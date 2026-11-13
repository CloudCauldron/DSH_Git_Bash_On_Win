import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { purgeRuntime } from './private-runtime.ts';

// Run with DSH closed, before removing the package through the native manager.
const [directory, ...extra] = process.argv.slice(2);
if (!directory || extra.length || !isAbsolute(directory) || !['.git-bash-on-win', '.runtime'].includes(basename(directory))) {
  throw new Error('Usage: node lib/cleanup.js <absolute profile/.git-bash-on-win or package/.runtime path>');
}
const fallback = fileURLToPath(new URL('../.runtime', import.meta.url));
if (resolve(directory).toLowerCase() !== resolve(fallback).toLowerCase()) await purgeRuntime(fallback);
await purgeRuntime(directory);
