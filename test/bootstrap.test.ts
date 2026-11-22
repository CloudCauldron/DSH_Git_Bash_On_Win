import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { mkdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createRequire, findPackageJSON } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
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
import { readDictionaries } from '../src/locale/catalogs.ts';
import GitBashPreset from '../src/preset.ts';
import * as BashTool from '../src/tool.ts';
import { findInstalledDshManifest, installedDsh, SUPPORTED_DSH } from '../scripts/installed-dsh.ts';
import { profileEnvironment, localSpawn, runFixtureCommand, success, runtimeFixture, temporaryDirectory, readAclRecords } from './fixtures.ts';
import { pathExists } from '../src/runtime/ntfs-filesystem.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const nativeWindows = process.platform === 'win32' && process.arch === 'x64';
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  main: string;
  types: string;
  exports: Record<string, string | { types: string; default: string }>;
  engines: { dsh: string };
  dsh: { bundle: { patch: string; platforms: string[] }; client: { platform: string; inject: string[] } };
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
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

await test('executor requires a DSH profile before registering a Shell provider', {
  skip: !nativeWindows && 'Requires native Windows x64.',
}, async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const config = (GitBashExecutor.Config as unknown as (value: unknown) => Config)({});
  assert.throws(() => new GitBashExecutor(ctx, config), /requires a DSH profile context/);
  assert.equal(ctx.get('shell'), undefined);
});

await test('bundle adaptation preserves Loader entry/config identity and restores namespaces', { skip: !nativeWindows && 'Requires native Windows x64.' }, async t => {
  const original = { inject: ['bootstrapMissingService'], apply() {} };
  const replacements = new Map<string, unknown>([
    ['dsh-git-bash-on-win/executor', GitBashExecutor],
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
  assert.deepEqual(patch.at(-1)?.insert, [{ id: 'git-bash-adapter', name: 'dsh-git-bash-on-win' }]);
  assert.deepEqual(packageJson.dsh.bundle, { patch: './cordis.patch.yml', platforms: ['win32'] });
});

await test('the classic client registers dictionaries and the bundle slot after one locale request', async t => {
  const ns = 'dsh-git-bash-on-win', slot = 'plugins.bundle.config';
  assert.deepEqual(packageJson.dsh.client, { platform: 'web', inject: [
    '@deepseek-ai/dsh-client-ui-plugin-manager', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-locale',
  ] });
  type ClientPlugin = { inject: string[]; apply(ctx: unknown): Promise<void> };
  type Registration = { id: string; factory(require: (name: string) => unknown): ClientPlugin };
  const load = t.mock.fn<(entry: Registration) => void>();
  const dictionaries = { zh: { 'path.label': 'Git Bash 路径' }, en: { 'path.label': 'Git Bash path' }, fr: { 'path.label': 'Chemin Git Bash' } };
  const request = t.mock.fn(async (url: string, options: RequestInit) => {
    assert.equal(url, 'api/git-bash-on-win/locales');
    assert.deepEqual({ ...options }, { cache: 'no-store', redirect: 'error' });
    return Response.json({ ok: true, dictionaries });
  });
  const client = require.resolve(ns + '/client');
  new Script(readFileSync(client, 'utf8'), { filename: client })
    .runInNewContext({ window: { __ModuleLoader__: { load } }, fetch: request });
  assert.equal(load.mock.callCount(), 1);
  assert.equal(request.mock.callCount(), 0);
  const [entry] = load.mock.calls[0]!.arguments;
  assert.equal(entry.id, ns);
  const hostRequire = t.mock.fn((name: string) => {
    assert.ok(['react', '@deepseek-ai/dsh-client-ui-primitives'].includes(name));
    return {};
  });
  const plugin = entry.factory(hostRequire);
  assert.deepEqual(hostRequire.mock.calls.map(call => call.arguments[0]), ['react', '@deepseek-ai/dsh-client-ui-primitives']);
  assert.deepEqual([...plugin.inject], ['slots', 'configForms', 'locale']);
  assert.equal(request.mock.callCount(), 0);

  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const fiber = ctx.plugin(() => {});
  await fiber;
  const disposeLocale = t.mock.fn();
  const registerLocale = t.mock.fn<(ns: string, dictionaries: Record<string, unknown>) => () => void>(() => disposeLocale);
  const form = {};
  const get = t.mock.fn<(id: string) => object>(() => form);
  type SlotEntry = { name: string; key?: string; id?: string; locale: string; inject(): { shellForm: unknown; hooks: { shellForm: unknown } } };
  const register = t.mock.fn<(entry: SlotEntry, component: unknown) => void>();
  const context = {
    fiber, effect: fiber.effect.bind(fiber), locale: { register: registerLocale }, configForms: { get },
    slots: { inject(name: string, setup: () => void) { assert.equal(name, slot); setup(); }, register },
  };

  request.mock.mockImplementationOnce(async () => new Response(null, { status: 404 }));
  await assert.rejects(plugin.apply(context), error => {
    const e = error as Error & { messages: unknown };
    assert.match(e.message, /HTTP 404/);
    assert.deepEqual(structuredClone(e.messages), [{ key: 'error.localeHttp', params: { status: '404' } }]);
    return true;
  });
  request.mock.mockImplementationOnce(async () => Response.json({ ok: true, dictionaries: { zh: {} } }));
  await assert.rejects(plugin.apply(context), error => {
    assert.deepEqual(structuredClone((error as { messages: unknown }).messages), [{ key: 'error.invalidLocaleDictionaries' }]);
    return true;
  });
  assert.equal(registerLocale.mock.callCount(), 0);
  assert.equal(register.mock.callCount(), 0);
  await plugin.apply(context);
  assert.equal(request.mock.callCount(), 3, 'one request per activation');
  assert.deepEqual(structuredClone(registerLocale.mock.calls.map(call => call.arguments)), [[ns, dictionaries]]);
  assert.deepEqual(get.mock.calls.map(call => call.arguments[0]), ['pwsh-sandbox']);
  assert.equal(register.mock.callCount(), 1);
  const [config, component] = register.mock.calls[0]!.arguments;
  assert.deepEqual([config.name, config.key, config.locale], [slot, ns, ns]);
  assert.equal(typeof component, 'function');
  const injection = config.inject();
  assert.equal(injection.shellForm, form);
  assert.equal(injection.hooks.shellForm, form);
  let respond!: (response: Response) => void;
  request.mock.mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
  const pending = plugin.apply(context);
  await fiber.dispose();
  respond(new Response(null, { status: 503 }));
  await pending;
  assert.equal(registerLocale.mock.callCount(), 1);
  assert.equal(disposeLocale.mock.callCount(), 1);
  assert.equal(register.mock.callCount(), 1);

  const englishOnly = ctx.plugin(() => {});
  await englishOnly;
  request.mock.mockImplementationOnce(async () => Response.json({ ok: true, dictionaries: { en: dictionaries.en } }));
  await plugin.apply({ ...context, fiber: englishOnly, effect: englishOnly.effect.bind(englishOnly) });
  assert.deepEqual(structuredClone(registerLocale.mock.calls.at(-1)!.arguments), [ns, { en: dictionaries.en }]);
  await englishOnly.dispose();
});

await test('public pinned dependencies resolve and atomic-write is usable', async t => {
  assert.equal(packageJson.engines.dsh, SUPPORTED_DSH);
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), ['@deepseek-ai/dsh-atomic-write', '@deepseek-ai/dsh-error',
    '@deepseek-ai/dsh-win32-process', '@deepseek-ai/schemastery', 'koffi']);
  const dshDevDependencies = Object.entries(packageJson.devDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'));
  const dependencies = [...Object.entries(packageJson.dependencies), ...Object.entries(packageJson.peerDependencies), ...dshDevDependencies];
  for (const [name, version] of dependencies) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(version, SUPPORTED_DSH, name);
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
  assert.throws(() => installedDsh('package.json'), {
    message: 'DSH_PACKAGE_JSON must be an absolute package.json path.',
    messages: [{ key: 'error.dshManifestPath', params: { variable: 'DSH_PACKAGE_JSON', manifest: 'package.json' } }],
  });
});

await test('maintained compiler graphs, lint and emitted public exports exclude non-production inputs from the package', async () => {
  for (const config of ['tsconfig.json', 'tsconfig.build.json']) {
    const filename = join(root, config);
    const raw = ts.readConfigFile(filename, ts.sys.readFile);
    assert.equal(raw.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, root);
    assert.deepEqual(parsed.errors, []);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const en = (require('dsh-git-bash-on-win/locale/en.json') as { messages: Record<string, string> }).messages;
    const local = program.getSourceFiles().map(file => relative(root, file.fileName).replaceAll('\\', '/'))
      .filter(file => !file.split('/').includes('node_modules'));
    assert.ok(local.length);
    for (const file of local) assert.match(file, config === 'tsconfig.build.json' ? /^src\// : /^(src|scripts|test)\//);
    if (config === 'tsconfig.json') {
      assert.ok(local.includes('scripts/plugin.ts'));
      assert.ok(local.includes('test/bootstrap.test.ts'));
    }
    // TypeScript follows transitive imports even when tsconfig excludes them.
    // Also reject literal runtime file/launch references to documentation and scratch directories.
    for (const source of program.getSourceFiles().filter(file => /^(src|scripts)\//.test(relative(root, file.fileName).replaceAll('\\', '/')))) {
      const visit = (node: ts.Node, parent?: ts.Node): void => {
        if (ts.isStringLiteralLike(node)) {
          // Git's own tmp directory is excluded by a name comparison during shallow enumeration.
          const comparesTempName = node.text === 'tmp' && parent && ts.isBinaryExpression(parent)
            && parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken;
          if (!comparesTempName) assert.doesNotMatch(node.text, /(?:^|[\\/])(?:docs|tmp)(?:[\\/]|$)/, source.fileName);
          if (/^error\.\w+$/.test(node.text)) assert.ok(Object.hasOwn(en, node.text), node.text);
        }
        ts.forEachChild(node, child => visit(child, node));
      };
      visit(source);
    }
  }
  const eslint = new ESLint({ cwd: root });
  for (const path of ['tmp/probe.ts', 'lib/index.js']) assert.equal(await eslint.isPathIgnored(path), true);
  assert.equal(await eslint.isPathIgnored('test/bootstrap.test.ts'), false);
  const outputs = filesUnder(join(root, 'lib'));
  const expected = filesUnder(join(root, 'src'))
    .filter(file => file.endsWith('.ts')).flatMap(file => [file.replace(/\.ts$/, '.js'), file.replace(/\.ts$/, '.d.ts')]);
  expected.push('dsh-msys-compat.dll'); expected.sort();
  assert.deepEqual(outputs, expected, 'clean build contains only maintained production outputs');
  assert.equal(packageJson.main, './lib/adapter.js');
  assert.equal(packageJson.types, './lib/adapter.d.ts');
  assert.deepEqual(packageJson.exports['.'], { types: packageJson.types, default: packageJson.main });
  assert.deepEqual(packageJson.exports['./executor'], { types: './lib/index.d.ts', default: './lib/index.js' });
  assert.equal(packageJson.exports['./client'], './lib/client.js');
  assert.equal(packageJson.exports['./locale/*.json'], './locale/*.json');
  assert.equal(packageJson.exports['./adapter'], undefined);
  for (const value of Object.values(packageJson.exports)) {
    for (const path of typeof value === 'string' ? [value] : [value.default, value.types]) {
      for (const file of path.includes('*') ? filesUnder(join(root, 'locale')).map(name => './locale/' + name) : [path]) {
        assert.ok(readFileSync(resolve(root, file)).length);
      }
    }
  }
  const built = await import(pathToFileURL(require.resolve('dsh-git-bash-on-win/executor')).href) as { default: typeof GitBashExecutor };
  assert.equal(Object.getPrototypeOf(built.default), SandboxBashExecutor);
});

await test('offline tooling rejects unowned directories and unsupported package operations', async t => {
  const directory = await temporaryDirectory(t);
  const cache = join(directory, '.dsh-git-bash-on-win');
  await mkdir(cache);
  const sentinel = join(cache, 'owned.txt');
  await writeFile(sentinel, 'unowned directory must be retained');
  const purge = spawnSync(process.execPath, [join(root, 'lib/purge-runtime-cache.js'), cache], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(purge.error, undefined);
  assert.equal(purge.status, 1);
  assert.match(purge.stderr, /uninstallation are incomplete/);
  for (const operation of [['add', root], ['add', 'file:relative'], ['add', 'file:' + join(root, 'package.json')],
    ['remove', 'another-package'], ['--silent', 'remove', 'dsh-git-bash-on-win'],
    ['remove', 'dsh-git-bash-on-win', '--dir', directory]]) {
    const plugin = spawnSync(process.execPath, [join(root, 'scripts/plugin.ts'), process.execPath, 'bootstrap', ...operation], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, DSH_HOME: directory, DSH_PACKAGE_JSON: join(directory, 'missing-dsh.json') },
    });
    assert.equal(plugin.error, undefined);
    assert.equal(plugin.status, 1);
    assert.match(plugin.stderr, /Usage: node scripts\/plugin.ts/);
  }
  assert.deepEqual(filesUnder(directory), ['.dsh-git-bash-on-win/owned.txt']);
  assert.equal(readFileSync(sentinel, 'utf8'), 'unowned directory must be retained');
});

await test('checkout install, offline recovery and removal preserve shared Shell settings and source files', {
  skip: !nativeWindows && 'Requires native Windows x64, pinned DSH and pnpm.',
}, async t => {
  const spawn = await localSpawn(t); if (!spawn) return;
  const runtime = installedDsh(), fixture = await runtimeFixture(t, 'ucrt64', join('home', '.dsh-git-bash-on-win'));
  const pnpm = realpathSync(process.env.npm_execpath?.endsWith('.exe') ? process.env.npm_execpath
    : execFileSync('where.exe', ['pnpm.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]!);
  const home = join(fixture.directory, 'home'), profile = join(home, 'profiles', 'integration');
  const { initProfile, assertBundlePlatform } = await runtime.load(runtime.cliRequire, '@deepseek-ai/dsh-app-boot') as {
    initProfile(dir: string, bundles: string[]): void;
    assertBundlePlatform(platforms: string[], host: string): void;
  };
  initProfile(profile, ['@deepseek-ai/dsh-base']);
  assert.throws(() => assertBundlePlatform(['win32'], 'linux'), /supports Host platforms/);
  const patchPath = join(profile, 'cordis.patch.yml');
  const shared = { timeoutMs: 12345, maxOutputBytes: 65536, graceMs: 500 };
  const patches = [{ id: 'pwsh-sandbox', config: { ...shared, gitBashPath: fixture.request.gitBashPath } }];
  await writeFile(patchPath, JSON.stringify(patches)); // JSON is a valid native YAML patch.
  // Keep package-manager state and all profile changes inside this fixture.
  const env = profileEnvironment(fixture.directory, home);
  const run = (argv: string[], cwd = fixture.directory) => runFixtureCommand(spawn, argv, cwd, env, t.signal);
  const checkout = 'file:' + resolve(root).replaceAll('\\', '/');
  const operation = (verb: 'add' | 'remove', target: string, ...flags: string[]) => run([process.execPath, join(root, 'scripts/plugin.ts'), pnpm, 'integration', verb, target, ...flags]);
  success(await operation('add', checkout));
  const manifest = () => JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>; dsh: { profile: { bundles: string[] } };
  };
  assert.ok(manifest().dsh.profile.bundles.includes('dsh-git-bash-on-win'));
  assert.match(manifest().dependencies?.['dsh-git-bash-on-win'] ?? '', /^file:/);
  assert.deepEqual(parse(readFileSync(patchPath, 'utf8')), patches);
  const profileRequire = createRequire(join(profile, 'package.json'));
  const packageRoot = dirname(realpathSync(profileRequire.resolve('dsh-git-bash-on-win/package.json')));
  assert.deepEqual(readdirSync(packageRoot).sort(), ['README.md', 'README_CN.md', 'cordis.patch.yml', 'lib', 'locale', 'package.json']);
  const builtFiles = filesUnder(join(root, 'lib'));
  assert.deepEqual(filesUnder(join(packageRoot, 'lib')), builtFiles);
  for (const file of ['cordis.patch.yml', ...builtFiles.map(name => join('lib', name))]) {
    assert.deepEqual(readFileSync(join(packageRoot, file)), readFileSync(join(root, file)), file);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')), packageJson);
  const localeFiles = filesUnder(join(root, 'locale'));
  assert.deepEqual(filesUnder(join(packageRoot, 'locale')), localeFiles);
  for (const file of localeFiles) assert.deepEqual(readFileSync(join(packageRoot, 'locale', file)), readFileSync(join(root, 'locale', file)));
  const english = readDictionaries().en!;
  const placeholders = (value: string) => value.match(/{[a-zA-Z0-9_]+}/g)?.sort() ?? [];
  for (const file of localeFiles) {
    const path = profileRequire.resolve('dsh-git-bash-on-win/locale/' + file);
    assert.equal(realpathSync(path), join(packageRoot, 'locale', file));
    const { meta, messages } = JSON.parse(readFileSync(path, 'utf8')) as {
      meta?: { title: string; description: string; detail: string }; messages: Record<string, string>;
    };
    if (file === 'en.json' || file === 'zh.json') {
      assert.equal(meta?.title, 'DSH Git Bash on Windows');
      assert.ok(meta.description.trim());
      assert.equal(meta.detail, file === 'zh.json' ? 'README_CN.md' : 'README.md');
      assert.deepEqual(readFileSync(join(packageRoot, meta.detail)), readFileSync(join(root, meta.detail)));
    }
    for (const [key, value] of Object.entries(messages)) {
      assert.ok(Object.hasOwn(english, key), key);
      assert.deepEqual(placeholders(value), placeholders(english[key]!), key);
    }
  }
  assert.equal(realpathSync(profileRequire.resolve('dsh-git-bash-on-win/client')), join(packageRoot, 'lib', 'client.js'));
  // Exercise DSH's real profile resolver: adding standalone dependencies must
  // not split the host's Cordis service or native Shell schema identities.
  const sourceFile = join(fixture.source, 'usr/bin/bash.exe');
  const before = { bytes: readFileSync(sourceFile), links: statSync(sourceFile).nlink,
    acl: readAclRecords(sourceFile) };
  const identityEntry = join(fixture.directory, 'profile-identity.mjs');
  await writeFile(identityEntry, `
    import assert from 'node:assert/strict';
    import fs, { existsSync, readFileSync } from 'node:fs';
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    import { join, toNamespacedPath } from 'node:path';
    import { mock } from 'node:test';
    import { pathToFileURL } from 'node:url';
    import { Context } from ${JSON.stringify(pathToFileURL(runtime.baseRequire.resolve('@deepseek-ai/cordis')).href)};
    import { SandboxBashExecutor } from ${JSON.stringify(pathToFileURL(runtime.baseRequire.resolve('@deepseek-ai/dsh-bash-sandbox')).href)};
    import Loader from ${JSON.stringify(pathToFileURL(runtime.cliRequire.resolve('@deepseek-ai/cordis-plugin-loader')).href)};
    import * as Connection from ${JSON.stringify(pathToFileURL(runtime.cliRequire.resolve('@deepseek-ai/dsh-client-connection')).href)};
    import Credentials from ${JSON.stringify(pathToFileURL(runtime.baseRequire.resolve('@deepseek-ai/dsh-credentials-local')).href)};
    import ClientModules from ${JSON.stringify(pathToFileURL(runtime.cliRequire.resolve('@deepseek-ai/dsh-client-modules')).href)};
    import { PluginPackages, createRuntimeResolution, loadProfileDirectory } from ${JSON.stringify(pathToFileURL(runtime.cliRequire.resolve('@deepseek-ai/dsh-app-boot')).href)};
    const [dir, home, installAnchor] = process.argv.slice(2), ctx = new Context();
    try {
      const profile = loadProfileDirectory('dsh', dir, installAnchor);
      await ctx.plugin(PluginPackages, { resolution: await createRuntimeResolution({ profile, home, installAnchor }) });
      const require = createRequire(join(dir, 'package.json'));
      const adapter = await import(pathToFileURL(require.resolve('dsh-git-bash-on-win')).href);
      assert.equal(typeof adapter.apply, 'function');
      assert.deepEqual(adapter.inject, { loader: { await: false } });
      assert.throws(() => require.resolve('dsh-git-bash-on-win/adapter'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
      const { default: Executor } = await import(pathToFileURL(require.resolve('dsh-git-bash-on-win/executor')).href);
      assert.ok(Executor.Config.dict.gitBashPath);
      assert.equal(Object.getPrototypeOf(Executor), SandboxBashExecutor);
      await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(dir, 'package.json')).href });
      const layer = profile.layers.find(layer => layer.packageName === 'dsh-git-bash-on-win');
      const shellConfig = profile.patches.find(row => row.id === 'pwsh-sandbox').config;
      assert.ok(shellConfig.gitBashPath);
      await ctx.loader.root.update([
        { name: '@deepseek-ai/dsh-pwsh-sandbox', ...layer.patches.find(row => row.id === 'pwsh-sandbox'), config: shellConfig },
        ...layer.patches.flatMap(row => row.insert ?? []),
      ]);
      await ctx.loader.await();
      assert.equal(ctx.loader.resolve('pwsh-sandbox').moduleNamespace.default, Executor);
      await ctx.plugin(ClientModules);
      assert.deepEqual(ctx.clientModules.graph().entries.map(row => row.id), ['dsh-git-bash-on-win']);
      assert.equal(ctx.clientModules.clientPath('dsh-git-bash-on-win'), require.resolve('dsh-git-bash-on-win/client'));
      await ctx.plugin(Credentials);
      await ctx.plugin(Connection);
      const routes = ctx.connection.createSharedFetchHandler('/api');
      const url = 'http://localhost/api/git-bash-on-win/locales';
      const get = (method = 'GET', peer = ctx.connection.browserPeer) => routes.fetch(new Request(url, { method }), peer);
      assert.equal((await get()).status, 404, 'no route outside a profile');
      const profileScope = ctx.plugin(scope => { scope.provide('profileContext', { dir, home, installAnchor }); });
      await profileScope;
      await ctx.loader.await();
      assert.equal((await get('POST')).status, 404);
      assert.equal((await get('GET', { principal: { kind: 'other' } })).status, 403);
      const response = await get();
      assert.equal(response.status, 200);
      const dictionaries = ${JSON.stringify(readDictionaries())};
      assert.deepEqual(await response.json(), { ok: true, dictionaries });
      const rebuild = (method = 'POST', peer = ctx.connection.browserPeer) =>
        routes.fetch(new Request('http://localhost/api/git-bash-on-win/rebuild', { method }), peer);
      assert.equal((await rebuild()).status, 404, 'only a live executor owns the rebuild route');
      const services = ctx.plugin(scope => {
        scope.provide('sandbox', {});
        scope.provide('sandboxPolicy', { defaultMode: 'read-only' });
        scope.provide('subprocess', { spawn() { throw new Error('Local fixture linking requires no subprocess.'); } });
      });
      await services;
      await ctx.loader.await();
      assert.equal((await rebuild('GET')).status, 404);
      assert.equal((await rebuild('POST', { principal: { kind: 'other' } })).status, 403);
      assert.equal(existsSync(join(home, '.dsh-git-bash-on-win')), false, 'discovery and dictionary reads leave the runtime cold');
      const patchFile = join(dir, 'cordis.patch.yml');
      const beforeRead = readFileSync(patchFile, 'utf8');
      // Observe the configured executable's existence check with the real executor active.
      const stat = mock.method(fs, 'lstatSync');
      syncBuiltinESMExports();
      const probed = () => stat.mock.calls.some(call => call.arguments[0] === toNamespacedPath(shellConfig.gitBashPath));
      const rebuilds = mock.method(Executor.prototype, 'rebuildRuntime');
      assert.deepEqual(await (await get()).json(), { ok: true, dictionaries });
      assert.equal(probed(), false);
      assert.equal(rebuilds.mock.callCount(), 0);
      assert.equal(readFileSync(patchFile, 'utf8'), beforeRead);
      const feedbackUrl = 'http://localhost/api/git-bash-on-win/feedback';
      for (const method of ['GET', 'POST']) assert.equal((await routes.fetch(new Request(feedbackUrl, { method }), ctx.connection.browserPeer)).status, 404);
      const first = rebuild();
      const busy = await rebuild();
      assert.equal(busy.ok, false);
      assert.deepEqual(await busy.json(), { error: 'Git Bash runtime rebuilding is busy.', messages: [{ key: 'error.rebuildBusy' }] });
      assert.equal((await first).status, 204);
      assert.equal(probed(), true, 'explicit rebuild exercises the observed Git probe');
      assert.equal(rebuilds.mock.callCount(), 2);
      await services.dispose();
      await ctx.loader.await();
      assert.equal((await rebuild()).status, 404, 'disposing the executor releases the route');
      assert.equal((await get()).status, 200, 'dictionary reads are independent of the executor');
      await profileScope.dispose();
      assert.equal((await get()).status, 404, 'the injection scope releases the route');
      for (const [name, field] of Object.entries(SandboxBashExecutor.Config.dict)) assert.equal(Executor.Config.dict[name], field);
    } finally { mock.restoreAll(); syncBuiltinESMExports(); await ctx.fiber.dispose(); }
  `);
  const cache = fixture.cache;
  const purge = () => run([process.execPath, join(packageRoot, 'lib/purge-runtime-cache.js'), cache]);
  try {
    success(await run([process.execPath, identityEntry, profile, home, runtime.manifest]));
    const published = JSON.parse(readFileSync(join(cache, 'current.json'), 'utf8')) as { sourceRoot: string };
    assert.equal(published.sourceRoot, fixture.source);
    assert.equal(statSync(sourceFile).nlink, before.links);
  } finally { success(await purge()); }
  assert.equal(statSync(sourceFile).nlink, before.links);
  assert.deepEqual(parse(readFileSync(patchPath, 'utf8')), patches);
  for (const dead of ['debugger', 'setup', 'bash-launcher.js', 'link-runtime-cache.js', 'rebuild-feedback.js']) {
    assert.equal(pathExists(join(packageRoot, 'lib', dead)), false);
  }
  // Replace the bundled file only inside this owned installation, detaching the package-store hardlink.
  const shimCheck = join(fixture.directory, 'shim-refresh.mjs');
  await writeFile(shimCheck, `
    import assert from 'node:assert/strict';
    import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
    import { join } from 'node:path';
    import { prepareRuntime, bundledShimUrl } from ${JSON.stringify(pathToFileURL(join(packageRoot, 'lib/runtime/runtime-cache.js')).href)};
    const [cacheDirectory, gitBashPath] = process.argv.slice(2);
    const prepare = async () => {
      await (await prepareRuntime({ cacheDirectory, gitBashPath }, new AbortController().signal)).release();
      return JSON.parse(await readFile(join(cacheDirectory, 'current.json'), 'utf8'));
    };
    const before = await prepare(), bytes = await readFile(bundledShimUrl);
    const saved = new URL('./original.dll', bundledShimUrl);
    await rename(bundledShimUrl, saved);
    try {
      await writeFile(bundledShimUrl, Buffer.concat([bytes, Buffer.from([0])]), { flag: 'wx' });
      const after = await prepare();
      assert.notEqual(before.generationId, after.generationId);
      assert.equal(before.patchAbi, after.patchAbi);
    } finally { await unlink(bundledShimUrl); await rename(saved, bundledShimUrl); }
  `);
  success(await run([process.execPath, shimCheck, cache, sourceFile]));
  const prepare = () => fixture.prepare(false, t.signal, cache);
  const pin = await prepare();
  try {
    const blocked = await operation('remove', 'dsh-git-bash-on-win', '--purge-cache');
    assert.notEqual(blocked.exitCode, 0);
    assert.match(blocked.stderr, /package removal was not started/);
    assert.ok(manifest().dependencies?.['dsh-git-bash-on-win']);
    const selected = readFileSync(join(cache, 'current.json'), 'utf8');
    success(await operation('remove', 'dsh-git-bash-on-win'));
    assert.equal(manifest().dependencies?.['dsh-git-bash-on-win'], undefined);
    assert.equal(readFileSync(join(cache, 'current.json'), 'utf8'), selected);
    success(await operation('add', checkout));
  } finally { await pin.release(); }
  const current = readFileSync(join(cache, 'current.json'), 'utf8');
  success(await operation('add', checkout));
  assert.equal(readFileSync(join(cache, 'current.json'), 'utf8'), current, 'package installation retains the shared cache');
  success(await purge());
  assert.equal(pathExists(cache), false);
  assert.deepEqual(parse(readFileSync(patchPath, 'utf8')), patches, 'offline rebuild retains the override and package');
  assert.equal(statSync(sourceFile).nlink, before.links);

  // Unowned cache contents block removal before the package manager runs.
  await mkdir(cache);
  const sentinel = join(cache, 'unowned.txt');
  try {
    await writeFile(sentinel, 'Do not delete unowned contents.');
    const refused = await operation('remove', 'dsh-git-bash-on-win', '--purge-cache');
    assert.notEqual(refused.exitCode, 0); assert.match(refused.stderr, /package removal was not started/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'Do not delete unowned contents.');
    assert.ok(manifest().dependencies?.['dsh-git-bash-on-win']);
  } finally {
    // Only the objects this test created; plugin purge must refuse this root.
    if (pathExists(sentinel)) await unlink(sentinel);
    if (pathExists(cache)) await rmdir(cache);
  }

  // Documented uninstall step: edit only the plugin field before closing DSH.
  const remaining = [{ id: 'pwsh-sandbox', config: shared }];
  await writeFile(patchPath, JSON.stringify(remaining));
  const dump = () => run([process.execPath, join(dirname(runtime.manifest), 'lib/bin.js'), '--profile', 'integration', '--dump-config']);
  const enabled = await dump(); success(enabled); assert.match(enabled.stdout, /git-bash-adapter/);
  await (await prepare()).release();
  success(await operation('remove', 'dsh-git-bash-on-win', '--purge-cache'));
  assert.equal(manifest().dependencies?.['dsh-git-bash-on-win'], undefined);
  assert.equal(manifest().dsh.profile.bundles.includes('dsh-git-bash-on-win'), false);
  assert.equal(pathExists(cache), false);
  assert.deepEqual(parse(readFileSync(patchPath, 'utf8')), remaining);
  const restored = await dump(); success(restored); assert.doesNotMatch(restored.stdout, /git-bash-adapter|gitBashPath/);
  assert.match(restored.stdout, /timeoutMs: 12345/);
  assert.deepEqual(readFileSync(sourceFile), before.bytes);
  assert.equal(statSync(sourceFile).nlink, before.links);
  assert.equal(readAclRecords(sourceFile), before.acl);
});
