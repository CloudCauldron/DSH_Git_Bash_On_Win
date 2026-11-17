import koffi from 'koffi';
import { tmpdir } from 'node:os';
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox';
import { tempWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl';
import { closeHandleChecked, extendWin32ProcessBindings, isNullPtr, spawnCurrentTokenJobProcess, throwLastError, type CurrentTokenProcessSpawnOptions, type NativePtr } from '@deepseek-ai/dsh-win32-process';

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

let bindings: ReturnType<typeof extendWin32ProcessBindings<DebugBindings>> | undefined;
export function debugApi() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native Windows x64 is required.');
  return bindings ??= extendWin32ProcessBindings(({ kernel32, advapi32, bind }) => ({
    currentProcess: bind(kernel32, 'GetCurrentProcess', 'void *', []),
    waitDebug: bind(kernel32, 'WaitForDebugEvent', 'int', ['void *', 'uint32']),
    continueDebug: bind(kernel32, 'ContinueDebugEvent', 'int', ['uint32', 'uint32', 'uint32']),
    killOnDebuggerExit: bind(kernel32, 'DebugSetProcessKillOnExit', 'int', ['int']),
    getContext: bind(kernel32, 'GetThreadContext', 'int', ['void *', 'void *']),
    setContext: bind(kernel32, 'SetThreadContext', 'int', ['void *', 'void *']),
    module: bind(kernel32, 'GetModuleHandleW', 'void *', ['str16']),
    symbol: bind(kernel32, 'GetProcAddress', 'void *', ['void *', 'str']),
    filePath: bind(kernel32, 'GetFinalPathNameByHandleW', 'uint32', ['void *', 'void *', 'uint32', 'uint32']),
    modulePath: bind(kernel32, 'K32GetModuleFileNameExW', 'uint32', ['void *', 'void *', 'void *', 'uint32']),
    readMemory: bind(kernel32, 'ReadProcessMemory', 'int', ['void *', 'void *', 'void *', 'size_t', 'void *']),
    writeMemory: bind(kernel32, 'WriteProcessMemory', 'int', ['void *', 'void *', 'void *', 'size_t', 'void *']),
    allocateMemory: bind(kernel32, 'VirtualAllocEx', 'void *', ['void *', 'void *', 'size_t', 'uint32', 'uint32']),
    descriptorText: bind(advapi32, 'ConvertSecurityDescriptorToStringSecurityDescriptorW', 'int', ['void *', 'uint32', 'uint32', 'void *', 'void *']),
    descriptor: bind(advapi32, 'ConvertStringSecurityDescriptorToSecurityDescriptorW', 'int', ['str16', 'uint32', 'void *', 'void *']),
    localFree: bind(kernel32, 'LocalFree', 'void *', ['void *']),
    inJob: bind(kernel32, 'IsProcessInJob', 'int', ['void *', 'void *', 'void *']),
    duplicateHandle: bind(kernel32, 'DuplicateHandle', 'int', ['void *', 'void *', 'void *', 'void *', 'uint32', 'int', 'uint32']),
    queryObject: bind(koffi.load('ntdll.dll'), 'NtQueryObject', 'int32', ['void *', 'int', 'void *', 'uint32', 'void *']),
    processInformation: bind(koffi.load('ntdll.dll'), 'NtQueryInformationProcess', 'int32', ['void *', 'int', 'void *', 'uint32', 'void *']),
    openToken: bind(advapi32, 'OpenProcessToken', 'int', ['void *', 'uint32', 'void *']),
    tokenInfo: bind(advapi32, 'GetTokenInformation', 'int', ['void *', 'int', 'void *', 'uint32', 'void *']),
    restricted: bind(advapi32, 'IsTokenRestricted', 'int', ['void *']),
  }) as DebugBindings);
}

export function pointer(buffer: Buffer, offset = 0): NativePtr {
  const value = buffer.readBigUInt64LE(offset) as NativePtr;
  if (!valid(value)) throw new Error('Missing native pointer.');
  return value;
}
export function valid(value: NativePtr | null | undefined): value is NativePtr {
  return !isNullPtr(value) && BigInt.asUintN(64, value) !== 0xffffffffffffffffn;
}
export function checked(result: number, operation: string): void {
  if (!result) throwLastError(debugApi(), operation);
}
export function close(handle: NativePtr | null): void {
  if (valid(handle)) closeHandleChecked(debugApi(), handle, 'private debugger');
}
function freeLocal(memory: NativePtr): void {
  if (!isNullPtr(debugApi().localFree(memory))) throwLastError(debugApi(), 'LocalFree');
}

export function fileName(handle: NativePtr | null): string {
  if (!valid(handle)) return '';
  const data = Buffer.alloc(65536), length = debugApi().filePath(handle, data, data.length / 2, 0);
  return length > 0 && length < data.length / 2 ? data.subarray(0, length * 2).toString('utf16le') : '';
}
export function loaderPath(process: NativePtr, base: bigint): string {
  const data = Buffer.alloc(65536), length = debugApi().modulePath(process, base, data, data.length / 2);
  return length > 0 && length < data.length / 2 ? data.subarray(0, length * 2).toString('utf16le') : '';
}

export function imagePath(process: NativePtr): string {
  const data = Buffer.alloc(48), api = debugApi();
  const status = api.processInformation(process, 0, data, data.length, null);
  if (status < 0) throw new Error(`NtQueryInformationProcess: 0x${(status >>> 0).toString(16)}`);
  const parameters = readMemory(process, data.readBigUInt64LE(8) + 0x20n, 8).readBigUInt64LE();
  const image = readMemory(process, parameters + 0x60n, 16), bytes = image.readUInt16LE();
  if (!bytes || bytes > 32768 || bytes % 2) throw new Error('Invalid process image path.');
  return readMemory(process, image.readBigUInt64LE(8), bytes).toString('utf16le');
}

export function imageLayout(header: Buffer): { size: number; x64: boolean } {
  if (header.length < 64 || header.readUInt16LE() !== 0x5a4d) throw new Error('Invalid module DOS header.');
  const pe = header.readUInt32LE(0x3c);
  if (pe + 84 > header.length || header.readUInt32LE(pe) !== 0x00004550) throw new Error('Invalid module PE header.');
  const x64 = header.readUInt16LE(pe + 4) === 0x8664 && header.readUInt16LE(pe + 24) === 0x20b;
  const size = header.readUInt32LE(pe + 24 + 56);
  if (size < 4096) throw new Error('Invalid module image size.');
  return { size, x64 };
}

interface EventIdentity { readonly pid: number; readonly tid: number }
export type DebugEvent = EventIdentity & (
  | { kind: 'process'; file: NativePtr | null; process: NativePtr; thread: NativePtr }
  | { kind: 'thread'; thread: NativePtr }
  | { kind: 'exit-thread' }
  | { kind: 'exit'; exitCode: number }
  | { kind: 'module'; file: NativePtr | null; base: bigint; nameSlot: bigint; unicode: boolean }
  | { kind: 'unload'; base: bigint }
  | { kind: 'exception'; code: number; address: bigint }
  | { kind: 'other' }
);

/** DEBUG_EVENT x64: 176 bytes, union at 16. Process/thread handles are
 * borrowed until ContinueDebugEvent on their exit; event image files are ours.
 * https://learn.microsoft.com/windows/win32/api/debugapi/nf-debugapi-waitfordebugevent */
export function waitDebugEvent(milliseconds: number): DebugEvent | undefined {
  const data = Buffer.alloc(176), api = debugApi();
  if (!api.waitDebug(data, milliseconds)) {
    if (api.getLastError() === 121) return;
    throwLastError(api, 'WaitForDebugEvent');
  }
  const identity = { pid: data.readUInt32LE(4), tid: data.readUInt32LE(8) };
  const optionalFile = () => data.readBigUInt64LE(16) ? pointer(data, 16) : null;
  switch (data.readUInt32LE()) {
    case 1: return { ...identity, kind: 'exception', code: data.readUInt32LE(16), address: data.readBigUInt64LE(32) };
    case 2: return { ...identity, kind: 'thread', thread: pointer(data, 16) };
    case 3: return { ...identity, kind: 'process', file: optionalFile(), process: pointer(data, 24), thread: pointer(data, 32) };
    case 4: return { ...identity, kind: 'exit-thread' };
    case 5: return { ...identity, kind: 'exit', exitCode: data.readUInt32LE(16) };
    case 6: return { ...identity, kind: 'module', file: optionalFile(), base: data.readBigUInt64LE(24), nameSlot: data.readBigUInt64LE(40), unicode: !!data.readUInt16LE(48) };
    case 7: return { ...identity, kind: 'unload', base: data.readBigUInt64LE(16) };
    default: return { ...identity, kind: 'other' };
  }
}

/** Query only: DSH creates the token and policy; the plugin never relaxes it. */
export interface IpcCompatibility { readonly confined: boolean; readonly pipeSid: string; readonly defaultDaclSid: string }
export function inheritedCompatibility(mode: SandboxMode): IpcCompatibility {
  const api = debugApi(), output = Buffer.alloc(8);
  checked(api.openToken(api.currentProcess(), 8, output), 'OpenProcessToken(query)');
  const token = pointer(output);
  try {
    const query = (kind: number): Buffer => {
      const needed = Buffer.alloc(4);
      api.tokenInfo(token, kind, null, 0, needed);
      const bytes = needed.readUInt32LE();
      if (bytes < 4 || bytes > 65_536) throw new Error('Invalid token information size.');
      const result = Buffer.alloc(bytes);
      checked(api.tokenInfo(token, kind, result, bytes, needed), 'GetTokenInformation');
      return result;
    };
    const groups = (kind: number) => {
      const data = query(kind), count = data.readUInt32LE();
      if (8 + count * 16 > data.length) throw new Error('Invalid TOKEN_GROUPS layout.');
      return Array.from({ length: count }, (_, index) => ({
        sid: sidText(data, 8 + index * 16), attributes: data.readUInt32LE(16 + index * 16),
      }));
    };
    const logon = groups(2).find(group => ((group.attributes & 0xc0000000) >>> 0) === 0xc0000000)?.sid;
    if (!logon) throw new Error('The inherited token has no logon SID.');
    requireJobMember(api.currentProcess(), null);
    if (mode === 'danger-full-access') {
      if (api.restricted(token)) throw new Error('Full-access policy cannot use a restricted inherited token.');
      return { confined: false, pipeSid: logon, defaultDaclSid: logon };
    }
    const restrictions = groups(11).map(group => group.sid);
    const user = sidText(query(1)), integrity = sidText(query(25));
    const capabilities = restrictions.filter(value => value.startsWith('S-1-4-'));
    if (!api.restricted(token) || integrity !== 'S-1-16-4096' || restrictions.includes(user)
      || restrictions.includes('S-1-5-11') || !restrictions.includes(logon)) throw new Error('DSH Windows sandbox restrictions are missing.');
    if (mode === 'read-only' && capabilities.length === 0) return { confined: true, pipeSid: logon, defaultDaclSid: logon };
    const temp = tempWriteSid(tmpdir());
    if (mode === 'workspace-write' && capabilities.includes(temp)) return { confined: true, pipeSid: temp, defaultDaclSid: temp };
    throw new Error('The inherited DSH mode or private-temp capability is incompatible.');
  } finally { close(token); }
}

function sidText(data: Buffer, pointerOffset = 0): string {
  // TOKEN_* pointers refer into the same caller-owned query buffer. Decode
  // there, keeping its storage alive and rejecting pointers outside its bounds.
  const relative = pointer(data, pointerOffset) - koffi.address(data);
  if (relative < 0n || relative > BigInt(data.length - 8)) throw new Error('Invalid token SID pointer.');
  const offset = Number(relative), count = data[offset + 1]!;
  if (data[offset] !== 1 || count > 15 || offset + 8 + count * 4 > data.length) throw new Error('Invalid SID.');
  let authority = 0;
  for (let index = 2; index < 8; index++) authority = authority * 256 + data[offset + index]!;
  return `S-1-${authority}` + Array.from({ length: count }, (_, index) => `-${data.readUInt32LE(offset + 8 + index * 4)}`).join('');
}

export function requireJobMember(process: NativePtr, job: NativePtr | null): void {
  const member = Buffer.alloc(4);
  checked(debugApi().inJob(process, job, member), 'IsProcessInJob');
  if (!member.readUInt32LE()) throw new Error('Private DSH Job containment is required.');
}

export function spawnDebugFamily(options: CurrentTokenProcessSpawnOptions) {
  const api = debugApi();
  return spawnCurrentTokenJobProcess({ ...api, createProcessW: (...args: Parameters<typeof api.createProcessW>) => {
    args[5] |= 1; // DEBUG_PROCESS observes descendants; DSH assigns the private Job before resume.
    return api.createProcessW(...args);
  } }, options);
}

export function readMemory(process: NativePtr, address: bigint, bytes: number): Buffer {
  if (address === 0n || !Number.isInteger(bytes) || bytes < 0 || bytes > 65_536) throw new Error('Invalid bounded memory read.');
  const buffer = Buffer.alloc(bytes), got = Buffer.alloc(8);
  checked(debugApi().readMemory(process, address, buffer, bytes, got), 'ReadProcessMemory');
  if (got.readBigUInt64LE() !== BigInt(bytes)) throw new Error('Partial process memory read.');
  return buffer;
}

export function writeMemory(process: NativePtr, address: bigint, payload: Buffer): void {
  if (!address || payload.length > 65_536) throw new Error('Invalid bounded memory write.');
  const written = Buffer.alloc(8);
  checked(debugApi().writeMemory(process, address, payload, payload.length, written), 'WriteProcessMemory');
  if (written.readBigUInt64LE() !== BigInt(payload.length)) throw new Error('Partial process memory write.');
}

export function writeData(process: NativePtr, payload: Buffer): NativePtr {
  if (!payload.length || payload.length > 65_536) throw new Error('Invalid private data allocation.');
  const memory = debugApi().allocateMemory(process, null, payload.length, 0x3000, 0x04);
  if (!valid(memory)) throwLastError(debugApi(), 'VirtualAllocEx(data)');
  writeMemory(process, memory, payload);
  return memory;
}

export function wide(process: NativePtr, address: bigint, maximum = 512): string {
  if (maximum > 32768) throw new Error('Invalid Unicode bound.');
  const chars: number[] = [];
  for (let i = 0; i < maximum; i++) {
    const code = readMemory(process, address + BigInt(i * 2), 2).readUInt16LE();
    if (code === 0) return String.fromCharCode(...chars);
    chars.push(code);
  }
  throw new Error('Unterminated process string.');
}

/** x64 CONTEXT offsets; only hardware debug registers and data arguments change. */
export const registers = { rcx: 128, rdx: 136, rsp: 152, r8: 184, r9: 192 } as const;
export class ThreadContext {
  private readonly memory = koffi.alloc('uint64', 154) as NativePtr;
  constructor() {
    if (!valid(this.memory) || (this.memory & 15n) !== 0n) {
      if (valid(this.memory)) koffi.free(this.memory);
      throw new Error('A 16-byte aligned x64 CONTEXT is required.');
    }
  }
  read64(offset: number): bigint { return BigInt(koffi.decode(this.memory, offset, 'uint64') as bigint); }
  write64(offset: number, value: bigint): void { koffi.encode(this.memory, offset, 'uint64', value); }
  load(thread: NativePtr): void {
    koffi.encode(this.memory, 48, 'uint32', 0x00100013);
    checked(debugApi().getContext(thread, this.memory), 'GetThreadContext');
  }
  save(thread: NativePtr): void { checked(debugApi().setContext(thread, this.memory), 'SetThreadContext'); }
  arm(thread: NativePtr, addresses: readonly (bigint | undefined)[], alreadyArmed: boolean): void {
    this.load(thread);
    if (!alreadyArmed && (this.read64(112) & 255n) !== 0n) throw new Error('Refusing pre-existing debug-register state.');
    if (addresses.length > 4) throw new Error('Too many hardware breakpoints.');
    let enabled = 0n;
    addresses.forEach((address, i) => {
      this.write64(72 + i * 8, address ?? 0n);
      if (address !== undefined) enabled |= 1n << BigInt(i * 2);
    });
    this.write64(104, 0n); this.write64(112, enabled); this.save(thread);
  }
  resume(thread: NativePtr): void {
    this.write64(104, 0n);
    koffi.encode(this.memory, 68, 'uint32', Number(koffi.decode(this.memory, 68, 'uint32')) | 0x10000);
    this.save(thread);
  }
  close(): void { koffi.free(this.memory); }
}

export function readDescriptor(process: NativePtr, address: bigint) {
  const header = readMemory(process, address, 20);
  const control = header.readUInt16LE(2);
  if ((control & 0x8000) !== 0) {
    let bytes = 20;
    for (let i = 0; i < 4; i++) {
      const offset = header.readUInt32LE(4 + i * 4);
      if (!offset) continue;
      const first = readMemory(process, address + BigInt(offset), 8);
      const size = i < 2 ? 8 + first[1]! * 4 : first.readUInt16LE(2);
      if (size < 8 || offset + size > 65_536) throw new Error('Invalid relative security descriptor.');
      bytes = Math.max(bytes, offset + size);
    }
    return readMemory(process, address, bytes);
  }
  const absolute = readMemory(process, address, 40);
  const pieces: Buffer[] = [];
  const result = Buffer.alloc(20);
  header.copy(result, 0, 0, 4);
  result.writeUInt16LE(control | 0x8000, 2);
  let length = 20;
  for (let i = 0; i < 4; i++) {
    const item = absolute.readBigUInt64LE(8 + i * 8);
    if (!item) continue;
    const first = readMemory(process, item, 8);
    const size = i < 2 ? 8 + first[1]! * 4 : first.readUInt16LE(2);
    if (size < 8 || size > 16_384) throw new Error('Invalid absolute security descriptor.');
    const padding = (4 - length % 4) % 4;
    if (padding) { pieces.push(Buffer.alloc(padding)); length += padding; }
    result.writeUInt32LE(length, 4 + i * 4);
    pieces.push(readMemory(process, item, size)); length += size;
  }
  return Buffer.concat([result, ...pieces]);
}
export function descriptorText(buffer: Buffer) {
  const slot = Buffer.alloc(8), count = Buffer.alloc(4);
  checked(debugApi().descriptorText(buffer, 1, 0x0f, slot, count), "descriptorText");
  const address = pointer(slot);
  try { return wide(debugApi().currentProcess(), address!, Math.min(count.readUInt32LE(), 4096)); }
  finally { freeLocal(address); }
}
export function objectName(process: NativePtr, remoteHandle: bigint) {
  const output = Buffer.alloc(8);
  const self = debugApi().currentProcess();
  checked(debugApi().duplicateHandle(process, remoteHandle, self, output, 0, 0, 2), "duplicateHandle");
  const handle = pointer(output);
  try {
    const buffer = Buffer.alloc(4096), needed = Buffer.alloc(4);
    const status = Number(debugApi().queryObject(handle, 1, buffer, buffer.length, needed));
    if (status < 0) throw new Error(`NtQueryObject(name): 0x${(status >>> 0).toString(16)}`);
    const length = buffer.readUInt16LE();
    if (length < 2 || length > 2048 || length % 2) throw new Error('Invalid private namespace name.');
    return readMemory(self, pointer(buffer, 8)!, length).toString('utf16le');
  } finally { close(handle); }
}
export function mergedDescriptor(original: string, sid: string) {
  const sddl = original.replace(/(?=S:|$)/, `(A;;GA;;;${sid})`);
  if (!original.includes('D:') || original.includes('NO_ACCESS_CONTROL')) throw new Error('Unsupported pipe DACL.');
  const slot = Buffer.alloc(8), count = Buffer.alloc(4);
  checked(debugApi().descriptor(sddl, 1, slot, count), "descriptor");
  const local = pointer(slot);
  try {
    const bytes = count.readUInt32LE();
    if (bytes < 20 || bytes > 16_384) throw new Error('Invalid replacement descriptor length.');
    return readMemory(debugApi().currentProcess(), local!, bytes);
  } finally { freeLocal(local); }
}

/** x64 SECURITY_ATTRIBUTES and stack argument 7 of CreateNamedPipeW. */
export function grantPipe(process: NativePtr, stack: bigint, attributes: bigint, original: string, sid: string): void {
  const payload = readMemory(process, attributes, 24);
  if (payload.readUInt32LE() !== 24 || payload.readUInt32LE(16) > 1) throw new Error('Invalid SECURITY_ATTRIBUTES.');
  payload.writeBigUInt64LE(writeData(process, mergedDescriptor(original, sid)), 8);
  const argument = Buffer.alloc(8); argument.writeBigUInt64LE(writeData(process, payload));
  writeMemory(process, stack + 0x40n, argument);
}

export function defaultDaclText(process: NativePtr, information: bigint): string {
  const acl = readMemory(process, information, 8).readBigUInt64LE();
  const bytes = readMemory(process, acl, 8).readUInt16LE(2);
  if (bytes < 8 || bytes > 16384) throw new Error('Invalid proposed TOKEN_DEFAULT_DACL.');
  const relative = Buffer.alloc(20 + bytes);
  relative[0] = 1; relative.writeUInt16LE(0x8004, 2); relative.writeUInt32LE(20, 16);
  readMemory(process, acl, bytes).copy(relative, 20);
  return descriptorText(relative);
}

export function grantDefaultDacl(process: NativePtr, original: string, sid: string): NativePtr {
  const sd = mergedDescriptor(original, sid), offset = sd.readUInt32LE(16);
  if (offset < 20 || offset + 8 > sd.length) throw new Error('Invalid replacement DACL offset.');
  const length = sd.readUInt16LE(offset + 2);
  if (length < 8 || offset + length > sd.length) throw new Error('Invalid replacement DACL length.');
  const information = Buffer.alloc(8);
  information.writeBigUInt64LE(writeData(process, sd.subarray(offset, offset + length)));
  return writeData(process, information);
}

export function objectAttributes(process: NativePtr, address: bigint) {
  const attributes = readMemory(process, address, 48);
  if (attributes.readUInt32LE() !== 48) throw new Error('Invalid section OBJECT_ATTRIBUTES.');
  const namePointer = attributes.readBigUInt64LE(16), root = attributes.readBigUInt64LE(8);
  let name = '';
  if (namePointer) {
    const unicode = readMemory(process, namePointer, 16), bytes = unicode.readUInt16LE();
    if (bytes > 2048 || bytes % 2) throw new Error('Invalid section name length.');
    if (bytes) name = readMemory(process, unicode.readBigUInt64LE(8), bytes).toString('utf16le');
  }
  return { attributes, root, name };
}

export function grantObjectAttributes(process: NativePtr, attributes: Buffer, original: string, sid: string): NativePtr {
  const replacement = Buffer.from(attributes);
  replacement.writeBigUInt64LE(writeData(process, mergedDescriptor(original, sid)), 32);
  return writeData(process, replacement);
}
