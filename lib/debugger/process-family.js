import { basename, dirname, join, resolve, win32 } from 'node:path';
import { isJobEmpty, terminateJob } from '@deepseek-ai/dsh-win32-process';
import { absolutePath, admitDirectory, admitChildDirectory, admitJunction, canonicalExistingPath, containsPath, fileIdentity, openOrdinaryFile, sameIdentity, samePath } from '../runtime/ntfs-filesystem.js';
import { checked, close, debugApi, defaultDaclText, descriptorText, fileName, grantDefaultDacl, grantObjectAttributes, grantPipe, imagePath, imageLayout, loaderPath, objectAttributes, objectName, pointer, readDescriptor, readMemory, registers, requireJobMember, spawnDebugFamily, ThreadContext, valid, waitDebugEvent, wide, writeData as allocateData, writeMemory, } from './native-debug.js';
import { LocalizedAggregateError, LocalizedError } from '../locale/errors.js';
/** One child path admission; parent pins do not freeze junction targets. */
export async function runPrivateBash(options) {
    const base = admitDirectory(options.baseRoot);
    if (!samePath(base.path, absolutePath(options.baseRoot)))
        throw new LocalizedError('error.baseRedirected');
    const installationRoot = absolutePath(options.installationRoot);
    const viewsRoot = join(dirname(base.path), 'views');
    if (samePath(viewsRoot, installationRoot) || !containsPath(viewsRoot, installationRoot))
        throw new LocalizedError('error.viewOutsideGeneration');
    admitJunction(admitDirectory(dirname(installationRoot)), basename(installationRoot), base);
    const bin = admitChildDirectory(admitChildDirectory(base, 'usr'), 'bin');
    const bash = openOrdinaryFile(bin, 'bash.exe');
    let path;
    try {
        path = bash.canonicalPath();
    }
    finally {
        bash.close();
    }
    const dll = openOrdinaryFile(bin, 'msys-2.0.dll');
    let dllIdentity, msysPath;
    try {
        dllIdentity = dll.information();
        msysPath = dll.canonicalPath();
    }
    finally {
        dll.close();
    }
    const privateRoot = base.path;
    const { grantSid } = options.compatibility;
    const api = debugApi(), ctx = new ThreadContext();
    const states = new Map();
    let state, processHandle;
    let ownerProcess = null, job = null;
    let pid = 0, exited = false, joined = false;
    let terminatedAt;
    let pending;
    let repaired = 0, defaultDaclAdjusted = 0, mappingsAdjusted = 0;
    let exitCode, rootExitedAt, familyKey;
    const read = readMemory;
    const remote64 = (address) => read(processHandle, address, 8).readBigUInt64LE();
    const reg = (offset) => ctx.read64(offset);
    const writeData = (payload) => allocateData(processHandle, payload);
    function context(tid) {
        const thread = state.threads.get(tid);
        if (!thread)
            throw new LocalizedError('error.unknownThread');
        ctx.load(thread);
        return thread;
    }
    function arm(tid) {
        const thread = state.threads.get(tid);
        if (!thread)
            throw new LocalizedError('error.unknownThread');
        ctx.arm(thread, state.hooks.map(hook => hook.address), state.armed.has(tid));
        state.armed.add(tid);
    }
    function debugLoaderPath(event) {
        if (!event.nameSlot || !event.unicode)
            return '';
        const address = remote64(event.nameSlot);
        if (!address)
            return '';
        const name = wide(processHandle, address, 32768);
        return win32.isAbsolute(name) ? name : '';
    }
    function isPrivateDll(remoteHandle) {
        const output = Buffer.alloc(8);
        if (!api.duplicateHandle(processHandle, remoteHandle, api.currentProcess(), output, 0, 0, 2))
            return false;
        const handle = pointer(output);
        try {
            return sameIdentity(fileIdentity(handle), dllIdentity);
        }
        finally {
            close(handle);
        }
    }
    function verifyLoaderPath(started = !state.firstBreakpoint) {
        if (state.loaderPathVerified)
            return;
        if (!state.msys) {
            if (started && state.pid === pid)
                throw new LocalizedError('error.missingStartupMsys');
            return; // Native descendants need not load MSYS.
        }
        const loaded = loaderPath(processHandle, state.msys.base) || state.msys.loaderPath;
        // Fork initialization may precede PSAPI loader-list visibility.
        if (!loaded && !started)
            return;
        if (!loaded || !samePath(canonicalExistingPath(loaded), msysPath))
            throw new LocalizedError('error.loaderOutsideBase', { path: loaded });
        state.loaderPathVerified = true;
    }
    function onHit(tid, slot) {
        verifyLoaderPath();
        const thread = context(tid);
        const stack = reg(registers.rsp);
        const caller = remote64(stack);
        const fromPrivateMsys = state.msys !== undefined && caller >= state.msys.base && caller < state.msys.end;
        const callerModule = state.modules.find(module => caller >= module.base && caller < module.end)?.name;
        if (slot === 0) {
            const name = wide(processHandle, reg(registers.rcx));
            const attributes = remote64(stack + 0x40n);
            const access = Number(reg(registers.rdx) & 0xffffffffn), mode = Number(reg(registers.r8) & 0xffffffffn), instances = Number(reg(registers.r9));
            const match = /^\\\\\.\\pipe\\(?:msys|cygwin)-([a-f0-9]+)-(\d+)-sigwait$/i.exec(name);
            const ownSignalPipe = match !== null && Number(match[2]) === state.pid;
            if (ownSignalPipe) {
                const key = match[1].toLowerCase();
                if (!state.installationPathAdjusted && state.pid === pid)
                    throw new LocalizedError('error.startupNamespaceMissing');
                if (familyKey !== undefined && familyKey !== key)
                    throw new LocalizedError('error.descendantNamespaceChanged');
                familyKey ??= key;
                state.installationKey = key;
            }
            const trustedForwarder = callerModule === 'kernel32.dll' || callerModule === 'kernelbase.dll';
            const freshPrivatePipe = ownSignalPipe && state.msys !== undefined && (fromPrivateMsys || trustedForwarder)
                && (access & 0x80000) !== 0 && (mode & 8) !== 0 && instances === 1;
            let original;
            if (grantSid && freshPrivatePipe && attributes !== 0n) {
                const sd = remote64(attributes + 8n);
                if (sd)
                    original = descriptorText(readDescriptor(processHandle, sd));
            }
            if (grantSid && original) {
                grantPipe(processHandle, stack, attributes, original, grantSid);
                repaired++;
            }
        }
        else if (slot === 1 && grantSid) {
            const informationClass = Number(reg(registers.rdx));
            if (fromPrivateMsys && informationClass === 6 && reg(registers.r9) === 8n) {
                const original = defaultDaclText(processHandle, reg(registers.r8));
                if (!original.includes(`(A;;GA;;;${grantSid})`)) {
                    ctx.write64(registers.r8, grantDefaultDacl(processHandle, original, grantSid));
                    defaultDaclAdjusted++;
                }
            }
        }
        else if (slot === 2 && grantSid && fromPrivateMsys && remote64(stack + 0x38n) === 0n) {
            const attributes = reg(registers.r8);
            let rootName = '';
            let attrs;
            if (attributes !== 0n) {
                const parsed = objectAttributes(processHandle, attributes);
                attrs = parsed.attributes;
                const { root, name } = parsed;
                if (root && /^cygpid\.\d+$/.test(name))
                    rootName = objectName(processHandle, root);
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
        }
        else if (slot === 3 && !state.installationPathAdjusted && fromPrivateMsys && reg(registers.r9) === 0n && isPrivateDll(reg(registers.rcx))) {
            // MSYS normalizes its DLL pathname before hashing the installation key.
            // Retain a real session junction path in its original buffer, redirecting
            // only this optional normalization's output to private scratch data.
            // The native call/return still executes normally (including CET state).
            const text = win32.toNamespacedPath(resolve(installationRoot, 'usr/bin/msys-2.0.dll'));
            const bytes = Buffer.from(text + '\0', 'utf16le'), capacity = Number(reg(registers.r8));
            if (capacity < text.length + 1 || capacity > 32_768)
                throw new LocalizedError('error.viewBufferTooSmall');
            writeMemory(processHandle, reg(registers.rdx), bytes);
            ctx.write64(registers.rdx, writeData(Buffer.alloc(capacity * 2)));
            state.installationPathAdjusted = true;
        }
        ctx.resume(thread);
    }
    function admitModule(event) {
        const { file, base } = event;
        // Image-section handles may report another hardlink name. Prefer the
        // loader's spelling both for module classification and boundary admission.
        const loadedPath = loaderPath(processHandle, base) || debugLoaderPath(event) || fileName(file);
        if (!loadedPath)
            throw new LocalizedError('error.unidentifiedModule');
        const name = win32.basename(loadedPath).toLowerCase();
        const { size, x64 } = imageLayout(read(processHandle, base, 4096));
        state.modules.push({ name, base, end: base + BigInt(size) });
        if (name === 'msys-2.0.dll') {
            if (!x64)
                throw new LocalizedError('error.x64MsysRequired');
            state.imagePath ??= imagePath(processHandle);
            if (!containsPath(privateRoot, canonicalExistingPath(state.imagePath)))
                throw new LocalizedError('error.executableOutsideBase');
            if (!file || !sameIdentity(fileIdentity(file), dllIdentity))
                throw new LocalizedError('error.moduleIdentityMismatch');
            requireJobMember(processHandle, job);
            state.msys = { base, end: base + BigInt(size), loaderPath: debugLoaderPath(event) };
            verifyLoaderPath();
            // Forks may create pinfo before sigproc_init; they inherit this family's key.
            if (state.pid !== pid)
                state.installationKey = familyKey;
        }
        state.hooks.forEach((hook, slot) => {
            if (!x64 || name !== hook.module || (!grantSid && (slot === 1 || slot === 2)))
                return;
            const localBase = api.module(hook.module);
            if (!valid(localBase))
                throw new LocalizedError('error.missingModule', { module: hook.module });
            const address = api.symbol(localBase, hook.symbol);
            if (!valid(address) || address < localBase || address - localBase >= BigInt(size))
                throw new LocalizedError('error.unsupportedSymbol', { symbol: hook.symbol });
            hook.address = base + address - localBase;
        });
        if (state.msys)
            for (const tid of state.threads.keys())
                arm(tid);
    }
    function eventOnce(milliseconds, cleanup = false) {
        const event = waitDebugEvent(milliseconds);
        if (!event)
            return;
        const { pid: eventPid, tid } = event;
        pending = { pid: eventPid, tid };
        let disposition = 0x00010002;
        if (cleanup) {
            if (event.kind === 'process' || event.kind === 'module')
                attempt(() => close(event.file));
        }
        else {
            if (event.kind === 'process') {
                try {
                    if (states.has(eventPid))
                        throw new LocalizedError('error.duplicateProcess');
                    requireJobMember(event.process, job);
                    states.set(eventPid, { pid: eventPid, process: event.process, threads: new Map([[tid, event.thread]]),
                        armed: new Set(), modules: [], firstBreakpoint: true,
                        hooks: [{ module: 'kernelbase.dll', symbol: 'CreateNamedPipeW' }, { module: 'ntdll.dll', symbol: 'NtSetInformationToken' },
                            { module: 'ntdll.dll', symbol: 'NtCreateSection' }, { module: 'kernelbase.dll', symbol: 'GetFinalPathNameByHandleW' }] });
                }
                finally {
                    close(event.file);
                }
            }
            const selected = states.get(eventPid);
            if (!selected) {
                if (event.kind === 'module')
                    close(event.file);
                throw new LocalizedError('error.debugEventOutsideFamily');
            }
            state = selected;
            processHandle = state.process;
            switch (event.kind) {
                case 'process': break;
                case 'thread':
                    state.threads.set(tid, event.thread);
                    if (state.msys)
                        arm(tid);
                    break;
                case 'exit-thread':
                    state.threads.delete(tid);
                    state.armed.delete(tid);
                    break;
                case 'module':
                    try {
                        admitModule(event);
                    }
                    finally {
                        close(event.file);
                    }
                    break;
                case 'unload':
                    if (state.msys?.base === event.base) {
                        // Unload can be part of ordinary process teardown. Withdraw repair
                        // eligibility immediately; a later load must pass admission afresh.
                        state.msys = undefined;
                        state.loaderPathVerified = false;
                        state.installationPathAdjusted = false;
                    }
                    state.modules = state.modules.filter(module => module.base !== event.base);
                    for (const hook of state.hooks) {
                        if (hook.address !== undefined && !state.modules.some(module => hook.address >= module.base && hook.address < module.end))
                            hook.address = undefined;
                    }
                    if (state.msys)
                        for (const id of state.threads.keys())
                            arm(id);
                    else
                        for (const id of state.armed) {
                            ctx.arm(state.threads.get(id), [], true);
                            state.armed.delete(id);
                        }
                    break;
                case 'exception': {
                    const slot = state.hooks.findIndex(hook => hook.address === event.address);
                    if (event.code === 0x80000004 && slot >= 0)
                        onHit(tid, slot);
                    else if (event.code === 0x80000003 && state.firstBreakpoint) {
                        verifyLoaderPath(true);
                        if (state.msys && state.hooks.some((hook, i) => (grantSid || i === 0 || i === 3) && hook.address === undefined))
                            throw new LocalizedError('error.startupHooksUnavailable');
                        state.firstBreakpoint = false;
                    }
                    else
                        disposition = 0x80010001;
                    break;
                }
            }
        }
        if (event.kind === 'exit' && eventPid === pid) {
            exitCode = event.exitCode;
            rootExitedAt = performance.now();
        }
        checked(api.continueDebug(eventPid, tid, disposition), 'ContinueDebugEvent');
        pending = undefined;
        // Windows closes debug-event process/thread handles after continuation.
        if (event.kind === 'exit')
            states.delete(eventPid);
        exited = rootExitedAt !== undefined && states.size === 0;
    }
    const errors = [];
    const attempt = (action) => { try {
        action();
    }
    catch (error) {
        errors.push(error);
    } };
    try {
        const child = spawnDebugFamily({ command: path, applicationName: path,
            args: ['--noprofile', '--norc', '-c', options.command], cwd: options.cwd, env: options.environment,
            stdio: { stdin: 0, stdout: 1, stderr: 2 } });
        pid = child.pid;
        ownerProcess = child.process;
        job = child.job;
        checked(api.killOnDebuggerExit(1), 'DebugSetProcessKillOnExit');
        // Continuing EXIT_PROCESS_DEBUG_EVENT precedes the kernel's Job accounting
        // update. Join both observations, including descendants after root exit.
        while (!exited || !isJobEmpty(api, job)) {
            if (terminatedAt === undefined && rootExitedAt !== undefined && performance.now() - rootExitedAt >= options.graceMs) {
                terminateJob(api, job, 1);
                terminatedAt = performance.now();
            }
            if (terminatedAt !== undefined && performance.now() - terminatedAt > 3000)
                throw new LocalizedError('error.jobTerminationTimeout');
            eventOnce(25);
        }
        joined = true;
        if (exitCode === undefined || familyKey === undefined)
            throw new LocalizedError('error.familyExitUnconfirmed');
    }
    catch (error) {
        errors.push(error);
    }
    finally {
        if (job && !joined) {
            attempt(() => terminateJob(api, job, 1));
            if (pending)
                attempt(() => { checked(api.continueDebug(pending.pid, pending.tid, 0x00010002), 'ContinueDebugEvent(cleanup)'); pending = undefined; });
            const until = performance.now() + 3000;
            attempt(() => { while ((!exited || !isJobEmpty(api, job)) && performance.now() < until)
                eventOnce(25, true); });
        }
        if (job)
            attempt(() => { if (!isJobEmpty(api, job))
                throw new LocalizedError('error.jobTerminationUnconfirmed'); });
        attempt(() => close(ownerProcess));
        attempt(() => close(job));
        attempt(() => ctx.close());
    }
    if (errors.length)
        throw new LocalizedAggregateError(errors);
    return { exitCode: exitCode, repaired, defaultDaclAdjusted, mappingsAdjusted, installationKey: familyKey };
}
