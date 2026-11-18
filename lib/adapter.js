/** The pinned native Shell waits for target done, not managed-range settlement.
 * Shadow only this invocation's lookup; the provider still owns all processes. */
export function commandReceiver(receiver, ctx, onRangeFailure) {
    const provider = ctx.subprocess;
    const scoped = ctx.extend({ subprocess: {
            spawn(spec) {
                const child = provider.spawn(spec);
                const join = async () => {
                    try {
                        if (!await child.waitForExit())
                            throw new Error('DSH command range settlement was not confirmed.');
                    }
                    catch (error) {
                        onRangeFailure(error);
                        throw error;
                    }
                };
                return { ...child, done: child.done.then(async (outcome) => { await join(); return outcome; }, async (error) => { await join(); throw error; }) };
            },
        } });
    // Cordis traces ctx as read-only through the inherited service proxy. Define
    // it on the derived receiver instead of assigning through that proxy.
    Object.defineProperty(receiver, 'ctx', { value: scoped });
    return receiver;
}
export const inject = { loader: { await: false } };
/** Mount replacement providers in native entries, preserving their settings identity. */
export async function apply(ctx) {
    if (process.platform !== 'win32')
        return;
    const modules = {
        'pwsh-sandbox': ['@deepseek-ai/dsh-pwsh-sandbox', 'dsh-git-bash-on-win/executor'],
        'tool-pwsh': ['@deepseek-ai/dsh-tool-pwsh', 'dsh-git-bash-on-win/tool'],
        'preset-standard': ['@deepseek-ai/dsh-agent-preset', 'dsh-git-bash-on-win/preset'],
        'preset-ptc': ['@deepseek-ai/dsh-agent-preset', 'dsh-git-bash-on-win/preset'],
        'preset-cordis': ['@deepseek-ai/dsh-agent-preset', 'dsh-git-bash-on-win/preset'],
    };
    const changed = [];
    const disposeEntry = async (entry) => {
        const disabled = entry.options.disabled;
        // Loader interprets disposal of an enabled entry as a user disable and
        // persists it. Mark only this in-memory transition disabled so it does
        // not write a profile patch while we replace the pending fiber.
        entry.options.disabled = true;
        try {
            await entry.fiber?.dispose();
            entry.fiber = undefined;
        }
        finally {
            entry.options.disabled = disabled;
        }
    };
    ctx.effect(() => async () => {
        for (const { entry, namespace } of changed.reverse()) {
            await disposeEntry(entry);
            entry.moduleNamespace = namespace;
        }
    });
    for (const entry of ctx.loader.entries()) {
        const replacement = modules[entry.options.id];
        if (!replacement)
            continue;
        if (entry.options.name !== replacement[0])
            throw new Error(`Cannot adapt the customized ${entry.options.id} module; the shell was not replaced.`);
        // Finish an already-started import while the gate keeps its original
        // provider pending. Otherwise init() could reuse that import's namespace.
        await entry.refresh();
        // Keep the canonical name: ConfigEditor writes name-qualified patches.
        // A replacement fiber uses the same entry context/config and native ID.
        await disposeEntry(entry);
        changed.push({ entry, namespace: entry.moduleNamespace });
        const namespace = await entry.parent.tree.import(replacement[1]);
        const plugin = ctx.loader.unwrapExports(namespace);
        if (!entry.disabled)
            entry.fiber = entry.ctx.plugin(plugin, entry.options.config);
        entry.moduleNamespace = namespace;
    }
    if (!changed.some(({ entry }) => entry.options.id === 'pwsh-sandbox'))
        throw new Error('The native pwsh-sandbox entry is required.');
    ctx.provide('gitBashAdapter', {});
}
