import type Subprocess from '@deepseek-ai/dsh-subprocess';
import { type GitLayout } from '../runtime/git-installation.ts';
import { type Directory, type FileIdentity } from '../runtime/ntfs-filesystem.ts';
import { LocalizedAggregateError } from '../localized-error.ts';
export interface ProvisioningAttempt {
    readonly source: Directory;
    readonly cache: Directory;
    readonly generation: Directory;
    readonly base: Directory;
    readonly layout: GitLayout;
}
interface ElevationPlan {
    readonly schemaVersion: 1;
    readonly sourceRoot: string;
    readonly cacheRoot: string;
    readonly generationId: string;
    readonly baseRoot: string;
    readonly layout: GitLayout;
    readonly identities: Readonly<Record<'source' | 'cache' | 'generation' | 'base' | 'lease', FileIdentity>>;
}
export declare const planByteLimit: number;
export declare const planDigest: (value: unknown) => string;
export declare function decodeElevationPlan(value: unknown, digest: string): ElevationPlan;
/** Both entries take only the fixed control path, never an executable or file list. */
export declare function planGeneration(planPath: string): Directory;
/** Independently bind the input to existing objects before any privileged mutation. */
export declare function admitElevationPlan(plan: ElevationPlan, openedGeneration: Directory): ProvisioningAttempt;
/** Local broker shutdown failed; ordinary setup rejection does not imply this. */
export declare class ProvisioningCleanupError extends LocalizedAggregateError {
}
/** Keep the setup lease through the caller's synchronous final admission. */
export declare function provisionRuntime<T>(attempt: ProvisioningAttempt, signal: AbortSignal, spawn: Subprocess['spawn'], validate: () => T): Promise<T>;
export {};
