import { dirname, isAbsolute } from 'node:path';
import { purgeRuntimeCache, sharedCacheDirectory } from './runtime/runtime-cache.js';
import { samePath } from './runtime/ntfs-filesystem.js';
import { LocalizedError } from './locale/errors.js';
// Offline only: close every DSH instance sharing this DSH home before invoking.
const [directory, ...extra] = process.argv.slice(2);
if (!directory || extra.length || !isAbsolute(directory) || !samePath(directory, sharedCacheDirectory(dirname(directory)))) {
    throw new LocalizedError('error.purgeUsage', { command: 'node lib/purge-runtime-cache.js <absolute shared cache path>' });
}
try {
    await purgeRuntimeCache(directory);
}
catch (cause) {
    throw new LocalizedError('error.purgeIncomplete', undefined, { cause, failures: [cause] });
}
