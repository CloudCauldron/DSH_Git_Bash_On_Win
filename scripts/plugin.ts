import { dirname, isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { loadRuntime } from '../poc/runtime.ts';
import { purgeRuntime } from '../src/private-runtime.ts';

// Repository helper for this installation's broken bare-name pnpm lookup.
// Use the same official operation/compatibility/reconciliation code as dsh plugin.
const [pnpm, profile, ...args] = process.argv.slice(2);
if (!pnpm || !isAbsolute(pnpm) || !profile || args.length === 0) throw new Error('Usage: node scripts/plugin.ts <absolute pnpm.exe> <profile> <pnpm arguments...>');
const runtime = await loadRuntime();
const { resolveProfileDir } = await runtime.load(runtime.cliRequire, '@deepseek-ai/dsh-app-boot');
const { runPluginCommand } = await runtime.load(runtime.cliRequire, '@deepseek-ai/dsh-plugin-manager/operations');
const dir = resolveProfileDir(profile);
if (['remove', 'rm', 'uninstall', 'un'].includes(args[0]!) && args.slice(1).includes('dsh-git-bash-on-win')) {
  let packageDirectory: string | undefined;
  try { packageDirectory = dirname(realpathSync(createRequire(join(dir, 'package.json')).resolve('dsh-git-bash-on-win/package.json'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error; }
  if (packageDirectory) await purgeRuntime(join(packageDirectory, '.runtime'));
  await purgeRuntime(join(dir, '.git-bash-on-win'));
}
const result = await runPluginCommand({ profile, dir, installAnchor: runtime.manifest, cwd: process.cwd() }, args,
  { command: pnpm, execution: 'cli', outputBytes: 16_384, lockWaitMs: 120_000, lookupTimeoutMs: 120_000,
    onOutput: (text: string, stream: 'stdout' | 'stderr') => process[stream].write(text) });
process.exitCode = result.exitCode ?? 1;
