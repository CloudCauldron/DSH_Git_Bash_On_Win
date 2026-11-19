import { isAbsolute } from 'node:path';
import { purgeRuntimeCache } from './runtime/runtime-cache.js';
import { LocalizedError } from './localized-error.js';
// Offline only: close every DSH instance sharing this DSH home before invoking.
const [directory, ...extra] = process.argv.slice(2);
if (!directory || extra.length || !isAbsolute(directory))
    throw new LocalizedError('error.purgeUsage', { command: 'node lib/purge-runtime-cache.js <absolute shared cache path>' });
try {
    await purgeRuntimeCache(directory);
}
catch (cause) {
    throw new LocalizedError('error.purgeIncomplete', undefined, { cause });
}
