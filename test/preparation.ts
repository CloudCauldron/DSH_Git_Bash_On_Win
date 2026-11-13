import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import GitBashExecutor from '../lib/index.js';

for (const kind of ['cancel', 'deadline'] as const) {
  void test(`${kind} after prepared argv releases the lease and view without spawning`, async context => {
    const cancellation = new AbortController();
    const counts = { acquired: 0, viewReleased: 0, leaseReleased: 0, spawned: 0 };
    const executor = Object.create(GitBashExecutor.prototype);
    Object.assign(executor, {
      stopping: new AbortController(), preparing: new Set(), executions: new Set(), processFacts: new Map(),
      config: { gitBashPath: { get: () => 'C:/Program Files/Git/bin/bash.exe' }, graceMs: { get: () => 300 } },
      ctx: { get: () => undefined, subprocess: { spawn: () => { counts.spawned++; throw new Error('Unexpected spawn'); } } },
      runtime: {
        prepare: async () => {
          counts.acquired++;
          return { root: 'synthetic-runtime', source: 'synthetic-source', release: async () => { counts.leaseReleased++; } };
        },
        view: () => ({ installationRoot: 'synthetic-view', release: () => { counts.viewReleased++; } }),
      },
    });
    if (kind === 'deadline') context.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const operation = executor.executeArgv({
        command: 'true', workdir: process.cwd(), timeoutMs: 1000, onExpiry: kind === 'deadline' ? 'kill' : 'none',
        stdoutMaxBytes: 1000, signal: cancellation.signal, sandboxPolicy: { mode: 'read-only', workspaceRoot: process.cwd() },
      }, () => {
        queueMicrotask(() => queueMicrotask(() => {
          if (kind === 'deadline') context.mock.timers.tick(1000);
          else cancellation.abort(new Error('Synthetic cancellation after prepared argv'));
        }));
        return ['bash', '-c', 'true'];
      });
      if (kind === 'cancel') await assert.rejects(operation, /Synthetic cancellation/);
      else {
        const result = await (await operation).result();
        assert(result.timedOut && !result.aborted);
      }
    } finally { if (kind === 'deadline') context.mock.timers.reset(); }
    await setImmediate();
    assert.deepEqual(counts, { acquired: 1, viewReleased: 1, leaseReleased: 1, spawned: 0 });
  });
}
