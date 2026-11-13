import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const inject = ['appReady', 'appExit', 'shell', 'agentPresets', 'agents', 'tools', 'profileContext', 'configEditor'];
const progress = (stage: string, detail?: unknown) => writeFileSync(join(process.env.DSH_HOME!, 'driver-progress.json'), JSON.stringify({ stage, detail }));
progress('imported');

// Loaded ONLY in the disposable test profile by the real DSH CLI.
export function apply(ctx: any, config: { execute?: boolean } = {}): void {
  progress('applied', config);
  ctx.effect(() => ctx.appReady.onReady(() => {
    void verify(ctx, config.execute !== false && process.env.DSH_GITBASH_VERIFY_CLEANUP !== '1').then(report => {
      writeFileSync(join(ctx.profileContext.dir, 'verification.json'), JSON.stringify(report, null, 2));
      ctx.appExit(report.checks.every((check: any) => check.passed) ? 0 : 1);
    }, error => {
      writeFileSync(join(ctx.profileContext.dir, 'verification.json'), JSON.stringify({ error: String(error), stack: error?.stack, checks: error?.checks, runs: error?.runs }));
      ctx.appExit(1);
    });
  }));
}

async function verify(ctx: any, execute: boolean) {
  progress('ready', { execute });
  const startupPatchHash = createHash('sha256').update(readFileSync(ctx.profileContext.patchPath)).digest('hex');
  const checks: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
  const runs: unknown[] = [];
  const check = (name: string, passed: boolean, detail?: unknown) => {
    checks.push({ name, passed, detail });
    progress(name, { passed });
    if (!passed) throw Object.assign(new Error(`${name}: ${JSON.stringify(detail)}`), { checks, runs });
  };
  const entry = [...ctx.loader.entries()].find((row: any) => row.options.id === 'pwsh-sandbox') as any;
  check('native pwsh-sandbox ID owns Git Bash executor', entry?.options.name === '@deepseek-ai/dsh-pwsh-sandbox' && entry.fiber?.runtime?.callback.name === 'GitBashExecutor', { module: entry?.options.name, provider: entry?.fiber?.runtime?.callback.name });
  const Native = Object.getPrototypeOf(entry.fiber.runtime.callback);
  const schema = entry.fiber.runtime.Config;
  const fields = Object.keys(Native.Config.dict);
  check('all native schema fields are reused without alteration', fields.length > 0
    && fields.every(field => schema.dict[field] === Native.Config.dict[field])
    && Object.keys(schema.dict).length === fields.length + 1 && schema.dict.gitBashPath.meta.volatile === true);
  const settings = { cwd: join(ctx.profileContext.cwd, '設定 目錄'), timeoutMs: 9876, maxTimeoutMs: 180_000,
    maxOutputBytes: 2345, maxSpillBytes: 4096, graceMs: 250, gitBashPath: 'C:/Program Files/Git/usr/bin/bash.exe' };
  mkdirSync(settings.cwd, { recursive: true });
  if (process.env.DSH_GITBASH_VERIFY_RESTART !== '1') {
    const shell = ctx.shell, fiber = entry.fiber;
    const patchBefore = readFileSync(ctx.profileContext.patchPath, 'utf8');
    for (const [field, value] of Object.entries(settings)) {
      await assert.rejects(ctx.configEditor.edit(entry, (current: Record<string, unknown>) => ({ ...current, [field]: typeof value === 'number' ? 'invalid-number' : 42 })));
    }
    check('every setting rejects schema-invalid edits without persistence or reload', readFileSync(ctx.profileContext.patchPath, 'utf8') === patchBefore && entry.fiber === fiber && ctx.shell.config === shell.config,
      { patchUnchanged: readFileSync(ctx.profileContext.patchPath, 'utf8') === patchBefore, fiberUnchanged: entry.fiber === fiber, configUnchanged: ctx.shell.config === shell.config });
    for (const [field, value] of Object.entries(settings)) {
      await ctx.configEditor.edit(entry, (current: Record<string, unknown>) => ({ ...current, [field]: value }));
      check(`${field} hot-reloads through native ConfigEditor without replacing the executor`, ctx.shell.config === shell.config && entry.fiber === fiber && ctx.shell.config[field].get() === value);
    }
  }
  check('all settings are active, including after a fresh profile boot', Object.entries(settings).every(([field, value]) => ctx.shell.config[field].get() === value));
  const resolved = ctx.shell.resolve({ command: 'true' });
  check('native defaulting and per-call overrides are preserved', resolved.workdir === settings.cwd && resolved.timeoutMs === settings.timeoutMs
    && resolved.stdoutMaxBytes === settings.maxOutputBytes && ctx.shell.resolve({ command: 'true', timeoutMs: 500_000 }).timeoutMs === settings.maxTimeoutMs
    && ctx.shell.resolve({ command: 'true', workdir: ctx.profileContext.cwd, stdoutMaxBytes: 123 }).workdir === ctx.profileContext.cwd
    && ctx.shell.resolve({ command: 'true', stdoutMaxBytes: 123 }).stdoutMaxBytes === 123);
  for (const field of fields.filter(field => field !== 'cwd')) {
    for (const value of [0, -1, Infinity, NaN, ...field === 'graceMs' ? [2_147_483_648] : []]) {
      assert.throws(() => Native.prototype.resolve.call({ ctx, config: entry.fiber.resolveConfig({ ...entry.options.config, [field]: value }) }, { command: 'true' }), new RegExp(field));
    }
  }
  check('unserviceable numeric settings retain native next-command rejection', true);
  check('native settings reconciliation keeps Git Bash provider active', entry.fiber?.runtime?.callback.name === 'GitBashExecutor');
  if (execute) {
    const result = await (await ctx.shell.execute(ctx.shell.resolve({ command: "pwd -W; awk 'BEGIN { for(i=0;i<10000;i++) printf \"x\"; print \"TAIL\" }'", timeoutMs: 120_000 }))).result();
    check('live cwd/output/spill settings reach the native executor', result.exitCode === 0 && result.stdout.truncated
      && Buffer.byteLength(result.stdout.text) <= settings.maxOutputBytes && result.stdout.text.endsWith('TAIL\n') && result.stdout.spillPath === undefined, result);
    const spilled = await (await ctx.shell.execute(ctx.shell.resolve({ command: "awk 'BEGIN { for(i=0;i<3000;i++) printf \"s\"; print \"TAIL\" }'" }))).result();
    check('live output within the spill budget creates a complete readable spill file', spilled.exitCode === 0 && spilled.stdout.truncated
      && typeof spilled.stdout.spillPath === 'string' && readFileSync(spilled.stdout.spillPath, 'utf8') === 's'.repeat(3000) + 'TAIL\n', spilled);
    const cwd = await (await ctx.shell.execute(ctx.shell.resolve({ command: 'pwd -W' }))).result();
    check('live working directory is used by Git Bash', cwd.exitCode === 0 && cwd.stdout.text.trim().replaceAll('\\', '/').toLowerCase() === settings.cwd.replaceAll('\\', '/').toLowerCase(), cwd);
  }
  for (const preset of ['standard', 'ptc', 'cordis']) {
    const resolved = await ctx.agentPresets.resolve(preset);
    check(`${preset} mounts successfully`, resolved.broken === undefined, resolved);
    const document = await ctx.agentPresets.readDocument(preset);
    check(`${preset} declares native Bash tool`, document.content.includes('@deepseek-ai/dsh-tool-bash') && !document.content.includes('@deepseek-ai/dsh-tool-pwsh'));
    const handle = await ctx.agents.create({ sessionId: `gitbash-${randomUUID()}`, meta: { cwd: ctx.profileContext.cwd, agentPreset: preset },
      setup: async (agentCtx: any) => { await ctx.agentPresets.mount(agentCtx, preset); } });
    try {
      check(`${preset} mounts the Bash capability in its agent scope`, ctx.tools.get('bash', handle.agent) !== undefined && ctx.tools.get('pwsh', handle.agent) === undefined);
      if (preset === 'standard') {
        const canary = join(dirname(ctx.profileContext.cwd), 'outside/approval-must-not-run.txt');
        let requests = 0;
        handle.agent.session.append('approval/policy', { policy: 'ask' });
        handle.agent.session.append('turn/start', { turn: 1 });
        const stop = ctx.on('approval/request', (request: any, next: () => unknown) => {
          if (request.agent.id !== handle.agent.id) return next();
          requests++;
          return 'rejected';
        }, { prepend: true, global: true });
        try {
          const command = `printf should-not-run > '${canary.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
          const denied = await ctx.tools.execute({ agent: handle.agent, signal: AbortSignal.timeout(10_000), calls: [{ type: 'tool-call', id: 'test-native-approval', name: 'bash',
            arguments: JSON.stringify({ description: 'Verify native sandbox escalation approval', command, sandbox_permissions: 'danger-full-access', justification: 'Verify rejection in an isolated test profile' }) }] });
          check('sandbox escalation uses native approval and obeys rejection', requests === 1 && denied.results[0]?.result.isError === true && !existsSync(canary), { requests, result: denied });
        } finally {
          stop();
          handle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } });
        }
      }
      if (!execute) continue;
      const marker = `${preset}-${randomUUID()}`;
      const args = { description: 'Verify isolated preset Git Bash', command: `printf '%s\\n' '${Buffer.from(marker).toString('base64')}' | base64 -d; printf '\\n'; cygpath -w /`, workdir: ctx.profileContext.cwd, timeoutMs: 60_000 };
      const call = preset === 'ptc'
        ? { type: 'tool-call', id: `test-${preset}`, name: 'run_code', arguments: JSON.stringify({ description: 'Verify native PTC Bash', code: `console.log(await tools.bash(${JSON.stringify(args)}))` }) }
        : { type: 'tool-call', id: `test-${preset}`, name: 'bash', arguments: JSON.stringify(args) };
      const result = await ctx.tools.execute({ agent: handle.agent, calls: [call], signal: AbortSignal.timeout(90_000) });
      runs.push({ preset, result });
      // The decoded marker never appears in the request; echoed argv cannot pass.
      check(`${preset} executes its Bash tool`, JSON.stringify(result).includes(marker) && result.results.length === 1 && result.results[0]?.result.isError === false, result);
      check(`${preset} uses profile-scoped runtime storage`, JSON.stringify(result).includes('.git-bash-on-win'), result);
    } finally { await handle.dispose(); }
  }
  const rows = [...ctx.loader.entries()].map((row: any) => ({ id: row.options.id, name: row.options.name, state: row.fiber?.state }));
  check('cleanup plugin coexists', rows.some(row => row.name === 'dsh-session-deletion' && row.state === ctx.fiber.state), rows.filter(row => row.name.includes('dsh-session-deletion')));
  if (process.env.DSH_GITBASH_VERIFY_CLEANUP === '1') {
    const before = { ...entry.options.config };
    delete before.gitBashPath;
    await ctx.configEditor.edit(entry, (current: Record<string, unknown>) => {
      const next = { ...current }; delete next.gitBashPath; return next;
    });
    check('complete-removal step deletes only the plugin-specific path override', !Object.hasOwn(entry.options.config, 'gitBashPath')
      && Object.entries(before).every(([key, value]) => entry.options.config[key] === value));
  }
  return { checks, runs, rows, startupPatchHash };
}
