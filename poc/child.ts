import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendFileSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRuntime } from './runtime.ts';
import { createNativeDiagnostics } from './windows.ts';

interface Input {
  manifest: string;
  bash: string;
  pwsh: string;
  workspace: string;
  outside: string;
  mode: string;
  namespace?: string;
  directBashStderr?: string;
}

const argument = process.argv[2] ?? '';
const input = JSON.parse(argument.startsWith('base64=') ? Buffer.from(argument.slice(7), 'base64').toString('utf8') : argument) as Input;
const runtime = await loadRuntime(input.manifest);
const native = await createNativeDiagnostics(runtime);

function fileProbe(directory: string) {
  const path = join(directory, `probe-${randomUUID()}.txt`);
  try {
    writeFileSync(path, 'sandbox probe', { flag: 'wx' });
  } catch (error) {
    return { path, written: false, code: (error as NodeJS.ErrnoException).code };
  }
  try { rmSync(path); return { path, written: true, removed: true }; }
  catch (error) { return { path, written: true, removed: false, cleanupError: (error as NodeJS.ErrnoException).code }; }
}

function command(file: string, args: string[]) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 6_000, windowsHide: true, maxBuffer: 64_000 });
  return {
    exitCode: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
    error: result.error ? { message: result.error.message, code: (result.error as NodeJS.ErrnoException).code } : undefined,
  };
}

const before = native.token();
const isGrandchild = process.argv[3] === '--grandchild';
const files = { workspace: fileProbe(input.workspace), outside: fileProbe(input.outside), temp: fileProbe(tmpdir()) };
const readCanary = readFileSync(join(input.outside, 'canary.txt'), 'utf8');
const summary: Record<string, unknown> = { token: before.public, files, outsideCanary: readCanary };
summary.existingOutsideFiles = Object.fromEntries([
  ['overwrite', () => writeFileSync(join(input.outside, `${input.mode}-overwrite.txt`), 'modified')],
  ['append', () => appendFileSync(join(input.outside, `${input.mode}-append.txt`), 'modified')],
  ['rename', () => renameSync(join(input.outside, `${input.mode}-rename.txt`), join(input.outside, `${input.mode}-renamed.txt`))],
  ['delete', () => unlinkSync(join(input.outside, `${input.mode}-delete.txt`))],
].map(([operation, act]) => {
  // Descendants only probe fresh writes; do not repeat mutations of the parent's fixtures.
  if (isGrandchild && !process.argv.includes('--mutate-fixtures')) return [operation, { skipped: true }];
  try { (act as () => void)(); return [operation, { allowed: true }]; }
  catch (error) { return [operation, { allowed: false, code: (error as NodeJS.ErrnoException).code }]; }
}));

if (!isGrandchild) {
  summary.nativeCmd = command(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/cmd.exe'), ['/d', '/c', 'echo native-cmd-ok']);
  summary.nativePwsh = command(input.pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Console]::Write("native-pwsh-ok")']);
  summary.gitBash = command(input.bash, ['--noprofile', '--norc', '-c', "printf 'git-bash-started\\n'; printf '%s\\n' \"$BASH_VERSION\"; /usr/bin/printf 'msys-child-started\\n'"]);
  summary.grandchild = command(process.execPath, [fileURLToPath(import.meta.url), JSON.stringify(input), '--grandchild']);
  const inherited = spawnSync(process.execPath, [fileURLToPath(import.meta.url), JSON.stringify(input), '--grandchild'], {
    stdio: ['ignore', 'inherit', 'inherit'], timeout: 6_000, windowsHide: true,
  });
  summary.grandchildInherited = {
    exitCode: inherited.status, signal: inherited.signal,
    error: inherited.error ? { message: inherited.error.message, code: (inherited.error as NodeJS.ErrnoException).code } : undefined,
  };
  summary.privatePipes = native.pipeMatrix(before);
  summary.namespaces = native.namespaceMatrix(before, input.namespace, { stderr: input.directBashStderr ?? '' });
  summary.filesAfterIpc = { workspace: fileProbe(input.workspace), outside: fileProbe(input.outside), temp: fileProbe(tmpdir()) };
}

const after = native.token();
summary.tokenUnchanged = before.public.fingerprint === after.public.fingerprint;
console.log((isGrandchild ? '@@DSH_POC_GRANDCHILD@@' : '@@DSH_POC_WORKER@@') + JSON.stringify(summary));
