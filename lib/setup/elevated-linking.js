import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { discoverGitInstallation } from '../runtime/git-installation.js';
import { absolutePath, admitChildDirectory, admitDirectory, children, createSetupLease, overlaps, requireActiveLease, sameIdentity, samePath, writeNewMetadata, } from '../runtime/ntfs-filesystem.js';
import { LocalizedAggregateError, LocalizedError } from '../localized-error.js';
const id = z.string().pattern(/^[a-f0-9]{32}$/).required();
const path = z.string().min(3).max(32767).required();
const integer = z.string().pattern(/^\d{1,20}$/).required();
const identity = z.object({ volumeSerial: integer, fileId: integer }).required();
const planSchema = z.object({
    schemaVersion: z.const(1).required(), attemptId: id, sourceRoot: path, cacheRoot: path,
    generationId: id, baseRoot: path, layout: z.union([z.const('ucrt64'), z.const('mingw64')]).required(),
    identities: z.object({ source: identity, cache: identity, generation: identity, base: identity, lease: identity }).required(),
}).required();
export const planByteLimit = 512 * 1024;
export function decodeElevationPlan(value) {
    return planSchema(value);
}
/** Both entries take only the fixed control path, never an executable or file list. */
export function planGeneration(planPath) {
    planPath = absolutePath(planPath);
    if (basename(planPath) !== 'plan.json' || !/^[a-f0-9]{32}$/.test(basename(dirname(planPath)))
        || basename(dirname(dirname(planPath))) !== 'generations')
        throw new LocalizedError('error.generationPlanRequired', { file: 'plan.json' });
    return admitDirectory(dirname(planPath));
}
/** Independently bind the input to existing objects before any privileged mutation. */
export function admitElevationPlan(plan, openedGeneration) {
    const source = admitDirectory(plan.sourceRoot, plan.identities.source);
    const cache = admitDirectory(plan.cacheRoot, plan.identities.cache);
    if (!samePath(source.path, plan.sourceRoot) || !samePath(cache.path, plan.cacheRoot)
        || overlaps(source.path, cache.path) || source.volumeSerial !== cache.volumeSerial)
        throw new LocalizedError('error.invalidSetupBoundary');
    const generation = admitChildDirectory(admitChildDirectory(cache, 'generations'), plan.generationId, plan.identities.generation);
    if (!samePath(generation.path, openedGeneration.path) || !sameIdentity(generation, openedGeneration))
        throw new LocalizedError('error.planOutsideGeneration');
    const base = admitChildDirectory(generation, 'base', plan.identities.base);
    if (!samePath(base.path, absolutePath(plan.baseRoot)))
        throw new LocalizedError('error.unexpectedPlanBase');
    requireActiveLease(generation, plan.identities.lease);
    if (children(base).length)
        throw new LocalizedError('error.nonemptyElevatedBase');
    const selected = discoverGitInstallation(join(source.path, 'usr/bin/bash.exe'));
    if (!samePath(selected.root, source.path) || selected.layout !== plan.layout)
        throw new LocalizedError('error.sourcePlanMismatch');
    return { source, cache, generation, base, layout: plan.layout };
}
const brokerGraceMs = 250;
/** Local broker shutdown failed; ordinary setup rejection does not imply this. */
export class ProvisioningCleanupError extends LocalizedAggregateError {
}
/** A rejected observation is not a join. DSH retains the managed range throughout. */
async function stopBroker(broker) {
    const errors = [];
    let exited = false;
    try {
        exited = await broker.waitForExit(AbortSignal.timeout(brokerGraceMs));
    }
    catch (error) {
        errors.push(error);
    }
    if (!exited) {
        try {
            broker.terminate();
        }
        catch (error) {
            errors.push(error);
        }
    }
    const settled = await Promise.allSettled([broker.done.catch(() => { }), broker.waitForExit()]);
    for (const result of settled)
        if (result.status === 'rejected')
            errors.push(result.reason);
    if (settled[1]?.status === 'fulfilled' && !settled[1].value)
        errors.push(new LocalizedError('error.brokerRangeUnsettled'));
    if (errors.length)
        throw new ProvisioningCleanupError(errors, 'error.brokerCleanupFailed');
}
/** Keep the setup lease through the caller's synchronous final admission. */
export async function provisionRuntime(attempt, signal, spawn, validate) {
    signal.throwIfAborted();
    const lease = createSetupLease(attempt.generation);
    let cancel;
    const cancelled = new Promise(resolve => { cancel = resolve; });
    const errors = [];
    let broker;
    let joined = false;
    let validated;
    const revoke = () => {
        try {
            lease.close();
        }
        catch (error) {
            errors.push(error);
        }
        cancel();
    };
    signal.addEventListener('abort', revoke, { once: true });
    try {
        const fileIdentity = ({ volumeSerial, fileId }) => ({ volumeSerial, fileId });
        const plan = {
            schemaVersion: 1, attemptId: randomUUID().replaceAll('-', ''), sourceRoot: attempt.source.path,
            cacheRoot: attempt.cache.path, generationId: basename(attempt.generation.path), baseRoot: attempt.base.path, layout: attempt.layout,
            identities: {
                source: fileIdentity(attempt.source), cache: fileIdentity(attempt.cache), generation: fileIdentity(attempt.generation),
                base: fileIdentity(attempt.base), lease: fileIdentity(lease.information()),
            },
        };
        writeNewMetadata(attempt.generation, 'plan.json', plan);
        signal.throwIfAborted();
        const child = broker = spawn({
            argv: [process.execPath, fileURLToPath(new URL('./elevation-broker.js', import.meta.url)), join(attempt.generation.path, 'plan.json')],
            cwd: attempt.cache.path, graceMs: brokerGraceMs,
            stdio: { stdin: 'ignore', stdout: { maxBytes: 0 }, stderr: { maxBytes: 8192 } },
            env: { NODE_OPTIONS: undefined },
        });
        // A failed target outcome must revoke setup even if managed descendants
        // remain alive. Only successful exit waits for normal range settlement.
        const successfulExit = child.done.then(outcome => {
            if (outcome.exitCode !== 0 || outcome.signal !== null) {
                const diagnostic = child.collected.stderr?.readFrom(0).text ?? '';
                throw new LocalizedError('error.elevatedSetup', { exit: String(outcome.exitCode), signal: String(outcome.signal) }, { fallback: `Elevated setup failed (exit ${outcome.exitCode}, signal ${outcome.signal}). ${diagnostic}`, diagnostic });
            }
        });
        const result = await Promise.race([Promise.all([successfulExit, child.waitForExit()]), cancelled]);
        signal.throwIfAborted();
        if (!result || !result[1])
            throw new LocalizedError('error.brokerRangeUnsettled');
        joined = true;
        validated = validate();
    }
    catch (error) {
        errors.push(error);
    }
    // Revocation precedes local shutdown even when observation failed. Never use
    // plan unlink as cancellation; the caller retires it after final admission or
    // under the ordinary collector guard when this operation rejects.
    try {
        lease.close();
    }
    catch (error) {
        errors.push(error);
    }
    if (broker && !joined) {
        try {
            await stopBroker(broker);
        }
        catch (error) {
            errors.push(error);
        }
    }
    signal.removeEventListener('abort', revoke);
    if (errors.length === 1)
        throw errors[0];
    if (errors.length)
        throw new LocalizedAggregateError(errors, 'error.elevatedCleanupFailed');
    signal.throwIfAborted();
    return validated;
}
