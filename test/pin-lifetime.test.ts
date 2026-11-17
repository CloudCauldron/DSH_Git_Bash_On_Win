import assert from 'node:assert/strict';
import fs, { readdirSync, unlinkSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import { nativeOnly, runtimeFixture } from './fixtures.ts';
import { purgeRuntimeCache } from '../src/runtime/runtime-cache.ts';
import { anchorPaths } from '../src/runtime/git-installation.ts';
import {
  admitDirectory, claimDirectory, createSetupLease, isBusy, NativeHold, openExclusiveMetadata,
  pathExists, pinDirectory, removeTree, requireActiveLease, unlinkEntry,
} from '../src/runtime/ntfs-filesystem.ts';

const signal = () => new AbortController().signal;
const scope = (workspaceRoot: string, sessionId?: string): Pick<SandboxExecutionPolicy, 'mode' | 'workspaceRoot' | 'sessionId'> => ({
  mode: 'read-only', workspaceRoot, sessionId: sessionId as SandboxExecutionPolicy['sessionId'],
});

await test('native pin and collector exclusion works in both acquisition orders', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), prepared = await fixture.prepare();
  await prepared.release();
  const generation = admitDirectory(join(fixture.cache, 'generations', (await fixture.current()).generationId));
  const pin = pinDirectory(generation);
  try {
    const peer = pinDirectory(generation); peer.close(); peer.close();
    assert.throws(() => claimDirectory(generation), isBusy);
  } finally { pin.close(); }
  const collector = claimDirectory(generation);
  try { assert.throws(() => pinDirectory(generation), isBusy); }
  finally { collector.close(); collector.close(); }
  const later = pinDirectory(generation); later.close();
});

await test('purge preflight finds a pin in any generation before deleting controls or payload', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), first = await fixture.prepare();
  const old = await fixture.current();
  const second = await fixture.prepare(true);
  const selected = await fixture.current();
  await second.release();
  const before = readdirSync(join(fixture.cache, 'generations')).sort();
  await assert.rejects(purgeRuntimeCache(fixture.cache), isBusy);
  assert.equal((await fixture.current()).generationId, selected.generationId);
  assert.deepEqual(readdirSync(join(fixture.cache, 'generations')).sort(), before);
  for (const id of [old.generationId, selected.generationId]) assert.ok(pathExists(join(fixture.cache, 'generations', id, 'base/usr/lib/perl/module.pm')));
  await first.release();
  const unknown = join(fixture.cache, 'generations', 'zz-unselected-held');
  await mkdir(unknown); await writeFile(join(unknown, 'payload'), 'owned');
  const lastPin = pinDirectory(admitDirectory(unknown));
  try {
    await assert.rejects(purgeRuntimeCache(fixture.cache), isBusy);
    assert.equal((await fixture.current()).generationId, selected.generationId);
    assert.ok(pathExists(join(fixture.cache, 'generations', old.generationId, 'base/usr/lib/perl/module.pm')));
  } finally { lastPin.close(); }
  await purgeRuntimeCache(fixture.cache);
  assert.equal(pathExists(fixture.cache), false);
});

await test('retain-before-await protects an acquiring use through retirement and idempotent release', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  const acquiring = pin.lease(scope(fixture.workspace), signal());
  await pin.release(); await pin.release();
  const use = await acquiring;
  await assert.rejects(pin.lease(scope(fixture.workspace), signal()), /retired/);
  await assert.rejects(purgeRuntimeCache(fixture.cache), isBusy);
  assert.ok(pathExists(use.installationRoot));
  await use.release(); await use.release();
  assert.equal(pathExists(use.installationRoot), false);
  await purgeRuntimeCache(fixture.cache);
});

await test('session view promises are shared, agentless views are distinct, and cancelled waiters unwind', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare(), cancelled = new AbortController();
  const failed = pin.lease(scope(fixture.workspace, 'session'), cancelled.signal);
  const active = pin.lease(scope(fixture.workspace, 'session'), signal());
  cancelled.abort();
  await assert.rejects(failed, { name: 'AbortError' });
  const use = await active;
  const next = await pin.lease(scope(fixture.workspace, 'session'), signal());
  assert.equal(next.installationRoot, use.installationRoot);
  await use.release(); await next.release();
  assert.ok(pathExists(use.installationRoot));
  const [a, b] = await Promise.all([pin.lease(scope(fixture.workspace), signal()), pin.lease(scope(fixture.workspace), signal())]);
  assert.notEqual(a.installationRoot, b.installationRoot);
  const full = await pin.lease({ ...scope(fixture.workspace, 'session'), mode: 'danger-full-access' }, signal());
  assert.notEqual(full.installationRoot, use.installationRoot);
  await a.release(); await b.release(); await full.release();
  await pin.release();
  assert.equal(pathExists(use.installationRoot), false);
});

await test('workspace aliases and both overlap directions are rejected before view creation', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  await symlink(fixture.source, join(fixture.directory, 'source-alias'), 'junction');
  for (const workspace of [fixture.source, join(fixture.source, 'usr'), fixture.cache, fixture.directory, join(fixture.directory, 'source-alias')]) {
    await assert.rejects(pin.lease(scope(workspace), signal()), /overlap/);
  }
  const generation = join(fixture.cache, 'generations', (await fixture.current()).generationId);
  assert.deepEqual(readdirSync(generation), ['base']);
  await pin.release();
});

await test('failed shared view creation unwinds waiters, evicts the promise and permits retry', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  const generation = join(fixture.cache, 'generations', (await fixture.current()).generationId);
  await writeFile(join(generation, 'views'), 'an unexpected file must not be adopted or deleted');
  const outcomes = await Promise.allSettled([
    pin.lease(scope(fixture.workspace, 'session'), signal()),
    pin.lease(scope(fixture.workspace, 'session'), signal()),
  ]);
  assert.ok(outcomes.every(outcome => outcome.status === 'rejected'));
  assert.equal(await readFile(join(generation, 'views'), 'utf8'), 'an unexpected file must not be adopted or deleted');
  unlinkSync(join(generation, 'views'));
  const use = await pin.lease(scope(fixture.workspace, 'session'), signal());
  await pin.release(); await use.release();
  await purgeRuntimeCache(fixture.cache);
});

await test('a namespace created before failed directory admission is rolled back so the pin can retry', nativeOnly, async t => {
  const f = await runtimeFixture(t), pin = await f.prepare(), original = NativeHold.prototype.information;
  const generation = join(f.cache, 'generations', (await f.current()).generationId);
  const views = join(generation, 'views');
  const failure = new Error('fixture namespace admission failed');
  let created = '';
  const mock = t.mock.method(NativeHold.prototype, 'information', function (this: NativeHold) {
    if (!created && dirname(this.path) === views) { created = this.path; throw failure; }
    return original.call(this);
  });
  try { await assert.rejects(pin.lease(scope(f.workspace, 'session'), signal()), error => error === failure); }
  finally { mock.mock.restore(); }
  assert.ok(created, 'fault must occur at the newly created namespace');
  assert.equal(pathExists(created), false, 'failed admission must not leave the fixed namespace occupied');
  const retried = await pin.lease(scope(f.workspace, 'session'), signal());
  await retried.release(); await pin.release();
  await purgeRuntimeCache(f.cache);
});

await test('failed namespace rollback retains ownership for later retry and final cleanup', nativeOnly, async t => {
  for (const retry of [false, true]) await t.test(retry ? 'retry' : 'retirement', async t => {
    const f = await runtimeFixture(t), pin = await f.prepare();
    const views = join(f.cache, 'generations', (await f.current()).generationId, 'views');
    const originalInfo = NativeHold.prototype.information, originalCanonical = NativeHold.prototype.canonicalPath;
    let created = '', rollbackFailed = false;
    const admission = t.mock.method(NativeHold.prototype, 'information', function (this: NativeHold) {
      if (!created && dirname(this.path) === views) { created = this.path; throw new Error('fixture namespace admission failed'); }
      return originalInfo.call(this);
    });
    const rollback = t.mock.method(NativeHold.prototype, 'canonicalPath', function (this: NativeHold) {
      if (created && this.path === views) { rollbackFailed = true; throw new Error('fixture namespace rollback failed'); }
      return originalCanonical.call(this);
    });
    try { await assert.rejects(pin.lease(scope(f.workspace, 'session'), signal()), AggregateError); }
    finally { admission.mock.restore(); rollback.mock.restore(); }
    assert.ok(rollbackFailed);
    assert.ok(pathExists(created));
    if (retry) {
      const use = await pin.lease(scope(f.workspace, 'session'), signal());
      await use.release();
    }
    await pin.release();
    assert.equal(pathExists(created), false, 'retirement must attempt its owned namespace residue');
    await purgeRuntimeCache(f.cache);
  });
});

await test('unexpected namespace EEXIST grants no ownership for retry or pin cleanup', nativeOnly, async t => {
  const f = await runtimeFixture(t), pin = await f.prepare(), original = fs.mkdirSync;
  const views = join(f.cache, 'generations', (await f.current()).generationId, 'views');
  let collision = '';
  const mock = t.mock.method(fs, 'mkdirSync', ((...args: Parameters<typeof fs.mkdirSync>) => {
    const path = String(args[0]).replace(/^\\\\\?\\/, '');
    if (dirname(path) === views) {
      collision = path; original(...args);
      fs.writeFileSync(join(path, 'sentinel'), 'unexpected namespace');
    }
    return original(...args);
  }) as typeof fs.mkdirSync); syncBuiltinESMExports();
  try { await assert.rejects(pin.lease(scope(f.workspace, 'session'), signal()), { code: 'EEXIST' }); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(collision);
  await assert.rejects(pin.lease(scope(f.workspace, 'session'), signal()), { code: 'EEXIST' });
  await pin.release();
  assert.equal(fs.readFileSync(join(collision, 'sentinel'), 'utf8'), 'unexpected namespace');
  await purgeRuntimeCache(f.cache);
});

await test('failed junction admission cleans only its created target and the shared view can retry', nativeOnly, async t => {
  const f = await runtimeFixture(t), pin = await f.prepare(), original = fs.realpathSync;
  let attempted = '';
  const mock = t.mock.method(fs, 'realpathSync', ((...args: Parameters<typeof fs.realpathSync>) => {
    if (String(args[0]).includes('\\views\\')) { attempted = String(args[0]); throw new Error('fixture view admission failed'); }
    return original(...args);
  }) as typeof fs.realpathSync);
  syncBuiltinESMExports();
  try {
    const outcomes = await Promise.allSettled([
      pin.lease(scope(f.workspace, 'session'), signal()), pin.lease(scope(f.workspace, 'session'), signal()),
    ]);
    assert.ok(attempted);
    assert.ok(outcomes.every(result => result.status === 'rejected' && /Unexpected runtime junction/.test(String(result.reason))));
    assert.equal(fs.existsSync(attempted), false);
    assert.deepEqual(readdirSync(dirname(attempted)), []);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  const retried = await pin.lease(scope(f.workspace, 'session'), signal());
  await retried.release(); await pin.release();
});

await test('a shared creation promise evicts even when its partial-target cleanup fails', nativeOnly, async t => {
  const f = await runtimeFixture(t), pin = await f.prepare(), originalRealpath = fs.realpathSync;
  const originalCanonical = NativeHold.prototype.canonicalPath;
  let attempted = '', cleanupFailed = false;
  const target = t.mock.method(fs, 'realpathSync', ((...args: Parameters<typeof fs.realpathSync>) => {
    if (String(args[0]).includes('\\views\\')) { attempted = String(args[0]); throw new Error('fixture view admission failed'); }
    return originalRealpath(...args);
  }) as typeof fs.realpathSync);
  const cleanup = t.mock.method(NativeHold.prototype, 'canonicalPath', function (this: NativeHold) {
    if (attempted && this.path.includes('\\views\\')) { cleanupFailed = true; throw new Error('fixture cleanup observation failed'); }
    return originalCanonical.call(this);
  }); syncBuiltinESMExports();
  try {
    await assert.rejects(pin.lease(scope(f.workspace, 'session'), signal()), AggregateError);
    assert.ok(cleanupFailed);
    assert.equal(fs.existsSync(attempted), true);
  } finally { target.mock.restore(); cleanup.mock.restore(); syncBuiltinESMExports(); }
  const retried = await pin.lease(scope(f.workspace, 'session'), signal());
  assert.notEqual(basename(retried.installationRoot), basename(attempted));
  await retried.release(); await pin.release();
  assert.equal(fs.existsSync(attempted), false);
});

await test('canonical workspace aliases share one session view while separate pins own distinct namespaces', nativeOnly, async t => {
  const f = await runtimeFixture(t), first = await f.prepare(), second = await f.prepare();
  const alias = join(f.directory, 'workspace-alias');
  await symlink(f.workspace, alias, 'junction');
  const uses = await Promise.all([
    first.lease(scope(f.workspace, 'session'), signal()), first.lease(scope(alias, 'session'), signal()),
    second.lease(scope(f.workspace, 'session'), signal()),
  ]);
  try {
    assert.equal(uses[0]!.baseRoot, uses[2]!.baseRoot);
    assert.equal(uses[0]!.installationRoot, uses[1]!.installationRoot);
    assert.notEqual(uses[0]!.installationRoot, uses[2]!.installationRoot);
  } finally { await Promise.all(uses.map(use => use.release())); await first.release(); await second.release(); }
});

await test('unexpected EEXIST at a view name is neither adopted nor deleted by its creation attempt', nativeOnly, async t => {
  const f = await runtimeFixture(t), pin = await f.prepare(), original = fs.symlinkSync;
  let collision = '';
  const mock = t.mock.method(fs, 'symlinkSync', (target: fs.PathLike, path: fs.PathLike, type?: fs.symlink.Type | null) => {
    if (String(path).includes('\\views\\')) {
      collision = String(path);
      fs.mkdirSync(path); fs.writeFileSync(join(collision, 'sentinel'), 'retain until pin cleanup');
    }
    original(target, path, type);
  }); syncBuiltinESMExports();
  try {
    await assert.rejects(pin.lease(scope(f.workspace, 'session'), signal()), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(join(collision, 'sentinel'), 'utf8'), 'retain until pin cleanup');
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  const retried = await pin.lease(scope(f.workspace, 'session'), signal());
  assert.notEqual(basename(retried.installationRoot), basename(collision));
  await retried.release(); await pin.release();
  assert.equal(fs.existsSync(collision), false);
});

await test('cancelled admission retains its one reference until the awaited operation finishes', nativeOnly, async t => {
  const f = await runtimeFixture(t), pin = await f.prepare(), cancelled = new AbortController();
  const original = fsp.realpath;
  let resume!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const mock = t.mock.method(fsp, 'realpath', (async (...args: Parameters<typeof fsp.realpath>) => {
    if (String(args[0]) === f.workspace) { entered(); await gate; }
    return original(...args);
  }) as typeof fsp.realpath); syncBuiltinESMExports();
  const generation = join(f.cache, 'generations', (await f.current()).generationId);
  try {
    const acquiring = pin.lease(scope(f.workspace), cancelled.signal);
    const rejected = assert.rejects(acquiring, { name: 'AbortError' });
    await started; cancelled.abort(); await pin.release();
    assert.throws(() => claimDirectory(admitDirectory(generation)), isBusy);
    resume(); await rejected;
    const claim = claimDirectory(admitDirectory(generation)); claim.close();
  } finally { resume(); mock.mock.restore(); syncBuiltinESMExports(); }
});

await test('a reused session view performs no metadata, anchor, tree or junction-target revalidation', nativeOnly, async t => {
  const f = await runtimeFixture(t), pin = await f.prepare();
  const first = await pin.lease(scope(f.workspace, 'session'), signal());
  const fail = () => { throw new Error('a lease repeated pin/child validation'); };
  const read = t.mock.method(NativeHold.prototype, 'readJson', fail);
  const anchors = t.mock.method(NativeHold.prototype, 'information', function (this: NativeHold) {
    // All native observations would be redundant for this reused session view.
    return fail();
  });
  const tree = t.mock.method(fsp, 'readdir', fail), target = t.mock.method(fs, 'realpathSync', fail);
  syncBuiltinESMExports();
  let second;
  try {
    second = await pin.lease(scope(f.workspace, 'session'), signal());
    assert.equal(second.installationRoot, first.installationRoot);
    assert.equal(second.layout, first.layout);
  } finally {
    read.mock.restore(); anchors.mock.restore(); tree.mock.restore(); target.mock.restore(); syncBuiltinESMExports();
    await second?.release(); await first.release(); await pin.release();
  }
});

await test('a live pin leases without source probes after the source pathname disappears', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  await rename(fixture.source, join(fixture.directory, 'moved-source'));
  const use = await pin.lease(scope(fixture.workspace), signal());
  assert.equal(use.sourceRoot, fixture.source);
  await pin.release();
  await use.release();
  await purgeRuntimeCache(fixture.cache);
});

await test('plan unlink is an ordinary native sharing gate before any candidate payload', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  await pin.release();
  const generation = admitDirectory(join(fixture.cache, 'generations', (await fixture.current()).generationId));
  await writeFile(join(generation.path, 'plan.json'), '{malformed-but-owned');
  const plan = openExclusiveMetadata(generation, 'plan.json');
  try {
    await assert.rejects(purgeRuntimeCache(fixture.cache));
    assert.ok(pathExists(join(generation.path, 'base/usr/lib/perl/module.pm')));
    assert.ok(pathExists(join(fixture.cache, 'current.json')));
  } finally { plan.close(); }
  await purgeRuntimeCache(fixture.cache);
});

await test('setup leases are exclusive, identity-bound and revoked by checked close', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  await pin.release();
  const generation = admitDirectory(join(fixture.cache, 'generations', (await fixture.current()).generationId));
  const lease = createSetupLease(generation);
  try {
    const identity = lease.information();
    requireActiveLease(generation, identity);
    assert.throws(() => createSetupLease(generation));
    assert.throws(() => requireActiveLease(generation, { ...identity, fileId: '0' }), /identity/);
    lease.close(); lease.close();
    assert.throws(() => requireActiveLease(generation, identity));
  } finally { lease.close(); }
  assert.equal(pathExists(join(generation.path, '.setup-owner')), false);
});

await test('interrupted arbitrary-order GC leaves anchors intact but a delayed reader rejects its stale selector', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), first = await fixture.prepare(), old = await fixture.current();
  const second = await fixture.prepare(true), current = await fixture.current();
  await first.release(); await second.release();
  const oldPath = join(fixture.cache, 'generations', old.generationId);
  const originalRead = NativeHold.prototype.readJson;
  let delayed = true, interrupted = false;
  // Deliver the snapshot a reader obtained before B was published, then perform
  // real collector sharing/deletion before that reader opens its provisional pin.
  t.mock.method(NativeHold.prototype, 'readJson', function (this: NativeHold, maxBytes: number) {
    const value = originalRead.call(this, maxBytes);
    if (delayed && this.path === join(fixture.cache, 'current.json')) {
      delayed = false;
      const lock = createSetupLease(admitDirectory(fixture.cache), '.writer-lock');
      try {
        const claim = claimDirectory(admitDirectory(oldPath));
        try { unlinkEntry(admitDirectory(join(oldPath, 'base/usr/lib/perl')), 'module.pm'); }
        finally { claim.close(); }
      } finally { lock.close(); }
      interrupted = true;
      return old;
    }
    return value;
  });
  const pin = await fixture.prepare();
  assert.equal(interrupted, true);
  assert.equal(pathExists(join(oldPath, 'base/usr/lib/perl/module.pm')), false, 'the interrupted collector must actually remove non-anchor payload');
  assert.ok(Object.values(anchorPaths('ucrt64')).every(path => pathExists(join(oldPath, 'base', path))));
  const use = await pin.lease(scope(fixture.workspace), signal());
  try { assert.equal(use.baseRoot, join(fixture.cache, 'generations', current.generationId, 'base')); }
  finally { await use.release(); await pin.release(); }
});

await test('interrupted purge unpublishes before payload removal and remains retryable', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  await pin.release();
  const record = await fixture.current(), generation = join(fixture.cache, 'generations', record.generationId);
  // A reader denying delete on a non-anchor payload obstructs ordinary unlink.
  const blocker = openExclusiveMetadata(admitDirectory(join(generation, 'base/usr/lib/perl')), 'module.pm');
  try { await assert.rejects(purgeRuntimeCache(fixture.cache)); }
  finally { blocker.close(); }
  assert.equal(pathExists(join(fixture.cache, 'current.json')), false);
  assert.ok(pathExists(join(fixture.cache, '.owner.json')));
  await purgeRuntimeCache(fixture.cache);
  assert.equal(pathExists(fixture.cache), false);
});

await test('normal view cleanup obstruction still closes the pin; strict purge later removes residue', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  const use = await pin.lease(scope(fixture.workspace, 'session'), signal());
  const generation = join(fixture.cache, 'generations', (await fixture.current()).generationId);
  const instance = readdirSync(join(generation, 'views'))[0]!;
  const namespace = admitDirectory(join(generation, 'views', instance));
  await writeFile(join(namespace.path, 'blocked'), 'owned residue');
  const blocker = openExclusiveMetadata(namespace, 'blocked');
  try {
    await pin.release(); await use.release();
    const claim = claimDirectory(admitDirectory(generation)); claim.close();
    assert.ok(pathExists(join(namespace.path, 'blocked')));
    await assert.rejects(purgeRuntimeCache(fixture.cache));
  } finally { blocker.close(); }
  await purgeRuntimeCache(fixture.cache);
});

await test('replaced view ancestors never send disposal or purge outside the cache', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  const use = await pin.lease(scope(fixture.workspace, 'session'), signal());
  const generation = join(fixture.cache, 'generations', (await fixture.current()).generationId);
  const views = join(generation, 'views');
  // Model an outside program replacing a child namespace while the pin is live.
  removeTree(admitDirectory(generation), 'views');
  await mkdir(join(fixture.workspace, 'outside'));
  await writeFile(join(fixture.workspace, 'outside', 'sentinel'), 'keep');
  await symlink(join(fixture.workspace, 'outside'), views, 'junction');
  await pin.release(); await use.release();
  assert.equal(await readFile(join(fixture.workspace, 'outside', 'sentinel'), 'utf8'), 'keep');
  await purgeRuntimeCache(fixture.cache);
  assert.equal(await readFile(join(fixture.workspace, 'outside', 'sentinel'), 'utf8'), 'keep');
});
