import type { Context, Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox';
import type { Config as BashConfig } from '@deepseek-ai/dsh-bash-local';
import type { ShellExecution } from '@deepseek-ai/dsh-shell';

export interface Config extends BashConfig { gitBashPath: Volatile<string | undefined> }

/** Native settings seam; preparation and execution are implemented in later phases. */
export default class GitBashExecutor extends SandboxBashExecutor {
  static override Config: typeof SandboxBashExecutor.Config = z.object({
    ...SandboxBashExecutor.Config.dict,
    gitBashPath: z.string().volatile(),
  }) as unknown as typeof SandboxBashExecutor.Config;

  declare readonly config: Config;

  constructor(ctx: Context, config: Config) {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This plugin runs only on native Windows x64.');
    super(ctx, config);
  }

  protected override async executeArgv(): Promise<ShellExecution> {
    throw new Error('Git Bash execution is unavailable until executor and launcher integration is complete.');
  }

  async rebuildRuntime(): Promise<void> {
    throw new Error('Git Bash runtime preparation is not implemented yet.');
  }
}
