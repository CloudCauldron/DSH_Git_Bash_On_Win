import { basename, dirname, join, resolve, win32 } from 'node:path';
import { isJobEmpty, terminateJob, type NativePtr } from '@deepseek-ai/dsh-win32-process';
import { absolutePath, admitDirectory, admitChildDirectory, admitJunction, canonicalExistingPath, containsPath, fileIdentity, openOrdinaryFile, sameIdentity, samePath, type FileIdentity } from '../runtime/ntfs-filesystem.ts';
import {
  checked, close, debugApi, defaultDaclText, descriptorText, fileName, grantDefaultDacl, grantObjectAttributes, grantPipe,
  imagePath, imageLayout, loaderPath, objectAttributes, objectName, pointer, readDescriptor, readMemory, registers,
  requireJobMember, spawnDebugFamily, ThreadContext, valid, waitDebugEvent, wide, writeData as allocateData, writeMemory,
  type DebugEvent, type IpcCompatibility,
} from './native-debug.ts';
import { LocalizedAggregateError, LocalizedError } from '../locale/errors.ts';

export interface PrivateBashLaunch {
  readonly baseRoot: string;
  readonly installationRoot: string;
  readonly cwd: string;
  readonly command: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly compatibility: IpcCompatibility;
  readonly graceMs: number;
}
export interface PrivateFamilyExit {
  readonly exitCode: number;
  readonly repaired: number;
  readonly defaultDaclAdjusted: number;
  readonly mappingsAdjusted: number;
  readonly installationKey: string;
}

interface LoadedModule {
  name: string; base: bigint; end: bigint;
  // Each concurrently mapped copy passes admission and loader-path verification independently.
  msys?: { pathVerified: boolean; installationPathAdjusted?: boolean };
}

interface ModuleState {
  hooks: Array<{ module: string; symbol: string; address?: bigint }>;
  modules: LoadedModule[];
}

interface DebugState extends ModuleState {
  pid: number; process: NativePtr;
  threads: Map<number, NativePtr>; armed: Set<number>;
  installationKey?: string;
  firstBreakpoint: boolean;
  imagePath?: string;
}

function moduleAt(modules: LoadedModule[], address: bigint) {
  return modules.find(module => address >= module.base && address < module.end);
}

function hasMsys(modules: LoadedModule[]) {
  return modules.some(module => module.msys !== undefined);
}

/** Unload just this base and report whether private MSYS hooks still apply. */
export function unloadModule(state: ModuleState, base: bigint): boolean {
  state.modules = state.modules.filter(module => module.base !== base);
  for (const hook of state.hooks) {
    if (hook.address !== undefined && !moduleAt(state.modules, hook.address)) hook.address = undefined;
  }
  return hasMsys(state.modules);
}

/** One child path admission; parent pins do not freeze junction targets. */
export async function runPrivateBash(options: PrivateBashLaunch): Promise<PrivateFamilyExit> {
  const base = admitDirectory(options.baseRoot);
  if (!samePath(base.path, absolutePath(options.baseRoot))) throw new LocalizedError('error.baseRedirected');
  const installationRoot = absolutePath(options.installationRoot);
  const viewsRoot = join(dirname(base.path), 'views');
  if (samePath(viewsRoot, installationRoot) || !containsPath(viewsRoot, installationRoot)) throw new LocalizedError('error.viewOutsideGeneration');
  admitJunction(admitDirectory(dirname(installationRoot)), basename(installationRoot), base);
  const bin = admitChildDirectory(admitChildDirectory(base, 'usr'), 'bin');
  const bash = openOrdinaryFile(bin, 'bash.exe');
  let path: string;
  try { path = bash.canonicalPath(); } finally { bash.close(); }
  const dll = openOrdinaryFile(bin, 'msys-2.0.dll');
  let dllIdentity: FileIdentity, msysPath: string;
  try { dllIdentity = dll.information(); msysPath = dll.canonicalPath(); } finally { dll.close(); }
  const privateRoot = base.path;
  const { grantSid } = options.compatibility;
  const api = debugApi(), ctx = new ThreadContext();
  const states = new Map<number, DebugState>();
  let state: DebugState, processHandle: NativePtr;
  let ownerProcess: NativePtr | null = null, job: NativePtr | null = null;
  let pid = 0, exited = false, joined = false;
  let terminatedAt: number | undefined;
  let pending: { pid: number; tid: number } | undefined;
  let repaired = 0, defaultDaclAdjusted = 0, mappingsAdjusted = 0;
  let exitCode: number | undefined, rootExitedAt: number | undefined, familyKey: string | undefined;
  const read = readMemory;
  const remote64 = (address: bigint) => read(processHandle, address, 8).readBigUInt64LE();
  const reg = (offset: number) => ctx.read64(offset);
  const writeData = (payload: Buffer) => allocateData(processHandle, payload);
  function context(tid: number): NativePtr {
    const thread = state.threads.get(tid);
    if (!thread) throw new LocalizedError('error.unknownThread');
    ctx.load(thread);
    return thread;
  }
  function arm(tid: number): void {
    const thread = state.threads.get(tid);
    if (!thread) throw new LocalizedError('error.unknownThread');
    ctx.arm(thread, state.hooks.map(hook => hook.address), state.armed.has(tid));
    state.armed.add(tid);
  }
  function debugLoaderPath(event: Extract<DebugEvent, { kind: 'module' }>): string {
    if (!event.nameSlot || !event.unicode) return '';
    const address = remote64(event.nameSlot);
    if (!address) return '';
    const name = wide(processHandle, address, 32768);
    return win32.isAbsolute(name) ? name : '';
  }
  function isPrivateDll(remoteHandle: bigint): boolean {
    const output = Buffer.alloc(8);
    if (!api.duplicateHandle(processHandle, remoteHandle, api.currentProcess(), output, 0, 0, 2)) return false;
    const handle = pointer(output);
    try { return sameIdentity(fileIdentity(handle), dllIdentity); } finally { close(handle); }
  }
  function verifyLoaderPath(path: string, started: boolean): boolean {
    // Fork initialization may precede PSAPI loader-list visibility.
    if (!path && !started) return false;
    if (!path || !samePath(canonicalExistingPath(path), msysPath)) throw new LocalizedError('error.loaderOutsideBase', { path });
    return true;
  }
  function verifyLoaderPaths(started = !state.firstBreakpoint): boolean {
    let present = false;
    for (const { base, msys } of state.modules) {
      if (!msys) continue;
      present = true;
      if (!msys.pathVerified) msys.pathVerified = verifyLoaderPath(loaderPath(processHandle, base), started);
    }
    if (!present && started && state.pid === pid) throw new LocalizedError('error.missingStartupMsys');
    return present;
  }
  function onHit(tid: number, slot: number) {
    const hasPrivateMsys = verifyLoaderPaths();
    const thread = context(tid);
    const stack = reg(registers.rsp);
    const caller = remote64(stack);
    const callerModule = moduleAt(state.modules, caller);
    const msys = callerModule?.msys;
    if (slot === 0) {
      const name = wide(processHandle, reg(registers.rcx));
      const attributes = remote64(stack + 0x40n);
      const access = Number(reg(registers.rdx) & 0xffffffffn), mode = Number(reg(registers.r8) & 0xffffffffn), instances = Number(reg(registers.r9));
      const match = /^\\\\\.\\pipe\\(?:msys|cygwin)-([a-f0-9]+)-(\d+)-sigwait$/i.exec(name);
      const ownSignalPipe = match !== null && Number(match[2]) === state.pid;
      if (ownSignalPipe) {
        const key = match[1]!.toLowerCase();
        if (state.pid === pid && !state.modules.some(module => module.msys?.installationPathAdjusted)) throw new LocalizedError('error.startupNamespaceMissing');
        if (familyKey !== undefined && familyKey !== key) throw new LocalizedError('error.descendantNamespaceChanged');
        familyKey ??= key;
        state.installationKey = key;
      }
      const trustedForwarder = callerModule?.name === 'kernel32.dll' || callerModule?.name === 'kernelbase.dll';
      const freshPrivatePipe = ownSignalPipe && hasPrivateMsys && (msys || trustedForwarder)
        && (access & 0x80000) !== 0 && (mode & 8) !== 0 && instances === 1;
      let original: string | undefined;
      if (grantSid && freshPrivatePipe && attributes !== 0n) {
        const sd = remote64(attributes + 8n);
        if (sd) original = descriptorText(readDescriptor(processHandle, sd));
      }
      if (grantSid && original) {
        grantPipe(processHandle, stack, attributes, original, grantSid); repaired++;
      }
    } else if (slot === 1 && grantSid) {
      const informationClass = Number(reg(registers.rdx));
      if (msys && informationClass === 6 && reg(registers.r9) === 8n) {
        const original = defaultDaclText(processHandle, reg(registers.r8));
        if (!original.includes(`(A;;GA;;;${grantSid})`)) {
          ctx.write64(registers.r8, grantDefaultDacl(processHandle, original, grantSid));
          defaultDaclAdjusted++;
        }
      }
    } else if (slot === 2 && grantSid && msys && remote64(stack + 0x38n) === 0n) {
      const attributes = reg(registers.r8);
      let rootName = '';
      let attrs: Buffer | undefined;
      if (attributes !== 0n) {
        const parsed = objectAttributes(processHandle, attributes);
        attrs = parsed.attributes;
        const { root, name } = parsed;
        if (root && /^cygpid\.\d+$/.test(name)) rootName = objectName(processHandle, root);
      }
      const privateNamespaceVerified = state.installationKey !== undefined && rootName.toLowerCase().startsWith('\\basenamedobjects\\msys-')
        && rootName.toLowerCase().endsWith('-' + state.installationKey);
      if (attrs && privateNamespaceVerified) {
        const descriptor = attrs.readBigUInt64LE(32);
        if (descriptor) {
          const original = descriptorText(readDescriptor(processHandle, descriptor));
          if (!original.includes(`(A;;GA;;;${grantSid})`)) {
            ctx.write64(registers.r8, grantObjectAttributes(processHandle, attrs, original, grantSid));
            mappingsAdjusted++;
          }
        }
      }
    } else if (slot === 3 && msys && !msys.installationPathAdjusted && reg(registers.r9) === 0n && isPrivateDll(reg(registers.rcx))) {
      // MSYS normalizes its DLL pathname before hashing the installation key.
      // Retain a real session junction path in its original buffer, redirecting
      // only this optional normalization's output to private scratch data.
      // The native call/return still executes normally (including CET state).
      const text = win32.toNamespacedPath(resolve(installationRoot, 'usr/bin/msys-2.0.dll'));
      const bytes = Buffer.from(text + '\0', 'utf16le'), capacity = Number(reg(registers.r8));
      if (capacity < text.length + 1 || capacity > 32_768) throw new LocalizedError('error.viewBufferTooSmall');
      writeMemory(processHandle, reg(registers.rdx), bytes);
      ctx.write64(registers.rdx, writeData(Buffer.alloc(capacity * 2)));
      msys.installationPathAdjusted = true;
    }
    ctx.resume(thread);
  }

  function admitModule(event: Extract<DebugEvent, { kind: 'module' }>): void {
    const { file, base } = event;
    // Image-section handles may report another hardlink name. Prefer the
    // loader's spelling both for module classification and boundary admission.
    const reportedPath = loaderPath(processHandle, base) || debugLoaderPath(event);
    const loadedPath = reportedPath || fileName(file);
    if (!loadedPath) throw new LocalizedError('error.unidentifiedModule');
    const name = win32.basename(loadedPath).toLowerCase();
    const { size, x64 } = imageLayout(read(processHandle, base, 4096));
    const module: LoadedModule = { name, base, end: base + BigInt(size) };
    state.modules.push(module);
    if (name === 'msys-2.0.dll') {
      if (!x64) throw new LocalizedError('error.x64MsysRequired');
      state.imagePath ??= imagePath(processHandle);
      if (!containsPath(privateRoot, canonicalExistingPath(state.imagePath))) throw new LocalizedError('error.executableOutsideBase');
      if (!file || !sameIdentity(fileIdentity(file), dllIdentity)) throw new LocalizedError('error.moduleIdentityMismatch');
      requireJobMember(processHandle, job);
      module.msys = { pathVerified: verifyLoaderPath(reportedPath, !state.firstBreakpoint) };
      // Forks may create pinfo before sigproc_init; they inherit this family's key.
      if (state.pid !== pid) state.installationKey = familyKey;
    }
    state.hooks.forEach((hook, slot) => {
      if (!x64 || name !== hook.module || (!grantSid && (slot === 1 || slot === 2))) return;
      const localBase = api.module(hook.module);
      if (!valid(localBase)) throw new LocalizedError('error.missingModule', { module: hook.module });
      const address = api.symbol(localBase, hook.symbol);
      if (!valid(address) || address < localBase || address - localBase >= BigInt(size)) throw new LocalizedError('error.unsupportedSymbol', { symbol: hook.symbol });
      hook.address = base + address - localBase;
    });
    if (hasMsys(state.modules)) for (const tid of state.threads.keys()) arm(tid);
  }

  function eventOnce(milliseconds: number, cleanup = false): void {
    const event = waitDebugEvent(milliseconds);
    if (!event) return;
    const { pid: eventPid, tid } = event;
    pending = { pid: eventPid, tid };
    let disposition = 0x00010002;
    if (cleanup) {
      if (event.kind === 'process' || event.kind === 'module') attempt(() => close(event.file));
    } else {
      if (event.kind === 'process') {
        try {
          if (states.has(eventPid)) throw new LocalizedError('error.duplicateProcess');
          requireJobMember(event.process, job);
          states.set(eventPid, { pid: eventPid, process: event.process, threads: new Map([[tid, event.thread]]),
            armed: new Set(), modules: [], firstBreakpoint: true,
            hooks: [{ module: 'kernelbase.dll', symbol: 'CreateNamedPipeW' }, { module: 'ntdll.dll', symbol: 'NtSetInformationToken' },
              { module: 'ntdll.dll', symbol: 'NtCreateSection' }, { module: 'kernelbase.dll', symbol: 'GetFinalPathNameByHandleW' }] });
        } finally { close(event.file); }
      }
      const selected = states.get(eventPid);
      if (!selected) {
        if (event.kind === 'module') close(event.file);
        throw new LocalizedError('error.debugEventOutsideFamily');
      }
      state = selected; processHandle = state.process;
      switch (event.kind) {
        case 'process': break;
        case 'thread':
          state.threads.set(tid, event.thread);
          if (hasMsys(state.modules)) arm(tid);
          break;
        case 'exit-thread': state.threads.delete(tid); state.armed.delete(tid); break;
        case 'module':
          try { admitModule(event); } finally { close(event.file); }
          break;
        case 'unload':
          if (unloadModule(state, event.base)) for (const id of state.threads.keys()) arm(id);
          else for (const id of state.armed) { ctx.arm(state.threads.get(id)!, [], true); state.armed.delete(id); }
          break;
        case 'exception': {
          const slot = state.hooks.findIndex(hook => hook.address === event.address);
          if (event.code === 0x80000004 && slot >= 0) onHit(tid, slot);
          else if (event.code === 0x80000003 && state.firstBreakpoint) {
            if (verifyLoaderPaths(true) && state.hooks.some((hook, i) => (grantSid || i === 0 || i === 3) && hook.address === undefined)) throw new LocalizedError('error.startupHooksUnavailable');
            state.firstBreakpoint = false;
          } else disposition = 0x80010001;
          break;
        }
      }
    }
    if (event.kind === 'exit' && eventPid === pid) { exitCode = event.exitCode; rootExitedAt = performance.now(); }
    checked(api.continueDebug(eventPid, tid, disposition), 'ContinueDebugEvent');
    pending = undefined;
    // Windows closes debug-event process/thread handles after continuation.
    if (event.kind === 'exit') states.delete(eventPid);
    exited = rootExitedAt !== undefined && states.size === 0;
  }

  const errors: unknown[] = [];
  const attempt = (action: () => void) => { try { action(); } catch (error) { errors.push(error); } };
  try {
    const child = spawnDebugFamily({ command: path, applicationName: path,
      args: ['--noprofile', '--norc', '-c', options.command], cwd: options.cwd, env: options.environment,
      stdio: { stdin: 0, stdout: 1, stderr: 2 } });
    pid = child.pid; ownerProcess = child.process; job = child.job;
    checked(api.killOnDebuggerExit(1), 'DebugSetProcessKillOnExit');
    // Continuing EXIT_PROCESS_DEBUG_EVENT precedes the kernel's Job accounting
    // update. Join both observations, including descendants after root exit.
    while (!exited || !isJobEmpty(api, job)) {
      if (terminatedAt === undefined && rootExitedAt !== undefined && performance.now() - rootExitedAt >= options.graceMs) {
        terminateJob(api, job, 1); terminatedAt = performance.now();
      }
      if (terminatedAt !== undefined && performance.now() - terminatedAt > 3000) throw new LocalizedError('error.jobTerminationTimeout');
      eventOnce(25);
    }
    joined = true;
    if (exitCode === undefined || familyKey === undefined) throw new LocalizedError('error.familyExitUnconfirmed');
  } catch (error) { errors.push(error); }
  finally {
    if (job && !joined) {
      attempt(() => terminateJob(api, job!, 1));
      if (pending) attempt(() => { checked(api.continueDebug(pending!.pid, pending!.tid, 0x00010002), 'ContinueDebugEvent(cleanup)'); pending = undefined; });
      const until = performance.now() + 3000;
      attempt(() => { while ((!exited || !isJobEmpty(api, job!)) && performance.now() < until) eventOnce(25, true); });
    }
    if (job) attempt(() => { if (!isJobEmpty(api, job!)) throw new LocalizedError('error.jobTerminationUnconfirmed'); });
    attempt(() => close(ownerProcess));
    attempt(() => close(job));
    attempt(() => ctx.close());
  }
  if (errors.length) throw new LocalizedAggregateError(errors);
  return { exitCode: exitCode!, repaired, defaultDaclAdjusted, mappingsAdjusted, installationKey: familyKey! };
}
