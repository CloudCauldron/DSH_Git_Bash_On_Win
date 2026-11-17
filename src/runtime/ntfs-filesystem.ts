import { linkSync, lstatSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep, toNamespacedPath } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { closeHandleChecked, extendWin32ProcessBindings, isNullPtr, throwLastError, Win32Error, type NativePtr } from '@deepseek-ai/dsh-win32-process';

export interface FileIdentity { readonly volumeSerial: string; readonly fileId: string }
export interface Directory extends FileIdentity { readonly path: string }
interface FileInformation extends FileIdentity {
  readonly size: string;
  readonly lastWriteTime: string;
  readonly attributes: number;
  readonly reparseTag: number;
}

const READ = 0x80000000, DELETE = 0x10000;
const SHARE_ALL = 7, OPEN_EXISTING = 3, CREATE_NEW = 1;
const NO_FOLLOW = 0x00200000, DIRECTORY = 0x02000000, DELETE_ON_CLOSE = 0x04000000;
const ATTR_DIRECTORY = 0x10, ATTR_REPARSE = 0x400, ATTR_READONLY = 1;
const MOUNT_POINT = 0xa0000003, SYMLINK = 0xa000000c;

interface FileBindings {
  open(path: string, access: number, sharing: number, security: null, disposition: number, flags: number, template: null): NativePtr | null;
  information(handle: NativePtr, buffer: Buffer): number;
  informationEx(handle: NativePtr, kind: number, buffer: Buffer, size: number): number;
  finalPath(handle: NativePtr, buffer: Buffer, size: number, flags: number): number;
  volume(handle: NativePtr, label: null, labelSize: number, serial: null, component: null, flags: null, filesystem: Buffer, size: number): number;
  readBytes(handle: NativePtr, buffer: Buffer, size: number, read: Buffer, overlapped: null): number;
  deleteFile(path: string): number;
  removeDirectory(path: string): number;
}

let bindings: ReturnType<typeof extendWin32ProcessBindings<FileBindings>> | undefined;
function api() {
  requireWindows();
  return bindings ??= extendWin32ProcessBindings(({ kernel32, bind }) => ({
    open: bind(kernel32, 'CreateFileW', 'void *', ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'void *']),
    information: bind(kernel32, 'GetFileInformationByHandle', 'int', ['void *', 'void *']),
    informationEx: bind(kernel32, 'GetFileInformationByHandleEx', 'int', ['void *', 'int', 'void *', 'uint32']),
    finalPath: bind(kernel32, 'GetFinalPathNameByHandleW', 'uint32', ['void *', 'void *', 'uint32', 'uint32']),
    volume: bind(kernel32, 'GetVolumeInformationByHandleW', 'int', ['void *', 'void *', 'uint32', 'void *', 'void *', 'void *', 'void *', 'uint32']),
    readBytes: bind(kernel32, 'ReadFile', 'int', ['void *', 'void *', 'uint32', 'void *', 'void *']),
    deleteFile: bind(kernel32, 'DeleteFileW', 'int', ['str16']),
    removeDirectory: bind(kernel32, 'RemoveDirectoryW', 'int', ['str16']),
  }) as FileBindings);
}

export function requireWindows(): void {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native Windows x64 is required for the Git Bash runtime.');
}

export function isMissing(error: unknown): boolean {
  return [2, 3].includes((error as { win32Code?: number })?.win32Code ?? 0)
    || (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export function isBusy(error: unknown): boolean {
  return [32, 33].includes((error as { win32Code?: number })?.win32Code ?? 0)
    || ['EBUSY', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException)?.code ?? '');
}

export class InvalidMetadataError extends Error {}

/** The new name was created, but neither admission nor its rollback completed. */
export class DirectoryRollbackError extends AggregateError {}

export function hasCloseFailure(error: unknown): boolean {
  return (error instanceof Win32Error && error.api === 'CloseHandle')
    || (error instanceof AggregateError && error.errors.some(hasCloseFailure));
}

/** Resource failures must never disappear inside best-effort artifact cleanup. */
export function bestEffort(action: () => void): void {
  try { action(); } catch (error) {
    if (hasCloseFailure(error)) throw error;
  }
}

// Synchronous path queries decode independent strings before reusing this scratch.
const pathBuffer = Buffer.alloc(65536);

export class NativeHold {
  private closed = false;
  private observation?: FileInformation;
  readonly path: string;
  private readonly handle: NativePtr;
  constructor(path: string, handle: NativePtr) { this.path = path; this.handle = handle; }

  information(): FileInformation {
    // One handle observation serves kind, identity and stamp admission. Lease
    // liveness checks open fresh handles; they never reuse an earlier sample.
    if (this.observation) return this.observation;
    const data = Buffer.alloc(52); // BY_HANDLE_FILE_INFORMATION, x64 and x86 layout.
    if (!api().information(this.handle, data)) throwLastError(api(), 'GetFileInformationByHandle', this.path);
    const attributes = data.readUInt32LE(0);
    let reparseTag = 0;
    if (attributes & ATTR_REPARSE) {
      const tag = Buffer.alloc(8); // FILE_ATTRIBUTE_TAG_INFO, needed only for reparses.
      if (!api().informationEx(this.handle, 9, tag, tag.length)) throwLastError(api(), 'FileAttributeTagInfo', this.path);
      reparseTag = tag.readUInt32LE(4);
    }
    return this.observation = {
      volumeSerial: String(data.readUInt32LE(28)),
      fileId: String((BigInt(data.readUInt32LE(44)) << 32n) | BigInt(data.readUInt32LE(48))),
      size: String((BigInt(data.readUInt32LE(32)) << 32n) | BigInt(data.readUInt32LE(36))),
      lastWriteTime: String(data.readBigUInt64LE(20)),
      attributes, reparseTag,
    };
  }

  canonicalPath(): string {
    const length = api().finalPath(this.handle, pathBuffer, pathBuffer.length / 2, 0);
    if (!length) throwLastError(api(), 'GetFinalPathNameByHandleW', this.path);
    if (length >= pathBuffer.length / 2) throw new Error(`Canonical path exceeds the supported bound: ${this.path}`);
    return ordinaryPath(pathBuffer.subarray(0, length * 2).toString('utf16le'));
  }

  requireNtfs(): void {
    const data = Buffer.alloc(64);
    if (!api().volume(this.handle, null, 0, null, null, null, data, 32)) throwLastError(api(), 'GetVolumeInformationByHandleW', this.path);
    if (data.toString('utf16le').split('\0')[0] !== 'NTFS') throw new Error(`NTFS is required: ${this.path}`);
  }

  readJson(maxBytes: number): unknown {
    const info = this.information();
    requireKind(info, 'file', this.path);
    if (BigInt(info.size) > BigInt(maxBytes)) throw new InvalidMetadataError(`Metadata exceeds its path-aware bound: ${this.path}`);
    const size = Number(info.size), data = Buffer.alloc(size + 1), count = Buffer.alloc(4);
    // The SDK's raw count-pointer allocator has no public matching free. A
    // Buffer out-parameter keeps this bounded read entirely GC-owned.
    if (!api().readBytes(this.handle, data, data.length, count, null)) throwLastError(api(), 'ReadFile', this.path);
    const length = count.readUInt32LE(0);
    if (length > size) throw new InvalidMetadataError(`Metadata grew during its read: ${this.path}`);
    return JSON.parse(data.subarray(0, length).toString('utf8')) as unknown;
  }

  close(): void {
    if (this.closed) return;
    closeHandleChecked(api(), this.handle, this.path);
    this.closed = true;
  }
}

function open(path: string, access = 0, sharing = SHARE_ALL, disposition = OPEN_EXISTING, flags = 0): NativeHold {
  const handle = api().open(toNamespacedPath(path), access, sharing, null, disposition, NO_FOLLOW | DIRECTORY | flags, null);
  if (isNullPtr(handle) || BigInt.asUintN(64, handle) === 0xffffffffffffffffn) throwLastError(api(), 'CreateFileW', path);
  return new NativeHold(path, handle);
}

function requireKind(info: FileInformation, kind: 'file' | 'directory', path: string): void {
  if (info.attributes & ATTR_REPARSE) throw new Error(`Refusing reparse point: ${path}`);
  if (!!(info.attributes & ATTR_DIRECTORY) !== (kind === 'directory')) throw new Error(`Expected ordinary ${kind}: ${path}`);
}

function ordinaryPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice(8)}`;
  return path.startsWith('\\\\?\\') ? path.slice(4) : path;
}

export function absolutePath(path: string): string {
  requireWindows();
  if (!isAbsolute(path) || parse(path).root.length <= 1 || path.startsWith('\\\\?\\')
    || path.includes('\0') || path.length > 32767 || /[. ](?:[\\/]|$)/.test(path)
    || path.slice(2).includes(':')) throw new Error(`Expected an ordinary absolute Windows path: ${path}`);
  return resolve(path);
}

export function samePath(a: string, b: string): boolean { return resolve(a).toLowerCase() === resolve(b).toLowerCase(); }
export function sameIdentity(a: FileIdentity, b: FileIdentity): boolean { return a.volumeSerial === b.volumeSerial && a.fileId === b.fileId; }
/** Borrowed debug-event file handles stay owned by the event dispatcher. */
export function fileIdentity(handle: NativePtr): FileIdentity {
  const data = Buffer.alloc(52);
  if (!api().information(handle, data)) throwLastError(api(), 'GetFileInformationByHandle', 'loaded module');
  return { volumeSerial: String(data.readUInt32LE(28)), fileId: String((BigInt(data.readUInt32LE(44)) << 32n) | BigInt(data.readUInt32LE(48))) };
}

export function canonicalExistingPath(path: string): string { return ordinaryPath(realpathSync(path)); }

export function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function overlaps(a: string, b: string): boolean {
  return containsPath(a, b) || containsPath(b, a);
}

function inspect(path: string): FileInformation {
  const hold = open(path);
  try { return hold.information(); } finally { hold.close(); }
}

/** Walk ancestors before opening a target; cache/source policy stays with callers. */
export function admitDirectory(path: string, expected?: FileIdentity): Directory {
  path = absolutePath(path);
  const parents: string[] = [];
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    parents.unshift(parent);
    if (dirname(parent) === parent) break;
  }
  for (const parent of parents) requireKind(inspect(parent), 'directory', parent);
  const hold = open(path);
  try {
    const info = hold.information();
    requireKind(info, 'directory', path);
    if (expected && !sameIdentity(info, expected)) throw new Error(`Directory identity changed: ${path}`);
    hold.requireNtfs();
    return { path: hold.canonicalPath(), volumeSerial: info.volumeSerial, fileId: info.fileId };
  } finally { hold.close(); }
}

export function revalidateDirectory(directory: Directory): void {
  directoryHold(directory, 0, SHARE_ALL).close();
}

export function childPath(parent: Directory, name: string): string {
  // Enumerated interior names need not be valid generation IDs or conventional
  // Win32 spellings. Preserve one exact component, including trailing dots/spaces.
  if (!name || name === '.' || name === '..' || /[\\/:\0]/.test(name)) throw new Error(`Invalid child name: ${name}`);
  return join(parent.path, name);
}

/** An already admitted parent is reused during a bounded inventory/link pass. */
export function admitChildDirectory(parent: Directory, name: string, expected?: FileIdentity): Directory {
  const path = childPath(parent, name);
  const info = inspect(path);
  if (expected && !sameIdentity(info, expected)) throw new Error(`Directory identity changed: ${path}`);
  return observedDirectory(path, info, parent.volumeSerial);
}

function observedDirectory(path: string, info: FileInformation, volumeSerial: string): Directory {
  requireKind(info, 'directory', path);
  if (info.volumeSerial !== volumeSerial) throw new Error(`Volume boundary changed: ${path}`);
  return { path, volumeSerial: info.volumeSerial, fileId: info.fileId };
}

export function createDirectory(parent: Directory, name: string): Directory {
  revalidateDirectory(parent);
  return createChildDirectory(parent, name);
}

function createChildDirectory(parent: Directory, name: string): Directory {
  const path = childPath(parent, name);
  mkdirSync(toNamespacedPath(path), { mode: 0o700 }); // EEXIST never authorizes cleanup.
  try { return admitChildDirectory(parent, name); }
  catch (error) {
    // Roll back only our successfully created, still-empty name. Never recurse
    // or repair attributes when admission itself could not establish a Directory.
    try { revalidateDirectory(parent); removeDirectoryName(path); }
    catch (cleanup) { throw new DirectoryRollbackError([error, cleanup], `Directory admission and cleanup failed: ${path}`, { cause: cleanup }); }
    throw error;
  }
}

export function ensureDirectory(parent: Directory, name: string): Directory {
  revalidateDirectory(parent);
  try { return admitChildDirectory(parent, name); }
  catch (error) { if (!isMissing(error)) throw error; }
  return createChildDirectory(parent, name);
}

export function openOrdinaryFile(parent: Directory, name: string, writable = false): NativeHold {
  const path = childPath(parent, name), hold = open(path);
  try {
    const info = hold.information();
    requireKind(info, 'file', path);
    if (info.volumeSerial !== parent.volumeSerial) throw new Error(`Volume boundary changed: ${path}`);
    if (writable && (info.attributes & ATTR_READONLY)) throw new Error(`Refusing read-only source hardlink: ${path}`);
    return hold;
  } catch (error) { hold.close(); throw error; }
}

export function readMetadata(parent: Directory, name: string, maxBytes: number): unknown {
  revalidateDirectory(parent);
  const path = childPath(parent, name), hold = open(path, READ);
  try { return hold.readJson(maxBytes); } finally { hold.close(); }
}

export function writeNewMetadata(parent: Directory, name: string, value: unknown): void {
  revalidateDirectory(parent);
  writeFileSync(toNamespacedPath(childPath(parent, name)), `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
}

function directoryHold(directory: Directory, access: number, sharing: number): NativeHold {
  const hold = open(directory.path, access, sharing);
  try {
    const info = hold.information();
    requireKind(info, 'directory', directory.path);
    if (!sameIdentity(info, directory)) throw new Error(`Directory identity changed: ${directory.path}`);
    // Admission already established the ancestor chain and NTFS volume. Reuse
    // it only while this opened object still has that identity AND physical path.
    if (!samePath(hold.canonicalPath(), directory.path)) throw new Error(`Directory path redirected: ${directory.path}`);
    return hold;
  } catch (error) { hold.close(); throw error; }
}

export function pinDirectory(directory: Directory): NativeHold { return directoryHold(directory, READ, 1); }
export function claimDirectory(directory: Directory): NativeHold { return directoryHold(directory, DELETE, SHARE_ALL); }

/** Exclusive creation, no inheritance, automatically removed on close or death. */
export function createSetupLease(parent: Directory, name = '.setup-owner'): NativeHold {
  revalidateDirectory(parent);
  return open(childPath(parent, name), 0xc0010000, 0, CREATE_NEW, DELETE_ON_CLOSE);
}

export function requireActiveLease(parent: Directory, expected: FileIdentity): void {
  revalidateDirectory(parent);
  const lease = openOrdinaryFile(parent, '.setup-owner');
  try { if (!sameIdentity(lease.information(), expected)) throw new Error('Setup lease identity changed.'); }
  finally { lease.close(); }
}

export function openExclusiveMetadata(parent: Directory, name: string): NativeHold {
  revalidateDirectory(parent);
  const hold = open(childPath(parent, name), READ, 0);
  try { requireKind(hold.information(), 'file', hold.path); return hold; }
  catch (error) { hold.close(); throw error; }
}

export async function acquireWriterLock(directory: Directory, signal: AbortSignal): Promise<NativeHold> {
  const started = performance.now();
  for (;;) {
    signal.throwIfAborted();
    try { return createSetupLease(directory, '.writer-lock'); }
    catch (error) {
      const code = (error as { win32Code?: number }).win32Code;
      if (![32, 80, 183].includes(code ?? 0) || performance.now() - started > 120_000) throw error;
      // A sharing conflict is waitable; an unsafe lock object is not.
      try { openOrdinaryFile(directory, '.writer-lock').close(); }
      catch (inspection) { if (!isMissing(inspection)) throw inspection; }
      await delay(25, undefined, { signal });
    }
  }
}

/** Only the actual link syscall can authorize the later UAC choice. */
export function createHardlink(sourceParent: Directory, sourceName: string, targetParent: Directory, targetName: string): void {
  revalidateDirectory(sourceParent);
  revalidateDirectory(targetParent);
  if (sourceParent.volumeSerial !== targetParent.volumeSerial) throw new Error('Hardlink source and destination must share an NTFS volume.');
  const source = openOrdinaryFile(sourceParent, sourceName, true);
  try {
    // Keep admission and the syscall in one synchronous operation. Queuing an
    // async link would let a renamed/junction-replaced parent redirect the write
    // while it waits in libuv. The caller yields between bounded batches.
    try { linkSync(toNamespacedPath(source.path), toNamespacedPath(childPath(targetParent, targetName))); }
    catch (error) {
      if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) Object.assign(error as object, { linkPermissionDenied: true });
      throw error;
    }
  } finally { source.close(); }
}

export function createJunction(parent: Directory, name: string, target: Directory): string {
  revalidateDirectory(parent);
  revalidateDirectory(target);
  const path = childPath(parent, name);
  symlinkSync(toNamespacedPath(target.path), toNamespacedPath(path), 'junction'); // EEXIST is never adopted.
  try { admitJunction(parent, name, target); }
  catch (error) {
    // Only a successfully created name is ours to clean up on failed admission.
    try { unlinkEntry(parent, name); }
    catch (cleanup) { throw new AggregateError([error, cleanup], `Junction admission and cleanup failed: ${path}`, { cause: cleanup }); }
    throw error;
  }
  return path;
}

export function admitJunction(parent: Directory, name: string, target: Directory): void {
  const path = childPath(parent, name), info = inspect(path);
  if (!(info.attributes & ATTR_REPARSE) || info.reparseTag !== MOUNT_POINT) throw new Error(`Unexpected runtime junction: ${path}`);
  let actual: string;
  try { actual = ordinaryPath(realpathSync(toNamespacedPath(path))); }
  catch (cause) { throw new Error(`Unexpected runtime junction: ${path}`, { cause }); }
  if (!samePath(actual, target.path)) {
    throw new Error(`Unexpected runtime junction: ${path}`);
  }
}

export async function canonicalWorkspace(path: string): Promise<string> { return resolve(await realpath(absolutePath(path))); }

/** Includes malformed names; enumeration does not grant permission to follow links. */
export function children(directory: Directory): string[] {
  revalidateDirectory(directory);
  return readdirSync(toNamespacedPath(directory.path));
}

export function ordinaryChildDirectory(parent: Directory, name: string): Directory | undefined {
  revalidateDirectory(parent);
  const path = childPath(parent, name), info = inspect(path);
  if (info.attributes & ATTR_REPARSE || !(info.attributes & ATTR_DIRECTORY)) return undefined;
  return observedDirectory(path, info, parent.volumeSerial);
}

/** Unlink controls before traversing payload. Never decode their contents. */
export function unlinkEntry(parent: Directory, name: string): void {
  revalidateDirectory(parent);
  const path = childPath(parent, name);
  let info: FileInformation;
  try { info = inspect(path); } catch (error) { if (isMissing(error)) return; throw error; }
  unlinkObserved(path, info);
}

function unlinkObserved(path: string, info: FileInformation): void {
  if (info.attributes & ATTR_REPARSE) {
    if (![MOUNT_POINT, SYMLINK].includes(info.reparseTag)) throw new Error(`Unsupported reparse tag at ${path}`);
    if (info.attributes & ATTR_DIRECTORY) { removeDirectoryName(path); return; }
  } else if (info.attributes & ATTR_DIRECTORY) {
    throw new Error(`Expected an unlinkable name, not a directory: ${path}`);
  }
  // libuv's unlink/rmdir fallback can clear READONLY on the shared file.
  // Ordinary Win32 deletion reports obstructions without repairing attributes.
  if (!api().deleteFile(toNamespacedPath(path))) throwLastError(api(), 'DeleteFileW', path);
}

function removeDirectoryName(path: string): void {
  if (!api().removeDirectory(toNamespacedPath(path))) throwLastError(api(), 'RemoveDirectoryW', path);
}

/** Caller owns any required generation claim; this primitive has no cache policy. */
export function removeTree(parent: Directory, name: string): void {
  revalidateDirectory(parent);
  const path = childPath(parent, name);
  let info: FileInformation;
  try { info = inspect(path); } catch (error) { if (isMissing(error)) return; throw error; }
  if (!(info.attributes & ATTR_DIRECTORY) || info.attributes & ATTR_REPARSE) { unlinkObserved(path, info); return; }
  const directory = observedDirectory(path, info, parent.volumeSerial);
  removeDirectoryTree(directory);
}

/** Retains the caller's admitted identity, especially while a DELETE claim is held. */
export function removeDirectoryTree(directory: Directory): void {
  for (const child of children(directory)) removeTree(directory, child);
  removeEmptyDirectory(directory);
}

export function removeEmptyDirectory(directory: Directory): void {
  revalidateDirectory(directory);
  removeDirectoryName(directory.path);
}

/** Node enumeration hints are not authoritative for reparse/read-only admission. */
export function ordinaryFileExists(parent: Directory, name: string): boolean {
  try {
    const hold = openOrdinaryFile(parent, name);
    hold.close();
    return true;
  } catch (error) { if (isMissing(error)) return false; throw error; }
}

export function pathExists(path: string): boolean {
  try { lstatSync(toNamespacedPath(path)); return true; } catch (error) { if (isMissing(error)) return false; throw error; }
}
