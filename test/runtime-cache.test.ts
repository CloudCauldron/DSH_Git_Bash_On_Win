import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { cp, link, mkdir, readFile, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { nativeOnly, runtimeFixture } from './fixtures.ts';
import { prepareRuntime, purgeRuntimeCache } from '../src/runtime/runtime-cache.ts';
import { anchorPaths, discoverGitInstallation, inventoryGitFiles, linkFreshTree } from '../src/runtime/git-installation.ts';
import {
  acquireWriterLock, admitDirectory, createDirectory, createJunction, NativeHold,
  pathExists, removeTree, unlinkEntry,
} from '../src/runtime/ntfs-filesystem.ts';

await test('F1 refuses markerless and unrecognized roots before mutation or purge', nativeOnly, async t => {
  const fixture = await runtimeFixture(t);
  await mkdir(fixture.cache);
  await writeFile(join(fixture.cache, 'sentinel'), 'retain');
  await assert.rejects(fixture.prepare());
  await assert.rejects(purgeRuntimeCache(fixture.cache));
  assert.deepEqual(readdirSync(fixture.cache), ['sentinel']);
  await writeFile(join(fixture.cache, '.owner.json'), JSON.stringify({ schemaVersion: 1 }));
  await assert.rejects(fixture.prepare());
  await assert.rejects(purgeRuntimeCache(fixture.cache));
  assert.equal(await readFile(join(fixture.cache, 'sentinel'), 'utf8'), 'retain');
  // Explicitly owned test scratch, never adopted by production cache admission.
  removeTree(admitDirectory(fixture.directory), 'cache');
});

await test('root identity, source overlap and reparse ancestors are admission errors', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  await pin.release();
  const markerPath = join(fixture.cache, '.owner.json'), marker = await readFile(markerPath, 'utf8');
  await writeFile(markerPath, JSON.stringify({ ...JSON.parse(marker) as object, fileId: '0' }));
  await assert.rejects(fixture.prepare(), /ownership/);
  await assert.rejects(purgeRuntimeCache(fixture.cache), /ownership/);
  await writeFile(markerPath, marker);
  await assert.rejects(prepareRuntime({ ...fixture.request, cacheDirectory: join(fixture.source, 'cache') }, new AbortController().signal), /overlap/);
  assert.equal(pathExists(join(fixture.source, 'cache')), false);
  const alias = join(fixture.directory, 'alias');
  await symlink(fixture.cache, alias, 'junction');
  await assert.rejects(purgeRuntimeCache(alias), /reparse/);
  await assert.rejects(prepareRuntime({ ...fixture.request, cacheDirectory: join(alias, 'nested') }, new AbortController().signal), /reparse/);
  assert.equal(pathExists(join(fixture.cache, 'nested')), false);
});

await test('an unsafe writer-lock object is refused without a contention wait or target cleanup', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  await pin.release();
  await writeFile(join(fixture.workspace, 'sentinel'), 'keep');
  await symlink(fixture.workspace, join(fixture.cache, '.writer-lock'), 'junction');
  await assert.rejects(purgeRuntimeCache(fixture.cache), /reparse/);
  assert.equal(await readFile(join(fixture.workspace, 'sentinel'), 'utf8'), 'keep');
  unlinkEntry(admitDirectory(fixture.cache), '.writer-lock');
});

await test('source inventory retains distinct hardlink names and the fixed selection policy', nativeOnly, async t => {
  const fixture = await runtimeFixture(t, 'mingw64');
  assert.deepEqual(discoverGitInstallation(fixture.request.gitBashPath), { root: fixture.source, layout: 'mingw64' });
  const files = await inventoryGitFiles(fixture.source, () => {});
  assert.ok(files.includes('usr/bin/bash.exe') && files.includes('usr/bin/sh.exe'));
  assert.ok(files.includes('usr/lib/perl/module.pm'));
  assert.equal(files.some(path => path.includes('ignored') || path.endsWith('winpty.lib')), false);
  const parent = admitDirectory(fixture.directory), base = createDirectory(parent, 'links');
  await linkFreshTree({ sourceRoot: fixture.source, baseRoot: base.path, files }, () => {});
  assert.equal((await stat(join(base.path, 'usr/bin/bash.exe'))).ino, (await stat(join(fixture.source, 'usr/bin/bash.exe'))).ino);
  await assert.rejects(linkFreshTree({ sourceRoot: fixture.source, baseRoot: base.path, files }, () => {}), /EEXIST/);
  for (const paths of [['../outside'], ['usr/bin/bash.exe', 'usr/bin/BASH.EXE'], ['usr/bin/../escape']]) {
    await assert.rejects(linkFreshTree({ sourceRoot: fixture.source, baseRoot: base.path, files: paths }, () => {}), /Invalid|Duplicate/);
  }
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(inventoryGitFiles(fixture.source, () => cancelled.signal.throwIfAborted()), { name: 'AbortError' });
  removeTree(parent, 'links');
});

await test('structural and read-only source failures never create an elevated attempt', nativeOnly, async t => {
  const fixture = await runtimeFixture(t);
  await symlink(fixture.workspace, join(fixture.source, 'usr/lib/redirected'), 'junction');
  await assert.rejects(fixture.prepare(), /reparse/);
  assert.deepEqual(readdirSync(join(fixture.cache, 'generations')), []);
  unlinkEntry(admitDirectory(join(fixture.source, 'usr/lib')), 'redirected');
  // Change only this owned fixture, then restore it before strict teardown.
  const bash = join(fixture.source, 'usr/bin/bash.exe');
  execFileSync('attrib.exe', ['+R', bash]);
  try {
    await assert.rejects(fixture.prepare(), /read-only/);
    assert.deepEqual(readdirSync(join(fixture.cache, 'generations')), []);
    assert.equal(pathExists(join(fixture.cache, 'current.json')), false);
  } finally { execFileSync('attrib.exe', ['-R', bash]); }
});

await test('cold commit, ownerless warm reuse, immutable expectations and explicit rebuild', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), sourceFile = join(fixture.source, 'usr/bin/bash.exe');
  const content = await readFile(sourceFile), links = (await stat(sourceFile)).nlink;
  const acl = execFileSync('icacls.exe', [sourceFile], { encoding: 'utf8' });
  const cold = await fixture.prepare(), initial = await fixture.current();
  const generation = join(fixture.cache, 'generations', initial.generationId);
  assert.deepEqual(readdirSync(generation), ['base']);
  assert.equal((await stat(sourceFile)).nlink, links + 2);
  await cold.release();
  const before = readdirSync(fixture.cache).sort();
  const root = admitDirectory(fixture.cache), writer = await acquireWriterLock(root, new AbortController().signal);
  const started = performance.now();
  let warm;
  try { warm = await fixture.prepare(false, AbortSignal.timeout(5000)); }
  finally { writer.close(); }
  t.diagnostic(`Fixture metadata/anchor warm path: ${(performance.now() - started).toFixed(2)} ms (not a latency guarantee).`);
  assert.equal((await fixture.current()).generationId, initial.generationId);
  assert.deepEqual(readdirSync(fixture.cache).sort(), before);
  assert.deepEqual(readdirSync(generation), ['base']);
  await warm.release();
  await unlink(join(generation, 'base/usr/lib/perl/module.pm'));
  const bounded = await fixture.prepare();
  assert.equal((await fixture.current()).generationId, initial.generationId, 'non-anchor damage is outside warm freshness');
  await bounded.release();
  const rebuilt = await fixture.prepare(true);
  const replacement = await fixture.current();
  assert.notEqual(replacement.generationId, initial.generationId);
  assert.ok(pathExists(join(fixture.cache, 'generations', replacement.generationId, 'base/usr/lib/perl/module.pm')));
  await rebuilt.release();
  await purgeRuntimeCache(fixture.cache);
  assert.equal(pathExists(fixture.cache), false);
  assert.equal((await stat(sourceFile)).nlink, links);
  assert.deepEqual(await readFile(sourceFile), content);
  assert.equal(execFileSync('icacls.exe', [sourceFile], { encoding: 'utf8' }), acl);
});

await test('warm admission compares source and base to saved stamps, not only to each other', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), first = await fixture.prepare();
  const old = await fixture.current();
  await first.release();
  await writeFile(join(fixture.source, 'etc/profile'), 'shared in-place update with different size');
  const next = await fixture.prepare();
  const current = await fixture.current();
  assert.notEqual(current.generationId, old.generationId);
  assert.notDeepEqual(current.anchors.profile, old.anchors.profile);
  await next.release();
  // Replacing a source name also changes eligibility, without rewriting old records.
  await rename(join(fixture.source, 'etc/profile'), join(fixture.source, 'etc/old-profile'));
  await writeFile(join(fixture.source, 'etc/profile'), 'new source identity');
  const third = await fixture.prepare();
  assert.notEqual((await fixture.current()).generationId, current.generationId);
  await third.release();
});

await test('concurrent preparations recheck under the writer lock and own independent pins', nativeOnly, async t => {
  const fixture = await runtimeFixture(t);
  const [first, second] = await Promise.all([fixture.prepare(), fixture.prepare()]);
  assert.equal(readdirSync(join(fixture.cache, 'generations')).length, 1);
  await first.release();
  await assert.rejects(purgeRuntimeCache(fixture.cache));
  await second.release();
  const id = (await fixture.current()).generationId;
  const alias = await prepareRuntime({ ...fixture.request, gitBashPath: fixture.request.gitBashPath!.toUpperCase() }, new AbortController().signal);
  try { assert.equal((await fixture.current()).generationId, id); } finally { await alias.release(); }
});

await test('a writer-close failure reports failure and does not leak the unpublished return value', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), original = NativeHold.prototype.close;
  let injected = false;
  const mock = t.mock.method(NativeHold.prototype, 'close', function (this: NativeHold) {
    original.call(this);
    if (!injected && this.path.endsWith('\\.writer-lock')) { injected = true; throw new Error('injected checked-close failure'); }
  });
  await assert.rejects(fixture.prepare(), /checked-close failure/);
  mock.mock.restore();
  assert.equal(injected, true);
  // Publication may already have committed, but the rejected operation owns no pin.
  await purgeRuntimeCache(fixture.cache);
});

await test('safe malformed current rebuilds; extra fields are ignored; unsafe controls fail', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  await pin.release();
  const previous = await fixture.current();
  await writeFile(join(fixture.cache, 'current.json'), JSON.stringify({ ...previous, irrelevant: { path: 'outside' } }));
  const warm = await fixture.prepare();
  assert.equal((await fixture.current()).generationId, previous.generationId);
  await warm.release();
  await writeFile(join(fixture.cache, 'current.json'), '{malformed');
  const rebuilt = await fixture.prepare();
  assert.notEqual((await fixture.current()).generationId, previous.generationId);
  await rebuilt.release();
  await unlink(join(fixture.cache, 'current.json'));
  await mkdir(join(fixture.cache, 'current.json'));
  await assert.rejects(fixture.prepare(), /ordinary file/);
});

await test('purge owns the entire interior but removes junctions without visiting targets', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  await pin.release();
  const outside = join(fixture.directory, 'outside');
  await mkdir(outside); await writeFile(join(outside, 'sentinel'), 'keep');
  await mkdir(join(fixture.cache, 'unexpected directory'));
  await link(join(fixture.source, 'etc/profile'), join(fixture.cache, 'unexpected directory/manual-link'));
  await symlink(outside, join(fixture.cache, 'outside-view'), 'junction');
  await symlink(outside, join(fixture.cache, 'generations', 'malformed-junction'), 'junction');
  await mkdir(join(fixture.cache, 'generations', 'not-an-id'));
  await writeFile(join(fixture.cache, 'generations', 'not-an-id', 'plan.json'), '{corrupt');
  await writeFile(join(fixture.cache, 'generations', 'not-an-id', 'payload'), 'owned');
  await purgeRuntimeCache(fixture.cache);
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'keep');
  assert.equal(pathExists(fixture.cache), false);
});

await test('a generations junction is removed as an object, never admitted as a runtime tree', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  await pin.release();
  const root = admitDirectory(fixture.cache);
  // Move owned generations aside; the entire root interior remains disposable.
  await rename(join(fixture.cache, 'generations'), join(fixture.cache, 'saved'));
  createJunction(root, 'generations', admitDirectory(fixture.workspace));
  await writeFile(join(fixture.workspace, 'sentinel'), 'keep');
  await assert.rejects(fixture.prepare(), /reparse/);
  await purgeRuntimeCache(fixture.cache);
  assert.equal(await readFile(join(fixture.workspace, 'sentinel'), 'utf8'), 'keep');
});

await test('dynamic generations container has no historical file identity in the marker', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), first = await fixture.prepare();
  await first.release();
  const marker = readFileSync(join(fixture.cache, '.owner.json'), 'utf8');
  const root = admitDirectory(fixture.cache);
  // No pins remain. Emulate offline removal of the old disposable payload.
  removeTree(root, 'generations');
  unlinkEntry(root, 'current.json');
  const second = await fixture.prepare();
  assert.equal(readFileSync(join(fixture.cache, '.owner.json'), 'utf8'), marker);
  await second.release();
});

await test('cancellation during a bounded linking batch drains before cleanup and leaves no current', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), controller = new AbortController();
  const original = NativeHold.prototype.information;
  const mock = t.mock.method(NativeHold.prototype, 'information', function (this: NativeHold) {
    const result = original.call(this);
    if (this.path.includes('\\base\\usr\\bin\\bash.exe')) controller.abort();
    return result;
  });
  await assert.rejects(fixture.prepare(false, controller.signal), { name: 'AbortError' });
  mock.mock.restore();
  assert.equal(pathExists(join(fixture.cache, 'current.json')), false);
  assert.equal(pathExists(join(fixture.cache, '.writer-lock')), false);
  assert.deepEqual(readdirSync(join(fixture.cache, 'generations')), []);
  assert.ok(Object.values(anchorPaths('ucrt64')).every(path => pathExists(join(fixture.source, path))));
  // Cancellation does not retain a failed-readiness slot at the factory boundary.
  const pin = await fixture.prepare(); await pin.release();
});

await test('packaged cleanup strictly purges isolated profile and fallback caches', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), profile = await fixture.prepare();
  await profile.release();
  const packageRoot = join(fixture.directory, 'package');
  await mkdir(packageRoot);
  const repository = fileURLToPath(new URL('../', import.meta.url));
  await cp(join(repository, 'lib'), join(packageRoot, 'lib'), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), '{"type":"module"}');
  await symlink(join(repository, 'node_modules'), join(packageRoot, 'node_modules'), 'junction');
  const fallbackPath = join(packageRoot, '.runtime');
  const fallback = await fixture.prepare(false, new AbortController().signal, fallbackPath);
  await fallback.release();
  const cleanup = spawnSync(process.execPath, [join(packageRoot, 'lib/cleanup.js'), fixture.cache], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(cleanup.error, undefined);
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(pathExists(fixture.cache), false);
  assert.equal(pathExists(fallbackPath), false);
  assert.equal((await stat(join(fixture.source, 'usr/bin/bash.exe'))).nlink, 2);
});
