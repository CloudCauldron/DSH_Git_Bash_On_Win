import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type Subprocess from '@deepseek-ai/dsh-subprocess';
import { provisionRuntime } from '../setup/provision-runtime.ts';
import {
  absolutePath, acquireWriterLock, admitChildDirectory, admitDirectory, admitJunction,
  bestEffort, canonicalWorkspace, children, claimDirectory, createDirectory, createHardlink,
  createJunction, ensureDirectory, InvalidMetadataError, isBusy, isMissing, ordinaryChildDirectory,
  overlaps, pathExists, pinDirectory, readMetadata, removeDirectoryTree, removeEmptyDirectory, removeTree,
  revalidateDirectory, sameIdentity, samePath, unlinkEntry, writeNewMetadata,
  type Directory, type NativeHold,
} from './ntfs-filesystem.ts';
import {
  anchorNames, captureAnchors, discoverGitInstallation, inventoryGitFiles, linkFreshTree,
  readAnchors, sameAnchors, type AnchorStamps, type GitInstallation, type GitLayout,
} from './git-installation.ts';

export interface RuntimePreparation {
  readonly cacheDirectory: string;
  readonly spawn: Subprocess['spawn'];
  readonly gitBashPath?: string;
  readonly rebuild?: boolean;
}
export interface GenerationPin {
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
interface CurrentRuntime {
  readonly schemaVersion: 1;
  readonly generationId: string;
  readonly sourceRoot: string;
  readonly layout: GitLayout;
  readonly anchors: AnchorStamps;
}

const markerName = '.owner.json';
const generationId = z.string().pattern(/^[a-f0-9]{32}$/).required();
const pathSchema = z.string().min(3).max(32767).required();
const integerString = z.string().pattern(/^\d{1,20}$/).required();
const identityFields = { volumeSerial: integerString, fileId: integerString };
const markerSchema = z.object({
  schemaVersion: z.const(1).required(), owner: z.const('dsh-git-bash-on-win').required(),
  rootPath: pathSchema, ...identityFields,
}).required();
const stampSchema = z.object({ ...identityFields, size: integerString, lastWriteTime: integerString }).required();
const currentSchema = z.object({
  schemaVersion: z.const(1).required(), generationId, sourceRoot: pathSchema,
  layout: z.union([z.const('ucrt64'), z.const('mingw64')]).required(),
  anchors: z.object(Object.fromEntries(anchorNames.map(name => [name, stampSchema]))).required(),
}).required();

/** A marker authorizes the whole interior, but never an external reparse target. */
function admitRoot(path: string, create: boolean): Directory | undefined {
  path = absolutePath(path);
  if (!pathExists(path)) {
    if (!create) { admitDirectory(dirname(path)); return undefined; }
    const parent = admitDirectory(dirname(path));
    let root: Directory;
    try { root = createDirectory(parent, basename(path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Another process may have completed ownership while mkdir was pending.
      // Reuse normal admission; an incomplete or unknown marker still fails F1.
      const competing = admitRoot(path, false);
      if (competing) return competing;
      throw error;
    }
    try { writeNewMetadata(root, markerName, { schemaVersion: 1, owner: 'dsh-git-bash-on-win', rootPath: root.path, volumeSerial: root.volumeSerial, fileId: root.fileId }); }
    catch (error) { bestEffort(() => removeEmptyDirectory(root)); throw error; }
    return root;
  }
  const root = admitDirectory(path);
  const marker = (markerSchema as (value: unknown) => ReturnType<typeof markerSchema>)(readMetadata(root, markerName, 256 * 1024));
  if (!samePath(absolutePath(marker.rootPath), root.path) || !sameIdentity(marker, root)) throw new Error(`Unrecognized cache ownership: ${path}`);
  return root;
}

function revalidateRoot(root: Directory): void {
  const admitted = admitRoot(root.path, false);
  if (!admitted || !sameIdentity(admitted, root)) throw new Error(`Cache ownership changed: ${root.path}`);
}

function currentRecord(root: Directory): CurrentRuntime | undefined {
  let raw: unknown;
  try { raw = readMetadata(root, 'current.json', 512 * 1024); }
  catch (error) {
    if (isMissing(error) || error instanceof SyntaxError || error instanceof InvalidMetadataError) return undefined;
    throw error;
  }
  try {
    const record = (currentSchema as unknown as (value: unknown) => CurrentRuntime)(raw);
    if (absolutePath(record.sourceRoot) !== record.sourceRoot) return undefined;
    return record;
  } catch { return undefined; }
}

function admitBase(generation: Directory, layout: GitLayout): Directory {
  const base = admitChildDirectory(generation, 'base');
  const usr = admitChildDirectory(base, 'usr');
  const bin = admitChildDirectory(usr, 'bin');
  admitChildDirectory(base, layout);
  admitChildDirectory(base, 'etc');
  admitJunction(base, 'bin', bin);
  return base;
}

/** One optimistic attempt; the second selector read is required even with a pin. */
async function tryWarm(root: Directory, source: GitInstallation, signal: AbortSignal): Promise<GenerationPin | undefined> {
  const record = currentRecord(root);
  if (!record) return undefined;
  let hold: NativeHold | undefined;
  try {
    const generations = admitChildDirectory(root, 'generations');
    const generation = admitChildDirectory(generations, record.generationId);
    hold = pinDirectory(generation);
    if (currentRecord(root)?.generationId !== record.generationId) return undefined;
    if (!samePath(record.sourceRoot, source.root) || record.layout !== source.layout) return undefined;
    const base = admitBase(generation, record.layout);
    const origin = await readAnchors(source.root, source.layout), target = await readAnchors(base.path, record.layout);
    if (!sameAnchors(origin, record.anchors) || !sameAnchors(target, record.anchors)) return undefined;
    signal.throwIfAborted();
    const pin = new RuntimePin(root, generation, base, record, hold);
    hold = undefined;
    return pin;
  } catch (error) {
    if (!isMissing(error) && !isBusy(error)) throw error;
    return undefined;
  } finally { hold?.close(); }
}

/** The writer retains ownership through linking, final capture and commit. */
export async function prepareRuntime(request: RuntimePreparation, signal: AbortSignal): Promise<GenerationPin> {
  signal.throwIfAborted();
  const source = discoverGitInstallation(request.gitBashPath);
  const sourceDirectory = admitDirectory(source.root);
  const requestedPath = absolutePath(request.cacheDirectory);
  // Resolve an existing parent before creating anything, including short-name aliases.
  const parent = admitDirectory(dirname(requestedPath)), cachePath = join(parent.path, basename(requestedPath));
  if (overlaps(cachePath, source.root)) throw new Error('Git source and cache paths must not overlap.');
  if (parent.volumeSerial !== sourceDirectory.volumeSerial) throw new Error('Git and cache must share an NTFS volume.');
  const root = admitRoot(cachePath, true)!;
  if (overlaps(root.path, source.root)) throw new Error('Git source and cache paths must not overlap.');
  if (root.volumeSerial !== sourceDirectory.volumeSerial) throw new Error('Git and cache must share an NTFS volume.');
  if (!request.rebuild) {
    const warm = await tryWarm(root, source, signal);
    if (warm) return warm;
  }
  const lock = await acquireWriterLock(root, signal);
  let pin: GenerationPin | undefined;
  try {
    revalidateRoot(root);
    if (!request.rebuild) {
      pin = await tryWarm(root, source, signal);
      if (pin) return pin;
    }
    const generations = ensureDirectory(root, 'generations');
    collectUnused(generations, currentRecord(root)?.generationId);
    pin = await buildFresh(root, generations, source, signal, request.spawn);
    return pin;
  } finally { await closePreparationLock(lock, pin); }
}

async function closePreparationLock(lock: NativeHold, pin: GenerationPin | undefined): Promise<void> {
  try { lock.close(); }
  catch (error) {
    // A successful factory result cannot escape if closing its writer failed.
    await pin?.release();
    throw error;
  }
}

async function buildFresh(root: Directory, generations: Directory, source: GitInstallation, signal: AbortSignal, spawn: Subprocess['spawn']): Promise<GenerationPin> {
  signal.throwIfAborted();
  const id = randomUUID().replaceAll('-', ''), generation = createDirectory(generations, id);
  let hold: NativeHold | undefined;
  let published = false;
  try {
    const sourceDirectory = admitDirectory(source.root);
    const sourceBin = admitChildDirectory(admitChildDirectory(sourceDirectory, 'usr'), 'bin');
    let elevated = false;
    try { createHardlink(sourceBin, 'bash.exe', generation, '.probe'); }
    catch (error) {
      if (!(error as { linkPermissionDenied?: boolean }).linkPermissionDenied) throw error;
      elevated = true;
    }
    if (!elevated) unlinkEntry(generation, '.probe');
    signal.throwIfAborted();
    const base = createDirectory(generation, 'base');
    if (elevated) {
      await provisionRuntime({ source: sourceDirectory, cache: root, generation, base, layout: source.layout }, signal, spawn);
    } else {
      const files = await inventoryGitFiles(source.root, () => signal.throwIfAborted());
      revalidateDirectory(sourceDirectory);
      revalidateDirectory(base);
      await linkFreshTree({ sourceRoot: source.root, baseRoot: base.path, files }, () => signal.throwIfAborted());
    }
    signal.throwIfAborted();
    createJunction(base, 'bin', admitChildDirectory(admitChildDirectory(base, 'usr'), 'bin'));
    const anchors = captureAnchors(source.root, base.path, source.layout);
    admitBase(generation, source.layout);
    // provisionRuntime has closed its setup lease. Retire the input only after
    // final admission; a blocked ordinary unlink must still prevent commit.
    if (elevated) unlinkEntry(generation, 'plan.json');
    signal.throwIfAborted();
    hold = pinDirectory(generation);
    const record: CurrentRuntime = { schemaVersion: 1, generationId: id, sourceRoot: source.root, layout: source.layout, anchors };
    revalidateRoot(root);
    await writeFileAtomic(join(root.path, 'current.json'), `${JSON.stringify(record)}\n`, { mode: 0o600, dirMode: 0o700 });
    published = true;
    signal.throwIfAborted();
    const pin = new RuntimePin(root, generation, base, record, hold);
    hold = undefined;
    return pin;
  } finally {
    hold?.close();
    if (!published) bestEffort(() => collectGeneration(generations, id));
  }
}

/** Claims and plan unlink are gates, including for malformed generation names. */
function collectGeneration(generations: Directory, name: string): void {
  const directory = ordinaryChildDirectory(generations, name);
  if (!directory) { removeTree(generations, name); return; }
  const claim = claimDirectory(directory);
  try {
    unlinkEntry(directory, 'plan.json');
    removeDirectoryTree(directory);
  } finally { claim.close(); }
}

function collectUnused(generations: Directory, selected?: string): void {
  for (const name of children(generations)) if (name !== selected) bestEffort(() => collectGeneration(generations, name));
}

/** Offline only. Preflight every generation before unpublication or payload deletion. */
export async function purgeRuntimeCache(cacheDirectory: string): Promise<void> {
  const root = admitRoot(cacheDirectory, false);
  if (!root) return;
  const lock = await acquireWriterLock(root, new AbortController().signal);
  const claims: Array<{ directory: Directory; hold: NativeHold }> = [];
  try {
    revalidateRoot(root);
    const generations = pathExists(join(root.path, 'generations')) ? ordinaryChildDirectory(root, 'generations') : undefined;
    if (generations) {
      for (const name of children(generations)) {
        const directory = ordinaryChildDirectory(generations, name);
        if (directory) claims.push({ directory, hold: claimDirectory(directory) });
      }
    }
    for (const { directory } of claims) unlinkEntry(directory, 'plan.json');
    removeTree(root, 'current.json');
    if (generations) {
      for (const { directory, hold } of claims) {
        removeDirectoryTree(directory);
        hold.close();
      }
      for (const name of children(generations)) {
        if (ordinaryChildDirectory(generations, name)) throw new Error(`Generation appeared after purge preflight: ${name}`);
        unlinkEntry(generations, name);
      }
      removeEmptyDirectory(generations);
    }
    for (const name of children(root)) if (name !== markerName && name !== '.writer-lock') removeTree(root, name);
    unlinkEntry(root, markerName);
  } finally {
    closePurgeHolds([...claims.map(claim => claim.hold), lock]);
  }
  removeEmptyDirectory(root);
}

function closePurgeHolds(holds: readonly NativeHold[]): void {
  const errors: unknown[] = [];
  for (const hold of holds) { try { hold.close(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, 'Runtime purge failed to close native resources.');
}

/** One native directory hold, shared by an owner and its local uses. */
class RuntimePin implements GenerationPin {
  private readonly root: Directory;
  private readonly generation: Directory;
  private readonly base: Directory;
  private readonly record: CurrentRuntime;
  private readonly hold: NativeHold;
  private references = 1;
  private retired = false;
  private ownerRelease?: Promise<void>;
  private namespace?: Directory;
  private readonly instance = randomUUID();
  private readonly views = new Map<string, Promise<string>>();

  constructor(root: Directory, generation: Directory, base: Directory, record: CurrentRuntime, hold: NativeHold) {
    this.root = root; this.generation = generation; this.base = base; this.record = record; this.hold = hold;
  }

  async lease(scope: Pick<SandboxExecutionPolicy, 'mode' | 'workspaceRoot' | 'sessionId'>, signal: AbortSignal): Promise<RuntimeUse> {
    if (this.retired) throw new Error('Runtime generation pin is retired.');
    this.references++;
    let transferred = false;
    let view: string | undefined;
    try {
      const workspace = await canonicalWorkspace(scope.workspaceRoot);
      if (overlaps(workspace, this.record.sourceRoot) || overlaps(workspace, this.root.path)) throw new Error('Workspace must not overlap Git source or runtime cache.');
      const key = scope.sessionId === undefined ? undefined : JSON.stringify([scope.mode, workspace.toLowerCase(), scope.sessionId]);
      view = await this.view(key);
      signal.throwIfAborted();
      let release: Promise<void> | undefined;
      const use: RuntimeUse = {
        baseRoot: this.base.path, installationRoot: view, sourceRoot: this.record.sourceRoot, layout: this.record.layout,
        release: () => release ??= this.releaseUse(view!, scope.sessionId === undefined),
      };
      transferred = true;
      return use;
    } finally {
      if (!transferred) await this.releaseUse(view, scope.sessionId === undefined);
    }
  }

  release(): Promise<void> {
    if (!this.ownerRelease) { this.retired = true; this.ownerRelease = this.dropReference(); }
    return this.ownerRelease;
  }

  private view(key: string | undefined): Promise<string> {
    if (key !== undefined) {
      const existing = this.views.get(key);
      if (existing) return existing;
    }
    const promise = (async () => {
      // Yield once so even a synchronous creation error is evicted after insertion.
      await Promise.resolve();
      try {
        this.namespace ??= createDirectory(ensureDirectory(this.generation, 'views'), this.instance);
        return createJunction(this.namespace, randomUUID(), this.base);
      } catch (error) {
        if (key !== undefined) this.views.delete(key);
        throw error;
      }
    })();
    if (key !== undefined) this.views.set(key, promise);
    return promise;
  }

  private async releaseUse(view: string | undefined, agentless: boolean): Promise<void> {
    try {
      if (agentless && view && this.namespace) bestEffort(() => unlinkEntry(this.namespace!, basename(view)));
    } finally { await this.dropReference(); }
  }

  private async dropReference(): Promise<void> {
    this.references--;
    if (this.references !== 0 || !this.retired) return;
    try {
      if (this.namespace) bestEffort(() => removeTree(admitChildDirectory(this.generation, 'views'), this.instance));
    } finally { this.views.clear(); this.hold.close(); }
  }
}
