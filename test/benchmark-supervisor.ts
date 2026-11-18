import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildRuntimeEnvironment } from '../src/runtime/git-installation.ts';
import { executionFixture, nativeWindows } from './fixtures.ts';

const lanes = ['direct', 'node', 'supervised'] as const;
type Lane = typeof lanes[number];
const commands = {
  builtin: 'printf ok',
  external: '/usr/bin/true.exe && printf ok',
  loop50: 'for ((i=0; i<50; i++)); do /usr/bin/true.exe || exit 1; done; printf ok',
};
const relay = `const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.argv[1], process.argv.slice(2), { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;`;
const reportUsage = 'data:text/javascript,' + encodeURIComponent(`
  process.on('exit', () => {
    const {maxRSS, userCPUTime, systemCPUTime} = process.resourceUsage();
    console.error(JSON.stringify({peakMiB: maxRSS / 1024, cpuMs: (userCPUTime + systemCPUTime) / 1000}));
  });`);

// Opt-in. Use disposable Git bytes and a DSH Job for every lane, including direct Bash.
await test('Windows Git Bash supervisor benchmark', async t => {
  assert.ok(nativeWindows, 'Run with native Windows x64 Node.');
  const fixture = await executionFixture(t);
  assert.ok(fixture, 'The benchmark requires the pinned DSH and Git for Windows.');
  const pin = await fixture.prepare();
  const mode = 'danger-full-access';
  const use = await pin.lease({ mode, workspaceRoot: fixture.workspace }, new AbortController().signal);
  try {
    const bash = join(use.baseRoot, 'usr/bin/bash.exe');
    const launcher = fileURLToPath(new URL('../lib/bash-launcher.js', import.meta.url));
    const env = { ...process.env };
    const runtimeEnv = buildRuntimeEnvironment(use.installationRoot, use.sourceRoot, use.layout, env);
    for (const key of Object.keys(env)) {
      if (Object.keys(runtimeEnv).some(name => name.toLowerCase() === key.toLowerCase())) delete env[key];
    }
    Object.assign(env, runtimeEnv);
    const run = async (lane: Lane, command: string, sampleUsage = false) => {
      const shell = [bash, '--noprofile', '--norc', '-c', command];
      const node = sampleUsage ? [process.execPath, '--import', reportUsage] : [process.execPath];
      const argv = lane === 'direct' ? shell : lane === 'node' ? [...node, '-e', relay, ...shell]
        : [...node, launcher, use.baseRoot, use.installationRoot, use.sourceRoot, use.layout, mode,
          Buffer.from(command).toString('base64'), '300'];
      const start = performance.now();
      const child = fixture.ctx.subprocess.spawn({ argv, cwd: fixture.workspace, env: lane === 'supervised' ? process.env : env,
        signal: AbortSignal.timeout(60_000), graceMs: 300,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 8192 } } });
      try {
        const result = await child.done;
        assert.ok(await child.waitForExit(AbortSignal.timeout(5000)));
        const ms = performance.now() - start;
        const stderr = child.collected.stderr!.readFrom(0).text.trim();
        assert.equal(result.exitCode, 0, stderr);
        assert.equal(child.collected.stdout!.readFrom(0).text, 'ok');
        if (!sampleUsage) assert.equal(stderr, '');
        return { ms, usage: sampleUsage ? JSON.parse(stderr) as { peakMiB: number; cpuMs: number } : undefined };
      } finally {
        child.terminate();
        assert.ok(await child.waitForExit(AbortSignal.timeout(5000)));
      }
    };

    for (const [workload, command] of Object.entries(commands)) {
      for (const lane of lanes) await run(lane, command);
      // Nine paired rounds put each lane first, second and third three times.
      for (let round = 0; round < 9; round++) {
        for (let i = 0; i < lanes.length; i++) {
          const lane = lanes[(round + i) % lanes.length]!;
          const { ms } = await run(lane, command);
          t.diagnostic(JSON.stringify({ workload, round, lane, ms }));
        }
      }
      // Collect process-local high-water and CPU counters outside timed runs.
      for (let round = 0; round < 3; round++) {
        for (const lane of ['node', 'supervised'] as const) {
          const { usage } = await run(lane, command, true);
          t.diagnostic(JSON.stringify({ workload, round, lane, ...usage }));
        }
      }
    }
  } finally { await use.release(); }
});
