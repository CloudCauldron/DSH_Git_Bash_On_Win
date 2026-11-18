import { isAbsolute } from 'node:path';
import { purgeRuntimeCache } from './runtime/runtime-cache.ts';

// Offline only: close every DSH instance using this profile before invoking.
const [directory, ...extra] = process.argv.slice(2);
if (!directory || extra.length || !isAbsolute(directory)) throw new Error('Usage: node lib/purge-runtime-cache.js <absolute profile cache path>');
try {
  await purgeRuntimeCache(directory);
} catch (cause) {
  throw new Error('Runtime cleanup and uninstallation are incomplete.', { cause });
}
