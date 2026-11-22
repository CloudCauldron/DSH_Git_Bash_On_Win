import type { Context } from '@deepseek-ai/cordis';
export declare const inject: {
    loader: {
        await: boolean;
    };
};
/** Mount replacement providers in native entries, preserving their settings identity. */
export declare function apply(ctx: Context): Promise<void>;
