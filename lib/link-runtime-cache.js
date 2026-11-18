import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { LocalizedError } from './localized-error.js';
import { admitDirectory, samePath } from './runtime/ntfs-filesystem.js';
import { prepareRuntime } from './runtime/runtime-cache.js';
// An explicit operator invocation. Only the fixed broker/helper may elevate.
const [profile, gitBashPath, ...extra] = process.argv.slice(2);
if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new LocalizedError('error.runtimePlatform');
if (!profile || !isAbsolute(profile) || !gitBashPath || !isAbsolute(gitBashPath) || extra.length) {
    throw new LocalizedError('error.pluginUsage', { command: 'node lib/link-runtime-cache.js <absolute DSH profile directory> <absolute bash.exe>' });
}
const directory = admitDirectory(profile).path;
const manifest = join(directory, 'package.json'), name = 'dsh-git-bash-on-win';
const metadata = JSON.parse(readFileSync(manifest, 'utf8'));
const bundles = metadata.dsh?.profile?.bundles;
if (basename(dirname(directory)).toLowerCase() !== 'profiles' || !Array.isArray(bundles) || !bundles.includes(name)
    || !samePath(realpathSync(createRequire(manifest).resolve(name + '/package.json')), realpathSync(join(import.meta.dirname, '../package.json')))) {
    throw new LocalizedError('error.linkProfile', { path: directory });
}
const controller = new AbortController(), ctx = new Context();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
    await ctx.plugin(LocalSubprocessRuntime);
    const pin = await prepareRuntime({ cacheDirectory: join(directory, '.git-bash-on-win'), gitBashPath, elevation: 'manual',
        spawn: ctx.subprocess.spawn.bind(ctx.subprocess) }, controller.signal);
    await pin.release();
}
finally {
    await ctx.fiber.dispose();
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
}
console.log('Git Bash links ready.');
