import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Always verify the current build, never a stale development archive. */
export function packPlugin(pnpm: string, repository: string, destination: string): string {
  const packed = spawnSync(pnpm, ['pack', '--pack-destination', destination, '--silent'],
    { cwd: repository, encoding: 'utf8', timeout: 120_000, maxBuffer: 4_000_000 });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
  return join(destination, `${manifest.name}-${manifest.version}.tgz`);
}
