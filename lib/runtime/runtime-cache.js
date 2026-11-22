import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import z from '@deepseek-ai/schemastery';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { absolutePath, acquireWriterLock, admitChildDirectory, admitDirectory, admitJunction, bestEffort, children, claimDirectory, createDirectory, createJunction, ensureDirectory, InvalidFileSizeError, isBusy, isMissing, openOrdinaryFile, ordinaryChildDirectory, overlaps, pathExists, pinDirectory, readFileBytes, readMetadata, removeDirectoryTree, removeEmptyDirectory, removeTree, sameIdentity, samePath, unlinkEntry, writeNewMetadata, } from './ntfs-filesystem.js';
import { admitCopyJunctions, buildCopyLayout, discoverGitInstallation, payloadLimit, readSourceFreshness, requireViewPathBudget } from './git-installation.js';
import { LocalizedAggregateError, LocalizedError } from '../locale/errors.js';
export const sharedCacheDirectory = (home) => join(home, '.dsh-git-bash-on-win');
export const bundledShimUrl = new URL('../../lib/dsh-msys-compat.dll', import.meta.url);
const nonce = () => randomBytes(8).toString('hex');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const markerName = '.owner.json';
const generationId = z.string().pattern(/^[a-f0-9]{16}$/).required();
const pathSchema = z.string().min(3).max(32767).required();
const integerString = z.string().pattern(/^\d{1,20}$/).required();
const identityFields = { volumeSerial: integerString, fileId: integerString };
const markerSchema = z.object({
    schemaVersion: z.const(2).required(), owner: z.const('dsh-git-bash-on-win').required(),
    rootPath: pathSchema, ...identityFields,
}).required();
const stamp = z.object({ ...identityFields, size: integerString, lastWriteTime: integerString }).required();
const currentSchema = z.object({
    schemaVersion: z.const(2).required(), patchAbi: z.const(1).required(), generationId, sourceRoot: pathSchema,
    sourceIdentity: z.object(identityFields).required(), layout: z.union([z.const('ucrt64'), z.const('mingw64')]).required(),
    sourceFreshness: z.object({ git: stamp, msys: stamp, packageVersionsSha256: z.any() }).required(),
    patchedMsysSha256: z.string().pattern(/^[a-f0-9]{64}$/).required(),
}).required();
function writeOwnerMarker(root) {
    writeNewMetadata(root, markerName, { schemaVersion: 2, owner: 'dsh-git-bash-on-win',
        rootPath: root.path, volumeSerial: root.volumeSerial, fileId: root.fileId });
}
/** A marker authorizes the whole interior, but never an external reparse target. */
function admitRoot(path, create) {
    path = absolutePath(path);
    if (!pathExists(path)) {
        if (!create) {
            admitDirectory(dirname(path));
            return undefined;
        }
        const parent = admitDirectory(dirname(path));
        const root = createDirectory(parent, basename(path));
        try {
            writeOwnerMarker(root);
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
        if (isMissing(error) || error instanceof SyntaxError || error instanceof InvalidFileSizeError)
            return undefined;
        throw error;
    }
    try {
        const record = currentSchema(raw);
        if (record.sourceFreshness.packageVersionsSha256 !== null && !/^[a-f0-9]{64}$/.test(record.sourceFreshness.packageVersionsSha256))
            return undefined;
        if (absolutePath(record.sourceRoot) !== record.sourceRoot)
            return undefined;
        return record;
    }
    catch {
        return undefined;
    }
}
function tryWarm(root, source, layout, shimHash) {
    const record = currentRecord(root);
    if (!record)
        return;
    let generation, hold;
    try {
        generation = admitChildDirectory(admitChildDirectory(root, 'g'), record.generationId);
        hold = pinDirectory(generation);
    }
    catch (error) {
        if (isMissing(error) || isBusy(error))
            return;
        throw error;
    }
    let transferred = false;
    try {
        if (currentRecord(root)?.generationId !== record.generationId || record.layout !== layout
            || !samePath(source.path, record.sourceRoot) || !sameIdentity(source, record.sourceIdentity)
            || !isDeepStrictEqual(readSourceFreshness(source, layout), record.sourceFreshness))
            return;
        const runtime = admitChildDirectory(generation, 'r'), views = admitChildDirectory(generation, 'v');
        const bin = admitChildDirectory(admitChildDirectory(runtime, 'usr'), 'bin');
        admitCopyJunctions(runtime, source, layout);
        try {
            for (const name of ['bash.exe', 'sh.exe'])
                openOrdinaryFile(bin, name).close();
            if (digest(readFileBytes(bin, 'msys-2.0.dll', payloadLimit)) !== record.patchedMsysSha256
                || digest(readFileBytes(bin, 'dsh-msys-compat.dll', payloadLimit)) !== shimHash)
                return;
        }
        catch (error) {
            if (isMissing(error))
                return;
            throw error;
        }
        const pin = new RuntimePin(root, runtime, views, record, hold);
        transferred = true;
        return pin;
    }
    finally {
        if (!transferred)
            hold.close();
    }
}
export async function prepareRuntime(request, signal) {
    signal.throwIfAborted();
    const installation = discoverGitInstallation(request.gitBashPath), source = admitDirectory(installation.root);
    const requested = absolutePath(request.cacheDirectory);
    const parent = admitDirectory(dirname(requested)), path = join(parent.path, basename(requested));
    if (overlaps(path, source.path))
        throw new LocalizedError('error.cacheOverlap');
    requireViewPathBudget(join(path, 'g/ffffffffffffffff/v/ww-4294967295-4294967295-ffffffffffffffff'));
    const shim = await readFile(bundledShimUrl), shimHash = digest(shim);
    signal.throwIfAborted();
    if (!request.rebuild) {
        let root;
        try {
            root = admitRoot(path, false);
        }
        catch (error) {
            // A competing writer may still be installing its first owner marker.
            if (!isMissing(error) && !(error instanceof SyntaxError))
                throw error;
        }
        if (root) {
            if (overlaps(root.path, source.path))
                throw new LocalizedError('error.cacheOverlap');
            const warm = tryWarm(root, source, installation.layout, shimHash);
            if (warm)
                return warm;
        }
    }
    let pin;
    try {
        using _lock = await acquireWriterLock(path, signal);
        signal.throwIfAborted();
        const root = admitRoot(path, true);
        if (overlaps(root.path, source.path))
            throw new LocalizedError('error.cacheOverlap');
        using _root = pinDirectory(root);
        pin = request.rebuild ? undefined : tryWarm(root, source, installation.layout, shimHash);
        return pin ??= await buildFresh(root, source, installation, shim, signal);
    }
    catch (error) {
        await pin?.release();
        if (error instanceof SuppressedError && error.suppressed === signal.reason)
            throw error.error;
        throw error;
    }
}
async function buildFresh(root, source, installation, shim, signal) {
    const { layout } = installation, sourceFreshness = readSourceFreshness(source, layout);
    const generations = ensureDirectory(root, 'g'), selected = currentRecord(root)?.generationId;
    for (const name of children(generations)) {
        if (name.toLowerCase() !== selected)
            bestEffort(() => collectGeneration(generations, name));
    }
    const id = nonce(), generation = createDirectory(generations, id);
    let hold, published = false;
    try {
        const { runtime, views, patchedMsysSha256 } = await buildCopyLayout(generation, installation, shim, signal);
        const checked = discoverGitInstallation(join(source.path, 'usr/bin/bash.exe'));
        if (checked.layout !== layout || !sameIdentity(admitDirectory(checked.root), source)
            || !isDeepStrictEqual(readSourceFreshness(source, layout), sourceFreshness))
            throw new LocalizedError('error.sourceChanged');
        revalidateRoot(root);
        const { volumeSerial, fileId } = source;
        const record = { schemaVersion: 2, patchAbi: 1, generationId: id, sourceRoot: source.path,
            sourceIdentity: { volumeSerial, fileId }, layout, sourceFreshness, patchedMsysSha256 };
        hold = pinDirectory(generation);
        signal.throwIfAborted();
        await writeFileAtomic(join(root.path, 'current.json'), JSON.stringify(record) + '\n', { mode: 0o600, dirMode: 0o700 });
        published = true;
        if (selected)
            bestEffort(() => collectGeneration(generations, selected));
        const pin = new RuntimePin(root, runtime, views, record, hold);
        hold = undefined;
        return pin;
    }
    finally {
        hold?.close();
        if (!published)
            bestEffort(() => collectGeneration(generations, id));
    }
}
function collectGeneration(generations, name) {
    const directory = ordinaryChildDirectory(generations, name);
    if (!directory) {
        removeTree(generations, name);
        return;
    }
    const claim = claimDirectory(directory);
    try {
        removeDirectoryTree(directory, claim);
    }
    finally {
        claim.close();
    }
}
/** Offline only. Preflight every generation before unpublication or payload deletion. */
export async function purgeRuntimeCache(cacheDirectory) {
    const path = absolutePath(cacheDirectory);
    using lock = await acquireWriterLock(path);
    const root = admitRoot(path, false);
    if (root)
        purgeOwnedRoot(root);
    lock.close();
    // A metadata observer can keep a delete-on-close lock name pending.
    const rootName = basename(path).toLowerCase(), lockName = basename(lock.path).toLowerCase();
    if (children(admitDirectory(dirname(path))).some(name => [rootName, lockName].includes(name.toLowerCase()))) {
        throw new LocalizedError('error.purgeIncomplete');
    }
}
function purgeOwnedRoot(root) {
    const claims = [];
    using rootHold = claimDirectory(root);
    try {
        const generations = pathExists(join(root.path, 'g')) ? ordinaryChildDirectory(root, 'g') : undefined;
        if (generations) {
            for (const name of children(generations)) {
                const directory = ordinaryChildDirectory(generations, name);
                if (directory)
                    claims.push({ directory, hold: claimDirectory(directory) });
            }
        }
        removeTree(root, 'current.json');
        if (generations) {
            for (const { directory, hold } of claims) {
                removeDirectoryTree(directory, hold);
                hold.close();
            }
            for (const name of children(generations)) {
                if (ordinaryChildDirectory(generations, name))
                    throw new LocalizedError('error.generationAfterPreflight', { name });
                unlinkEntry(generations, name);
            }
            removeEmptyDirectory(generations);
        }
        const entries = children(root);
        const marker = entries.includes(markerName) ? markerName : entries.find(name => name.toLowerCase() === markerName);
        for (const name of entries)
            if (name !== marker)
                removeTree(root, name);
    }
    finally {
        closePurgeHolds(claims.map(claim => claim.hold));
    }
    unlinkEntry(root, markerName);
    try {
        rootHold.deleteEntry();
    }
    catch (error) {
        rootHold.close();
        writeOwnerMarker(root);
        throw error;
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
class RuntimePin {
    references = 1;
    retired;
    sessions = new Map();
    root;
    runtime;
    views;
    record;
    hold;
    constructor(root, runtime, views, record, hold) {
        this.root = root;
        this.runtime = runtime;
        this.views = views;
        this.record = record;
        this.hold = hold;
    }
    acquireUse() {
        if (this.retired)
            throw new LocalizedError('error.pinRetired');
        this.references++;
        let ephemeral, release;
        return {
            cacheRoot: this.root.path, sourceRoot: this.record.sourceRoot, layout: this.record.layout,
            bindView: ({ prefix, workspace, sessionId }) => {
                const key = sessionId === undefined ? undefined : JSON.stringify([prefix, workspace, sessionId]);
                const existing = key === undefined ? ephemeral : this.sessions.get(key);
                if (existing) {
                    admitJunction(this.views, basename(existing), this.runtime);
                    return existing;
                }
                const name = prefix + '-' + nonce();
                requireViewPathBudget(join(this.views.path, name));
                const path = createJunction(this.views, name, this.runtime);
                if (key === undefined)
                    ephemeral = path;
                else
                    this.sessions.set(key, path);
                return path;
            },
            release: () => release ??= this.dropReference(ephemeral),
        };
    }
    release() { return this.retired ??= this.dropReference(); }
    async dropReference(ephemeral) {
        try {
            if (ephemeral)
                bestEffort(() => unlinkEntry(this.views, basename(ephemeral)));
        }
        finally {
            if (--this.references === 0) {
                try {
                    for (const view of this.sessions.values())
                        bestEffort(() => unlinkEntry(this.views, basename(view)));
                }
                finally {
                    this.sessions.clear();
                    this.hold.close();
                }
            }
        }
    }
}
