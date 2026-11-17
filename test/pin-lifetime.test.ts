import assert from 'node:assert/strict';
import { readdirSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import { nativeOnly, runtimeFixture } from './fixtures.ts';
import { purgeRuntimeCache } from '../src/runtime/runtime-cache.ts';
import { anchorPaths } from '../src/runtime/git-installation.ts';
import {
  admitDirectory, claimDirectory, createSetupLease, isBusy, NativeHold, openExclusiveMetadata,
  pathExists, pinDirectory, removeTree, requireActiveLease,
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
  const originalRead = NativeHold.prototype.readJson, originalPath = NativeHold.prototype.canonicalPath;
  let delayed = true, interrupted = false;
  // Deliver the snapshot a reader obtained before B was published, then perform
  // real collector sharing/deletion before that reader opens its provisional pin.
  t.mock.method(NativeHold.prototype, 'readJson', function (this: NativeHold, maxBytes: number) {
    const value = originalRead.call(this, maxBytes);
    if (delayed && this.path === join(fixture.cache, 'current.json')) { delayed = false; return old; }
    return value;
  });
  t.mock.method(NativeHold.prototype, 'canonicalPath', function (this: NativeHold) {
    const path = originalPath.call(this);
    if (!interrupted && path === oldPath) {
      interrupted = true;
      const directory = admitDirectory(oldPath), claim = claimDirectory(directory);
      try { unlinkSync(join(oldPath, 'base/usr/lib/perl/module.pm')); }
      finally { claim.close(); }
    }
    return path;
  });
  const pin = await fixture.prepare();
  assert.equal(interrupted, true);
  assert.ok(Object.values(anchorPaths('ucrt64')).every(path => pathExists(join(oldPath, 'base', path))));
  const use = await pin.lease(scope(fixture.workspace), signal());
  assert.equal(use.baseRoot, join(fixture.cache, 'generations', current.generationId, 'base'));
  await use.release(); await pin.release();
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
