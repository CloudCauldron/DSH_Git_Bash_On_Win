import { mkdtemp, rm, mkdir, writeFile, link, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { admitDirectory, removeTree } from '../src/runtime/ntfs-filesystem.ts';
import { prepareRuntime, purgeRuntimeCache, type GenerationPin, type RuntimePreparation } from '../src/runtime/runtime-cache.ts';
import { anchorPaths, type AnchorStamps, type GitLayout } from '../src/runtime/git-installation.ts';

/** Ordinary bootstrap files only. Native cache fixtures must use guarded purge. */
export async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-git-bash-bootstrap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export const nativeWindows = process.platform === 'win32' && process.arch === 'x64';
export const nativeOnly = { skip: !nativeWindows && 'Requires native Windows x64 and NTFS.' };

/** All native payloads are owned copies; teardown never uses recursive rm. */
export async function runtimeFixture(t: TestContext, layout: GitLayout = 'ucrt64') {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-git-bash-native-'));
  const source = join(directory, 'source'), cache = join(directory, 'cache'), workspace = join(directory, 'workspace');
  const pins = new Set<GenerationPin>();
  const caches = new Set([cache]);
  t.after(async () => {
    for (const pin of pins) await pin.release();
    for (const path of caches) await purgeRuntimeCache(path);
    removeTree(admitDirectory(dirname(directory)), basename(directory));
  });
  await mkdir(source);
  await mkdir(workspace);
  for (const file of [...Object.values(anchorPaths(layout)), 'usr/lib/perl/module.pm', 'usr/share/doc/ignored.txt', 'usr/lib/winpty.lib', `${layout}/libexec/git-core/git-helper.exe`]) {
    await mkdir(dirname(join(source, file)), { recursive: true });
    if (file === 'usr/bin/sh.exe') await link(join(source, 'usr/bin/bash.exe'), join(source, file));
    else await writeFile(join(source, file), `fixture ${file}\n`);
  }
  const request: RuntimePreparation = {
    cacheDirectory: cache, gitBashPath: join(source, 'usr/bin/bash.exe'),
    spawn: () => { throw new Error('A Phase 2 fixture must never start a subprocess or open UAC.'); },
  };
  return {
    directory, source, cache, workspace, request,
    async prepare(rebuild = false, signal = new AbortController().signal, cacheDirectory = cache) {
      caches.add(cacheDirectory);
      const pin = await prepareRuntime({ ...request, rebuild, cacheDirectory }, signal);
      pins.add(pin);
      return pin;
    },
    async current() {
      return JSON.parse(await readFile(join(cache, 'current.json'), 'utf8')) as {
        schemaVersion: 1; generationId: string; sourceRoot: string; layout: GitLayout; anchors: AnchorStamps;
      };
    },
  };
}
