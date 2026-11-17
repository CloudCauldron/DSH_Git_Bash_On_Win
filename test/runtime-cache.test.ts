import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs, { readFileSync, readdirSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { link, mkdir, readFile, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, toNamespacedPath } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { nativeOnly, runtimeFixture } from './fixtures.ts';
import { prepareRuntime, purgeRuntimeCache } from '../src/runtime/runtime-cache.ts';
import { anchorPaths, discoverGitInstallation, inventoryGitFiles, linkFreshTree } from '../src/runtime/git-installation.ts';
import {
  absolutePath, acquireWriterLock, admitDirectory, createDirectory, createJunction, NativeHold,
  isBusy, pathExists, removeTree, unlinkEntry,
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

await test('discovery skips missing or incomplete defaults without hiding selection or IO errors', nativeOnly, async t => {
  const fixture = await runtimeFixture(t);
  const stale = join(fixture.directory, 'stale'), valid = join(fixture.directory, 'valid');
  await mkdir(join(stale, 'Git/bin'), { recursive: true });
  await writeFile(join(stale, 'Git/bin/bash.exe'), 'incomplete installation');
  await mkdir(valid);
  await mkdir(join(fixture.source, 'bin'));
  await link(join(fixture.source, 'usr/bin/bash.exe'), join(fixture.source, 'bin/bash.exe'));
  await symlink(fixture.source, join(valid, 'Git'), 'junction');
  const keys = ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'];
  const saved = keys.map(key => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    process.env.ProgramW6432 = stale; process.env.ProgramFiles = valid;
    assert.equal(discoverGitInstallation().root, fixture.source);

    const candidate = join(stale, 'Git/bin/bash.exe');
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
    if (args[0] === toNamespacedPath(join(fixture.cache, '.owner.json'))) throw new Error('fixture ownership write failure');
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(fixture.prepare(), /fixture ownership write failure/);
    assert.equal(pathExists(fixture.cache), false);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  const pin = await fixture.prepare(); await pin.release();
});

await test('volume mismatch is rejected before cache-root creation', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), original = NativeHold.prototype.information;
  const mock = t.mock.method(NativeHold.prototype, 'information', function (this: NativeHold) {
    const info = original.call(this);
    return this.path === fixture.directory ? { ...info, volumeSerial: String(BigInt(info.volumeSerial) + 1n) } : info;
  });
  try {
    await assert.rejects(fixture.prepare(), /same an? NTFS volume|share an NTFS volume/);
    assert.equal(pathExists(fixture.cache), false);
  } finally { mock.mock.restore(); }
});

await test('an admitted link is never left queued behind an unrelated libuv operation', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), target = join(fixture.directory, 'target'), outside = join(fixture.directory, 'outside');
  await mkdir(target); await mkdir(outside);
  const program = `
    import { pbkdf2 } from 'node:crypto';
    import { promisify } from 'node:util';
    import { renameSync, symlinkSync, existsSync } from 'node:fs';
    import { join } from 'node:path';
    const [module, source, target, outside] = process.argv.slice(1);
    const { admitDirectory, createHardlink } = await import(module);
    const origin = admitDirectory(source), destination = admitDirectory(target);
    const busy = promisify(pbkdf2)('fixture', 'fixture', 1_000_000, 32, 'sha256');
    const linking = Promise.resolve(createHardlink(origin, 'bash.exe', destination, 'payload'));
    renameSync(target, target + '-saved');
    symlinkSync(outside, target, 'junction');
    await Promise.all([busy, linking]);
    console.log(JSON.stringify({ outside: existsSync(join(outside, 'payload')), admitted: existsSync(join(target + '-saved', 'payload')) }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program,
    new URL('../src/runtime/ntfs-filesystem.ts', import.meta.url).href, join(fixture.source, 'usr/bin'), target, outside],
  { encoding: 'utf8', timeout: 10_000, env: { ...process.env, UV_THREADPOOL_SIZE: '1' } });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { outside: false, admitted: true });
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
  const relative = 'usr/lib/perl/module.pm', leaf = join(fixture.source, relative);
  execFileSync('attrib.exe', ['+R', leaf]);
  try {
    assert.ok((await inventoryGitFiles(fixture.source, () => {})).includes(relative));
    await assert.rejects(fixture.prepare(), { message: 'Refusing read-only source hardlink: ' + leaf });
    assert.deepEqual(readdirSync(join(fixture.cache, 'generations')), []);
    assert.equal(pathExists(join(fixture.cache, 'current.json')), false);
  } finally { execFileSync('attrib.exe', ['-R', leaf]); }
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

await test('cancellation before atomic publication preserves the selected generation', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), first = await fixture.prepare();
  await first.release();
  const before = await fixture.current(), controller = new AbortController();
  const original = NativeHold.prototype.canonicalPath;
  let cancelled = false;
  const mock = t.mock.method(NativeHold.prototype, 'canonicalPath', function (this: NativeHold) {
    const path = original.call(this);
    // Cancel at fresh pin acquisition, after final admission but before writing.
    if (dirname(this.path) === join(fixture.cache, 'generations') && pathExists(join(this.path, 'base/bin'))) {
      cancelled = true; controller.abort();
    }
    return path;
  });
  try { await assert.rejects(fixture.prepare(true, controller.signal), { name: 'AbortError' }); }
  finally { mock.mock.restore(); }
  assert.ok(cancelled, 'cancellation must reach the last pre-publication boundary');
  assert.deepEqual(await fixture.current(), before);
  assert.deepEqual(readdirSync(join(fixture.cache, 'generations')), [before.generationId]);
  assert.equal(pathExists(join(fixture.cache, '.writer-lock')), false);
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
      assert.equal(pathExists(join(fixture.cache, '.writer-lock')), false);
      const use = await pin.lease({ mode: 'read-only', workspaceRoot: fixture.workspace }, new AbortController().signal);
      try { assert.equal(use.baseRoot, join(fixture.cache, 'generations', published.generationId, 'base')); }
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
  assert.deepEqual(readdirSync(join(fixture.cache, 'generations')), [before.generationId]);
  assert.deepEqual(readdirSync(fixture.cache).sort(), ['.owner.json', 'current.json', 'generations']);
  await purgeRuntimeCache(fixture.cache);
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

await test('a competing process can finish root ownership before the losing mkdir resumes', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), original = fs.mkdirSync;
  let competed = false;
  const mock = t.mock.method(fs, 'mkdirSync', (...args: Parameters<typeof fs.mkdirSync>) => {
    if (!competed && args[0] === toNamespacedPath(fixture.cache)) {
      competed = true;
      const program = `
        const [module, cacheDirectory, gitBashPath] = process.argv.slice(1);
        const { prepareRuntime } = await import(module);
        const pin = await prepareRuntime({ cacheDirectory, gitBashPath,
          spawn() { throw new Error('Unexpected subprocess'); } }, new AbortController().signal);
        await pin.release();
      `;
      execFileSync(process.execPath, ['--input-type=module', '-e', program,
        new URL('../src/runtime/runtime-cache.ts', import.meta.url).href, fixture.cache, fixture.request.gitBashPath!], { timeout: 10_000 });
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const pin = await fixture.prepare();
    assert.equal(competed, true);
    assert.equal(readdirSync(join(fixture.cache, 'generations')).length, 1);
    await pin.release();
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
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

await test('a redirected dangling internal junction is an error, not a cold cache miss', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), pin = await fixture.prepare();
  await pin.release();
  const record = await fixture.current(), base = join(fixture.cache, 'generations', record.generationId, 'base');
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
  const generation = join(fixture.cache, 'generations', (await fixture.current()).generationId);
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
  assert.equal((await stat(source)).nlink, originalLinks + 1, 'only the recovered base retains a source link');
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'keep');

  const plan = join(fixture.cache, 'generations', (await fixture.current()).generationId, 'plan.json');
  await mkdir(plan);
  await link(source, join(plan, 'manual-link'));
  await symlink(outside, join(plan, 'outside-view'), 'junction');
  await mkdir(join(fixture.cache, 'unexpected directory'));
  await link(source, join(fixture.cache, 'unexpected directory/manual-link'));
  await symlink(outside, join(fixture.cache, 'outside-view'), 'junction');
  await symlink(outside, join(fixture.cache, 'generations', 'malformed-junction'), 'junction');
  await mkdir(join(fixture.cache, 'generations', 'not-an-id'));
  await writeFile(join(fixture.cache, 'generations', 'not-an-id', 'plan.json'), '{corrupt');
  await writeFile(join(fixture.cache, 'generations', 'not-an-id', 'payload'), 'owned');
  await purgeRuntimeCache(fixture.cache);
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'keep');
  assert.equal(pathExists(fixture.cache), false);
  assert.equal((await stat(source)).nlink, originalLinks);
});

await test('purge preserves a source read-only bit and reports the obstruction explicitly', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), source = join(fixture.source, 'usr/bin/bash.exe');
  const originalLinks = (await stat(source)).nlink;
  const pin = await fixture.prepare(); await pin.release();
  execFileSync('attrib.exe', ['+R', source]);
  try {
    const readOnlyMode = (await stat(source)).mode;
    await assert.rejects(purgeRuntimeCache(fixture.cache), error => (error as { win32Code?: number }).win32Code === 5);
    assert.equal((await stat(source)).mode, readOnlyMode);
    assert.ok(pathExists(join(fixture.cache, '.owner.json')));
  } finally { execFileSync('attrib.exe', ['-R', source]); }
  await purgeRuntimeCache(fixture.cache);
  assert.equal((await stat(source)).nlink, originalLinks);
});

await test('purge addresses unusual enumerated NTFS names exactly and restores their hardlink counts', nativeOnly, async t => {
  const fixture = await runtimeFixture(t), source = join(fixture.source, 'etc/profile');
  const originalLinks = (await stat(source)).nlink;
  const pin = await fixture.prepare(); await pin.release();
  const unusualGeneration = toNamespacedPath(join(fixture.cache, 'generations', 'generation '));
  await mkdir(unusualGeneration);
  await link(source, join(unusualGeneration, 'payload.'));
  await link(source, toNamespacedPath(join(fixture.cache, 'manual ')));
  assert.ok(readdirSync(join(fixture.cache, 'generations')).includes('generation '));
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
    if (this.path === join(fixture.source, 'usr/lib/perl/module.pm') && pathExists(join(fixture.cache, 'generations'))
      && readdirSync(join(fixture.cache, 'generations')).some(id => pathExists(join(fixture.cache, 'generations', id, 'base/usr/bin/bash.exe')))) controller.abort();
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
