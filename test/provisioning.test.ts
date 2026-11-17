import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs, { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import koffi from 'koffi';
import { loadWin32ProcessBindings, Win32Error, type NativePtr } from '@deepseek-ai/dsh-win32-process';
import type Subprocess from '@deepseek-ai/dsh-subprocess';
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess';
import { localSpawn, nativeOnly, runtimeFixture } from './fixtures.ts';
import { prepareRuntime, purgeRuntimeCache, type GenerationPin } from '../src/runtime/runtime-cache.ts';
import {
  admitDirectory, children, createSetupLease, isBusy, isMissing, NativeHold, openExclusiveMetadata, openOrdinaryFile, pathExists, pinDirectory,
  requireActiveLease, unlinkEntry,
} from '../src/runtime/ntfs-filesystem.ts';
import { decodeElevationPlan } from '../src/setup/provision-runtime.ts';
import { runLinkHelper } from '../src/setup/link-helper.ts';
import { runElevationBroker } from '../src/setup/elevation-broker.ts';

const signal = () => new AbortController().signal;
const root = fileURLToPath(new URL('..', import.meta.url));
const helperEntry = join(root, 'lib/setup/link-helper.js');
const brokerEntry = join(root, 'lib/setup/elevation-broker.js');
const success: SubprocessOutcome = { exitCode: 0, signal: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** Outcome and range are deliberately independent in the supervision tests. */
function brokerHandle(done: Promise<SubprocessOutcome>, overrides: Partial<SubprocessHandle> = {}): SubprocessHandle {
  return {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {}, done,
    terminate() {}, async waitForExit() { await done.catch(() => {}); return true; }, ...overrides,
  };
}

function replaceLinks(t: TestContext, action: typeof fs.linkSync) {
  const mock = t.mock.method(fs, 'linkSync', action);
  syncBuiltinESMExports();
  return () => { mock.mock.restore(); syncBuiltinESMExports(); };
}

function denyProbe(t: TestContext) {
  const link = fs.linkSync;
  return replaceLinks(t, (source, target) => {
    if (basename(String(target)) === '.probe') throw Object.assign(new Error('fixture probe denial'), { code: 'EPERM' });
    link(source, target);
  });
}

await test('local probe is removed before inventory and creates no elevation controls', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), readdir = fsp.readdir;
  let inventoried = false;
  const mock = t.mock.method(fsp, 'readdir', (async (...args: Parameters<typeof fsp.readdir>) => {
    if (String(args[0]).startsWith(fixture.source)) {
      const ids = readdirSync(join(fixture.cache, 'generations'));
      assert.equal(ids.length, 1);
      assert.deepEqual(readdirSync(join(fixture.cache, 'generations', ids[0]!)), ['base']);
      inventoried = true;
    }
    return readdir(...args);
  }) as typeof fsp.readdir);
  syncBuiltinESMExports();
  try { const pin = await fixture.prepare(); await pin.release(); assert.ok(inventoried); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

await test('probe denial chooses independent helper inventory and waits for DSH range settlement', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), restore = denyProbe(t);
  const linked = deferred<void>(), range = deferred<boolean>();
  let started = false, generation = '', baseId = 0n;
  const readdir = fsp.readdir;
  const mock = t.mock.method(fsp, 'readdir', (async (...args: Parameters<typeof fsp.readdir>) => {
    if (String(args[0]).startsWith(fixture.source)) {
      assert.ok(started, 'the controller must not inventory before UAC');
      assert.throws(() => unlinkEntry(admitDirectory(generation), 'plan.json'), isBusy);
    }
    return readdir(...args);
  }) as typeof fsp.readdir);
  syncBuiltinESMExports();
  const spawn: Subprocess['spawn'] = spec => {
    started = true;
    const planPath = spec.argv[2]!;
    generation = dirname(planPath);
    const plan = decodeElevationPlan(JSON.parse(readFileSync(planPath, 'utf8')));
    assert.equal('files' in plan, false);
    assert.deepEqual(readdirSync(plan.baseRoot), []);
    assert.equal(pathExists(join(generation, '.probe')), false);
    baseId = fs.statSync(plan.baseRoot, { bigint: true }).ino;
    const done = runLinkHelper(planPath).then(() => { linked.resolve(); return success; });
    return brokerHandle(done, { waitForExit: () => range.promise });
  };
  try {
    const preparation = prepareRuntime({ ...fixture.request, spawn }, signal());
    await linked.promise;
    assert.equal(pathExists(join(fixture.cache, 'current.json')), false);
    assert.ok(pathExists(join(generation, '.setup-owner')));
    range.resolve(true);
    const pin = await preparation;
    try {
      assert.equal(fs.statSync(join(generation, 'base'), { bigint: true }).ino, baseId);
      assert.deepEqual(readdirSync(generation), ['base']);
      assert.equal(fs.statSync(join(generation, 'base/usr/bin/bash.exe')).ino, fs.statSync(join(fixture.source, 'usr/bin/bash.exe')).ino);
    } finally { await pin.release(); }
  } finally { range.resolve(true); restore(); mock.mock.restore(); syncBuiltinESMExports(); }
});

await test('probe non-permission, structural, read-only and cleanup failures never request UAC', nativeOnly, async t => {
  for (const kind of ['io', 'source-directory', 'read-only', 'probe-cleanup'] as const) await t.test(kind, async t => {
    const fixture = await runtimeFixture(t), bash = join(fixture.source, 'usr/bin/bash.exe');
    const link = fs.linkSync;
    let blocker: NativeHold | undefined;
    const restore = replaceLinks(t, (source, target) => {
      if (kind === 'io') throw Object.assign(new Error('fixture link IO failure'), { code: 'EIO' });
      link(source, target);
      if (kind === 'probe-cleanup' && basename(String(target)) === '.probe') {
        blocker = openExclusiveMetadata(admitDirectory(dirname(String(target).replace(/^\\\\\?\\/, ''))), '.probe');
      }
    });
    try {
      if (kind === 'source-directory') { fs.unlinkSync(bash); fs.mkdirSync(bash); }
      if (kind === 'read-only') fs.chmodSync(bash, 0o444);
      await assert.rejects(fixture.prepare(), kind === 'probe-cleanup' ? isBusy : error => !String(error).includes('never start a subprocess'));
      if (kind === 'probe-cleanup') assert.ok(blocker, 'the actual probe handle must block ordinary unlink');
      assert.equal(pathExists(join(fixture.cache, 'current.json')), false);
    } finally {
      blocker?.close(); restore();
      if (kind === 'read-only') fs.chmodSync(bash, 0o666);
    }
  });
});

await test('later link denial never resets base or escalates, and guarded GC reclaims the candidate', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), link = fs.linkSync;
  let hold: NativeHold | undefined, generation = '', baseId = 0;
  const restore = replaceLinks(t, (source, target) => {
    if (String(target).endsWith('sh.exe') && !String(target).endsWith('bash.exe')) {
      generation = dirname(dirname(dirname(dirname(String(target)))));
      // Strip the Node namespace spelling before boundary admission.
      generation = generation.replace(/^\\\\\?\\/, '');
      const base = join(generation, 'base');
      baseId = fs.statSync(base).ino;
      hold = pinDirectory(admitDirectory(generation));
      throw Object.assign(new Error('fixture later link denial'), { code: 'EACCES' });
    }
    link(source, target);
  });
  try {
    await assert.rejects(fixture.prepare(), /fixture later link denial/);
    assert.equal(fs.statSync(join(generation, 'base')).ino, baseId);
    assert.ok(pathExists(join(generation, 'base/etc/profile')));
    assert.equal(pathExists(join(generation, 'plan.json')), false);
    assert.equal(pathExists(join(fixture.cache, 'current.json')), false);
  } finally { hold?.close(); restore(); }
  const pin = await fixture.prepare(); await pin.release();
  assert.equal(pathExists(generation), false);
});

await test('helper independently rejects changed identities, wrong layout/path, and populated base', nativeOnly, async t => {
  for (const kind of ['schema', 'identity', 'layout', 'base-path', 'populated', 'reparse', 'read-only'] as const) await t.test(kind, async t => {
    const fixture = await runtimeFixture(t), restore = denyProbe(t);
    const bash = join(fixture.source, 'usr/bin/bash.exe');
    const spawn: Subprocess['spawn'] = spec => {
      const planPath = spec.argv[2]!, plan = JSON.parse(readFileSync(planPath, 'utf8')) as Record<string, unknown>;
      const base = String(plan.baseRoot);
      if (kind === 'schema') delete plan.attemptId;
      if (kind === 'identity') (plan.identities as Record<string, unknown>).source = { volumeSerial: '0', fileId: '0' };
      if (kind === 'layout') plan.layout = 'mingw64';
      if (kind === 'base-path') plan.baseRoot = fixture.workspace;
      if (kind === 'populated') writeFileSync(join(base, 'unexpected'), 'owned fixture');
      if (kind === 'reparse') { fs.rmdirSync(base); fs.symlinkSync(fixture.workspace, base, 'junction'); }
      if (kind === 'read-only') fs.chmodSync(bash, 0o444);
      writeFileSync(planPath, JSON.stringify(plan));
      return brokerHandle(runLinkHelper(planPath).then(() => success));
    };
    try {
      await assert.rejects(prepareRuntime({ ...fixture.request, spawn }, signal()));
      assert.equal(pathExists(join(fixture.cache, 'current.json')), false);
      assert.deepEqual(readdirSync(fixture.workspace), []);
    } finally { if (kind === 'read-only') fs.chmodSync(bash, 0o666); restore(); }
  });
});

await test('cancelled inventory drains before the exclusive helper plan handle closes', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), restore = denyProbe(t), controller = new AbortController();
  const issued = deferred<void>(), drain = deferred<void>(), lstat = fsp.lstat;
  let planPath = '', pending = 0, helperDone!: Promise<SubprocessOutcome>;
  const mock = t.mock.method(fsp, 'lstat', (async (...args: Parameters<typeof fsp.lstat>) => {
    pending++;
    issued.resolve();
    await drain.promise;
    try { return await lstat(...args); } finally { pending--; }
  }) as typeof fsp.lstat);
  syncBuiltinESMExports();
  const spawn: Subprocess['spawn'] = spec => {
    planPath = spec.argv[2]!;
    helperDone = runLinkHelper(planPath).then(() => success, () => ({ exitCode: 1, signal: null }));
    return brokerHandle(helperDone);
  };
  const preparation = prepareRuntime({ ...fixture.request, spawn }, controller.signal);
  const rejected = assert.rejects(preparation, { name: 'AbortError' });
  try {
    await issued.promise;
    controller.abort();
    assert.ok(pending > 0 && pending <= 32);
    assert.throws(() => unlinkEntry(admitDirectory(dirname(planPath)), 'plan.json'), isBusy);
    assert.equal(pathExists(join(dirname(planPath), '.setup-owner')), false);
    drain.resolve();
    await rejected; await helperDone;
    assert.equal(pending, 0);
    assert.equal(pathExists(join(fixture.cache, 'current.json')), false);
  } finally { drain.resolve(); restore(); mock.mock.restore(); syncBuiltinESMExports(); }
});

await test('both link callers reject source/base replacement across inventory before writing payload', nativeOnly, async t => {
  for (const caller of ['local', 'helper']) for (const boundary of ['source', 'base']) await t.test(`${caller} ${boundary}`, async t => {
    const fixture = await runtimeFixture(t), readdir = fsp.readdir;
    const restore = caller === 'helper' ? denyProbe(t) : () => {};
    let base = '', replaced = false, helperFailure: unknown, pin: GenerationPin | undefined;
    let retained: NativeHold | undefined;
    const mock = t.mock.method(fsp, 'readdir', (async (...args: Parameters<typeof fsp.readdir>) => {
      const result = await readdir(...args);
      if (!replaced && String(args[0]) === join(fixture.source, 'usr/bin')) {
        replaced = true;
        const generation = admitDirectory(join(fixture.cache, 'generations', readdirSync(join(fixture.cache, 'generations'))[0]!));
        base = join(generation.path, 'base');
        // Keep the rejected candidate available for payload assertions; cleanup
        // must defer while this native pin is held, then strictly purge below.
        retained = pinDirectory(generation);
        const path = boundary === 'source' ? fixture.source : base;
        if (boundary === 'source') {
          fs.renameSync(path, `${path}-admitted`);
          fs.cpSync(`${path}-admitted`, path, { recursive: true });
        } else {
          fs.rmdirSync(path);
          fs.mkdirSync(path);
        }
      }
      return result;
    }) as typeof fsp.readdir);
    syncBuiltinESMExports();
    const spawn: Subprocess['spawn'] = caller === 'local' ? fixture.request.spawn : spec => brokerHandle((async () => {
      try { await runLinkHelper(spec.argv[2]!); return success; }
      catch (error) { helperFailure = error; return { exitCode: 1, signal: null }; }
    })());
    try {
      await assert.rejects(prepareRuntime({ ...fixture.request, spawn }, signal()).then(result => { pin = result; return result; }));
      assert.ok(replaced);
      if (caller === 'helper') assert.match(String(helperFailure), /Directory identity changed/);
      assert.deepEqual(readdirSync(base), [], 'the replacement must be refused before any linking');
      assert.equal(pathExists(join(fixture.cache, 'current.json')), false);
    } finally {
      await pin?.release(); retained?.close(); restore(); mock.mock.restore(); syncBuiltinESMExports();
    }
  });
});

await test('lease revocation stops helper link batches while its plan still excludes deletion', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), controller = new AbortController();
  for (let i = 0; i < 80; i++) writeFileSync(join(fixture.source, `usr/bin/extra-${i}.dll`), 'owned');
  const link = fs.linkSync;
  let planPath = '', linked = 0, afterAbort = 0;
  const restore = replaceLinks(t, (source, target) => {
    if (basename(String(target)) === '.probe') throw Object.assign(new Error('probe denial'), { code: 'EPERM' });
    link(source, target); linked++;
    if (controller.signal.aborted) afterAbort++;
    else {
      controller.abort();
      assert.throws(() => unlinkEntry(admitDirectory(dirname(planPath)), 'plan.json'), isBusy);
    }
  });
  const spawn: Subprocess['spawn'] = spec => {
    planPath = spec.argv[2]!;
    return brokerHandle(runLinkHelper(planPath).then(() => success, () => ({ exitCode: 1, signal: null })));
  };
  try {
    await assert.rejects(prepareRuntime({ ...fixture.request, spawn }, controller.signal), { name: 'AbortError' });
    assert.ok(linked > 0 && linked <= 32 && afterAbort < 32, 'only the issued bounded batch may drain');
    assert.equal(pathExists(join(fixture.cache, 'current.json')), false);
  } finally { restore(); }
});

await test('blocked plan cleanup preserves payload, but a new attempt never reauthorizes a revoked plan', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), restore = denyProbe(t), controller = new AbortController();
  let planPath = '', reader: NativeHold | undefined;
  const spawn: Subprocess['spawn'] = spec => {
    planPath = spec.argv[2]!;
    reader = openExclusiveMetadata(admitDirectory(dirname(planPath)), 'plan.json');
    writeFileSync(join(dirname(planPath), 'base/sentinel'), 'still protected');
    controller.abort();
    return brokerHandle(Promise.resolve(success)); // A late zero cannot undo cancellation.
  };
  try {
    await assert.rejects(prepareRuntime({ ...fixture.request, spawn }, controller.signal), { name: 'AbortError' });
    assert.ok(pathExists(join(dirname(planPath), 'base/sentinel')));
    await assert.rejects(purgeRuntimeCache(fixture.cache), isBusy);
    assert.ok(pathExists(join(dirname(planPath), 'base/sentinel')));
    const nextSpawn: Subprocess['spawn'] = spec => {
      reader!.close(); reader = undefined;
      assert.notEqual(spec.argv[2], planPath);
      return brokerHandle((async () => {
        const oldBase = admitDirectory(join(dirname(planPath), 'base'));
        unlinkEntry(oldBase, 'sentinel');
        assert.deepEqual(children(oldBase), [], 'late admission must fail on the revoked lease, not a populated base');
        await assert.rejects(runLinkHelper(planPath), error => isMissing(error) && String(error).includes('.setup-owner'));
        assert.deepEqual(children(oldBase), [], 'the revoked helper must not mutate its empty base');
        await runLinkHelper(spec.argv[2]!);
        return success;
      })());
    };
    const pin = await prepareRuntime({ ...fixture.request, spawn: nextSpawn }, signal()); await pin.release();
    await assert.rejects(runLinkHelper(planPath));
  } finally { reader?.close(); restore(); }
});

await test('failed final plan unlink and checked helper/lease closes prevent publication', nativeOnly, async t => {
  for (const kind of ['unlink', 'close', 'helper-close'] as const) await t.test(kind, async t => {
    const fixture = await runtimeFixture(t), restore = denyProbe(t);
    let reader: NativeHold | undefined;
    let owner: NativeHold | undefined;
    const information = NativeHold.prototype.information;
    t.mock.method(NativeHold.prototype, 'information', function (this: NativeHold) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- Fault the owner, not short-lived metadata readers.
      if (basename(this.path) === '.setup-owner') owner ??= this;
      return information.call(this);
    });
    const close = NativeHold.prototype.close;
    let injected = false;
    const mock = t.mock.method(NativeHold.prototype, 'close', function (this: NativeHold) {
      close.call(this);
      if (!injected && ((kind === 'close' && this === owner) || (kind === 'helper-close' && basename(this.path) === 'plan.json'))) {
        injected = true;
        throw new Win32Error('CloseHandle', 6, 'fixture checked close failure');
      }
    });
    const spawn: Subprocess['spawn'] = spec => brokerHandle(runLinkHelper(spec.argv[2]!).then(() => {
      if (kind === 'unlink') reader = openExclusiveMetadata(admitDirectory(dirname(spec.argv[2]!)), 'plan.json');
      return success;
    }));
    try {
      await assert.rejects(prepareRuntime({ ...fixture.request, spawn }, signal()));
      assert.equal(pathExists(join(fixture.cache, 'current.json')), false);
    } finally { mock.mock.restore(); reader?.close(); restore(); }
  });
});

await test('a delete-pending setup lease is inactive even while a metadata reader retains it', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare(); await pin.release();
  const generation = admitDirectory(join(fixture.cache, 'generations', (await fixture.current()).generationId));
  const lease = createSetupLease(generation);
  let reader: NativeHold | undefined;
  try {
    const identity = lease.information();
    reader = openOrdinaryFile(generation, '.setup-owner');
    lease.close();
    assert.throws(() => requireActiveLease(generation, identity));
    assert.throws(() => createSetupLease(generation));
  } finally { reader?.close(); lease.close(); }
  await purgeRuntimeCache(fixture.cache);
});

await test('final source/base anchors require ordinary matching identities after helper success', nativeOnly, async t => {
  for (const kind of ['replacement', 'directory'] as const) await t.test(kind, async t => {
    const fixture = await runtimeFixture(t), restore = denyProbe(t);
    const spawn: Subprocess['spawn'] = spec => brokerHandle(runLinkHelper(spec.argv[2]!).then(() => {
      const profile = join(dirname(spec.argv[2]!), 'base/etc/profile');
      fs.unlinkSync(profile);
      if (kind === 'replacement') writeFileSync(profile, 'different identity'); else fs.mkdirSync(profile);
      return success;
    }));
    try {
      await assert.rejects(prepareRuntime({ ...fixture.request, spawn }, signal()), /anchor identity|ordinary file/);
      assert.equal(pathExists(join(fixture.cache, 'current.json')), false);
    } finally { restore(); }
  });
});

await test('abnormal broker outcome and failed range observation remain non-publishable', nativeOnly, async t => {
  for (const fault of ['signal', 'range'] as const) await t.test(fault, async t => {
    const fixture = await runtimeFixture(t), restore = denyProbe(t);
    let terminated = false;
    const spawn: Subprocess['spawn'] = () => brokerHandle(Promise.resolve(fault === 'signal' ? { exitCode: 0, signal: 'SIGTERM' } : success), {
      terminate() { terminated = true; },
      async waitForExit() { if (fault === 'range') throw new Error('fixture range observation failed'); return true; },
    });
    try {
      await assert.rejects(prepareRuntime({ ...fixture.request, spawn }, signal()));
      assert.equal(terminated, fault === 'range');
      assert.equal(pathExists(join(fixture.cache, 'current.json')), false);
    } finally { restore(); }
  });
});

await test('a nonzero broker outcome revokes the lease and stops a still-live managed range', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), restore = denyProbe(t), range = deferred<boolean>();
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(new Error('fixture shutdown watchdog')), 2000);
  let terminated = false;
  const spawn: Subprocess['spawn'] = spec => brokerHandle(Promise.resolve({ exitCode: 9, signal: null }), {
    terminate() {
      assert.equal(pathExists(join(dirname(spec.argv[2]!), '.setup-owner')), false, 'revocation must precede range termination');
      terminated = true; range.resolve(true);
    },
    async waitForExit(bound) {
      if (!bound) return range.promise;
      try { await delay(10_000, undefined, { signal: bound }); } catch (error) { if (!bound.aborted) throw error; }
      return false;
    },
  });
  try {
    await assert.rejects(prepareRuntime({ ...fixture.request, spawn }, controller.signal), /Elevated setup failed \(exit 9/);
    assert.ok(terminated);
    assert.equal(pathExists(join(fixture.cache, 'current.json')), false);
  } finally { clearTimeout(watchdog); restore(); }
});

await test('fixed scripts default to failure on invalid input', nativeOnly, () => {
  for (const entry of [helperEntry, brokerEntry]) {
    const child = spawnSync(process.execPath, [entry], { encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /Expected one setup plan path/);
  }
});

/** Fault only the native request/wait results, retaining public DSH wait/close code. */
function brokerFault(t: TestContext, fault: 'success' | 'request' | 'missing' | 'wait' | 'exit' | 'close') {
  const api = loadWin32ProcessBindings(), load = koffi.load;
  const handle = 12345n as NativePtr;
  let closed = false;
  t.mock.method(koffi, 'load', (...args: Parameters<typeof koffi.load>) => {
    const library = load(...args);
    if (args[0] !== 'shell32.dll') return library;
    return { ...library, func: (() => ((request: { hProcess: NativePtr | null; lpVerb: string; lpParameters: string }) => {
      assert.equal(request.lpVerb, 'runas');
      assert.match(request.lpParameters, /link-helper\.js/);
      if (fault !== 'missing') request.hProcess = handle;
      return fault === 'request' ? 0 : 1;
    })) as unknown as typeof library.func };
  });
  t.mock.method(api, 'waitForSingleObject', () => fault === 'wait' ? 0xffffffff : 0);
  t.mock.method(api, 'getExitCodeProcess', (_process: NativePtr, output: NativePtr) => { koffi.encode(output, 'uint32', fault === 'exit' ? 9 : 0); return 1; });
  t.mock.method(api, 'closeHandle', (actual: NativePtr) => { assert.equal(actual, handle); closed = true; return fault === 'close' ? 0 : 1; });
  t.mock.method(api, 'getLastError', () => 6);
  return () => assert.equal(closed, fault !== 'missing');
}

await test('F4 broker requires a process handle, helper zero, successful wait and checked close', nativeOnly, async t => {
  for (const fault of ['success', 'request', 'missing', 'wait', 'exit', 'close'] as const) await t.test(fault, async t => {
    const fixture = await runtimeFixture(t), restore = denyProbe(t);
    admitDirectory(fixture.source); // Establish the real filesystem bindings before native wait faults.
    const verifyClose = brokerFault(t, fault);
    const spawn: Subprocess['spawn'] = spec => brokerHandle((async () => {
      if (fault === 'success') { await runElevationBroker(spec.argv[2]!); await runLinkHelper(spec.argv[2]!); }
      else await assert.rejects(runElevationBroker(spec.argv[2]!), fault === 'wait' ? /WaitForSingleObject/ : fault === 'close' ? /CloseHandle/ : /ShellExecuteExW|no process handle|exited with code/);
      return fault === 'success' ? success : { exitCode: 1, signal: null };
    })());
    try {
      if (fault === 'success') { const pin = await prepareRuntime({ ...fixture.request, spawn }, signal()); await pin.release(); }
      else { await assert.rejects(prepareRuntime({ ...fixture.request, spawn }, signal()), /Elevated setup failed/); assert.equal(pathExists(join(fixture.cache, 'current.json')), false); }
      verifyClose();
    } finally { restore(); }
  });
});

await test('native broker launch and wait join through DSH before cache publication without consent', nativeOnly, async t => {
  const spawn = await localSpawn(t); if (!spawn) return;
  const fixture = await runtimeFixture(t), restore = denyProbe(t);
  const bash = join(fixture.source, 'usr/bin/bash.exe');
  const content = readFileSync(bash), links = fs.statSync(bash).nlink;
  const acl = execFileSync('icacls.exe', [bash], { encoding: 'utf8' });
  const preload = join(fixture.directory, 'ordinary-shell-execute.mjs');
  // Change only the consent verb. The request ABI, process handle, wait/close,
  // fixed script argv and DSH outcome/range observation all remain native.
  // Resolve the ESM export used by the broker; Koffi's CJS facade is separate.
  writeFileSync(preload, `
    import assert from 'node:assert/strict';
    import koffi from ${JSON.stringify(import.meta.resolve('koffi'))};
    const load = koffi.load;
    koffi.load = (...args) => {
      const library = load(...args);
      if (args[0] !== 'shell32.dll') return library;
      return { ...library, func(...declaration) {
        assert.equal(declaration[1], 'ShellExecuteExW');
        const execute = library.func(...declaration);
        return request => {
          assert.equal(request.lpVerb, 'runas');
          request.lpVerb = 'open';
          return execute(request);
        };
      } };
    };
  `);
  const { prepareRuntime: prepareBuilt } = await import(pathToFileURL(join(root, 'lib/runtime/runtime-cache.js')).href) as typeof import('../src/runtime/runtime-cache.ts');
  let broker: SubprocessHandle | undefined;
  try {
    const pin = await prepareBuilt({ ...fixture.request, spawn: spec => broker = spawn({ ...spec, argv: [spec.argv[0]!, '--import', pathToFileURL(preload).href, ...spec.argv.slice(1)] }) }, AbortSignal.timeout(10_000));
    await pin.release();
    const record = await fixture.current();
    assert.deepEqual(children(admitDirectory(join(fixture.cache, 'generations', record.generationId))), ['base']);
    await purgeRuntimeCache(fixture.cache);
    assert.equal(fs.statSync(bash).nlink, links);
    assert.deepEqual(readFileSync(bash), content);
    assert.equal(execFileSync('icacls.exe', [bash], { encoding: 'utf8' }), acl);
  } catch (error) { t.diagnostic(broker?.collected.stderr?.readFrom(0).text ?? ''); throw error; }
  finally { restore(); }
});

// Never registered by the default suite. Only this explicit manual lane opens
// real consent; it still uses owned source copies and the production broker.
if (process.env.DSH_GIT_BASH_UAC_TEST) {
  await test('manual UAC approval, denial or late consent after cancellation', nativeOnly, async t => {
    const choice = process.env.DSH_GIT_BASH_UAC_TEST;
    assert.ok(choice === 'approve' || choice === 'deny' || choice === 'late', 'Use DSH_GIT_BASH_UAC_TEST=approve, deny or late.');
    const spawn = await localSpawn(t); if (!spawn) return;
    const fixture = await runtimeFixture(t);
    const { prepareRuntime: prepareBuilt } = await import(pathToFileURL(join(root, 'lib/runtime/runtime-cache.js')).href) as typeof import('../src/runtime/runtime-cache.ts');
    const bash = join(fixture.source, 'usr/bin/bash.exe');
    const before = { bytes: readFileSync(bash), links: fs.statSync(bash).nlink,
      acl: execFileSync('icacls.exe', [bash], { encoding: 'utf8' }) };
    let pin: GenerationPin | undefined;
    console.error(choice === 'late'
      ? 'Leave consent pending for 10 seconds. Approve only after LOCAL SHUTDOWN COMPLETED appears below; finish any prompt within the following 20 seconds.'
      : `Respond ${choice === 'approve' ? 'Yes' : 'No'} to the Windows consent prompt.`);
    const restore = denyProbe(t);
    try {
      const started = performance.now();
      // Keep ownership even if an unexpected consent response fulfils a promise
      // which assert.rejects expected to reject.
      const prepared = prepareBuilt({ ...fixture.request, spawn }, choice === 'late' ? AbortSignal.timeout(10_000) : signal())
        .then(value => pin = value);
      if (choice === 'approve') { await prepared; await fixture.current(); }
      else if (choice === 'deny') {
        await assert.rejects(prepared, /ShellExecuteExW failed \(Win32 1223\)/);
        assert.equal(pathExists(join(fixture.cache, 'current.json')), false);
      }
      else {
        await assert.rejects(prepared, { name: 'TimeoutError' });
        assert.ok(performance.now() - started < 15_000, 'local shutdown must settle within five seconds of cancellation');
        assert.equal(pathExists(join(fixture.cache, 'current.json')), false);
        console.error('LOCAL SHUTDOWN COMPLETED. If consent remains visible, approve now. Strict purge runs in 20 seconds.');
        await delay(20_000);
        assert.equal(pathExists(join(fixture.cache, 'current.json')), false, 'late consent must never publish a revoked attempt');
      }
    } finally { restore(); await pin?.release(); }
    await purgeRuntimeCache(fixture.cache); // Busy independent work is an explicit failure, never a passing cleanup.
    assert.equal(pathExists(fixture.cache), false);
    assert.deepEqual(readFileSync(bash), before.bytes);
    assert.equal(fs.statSync(bash).nlink, before.links);
    assert.equal(execFileSync('icacls.exe', [bash], { encoding: 'utf8' }), before.acl);
  });
}

await test('cancellation settles a DSH-owned broker blocked in native work', nativeOnly, async t => {
  const spawn = await localSpawn(t); if (!spawn) return;
  const fixture = await runtimeFixture(t), restore = denyProbe(t), controller = new AbortController();
  const require = createRequire(import.meta.url);
  const code = `const koffi = require(${JSON.stringify(require.resolve('koffi'))}); process.stderr.write('native-work-ready'); koffi.load('kernel32.dll').func('__stdcall', 'Sleep', 'void', ['uint32'])(30000);`;
  let broker: SubprocessHandle | undefined;
  const preparation = prepareRuntime({ ...fixture.request, spawn: spec => broker = spawn({ ...spec, argv: [process.execPath, '-e', code] }) }, controller.signal);
  const rejected = assert.rejects(preparation, { name: 'AbortError' });
  try {
    const deadline = performance.now() + 10_000;
    while (!broker?.collected.stderr?.readFrom(0).text.includes('native-work-ready')) {
      assert.ok(performance.now() < deadline, 'native fixture failed to start');
      await delay(20);
    }
    const started = performance.now(); controller.abort();
    await rejected;
    assert.ok(performance.now() - started < 5000, 'shutdown must not await the 30-second native call');
    assert.equal(await broker.waitForExit(), true);
    assert.equal(pathExists(join(fixture.cache, 'current.json')), false);
  } finally { controller.abort(); await rejected; restore(); }
});
