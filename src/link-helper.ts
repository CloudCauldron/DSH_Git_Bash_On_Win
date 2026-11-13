import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { linkRuntimeFiles, removePrivateTree, retryCleanup, setupCancellationFile } from './private-runtime.ts';

// UAC setup entry. No shell commands, process launch, file replacement, or ACL API.
const [source, generation, owner] = process.argv.slice(2);
if (process.platform !== 'win32' || !source || !generation || !/^[a-f0-9-]{36}$/i.test(basename(generation))
  || !/^[a-f0-9-]{36}$/i.test(basename(dirname(generation))) || realpathSync(generation).toLowerCase() !== generation.toLowerCase()) {
  throw new Error('An existing private runtime generation is required.');
}
if (!owner || !/^\d+$/.test(owner) || Number(owner) <= 0) throw new Error('The unelevated setup owner is required.');
const checkOwner = () => {
  process.kill(Number(owner), 0);
  if (existsSync(join(generation, setupCancellationFile))) throw new Error('Hardlink setup was cancelled.');
};
const result = join(generation, 'setup-result.json');
if (existsSync(result)) throw new Error('Setup result already exists.');
try {
  checkOwner();
  await linkRuntimeFiles(source, generation, checkOwner);
  checkOwner();
  writeFileSync(result, JSON.stringify({ ok: true }), { flag: 'wx' });
} catch (error) {
  try { checkOwner(); } catch {
    process.chdir(dirname(generation));
    await retryCleanup(() => removePrivateTree(generation));
    throw new Error('The setup was cancelled or its owner exited; private hardlinks were removed.');
  }
  writeFileSync(result, JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }), { flag: 'wx' });
  process.exitCode = 1;
}
