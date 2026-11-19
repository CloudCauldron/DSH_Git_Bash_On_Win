import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import koffi from 'koffi';
import { closeHandleChecked, isNullPtr, loadWin32ProcessBindings, pollProcessExit, throwLastError } from '@deepseek-ai/dsh-win32-process';
import { readMetadata, requireActiveLease, requireWindows } from '../runtime/ntfs-filesystem.js';
import { decodeElevationPlan, planByteLimit, planGeneration } from './elevated-linking.js';
import { LocalizedError } from '../locale/errors.js';
// DSH's equivalent quoteArg is not a public export. ShellExecuteEx takes a
// Windows argument string, not shell syntax; preserve quotes and trailing '\\'.
const quote = (argument) => '"' + argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
/** Modal COM/UAC stays in this unelevated DSH-owned process. */
export async function runElevationBroker(planPath, digest) {
    requireWindows();
    const generation = planGeneration(planPath);
    const plan = decodeElevationPlan(readMetadata(generation, 'plan.json', planByteLimit), digest);
    const api = loadWin32ProcessBindings();
    const info = koffi.struct({
        cbSize: 'uint32', fMask: 'uint32', hwnd: 'void *', lpVerb: 'str16', lpFile: 'str16',
        lpParameters: 'str16', lpDirectory: 'str16', nShow: 'int', hInstApp: 'void *', lpIDList: 'void *',
        lpClass: 'str16', hkeyClass: 'void *', dwHotKey: 'uint32', hIcon: 'void *', hProcess: 'void *',
    });
    if (info.size !== 112)
        throw new LocalizedError('error.unsupportedShellExecuteLayout', { type: 'SHELLEXECUTEINFOW' });
    const execute = koffi.load('shell32.dll').func('__stdcall', 'ShellExecuteExW', 'int', [koffi.inout(koffi.pointer(info))]);
    const ole = koffi.load('ole32.dll');
    const initialize = ole.func('__stdcall', 'CoInitializeEx', 'int32', ['void *', 'uint32']);
    const uninitialize = ole.func('__stdcall', 'CoUninitialize', 'void', []);
    const request = {
        cbSize: info.size, fMask: 0x140, hwnd: null, lpVerb: 'runas', lpFile: process.execPath,
        lpParameters: [fileURLToPath(new URL('./link-helper.js', import.meta.url)), planPath, digest].map(quote).join(' '),
        lpDirectory: fileURLToPath(new URL('.', import.meta.url)), nShow: 0, hInstApp: null, lpIDList: null,
        lpClass: null, hkeyClass: null, dwHotKey: 0, hIcon: null, hProcess: null,
    };
    console.error('dsh-git-bash: Administrator permission is needed only for private Git hardlinks. Git contents and ACLs stay unchanged; DSH commands remain unelevated.');
    const apartment = initialize(null, 6); // STA and disable OLE1 DDE, this thread only.
    if (apartment < 0)
        throw new LocalizedError('error.setupComFailed', { status: (apartment >>> 0).toString(16) });
    try {
        requireActiveLease(generation, plan.identities.lease);
        if (!execute(request))
            throwLastError(api, 'ShellExecuteExW');
        if (isNullPtr(request.hProcess))
            throw new LocalizedError('error.missingElevatedProcess');
        let exit;
        while ((exit = pollProcessExit(api, request.hProcess)) === undefined)
            await delay(25);
        if (exit !== 0)
            throw new LocalizedError('error.linkHelperExit', { code: String(exit) });
    }
    finally {
        try {
            if (!isNullPtr(request.hProcess))
                closeHandleChecked(api, request.hProcess, 'elevated link helper');
        }
        finally {
            uninitialize();
        }
    }
}
if (import.meta.main) {
    process.exitCode = 1;
    try {
        if (process.argv.length !== 4)
            throw new LocalizedError('error.setupPlanArgument');
        await runElevationBroker(process.argv[2], process.argv[3]);
        process.exitCode = 0;
    }
    catch (error) {
        console.error(String(error).slice(0, 8192));
    }
}
