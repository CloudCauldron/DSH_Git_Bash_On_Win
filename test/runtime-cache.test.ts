import { createHash } from 'node:crypto';
import { Win32Error } from '@deepseek-ai/dsh-win32-process';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import fs, { readFileSync, readdirSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { link, mkdir, readFile, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, toNamespacedPath } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';
import { blockFile, nativeOnly, runtimeFixture, readAclRecords } from './fixtures.ts';
import { patchMsysDll } from '../src/runtime/pe.ts';
import { bundledShimUrl, prepareRuntime, purgeRuntimeCache } from '../src/runtime/runtime-cache.ts';
import { admitCopyJunctions, buildCopyLayout, discoverGitInstallation, requireViewPathBudget } from '../src/runtime/git-installation.ts';
import {
  absolutePath, acquireWriterLock, admitDirectory, admitJunction, createDirectory, createJunction, NativeHold,
  hasCloseFailure, isBusy, openOrdinaryFile, pathExists, pinDirectory, readFileBytes, removeTree, unlinkEntry, writeNewFile,
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

await test('successive native path reads retain exact Unicode and shorter strings', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  await pin.release();
  const longer = join(fixture.cache, '較長的路徑 含空格 😀');
  await mkdir(longer);
  const first = admitDirectory(longer).path;
  const second = admitDirectory(fixture.cache).path;
  assert.deepEqual([first, second], [longer, fixture.cache]);
});

await test('cancelling a contended writer preserves the reason used to retire shared preparation', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), controller = new AbortController();
  const owner = await acquireWriterLock(fixture.cache, controller.signal);
  try {
    await assert.rejects(purgeRuntimeCache(fixture.cache));
    assert.equal(pathExists(fixture.cache), false);
    const reason = new Error('selection superseded');
    const waiting = acquireWriterLock(fixture.cache, controller.signal);
    controller.abort(reason);
    await assert.rejects(waiting, error => error === reason);
  } finally { owner.close(); }
});

await test('preparation promptly refuses an unlocked writer-lock file and preserves it', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), lockPath = fixture.cache + '.writer-lock';
  await writeFile(lockPath, 'unowned');
  try {
    await assert.rejects(prepareRuntime(fixture.request, AbortSignal.timeout(2000)),
      error => [80, 183].includes((error as { win32Code: number }).win32Code));
    assert.equal(await readFile(lockPath, 'utf8'), 'unowned');
    assert.equal(pathExists(fixture.cache), false);
  } finally { await unlink(lockPath); }
});

await test('an unsafe writer-lock object is refused without a contention wait or target cleanup', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  await pin.release();
  await writeFile(join(fixture.workspace, 'sentinel'), 'keep');
  await symlink(fixture.workspace, fixture.cache + '.writer-lock', 'junction');
  await assert.rejects(purgeRuntimeCache(fixture.cache), /reparse/);
  assert.equal(await readFile(join(fixture.workspace, 'sentinel'), 'utf8'), 'keep');
  unlinkEntry(admitDirectory(fixture.directory), 'cache.writer-lock');
});

await test('discovery skips missing or incomplete defaults without hiding selection or IO errors', nativeOnly, async t => {
  const fixture = await runtimeFixture(t);
  const stale = join(fixture.directory, 'stale'), valid = join(fixture.directory, 'valid');
  await mkdir(join(stale, 'Git/bin'), { recursive: true });
  await writeFile(join(stale, 'Git/bin/bash.exe'), 'incomplete installation');
  await writeFile(join(stale, 'Git/ucrt64'), 'unrelated root file');
  await mkdir(valid);
  await symlink(fixture.source, join(valid, 'Git'), 'junction');
  const keys = ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'];
  const saved = keys.map(key => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    process.env.ProgramW6432 = stale; process.env.ProgramFiles = valid;
    assert.equal(discoverGitInstallation().root, fixture.source);

    const candidate = join(stale, 'Git/bin/bash.exe');
    const malformedEtc = join(stale, 'Git/etc');
    await writeFile(malformedEtc, 'ordinary file');
    assert.equal(discoverGitInstallation().root, fixture.source);
    assert.throws(() => discoverGitInstallation(candidate), /ordinary directory/);
    await unlink(malformedEtc);
    await unlink(candidate);
    // A dangling junction exercises native reparse resolution without requiring
    // file-symlink privileges or changing any installed Git directory.
    await symlink(join(fixture.directory, 'missing'), candidate, 'junction');
    assert.ok(pathExists(candidate), 'the broken candidate must pass lstat admission');
    assert.equal(discoverGitInstallation().root, fixture.source);
    assert.throws(() => discoverGitInstallation(candidate), { code: 'ENOENT' });

    const original = fs.realpathSync;
    for (const code of ['EACCES', 'ELOOP']) {
      const failure = Object.assign(new Error(`fixture discovery ${code}`), { code });
      const mock = t.mock.method(fs, 'realpathSync', ((...args: Parameters<typeof fs.realpathSync>) => {
        if (args[0] === candidate) throw failure;
        return original(...args);
      }) as typeof fs.realpathSync);
      syncBuiltinESMExports();
      try {
        assert.throws(() => discoverGitInstallation(), error => error === failure);
        assert.throws(() => discoverGitInstallation(candidate), error => error === failure);
      } finally { mock.mock.restore(); syncBuiltinESMExports(); }
    }

    delete process.env.ProgramFiles;
    assert.throws(() => discoverGitInstallation(), /^Error: Supported Git for Windows was not found\./);
    unlinkEntry(admitDirectory(dirname(candidate)), 'bash.exe');
    assert.throws(() => discoverGitInstallation(), /^Error: Supported Git for Windows was not found\./);
  } finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
  }
  await writeFile(join(fixture.source, 'etc/bash.exe'), 'not a supported entry');
  assert.throws(() => discoverGitInstallation(join(fixture.source, 'etc/bash.exe')), /Supported Git/);
});

await test('ordinary paths require a volume root and current metadata keeps canonical syntax', nativeOnly, async t => {
  for (const path of ['\\relative-to-drive', '/relative-to-drive', 'C:relative']) assert.throws(() => absolutePath(path), /absolute Windows path/);
  const fixture = await runtimeFixture(t), first = await fixture.prepare();
  await first.release();
  const current = await fixture.current();
  await writeFile(join(fixture.cache, 'current.json'), JSON.stringify({ ...current, sourceRoot: current.sourceRoot.replaceAll('\\', '/') }));
  const rebuilt = await fixture.prepare();
  assert.notEqual((await fixture.current()).generationId, current.generationId);
  await rebuilt.release();
});

await test('root creation unwinds an empty directory when its ownership-marker write fails', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), original = fs.writeFileSync;
  const mock = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    if (typeof args[0] === 'number') { original(args[0], '{'); throw new Error('fixture ownership write failure'); }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(fixture.prepare(), /fixture ownership write failure/);
    assert.equal(pathExists(fixture.cache), false);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  const pin = await fixture.prepare(); await pin.release();
});

await test('an owner marker that grows during the optimistic read is rechecked under the lock', nativeOnly, async t => {
  const f = await runtimeFixture(t);
  await (await f.prepare()).release();
  const selected = await f.current(), path = join(f.cache, '.owner.json'), marker = await readFile(path);
  const information = NativeHold.prototype.information, lockedReads: boolean[] = [];
  const hook = t.mock.method(NativeHold.prototype, 'information', function (this: NativeHold) {
    const info = information.call(this);
    if (this.path === path) {
      lockedReads.push(pathExists(f.cache + '.writer-lock'));
      if (info.size === '0') fs.writeFileSync(path, marker);
    }
    return info;
  });
  try {
    await writeFile(path, '');
    await (await f.prepare()).release();
    assert.deepEqual(lockedReads, [false, true]);
    assert.deepEqual(await f.current(), selected);
    await writeFile(path, Buffer.alloc(256 * 1024 + 1));
    await assert.rejects(f.prepare(), /262145/);
    assert.deepEqual(lockedReads.slice(2), [false, true]);
    assert.equal((await stat(path)).size, 256 * 1024 + 1);
  } finally { hook.mock.restore(); await writeFile(path, marker); }
});

await test('cancellation before atomic publication preserves the selected generation', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), first = await fixture.prepare();
  await first.release();
  const before = await fixture.current(), controller = new AbortController();
  const original = NativeHold.prototype.canonicalPath;
  let cancelled = false;
  const mock = t.mock.method(NativeHold.prototype, 'canonicalPath', function (this: NativeHold) {
    const path = original.call(this);
    // Cancel at fresh pin acquisition, after final admission but before writing.
    if (dirname(this.path) === join(fixture.cache, 'g') && pathExists(join(this.path, 'r/bin'))) {
      cancelled = true; controller.abort();
    }
    return path;
  });
  try { await assert.rejects(fixture.prepare(true, controller.signal), { name: 'AbortError' }); }
  finally { mock.mock.restore(); }
  assert.ok(cancelled, 'cancellation must reach the last pre-publication boundary');
  assert.deepEqual(await fixture.current(), before);
  assert.deepEqual(readdirSync(join(fixture.cache, 'g')), [before.generationId]);
  assert.equal(pathExists(fixture.cache + '.writer-lock'), false);
  await purgeRuntimeCache(fixture.cache);
});

await test('atomic publication returns its pinned generation despite cancellation during the write', nativeOnly, async t => {
  for (const rebuild of [false, true]) await t.test(rebuild ? 'replacement' : 'first publication', async t => {
    const fixture = await runtimeFixture(t), controller = new AbortController();
    const sourceFile = join(fixture.source, 'usr/bin/bash.exe'), links = (await stat(sourceFile)).nlink;
    if (rebuild) { const first = await fixture.prepare(); await first.release(); }
    const before = rebuild ? await fixture.current() : undefined;
    const original = fsp.mkdir;
    let entered = false;
    const mock = t.mock.method(fsp, 'mkdir', ((...args: Parameters<typeof fsp.mkdir>) => {
      // The public writer's first asynchronous operation precedes its temp write
      // and rename. Exercise the whole non-cancellable phase, not just post-commit.
      if (args[0] === fixture.cache) {
        entered = true;
        assert.equal(pathExists(join(fixture.cache, 'current.json')), rebuild);
        controller.abort();
      }
      return original(...args);
    }) as typeof fsp.mkdir);
    syncBuiltinESMExports();
    try {
      const pin = await fixture.prepare(rebuild, controller.signal);
      assert.ok(entered && controller.signal.aborted);
      const published = await fixture.current();
      assert.notEqual(published.generationId, before?.generationId);
      assert.equal(pathExists(fixture.cache + '.writer-lock'), false);
      const use = pin.acquireUse();
      try { assert.equal(fs.realpathSync.native(use.bindView({ workspace: fixture.workspace, prefix: 'ro' })), join(fixture.cache, 'g', published.generationId, 'r')); }
      finally { await use.release(); }
      await assert.rejects(purgeRuntimeCache(fixture.cache), isBusy);
      await pin.release();
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
    await purgeRuntimeCache(fixture.cache);
    assert.equal((await stat(sourceFile)).nlink, links);
  });
});

await test('an atomic write failure after cancellation remains an IO failure and preserves current', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), first = await fixture.prepare();
  await first.release();
  const before = await fixture.current(), controller = new AbortController();
  const original = fsp.rename, failure = Object.assign(new Error('fixture publication IO failure'), { code: 'EIO' });
  let attempted = false;
  const mock = t.mock.method(fsp, 'rename', async (...args: Parameters<typeof fsp.rename>) => {
    if (args[1] === join(fixture.cache, 'current.json')) {
      attempted = true; controller.abort();
      throw failure;
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(fixture.prepare(true, controller.signal), error => error === failure); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(attempted && controller.signal.aborted);
  assert.deepEqual(await fixture.current(), before);
  assert.deepEqual(readdirSync(join(fixture.cache, 'g')), [before.generationId]);
  assert.deepEqual(readdirSync(fixture.cache).sort(), ['.owner.json', 'current.json', 'g']);
  await purgeRuntimeCache(fixture.cache);
});

await test('concurrent preparations recheck under the writer lock and own independent pins', nativeOnly, async t => {
  const fixture = await runtimeFixture(t);
  const [first, second] = await Promise.all([fixture.prepare(), fixture.prepare()]);
  assert.equal(readdirSync(join(fixture.cache, 'g')).length, 1);
  await first.release();
  await assert.rejects(purgeRuntimeCache(fixture.cache));
  await second.release();
  const id = (await fixture.current()).generationId;
  const alias = await prepareRuntime({ ...fixture.request, gitBashPath: fixture.request.gitBashPath!.toUpperCase() }, new AbortController().signal);
  try { assert.equal((await fixture.current()).generationId, id); } finally { await alias.release(); }
});

await test('independent processes converge on cold start and after a Git-only update with separate views', nativeOnly, async t => {
  const fixture = await runtimeFixture(t);
  const program = `
    const [module, cacheDirectory, gitBashPath, workspaceRoot] = process.argv.slice(1);
    const { prepareRuntime } = await import(module);
    const signal = AbortSignal.timeout(15_000);
    const pin = await prepareRuntime({ cacheDirectory, gitBashPath }, signal);
    try {
      const use = pin.acquireUse();
      try { console.log(use.bindView({ workspace: workspaceRoot, prefix: 'ro', sessionId: 'shared-id' })); }
      finally { await use.release(); }
    } finally { await pin.release(); }
  `;
  const worker = () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', program,
    new URL('../src/runtime/runtime-cache.ts', import.meta.url).href, fixture.cache, fixture.request.gitBashPath!, fixture.workspace],
  { timeout: 20_000 });
  async function prepareBoth() {
    const results = await Promise.allSettled([worker(), worker()]);
    const [first, second] = results.map(result => {
      if (result.status === 'rejected') throw result.reason;
      return result.value.stdout.trim();
    });
    const { generationId } = await fixture.current();
    assert.equal(dirname(first!), join(fixture.cache, 'g', generationId, 'v'));
    assert.equal(dirname(second!), dirname(first!));
    assert.notEqual(first, second);
    assert.deepEqual(readdirSync(join(fixture.cache, 'g')), [generationId]);
    return generationId;
  }
  const cold = await prepareBoth();
  await writeFile(join(fixture.source, 'ucrt64/bin/git.exe'), 'updated Git');
  assert.notEqual(await prepareBoth(), cold);
});

await test('a failed guard close releases the pending lease or generation pin', nativeOnly, async t => {
  for (const guard of ['lock parent', 'root', 'writer']) await t.test(guard, async t => {
    const fixture = await runtimeFixture(t), original = NativeHold.prototype.close;
    const lock = fixture.cache + '.writer-lock', current = join(fixture.cache, 'current.json');
    let injected = false;
    const mock = t.mock.method(NativeHold.prototype, 'close', function (this: NativeHold) {
      original.call(this);
      const ready = guard === 'lock parent' ? this.path === fixture.directory && pathExists(lock)
        : this.path === (guard === 'writer' ? lock : fixture.cache) && pathExists(current);
      if (!injected && ready) { injected = true; throw new Error('fixture checked-close failure'); }
    });
    try { await assert.rejects(fixture.prepare(), /checked-close failure/); }
    finally { mock.mock.restore(); }
    assert.equal(injected, true);
    assert.equal(pathExists(lock), false);
    await purgeRuntimeCache(fixture.cache);
  });
});

await test('case-only renames preserve ownership and the selected generation through failed operations', nativeOnly, async t => {
  const fixture = await runtimeFixture(t);
  await (await fixture.prepare()).release();
  const current = await fixture.current(), generations = join(fixture.cache, 'g');
  const selected = join(generations, current.generationId.toUpperCase());
  await rename(join(generations, current.generationId), selected);
  await rename(join(fixture.cache, '.owner.json'), join(fixture.cache, '.OWNER.JSON'));
  const invalid = join(fixture.source, 'usr/bin/dsh-msys-compat.dll');
  await writeFile(invalid, 'collision');
  await assert.rejects(fixture.prepare(true), /Unsupported Git runtime entry/);
  await unlink(invalid);
  assert.deepEqual(await fixture.current(), current);
  assert.ok(pathExists(join(selected, 'r/usr/bin/bash.exe')));
  await writeFile(join(fixture.cache, 'zz-busy'), 'held');
  const blocker = blockFile(join(fixture.cache, 'zz-busy'));
  try {
    await assert.rejects(purgeRuntimeCache(fixture.cache), isBusy);
    assert.ok(pathExists(join(fixture.cache, '.OWNER.JSON')));
  } finally { blocker.close(); }
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

await test('a redirected dangling internal junction is an error, not a cold cache miss', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  await pin.release();
  const record = await fixture.current(), base = join(fixture.cache, 'g', record.generationId, 'r');
  unlinkEntry(admitDirectory(base), 'bin');
  await symlink(join(fixture.directory, 'missing'), join(base, 'bin'), 'junction');
  await assert.rejects(fixture.prepare(), /Unexpected runtime junction/);
  assert.equal((await fixture.current()).generationId, record.generationId);
});

await test('GC and purge own the entire interior but remove junctions without visiting targets', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), source = join(fixture.source, 'etc/profile');
  const originalLinks = (await stat(source)).nlink;
  const pin = await fixture.prepare();
  await pin.release();
  const generation = join(fixture.cache, 'g', (await fixture.current()).generationId);
  const outside = join(fixture.directory, 'outside');
  await mkdir(outside); await writeFile(join(outside, 'sentinel'), 'keep');
  const oldPlan = join(generation, 'plan.json');
  await mkdir(oldPlan);
  await link(source, join(oldPlan, 'manual-link'));
  await symlink(outside, join(oldPlan, 'outside-view'), 'junction');
  // Losing the selector makes this unpinned generation eligible for ordinary GC.
  await unlink(join(fixture.cache, 'current.json'));
  const recovered = await fixture.prepare();
  await recovered.release();
  assert.equal(pathExists(generation), false);
  assert.equal((await stat(source)).nlink, originalLinks, 'published copies have independent identities');
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'keep');

  const plan = join(fixture.cache, 'g', (await fixture.current()).generationId, 'plan.json');
  await mkdir(plan);
  await link(source, join(plan, 'manual-link'));
  await symlink(outside, join(plan, 'outside-view'), 'junction');
  await mkdir(join(fixture.cache, 'unexpected directory'));
  await link(source, join(fixture.cache, 'unexpected directory/manual-link'));
  await symlink(outside, join(fixture.cache, 'outside-view'), 'junction');
  await symlink(outside, join(fixture.cache, 'g', 'malformed-junction'), 'junction');
  await mkdir(join(fixture.cache, 'g', 'not-an-id'));
  await writeFile(join(fixture.cache, 'g', 'not-an-id', 'plan.json'), '{corrupt');
  await writeFile(join(fixture.cache, 'g', 'not-an-id', 'payload'), 'owned');
  await purgeRuntimeCache(fixture.cache);
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'keep');
  assert.equal(pathExists(fixture.cache), false);
  assert.equal((await stat(source)).nlink, originalLinks);
});

await test('purge reports a read-only cache file without altering source attributes', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  await pin.release();
  const source = join(fixture.cache, 'g', (await fixture.current()).generationId, 'r/usr/bin/bash.exe');
  const original = join(fixture.source, 'usr/bin/bash.exe'), originalLinks = (await stat(original)).nlink;
  execFileSync('attrib.exe', ['+R', source]);
  try {
    const readOnlyMode = (await stat(source)).mode;
    await assert.rejects(purgeRuntimeCache(fixture.cache), error => (error as { win32Code?: number }).win32Code === 5);
    assert.equal((await stat(source)).mode, readOnlyMode);
    assert.ok(pathExists(join(fixture.cache, '.owner.json')));
  } finally { execFileSync('attrib.exe', ['-R', source]); }
  await purgeRuntimeCache(fixture.cache);
  assert.equal((await stat(original)).nlink, originalLinks);
});

await test('purge addresses unusual enumerated NTFS names exactly and restores their hardlink counts', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), source = join(fixture.source, 'etc/profile');
  const originalLinks = (await stat(source)).nlink;
  const pin = await fixture.prepare(); await pin.release();
  const unusualGeneration = toNamespacedPath(join(fixture.cache, 'g', 'generation '));
  await mkdir(unusualGeneration);
  await link(source, join(unusualGeneration, 'payload.'));
  await link(source, toNamespacedPath(join(fixture.cache, 'manual ')));
  assert.ok(readdirSync(join(fixture.cache, 'g')).includes('generation '));
  assert.ok(readdirSync(unusualGeneration).includes('payload.'));
  await purgeRuntimeCache(fixture.cache);
  assert.equal(pathExists(fixture.cache), false);
  assert.equal((await stat(source)).nlink, originalLinks);
});

await test('a generations junction is removed as an object, never admitted as a runtime tree', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  await pin.release();
  const root = admitDirectory(fixture.cache);
  // Move owned generations aside; the entire root interior remains disposable.
  await rename(join(fixture.cache, 'g'), join(fixture.cache, 'saved'));
  createJunction(root, 'g', admitDirectory(fixture.workspace));
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
  removeTree(root, 'g');
  unlinkEntry(root, 'current.json');
  const second = await fixture.prepare();
  assert.equal(readFileSync(join(fixture.cache, '.owner.json'), 'utf8'), marker);
  await second.release();
});

async function copyFixture(t: TestContext) {
  const f = await runtimeFixture(t), parent = admitDirectory(f.directory);
  const shim = await readFile(bundledShimUrl);
  return { ...f, parent, shim, build(name: string, signal = t.signal) {
    const installation = discoverGitInstallation(f.request.gitBashPath);
    return buildCopyLayout(createDirectory(parent, name), installation, shim, signal);
  } };
}

await test('shallow copies preserve flat names and private bytes, junctions retain their admitted targets', nativeOnly, async t => {
  const f = await copyFixture(t);
  const emitted = await import(new URL('../lib/runtime/runtime-cache.js', import.meta.url).href) as { bundledShimUrl: URL };
  assert.equal(emitted.bundledShimUrl.href, bundledShimUrl.href);
  for (const path of ['usr/bin/core_perl', 'usr/bin/vendor_perl', 'usr/libexec', 'usr/ssl', 'extra']) {
    await mkdir(join(f.source, path), { recursive: true });
  }
  for (const path of ['dev', 'usr/tmp']) await symlink(f.workspace, join(f.source, path), 'junction');
  for (const path of ['root.txt', 'usr/ignored.txt', 'usr/bin/helper']) await writeFile(join(f.source, path), 'before');
  const { runtime, patchedMsysSha256 } = await f.build('one');
  const flat = join(runtime.path, 'usr/bin'), origin = join(f.source, 'usr/bin');
  assert.deepEqual(readdirSync(flat).sort(), [...readdirSync(origin), 'dsh-msys-compat.dll'].sort());
  const identities = new Set<bigint>();
  for (const entry of readdirSync(origin, { withFileTypes: true }).filter(e => e.isFile())) {
    const target = join(flat, entry.name), source = join(origin, entry.name);
    const stats = fs.lstatSync(target, { bigint: true });
    assert.ok(stats.isFile() && stats.nlink === 1n);
    assert.notEqual(stats.ino, fs.statSync(source, { bigint: true }).ino);
    assert.ok(!identities.has(stats.ino));
    identities.add(stats.ino);
    const bytes = readFileSync(target);
    if (entry.name === 'msys-2.0.dll') {
      assert.deepEqual(bytes, patchMsysDll(readFileSync(source)));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), patchedMsysSha256);
    } else assert.deepEqual(bytes, readFileSync(source));
  }
  assert.deepEqual(await readFile(join(flat, 'dsh-msys-compat.dll')), f.shim);
  assert.equal((await stat(join(flat, 'dsh-msys-compat.dll'))).nlink, 1);
  for (const path of ['bin', 'etc', 'ucrt64', 'extra', 'usr/share', 'usr/lib', 'usr/libexec', 'usr/ssl', 'usr/bin/core_perl', 'usr/bin/vendor_perl']) {
    assert.ok(fs.lstatSync(join(runtime.path, path)).isSymbolicLink());
    assert.equal(fs.realpathSync.native(join(runtime.path, path)), join(f.source, path));
  }
  for (const path of ['dev', 'usr/tmp', 'root.txt', 'usr/ignored.txt']) assert.equal(pathExists(join(runtime.path, path)), false);
  assert.deepEqual(readdirSync(join(f.directory, 'one/v')), []);
  await writeFile(join(origin, 'helper'), 'edited');
  await rename(join(origin, 'helper'), join(origin, 'retired'));
  await writeFile(join(origin, 'helper'), 'replacement');
  assert.equal(await readFile(join(flat, 'helper'), 'utf8'), 'before');
  const source = admitDirectory(f.source);
  admitCopyJunctions(runtime, source, 'ucrt64');
  for (const name of ['bin', 'etc', 'ucrt64']) {
    unlinkEntry(runtime, name);
    createJunction(runtime, name, admitDirectory(f.workspace));
    assert.throws(() => admitCopyJunctions(runtime, source, 'ucrt64'), /Unexpected runtime junction/);
    unlinkEntry(runtime, name);
    createJunction(runtime, name, admitDirectory(join(f.source, name)));
  }
  const nativeBin = admitDirectory(join(f.source, 'bin'));
  const alternate = createJunction(f.parent, 'also-bin', nativeBin);
  unlinkEntry(runtime, 'bin');
  await symlink(alternate, join(runtime.path, 'bin'), 'junction');
  assert.equal(fs.realpathSync.native(join(runtime.path, 'bin')), join(f.source, 'bin'));
  assert.throws(() => admitCopyJunctions(runtime, source, 'ucrt64'), /Unexpected runtime junction/);
  unlinkEntry(runtime, 'bin');
  createJunction(runtime, 'bin', nativeBin);
  await unlink(join(nativeBin.path, 'bash.exe'));
  assert.throws(() => admitCopyJunctions(runtime, source, 'ucrt64'), { api: 'CreateFileW', win32Code: 2 });
  await rename(nativeBin.path, nativeBin.path + '-moved');
  assert.throws(() => admitJunction(runtime, 'bin', nativeBin), /Unexpected runtime junction/);
  removeTree(f.parent, 'one');
  assert.equal(await readFile(join(origin, 'helper'), 'utf8'), 'replacement');
});

await test('junction admission uses NTFS identity across case spellings and rejects intermediate reparses', nativeOnly, async t => {
  const f = await runtimeFixture(t), root = admitDirectory(f.directory);
  const ascii = createDirectory(root, 'K'), kelvin = createDirectory(root, 'K');
  const expected = createDirectory(ascii, 'bin'), other = createDirectory(kelvin, 'bin');
  assert.equal(expected.path.toLowerCase(), other.path.toLowerCase());
  assert.notEqual(expected.fileId, other.fileId);
  createJunction(root, 'view', other);
  assert.throws(() => admitJunction(root, 'view', expected), /Unexpected runtime junction/);
  unlinkEntry(root, 'view');
  removeTree(root, 'K');
  createJunction(root, 'K', ascii);
  await symlink(other.path, join(root.path, 'view'), 'junction');
  assert.throws(() => admitJunction(root, 'view', expected), /Unexpected runtime junction/);
  unlinkEntry(root, 'view');
  const spelling = join(root.path, 'k', 'BIN');
  await symlink(spelling, join(root.path, 'view'), 'junction');
  admitJunction(root, 'view', expected);
  const close = NativeHold.prototype.close, fault = new Win32Error('CloseHandle', 6, spelling);
  const mock = t.mock.method(NativeHold.prototype, 'close', function (this: NativeHold) {
    close.call(this);
    if (this.path === spelling) throw fault;
  });
  try { assert.throws(() => admitJunction(root, 'view', expected), error => error === fault); }
  finally { mock.mock.restore(); }
  await rename(expected.path, expected.path + '-saved');
  await mkdir(expected.path);
  assert.throws(() => admitJunction(root, 'view', expected), /Unexpected runtime junction/);
});

await test('both Bash entry points require ordinary etc, bin and the native wrapper before construction', nativeOnly, async t => {
  const f = await copyFixture(t);
  const selection = discoverGitInstallation(f.request.gitBashPath);
  const wrapperTarget = join(f.workspace, 'bash.exe');
  await mkdir(wrapperTarget);
  for (const path of ['etc', 'bin', 'bin/bash.exe', selection.layout]) {
    const original = join(f.source, path), moved = original + '.saved';
    await rename(original, moved);
    for (const kind of ['missing', 'junction', 'wrong type']) {
      if (kind === 'junction') await symlink(path === 'bin/bash.exe' ? wrapperTarget : moved, original, 'junction');
      if (kind === 'wrong type') {
        if (path === 'bin/bash.exe') await mkdir(original);
        else await writeFile(original, 'ordinary file');
      }
      const structuralError = kind === 'junction' ? { message: `Refusing reparse point: ${original}` }
        : { message: `Expected ordinary ${path === 'bin/bash.exe' ? 'file' : 'directory'}: ${original}` };
      for (const entry of ['bin/bash.exe', 'usr/bin/bash.exe']) {
        const notFound = kind === 'missing' || (kind === 'wrong type'
          && (path === selection.layout || (path === 'bin' && entry === 'bin/bash.exe')));
        assert.throws(() => discoverGitInstallation(join(f.source, entry)), notFound ? /Supported Git for Windows was not found/ : structuralError);
      }
      const generation = createDirectory(f.parent, 'pending');
      await assert.rejects(buildCopyLayout(generation, selection, f.shim, t.signal),
        kind === 'missing' ? { api: 'CreateFileW', win32Code: 2 } : structuralError);
      assert.deepEqual(readdirSync(generation.path), []);
      removeTree(f.parent, 'pending');
      if (kind !== 'missing') removeTree(admitDirectory(dirname(original)), path.split('/').at(-1)!);
    }
    await rename(moved, original);
  }
  assert.equal(pathExists(f.cache), false);
  for (const dir of ['bin', 'usr/bin']) for (const tail of ['/bash.exe', '/./bash.exe', '//bash.exe']) {
    assert.deepEqual(discoverGitInstallation(join(f.source, dir) + tail), selection);
  }
  const bash = join(f.source, 'bin/bash.exe'), rooted = bash.slice(2);
  for (const invalid of [rooted, rooted.replaceAll('\\', '/'), bash + '/', bash + '\\']) {
    assert.throws(() => discoverGitInstallation(invalid), /Supported Git for Windows was not found/);
  }
  const usr = join(f.directory, 'usr');
  createJunction(f.parent, 'usr', admitDirectory(f.source));
  for (const dir of ['bin', 'usr/bin']) assert.deepEqual(discoverGitInstallation(join(usr, dir, 'bash.exe')), selection);
  unlinkEntry(f.parent, 'usr');
  await rename(f.source, usr);
  const sibling = join(f.directory, selection.layout);
  await writeFile(sibling, 'unrelated file outside the installation');
  for (const dir of ['bin', 'usr/bin']) assert.equal(discoverGitInstallation(join(usr, dir, 'bash.exe')).root, usr);
  const outsideBin = join(f.directory, 'bin');
  await writeFile(outsideBin, 'outside the selected Git root');
  assert.equal(discoverGitInstallation(join(usr, 'bin/bash.exe')).root, usr);
  const close = NativeHold.prototype.close, fault = new Win32Error('CloseHandle', 6, outsideBin);
  const mock = t.mock.method(NativeHold.prototype, 'close', function (this: NativeHold) {
    close.call(this);
    if (this.path === outsideBin) throw fault;
  });
  try { assert.throws(() => discoverGitInstallation(join(usr, 'bin/bash.exe')), error => error === fault); }
  finally { mock.mock.restore(); }
  const etc = join(usr, 'etc'), wrapper = join(usr, 'bin/bash.exe');
  await rename(etc, etc + '.saved');
  await symlink(etc + '.saved', etc, 'junction');
  assert.throws(() => discoverGitInstallation(wrapper), { message: `Refusing reparse point: ${etc}` });
  unlinkEntry(admitDirectory(usr), 'etc');
  await rename(etc + '.saved', etc);
  await unlink(join(usr, 'usr/bin/bash.exe'));
  assert.throws(() => discoverGitInstallation(wrapper), error => error instanceof Error && error.message.includes(outsideBin));
});

await test('copy refuses admitted reparses and a reserved shim name at any flat entry type', nativeOnly, async t => {
  const f = await copyFixture(t);
  for (const [i, path] of ['unexpected', 'usr/unexpected', 'usr/bin/unexpected', 'usr/bin/DSH-MSYS-COMPAT.DLL'].entries()) {
    const name = join(f.source, path);
    await symlink(f.workspace, name, 'junction');
    await assert.rejects(f.build('bad' + i), /Unsupported|reparse/);
    unlinkEntry(admitDirectory(dirname(name)), path.split('/').at(-1)!);
  }
  const shim = join(f.source, 'usr/bin/DSH-MSYS-COMPAT.DLL');
  await writeFile(shim, 'collision');
  await assert.rejects(f.build('collision'), /Unsupported/);
  assert.equal(await readFile(shim, 'utf8'), 'collision');
  await unlink(shim); await mkdir(shim);
  await assert.rejects(f.build('reserved-dir'), /Unsupported/);
});

await test('layout discovery skips ordinary type mismatches and rejects reparses', nativeOnly, async t => {
  const f = await runtimeFixture(t, 'mingw64'), other = join(f.source, 'ucrt64');
  const select = () => discoverGitInstallation(f.request.gitBashPath);
  await writeFile(other, 'ordinary root file');
  assert.equal(select().layout, 'mingw64');
  const { runtime } = await buildCopyLayout(createDirectory(admitDirectory(f.directory), 'generation'), select(), await readFile(bundledShimUrl), t.signal);
  assert.equal(pathExists(join(runtime.path, 'ucrt64')), false);
  await unlink(other); await mkdir(other);
  await writeFile(join(other, 'bin'), 'ordinary file');
  assert.equal(select().layout, 'mingw64');
  await unlink(join(other, 'bin')); await mkdir(join(other, 'bin/git.exe'), { recursive: true });
  assert.equal(select().layout, 'mingw64');
  removeTree(admitDirectory(f.source), 'ucrt64');
  await symlink(f.workspace, other, 'junction');
  assert.throws(select, /reparse/);
});

await test('a protected real Git payload keeps its bytes, ACL, attributes and link count', nativeOnly, async t => {
  const f = await copyFixture(t), origin = join(f.source, 'usr/bin'), name = 'true.exe';
  const source = join(origin, name);
  const installed = discoverGitInstallation(process.env.DSH_TEST_GIT_BASH);
  await fsp.copyFile(join(installed.root, 'usr/bin', name), source);
  const userSid = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8' }).trim();
  execFileSync('attrib.exe', ['+R', source]);
  try {
    execFileSync('icacls.exe', [source, '/inheritance:r', '/grant:r', '*' + userSid + ':(RX)']);
    try {
      const snapshot = () => {
        using hold = openOrdinaryFile(admitDirectory(origin), name);
        return { bytes: readFileSync(source), acl: readAclRecords(source), info: hold.information(), links: fs.statSync(source).nlink };
      };
      const before = snapshot();
      assert.ok(before.info.attributes & 1);
      const { runtime } = await f.build('protected-漢');
      const target = join(runtime.path, 'usr/bin', name);
      assert.deepEqual(readFileSync(target), before.bytes);
      {
        using copy = openOrdinaryFile(admitDirectory(dirname(target)), name);
        assert.equal(copy.information().attributes & 1, 0);
      }
      fs.writeFileSync(target, 'independent');
      assert.deepEqual(snapshot(), before);
      const copiedAcl = readAclRecords(target);
      await unlink(target);
      await writeFile(target, '', { flag: 'wx' });
      assert.equal(readAclRecords(target), copiedAcl, 'a fresh file at the same path inherits the cache ACL');
    } finally { execFileSync('icacls.exe', [source, '/reset']); }
  } finally { execFileSync('attrib.exe', ['-R', source]); }
});

await test('bounded native reads check declared size before allocation and require exact EOF', nativeOnly, async t => {
  const f = await copyFixture(t), file = join(f.directory, 'bytes');
  await writeFile(file, '');
  assert.equal(readFileBytes(f.parent, 'bytes', 0).length, 0);
  const otherVolume = { ...f.parent, volumeSerial: String(BigInt(f.parent.volumeSerial) + 1n) };
  assert.throws(() => readFileBytes(otherVolume, 'bytes', 0), { message: `Volume boundary changed: ${file}` });
  for (const limit of [256 * 1024, 512 * 1024, 64 * 1024 * 1024]) {
    fs.truncateSync(file, limit);
    assert.equal(readFileBytes(f.parent, 'bytes', limit).length, limit);
    fs.truncateSync(file, limit + 1);
    assert.throws(() => readFileBytes(f.parent, 'bytes', limit), error => error instanceof Error &&
      [file, String(limit), String(limit + 1)].every(s => error.message.includes(s)));
  }
  fs.writeFileSync(file, 'abc');
  const original = NativeHold.prototype.information;
  for (const size of ['1', '4', '0', '18446744073709551615']) {
    const mock = t.mock.method(NativeHold.prototype, 'information', function (this: NativeHold) {
      return { ...original.call(this), size };
    });
    try {
      assert.throws(() => readFileBytes(f.parent, 'bytes', 256 * 1024), size.length > 10 ? /limit is 262144/ : /Size changed/);
    } finally { mock.mock.restore(); }
  }
  using first = openOrdinaryFile(f.parent, 'bytes');
  const stamp = first.information();
  fs.writeFileSync(file, 'abcd');
  assert.equal(first.information(), stamp);
  using reopened = openOrdinaryFile(f.parent, 'bytes');
  assert.equal(stamp.size, '3'); assert.equal(reopened.information().size, '4');
  await symlink(f.workspace, join(f.directory, 'redirected'), 'junction');
  assert.throws(() => readFileBytes(f.parent, 'redirected', 10), /reparse/);
});

await test('exclusive byte writes preserve collisions and every write, close and rollback error', nativeOnly, async t => {
  const f = await copyFixture(t);
  using _pin = pinDirectory(f.parent);
  const bytes = Buffer.from('initial');
  writeNewFile(f.parent, 'entry', bytes);
  assert.throws(() => writeNewFile(f.parent, 'entry', Buffer.from('second')), { code: 'EEXIST' });
  assert.deepEqual(readFileSync(join(f.directory, 'entry')), bytes);
  for (const bad of ['', '.', '..', 'nested/escape', 'file:stream']) {
    assert.throws(() => writeNewFile(f.parent, bad, bytes), /Invalid/);
  }
  const write = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  const close = new Error('payload close'), rollback = new Error('rollback');
  const original = fs.closeSync;
  t.mock.method(fs, 'writeFileSync', () => { throw write; });
  t.mock.method(fs, 'closeSync', (fd: number) => { original(fd); throw close; });
  t.mock.method(NativeHold.prototype, 'deleteEntry', () => { throw rollback; }, { times: 1 });
  const nativePath = join(f.parent.path, 'partial-native'), closeHold = NativeHold.prototype.close;
  const nativeClose = new Win32Error('CloseHandle', 6, nativePath);
  t.mock.method(NativeHold.prototype, 'close', function (this: NativeHold) {
    closeHold.call(this);
    if (this.path === nativePath) throw nativeClose;
  });
  syncBuiltinESMExports();
  try {
    for (const [name, cause] of [['partial', rollback], ['partial-native', nativeClose]] as const) {
      assert.throws(() => writeNewFile(f.parent, name, bytes), error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [write, close, cause]);
        assert.equal(hasCloseFailure(error), cause === nativeClose);
        return true;
      });
    }
    assert.equal(pathExists(nativePath), false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

await test('copy path budget counts the NT prefix, supplementary characters and NUL before any payload', nativeOnly, async t => {
  const f = await copyFixture(t);
  const leaf = 'v/ww-4294967295-4294967295-ffffffffffffffff';
  for (const prefix of ['a', '漢😀']) {
    const head = join(f.directory, prefix);
    const left = 260 - Buffer.byteLength(toNamespacedPath(join(head, leaf, 'usr/bin/msys-2.0.dll'))) - 1;
    assert.ok(left > 0);
    const generation = head + 'x'.repeat(left);
    requireViewPathBudget(join(generation, leaf));
    assert.throws(() => requireViewPathBudget(join(generation + 'x', leaf)), /shorter DSH home/);
    await f.build(generation.slice(f.directory.length + 1));
    await assert.rejects(f.build(generation.slice(f.directory.length + 1) + 'x'), /shorter DSH home/);
    assert.deepEqual(readdirSync(generation + 'x'), []);
  }
});

await test('flat pass holds each parent once, closes each reader before yielding and stops on the first failure', nativeOnly, async t => {
  for (const outcome of ['success', 'abort', 'disk full', 'close', 'hold close'] as const) await t.test(outcome, async t => {
    const f = await copyFixture(t), controller = new AbortController();
    const sourceBin = join(f.source, 'usr/bin'), destBin = join(f.directory, 'generation/r/usr/bin');
    const selection = discoverGitInstallation(f.request.gitBashPath);
    const generation = createDirectory(f.parent, 'generation');
    const held = new Set<NativeHold>(), readers = new Set<NativeHold>(), parentPaths: string[] = [];
    const observed: string[] = [];
    const canonical = NativeHold.prototype.canonicalPath, read = NativeHold.prototype.readBytes;
    const close = NativeHold.prototype.close, write = fs.writeFileSync, closeFd = fs.closeSync;
    const fault = new Error(outcome), nativeFault = new Win32Error('CloseHandle', 6, sourceBin);
    t.mock.method(NativeHold.prototype, 'canonicalPath', function (this: NativeHold) {
      if (this.path === sourceBin || this.path === destBin) {
        held.add(this);
        parentPaths.push(this.path);
      }
      return canonical.call(this);
    });
    t.mock.method(NativeHold.prototype, 'readBytes', function (this: NativeHold, limit: number) {
      assert.equal(limit, 64 * 1024 * 1024);
      assert.deepEqual(parentPaths, [sourceBin, destBin]);
      assert.equal(held.size, 2);
      assert.equal(readers.size, 0);
      readers.add(this);
      // An open payload denies writes and deletes even when the source ACL permits them.
      assert.throws(() => fs.closeSync(fs.openSync(this.path, 'r+')), /EBUSY|EPERM|EACCES/);
      return read.call(this, limit);
    });
    t.mock.method(NativeHold.prototype, 'close', function (this: NativeHold) {
      close.call(this);
      readers.delete(this);
      if (held.delete(this) && this.path === sourceBin && outcome === 'hold close') throw nativeFault;
    });
    t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
      assert.equal(readers.size, 0);
      observed.push('write');
      if (observed.length === 2 && (outcome === 'disk full' || outcome === 'hold close')) throw fault;
      write(...args);
      if (observed.length === 1 && outcome === 'abort') setImmediate(() => controller.abort(fault));
    });
    t.mock.method(fs, 'closeSync', (fd: number) => {
      closeFd(fd);
      if (observed.length === 2 && outcome === 'close') throw fault;
    });
    syncBuiltinESMExports();
    try {
      const building = buildCopyLayout(generation, selection, f.shim, controller.signal);
      if (outcome === 'success') await building;
      else await assert.rejects(building, error => {
        if (outcome === 'hold close') {
          assert.ok(error instanceof SuppressedError);
          assert.equal(error.error, nativeFault);
          assert.equal(error.suppressed, fault);
          assert.equal(hasCloseFailure(error), true);
        } else {
          assert.equal(error, fault);
          assert.equal(hasCloseFailure(error), false);
        }
        return true;
      });
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.equal(readers.size, 0); assert.equal(held.size, 0);
    const copied = readdirSync(destBin);
    assert.equal(observed.length, outcome === 'abort' ? 1 : outcome === 'success' ? 4 : 2);
    assert.equal(copied.length, outcome === 'success' ? 4 : 1);
    removeTree(f.parent, 'generation');
    await rename(sourceBin, sourceBin + '-moved');
    await new Promise<void>(done => setImmediate(done));
    assert.equal(pathExists(generation.path), false);
    assert.equal(pathExists(f.cache + '.writer-lock'), false);
  });
});

await test('freshness tracks each source stamp and the optional package list across restarts', nativeOnly, async t => {
  const f = await runtimeFixture(t);
  const prepare = async () => { await (await f.prepare()).release(); return f.current(); };
  let current = await prepare();
  assert.equal(current.sourceFreshness.packageVersionsSha256, null);
  assert.deepEqual(await prepare(), current);
  const git = join(f.source, 'ucrt64/bin/git.exe'), msys = join(f.source, 'usr/bin/msys-2.0.dll');
  const manifest = join(f.source, 'etc/package-versions.txt');
  for (const change of [
    () => fsp.utimes(git, 1700000000, 1700000000),
    async () => { await rename(git, git + '.old'); await fsp.copyFile(git + '.old', git); await fsp.utimes(git, 1700000000, 1700000000); },
    () => fsp.utimes(msys, 1700000000, 1700000000),
    () => writeFile(manifest, Buffer.from([0x80])), () => writeFile(manifest, Buffer.from([0xff])), () => unlink(manifest),
  ]) {
    await change();
    const next = await prepare();
    assert.notEqual(next.generationId, current.generationId);
    assert.notDeepEqual(next.sourceFreshness, current.sourceFreshness);
    current = next;
  }
  await writeFile(manifest, Buffer.alloc(256 * 1024 + 1));
  await assert.rejects(f.prepare(), /262145/);
  await unlink(manifest); await symlink(f.workspace, manifest, 'junction');
  await assert.rejects(f.prepare(), /reparse/);
  unlinkEntry(admitDirectory(join(f.source, 'etc')), 'package-versions.txt');
  await writeFile(manifest, 'held'); const blocker = blockFile(manifest);
  try { await assert.rejects(f.prepare(), isBusy); } finally { blocker.close(); }
});

await test('warm validation repairs ordinary payload loss and digest mismatches and rejects unsafe entries', nativeOnly, async t => {
  const f = await runtimeFixture(t);
  await (await f.prepare()).release();
  for (const name of ['bash.exe', 'sh.exe', 'msys-2.0.dll', 'dsh-msys-compat.dll']) {
    for (const damage of name.endsWith('.dll') ? ['missing', 'changed'] : ['missing']) {
      const before = await f.current(), path = join(f.cache, 'g', before.generationId, 'r/usr/bin', name);
      if (damage === 'missing') await unlink(path);
      else await writeFile(path, 'damaged private bytes');
      await (await f.prepare()).release();
      assert.notEqual((await f.current()).generationId, before.generationId);
    }
  }
  const before = await f.current(), bin = join(f.cache, 'g', before.generationId, 'r/usr/bin');
  await unlink(join(bin, 'sh.exe')); await symlink(f.workspace, join(bin, 'sh.exe'), 'junction');
  await assert.rejects(f.prepare(), /reparse/);
  assert.equal((await f.current()).generationId, before.generationId);
});

await test('warm validation reports hard errors in remaining payloads after finding stale bytes', nativeOnly, async t => {
  const f = await runtimeFixture(t);
  await (await f.prepare()).release();
  const before = await f.current(), bin = join(f.cache, 'g', before.generationId, 'r/usr/bin');
  const bash = join(bin, 'bash.exe'), shim = join(bin, 'dsh-msys-compat.dll');
  await unlink(bash);
  const blocker = blockFile(shim);
  try { await assert.rejects(f.prepare(), isBusy); } finally { blocker.close(); }
  await writeFile(bash, 'restored');
  await writeFile(join(bin, 'msys-2.0.dll'), 'stale digest');
  await unlink(shim); await symlink(f.workspace, shim, 'junction');
  await assert.rejects(f.prepare(), /reparse/);
  assert.deepEqual(await f.current(), before);
});

await test('a source DLL whose patch exceeds the payload limit cannot replace the selector', nativeOnly, async t => {
  const f = await runtimeFixture(t);
  await (await f.prepare()).release();
  const before = await f.current(), path = join(f.source, 'usr/bin/msys-2.0.dll');
  const image = await readFile(path), strings = Buffer.alloc(4), limit = 64 * 1024 * 1024;
  // Extend the fixture with a valid COFF string table up to the source read limit.
  image.writeUInt32LE(image.length, image.readUInt32LE(0x3c) + 12);
  strings.writeUInt32LE(limit - image.length);
  await writeFile(path, Buffer.concat([image, strings]));
  await fsp.truncate(path, limit);
  await assert.rejects(f.prepare(), /msys-2\.0\.dll has \d+ bytes\. The limit is 67108864/);
  assert.deepEqual(await f.current(), before);
  assert.deepEqual(readdirSync(join(f.cache, 'g')), [before.generationId]);
});

await test('failed automatic rebuilding and final-key changes preserve the last publication', nativeOnly, async t => {
  const f = await runtimeFixture(t); await (await f.prepare()).release();
  const before = await f.current(), git = join(f.source, 'ucrt64/bin/git.exe');
  await writeFile(git, 'new git');
  const collision = join(f.source, 'usr/bin/dsh-msys-compat.dll');
  await writeFile(collision, 'reserved'); await assert.rejects(f.prepare(), /Unsupported/); await unlink(collision);
  const write = fs.writeFileSync;
  let changed = false;
  t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    write(...args);
    if (!changed && typeof args[0] === 'number') {
      changed = true; write(git, 'upgraded during preparation');
    }
  });
  syncBuiltinESMExports();
  try { await assert.rejects(f.prepare(), /changed during preparation/); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.ok(changed);
  assert.deepEqual(await f.current(), before);
  assert.deepEqual(readdirSync(join(f.cache, 'g')), [before.generationId]);
});

await test('a post-publication collector close error preserves the newly selected generation', nativeOnly, async t => {
  const f = await runtimeFixture(t); await (await f.prepare()).release();
  const before = await f.current(), oldPath = join(f.cache, 'g', before.generationId);
  const close = NativeHold.prototype.close;
  const failure = new Win32Error('CloseHandle', 6, oldPath);
  let injected = false;
  t.mock.method(NativeHold.prototype, 'close', function (this: NativeHold) {
    close.call(this);
    if (!injected && this.path === oldPath && JSON.parse(readFileSync(join(f.cache, 'current.json'), 'utf8')).generationId !== before.generationId) {
      injected = true; throw failure;
    }
  });
  await assert.rejects(f.prepare(true), error => error === failure);
  assert.ok(injected);
  const published = await f.current();
  assert.notEqual(published.generationId, before.generationId);
  await (await f.prepare()).release(); assert.deepEqual(await f.current(), published);
});

await test('a terminated writer leaves a complete selector and collectible unpublished bytes', nativeOnly, async t => {
  const f = await runtimeFixture(t);
  await (await f.prepare()).release();
  const before = await f.current();
  const module = new URL('../lib/runtime/runtime-cache.js', import.meta.url).href;
  for (const boundary of ['copy', 'rename']) {
    const worker = `
      import fs from 'node:fs'; import fsp from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      import { join } from 'node:path';
      const [module, path, bash, boundary] = process.argv.slice(1);
      const stop = () => process.kill(process.pid, 'SIGKILL');
      const write = fs.writeFileSync, rename = fsp.rename;
      fs.writeFileSync = function(fd, ...args) {
        write(fd, ...args);
        if (boundary === 'copy' && typeof fd === 'number') stop();
      };
      fsp.rename = async function(from, to) {
        await rename(from, to);
        if (boundary === 'rename' && to === join(path, 'current.json')) stop();
      };
      syncBuiltinESMExports();
      await (await (await import(module)).prepareRuntime({ cacheDirectory: path, gitBashPath: bash, rebuild: true }, new AbortController().signal)).release();
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', worker, module, f.cache, f.request.gitBashPath!, boundary], { timeout: 20000 });
    assert.equal(child.error, undefined); assert.notEqual(child.status, 0);
    const selected = await f.current(), names = readdirSync(join(f.cache, 'g'));
    if (boundary === 'copy') { assert.deepEqual(selected, before); assert.equal(names.length, 2); }
    else { assert.notEqual(selected.generationId, before.generationId); assert.equal(names.length, 2); }
    await (await f.prepare()).release(); assert.deepEqual(await f.current(), selected);
  }
  await (await f.prepare(true)).release();
  assert.deepEqual(readdirSync(join(f.cache, 'g')), [(await f.current()).generationId]);
});

await test('custom flat-file changes preserving the entire key wait for a forced rebuild', nativeOnly, async t => {
  const f = await runtimeFixture(t), name = 'support-tool';
  await writeFile(join(f.source, 'usr/bin', name), 'A');
  await (await f.prepare()).release(); const a = await f.current();
  await writeFile(join(f.source, 'usr/bin', name), 'B');
  await (await f.prepare()).release();
  assert.deepEqual(await f.current(), a); assert.equal(await readFile(join(f.cache, 'g', a.generationId, 'r/usr/bin', name), 'utf8'), 'A');
  await (await f.prepare(true)).release(); const b = await f.current();
  assert.notEqual(b.generationId, a.generationId); assert.equal(await readFile(join(f.cache, 'g', b.generationId, 'r/usr/bin', name), 'utf8'), 'B');
});

await test('different Git roots can share one home while idle peers retain the old generation', nativeOnly, async t => {
  const f = await runtimeFixture(t), rootB = join(f.directory, 'second-git');
  await fsp.cp(f.source, rootB, { recursive: true });
  const a = await f.prepare(), peer = await f.prepare(), before = await f.current();
  const b = await prepareRuntime({ cacheDirectory: f.cache, gitBashPath: join(rootB, 'bin/bash.exe') }, t.signal);
  try {
    const after = await f.current(); assert.equal(after.sourceRoot, rootB); assert.notEqual(before.generationId, after.generationId);
    await a.release();
    const use = peer.acquireUse();
    try { assert.equal(use.sourceRoot, f.source); assert.ok(pathExists(use.bindView({ workspace: f.workspace, prefix: 'ro' }))); }
    finally { await use.release(); }
    await peer.release(); assert.ok(pathExists(join(f.cache, 'g', before.generationId)));
  } finally { await b.release(); }
});

await test('build scans orphans once and visits only the superseded generation after publication', nativeOnly, async t => {
  const f = await runtimeFixture(t); await (await f.prepare()).release();
  const before = await f.current(), generations = join(f.cache, 'g'), selector = join(f.cache, 'current.json');
  await mkdir(join(generations, 'orphan'));
  const scans: string[] = [], after: string[] = [], read = fs.readdirSync;
  const hook = t.mock.method(fs, 'readdirSync', ((...args: Parameters<typeof read>) => {
    const path = String(args[0]).replace(/^\\\\\?\\/, '');
    if (path === generations) scans.push(JSON.parse(readFileSync(selector, 'utf8')).generationId);
    if (path.startsWith(generations + '\\') && JSON.parse(readFileSync(selector, 'utf8')).generationId !== before.generationId) after.push(path);
    return read(...args);
  }) as typeof read);
  syncBuiltinESMExports();
  try { await (await f.prepare(true)).release(); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(scans, [before.generationId]); assert.ok(after.length);
  assert.ok(after.every(path => path === join(generations, before.generationId) || path.startsWith(join(generations, before.generationId) + '\\')));
});
