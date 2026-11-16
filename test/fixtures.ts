import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

/** Ordinary bootstrap files only. Native cache fixtures must use guarded purge. */
export async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-git-bash-bootstrap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
