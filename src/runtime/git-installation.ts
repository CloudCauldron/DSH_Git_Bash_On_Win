import { createHash } from 'node:crypto';
import { readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, posix, resolve, toNamespacedPath } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import {
  admitChildDirectory, admitDirectory, admitJunction, createDirectory, createJunction,
  hasCloseFailure, isMissing, openOrdinaryFile, ordinaryFileExists, overlaps, pathExists, pinDirectory, readFileBytes,
  writeNewFile, WrongEntryKindError, type Directory, type FileIdentity,
} from './ntfs-filesystem.ts';
import { patchMsysDll } from './pe.ts';
import { LocalizedError } from '../locale/errors.ts';

export type GitLayout = 'ucrt64' | 'mingw64';
export interface GitInstallation { readonly root: string; readonly layout: GitLayout }
export interface FileStamp extends FileIdentity { readonly size: string; readonly lastWriteTime: string }
export interface SourceFreshness { readonly git: FileStamp; readonly msys: FileStamp; readonly packageVersionsSha256: string | null }

/** Apply DSH's already assembled explicit map in its enumeration order. */
export function buildRuntimeEnvironment(installationRoot: string, sourceRoot: string, layout: GitLayout, explicit: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let existing = process.env.PATH;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(explicit)) {
    const folded = key.toUpperCase();
    if (folded === 'PATH') existing = value;
    else if (!['GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR', 'MSYS2_PATH_TYPE'].includes(folded)) env[key] = value;
  }
  const excluded = ['bin', 'usr/bin', 'cmd', `${layout}/bin`].map(path => resolve(sourceRoot, path).toLowerCase());
  const tail = (existing ?? '').split(';').filter(path => path && !excluded.includes(resolve(path.replace(/^"(.*)"$/, '$1')).toLowerCase()));
  return {
    ...env, PATH: [join(installationRoot, layout, 'bin'), join(installationRoot, 'usr/bin'), ...tail].join(';'),
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
    if (!isAbsolute(candidate) || parse(candidate).root.length <= 1 || /[\\/]$/.test(candidate)
      || basename(candidate).toLowerCase() !== 'bash.exe' || !pathExists(candidate)) continue;
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
        if (!isMissing(error) && !incompleteDefault && (admissionError === undefined || admissionError instanceof WrongEntryKindError)) admissionError = error;
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

function directoryAt(root: Directory, path: string): Directory {
  return path.split('/').reduce((parent, name) => admitChildDirectory(parent, name), root);
}

/** MSYS budgets the normalized NT image path, including the terminating byte. */
export function requireViewPathBudget(view: string): void {
  const path = toNamespacedPath(join(view, 'usr/bin/msys-2.0.dll'));
  // The Win32 extended prefix and its NT spelling both occupy four ASCII bytes.
  if (Buffer.byteLength(path) + 1 > 260) throw new LocalizedError('error.viewPathBudget', { path });
}

export const payloadLimit = 64 * 1024 * 1024;

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
  const views = createDirectory(generation, 'v');
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
  return { runtime, views, patchedMsysSha256 };
}

export function admitCopyJunctions(runtime: Directory, source: Directory, layout: GitLayout): void {
  for (const target of sourceJunctionTargets(source, layout)) admitJunction(runtime, basename(target.path), target);
}

export function readSourceFreshness(source: Directory, layout: GitLayout): SourceFreshness {
  function stamp(path: string): FileStamp {
    using hold = openOrdinaryFile(directoryAt(source, posix.dirname(path)), posix.basename(path));
    const { volumeSerial, fileId, size, lastWriteTime } = hold.information();
    return { volumeSerial, fileId, size, lastWriteTime };
  }
  const etc = admitChildDirectory(source, 'etc');
  let packageVersionsSha256: string | null = null;
  try { packageVersionsSha256 = createHash('sha256').update(readFileBytes(etc, 'package-versions.txt', 256 * 1024)).digest('hex'); }
  catch (error) { if (!isMissing(error)) throw error; }
  return { git: stamp(layout + '/bin/git.exe'), msys: stamp('usr/bin/msys-2.0.dll'), packageVersionsSha256 };
}
