import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type Subprocess from '@deepseek-ai/dsh-subprocess';
import { type GitLayout } from './git-installation.ts';
export type LinkProgress = 'preparing' | 'elevation' | 'checking' | {
    path: string;
    completed?: never;
} | {
    path: string;
    completed: number;
    total: number;
};
export interface RuntimePreparation {
    readonly cacheDirectory: string;
    readonly spawn: Subprocess['spawn'];
    readonly gitBashPath?: string;
    readonly rebuild?: boolean;
    readonly onProgress?: (progress: LinkProgress) => void;
    readonly elevation: 'manual' | ((sourceRoot: string, sourceChanged: boolean) => Promise<void>);
}
export interface GenerationPin {
    readonly freshlyBuilt: boolean;
    lease(scope: Pick<SandboxExecutionPolicy, 'mode' | 'workspaceRoot' | 'sessionId'>, signal: AbortSignal): Promise<RuntimeUse>;
    release(): Promise<void>;
}
export interface RuntimeUse {
    readonly baseRoot: string;
    readonly installationRoot: string;
    readonly sourceRoot: string;
    readonly layout: GitLayout;
    release(): Promise<void>;
}
/** Preserve local resource failures without treating source/setup errors as leaks. */
export declare function hasRuntimeCleanupFailure(error: unknown): boolean;
export declare const sharedCacheDirectory: (home: string) => string;
export declare function prepareRuntime(request: RuntimePreparation, signal: AbortSignal): Promise<GenerationPin>;
/** Offline only. Preflight every generation before unpublication or payload deletion. */
export declare function purgeRuntimeCache(cacheDirectory: string): Promise<void>;
