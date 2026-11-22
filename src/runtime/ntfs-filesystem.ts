import koffi from 'koffi';
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep, toNamespacedPath } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { closeHandleChecked, extendWin32ProcessBindings, isNullPtr, throwLastError, Win32Error, type NativePtr } from '@deepseek-ai/dsh-win32-process';
import { LocalizedAggregateError, LocalizedError } from '../locale/errors.ts';

export interface FileIdentity { readonly volumeSerial: string; readonly fileId: string }
export interface Directory extends FileIdentity { readonly path: string }
interface FileInformation extends FileIdentity {
  readonly size: string;
  readonly lastWriteTime: string;
  readonly attributes: number;
  readonly reparseTag: number;
}

const READ = 0x80000000, DELETE = 0x10000;
const SHARE_READ = 1, SHARE_READ_WRITE = 3, SHARE_ALL = 7, OPEN_EXISTING = 3, CREATE_NEW = 1;
const NO_FOLLOW = 0x00200000, DIRECTORY = 0x02000000, DELETE_ON_CLOSE = 0x04000000;
const ATTR_DIRECTORY = 0x10, ATTR_REPARSE = 0x400, ATTR_READONLY = 1;
const FILE_ADD_FILE = 2;
const MOUNT_POINT = 0xa0000003, SYMLINK = 0xa000000c;

interface FileBindings {
  open(path: string, access: number, sharing: number, security: null, disposition: number, flags: number, template: null): NativePtr | null;
  information(handle: NativePtr, buffer: Buffer): number;
  informationEx(handle: NativePtr, kind: number, buffer: Buffer, size: number): number;
  finalPath(handle: NativePtr, buffer: Buffer, size: number, flags: number): number;
  volume(handle: NativePtr, label: null, labelSize: number, serial: null, component: null, flags: null, filesystem: Buffer, size: number): number;
  readBytes(handle: NativePtr, buffer: Buffer, size: number, read: Buffer, overlapped: null): number;
  setFileInformation(handle: NativePtr, status: Buffer, info: Buffer, size: number, kind: number): number;
  statusToError(status: number): number;
  removeDirectory(path: string): number;
}

let bindings: ReturnType<typeof extendWin32ProcessBindings<FileBindings>> | undefined;
function api() {
  requireWindows();
  return bindings ??= extendWin32ProcessBindings(({ kernel32, bind }) => {
    const ntdll = koffi.load('ntdll.dll');
    return {
      open: bind(kernel32, 'CreateFileW', 'void *', ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'void *']),
      information: bind(kernel32, 'GetFileInformationByHandle', 'int', ['void *', 'void *']),
      informationEx: bind(kernel32, 'GetFileInformationByHandleEx', 'int', ['void *', 'int', 'void *', 'uint32']),
      finalPath: bind(kernel32, 'GetFinalPathNameByHandleW', 'uint32', ['void *', 'void *', 'uint32', 'uint32']),
      volume: bind(kernel32, 'GetVolumeInformationByHandleW', 'int', ['void *', 'void *', 'uint32', 'void *', 'void *', 'void *', 'void *', 'uint32']),
      readBytes: bind(kernel32, 'ReadFile', 'int', ['void *', 'void *', 'uint32', 'void *', 'void *']),
      setFileInformation: bind(ntdll, 'NtSetInformationFile', 'int32', ['void *', 'void *', 'void *', 'uint32', 'uint32']),
      statusToError: bind(ntdll, 'RtlNtStatusToDosError', 'uint32', ['int32']),
      removeDirectory: bind(kernel32, 'RemoveDirectoryW', 'int', ['str16']),
    } as FileBindings;
  });
}

export function requireWindows(): void {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new LocalizedError('error.runtimePlatform');
}

export function isMissing(error: unknown): boolean {
  return [2, 3].includes((error as { win32Code?: number })?.win32Code ?? 0)
    || (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export function isBusy(error: unknown): boolean {
  return [32, 33].includes((error as { win32Code?: number })?.win32Code ?? 0)
    || ['EBUSY', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException)?.code ?? '');
}

export class InvalidFileSizeError extends LocalizedError {}
export class WrongEntryKindError extends LocalizedError {}

/** The new name was created, but neither admission nor its rollback completed. */
export class DirectoryRollbackError extends LocalizedAggregateError {}

export function hasCloseFailure(error: unknown): boolean {
  return (error instanceof Win32Error && error.api === 'CloseHandle')
    || (error instanceof AggregateError && error.errors.some(hasCloseFailure))
    || (error instanceof SuppressedError && (hasCloseFailure(error.error) || hasCloseFailure(error.suppressed)));
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
    // Reuse kind, identity and size on this handle. A later freshness sample opens a new handle.
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
    if (length >= pathBuffer.length / 2) throw new LocalizedError('error.canonicalPathTooLong', { path: this.path });
    return ordinaryPath(pathBuffer.subarray(0, length * 2).toString('utf16le'));
  }

  requireNtfs(): void {
    const data = Buffer.alloc(64);
    if (!api().volume(this.handle, null, 0, null, null, null, data, 32)) throwLastError(api(), 'GetVolumeInformationByHandleW', this.path);
    if (data.toString('utf16le').split('\0')[0] !== 'NTFS') {
      throw new LocalizedError('error.ntfsRequired', { path: this.path }, { fallback: `NTFS is required: ${this.path}` });
    }
  }

  readBytes(maxBytes: number): Buffer {
    const info = this.information();
    requireKind(info, 'file', this.path);
    const size = BigInt(info.size);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= 0xffffffff || size > BigInt(maxBytes)) {
      throw new InvalidFileSizeError('error.fileTooLarge', { path: this.path, size: info.size, limit: maxBytes });
    }
    const data = Buffer.alloc(Number(size) + 1), count = Buffer.alloc(4);
    // The SDK's raw count-pointer allocator has no public matching free. A
    // Buffer out-parameter keeps this bounded read entirely GC-owned.
    if (!api().readBytes(this.handle, data, data.length, count, null)) throwLastError(api(), 'ReadFile', this.path);
    const length = count.readUInt32LE(0);
    if (length !== Number(size)) throw new InvalidFileSizeError('error.fileSizeChanged', { path: this.path, size: info.size, read: length });
    return data.subarray(0, length);
  }

  readJson(maxBytes: number): unknown {
    return JSON.parse(this.readBytes(maxBytes).toString('utf8')) as unknown;
  }

  /** FileLinkInformation uses the admitted source and destination directory handles. */
  linkTo(parent: NativeHold, name: string): void {
    const path = childPath(parent, name);
    const bytes = Buffer.from(name, 'utf16le');
    const info = Buffer.alloc(Math.max(24, 20 + bytes.length)); // x64 FILE_LINK_INFORMATION
    info.writeBigUInt64LE(BigInt(parent.handle), 8);
    info.writeUInt32LE(bytes.length, 16);
    bytes.copy(info, 20);
    this.setInformation(11, info, 'FileLinkInformation', path);
  }

  deleteEntry(): void {
    // POSIX disposition removes this name when our handle closes, even with other readers.
    // Omit IGNORE_READONLY_ATTRIBUTE so an obstruction never alters a shared file.
    this.setInformation(64, Buffer.from([3, 0, 0, 0]), 'FileDispositionInformationEx', this.path);
  }

  private setInformation(kind: number, info: Buffer, label: string, path: string): void {
    const status = api().setFileInformation(this.handle, Buffer.alloc(16), info, info.length, kind);
    if (status < 0) throw new Win32Error(label, api().statusToError(status), path);
  }

  [Symbol.dispose](): void { this.close(); }

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
  if (info.attributes & ATTR_REPARSE) {
    throw new LocalizedError('error.reparsePoint', { path }, { fallback: `Refusing reparse point: ${path}` });
  }
  if (!!(info.attributes & ATTR_DIRECTORY) !== (kind === 'directory')) throw new WrongEntryKindError('error.ordinaryEntryRequired', { kind, path });
}

function ordinaryPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice(8)}`;
  return path.startsWith('\\\\?\\') ? path.slice(4) : path;
}

export function absolutePath(path: string): string {
  requireWindows();
  if (!isAbsolute(path) || parse(path).root.length <= 1 || path.startsWith('\\\\?\\')
    || path.includes('\0') || path.length > 32767 || /[. ](?:[\\/]|$)/.test(path)
    || path.slice(2).includes(':')) throw new LocalizedError('error.absoluteWindowsPath', { path });
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
  return admitDirectoryPath(absolutePath(path), expected);
}

function admitDirectoryPath(path: string, expected?: FileIdentity): Directory {
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
    if (expected && !sameIdentity(info, expected)) throw new LocalizedError('error.directoryIdentityChanged', { path });
    hold.requireNtfs();
    return { path: hold.canonicalPath(), volumeSerial: info.volumeSerial, fileId: info.fileId };
  } finally { hold.close(); }
}

export function revalidateDirectory(directory: Directory): void {
  directoryHold(directory, 0, SHARE_ALL).close();
}

export function childPath(parent: Pick<Directory, 'path'>, name: string): string {
  // Enumerated interior names need not be valid generation IDs or conventional
  // Win32 spellings. Preserve one exact component, including trailing dots/spaces.
  if (!name || name === '.' || name === '..' || /[\\/:\0]/.test(name)) throw new LocalizedError('error.invalidChildName', { name });
  return join(parent.path, name);
}

/** An already admitted parent is reused during a bounded inventory/link pass. */
export function admitChildDirectory(parent: Directory, name: string, expected?: FileIdentity): Directory {
  const path = childPath(parent, name);
  const info = inspect(path);
  if (expected && !sameIdentity(info, expected)) throw new LocalizedError('error.directoryIdentityChanged', { path });
  return observedDirectory(path, info, parent.volumeSerial);
}

function observedDirectory(path: string, info: FileInformation, volumeSerial: string): Directory {
  requireKind(info, 'directory', path);
  if (info.volumeSerial !== volumeSerial) throw new LocalizedError('error.volumeBoundaryChanged', { path });
  return { path, volumeSerial: info.volumeSerial, fileId: info.fileId };
}

export function createDirectory(parent: Directory, name: string): Directory {
  using _parent = pinDirectory(parent);
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
    catch (cleanup) { throw new DirectoryRollbackError([error, cleanup], 'error.directoryRollbackFailed', { path }, { cause: cleanup }); }
    throw error;
  }
}

export function ensureDirectory(parent: Directory, name: string): Directory {
  using _parent = pinDirectory(parent);
  try { return admitChildDirectory(parent, name); }
  catch (error) { if (!isMissing(error)) throw error; }
  try { return createChildDirectory(parent, name); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return admitChildDirectory(parent, name);
  }
}

export function openOrdinaryFile(parent: Directory, name: string, writable = false): NativeHold {
  const path = childPath(parent, name), hold = open(path);
  try {
    const info = hold.information();
    requireKind(info, 'file', path);
    if (info.volumeSerial !== parent.volumeSerial) throw new LocalizedError('error.volumeBoundaryChanged', { path });
    if (writable && (info.attributes & ATTR_READONLY)) {
      throw new LocalizedError('error.readOnlySource', { path }, { fallback: `Refusing read-only source hardlink: ${path}` });
    }
    return hold;
  } catch (error) { hold.close(); throw error; }
}

/** Read one no-follow file under its admitted parent. Writers and deletion are excluded until close. */
export function readFileBytes(parent: Directory, name: string, maxBytes: number): Buffer {
  using hold = open(childPath(parent, name), READ, SHARE_READ);
  if (hold.information().volumeSerial !== parent.volumeSerial) throw new LocalizedError('error.volumeBoundaryChanged', { path: hold.path });
  return hold.readBytes(maxBytes);
}

export function readMetadata(parent: Directory, name: string, maxBytes: number): unknown {
  revalidateDirectory(parent);
  using hold = open(childPath(parent, name), READ);
  return hold.readJson(maxBytes);
}

export function writeNewMetadata(parent: Directory, name: string, value: unknown): void {
  using _parent = pinDirectory(parent);
  writeNewFile(parent, name, Buffer.from(JSON.stringify(value) + '\n'));
}

/** The caller holds the parent across creation and any rollback. */
export function writeNewFile(parent: Directory, name: string, bytes: Buffer): void {
  const fd = openSync(toNamespacedPath(childPath(parent, name)), 'wx', 0o600);
  const errors: unknown[] = [];
  try { writeFileSync(fd, bytes); } catch (error) { errors.push(error); }
  try { closeSync(fd); } catch (error) { errors.push(error); }
  if (errors.length) {
    try { unlinkEntry(parent, name); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    throw new LocalizedAggregateError(errors);
  }
}

function directoryHold(directory: Directory, access: number, sharing: number): NativeHold {
  const hold = open(directory.path, access, sharing);
  try {
    const info = hold.information();
    requireKind(info, 'directory', directory.path);
    if (!sameIdentity(info, directory)) throw new LocalizedError('error.directoryIdentityChanged', { path: directory.path });
    // Admission already established the ancestor chain and NTFS volume. Reuse
    // it only while this opened object still has that identity AND physical path.
    if (!samePath(hold.canonicalPath(), directory.path)) throw new LocalizedError('error.directoryRedirected', { path: directory.path });
    return hold;
  } catch (error) { hold.close(); throw error; }
}

export function pinDirectory(directory: Directory): NativeHold { return directoryHold(directory, READ, SHARE_READ_WRITE); }
export function claimDirectory(directory: Directory): NativeHold { return directoryHold(directory, DELETE, SHARE_READ_WRITE); }

/** Exclusive creation, no inheritance, automatically removed on close or death. */
export function createSetupLease(parent: Directory, name = '.setup-owner'): NativeHold {
  let lease: NativeHold | undefined;
  try {
    using _parent = pinDirectory(parent);
    lease = open(childPath(parent, name), 0xc0010000, 0, CREATE_NEW, DELETE_ON_CLOSE);
    return lease;
  } catch (error) { lease?.close(); throw error; }
}

export function requireActiveLease(parent: Directory, expected: FileIdentity): void {
  revalidateDirectory(parent);
  const lease = openOrdinaryFile(parent, '.setup-owner');
  try { if (!sameIdentity(lease.information(), expected)) throw new LocalizedError('error.leaseIdentityChanged'); }
  finally { lease.close(); }
}

export function openExclusiveMetadata(parent: Directory, name: string): NativeHold {
  revalidateDirectory(parent);
  const hold = open(childPath(parent, name), READ, 0);
  try { requireKind(hold.information(), 'file', hold.path); return hold; }
  catch (error) { hold.close(); throw error; }
}

export async function acquireWriterLock(cachePath: string, signal?: AbortSignal): Promise<NativeHold> {
  // A sibling lock covers first creation and final removal of the cache root.
  const directory = admitDirectory(dirname(cachePath)), name = basename(cachePath) + '.writer-lock';
  const started = performance.now(), path = toNamespacedPath(childPath(directory, name));
  let retriedAccessDenied = false;
  for (;;) {
    signal?.throwIfAborted();
    try { return createSetupLease(directory, name); }
    catch (error) {
      if (hasCloseFailure(error)) throw error;
      const code = (error as { win32Code?: number }).win32Code;
      if (performance.now() - started > 120_000 || ![5, 32, 80, 183].includes(code ?? 0)) throw error;
      const entry = lstatSync(path, { throwIfNoEntry: false });
      if (entry?.isSymbolicLink()) throw new LocalizedError('error.reparsePoint', { path });
      if (!signal || (entry && !entry.isFile())) throw error;
      if (entry) {
        // Live writers deny read sharing. An unlocked ordinary file belongs to someone else.
        let orphan: NativeHold | undefined;
        try { orphan = open(path, READ); }
        catch (inspection) {
          if (!isBusy(inspection) && !isMissing(inspection) && (inspection as Win32Error).win32Code !== 5) throw inspection;
        }
        if (orphan) { orphan.close(); throw error; }
      }
      // NTFS can report access denied while the previous lock is delete-pending.
      // A missing lock and a persistent access denial indicate an unwritable parent.
      if (code === 5 && !entry && retriedAccessDenied) throw error;
      retriedAccessDenied = code === 5 && !entry;
      // Timers wrap the abort reason. Preserve it so retirement is distinguishable from a setup failure.
      await delay(25, undefined, { signal }).catch(error => { signal.throwIfAborted(); throw error; });
    }
  }
}

/** Only the actual link syscall can authorize the later UAC choice. */
export function createHardlink(sourceParent: Directory, sourceName: string, targetParent: Directory, targetName: string): void {
  using _sourceParent = pinDirectory(sourceParent);
  using target = directoryHold(targetParent, READ + FILE_ADD_FILE, SHARE_READ_WRITE);
  if (sourceParent.volumeSerial !== targetParent.volumeSerial) throw new LocalizedError('error.hardlinkVolume');
  using source = openOrdinaryFile(sourceParent, sourceName, true);
  try { source.linkTo(target, targetName); }
  catch (error) {
    if ((error as { win32Code?: number }).win32Code === 5) Object.assign(error as object, { linkPermissionDenied: true });
    throw error;
  }
}

export function createJunction(parent: Directory, name: string, target: Directory): string {
  using _parent = pinDirectory(parent);
  using _target = pinDirectory(target);
  const path = childPath(parent, name);
  symlinkSync(toNamespacedPath(target.path), toNamespacedPath(path), 'junction'); // EEXIST is never adopted.
  try { admitJunction(parent, name, target); }
  catch (error) {
    // Only a successfully created name is ours to clean up on failed admission.
    try { unlinkEntry(parent, name); }
    catch (cleanup) { throw new LocalizedAggregateError([error, cleanup], 'error.junctionRollbackFailed', { path }, { cause: cleanup }); }
    throw error;
  }
  return path;
}

export function admitJunction(parent: Directory, name: string, target: Directory): void {
  const path = childPath(parent, name), info = inspect(path);
  if (!(info.attributes & ATTR_REPARSE) || info.reparseTag !== MOUNT_POINT) throw new LocalizedError('error.unexpectedJunction', { path });
  try {
    const direct = ordinaryPath(readlinkSync(toNamespacedPath(path)));
    // The expected spelling bounds the lookup. NTFS verifies each component and the target file ID.
    if (direct.toLowerCase() === target.path.toLowerCase()) {
      admitDirectoryPath(direct, target);
      return;
    }
  } catch (cause) {
    if (hasCloseFailure(cause)) throw cause;
    throw new LocalizedError('error.unexpectedJunction', { path }, { cause, failures: [cause] });
  }
  throw new LocalizedError('error.unexpectedJunction', { path });
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
export function unlinkEntry(parent: Directory, name: string): void { removeTree(parent, name, false); }

function removeDirectoryName(path: string): void {
  if (!api().removeDirectory(toNamespacedPath(path))) throwLastError(api(), 'RemoveDirectoryW', path);
}

/** Open the entry itself and retain its identity through enumeration or deletion. */
export function removeTree(parent: Directory, name: string, recursive = true): void {
  revalidateDirectory(parent);
  const path = childPath(parent, name);
  let entry: NativeHold;
  try { entry = open(path, DELETE, SHARE_READ_WRITE); }
  catch (error) { if (isMissing(error)) return; throw error; }
  using hold = entry;
  const info = hold.information();
  if (!samePath(hold.canonicalPath(), path)) throw new LocalizedError('error.directoryRedirected', { path });
  if (info.attributes & ATTR_REPARSE) {
    if (![MOUNT_POINT, SYMLINK].includes(info.reparseTag)) throw new LocalizedError('error.unsupportedReparseTag', { path });
  } else if (info.attributes & ATTR_DIRECTORY) {
    if (!recursive) throw new LocalizedError('error.cannotUnlinkDirectory', { path });
    removeDirectoryTree(observedDirectory(path, info, parent.volumeSerial), hold);
    return;
  }
  hold.deleteEntry();
}

export function removeDirectoryTree(directory: Directory, hold: NativeHold): void {
  for (const child of children(directory)) removeTree(directory, child);
  hold.deleteEntry();
}

export function removeEmptyDirectory(directory: Directory): void {
  using hold = claimDirectory(directory);
  hold.deleteEntry();
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
