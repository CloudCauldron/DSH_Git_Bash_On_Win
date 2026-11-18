import { createRequire } from 'node:module';

export interface LocalizedMessage {
  key: `error.${string}`;
  params?: Record<string, string>;
  diagnostic?: string;
}

type Key = LocalizedMessage['key'];
type Params = LocalizedMessage['params'];
const require = createRequire(import.meta.url);

/** Standalone tools use English. A missing or damaged catalog must not mask the original failure. */
function english(key: Key, params?: Params): string {
  try {
    const { messages } = require('../locale/en.json') as { messages: Record<string, string> };
    return (messages[key] ?? key).replace(/\{(\w+)\}/g, (token, name: string) => params?.[name] ?? token);
  } catch { return key; }
}

export class LocalizedError extends Error {
  readonly localized: LocalizedMessage;

  constructor(key: Key, params?: Params, options?: ErrorOptions & { fallback?: string; diagnostic?: string }) {
    super(options?.fallback ?? english(key, params), options);
    this.localized = params ? { key, params } : { key };
    if (options?.diagnostic !== undefined) this.localized.diagnostic = options.diagnostic;
  }
}

export class LocalizedAggregateError extends AggregateError {
  readonly localized: LocalizedMessage;

  constructor(errors: Iterable<unknown>, key: Key, params?: Params, options?: ErrorOptions) {
    super(errors, english(key, params), options);
    this.localized = params ? { key, params } : { key };
  }
}
