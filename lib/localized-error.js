import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/** Standalone tools use English. A missing or damaged catalog must not mask the original failure. */
function english(key, params) {
    try {
        const { messages } = require('../locale/en.json');
        return (messages[key] ?? key).replace(/\{(\w+)\}/g, (token, name) => params?.[name] ?? token);
    }
    catch {
        return key;
    }
}
export class LocalizedError extends Error {
    localized;
    constructor(key, params, options) {
        super(options?.fallback ?? english(key, params), options);
        this.localized = params ? { key, params } : { key };
        if (options?.diagnostic !== undefined)
            this.localized.diagnostic = options.diagnostic;
    }
}
export class LocalizedAggregateError extends AggregateError {
    localized;
    constructor(errors, key, params, options) {
        super(errors, english(key, params), options);
        this.localized = params ? { key, params } : { key };
    }
}
