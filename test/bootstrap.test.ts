import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire, findPackageJSON } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Loader, { type EntryChange } from '@deepseek-ai/cordis-plugin-loader';
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox';
import * as NativeBashTool from '@deepseek-ai/dsh-tool-bash';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { ESLint } from 'eslint';
import ts from 'typescript';
import { parse } from 'yaml';
import GitBashExecutor, { type Config } from '../src/index.ts';
import * as Adapter from '../src/adapter.ts';
import GitBashPreset from '../src/preset.ts';
import * as BashTool from '../src/tool.ts';
import { findInstalledDshManifest, installedDsh, SUPPORTED_DSH } from '../scripts/installed-dsh.ts';
import { temporaryDirectory } from './fixtures.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const nativeWindows = process.platform === 'win32' && process.arch === 'x64';
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  exports: Record<string, string | { types: string; default: string }>;
  engines: { dsh: string };
  dsh: { bundle: { patch: string; platforms: string[] } };
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => relative(directory, join(entry.parentPath, entry.name)).replaceAll('\\', '/')).sort();
}

await test('native Shell schema and Bash tool exports keep their identity', () => {
  const native = SandboxBashExecutor.Config.dict!;
  const adapted = GitBashExecutor.Config.dict!;
  assert.deepEqual(Object.keys(adapted).sort(), [...Object.keys(native), 'gitBashPath'].sort());
  for (const key of Object.keys(native)) assert.equal(adapted[key], native[key]);
  const schema = GitBashExecutor.Config as unknown as (value: unknown) => unknown;
  const input = { timeoutMs: 1234, gitBashPath: 'C:/Tools/Git/bin/bash.exe' };
  const output = schema(input) as Config;
  assert.equal(output.timeoutMs.get(), input.timeoutMs);
  assert.equal(output.gitBashPath.get(), input.gitBashPath);
  assert.throws(() => schema({ timeoutMs: 'invalid' }));
  assert.deepEqual(BashTool, NativeBashTool);
});

await test('bundle adaptation preserves Loader entry/config identity and restores namespaces', { skip: !nativeWindows && 'Requires native Windows x64.' }, async t => {
  const original = { inject: ['bootstrapMissingService'], apply() {} };
  const replacements = new Map<string, unknown>([
    ['dsh-git-bash-on-win', GitBashExecutor],
    ['dsh-git-bash-on-win/tool', BashTool],
    ['dsh-git-bash-on-win/preset', GitBashPreset],
  ]);
  // Real Loader entries/lifecycles, with in-memory module resolution and no
  // persistence provider. Runtime services are deliberately absent in Phase 1.
  class FixtureLoader extends Loader {
    readonly changes: EntryChange[] = [];
    override import(name: string): unknown { return replacements.get(name) ?? original; }
    override commit(change: EntryChange): void { this.changes.push(change); }
  }
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(FixtureLoader);
  const loader = ctx.loader as FixtureLoader;
  const modules = [
    ['pwsh-sandbox', '@deepseek-ai/dsh-pwsh-sandbox'],
    ['tool-pwsh', '@deepseek-ai/dsh-tool-pwsh'],
    ['preset-standard', '@deepseek-ai/dsh-agent-preset'],
    ['preset-ptc', '@deepseek-ai/dsh-agent-preset'],
    ['preset-cordis', '@deepseek-ai/dsh-agent-preset'],
  ] as const;
  const rows = modules.map(([id, name]) => ({ id, name, disabled: id === 'preset-cordis', config: { timeoutMs: 1234 }, inject: { gitBashAdapter: null } }));
  const saved = structuredClone(rows);
  await loader.root.update(rows);
  await loader.await();
  const entries = [...loader.entries()];
  const configs = entries.map(entry => entry.options.config as unknown);
  const namespaces = entries.map(entry => entry.moduleNamespace);
  const adapter = ctx.plugin(Adapter);
  await adapter;
  await loader.await();
  for (const [i, entry] of entries.entries()) {
    assert.equal(loader.resolve(entry.id), entry);
    assert.equal(entry.options.config, configs[i]);
    assert.equal(entry.options.name, saved[i]!.name);
    assert.notEqual(entry.moduleNamespace, original);
  }
  assert.deepEqual(loader.root.data, saved);
  assert.deepEqual(loader.changes, [], 'activation must not persist a Shell settings change');
  await adapter.dispose();
  for (const [i, entry] of entries.entries()) assert.equal(entry.moduleNamespace, namespaces[i]);
  assert.deepEqual(loader.root.data, saved);
  assert.deepEqual(loader.changes, [], 'restoration must not persist a disable');

  const patch = parse(readFileSync(join(root, 'cordis.patch.yml'), 'utf8')) as Array<{ id?: string; inject?: unknown; insert?: unknown }>;
  assert.deepEqual(patch.filter(row => row.id).map(row => row.id), modules.map(([id]) => id));
  for (const row of patch.filter(row => row.id)) assert.deepEqual(row.inject, { gitBashAdapter: null });
  assert.deepEqual(patch.at(-1)?.insert, [{ id: 'git-bash-adapter', name: 'dsh-git-bash-on-win/adapter' }]);
  assert.deepEqual(packageJson.dsh.bundle, { patch: './cordis.patch.yml', platforms: ['win32'] });
});

await test('public pinned dependencies resolve and atomic-write is usable', async t => {
  assert.equal(packageJson.engines.dsh, SUPPORTED_DSH);
  assert.equal(packageJson.dependencies['@deepseek-ai/dsh-atomic-write'], SUPPORTED_DSH);
  for (const [name, version] of Object.entries({ ...packageJson.dependencies, ...packageJson.peerDependencies })) {
    const manifest = findPackageJSON(name, import.meta.url);
    assert.ok(manifest, name);
    const metadata = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
    assert.equal(metadata.version, version, name);
    assert.ok(require.resolve(name));
  }
  const directory = await temporaryDirectory(t);
  await writeFileAtomic(join(directory, 'metadata.json'), '{}\n', { mode: 0o600 });
  assert.equal(readFileSync(join(directory, 'metadata.json'), 'utf8'), '{}\n');
});

await test('installed CLI resolution needs no personal profile', { skip: !nativeWindows && 'Requires native Windows x64.' }, async t => {
  const manifest = findInstalledDshManifest();
  if (manifest === undefined) {
    t.skip('No installed DSH found; set DSH_PACKAGE_JSON to run this check.');
    return;
  }
  const runtime = installedDsh(manifest);
  assert.equal(runtime.version, SUPPORTED_DSH);
  const app = await runtime.load(runtime.cliRequire, '@deepseek-ai/dsh-app-boot') as { resolveProfileDir: unknown };
  const manager = await runtime.load(runtime.cliRequire, '@deepseek-ai/dsh-plugin-manager/operations') as { runPluginCommand: unknown };
  assert.equal(typeof app.resolveProfileDir, 'function');
  assert.equal(typeof manager.runPluginCommand, 'function');
  assert.ok(runtime.baseRequire.resolve('@deepseek-ai/dsh-subprocess-local'));
});

await test('CLI identity validation rejects invalid selections without an installed DSH', { skip: !nativeWindows && 'Requires native Windows x64.' }, async t => {
  const invalid = join(await temporaryDirectory(t), 'package.json');
  await writeFile(invalid, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0' }));
  assert.throws(() => installedDsh(invalid), /Expected @deepseek-ai\/dsh/);
  assert.throws(() => installedDsh('package.json'), /absolute/);
});

await test('maintained compiler graphs, lint and emitted public exports exclude historical inputs', async () => {
  for (const config of ['tsconfig.json', 'tsconfig.build.json']) {
    const filename = join(root, config);
    const raw = ts.readConfigFile(filename, ts.sys.readFile);
    assert.equal(raw.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, root);
    assert.deepEqual(parsed.errors, []);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const local = program.getSourceFiles().map(file => relative(root, file.fileName).replaceAll('\\', '/'))
      .filter(file => !file.split('/').includes('node_modules'));
    assert.ok(local.length);
    for (const file of local) assert.match(file, config === 'tsconfig.build.json' ? /^src\// : /^(src|scripts|test)\//);
    if (config === 'tsconfig.json') {
      assert.ok(local.includes('scripts/plugin.ts'));
      assert.ok(local.includes('test/bootstrap.test.ts'));
    }
    // TypeScript follows transitive imports even when tsconfig excludes them.
    // Also reject literal runtime file/launch references to historical trees.
    for (const source of program.getSourceFiles().filter(file => /^(src|scripts)\//.test(relative(root, file.fileName).replaceAll('\\', '/')))) {
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node)) assert.doesNotMatch(node.text, /(?:^|[\\/])(?:\.deprecated|tmp|poc)(?:[\\/]|$)/, source.fileName);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  const eslint = new ESLint({ cwd: root });
  for (const path of ['.deprecated/src/index.ts', 'tmp/probe.ts', 'poc/run.ts', 'lib/index.js']) assert.equal(await eslint.isPathIgnored(path), true);
  assert.equal(await eslint.isPathIgnored('test/bootstrap.test.ts'), false);
  const outputs = filesUnder(join(root, 'lib'));
  const expected = filesUnder(join(root, 'src'))
    .filter(file => file.endsWith('.ts')).flatMap(file => [file.replace(/\.ts$/, '.js'), file.replace(/\.ts$/, '.d.ts')]).sort();
  assert.deepEqual(outputs, expected, 'clean build contains only maintained production outputs');
  for (const value of Object.values(packageJson.exports)) {
    for (const path of typeof value === 'string' ? [value] : [value.default, value.types]) assert.ok(readFileSync(resolve(root, path)).length);
  }
  const built = await import(pathToFileURL(join(root, 'lib/index.js')).href) as { default: typeof GitBashExecutor };
  assert.equal(Object.getPrototypeOf(built.default), SandboxBashExecutor);
});

await test('execution and release packaging remain gated; purge refuses an unowned directory', async t => {
  // The extension point rejects before either the deferred confinement callback
  // or DSH subprocess launch can run, including full-access callers.
  class ExecutorProbe extends GitBashExecutor {
    static attempt() { return this.prototype.executeArgv(); }
  }
  await assert.rejects(ExecutorProbe.attempt(), /executor and launcher integration/);
  await assert.rejects(GitBashExecutor.prototype.rebuildRuntime(), /not implemented/);
  const directory = await temporaryDirectory(t);
  const sentinel = join(directory, 'owned.txt');
  await writeFile(sentinel, 'unowned directory must be retained');
  const cleanup = spawnSync(process.execPath, [join(root, 'lib/cleanup.js'), directory], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(cleanup.error, undefined);
  assert.equal(cleanup.status, 1);
  assert.match(cleanup.stderr, /uninstallation are incomplete/);
  for (const operation of [['add', root], ['remove', 'dsh-git-bash-on-win'], ['--silent', 'remove', 'dsh-git-bash-on-win']]) {
    const plugin = spawnSync(process.execPath, [join(root, 'scripts/plugin.ts'), process.execPath, 'bootstrap', ...operation], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, DSH_HOME: directory, DSH_PACKAGE_JSON: join(directory, 'missing-dsh.json') },
    });
    assert.equal(plugin.error, undefined);
    assert.equal(plugin.status, 1);
    assert.match(plugin.stderr, /Plugin package operations are unavailable until runtime integration/);
  }
  assert.deepEqual(filesUnder(directory), ['owned.txt']);
  assert.equal(readFileSync(sentinel, 'utf8'), 'unowned directory must be retained');
  const pnpm = process.env.npm_execpath ?? (process.platform === 'win32' ? 'pnpm.exe' : 'pnpm');
  const args = /\.[cm]?js$/.test(pnpm) ? [pnpm] : [];
  const executable = args.length ? process.execPath : pnpm;
  const blocked = spawnSync(executable, [...args, 'pack', '--dry-run'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(blocked.error, undefined);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stdout + blocked.stderr, /Backend refactor incomplete/);
  const packed = JSON.parse(execFileSync(executable, [...args, '--ignore-scripts', 'pack', '--dry-run', '--json'], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
  })) as { files: Array<{ path: string }> };
  const files = packed.files.map(file => file.path).sort();
  const expected = ['README.md', 'package.json', 'cordis.patch.yml',
    ...filesUnder(join(root, 'lib')).map(file => `lib/${file}`)].sort();
  assert.deepEqual(files, expected);
  assert.ok(files.every(file => dirname(file) === '.' || file.startsWith('lib/')));
});
