import type { Context, Volatile } from '@deepseek-ai/cordis';
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox';
import type { Config as BashConfig } from '@deepseek-ai/dsh-bash-local';
import type { ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell';
export interface Config extends BashConfig {
    gitBashPath: Volatile<string | undefined>;
}
export default class GitBashExecutor extends SandboxBashExecutor {
    static Config: typeof SandboxBashExecutor.Config;
    readonly config: Config;
    private readonly cache;
    private ready?;
    private attempt?;
    private readonly stopping;
    private readonly commands;
    private readonly work;
    private readonly cleanup;
    private readonly cleanupErrors;
    constructor(ctx: Context, config: Config);
    private track;
    private ownCleanup;
    /** Record native close failures at the operation that incurred them, before notifying shared waiters. */
    private rethrowPreparationError;
    private retireAttempt;
    private observeSelection;
    private prepare;
    rebuildRuntime(): Promise<void>;
    execute(spec: ShellExecSpec): Promise<ShellExecution>;
    protected executeArgv(spec: ShellExecSpec, argvOrPrepare: readonly string[] | ((signal: AbortSignal) => Promise<readonly string[]>), onStarted?: (execution: ShellExecution) => void): Promise<ShellExecution>;
    private disposeRuntime;
}
