import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, installedSource, launch, loadRuntime, type Mode } from './runtime.ts';
import { createTestScope } from './scope.ts';
import { createNativeDiagnostics } from './windows.ts';
import { assessPhase2 } from './verify.ts';

const runtime = await loadRuntime();
const source = dirname(fileURLToPath(import.meta.url));
const installedBash = process.env.DSH_POC_BASH ?? 'C:/Program Files/Git/bin/bash.exe';
const installedBin = resolve(dirname(installedBash), '../usr/bin');
const native = await createNativeDiagnostics(runtime);
const reportPath = join(source, 'results/phase2-latest.json');
mkdirSync(dirname(reportPath), { recursive: true });
const hash = (path: string) => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
const watched = [
  installedBash, join(installedBin, 'bash.exe'), join(installedBin, 'msys-2.0.dll'),
  ...['lib/index.js', 'lib/runner.js', 'src/token.ts', 'src/acl.ts'].map(file => installedSource(runtime, '@deepseek-ai/dsh-sandbox-windows-acl', file)),
  ...['package.json', 'cordis.yml', 'cordis.patch.yml'].map(file => join(process.env.USERPROFILE!, '.dsh/profiles/web', file)),
];
const before = Object.fromEntries(watched.map(path => [path, hash(path)]));
const watchedSecurity = [dirname(installedBash), installedBin, join(installedBin, 'msys-2.0.dll'), join(process.env.USERPROFILE!, '.dsh/profiles/web')];
const securityBefore = Object.fromEntries(watchedSecurity.map(path => [path, native.fileSecurityHash(path)]));
const scope = createTestScope();
const workspace = join(scope.root, 'workspace');
const outside = join(scope.root, 'outside');
const payload = join(scope.root, 'payload');
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), dsh: runtime.version, node: process.version,
  observationOnly: !process.argv.includes('--repair-pipe') && !process.argv.includes('--repair-ipc'), temporaryRoot: scope.root,
  runs: [], watchedHashes: before, watchedSecurityHashes: securityBefore };
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
let ctx: Awaited<ReturnType<typeof createContext>> | undefined;
try {
  for (const directory of [workspace, outside, payload]) mkdirSync(directory);
  writeFileSync(join(outside, 'canary.txt'), 'outside-canary-unchanged', { flag: 'wx' });
  for (const file of ['runtime.ts', 'windows.ts', 'phase2-child.ts', 'child.ts']) copyFileSync(join(source, file), join(payload, file));
  writeFileSync(join(payload, 'debugger.ts'), `export { debugPrivateBash } from ${JSON.stringify(new URL('../src/ipc.ts', import.meta.url).href)};\n`);
  ctx = await createContext(runtime);
  report.ordinaryBashBefore = await launch(ctx, 'unconfined-control', workspace, [installedBash, '--noprofile', '--norc', '-c', "printf 'ordinary-bash-ok\\n'"]);
  const modes: Exclude<Mode, 'unconfined-control'>[] = process.argv.includes('--both-modes') ? ['read-only', 'workspace-write'] : ['read-only'];
  report.expectedModes = modes;
  for (const mode of modes) {
    const variants = [{ name: 'observe', repair: false, repairDefaultDacl: false },
      ...process.argv.includes('--repair-pipe') || process.argv.includes('--repair-ipc') ? [{ name: 'signal-pipe', repair: true, repairDefaultDacl: false }] : [],
      ...process.argv.includes('--repair-ipc') ? [{ name: 'ipc', repair: true, repairDefaultDacl: true }] : []];
    for (const variant of variants) {
      const { repair, repairDefaultDacl } = variant;
      console.log(`Phase 2: ${mode}, ${variant.name}`);
      const privateRoot = join(scope.root, `${mode}-${variant.name}`);
      const bin = join(privateRoot, 'usr/bin');
      mkdirSync(bin, { recursive: true });
      for (const file of ['bash.exe', 'msys-2.0.dll', 'true.exe']) copyFileSync(join(installedBin, file), join(bin, file));
      const copiesMatch = ['bash.exe', 'msys-2.0.dll', 'true.exe'].every(file => hash(join(installedBin, file)) === hash(join(bin, file)));
      if (!copiesMatch) throw new Error('Private runtime differs from the installed runtime.');
      const fixtureMode = `${mode}-${variant.name}`;
      for (const operation of ['overwrite', 'append', 'rename', 'delete']) writeFileSync(join(outside, `${fixtureMode}-${operation}.txt`), 'fixture-original', { flag: 'wx' });
      const fixture = { manifest: runtime.manifest, bash: installedBash, pwsh: '', workspace, outside, mode: fixtureMode };
      const encodedFixture = 'base64=' + Buffer.from(JSON.stringify(fixture)).toString('base64');
      const writeTest = (name: string, directory: string) => `if printf 'probe' > ${quote(join(directory, `${fixtureMode}-bash.txt`).replaceAll('\\', '/'))}; then printf '@@DSH_BASH_WRITE@@${name}:allowed\\n'; else printf '@@DSH_BASH_WRITE@@${name}:denied\\n'; fi; `;
      const command = "set +e; printf 'private-bash-started\\n'; " + writeTest('workspace', workspace) + writeTest('outside', outside)
        + quote(join(bin, 'true.exe').replaceAll('\\', '/')) + "; printf '@@DSH_MSYS_CHILD@@%s\\n' \"$?\"; "
        + "printf 'pipeline-ok\\n' | " + quote(join(bin, 'bash.exe').replaceAll('\\', '/'))
        + " --noprofile --norc -c " + quote("IFS= read -r line; printf '@@DSH_PIPELINE@@%s\\n' \"$line\"") + "; "
        + [process.execPath.replaceAll('\\', '/'), join(payload, 'child.ts').replaceAll('\\', '/'), encodedFixture, '--grandchild', '--mutate-fixtures'].map(quote).join(' ');
      const probe = { manifest: runtime.manifest, privateRoot, bash: join(bin, 'bash.exe'), workspace, command, repair, repairDefaultDacl,
        repairMappings: repairDefaultDacl && process.argv.includes('--repair-mappings'), followFamily: process.argv.includes('--follow-family') };
      const launched = await launch(ctx, mode, workspace, [process.execPath, join(payload, 'phase2-child.ts'), JSON.stringify(probe)]);
      const debugFrame = launched.stdout.split(/\r?\n/).find(line => line.startsWith('@@DSH_POC_DEBUG@@'));
      const result = debugFrame ? JSON.parse(debugFrame.slice('@@DSH_POC_DEBUG@@'.length)) : { error: launched.stderr };
      const frame = result.stdout?.split(/\r?\n/).find((line: string) => line.startsWith('@@DSH_POC_GRANDCHILD@@'));
      const descendant = frame ? JSON.parse(frame.slice('@@DSH_POC_GRANDCHILD@@'.length)) : null;
      (report.runs as unknown[]).push({ mode, variant: variant.name, copiesMatch, ...result, descendant,
        observerExitCode: launched.exitCode,
        descendantMatchesSource: descendant !== null && descendant?.token?.fingerprint === result.sourceToken?.fingerprint,
        outsideFixturesUnchanged: ['overwrite', 'append', 'rename', 'delete'].every(operation =>
          existsSync(join(outside, `${fixtureMode}-${operation}.txt`)) && readFileSync(join(outside, `${fixtureMode}-${operation}.txt`), 'utf8') === 'fixture-original')
          && !existsSync(join(outside, `${fixtureMode}-renamed.txt`)) && !existsSync(join(outside, `${fixtureMode}-bash.txt`)),
      });
      save();
      console.log(JSON.stringify({ mode, repair, exitCode: result.exitCode, repaired: result.repaired, error: result.error, descendantAvailable: descendant !== null }));
    }
  }
  report.ordinaryBashAfter = await launch(ctx, 'unconfined-control', workspace, [installedBash, '--noprofile', '--norc', '-c', "printf 'ordinary-bash-ok\\n'"]);
  report.watchedFilesUnchanged = watched.every(path => hash(path) === before[path]);
  report.watchedSecurityUnchanged = watchedSecurity.every(path => native.fileSecurityHash(path) === securityBefore[path]);
  report.canaryUnchanged = readFileSync(join(outside, 'canary.txt'), 'utf8') === 'outside-canary-unchanged';
} catch (error) {
  report.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
  process.exitCode = 1;
} finally {
  const cleanupErrors: string[] = [];
  try { await ctx?.fiber.dispose(); } catch (error) { cleanupErrors.push(`DSH disposal: ${String(error)}`); }
  try { report.cleanup = scope.dispose(); } catch (error) { cleanupErrors.push(`Test scope: ${String(error)}`); }
  report.cleanupErrors = cleanupErrors;
  report.completedAt = new Date().toISOString();
  report.assessment = assessPhase2(report);
  const assessment = report.assessment as ReturnType<typeof assessPhase2>;
  if (assessment.passed !== assessment.total) process.exitCode = 1;
  save();
  if (cleanupErrors.length) process.exitCode = 1;
}
console.log(`Report: ${reportPath}`);
const assessment = report.assessment as ReturnType<typeof assessPhase2>;
console.log(JSON.stringify({ verdict: assessment.verdict, passed: assessment.passed, total: assessment.total, failed: assessment.checks.filter(check => !check.passed) }));
