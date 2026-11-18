import type { Context, Volatile } from '@deepseek-ai/cordis';
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox';
import type { Config as BashConfig } from '@deepseek-ai/dsh-bash-local';
import type { ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell';
export interface Config extends BashConfig {
    gitBashPath: Volatile<string | undefined>;
}
/** Native settings, command mechanics and one lazily owned runtime selection. */
export default class GitBashExecutor extends SandboxBashExecutor {
    static Config: typeof SandboxBashExecutor.Config;
    readonly config: Config;
    private readonly cacheDirectory;
    private readonly feedback;
    private readonly setupSpawn;
    private slot?;
    private rebuildOp?;
    private readonly stopping;
    private readonly executions;
    private readonly work;
    private readonly cleanup;
    private readonly cleanupErrors;
    constructor(ctx: Context, config: Config);
    private track;
    private ownCleanup;
    private retire;
    /** Detach obsolete work before it can request consent, launch a broker, or serve a command. */
    private observeSelection;
    private createSlot;
    private confirmElevation;
    private current;
    private acquireUse;
    protected executeArgv(spec: ShellExecSpec, argvOrPrepare: readonly string[] | ((signal: AbortSignal) => Promise<readonly string[]>), onStarted?: (execution: ShellExecution) => void): Promise<ShellExecution>;
    rebuildRuntime(): Promise<void>;
    private disposeRuntime;
}
