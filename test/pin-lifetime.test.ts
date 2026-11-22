import assert from 'node:assert/strict';
import koffi from 'koffi';
import fs, { readdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { blockFile, nativeOnly, runtimeFixture } from './fixtures.ts';
import { purgeRuntimeCache } from '../src/runtime/runtime-cache.ts';
import {
  admitDirectory, claimDirectory, createDirectory, isBusy, NativeHold, openOrdinaryFile,
  pathExists, pinDirectory, unlinkEntry,
} from '../src/runtime/ntfs-filesystem.ts';

await test('native pin and collector exclusion works in both acquisition orders', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), prepared = await fixture.prepare();
  await prepared.release();
  const generation = admitDirectory(join(fixture.cache, 'g', (await fixture.current()).generationId));
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

await test('purge preflight preserves a blocked root and succeeds after its blocker closes', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), sourceFile = join(fixture.source, 'usr/lib/perl/module.pm');
  const links = fs.statSync(sourceFile).nlink;
  const prepared = await fixture.prepare();
  await prepared.release();
  const selected = await fixture.current(), markerPath = join(fixture.cache, '.owner.json');
  const marker = await readFile(markerPath);
  const payload = join(fixture.cache, 'g', selected.generationId, 'r/usr/lib/perl/module.pm');
  const blocker = pinDirectory(admitDirectory(fixture.cache));
  try {
    await assert.rejects(purgeRuntimeCache(fixture.cache), isBusy);
    assert.deepEqual(await readFile(markerPath), marker);
    assert.deepEqual(await fixture.current(), selected);
    assert.ok(pathExists(payload));
    assert.equal(fs.statSync(sourceFile).nlink, links);
  } finally { blocker.close(); }
  await purgeRuntimeCache(fixture.cache);
  assert.equal(pathExists(fixture.cache), false);
  assert.equal(fs.statSync(sourceFile).nlink, links);
});

await test('purge removes the marker and root names while share-delete observers remain open', nativeOnly, async t => {
  const fixture = await runtimeFixture(t);
  await (await fixture.prepare()).release();
  const observers = new Map<string, () => void>();
  const marker = join(fixture.cache, '.owner.json');
  const close = NativeHold.prototype.close;
  const hook = t.mock.method(NativeHold.prototype, 'close', function (this: NativeHold) {
    if ((this.path === marker || this.path === fixture.cache) && !observers.has(this.path)) {
      observers.set(this.path, close.bind(this)); return;
    }
    close.call(this);
  });
  try {
    await purgeRuntimeCache(fixture.cache);
    assert.equal(observers.size, 2);
    assert.equal(readdirSync(fixture.directory).includes('cache'), false);
  } finally { hook.mock.restore(); for (const closeObserver of observers.values()) closeObserver(); }
  assert.equal(pathExists(fixture.cache), false);
  await purgeRuntimeCache(fixture.cache);
});

await test('offline purge reports a sibling lock still held by a metadata observer', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), parent = admitDirectory(fixture.directory);
  const name = basename(fixture.cache) + '.writer-lock', close = NativeHold.prototype.close;
  let observer: NativeHold | undefined;
  const hook = t.mock.method(NativeHold.prototype, 'close', function (this: NativeHold) {
    if (!observer && this.path === join(parent.path, name)) observer = openOrdinaryFile(parent, name);
    close.call(this);
  });
  try {
    await assert.rejects(purgeRuntimeCache(fixture.cache), /incomplete/);
    assert.ok(readdirSync(parent.path).includes(name));
  } finally { hook.mock.restore(); observer?.close(); }
  await purgeRuntimeCache(fixture.cache);
  assert.equal(readdirSync(parent.path).includes(name), false);
});

await test('purge preflight finds a pin in any generation before deleting controls or payload', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), first = await fixture.prepare();
  const old = await fixture.current();
  const second = await fixture.prepare(true);
  const selected = await fixture.current();
  await second.release();
  const before = readdirSync(join(fixture.cache, 'g')).sort();
  await assert.rejects(purgeRuntimeCache(fixture.cache), isBusy);
  assert.equal((await fixture.current()).generationId, selected.generationId);
  assert.deepEqual(readdirSync(join(fixture.cache, 'g')).sort(), before);
  for (const id of [old.generationId, selected.generationId]) assert.ok(pathExists(join(fixture.cache, 'g', id, 'r/usr/lib/perl/module.pm')));
  await first.release();
  const unknown = join(fixture.cache, 'g', 'zz-unselected-held');
  await mkdir(unknown); await writeFile(join(unknown, 'payload'), 'owned');
  const lastPin = pinDirectory(admitDirectory(unknown));
  try {
    await assert.rejects(purgeRuntimeCache(fixture.cache), isBusy);
    assert.equal((await fixture.current()).generationId, selected.generationId);
    assert.ok(pathExists(join(fixture.cache, 'g', old.generationId, 'r/usr/lib/perl/module.pm')));
  } finally { lastPin.close(); }
  await purgeRuntimeCache(fixture.cache);
  assert.equal(pathExists(fixture.cache), false);
});

await test('synchronous bindings share only session capabilities and revalidate the pinned runtime', nativeOnly, async t => {
  const f = await runtimeFixture(t), pin = await f.prepare(), peer = await f.prepare();
  const scope = { workspace: f.workspace, prefix: 'ww-1-2', sessionId: 'session' };
  const a = pin.acquireUse(), b = pin.acquireUse(), c = peer.acquireUse();
  const view = a.bindView(scope);
  assert.equal(b.bindView(scope), view);
  assert.notEqual(c.bindView(scope), view);
  const d = pin.acquireUse();
  assert.notEqual(d.bindView({ ...scope, prefix: 'ww-3-4' }), view);
  const path = dirname(view);
  unlinkEntry(admitDirectory(path), basename(view)); await symlink(f.workspace, view, 'junction');
  assert.throws(() => b.bindView(scope), /Unexpected runtime junction/);
  await pin.release(); assert.throws(() => pin.acquireUse(), /retired/);
  await Promise.all([a.release(), a.release(), b.release(), c.release(), d.release(), peer.release()]);
  assert.deepEqual(readdirSync(path), []);
});

await test('agentless views last through retirement and release never scans the payload or selector', nativeOnly, async t => {
  const f = await runtimeFixture(t), pin = await f.prepare(), a = pin.acquireUse(), b = pin.acquireUse();
  const scope = { prefix: 'ww-u', workspace: f.workspace };
  const first = a.bindView(scope), second = b.bindView(scope);
  assert.notEqual(first, second);
  await pin.release();
  const next = await f.prepare(true), current = await f.current();
  const oldPath = dirname(dirname(first)), root = join(f.cache, 'g');
  assert.notEqual(basename(oldPath), current.generationId);
  const read = t.mock.method(NativeHold.prototype, 'readJson', () => { throw Error('unexpected selector read'); });
  const scan = t.mock.method(fs, 'readdirSync', () => { throw Error('unexpected traversal'); });
  const info = NativeHold.prototype.information;
  t.mock.method(NativeHold.prototype, 'information', function (this: NativeHold) {
    assert.notEqual(this.path, f.cache + '.writer-lock'); return info.call(this);
  });
  syncBuiltinESMExports();
  try { await a.release(); assert.ok(pathExists(second)); await b.release(); await next.release(); }
  finally { read.mock.restore(); scan.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(pathExists(oldPath)); assert.ok(!pathExists(first) && !pathExists(second));
  await (await f.prepare(true)).release();
  assert.deepEqual(readdirSync(root), [(await f.current()).generationId]);
});

await test('interrupted arbitrary-order collection cannot make a delayed reader adopt its stale selector', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), first = await fixture.prepare(), old = await fixture.current();
  const second = await fixture.prepare(true), current = await fixture.current();
  await first.release(); await second.release();
  const oldPath = join(fixture.cache, 'g', old.generationId);
  const originalRead = NativeHold.prototype.readJson;
  let delayed = true, interrupted = false;
  // Deliver the snapshot a reader obtained before B was published, then perform
  // real collector sharing/deletion before that reader opens its provisional pin.
  t.mock.method(NativeHold.prototype, 'readJson', function (this: NativeHold, maxBytes: number) {
    const value = originalRead.call(this, maxBytes);
    if (delayed && this.path === join(fixture.cache, 'current.json')) {
      delayed = false;
      const claim = claimDirectory(admitDirectory(oldPath));
      try { unlinkEntry(admitDirectory(join(oldPath, 'r/usr/bin')), 'sh.exe'); } finally { claim.close(); }
      interrupted = true;
      return old;
    }
    return value;
  });
  const pin = await fixture.prepare();
  assert.equal(interrupted, true);
  assert.equal(pathExists(join(oldPath, 'r/usr/bin/sh.exe')), false);
  const use = pin.acquireUse();
  try { assert.equal(dirname(dirname(use.bindView({ workspace: fixture.workspace, prefix: 'ro' }))), join(fixture.cache, 'g', current.generationId)); }
  finally { await use.release(); await pin.release(); }
});

await test('interrupted purge unpublishes before payload removal and remains retryable', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  await pin.release();
  const record = await fixture.current(), generation = join(fixture.cache, 'g', record.generationId);
  // A reader denying delete on a non-anchor payload obstructs ordinary unlink.
  const blocker = blockFile(join(generation, 'r/usr/bin/sh.exe'));
  try { await assert.rejects(purgeRuntimeCache(fixture.cache), { api: 'CreateFileW', win32Code: 32 }); }
  finally { blocker.close(); }
  assert.equal(pathExists(join(fixture.cache, 'current.json')), false);
  assert.ok(pathExists(join(fixture.cache, '.owner.json')));
  await purgeRuntimeCache(fixture.cache);
  assert.equal(pathExists(fixture.cache), false);
});

await test('collision and failed view admission roll back only a newly created junction', nativeOnly, async t => {
  const f = await runtimeFixture(t), pin = await f.prepare(), use = pin.acquireUse();
  const scope = { prefix: 'ro', workspace: f.workspace, sessionId: 'shared' };
  const link = fs.symlinkSync, read = fs.readlinkSync;
  let created = '';
  const collision = t.mock.method(fs, 'symlinkSync', ((target, path, type) => {
    created = String(path); link(f.workspace, path, 'junction'); link(target, path, type);
  }) as typeof link);
  syncBuiltinESMExports();
  try { assert.throws(() => use.bindView(scope), { code: 'EEXIST' }); assert.ok(pathExists(created)); }
  finally { collision.mock.restore(); syncBuiltinESMExports(); }
  let blocked = false;
  const badRead = t.mock.method(fs, 'readlinkSync', ((path: string) => {
    if (!String(path).includes('\\v\\')) return read(path);
    created = String(path);
    // A successful create followed by a failed rollback must retain both errors.
    blocked = true; throw Error('view admission failed');
  }) as typeof read);
  const remove = NativeHold.prototype.deleteEntry;
  t.mock.method(NativeHold.prototype, 'deleteEntry', function (this: NativeHold) {
    if (blocked) throw Error('view rollback failed');
    remove.call(this);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => use.bindView(scope), error => error instanceof AggregateError && /view admission failed/.test(error.message) && /view rollback failed/.test(error.message));
  } finally { blocked = false; badRead.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(pathExists(use.bindView(scope)));
  await use.release(); await pin.release();
});

await test('unknown reparse tags retain the owner marker and stop offline purge', nativeOnly, async t => {
  const f = await runtimeFixture(t); await (await f.prepare()).release();
  const path = join(f.cache, 'unknown-tag'); await writeFile(path, 'keep');
  const info = NativeHold.prototype.information;
  const hook = t.mock.method(NativeHold.prototype, 'information', function (this: NativeHold) {
    const observation = info.call(this);
    return this.path === path ? { ...observation, attributes: observation.attributes | 0x400, reparseTag: 0x80000009 } : observation;
  });
  try {
    await assert.rejects(purgeRuntimeCache(f.cache), /Unsupported reparse tag/);
    assert.ok(pathExists(join(f.cache, '.owner.json'))); assert.ok(pathExists(path));
  } finally { hook.mock.restore(); }
  await purgeRuntimeCache(f.cache);
});

await test('an image mapped from the cache blocks purge until its mapping closes', nativeOnly, async t => {
  const f = await runtimeFixture(t); await (await f.prepare()).release();
  const image = join(f.cache, 'mapped.dll');
  fs.copyFileSync(join(process.env.SystemRoot!, 'System32/version.dll'), image);
  const k = koffi.load('kernel32.dll'), load = k.func('void * LoadLibraryExW(str16,void*,uint32)'), free = k.func('int FreeLibrary(void*)');
  const mapping = load(image, null, 1); assert.ok(mapping);
  try {
    await assert.rejects(purgeRuntimeCache(f.cache), error => [5, 32, 1224].includes((error as { win32Code: number }).win32Code));
    assert.ok(pathExists(join(f.cache, '.owner.json'))); assert.ok(pathExists(image));
  } finally { assert.ok(free(mapping)); }
  await purgeRuntimeCache(f.cache);
});

await test('failed directory admission and rollback preserve both causes', nativeOnly, async t => {
  const f = await runtimeFixture(t), root = admitDirectory(f.directory), path = join(root.path, 'rollback');
  const info = NativeHold.prototype.information;
  const failure = Error('new directory admission failed');
  t.mock.method(NativeHold.prototype, 'information', function (this: NativeHold) {
    if (this.path === path) { fs.writeFileSync(join(path, 'obstruction'), 'owned'); throw failure; }
    return info.call(this);
  });
  assert.throws(() => createDirectory(root, 'rollback'), e => e instanceof AggregateError && e.errors.length === 2
    && e.errors[0] === failure && e.errors[1].win32Code === 145);
  t.mock.restoreAll();
});
