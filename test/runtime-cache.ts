import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createInterface } from 'node:readline';
import { RuntimeDirectory, purgeRuntime } from '../src/private-runtime.ts';
import { createTestScope } from '../poc/scope.ts';

const runtimeModule = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../lib/private-runtime.js')).href;
function fixture() {
  const scope = createTestScope('dsh-gitbash-cache-');
  const source = join(scope.root, 'git'), workspace = join(scope.root, 'workspace'), cache = join(scope.root, '.git-bash-on-win');
  mkdirSync(join(source, 'usr/bin'), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(join(source, 'usr/bin/bash.exe'), 'synthetic bash v1');
  writeFileSync(join(source, 'usr/bin/msys-2.0.dll'), 'synthetic runtime');
  return { scope, source, workspace, cache };
}

void test('a fresh Windows process reuses the persistent, verified generation without setup', { timeout: 15_000 }, async () => {
  const { scope, source, workspace, cache } = fixture();
  let manager = new RuntimeDirectory(cache, source, workspace);
  try {
    const runtime = await manager.prepare(source, 'read-only', workspace);
    const generation = dirname(runtime.root), identity = String(statSync(generation, { bigint: true }).ino);
    const view = manager.view(runtime, 'session');
    await assert.rejects(purgeRuntime(cache), /Close every DSH instance/);
    await manager.dispose();
    assert(existsSync(runtime.bash));
    assert(!existsSync(view.installationRoot));
    assert(!readdirSync(cache).some(name => name.startsWith('.owner-') || name === '.lock'));
    const probe = `import {RuntimeDirectory} from ${JSON.stringify(runtimeModule)};
      import {statSync} from 'node:fs'; import {dirname} from 'node:path';
      const [cache,source,workspace]=process.argv.slice(1);
      const manager=new RuntimeDirectory(cache,source,workspace);
      try { const runtime=await manager.prepare(source,'read-only',workspace,async()=>{throw new Error('Unexpected elevation');});
        console.log(JSON.stringify({root:runtime.root,identity:String(statSync(dirname(runtime.root),{bigint:true}).ino)}));
      } finally { await manager.dispose(); }`;
    const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', probe, cache, source, workspace], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.deepEqual(JSON.parse(restarted.stdout), { root: runtime.root, identity });
    assert.equal(readdirSync(join(cache, 'generations')).length, 1);
    // Missing and replaced links must invalidate the cache, including another mode.
    manager = new RuntimeDirectory(cache, source, workspace);
    const held = await manager.prepare(source, 'read-only', workspace);
    manager.view(held, 'rollback-session');
    const missing = join(dirname(held.root), 'workspace-write/usr/bin/bash.exe');
    unlinkSync(missing);
    const repaired = await manager.prepare(source, 'read-only', workspace);
    assert.notEqual(repaired.root, held.root);
    assert(existsSync(held.bash), 'in-flight generation survives repair');
    await held.release();
    assert(!existsSync(dirname(held.root)));
    const replaced = join(repaired.root, 'usr/bin/msys-2.0.dll');
    unlinkSync(replaced); writeFileSync(replaced, 'corrupted private link');
    const verified = await manager.prepare(source, 'read-only', workspace);
    assert.notEqual(verified.root, repaired.root);
    assert.equal(readFileSync(join(source, 'usr/bin/msys-2.0.dll'), 'utf8'), 'synthetic runtime');
    await repaired.release(); await verified.release();
    const metadata = join(cache, 'current.json'), saved = readFileSync(metadata, 'utf8');
    const verifiedIdentity = String(statSync(dirname(verified.root), { bigint: true }).ino);
    try {
      for (const damaged of ['null', '{}', '{broken', undefined]) {
        if (damaged === undefined) unlinkSync(metadata); else writeFileSync(metadata, damaged);
        const recovered = await manager.prepare(source, 'read-only', workspace);
        assert.equal(recovered.root, verified.root, 'metadata recovery must rediscover a verified repaired generation');
        assert.equal(String(statSync(dirname(recovered.root), { bigint: true }).ino), verifiedIdentity);
        await recovered.release();
      }
    } finally { writeFileSync(metadata, saved); }
    const alternative = join(scope.root, 'other-git');
    mkdirSync(join(alternative, 'usr/bin'), { recursive: true });
    writeFileSync(join(alternative, 'usr/bin/bash.exe'), 'other synthetic bash');
    writeFileSync(join(alternative, 'usr/bin/msys-2.0.dll'), 'other synthetic runtime');
    const other = await manager.prepare(alternative, 'read-only', workspace);
    const returned = await manager.prepare(source, 'read-only', workspace);
    assert.equal(returned.root, held.root, 'the fingerprint path is reused after switching sources back');
    assert(existsSync(manager.view(returned, 'rollback-session').installationRoot), 'a collected session view is recreated');
    await other.release(); await returned.release();
    await manager.dispose();
    await purgeRuntime(cache);
    assert(!existsSync(cache));
    assert.equal(statSync(join(source, 'usr/bin/bash.exe')).nlink, 1);
    assert.equal(statSync(join(source, 'usr/bin/msys-2.0.dll')).nlink, 1);
  } finally {
    try { await manager.dispose(); } finally { scope.dispose(); }
  }
});

void test('workspace roots cannot overlap the cache or Git source in either direction', async () => {
  const { scope, source, workspace, cache } = fixture();
  const manager = new RuntimeDirectory(cache, source, workspace);
  try {
    const runtime = await manager.prepare(source, 'read-only', workspace);
    for (const nested of [join(runtime.root, 'usr'), join(source, 'usr')]) {
      let unexpected: RuntimeDirectory | undefined;
      try {
        assert.throws(() => { unexpected = new RuntimeDirectory(cache, source, nested); }, /outside the workspace/);
      } finally { await unexpected?.dispose(); }
      await assert.rejects(manager.prepare(source, 'workspace-write', nested), /outside the workspace/);
    }
  } finally {
    try { await manager.dispose(); await purgeRuntime(cache); } finally { scope.dispose(); }
  }
});

void test('source traversal rejects junctions in otherwise skipped intermediate directories', async () => {
  const { scope, source, workspace, cache } = fixture();
  const manager = new RuntimeDirectory(cache, source, workspace);
  try {
    const external = join(workspace, 'source-through-junction');
    renameSync(join(source, 'usr'), external);
    symlinkSync(external, join(source, 'usr'), 'junction');
    await assert.rejects(manager.prepare(source, 'read-only', workspace), /reparse point/);
    rmdirSync(join(source, 'usr')); renameSync(external, join(source, 'usr'));
    const library = join(source, 'ucrt64/libexec');
    mkdirSync(join(library, 'git-core'), { recursive: true });
    writeFileSync(join(library, 'git-core/helper.exe'), 'synthetic helper');
    renameSync(library, external);
    symlinkSync(external, library, 'junction');
    await assert.rejects(manager.prepare(source, 'read-only', workspace), /reparse point/);
  } finally {
    try { await manager.dispose(); await purgeRuntime(cache); } finally { scope.dispose(); }
  }
});

void test('failed generation collection does not acquire an unreachable execution lease', async () => {
  const { scope, source, workspace, cache } = fixture();
  const manager = new RuntimeDirectory(cache, source, workspace);
  const unexpected = join(cache, 'generations/unexpected');
  try {
    const runtime = await manager.prepare(source, 'read-only', workspace);
    const leases = () => readdirSync(dirname(runtime.root)).filter(name => name.startsWith('.lease-')).length;
    const before = leases();
    mkdirSync(unexpected);
    try {
      await assert.rejects(manager.prepare(source, 'read-only', workspace), /Unexpected private runtime generation/);
      assert.equal(leases(), before);
    } finally { rmdirSync(unexpected); }
    await runtime.release();
  } finally {
    try { await manager.dispose(); await purgeRuntime(cache); } finally { scope.dispose(); }
  }
});

void test('concurrent owners share setup and retain superseded generations until the last lease ends', { timeout: 15_000 }, async () => {
  const { scope, source, workspace, cache } = fixture();
  const first = new RuntimeDirectory(cache, source, workspace), second = new RuntimeDirectory(cache, source, workspace);
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  try {
    const [a, b] = await Promise.all([first.prepare(source, 'read-only', workspace), second.prepare(source, 'read-only', workspace)]);
    assert.equal(a.root, b.root);
    assert.equal(readdirSync(join(cache, 'generations')).length, 1);
    const probe = `import {RuntimeDirectory} from ${JSON.stringify(runtimeModule)};
      const [cache,source,workspace]=process.argv.slice(1);
      const manager=new RuntimeDirectory(cache,source,workspace);
      const runtime=await manager.prepare(source,'read-only',workspace);
      manager.view(runtime,'crash-test'); console.log('ready'); setInterval(()=>{},1000);`;
    child = spawn(process.execPath, ['--input-type=module', '-e', probe, cache, source, workspace], { stdio: ['ignore', 'pipe', 'pipe'] });
    exited = once(child, 'exit');
    const output = createInterface({ input: child.stdout! });
    try {
      const [ready] = await Promise.race([once(output, 'line'), exited.then(() => { throw new Error('Cache probe exited before acquiring its lease'); })]);
      assert.equal(ready, 'ready');
    } finally { output.close(); }
    await a.release(); await b.release();
    renameSync(join(source, 'usr/bin/bash.exe'), join(source, 'usr/bin/old.exe'));
    writeFileSync(join(source, 'usr/bin/bash.exe'), 'synthetic bash v2');
    const updated = await first.prepare(source, 'workspace-write', workspace);
    assert.notEqual(dirname(updated.root), dirname(a.root));
    assert(existsSync(a.bash), 'the other process still owns the old generation');
    child.kill(); await exited; child = undefined;
    await updated.release();
    assert(!existsSync(dirname(a.root)), 'owner death releases Windows leases and permits collection');
    await first.dispose(); await second.dispose();
    assert(existsSync(updated.bash), 'normal shutdown retains the current generation');
    await purgeRuntime(cache);
    assert(!existsSync(cache));
  } finally {
    if (child) { child.kill(); await exited; }
    try { await first.dispose(); await second.dispose(); } finally { scope.dispose(); }
  }
});
