import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workerData } from 'node:worker_threads';
import { setupCancellationFile } from './private-runtime.ts';
import { nativeRuntime } from './native.ts';
import type { NativePtr } from '@deepseek-ai/dsh-win32-process';

const quote = (argument: string) => '"' + argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';

/** Keep modal UAC/COM work off DSH's event loop, using its existing native SDK. */
async function requestElevation(): Promise<void> {
  const { source, generation } = workerData as { source: string; generation: string };
  const cancelled = () => existsSync(join(generation, setupCancellationFile));
  if (cancelled()) throw new Error('Hardlink setup was cancelled before elevation.');
  const ffi = nativeRuntime.aclRequire('koffi');
  const info = ffi.struct({ cbSize: 'uint32', fMask: 'uint32', hwnd: 'void *', lpVerb: 'str16', lpFile: 'str16',
    lpParameters: 'str16', lpDirectory: 'str16', nShow: 'int', hInstApp: 'void *', lpIDList: 'void *',
    lpClass: 'str16', hkeyClass: 'void *', dwHotKey: 'uint32', hIcon: 'void *', hProcess: 'void *' });
  if (info.size !== 112) throw new Error('Unsupported SHELLEXECUTEINFOW layout.');
  const shell = ffi.load('shell32.dll');
  const execute = shell.func('__stdcall', 'ShellExecuteExW', 'int', [ffi.inout(ffi.pointer(info))]);
  const processModule = await nativeRuntime.load(nativeRuntime.aclRequire, '@deepseek-ai/dsh-win32-process');
  const api = processModule.loadWin32ProcessBindings();
  const request = { cbSize: info.size, fMask: 0x140, hwnd: null, lpVerb: 'runas', lpFile: process.execPath,
    lpParameters: [fileURLToPath(new URL('./link-helper.js', import.meta.url)), source, generation, String(process.pid)].map(quote).join(' '),
    lpDirectory: generation, nShow: 0, hInstApp: null, lpIDList: null, lpClass: null, hkeyClass: null, dwHotKey: 0, hIcon: null, hProcess: null as NativePtr | null };
  console.error('dsh-git-bash: Windows Administrator permission is needed solely to hardlink read-only Git files into the private runtime. Source ACLs are unchanged; DSH and shell commands do not run elevated.');
  const ole = ffi.load('ole32.dll');
  const initialize = ole.func('__stdcall', 'CoInitializeEx', 'int32', ['void *', 'uint32']);
  const uninitialize = ole.func('__stdcall', 'CoUninitialize', 'void', []);
  const apartment = initialize(null, 6); // STA + disable OLE1 DDE, on this thread only.
  if (apartment < 0) throw new Error(`Cannot initialize the setup COM apartment: 0x${(apartment >>> 0).toString(16)}`);
  try {
    if (cancelled()) throw new Error('Hardlink setup was cancelled before elevation.');
    if (!execute(request)) throw new Error(`Hardlink setup elevation was refused or failed (Windows ${api.getLastError()}); the command did not run.`);
  } finally { uninitialize(); }
  const processHandle = request.hProcess;
  if (!processHandle) throw new Error('Elevated hardlink setup returned no process handle.');
  try {
    while (api.waitForSingleObject(processHandle, 0) === 258) await new Promise(resolve => setTimeout(resolve, 100));
    if (cancelled()) throw new Error('Hardlink setup was cancelled; the helper has exited.');
    const resultPath = join(generation, 'setup-result.json');
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as { ok: boolean; message?: string };
    unlinkSync(resultPath);
    if (!result.ok) throw new Error(`Elevated hardlink setup failed: ${result.message}`);
  } finally { api.closeHandle(processHandle); }
}

await requestElevation();
