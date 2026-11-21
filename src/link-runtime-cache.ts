import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { LocalizedError } from './locale/errors.ts';
import { admitDirectory, samePath } from './runtime/ntfs-filesystem.ts';
import { prepareRuntime, sharedCacheDirectory } from './runtime/runtime-cache.ts';

// An explicit operator invocation. Only the fixed broker/helper may elevate.
const [home, profile, gitBashPath, installAnchor, ...extra] = process.argv.slice(2);
if (process.platform !== 'win32' || process.arch !== 'x64') throw new LocalizedError('error.runtimePlatform');
if (!home || !isAbsolute(home) || !profile || !isAbsolute(profile) || !gitBashPath || !isAbsolute(gitBashPath) || (installAnchor !== undefined && !isAbsolute(installAnchor)) || extra.length) {
  throw new LocalizedError('error.pluginUsage', { command: 'node lib/link-runtime-cache.js <absolute DSH home> <absolute DSH profile directory> <absolute bash.exe> [absolute DSH installation anchor]' });
}
const directory = admitDirectory(profile).path;
const manifest = join(directory, 'package.json'), name = 'dsh-git-bash-on-win';
const metadata = JSON.parse(readFileSync(manifest, 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } };
const bundles = metadata.dsh?.profile?.bundles;
if (!Array.isArray(bundles) || !bundles.includes(name)) throw new LocalizedError('error.linkProfile', { path: directory });
let installedManifest: string;
if (installAnchor) {
  const boot = createRequire(installAnchor).resolve('@deepseek-ai/dsh-app-boot');
  const { resolveBundleDir } = await import(pathToFileURL(boot).href) as {
    resolveBundleDir(binName: string, packageName: string, installAnchor: string, profileDir: string): string;
  };
  installedManifest = join(resolveBundleDir('dsh', name, installAnchor, directory), 'package.json');
} else {
  installedManifest = createRequire(manifest).resolve(name + '/package.json');
}
if (!samePath(realpathSync(installedManifest), realpathSync(join(import.meta.dirname, '../package.json')))) {
  throw new LocalizedError('error.linkProfile', { path: directory });
}
const controller = new AbortController(), ctx = new Context();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  await ctx.plugin(LocalSubprocessRuntime);
  const pin = await prepareRuntime({ cacheDirectory: sharedCacheDirectory(home), gitBashPath, installAnchor, elevation: 'manual',
    spawn: ctx.subprocess.spawn.bind(ctx.subprocess) }, controller.signal);
  await pin.release();
} finally {
  await ctx.fiber.dispose();
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}
console.log('Git Bash links ready.');
