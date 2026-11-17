import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type { ShellExecRequest, ShellExecution } from '@deepseek-ai/dsh-shell';
import type Subprocess from '@deepseek-ai/dsh-subprocess';
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import { runPrivateBash, type PrivateFamilyExit } from '../src/debugger/process-family.ts';
import { Win32Error } from '@deepseek-ai/dsh-win32-process';
import GitBashExecutor from '../src/index.ts';
import { buildRuntimeEnvironment } from '../src/runtime/git-installation.ts';
import { admitDirectory, claimDirectory, createDirectory, createJunction, isBusy, NativeHold, pathExists } from '../src/runtime/ntfs-filesystem.ts';
import { purgeRuntimeCache } from '../src/runtime/runtime-cache.ts';
import { executionFixture, nativeOnly, runtimeFixture } from './fixtures.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function executorFixture(t: TestContext) {
  let dispose = async () => {};
  const unblock = new Set<() => void>();
  t.after(async () => { for (const resume of unblock) resume(); await dispose(); });
  const fixture = await runtimeFixture(t, 'ucrt64', '.git-bash-on-win');
  const ctx = new Context();
  const spawned: Array<{ spec: SubprocessSpawnSpec; finish: (exitCode?: number) => void }> = [];
  const policy: SandboxExecutionPolicy = { mode: 'read-only', workspaceRoot: fixture.workspace };
  const controls = {
    setup: (() => { throw new Error('Unexpected setup subprocess in executor fixture.'); }) as Subprocess['spawn'],
    range: async (outcome: Promise<SubprocessOutcome>) => { await outcome; return true; },
    confine: async (argv: string[]) => ({ argv: ['fixture-runner', '--', ...argv], enforcement: 'partial' as const, denialSignatures: [], runnerFailureRules: [] }),
  };
  const provider = {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      assert.equal(this, provider, 'setup spawn must retain its provider binding');
      if (spec.argv.some(arg => basename(arg) === 'elevation-broker.js')) return controls.setup(spec);
      const outcome = deferred<SubprocessOutcome>();
      const finish = (exitCode = 0) => outcome.resolve({ exitCode, signal: null });
      const abort = () => finish(1);
      spec.signal?.addEventListener('abort', abort, { once: true });
      void outcome.promise.then(() => spec.signal?.removeEventListener('abort', abort));
      const reader = { readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }) };
      spawned.push({ spec, finish });
      return {
        stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
        collected: { stdout: reader, stderr: reader }, done: outcome.promise,
        terminate: abort, waitForExit: () => controls.range(outcome.promise),
      };
    },
  };
  ctx.provide('profileContext', { dir: fixture.directory });
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
    holdInventory() {
      const blocked = holdInventory(t, fixture.source);
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

/** Hold one issued inventory read, so cancellation must drain real cache work. */
function holdInventory(t: TestContext, source: string) {
  const entered = deferred<void>(), resume = deferred<void>(), original = fsp.readdir;
  let first = true;
  const mock = t.mock.method(fsp, 'readdir', (async (...args: Parameters<typeof fsp.readdir>) => {
    if (first && String(args[0]).startsWith(source)) {
      first = false; entered.resolve(); await resume.promise;
    }
    return original(...args);
  }) as typeof fsp.readdir);
  syncBuiltinESMExports();
  t.after(() => { resume.resolve(); mock.mock.restore(); syncBuiltinESMExports(); });
  return { entered: entered.promise, resume: () => resume.resolve() };
}

function invocation(spec: SubprocessSpawnSpec) {
  const start = spec.argv.findIndex(arg => basename(arg) === 'bash-launcher.js');
  assert.ok(start > 0);
  const [base, view, source, layout, mode, encoded] = spec.argv.slice(start + 1);
  return { base: base!, view: view!, source, layout, mode, command: Buffer.from(encoded!, 'base64').toString() };
}

await test('executor activation is lazy; concurrent commands share readiness and admit scope before confinement', nativeOnly, async t => {
  const f = await executorFixture(t);
  await turn();
  assert.equal(pathExists(f.cache), false);
  const blocked = f.holdInventory();
  const first = f.run(), second = f.run();
  await blocked.entered;
  assert.equal(f.spawned.length, 0);
  f.controls.confine = async argv => {
    const id = (await f.current()).generationId;
    const views = fs.readdirSync(join(f.cache, 'generations', id, 'views'), { recursive: true });
    assert.ok(views.length >= 2, 'a view must already exist before confinement');
    return { argv: ['fixture-runner', '--', ...argv], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] };
  };
  blocked.resume();
  const [a, b] = await Promise.all([first, second]);
  const [one, two] = f.spawned.map(item => invocation(item.spec));
  assert.equal(one!.base, two!.base);
  assert.notEqual(one!.view, two!.view);
  assert.equal(one!.layout, 'ucrt64'); assert.equal(one!.source, f.source);
  assert.equal(one!.command, 'fixture command');
  assert.deepEqual(f.spawned[0]!.spec.argv.slice(0, 2), ['fixture-runner', '--']);
  assert.equal(fs.readdirSync(join(f.cache, 'generations')).length, 1);
  f.spawned.forEach(item => item.finish());
  await Promise.all([a.done, b.done]);
});

await test('caller cancellation and native timeout abandon waits without cancelling shared preparation', nativeOnly, async t => {
  const f = await executorFixture(t), blocked = f.holdInventory(), cancelled = new AbortController();
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
  const f = await executorFixture(t), blocked = f.holdInventory();
  const displaced = f.run();
  await blocked.entered;
  const obsolete = fs.readdirSync(join(f.cache, 'generations'))[0]!;
  const rebuilding = f.executor.rebuildRuntime();
  const joining = f.run();
  await assert.rejects(f.executor.rebuildRuntime(), /busy/);
  await turn();
  assert.deepEqual(fs.readdirSync(join(f.cache, 'generations')), [obsolete]);
  blocked.resume();
  await rebuilding;
  const [a, b] = await Promise.all([displaced, joining]);
  const current = (await f.current()).generationId;
  assert.notEqual(current, obsolete);
  assert.equal(pathExists(join(f.cache, 'generations', obsolete)), false);
  assert.ok(f.spawned.every(item => invocation(item.spec).base === join(f.cache, 'generations', current, 'base')));
  f.spawned.forEach(item => item.finish()); await Promise.all([a.done, b.done]);
});

await test('failed readiness is retained until an explicit rebuild', nativeOnly, async t => {
  const f = await executorFixture(t), original = fs.linkSync;
  const failure = new Error('fixture cold link failure');
  const mock = t.mock.method(fs, 'linkSync', () => { throw failure; }); syncBuiltinESMExports();
  try { await assert.rejects(f.run(), error => error === failure); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(fs.linkSync, original);
  await assert.rejects(f.run(), error => error === failure);
  assert.equal(f.spawned.length, 0);
  await f.executor.rebuildRuntime();
  const execution = await f.run(); f.spawned[0]!.finish(); await execution.done;
});

await test('a failed shared rebuild gives displaced and new waiters the same retained failure', nativeOnly, async t => {
  const f = await executorFixture(t), blocked = f.holdInventory();
  const first = f.run(); await blocked.entered;
  const failure = new Error('fixture rebuild link failure');
  const mock = t.mock.method(fs, 'linkSync', () => { throw failure; }); syncBuiltinESMExports();
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
  const old = invocation(f.spawned[0]!.spec), blocked = f.holdInventory();
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

await test('UAC denial during rebuilding preserves a ready pin and its current selection', nativeOnly, async t => {
  const f = await executorFixture(t), existing = await f.run();
  const before = await f.current(), original = fs.linkSync;
  const mock = t.mock.method(fs, 'linkSync', (source: fs.PathLike, target: fs.PathLike) => {
    if (basename(String(target)) === '.probe') throw Object.assign(new Error('fixture link denial'), { code: 'EPERM' });
    original(source, target);
  }); syncBuiltinESMExports();
  f.controls.setup = () => ({
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {},
    done: Promise.resolve({ exitCode: 1, signal: null }), terminate() {}, async waitForExit() { return true; },
  });
  try { await assert.rejects(f.executor.rebuildRuntime(), /Elevated setup failed/); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal((await f.current()).generationId, before.generationId);
  const subsequent = await f.run();
  assert.equal(invocation(f.spawned[0]!.spec).base, invocation(f.spawned[1]!.spec).base);
  f.spawned.forEach(item => item.finish()); await Promise.all([existing.done, subsequent.done]);
});

await test('observed A to B to A detaches the original work; an idle toggle keeps a ready pin', nativeOnly, async t => {
  const f = await executorFixture(t), blocked = f.holdInventory();
  const initial = f.run(); await blocked.entered;
  const obsolete = fs.readdirSync(join(f.cache, 'generations'))[0]!;
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
  const selected = await f.current();
  await assert.rejects(f.run(), /confinement reached/);
  assert.equal((await f.current()).generationId, selected.generationId);
  assert.equal(f.spawned.length, 0);
});

await test('selection during lease admission unwinds the old use and follows canonical-source readiness', nativeOnly, async t => {
  const f = await executorFixture(t), entered = deferred<void>(), resume = deferred<void>(), original = fsp.realpath;
  let first = true;
  const mock = t.mock.method(fsp, 'realpath', (async (...args: Parameters<typeof fsp.realpath>) => {
    if (first && String(args[0]) === f.workspace) { first = false; entered.resolve(); await resume.promise; }
    return original(...args);
  }) as typeof fsp.realpath); syncBuiltinESMExports();
  try {
    const acquiring = f.run(); await entered.promise;
    const before = await f.current();
    await f.select(f.request.gitBashPath!.replaceAll('\\', '/'));
    const other = await f.run();
    resume.resolve(); const originalCommand = await acquiring;
    assert.equal((await f.current()).generationId, before.generationId, 'a spelling-only selection change uses normal warm admission');
    const [one, two] = f.spawned.map(item => invocation(item.spec));
    assert.equal(one!.base, two!.base);
    assert.equal(dirname(one!.view), dirname(two!.view), 'both commands must use the replacement pin namespace');
    f.spawned.forEach(item => item.finish()); await Promise.all([other.done, originalCommand.done]);
  } finally { resume.resolve(); mock.mock.restore(); syncBuiltinESMExports(); }
});

await test('a selection observed just after commit releases the stale pin without rewinding publication', nativeOnly, async t => {
  const f = await executorFixture(t), original = NativeHold.prototype.close;
  let changed: Promise<void> | undefined;
  const mock = t.mock.method(NativeHold.prototype, 'close', function (this: NativeHold) {
    original.call(this);
    if (!changed && this.path === join(f.cache, '.writer-lock') && pathExists(join(f.cache, 'current.json'))) {
      changed = f.select('invalid selection after commit');
    }
  });
  try {
    await assert.rejects(f.executor.rebuildRuntime(), /superseded/);
    await changed;
    assert.ok(changed, 'the factory must have committed before selection changed');
    const generation = join(f.cache, 'generations', (await f.current()).generationId);
    const claim = claimDirectory(admitDirectory(generation)); claim.close();
    assert.equal(f.spawned.length, 0);
    assert.ok(pathExists(join(generation, 'base/usr/bin/bash.exe')));
  } finally { mock.mock.restore(); }
});

await test('retiring preparation close failure blocks replacement setup and remains a disposal error', nativeOnly, async t => {
  const f = await executorFixture(t), blocked = f.holdInventory();
  const initial = f.run(); await blocked.entered;
  const original = NativeHold.prototype.close, failure = new Win32Error('CloseHandle', 6, 'fixture checked writer close failure');
  let injected = false;
  const mock = t.mock.method(NativeHold.prototype, 'close', function (this: NativeHold) {
    original.call(this); // Close the real fixture handle before injecting failure.
    if (!injected && this.path === join(f.cache, '.writer-lock')) { injected = true; throw failure; }
  });
  const logged: unknown[][] = [];
  const log = t.mock.method(f.providerContext.logger, 'error', (...args: unknown[]) => { logged.push(args); });
  try {
    const rebuilding = f.executor.rebuildRuntime();
    const failures = Promise.all([initial, rebuilding].map(operation => assert.rejects(operation, error => error === failure)));
    blocked.resume(); await failures;
    assert.ok(injected);
    assert.equal(pathExists(join(f.cache, 'current.json')), false);
    assert.deepEqual(fs.readdirSync(join(f.cache, 'generations')), []);
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
    if (!injected && this.path === join(f.cache, '.writer-lock') && pathExists(join(f.cache, 'current.json'))) {
      injected = true; throw failure;
    }
  });
  const logged: unknown[][] = [];
  const log = t.mock.method(f.providerContext.logger, 'error', (...args: unknown[]) => { logged.push(args); });
  try {
    await assert.rejects(f.run(), error => error === failure);
    assert.ok(injected);
    const before = await f.current();
    await assert.rejects(f.executor.rebuildRuntime(), error => error === failure);
    assert.equal((await f.current()).generationId, before.generationId);
    await f.dispose();
    assert.ok(logged.flat().some(value => value instanceof AggregateError && /owned resources/.test(value.message)));
  } finally { mock.mock.restore(); log.mock.restore(); }
});

await test('a rejected broker outcome with an empty range permits explicit rebuilding and clean disposal', nativeOnly, async t => {
  const f = await executorFixture(t), original = fs.linkSync;
  const failure = new Error('fixture broker target failed to start');
  const mock = t.mock.method(fs, 'linkSync', (source: fs.PathLike, target: fs.PathLike) => {
    if (basename(String(target)) === '.probe') throw Object.assign(new Error('fixture probe denial'), { code: 'EPERM' });
    original(source, target);
  }); syncBuiltinESMExports();
  f.controls.setup = () => ({
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {},
    done: Promise.reject(failure), terminate() {},
    async waitForExit() { return true; },
  });
  const logged: unknown[][] = [];
  const log = t.mock.method(f.providerContext.logger, 'error', (...args: unknown[]) => { logged.push(args); });
  try {
    await assert.rejects(f.run(), error => error === failure);
    assert.equal(f.spawned.length, 0);
    assert.equal(pathExists(join(f.cache, 'current.json')), false);
    mock.mock.restore(); syncBuiltinESMExports();
    await f.executor.rebuildRuntime();
    const execution = await f.run(); f.spawned[0]!.finish(); await execution.done;
    await f.dispose();
    assert.deepEqual(logged, []);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); log.mock.restore(); }
});

await test('an already rejected broker shutdown remains a local resource failure at rebuild and disposal', nativeOnly, async t => {
  const f = await executorFixture(t), original = fs.linkSync;
  const failure = new Error('fixture broker range cannot be observed');
  const mock = t.mock.method(fs, 'linkSync', (source: fs.PathLike, target: fs.PathLike) => {
    if (basename(String(target)) === '.probe') throw Object.assign(new Error('fixture probe denial'), { code: 'EPERM' });
    original(source, target);
  }); syncBuiltinESMExports();
  let launches = 0;
  f.controls.setup = () => {
    launches++;
    return {
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {},
      done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {},
      async waitForExit() { throw failure; },
    };
  };
  const logged: unknown[][] = [];
  const log = t.mock.method(f.providerContext.logger, 'error', (...args: unknown[]) => { logged.push(args); });
  try {
    await assert.rejects(f.run(), AggregateError);
    await assert.rejects(f.executor.rebuildRuntime(), AggregateError);
    assert.equal(launches, 1, 'failed local shutdown must block another setup');
    assert.equal(pathExists(join(f.cache, 'current.json')), false);
    await f.dispose();
    assert.ok(logged.flat().some(value => value instanceof AggregateError && /owned resources/.test(value.message)));
  } finally { mock.mock.restore(); syncBuiltinESMExports(); log.mock.restore(); }
});

await test('ordinary source IO failure during supersession drains without poisoning shared rebuilding', nativeOnly, async t => {
  const f = await executorFixture(t), entered = deferred<void>(), resume = deferred<void>(), original = fsp.readdir;
  let first = true;
  const mock = t.mock.method(fsp, 'readdir', (async (...args: Parameters<typeof fsp.readdir>) => {
    if (first && String(args[0]).startsWith(f.source)) {
      first = false; entered.resolve(); await resume.promise;
      throw Object.assign(new Error('fixture source read failed after cancellation'), { code: 'EIO' });
    }
    return original(...args);
  }) as typeof fsp.readdir); syncBuiltinESMExports();
  const logged: unknown[][] = [];
  const log = t.mock.method(f.providerContext.logger, 'error', (...args: unknown[]) => { logged.push(args); });
  try {
    const initial = f.run(); await entered.promise;
    const rebuilding = f.executor.rebuildRuntime(), joined = f.run();
    // Observe all three immediately, even when the regression rejects early.
    const results = Promise.all([initial, rebuilding, joined]);
    resume.resolve();
    const [firstCommand, , nextCommand] = await results;
    assert.equal(f.spawned.length, 2);
    assert.equal(invocation(f.spawned[0]!.spec).base, invocation(f.spawned[1]!.spec).base);
    f.spawned.forEach(item => item.finish());
    await Promise.all([firstCommand!.done, nextCommand!.done]);
    await f.executor.rebuildRuntime();
    await f.dispose();
    assert.deepEqual(logged, []);
  } finally { resume.resolve(); mock.mock.restore(); syncBuiltinESMExports(); log.mock.restore(); }
});

await test('native cleanup failure inside lease admission remains owned after current or cancelled acquisition', nativeOnly, async t => {
  for (const cancelled of [false, true]) await t.test(cancelled ? 'cancelled and retired' : 'current', async t => {
    const f = await executorFixture(t);
    await f.executor.rebuildRuntime();
    const generation = join(f.cache, 'generations', (await f.current()).generationId);
    const failure = new Win32Error('CloseHandle', 6, 'fixture lease admission close failure');
    const originalClose = NativeHold.prototype.close, originalRealpath = fsp.realpath;
    const entered = deferred<void>(), resume = deferred<void>(), caller = new AbortController();
    let injected = false;
    const close = t.mock.method(NativeHold.prototype, 'close', function (this: NativeHold) {
      originalClose.call(this);
      if (!injected && this.path === join(generation, 'views')) { injected = true; throw failure; }
    });
    const realpath = t.mock.method(fsp, 'realpath', (async (...args: Parameters<typeof fsp.realpath>) => {
      if (String(args[0]) === f.workspace) { entered.resolve(); await resume.promise; }
      return originalRealpath(...args);
    }) as typeof fsp.realpath); syncBuiltinESMExports();
    const logged: unknown[][] = [];
    const log = t.mock.method(f.providerContext.logger, 'error', (...args: unknown[]) => { logged.push(args); });
    try {
      const acquisition = assert.rejects(f.run({ signal: caller.signal }), error => cancelled ? error === caller.signal.reason : error === failure);
      await entered.promise;
      if (cancelled) {
        await f.select(f.request.gitBashPath!.replaceAll('\\', '/'));
        const stop = new Error('fixture cancelled observer');
        await assert.rejects(f.run({ signal: AbortSignal.abort(stop) }), error => error === stop);
        caller.abort(new Error('fixture caller cancelled'));
      }
      resume.resolve(); await acquisition;
      assert.ok(injected);
      await assert.rejects(f.executor.rebuildRuntime(), /Previous runtime cleanup failed/);
      assert.equal(f.spawned.length, 0);
      await f.dispose();
      assert.ok(logged.flat().some(value => value instanceof AggregateError && /owned resources/.test(value.message)));
    } finally { resume.resolve(); close.mock.restore(); realpath.mock.restore(); syncBuiltinESMExports(); log.mock.restore(); }
  });
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
    previous = join(f.cache, 'generations', (await f.current()).generationId);
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
  assert.equal(invocation(f.spawned[0]!.spec).base, join(f.cache, 'generations', current.generationId, 'base'));
  f.spawned[0]!.finish(); await next.done;
  await f.dispose();
  await purgeRuntimeCache(f.cache);
});

await test('disposal stops executions before waiting for cancelled setup and drains all references', nativeOnly, async t => {
  const f = await executorFixture(t), execution = await f.run(), blocked = f.holdInventory();
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
  assert.equal(launched.mode, 'danger-full-access');
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

await test('runtime environment uses only the admitted layout and recorded source strings', nativeOnly, async t => {
  const f = await runtimeFixture(t, 'mingw64'), pin = await f.prepare();
  const use = await pin.lease({ mode: 'danger-full-access', workspaceRoot: f.workspace }, new AbortController().signal);
  try {
    await fsp.rename(f.source, join(f.directory, 'source-gone'));
    const ambient = { Path: `${join(f.source, 'usr/bin')};"${join(f.source, 'mingw64/bin')}";C:\\Windows\\System32`, KEEP: 'unchanged' };
    const before = { ...ambient };
    const env = buildRuntimeEnvironment(use.installationRoot, use.sourceRoot, use.layout, ambient);
    assert.deepEqual(ambient, before);
    assert.equal(env.PATH, [join(use.installationRoot, 'mingw64/bin'), join(use.installationRoot, 'usr/bin'), 'C:\\Windows\\System32'].join(';'));
    assert.equal(env.GIT_EXEC_PATH, join(use.installationRoot, 'mingw64/libexec/git-core').replaceAll('\\', '/'));
    assert.equal(env.GIT_TEMPLATE_DIR, join(use.installationRoot, 'mingw64/share/git-core/templates').replaceAll('\\', '/'));
    assert.equal(env.MSYS2_PATH_TYPE, 'inherit');
  } finally { await use.release(); await pin.release(); }
});

await test('child admission requires a strict descendant of the generation views directory', nativeOnly, async t => {
  for (const kind of ['ordinary', 'junction']) await t.test(kind, async t => {
    const f = await runtimeFixture(t), pin = await f.prepare();
    const generation = admitDirectory(join(f.cache, 'generations', (await f.current()).generationId));
    const base = admitDirectory(join(generation.path, 'base')), views = join(generation.path, 'views');
    if (kind === 'ordinary') createDirectory(generation, 'views');
    else createJunction(generation, 'views', base);
    // Invalid view paths must fail before executable admission. Removing only
    // this cache name also prevents a regressed guard from launching the fixture.
    await fsp.unlink(join(base.path, 'usr/bin/bash.exe'));
    for (const installationRoot of [views, views.toUpperCase(), views + '\\', join(generation.path, 'views-other/scope'), f.workspace]) {
      await assert.rejects(runPrivateBash({
        baseRoot: base.path, installationRoot, cwd: f.workspace, command: 'echo forbidden',
        environment: {}, compatibility: { grantSid: undefined }, graceMs: 300,
      }), /The MSYS view must be generation-owned\./);
    }
    await pin.release();
    await purgeRuntimeCache(f.cache);
  });
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
  t.diagnostic(`Real Git metadata/anchor warm admission (5 samples, ms): ${warmTimes.map(ms => ms.toFixed(2)).join(', ')}; no latency guarantee.`);
  const executorFiber = f.ctx.plugin(BuiltExecutor, { gitBashPath: f.request.gitBashPath, graceMs: 300 });
  await executorFiber;
  const executor = f.ctx.shell as GitBashExecutor;
  const run = async (mode: SandboxExecutionPolicy['mode'], command: string, sessionId = mode) => {
    const execution = await executor.execute(executor.resolve({ command, workdir: f.workspace, timeoutMs: 30000,
      env: { gIt_ExEc_PaTh: 'must-not-leak', gIt_TeMpLaTe_DiR: 'must-not-leak' },
      onExpiry: 'kill', sandboxPolicy: { mode, workspaceRoot: f.workspace, sessionId: sessionId as SandboxExecutionPolicy['sessionId'] } }));
    const result = await execution.result();
    await execution.done;
    return result;
  };
  // This test entry reports the public debugger result after actual DSH
  // confinement. The production launcher has no diagnostic stdout protocol.
  const observer = join(f.directory, 'observe.mjs');
  await fsp.writeFile(observer, `
    import { runPrivateBash } from ${JSON.stringify(new URL('../lib/debugger/process-family.js', import.meta.url).href)};
    import { inheritedCompatibility } from ${JSON.stringify(new URL('../lib/debugger/native-debug.js', import.meta.url).href)};
    import { debugApi, readMemory } from ${JSON.stringify(new URL('../lib/debugger/native-debug.js', import.meta.url).href)};
    import { sectionAccess } from ${JSON.stringify(new URL('./fixtures.ts', import.meta.url).href)};
    import { copyFileSync, renameSync } from 'node:fs';
    import { join } from 'node:path';
    import { buildRuntimeEnvironment } from ${JSON.stringify(new URL('../lib/runtime/git-installation.js', import.meta.url).href)};
    const request = JSON.parse(process.argv[2]);
    let reportFailure;
    try {
      if (request.section) {
        inheritedCompatibility(request.mode);
        console.log('@@ACCESS@@' + JSON.stringify({ read: sectionAccess(request.section, false), write: sectionAccess(request.section, true) }));
      } else {
      const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
      Object.assign(environment, buildRuntimeEnvironment(request.installationRoot, request.sourceRoot, request.layout, process.env));
      if (request.observeNamespace) {
        const api = debugApi(), original = api.queryObject;
        const seen = new Set();
        api.queryObject = (handle, kind, buffer, size, needed) => {
          const status = original(handle, kind, buffer, size, needed);
          if (status >= 0 && kind === 1) {
            const name = readMemory(api.currentProcess(), buffer.readBigUInt64LE(8), buffer.readUInt16LE()).toString('utf16le');
            if (name.toLowerCase().startsWith('\\\\basenamedobjects\\\\msys-') && !seen.has(name)) {
              seen.add(name); console.log('@@NAMESPACE@@' + name);
            }
          }
          return status;
        };
      }
      if (request.cleanupSequence) {
        const api = debugApi(), original = { ...api };
        const failure = new Error('fixture initial Job admission failed');
        const closeFailure = new Error('fixture cleanup image close failed');
        const trace = { admissions: 0, images: [], continued: [], rootCreated: false, rootExited: false, rootImageClosed: false, emptyChecks: 0 };
        const events = [], images = new Map();
        let rootPid, rootTid, rootImage, kind, injected;
        api.inJob = (process, job, member) => {
          if (job === null) return original.inJob(process, job, member);
          trace.admissions++; throw failure;
        };
        api.waitDebug = (data, milliseconds) => {
          if (events.length) {
            const [eventKind, pid, tid, file = 0n] = events.shift();
            data.fill(0); data.writeUInt32LE(eventKind); data.writeUInt32LE(pid, 4); data.writeUInt32LE(tid, 8);
            if (eventKind === 3 || eventKind === 6) data.writeBigUInt64LE(file, 16);
            if (eventKind === 3) { data.writeBigUInt64LE(0x100000001n, 24); data.writeBigUInt64LE(0x100000002n, 32); }
            if (eventKind === 2) data.writeBigUInt64LE(0x100000003n, 16);
            injected = [eventKind, pid, tid];
            return 1;
          }
          const result = original.waitDebug(data, milliseconds);
          if (result) {
            kind = data.readUInt32LE();
            if (kind === 3 && rootPid === undefined) {
              rootPid = data.readUInt32LE(4); rootTid = data.readUInt32LE(8); rootImage = data.readBigUInt64LE(16);
              // Real duplicate image handles; synthetic process/thread handles are borrowed sentinels.
              const files = [6, 3].map(eventKind => {
                const output = Buffer.alloc(8), self = api.currentProcess();
                if (!api.duplicateHandle(self, rootImage, self, output, 0, 0, 2)) throw new Error('fixture image duplication failed');
                const handle = output.readBigUInt64LE(); images.set(handle, eventKind); return handle;
              });
              events.push([6, rootPid, rootTid, files[0]], [3, rootPid + 1, rootTid + 1, files[1]],
                [2, rootPid + 1, rootTid + 2], [4, rootPid + 1, rootTid + 2], [5, rootPid + 1, rootTid + 1]);
            }
          }
          return result;
        };
        api.continueDebug = (pid, tid, disposition) => {
          if (injected) {
            if (pid !== injected[1] || tid !== injected[2] || disposition !== 0x00010002) throw new Error('fixture cleanup continuation mismatch');
            trace.continued.push(injected[0]); injected = undefined; return 1;
          }
          const result = original.continueDebug(pid, tid, disposition);
          if (result && pid === rootPid && kind === 3) trace.rootCreated = true;
          if (result && pid === rootPid && kind === 5) trace.rootExited = true;
          return result;
        };
        api.closeHandle = handle => {
          if ([0x100000001n, 0x100000002n, 0x100000003n].includes(handle)) throw new Error('fixture borrowed handle was closed');
          const result = original.closeHandle(handle);
          if (result && handle === rootImage) trace.rootImageClosed = true;
          if (result && images.has(handle)) {
            const eventKind = images.get(handle); images.delete(handle); trace.images.push(eventKind);
            if (eventKind === 6) throw closeFailure; // Actual test handle is closed before reporting the fault.
          }
          return result;
        };
        api.queryInformationJobObject = (...args) => {
          const result = original.queryInformationJobObject(...args);
          if (result && args[1] === 1 && trace.rootExited && args[2].readUInt32LE(40) === 0) trace.emptyChecks++;
          return result;
        };
        reportFailure = error => console.log('@@DRAIN@@' + JSON.stringify({ ...trace,
          errors: error.errors.map(value => value === failure ? 'admission' : value === closeFailure ? 'image-close' : String(value)) }));
      }
      if (request.fault) {
        // Race the real launch after its local DLL identity was retained. This
        // changes fixture paths only; all debug events and hooks remain real.
        if (request.alias) environment.PATH = request.alias + ';' + environment.PATH;
        const api = debugApi(), original = api.createProcessW;
        api.createProcessW = (...args) => {
          api.createProcessW = original;
          const target = join(request.baseRoot, 'usr/bin/msys-2.0.dll');
          renameSync(target, target + '.held');
          if (request.fault === 'identity') copyFileSync(join(request.sourceRoot, 'usr/bin/msys-2.0.dll'), target);
          return original(...args);
        };
      }
      const result = await runPrivateBash({ ...request, cwd: process.cwd(), environment, compatibility: inheritedCompatibility(request.mode), graceMs: 300 });
      console.log('@@FAMILY@@' + JSON.stringify(result));
      process.exitCode = result.exitCode;
      }
    } catch (error) { reportFailure?.(error); console.error(error.message); process.exitCode = 127; }
  `);
  const startCaptured = async (argv: string[], mode: SandboxExecutionPolicy['mode'], session = 'observed') => {
    const signal = AbortSignal.timeout(15000);
    const policy: SandboxExecutionPolicy = { mode, workspaceRoot: f.workspace, sessionId: session as SandboxExecutionPolicy['sessionId'] };
    if (mode !== 'danger-full-access') argv = [...(await f.ctx.sandbox.confine(argv, { ...policy, mode }, signal)).argv];
    return f.ctx.subprocess.spawn({ argv, cwd: f.workspace, signal, graceMs: 300,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 8192 } } });
  };
  const captured = async (argv: string[], mode: SandboxExecutionPolicy['mode'], session?: string) => {
    const child = await startCaptured(argv, mode, session);
    try {
      const outcome = await child.done;
      assert.equal(await child.waitForExit(AbortSignal.timeout(3000)), true, 'DSH managed range must settle');
      return { ...outcome, stdout: child.collected.stdout!.readFrom(0).text, stderr: child.collected.stderr!.readFrom(0).text };
    } finally {
      child.terminate();
      assert.equal(await child.waitForExit(AbortSignal.timeout(3000)), true, 'fixture must join every child');
    }
  };
  const observe = async (mode: SandboxExecutionPolicy['mode'], session: string, command = 'bash -c true; printf x | cat') => {
    const use = await pin.lease({ mode, workspaceRoot: f.workspace, sessionId: session as SandboxExecutionPolicy['sessionId'] }, new AbortController().signal);
    try {
      const result = await captured([process.execPath, observer, JSON.stringify({ ...use, mode, command })], mode, session);
      assert.equal(result.exitCode, 0, result.stderr);
      const match = /@@FAMILY@@([^\r\n]+)/.exec(result.stdout);
      assert.ok(match, result.stdout);
      return JSON.parse(match[1]!) as PrivateFamilyExit;
    } finally { await use.release(); }
  };
  const namespaces = new Set<string>();
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
    await t.test(mode, async () => {
      const result = await run(mode, "printf 'pipeline\\n' | cat; bash -c 'printf child'; printf '%s\\n' \"$(printf fork)\"; git --version; printf '%s\\n' \"$GIT_EXEC_PATH\" \"$GIT_TEMPLATE_DIR\"");
      assert.equal(result.exitCode, 0, result.stderr.text);
      assert.match(result.stdout.text, /pipeline/);
      assert.match(result.stdout.text, /childfork/);
      assert.match(result.stdout.text, /git version/);
      assert.match(result.stdout.text, /\/views\/.*\/libexec\/git-core/);
      assert.match(result.stdout.text, /\/views\/.*\/share\/git-core\/templates/);
      assert.doesNotMatch(result.stdout.text, /must-not-leak/);
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
      const [first, second] = await Promise.all([observe(mode, 'first'), observe(mode, 'second')]);
      assert.notEqual(first.installationKey, second.installationKey);
      assert.equal((await observe(mode, 'first')).installationKey, first.installationKey);
      namespaces.add(first.installationKey); namespaces.add(second.installationKey);
      for (const result of [first, second]) {
        if (mode === 'danger-full-access') assert.deepEqual([result.repaired, result.defaultDaclAdjusted, result.mappingsAdjusted], [0, 0, 0]);
        else assert.ok(result.repaired > 0 && result.defaultDaclAdjusted > 0 && result.mappingsAdjusted > 0, JSON.stringify(result));
      }
    });
  }
  assert.equal(namespaces.size, 6, 'all modes and scoped views need distinct namespaces');
  await t.test('failed initial admission drains unregistered cleanup events', async () => {
    const use = await pin.lease({ mode: 'danger-full-access', workspaceRoot: f.workspace }, new AbortController().signal);
    try {
      const result = await captured([process.execPath, observer, JSON.stringify({ ...use, mode: 'danger-full-access',
        cleanupSequence: true, command: 'echo forbidden' })], 'danger-full-access');
      assert.equal(result.exitCode, 127, result.stderr);
      assert.doesNotMatch(result.stdout, /forbidden/);
      const match = /@@DRAIN@@([^\r\n]+)/.exec(result.stdout);
      assert.ok(match, result.stdout + result.stderr);
      const { emptyChecks, ...observed } = JSON.parse(match[1]!);
      assert.deepEqual(observed, { admissions: 1, images: [6, 3], continued: [6, 3, 2, 4, 5],
        rootCreated: true, rootExited: true, rootImageClosed: true, errors: ['admission', 'image-close'] });
      assert.ok(emptyChecks >= 2, 'root settlement and final cleanup must both confirm the actual Job is empty');
    } finally { await use.release(); }
  });
  await t.test('actual MSYS mapping grants separate workspace sessions while preserving peer reads', async () => {
    const use = await pin.lease({ mode: 'workspace-write', workspaceRoot: f.workspace,
      sessionId: 'ipc-owner' as SandboxExecutionPolicy['sessionId'] }, new AbortController().signal);
    let owner: SubprocessHandle | undefined;
    let ownerOutcome: Promise<PromiseSettledResult<SubprocessOutcome>[]> | undefined;
    try {
      owner = await startCaptured([process.execPath, observer, JSON.stringify({ ...use, mode: 'workspace-write', observeNamespace: true,
        command: 'printf "@@PID@@%s\\n" "$$"; sleep 60' })], 'workspace-write', 'ipc-owner');
      ownerOutcome = Promise.allSettled([owner.done]);
      let namespace: string | undefined, pid: string | undefined;
      const until = performance.now() + 10000;
      while (performance.now() < until) {
        const output = owner.collected.stdout!.readFrom(0).text;
        namespace = /@@NAMESPACE@@([^\r\n]+)/.exec(output)?.[1];
        pid = /@@PID@@(\d+)/.exec(output)?.[1];
        if (namespace && pid) break;
        await delay(20);
      }
      assert.ok(namespace && pid, owner.collected.stdout!.readFrom(0).text + owner.collected.stderr!.readFrom(0).text);
      const section = `${namespace}\\cygpid.${pid}`;
      for (const [mode, session, write] of [
        ['workspace-write', 'ipc-owner', 0], ['workspace-write', 'ipc-peer', 0xc0000022],
        ['read-only', 'ipc-read', 0xc0000022], ['danger-full-access', 'ipc-full', 0],
      ] as const) {
        const result = await captured([process.execPath, observer, JSON.stringify({ mode, section })], mode, session);
        assert.equal(result.exitCode, 0, result.stderr);
        const match = /@@ACCESS@@([^\r\n]+)/.exec(result.stdout);
        assert.ok(match, result.stdout);
        assert.deepEqual(JSON.parse(match[1]!), { read: 0, write }, `${mode}/${session}: ${result.stdout}`);
      }
    } finally {
      if (owner) {
        try { owner.terminate(); }
        finally {
          assert.equal(await owner.waitForExit(AbortSignal.timeout(3000)), true);
          await use.release();
        }
        const [outcome] = await ownerOutcome!;
        assert.equal(outcome!.status, 'fulfilled', outcome!.status === 'rejected' ? String(outcome!.reason) : '');
      } else { await use.release(); }
    }
  });
  await t.test('child admission refuses redirected views and external MSYS descendants', async () => {
    const use = await pin.lease({ mode: 'danger-full-access', workspaceRoot: f.workspace }, new AbortController().signal);
    try {
      await fsp.rmdir(use.installationRoot);
      await fsp.symlink(f.source, use.installationRoot, 'junction');
      const redirected = await captured([process.execPath, observer, JSON.stringify({ ...use, mode: 'danger-full-access', command: 'echo forbidden' })], 'danger-full-access');
      assert.equal(redirected.exitCode, 127); assert.match(redirected.stderr, /junction/);
      assert.doesNotMatch(redirected.stdout, /forbidden/);
    } finally { await use.release(); }
    const original = join(f.source, 'usr/bin/bash.exe').replaceAll('\\', '/');
    const external = await run('danger-full-access', `'${original}' -c 'echo forbidden'`);
    assert.equal(external.exitCode, 127); assert.match(external.stderr.text, /outside the admitted base/);
    assert.doesNotMatch(external.stdout.text, /forbidden/);
    const native = await run('danger-full-access', 'node.exe -p "process.platform"');
    assert.equal(native.exitCode, 0, native.stderr.text); assert.match(native.stdout.text, /win32/);
    const native32 = await run('danger-full-access', `MSYS2_ARG_CONV_EXCL='*' '${process.env.SystemRoot!.replaceAll('\\', '/')}/SysWOW64/cmd.exe' /d /c echo native32`);
    assert.equal(native32.exitCode, 0, native32.stderr.text); assert.match(native32.stdout.text, /native32/);
  });
  await t.test('launcher validates invocation, grace period and inherited policy', async () => {
    const launcher = fileURLToPath(new URL('../lib/bash-launcher.js', import.meta.url));
    const invalid = spawnSync(process.execPath, [launcher], { encoding: 'utf8', timeout: 10000 });
    assert.equal(invalid.status, 127); assert.match(invalid.stderr, /Invalid private/);
    const use = await pin.lease({ mode: 'read-only', workspaceRoot: f.workspace }, new AbortController().signal);
    try {
      const args = [process.execPath, launcher, use.baseRoot, use.installationRoot, use.sourceRoot, use.layout, 'read-only', Buffer.from('echo forbidden').toString('base64'), '300'];
      const wrongToken = await captured(args, 'danger-full-access');
      assert.equal(wrongToken.exitCode, 127); assert.match(wrongToken.stderr, /restrictions are missing/);
      assert.doesNotMatch(wrongToken.stdout, /forbidden/);
      args[6] = 'danger-full-access';
      const wrongMode = await captured(args, 'read-only');
      assert.equal(wrongMode.exitCode, 127); assert.match(wrongMode.stderr, /restricted inherited token/);
      args[6] = 'read-only';
      args[7] = Buffer.from('printf fractional-grace').toString('base64');
      args[8] = '300.5';
      const fractional = await captured(args, 'read-only');
      assert.equal(fractional.exitCode, 0, fractional.stderr);
      assert.equal(fractional.stdout, 'fractional-grace');
      for (const grace of ['NaN', 'Infinity', '0', '-1', '2147483647.5']) {
        args[8] = grace;
        const invalid = await captured(args, 'read-only');
        assert.equal(invalid.exitCode, 127, grace + ': ' + invalid.stderr);
        assert.match(invalid.stderr, /Invalid DSH process grace period/, grace);
        assert.equal(invalid.stdout, '', grace);
      }
    } finally { await use.release(); }
  });
  await t.test('actual loaded MSYS identity and loader path are independently required', async () => {
    const use = await pin.lease({ mode: 'danger-full-access', workspaceRoot: f.workspace }, new AbortController().signal);
    const target = join(use.baseRoot, 'usr/bin/msys-2.0.dll'), held = target + '.held';
    const alias = join(f.directory, 'foreign-dll');
    await fsp.mkdir(alias);
    await fsp.link(target, join(alias, 'msys-2.0.dll'));
    try {
      for (const fault of ['identity', 'loader-path']) {
        try {
          const result = await captured([process.execPath, observer, JSON.stringify({ ...use, mode: 'danger-full-access', fault, alias, command: 'echo forbidden' })], 'danger-full-access');
          assert.equal(result.exitCode, 127, result.stderr);
          assert.match(result.stderr, fault === 'identity' ? /module identity differs/ : /loader path is outside/);
          assert.doesNotMatch(result.stdout, /forbidden/);
        } finally {
          if (fs.existsSync(held)) {
            if (fs.existsSync(target)) await fsp.unlink(target);
            await fsp.rename(held, target);
          }
        }
      }
    } finally {
      await fsp.unlink(join(alias, 'msys-2.0.dll'));
      await use.release();
    }
  });
  await t.test('an admitted pin executes after its recorded source pathname disappears', async () => {
    const retired = join(f.directory, 'retired-source');
    await fsp.rename(f.source, retired);
    try {
      const result = await run('read-only', 'git --version');
      assert.equal(result.exitCode, 0, result.stderr.text); assert.match(result.stdout.text, /git version/);
    } finally { await fsp.rename(retired, f.source); }
  });
  await t.test('root exit drains descendants; cancellation and executor disposal join active families', async () => {
    await pin.release(); // The executor must now protect the generation on its own.
    const lingering = await run('danger-full-access', 'sleep 60 & exit 7');
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
    if (dirname(this.path) === join(f.cache, 'generations')) holds.add(this);
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
