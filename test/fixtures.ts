import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type GitBashExecutor from '../src/index.ts';
import { cp, readdir, mkdtemp, rm, mkdir, writeFile, link, readFile, stat, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import { closeHandleChecked, extendWin32ProcessBindings, type NativePtr } from '@deepseek-ai/dsh-win32-process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import type { TestContext } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { SandboxProvider, SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type Subprocess from '@deepseek-ai/dsh-subprocess';
import { installedDsh } from '../scripts/installed-dsh.ts';
import { admitDirectory, createDirectory, openOrdinaryFile, removeTree } from '../src/runtime/ntfs-filesystem.ts';
import { bundledShimUrl, prepareRuntime, purgeRuntimeCache, type GenerationPin, type RuntimePreparation } from '../src/runtime/runtime-cache.ts';
import { buildCopyLayout, buildRuntimeEnvironment, discoverGitInstallation, type SourceFreshness, type GitLayout } from '../src/runtime/git-installation.ts';

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

export function pnpmExecutable(): string {
  return process.env.npm_execpath?.endsWith('.exe') ? process.env.npm_execpath
    : execFileSync('where.exe', ['pnpm.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]!;
}

export function packRelease(directory: string, destination: string): string {
  mkdirSync(destination, { recursive: true });
  execFileSync(pnpmExecutable(), ['pack', '--pack-destination', destination], { cwd: directory, stdio: 'inherit' });
  const files = readdirSync(destination).filter(name => name.endsWith('.tgz'));
  assert.equal(files.length, 1);
  return join(destination, files[0]!);
}

/** Use rc.5's profile template, package operation and host peer resolver for the packed plugin. */
export async function installPackedProfile(home: string, name: 'web' | 'desktop', archive: string) {
  const dsh = installedDsh(), dir = join(home, 'profiles', name);
  // Desktop initializes its profile with the official Web template before managing packages.
  const boot = await dsh.load(dsh.cliRequire, '@deepseek-ai/dsh-app-boot') as { initProfile(dir: string, bundles: string[]): void };
  const { PROFILE_TEMPLATES } = await dsh.load(dsh.cliRequire, '@deepseek-ai/dsh-official-bundles') as { PROFILE_TEMPLATES: { web: { bundles: string[] } } };
  boot.initProfile(dir, PROFILE_TEMPLATES.web.bundles);
  const env = profileEnvironment(home, home);
  const manager = await dsh.load(dsh.cliRequire, '@deepseek-ai/dsh-plugin-manager/operations') as {
    runPluginCommand(context: object, args: string[], options: object): Promise<{ exitCode: number | null }>;
  };
  const operation = async (verb: string, spec: string) => {
    let output = '';
    const result = await manager.runPluginCommand({ profile: name, dir, installAnchor: dsh.manifest, cwd: home },
      [verb, spec, '--config.ignore-scripts=true'], { command: pnpmExecutable(), execution: 'cli', env,
        onOutput: (chunk: string) => { output += chunk; } });
    assert.equal(result.exitCode, 0, output);
  };
  await operation('add', 'file:' + archive.replaceAll('\\', '/'));
  assert.match(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8'), /autoInstallPeers: false/);
  const require = createRequire(join(dir, 'package.json'));
  const root = dirname(realpathSync.native(require.resolve('dsh-git-bash-on-win/package.json')));
  assert.ok(root.startsWith(realpathSync.native(dir) + sep));
  return { dir, root, remove: () => operation('remove', 'dsh-git-bash-on-win') };
}

export async function loadPackedExecutor(ctx: Context, dir: string) {
  const home = dirname(dirname(dir)), dsh = installedDsh(), require = createRequire(join(dir, 'package.json'));
  const boot = await dsh.load(dsh.cliRequire, '@deepseek-ai/dsh-app-boot') as {
    loadProfileDirectory(app: string, dir: string, anchor: string, options: { userLayer: boolean }): object;
    createRuntimeResolution(options: object): Promise<object>;
    PluginPackages: new (ctx: Context, config: { resolution: object }) => object;
  };
  const profile = boot.loadProfileDirectory('dsh', dir, dsh.manifest, { userLayer: false });
  const resolution = await boot.createRuntimeResolution({ home, profile, installAnchor: dsh.manifest });
  const peers = ctx.plugin(boot.PluginPackages, { resolution });
  await peers;
  const { default: Executor } = await import(pathToFileURL(require.resolve('dsh-git-bash-on-win/executor')).href) as { default: typeof GitBashExecutor };
  return { Executor, require, root: dirname(require.resolve('dsh-git-bash-on-win/package.json')) };
}

/** End the native module's process lifetime before removing its installed profile. */
export function runProfileHost(entry: string, ...args: string[]) {
  execFileSync(process.execPath, [fileURLToPath(entry), ...args], { stdio: 'inherit', env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
}

export async function qualifyPackedProfile(t: TestContext, entry: string, run: (dir: string) => Promise<void>) {
  const profile = process.argv[2];
  if (profile) return run(profile);
  const home = await temporaryDirectory(t);
  const archive = process.env.DSH_TEST_TARBALL ?? packRelease(join(import.meta.dirname, '..'), join(home, 'pack'));
  const installed = await installPackedProfile(home, 'web', archive);
  try { runProfileHost(entry, installed.dir, archive); }
  finally { await installed.remove(); }
}

export function chromeExecutable(): string {
  const path = process.env.CHROME_PATH ?? join(process.env.ProgramFiles!, 'Google/Chrome/Application/chrome.exe');
  assert.ok(statSync(path, { throwIfNoEntry: false })?.isFile(), 'Chrome executable missing. Set CHROME_PATH: ' + path);
  return path;
}

export const nativeWindows = process.platform === 'win32' && process.arch === 'x64';
export const nativeOnly = { skip: !nativeWindows && 'Requires native Windows x64 and NTFS.' };

/** Independently encoded PE32+ fixture: no production parser/patcher builds these bytes. */
export function msysPeFixture(imports = [
  { dll: 'KERNEL32.dll', symbols: ['GetFinalPathNameByHandleW', 'CreateNamedPipeA', 'CreateProcessW'] as (string | number)[] },
  { dll: 'ntdll.dll', symbols: ['NtSetInformationToken', 'NtCreateSection'] as (string | number)[] },
]) {
  const b = Buffer.alloc(0x1000), nt = 0x80, opt = 0x98, sections = 0x188;
  b.writeUInt16LE(0x5a4d); b.writeUInt32LE(nt, 0x3c); b.writeUInt32LE(0x4550, nt);
  b.writeUInt16LE(0x8664, nt + 4); b.writeUInt16LE(2, nt + 6);
  b.writeUInt16LE(240, nt + 20); b.writeUInt16LE(0x2022, nt + 22);
  b.writeUInt16LE(0x20b, opt); b.writeUInt32LE(0x200, opt + 4); b.writeUInt32LE(0xa11, opt + 8);
  b.writeUInt32LE(0x1000, opt + 16); b.writeBigUInt64LE(0x180000000n, opt + 24);
  b.writeUInt32LE(0x1000, opt + 32); b.writeUInt32LE(0x200, opt + 36);
  b.writeUInt32LE(0x3000, opt + 56); b.writeUInt32LE(0x400, opt + 60);
  b.writeUInt16LE(3, opt + 68); b.writeUInt16LE(0x160, opt + 70); b.writeUInt32LE(16, opt + 108);
  for (const [i, s] of [
    { name: '.text', va: 0x1000, raw: 0x400, size: 0x200, flags: 0x60000020 },
    { name: '.idata', va: 0x2000, raw: 0x600, size: 0xa00, flags: 0x40000040 },
  ].entries()) {
    const at = sections + i * 40;
    b.write(s.name, at, 'ascii'); b.writeUInt32LE(s.size, at + 8); b.writeUInt32LE(s.va, at + 12);
    b.writeUInt32LE(s.size, at + 16); b.writeUInt32LE(s.raw, at + 20); b.writeUInt32LE(s.flags, at + 36);
  }
  b[0x400] = 0xc3;
  const rva = (raw: number) => 0x2000 + raw - 0x600;
  let table = 0x700, names = 0x900;
  const string = (text: string) => { const at = names; names += b.write(text, at, 'ascii') + 1; return rva(at); };
  for (const [i, entry] of imports.entries()) {
    const desc = 0x600 + i * 20, ilt = table, iat = ilt + (entry.symbols.length + 1) * 8;
    table = iat + (entry.symbols.length + 1) * 8;
    b.writeUInt32LE(rva(ilt), desc); b.writeUInt32LE(string(entry.dll), desc + 12); b.writeUInt32LE(rva(iat), desc + 16);
    for (const [j, symbol] of entry.symbols.entries()) {
      let value: bigint;
      if (typeof symbol === 'number') value = 0x8000000000000000n | BigInt(symbol);
      else { names += names % 2; const hint = names; names += 2; string(symbol); value = BigInt(rva(hint)); }
      b.writeBigUInt64LE(value, ilt + j * 8); b.writeBigUInt64LE(value, iat + j * 8);
    }
  }
  assert.ok(table < 0x900 && names < b.length && (imports.length + 1) * 20 <= 0x100);
  b.writeUInt32LE(0x2000, opt + 120); b.writeUInt32LE((imports.length + 1) * 20, opt + 124);
  return b;
}

/** Independent token-query oracle, run in children confined by the real DSH runner. */
export function probeTokenLogonSid() {
  const nt = koffi.load('ntdll.dll');
  const open = nt.func('int32 NtOpenProcessToken(void*, uint32, void*)');
  const query = nt.func('int32 NtQueryInformationToken(void*, int, void*, uint32, void*)');
  const close = nt.func('int32 NtClose(void*)');
  const slot = Buffer.alloc(8);
  assert.equal(open(-1n, 8, slot), 0);
  const token = slot.readBigUInt64LE();
  try {
    const groups = (kind: number, capacity: number) => {
      const buffer = Buffer.alloc(capacity), returned = Buffer.alloc(4);
      assert.equal(query(token, kind, buffer, capacity, returned), 0);
      const size = returned.readUInt32LE(), count = buffer.readUInt32LE();
      assert.ok(size >= 8 && size <= capacity && count <= (size - 8) / 16);
      const entries = Array.from({ length: count }, (_, i) => {
        const offset = Number(buffer.readBigUInt64LE(8 + i * 16) - koffi.address(buffer));
        assert.ok(offset >= 8 + count * 16 && offset + 8 <= size);
        const length = 8 + buffer[offset + 1]! * 4;
        assert.equal(buffer[offset], 1);
        assert.ok(length <= 68 && offset + length <= size);
        return { attributes: buffer.readUInt32LE(16 + i * 16), offset, length,
          sid: buffer.subarray(offset, offset + length).toString('hex') };
      });
      return { count, size, entries };
    };
    const logon = groups(28, 96), oracle = groups(2, 16384), restricted = groups(11, 2048);
    const expected = oracle.entries.filter(x => (x.attributes & 0xc0000000) >>> 0 === 0xc0000000);
    assert.equal(expected.length, 1);
    assert.equal(logon.count, 1);
    assert.equal(logon.entries[0]!.sid, expected[0]!.sid);
    assert.equal((logon.entries[0]!.attributes & 0xc0000000) >>> 0, 0xc0000000);
    const integrity = Buffer.alloc(256), returned = Buffer.alloc(4);
    assert.equal(query(token, 25, integrity, integrity.length, returned), 0);
    const offset = Number(integrity.readBigUInt64LE() - koffi.address(integrity));
    assert.ok(offset >= 16 && offset + 12 <= returned.readUInt32LE());
    return { logon, oracle: expected[0], restrictedCount: restricted.count,
      logonRestricted: restricted.entries.some(x => x.sid === expected[0]!.sid),
      integrityRid: integrity.readUInt32LE(offset + 8) };
  } finally { assert.equal(close(token), 0); }
}

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

export const msysHolderCommand = [
  'IFS= read -r winpid < "/proc/$$/winpid"',
  'printf "HOLDER %s %s\\n" "$$" "$winpid"',
  'for d in /proc/sys/BaseNamedObjects/msys-*; do [[ -e "$d/cygpid.$$" ]] && printf "NAMESPACE %s\\n" "${d##*/}"; done',
  'printf "READY\\n"',
  'IFS= read -r release',
].join('\n');

/** Read a live MSYS process independently of the shim's own admission decisions. */
export function observeMsysImages(pid: number, iatRvas: number[]) {
  const k = koffi.load('kernel32.dll');
  const open = k.func('void* OpenProcess(uint32, int, uint32)');
  const close = k.func('int CloseHandle(void*)');
  const modules = k.func('int K32EnumProcessModulesEx(void*, void*, uint32, void*, uint32)');
  const filename = k.func('uint32 K32GetModuleFileNameExW(void*, void*, void*, uint32)');
  const mapped = k.func('uint32 K32GetMappedFileNameW(void*, void*, void*, uint32)');
  const query = k.func('size_t VirtualQueryEx(void*, void*, void*, size_t)');
  const processHandle = open(0x410, 0, pid);
  assert.ok(processHandle);
  try {
    const buffer = Buffer.alloc(8192), length = Buffer.alloc(4), text = Buffer.alloc(4096);
    assert.ok(modules(processHandle, buffer, buffer.length, length, 3));
    assert.ok(length.readUInt32LE() <= buffer.length);
    const images: { path: string; mapped: string; iatProtections?: number[] }[] = [];
    for (let i = 0; i < length.readUInt32LE(); i += 8) {
      const base = buffer.readBigUInt64LE(i), count = filename(processHandle, base, text, text.length / 2) as number;
      assert.ok(count && count < text.length / 2);
      const path = text.toString('utf16le', 0, count * 2);
      if (!/[/\\](msys-2\.0|dsh-msys-compat)\.dll$/i.test(path)) continue;
      const n = mapped(processHandle, base, text, text.length / 2) as number;
      assert.ok(n && n < text.length / 2);
      const image: typeof images[number] = { path, mapped: text.toString('utf16le', 0, n * 2) };
      if (/msys-2\.0\.dll$/i.test(path)) {
        image.iatProtections = iatRvas.map(rva => {
          const info = Buffer.alloc(48);
          assert.equal(query(processHandle, base + BigInt(rva), info, info.length), 48);
          return info.readUInt32LE(36);
        });
      }
      images.push(image);
    }
    return images;
  } finally { assert.ok(close(processHandle)); }
}

export function shortPath(path: string) {
  const get = koffi.load('kernel32.dll').func('uint32 GetShortPathNameW(str16,void*,uint32)');
  const buffer = Buffer.alloc(65536), length = get(path, buffer, buffer.length / 2) as number;
  assert.ok(length > 0 && length < buffer.length / 2, path);
  const short = buffer.toString('utf16le', 0, length * 2);
  assert.notEqual(basename(short).toLowerCase(), basename(path).toLowerCase(), 'UNVERIFIED: Windows did not supply an 8.3 alias for ' + path);
  return short;
}

export function expectedMsysKey(view: string) {
  const path = `\\??\\${view}\\usr\\bin\\msys-2.0.dll`.toUpperCase();
  let key = 0n;
  for (let i = 0; i < path.length; i++) key = BigInt.asUintN(64, BigInt(path.charCodeAt(i)) + (key << 6n) + (key << 16n) - key);
  return key.toString(16).padStart(16, '0');
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
  for (const file of ['bin/bash.exe', 'usr/bin/bash.exe', 'usr/bin/sh.exe', 'usr/bin/msys-2.0.dll', `${layout}/bin/git.exe`, 'etc/profile', 'etc/install-options.txt', 'usr/lib/perl/module.pm', 'usr/share/doc/ignored.txt', 'usr/lib/winpty.lib', `${layout}/libexec/git-core/git-helper.exe`]) {
    await mkdir(dirname(join(source, file)), { recursive: true });
    if (file === 'usr/bin/sh.exe') await link(join(source, 'usr/bin/bash.exe'), join(source, file));
    else if (file === 'usr/bin/msys-2.0.dll') await writeFile(join(source, file), msysPeFixture());
    else await writeFile(join(source, file), `fixture ${file}\n`);
  }
  const request: RuntimePreparation = {
    cacheDirectory: cache, gitBashPath: join(source, 'usr/bin/bash.exe'),
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
        schemaVersion: 1; patchAbi: 1; generationId: string; sourceRoot: string; layout: GitLayout; sourceFreshness: SourceFreshness; patchedMsysSha256: string;
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

/** Deny sharing on a fixture file until its caller closes the handle. */
export function blockFile(path: string) {
  const k = koffi.load('kernel32.dll'), open = k.func('void * CreateFileW(str16, uint32, uint32, void *, uint32, uint32, void *)');
  const handle = open(path, 0x80000000, 0, null, 3, 0x00200000, null);
  assert.ok(handle && BigInt.asIntN(64, handle) !== -1n, path);
  return { close() { assert.ok(k.func('int CloseHandle(void *)')(handle)); } };
}

/** An isolated installed provider, with no Loader, settings or personal profile. */
export async function localSpawn(t: TestContext): Promise<Subprocess['spawn']> {
  const runtime = installedDsh();
  const { Context } = await runtime.load(runtime.baseRequire, '@deepseek-ai/cordis') as typeof import('@deepseek-ai/cordis');
  const { LocalSubprocessRuntime } = await runtime.load(runtime.baseRequire, '@deepseek-ai/dsh-subprocess-local') as {
    LocalSubprocessRuntime: new (ctx: Context) => Subprocess;
  };
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LocalSubprocessRuntime);
  return ctx.subprocess.spawn.bind(ctx.subprocess);
}

export async function executionContext(home: string, workspace: string, profile: string) {
  const runtime = installedDsh();
  const { Context: InstalledContext } = await runtime.load(runtime.baseRequire, '@deepseek-ai/cordis') as typeof import('@deepseek-ai/cordis');
  const { LocalSubprocessRuntime } = await runtime.load(runtime.baseRequire, '@deepseek-ai/dsh-subprocess-local') as { LocalSubprocessRuntime: new (ctx: Context) => Subprocess };
  const { LocalSandboxProvider } = await runtime.load(runtime.baseRequire, '@deepseek-ai/dsh-sandbox-local') as { LocalSandboxProvider: new (ctx: Context, config: object) => SandboxProvider };
  const ctx = new InstalledContext();
  await ctx.plugin(LocalSubprocessRuntime);
  await ctx.plugin(LocalSandboxProvider, {});
  ctx.provide('profileContext', { dir: profile, home });
  ctx.provide('sandboxPolicy', { defaultMode: 'read-only', resolve: () => ({ mode: 'read-only', workspaceRoot: workspace }) });
  return ctx;
}

/** Real providers, owned Git bytes, and no personal Loader/profile state. */
export async function executionFixture(t: TestContext) {
  const installed = discoverGitInstallation(process.env.DSH_TEST_GIT_BASH);
  const directory = await mkdtemp(join(tmpdir(), 'dsh-git-bash-execution-'));
  const source = join(directory, 'source'), workspace = join(directory, 'workspace 含空格'), cache = join(directory, '.dsh-git-bash-on-win');
  const ctx = await executionContext(directory, workspace, directory);
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
  for (const name of ['bin', 'etc', 'usr', installed.layout]) {
    await cp(join(installed.root, name), join(source, name), { recursive: true });
  }
  const files = (await readdir(join(source, 'usr/bin'), { withFileTypes: true })).filter(file => file.isFile()).map(file => 'usr/bin/' + file.name);
  const snapshot = async () => {
    const contents: Array<{ hash: string; links: number; attributes: number }> = [];
    const bin = admitDirectory(join(source, 'usr/bin'));
    for (let offset = 0; offset < files.length; offset += 16) {
      contents.push(...await Promise.all(files.slice(offset, offset + 16).map(async file => {
        using handle = openOrdinaryFile(bin, basename(file));
        return { attributes: handle.information().attributes, hash: createHash('sha256').update(await readFile(join(source, file))).digest('hex'),
          links: (await stat(join(source, file))).nlink };
      })));
    }
    return { contents, acl: readAclRecords(source, true) };
  };
  const before = await snapshot();
  verifySource = async () => {
    assert.deepEqual(await snapshot(), before, 'preparation and purge must preserve source link counts, contents, attributes and ACLs');
  };
  const request: RuntimePreparation = { cacheDirectory: cache, gitBashPath: join(source, 'usr/bin/bash.exe') };
  return { ctx, directory, source, workspace, cache, installed, request,
    async prepare() { const pin = await prepareRuntime(request, new AbortController().signal); pins.add(pin); return pin; },
  };
}

/** Exercise the shallow copy layout through the installed DSH providers. */
export async function compatFixture(t: TestContext) {
  const f = await executionFixture(t);
  const generation = createDirectory(admitDirectory(f.directory), 'generation');
  const installation = discoverGitInstallation(f.request.gitBashPath);
  const built = await buildCopyLayout(generation, installation, await readFile(bundledShimUrl), t.signal);
  const runtime = built.runtime.path, views = join(generation.path, 'v');
  return { ...f, runtime,
    async command(mode: SandboxExecutionPolicy['mode'], command: string, session?: string, leafOverride?: string) {
      const confined = mode === 'danger-full-access' ? ['bash', '-c', command] : [...(await f.ctx.sandbox.confine(['bash', '-c', command],
        { mode, workspaceRoot: f.workspace, sessionId: session as SandboxExecutionPolicy['sessionId'] }, t.signal)).argv];
      assert.deepEqual(confined.slice(-3), ['bash', '-c', command]);
      const sidIndex = confined.indexOf('--temp-write-sid'), sid = sidIndex < 0 ? undefined : confined[sidIndex + 1];
      const parts = sid && /^S-1-4-(\d+)-(\d+)-1$/.exec(sid);
      if (mode === 'workspace-write') {
        if (session) assert.ok(parts, 'DSH must supply a valid session temp SID');
        else assert.equal(sidIndex, -1, 'agentless DSH confinement supplies no temp SID');
      }
      const prefix = mode === 'danger-full-access' ? 'fa' : mode === 'read-only' ? 'ro' : parts ? `ww-${parts[1]}-${parts[2]}` : 'ww-u';
      const view = join(views, leafOverride ?? `${prefix}-${randomBytes(8).toString('hex')}`);
      await symlink(runtime, view, 'junction');
      const argv = [...confined.slice(0, -3), join(view, 'usr/bin/bash.exe'), '--noprofile', '--norc', '-c', command];
      const env = { ...buildRuntimeEnvironment(view, f.source, f.installed.layout, process.env), BASH_ENV: '', ENV: '', HISTFILE: '' };
      return { argv, view, env, prefix: confined.slice(0, -3) };
    },
  };
}
