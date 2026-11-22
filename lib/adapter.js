import { registerCatalogs } from './locale/catalogs.js';
import { LocalizedError } from './locale/errors.js';
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
            throw new LocalizedError('error.customizedModule', { id: entry.options.id });
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
        throw new LocalizedError('error.shellEntryRequired', { entry: 'pwsh-sandbox' });
    ctx.provide('gitBashAdapter', {});
    if (process.arch === 'x64') {
        ctx.inject(['profileContext', 'connection'], scope => {
            registerCatalogs(scope.connection.fetch, 'git-bash-on-win');
        });
    }
}
