import { isAbsolute, join } from 'node:path';
import { installedDsh } from './installed-dsh.ts';
import { purgeRuntimeCache } from '../src/runtime/runtime-cache.ts';
import { canonicalExistingPath, pathExists } from '../src/runtime/ntfs-filesystem.ts';

// Arbitrary pnpm flags could redirect removal or bypass the cache purge.
// DSH owns package compatibility and bundle reconciliation.
const [pnpm, profile, operation, target, ...extra] = process.argv.slice(2);
const packageName = 'dsh-git-bash-on-win';
if (!pnpm || !isAbsolute(pnpm) || !profile || extra.length
  || !(operation === 'add' && target && isAbsolute(target) && target.endsWith('.tgz')
    || operation === 'remove' && target === packageName)) {
  throw new Error('Usage: node scripts/plugin.ts <absolute pnpm.exe> <profile> <add <absolute .tgz> | remove dsh-git-bash-on-win>');
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
// Offline precondition for installation/replacement too: pnpm may remove the old
// package tree. Locate its entry without relying on an intact package manifest.
// An idle DSH instance without a pin can otherwise recreate the fallback cache.
try {
  const entry = join(dir, 'node_modules', packageName);
  if (pathExists(entry)) await purgeRuntimeCache(join(canonicalExistingPath(entry), '.runtime'));
  if (operation === 'remove') await purgeRuntimeCache(join(dir, '.git-bash-on-win'));
} catch (cause) {
  throw new Error(`Runtime cleanup is incomplete; package ${operation === 'remove' ? 'removal' : 'installation'} was not started. Close every DSH instance and resolve the reported obstruction before retrying.`, { cause });
}
const result = await runPluginCommand({ profile, dir, installAnchor: runtime.manifest, cwd: process.cwd() },
  [operation, target!, '--ignore-scripts'], {
    command: pnpm, execution: 'cli', outputBytes: 16_384, lockWaitMs: 120_000,
    onOutput: (text, stream) => { process[stream].write(text); },
  });
process.exitCode = result.exitCode ?? 1;
