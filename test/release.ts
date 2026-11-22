import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installedDsh } from '../scripts/installed-dsh.ts';
import { admitDirectory, openOrdinaryFile } from '../src/runtime/ntfs-filesystem.ts';
import { executionContext, executionFixture, installPackedProfile, loadPackedExecutor, packRelease, runProfileHost, temporaryDirectory } from './fixtures.ts';

const checkout = resolve(import.meta.dirname, '..');
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function exerciseProfile(dir: string, workspace: string, bash: string) {
  const dsh = installedDsh(), ctx = await executionContext(dirname(dirname(dir)), workspace, dir);
  try {
    const p = await loadPackedExecutor(ctx, dir);
    const metadata = JSON.parse(readFileSync(join(p.root, 'package.json'), 'utf8'));
    for (const key of Object.keys(metadata.exports)) {
      const entries = key.includes('*') ? readdirSync(join(p.root, 'locale')).map(f => './locale/' + f) : [key];
      for (const entry of entries) assert.ok(p.require.resolve(metadata.name + entry.slice(1)).startsWith(p.root));
    }
    const stock = await dsh.load(dsh.baseRequire, '@deepseek-ai/dsh-bash-sandbox') as typeof import('@deepseek-ai/dsh-bash-sandbox');
    const cordis = await dsh.load(dsh.baseRequire, '@deepseek-ai/cordis') as typeof import('@deepseek-ai/cordis');
    const tools = await dsh.load(dsh.baseRequire, '@deepseek-ai/dsh-tool-bash') as typeof import('@deepseek-ai/dsh-tool-bash');
    assert.equal(Object.getPrototypeOf(p.Executor), stock.SandboxBashExecutor);
    assert.equal((await dsh.load(p.require, '@deepseek-ai/cordis') as typeof cordis).Context, cordis.Context);
    assert.equal((await dsh.load(p.require, metadata.name + '/tool') as typeof tools).apply, tools.apply);
    const cache = await dsh.load(p.require, join(p.root, 'lib/runtime/runtime-cache.js')) as { bundledShimUrl: URL };
    assert.equal(fileURLToPath(cache.bundledShimUrl), join(p.root, 'lib/dsh-msys-compat.dll'));
    await ctx.plugin(p.Executor, { gitBashPath: bash });
    for (const mode of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
      const ex = await ctx.shell.execute(ctx.shell.resolve({ command: 'printf "packed\\n" | grep -Fx packed && git --version',
        workdir: workspace, timeoutMs: 15000, sandboxPolicy: { mode, workspaceRoot: workspace } }));
      const r = await ex.result();
      await ex.done;
      assert.equal(r.exitCode, 0, r.stderr.text);
      assert.match(r.stdout.text, /^packed\r?\ngit version /);
    }
  } finally { await ctx.fiber.dispose(); }
}

if (process.argv[2]) await exerciseProfile(process.argv[2], process.argv[3]!, process.argv[4]!);
else await test('independent release packs install, execute, share a cache and uninstall in rc.5 profiles', async t => {
  const staging = await temporaryDirectory(t);
  const manifest = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')) as {
    name: string; dependencies: Record<string, string>; peerDependencies: Record<string, string>; exports: Record<string, unknown>;
  };
  const tar = join(process.env.SystemRoot!, 'System32/tar.exe');
  const tracked = execFileSync('git.exe', ['ls-files', '-z', '--', 'lib', 'locale', 'package.json', 'cordis.patch.yml', 'README*.md'],
    { cwd: checkout, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  const archives: string[] = [];
  for (const lane of ['a', 'b']) {
    const tree = join(staging, lane), output = join(tree, 'out');
    mkdirSync(output, { recursive: true });
    for (const item of ['src', 'scripts', 'native', 'locale', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
      'tsconfig.json', 'tsconfig.build.json', 'cordis.patch.yml', 'README.md', 'README_CN.md']) {
      cpSync(join(checkout, item), join(tree, item), { recursive: true });
    }
    for (const obsolete of ['debugger/native-debug.js', 'setup/link-helper.js', 'rebuild-feedback.js', 'dsh-msys-compat.dll']) {
      mkdirSync(dirname(join(tree, 'lib', obsolete)), { recursive: true });
      writeFileSync(join(tree, 'lib', obsolete), 'obsolete ' + lane);
    }
    // Only the build tools are shared. Each prepack starts with its own inputs and poisoned lib.
    symlinkSync(join(checkout, 'node_modules'), join(tree, 'node_modules'), 'junction');
    try { archives.push(packRelease(tree, output)); }
    finally { unlinkSync(join(tree, 'node_modules')); }
    const archived = execFileSync(tar, ['-tf', archives.at(-1)!], { encoding: 'utf8' }).trim().split(/\r?\n/);
    assert.deepEqual(archived.map(path => path.replace(/^package\//, '')).sort(), tracked);
    for (const file of tracked.filter(f => f.startsWith('lib/'))) assert.equal(hash(join(tree, file)), hash(join(checkout, file)), file);
  }
  assert.deepEqual(readFileSync(archives[0]!), readFileSync(archives[1]!));
  t.diagnostic('Tarball SHA-256 ' + hash(archives[0]!) + ', DLL SHA-256 ' + hash(join(checkout, 'lib/dsh-msys-compat.dll')));

  const f = await executionFixture(t);
  await f.ctx.fiber.dispose();
  const marker = join(f.cache, 'current.json'), source = join(f.source, 'usr/bin/grep.exe');
  const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', DSH_HOME: f.directory };
  const shared = { timeoutMs: 12000, graceMs: 500 };
  const web = await installPackedProfile(f.directory, 'web', archives[0]!);
  const desktop = await installPackedProfile(f.directory, 'desktop', archives[1]!);
  const packedManifest = execFileSync(tar, ['-xOf', archives[0]!, 'package/package.json']);
  const packed = JSON.parse(packedManifest.toString()) as typeof manifest;
  for (const field of ['dependencies', 'peerDependencies', 'exports'] as const) assert.deepEqual(packed[field], manifest[field]);
  let selected: string | undefined;
  execFileSync('attrib.exe', ['+R', source]);
  try {
    for (const p of [web, desktop]) {
      const patch = join(p.dir, 'cordis.patch.yml');
      writeFileSync(patch, JSON.stringify([{ id: 'pwsh-sandbox', config: { ...shared, gitBashPath: f.request.gitBashPath } }]));
      for (const file of tracked) {
        const expected = file === 'package.json' ? packedManifest : readFileSync(join(checkout, file));
        assert.deepEqual(readFileSync(join(p.root, file)), expected, file);
      }
      runProfileHost(import.meta.url, p.dir, f.workspace, f.request.gitBashPath!);
      writeFileSync(patch, JSON.stringify([{ id: 'pwsh-sandbox', config: shared }]));
      const current = readFileSync(marker, 'utf8');
      if (selected) assert.equal(current, selected);
      selected = current;
      if (p === web) {
        await web.remove();
        assert.equal(readFileSync(marker, 'utf8'), current);
      }
    }
    const { generationId } = JSON.parse(selected!) as { generationId: string };
    const usrBin = admitDirectory(join(f.cache, 'g', generationId, 'r/usr/bin'));
    using copy = openOrdinaryFile(usrBin, basename(source));
    using original = openOrdinaryFile(admitDirectory(dirname(source)), basename(source));
    assert.equal(original.information().attributes & 1, 1);
    assert.equal(copy.information().attributes & 1, 0);
    assert.notEqual(original.information().fileId, copy.information().fileId);
  } finally { execFileSync('attrib.exe', ['-R', source]); }

  // Standalone purge has no PluginPackages service. Reject any module resolved outside this installation.
  const guard = `import { registerHooks } from 'node:module';
    import { realpathSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    import { sep } from 'node:path';
    const allowed = realpathSync.native(process.cwd()) + sep + 'node_modules' + sep;
    registerHooks({ resolve(specifier, ctx, next) {
      const result = next(specifier, ctx);
      if (result.url.startsWith('file:') && !realpathSync.native(fileURLToPath(result.url)).startsWith(allowed))
        throw Error('Standalone resolution outside profile: ' + result.url);
      return result;
    } });`;
  execFileSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(guard),
    join(desktop.root, 'lib/purge-runtime-cache.js'), f.cache], { cwd: desktop.dir, env });
  assert.equal(existsSync(f.cache), false);
  assert.equal(existsSync(f.cache + '.writer-lock'), false);
  await desktop.remove();
  for (const p of [web, desktop]) {
    const info = JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8'));
    assert.equal(info.dependencies?.[manifest.name], undefined);
    assert.ok(!info.dsh.profile.bundles.includes(manifest.name));
    assert.deepEqual(JSON.parse(readFileSync(join(p.dir, 'cordis.patch.yml'), 'utf8')), [{ id: 'pwsh-sandbox', config: shared }]);
  }
});
