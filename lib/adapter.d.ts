import type { Context } from '@deepseek-ai/cordis';
/** The pinned native Shell waits for target done, not managed-range settlement.
 * Shadow only this invocation's lookup; the provider still owns all processes. */
export declare function commandReceiver<T extends object>(receiver: T, ctx: Context, onRangeFailure: (error: unknown) => void): T;
export declare const inject: {
    loader: {
        await: boolean;
    };
};
/** Mount replacement providers in native entries, preserving their settings identity. */
export declare function apply(ctx: Context): Promise<void>;
