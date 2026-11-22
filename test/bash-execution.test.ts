import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { basename, dirname, join, toNamespacedPath } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import timers, { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type { ShellExecRequest, ShellExecution } from '@deepseek-ai/dsh-shell';
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import { tempWriteSid, workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl';
import { Win32Error } from '@deepseek-ai/dsh-win32-process';
import GitBashExecutor from '../src/index.ts';
import { admitDirectory, claimDirectory, isBusy, NativeHold, pathExists } from '../src/runtime/ntfs-filesystem.ts';
import { purgeRuntimeCache } from '../src/runtime/runtime-cache.ts';
import { msysHolderCommand, observeMsysImages, expectedMsysKey, shortPath, executionFixture, nativeOnly, runtimeFixture } from './fixtures.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function executorFixture(t: TestContext) {
  let dispose = async () => {};
  const unblock = new Set<() => void>();
  t.after(async () => { for (const resume of unblock) resume(); await dispose(); });
  const fixture = await runtimeFixture(t, 'ucrt64', '.dsh-git-bash-on-win');
  const ctx = new Context();
  const spawned: Array<{ spec: SubprocessSpawnSpec; finish: (exitCode?: number) => void }> = [];
  const policy: SandboxExecutionPolicy = { mode: 'read-only', workspaceRoot: fixture.workspace };
  const controls = {
    spawnError: undefined as Error | undefined,
    providerError: undefined as Error | undefined,
    terminations: 0,
    range: async (outcome: Promise<SubprocessOutcome>) => { await outcome; return true; },
    confine: async (argv: string[]) => ({ argv: ['fixture-runner', '--workspace', policy.workspaceRoot, '--temp', fixture.directory, '--mode', policy.mode, '--', ...argv], enforcement: 'partial' as const, denialSignatures: [], runnerFailureRules: [] }),
  };
  const provider = {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      assert.equal(this, provider);
      if (controls.spawnError) throw controls.spawnError;
      const outcome = deferred<SubprocessOutcome>();
      const finish = (exitCode = 0) => outcome.resolve({ exitCode, signal: null });
      const abort = () => finish(1);
      spec.signal?.addEventListener('abort', abort, { once: true });
      void outcome.promise.then(() => spec.signal?.removeEventListener('abort', abort));
      const reader = { readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }) };
      spawned.push({ spec, finish });
      return {
        stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
        collected: { stdout: reader, stderr: reader }, done: controls.providerError ? Promise.reject(controls.providerError) : outcome.promise,
        terminate() { controls.terminations++; abort(); }, waitForExit: () => controls.range(outcome.promise),
      };
    },
  };
  ctx.provide('profileContext', { dir: fixture.directory, home: fixture.directory });
  ctx.provide('subprocess', provider);
  ctx.provide('sandboxPolicy', { defaultMode: policy.mode, resolve: () => policy });
  ctx.provide('sandbox', { confine: (argv: string[]) => controls.confine(argv) });
  class FixtureLoader extends Loader {
    override import() { return GitBashExecutor; }
    override commit() {} // No settings file or personal profile.
  }
  await ctx.plugin(FixtureLoader);
  const options = { id: 'phase4-executor', name: 'fixture-executor', config: { gitBashPath: fixture.request.gitBashPath } };
  await ctx.loader.root.update([options]);
  await ctx.loader.await();
  const executor = ctx.shell as GitBashExecutor;
  const entry = ctx.loader.resolve(options.id)!;
  const providerContext = entry.fiber!.ctx, providerId = entry.fiber!.uid;
  dispose = async () => { await ctx.fiber.dispose(); };
  const run = (request: Partial<ShellExecRequest> = {}) => executor.execute(executor.resolve({ command: 'fixture command', onExpiry: 'none', ...request }));
  return { ...fixture, ctx, providerContext, executor, spawned, controls, policy, run, dispose,
    holdCopy() {
      const blocked = holdCopy(t);
      unblock.add(blocked.resume);
      return blocked;
    },
    async select(value: string | undefined) {
      await ctx.loader.root.update([{ ...options, config: { gitBashPath: value } }]);
      assert.equal(entry.fiber?.uid, providerId, 'native volatile updates must preserve the provider');
      assert.equal(executor.config.gitBashPath.get(), value);
    },
  };
}

/** Hold one copy yield, so cancellation must drain real cache work. */
function holdCopy(t: TestContext) {
  const entered = deferred<void>(), resume = deferred<void>(), original = timers.setImmediate;
  let first = true;
  const mock = t.mock.method(timers, 'setImmediate', (async (...args: Parameters<typeof original>) => {
    if (first) { first = false; entered.resolve(); await resume.promise; }
    return original(...args);
  }) as typeof original);
  syncBuiltinESMExports();
  t.after(() => { resume.resolve(); mock.mock.restore(); syncBuiltinESMExports(); });
  return { entered: entered.promise, resume: () => resume.resolve() };
}

function invocation(spec: SubprocessSpawnSpec) {
  assert.deepEqual(spec.argv.slice(-4, -1), ['--noprofile', '--norc', '-c']);
  const view = dirname(dirname(dirname(spec.argv.at(-5)!)));
  return { view, base: join(dirname(dirname(view)), 'r'), command: spec.argv.at(-1)! };
}
await test('executor activation is lazy; concurrent commands share readiness and admit scope before confinement', nativeOnly, async t => {
  const f = await executorFixture(t);
  await turn();
  assert.equal(pathExists(f.cache), false);
  const blocked = f.holdCopy();
  const first = f.run(), second = f.run();
  await blocked.entered;
  assert.equal(f.spawned.length, 0);
  let sawEmptyBeforeBinding = false;
  f.controls.confine = async argv => {
    const id = (await f.current()).generationId;
    const views = fs.readdirSync(join(f.cache, 'g', id, 'v'), { recursive: true });
    if (!views.length) sawEmptyBeforeBinding = true;
    return { argv: ['fixture-runner', '--workspace', f.workspace, '--temp', f.directory, '--mode', 'read-only', '--', ...argv], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] };
  };
  blocked.resume();
  const [a, b] = await Promise.all([first, second]);
  const [one, two] = f.spawned.map(item => invocation(item.spec));
  assert.equal(one!.base, two!.base);
  assert.notEqual(one!.view, two!.view);
  assert.ok(sawEmptyBeforeBinding);
  assert.equal(one!.command, 'fixture command');
  assert.deepEqual(f.spawned[0]!.spec.argv.slice(0, 2), ['fixture-runner', '--workspace']);
  assert.equal(fs.readdirSync(join(f.cache, 'g')).length, 1);
  f.spawned.forEach(item => item.finish());
  await Promise.all([a.done, b.done]);
});

await test('caller cancellation and native timeout abandon waits without cancelling shared preparation', nativeOnly, async t => {
  const f = await executorFixture(t), blocked = f.holdCopy(), cancelled = new AbortController();
  const abandoned = assert.rejects(f.run({ signal: cancelled.signal }), /caller left/);
  const active = f.run();
  await blocked.entered;
  cancelled.abort(new Error('caller left'));
  await abandoned;
  const timedOut = await f.run({ onExpiry: 'kill', timeoutMs: 10 });
  assert.equal((await timedOut.result()).timedOut, true);
  assert.equal(f.spawned.length, 0);
  blocked.resume();
  const execution = await active;
  assert.equal(f.spawned.length, 1);
  f.spawned[0]!.finish(); await execution.done;
});
await test('rebuild supersedes unfinished initialization and becomes shared readiness before awaiting its drain', nativeOnly, async t => {
  const f = await executorFixture(t), blocked = f.holdCopy();
  const displaced = f.run();
  await blocked.entered;
  const obsolete = fs.readdirSync(join(f.cache, 'g'))[0]!;
  const rebuilding = f.executor.rebuildRuntime();
  const joining = f.run();
  await assert.rejects(f.executor.rebuildRuntime(), /busy/);
  await turn();
  assert.deepEqual(fs.readdirSync(join(f.cache, 'g')), [obsolete]);
  blocked.resume();
  await rebuilding;
  const [a, b] = await Promise.all([displaced, joining]);
  const current = (await f.current()).generationId;
  assert.notEqual(current, obsolete);
  assert.equal(pathExists(join(f.cache, 'g', obsolete)), false);
  assert.ok(f.spawned.every(item => invocation(item.spec).base === join(f.cache, 'g', current, 'r')));
  f.spawned.forEach(item => item.finish()); await Promise.all([a.done, b.done]);
});

await test('failed readiness is retained until an explicit rebuild', nativeOnly, async t => {
  const f = await executorFixture(t), original = fs.writeFileSync;
  const failure = new Error('fixture cold link failure');
  const mock = t.mock.method(fs, 'writeFileSync', () => { throw failure; }); syncBuiltinESMExports();
  try { await assert.rejects(f.run(), error => error === failure); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(fs.writeFileSync, original);
  await assert.rejects(f.run(), error => error === failure);
  assert.equal(f.spawned.length, 0);
  await f.executor.rebuildRuntime();
  const execution = await f.run(); f.spawned[0]!.finish(); await execution.done;
});

await test('a failed shared rebuild gives displaced and new waiters the same retained failure', nativeOnly, async t => {
  const f = await executorFixture(t), blocked = f.holdCopy();
  const first = f.run(); await blocked.entered;
  const failure = new Error('fixture rebuild link failure');
  const mock = t.mock.method(fs, 'writeFileSync', () => { throw failure; }); syncBuiltinESMExports();
  try {
    const rebuilding = f.executor.rebuildRuntime(), joining = f.run();
    const outcomes = Promise.all([first, rebuilding, joining].map(operation => assert.rejects(operation, error => error === failure)));
    blocked.resume(); await outcomes;
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  await assert.rejects(f.run(), error => error === failure);
  assert.equal(f.spawned.length, 0);
  assert.equal(pathExists(join(f.cache, 'current.json')), false);
  await f.executor.rebuildRuntime();
});

await test('a successful rebuild serves the old pin during preparation and preserves its running uses', nativeOnly, async t => {
  const f = await executorFixture(t), oldExecution = await f.run();
  const old = invocation(f.spawned[0]!.spec), blocked = f.holdCopy();
  const rebuilding = f.executor.rebuildRuntime();
  await blocked.entered;
  const during = await f.run();
  assert.equal(invocation(f.spawned[1]!.spec).base, old.base);
  blocked.resume(); await rebuilding;
  const next = await f.run(), fresh = invocation(f.spawned[2]!.spec);
  assert.notEqual(fresh.base, old.base);
  assert.throws(() => claimDirectory(admitDirectory(dirname(old.base))), isBusy);
  f.spawned[0]!.finish(); f.spawned[1]!.finish();
  await Promise.all([oldExecution.done, during.done]); await turn();
  const claim = claimDirectory(admitDirectory(dirname(old.base))); claim.close();
  assert.equal(pathExists(old.view), false);
  f.spawned[2]!.finish(); await next.done;
});

await test('observed A to B to A detaches the original work; an idle toggle keeps a ready pin', nativeOnly, async t => {
  const f = await executorFixture(t), blocked = f.holdCopy();
  const initial = f.run(); await blocked.entered;
  const obsolete = fs.readdirSync(join(f.cache, 'g'))[0]!;
  await f.select(join(f.source, 'BIN', 'bash.exe')); // An invalid B that must never start after A is observed again.
  const b = f.run();
  await f.select(f.request.gitBashPath);
  const a = f.run();
  blocked.resume();
  const executions = await Promise.all([initial, b, a]);
  assert.notEqual((await f.current()).generationId, obsolete);
  const selected = await f.current();
  await f.select('unobserved invalid selection'); await f.select(f.request.gitBashPath);
  executions.push(await f.run());
  assert.equal((await f.current()).generationId, selected.generationId);
  assert.ok(f.spawned.every(item => invocation(item.spec).base === invocation(f.spawned[0]!.spec).base));
  f.spawned.forEach(item => item.finish()); await Promise.all(executions.map(execution => execution.done));
});

await test('workspace overlap is rejected before confinement and does not invalidate readiness', nativeOnly, async t => {
  const f = await executorFixture(t);
  f.controls.confine = () => { throw new Error('confinement reached'); };
  await assert.rejects(f.run({ sandboxPolicy: { ...f.policy, workspaceRoot: f.source } }), /overlap/);
  assert.equal(pathExists(f.cache), false, 'an overlapping first command must leave the home untouched');
  await assert.rejects(f.run(), /confinement reached/);
  assert.ok((await f.current()).generationId);
  assert.equal(f.spawned.length, 0);
});

await test('a selection observed just after commit releases the stale pin without rewinding publication', nativeOnly, async t => {
  const f = await executorFixture(t), original = NativeHold.prototype.close;
  let changed: Promise<void> | undefined;
  const mock = t.mock.method(NativeHold.prototype, 'close', function (this: NativeHold) {
    original.call(this);
    if (!changed && this.path === f.cache + '.writer-lock' && pathExists(join(f.cache, 'current.json'))) {
      changed = f.select('invalid selection after commit');
    }
  });
  try {
    await assert.rejects(f.executor.rebuildRuntime(), /superseded/);
    await changed;
    assert.ok(changed, 'the factory must have committed before selection changed');
    const generation = join(f.cache, 'g', (await f.current()).generationId);
    const claim = claimDirectory(admitDirectory(generation)); claim.close();
    assert.equal(f.spawned.length, 0);
    assert.ok(pathExists(join(generation, 'r/usr/bin/bash.exe')));
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

await test('retiring preparation close failure blocks replacement setup and remains a disposal error', nativeOnly, async t => {
  const f = await executorFixture(t), blocked = f.holdCopy();
  const initial = f.run(); await blocked.entered;
  const original = NativeHold.prototype.close, failure = new Win32Error('CloseHandle', 6, 'fixture checked writer close failure');
  let injected = false;
  const mock = t.mock.method(NativeHold.prototype, 'close', function (this: NativeHold) {
    original.call(this); // Close the real fixture handle before injecting failure.
    if (!injected && this.path === f.cache + '.writer-lock') { injected = true; throw failure; }
  });
  const logged: unknown[][] = [];
  const log = t.mock.method(f.providerContext.logger, 'error', (...args: unknown[]) => { logged.push(args); });
  try {
    const rebuilding = f.executor.rebuildRuntime();
    const failures = Promise.all([initial, rebuilding].map(operation => assert.rejects(operation, error => error === failure || error instanceof AggregateError && error.errors.includes(failure))));
    blocked.resume(); await failures;
    assert.ok(injected);
    assert.equal(pathExists(join(f.cache, 'current.json')), false);
    assert.deepEqual(fs.readdirSync(join(f.cache, 'g')), []);
    await f.dispose();
    assert.ok(logged.flat().some(value => value instanceof AggregateError && /owned resources/.test(value.message)));
  } finally { mock.mock.restore(); log.mock.restore(); }
});

await test('an already rejected preparation retains its native close failure across rebuild and disposal', nativeOnly, async t => {
  const f = await executorFixture(t), original = NativeHold.prototype.close;
  const failure = new Win32Error('CloseHandle', 6, 'fixture settled writer close failure');
  let injected = false;
  const mock = t.mock.method(NativeHold.prototype, 'close', function (this: NativeHold) {
    original.call(this); // Do not leak a real fixture handle to simulate a fault.
    if (!injected && this.path === f.cache + '.writer-lock' && pathExists(join(f.cache, 'current.json'))) {
      injected = true; throw failure;
    }
  });
  const logged: unknown[][] = [];
  const log = t.mock.method(f.providerContext.logger, 'error', (...args: unknown[]) => { logged.push(args); });
  try {
    await assert.rejects(f.run(), error => error === failure);
    assert.ok(injected);
    const before = await f.current();
    await assert.rejects(f.executor.rebuildRuntime(), error => error instanceof AggregateError && error.errors.includes(failure));
    assert.equal((await f.current()).generationId, before.generationId);
    await f.dispose();
    assert.ok(logged.flat().some(value => value instanceof AggregateError && /owned resources/.test(value.message)));
  } finally { mock.mock.restore(); log.mock.restore(); }
});

await test('selection or cancellation during confinement prevents launch and releases the use', nativeOnly, async t => {
  for (const kind of ['selection', 'cancellation', 'argv'] as const) await t.test(kind, async t => {
    const f = await executorFixture(t), cancelled = new AbortController();
    f.controls.confine = async argv => {
      if (kind === 'selection') await f.select('invalid new selection');
      if (kind === 'cancellation') cancelled.abort(new Error('cancel during confinement'));
      return { argv: kind === 'argv' ? ['wrong-command'] : argv, enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] };
    };
    await assert.rejects(f.run({ signal: cancelled.signal }), kind === 'selection' ? /runtime changed/ : kind === 'cancellation' ? /cancel during/ : /Unexpected DSH shell argv/);
    assert.equal(f.spawned.length, 0);
    await f.dispose();
    await purgeRuntimeCache(f.cache);
  });
});

await test('same-selection rebuild during confinement rejects the old use and preserves fresh readiness', nativeOnly, async t => {
  const f = await executorFixture(t), confine = f.controls.confine;
  const selection = f.executor.config.gitBashPath.get();
  let previous = '';
  f.controls.confine = async argv => {
    previous = join(f.cache, 'g', (await f.current()).generationId);
    await f.executor.rebuildRuntime();
    assert.equal(f.executor.config.gitBashPath.get(), selection);
    assert.throws(() => claimDirectory(admitDirectory(previous)), isBusy, 'the unlaunched use still protects its retired generation');
    return confine(argv);
  };
  await assert.rejects(f.run(), { message: 'Git Bash runtime changed during command preparation.' });
  assert.equal(f.spawned.length, 0);
  const current = await f.current();
  assert.notEqual(current.generationId, basename(previous));
  const claim = claimDirectory(admitDirectory(previous)); claim.close();
  f.controls.confine = confine;
  const next = await f.run();
  assert.equal(invocation(f.spawned[0]!.spec).base, join(f.cache, 'g', current.generationId, 'r'));
  f.spawned[0]!.finish(); await next.done;
  await f.dispose();
  await purgeRuntimeCache(f.cache);
});

await test('disposal stops executions before waiting for cancelled setup and drains all references', nativeOnly, async t => {
  const f = await executorFixture(t), execution = await f.run(), blocked = f.holdCopy();
  const rebuilding = assert.rejects(f.executor.rebuildRuntime(), /superseded/);
  await blocked.entered;
  const disposing = f.dispose();
  await execution.done;
  assert.equal(f.spawned[0]!.spec.signal?.aborted, true);
  await assert.rejects(f.run(), /stopping/);
  await assert.rejects(f.executor.rebuildRuntime(), /stopping/);
  blocked.resume(); await rebuilding; await disposing;
  await purgeRuntimeCache(f.cache);
});

await test('full-access still receives a scoped view and keeps it through nonzero command settlement', nativeOnly, async t => {
  const f = await executorFixture(t);
  f.controls.confine = () => { throw new Error('full-access must not invoke confinement'); };
  const execution = await f.run({ sandboxPolicy: { ...f.policy, mode: 'danger-full-access' } });
  const launched = invocation(f.spawned[0]!.spec), selected = await f.current();
  assert.notEqual(launched.base, launched.view);
  assert.match(basename(launched.view), /^fa-[0-9a-f]{16}$/);
  assert.ok(pathExists(launched.view));
  f.spawned[0]!.finish(7);
  assert.equal((await execution.result()).exitCode, 7);
  await turn();
  assert.equal(pathExists(launched.view), false);
  assert.equal((await f.current()).generationId, selected.generationId);
  const next = await f.run({ sandboxPolicy: { ...f.policy, mode: 'danger-full-access' } });
  assert.equal(invocation(f.spawned[1]!.spec).base, launched.base);
  f.spawned[1]!.finish(); await next.done;
});

await test('target completion retains uses and disposal until DSH confirms the command range', nativeOnly, async t => {
  const entered = deferred<void>(), settled = deferred<boolean>();
  t.after(() => settled.resolve(true));
  const f = await executorFixture(t);
  f.controls.range = async () => { entered.resolve(); return settled.promise; };
  const execution = await f.run();
  const { view } = invocation(f.spawned[0]!.spec);
  f.spawned[0]!.finish();
  await entered.promise;
  let finished = false;
  void execution.done.then(() => { finished = true; });
  const disposing = f.dispose();
  await turn();
  assert.equal(finished, false);
  assert.equal(pathExists(view), true);
  await assert.rejects(purgeRuntimeCache(f.cache), isBusy);

  // This command-scoped adaptation must not change another consumer's handle.
  const unrelated = f.ctx.subprocess.spawn({ argv: ['unrelated'], cwd: f.workspace, graceMs: 1,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 0 }, stderr: { maxBytes: 0 } } });
  f.spawned.at(-1)!.finish(9);
  assert.equal((await unrelated.done).exitCode, 9);

  settled.resolve(true);
  await Promise.all([execution.done, disposing]);
  await purgeRuntimeCache(f.cache);
  assert.equal(pathExists(f.cache), false);
});

await test('range observation failure survives cancellation and retains the last native pin', nativeOnly, async t => {
  const f = await executorFixture(t), controller = new AbortController();
  const failure = new Error('fixture command range cannot be observed');
  const holds = new Set<NativeHold>(), information = NativeHold.prototype.information;
  const capture = t.mock.method(NativeHold.prototype, 'information', function (this: NativeHold) {
    if (dirname(this.path) === join(f.cache, 'g')) holds.add(this);
    return information.call(this);
  });
  const logged: unknown[][] = [];
  const log = t.mock.method(f.providerContext.logger, 'error', (...args: unknown[]) => { logged.push(args); });
  f.controls.range = async () => { throw failure; };
  try {
    const execution = await f.run({ signal: controller.signal });
    controller.abort(new Error('caller cancellation'));
    assert.equal((await execution.result()).aborted, true);
    await f.dispose();
    assert.ok(logged.flat().some(value => value instanceof AggregateError && value.errors.includes(failure)));
    await assert.rejects(purgeRuntimeCache(f.cache), isBusy);
    assert.ok(pathExists(invocation(f.spawned[0]!.spec).view));
  } finally {
    capture.mock.restore(); log.mock.restore();
    // Simulate the final host-process teardown only AFTER asserting retention.
    // A fake observation failure must not strand real fixture handles.
    for (const hold of holds) hold.close();
  }
});

await test('final environment uses DSH enumeration order, preserves tombstones and runner temp', nativeOnly, async t => {
  const f = await executorFixture(t), run = await f.run({
    env: { PATH: 'X:/first', Path: f.source + '/bin;X:/second', TeMp: 'original', TMP: undefined, KEEP: 'caller' } as unknown as ShellExecRequest['env'],
    dshEnv: { PATH: 'X:/last', GIt_ExeC_PAth: 'wrong', mSyS2_pAtH_tYpE: undefined, KEEP: undefined } as unknown as ShellExecRequest['dshEnv'],
  });
  const spec = f.spawned[0]!.spec, env = spec.env!, { view } = invocation(spec);
  assert.equal(env.PATH, [join(view, 'ucrt64/bin'), join(view, 'usr/bin'), 'X:/second'].join(';'));
  assert.equal(env.GIT_EXEC_PATH, join(view, 'ucrt64/libexec/git-core').replaceAll('\\', '/'));
  assert.equal(env.GIT_TEMPLATE_DIR, join(view, 'ucrt64/share/git-core/templates').replaceAll('\\', '/'));
  assert.equal(env.MSYS2_PATH_TYPE, 'inherit');
  assert.equal(env.TeMp, 'original');
  for (const name of ['TMP', 'KEEP']) assert.ok(Object.hasOwn(env, name) && env[name] === undefined);
  assert.ok(!Object.hasOwn(env, 'Path') && !Object.hasOwn(env, 'GIt_ExeC_PAth'));
  f.spawned[0]!.finish(); await run.done;
});

await test('native canonical workspace admission rejects overlap and changed runner arguments before spawn', nativeOnly, async t => {
  const f = await executorFixture(t);
  const alias = join(f.directory, 'workspace-alias');
  await fsp.symlink(f.workspace, alias, 'junction');
  const realpath = t.mock.method(fs.realpath, 'native');
  try {
    for (const workspaceRoot of [alias, f.workspace.toUpperCase(), f.workspace.replaceAll('\\', '/'), shortPath(f.workspace)]) {
      const before = realpath.mock.callCount(), ex = await f.run({ sandboxPolicy: { ...f.policy, workspaceRoot } });
      assert.equal(realpath.mock.callCount(), before + 1);
      f.spawned.at(-1)!.finish(); await ex.done;
    }
    for (const workspaceRoot of [f.cache, join(f.cache, 'g'), f.source, join(f.source, 'usr'), f.directory]) {
      await assert.rejects(f.run({ sandboxPolicy: { ...f.policy, workspaceRoot } }), /overlap/);
    }
    const valid = f.controls.confine;
    for (const [flag, value] of [['--workspace', f.directory], ['--mode', 'workspace-write'], ['--temp-write-sid', 'S-1-4-1-2-1']] as const) {
      f.controls.confine = async argv => {
        const result = await valid(argv), args = [...result.argv], index = args.indexOf(flag);
        if (index >= 0) args[index + 1] = value;
        else args.splice(args.indexOf('--'), 0, flag, value);
        return { ...result, argv: args };
      };
      await assert.rejects(f.run(), /Unexpected DSH shell argv/);
    }
    assert.equal(f.spawned.length, 4);
  } finally { realpath.mock.restore(); }
});

await test('a reused view checks its target without scanning publication or freshness', nativeOnly, async t => {
  const f = await executorFixture(t);
  const policy = { ...f.policy, sessionId: 'reused' as SandboxExecutionPolicy['sessionId'] };
  const run = () => f.run({ sandboxPolicy: policy });
  const first = await run(), view = invocation(f.spawned[0]!.spec).view;
  f.spawned[0]!.finish(); await first.done;
  const read = fs.readlinkSync, observed: string[] = [];
  t.mock.method(fs, 'readlinkSync', ((...args: Parameters<typeof read>) => {
    observed.push(String(args[0])); return read(...args);
  }) as typeof read);
  t.mock.method(fs, 'readdirSync', () => { throw Error('ready command scanned the tree'); });
  t.mock.method(NativeHold.prototype, 'readBytes', () => { throw Error('ready command read selector or DLL bytes'); });
  const info = NativeHold.prototype.information;
  t.mock.method(NativeHold.prototype, 'information', function (this: NativeHold) {
    assert.ok(!this.path.startsWith(f.source), 'ready command probed source'); return info.call(this);
  });
  syncBuiltinESMExports();
  try {
    const next = await run();
    assert.equal(view, invocation(f.spawned[1]!.spec).view);
    assert.ok(observed.includes(toNamespacedPath(view)));
    f.spawned[1]!.finish(); await next.done;
    await fsp.unlink(view); await fsp.symlink(f.workspace, view, 'junction');
    await assert.rejects(run(), /Unexpected runtime junction/);
    assert.equal(f.spawned.length, 2);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

await test('native workspace resolution can fail or outlive cancellation without granting or spawning', nativeOnly, async t => {
  const f = await executorFixture(t); await f.executor.rebuildRuntime();
  const entered = deferred<void>(), resume = deferred<void>(), original = fs.realpath.native;
  const failure = Object.assign(Error('fixture native realpath'), { code: 'EACCES' });
  let delayed = false, granted = false;
  const confine = f.controls.confine;
  f.controls.confine = async argv => { granted = true; return confine(argv); };
  const hook = t.mock.method(fs.realpath, 'native', ((path, cb) => {
    if (!delayed) { cb(failure); return; }
    entered.resolve();
    void resume.promise.then(() => original(path, cb));
  }) as (path: string, cb: (error: NodeJS.ErrnoException | null, path?: string) => void) => void);
  try {
    await assert.rejects(f.run(), error => error === failure);
    delayed = true;
    const controller = new AbortController(), operation = assert.rejects(f.run({ signal: controller.signal }), /left realm/);
    await entered.promise; controller.abort(Error('left realm')); resume.resolve(); await operation;
    assert.equal(granted, false); assert.equal(f.spawned.length, 0);
  } finally { resume.resolve(); hook.mock.restore(); }
});

await test('paired session flags bind exactly the temp capability returned by DSH', nativeOnly, async t => {
  const f = await executorFixture(t), workspace = f.workspace, temp = f.directory;
  const mode = 'workspace-write', policy = { mode, workspaceRoot: workspace, sessionId: 'one' as SandboxExecutionPolicy['sessionId'] } as const;
  const valid = ['--write-sid', workspaceWriteSid(workspace), '--temp-write-sid', tempWriteSid(temp)];
  let flags = valid;
  f.controls.confine = async argv => ({ argv: ['runner', '--workspace', workspace, '--temp', temp, '--mode', mode, ...flags, '--', ...argv],
    enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] });
  const ex = await f.run({ sandboxPolicy: policy });
  assert.ok(basename(invocation(f.spawned[0]!.spec).view).startsWith('ww-' + valid[3]!.slice(6, -2) + '-'));
  f.spawned[0]!.finish(); await ex.done;
  for (const malformed of [[], valid.slice(0, 2), valid.slice(2), [...valid.slice(0, 3), tempWriteSid(f.workspace)]]) {
    flags = malformed; await assert.rejects(f.run({ sandboxPolicy: policy }), /Unexpected DSH shell argv/);
  }
  assert.equal(f.spawned.length, 1);
});

await test('failed manual payload write and close preserve ready commands and permit explicit retry', nativeOnly, async t => {
  const f = await executorFixture(t), active = await f.run(), before = await f.current();
  const write = Error('payload write failed'), close = Error('payload close failed'), closeFd = fs.closeSync;
  let fd: number | undefined;
  t.mock.method(fs, 'writeFileSync', (target: number) => { fd = target; throw write; });
  t.mock.method(fs, 'closeSync', (target: number) => { closeFd(target); if (fd === target) throw close; });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.executor.rebuildRuntime(), error => error instanceof AggregateError && error.errors[0] === write && error.errors[1] === close);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.deepEqual(await f.current(), before);
  const preserved = await f.run();
  assert.equal(invocation(f.spawned[0]!.spec).base, invocation(f.spawned[1]!.spec).base);
  await f.executor.rebuildRuntime();
  assert.notEqual((await f.current()).generationId, before.generationId);
  f.spawned.forEach(child => child.finish()); await Promise.all([active.done, preserved.done]);
});

await test('a pre-spawn release failure is retained once through rebuild and disposal', nativeOnly, async t => {
  const f = await executorFixture(t); await f.executor.rebuildRuntime();
  const failure = new Win32Error('CloseHandle', 6, 'owned view');
  const original = NativeHold.prototype.close;
  let closing = false, calls = 0;
  f.controls.spawnError = new Error('provider rejected spawn');
  const hook = t.mock.method(NativeHold.prototype, 'deleteEntry', function (this: NativeHold) {
    if (basename(this.path).startsWith('ro-')) closing = true;
  });
  const close = t.mock.method(NativeHold.prototype, 'close', function (this: NativeHold) {
    original.call(this);
    if (closing && basename(this.path).startsWith('ro-')) { calls++; throw failure; }
  });
  const logged: unknown[][] = [];
  t.mock.method(f.providerContext.logger, 'error', (...args: unknown[]) => { logged.push(args); });
  try {
    await assert.rejects(f.run(), error => error === failure);
    await assert.rejects(f.executor.rebuildRuntime(), error => error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === failure);
    await f.dispose(); assert.equal(calls, 1);
    assert.ok(logged.flat().some(e => e instanceof AggregateError && e.errors.length === 1 && e.errors[0] === failure));
  } finally { close.mock.restore(); hook.mock.restore(); }
});

await test('a rejected child remains owned after Shell reports killed and an unconfirmed wait', nativeOnly, async t => {
  const f = await executorFixture(t);
  f.controls.providerError = new Error('provider unavailable');
  let waits = 0;
  f.controls.range = async () => ++waits > 1;
  const ex = await f.run(); await assert.rejects(ex.result(), /settlement/);
  assert.equal(ex.status, 'killed');
  t.mock.method(f.providerContext.logger, 'error', () => {});
  await f.dispose(); assert.equal(f.controls.terminations, 1); assert.equal(waits, 2);
  await purgeRuntimeCache(f.cache);
});

await test('native DSH Bash execution across all modes', nativeOnly, async t => {
  const f = await executionFixture(t);
  if (!f) return;
  const { default: BuiltExecutor } = await import(new URL('../lib/index.js', import.meta.url).href) as { default: typeof GitBashExecutor };
  const pin = await f.prepare(); // Cold preparation is outside command deadlines.
  const warmTimes: number[] = [];
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now(), warm = await f.prepare();
    warmTimes.push(performance.now() - start);
    await warm.release();
  }
  t.diagnostic(`Real Git freshness and DLL warm admission (5 samples, ms): ${warmTimes.map(ms => ms.toFixed(2)).join(', ')}; no latency guarantee.`);
  const executorFiber = f.ctx.plugin(BuiltExecutor, { gitBashPath: f.request.gitBashPath, graceMs: 300 });
  await executorFiber;
  const executor = f.ctx.shell as GitBashExecutor;
  const run = async (mode: SandboxExecutionPolicy['mode'], command: string, sessionId: string | null = mode) => {
    const execution = await executor.execute(executor.resolve({ command, workdir: f.workspace, timeoutMs: 30000,
      env: { gIt_ExEc_PaTh: 'must-not-leak', gIt_TeMpLaTe_DiR: 'must-not-leak' },
      onExpiry: 'kill', sandboxPolicy: { mode, workspaceRoot: f.workspace, sessionId: (sessionId ?? undefined) as SandboxExecutionPolicy['sessionId'] } }));
    const result = await execution.result();
    await execution.done;
    return result;
  };
  const generation = join(f.cache, 'g', (JSON.parse(await fsp.readFile(join(f.cache, 'current.json'), 'utf8')) as { generationId: string }).generationId);
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  const bashPath = (path: string) => quote(path.replaceAll('\\', '/'));
  const arg = 'shell arg 漢 Ω', script = join(f.workspace, '含 空格 Ω.sh');
  await fsp.writeFile(script, '#!/bin/sh\nprintf "%s" "$1"\n');
  await fsp.writeFile(join(f.workspace, 'input.txt'), 'native-grep\n');
  const driver = join(f.workspace, 'native.cjs');
  await fsp.writeFile(driver, `
    const { spawnSync } = require('node:child_process'), [program, stdio, ...args] = process.argv.slice(2);
    const result = spawnSync(program, args, { stdio, encoding: 'utf8' });
    if (result.error) { console.error(result.error.code); process.exit(1); }
    if (result.stdout) process.stdout.write(result.stdout);
    console.log('NATIVE STATUS ' + result.status);
    process.exit(result.status & 255);
  `);
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
    await t.test(mode, async () => {
      const result = await run(mode, "printf 'pipeline\\n' | cat; bash -c 'printf child'; printf '%s\\n' \"$(printf fork)\"; git --version; printf '%s\\n' \"$GIT_EXEC_PATH\" \"$GIT_TEMPLATE_DIR\"");
      assert.equal(result.exitCode, 0, result.stderr.text);
      assert.match(result.stdout.text, /pipeline/);
      assert.match(result.stdout.text, /childfork/);
      assert.match(result.stdout.text, /git version/);
      assert.match(result.stdout.text, /\/v\/.*\/libexec\/git-core/);
      assert.match(result.stdout.text, /\/v\/.*\/share\/git-core\/templates/);
      assert.doesNotMatch(result.stdout.text, /must-not-leak/);
      const full = mode === 'danger-full-access';
      const view = join(generation, 'v', fs.readdirSync(join(generation, 'v'))
        .find(name => name.startsWith(full ? 'fa-' : mode === 'read-only' ? 'ro-' : 'ww-'))!);
      const msys = join(view, 'usr/bin/bash.exe'), wrapper = join(view, 'bin/bash.exe');
      const inherited = 'node.exe ./native.cjs ';
      const rows: Array<[string, number, RegExp]> = [
        [`git -c ${quote('alias.probe=!f() { printf "%s" "$1"; }; f')} probe ${quote(arg)}`, 0, /shell arg 漢 Ω/],
        [inherited + 'grep.exe inherit native-grep input.txt', 0, /native-grep/],
        [inherited + 'grep.exe pipe native-grep input.txt', full ? 0 : 1, full ? /native-grep/ : /EPERM/],
        [bashPath(script) + ' ' + quote(arg), 0, /shell arg 漢 Ω/],
        ['PATH=.:$PATH ' + quote(basename(script)) + ' ' + quote(arg), 0, /shell arg 漢 Ω/],
        [`printf '{"gate":4}' | /usr/bin/core_perl/json_pp -json_opt canonical`, 0, /"gate"\s*:\s*4/],
        ['/usr/bin/vendor_perl/lwp-request -v', 255, /lwp-request version/],
        ["/usr/libexec/lessecho -a 'two words'", 0, /two words/],
        ["/usr/lib/awk/grcat && echo group-reader-ok", 0, /group-reader-ok/],
        [bashPath(msys) + ' -c "echo private-entry"', 0, /private-entry/],
        [bashPath(join(f.source, 'usr/bin/bash.exe')) + ' -c "echo source-entry"', 0, /source-entry/],
        [bashPath(join(f.source, 'bin/bash.exe')) + ' -c "echo wrapper"', full ? 0 : 127, full ? /wrapper/ : /0xC0000022|Win32 error 5|permission denied|initializ/i],
        [inherited + bashPath(wrapper) + ' inherit -c "echo wrapper"', full ? 0 : 66, full ? /wrapper/ : /NATIVE STATUS (?:3221225794|-1073741502)/],
        [`sh -c 'shopt -qo posix && echo posix'`, 0, /posix/],
        [`exec -a custom bash -c 'printf "%s" "$0"'`, 0, /custom/],
        [bashPath(shortPath(script)) + ' ' + quote(arg), 0, /shell arg 漢 Ω/],
        [quote(toNamespacedPath(msys)) + ' -c true', 127, /No such file|not found/i],
      ];
      for (const [command, status, expected] of rows) {
        const output = await run(mode, command), detail = output.stdout.text + output.stderr.text;
        assert.equal(output.exitCode, status, command + '\n' + detail);
        assert.match(detail, expected, command);
      }
      // Gate 4 supplies these spellings to DSH's native spawn, before any MSYS parent exists.
      const provider = f.ctx.subprocess, original = provider.spawn.bind(provider);
      for (const [entry, expectedStatus] of [[shortPath(msys), 0], [toNamespacedPath(msys), 0], [wrapper, full ? 0 : 0xc0000142]] as const) {
        const hook = t.mock.method(provider, 'spawn', (spec: SubprocessSpawnSpec) => {
          assert.equal(spec.argv.at(-5), msys);
          return original({ ...spec, argv: [...spec.argv.slice(0, -5), entry, ...spec.argv.slice(-4)] });
        });
        try {
          const result = await run(mode, 'echo native-argv');
          assert.equal(result.exitCode, expectedStatus, entry + '\n' + result.stderr.text);
          if (expectedStatus === 0) assert.match(result.stdout.text, /native-argv/);
        } finally { hook.mock.restore(); }
      }
      const chain = await run(mode, 'for i in {1..4}; do ( sh -c "printf f" ) || exit; done; env -i PATH="$PATH" sh -c "echo clean"', null);
      assert.equal(chain.exitCode, 0, chain.stderr.text); assert.match(chain.stdout.text, /ffffclean/);
      const written = await run(mode, `printf write > '${mode}.txt'`);
      assert.equal(written.exitCode === 0, mode !== 'read-only', written.stderr.text);
      if (mode === 'read-only') {
        assert.equal(written.exitCode, 1, written.stderr.text);
        assert.match(written.stderr.text, /permission denied|operation not permitted|read-only file system/i);
      }
      assert.equal(fs.existsSync(join(f.workspace, `${mode}.txt`)), mode !== 'read-only');
      const outside = join(f.directory, `${mode}.txt`).replaceAll('\\', '/');
      const out = await run(mode, `printf outside > '${outside}'`);
      assert.equal(out.exitCode === 0, mode === 'danger-full-access', out.stderr.text);
      if (mode !== 'danger-full-access') {
        assert.equal(out.exitCode, 1, out.stderr.text);
        assert.match(out.stderr.text, /permission denied|operation not permitted|read-only file system/i);
      }
      assert.equal(fs.existsSync(outside), mode === 'danger-full-access');
    });
  }
  await t.test('the stock runner rejects a substituted workspace write SID before Bash starts', async () => {
    const provider = f.ctx.subprocess, original = provider.spawn.bind(provider);
    const hook = t.mock.method(provider, 'spawn', (spec: SubprocessSpawnSpec) => {
      const argv = [...spec.argv], flag = argv.indexOf('--write-sid'); assert.ok(flag > 0);
      argv[flag + 1] = workspaceWriteSid(f.directory);
      return original({ ...spec, argv });
    });
    try {
      const ex = await executor.execute(executor.resolve({ command: 'echo MUST_NOT_START', workdir: f.workspace, timeoutMs: 30000,
        sandboxPolicy: { mode: 'workspace-write', workspaceRoot: f.workspace, sessionId: 'rejected-sid' as SandboxExecutionPolicy['sessionId'] } }));
      await assert.rejects(ex.result(), { name: 'SandboxUnavailableError' });
      assert.match(ex.observed.stderr.readFrom(0).text, /write-sid does not match/);
      assert.doesNotMatch(ex.observed.stdout.readFrom(0).text, /MUST_NOT_START/);
    } finally { hook.mock.restore(); }
  });

  await t.test('private images and four callers observe the session IPC policy through the executor', async () => {
    const mode = 'workspace-write', session = 'ipc-owner' as SandboxExecutionPolicy['sessionId'];
    const holder = await executor.execute(executor.resolve({ workdir: f.workspace, timeoutMs: 30000,
      command: msysHolderCommand.replace('IFS= read -r release', 'sleep 30'), sandboxPolicy: { mode, workspaceRoot: f.workspace, sessionId: session } }));
    try {
      let out = '';
      while (!out.includes('READY') && holder.status === 'running') { await delay(20); out = holder.observed.stdout.readFrom(0).text; }
      const pid = /HOLDER (\d+) (\d+)/.exec(out), ns = /NAMESPACE (msys-\S+)/.exec(out);
      assert.ok(pid && ns, out);
      const images = observeMsysImages(Number(pid[2]), []);
      assert.deepEqual(images.map(image => basename(image.path).toLowerCase()).sort(), ['dsh-msys-compat.dll', 'msys-2.0.dll']);
      const runtimePath = join(generation, 'r/usr/bin');
      for (const image of images) assert.equal(fs.realpathSync.native(image.path), join(runtimePath, basename(image.path)));
      assert.ok(ns[1]!.endsWith('-' + expectedMsysKey(dirname(dirname(dirname(images[0]!.path))))));
      const object = '\\BaseNamedObjects\\' + ns[1] + '\\cygpid.' + pid[1];
      const probe = 'import {sectionAccess} from ' + JSON.stringify(new URL('./fixtures.ts', import.meta.url).href)
        + '; const name=' + JSON.stringify(object) + '; console.log(JSON.stringify([sectionAccess(name,false),sectionAccess(name,true)]));';
      for (const [caller, sessionId, write] of [[mode, session, true], [mode, 'peer', false], ['read-only', 'ro', false], ['danger-full-access', 'fa', true]] as const) {
        const callerScript = join(f.workspace, 'section-access.mjs');
        await fsp.writeFile(callerScript, probe);
        const access = await run(caller, 'node.exe ' + bashPath(callerScript), sessionId);
        assert.equal(access.exitCode, 0, access.stderr.text);
        assert.deepEqual(JSON.parse(access.stdout.text), [0, write ? 0 : 0xc0000022]);
      }
    } finally { holder.kill(); await holder.done; }
  });

  await t.test('workspace-write starts iconv and grep in pipelines, substitutions and the final command', async () => {
    await fsp.writeFile(join(f.workspace, 'icons.bin'), Buffer.from('Adobe Apps', 'utf16le'));
    const search = String.raw`grep -a -c -P 'A\x00d\x00o\x00b\x00e\x00' icons.bin`;
    const result = await run('workspace-write', [
      'set -eo pipefail',
      'for i in {1..8}; do',
      '  MSYS_NO_PATHCONV=1 cmd.exe /d /c "echo marker" | iconv -f GBK -t UTF-8 | grep -o marker',
      `  count=$(${search})`, '  echo "$count"',
      'done',
      search,
    ].join('\n'));
    assert.equal(result.exitCode, 0, result.stderr.text);
    assert.equal(result.stderr.text, '');
    assert.equal(result.stdout.text.replaceAll('\r\n', '\n'), 'marker\n1\n'.repeat(8) + '1\n');
  });
  await t.test('root exit drains descendants; cancellation and executor disposal join active families', async () => {
    await pin.release(); // The executor must now protect the generation on its own.
    const lingering = await run('danger-full-access', 'sleep 0.2 & exit 7');
    assert.equal(lingering.exitCode, 7, lingering.stderr.text);
    assert.equal(lingering.timedOut, false, 'root exit must apply the bounded family grace');
    const start = (signal?: AbortSignal) => executor.execute(executor.resolve({
      command: 'node.exe -e "console.log(\'PID:\'+process.pid);setInterval(()=>{},1000)"', workdir: f.workspace,
      timeoutMs: 15000, onExpiry: 'kill', signal,
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: f.workspace },
    }));
    const ready = async (execution: ShellExecution) => {
      let output = '';
      const until = performance.now() + 10000;
      while (performance.now() < until) {
        output += execution.readOutput().delta;
        const match = /PID:(\d+)/.exec(output);
        assert.equal(execution.status, 'running', output);
        if (match) {
          const pid = Number(match[1]);
          process.kill(pid, 0); // Readiness must refer to a currently live child.
          return pid;
        }
        await delay(20);
      }
      throw new Error(`Private native descendant did not start: ${output}`);
    };
    const controller = new AbortController(), cancelled = await start(controller.signal);
    const cancelledPid = await ready(cancelled);
    controller.abort(new Error('native fixture cancellation'));
    assert.equal((await cancelled.result()).aborted, true);
    await cancelled.done;
    assert.throws(() => process.kill(cancelledPid, 0), { code: 'ESRCH' });
    const [one, two] = await Promise.all([start(), start()]);
    const pids = await Promise.all([ready(one), ready(two)]);
    for (const pid of pids) process.kill(pid, 0);
    await executorFiber.dispose();
    await Promise.all([one.done, two.done]);
    for (const result of await Promise.all([one.result(), two.result()])) {
      assert.equal(result.aborted, true); assert.equal(result.timedOut, false);
    }
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    // Real executor and external pin retirement leave no held generation/view.
    await purgeRuntimeCache(f.cache);
    assert.equal(pathExists(f.cache), false);
  });
});
