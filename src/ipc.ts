import { readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, win32 } from 'node:path';
import type { createRequire } from 'node:module';
import { contains } from './private-runtime.ts';

export interface NativeRuntime {
  aclRequire: ReturnType<typeof createRequire>;
  baseRequire: ReturnType<typeof createRequire>;
  load(require: ReturnType<typeof createRequire>, name: string): Promise<any>;
}

type Ptr = bigint | null;
type Fn = (...args: unknown[]) => unknown;
interface Ffi {
  load(name: string): { func(convention: string, name: string, result: string, args: string[]): Fn };
  alloc(type: string, count: number): Ptr;
  free(pointer: Ptr): void;
  decode(pointer: Ptr | Buffer, offset: number, type: string): unknown;
  encode(pointer: Ptr, offset: number, type: string, value: unknown): void;
}
interface BindContext {
  kernel32: unknown; advapi32: unknown;
  bind(library: unknown, name: string, result: string, args: string[]): Fn;
}
export interface ProbeOptions {
  privateRoot: string;
  bash: string;
  cwd: string;
  command: string;
  pipeSid: string;
  defaultDaclSid?: string;
  installationRoot?: string;
  repairPipe: boolean;
  repairDefaultDacl?: boolean;
  repairMappings?: boolean;
  followFamily?: boolean;
  inheritStdio?: boolean;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  graceMs?: number;
}

interface DebugState {
  pid: number; process: Ptr;
  threads: Map<number, Ptr>; armed: Set<number>;
  hooks: Array<{ module: string; symbol: string; address?: bigint }>;
  modules: Array<{ name: string; base: bigint; end: bigint }>;
  msys?: { base: bigint; end: bigint; loaderPath: string };
  installationKey?: string;
  firstBreakpoint: boolean; exited: boolean; exitCode?: number;
  loaderPathVerified?: boolean;
  imagePath?: string;
  installationPathAdjusted?: boolean;
}

/** A bounded debugger for a NEW private process family, with hardware breakpoints only. */
export async function debugPrivateBash(runtime: NativeRuntime, options: ProbeOptions) {
  const canonical = (file: string) => {
    let path = realpathSync(file);
    if (path.startsWith('\\\\?\\UNC\\')) path = '\\\\' + path.slice(8);
    else if (path.startsWith('\\\\?\\')) path = path.slice(4);
    return win32.normalize(path).toLowerCase();
  };
  const path = realpathSync(options.bash);
  const privateRoot = canonical(options.privateRoot);
  if (options.installationRoot && canonical(options.installationRoot) !== canonical(options.privateRoot)) throw new Error('MSYS installation view must resolve to this private runtime.');
  const dllIdentity = statSync(resolve(win32.dirname(path), 'msys-2.0.dll'), { bigint: true });
  const inside = relative(realpathSync(options.privateRoot), path);
  if (inside.startsWith('..') || win32.isAbsolute(inside) || win32.basename(path).toLowerCase() !== 'bash.exe') {
    throw new Error('Debugger target must be a private Bash copy owned by this experiment.');
  }
  if (!/^S-1-(?:4|5-5)-\d+(?:-\d+)*$/.test(options.pipeSid)) throw new Error('Expected an existing capability or logon SID.');
  if (options.defaultDaclSid && !/^S-1-(?:4|5-5)-\d+(?:-\d+)*$/.test(options.defaultDaclSid)) throw new Error('Expected the inherited default-DACL capability.');
  const ffi = runtime.aclRequire('koffi') as Ffi;
  const processModule = await runtime.load(runtime.aclRequire, '@deepseek-ai/dsh-win32-process');
  const api = processModule.extendWin32ProcessBindings(({ kernel32, advapi32, bind }: BindContext) => ({
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
    fileInformation: bind(kernel32, 'GetFileInformationByHandle', 'int', ['void *', 'void *']),
    readMemory: bind(kernel32, 'ReadProcessMemory', 'int', ['void *', 'void *', 'void *', 'size_t', 'void *']),
    writeMemory: bind(kernel32, 'WriteProcessMemory', 'int', ['void *', 'void *', 'void *', 'size_t', 'void *']),
    allocateMemory: bind(kernel32, 'VirtualAllocEx', 'void *', ['void *', 'void *', 'size_t', 'uint32', 'uint32']),
    descriptorText: bind(advapi32, 'ConvertSecurityDescriptorToStringSecurityDescriptorW', 'int', ['void *', 'uint32', 'uint32', 'void *', 'void *']),
    descriptor: bind(advapi32, 'ConvertStringSecurityDescriptorToSecurityDescriptorW', 'int', ['str16', 'uint32', 'void *', 'void *']),
    localFree: bind(kernel32, 'LocalFree', 'void *', ['void *']),
    inJob: bind(kernel32, 'IsProcessInJob', 'int', ['void *', 'void *', 'void *']),
    duplicateHandle: bind(kernel32, 'DuplicateHandle', 'int', ['void *', 'void *', 'void *', 'void *', 'uint32', 'int', 'uint32']),
    queryObject: bind(ffi.load('ntdll.dll'), 'NtQueryObject', 'int32', ['void *', 'int', 'void *', 'uint32', 'void *']),
    processInformation: bind(ffi.load('ntdll.dll'), 'NtQueryInformationProcess', 'int32', ['void *', 'int', 'void *', 'uint32', 'void *']),
  })) as Record<string, Fn>;
  const call = (name: string, ...args: unknown[]) => api[name]!(...args);
  const pointer = (buffer: Buffer, offset = 0) => ffi.decode(buffer, offset, 'void *') as Ptr;
  const valid = (p: Ptr) => p !== null && p !== 0n && BigInt.asUintN(64, p) !== 0xffffffffffffffffn;
  const checked = (name: string, ...args: unknown[]) => { if (!call(name, ...args)) throw new Error(`${name}: ${call('getLastError')}`); };
  const close = (handle: Ptr) => { if (valid(handle)) checked('closeHandle', handle); };
  const ctx = ffi.alloc('uint64', 154);
  if (!valid(ctx) || (ctx! & 15n) !== 0n) { if (valid(ctx)) ffi.free(ctx); throw new Error('A 16-byte aligned x64 CONTEXT is required.'); }
  const states = new Map<number, DebugState>();
  const completed: Array<{ pid: number; privateMsys: boolean; exited: boolean; exitCode?: number }> = [];
  let state: DebugState;
  const trace: Array<Record<string, unknown>> = [];
  const record = (event: Record<string, unknown>) => { if (!options.inheritStdio && trace.length < 10_000) trace.push(event); };
  const privateNamespaces = new Set<string>();
  let processHandle: Ptr = null;
  let ownerProcess: Ptr = null;
  let job: Ptr = null;
  let pid = 0;
  let exited = false;
  let pending: { pid: number; tid: number } | undefined;
  const readEnds: Ptr[] = [];
  const writeEnds: Ptr[] = [];
  const output = ['', ''];
  let repaired = 0;
  let defaultDaclAdjusted = 0;
  let mappingsAdjusted = 0;
  let exitCode: number | undefined;
  let error: string | undefined;
  let rootExitedAt: number | undefined;
  let rangeTerminated = false;
  const start = performance.now();

  function read(process: Ptr, address: bigint, bytes: number): Buffer {
    if (address === 0n || bytes < 0 || bytes > 65_536) throw new Error('Invalid diagnostic read.');
    const buffer = Buffer.alloc(bytes);
    const got = Buffer.alloc(8);
    checked('readMemory', process, address, buffer, bytes, got);
    if (got.readBigUInt64LE() !== BigInt(bytes)) throw new Error('Partial diagnostic read.');
    return buffer;
  }
  const remote64 = (address: bigint) => read(processHandle, address, 8).readBigUInt64LE();
  function wide(process: Ptr, address: bigint, maximum = 512) {
    const chars: number[] = [];
    for (let i = 0; i < maximum; i++) {
      const code = read(process, address + BigInt(i * 2), 2).readUInt16LE();
      if (code === 0) return String.fromCharCode(...chars);
      chars.push(code);
    }
    throw new Error('Unterminated diagnostic string.');
  }
  function context(tid: number) {
    const thread = state.threads.get(tid);
    if (!thread) throw new Error('Unknown fixture thread.');
    ffi.encode(ctx, 48, 'uint32', 0x00100013);
    checked('getContext', thread, ctx);
    return thread;
  }
  const reg = (offset: number) => BigInt(ffi.decode(ctx, offset, 'uint64') as bigint);
  function arm(tid: number) {
    const thread = context(tid);
    if (!state.armed.has(tid) && (reg(112) & 255n) !== 0n) throw new Error('Refusing to replace pre-existing debug-register state.');
    let enabled = 0n;
    state.hooks.forEach((hook, i) => {
      if (hook.address !== undefined) { ffi.encode(ctx, 72 + i * 8, 'uint64', hook.address); enabled |= 1n << BigInt(i * 2); }
    });
    ffi.encode(ctx, 104, 'uint64', 0n);
    ffi.encode(ctx, 112, 'uint64', enabled);
    checked('setContext', thread, ctx);
    state.armed.add(tid);
  }
  function fileName(handle: Ptr) {
    if (!valid(handle)) return '';
    const buffer = Buffer.alloc(2048);
    const length = Number(call('filePath', handle, buffer, 1024, 0));
    return length > 0 && length < 1024 ? buffer.subarray(0, length * 2).toString('utf16le') : '';
  }
  function loaderPath(base: bigint) {
    const buffer = Buffer.alloc(65_536);
    const length = Number(call('modulePath', processHandle, base, buffer, buffer.length / 2));
    return length > 0 && length < buffer.length / 2 ? buffer.subarray(0, length * 2).toString('utf16le') : '';
  }
  function debugLoaderPath(event: Buffer): string {
    // LOAD_DLL_DEBUG_INFO supplies an optional pointer to a Unicode string
    // pointer in the debuggee. This name precedes PSAPI's loader-list visibility.
    const slot = event.readBigUInt64LE(40);
    if (!slot || !event.readUInt16LE(48)) return '';
    const address = remote64(slot);
    if (!address) return '';
    const name = wide(processHandle, address, 32_768);
    return win32.isAbsolute(name) ? name : '';
  }
  function verifyLoaderPath(started = !state.firstBreakpoint) {
    if (state.loaderPathVerified) return;
    if (!state.msys) {
      if (started && state.pid === pid) throw new Error('The private Bash MSYS module was not identified at startup.');
      return; // Native descendants do not load MSYS.
    }
    const loaded = loaderPath(state.msys.base) || state.msys.loaderPath;
    // Fork initialization may precede PSAPI's loader list. File identity and
    // the private executable were checked at load time; require the path by startup.
    if (!loaded && !started) return;
    if (!loaded) throw new Error('Cannot resolve the MSYS loader path after process startup.');
    if (canonical(loaded) !== canonical(resolve(win32.dirname(path), 'msys-2.0.dll'))) throw new Error(`Refusing an MSYS loader path outside the private runtime: ${loaded}`);
    state.loaderPathVerified = true;
  }
  function readDescriptor(address: bigint) {
    const header = read(processHandle, address, 20);
    const control = header.readUInt16LE(2);
    if ((control & 0x8000) !== 0) {
      let bytes = 20;
      for (let i = 0; i < 4; i++) {
        const offset = header.readUInt32LE(4 + i * 4);
        if (!offset) continue;
        const first = read(processHandle, address + BigInt(offset), 8);
        const size = i < 2 ? 8 + first[1]! * 4 : first.readUInt16LE(2);
        if (size < 8 || offset + size > 65_536) throw new Error('Invalid relative security descriptor.');
        bytes = Math.max(bytes, offset + size);
      }
      return read(processHandle, address, bytes);
    }
    const absolute = read(processHandle, address, 40);
    const pieces: Buffer[] = [];
    const result = Buffer.alloc(20);
    header.copy(result, 0, 0, 4);
    result.writeUInt16LE(control | 0x8000, 2);
    let length = 20;
    for (let i = 0; i < 4; i++) {
      const item = absolute.readBigUInt64LE(8 + i * 8);
      if (!item) continue;
      const first = read(processHandle, item, 8);
      const size = i < 2 ? 8 + first[1]! * 4 : first.readUInt16LE(2);
      if (size < 8 || size > 16_384) throw new Error('Invalid absolute security descriptor.');
      const padding = (4 - length % 4) % 4;
      if (padding) { pieces.push(Buffer.alloc(padding)); length += padding; }
      result.writeUInt32LE(length, 4 + i * 4);
      pieces.push(read(processHandle, item, size)); length += size;
    }
    return Buffer.concat([result, ...pieces]);
  }
  function descriptorText(buffer: Buffer) {
    const slot = Buffer.alloc(8), count = Buffer.alloc(4);
    checked('descriptorText', buffer, 1, 0x0f, slot, count);
    const address = pointer(slot);
    try { return wide(call('currentProcess') as Ptr, address!, Math.min(count.readUInt32LE(), 4096)); }
    finally { if (valid(address)) call('localFree', address); }
  }
  function objectName(remoteHandle: bigint) {
    const output = Buffer.alloc(8);
    const self = call('currentProcess') as Ptr;
    checked('duplicateHandle', processHandle, remoteHandle, self, output, 0, 0, 2);
    const handle = pointer(output);
    try {
      const buffer = Buffer.alloc(4096), needed = Buffer.alloc(4);
      const status = Number(call('queryObject', handle, 1, buffer, buffer.length, needed));
      if (status < 0) throw new Error(`NtQueryObject(name): 0x${(status >>> 0).toString(16)}`);
      const length = buffer.readUInt16LE();
      if (length < 2 || length > 2048 || length % 2) throw new Error('Invalid private namespace name.');
      return read(self, pointer(buffer, 8)!, length).toString('utf16le');
    } finally { close(handle); }
  }
  function isPrivateDll(remoteHandle: bigint) {
    if (!valid(remoteHandle)) return false;
    const output = Buffer.alloc(8), info = Buffer.alloc(52);
    const self = call('currentProcess') as Ptr;
    if (!call('duplicateHandle', processHandle, remoteHandle, self, output, 0, 0, 2)) return false;
    const handle = pointer(output);
    try {
      if (!call('fileInformation', handle, info)) return false;
      return ((BigInt(info.readUInt32LE(44)) << 32n) | BigInt(info.readUInt32LE(48))) === dllIdentity.ino
        && BigInt(info.readUInt32LE(28)) === dllIdentity.dev;
    } finally { close(handle); }
  }
  function mergedDescriptor(original: string, sid = options.pipeSid) {
    const sddl = original.replace(/(?=S:|$)/, `(A;;GA;;;${sid})`);
    if (!original.includes('D:') || original.includes('NO_ACCESS_CONTROL')) throw new Error('Unsupported pipe DACL.');
    const slot = Buffer.alloc(8), count = Buffer.alloc(4);
    checked('descriptor', sddl, 1, slot, count);
    const local = pointer(slot);
    try {
      const bytes = count.readUInt32LE();
      if (bytes < 20 || bytes > 16_384) throw new Error('Invalid replacement descriptor length.');
      return read(call('currentProcess') as Ptr, local!, bytes);
    } finally { if (valid(local)) call('localFree', local); }
  }
  function writeData(payload: Buffer) {
    // Only data pages belonging to this new fixture process are allocated/written.
    const memory = call('allocateMemory', processHandle, null, payload.length, 0x3000, 0x04) as Ptr;
    if (!valid(memory)) throw new Error(`VirtualAllocEx(data): ${call('getLastError')}`);
    const written = Buffer.alloc(8);
    checked('writeMemory', processHandle, memory, payload, payload.length, written);
    if (written.readBigUInt64LE() !== BigInt(payload.length)) throw new Error('Partial fixture data write.');
    return memory!;
  }
  function adjustedAttributes(oldAttributes: bigint, original: string) {
    const sd = mergedDescriptor(original);
    const old = read(processHandle, oldAttributes, 24);
    if (old.readUInt32LE() !== 24 || old.readUInt32LE(16) > 1) throw new Error('Invalid SECURITY_ATTRIBUTES.');
    // Data-only allocation. No executable page, DLL injection, code-byte or token change.
    const memory = call('allocateMemory', processHandle, null, 24 + sd.length, 0x3000, 0x04) as Ptr;
    if (!valid(memory)) throw new Error(`VirtualAllocEx(data): ${call('getLastError')}`);
    const payload = Buffer.alloc(24 + sd.length);
    payload.writeUInt32LE(24); payload.writeBigUInt64LE(memory! + 24n, 8); payload.writeUInt32LE(old.readUInt32LE(16), 16);
    sd.copy(payload, 24);
    const written = Buffer.alloc(8);
    checked('writeMemory', processHandle, memory, payload, payload.length, written);
    if (written.readBigUInt64LE() !== BigInt(payload.length)) throw new Error('Partial descriptor write.');
    return memory!;
  }
  function adjustPipe(stack: bigint, oldAttributes: bigint, original: string) {
    const memory = adjustedAttributes(oldAttributes, original);
    const argument = Buffer.alloc(8); argument.writeBigUInt64LE(memory);
    const written = Buffer.alloc(8);
    checked('writeMemory', processHandle, stack + 0x40n, argument, 8, written);
    if (written.readBigUInt64LE() !== 8n) throw new Error('Partial stack-argument write.');
    // The allocation is owned by this disposable process and reclaimed on its exit.
    repaired++;
  }
  function onHit(tid: number, slot: number) {
    verifyLoaderPath();
    const thread = context(tid);
    const stack = reg(152);
    const caller = remote64(stack);
    const fromPrivateMsys = state.msys !== undefined && caller >= state.msys.base && caller < state.msys.end;
    const callerModule = state.modules.find(module => caller >= module.base && caller < module.end)?.name;
    if (slot === 0) {
      const name = wide(processHandle, reg(128));
      const attributes = remote64(stack + 0x40n);
      const access = Number(reg(136) & 0xffffffffn), mode = Number(reg(184) & 0xffffffffn), instances = Number(reg(192));
      const match = /^\\\\\.\\pipe\\(?:msys|cygwin)-([a-f0-9]+)-(\d+)-sigwait$/i.exec(name);
      const ownSignalPipe = match !== null && Number(match[2]) === state.pid;
      if (ownSignalPipe) state.installationKey = match[1]!.toLowerCase();
      const trustedForwarder = callerModule === 'kernel32.dll' || callerModule === 'kernelbase.dll';
      const freshPrivatePipe = ownSignalPipe && state.msys !== undefined && (fromPrivateMsys || trustedForwarder)
        && (access & 0x80000) !== 0 && (mode & 8) !== 0 && instances === 1;
      let original: string | undefined;
      if (attributes !== 0n) {
        const sd = remote64(attributes + 8n);
        if (sd) original = descriptorText(readDescriptor(sd));
      }
      const record: Record<string, unknown> = { event: 'CreateNamedPipeW', pid: state.pid, name, fromPrivateMsys, callerModule, freshPrivatePipe, explicitDescriptor: original !== undefined,
        descriptorHasAllowedSid: original?.includes(options.pipeSid), adjusted: false };
      if (options.repairPipe && freshPrivatePipe && attributes && original) { adjustPipe(stack, attributes, original); record.adjusted = true; }
      if (!options.inheritStdio && trace.length < 10_000) trace.push(record);
    } else if (slot === 1) {
      const informationClass = Number(reg(136));
      const record: Record<string, unknown> = { event: 'NtSetInformationToken', pid: state.pid, informationClass, fromPrivateMsys, adjusted: false };
      if (options.repairDefaultDacl && fromPrivateMsys && informationClass === 6 && reg(192) === 8n) {
        const acl = remote64(reg(184));
        const header = read(processHandle, acl, 8);
        const bytes = header.readUInt16LE(2);
        if (bytes < 8 || bytes > 16_384) throw new Error('Invalid proposed TOKEN_DEFAULT_DACL.');
        const relative = Buffer.alloc(20 + bytes);
        relative[0] = 1; relative.writeUInt16LE(0x8004, 2); relative.writeUInt32LE(20, 16);
        read(processHandle, acl, bytes).copy(relative, 20);
        const original = descriptorText(relative);
        const defaultSid = options.defaultDaclSid ?? options.pipeSid;
        if (!original.includes(defaultSid)) {
          const sd = mergedDescriptor(original, defaultSid);
          const offset = sd.readUInt32LE(16), length = sd.readUInt16LE(offset + 2);
          const aclData = writeData(sd.subarray(offset, offset + length));
          const info = Buffer.alloc(8); info.writeBigUInt64LE(aclData);
          ffi.encode(ctx, 184, 'uint64', writeData(info));
          defaultDaclAdjusted++; record.adjusted = true;
        }
      }
      if (!options.inheritStdio && trace.length < 10_000) trace.push(record);
    } else if (slot === 2) {
      const attributes = reg(184);
      const pageFileBacked = remote64(stack + 0x38n) === 0n;
      let name = '', rootName = '';
      let attrs: Buffer | undefined;
      if (attributes !== 0n) {
        attrs = read(processHandle, attributes, 48);
        if (attrs.readUInt32LE() !== 48) throw new Error('Invalid section OBJECT_ATTRIBUTES.');
        const namePointer = attrs.readBigUInt64LE(16), root = attrs.readBigUInt64LE(8);
        if (namePointer) {
          const unicode = read(processHandle, namePointer, 16), bytes = unicode.readUInt16LE();
          if (bytes > 2048 || bytes % 2) throw new Error('Invalid section name length.');
          if (bytes) name = read(processHandle, unicode.readBigUInt64LE(8), bytes).toString('utf16le');
        }
        if (root && pageFileBacked && /^cygpid\.\d+$/.test(name) && fromPrivateMsys) rootName = objectName(root);
      }
      const privateNamespaceVerified = state.installationKey !== undefined && rootName.toLowerCase().startsWith('\\basenamedobjects\\msys-')
        && rootName.toLowerCase().endsWith('-' + state.installationKey);
      const ownMapping = state.msys !== undefined && pageFileBacked && /^cygpid\.\d+$/.test(name) && fromPrivateMsys && privateNamespaceVerified;
      if (ownMapping) privateNamespaces.add(rootName);
      const record: Record<string, unknown> = { event: 'NtCreateSection', pid: state.pid, name, privateNamespaceVerified,
        ownMapping, pageFileBacked, explicitDescriptor: false, adjusted: false };
      if (attrs) {
        const descriptor = attrs.readBigUInt64LE(32);
        if (descriptor) {
          const original = descriptorText(readDescriptor(descriptor));
          record.explicitDescriptor = true; record.descriptorHasAllowedSid = original.includes(options.pipeSid);
          if (options.repairMappings && ownMapping && !original.includes(options.pipeSid)) {
            attrs.writeBigUInt64LE(writeData(mergedDescriptor(original)), 32);
            ffi.encode(ctx, 184, 'uint64', writeData(attrs));
            mappingsAdjusted++; record.adjusted = true;
          }
        }
      }
      if (!options.inheritStdio && trace.length < 10_000) trace.push(record);
    } else if (options.installationRoot && !state.installationPathAdjusted && fromPrivateMsys && reg(192) === 0n && isPrivateDll(reg(128))) {
      // MSYS normalizes its DLL pathname before hashing the installation key.
      // Retain a real session junction path in its original buffer, redirecting
      // only this optional normalization's output to private scratch data.
      // The native call/return still executes normally (including CET state).
      const text = win32.toNamespacedPath(resolve(options.installationRoot, 'usr/bin/msys-2.0.dll'));
      const bytes = Buffer.from(text + '\0', 'utf16le'), capacity = Number(reg(184));
      if (capacity < text.length + 1 || capacity > 32_768) throw new Error('Private MSYS view exceeds its startup buffer.');
      const written = Buffer.alloc(8);
      checked('writeMemory', processHandle, reg(136), bytes, bytes.length, written);
      if (written.readBigUInt64LE() !== BigInt(bytes.length)) throw new Error('Partial private MSYS view write.');
      ffi.encode(ctx, 136, 'uint64', writeData(Buffer.alloc(capacity * 2)));
      state.installationPathAdjusted = true;
      record({ event: 'private-msys-view', pid: state.pid });
    }
    ffi.encode(ctx, 104, 'uint64', 0n);
    ffi.encode(ctx, 68, 'uint32', Number(ffi.decode(ctx, 68, 'uint32')) | 0x10000);
    checked('setContext', thread, ctx);
  }
  function drain() {
    for (let i = 0; i < readEnds.length; i++) {
      const available = Buffer.alloc(4);
      if (!call('peekNamedPipe', readEnds[i], null, 0, null, available, null)) continue;
      const count = available.readUInt32LE();
      if (!count) continue;
      if (output[i]!.length + count > 65_536) throw new Error('Fixture output budget exceeded.');
      const buffer = Buffer.alloc(count), got = Buffer.alloc(4);
      checked('readFile', readEnds[i], buffer, count, got, null);
      output[i] += buffer.subarray(0, got.readUInt32LE()).toString('utf8');
    }
  }
  function eventOnce(milliseconds: number, cleanup = false) {
    const event = Buffer.alloc(176);
    if (!call('waitDebug', event, milliseconds)) {
      const code = Number(call('getLastError'));
      if (code === 121) return;
      throw new Error(`WaitForDebugEvent: ${code}`);
    }
    const kind = event.readUInt32LE(), eventPid = event.readUInt32LE(4), tid = event.readUInt32LE(8);
    pending = { pid: eventPid, tid };
    let disposition = 0x00010002;
    if (kind === 3) {
      if (states.has(eventPid)) throw new Error('Duplicate live process identity in the private Job.');
      const handle = pointer(event, 24), member = Buffer.alloc(4);
      checked('inJob', handle, job, member);
      if (!member.readUInt32LE()) throw new Error('Refusing a process outside the probe-owned Job.');
      if (!options.followFamily && eventPid !== pid) throw new Error('Unexpected descendant while family observation is disabled.');
      states.set(eventPid, { pid: eventPid, process: handle, threads: new Map(), armed: new Set(), modules: [], firstBreakpoint: true, exited: false,
        hooks: [{ module: 'kernelbase.dll', symbol: 'CreateNamedPipeW' }, { module: 'ntdll.dll', symbol: 'NtSetInformationToken' },
          { module: 'ntdll.dll', symbol: 'NtCreateSection' }, { module: 'kernelbase.dll', symbol: 'GetFinalPathNameByHandleW' }] });
      close(pointer(event, 16));
    }
    const selected = states.get(eventPid);
    if (!selected) throw new Error('Debugger received a process that was not created in the private Job.');
    state = selected; processHandle = state.process;
    if (kind === 3) {
      state.threads.set(tid, pointer(event, 32));
      const basic = Buffer.alloc(48);
      const status = Number(call('processInformation', processHandle, 0, basic, basic.length, null));
      if (status < 0) throw new Error(`NtQueryInformationProcess: 0x${(status >>> 0).toString(16)}`);
      const parameters = remote64(basic.readBigUInt64LE(8) + 0x20n);
      const image = read(processHandle, parameters + 0x60n, 16);
      const bytes = image.readUInt16LE();
      if (!bytes || bytes > 32_768 || bytes % 2) throw new Error('Invalid process image path.');
      state.imagePath = read(processHandle, image.readBigUInt64LE(8), bytes).toString('utf16le');
    } else if (kind === 2) {
      state.threads.set(tid, pointer(event, 16));
      if (!cleanup && state.msys && state.hooks.some(h => h.address !== undefined)) arm(tid);
    } else if (kind === 4) {
      state.threads.delete(tid); state.armed.delete(tid);
    } else if (kind === 6) {
      const handle = pointer(event, 16), base = event.readBigUInt64LE(24);
      try {
        const loadedPath = fileName(handle) || loaderPath(base) || debugLoaderPath(event);
        if (!loadedPath) throw new Error('Cannot identify a loaded module in the private process family.');
        const name = win32.basename(loadedPath).toLowerCase();
        if (name) {
          const header = read(processHandle, base, 4096);
          const pe = header.readUInt32LE(0x3c);
          if (pe + 84 > header.length || header.readUInt32LE(pe) !== 0x00004550) throw new Error('Invalid fixture module header.');
          const size = header.readUInt32LE(pe + 24 + 56);
          state.modules.push({ name, base, end: base + BigInt(size) });
        }
        if (name === 'msys-2.0.dll') {
          if (!state.imagePath || !contains(privateRoot, canonical(state.imagePath))) throw new Error('Refusing an MSYS executable outside the private runtime.');
          // An image-section handle may name another hardlink to the same file.
          // Verify the target loader's actual DLL path, not that cached alias.
          const information = Buffer.alloc(52);
          checked('fileInformation', handle, information);
          const expected = statSync(resolve(win32.dirname(path), name), { bigint: true });
          const identity = (BigInt(information.readUInt32LE(44)) << 32n) | BigInt(information.readUInt32LE(48));
          if (identity !== expected.ino || BigInt(information.readUInt32LE(28)) !== expected.dev) throw new Error(`MSYS module file identity differs from the private hardlink: ${identity}/${expected.ino}, ${information.readUInt32LE(28)}/${expected.dev}.`);
          const binary = readFileSync(resolve(win32.dirname(path), name));
          const pe = binary.readUInt32LE(0x3c); const size = binary.readUInt32LE(pe + 24 + 56);
          state.msys = { base, end: base + BigInt(size), loaderPath: debugLoaderPath(event) };
          verifyLoaderPath();
          // Fork children use the same verified DLL path/installation key, and may open pinfo before sigproc_init.
          if (state.pid !== pid) state.installationKey = states.get(pid)?.installationKey;
          record({ event: 'private-msys-loaded', pid: state.pid, privateCopyVerified: true });
        }
        state.hooks.forEach(hook => {
          if (name !== hook.module) return;
          const localBase = call('module', hook.module) as bigint;
          const localAddress = call('symbol', localBase, hook.symbol) as Ptr;
          if (!valid(localAddress)) throw new Error(`Missing ${hook.symbol}.`);
          hook.address = base + localAddress! - localBase;
        });
        if (!cleanup && state.msys && state.hooks.some(h => h.address !== undefined)) for (const id of state.threads.keys()) arm(id);
      } finally { close(handle); }
    } else if (kind === 1) {
      const code = event.readUInt32LE(16), address = event.readBigUInt64LE(32);
      const slot = state.hooks.findIndex(h => h.address === address);
      if (!cleanup && code === 0x80000004 && slot >= 0) onHit(tid, slot);
      else if (code === 0x80000003 && state.firstBreakpoint) { verifyLoaderPath(true); state.firstBreakpoint = false; }
      else { disposition = 0x80010001; record({ event: 'exception', pid: eventPid, code: '0x' + code.toString(16), firstChance: event.readUInt32LE(168) }); }
    } else if (kind === 5) {
      state.exitCode = event.readUInt32LE(16); state.exited = true;
      if (eventPid === pid) { exitCode = state.exitCode; rootExitedAt = performance.now(); }
      exited = states.get(pid)?.exited === true && [...states.values()].every(state => state.exited);
    }
    checked('continueDebug', eventPid, tid, disposition);
    pending = undefined;
    if (kind === 5) {
      if (!options.inheritStdio && completed.length < 4096) completed.push({ pid: state.pid, privateMsys: state.msys !== undefined, exited: true, exitCode: state.exitCode });
      // Windows can reuse a child PID once its debug handles close. Keep only
      // live children; the separately owned root handle retains the root PID.
      if (eventPid !== pid) states.delete(eventPid);
    }
  }

  try {
    for (let i = 0; !options.inheritStdio && i < 2; i++) {
      const read = Buffer.alloc(8), write = Buffer.alloc(8);
      checked('createPipe', read, write, null, 65_536);
      readEnds.push(pointer(read)); writeEnds.push(pointer(write));
    }
    const originalCreate = api.createProcessW!;
    const originalFd = api.uvGetOsfhandle!;
    const controlled = { ...api,
      createProcessW: (...args: unknown[]) => { args[5] = Number(args[5]) | (options.followFamily ? 1 : 3); return originalCreate(...args); },
      uvGetOsfhandle: (fd: number) => !options.inheritStdio && fd === 1 ? writeEnds[0] : !options.inheritStdio && fd === 2 ? writeEnds[1] : originalFd(fd),
    };
    const { scrubbedParentEnv } = await runtime.load(runtime.baseRequire, '@deepseek-ai/dsh-subprocess');
    const child = processModule.spawnCurrentTokenJobProcess(controlled, { command: path, applicationName: path,
      args: ['--noprofile', '--norc', '-c', options.command], cwd: options.cwd, env: options.env ?? scrubbedParentEnv(),
      stdio: { stdin: 0, stdout: 1, stderr: 2 },
    }) as { pid: number; process: Ptr; job: Ptr };
    pid = child.pid; ownerProcess = child.process; job = child.job;
    checked('killOnDebuggerExit', 1);
    for (const handle of writeEnds.splice(0)) close(handle);
    while (!exited) {
      if (performance.now() - start > (options.timeoutMs ?? 15_000)) throw new Error('Private debugger deadline exceeded.');
      if (!rangeTerminated && rootExitedAt !== undefined && options.graceMs !== undefined && performance.now() - rootExitedAt >= options.graceMs) {
        checked('terminateJobObject', job, 1);
        rangeTerminated = true;
      }
      eventOnce(100); drain();
    }
    drain();
  } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  finally {
    if (!exited && valid(job)) {
      call('terminateJobObject', job, 1);
      if (pending) { call('continueDebug', pending.pid, pending.tid, 0x00010002); pending = undefined; }
      const until = performance.now() + 3_000;
      while (!exited && performance.now() < until) { try { eventOnce(100, true); } catch { break; } }
    }
    try { drain(); } catch (cause) { error ??= String(cause); }
    close(ownerProcess); close(job);
    for (const handle of [...readEnds, ...writeEnds]) close(handle);
    ffi.free(ctx);
  }
  return { pid, repairRequested: options.repairPipe, repairDefaultDaclRequested: options.repairDefaultDacl === true,
    repaired, defaultDaclAdjusted, mappingsAdjusted, exitCode, stdout: output[0], stderr: output[1], trace, error,
    elapsedMs: Math.round(performance.now() - start), exited, executablePagesWritten: false,
    privateNamespaces: [...privateNamespaces],
    processFamily: [...completed, ...[...states.values()].filter(state => options.inheritStdio || !state.exited)
      .map(state => ({ pid: state.pid, privateMsys: state.msys !== undefined, exited: state.exited, exitCode: state.exitCode }))],
  };
}
