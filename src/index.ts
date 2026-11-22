import type { Context, Volatile } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox';
import type { Config as BashConfig } from '@deepseek-ai/dsh-bash-local';
import type { ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import { tempWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl';
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import { basename, dirname, join } from 'node:path';
import { prepareRuntime, sharedCacheDirectory, type GenerationPin, type RuntimeUse } from './runtime/runtime-cache.ts';
import { admitDirectory, canonicalWorkspace, hasCloseFailure, overlaps } from './runtime/ntfs-filesystem.ts';
import { buildRuntimeEnvironment, discoverGitInstallation } from './runtime/git-installation.ts';
import { describeFailure, LocalizedAggregateError, LocalizedError } from './locale/errors.ts';

export interface Config extends BashConfig { gitBashPath: Volatile<string | undefined> }
interface Attempt {
  selection?: string;
  rebuild: boolean;
  pending: boolean;
  controller: AbortController;
  ready: Promise<void>;
}
interface Command { stop?(): void; release(): Promise<void> }

/** Cancel a caller's wait without cancelling the shared preparation. */
async function waitForReady(attempt: Attempt, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); });
  signal.addEventListener('abort', abort, { once: true });
  try { return await Promise.race([attempt.ready, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

function viewPrefix(prefix: readonly string[], mode: SandboxExecutionPolicy['mode'], workspace: string, session?: string): string {
  const invalid = () => new LocalizedError('error.unexpectedShellArguments');
  if (mode === 'danger-full-access') {
    if (prefix.length) throw invalid();
    return 'fa';
  }
  const start = prefix.indexOf('--workspace'), args = prefix.slice(start);
  if (start < 1 || args[1] !== workspace || args[2] !== '--temp' || !args[3] || args[4] !== '--mode'
    || args[5] !== mode || (mode !== 'workspace-write' && mode !== 'read-only') || args.at(-1) !== '--') throw invalid();
  if (mode === 'read-only' || session === undefined) {
    if (args.length !== 7) throw invalid();
    return mode === 'read-only' ? 'ro' : 'ww-u';
  }
  const sid = tempWriteSid(args[3]);
  if (args.length !== 11 || args[6] !== '--write-sid' || !args[7]
    || args[8] !== '--temp-write-sid' || args[9] !== sid) throw invalid();
  return 'ww-' + sid.split('-').slice(3, 5).join('-');
}

/** Only this command's spawn sees the finalized environment and the range-settled done promise. */
function commandReceiver<T extends object>(receiver: T, ctx: Context, spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle): T {
  Object.defineProperty(receiver, 'ctx', { value: ctx.extend({ subprocess: { spawn } }) });
  return receiver;
}

export default class GitBashExecutor extends SandboxBashExecutor {
  static override Config: typeof SandboxBashExecutor.Config = z.object({
    ...SandboxBashExecutor.Config.dict,
    gitBashPath: z.string().volatile(),
  }) as unknown as typeof SandboxBashExecutor.Config;

  declare readonly config: Config;
  private readonly cache: string;
  private ready?: { selection?: string; pin: GenerationPin };
  private attempt?: Attempt;
  private readonly stopping = new AbortController();
  private readonly commands = new Set<Command>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly cleanup = new Set<Promise<unknown>>();
  private readonly cleanupErrors: unknown[] = [];

  constructor(ctx: Context, config: Config) {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new LocalizedError('error.pluginPlatform');
    const profile = ctx.get('profileContext') as { home: string } | undefined;
    if (!profile) throw new LocalizedError('error.profileRequired');
    super(ctx, config);
    this.cache = sharedCacheDirectory(profile.home);
    ctx.on('loader/volatile-update', () => { if (this.attempt?.pending) this.observeSelection(); });
    ctx.effect(() => () => this.disposeRuntime());
    ctx.inject(['connection'], scope => {
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

  /** Record native close failures at the operation that incurred them, before notifying shared waiters. */
  private rethrowPreparationError = (error: unknown): never => {
    if (hasCloseFailure(error)) this.cleanupErrors.push(error);
    throw error;
  };

  private retireAttempt() {
    const attempt = this.attempt;
    this.attempt = undefined;
    if (attempt?.pending) {
      attempt.controller.abort(new LocalizedError('error.preparationSuperseded'));
      void this.track(attempt.ready.then(() => {}, () => {}), this.cleanup);
    }
  }

  private observeSelection() {
    const selection = this.config.gitBashPath.get();
    if (this.attempt && this.attempt.selection !== selection) this.retireAttempt();
    if (this.ready && this.ready.selection !== selection) {
      void this.ownCleanup(this.ready.pin.release());
      this.ready = undefined;
    }
    return selection;
  }

  private prepare(selection: string | undefined, rebuild: boolean): Attempt {
    const controller = new AbortController(), cleanup = [...this.cleanup];
    const attempt: Attempt = { selection, rebuild, controller, pending: true, ready: this.track((async () => {
      await Promise.allSettled(cleanup);
      if (this.cleanupErrors.length) throw new LocalizedAggregateError(this.cleanupErrors, 'error.priorCleanupFailed');
      this.observeSelection();
      controller.signal.throwIfAborted();
      const pin = await prepareRuntime({ cacheDirectory: this.cache, gitBashPath: selection, rebuild }, controller.signal).catch(this.rethrowPreparationError);
      this.observeSelection();
      if (controller.signal.aborted) { await this.ownCleanup(pin.release()); controller.signal.throwIfAborted(); }
      const previous = this.ready;
      this.ready = { selection, pin };
      if (previous) await this.ownCleanup(previous.pin.release());
    })().finally(() => { attempt.pending = false; })) };
    this.attempt = attempt;
    return attempt;
  }

  async rebuildRuntime(): Promise<void> {
    this.stopping.signal.throwIfAborted();
    const selection = this.observeSelection();
    if (this.attempt?.pending && this.attempt.rebuild) throw new LocalizedError('error.rebuildBusy');
    this.retireAttempt();
    const attempt = this.prepare(selection, true);
    await attempt.ready;
    this.observeSelection();
    this.stopping.signal.throwIfAborted();
    attempt.controller.signal.throwIfAborted();
    if (this.attempt !== attempt) throw new LocalizedError('error.preparationSuperseded');
  }

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    if (!spec.sandboxPolicy) throw new LocalizedError('error.executionPolicyRequired');
    // Stock confinement captures this object. Give each invocation its own policy.
    return super.execute({ ...spec, sandboxPolicy: { ...spec.sandboxPolicy } });
  }

  protected override executeArgv(spec: ShellExecSpec,
    argvOrPrepare: readonly string[] | ((signal: AbortSignal) => Promise<readonly string[]>),
    onStarted?: (execution: ShellExecution) => void): Promise<ShellExecution> {
    this.stopping.signal.throwIfAborted();
    const policy = spec.sandboxPolicy!;
    const { mode, workspaceRoot, sessionId } = policy;
    spec = { ...spec, signal: spec.signal ? AbortSignal.any([spec.signal, this.stopping.signal]) : this.stopping.signal };
    let use: RuntimeUse | undefined, pin: GenerationPin, view: string;
    let preparation: Promise<readonly string[]> | undefined, release: Promise<void> | undefined;
    const command: Command = { release: () => release ??= this.ownCleanup((async () => {
      await use?.release();
      use = undefined;
      this.commands.delete(command);
    })()) };
    this.commands.add(command);
    const receiver = commandReceiver(this[Service.extend]() as this, this.ctx, spawn => {
      this.observeSelection();
      if (this.ready?.pin !== pin) throw new LocalizedError('error.changedDuringConfinement');
      const env = buildRuntimeEnvironment(view, use!.sourceRoot, use!.layout, spawn.env ?? {});
      const child = this.ctx.subprocess.spawn({ ...spawn, env });
      let unconfirmed: LocalizedError | undefined;
      const settle = async () => {
        try {
          if (!await child.waitForExit()) throw unconfirmed ??= new LocalizedError('error.commandRangeUnconfirmed');
        } catch (error) {
          if (!this.cleanupErrors.includes(error)) this.cleanupErrors.push(error);
          throw error;
        }
        await command.release();
      };
      const done = this.track(child.done.finally(settle));
      command.stop = () => {
        if (release) return;
        try { child.terminate(); } catch (error) { this.cleanupErrors.push(error); }
        if (!this.work.has(done)) void this.track(settle());
      };
      return { ...child, done };
    });
    const prepare = async (signal: AbortSignal) => {
      let workspace: string | undefined;
      for (;;) {
        signal.throwIfAborted();
        const selection = this.observeSelection();
        if (this.ready) break;
        if (!this.attempt) {
          // A cold command must admit its workspace before starting a shared cache write.
          if (!workspace) { workspace = await canonicalWorkspace(workspaceRoot); continue; }
          try {
            const home = admitDirectory(dirname(this.cache));
            if (overlaps(workspace, join(home.path, basename(this.cache))) || overlaps(workspace, discoverGitInstallation(selection).root)) {
              throw new LocalizedError('error.workspaceOverlap');
            }
          } catch (error) { this.rethrowPreparationError(error); }
        }
        const attempt = this.attempt ?? this.prepare(selection, false);
        try { await waitForReady(attempt, signal); }
        catch (error) {
          this.observeSelection();
          if (this.attempt === attempt || hasCloseFailure(error)) throw error;
        }
      }
      pin = this.ready.pin;
      use = pin.acquireUse();
      workspace ??= await canonicalWorkspace(workspaceRoot);
      signal.throwIfAborted();
      this.observeSelection();
      if (this.ready?.pin !== pin) throw new LocalizedError('error.changedBeforeConfinement');
      if (overlaps(workspace, use.sourceRoot) || overlaps(workspace, use.cacheRoot)) throw new LocalizedError('error.workspaceOverlap');
      policy.workspaceRoot = workspace;
      const argv = typeof argvOrPrepare === 'function' ? await argvOrPrepare(signal) : argvOrPrepare;
      signal.throwIfAborted();
      this.observeSelection();
      if (this.ready?.pin !== pin) throw new LocalizedError('error.changedDuringConfinement');
      if (argv.at(-3) !== 'bash' || argv.at(-2) !== '-c' || argv.at(-1) !== spec.command) throw new LocalizedError('error.unexpectedShellArguments');
      const prefix = argv.slice(0, -3);
      try { view = use.bindView({ workspace, sessionId, prefix: viewPrefix(prefix, mode, workspace, sessionId) }); }
      catch (error) { this.rethrowPreparationError(error); }
      return [...prefix, join(view, 'usr/bin/bash.exe'), '--noprofile', '--norc', '-c', spec.command];
    };
    return this.track(super.executeArgv.call(receiver, spec, signal => preparation = this.track(prepare(signal)), onStarted)
      .finally(() => {
        if (command.stop) return;
        if (preparation && this.work.has(preparation)) {
          // DSH has already stopped waiting. Keep the use until our abandoned preparation settles.
          void this.track(preparation.then(command.release, command.release));
          return;
        }
        return command.release();
      }));
  }

  private async disposeRuntime(): Promise<void> {
    this.stopping.abort(new LocalizedError('error.providerStopping'));
    this.retireAttempt();
    if (this.ready) { void this.ownCleanup(this.ready.pin.release()); this.ready = undefined; }
    for (const command of this.commands) command.stop?.();
    while (this.work.size || this.cleanup.size) await Promise.allSettled([...this.work, ...this.cleanup]);
    if (this.cleanupErrors.length) throw new LocalizedAggregateError(this.cleanupErrors, 'error.providerCleanupFailed');
  }
}
