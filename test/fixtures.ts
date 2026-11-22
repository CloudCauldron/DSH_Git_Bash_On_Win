import { copyFile, mkdtemp, rm, mkdir, writeFile, link, readFile, stat, readdir, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import { closeHandleChecked, extendWin32ProcessBindings, Win32Error, type NativePtr } from '@deepseek-ai/dsh-win32-process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { SandboxProvider, SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type Subprocess from '@deepseek-ai/dsh-subprocess';
import { findInstalledDshManifest, installedDsh } from '../scripts/installed-dsh.ts';
import { admitDirectory, NativeHold, removeTree } from '../src/runtime/ntfs-filesystem.ts';
import { prepareRuntime, purgeRuntimeCache, type GenerationPin, type RuntimePreparation } from '../src/runtime/runtime-cache.ts';
import { anchorPaths, buildRuntimeEnvironment, discoverGitInstallation, inventoryGitFiles, type AnchorStamps, type GitLayout } from '../src/runtime/git-installation.ts';
import { patchMsysDll } from '../src/runtime/pe.ts';

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

/** Native tests share stock providers and own every workspace/temp artifact. */
export async function sandboxFixture(t: TestContext) {
  const runtime = installedDsh();
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-'));
  const workspace = join(directory, 'w');
  await mkdir(workspace);
  const { Context } = await runtime.load(runtime.baseRequire, '@deepseek-ai/cordis') as typeof import('@deepseek-ai/cordis');
  const { LocalSubprocessRuntime } = await runtime.load(runtime.baseRequire, '@deepseek-ai/dsh-subprocess-local') as {
    LocalSubprocessRuntime: new (ctx: Context) => Subprocess;
  };
  const { LocalSandboxProvider } = await runtime.load(runtime.baseRequire, '@deepseek-ai/dsh-sandbox-local') as {
    LocalSandboxProvider: new (ctx: Context, config: object) => SandboxProvider;
  };
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    removeTree(admitDirectory(dirname(directory)), basename(directory));
  });
  await ctx.plugin(LocalSubprocessRuntime);
  await ctx.plugin(LocalSandboxProvider, {});
  return { ctx, directory, workspace };
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

/** Independently provisioned owned copies for native qualification; no production backend switch. */
export async function compatFixture(t: TestContext) {
  installedDsh(); discoverGitInstallation(process.env.DSH_TEST_GIT_BASH);
  const f = await executionFixture(t);
  assert.ok(f);
  const runtime = join(f.directory, 'r'), views = join(f.directory, 'v');
  await mkdir(join(runtime, 'usr/bin'), { recursive: true }); await mkdir(views);
  const junctions = async (source: string, destination: string) => {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (['usr', 'bin', 'tmp', 'dev'].includes(entry.name) && source === f.source) continue;
      if (['bin', 'tmp', 'dev'].includes(entry.name) && source !== f.source) continue;
      if (entry.isDirectory()) await symlink(join(source, entry.name), join(destination, entry.name), 'junction');
    }
  };
  await junctions(f.source, runtime);
  await symlink(join(f.source, 'bin'), join(runtime, 'bin'), 'junction');
  await junctions(join(f.source, 'usr'), join(runtime, 'usr'));
  for (const entry of await readdir(join(f.source, 'usr/bin'), { withFileTypes: true })) {
    const source = join(f.source, 'usr/bin', entry.name), destination = join(runtime, 'usr/bin', entry.name);
    if (entry.name === 'msys-2.0.dll') await writeFile(destination, patchMsysDll(await readFile(source)));
    else if (entry.isDirectory()) await symlink(source, destination, 'junction');
    else { assert.ok(entry.isFile()); await copyFile(source, destination); }
  }
  await copyFile(new URL('../lib/dsh-msys-compat.dll', import.meta.url), join(runtime, 'usr/bin/dsh-msys-compat.dll'));
  return { ...f, runtime,
    async command(mode: SandboxExecutionPolicy['mode'], command: string, session?: string, leafOverride?: string) {
      const confined = mode === 'danger-full-access' ? ['bash', '-c', command] : [...(await f.ctx.sandbox.confine(['bash', '-c', command],
        { mode, workspaceRoot: f.workspace, sessionId: session as SandboxExecutionPolicy['sessionId'] }, t.signal)).argv];
      assert.deepEqual(confined.slice(-3), ['bash', '-c', command]);
      const sidIndex = confined.indexOf('--temp-write-sid'), sid = sidIndex < 0 ? undefined : confined[sidIndex + 1];
      const parts = sid && /^S-1-4-(\d+)-(\d+)-1$/.exec(sid);
      const prefix = mode === 'danger-full-access' ? 'fa' : mode === 'read-only' ? 'ro' : parts ? `ww-${parts[1]}-${parts[2]}` : 'ww-u';
      const view = join(views, leafOverride ?? `${prefix}-${randomBytes(8).toString('hex')}`);
      await symlink(runtime, view, 'junction');
      const argv = [...confined.slice(0, -3), join(view, 'usr/bin/bash.exe'), '--noprofile', '--norc', '-c', command];
      const env = { ...buildRuntimeEnvironment(view, f.source, f.installed.layout, process.env), BASH_ENV: '', ENV: '', HISTFILE: '' };
      return { argv, view, env, prefix: confined.slice(0, -3) };
    },
  };
}
