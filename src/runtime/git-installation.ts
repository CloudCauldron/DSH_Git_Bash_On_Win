import { createHash } from 'node:crypto';
import { readdirSync, realpathSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, resolve, toNamespacedPath } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import {
  admitChildDirectory, admitDirectory, admitJunction, createDirectory, createHardlink, createJunction,
  hasCloseFailure, isMissing, openOrdinaryFile, ordinaryFileExists, overlaps, pathExists, pinDirectory, readFileBytes,
  revalidateDirectory, sameIdentity, writeNewFile, WrongEntryKindError, type Directory, type FileIdentity,
} from './ntfs-filesystem.ts';
import { patchMsysDll } from './pe.ts';
import { LocalizedError } from '../locale/errors.ts';

export type GitLayout = 'ucrt64' | 'mingw64';
export interface GitInstallation { readonly root: string; readonly layout: GitLayout }
export interface FreshLinkTree { readonly source: Directory; readonly base: Directory; readonly files: readonly string[] }
export interface FileStamp extends FileIdentity { readonly size: string; readonly lastWriteTime: string }
export const anchorNames = ['bash', 'sh', 'msys', 'git', 'profile', 'installOptions'] as const;
export type AnchorName = typeof anchorNames[number];
export type AnchorStamps = Readonly<Record<AnchorName, FileStamp>>;

export function anchorPaths(layout: GitLayout): Readonly<Record<AnchorName, string>> {
  return {
    bash: 'usr/bin/bash.exe', sh: 'usr/bin/sh.exe', msys: 'usr/bin/msys-2.0.dll',
    git: `${layout}/bin/git.exe`, profile: 'etc/profile', installOptions: 'etc/install-options.txt',
  };
}

/** Pure construction from a pin's recorded selection; the source may be gone. */
export function buildRuntimeEnvironment(installationRoot: string, sourceRoot: string, layout: GitLayout, ambient: NodeJS.ProcessEnv): Record<string, string> {
  const existing = Object.entries(ambient).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const excluded = ['bin', 'usr/bin', 'cmd', `${layout}/bin`].map(path => resolve(sourceRoot, path).toLowerCase());
  const tail = existing.split(';').filter(path => path && !excluded.includes(resolve(path.replace(/^"(.*)"$/, '$1')).toLowerCase()));
  return {
    PATH: [join(installationRoot, layout, 'bin'), join(installationRoot, 'usr/bin'), ...tail].join(';'),
    GIT_EXEC_PATH: join(installationRoot, layout, 'libexec/git-core').replaceAll('\\', '/'),
    GIT_TEMPLATE_DIR: join(installationRoot, layout, 'share/git-core/templates').replaceAll('\\', '/'),
    MSYS2_PATH_TYPE: 'inherit',
  };
}

export function discoverGitInstallation(setting?: string): GitInstallation {
  const candidates = setting !== undefined ? [setting] : [
    ...['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)'].flatMap(key => process.env[key] ? [join(process.env[key]!, 'Git/bin/bash.exe')] : []),
    ...process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Programs/Git/bin/bash.exe')] : [],
  ];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || basename(candidate).toLowerCase() !== 'bash.exe' || !pathExists(candidate)) continue;
    let executable: string;
    try { executable = realpathSync(candidate); }
    catch (error) {
      if (setting === undefined && isMissing(error)) continue;
      throw error;
    }
    const parent = dirname(resolve(candidate));
    if (basename(executable).toLowerCase() !== 'bash.exe' || basename(parent).toLowerCase() !== 'bin') continue;
    const nativeRoot = dirname(parent);
    // A root (or its alias) can itself be named usr. Only the two supported entry paths can identify a root.
    const usrBin = /[\\/]usr[\\/]bin$/i;
    const roots = usrBin.test(parent) && usrBin.test(dirname(executable)) ? [dirname(nativeRoot), nativeRoot] : [nativeRoot];
    let admissionError: unknown;
    for (const rootPath of roots) {
      try {
        const root = admitDirectory(realpathSync(rootPath));
        sourceJunctionTargets(root);
        if (!hasSourceFile(root, 'usr/bin/bash.exe') || !hasSourceFile(root, 'usr/bin/msys-2.0.dll')) continue;
        const layout = (['ucrt64', 'mingw64'] as const).find(name => hasSourceFile(root, `${name}/bin/git.exe`));
        if (layout) return { root: root.path, layout };
      } catch (error) {
        if (hasCloseFailure(error)) throw error;
        const incompleteDefault = setting === undefined && error instanceof WrongEntryKindError;
        if (!isMissing(error) && !incompleteDefault) admissionError ??= error;
      }
    }
    if (admissionError) throw admissionError;
  }
  throw new LocalizedError('error.gitNotFound', { bin: 'bin/bash.exe', usrBin: 'usr/bin/bash.exe' });
}

function sourceJunctionTargets(root: Directory, layout?: GitLayout): Directory[] {
  const bin = admitChildDirectory(root, 'bin');
  openOrdinaryFile(bin, 'bash.exe').close();
  const targets = [bin, admitChildDirectory(root, 'etc')];
  if (layout) targets.push(admitChildDirectory(root, layout));
  return targets;
}

function hasSourceFile(root: Directory, path: string): boolean {
  try { return ordinaryFileExists(directoryAt(root, posix.dirname(path)), posix.basename(path)); }
  catch (error) {
    if (isMissing(error) || error instanceof WrongEntryKindError) return false;
    throw error;
  }
}

/** Directory observations are shared within each source pass, never persisted. */
function directoryAt(root: Directory, path: string, directories = new Map<string, Directory>()): Directory {
  let current = root, prefix = '';
  for (const name of path.split('/').filter(name => name && name !== '.')) {
    prefix = prefix ? `${prefix}/${name}` : name;
    let next = directories.get(prefix);
    if (!next) { next = admitChildDirectory(current, name); directories.set(prefix, next); }
    current = next;
  }
  return current;
}

/** MSYS budgets the normalized NT image path, including the terminating byte. */
export function requireViewPathBudget(view: string): void {
  const path = toNamespacedPath(join(view, 'usr/bin/msys-2.0.dll'));
  // The Win32 extended prefix and its NT spelling both occupy four ASCII bytes.
  if (Buffer.byteLength(path) + 1 > 260) throw new LocalizedError('error.viewPathBudget', { path });
}

const payloadLimit = 64 * 1024 * 1024;

/** Root and usr expose only directories. In usr/bin retain the ordinary filenames for the flat copy pass. */
function junctionDirectories(source: Directory, destination: Directory, handled?: readonly string[]): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(toNamespacedPath(source.path), { withFileTypes: true })) {
    const name = entry.name.toLowerCase();
    if (handled && (handled.includes(name) || name === 'tmp' || name === 'dev')) continue;
    if (!handled && name === 'dsh-msys-compat.dll') throw new LocalizedError('error.unsupportedRuntimeEntry', { path: join(source.path, entry.name) });
    if (entry.isDirectory()) createJunction(destination, entry.name, admitChildDirectory(source, entry.name));
    else if (entry.isFile()) {
      if (!handled) files.push(entry.name);
    } else throw new LocalizedError('error.unsupportedRuntimeEntry', { path: join(source.path, entry.name) });
  }
  return files;
}

/** Called on an unpublished, exclusively created generation after discovery. Its owner handles whole-generation rollback. */
export async function buildCopyLayout(generation: Directory, installation: GitInstallation, shim: Buffer, signal: AbortSignal) {
  signal.throwIfAborted();
  requireViewPathBudget(join(generation.path, 'v/ww-4294967295-4294967295-ffffffffffffffff'));
  const source = admitDirectory(installation.root);
  if (overlaps(source.path, generation.path)) throw new LocalizedError('error.cacheOverlap');
  const requiredTargets = sourceJunctionTargets(source, installation.layout);
  const usr = admitChildDirectory(source, 'usr'), bin = admitChildDirectory(usr, 'bin');
  const runtime = createDirectory(generation, 'r'), destUsr = createDirectory(runtime, 'usr');
  const destBin = createDirectory(destUsr, 'bin');
  createDirectory(generation, 'v');
  for (const target of requiredTargets) createJunction(runtime, basename(target.path), target);
  junctionDirectories(source, runtime, ['usr', ...requiredTargets.map(target => basename(target.path))]);
  junctionDirectories(usr, destUsr, ['bin']);
  const files = junctionDirectories(bin, destBin);
  for (const required of ['bash.exe', 'sh.exe', 'msys-2.0.dll']) {
    if (!files.some(name => name.toLowerCase() === required)) throw new LocalizedError('error.ordinaryEntryRequired', { kind: 'file', path: join(bin.path, required) });
  }
  using _source = pinDirectory(bin);
  using _dest = pinDirectory(destBin);
  let patchedMsysSha256 = '';
  for (const name of files) {
    signal.throwIfAborted();
    let bytes = readFileBytes(bin, name, payloadLimit);
    if (name.toLowerCase() === 'msys-2.0.dll') {
      bytes = patchMsysDll(bytes);
      patchedMsysSha256 = createHash('sha256').update(bytes).digest('hex');
    }
    writeNewFile(destBin, name, bytes);
    await yieldToEventLoop();
  }
  signal.throwIfAborted();
  writeNewFile(destBin, 'dsh-msys-compat.dll', shim);
  return { runtime, patchedMsysSha256 };
}

export function admitCopyJunctions(runtime: Directory, source: Directory, layout: GitLayout): void {
  for (const target of sourceJunctionTargets(source, layout)) admitJunction(runtime, basename(target.path), target);
}

const selectionRoots = [
  'usr/bin', 'usr/lib', 'usr/libexec', 'usr/share', 'usr/ssl',
  ...['ucrt64', 'mingw64'].flatMap(layout => ['bin', 'lib', 'libexec/git-core', 'share', 'etc'].map(path => `${layout}/${path}`)),
  'etc',
];

function selected(path: string): boolean {
  return !/^(?:usr|ucrt64|mingw64)\/share\/(?:doc|licenses|gtk-doc|icons|applications|fish|makepkg-template)(?:\/|$)/.test(path)
    && path !== 'usr/lib/winpty.lib';
}

function validateFiles(files: readonly string[]): void {
  const seen = new Set<string>();
  for (const path of files) {
    if (!path || path.length > 32767 || path.includes('\\') || path.startsWith('/') || posix.normalize(path) !== path
      || path.split('/').some(name => !name || name === '.' || name === '..' || /[:\0]/.test(name) || /[. ]$/.test(name))
      || !selectionRoots.some(root => path.startsWith(`${root}/`)) || !selected(path)) throw new LocalizedError('error.invalidRelativePath', { path });
    const key = path.toLowerCase();
    if (seen.has(key)) throw new LocalizedError('error.duplicateRelativePath', { path });
    seen.add(key);
  }
}

/** Stop scheduling on cancellation/failure, but always drain the issued batch. */
async function batch<T, R>(items: readonly T[], checkActive: () => void, action: (item: T) => Promise<R>): Promise<R[]> {
  checkActive();
  const settled = await Promise.allSettled(items.map(action));
  const failed = settled.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  checkActive();
  return settled.map(result => (result as PromiseFulfilledResult<R>).value);
}

export async function inventoryGitFiles(sourceRoot: string, checkActive: () => void): Promise<readonly string[]> {
  checkActive();
  const root = admitDirectory(sourceRoot), directories = new Map<string, Directory>(), files: string[] = [];
  const pending: Array<{ path: string; directory: Directory }> = [];
  for (const path of selectionRoots) {
    try { pending.push({ path, directory: directoryAt(root, path, directories) }); }
    catch (error) { if (!isMissing(error)) throw error; }
  }
  for (let cursor = 0; cursor < pending.length; cursor++) {
    checkActive();
    const { path, directory } = pending[cursor]!;
    const names = (await readdir(directory.path)).filter(name => selected(`${path}/${name}`)).sort();
    for (let offset = 0; offset < names.length; offset += 32) {
      const entries = await batch(names.slice(offset, offset + 32), checkActive, async name => ({ name, stat: await lstat(join(directory.path, name)) }));
      for (const { name, stat } of entries) {
        const child = `${path}/${name}`;
        if (stat.isSymbolicLink()) {
          throw new LocalizedError('error.reparsePoint', { path: child }, { fallback: `Refusing source reparse point: ${child}` });
        }
        if (stat.isDirectory()) pending.push({ path: child, directory: admitChildDirectory(directory, name) });
        else if (stat.isFile()) files.push(child);
        else throw new LocalizedError('error.unsupportedRuntimeEntry', { path: child });
      }
    }
  }
  checkActive();
  validateFiles(files);
  return files.sort();
}

export async function linkFreshTree(tree: FreshLinkTree, checkActive: () => void,
  onLinked?: (file: { path: string; completed: number; total: number }) => void): Promise<void> {
  checkActive();
  validateFiles(tree.files);
  const { source, base } = tree;
  revalidateDirectory(source);
  using _base = pinDirectory(base);
  if (source.volumeSerial !== base.volumeSerial) {
    throw new LocalizedError('error.sameVolume', undefined, { fallback: 'Git and runtime base must share an NTFS volume.' });
  }
  const parents = new Set<string>();
  for (const file of tree.files) for (let parent = posix.dirname(file); parent !== '.'; parent = posix.dirname(parent)) parents.add(parent);
  const targets = new Map<string, Directory>([['.', base]]), sources = new Map<string, Directory>();
  let created = 0;
  for (const parent of [...parents].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
    checkActive();
    targets.set(parent, createDirectory(targets.get(posix.dirname(parent))!, posix.basename(parent)));
    // Deliver cancellation even when a large tree has only synchronous mkdir work.
    if (++created % 32 === 0) await yieldToEventLoop();
  }
  for (let offset = 0; offset < tree.files.length; offset += 32) {
    checkActive();
    {
      using _source = pinDirectory(source);
      for (const file of tree.files.slice(offset, offset + 32)) {
        const parent = posix.dirname(file), name = posix.basename(file);
        createHardlink(directoryAt(source, parent, sources), name, targets.get(parent)!, name);
      }
    }
    if (onLinked) {
      const completed = Math.min(offset + 32, tree.files.length);
      onLinked({ path: tree.files[completed - 1]!, completed, total: tree.files.length });
    }
    // Each synchronous syscall has settled before yielding. Cancellation can
    // stop the next bounded batch without leaving queued path-based writes.
    await yieldToEventLoop();
  }
  checkActive();
}

function stamp(info: FileStamp): FileStamp {
  return { volumeSerial: info.volumeSerial, fileId: info.fileId, size: info.size, lastWriteTime: info.lastWriteTime };
}

export async function readAnchors(root: string, layout: GitLayout): Promise<AnchorStamps> {
  const directory = admitDirectory(root), directories = new Map<string, Directory>();
  return Object.fromEntries(Object.entries(anchorPaths(layout)).map(([name, path]) => {
    const hold = openOrdinaryFile(directoryAt(directory, posix.dirname(path), directories), posix.basename(path));
    try { return [name, stamp(hold.information())]; } finally { hold.close(); }
  })) as Record<AnchorName, FileStamp>;
}

/** Capture base stamps with both handles open; only identities are compared here. */
export function captureAnchors(sourceRoot: string, baseRoot: string, layout: GitLayout): AnchorStamps {
  const source = admitDirectory(sourceRoot), base = admitDirectory(baseRoot);
  const sources = new Map<string, Directory>(), bases = new Map<string, Directory>();
  const anchors = {} as Record<AnchorName, FileStamp>;
  for (const name of anchorNames) {
    const path = anchorPaths(layout)[name], parent = posix.dirname(path), leaf = posix.basename(path);
    const origin = openOrdinaryFile(directoryAt(source, parent, sources), leaf, true);
    try {
      const target = openOrdinaryFile(directoryAt(base, parent, bases), leaf, true);
      try {
        const saved = target.information();
        if (!sameIdentity(origin.information(), saved)) throw new LocalizedError('error.anchorIdentityMismatch', { path });
        anchors[name] = stamp(saved);
      } finally { target.close(); }
    } finally { origin.close(); }
  }
  return anchors;
}

export function sameAnchors(actual: AnchorStamps, saved: AnchorStamps): boolean {
  return anchorNames.every(name => sameIdentity(actual[name], saved[name])
    && actual[name].size === saved[name].size && actual[name].lastWriteTime === saved[name].lastWriteTime);
}
