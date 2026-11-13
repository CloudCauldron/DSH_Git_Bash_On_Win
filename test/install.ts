import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { loadRuntime } from '../poc/runtime.ts';
import { createTestScope } from '../poc/scope.ts';
import { packPlugin } from './package.ts';

const installed = await loadRuntime();
const scope = createTestScope('dsh-gitbash-install-');
const source = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(dirname(installed.manifest), 'lib/bin.js');
const home = join(scope.root, 'home');
const profile = join(home, 'profiles/gitbash-install');
const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
const args = ['--ignore-scripts', '--store-dir', join(scope.root, 'store'), '--state-dir', join(scope.root, 'state')];
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), root: scope.root };
const active = join(process.env.USERPROFILE!, '.dsh/profiles/web');
const snapshot = () => ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml'].map(name => createHash('sha256').update(readFileSync(join(active, name))).digest('hex'));
const before = snapshot();
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: scope.root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4_000_000 });
const pnpm = process.env.DSH_GITBASH_TEST_PNPM ?? join(process.env.LOCALAPPDATA!, 'Microsoft/WinGet/Packages/pnpm.pnpm_Microsoft.Winget.Source_8wekyb3d8bbwe/pnpm.exe');
const operation = (...args: string[]) => spawnSync(process.execPath, [join(source, 'scripts/plugin.ts'), pnpm, 'gitbash-install', ...args], { cwd: scope.root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4_000_000 });
let owner: ReturnType<typeof spawn> | undefined, ownerExit: Promise<unknown> | undefined;
try {
  const artifact = packPlugin(pnpm, source, join(scope.root, 'packed'));
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-gitbash-install-test', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
  const added = operation('add', artifact, ...args);
  report.add = { status: added.status, stderr: added.stderr, stdout: added.stdout };
  assert.equal(added.status, 0, added.stderr || added.stdout);
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
  assert(manifest.dsh.profile.bundles.includes('dsh-git-bash-on-win'));
  const dumped = run('--profile', 'gitbash-install', '--dump-config');
  report.dump = { status: dumped.status, stderr: dumped.stderr, containsAdapter: dumped.stdout.includes('git-bash-adapter') };
  assert.equal(dumped.status, 0, dumped.stderr);
  assert(dumped.stdout.includes('git-bash-adapter'));
  const app = await installed.load(installed.cliRequire, '@deepseek-ai/dsh-app-boot');
  assert.throws(() => app.assertBundlePlatform(['win32'], 'linux'), /supports Host platforms/);
  report.nonWindowsAdmissionRejected = true;
  const packageDirectory = dirname(realpathSync(createRequire(join(profile, 'package.json')).resolve('dsh-git-bash-on-win/package.json')));
  const fallback = join(packageDirectory, '.runtime'), cache = join(profile, '.git-bash-on-win');
  const fixture = join(scope.root, 'synthetic-git'), workspace = join(scope.root, 'workspace');
  mkdirSync(join(fixture, 'usr/bin'), { recursive: true }); mkdirSync(workspace);
  const fixtureFile = join(fixture, 'usr/bin/bash.exe'); writeFileSync(fixtureFile, 'synthetic source');
  const runtimeModule = pathToFileURL(join(packageDirectory, 'lib/private-runtime.js')).href;
  const probe = `import {RuntimeDirectory} from ${JSON.stringify(runtimeModule)}; import {once} from 'node:events';
    const [fallback,cache,source,workspace,hold]=process.argv.slice(1);
    const managers=[new RuntimeDirectory(fallback,source,workspace),...hold==='1'?[new RuntimeDirectory(cache,source,workspace)]:[]];
    try {for(const manager of managers) await manager.prepare(source,'read-only',workspace);
      if(hold==='1'){console.log('fallback-ready');await once(process.stdin,'data');}}
    finally {for(const manager of managers) await manager.dispose();}`;
  owner = spawn(process.execPath, ['--input-type=module', '-e', probe, fallback, cache, fixture, workspace, '1'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostics = '';
  owner.stderr!.on('data', chunk => { diagnostics += String(chunk); });
  ownerExit = once(owner, 'exit');
  const output = createInterface({ input: owner.stdout! });
  try {
    const [ready] = await Promise.race([once(output, 'line'), ownerExit.then(() => { throw new Error(`Fallback owner exited before readiness: ${diagnostics}`); })]);
    assert.equal(ready, 'fallback-ready');
  } finally { output.close(); }
  const blocked = operation('remove', 'dsh-git-bash-on-win', ...args);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /Close every DSH instance/);
  assert(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dependencies['dsh-git-bash-on-win']);
  report.activeFallbackRemovalRefused = true;
  owner.stdin!.end('stop');
  const stopped = await ownerExit as [number | null, string | null];
  assert.equal(stopped[0], 0, diagnostics); owner = undefined;
  const cleaned = spawnSync(process.execPath, [join(packageDirectory, 'lib/cleanup.js'), cache], { env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert(!existsSync(cache) && !existsSync(fallback));
  assert.equal(statSync(fixtureFile).nlink, 1);
  report.packagedCleanupPurgesBothCaches = true;
  const inactive = spawnSync(process.execPath, ['--input-type=module', '-e', probe, fallback, cache, fixture, workspace, '0'], { env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(inactive.status, 0, inactive.stderr);
  assert(existsSync(fallback));
  const removed = operation('remove', 'dsh-git-bash-on-win', ...args);
  report.remove = { status: removed.status, stderr: removed.stderr, stdout: removed.stdout };
  assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  const after = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
  assert(!after.dsh.profile.bundles.includes('dsh-git-bash-on-win'));
  assert(!existsSync(fallback));
  assert.equal(statSync(fixtureFile).nlink, 1);
  report.removalPurgesFallbackBeforePackageManager = true;
  report.passed = true;
} catch (error) {
  report.error = String(error); process.exitCode = 1;
} finally {
  if (owner) { owner.kill(); await ownerExit; }
  report.activeProfileUnchanged = JSON.stringify(snapshot()) === JSON.stringify(before);
  if (!report.activeProfileUnchanged) process.exitCode = 1;
  try { report.cleanup = scope.dispose(); } catch (error) { report.cleanupError = String(error); process.exitCode = 1; }
  const cleanup = report.cleanup as ReturnType<typeof scope.dispose> | undefined;
  if (!cleanup?.temporaryRootRemoved || !cleanup.environmentRestored || cleanup.addedAmbientLocks.length) process.exitCode = 1;
  report.passed = report.passed === true && !process.exitCode;
  report.completedAt = new Date().toISOString();
  mkdirSync(join(source, 'test/results'), { recursive: true });
  writeFileSync(join(source, 'test/results/install.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, error: report.error, activeProfileUnchanged: report.activeProfileUnchanged, cleanup: report.cleanup }));
}
