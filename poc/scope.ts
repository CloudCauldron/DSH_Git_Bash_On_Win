import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removePrivateTree } from '../src/private-runtime.ts';

/** Only the disposable controller's environment changes; callers outside it are unaffected. */
export function createTestScope(prefix = 'dsh-gitbash-phase2-') {
  if (process.platform !== 'win32') throw new Error('A native Windows controller is required.');
  const ambientTemp = tmpdir();
  const lockRoot = join(ambientTemp, 'dsh-acl-locks');
  const entries = () => existsSync(lockRoot) ? readdirSync(lockRoot).sort() : [];
  const before = entries();
  const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  const root = mkdtempSync(join(ambientTemp, prefix));
  const privateTemp = join(root, 'controller-temp');
  try {
    mkdirSync(privateTemp);
    process.env.TEMP = privateTemp;
    process.env.TMP = privateTemp;
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  let disposed = false;
  return {
    root, privateTemp,
    dispose() {
      if (disposed) throw new Error('Test scope has already been disposed.');
      disposed = true;
      for (const key of ['TEMP', 'TMP'] as const) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      removePrivateTree(root);
      const addedAmbientLocks = entries().filter(name => !before.includes(name));
      return { temporaryRootRemoved: !existsSync(root), addedAmbientLocks, environmentRestored: process.env.TEMP === previous.TEMP && process.env.TMP === previous.TMP };
    },
  };
}
