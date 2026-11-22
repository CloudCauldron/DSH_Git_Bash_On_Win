import { type Directory, type FileIdentity } from './ntfs-filesystem.ts';
export type GitLayout = 'ucrt64' | 'mingw64';
export interface GitInstallation {
    readonly root: string;
    readonly layout: GitLayout;
}
export interface FileStamp extends FileIdentity {
    readonly size: string;
    readonly lastWriteTime: string;
}
export interface SourceFreshness {
    readonly git: FileStamp;
    readonly msys: FileStamp;
    readonly packageVersionsSha256: string | null;
}
/** Apply DSH's already assembled explicit map in its enumeration order. */
export declare function buildRuntimeEnvironment(installationRoot: string, sourceRoot: string, layout: GitLayout, explicit: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function discoverGitInstallation(setting?: string): GitInstallation;
/** MSYS budgets the normalized NT image path, including the terminating byte. */
export declare function requireViewPathBudget(view: string): void;
export declare const payloadLimit: number;
/** Called on an unpublished, exclusively created generation after discovery. Its owner handles whole-generation rollback. */
export declare function buildCopyLayout(generation: Directory, installation: GitInstallation, shim: Buffer, signal: AbortSignal): Promise<{
    runtime: Directory;
    views: Directory;
    patchedMsysSha256: string;
}>;
export declare function admitCopyJunctions(runtime: Directory, source: Directory, layout: GitLayout): void;
export declare function readSourceFreshness(source: Directory, layout: GitLayout): SourceFreshness;
