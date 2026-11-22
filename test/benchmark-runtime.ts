import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { buildCopyLayout, discoverGitInstallation } from '../src/runtime/git-installation.ts';
import { admitDirectory, createDirectory, removeTree } from '../src/runtime/ntfs-filesystem.ts';
import { bundledShimUrl, sharedCacheDirectory } from '../src/runtime/runtime-cache.ts';

function protection() {
  const status = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Get-MpComputerStatus -ErrorAction Stop | Select-Object AntivirusEnabled,RealTimeProtectionEnabled | ConvertTo-Json -Compress'], { encoding: 'utf8' });
  return JSON.parse(status) as { AntivirusEnabled: boolean; RealTimeProtectionEnabled: boolean };
}

await test('cold copy provisioning on fresh NTFS generations', async t => {
  assert.ok(process.platform === 'win32' && process.arch === 'x64' && process.env.DSH_BENCH_COLD_ONLY === '1',
    'Run with Windows x64 Node and DSH_BENCH_COLD_ONLY=1.');
  const setting = process.env.DSH_TEST_GIT_BASH;
  const sourceBin = join(discoverGitInstallation(setting).root, 'usr/bin');
  const home = admitDirectory(mkdtempSync(join(tmpdir(), 'dsh-copy-bench-')));
  t.after(() => removeTree(admitDirectory(dirname(home.path)), basename(home.path)));
  const parent = createDirectory(createDirectory(home, basename(sharedCacheDirectory(home.path))), 'g');
  const names = readdirSync(sourceBin, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name);
  const sourceBytes = names.reduce((sum, name) => sum + statSync(join(sourceBin, name)).size, 0);
  const before = protection();
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const source = discoverGitInstallation(setting);
    const generation = createDirectory(parent, i.toString(16).padStart(16, '0'));
    const { runtime } = await buildCopyLayout(generation, source, readFileSync(bundledShimUrl), t.signal);
    const ms = performance.now() - start;
    const bin = join(runtime.path, 'usr/bin');
    const files = readdirSync(bin, { withFileTypes: true }).filter(e => e.isFile());
    assert.deepEqual(files.map(e => e.name).sort(), [...names, 'dsh-msys-compat.dll'].sort());
    const bytes = files.reduce((sum, entry) => sum + statSync(join(bin, entry.name)).size, 0);
    t.diagnostic(JSON.stringify({ sample: i + 1, layout: source.layout, sourceFiles: names.length, sourceBytes, files: files.length, bytes, ms }));
    removeTree(parent, basename(generation.path));
  }
  const after = protection();
  const active = [before, after].every(s => s.AntivirusEnabled && s.RealTimeProtectionEnabled);
  t.diagnostic(JSON.stringify({ before, after, activeDefender: active ? 'measured' : 'UNVERIFIED' }));
});
