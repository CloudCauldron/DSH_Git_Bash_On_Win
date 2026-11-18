"use strict";
window.__ModuleLoader__.load({
    id: 'dsh-git-bash-on-win',
    factory(require) {
        const ns = 'dsh-git-bash-on-win';
        const React = require('react');
        const { Tag } = require('@deepseek-ai/dsh-client-ui-primitives');
        function GitBashPage({ t, useShellForm }) {
            const status = useShellForm(snapshot => snapshot.status);
            if (status === 'ready')
                return null;
            return React.createElement(Tag, null, t('form.' + status));
        }
        function isDictionary(value) {
            return typeof value === 'object' && value !== null && !Array.isArray(value)
                && Object.values(value).every(message => typeof message === 'string');
        }
        return {
            inject: ['slots', 'configForms', 'locale'],
            async apply(ctx) {
                const response = await fetch('api/git-bash-on-win/locales', { cache: 'no-store' });
                if (!response.ok)
                    throw new Error(`Git Bash locales: HTTP ${response.status}`);
                const data = await response.json();
                if (ctx.fiber.uid === null)
                    return;
                const { zh, en } = data?.dictionaries ?? {};
                if (data?.ok !== true || !isDictionary(zh) || !isDictionary(en)) {
                    throw new Error('Invalid Git Bash locale dictionaries.');
                }
                for (const [lang, messages] of Object.entries({ zh, en })) {
                    ctx.effect(() => ctx.locale.register(ns, lang, messages));
                }
                const form = ctx.configForms.get('pwsh-sandbox');
                ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
                    name: 'plugins.bundle.config', key: ns, locale: ns,
                    inject: () => ({ shellForm: form, hooks: { shellForm: form } }),
                }, GitBashPage));
            },
        };
    },
});
