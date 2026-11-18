import { LocalizedError } from './localized-error.ts';
export declare function describeFailure(error: unknown): {
    error: string;
    localized: import("./localized-error.ts").LocalizedMessage | undefined;
};
export interface RebuildNotice {
    confirmation?: {
        id: string;
        sourceChanged: boolean;
    };
    failure?: {
        id: string;
        reason: ReturnType<typeof describeFailure>;
    };
    success?: boolean;
}
/** Lives with one executor. Only an owner with a mounted overlay can answer its current request. */
export declare class RebuildFeedback {
    private readonly clients;
    private readonly failures;
    private pending?;
    private frame;
    private publish;
    succeeded(): void;
    failed(error: unknown): void;
    confirm(sourceChanged: boolean, unavailable: LocalizedError, signal: AbortSignal): Promise<void>;
    /** The native Connection registry checks owner authentication for both methods. */
    handle(request: Request): Response;
    private subscribe;
    disconnect(): void;
}
