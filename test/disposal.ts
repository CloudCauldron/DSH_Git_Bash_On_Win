import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { ShellExecution } from '@deepseek-ai/dsh-shell';
import GitBashExecutor, { type Config } from '../lib/index.js';
import { createContext, loadRuntime } from '../poc/runtime.ts';
import { createTestScope } from '../poc/scope.ts';

test('a throwing kill does not skip other executions or dispose runtime before all joins', { timeout: 5_000 }, async () => {
  const installed = await loadRuntime();
  const scope = createTestScope('dsh-gitbash-disposal-');
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  };
  const first = deferred(), second = deferred(), attempted = deferred();
  const calls: string[] = [];
  let ctx: Context | undefined, disposing: Promise<void> | undefined;
  let removed = false;
  try {
    const workspace = join(scope.root, 'workspace');
    mkdirSync(workspace);
    ctx = await createContext(installed) as unknown as Context;
    const { default: Projections } = await installed.load(installed.baseRequire, '@deepseek-ai/dsh-session-projection');
    await ctx.plugin(Projections);
    const { default: Policy } = await installed.load(installed.baseRequire, '@deepseek-ai/dsh-sandbox-policy');
    await ctx.plugin(Policy, { mode: 'read-only', workspaceRoot: workspace });
    let executor: GitBashExecutor | undefined;
    class CaptureExecutor extends GitBashExecutor {
      constructor(context: Context, config: Config) { super(context, config); executor = this; }
    }
    const provider = ctx.plugin(CaptureExecutor, {});
    await provider;
    assert(executor, 'provider activated');
    // Inject only owned lifecycle handles: no processes, hardlinks, or elevation.
    const state = executor as unknown as {
      executions: Set<ShellExecution>;
      runtime: { dispose(): Promise<void> };
    };
    const execution = (kill: ShellExecution['kill'], done: Promise<void>) => ({ kill, done }) as ShellExecution;
    state.executions.add(execution(() => { calls.push('first'); throw new Error('Expected synthetic kill failure'); }, first.promise));
    state.executions.add(execution(() => { calls.push('second'); attempted.resolve(); return true; }, second.promise));
    state.runtime = { dispose: async () => { removed = true; } };
    disposing = provider.dispose();
    await Promise.race([attempted.promise, disposing]);
    assert.deepEqual(calls, ['first', 'second']);
    assert.equal(removed, false);
    second.resolve();
    await setImmediate();
    assert.equal(removed, false, 'the execution whose kill threw must also join');
    first.resolve();
    await disposing;
    assert.equal(removed, true);
  } finally {
    first.resolve(); second.resolve();
    try { await disposing; }
    finally {
      try { await ctx?.fiber.dispose(); }
      finally {
        const cleanup = scope.dispose();
        assert(cleanup.temporaryRootRemoved && cleanup.environmentRestored && cleanup.addedAmbientLocks.length === 0);
      }
    }
  }
});
