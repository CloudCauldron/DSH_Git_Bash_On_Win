import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { installedDsh } from './installed-dsh.ts';
import { purgeRuntimeCache, sharedCacheDirectory } from '../src/runtime/runtime-cache.ts';
import { LocalizedError } from '../src/locale/errors.ts';

// Arbitrary pnpm flags could redirect removal or bypass the cache purge.
// DSH owns package compatibility and bundle reconciliation.
const [pnpm, profile, operation, target, ...extra] = process.argv.slice(2);
const packageName = 'dsh-git-bash-on-win';
const purge = operation === 'remove' && extra.length === 1 && extra[0] === '--purge-cache';
if (!pnpm || !isAbsolute(pnpm) || !profile || (extra.length && !purge)
  || !(operation === 'add' && target?.startsWith('file:') && isAbsolute(target.slice(5))
    && statSync(target.slice(5), { throwIfNoEntry: false })?.isDirectory()
    || operation === 'remove' && target === packageName)) {
  throw new LocalizedError('error.pluginUsage', { command: 'node scripts/plugin.ts <absolute pnpm.exe> <profile> <add file:<absolute checkout> | remove dsh-git-bash-on-win [--purge-cache]>' });
}
const runtime = installedDsh();
const { resolveProfileDir } = await runtime.load(runtime.cliRequire, '@deepseek-ai/dsh-app-boot') as {
  resolveProfileDir(profile: string): string;
};
const { runPluginCommand } = await runtime.load(runtime.cliRequire, '@deepseek-ai/dsh-plugin-manager/operations') as {
  runPluginCommand(context: { profile: string; dir: string; installAnchor: string; cwd: string }, args: string[],
    options: { command: string; execution: 'cli'; outputBytes: number; lockWaitMs: number;
      onOutput(text: string, stream: 'stdout' | 'stderr'): void }): Promise<{ exitCode: number | null }>;
};
const dir = resolveProfileDir(profile);
if (purge) {
  // Full-home cleanup is explicit: removing one profile must preserve other profiles' links.
  const { resolveDshHome } = await runtime.load(runtime.cliRequire, '@deepseek-ai/dsh-home-paths') as { resolveDshHome(): string };
  try { await purgeRuntimeCache(sharedCacheDirectory(resolveDshHome())); }
  catch (cause) {
    throw new LocalizedError('error.removalBlocked', undefined, { cause });
  }
}
const result = await runPluginCommand({ profile, dir, installAnchor: runtime.manifest, cwd: process.cwd() },
  [operation, target!, '--config.ignore-scripts=true'], {
    command: pnpm, execution: 'cli', outputBytes: 16_384, lockWaitMs: 120_000,
    onOutput: (text, stream) => { process[stream].write(text); },
  });
process.exitCode = result.exitCode ?? 1;
