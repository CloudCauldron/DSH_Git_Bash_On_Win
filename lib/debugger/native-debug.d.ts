import type { SandboxMode } from '@deepseek-ai/dsh-sandbox';
import { type CurrentTokenProcessSpawnOptions, type NativePtr } from '@deepseek-ai/dsh-win32-process';
interface DebugBindings {
    currentProcess(): NativePtr;
    waitDebug(event: Buffer, milliseconds: number): number;
    continueDebug(pid: number, tid: number, disposition: number): number;
    killOnDebuggerExit(kill: number): number;
    getContext(thread: NativePtr, context: NativePtr): number;
    setContext(thread: NativePtr, context: NativePtr): number;
    module(name: string): NativePtr | null;
    symbol(module: NativePtr, name: string): NativePtr | null;
    filePath(file: NativePtr, output: Buffer, length: number, flags: number): number;
    modulePath(process: NativePtr, base: bigint, output: Buffer, length: number): number;
    readMemory(process: NativePtr, address: bigint, output: Buffer, length: number, read: Buffer): number;
    writeMemory(process: NativePtr, address: bigint, input: Buffer, length: number, written: Buffer): number;
    allocateMemory(process: NativePtr, address: null, length: number, kind: number, protection: number): NativePtr | null;
    descriptorText(descriptor: Buffer, revision: number, information: number, output: Buffer, length: Buffer): number;
    descriptor(text: string, revision: number, output: Buffer, length: Buffer): number;
    localFree(memory: NativePtr): NativePtr | null;
    inJob(process: NativePtr, job: NativePtr | null, member: Buffer): number;
    duplicateHandle(source: NativePtr, handle: bigint, target: NativePtr, output: Buffer, access: number, inherit: number, options: number): number;
    queryObject(handle: NativePtr, kind: number, output: Buffer, length: number, needed: Buffer): number;
    processInformation(process: NativePtr, kind: number, output: Buffer, length: number, needed: null): number;
    openToken(process: NativePtr, access: number, output: Buffer): number;
    tokenInfo(token: NativePtr, kind: number, output: Buffer | null, length: number, needed: Buffer): number;
    restricted(token: NativePtr): number;
}
export declare function debugApi(): import("@deepseek-ai/dsh-win32-process").CurrentTokenProcessBindings & DebugBindings;
export declare function pointer(buffer: Buffer, offset?: number): NativePtr;
export declare function valid(value: NativePtr | null | undefined): value is NativePtr;
export declare function checked(result: number, operation: string): void;
export declare function close(handle: NativePtr | null): void;
export declare function fileName(handle: NativePtr | null): string;
export declare function loaderPath(process: NativePtr, base: bigint): string;
export declare function imagePath(process: NativePtr): string;
export declare function imageLayout(header: Buffer): {
    size: number;
    x64: boolean;
};
interface EventIdentity {
    readonly pid: number;
    readonly tid: number;
}
export type DebugEvent = EventIdentity & ({
    kind: 'process';
    file: NativePtr | null;
    process: NativePtr;
    thread: NativePtr;
} | {
    kind: 'thread';
    thread: NativePtr;
} | {
    kind: 'exit-thread';
} | {
    kind: 'exit';
    exitCode: number;
} | {
    kind: 'module';
    file: NativePtr | null;
    base: bigint;
    nameSlot: bigint;
    unicode: boolean;
} | {
    kind: 'unload';
    base: bigint;
} | {
    kind: 'exception';
    code: number;
    address: bigint;
} | {
    kind: 'other';
});
/** DEBUG_EVENT x64: 176 bytes, union at 16. Process/thread handles are
 * borrowed until ContinueDebugEvent on their exit; event image files are ours.
 * https://learn.microsoft.com/windows/win32/api/debugapi/nf-debugapi-waitfordebugevent */
export declare function waitDebugEvent(milliseconds: number): DebugEvent | undefined;
/** Query only: DSH creates the token and policy; the plugin never relaxes it. */
export interface IpcCompatibility {
    readonly grantSid: string | undefined;
}
export declare function inheritedCompatibility(mode: SandboxMode): IpcCompatibility;
export declare function requireJobMember(process: NativePtr, job: NativePtr | null): void;
export declare function spawnDebugFamily(options: CurrentTokenProcessSpawnOptions): import("@deepseek-ai/dsh-win32-process").SpawnedJobProcess;
export declare function readMemory(process: NativePtr, address: bigint, bytes: number): Buffer;
export declare function writeMemory(process: NativePtr, address: bigint, payload: Buffer): void;
export declare function writeData(process: NativePtr, payload: Buffer): NativePtr;
export declare function wide(process: NativePtr, address: bigint, maximum?: number): string;
/** x64 CONTEXT offsets; only hardware debug registers and data arguments change. */
export declare const registers: {
    readonly rcx: 128;
    readonly rdx: 136;
    readonly rsp: 152;
    readonly r8: 184;
    readonly r9: 192;
};
export declare class ThreadContext {
    private readonly memory;
    constructor();
    read64(offset: number): bigint;
    write64(offset: number, value: bigint): void;
    load(thread: NativePtr): void;
    save(thread: NativePtr): void;
    arm(thread: NativePtr, addresses: readonly (bigint | undefined)[], alreadyArmed: boolean): void;
    resume(thread: NativePtr): void;
    close(): void;
}
export declare function readDescriptor(process: NativePtr, address: bigint): Buffer<ArrayBufferLike>;
export declare function descriptorText(buffer: Buffer): string;
export declare function objectName(process: NativePtr, remoteHandle: bigint): string;
export declare function mergedDescriptor(original: string, sid: string): Buffer<ArrayBufferLike>;
/** x64 SECURITY_ATTRIBUTES and stack argument 7 of CreateNamedPipeW. */
export declare function grantPipe(process: NativePtr, stack: bigint, attributes: bigint, original: string, sid: string): void;
export declare function defaultDaclText(process: NativePtr, information: bigint): string;
export declare function grantDefaultDacl(process: NativePtr, original: string, sid: string): NativePtr;
export declare function objectAttributes(process: NativePtr, address: bigint): {
    attributes: Buffer<ArrayBufferLike>;
    root: bigint;
    name: string;
};
export declare function grantObjectAttributes(process: NativePtr, attributes: Buffer, original: string, sid: string): NativePtr;
export {};
