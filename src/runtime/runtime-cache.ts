import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type Subprocess from '@deepseek-ai/dsh-subprocess';
import { provisionRuntime, ProvisioningCleanupError } from '../setup/elevated-linking.ts';
import {
  absolutePath, acquireWriterLock, admitChildDirectory, admitDirectory, admitJunction,
  bestEffort, canonicalWorkspace, children, claimDirectory, createDirectory, createHardlink,
  createJunction, DirectoryRollbackError, ensureDirectory, hasCloseFailure, InvalidMetadataError, isBusy, isMissing, ordinaryChildDirectory,
  overlaps, pathExists, pinDirectory, readMetadata, removeDirectoryTree, removeEmptyDirectory, removeTree,
  revalidateDirectory, sameIdentity, samePath, unlinkEntry, writeNewMetadata,
  type Directory, type NativeHold,
} from './ntfs-filesystem.ts';
import {
  anchorNames, captureAnchors, discoverGitInstallation, inventoryGitFiles, linkFreshTree,
  readAnchors, sameAnchors, type AnchorStamps, type GitInstallation, type GitLayout,
} from './git-installation.ts';
import { LocalizedAggregateError, LocalizedError } from '../locale/errors.ts';

export type LinkProgress = 'preparing' | 'elevation' | 'checking'
  | { path: string; completed?: never } | { path: string; completed: number; total: number };

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
export function hasRuntimeCleanupFailure(error: unknown): boolean {
  return hasCloseFailure(error) || error instanceof ProvisioningCleanupError
    || error instanceof AggregateError && error.errors.some(hasRuntimeCleanupFailure);
}
interface CurrentRuntime {
  readonly schemaVersion: 1;
  readonly generationId: string;
  readonly sourceRoot: string;
  readonly layout: GitLayout;
  readonly anchors: AnchorStamps;
}

export const sharedCacheDirectory = (home: string): string => join(home, '.dsh-git-bash-on-win');

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

function writeOwnerMarker(root: Directory): void {
  writeNewMetadata(root, markerName, { schemaVersion: 1, owner: 'dsh-git-bash-on-win',
    rootPath: root.path, volumeSerial: root.volumeSerial, fileId: root.fileId });
}

/** A marker authorizes the whole interior, but never an external reparse target. */
function admitRoot(path: string, create: boolean): Directory | undefined {
  path = absolutePath(path);
  if (!pathExists(path)) {
    if (!create) { admitDirectory(dirname(path)); return undefined; }
    const parent = admitDirectory(dirname(path));
    const root = createDirectory(parent, basename(path));
    try { writeOwnerMarker(root); }
    catch (error) { bestEffort(() => removeEmptyDirectory(root)); throw error; }
    return root;
  }
  const root = admitDirectory(path);
  const marker = (markerSchema as (value: unknown) => ReturnType<typeof markerSchema>)(readMetadata(root, markerName, 256 * 1024));
  if (!samePath(absolutePath(marker.rootPath), root.path) || !sameIdentity(marker, root)) {
    throw new LocalizedError('error.cacheOwner', { path }, { fallback: `Unrecognized cache ownership: ${path}` });
  }
  return root;
}

function revalidateRoot(root: Directory): void {
  const admitted = admitRoot(root.path, false);
  if (!admitted || !sameIdentity(admitted, root)) throw new LocalizedError('error.cacheOwnershipChanged', { path: root.path });
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
async function tryWarm(root: Directory, source: GitInstallation, signal: AbortSignal): Promise<GenerationPin | 'sourceChanged' | undefined> {
  const record = currentRecord(root);
  if (!record) return undefined;
  let hold: NativeHold | undefined;
  let sourceChanged = false;
  try {
    const generations = admitChildDirectory(root, 'generations');
    const generation = admitChildDirectory(generations, record.generationId);
    hold = pinDirectory(generation);
    if (currentRecord(root)?.generationId !== record.generationId) return undefined;
    if (!samePath(record.sourceRoot, source.root)) return undefined;
    if (record.layout !== source.layout) return 'sourceChanged';
    const base = admitBase(generation, record.layout);
    const origin = await readAnchors(source.root, source.layout).catch(error => {
      if (!isMissing(error)) throw error;
      // A saved source anchor has disappeared. A missing cache link alone has a different explanation.
      return undefined;
    });
    sourceChanged = !origin || !sameAnchors(origin, record.anchors);
    const target = await readAnchors(base.path, record.layout);
    if (sourceChanged) return 'sourceChanged';
    if (!sameAnchors(target, record.anchors)) return undefined;
    signal.throwIfAborted();
    const pin = new RuntimePin(root, generation, base, record, hold, false);
    hold = undefined;
    return pin;
  } catch (error) {
    if (!isMissing(error) && !isBusy(error)) throw error;
    return sourceChanged ? 'sourceChanged' : undefined;
  } finally { hold?.close(); }
}

interface ElevationRequest { source: Directory; layout: GitLayout; sourceChanged: boolean }

export async function prepareRuntime(request: RuntimePreparation, signal: AbortSignal): Promise<GenerationPin> {
  let approved: ElevationRequest | undefined;
  for (;;) {
    const result = await preparePass(request, signal, approved);
    if (!('source' in result)) return result;
    // preparePass has released the writer and discarded its probe generation.
    signal.throwIfAborted();
    if (typeof request.elevation !== 'function') throw new LocalizedError('error.confirmationRequired');
    await request.elevation(result.source.path, result.sourceChanged);
    approved = result;
  }
}

/** Re-admit the current selection after consent, including a cache built by another instance. */
async function preparePass(request: RuntimePreparation, signal: AbortSignal, approved?: ElevationRequest): Promise<GenerationPin | ElevationRequest> {
  signal.throwIfAborted();
  const source = discoverGitInstallation(request.gitBashPath);
  const sourceDirectory = admitDirectory(source.root);
  const requestedPath = absolutePath(request.cacheDirectory);
  // Resolve an existing parent before creating anything, including short-name aliases.
  const parent = admitDirectory(dirname(requestedPath)), cachePath = join(parent.path, basename(requestedPath));
  if (overlaps(cachePath, source.root)) throw new LocalizedError('error.cacheOverlap', undefined, { fallback: 'Git source and cache paths must not overlap.' });
  if (parent.volumeSerial !== sourceDirectory.volumeSerial) {
    throw new LocalizedError('error.sameVolume', undefined, { fallback: 'Git and cache must share an NTFS volume.' });
  }
  const admitCache = (create: boolean) => {
    const root = admitRoot(cachePath, create);
    if (root && overlaps(root.path, source.root)) throw new LocalizedError('error.cacheOverlap');
    if (root && root.volumeSerial !== sourceDirectory.volumeSerial) throw new LocalizedError('error.sameVolume');
    return root;
  };
  if (!request.rebuild) {
    try {
      const root = admitCache(false);
      if (root) {
        const warm = await tryWarm(root, source, signal);
        if (warm && warm !== 'sourceChanged') return warm;
      }
    } catch (error) {
      // Another process may be writing the first marker. Recheck under its lock.
      if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
    }
  }
  let pin: GenerationPin | undefined;
  try {
    using lock = await acquireWriterLock(cachePath, signal);
    const root = admitCache(true)!;
    using _root = pinDirectory(root);
    const warm = request.rebuild ? undefined : await tryWarm(root, source, signal);
    if (warm && warm !== 'sourceChanged') {
      pin = warm;
    } else {
      const generations = ensureDirectory(root, 'generations');
      const authorized = request.elevation === 'manual' || !!approved && approved.layout === source.layout
        && samePath(approved.source.path, source.root) && sameIdentity(approved.source, sourceDirectory);
      pin = await buildFresh(root, generations, source, sourceDirectory, signal, request, authorized);
      if (!pin) return { source: sourceDirectory, layout: source.layout, sourceChanged: warm === 'sourceChanged' };
    }
    return pin;
  } catch (error) {
    // The pin transfers only after both the root and writer have closed successfully.
    await pin?.release();
    if (error instanceof SuppressedError && error.suppressed === signal.reason) throw error.error;
    throw error;
  }
}

async function buildFresh(root: Directory, generations: Directory, source: GitInstallation, sourceDirectory: Directory,
  signal: AbortSignal, request: RuntimePreparation, authorized: boolean): Promise<GenerationPin | undefined> {
  signal.throwIfAborted();
  const id = randomUUID().replaceAll('-', ''), generation = createDirectory(generations, id);
  let hold: NativeHold | undefined;
  let published = false;
  try {
    revalidateDirectory(sourceDirectory);
    const sourceBin = admitChildDirectory(admitChildDirectory(sourceDirectory, 'usr'), 'bin');
    let elevated = false;
    try { createHardlink(sourceBin, 'bash.exe', generation, '.probe'); }
    catch (error) {
      if (!(error as { linkPermissionDenied?: boolean }).linkPermissionDenied) throw error;
      if (!authorized) return undefined;
      elevated = true;
    }
    if (!elevated) unlinkEntry(generation, '.probe');
    signal.throwIfAborted();
    // A permission check can end here without starting a rebuild. Collect only once it may proceed.
    const selected = currentRecord(root)?.generationId;
    for (const name of children(generations)) {
      if (name.toLowerCase() !== selected && name.toLowerCase() !== id) bestEffort(() => collectGeneration(generations, name));
    }
    const base = createDirectory(generation, 'base');
    const validate = () => {
      signal.throwIfAborted();
      request.onProgress?.('checking');
      createJunction(base, 'bin', admitChildDirectory(admitChildDirectory(base, 'usr'), 'bin'));
      revalidateDirectory(sourceDirectory);
      const anchors = captureAnchors(source.root, base.path, source.layout);
      admitBase(generation, source.layout);
      revalidateRoot(root);
      return anchors;
    };
    let anchors: AnchorStamps;
    if (elevated) {
      const report = request.onProgress;
      let watcher: FSWatcher | undefined;
      if (report) {
        report('elevation');
        // Observe relative names only. Windows may coalesce notifications from the helper.
        try {
          watcher = watch(base.path, { recursive: true, signal }, (event, name) => {
            if (event === 'rename' && name) report({ path: name.split(sep).join('/') });
          });
          watcher.on('error', () => watcher?.close());
        } catch { /* Linking can proceed without filename notifications. */ }
      }
      try {
        anchors = await provisionRuntime({ source: sourceDirectory, cache: root, generation, base, layout: source.layout },
          signal, request.spawn, validate);
      } finally { watcher?.close(); }
    } else {
      const files = await inventoryGitFiles(source.root, () => signal.throwIfAborted());
      await linkFreshTree({ source: sourceDirectory, base, files }, () => signal.throwIfAborted(), request.onProgress);
      anchors = validate();
    }
    // Final admission and checked lease closure precede ordinary plan cleanup.
    if (elevated) unlinkEntry(generation, 'plan.json');
    hold = pinDirectory(generation);
    const record: CurrentRuntime = { schemaVersion: 1, generationId: id, sourceRoot: source.root, layout: source.layout, anchors };
    signal.throwIfAborted();
    // Entering the atomic write is the cancellation cutoff. Once it succeeds,
    // return its published pin even if aborted; the executor guards adoption.
    await writeFileAtomic(join(root.path, 'current.json'), `${JSON.stringify(record)}\n`, { mode: 0o600, dirMode: 0o700 });
    published = true;
    const pin = new RuntimePin(root, generation, base, record, hold, true);
    hold = undefined;
    return pin;
  } finally {
    hold?.close();
    if (!published) bestEffort(() => collectGeneration(generations, id));
  }
}

/** Leave ordinary plan directories for payload traversal after the real plan gates. */
function unlinkPlan(directory: Directory): void {
  try {
    if (ordinaryChildDirectory(directory, 'plan.json')) return;
  } catch (error) {
    if (hasCloseFailure(error) || !isMissing(error)) throw error;
  }
  unlinkEntry(directory, 'plan.json');
}

/** Claims and plan unlink are gates, including for malformed generation names. */
function collectGeneration(generations: Directory, name: string): void {
  const directory = ordinaryChildDirectory(generations, name);
  if (!directory) { removeTree(generations, name); return; }
  const claim = claimDirectory(directory);
  try {
    unlinkPlan(directory);
    removeDirectoryTree(directory, claim);
  } finally { claim.close(); }
}

/** Offline only. Preflight every generation before unpublication or payload deletion. */
export async function purgeRuntimeCache(cacheDirectory: string): Promise<void> {
  const path = absolutePath(cacheDirectory);
  using lock = await acquireWriterLock(path);
  const root = admitRoot(path, false);
  if (root) purgeOwnedRoot(root);
  lock.close();
  // A metadata observer can keep a delete-on-close lock name pending.
  const rootName = basename(path).toLowerCase(), lockName = basename(lock.path).toLowerCase();
  if (children(admitDirectory(dirname(path))).some(name => [rootName, lockName].includes(name.toLowerCase()))) {
    throw new LocalizedError('error.purgeIncomplete');
  }
}

function purgeOwnedRoot(root: Directory): void {
  const claims: Array<{ directory: Directory; hold: NativeHold }> = [];
  using rootHold = claimDirectory(root);
  try {
    const generations = pathExists(join(root.path, 'generations')) ? ordinaryChildDirectory(root, 'generations') : undefined;
    if (generations) {
      for (const name of children(generations)) {
        const directory = ordinaryChildDirectory(generations, name);
        if (directory) claims.push({ directory, hold: claimDirectory(directory) });
      }
    }
    for (const { directory } of claims) unlinkPlan(directory);
    removeTree(root, 'current.json');
    if (generations) {
      for (const { directory, hold } of claims) {
        removeDirectoryTree(directory, hold);
        hold.close();
      }
      for (const name of children(generations)) {
        if (ordinaryChildDirectory(generations, name)) throw new LocalizedError('error.generationAfterPreflight', { name });
        unlinkEntry(generations, name);
      }
      removeEmptyDirectory(generations);
    }
    const entries = children(root);
    const marker = entries.includes(markerName) ? markerName : entries.find(name => name.toLowerCase() === markerName);
    for (const name of entries) if (name !== marker) removeTree(root, name);
  } finally {
    closePurgeHolds(claims.map(claim => claim.hold));
  }
  unlinkEntry(root, markerName);
  try { rootHold.deleteEntry(); }
  catch (error) {
    rootHold.close();
    writeOwnerMarker(root);
    throw error;
  }
}

function closePurgeHolds(holds: readonly NativeHold[]): void {
  const errors: unknown[] = [];
  for (const hold of holds) { try { hold.close(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new LocalizedAggregateError(errors, 'error.purgeCloseFailed');
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
  private namespaceResidue = false;
  private readonly instance = randomUUID();
  private readonly views = new Map<string, Promise<string>>();

  readonly freshlyBuilt: boolean;
  constructor(root: Directory, generation: Directory, base: Directory, record: CurrentRuntime, hold: NativeHold, freshlyBuilt: boolean) {
    this.freshlyBuilt = freshlyBuilt;
    this.root = root; this.generation = generation; this.base = base; this.record = record; this.hold = hold;
  }

  async lease(scope: Pick<SandboxExecutionPolicy, 'mode' | 'workspaceRoot' | 'sessionId'>, signal: AbortSignal): Promise<RuntimeUse> {
    if (this.retired) throw new LocalizedError('error.pinRetired');
    signal.throwIfAborted();
    this.references++;
    let transferred = false;
    let view: string | undefined;
    try {
      const workspace = await canonicalWorkspace(scope.workspaceRoot);
      signal.throwIfAborted();
      if (overlaps(workspace, this.record.sourceRoot) || overlaps(workspace, this.root.path)) throw new LocalizedError('error.workspaceOverlap');
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
        return createJunction(this.viewParent(), randomUUID(), this.base);
      } catch (error) {
        if (key !== undefined) this.views.delete(key);
        throw error;
      }
    })();
    if (key !== undefined) this.views.set(key, promise);
    return promise;
  }

  private viewParent(): Directory {
    if (this.namespace) return this.namespace;
    const views = ensureDirectory(this.generation, 'views');
    if (this.namespaceResidue) {
      removeTree(views, this.instance);
      this.namespaceResidue = false;
    }
    try { return this.namespace = createDirectory(views, this.instance); }
    catch (error) {
      // Only a failed rollback after our own mkdir grants ownership. An
      // unexpected EEXIST must never authorize removal on retry or retirement.
      if (error instanceof DirectoryRollbackError) this.namespaceResidue = true;
      throw error;
    }
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
      if (this.namespace || this.namespaceResidue) bestEffort(() => removeTree(admitChildDirectory(this.generation, 'views'), this.instance));
    } finally { this.views.clear(); this.hold.close(); }
  }
}
