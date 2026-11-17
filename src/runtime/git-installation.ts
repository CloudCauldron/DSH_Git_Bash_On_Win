import { realpathSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import {
  admitChildDirectory, admitDirectory, createDirectory, createHardlink, isMissing,
  openOrdinaryFile, ordinaryFileExists, pathExists, sameIdentity, type Directory, type FileIdentity,
} from './ntfs-filesystem.ts';

export type GitLayout = 'ucrt64' | 'mingw64';
export interface GitInstallation { readonly root: string; readonly layout: GitLayout }
export interface FreshLinkTree { readonly sourceRoot: string; readonly baseRoot: string; readonly files: readonly string[] }
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

export function discoverGitInstallation(setting?: string): GitInstallation {
  const candidates = setting !== undefined ? [setting] : [
    ...['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)'].flatMap(key => process.env[key] ? [join(process.env[key]!, 'Git/bin/bash.exe')] : []),
    ...process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Programs/Git/bin/bash.exe')] : [],
  ];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || basename(candidate).toLowerCase() !== 'bash.exe' || !pathExists(candidate)) continue;
    const executable = realpathSync(candidate), parent = dirname(executable);
    const root = admitDirectory(resolve(parent, /[\\/]usr[\\/]bin$/i.test(parent) ? '../..' : '..'));
    if (!ordinaryFileExists(directoryAt(root, 'usr/bin'), 'msys-2.0.dll')) continue;
    for (const layout of ['ucrt64', 'mingw64'] as const) {
      try { if (ordinaryFileExists(directoryAt(root, `${layout}/bin`), 'git.exe')) return { root: root.path, layout }; }
      catch (error) { if (!isMissing(error)) throw error; }
    }
  }
  throw new Error('Supported Git for Windows was not found. Set gitBashPath to its absolute bin/bash.exe or usr/bin/bash.exe path.');
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
      || !selectionRoots.some(root => path.startsWith(`${root}/`)) || !selected(path)) throw new Error(`Invalid Git relative file path: ${path}`);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate Git relative file path: ${path}`);
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
        if (stat.isSymbolicLink()) throw new Error(`Refusing source reparse point: ${child}`);
        if (stat.isDirectory()) pending.push({ path: child, directory: admitChildDirectory(directory, name) });
        else if (stat.isFile()) {
          const hold = openOrdinaryFile(directory, name, true);
          hold.close();
          files.push(child);
        } else throw new Error(`Unsupported Git runtime entry: ${child}`);
      }
    }
  }
  checkActive();
  validateFiles(files);
  return files.sort();
}

export async function linkFreshTree(tree: FreshLinkTree, checkActive: () => void): Promise<void> {
  checkActive();
  validateFiles(tree.files);
  const source = admitDirectory(tree.sourceRoot), base = admitDirectory(tree.baseRoot);
  if (source.volumeSerial !== base.volumeSerial) throw new Error('Git and runtime base must share an NTFS volume.');
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
    await batch(tree.files.slice(offset, offset + 32), checkActive, async file => {
      const parent = posix.dirname(file), name = posix.basename(file);
      await createHardlink(directoryAt(source, parent, sources), name, targets.get(parent)!, name);
    });
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
export async function captureAnchors(sourceRoot: string, baseRoot: string, layout: GitLayout): Promise<AnchorStamps> {
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
        if (!sameIdentity(origin.information(), saved)) throw new Error(`Source/base anchor identity mismatch: ${path}`);
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
