import type { Context, Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox';
import type { Config as BashConfig } from '@deepseek-ai/dsh-bash-local';
import type { ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell';
import type Subprocess from '@deepseek-ai/dsh-subprocess';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasRuntimeCleanupFailure, prepareRuntime, type GenerationPin, type RuntimeUse } from './runtime/runtime-cache.ts';

export interface Config extends BashConfig { gitBashPath: Volatile<string | undefined> }

interface PreparationSlot {
  readonly selection: string | undefined;
  readonly controller: AbortController;
  readonly ready: Promise<GenerationPin>;
  pin?: GenerationPin;
}

/** Cancel a caller's wait without cancelling the shared preparation. */
async function waitForReady(slot: PreparationSlot, signal: AbortSignal): Promise<GenerationPin> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); });
  signal.addEventListener('abort', abort, { once: true });
  try { return await Promise.race([slot.ready, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** Native settings, command mechanics and one lazily owned runtime selection. */
export default class GitBashExecutor extends SandboxBashExecutor {
  static override Config: typeof SandboxBashExecutor.Config = z.object({
    ...SandboxBashExecutor.Config.dict,
    gitBashPath: z.string().volatile(),
  }) as unknown as typeof SandboxBashExecutor.Config;

  declare readonly config: Config;
  private readonly setupSpawn: Subprocess['spawn'];
  private slot?: PreparationSlot;
  private rebuildOp?: PreparationSlot;
  private readonly stopping = new AbortController();
  private readonly executions = new Set<ShellExecution>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly cleanup = new Set<Promise<unknown>>();
  private readonly cleanupErrors: unknown[] = [];

  constructor(ctx: Context, config: Config) {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This plugin runs only on native Windows x64.');
    super(ctx, config);
    this.setupSpawn = ctx.subprocess.spawn.bind(ctx.subprocess);
    ctx.effect(() => () => this.disposeRuntime());
  }

  // Phase 5 removes this gate only after the launcher joins its private family
  // before exit. Phase 4 exercises the inherited execution seam in isolation.
  override async execute(_spec: ShellExecSpec): Promise<ShellExecution> {
    void _spec;
    throw new Error('Git Bash execution is unavailable until launcher/debugger integration is complete.');
  }

  private track<T>(operation: Promise<T>, owned = this.work): Promise<T> {
    owned.add(operation);
    void operation.then(() => owned.delete(operation), () => owned.delete(operation));
    return operation;
  }

  private ownCleanup(operation: Promise<void>): Promise<void> {
    return this.track(operation.catch(error => {
      this.cleanupErrors.push(error);
      throw error;
    }), this.cleanup);
  }

  private retire(slot: PreparationSlot): Promise<void> {
    slot.controller.abort(new Error('Git Bash runtime preparation was superseded.'));
    if (slot.pin) return this.ownCleanup(slot.pin.release());
    return this.track(slot.ready.then(() => {}, error => {
      // Preparation records resource failures at their boundary, independently
      // of retirement timing. Ordinary setup errors have already drained safely.
      if (hasRuntimeCleanupFailure(error)) throw error;
    }), this.cleanup);
  }

  /** Observation, not Loader events or string equality alone, detaches old work. */
  private observeSelection(): string | undefined {
    const selection = this.config.gitBashPath.get();
    const obsolete = new Set<PreparationSlot>();
    if (this.slot && this.slot.selection !== selection) { obsolete.add(this.slot); this.slot = undefined; }
    if (this.rebuildOp && this.rebuildOp.selection !== selection) { obsolete.add(this.rebuildOp); this.rebuildOp = undefined; }
    for (const slot of obsolete) void this.retire(slot);
    return selection;
  }

  private createSlot(selection: string | undefined, rebuild: boolean): PreparationSlot {
    const profile = this.ctx.get('profileContext') as { dir: string } | undefined;
    const cacheDirectory = profile ? join(profile.dir, '.git-bash-on-win') : fileURLToPath(new URL('../.runtime', import.meta.url));
    const controller = new AbortController();
    const retired = [...this.cleanup];
    // Install the object in slot/rebuildOp before preparation can yield or finish.
    const slot: PreparationSlot = {
      selection, controller,
      ready: this.track(Promise.resolve().then(async () => {
        await Promise.all(retired);
        if (this.cleanupErrors.length) throw new AggregateError(this.cleanupErrors, 'Previous runtime cleanup failed.');
        this.observeSelection();
        controller.signal.throwIfAborted();
        this.stopping.signal.throwIfAborted();
        const pin = await prepareRuntime({ cacheDirectory, gitBashPath: selection, rebuild, spawn: this.setupSpawn }, controller.signal).catch(error => {
          if (hasRuntimeCleanupFailure(error)) this.cleanupErrors.push(error);
          throw error;
        });
        try {
          this.observeSelection();
          controller.signal.throwIfAborted();
          this.stopping.signal.throwIfAborted();
          if (slot !== (rebuild ? this.rebuildOp : this.slot)) throw new Error('Stale Git Bash runtime preparation.');
          slot.pin = pin;
          return pin;
        } catch (error) { await this.ownCleanup(pin.release()); throw error; }
      })),
    };
    return slot;
  }

  private current(slot: PreparationSlot, signal: AbortSignal): boolean {
    this.observeSelection();
    signal.throwIfAborted();
    this.stopping.signal.throwIfAborted();
    return this.slot === slot && !slot.controller.signal.aborted;
  }

  private async acquireUse(spec: ShellExecSpec, signal: AbortSignal): Promise<{ slot: PreparationSlot; use: RuntimeUse }> {
    if (!spec.sandboxPolicy) throw new Error('Git Bash requires a resolved DSH execution policy.');
    for (;;) {
      signal.throwIfAborted();
      this.stopping.signal.throwIfAborted();
      const selection = this.observeSelection();
      const slot = this.slot ??= this.createSlot(selection, false);
      let use: RuntimeUse | undefined;
      let transferred = false;
      try {
        const pin = await waitForReady(slot, signal);
        if (!this.current(slot, signal)) continue;
        use = await pin.lease(spec.sandboxPolicy, signal).catch(error => {
          // Lease may unwind its last reference before returning a RuntimeUse.
          if (hasRuntimeCleanupFailure(error)) this.cleanupErrors.push(error);
          throw error;
        });
        if (this.current(slot, signal)) { transferred = true; return { slot, use }; }
      } catch (error) {
        // Recorded at acquisition, never discarded by stale/cancelled waiters.
        if (hasRuntimeCleanupFailure(error)) throw error;
        if (this.current(slot, signal)) throw error;
      } finally {
        // Transfer only a current, uncancelled use to the command.
        if (use && !transferred) await this.ownCleanup(use.release());
      }
    }
  }

  protected override executeArgv(spec: ShellExecSpec,
    argvOrPrepare: readonly string[] | ((signal: AbortSignal) => Promise<readonly string[]>),
    onStarted?: (execution: ShellExecution) => void): Promise<ShellExecution> {
    this.stopping.signal.throwIfAborted();
    this.observeSelection();
    spec = { ...spec, signal: spec.signal ? AbortSignal.any([spec.signal, this.stopping.signal]) : this.stopping.signal };
    let use: RuntimeUse | undefined;
    let preparation: Promise<readonly string[]> | undefined;
    let started = false;
    const release = () => {
      const held = use; use = undefined;
      return held ? this.ownCleanup(held.release()) : Promise.resolve();
    };
    const operation = super.executeArgv(spec, signal => {
      preparation = this.track((async () => {
        const acquired = await this.acquireUse(spec, signal);
        use = acquired.use;
        try {
          // Lease admission precedes the native deferred confinement callback.
          if (!this.current(acquired.slot, signal)) throw new Error('Git Bash selection changed before confinement.');
          const argv = typeof argvOrPrepare === 'function' ? await argvOrPrepare(signal) : argvOrPrepare;
          if (!this.current(acquired.slot, signal)) throw new Error('Git Bash selection changed during command preparation.');
          const offset = argv.length - 3;
          if (offset < 0 || argv[offset] !== 'bash' || argv[offset + 1] !== '-c' || argv[offset + 2] !== spec.command) throw new Error('Unexpected DSH shell argv; the command did not run.');
          return [...argv.slice(0, offset), process.execPath, fileURLToPath(new URL('./bash-launcher.js', import.meta.url)),
            use.baseRoot, use.installationRoot, use.sourceRoot, use.layout, spec.sandboxPolicy!.mode,
            Buffer.from(spec.command, 'utf8').toString('base64'), String(this.config.graceMs.get())];
        } catch (error) { await release(); throw error; }
      })());
      return preparation;
    }, execution => {
      started = true;
      this.executions.add(execution);
      void this.track(execution.done.then(async () => {
        try { await release(); } finally { this.executions.delete(execution); }
      }));
      onStarted?.(execution);
    });
    return this.track(operation.finally(async () => {
      if (!started) {
        // DSH can stop waiting on its callback at the command deadline. Join our
        // short lease/confinement operation before releasing its local reference.
        await preparation?.catch(() => {});
        await release();
      }
    }));
  }

  async rebuildRuntime(): Promise<void> {
    this.stopping.signal.throwIfAborted();
    const selection = this.observeSelection();
    if (this.rebuildOp) throw new Error('Git Bash runtime rebuilding is busy.');
    if (this.slot && !this.slot.pin) {
      const previous = this.slot; this.slot = undefined;
      void this.retire(previous);
    }
    const op = this.rebuildOp = this.createSlot(selection, true);
    this.slot ??= op;
    try {
      await op.ready;
      this.observeSelection();
      this.stopping.signal.throwIfAborted();
      op.controller.signal.throwIfAborted();
      if (this.rebuildOp !== op) throw new Error('Stale Git Bash runtime rebuild.');
      const previous = this.slot;
      this.slot = op;
      if (previous && previous !== op) await this.retire(previous);
    } finally {
      if (this.rebuildOp === op) this.rebuildOp = undefined;
    }
  }

  private async disposeRuntime(): Promise<void> {
    this.stopping.abort(new Error('The Git Bash provider is stopping.'));
    // Signal executions before waiting for any setup, regardless of selection.
    for (const execution of this.executions) {
      try { execution.kill(); } catch (error) { this.cleanupErrors.push(error); }
    }
    const slots = new Set([this.slot, this.rebuildOp]);
    this.slot = this.rebuildOp = undefined;
    for (const slot of slots) if (slot) void this.retire(slot);
    while (this.work.size || this.cleanup.size) await Promise.allSettled([...this.work, ...this.cleanup]);
    if (this.cleanupErrors.length) throw new AggregateError(this.cleanupErrors, 'Git Bash provider failed to release owned resources.');
  }
}
