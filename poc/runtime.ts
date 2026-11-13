import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SUPPORTED_DSH = '0.2.2-rc.2';
export type Mode = 'read-only' | 'workspace-write' | 'unconfined-control';

interface OutputReader {
  readFrom(offset: number): { text: string; lossy: boolean };
}

export interface DshContext {
  plugin(plugin: unknown): PromiseLike<unknown>;
  fiber: { dispose(): Promise<void> };
  sandbox: {
    confine(argv: readonly string[], policy: { mode: Exclude<Mode, 'unconfined-control'>; workspaceRoot: string }, signal?: AbortSignal): Promise<{ argv: string[]; enforcement: string }>;
  };
  subprocess: {
    spawn(spec: {
      argv: readonly string[]; cwd: string; graceMs: number; signal: AbortSignal;
      stdio: { stdin: 'ignore'; stdout: { maxBytes: number }; stderr: { maxBytes: number } };
    }): {
      collected: { stdout: OutputReader; stderr: OutputReader };
      done: Promise<{ exitCode: number | null; signal: string | null }>;
      terminate(): void;
    };
  };
}

/** Find one installed CLI without installing or changing a profile. */
function findManifest(): string {
  if (process.env.DSH_POC_PACKAGE) return realpathSync(process.env.DSH_POC_PACKAGE);
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error('LOCALAPPDATA is unavailable; set DSH_POC_PACKAGE to the installed DSH package.json.');
  const root = join(local, 'pnpm/global/v11');
  const found = new Set<string>();
  for (const item of readdirSync(root)) {
    const candidate = join(root, item, 'node_modules/@deepseek-ai/dsh/package.json');
    if (existsSync(candidate)) found.add(realpathSync(candidate));
  }
  if (found.size !== 1) throw new Error(`Found ${found.size} DSH installations; select one with DSH_POC_PACKAGE.`);
  return [...found][0]!;
}

export async function loadRuntime(manifest?: string) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This PoC requires native Windows x64 Node.');
  manifest ??= findManifest();
  const metadata = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
  if (metadata.version !== SUPPORTED_DSH) throw new Error(`Review the PoC before using DSH ${metadata.version}; expected ${SUPPORTED_DSH}.`);
  const cliRequire = createRequire(manifest);
  const baseRequire = createRequire(cliRequire.resolve('@deepseek-ai/dsh-base'));
  const aclRequire = createRequire(baseRequire.resolve('@deepseek-ai/dsh-sandbox-windows-acl'));
  const load = (require: ReturnType<typeof createRequire>, name: string) => import(pathToFileURL(require.resolve(name)).href);
  return { manifest, version: metadata.version, cliRequire, baseRequire, aclRequire, load };
}

export type Runtime = Awaited<ReturnType<typeof loadRuntime>>;

export async function createContext(runtime: Runtime): Promise<DshContext> {
  const { Context } = await runtime.load(runtime.cliRequire, '@deepseek-ai/cordis');
  const { default: Subprocess } = await runtime.load(runtime.baseRequire, '@deepseek-ai/dsh-subprocess-local');
  const { default: Sandbox } = await runtime.load(runtime.baseRequire, '@deepseek-ai/dsh-sandbox-local');
  const ctx: DshContext = new Context();
  try {
    await ctx.plugin(Subprocess);
    await ctx.plugin(Sandbox);
    return ctx;
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

export interface LaunchResult {
  mode: Mode;
  enforcement?: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

/** Use the installed sandbox and process owner verbatim. No fallback is performed. */
export async function launch(ctx: DshContext, mode: Mode, workspace: string, argv: readonly string[]): Promise<LaunchResult> {
  const start = performance.now();
  const { handle, confined } = await startProcess(ctx, mode, workspace, argv);
  const result = await handle.done;
  const stdout = handle.collected.stdout.readFrom(0);
  const stderr = handle.collected.stderr.readFrom(0);
  if (stdout.lossy || stderr.lossy) throw new Error('Diagnostic output exceeded its capture budget.');
  return {
    mode, ...confined ? { enforcement: confined.enforcement } : {}, ...result,
    stdout: stdout.text, stderr: stderr.text, elapsedMs: Math.round(performance.now() - start),
  };
}

export async function startProcess(ctx: DshContext, mode: Mode, workspace: string, argv: readonly string[], timeoutMs = 30_000) {
  const signal = AbortSignal.timeout(timeoutMs);
  const confined = mode === 'unconfined-control' ? undefined : await ctx.sandbox.confine(argv, { mode, workspaceRoot: workspace }, signal);
  const handle = ctx.subprocess.spawn({
    argv: confined?.argv ?? argv, cwd: workspace, graceMs: 500, signal,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 256_000 }, stderr: { maxBytes: 64_000 } },
  });
  return { handle, confined };
}

export function installedSource(runtime: Runtime, name: string, relative: string): string {
  return join(dirname(runtime.baseRequire.resolve(`${name}/package.json`)), relative);
}
