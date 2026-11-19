import { type IpcCompatibility } from './native-debug.ts';
export interface PrivateBashLaunch {
    readonly baseRoot: string;
    readonly installationRoot: string;
    readonly cwd: string;
    readonly command: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly compatibility: IpcCompatibility;
    readonly graceMs: number;
}
export interface PrivateFamilyExit {
    readonly exitCode: number;
    readonly repaired: number;
    readonly defaultDaclAdjusted: number;
    readonly mappingsAdjusted: number;
    readonly installationKey: string;
}
interface LoadedModule {
    name: string;
    base: bigint;
    end: bigint;
    msys?: {
        pathVerified: boolean;
        installationPathAdjusted?: boolean;
    };
}
interface ModuleState {
    hooks: Array<{
        module: string;
        symbol: string;
        address?: bigint;
    }>;
    modules: LoadedModule[];
}
/** Unload just this base and report whether private MSYS hooks still apply. */
export declare function unloadModule(state: ModuleState, base: bigint): boolean;
/** One child path admission; parent pins do not freeze junction targets. */
export declare function runPrivateBash(options: PrivateBashLaunch): Promise<PrivateFamilyExit>;
export {};
