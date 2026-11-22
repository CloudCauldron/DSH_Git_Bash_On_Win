import assert from 'node:assert/strict';
import { copyFile, lstat, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { release } from 'node:os';
import type { Context } from '@deepseek-ai/cordis';
import { join } from 'node:path';
import { test } from 'node:test';
import koffi from 'koffi';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import { installedDsh } from '../scripts/installed-dsh.ts';
import { executionFixture, loadPackedExecutor, qualifyPackedProfile } from './fixtures.ts';

/** Sample only descendants of this test process. Keep each handle for the native exit code. */
function observeAlias(name: string) {
  const k = koffi.load('kernel32.dll');
  const snapshot = k.func('void * CreateToolhelp32Snapshot(uint32,uint32)');
  const first = k.func('int Process32FirstW(void*,void*)'), next = k.func('int Process32NextW(void*,void*)');
  const open = k.func('void * OpenProcess(uint32,int,uint32)'), close = k.func('int CloseHandle(void*)');
  const identity = k.func('int GetPackageFullName(void*,void*,void*)');
  const debug = k.func('int CheckRemoteDebuggerPresent(void*,void*)'), exit = k.func('int GetExitCodeProcess(void*,void*)');
  const hits = new Map<number, { handle: bigint; packageName: string; debugged: boolean }>();
  function sample() {
    const snap = snapshot(2, 0), entry = Buffer.alloc(568);
    assert.ok(snap && BigInt.asIntN(64, snap) !== -1n);
    entry.writeUInt32LE(entry.length);
    const parents = new Map<number, number>(), candidates: number[] = [];
    try {
      for (let ok = first(snap, entry); ok; ok = next(snap, entry)) {
        const pid = entry.readUInt32LE(8);
        parents.set(pid, entry.readUInt32LE(32));
        if (!hits.has(pid) && entry.toString('utf16le', 44, 564).split('\0')[0]!.toLowerCase() === name + '.exe') candidates.push(pid);
      }
    } finally { assert.ok(close(snap)); }
    for (const pid of candidates) {
      let ancestor = parents.get(pid);
      const seen = new Set<number>();
      while (ancestor && ancestor !== process.pid && !seen.has(ancestor)) { seen.add(ancestor); ancestor = parents.get(ancestor); }
      if (ancestor !== process.pid) continue;
      const handle = open(0x1000 | 0x400, 0, pid) as bigint | null;
      if (!handle) continue;
      const size = Buffer.alloc(4), text = Buffer.alloc(2048), present = Buffer.alloc(4);
      size.writeUInt32LE(text.length / 2);
      let retained = false;
      try {
        if (identity(handle, size, text) !== 0 || !debug(handle, present)) continue;
        hits.set(pid, { handle, packageName: text.toString('utf16le', 0, 2 * (size.readUInt32LE() - 1)), debugged: !!present.readUInt32LE() });
        retained = true;
      } finally { if (!retained) assert.ok(close(handle)); }
    }
  }
  const timer = setInterval(sample, 3);
  return () => {
    clearInterval(timer);
    try {
      return [...hits].map(([pid, hit]) => {
        const code = Buffer.alloc(4); assert.ok(exit(hit.handle, code));
        return { pid, packageName: hit.packageName, debugged: hit.debugged, status: code.readUInt32LE() };
      });
    } finally { for (const hit of hits.values()) assert.ok(close(hit.handle)); }
  };
}

await test('packaged CLI and debugger qualification through installed DSH providers', t => qualifyPackedProfile(t, import.meta.url, async profile => {
  const f = await executionFixture(t);
  const dsh = installedDsh();
  const { default: Stock } = await dsh.load(dsh.baseRequire, '@deepseek-ai/dsh-pwsh-sandbox') as { default: new (ctx: Context, config: { pwshPath: string }) => object };
  const { Executor: Bash } = await loadPackedExecutor(f.ctx, profile);
  const aliases = join(process.env.LOCALAPPDATA!, 'Microsoft/WindowsApps');
  const gdb = process.env.DSH_TEST_GDB ?? join(process.env.ProgramFiles!, 'Inkscape/bin/gdb.exe');
  const target = join(f.workspace, 'exit-target.exe');
  await copyFile(join(process.env.SystemRoot!, 'System32/cmd.exe'), target);
  const modes = ['read-only', 'workspace-write', 'danger-full-access'] as const;
  const expected = new Map<string, { packageName: string; status: number }>();
  t.diagnostic('Windows ' + release() + ', DSH ' + dsh.version + ', Node ' + process.version + ', ' + execFileSync(join(f.source, f.installed.layout, 'bin/git.exe'), ['--version'], { encoding: 'utf8' }).trim() + ' ' + f.installed.layout);
  for (const backend of ['stock', 'bash']) {
    const fiber = backend === 'stock' ? f.ctx.plugin(Stock, { pwshPath: join(aliases, 'pwsh.exe') })
      : f.ctx.plugin(Bash, { gitBashPath: f.request.gitBashPath });
    await fiber;
    try {
      const run = async (mode: SandboxExecutionPolicy['mode'], command: string) => {
        const ex = await f.ctx.shell.execute(f.ctx.shell.resolve({ command, workdir: f.workspace, timeoutMs: 30000,
          env: { PATH: aliases + ';' + process.env.PATH }, sandboxPolicy: { mode, workspaceRoot: f.workspace } }));
        return ex.result();
      };
      for (const mode of modes) {
        for (const name of ['pwsh', 'winget']) await t.test([backend, mode, name].join(' / '), async t => {
          if (name === 'winget') assert.equal(process.env.DSH_TEST_WINGET, '1', 'UNVERIFIED: WinGet application logging requires DSH_TEST_WINGET=1.');
          assert.ok(await lstat(join(aliases, name + '.exe')).catch(() => undefined), 'UNVERIFIED: missing packaged ' + name);
          const payload = '"PID=$PID"; Start-Sleep -Milliseconds 450; exit 19';
          const cmd = name === 'pwsh' ? "pwsh -NoProfile -NonInteractive -Command '" + payload + "'" : 'winget --version';
          const finish = observeAlias(name);
          let observed: ReturnType<typeof finish> = [];
          const result = await run(mode, backend === 'stock' ? '& ' + cmd + '; exit $LASTEXITCODE' : cmd).finally(() => { observed = finish(); });
          const pid = name === 'pwsh' ? Number(/PID=(\d+)/.exec(result.stdout.text)?.[1]) : undefined;
          const hits = observed.filter(h => pid === undefined || h.pid === pid);
          assert.equal(hits.length, 1, JSON.stringify({ observed, output: result.stdout.text, error: result.stderr.text }));
          const hit = hits[0]!, key = name + '/' + mode;
          assert.ok(hit.packageName.startsWith(name === 'pwsh' ? 'Microsoft.PowerShell_' : 'Microsoft.DesktopAppInstaller_'));
          assert.equal(hit.debugged, false);
          assert.equal(hit.status, name === 'pwsh' ? 19 : mode === 'danger-full-access' ? 0 : 0x8a150001);
          assert.equal(result.exitCode, backend === 'stock' ? hit.status : hit.status & 255);
          if (name === 'winget' && mode === 'danger-full-access') assert.match(result.stdout.text, /^v\d+\.\d+\.\d+\s*$/m);
          const facts = { packageName: hit.packageName, status: hit.status };
          if (backend === 'stock') expected.set(key, facts);
          else assert.deepEqual(facts, expected.get(key));
          t.diagnostic(JSON.stringify(hit));
        });
        if (backend !== 'bash') continue;
        await t.test(mode + ' / packaged PowerShell pipeline', async () => {
          const r = await run(mode, `pwsh -NoProfile -NonInteractive -Command '"host-grep" | grep.exe -Fx host-grep; exit $LASTEXITCODE'`);
          assert.equal(r.exitCode, 0, r.stderr.text); assert.match(r.stdout.text, /host-grep/);
        });
        await t.test(mode + ' / GDB on an owned target', async t => {
          assert.ok(await stat(gdb).catch(() => undefined), 'UNVERIFIED: set DSH_TEST_GDB to the installed gdb.exe.');
          t.diagnostic(execFileSync(gdb, ['--version'], { encoding: 'utf8' }).split('\n')[0]!);
          const q = (p: string) => "'" + p.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
          const r = await run(mode, "MSYS2_ARG_CONV_EXCL='*' " + q(gdb) + " -nx -q -batch -ex 'set startup-with-shell off' -ex run --args " + q(target) + " /d /c 'exit 23'");
          assert.equal(r.exitCode, 0, r.stderr.text); assert.match(r.stdout.text + r.stderr.text, /Inferior \d+ .*exited with code (?:027|23|0x17)/i);
        });
      }
    } finally { await fiber.dispose(); }
  }
}));
