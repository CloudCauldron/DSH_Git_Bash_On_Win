import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasRuntimeCleanupFailure, prepareRuntime } from './runtime/runtime-cache.js';
import { commandReceiver } from './adapter.js';
import { LocalizedAggregateError, LocalizedError } from './localized-error.js';
/** Cancel a caller's wait without cancelling the shared preparation. */
async function waitForReady(slot, signal) {
    signal.throwIfAborted();
    let abort;
    const cancelled = new Promise((_resolve, reject) => { abort = () => reject(signal.reason); });
    signal.addEventListener('abort', abort, { once: true });
    try {
        return await Promise.race([slot.ready, cancelled]);
    }
    finally {
        signal.removeEventListener('abort', abort);
    }
}
/** Native settings, command mechanics and one lazily owned runtime selection. */
export default class GitBashExecutor extends SandboxBashExecutor {
    static Config = z.object({
        ...SandboxBashExecutor.Config.dict,
        gitBashPath: z.string().volatile(),
    });
    cacheDirectory;
    setupSpawn;
    slot;
    rebuildOp;
    stopping = new AbortController();
    executions = new Map();
    work = new Set();
    cleanup = new Set();
    cleanupErrors = [];
    constructor(ctx, config) {
        if (process.platform !== 'win32' || process.arch !== 'x64')
            throw new LocalizedError('error.pluginPlatform');
        const profile = ctx.get('profileContext');
        if (!profile)
            throw new LocalizedError('error.profileRequired');
        const cacheDirectory = join(profile.dir, '.git-bash-on-win');
        super(ctx, config);
        this.cacheDirectory = cacheDirectory;
        this.setupSpawn = ctx.subprocess.spawn.bind(ctx.subprocess);
        ctx.effect(() => () => this.disposeRuntime());
        ctx.inject(['connection'], scope => {
            scope.connection.fetch.register({
                path: '/api/git-bash-on-win/rebuild', methods: ['POST'], requestBody: 'buffered',
                fetch: async () => {
                    try {
                        await this.rebuildRuntime();
                        return new Response(null, { status: 204 });
                    }
                    catch (error) {
                        return Response.json({ error: error instanceof Error ? error.message : String(error),
                            localized: error instanceof LocalizedError || error instanceof LocalizedAggregateError ? error.localized : undefined }, { status: 500 });
                    }
                },
            });
        });
    }
    track(operation, owned = this.work) {
        owned.add(operation);
        void operation.then(() => owned.delete(operation), () => owned.delete(operation));
        return operation;
    }
    ownCleanup(operation) {
        return this.track(operation.catch(error => {
            this.cleanupErrors.push(error);
            throw error;
        }), this.cleanup);
    }
    retire(slot) {
        slot.controller.abort(new LocalizedError('error.preparationSuperseded', undefined, { fallback: 'Git Bash runtime preparation was superseded.' }));
        if (slot.pin)
            return this.ownCleanup(slot.pin.release());
        return this.track(slot.ready.then(() => { }, error => {
            // Preparation records resource failures at their boundary, independently
            // of retirement timing. Ordinary setup errors have already drained safely.
            if (hasRuntimeCleanupFailure(error))
                throw error;
        }), this.cleanup);
    }
    /** Observation, not Loader events or string equality alone, detaches old work. */
    observeSelection() {
        const selection = this.config.gitBashPath.get();
        const obsolete = new Set();
        if (this.slot && this.slot.selection !== selection) {
            obsolete.add(this.slot);
            this.slot = undefined;
        }
        if (this.rebuildOp && this.rebuildOp.selection !== selection) {
            obsolete.add(this.rebuildOp);
            this.rebuildOp = undefined;
        }
        for (const slot of obsolete)
            void this.retire(slot);
        return selection;
    }
    createSlot(selection, rebuild) {
        const controller = new AbortController();
        const retired = [...this.cleanup];
        // Install the object in slot/rebuildOp before preparation can yield or finish.
        const slot = {
            selection, controller,
            ready: this.track(Promise.resolve().then(async () => {
                await Promise.all(retired);
                if (this.cleanupErrors.length)
                    throw new LocalizedAggregateError(this.cleanupErrors, 'error.priorCleanupFailed');
                this.observeSelection();
                controller.signal.throwIfAborted();
                this.stopping.signal.throwIfAborted();
                const pin = await prepareRuntime({ cacheDirectory: this.cacheDirectory, gitBashPath: selection, rebuild, spawn: this.setupSpawn }, controller.signal).catch(error => {
                    if (hasRuntimeCleanupFailure(error))
                        this.cleanupErrors.push(error);
                    throw error;
                });
                try {
                    this.observeSelection();
                    controller.signal.throwIfAborted();
                    this.stopping.signal.throwIfAborted();
                    if (slot !== (rebuild ? this.rebuildOp : this.slot))
                        throw new LocalizedError('error.stalePreparation');
                    slot.pin = pin;
                    return pin;
                }
                catch (error) {
                    await this.ownCleanup(pin.release());
                    throw error;
                }
            })),
        };
        return slot;
    }
    current(slot, signal) {
        this.observeSelection();
        signal.throwIfAborted();
        this.stopping.signal.throwIfAborted();
        return this.slot === slot && !slot.controller.signal.aborted;
    }
    async acquireUse(spec, signal) {
        if (!spec.sandboxPolicy)
            throw new LocalizedError('error.executionPolicyRequired');
        for (;;) {
            signal.throwIfAborted();
            this.stopping.signal.throwIfAborted();
            const selection = this.observeSelection();
            const slot = this.slot ??= this.createSlot(selection, false);
            let use;
            let transferred = false;
            try {
                const pin = await waitForReady(slot, signal);
                if (!this.current(slot, signal))
                    continue;
                use = await pin.lease(spec.sandboxPolicy, signal).catch(error => {
                    // Lease may unwind its last reference before returning a RuntimeUse.
                    if (hasRuntimeCleanupFailure(error))
                        this.cleanupErrors.push(error);
                    throw error;
                });
                if (this.current(slot, signal)) {
                    transferred = true;
                    return { slot, use };
                }
            }
            catch (error) {
                // Recorded at acquisition, never discarded by stale/cancelled waiters.
                if (hasRuntimeCleanupFailure(error))
                    throw error;
                if (this.current(slot, signal))
                    throw error;
            }
            finally {
                // Transfer only a current, uncancelled use to the command.
                if (use && !transferred)
                    await this.ownCleanup(use.release());
            }
        }
    }
    executeArgv(spec, argvOrPrepare, onStarted) {
        this.stopping.signal.throwIfAborted();
        this.observeSelection();
        spec = { ...spec, signal: spec.signal ? AbortSignal.any([spec.signal, this.stopping.signal]) : this.stopping.signal };
        let use;
        let preparation;
        let started = false;
        let rangeFailed = false;
        const release = () => {
            const held = use;
            use = undefined;
            return held ? this.ownCleanup(held.release()) : Promise.resolve();
        };
        const receiver = commandReceiver(this[Service.extend](), this.ctx, error => {
            rangeFailed = true;
            this.cleanupErrors.push(error);
        });
        const operation = super.executeArgv.call(receiver, spec, signal => {
            preparation = this.track((async () => {
                const acquired = await this.acquireUse(spec, signal);
                use = acquired.use;
                try {
                    // Lease admission precedes the native deferred confinement callback.
                    if (!this.current(acquired.slot, signal))
                        throw new LocalizedError('error.changedBeforeConfinement');
                    const argv = typeof argvOrPrepare === 'function' ? await argvOrPrepare(signal) : argvOrPrepare;
                    if (!this.current(acquired.slot, signal))
                        throw new LocalizedError('error.changedDuringConfinement');
                    const offset = argv.length - 3;
                    if (offset < 0 || argv[offset] !== 'bash' || argv[offset + 1] !== '-c' || argv[offset + 2] !== spec.command)
                        throw new LocalizedError('error.unexpectedShellArguments');
                    return [...argv.slice(0, offset), process.execPath, fileURLToPath(new URL('./bash-launcher.js', import.meta.url)),
                        use.baseRoot, use.installationRoot, use.sourceRoot, use.layout, spec.sandboxPolicy.mode,
                        Buffer.from(spec.command, 'utf8').toString('base64'), String(this.config.graceMs.get())];
                }
                catch (error) {
                    await release();
                    throw error;
                }
            })());
            return preparation;
        }, execution => {
            started = true;
            this.executions.set(execution, release);
            void this.track(execution.done.then(async () => {
                // An unconfirmed range may still use the runtime. Keep its existing
                // owned reference, and report failed disposal; process exit closes it.
                if (rangeFailed)
                    return;
                try {
                    await release();
                }
                finally {
                    this.executions.delete(execution);
                }
            }));
            onStarted?.(execution);
        });
        return this.track(operation.finally(async () => {
            if (!started) {
                // DSH can stop waiting on its callback at the command deadline. Join our
                // short lease/confinement operation before releasing its local reference.
                await preparation?.catch(() => { });
                await release();
            }
        }));
    }
    async rebuildRuntime() {
        this.stopping.signal.throwIfAborted();
        const selection = this.observeSelection();
        if (this.rebuildOp)
            throw new LocalizedError('error.rebuildBusy', undefined, { fallback: 'Git Bash runtime rebuilding is busy.' });
        if (this.slot && !this.slot.pin) {
            const previous = this.slot;
            this.slot = undefined;
            void this.retire(previous);
        }
        const op = this.rebuildOp = this.createSlot(selection, true);
        this.slot ??= op;
        try {
            await op.ready;
            this.observeSelection();
            this.stopping.signal.throwIfAborted();
            op.controller.signal.throwIfAborted();
            if (this.rebuildOp !== op)
                throw new LocalizedError('error.staleRebuild');
            const previous = this.slot;
            this.slot = op;
            if (previous && previous !== op)
                await this.retire(previous);
        }
        finally {
            if (this.rebuildOp === op)
                this.rebuildOp = undefined;
        }
    }
    async disposeRuntime() {
        this.stopping.abort(new LocalizedError('error.providerStopping', undefined, { fallback: 'The Git Bash provider is stopping.' }));
        // Signal executions before waiting for any setup, regardless of selection.
        for (const execution of this.executions.keys()) {
            try {
                execution.kill();
            }
            catch (error) {
                this.cleanupErrors.push(error);
            }
        }
        const slots = new Set([this.slot, this.rebuildOp]);
        this.slot = this.rebuildOp = undefined;
        for (const slot of slots)
            if (slot)
                void this.retire(slot);
        while (this.work.size || this.cleanup.size)
            await Promise.allSettled([...this.work, ...this.cleanup]);
        if (this.cleanupErrors.length)
            throw new LocalizedAggregateError(this.cleanupErrors, 'error.providerCleanupFailed');
    }
}
