"use strict";
window.__ModuleLoader__.load({
    id: 'dsh-git-bash-on-win',
    factory(require) {
        const ns = 'dsh-git-bash-on-win';
        const React = require('react');
        const { Input, Button } = require('@deepseek-ai/dsh-client-ui-primitives');
        function pathChange(text, snapshot) {
            if (!text.trim()) {
                if (snapshot.user && Object.hasOwn(snapshot.user, 'gitBashPath'))
                    return { op: 'unset', path: ['gitBashPath'] };
            }
            else if (text !== snapshot.value?.gitBashPath) {
                return { op: 'set', path: ['gitBashPath'], value: text };
            }
        }
        function GitBashPage({ t, shellForm, useShellForm }) {
            const snapshot = useShellForm(s => s);
            const [draft, setDraft] = React.useState();
            const [feedback, setFeedback] = React.useState();
            const [saving, setSaving] = React.useState(false);
            const locked = React.useRef(false);
            const inputId = React.useId();
            const value = draft?.text ?? snapshot.value?.gitBashPath ?? '';
            const disabled = saving || snapshot.status !== 'ready';
            async function save() {
                if (locked.current)
                    return;
                const latest = shellForm.getSnapshot();
                if (latest.status !== 'ready')
                    return;
                const text = draft?.text ?? latest.value?.gitBashPath ?? '';
                const change = pathChange(text, latest);
                if (change && !latest.writable)
                    return;
                const revision = draft ? draft.revision : latest.revision;
                locked.current = true;
                setSaving(true);
                setFeedback(undefined);
                try {
                    if (change && !await shellForm.mutate([change], revision)) {
                        const confirmed = shellForm.getSnapshot();
                        if (confirmed.status === 'ready') {
                            setDraft({ text, revision: confirmed.revision });
                            setFeedback({ key: 'save.review', path: confirmed.value?.gitBashPath });
                        }
                        else {
                            setDraft({ text, revision });
                            setFeedback({ key: 'save.failed' });
                        }
                        return;
                    }
                    setDraft(undefined);
                }
                catch (error) {
                    setDraft({ text, revision });
                    setFeedback({ key: 'save.failed', reason: error instanceof Error ? error.message : String(error) });
                }
                finally {
                    locked.current = false;
                    setSaving(false);
                }
            }
            const status = snapshot.status !== 'ready' ? 'form.' + snapshot.status : !snapshot.writable ? 'form.readOnly' : undefined;
            const h = React.createElement;
            return h('div', null, h('label', { htmlFor: inputId }, t('path.label')), h('div', { style: { display: 'flex', alignItems: 'center', gap: '0.5rem' } }, h(Input, { id: inputId, value, placeholder: t('path.placeholder'), disabled: disabled || !snapshot.writable,
                onChange(event) {
                    const text = event.currentTarget.value;
                    setDraft(previous => ({ text, revision: previous ? previous.revision : snapshot.revision }));
                    setFeedback(undefined);
                },
            }), h(Button, { type: 'button', disabled: disabled || (!snapshot.writable && !!pathChange(value, snapshot)),
                onClick: () => { void save(); },
            }, t('action.saveLink'))), status && h('p', { role: 'status' }, t(status)), feedback && h('p', { role: 'status' }, feedback.key === 'save.review'
                ? t(feedback.key, { path: feedback.path || t('path.empty') })
                : t(feedback.key, { reason: feedback.reason ?? t('form.unavailable') })));
        }
        function isDictionary(value) {
            return typeof value === 'object' && value !== null && !Array.isArray(value)
                && Object.values(value).every(message => typeof message === 'string');
        }
        return {
            inject: ['slots', 'configForms', 'locale'],
            async apply(ctx) {
                const response = await fetch('api/git-bash-on-win/locales', { cache: 'no-store' });
                if (ctx.fiber.uid === null)
                    return;
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
