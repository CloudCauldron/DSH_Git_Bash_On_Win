import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { type LocalizedError } from './locale/errors.ts';
import type { Failure } from './locale/shared.ts';
import type { LinkProgress } from './runtime/runtime-cache.ts';
export interface RebuildNotice {
    confirmation?: {
        id: string;
        sourceChanged: boolean;
    };
    failure?: {
        id: string;
        reason: Failure;
    };
    success?: boolean;
    progress?: LinkProgress;
}
/** Lives with one executor. Only an owner with a mounted overlay can answer its current request. */
export declare class RebuildFeedback extends TypertRemoteService {
    private progress?;
    private nextPathUpdate;
    private readonly clients;
    private readonly failures;
    private pending?;
    constructor(ctx: Context);
    private frame;
    private publish;
    setProgress(progress?: LinkProgress): void;
    succeeded(): void;
    failed(error: unknown): void;
    confirm(sourceChanged: boolean, unavailable: LocalizedError, signal: AbortSignal): Promise<void>;
    /** The native Connection registry checks owner authentication for both methods. */
    handle(request: Request): Response;
    /** The Gateway runs this method on the calling peer's Cordis context. */
    watch(signal: AbortSignal): ReadableStream<RebuildNotice>;
    disconnect(): void;
}
