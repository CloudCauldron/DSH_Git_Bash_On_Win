import { dirname, isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { installedDsh } from './installed-dsh.ts';
import { purgeRuntimeCaches } from '../src/cleanup.ts';

// Narrow public CLI contracts. Modules must come from the selected installed
// CLI so its official compatibility, locking and bundle reconciliation apply.
interface AppBoot { resolveProfileDir(profile: string): string }
interface PluginOperations {
  runPluginCommand(
    context: { profile: string; dir: string; installAnchor: string; cwd: string },
    args: string[],
    options: {
      command: string; execution: 'cli'; outputBytes: number;
      lockWaitMs: number; lookupTimeoutMs: number;
      onOutput(text: string, stream: 'stdout' | 'stderr'): void;
    },
  ): Promise<{ exitCode: number | null }>;
}

export async function main(argv: string[]): Promise<number> {
  const [pnpm, profile, ...args] = argv;
  if (!pnpm || !isAbsolute(pnpm) || !profile || !args.length) {
    throw new Error('Usage: node scripts/plugin.ts <absolute pnpm.exe> <profile> <pnpm arguments...>');
  }
  const runtime = installedDsh();
  const { resolveProfileDir } = await runtime.load(runtime.cliRequire, '@deepseek-ai/dsh-app-boot') as AppBoot;
  const { runPluginCommand } = await runtime.load(runtime.cliRequire, '@deepseek-ai/dsh-plugin-manager/operations') as PluginOperations;
  const dir = resolveProfileDir(profile);
  if (['remove', 'rm', 'uninstall', 'un'].includes(args[0]!) && args.slice(1).includes('dsh-git-bash-on-win')) {
    const packageDirectory = dirname(realpathSync(createRequire(join(dir, 'package.json')).resolve('dsh-git-bash-on-win/package.json')));
    // Never report uninstall success before both caches have been strictly purged.
    await purgeRuntimeCaches(join(dir, '.git-bash-on-win'), join(packageDirectory, '.runtime'));
  }
  const result = await runPluginCommand({ profile, dir, installAnchor: runtime.manifest, cwd: process.cwd() }, args, {
    command: pnpm, execution: 'cli', outputBytes: 16_384,
    lockWaitMs: 120_000, lookupTimeoutMs: 120_000,
    onOutput: (text, stream) => { process[stream].write(text); },
  });
  return result.exitCode ?? 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
