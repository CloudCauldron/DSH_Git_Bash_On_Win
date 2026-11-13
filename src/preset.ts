import AgentPreset, { type Config } from '@deepseek-ai/dsh-agent-preset';
import type { Context } from '@deepseek-ai/cordis';

/** Keep the native preset definition, adapting only its Windows shell tool. */
export default class GitBashPreset extends AgentPreset {
  constructor(ctx: Context, config: Config) {
    super(ctx, process.platform === 'win32' && ['standard', 'ptc', 'cordis'].includes(config.id) ? {
      ...config,
      plugins: config.plugins.filter(entry => entry.id !== 'tool-bash' || entry.name !== '@deepseek-ai/dsh-tool-bash').map(entry =>
        entry.id === 'tool-pwsh' && entry.name === '@deepseek-ai/dsh-tool-pwsh'
          ? { ...entry, name: '@deepseek-ai/dsh-tool-bash' } : entry),
    } : config);
  }
}
