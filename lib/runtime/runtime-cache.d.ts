import { type GitLayout } from './git-installation.ts';
export interface RuntimePreparation {
    readonly cacheDirectory: string;
    readonly gitBashPath?: string;
    readonly rebuild?: boolean;
}
export interface GenerationPin {
    acquireUse(): RuntimeUse;
    release(): Promise<void>;
}
export interface RuntimeUse {
    readonly cacheRoot: string;
    readonly sourceRoot: string;
    readonly layout: GitLayout;
    bindView(scope: {
        prefix: string;
        workspace: string;
        sessionId?: string;
    }): string;
    release(): Promise<void>;
}
export declare const sharedCacheDirectory: (home: string) => string;
export declare const bundledShimUrl: URL;
export declare function prepareRuntime(request: RuntimePreparation, signal: AbortSignal): Promise<GenerationPin>;
/** Offline only. Preflight every generation before unpublication or payload deletion. */
export declare function purgeRuntimeCache(cacheDirectory: string): Promise<void>;
