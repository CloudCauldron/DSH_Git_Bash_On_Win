import AgentPreset, { type Config } from '@deepseek-ai/dsh-agent-preset';
import type { Context } from '@deepseek-ai/cordis';
/** Keep the native preset definition, adapting only its Windows shell tool. */
export default class GitBashPreset extends AgentPreset {
    constructor(ctx: Context, config: Config);
}
