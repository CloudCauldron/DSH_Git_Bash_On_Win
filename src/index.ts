import type { Context, Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox';
import type { Config as BashConfig } from '@deepseek-ai/dsh-bash-local';
import type { ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gitRoot, RuntimeDirectory, type RuntimeLease, type RuntimeView } from './private-runtime.ts';
import { elevateLinks } from './elevation.ts';

export interface Config extends BashConfig { gitBashPath: Volatile<string | undefined> }

/** Preserve DSH's executor mechanics and sandbox classification verbatim. */
export default class GitBashExecutor extends SandboxBashExecutor {
  static override Config: typeof SandboxBashExecutor.Config = z.object({
    ...SandboxBashExecutor.Config.dict,
    gitBashPath: z.string().volatile(),
  }) as unknown as typeof SandboxBashExecutor.Config;

  private runtime: RuntimeDirectory | undefined;
  private readonly executions = new Set<ShellExecution>();
  private readonly preparing = new Set<Promise<unknown>>();
  private readonly stopping = new AbortController();
  declare readonly config: Config;

  constructor(ctx: Context, config: Config) {
    super(ctx, config);
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This plugin runs only on native Windows x64.');
    ctx.effect(() => async () => {
      this.stopping.abort(new Error('The Git Bash provider is stopping.'));
      while (this.preparing.size) await Promise.allSettled([...this.preparing]);
      const executions = [...this.executions];
      for (const execution of executions) {
        try { execution.kill(); } catch (error) { this.ctx.logger.warn(error); }
      }
      await Promise.all(executions.map(execution => execution.done));
      while (this.preparing.size) await Promise.allSettled([...this.preparing]);
      await this.runtime?.dispose();
    });
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.preparing.add(operation);
    void operation.then(() => this.preparing.delete(operation), () => this.preparing.delete(operation));
    return operation;
  }

  protected override async executeArgv(spec: ShellExecSpec,
    argvOrPrepare: readonly string[] | ((signal: AbortSignal) => Promise<readonly string[]>),
    onStarted?: (execution: ShellExecution) => void): Promise<ShellExecution> {
    this.stopping.signal.throwIfAborted();
    spec = { ...spec, signal: spec.signal ? AbortSignal.any([spec.signal, this.stopping.signal]) : this.stopping.signal };
    let view: RuntimeView | undefined;
    let acquired: RuntimeLease | undefined;
    let started = false;
    const releaseView = () => { view?.release(); view = undefined; };
    const releaseRuntime = async () => {
      const held = acquired; acquired = undefined;
      try { releaseView(); } finally { await held?.release(); }
    };
    const operation = super.executeArgv(spec, signal => this.track((async () => {
      signal.throwIfAborted();
      const source = gitRoot(this.config.gitBashPath.get());
      const profile = this.ctx.get('profileContext') as { dir: string } | undefined;
      const policy = spec.sandboxPolicy!;
      // Keep native executable paths short even when pnpm's package path is deep.
      if (!this.runtime) {
        const base = profile?.dir ?? dirname(fileURLToPath(import.meta.url));
        const parent = profile ? join(base, '.git-bash-on-win') : join(base, '../.runtime');
        this.runtime = new RuntimeDirectory(parent, source, policy.workspaceRoot);
      }
      const runtime = acquired = await this.runtime.prepare(source, policy.mode, policy.workspaceRoot, (source, generation) => {
        signal.throwIfAborted();
        return elevateLinks(source, generation, signal);
      }, signal);
      try {
        signal.throwIfAborted();
        if (policy.mode !== 'danger-full-access') view = this.runtime.view(runtime,
          policy.sessionId === undefined ? undefined : JSON.stringify([policy.workspaceRoot, policy.sessionId]));
        const argv = typeof argvOrPrepare === 'function' ? await argvOrPrepare(signal) : argvOrPrepare;
        signal.throwIfAborted();
        const offset = argv.length - 3;
        if (offset < 0 || argv[offset] !== 'bash' || argv[offset + 1] !== '-c' || argv[offset + 2] !== spec.command) throw new Error('Unexpected DSH shell argv; the command did not run.');
        return [...argv.slice(0, offset), process.execPath, fileURLToPath(new URL('./launcher.js', import.meta.url)),
          runtime.root, runtime.source, policy.mode, Buffer.from(spec.command, 'utf8').toString('base64'), String(this.config.graceMs.get()), view?.installationRoot ?? runtime.root];
      } catch (error) { await releaseRuntime(); throw error; }
    })()), execution => {
      started = true;
      this.executions.add(execution);
      void execution.done.then(() => this.track((async () => {
        try { await releaseRuntime(); } catch (error) { this.ctx.logger.warn(error); }
        this.executions.delete(execution);
      })()));
      onStarted?.(execution);
    });
    return this.track(operation.finally(async () => { if (!started) await releaseRuntime(); }));
  }
}
