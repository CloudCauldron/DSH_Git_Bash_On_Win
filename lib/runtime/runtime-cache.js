import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { provisionRuntime, ProvisioningCleanupError } from '../setup/elevated-linking.js';
import { absolutePath, acquireWriterLock, admitChildDirectory, admitDirectory, admitJunction, bestEffort, canonicalWorkspace, children, claimDirectory, createDirectory, createHardlink, createJunction, DirectoryRollbackError, ensureDirectory, hasCloseFailure, InvalidMetadataError, isBusy, isMissing, ordinaryChildDirectory, overlaps, pathExists, pinDirectory, readMetadata, removeDirectoryTree, removeEmptyDirectory, removeTree, revalidateDirectory, sameIdentity, samePath, unlinkEntry, writeNewMetadata, } from './ntfs-filesystem.js';
import { anchorNames, captureAnchors, discoverGitInstallation, inventoryGitFiles, linkFreshTree, readAnchors, sameAnchors, } from './git-installation.js';
import { LocalizedAggregateError, LocalizedError } from '../localized-error.js';
/** Preserve local resource failures without treating source/setup errors as leaks. */
export function hasRuntimeCleanupFailure(error) {
    return hasCloseFailure(error) || error instanceof ProvisioningCleanupError
        || error instanceof AggregateError && error.errors.some(hasRuntimeCleanupFailure);
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
function admitRoot(path, create) {
    path = absolutePath(path);
    if (!pathExists(path)) {
        if (!create) {
            admitDirectory(dirname(path));
            return undefined;
        }
        const parent = admitDirectory(dirname(path));
        let root;
        try {
            root = createDirectory(parent, basename(path));
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            // Another process may have completed ownership while mkdir was pending.
            // Reuse normal admission; an incomplete or unknown marker still fails F1.
            const competing = admitRoot(path, false);
            if (competing)
                return competing;
            throw error;
        }
        try {
            writeNewMetadata(root, markerName, { schemaVersion: 1, owner: 'dsh-git-bash-on-win', rootPath: root.path, volumeSerial: root.volumeSerial, fileId: root.fileId });
        }
        catch (error) {
            bestEffort(() => removeEmptyDirectory(root));
            throw error;
        }
        return root;
    }
    const root = admitDirectory(path);
    const marker = markerSchema(readMetadata(root, markerName, 256 * 1024));
    if (!samePath(absolutePath(marker.rootPath), root.path) || !sameIdentity(marker, root)) {
        throw new LocalizedError('error.cacheOwner', { path }, { fallback: `Unrecognized cache ownership: ${path}` });
    }
    return root;
}
function revalidateRoot(root) {
    const admitted = admitRoot(root.path, false);
    if (!admitted || !sameIdentity(admitted, root))
        throw new LocalizedError('error.cacheOwnershipChanged', { path: root.path });
}
function currentRecord(root) {
    let raw;
    try {
        raw = readMetadata(root, 'current.json', 512 * 1024);
    }
    catch (error) {
        if (isMissing(error) || error instanceof SyntaxError || error instanceof InvalidMetadataError)
            return undefined;
        throw error;
    }
    try {
        const record = currentSchema(raw);
        if (absolutePath(record.sourceRoot) !== record.sourceRoot)
            return undefined;
        return record;
    }
    catch {
        return undefined;
    }
}
function admitBase(generation, layout) {
    const base = admitChildDirectory(generation, 'base');
    const usr = admitChildDirectory(base, 'usr');
    const bin = admitChildDirectory(usr, 'bin');
    admitChildDirectory(base, layout);
    admitChildDirectory(base, 'etc');
    admitJunction(base, 'bin', bin);
    return base;
}
/** One optimistic attempt; the second selector read is required even with a pin. */
async function tryWarm(root, source, signal) {
    const record = currentRecord(root);
    if (!record)
        return undefined;
    let hold;
    try {
        const generations = admitChildDirectory(root, 'generations');
        const generation = admitChildDirectory(generations, record.generationId);
        hold = pinDirectory(generation);
        if (currentRecord(root)?.generationId !== record.generationId)
            return undefined;
        if (!samePath(record.sourceRoot, source.root) || record.layout !== source.layout)
            return undefined;
        const base = admitBase(generation, record.layout);
        const origin = await readAnchors(source.root, source.layout), target = await readAnchors(base.path, record.layout);
        if (!sameAnchors(origin, record.anchors) || !sameAnchors(target, record.anchors))
            return undefined;
        signal.throwIfAborted();
        const pin = new RuntimePin(root, generation, base, record, hold);
        hold = undefined;
        return pin;
    }
    catch (error) {
        if (!isMissing(error) && !isBusy(error))
            throw error;
        return undefined;
    }
    finally {
        hold?.close();
    }
}
/** The writer retains ownership through linking, final capture and commit. */
export async function prepareRuntime(request, signal) {
    signal.throwIfAborted();
    const source = discoverGitInstallation(request.gitBashPath);
    const sourceDirectory = admitDirectory(source.root);
    const requestedPath = absolutePath(request.cacheDirectory);
    // Resolve an existing parent before creating anything, including short-name aliases.
    const parent = admitDirectory(dirname(requestedPath)), cachePath = join(parent.path, basename(requestedPath));
    if (overlaps(cachePath, source.root))
        throw new LocalizedError('error.cacheOverlap', undefined, { fallback: 'Git source and cache paths must not overlap.' });
    if (parent.volumeSerial !== sourceDirectory.volumeSerial) {
        throw new LocalizedError('error.sameVolume', undefined, { fallback: 'Git and cache must share an NTFS volume.' });
    }
    const root = admitRoot(cachePath, true);
    if (overlaps(root.path, source.root))
        throw new LocalizedError('error.cacheOverlap', undefined, { fallback: 'Git source and cache paths must not overlap.' });
    if (root.volumeSerial !== sourceDirectory.volumeSerial) {
        throw new LocalizedError('error.sameVolume', undefined, { fallback: 'Git and cache must share an NTFS volume.' });
    }
    if (!request.rebuild) {
        const warm = await tryWarm(root, source, signal);
        if (warm)
            return warm;
    }
    const lock = await acquireWriterLock(root, signal);
    let pin;
    try {
        revalidateRoot(root);
        if (!request.rebuild) {
            pin = await tryWarm(root, source, signal);
            if (pin)
                return pin;
        }
        const generations = ensureDirectory(root, 'generations');
        collectUnused(generations, currentRecord(root)?.generationId);
        pin = await buildFresh(root, generations, source, signal, request.spawn);
        return pin;
    }
    finally {
        await closePreparationLock(lock, pin);
    }
}
async function closePreparationLock(lock, pin) {
    try {
        lock.close();
    }
    catch (error) {
        // A successful factory result cannot escape if closing its writer failed.
        await pin?.release();
        throw error;
    }
}
async function buildFresh(root, generations, source, signal, spawn) {
    signal.throwIfAborted();
    const id = randomUUID().replaceAll('-', ''), generation = createDirectory(generations, id);
    let hold;
    let published = false;
    try {
        const sourceDirectory = admitDirectory(source.root);
        const sourceBin = admitChildDirectory(admitChildDirectory(sourceDirectory, 'usr'), 'bin');
        let elevated = false;
        try {
            createHardlink(sourceBin, 'bash.exe', generation, '.probe');
        }
        catch (error) {
            if (!error.linkPermissionDenied)
                throw error;
            elevated = true;
        }
        if (!elevated)
            unlinkEntry(generation, '.probe');
        signal.throwIfAborted();
        const base = createDirectory(generation, 'base');
        const validate = () => {
            signal.throwIfAborted();
            createJunction(base, 'bin', admitChildDirectory(admitChildDirectory(base, 'usr'), 'bin'));
            const anchors = captureAnchors(source.root, base.path, source.layout);
            admitBase(generation, source.layout);
            revalidateRoot(root);
            return anchors;
        };
        let anchors;
        if (elevated) {
            anchors = await provisionRuntime({ source: sourceDirectory, cache: root, generation, base, layout: source.layout }, signal, spawn, validate);
        }
        else {
            const files = await inventoryGitFiles(source.root, () => signal.throwIfAborted());
            revalidateDirectory(sourceDirectory);
            revalidateDirectory(base);
            await linkFreshTree({ sourceRoot: source.root, baseRoot: base.path, files }, () => signal.throwIfAborted());
            anchors = validate();
        }
        // Final admission and checked lease closure precede ordinary plan cleanup.
        if (elevated)
            unlinkEntry(generation, 'plan.json');
        hold = pinDirectory(generation);
        const record = { schemaVersion: 1, generationId: id, sourceRoot: source.root, layout: source.layout, anchors };
        signal.throwIfAborted();
        // Entering the atomic write is the cancellation cutoff. Once it succeeds,
        // return its published pin even if aborted; the executor guards adoption.
        await writeFileAtomic(join(root.path, 'current.json'), `${JSON.stringify(record)}\n`, { mode: 0o600, dirMode: 0o700 });
        published = true;
        const pin = new RuntimePin(root, generation, base, record, hold);
        hold = undefined;
        return pin;
    }
    finally {
        hold?.close();
        if (!published)
            bestEffort(() => collectGeneration(generations, id));
    }
}
/** Leave ordinary plan directories for payload traversal after the real plan gates. */
function unlinkPlan(directory) {
    try {
        if (ordinaryChildDirectory(directory, 'plan.json'))
            return;
    }
    catch (error) {
        if (hasCloseFailure(error) || !isMissing(error))
            throw error;
    }
    unlinkEntry(directory, 'plan.json');
}
/** Claims and plan unlink are gates, including for malformed generation names. */
function collectGeneration(generations, name) {
    const directory = ordinaryChildDirectory(generations, name);
    if (!directory) {
        removeTree(generations, name);
        return;
    }
    const claim = claimDirectory(directory);
    try {
        unlinkPlan(directory);
        removeDirectoryTree(directory);
    }
    finally {
        claim.close();
    }
}
function collectUnused(generations, selected) {
    for (const name of children(generations))
        if (name !== selected)
            bestEffort(() => collectGeneration(generations, name));
}
/** Offline only. Preflight every generation before unpublication or payload deletion. */
export async function purgeRuntimeCache(cacheDirectory) {
    const root = admitRoot(cacheDirectory, false);
    if (!root)
        return;
    const lock = await acquireWriterLock(root, new AbortController().signal);
    const claims = [];
    let rootHold;
    try {
        try {
            revalidateRoot(root);
            rootHold = claimDirectory(root);
            const generations = pathExists(join(root.path, 'generations')) ? ordinaryChildDirectory(root, 'generations') : undefined;
            if (generations) {
                for (const name of children(generations)) {
                    const directory = ordinaryChildDirectory(generations, name);
                    if (directory)
                        claims.push({ directory, hold: claimDirectory(directory) });
                }
            }
            for (const { directory } of claims)
                unlinkPlan(directory);
            removeTree(root, 'current.json');
            if (generations) {
                for (const { directory, hold } of claims) {
                    removeDirectoryTree(directory);
                    hold.close();
                }
                for (const name of children(generations)) {
                    if (ordinaryChildDirectory(generations, name))
                        throw new LocalizedError('error.generationAfterPreflight', { name });
                    unlinkEntry(generations, name);
                }
                removeEmptyDirectory(generations);
            }
            for (const name of children(root))
                if (name !== markerName && name !== '.writer-lock')
                    removeTree(root, name);
            unlinkEntry(root, markerName);
        }
        finally {
            closePurgeHolds([...claims.map(claim => claim.hold), lock]);
        }
        removeEmptyDirectory(root);
    }
    finally {
        rootHold?.close();
    }
}
function closePurgeHolds(holds) {
    const errors = [];
    for (const hold of holds) {
        try {
            hold.close();
        }
        catch (error) {
            errors.push(error);
        }
    }
    if (errors.length)
        throw new LocalizedAggregateError(errors, 'error.purgeCloseFailed');
}
/** One native directory hold, shared by an owner and its local uses. */
class RuntimePin {
    root;
    generation;
    base;
    record;
    hold;
    references = 1;
    retired = false;
    ownerRelease;
    namespace;
    namespaceResidue = false;
    instance = randomUUID();
    views = new Map();
    constructor(root, generation, base, record, hold) {
        this.root = root;
        this.generation = generation;
        this.base = base;
        this.record = record;
        this.hold = hold;
    }
    async lease(scope, signal) {
        if (this.retired)
            throw new LocalizedError('error.pinRetired');
        signal.throwIfAborted();
        this.references++;
        let transferred = false;
        let view;
        try {
            const workspace = await canonicalWorkspace(scope.workspaceRoot);
            signal.throwIfAborted();
            if (overlaps(workspace, this.record.sourceRoot) || overlaps(workspace, this.root.path))
                throw new LocalizedError('error.workspaceOverlap');
            const key = scope.sessionId === undefined ? undefined : JSON.stringify([scope.mode, workspace.toLowerCase(), scope.sessionId]);
            view = await this.view(key);
            signal.throwIfAborted();
            let release;
            const use = {
                baseRoot: this.base.path, installationRoot: view, sourceRoot: this.record.sourceRoot, layout: this.record.layout,
                release: () => release ??= this.releaseUse(view, scope.sessionId === undefined),
            };
            transferred = true;
            return use;
        }
        finally {
            if (!transferred)
                await this.releaseUse(view, scope.sessionId === undefined);
        }
    }
    release() {
        if (!this.ownerRelease) {
            this.retired = true;
            this.ownerRelease = this.dropReference();
        }
        return this.ownerRelease;
    }
    view(key) {
        if (key !== undefined) {
            const existing = this.views.get(key);
            if (existing)
                return existing;
        }
        const promise = (async () => {
            // Yield once so even a synchronous creation error is evicted after insertion.
            await Promise.resolve();
            try {
                return createJunction(this.viewParent(), randomUUID(), this.base);
            }
            catch (error) {
                if (key !== undefined)
                    this.views.delete(key);
                throw error;
            }
        })();
        if (key !== undefined)
            this.views.set(key, promise);
        return promise;
    }
    viewParent() {
        if (this.namespace)
            return this.namespace;
        const views = ensureDirectory(this.generation, 'views');
        if (this.namespaceResidue) {
            removeTree(views, this.instance);
            this.namespaceResidue = false;
        }
        try {
            return this.namespace = createDirectory(views, this.instance);
        }
        catch (error) {
            // Only a failed rollback after our own mkdir grants ownership. An
            // unexpected EEXIST must never authorize removal on retry or retirement.
            if (error instanceof DirectoryRollbackError)
                this.namespaceResidue = true;
            throw error;
        }
    }
    async releaseUse(view, agentless) {
        try {
            if (agentless && view && this.namespace)
                bestEffort(() => unlinkEntry(this.namespace, basename(view)));
        }
        finally {
            await this.dropReference();
        }
    }
    async dropReference() {
        this.references--;
        if (this.references !== 0 || !this.retired)
            return;
        try {
            if (this.namespace || this.namespaceResidue)
                bestEffort(() => removeTree(admitChildDirectory(this.generation, 'views'), this.instance));
        }
        finally {
            this.views.clear();
            this.hold.close();
        }
    }
}
