import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate as turn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type { ShellExecRequest, ShellExecSpec } from '@deepseek-ai/dsh-shell';
import type Subprocess from '@deepseek-ai/dsh-subprocess';
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import GitBashExecutor from '../src/index.ts';
import { buildRuntimeEnvironment } from '../src/runtime/git-installation.ts';
import { admitDirectory, claimDirectory, isBusy, NativeHold, pathExists } from '../src/runtime/ntfs-filesystem.ts';
import { purgeRuntimeCache } from '../src/runtime/runtime-cache.ts';
import { nativeOnly, runtimeFixture } from './fixtures.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// Exercise DSH's actual deferred confinement/deadline machinery. Production's
// public execute gate stays closed until Phase 5 supplies the private launcher.
class ExecutorSeam extends GitBashExecutor {
  override execute(spec: ShellExecSpec) { return SandboxBashExecutor.prototype.execute.call(this, spec); }
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
        terminate: abort, async waitForExit() { await outcome.promise; return true; },
      };
    },
  };
  ctx.provide('profileContext', { dir: fixture.directory });
  ctx.provide('subprocess', provider);
  ctx.provide('sandboxPolicy', { defaultMode: policy.mode, resolve: () => policy });
  ctx.provide('sandbox', { confine: (argv: string[]) => controls.confine(argv) });
  class FixtureLoader extends Loader {
    override import() { return ExecutorSeam; }
    override commit() {} // No settings file or personal profile.
  }
  await ctx.plugin(FixtureLoader);
  const options = { id: 'phase4-executor', name: 'fixture-executor', config: { gitBashPath: fixture.request.gitBashPath } };
  await ctx.loader.root.update([options]);
  await ctx.loader.await();
  const executor = ctx.shell as ExecutorSeam;
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
  const original = NativeHold.prototype.close, failure = new Error('fixture checked writer close failure');
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

await test('selection or cancellation during confinement prevents launch and releases the use', nativeOnly, async t => {
  for (const kind of ['selection', 'cancellation', 'argv'] as const) await t.test(kind, async t => {
    const f = await executorFixture(t), cancelled = new AbortController();
    f.controls.confine = async argv => {
      if (kind === 'selection') await f.select('invalid new selection');
      if (kind === 'cancellation') cancelled.abort(new Error('cancel during confinement'));
      return { argv: kind === 'argv' ? ['wrong-command'] : argv, enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] };
    };
    await assert.rejects(f.run({ signal: cancelled.signal }), kind === 'selection' ? /selection changed/ : kind === 'cancellation' ? /cancel during/ : /Unexpected DSH shell argv/);
    assert.equal(f.spawned.length, 0);
    await f.dispose();
    await purgeRuntimeCache(f.cache);
  });
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
