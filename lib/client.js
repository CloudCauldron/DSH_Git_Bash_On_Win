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
            const [busy, setBusy] = React.useState(false);
            const locked = React.useRef(false);
            const inputId = React.useId();
            const value = draft?.text ?? snapshot.value?.gitBashPath ?? '';
            const disabled = busy || snapshot.status !== 'ready';
            async function savePath(change, text, revision) {
                try {
                    if (await shellForm.mutate([change], revision))
                        return true;
                    const confirmed = shellForm.getSnapshot();
                    if (confirmed.status === 'ready') {
                        setDraft({ text, revision: confirmed.revision });
                        setFeedback({ key: 'save.review', path: confirmed.value?.gitBashPath });
                    }
                    else {
                        setDraft({ text, revision });
                        setFeedback({ key: 'save.failed' });
                    }
                }
                catch (error) {
                    setDraft({ text, revision });
                    setFeedback({ key: 'save.failed', reason: error instanceof Error ? error.message : String(error) });
                }
                return false;
            }
            async function saveAndLink() {
                if (locked.current)
                    return;
                locked.current = true;
                setBusy(true);
                try {
                    const latest = shellForm.getSnapshot();
                    if (latest.status !== 'ready')
                        return;
                    const text = draft?.text ?? latest.value?.gitBashPath ?? '';
                    const change = pathChange(text, latest);
                    if (change && !latest.writable)
                        return;
                    setFeedback(undefined);
                    if (change && !await savePath(change, text, draft ? draft.revision : latest.revision))
                        return;
                    setDraft(undefined);
                    try {
                        const response = await fetch('api/git-bash-on-win/rebuild', { method: 'POST', redirect: 'error' });
                        if (!response.ok)
                            throw new Error(await response.text() || `HTTP ${response.status}`);
                        setFeedback({ key: 'link.ok' });
                    }
                    catch (error) {
                        setFeedback({ key: change ? 'link.failedAfterSave' : 'link.failed', reason: error instanceof Error ? error.message : String(error) });
                    }
                }
                finally {
                    locked.current = false;
                    setBusy(false);
                }
            }
            let message;
            if (feedback?.key === 'link.ok')
                message = t(feedback.key);
            else if (feedback?.key === 'save.review')
                message = t(feedback.key, { path: feedback.path || t('path.empty') });
            else if (feedback)
                message = t(feedback.key, { reason: feedback.reason ?? t('form.unavailable') });
            const status = snapshot.status !== 'ready' ? 'form.' + snapshot.status : !snapshot.writable ? 'form.readOnly' : undefined;
            const h = React.createElement;
            return h('div', null, h('label', { htmlFor: inputId }, t('path.label')), h('div', { style: { display: 'flex', alignItems: 'center', gap: '0.5rem' } }, h(Input, { id: inputId, value, placeholder: t('path.placeholder'), disabled: disabled || !snapshot.writable,
                onChange(event) {
                    const text = event.currentTarget.value;
                    setDraft(previous => ({ text, revision: previous ? previous.revision : snapshot.revision }));
                    setFeedback(undefined);
                },
            }), h(Button, { type: 'button', disabled: disabled || (!snapshot.writable && !!pathChange(value, snapshot)),
                onClick: () => { void saveAndLink(); },
            }, t('action.saveLink'))), status && h('p', { role: 'status' }, t(status)), message && h('p', { role: 'status' }, message));
        }
        function isDictionary(value) {
            return typeof value === 'object' && value !== null && !Array.isArray(value)
                && Object.values(value).every(message => typeof message === 'string');
        }
        return {
            inject: ['slots', 'configForms', 'locale'],
            async apply(ctx) {
                const response = await fetch('api/git-bash-on-win/locales', { cache: 'no-store', redirect: 'error' });
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
