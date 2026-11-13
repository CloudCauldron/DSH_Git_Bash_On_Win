import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, installedSource, launch, loadRuntime, type Mode } from './runtime.ts';
import { createNativeDiagnostics } from './windows.ts';
import { assess } from './verify.ts';
import { createTestScope } from './scope.ts';

const runtime = await loadRuntime();
const source = dirname(fileURLToPath(import.meta.url));
const bash = process.env.DSH_POC_BASH ?? 'C:/Program Files/Git/bin/bash.exe';
if (!existsSync(bash)) throw new Error('Set DSH_POC_BASH to Git for Windows bin/bash.exe.');
const { resolvePwshPath } = await runtime.load(runtime.cliRequire, '@deepseek-ai/dsh-pwsh-local');
const pwsh: string = resolvePwshPath();
const native = await createNativeDiagnostics(runtime);
const gitBin = resolve(dirname(bash), '../usr/bin');
const privateRuntimeFiles = ['bash.exe', 'msys-2.0.dll'];
const dll = readFileSync(join(gitBin, 'msys-2.0.dll'));
const hashInstalled = () => Object.fromEntries([
  ['@deepseek-ai/dsh-sandbox-windows-acl', 'src/token.ts'],
  ['@deepseek-ai/dsh-sandbox-windows-acl', 'src/acl.ts'],
  ['@deepseek-ai/dsh-sandbox-windows-acl', 'lib/index.js'],
  ['@deepseek-ai/dsh-sandbox-windows-acl', 'lib/runner.js'],
  ['@deepseek-ai/dsh-subprocess-local', 'src/index.ts'],
  ['@deepseek-ai/dsh-subprocess-local', 'lib/index.js'],
].map(([name, path]) => [`${name}/${path}`, createHash('sha256').update(readFileSync(installedSource(runtime, name!, path!))).digest('hex')]));
const sourceHashes = hashInstalled();
const reportPath = resolve(source, 'results/latest.json');
mkdirSync(dirname(reportPath), { recursive: true });
const scope = createTestScope('dsh-gitbash-poc-');
const root = scope.root;
const workspace = join(root, 'workspace 含空格');
const outside = join(root, 'outside');
const payload = join(root, 'payload');
const modes = ['unconfined-control', 'read-only', 'workspace-write'] as const satisfies readonly Mode[];
let privateBinaries: Record<Mode, string>;
try {
  for (const directory of [workspace, outside, payload]) mkdirSync(directory);
  privateBinaries = Object.fromEntries(modes.map(mode => {
    // Separate installation keys: an unconfined control must not seed the restricted copy's namespace.
    const bin = join(root, 'private-runtime', mode, 'usr/bin');
    mkdirSync(bin, { recursive: true });
    for (const file of privateRuntimeFiles) copyFileSync(join(gitBin, file), join(bin, file));
    return [mode, join(bin, 'bash.exe')];
  })) as Record<Mode, string>;
  writeFileSync(join(outside, 'canary.txt'), 'outside-canary-unchanged', { flag: 'wx' });
  for (const mode of modes) for (const op of ['overwrite', 'append', 'rename', 'delete']) {
    writeFileSync(join(outside, `${mode}-${op}.txt`), 'fixture-original', { flag: 'wx' });
  }
  for (const file of ['child.ts', 'runtime.ts', 'windows.ts']) copyFileSync(join(source, file), join(payload, file));
} catch (error) { scope.dispose(); throw error; }
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(), dsh: runtime.version, node: process.version,
  windows: { release: (await import('node:os')).release(), arch: process.arch },
  bash, pwsh, temporaryRoot: root,
  msysBuild: dll.toString('utf16le').match(/3\.6\.\d+-[a-f0-9]{40}/)?.[0],
  privateRuntime: privateRuntimeFiles.map(file => ({ file,
    originalHash: createHash('sha256').update(readFileSync(join(gitBin, file))).digest('hex'),
    copiedHashes: Object.fromEntries(modes.map(mode => [mode, createHash('sha256').update(readFileSync(join(dirname(privateBinaries[mode]), file))).digest('hex')])),
  })),
  sourceHashes,
  runs: [], shells: [],
};
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
let ctx: Awaited<ReturnType<typeof createContext>> | undefined;
let namespace: Awaited<ReturnType<typeof native.createPrivateNamespace>> | undefined;
try {
  // Only this fresh random object is provisioned; no existing object DACL is edited.
  namespace = native.createPrivateNamespace();
  report.privateNamespaceSetup = namespace.result;
  ctx = await createContext(runtime);
  for (const mode of modes) {
    console.log(`Testing ${mode}`);
    let directBashStderr = '';
    for (const [name, argv] of [
      ['cmd', [join(process.env.SystemRoot ?? 'C:/Windows', 'System32/cmd.exe'), '/d', '/c', 'echo native-cmd-ok']],
      ['cmd-pipeline', [join(process.env.SystemRoot ?? 'C:/Windows', 'System32/cmd.exe'), '/d', '/c', 'echo native-pipeline-ok|findstr native-pipeline-ok']],
      ['pwsh', [pwsh, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "Write-Output 'native-pwsh-ok'"]],
      ['git-bash', [bash, '--noprofile', '--norc', '-c', "printf 'git-bash-started\\n'; /usr/bin/printf 'msys-child-started\\n'"]],
      ['private-runtime-bash', [privateBinaries[mode], '--noprofile', '--norc', '-c', "printf 'private-bash-started\\n'"]],
    ] as const) {
      const run = await launch(ctx, mode, workspace, argv);
      if (name === 'git-bash') directBashStderr = run.stderr;
      (report.shells as unknown[]).push({ name, ...run });
      save();
    }
    const input = { manifest: runtime.manifest, bash, pwsh, workspace, outside, mode, namespace: namespace.path, directBashStderr };
    const run = await launch(ctx, mode, workspace, [process.execPath, join(payload, 'child.ts'), JSON.stringify(input)]);
    let diagnostic: unknown;
    let inheritedGrandchild: unknown;
    const parseFrame = (prefix: string) => {
      const frame = run.stdout.split(/\r?\n/).find(line => line.startsWith(prefix));
      return frame === undefined ? null : JSON.parse(frame.slice(prefix.length));
    };
    try { diagnostic = parseFrame('@@DSH_POC_WORKER@@'); inheritedGrandchild = parseFrame('@@DSH_POC_GRANDCHILD@@'); }
    catch { diagnostic = null; inheritedGrandchild = null; }
    (report.runs as unknown[]).push({ ...run, diagnostic, inheritedGrandchild });
    save();
    console.log(JSON.stringify({ mode, exitCode: run.exitCode, diagnosticAvailable: diagnostic !== null }));
  }
  report.outsideCanaryUnchanged = readFileSync(join(outside, 'canary.txt'), 'utf8') === 'outside-canary-unchanged';
  report.restrictedOutsideFixturesUnchanged = modes.filter(mode => mode !== 'unconfined-control').every(mode =>
    ['overwrite', 'append', 'rename', 'delete'].every(op =>
      existsSync(join(outside, `${mode}-${op}.txt`)) && readFileSync(join(outside, `${mode}-${op}.txt`), 'utf8') === 'fixture-original')
    && !existsSync(join(outside, `${mode}-renamed.txt`)));
  report.installedSourcesUnchanged = JSON.stringify(hashInstalled()) === JSON.stringify(sourceHashes);
  report.installedGitRuntimeUnchanged = (report.privateRuntime as Array<{ file: string; originalHash: string }>).every(file =>
    createHash('sha256').update(readFileSync(join(gitBin, file.file))).digest('hex') === file.originalHash);
} catch (error) {
  report.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
  process.exitCode = 1;
} finally {
  const failures: string[] = [];
  try { await ctx?.fiber.dispose(); } catch (error) { failures.push(`DSH disposal: ${String(error)}`); }
  try { namespace?.close(); } catch (error) { failures.push(`Private namespace: ${String(error)}`); }
  let isolation: object = {};
  try { isolation = scope.dispose(); } catch (error) { failures.push(`Temporary files: ${String(error)}`); }
  report.cleanup = { temporaryRootRemoved: !existsSync(root), ...isolation, failures };
  report.completedAt = new Date().toISOString();
  report.assessment = assess(report);
  const assessment = report.assessment as ReturnType<typeof assess>;
  if (assessment.passed !== assessment.total) process.exitCode = 1;
  save();
  if (failures.length) process.exitCode = 1;
}
console.log(`Report: ${reportPath}`);
const assessment = report.assessment as ReturnType<typeof assess>;
console.log(JSON.stringify({ verdict: assessment.verdict, passed: assessment.passed, total: assessment.total, failed: assessment.checks.filter(check => !check.passed) }));
