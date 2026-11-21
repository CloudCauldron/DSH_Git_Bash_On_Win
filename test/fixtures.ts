import { copyFile, mkdtemp, rm, mkdir, writeFile, link, readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import { closeHandleChecked, extendWin32ProcessBindings, Win32Error, type NativePtr } from '@deepseek-ai/dsh-win32-process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox';
import type Subprocess from '@deepseek-ai/dsh-subprocess';
import { findInstalledDshManifest, installedDsh } from '../scripts/installed-dsh.ts';
import { admitDirectory, NativeHold, removeTree } from '../src/runtime/ntfs-filesystem.ts';
import { prepareRuntime, purgeRuntimeCache, type GenerationPin, type RuntimePreparation } from '../src/runtime/runtime-cache.ts';
import { anchorPaths, discoverGitInstallation, inventoryGitFiles, type AnchorStamps, type GitLayout } from '../src/runtime/git-installation.ts';

/** Keep every ACL record. icacls localizes its final success count to the console language. */
export function readAclRecords(path: string, recursive = false): string {
  const report = execFileSync('icacls.exe', recursive ? [path, '/T'] : [path], { encoding: 'latin1', maxBuffer: 32 * 1024 * 1024 });
  const footer = report.trimEnd().lastIndexOf('\n');
  assert.ok(footer > 0, 'icacls must return ACL records before its summary');
  return report.slice(0, footer);
}

/** Ordinary bootstrap files only. Native cache fixtures must use guarded purge. */
export async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-git-bash-bootstrap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export const nativeWindows = process.platform === 'win32' && process.arch === 'x64';
export const nativeOnly = { skip: !nativeWindows && 'Requires native Windows x64 and NTFS.' };

/** Query actual section write/read authorization without mapping or altering pinfo. */
export function sectionAccess(name: string, write: boolean): number {
  const unicode = koffi.struct({ Length: 'uint16', MaximumLength: 'uint16', Buffer: 'str16' });
  const attributes = koffi.struct({ Length: 'uint32', RootDirectory: 'void *', ObjectName: koffi.pointer(unicode),
    Attributes: 'uint32', SecurityDescriptor: 'void *', SecurityQualityOfService: 'void *' });
  assert.equal(unicode.size, 16); assert.equal(attributes.size, 48);
  const object = { Length: 48, RootDirectory: null, ObjectName: { Length: Buffer.byteLength(name, 'utf16le'),
    MaximumLength: Buffer.byteLength(name, 'utf16le') + 2, Buffer: name }, Attributes: 64, SecurityDescriptor: null, SecurityQualityOfService: null };
  const api = extendWin32ProcessBindings(({ bind }) => ({
    openSection: bind(koffi.load('ntdll.dll'), 'NtOpenSection', 'int32', ['void *', 'uint32', koffi.pointer(attributes)]),
  }) as { openSection(output: Buffer, access: number, attributes: typeof object): number });
  const output = Buffer.alloc(8), status = api.openSection(output, write ? 2 : 4, object);
  if (status >= 0) closeHandleChecked(api, output.readBigUInt64LE() as NativePtr, 'fixture pinfo access');
  return status >>> 0;
}

/** All native payloads are owned copies; teardown never uses recursive rm. */
export async function runtimeFixture(t: TestContext, layout: GitLayout = 'ucrt64', cacheName = 'cache') {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-git-bash-native-'));
  const source = join(directory, 'source'), cache = join(directory, cacheName), workspace = join(directory, 'workspace');
  const pins = new Set<GenerationPin>();
  const caches = new Set([cache]);
  t.after(async () => {
    for (const pin of pins) await pin.release();
    for (const path of caches) await purgeRuntimeCache(path);
    removeTree(admitDirectory(dirname(directory)), basename(directory));
  });
  await mkdir(source);
  await mkdir(workspace);
  for (const file of [...Object.values(anchorPaths(layout)), 'usr/lib/perl/module.pm', 'usr/share/doc/ignored.txt', 'usr/lib/winpty.lib', `${layout}/libexec/git-core/git-helper.exe`]) {
    await mkdir(dirname(join(source, file)), { recursive: true });
    if (file === 'usr/bin/sh.exe') await link(join(source, 'usr/bin/bash.exe'), join(source, file));
    else await writeFile(join(source, file), `fixture ${file}\n`);
  }
  const request: RuntimePreparation = {
    elevation: 'manual',
    installAnchor: process.versions.electron ? findInstalledDshManifest() : undefined,
    cacheDirectory: cache, gitBashPath: join(source, 'usr/bin/bash.exe'),
    spawn: () => { throw new Error('This fixture must never start a subprocess or open UAC.'); },
  };
  return {
    directory, source, cache, workspace, request,
    async prepare(rebuild = false, signal = new AbortController().signal, cacheDirectory = cache) {
      caches.add(cacheDirectory);
      const pin = await prepareRuntime({ ...request, rebuild, cacheDirectory }, signal);
      pins.add(pin);
      return pin;
    },
    async current() {
      return JSON.parse(await readFile(join(cache, 'current.json'), 'utf8')) as {
        schemaVersion: 1; generationId: string; sourceRoot: string; layout: GitLayout; anchors: AnchorStamps;
      };
    },
  };
}

export function profileEnvironment(directory: string, home: string): NodeJS.ProcessEnv {
  return { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
    TMP: directory, TEMP: directory, TMPDIR: directory,
    PNPM_CONFIG_STORE_DIR: join(directory, 'pnpm-store'), PNPM_CONFIG_CACHE_DIR: join(directory, 'pnpm-cache'),
    PNPM_CONFIG_STATE_DIR: join(directory, 'pnpm-state') };
}

export async function runFixtureCommand(spawn: Subprocess['spawn'], argv: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const child = spawn({ argv, cwd, env, graceMs: 500, signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 128 * 1024 }, stderr: { maxBytes: 128 * 1024 } } });
  try {
    const outcome = await child.done;
    assert.equal(await child.waitForExit(AbortSignal.timeout(5000)), true);
    return { ...outcome, stdout: child.collected.stdout!.readFrom(0).text, stderr: child.collected.stderr!.readFrom(0).text };
  } finally {
    child.terminate();
    assert.equal(await child.waitForExit(AbortSignal.timeout(5000)), true, 'fixture command must release its managed range');
  }
}

export function success(result: { exitCode: number | null; stdout: string; stderr: string }) {
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
}

export function denyProbe(t: TestContext, hold = NativeHold) {
  const link = hold.prototype.linkTo;
  const mock = t.mock.method(hold.prototype, 'linkTo', function (this: NativeHold, parent: NativeHold, name: string) {
    if (name === '.probe') throw new Win32Error('FileLinkInformation', 5, 'fixture probe denial');
    link.call(this, parent, name);
  });
  return () => mock.mock.restore();
}

/** An isolated installed provider, with no Loader, settings or personal profile. */
export async function localSpawn(t: TestContext): Promise<Subprocess['spawn'] | undefined> {
  const manifest = findInstalledDshManifest();
  if (!manifest) { t.skip('No installed DSH; set DSH_PACKAGE_JSON for native subprocess checks.'); return; }
  const runtime = installedDsh(manifest);
  const { Context } = await runtime.load(runtime.baseRequire, '@deepseek-ai/cordis') as typeof import('@deepseek-ai/cordis');
  const { LocalSubprocessRuntime } = await runtime.load(runtime.baseRequire, '@deepseek-ai/dsh-subprocess-local') as {
    LocalSubprocessRuntime: new (ctx: Context) => Subprocess;
  };
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LocalSubprocessRuntime);
  return ctx.subprocess.spawn.bind(ctx.subprocess);
}

/** Real providers, owned Git bytes, and no personal Loader/profile state. */
export async function executionFixture(t: TestContext) {
  const manifest = findInstalledDshManifest();
  if (!manifest) { t.skip('No installed pinned DSH; set DSH_PACKAGE_JSON.'); return; }
  const runtime = installedDsh(manifest);
  let installed;
  try { installed = discoverGitInstallation(process.env.DSH_TEST_GIT_BASH); }
  catch (error) {
    if (!process.env.DSH_TEST_GIT_BASH && error instanceof Error && error.message.startsWith('Supported Git for Windows was not found')) {
      t.skip('No supported Git for Windows; set DSH_TEST_GIT_BASH.'); return;
    }
    throw error;
  }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-git-bash-execution-'));
  const source = join(directory, 'source'), workspace = join(directory, 'workspace 含空格'), cache = join(directory, '.dsh-git-bash-on-win');
  const { Context: InstalledContext } = await runtime.load(runtime.baseRequire, '@deepseek-ai/cordis') as typeof import('@deepseek-ai/cordis');
  const { LocalSubprocessRuntime } = await runtime.load(runtime.baseRequire, '@deepseek-ai/dsh-subprocess-local') as { LocalSubprocessRuntime: new (ctx: Context) => Subprocess };
  const { LocalSandboxProvider } = await runtime.load(runtime.baseRequire, '@deepseek-ai/dsh-sandbox-local') as { LocalSandboxProvider: new (ctx: Context, config: object) => SandboxProvider };
  const ctx = new InstalledContext();
  const pins = new Set<GenerationPin>();
  let verifySource = async () => {};
  t.after(async () => {
    await ctx.fiber.dispose();
    for (const pin of pins) await pin.release();
    await purgeRuntimeCache(cache);
    try { await verifySource(); }
    finally { removeTree(admitDirectory(dirname(directory)), basename(directory)); }
  });
  await mkdir(source); await mkdir(workspace);
  const files = await inventoryGitFiles(installed.root, () => {});
  const parents = [...new Set(files.map(file => dirname(join(source, file))))].sort((a, b) => a.length - b.length);
  for (const parent of parents) await mkdir(parent, { recursive: true });
  for (let offset = 0; offset < files.length; offset += 32) {
    const batch = await Promise.allSettled(files.slice(offset, offset + 32).map(file => copyFile(join(installed.root, file), join(source, file))));
    for (const result of batch) if (result.status === 'rejected') throw result.reason;
  }
  const snapshot = async () => {
    const contents: Array<{ hash: string; links: number }> = [];
    for (let offset = 0; offset < files.length; offset += 16) {
      contents.push(...await Promise.all(files.slice(offset, offset + 16).map(async file => ({
        hash: createHash('sha256').update(await readFile(join(source, file))).digest('hex'),
        links: (await stat(join(source, file))).nlink,
      }))));
    }
    return { contents, acl: readAclRecords(source, true) };
  };
  const before = await snapshot();
  verifySource = async () => {
    assert.deepEqual(await snapshot(), before, 'strict purge must restore every copied source link count and preserve contents/ACLs');
  };
  await ctx.plugin(LocalSubprocessRuntime);
  await ctx.plugin(LocalSandboxProvider, {});
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess);
  ctx.subprocess.spawn = spec => {
    if (spec.argv.some(arg => basename(arg) === 'elevation-broker.js')) throw new Error('Automated execution fixtures must never request UAC.');
    return spawn(spec);
  };
  ctx.provide('profileContext', { dir: directory, home: directory });
  ctx.provide('sandboxPolicy', { defaultMode: 'read-only', resolve: () => ({ mode: 'read-only', workspaceRoot: workspace }) });
  const request: RuntimePreparation = { cacheDirectory: cache, gitBashPath: join(source, 'usr/bin/bash.exe'), elevation: 'manual', spawn: ctx.subprocess.spawn.bind(ctx.subprocess) };
  return { ctx, directory, source, workspace, cache, installed, request,
    async prepare() { const pin = await prepareRuntime(request, new AbortController().signal); pins.add(pin); return pin; },
  };
}
