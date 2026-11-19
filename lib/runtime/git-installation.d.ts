import { type FileIdentity } from './ntfs-filesystem.ts';
export type GitLayout = 'ucrt64' | 'mingw64';
export interface GitInstallation {
    readonly root: string;
    readonly layout: GitLayout;
}
export interface FreshLinkTree {
    readonly sourceRoot: string;
    readonly baseRoot: string;
    readonly files: readonly string[];
}
export interface FileStamp extends FileIdentity {
    readonly size: string;
    readonly lastWriteTime: string;
}
export declare const anchorNames: readonly ['bash', 'sh', 'msys', 'git', 'profile', 'installOptions'];
export type AnchorName = typeof anchorNames[number];
export type AnchorStamps = Readonly<Record<AnchorName, FileStamp>>;
export declare function anchorPaths(layout: GitLayout): Readonly<Record<AnchorName, string>>;
/** Pure construction from a pin's recorded selection; the source may be gone. */
export declare function buildRuntimeEnvironment(installationRoot: string, sourceRoot: string, layout: GitLayout, ambient: NodeJS.ProcessEnv): Record<string, string>;
export declare function discoverGitInstallation(setting?: string): GitInstallation;
export declare function inventoryGitFiles(sourceRoot: string, checkActive: () => void): Promise<readonly string[]>;
export declare function linkFreshTree(tree: FreshLinkTree, checkActive: () => void, onLinked?: (file: {
    path: string;
    completed: number;
    total: number;
}) => void): Promise<void>;
export declare function readAnchors(root: string, layout: GitLayout): Promise<AnchorStamps>;
/** Capture base stamps with both handles open; only identities are compared here. */
export declare function captureAnchors(sourceRoot: string, baseRoot: string, layout: GitLayout): AnchorStamps;
export declare function sameAnchors(actual: AnchorStamps, saved: AnchorStamps): boolean;
