import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { purgeRuntimeCache } from './runtime/runtime-cache.ts';

// Offline only: close every DSH instance using either cache before invoking.
const [directory, ...extra] = process.argv.slice(2);
if (!directory || extra.length || !isAbsolute(directory)) throw new Error('Usage: node lib/cleanup.js <absolute profile cache path>');
const fallback = fileURLToPath(new URL('../.runtime', import.meta.url));
try {
  await purgeRuntimeCache(directory);
  if (resolve(directory).toLowerCase() !== resolve(fallback).toLowerCase()) await purgeRuntimeCache(fallback);
} catch (cause) {
  throw new Error('Runtime cleanup and uninstallation are incomplete.', { cause });
}
