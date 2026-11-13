import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs, { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import workerThreads from 'node:worker_threads';
import { elevateLinks } from '../lib/elevation.js';
import { RuntimeDirectory, linkRuntimeFiles, purgeRuntime, setupCancellationFile } from '../src/private-runtime.ts';
import { createTestScope } from '../poc/scope.ts';

void test('setup cancellation is signalled while the worker is blocked and waits for worker exit', async () => {
  const scope = createTestScope('dsh-gitbash-elevation-');
  const previous = workerThreads.Worker;
  let worker: EventEmitter | undefined, pending: Promise<unknown> | undefined, created = 0;
  class ControlledWorker extends EventEmitter {
    constructor() { super(); worker = this; created++; }
  }
  try {
    workerThreads.Worker = ControlledWorker as unknown as typeof previous;
    syncBuiltinESMExports();
    const controller = new AbortController(), reason = new Error('Expected setup cancellation');
    let settled = false;
    pending = elevateLinks('unused-source', scope.root, controller.signal).then(() => { settled = true; }, error => { settled = true; return error; });
    controller.abort(reason);
    assert(existsSync(join(scope.root, setupCancellationFile)));
    await setImmediate();
    assert.equal(settled, false, 'cancellation must not discard the worker before it exits');
    worker!.emit('exit', 0);
    assert.equal(await pending, reason);
    settled = false;
    const failure = new Error('Expected worker failure');
    pending = elevateLinks('unused-source', scope.root, new AbortController().signal).then(() => { settled = true; }, error => { settled = true; return error; });
    worker!.emit('error', failure);
    await setImmediate();
    assert.equal(settled, false, 'an error event does not prove the worker has exited');
    worker!.emit('exit', 1);
    assert.equal(await pending, failure);
    const before = created;
    await assert.rejects(elevateLinks('unused-source', scope.root, AbortSignal.abort(reason)), /Expected setup cancellation/);
    assert.equal(created, before);
  } finally {
    worker?.emit('exit', 1); await pending;
    workerThreads.Worker = previous; syncBuiltinESMExports(); scope.dispose();
  }
});

void test('a cancelled fixed helper removes staging without creating source links', () => {
  const scope = createTestScope('dsh-gitbash-helper-cancel-');
  try {
    const source = join(scope.root, 'source'), generation = join(scope.root, randomUUID(), randomUUID());
    mkdirSync(join(source, 'usr/bin'), { recursive: true }); mkdirSync(generation, { recursive: true });
    const file = join(source, 'usr/bin/bash.exe'); writeFileSync(file, 'synthetic source');
    writeFileSync(join(generation, setupCancellationFile), '');
    const helper = join(dirname(fileURLToPath(import.meta.url)), '../lib/link-helper.js');
    const result = spawnSync(process.execPath, [helper, source, generation, String(process.pid)], { encoding: 'utf8', timeout: 5_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /setup was cancelled or its owner exited/);
    assert(!existsSync(generation));
    assert.equal(statSync(file).nlink, 1);
  } finally { scope.dispose(); }
});

void test('cancellation after elevated linking cannot publish a generation', async () => {
  const scope = createTestScope('dsh-gitbash-publish-cancel-');
  const link = fs.promises.link;
  let manager: RuntimeDirectory | undefined;
  try {
    const source = join(scope.root, 'source'), workspace = join(scope.root, 'workspace'), cache = join(scope.root, '.git-bash-on-win');
    mkdirSync(join(source, 'usr/bin'), { recursive: true }); mkdirSync(workspace);
    const file = join(source, 'usr/bin/bash.exe'); writeFileSync(file, 'synthetic source');
    manager = new RuntimeDirectory(cache, source, workspace);
    const controller = new AbortController();
    let elevated = false;
    fs.promises.link = async (...args) => {
      if (!elevated) throw Object.assign(new Error('Synthetic elevation required'), { code: 'EPERM' });
      return link(...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(manager.prepare(source, 'read-only', workspace, async (origin, staging) => {
      elevated = true;
      await linkRuntimeFiles(origin, staging);
      controller.abort(new Error('Cancelled after linking'));
    }, controller.signal), /Cancelled after linking/);
    assert(elevated);
    assert(!existsSync(join(cache, 'current.json')));
    assert.equal(statSync(file).nlink, 1);
    await manager.dispose(); await purgeRuntime(cache);
  } finally {
    fs.promises.link = link; syncBuiltinESMExports();
    try { await manager?.dispose(); } finally { scope.dispose(); }
  }
});
