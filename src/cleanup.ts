import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Phase 2 delegates to runtime-cache's shared guarded purge. Never fall back
// to recursive removal: the cache can contain hardlinks and live native holds.
export async function purgeRuntimeCaches(profileCache: string, fallbackCache = fileURLToPath(new URL('../.runtime', import.meta.url))): Promise<void> {
  if (!isAbsolute(profileCache) || !isAbsolute(fallbackCache)) throw new Error('Cache paths must be absolute.');
  throw new Error('Runtime purge is not implemented in Phase 1; cleanup and uninstallation are incomplete.');
}

if (import.meta.main) {
  const [directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length) throw new Error('Usage: node lib/cleanup.js <absolute profile cache path>');
  await purgeRuntimeCaches(directory);
}
