export interface LocalizedMessage {
    key: `error.${string}`;
    params?: Record<string, string>;
    diagnostic?: string;
}
type Key = LocalizedMessage['key'];
type Params = LocalizedMessage['params'];
export declare class LocalizedError extends Error {
    readonly localized: LocalizedMessage;
    constructor(key: Key, params?: Params, options?: ErrorOptions & {
        fallback?: string;
        diagnostic?: string;
    });
}
export declare class LocalizedAggregateError extends AggregateError {
    readonly localized: LocalizedMessage;
    constructor(errors: Iterable<unknown>, key: Key, params?: Params, options?: ErrorOptions);
}
export {};
