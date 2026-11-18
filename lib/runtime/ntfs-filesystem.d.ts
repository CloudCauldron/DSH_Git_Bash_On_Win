import { type NativePtr } from '@deepseek-ai/dsh-win32-process';
import { LocalizedAggregateError, LocalizedError } from '../localized-error.ts';
export interface FileIdentity {
    readonly volumeSerial: string;
    readonly fileId: string;
}
export interface Directory extends FileIdentity {
    readonly path: string;
}
interface FileInformation extends FileIdentity {
    readonly size: string;
    readonly lastWriteTime: string;
    readonly attributes: number;
    readonly reparseTag: number;
}
export declare function requireWindows(): void;
export declare function isMissing(error: unknown): boolean;
export declare function isBusy(error: unknown): boolean;
export declare class InvalidMetadataError extends LocalizedError {
}
/** The new name was created, but neither admission nor its rollback completed. */
export declare class DirectoryRollbackError extends LocalizedAggregateError {
}
export declare function hasCloseFailure(error: unknown): boolean;
/** Resource failures must never disappear inside best-effort artifact cleanup. */
export declare function bestEffort(action: () => void): void;
export declare class NativeHold {
    private closed;
    private observation?;
    readonly path: string;
    private readonly handle;
    constructor(path: string, handle: NativePtr);
    information(): FileInformation;
    canonicalPath(): string;
    requireNtfs(): void;
    readJson(maxBytes: number): unknown;
    close(): void;
}
export declare function absolutePath(path: string): string;
export declare function samePath(a: string, b: string): boolean;
export declare function sameIdentity(a: FileIdentity, b: FileIdentity): boolean;
/** Borrowed debug-event file handles stay owned by the event dispatcher. */
export declare function fileIdentity(handle: NativePtr): FileIdentity;
export declare function canonicalExistingPath(path: string): string;
export declare function containsPath(parent: string, child: string): boolean;
export declare function overlaps(a: string, b: string): boolean;
/** Walk ancestors before opening a target; cache/source policy stays with callers. */
export declare function admitDirectory(path: string, expected?: FileIdentity): Directory;
export declare function revalidateDirectory(directory: Directory): void;
export declare function childPath(parent: Directory, name: string): string;
/** An already admitted parent is reused during a bounded inventory/link pass. */
export declare function admitChildDirectory(parent: Directory, name: string, expected?: FileIdentity): Directory;
export declare function createDirectory(parent: Directory, name: string): Directory;
export declare function ensureDirectory(parent: Directory, name: string): Directory;
export declare function openOrdinaryFile(parent: Directory, name: string, writable?: boolean): NativeHold;
export declare function readMetadata(parent: Directory, name: string, maxBytes: number): unknown;
export declare function writeNewMetadata(parent: Directory, name: string, value: unknown): void;
export declare function pinDirectory(directory: Directory): NativeHold;
export declare function claimDirectory(directory: Directory): NativeHold;
/** Exclusive creation, no inheritance, automatically removed on close or death. */
export declare function createSetupLease(parent: Directory, name?: string): NativeHold;
export declare function requireActiveLease(parent: Directory, expected: FileIdentity): void;
export declare function openExclusiveMetadata(parent: Directory, name: string): NativeHold;
export declare function acquireWriterLock(directory: Directory, signal: AbortSignal): Promise<NativeHold>;
/** Only the actual link syscall can authorize the later UAC choice. */
export declare function createHardlink(sourceParent: Directory, sourceName: string, targetParent: Directory, targetName: string): void;
export declare function createJunction(parent: Directory, name: string, target: Directory): string;
export declare function admitJunction(parent: Directory, name: string, target: Directory): void;
export declare function canonicalWorkspace(path: string): Promise<string>;
/** Includes malformed names; enumeration does not grant permission to follow links. */
export declare function children(directory: Directory): string[];
export declare function ordinaryChildDirectory(parent: Directory, name: string): Directory | undefined;
/** Unlink controls before traversing payload. Never decode their contents. */
export declare function unlinkEntry(parent: Directory, name: string): void;
/** Caller owns any required generation claim; this primitive has no cache policy. */
export declare function removeTree(parent: Directory, name: string): void;
/** Retains the caller's admitted identity, especially while a DELETE claim is held. */
export declare function removeDirectoryTree(directory: Directory): void;
export declare function removeEmptyDirectory(directory: Directory): void;
/** Node enumeration hints are not authoritative for reparse/read-only admission. */
export declare function ordinaryFileExists(parent: Directory, name: string): boolean;
export declare function pathExists(path: string): boolean;
export {};
