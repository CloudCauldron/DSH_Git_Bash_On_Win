import type { Context, Volatile } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox';
import type { Config as BashConfig } from '@deepseek-ai/dsh-bash-local';
import type { ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell';
import type Subprocess from '@deepseek-ai/dsh-subprocess';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasRuntimeCleanupFailure, prepareRuntime, type GenerationPin, type RuntimeUse } from './runtime/runtime-cache.ts';
import { commandReceiver } from './adapter.ts';
import { LocalizedAggregateError, LocalizedError } from './localized-error.ts';
import { describeFailure, RebuildFeedback } from './rebuild-feedback.ts';

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
  private readonly cacheDirectory: string;
  private readonly installAnchor?: string;
  private readonly feedback = new RebuildFeedback();
  private readonly setupSpawn: Subprocess['spawn'];
  private slot?: PreparationSlot;
  private rebuildOp?: PreparationSlot;
  private readonly stopping = new AbortController();
  private readonly executions = new Map<ShellExecution, () => Promise<void>>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly cleanup = new Set<Promise<unknown>>();
  private readonly cleanupErrors: unknown[] = [];

  constructor(ctx: Context, config: Config) {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new LocalizedError('error.pluginPlatform');
    const profile = ctx.get('profileContext') as { dir: string; installAnchor?: string } | undefined;
    if (!profile) throw new LocalizedError('error.profileRequired');
    const cacheDirectory = join(profile.dir, '.git-bash-on-win');
    super(ctx, config);
    this.cacheDirectory = cacheDirectory;
    this.installAnchor = profile.installAnchor;
    this.setupSpawn = ctx.subprocess.spawn.bind(ctx.subprocess);
    ctx.on('loader/volatile-update', () => {
      if (this.rebuildOp || (this.slot && !this.slot.pin)) this.observeSelection();
    });
    ctx.effect(() => () => this.disposeRuntime());
    ctx.inject(['connection'], scope => {
      scope.effect(() => () => this.feedback.disconnect());
      scope.connection.fetch.register({
        path: '/api/git-bash-on-win/feedback', methods: ['GET', 'POST'], requestBody: 'buffered',
        fetch: async request => {
          if (request.method === 'POST') this.observeSelection();
          return this.feedback.handle(request);
        },
      });
      scope.connection.fetch.register({
        path: '/api/git-bash-on-win/rebuild', methods: ['POST'], requestBody: 'buffered',
        fetch: async () => {
          try {
            await this.rebuildRuntime();
            return new Response(null, { status: 204 });
          } catch (error) {
            return Response.json(describeFailure(error), { status: 500 });
          }
        },
      });
    });
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
    slot.controller.abort(new LocalizedError('error.preparationSuperseded', undefined, { fallback: 'Git Bash runtime preparation was superseded.' }));
    if (slot.pin) return this.ownCleanup(slot.pin.release());
    return this.track(slot.ready.then(() => {}, error => {
      // Preparation records resource failures at their boundary, independently
      // of retirement timing. Ordinary setup errors have already drained safely.
      if (hasRuntimeCleanupFailure(error)) throw error;
    }), this.cleanup);
  }

  /** Detach obsolete work before it can request consent, launch a broker, or serve a command. */
  private observeSelection(): string | undefined {
    const selection = this.config.gitBashPath.get();
    const obsolete = new Set<PreparationSlot>();
    if (this.slot && this.slot.selection !== selection) { obsolete.add(this.slot); this.slot = undefined; }
    if (this.rebuildOp && this.rebuildOp.selection !== selection) { obsolete.add(this.rebuildOp); this.rebuildOp = undefined; }
    for (const slot of obsolete) void this.retire(slot);
    return selection;
  }

  private createSlot(selection: string | undefined, rebuild: boolean): PreparationSlot {
    const controller = new AbortController();
    const retired = [...this.cleanup];
    // Install the object in slot/rebuildOp before preparation can yield or finish.
    const slot: PreparationSlot = {
      selection, controller,
      ready: this.track(Promise.resolve().then(async () => {
        await Promise.all(retired);
        if (this.cleanupErrors.length) throw new LocalizedAggregateError(this.cleanupErrors, 'error.priorCleanupFailed');
        this.observeSelection();
        controller.signal.throwIfAborted();
        this.stopping.signal.throwIfAborted();
        const pin = await prepareRuntime({ cacheDirectory: this.cacheDirectory, gitBashPath: selection, rebuild, spawn: this.setupSpawn,
          elevation: rebuild ? 'manual' : (source, changed) => this.confirmElevation(source, changed, controller.signal),
        }, controller.signal).catch(error => {
          if (hasRuntimeCleanupFailure(error)) this.cleanupErrors.push(error);
          throw error;
        });
        try {
          this.observeSelection();
          controller.signal.throwIfAborted();
          this.stopping.signal.throwIfAborted();
          if (slot !== (rebuild ? this.rebuildOp : this.slot)) throw new LocalizedError('error.stalePreparation');
          slot.pin = pin;
          if (!rebuild && pin.freshlyBuilt) this.feedback.succeeded();
          return pin;
        } catch (error) { await this.ownCleanup(pin.release()); throw error; }
      }).catch(error => {
        if (!rebuild && error !== controller.signal.reason) this.feedback.failed(error);
        throw error;
      })),
    };
    return slot;
  }

  private confirmElevation(source: string, changed: boolean, signal: AbortSignal): Promise<void> {
    this.observeSelection();
    const args = [process.execPath, fileURLToPath(new URL('./link-runtime-cache.js', import.meta.url)), dirname(this.cacheDirectory), join(source, 'usr/bin/bash.exe')];
    if (this.installAnchor) args.push(this.installAnchor);
    // Print literal arguments for Windows Git Bash, including paths with quotes or shell metacharacters.
    const command = args.map(arg => "'" + arg.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'").join(' ');
    return this.feedback.confirm(changed, new LocalizedError('error.confirmationUnavailable', { command }), signal);
  }

  private current(slot: PreparationSlot, signal: AbortSignal): boolean {
    this.observeSelection();
    signal.throwIfAborted();
    this.stopping.signal.throwIfAborted();
    return this.slot === slot && !slot.controller.signal.aborted;
  }

  private async acquireUse(spec: ShellExecSpec, signal: AbortSignal): Promise<{ slot: PreparationSlot; use: RuntimeUse }> {
    if (!spec.sandboxPolicy) throw new LocalizedError('error.executionPolicyRequired');
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
    let rangeFailed = false;
    const release = () => {
      const held = use; use = undefined;
      return held ? this.ownCleanup(held.release()) : Promise.resolve();
    };
    const receiver = commandReceiver(this[Service.extend]() as this, this.ctx, error => {
      rangeFailed = true;
      this.cleanupErrors.push(error);
    });
    const operation = super.executeArgv.call(receiver, spec, signal => {
      preparation = this.track((async () => {
        const acquired = await this.acquireUse(spec, signal);
        use = acquired.use;
        try {
          // Lease admission precedes the native deferred confinement callback.
          if (!this.current(acquired.slot, signal)) throw new LocalizedError('error.changedBeforeConfinement');
          const argv = typeof argvOrPrepare === 'function' ? await argvOrPrepare(signal) : argvOrPrepare;
          if (!this.current(acquired.slot, signal)) throw new LocalizedError('error.changedDuringConfinement');
          const offset = argv.length - 3;
          if (offset < 0 || argv[offset] !== 'bash' || argv[offset + 1] !== '-c' || argv[offset + 2] !== spec.command) throw new LocalizedError('error.unexpectedShellArguments');
          return [...argv.slice(0, offset), process.execPath, fileURLToPath(new URL('./bash-launcher.js', import.meta.url)),
            use.baseRoot, use.installationRoot, use.sourceRoot, use.layout, spec.sandboxPolicy!.mode,
            Buffer.from(spec.command, 'utf8').toString('base64'), String(this.config.graceMs.get())];
        } catch (error) { await release(); throw error; }
      })());
      return preparation;
    }, execution => {
      started = true;
      this.executions.set(execution, release);
      void this.track(execution.done.then(async () => {
        // An unconfirmed range may still use the runtime. Keep its existing
        // owned reference, and report failed disposal; process exit closes it.
        if (rangeFailed) return;
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
    if (this.rebuildOp) throw new LocalizedError('error.rebuildBusy', undefined, { fallback: 'Git Bash runtime rebuilding is busy.' });
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
      if (this.rebuildOp !== op) throw new LocalizedError('error.staleRebuild');
      const previous = this.slot;
      this.slot = op;
      if (previous && previous !== op) await this.retire(previous);
    } finally {
      if (this.rebuildOp === op) this.rebuildOp = undefined;
    }
  }

  private async disposeRuntime(): Promise<void> {
    this.stopping.abort(new LocalizedError('error.providerStopping', undefined, { fallback: 'The Git Bash provider is stopping.' }));
    // Signal executions before waiting for any setup, regardless of selection.
    for (const execution of this.executions.keys()) {
      try { execution.kill(); } catch (error) { this.cleanupErrors.push(error); }
    }
    const slots = new Set([this.slot, this.rebuildOp]);
    this.slot = this.rebuildOp = undefined;
    for (const slot of slots) if (slot) void this.retire(slot);
    while (this.work.size || this.cleanup.size) await Promise.allSettled([...this.work, ...this.cleanup]);
    if (this.cleanupErrors.length) throw new LocalizedAggregateError(this.cleanupErrors, 'error.providerCleanupFailed');
  }
}
