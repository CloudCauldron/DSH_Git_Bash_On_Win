import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import { installedDsh } from '../scripts/installed-dsh.ts';
import { executionFixture, loadPackedExecutor, pnpmExecutable, profileEnvironment, qualifyPackedProfile } from './fixtures.ts';
import { buildRuntimeEnvironment, buildCopyLayout, discoverGitInstallation } from '../src/runtime/git-installation.ts';
import { admitDirectory, createDirectory, removeTree } from '../src/runtime/ntfs-filesystem.ts';
import { bundledShimUrl, sharedCacheDirectory } from '../src/runtime/runtime-cache.ts';

function protection() {
  const status = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Get-MpComputerStatus -ErrorAction Stop | Select-Object AntivirusEnabled,RealTimeProtectionEnabled | ConvertTo-Json -Compress'], { encoding: 'utf8' });
  return JSON.parse(status) as { AntivirusEnabled: boolean; RealTimeProtectionEnabled: boolean };
}

async function coldCopy(t: TestContext) {
  assert.ok(process.platform === 'win32' && process.arch === 'x64', 'Run with Windows x64 Node.');
  const setting = process.env.DSH_TEST_GIT_BASH;
  const sourceBin = join(discoverGitInstallation(setting).root, 'usr/bin');
  const home = admitDirectory(mkdtempSync(join(tmpdir(), 'dsh-copy-bench-')));
  t.after(() => removeTree(admitDirectory(dirname(home.path)), basename(home.path)));
  const parent = createDirectory(createDirectory(home, basename(sharedCacheDirectory(home.path))), 'g');
  const names = readdirSync(sourceBin, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name);
  const sourceBytes = names.reduce((sum, name) => sum + statSync(join(sourceBin, name)).size, 0);
  const before = protection();
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const source = discoverGitInstallation(setting);
    const generation = createDirectory(parent, i.toString(16).padStart(16, '0'));
    const { runtime } = await buildCopyLayout(generation, source, readFileSync(bundledShimUrl), t.signal);
    const ms = performance.now() - start;
    const bin = join(runtime.path, 'usr/bin');
    const files = readdirSync(bin, { withFileTypes: true }).filter(e => e.isFile());
    assert.deepEqual(files.map(e => e.name).sort(), [...names, 'dsh-msys-compat.dll'].sort());
    const bytes = files.reduce((sum, entry) => sum + statSync(join(bin, entry.name)).size, 0);
    t.diagnostic(JSON.stringify({ sample: i + 1, layout: source.layout, sourceFiles: names.length, sourceBytes, files: files.length, bytes, ms }));
    removeTree(parent, basename(generation.path));
  }
  const after = protection();
  const active = [before, after].every(s => s.AntivirusEnabled && s.RealTimeProtectionEnabled);
  t.diagnostic(JSON.stringify({ before, after, activeDefender: active ? 'measured' : 'UNVERIFIED' }));
}

if (process.env.DSH_BENCH_COLD_ONLY === '1') await test('cold copy provisioning on fresh NTFS generations', coldCopy);
else await test('packed runtime and shipping revision on identical Git workloads', t => qualifyPackedProfile(t, import.meta.url, async profile => {
  const repo = join(import.meta.dirname, '..'), staging = dirname(dirname(profile));
  const f = await executionFixture(t);
  const old = await executionFixture(t);
  const { root, Executor } = await loadPackedExecutor(f.ctx, profile);
  const cacheModule = pathToFileURL(join(root, 'lib/runtime/runtime-cache.js')).href;
  const runtime = await import(cacheModule) as typeof import('../src/runtime/runtime-cache.ts');
  const ntfsModule = new URL('./ntfs-filesystem.js', cacheModule);
  const { canonicalWorkspace, overlaps } = await import(ntfsModule.href) as typeof import('../src/runtime/ntfs-filesystem.ts');
  const shipping = '33fa0a9039d193452ccab7eefc222144437f8aaa';
  const tree = join(staging, 'shipping'), snapshot = join(staging, 'shipping.tar');
  mkdirSync(tree);
  execFileSync('git.exe', ['archive', '-o', snapshot, shipping, '--', 'lib', 'locale', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'], { cwd: repo });
  execFileSync(join(process.env.SystemRoot!, 'System32/tar.exe'), ['-xf', snapshot, '-C', tree]);
  execFileSync(pnpmExecutable(), ['install', '--prod', '--ignore-scripts', '--frozen-lockfile'], { cwd: tree, env: profileEnvironment(staging, staging), stdio: 'inherit' });
  const { default: Shipping } = await import(pathToFileURL(join(tree, 'lib/index.js')).href) as { default: typeof Executor };
  const shippingCache = await import(pathToFileURL(join(tree, 'lib/runtime/runtime-cache.js')).href) as typeof runtime;
  const dsh = installedDsh();
  const { Context } = await dsh.load(dsh.baseRequire, '@deepseek-ai/cordis') as typeof import('@deepseek-ai/cordis');
  const { SandboxBashExecutor } = await dsh.load(dsh.baseRequire, '@deepseek-ai/dsh-bash-sandbox') as typeof import('@deepseek-ai/dsh-bash-sandbox');
  const direct = new Context();
  const stats = (samples: number[]) => {
    const sorted = samples.toSorted((a, b) => a - b), n = sorted.length;
    return { median: (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2,
      p95: sorted[Math.ceil(n * .95) - 1], max: sorted.at(-1), over1000: samples.filter(n => n > 1000).length };
  };
  const emit = (data: object) => console.log(JSON.stringify(data));
  const before = protection();
  emit({ shipping, protection: before,
    node: process.version, dsh: dsh.version, git: execFileSync(join(f.source, f.installed.layout, 'bin/git.exe'), ['--version'], { encoding: 'utf8' }).trim() });
  const warm: number[] = [], cold: number[] = [], ready: number[] = [];
  const payload = () => readdirSync(join(f.cache, 'g')).map(id => {
    const bin = join(f.cache, 'g', id, 'r/usr/bin');
    const files = readdirSync(bin, { withFileTypes: true }).filter(f => f.isFile());
    return { id, files: files.length, bytes: files.reduce((n, f) => n + statSync(join(bin, f.name)).size, 0) };
  });
  for (let i = 0; i < 5; i++) {
    const start = performance.now(), pin = await runtime.prepareRuntime(f.request, t.signal);
    cold.push(performance.now() - start);
    await pin.release();
    const selector = join(f.cache, 'current.json'), published = readFileSync(selector, 'utf8');
    const elapsed = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { prepareRuntime } = await import(process.argv[1]);
      const request = JSON.parse(process.argv[2]);
      const start = performance.now();
      const pin = await prepareRuntime(request, new AbortController().signal);
      const elapsed = performance.now() - start;
      await pin.release();
      console.log(elapsed);
    `, cacheModule, JSON.stringify(f.request)], { encoding: 'utf8' });
    assert.equal(readFileSync(selector, 'utf8'), published, 'fresh process must reuse the same generation');
    const ms = Number(elapsed.trim());
    assert.ok(Number.isFinite(ms) && ms > 0);
    warm.push(ms);
    if (i < 4) await runtime.purgeRuntimeCache(f.cache);
  }
  const first = await runtime.prepareRuntime(f.request, t.signal);
  try {
    for (let i = 0; i < 26; i++) {
      const start = performance.now(), use = first.acquireUse();
      try {
        const workspace = await canonicalWorkspace(f.workspace);
        assert.ok(!overlaps(workspace, use.sourceRoot) && !overlaps(workspace, use.cacheRoot));
        use.bindView({ workspace, prefix: 'ro', sessionId: 'ready' });
      } finally { await use.release(); }
      if (i >= 2) ready.push(performance.now() - start);
    }
    const next = await runtime.prepareRuntime({ ...f.request, rebuild: true }, t.signal);
    try { assert.equal(payload().length, 2); } finally { await next.release(); }
  } finally { await first.release(); }
  const retained = payload(); assert.equal(retained.length, 2);
  emit({ cold, warm, ready, readyStats: stats(ready), retained });
  const sweep = await runtime.prepareRuntime({ ...f.request, rebuild: true }, t.signal);
  await sweep.release();
  assert.equal(payload().length, 1);

  const path = [join(process.env.SystemRoot!, 'System32'), process.env.SystemRoot, dirname(process.execPath)].join(';');
  const modes = ['danger-full-access', 'read-only', 'workspace-write'] as const;
  const git = execFileSync(join(f.source, f.installed.layout, 'bin/git.exe'), ['--version'], { encoding: 'utf8' }).trim();
  const workloads = [
    ['builtin', 'echo ok', 'ok'],
    ['pipeline', 'set -o pipefail; result=$(printf "beta\\nalpha\\nalpha\\n" | grep -Fx alpha | wc -l) && test "$result" -eq 2 && printf "matches=%d\\n" "$result"', 'matches=2'],
    ['git', 'git --version', git],
  ] as const;
  let handle: SubprocessHandle | undefined;
  const observe = (child: SubprocessHandle) => { assert.equal(handle, undefined); return handle = child; };
  const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess);
  direct.provide('sandboxPolicy', f.ctx.get('sandboxPolicy'));
  direct.provide('sandbox', f.ctx.sandbox);
  direct.provide('subprocess', { spawn: (spec: SubprocessSpawnSpec) => {
    assert.deepEqual(spec.argv.slice(-3, -1), ['bash', '-c']);
    return observe(spawn({ ...spec, argv: [...spec.argv.slice(0, -3), f.request.gitBashPath!, '--noprofile', '--norc', ...spec.argv.slice(-2)],
      env: { ...spec.env, ...buildRuntimeEnvironment(f.source, f.source, f.installed.layout, { PATH: path }) } }));
  } });
  for (const ctx of [f.ctx, old.ctx]) {
    const original = ctx.subprocess.spawn.bind(ctx.subprocess);
    ctx.subprocess.spawn = spec => observe(original(spec));
  }
  const currentHost = f.ctx.plugin(Executor, { gitBashPath: f.request.gitBashPath, graceMs: 500 });
  const shippingHost = old.ctx.plugin(Shipping, { gitBashPath: old.request.gitBashPath, graceMs: 500 });
  try {
    await Promise.all([currentHost, shippingHost, direct.plugin(SandboxBashExecutor, { graceMs: 500 })]);
    const shells = { copy: f.ctx.shell, shipping: old.ctx.shell, direct: direct.shell };
    const cells = new Map<string, number[]>();
    // All six permutations balance the three full-access lanes, alternating pairs balance the restricted lanes.
    const orders = ['direct shipping copy', 'shipping copy direct', 'copy direct shipping',
      'direct copy shipping', 'copy shipping direct', 'shipping direct copy'];
    const groups = modes.flatMap(mode => workloads.map(workload => ({ mode, workload })));
    for (let round = -2; round < 24; round++) {
      for (let offset = 0; offset < groups.length; offset++) {
        const group = (offset + round + 2) % groups.length;
        const { mode, workload: [name, command, expected] } = groups[group]!;
        const ordinal = round + group + 2;
        const order = mode === 'danger-full-access' ? orders[ordinal % 6]! : ordinal % 2 ? 'copy shipping' : 'shipping copy';
        for (const lane of order.split(' ') as Array<keyof typeof shells>) {
          const sh = shells[lane];
          handle = undefined;
          const start = performance.now();
          const ex = await sh.execute(sh.resolve({ command, workdir: f.workspace, env: { PATH: path, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
            timeoutMs: 22000, onExpiry: 'kill', sandboxPolicy: { mode, workspaceRoot: f.workspace, sessionId: 'bench' as SandboxExecutionPolicy['sessionId'] } }));
          const result = await ex.result();
          await ex.done;
          const child = handle as SubprocessHandle | undefined;
          assert.ok(child, result.stderr.text);
          assert.equal(await child.waitForExit(AbortSignal.timeout(5000)), true);
          const ms = performance.now() - start;
          assert.equal(result.timedOut, false);
          assert.equal(result.aborted, false);
          assert.equal(result.exitCode, 0, result.stderr.text);
          assert.equal(result.stdout.text.trimEnd(), expected);
          if (round < 0) continue;
          const cell = [mode, name, lane].join('/');
          const values = cells.get(cell) ?? [];
          values.push(ms); cells.set(cell, values);
        }
      }
    }
    assert.equal(cells.size, 21);
    for (const [cell, samples] of cells) { assert.equal(samples.length, 24); emit({ cell, samples, ...stats(samples) }); }
    emit({ protectionAfter: protection() });
  } finally {
    await direct.fiber.dispose();
    await currentHost.dispose();
    await shippingHost.dispose();
    await shippingCache.purgeRuntimeCache(old.cache);
  }
}));
