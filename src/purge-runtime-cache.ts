import { isAbsolute } from 'node:path';
import { purgeRuntimeCache } from './runtime/runtime-cache.ts';
import { LocalizedError } from './localized-error.ts';

// Offline only: close every DSH instance using this profile before invoking.
const [directory, ...extra] = process.argv.slice(2);
if (!directory || extra.length || !isAbsolute(directory)) throw new LocalizedError('error.purgeUsage', { command: 'node lib/purge-runtime-cache.js <absolute profile cache path>' });
try {
  await purgeRuntimeCache(directory);
} catch (cause) {
  throw new LocalizedError('error.purgeIncomplete', undefined, { cause });
}
