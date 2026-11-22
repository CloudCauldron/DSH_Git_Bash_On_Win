import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPe } from '../src/runtime/pe.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
export interface BuildManifest {
  toolset: string; compiler: string; linker: string; sdk: string; sha256: string | null;
  imports: Record<string, string[]>;
}
export const compilerFlags = ['/nologo', '/c', '/utf-8', '/O2', '/Oi-', '/W4', '/WX', '/Zl', '/GS-',
  '/EHs-c-', '/GR-', '/DWIN32_LEAN_AND_MEAN', '/DUNICODE', '/D_UNICODE', '/Brepro'];
export const linkerFlags = ['/nologo', '/DLL', '/NODEFAULTLIB', '/ENTRY:DllMain', '/INCREMENTAL:NO',
  '/OPT:REF', '/OPT:ICF', '/DYNAMICBASE', '/NXCOMPAT', '/HIGHENTROPYVA', '/SUBSYSTEM:WINDOWS', '/MACHINE:X64', '/Brepro'];

export function readBuildManifest(): BuildManifest {
  return JSON.parse(readFileSync(join(root, 'native/build.json'), 'utf8')) as BuildManifest;
}

/** One discovery route, with explicit overrides for development installations. */
export function nativeToolchain(scratch: string, pins = readBuildManifest()) {
  assert.equal(process.platform, 'win32', 'Native Windows x64 build tools are required');
  assert.equal(process.arch, 'x64');
  const system = process.env.SystemRoot!;
  const programFiles = process.env['ProgramFiles(x86)']!;
  let tools = process.env.DSH_MSVC_TOOLS_DIR;
  if (!tools) {
    const vswhere = join(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe');
    const vs = execFileSync(vswhere, ['-utf8', '-latest', '-products', '*', '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
    { encoding: 'utf8', windowsHide: true }).trim();
    assert.ok(vs && !vs.includes('\n'), 'Select one MSVC installation with DSH_MSVC_TOOLS_DIR');
    const pinned = join(vs, 'VC/Tools/MSVC', pins.toolset);
    tools = existsSync(pinned) ? pinned : join(vs, 'VC/Tools/MSVC',
      readFileSync(join(vs, 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'), 'utf8').trim());
  }
  tools = resolve(tools);
  const sdkRoot = resolve(process.env.DSH_WINSDK_DIR ?? join(programFiles, 'Windows Kits/10'));
  const sdk = process.env.DSH_WINSDK_VERSION ?? pins.sdk;
  const bin = join(tools, 'bin/Hostx64/x64'), cl = join(bin, 'cl.exe'), link = join(bin, 'link.exe');
  const include = [join(tools, 'include'), ...['ucrt', 'shared', 'um'].map(n => join(sdkRoot, 'Include', sdk, n))];
  const libs = [join(tools, 'lib/x64'), ...['ucrt', 'um'].map(n => join(sdkRoot, 'Lib', sdk, n, 'x64'))];
  for (const path of [cl, link, ...include, ...libs, join(sdkRoot, 'Lib', sdk, 'um/x64/ntdll.lib'),
    join(sdkRoot, 'Lib', sdk, 'um/x64/kernel32.lib')]) assert.ok(existsSync(path), `Missing native prerequisite: ${path}`);
  // In particular CL/_CL_/LINK/_LINK_ and ambient INCLUDE/LIB never enter this map.
  const env = { SystemRoot: system, WINDIR: system, PATH: [bin, join(system, 'System32'), system].join(';'),
    INCLUDE: include.join(';'), LIB: libs.join(';'), TMP: scratch, TEMP: scratch, VSLANG: '1033' };
  const banner = (path: string, args: string[]) => {
    const result = spawnSync(path, args, { env, encoding: 'utf8', windowsHide: true });
    if (result.error) throw result.error;
    const value = /\b\d+\.\d+\.\d+(?:\.\d+)?\b/.exec((result.stdout ?? '') + (result.stderr ?? ''))?.[0];
    assert.ok(value, `Cannot read tool version: ${path}`);
    return value;
  };
  return { cl, link, bin, env, versions: { toolset: basename(tools), sdk,
    compiler: banner(cl, []), linker: banner(link, ['/help']) } };
}

/** Build-only policy: the runtime reader deliberately preserves ordinal and repeated imports. */
export function verifyCompatDll(bytes: Buffer, manifest = readBuildManifest()) {
  const pe = readPe(bytes);
  assert.equal(pe.dllCharacteristics & 0x160, 0x160, 'Missing ASLR/DEP/high-entropy mitigations');
  assert.deepEqual(pe.directory(4), { rva: 0, size: 0 }, 'Unexpected certificate directory');
  assert.ok(pe.imports.length > 0, 'Missing native imports');
  for (const entry of pe.imports) {
    const allowed = Object.hasOwn(manifest.imports, entry.dll) && manifest.imports[entry.dll];
    assert.ok(allowed && entry.symbols.length, `Unreviewed native import DLL: ${entry.dll}`);
    for (const symbol of entry.symbols) assert.ok(!symbol.startsWith('#') && allowed.includes(symbol),
      `Unreviewed native import: ${entry.dll}!${symbol}`);
  }
  // Delayed imports are outside the reviewed loader-lock contract.
  assert.deepEqual(pe.directory(13), { rva: 0, size: 0 }, 'Unexpected delay imports');
  assert.ok(pe.exports.rva && pe.exports.size >= 40, 'Missing anchor export');
  const e = pe.offset(pe.exports.rva, pe.exports.size);
  assert.equal(bytes.readUInt32LE(e + 20), 1, 'Expected sole exported function');
  assert.equal(bytes.readUInt32LE(e + 24), 1, 'Expected sole export name');
  const functions = pe.offset(bytes.readUInt32LE(e + 28), 4);
  const names = pe.offset(bytes.readUInt32LE(e + 32), 4);
  const ordinals = pe.offset(bytes.readUInt32LE(e + 36), 2);
  assert.equal(bytes.readUInt16LE(ordinals), 0);
  assert.equal(pe.string(bytes.readUInt32LE(names)), 'dsh_msys_compat_anchor');
  const target = bytes.readUInt32LE(functions);
  assert.ok(target && (target < pe.exports.rva || target >= pe.exports.rva + pe.exports.size), 'Forwarded export');
  pe.offset(target);
  assert.ok(pe.sections.some(s => target >= s.va && target < s.va + s.virtualSize && (s.characteristics & 0x20000000)), 'Anchor must be executable');
  return createHash('sha256').update(bytes).digest('hex');
}

export function buildCompatDll(release = false) {
  const output = join(root, 'lib/dsh-msys-compat.dll');
  rmSync(output, { force: true });
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-compat-build-'));
  let bytes: Buffer, hash: string, versions: ReturnType<typeof nativeToolchain>['versions'];
  let failure: unknown;
  try {
    const manifest = readBuildManifest(), tools = nativeToolchain(scratch, manifest);
    versions = tools.versions;
    if (release) for (const key of ['toolset', 'compiler', 'linker', 'sdk'] as const) {
      assert.equal(versions[key], manifest[key], `Release ${key} mismatch`);
    }
    // Fixed basenames and isolated cwd keep absolute build paths out of deterministic output.
    writeFileSync(join(scratch, 'dsh-msys-compat.c'), readFileSync(join(root, 'native/dsh-msys-compat.c')));
    const options = { cwd: scratch, env: tools.env, encoding: 'utf8' as const, windowsHide: true };
    execFileSync(tools.cl, [...compilerFlags, '/Focompat.obj', 'dsh-msys-compat.c'], options);
    execFileSync(tools.link, [...linkerFlags, '/OUT:dsh-msys-compat.dll', 'compat.obj', 'kernel32.lib', 'ntdll.lib'], options);
    bytes = readFileSync(join(scratch, 'dsh-msys-compat.dll'));
    hash = verifyCompatDll(bytes, manifest);
    if (release) assert.equal(hash, manifest.sha256, 'Unapproved release DLL hash');
  } catch (error) { failure = error; }
  finally {
    try { rmSync(scratch, { recursive: true, force: true }); }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'Native build and cleanup failed') : error; }
  }
  if (failure) throw failure;
  mkdirSync(join(root, 'lib'), { recursive: true });
  try { writeFileSync(output, bytes!, { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error;
    try { rmSync(output, { force: true }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Native output cleanup failed', { cause: cleanup }); }
    throw error;
  }
  console.log(JSON.stringify({ release, ...versions!, sha256: hash! }));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  assert.ok(!args.length || args.length === 1 && args[0] === '--release', 'Usage: node scripts/build-compat-dll.ts [--release]');
  buildCompatDll(args.length === 1);
}
