import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import koffi from 'koffi';
import { patchMsysDll, readPe } from '../src/runtime/pe.ts';
import { discoverGitInstallation } from '../src/runtime/git-installation.ts';
import { readBuildManifest, verifyCompatDll } from '../scripts/build-compat-dll.ts';
import { msysPeFixture, nativeOnly } from './fixtures.ts';

await test('fixed patch preserves sections and accounting and appends one read-only import', () => {
  const source = msysPeFixture(), before = readPe(source);
  source.writeUInt32LE(0x2900, before.directories + 11 * 8);
  source.writeUInt32LE(8, before.directories + 11 * 8 + 4);
  const original = Buffer.from(source);
  const output = patchMsysDll(source), after = readPe(output);
  assert.deepEqual(source, original);
  assert.deepEqual(output, patchMsysDll(source));
  assert.equal(output.length, source.length + 512);
  assert.deepEqual(after.sections.slice(0, -1), before.sections);
  assert.deepEqual(output.subarray(0x400, source.length), source.subarray(0x400));
  assert.equal(after.sections.at(-1)!.characteristics, 0x40000040);
  assert.equal(output.readUInt32LE(after.optional + 8), source.readUInt32LE(before.optional + 8) + 512);
  assert.deepEqual(after.directory(11), { rva: 0, size: 0 });
  assert.deepEqual(after.imports.at(-1)!.symbols, ['dsh_msys_compat_anchor']);
  assert.equal(after.imports.at(-1)!.dll, 'dsh-msys-compat.dll');
  const iat = after.directory(12);
  for (const entry of after.imports) assert.ok(entry.iat >= iat.rva && entry.iat + (entry.symbols.length + 1) * 8 <= iat.rva + iat.size);
  assert.throws(() => patchMsysDll(output), /already patched/);
});

await test('named/ordinal imports and repeated descriptors remain distinct and complete', () => {
  const source = msysPeFixture([
    { dll: 'kernel32.dll', symbols: ['GetFinalPathNameByHandleW', 7] },
    { dll: 'kernel32.dll', symbols: ['CreateNamedPipeA', 'CreateProcessW'] },
    { dll: 'ntdll.dll', symbols: ['NtSetInformationToken', 'NtCreateSection', 12] },
    { dll: 'other.dll', symbols: [3, 4] },
  ]);
  const pe = readPe(source), patched = readPe(patchMsysDll(source));
  assert.deepEqual(pe.imports.map(i => i.symbols), [['GetFinalPathNameByHandleW', '#7'],
    ['CreateNamedPipeA', 'CreateProcessW'], ['NtSetInformationToken', 'NtCreateSection', '#12'], ['#3', '#4']]);
  assert.deepEqual(patched.imports.slice(0, -1).map(i => [i.dll, i.symbols, i.iat]), pe.imports.map(i => [i.dll, i.symbols, i.iat]));
});

await test('ordinal-only imports are readable; the MSYS patch still requires its five named hooks', () => {
  const source = msysPeFixture([{ dll: 'other.dll', symbols: [1, 2] }]);
  assert.deepEqual(readPe(source).imports[0]!.symbols, ['#1', '#2']);
  assert.throws(() => patchMsysDll(source), /expected one kernel32.dll!GetFinalPathNameByHandleW/);
});

await test('COFF symbols/string tail and GNU debug-link section naming survive insertion', () => {
  const source = msysPeFixture(), tail = Buffer.alloc(18 + 4 + 15);
  tail.write('symbol', 0, 'ascii'); tail.writeUInt32LE(19, 18); tail.write('.gnu_debuglink\0', 22, 'ascii');
  const b = Buffer.concat([source, tail]), p = readPe(b);
  b.writeUInt32LE(source.length, p.coff + 8); b.writeUInt32LE(1, p.coff + 12);
  b.fill(0, p.sections[0]!.header, p.sections[0]!.header + 8); b.write('/4', p.sections[0]!.header);
  const patched = patchMsysDll(b);
  assert.equal(patched.readUInt32LE(p.coff + 8), source.length + 512);
  assert.deepEqual(patched.subarray(source.length + 512), tail);
  assert.equal(readPe(patched).sections[0]!.name, '/4');
  assert.equal(patched.readUInt32LE(p.optional + 8), 0xa11 + 512);
});

await test('header room is bounded by SizeOfHeaders as well as first raw data', () => {
  const b = msysPeFixture(), p = readPe(b), end = p.sectionTable + 3 * 40;
  b.writeUInt32LE(end - 1, p.optional + 60);
  assert.throws(() => patchMsysDll(b), /header room/);
  b.writeUInt32LE(end, p.optional + 60);
  assert.doesNotThrow(() => patchMsysDll(b));
});

await test('malformed, signed and unsupported layouts reject before producing a patch', async t => {
  const cases: [string, RegExp, (b: Buffer) => void][] = [
    ['overlapping DOS header', /NT header offset/, b => b.writeUInt32LE(48, 0x3c)],
    ['misaligned NT header', /NT header offset/, b => { b.copy(b, 0x81, 0x80, 0x1d8); b.writeUInt32LE(0x81, 0x3c); }],
    ['empty section', /empty section/, b => {
      b.writeUInt16LE(3, 0x86); b.writeUInt32LE(0x3000, 0x1d8 + 12); b.writeUInt32LE(0x40000040, 0x1d8 + 36);
    }],
    ['empty DLL name', /empty or unterminated name/, b => { b[0x900] = 0; }],
    ['empty symbol name', /empty or unterminated name/, b => { b[readPe(b).offset(Number(b.readBigUInt64LE(0x700)) + 2)] = 0; }],
    ['bound timestamp', /bound import descriptor/, b => b.writeUInt32LE(0xffffffff, 0x604)],
    ['forwarder chain', /bound import descriptor/, b => b.writeUInt32LE(1, 0x608)],
    ['signed', /signed image/, b => b.writeUInt32LE(1, 0x98 + 112 + 4 * 8)],
    ['header padding', /nonzero section header padding/, b => { b[0x1d8] = 1; }],
    ['overlapping import tables', /overlapping import thunks/, b => b.writeUInt32LE(b.readUInt32LE(0x600), 0x610)],
    ['gap before appended IAT section', /SizeOfImage/, b => b.writeUInt32LE(0x4000, 0x98 + 56)],
    ['overlapping raw', /overlapping raw sections/, b => b.writeUInt32LE(0x400, 0x188 + 40 + 20)],
    ['overlapping virtual', /virtual sections must be adjacent/, b => b.writeUInt32LE(0x1000, 0x188 + 40 + 12)],
    ['unmapped import', /unmapped RVA/, b => b.writeUInt32LE(0xffff0000, 0x98 + 120)],
    ['directory bounds', /32-bit size overflow/, b => b.writeUInt32LE(0xffffffff, 0x98 + 124)],
    ['unterminated descriptors', /unterminated descriptors/, b => b.writeUInt32LE(40, 0x98 + 124)],
    ['bad thunk RVA', /import RVA overflow/, b => b.writeBigUInt64LE(0x100000000n, 0x700)],
    ['bad ordinal', /invalid ordinal thunk/, b => b.writeBigUInt64LE(0x8000000000010001n, 0x700)],
    ['missing symbol', /expected one kernel32\.dll!GetFinalPathNameByHandleW/, b => b.writeBigUInt64LE(0x8000000000000001n, 0x700)],
    ['missing lookup table', /missing import lookup table/, b => b.writeUInt32LE(0, 0x600)],
    ['early IAT terminator', /import tables terminate at different entries/, b => b.writeBigUInt64LE(0n, 0x720)],
    ['unterminated thunk', /unmapped RVA/, b => { b.writeUInt32LE(0x29f8, 0x600); b.writeBigUInt64LE(0x8000000000000001n, 0xff8); }],
    ['empty debug directory', /debug directory/, b => b.writeUInt32LE(0x2800, 0x98 + 112 + 6 * 8)],
    ['unterminated string', /empty or unterminated name/, b => { b.fill(65, 0xff0); b.writeUInt32LE(0x29f0, 0x60c); }],
    ['unsafe IAT write', /IAT span must be readable/, b => b.writeUInt32LE(0xc0000040, 0x188 + 40 + 36)],
    ['unsafe IAT execute', /IAT span must be readable/, b => b.writeUInt32LE(0x60000040, 0x188 + 40 + 36)],
    ['initialized data overflow', /32-bit size overflow/, b => b.writeUInt32LE(0xffffffff, 0x98 + 8)],
    ['unsupported debug tail', /unsupported debug relocation/, b => { b.writeUInt32LE(0x2800, 0x98 + 112 + 6 * 8); b.writeUInt32LE(28, 0x98 + 116 + 6 * 8);
      b.writeUInt32LE(4, 0xe10); b.writeUInt32LE(0x1000, 0xe18); }],
  ];
  for (const [name, diagnostic, corrupt] of cases) await t.test(name, () => {
    const b = msysPeFixture(); corrupt(b); assert.throws(() => patchMsysDll(b), diagnostic);
  });
  for (const length of [0, 63, 0x90, 0x180, 0x500, 0xfff]) assert.throws(() => patchMsysDll(msysPeFixture().subarray(0, length)), /truncated file/);
  assert.throws(() => patchMsysDll(Buffer.concat([msysPeFixture(), Buffer.from('overlay')])), /unsupported overlay/);
});

await test('installed real MSYS is structurally admitted without a version/hash whitelist', nativeOnly, () => {
  const git = discoverGitInstallation(process.env.DSH_TEST_GIT_BASH);
  const source = readFileSync(join(git.root, 'usr/bin/msys-2.0.dll')), before = readPe(source);
  const output = patchMsysDll(source), after = readPe(output);
  assert.deepEqual(after.sections.slice(0, -1), before.sections);
  assert.equal(output.readUInt32LE(after.optional + 8), source.readUInt32LE(before.optional + 8) + after.sections.at(-1)!.rawSize);
  const checksum = koffi.load('imagehlp.dll').func('void* CheckSumMappedFile(void*, uint32, void*, void*)');
  for (const image of [output, patchMsysDll(msysPeFixture())]) {
    const recorded = Buffer.alloc(4), computed = Buffer.alloc(4);
    assert.ok(checksum(image, image.length, recorded, computed));
    assert.equal(recorded.readUInt32LE(), computed.readUInt32LE(), 'Windows independently verifies the PE checksum');
  }
});

await test('build-only verification enforces mitigations, export and named-function membership', nativeOnly, () => {
  const bytes = readFileSync(new URL('../lib/dsh-msys-compat.dll', import.meta.url)), manifest = readBuildManifest();
  assert.match(verifyCompatDll(bytes), /^[0-9a-f]{64}$/);
  manifest.imports['kernel32.dll']!.push('UnusedReviewedSymbol');
  assert.doesNotThrow(() => verifyCompatDll(bytes, manifest));
  const pe = readPe(bytes);
  const inherited = Buffer.from(bytes);
  inherited.write('constructor\0', pe.offset(bytes.readUInt32LE(pe.imports[0]!.descriptor + 12)));
  assert.throws(() => verifyCompatDll(inherited, manifest), /Unreviewed native import DLL: constructor/);
  const first = pe.imports[0]!.symbols[0]!;
  const allowed = manifest.imports[pe.imports[0]!.dll]!;
  manifest.imports[pe.imports[0]!.dll] = allowed.filter(n => n !== first);
  assert.throws(() => verifyCompatDll(bytes, manifest), /Unreviewed/);
  manifest.imports[pe.imports[0]!.dll] = allowed;
  for (const mask of [0x20, 0x40, 0x100]) {
    const b = Buffer.from(bytes); b.writeUInt16LE(pe.dllCharacteristics & ~mask, pe.optional + 70);
    assert.throws(() => verifyCompatDll(b), /mitigations/);
  }
  const b = Buffer.from(bytes), ilt = b.readUInt32LE(pe.imports[0]!.descriptor);
  b.writeBigUInt64LE(0x8000000000000001n, pe.offset(ilt, 8));
  assert.throws(() => verifyCompatDll(b), /Unreviewed/);
  for (const name of ['LoadLibraryA', 'CreateThread', 'HeapCreate']) {
    const b = Buffer.from(bytes), hint = Number(b.readBigUInt64LE(pe.offset(ilt, 8)));
    const at = pe.offset(hint + 2, name.length + 1); b.write(name + '\0', at);
    assert.throws(() => verifyCompatDll(b), /Unreviewed/);
  }
  const e = pe.offset(pe.exports.rva), changed = Buffer.from(bytes);
  changed.writeUInt32LE(2, e + 20);
  assert.throws(() => verifyCompatDll(changed), /sole exported/);
});
