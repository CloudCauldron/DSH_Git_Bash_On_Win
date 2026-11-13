import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createContext, type Runtime } from '../poc/runtime.ts';
import type { Context } from '@deepseek-ai/cordis';
import { packPlugin } from './package.ts';

export function readProfileVerification(path: string, outcome: { status: number | null; stderr: string }) {
  const present = existsSync(path);
  if (outcome.status !== 0 || !present) {
    throw new Error(`Isolated DSH profile exited ${outcome.status}; ${present ? readFileSync(path, 'utf8') : 'missing verification.json'}.\n${outcome.stderr}\nLive checks require interactive UAC approval within the 120-second subprocess deadline.`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

export async function verifyProfile(installed: Runtime, root: string, workspace: string,
  check: (name: string, passed: boolean, detail?: unknown) => void, report: Record<string, unknown>) {
  const previous = { DSH_HOME: process.env.DSH_HOME, DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED };
  const previousCwd = process.cwd();
  const home = join(root, 'isolated-dsh');
  const profile = join(home, 'profiles/gitbash-test');
  mkdirSync(profile, { recursive: true });
  const active = JSON.parse(readFileSync(join(process.env.USERPROFILE!, '.dsh/profiles/web/package.json'), 'utf8'));
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-gitbash-isolated-test', private: true,
    dependencies: { 'dsh-session-deletion': active.dependencies['dsh-session-deletion'] },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-session-deletion'] } } }, null, 2));
  writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'test-verifier', name: new URL('./profile-driver.ts', import.meta.url).href,
    config: { execute: !process.argv.includes('--structure-only') } }] }]));
  process.env.DSH_HOME = home;
  process.env.DSH_TELEMETRY_DISABLED = '1';
  process.chdir(workspace);
  try {
    const cli = join(dirname(installed.manifest), 'lib/bin.js');
    const repository = join(dirname(fileURLToPath(import.meta.url)), '..');
    const pnpm = process.env.DSH_GITBASH_TEST_PNPM ?? join(process.env.LOCALAPPDATA!, 'Microsoft/WinGet/Packages/pnpm.pnpm_Microsoft.Winget.Source_8wekyb3d8bbwe/pnpm.exe');
    const artifact = packPlugin(pnpm, repository, join(root, 'packed'));
    const added = spawnSync(process.execPath, [join(repository, 'scripts/plugin.ts'), pnpm, 'gitbash-test', 'add',
      artifact, '--ignore-scripts', '--store-dir', join(root, 'profile-store'), '--state-dir', join(root, 'profile-state')],
      { encoding: 'utf8', timeout: 120_000, maxBuffer: 4_000_000 });
    check('isolated profile: packed plugin installs through official operation', added.status === 0, { status: added.status, stderr: added.stderr });
    const packageDirectory = dirname(createRequire(join(profile, 'package.json')).resolve('dsh-git-bash-on-win/package.json'));
    const dumped = spawnSync(process.execPath, [cli, '--profile', 'gitbash-test', '--dump-config'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4_000_000 });
    report.configDump = { exitCode: dumped.status, stderr: dumped.stderr, containsAdapter: dumped.stdout.includes('git-bash-adapter'),
      containsNativeShellId: dumped.stdout.includes('id: pwsh-sandbox'), containsCleanup: dumped.stdout.includes('dsh-session-deletion') };
    check('isolated profile: --dump-config composes plugin and cleanup bundle', dumped.status === 0 && dumped.stdout.includes('git-bash-adapter') && dumped.stdout.includes('id: pwsh-sandbox') && !dumped.stderr.includes('name mismatch'), report.configDump);
    const configurationBefore = ['package.json', 'cordis.patch.yml'].map(name => readFileSync(join(profile, name), 'utf8'));
    // DSH owns the whole test CLI range, including the cleanup plugin's guard.
    // Join/terminate it before deleting the test home so no guard can recreate it.
    const runProfile = async (restart = false, cleanup = false) => {
      const verificationPath = join(profile, 'verification.json');
      if (existsSync(verificationPath)) unlinkSync(verificationPath);
      const owner = await createContext(installed) as unknown as Context;
      try {
      const handle = owner.subprocess.spawn({ argv: [process.execPath, cli, '--profile', 'gitbash-test', '--host', '127.0.0.1', '--port', '0', '--no-open'],
        cwd: workspace, env: { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_GITBASH_VERIFY_RESTART: restart ? '1' : '0', DSH_GITBASH_VERIFY_CLEANUP: cleanup ? '1' : '0' }, graceMs: 500,
        signal: AbortSignal.timeout(120_000), stdio: { stdin: 'ignore', stdout: { maxBytes: 4_000_000 }, stderr: { maxBytes: 4_000_000 } } });
      const outcome = await handle.done;
      handle.terminate();
      await handle.waitForExit();
      return { status: outcome.exitCode, stderr: handle.collected.stderr!.readFrom(0).text };
      } finally { await owner.fiber.dispose(); }
    };
    const running = await runProfile();
    report.profileExitCode = running.status;
    report.profileStderr = running.stderr;
    const verification = readProfileVerification(join(profile, 'verification.json'), running);
    report.profileVerification = verification;
    check('isolated profile: real CLI verification completes', running.status === 0 && !verification.error, verification);
    for (const row of verification.checks) check(`isolated profile: ${row.name}`, row.passed, row.detail);
    check('isolated profile: adapter startup leaves profile configuration unchanged', verification.startupPatchHash === createHash('sha256').update(configurationBefore[1]!).digest('hex') && readFileSync(join(profile, 'package.json'), 'utf8') === configurationBefore[0]);
    const saved = spawnSync(process.execPath, [cli, '--profile', 'gitbash-test', '--dump-config'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4_000_000 });
    check('isolated profile: native settings persist in composed configuration', saved.status === 0
      && ['timeoutMs: 9876', 'maxTimeoutMs: 180000', 'maxOutputBytes: 2345', 'maxSpillBytes: 4096', 'graceMs: 250', 'gitBashPath:', 'cwd:'].every(value => saved.stdout.includes(value))
      && !saved.stderr.includes('name mismatch'));
    const cache = join(profile, '.git-bash-on-win');
    const cacheSnapshot = () => {
      if (!existsSync(join(cache, 'current.json'))) return undefined;
      const record = JSON.parse(readFileSync(join(cache, 'current.json'), 'utf8'));
      return { record, identity: String(statSync(join(cache, 'generations', record.generation), { bigint: true }).ino) };
    };
    const beforeRestart = cacheSnapshot();
    check('isolated profile: shutdown retains only persistent runtime state', (process.argv.includes('--structure-only') || beforeRestart !== undefined)
      && !existsSync(join(packageDirectory, '.runtime')) && (!existsSync(cache) || !readdirSync(cache).some(name => name.startsWith('.owner-') || name === '.lock')));
    const restarted = await runProfile(true);
    const reloaded = readProfileVerification(join(profile, 'verification.json'), restarted);
    report.profileRestart = { ...restarted, verification: reloaded };
    check('isolated profile: persisted settings survive a fresh DSH process', restarted.status === 0 && !reloaded.error, report.profileRestart);
    for (const row of reloaded.checks) check(`isolated profile restart: ${row.name}`, row.passed, row.detail);
    check('isolated profile: restart executes tools with the same cache generation and zero UAC', !restarted.stderr.includes('Administrator permission is needed')
      && JSON.stringify(cacheSnapshot()) === JSON.stringify(beforeRestart)
      && (process.argv.includes('--structure-only') || reloaded.checks.some((row: any) => row.name === 'standard executes its Bash tool' && row.passed)), { beforeRestart, afterRestart: cacheSnapshot(), stderr: restarted.stderr });
    const cleanupRun = await runProfile(true, true);
    const cleaned = readProfileVerification(join(profile, 'verification.json'), cleanupRun);
    check('isolated profile: documented override cleanup preserves shared Shell settings', cleanupRun.status === 0
      && cleaned.checks?.some((row: any) => row.name === 'complete-removal step deletes only the plugin-specific path override' && row.passed), { ...cleanupRun, verification: cleaned });
    const removed = spawnSync(process.execPath, [join(repository, 'scripts/plugin.ts'), pnpm, 'gitbash-test', 'remove', 'dsh-git-bash-on-win',
      '--ignore-scripts', '--store-dir', join(root, 'profile-store'), '--state-dir', join(root, 'profile-state')], { encoding: 'utf8', timeout: 120_000, maxBuffer: 4_000_000 });
    const finalConfig = spawnSync(process.execPath, [cli, '--profile', 'gitbash-test', '--dump-config'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4_000_000 });
    check('isolated profile: complete uninstall removes bundle and plugin-only configuration', removed.status === 0 && finalConfig.status === 0
      && !finalConfig.stdout.includes('git-bash-adapter') && !finalConfig.stdout.includes('gitBashPath') && finalConfig.stdout.includes('maxOutputBytes: 2345')
      && !existsSync(join(profile, '.git-bash-on-win')), { removed: removed.status, dump: finalConfig.status, stderr: removed.stderr + finalConfig.stderr });
  } finally {
    process.chdir(previousCwd);
    for (const key of ['DSH_HOME', 'DSH_TELEMETRY_DISABLED'] as const) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
}
