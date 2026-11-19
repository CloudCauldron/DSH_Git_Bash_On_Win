"use strict";
window.__ModuleLoader__.load({
    id: 'dsh-git-bash-on-win',
    factory(require) {
        const ns = 'dsh-git-bash-on-win';
        const React = require('react');
        const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');
        const { SettingsForm, SettingsValueField, Button, Modal, Toast } = require('@deepseek-ai/dsh-client-ui-primitives');
        const feedbackUrl = 'api/git-bash-on-win/feedback';
        function pathChange(text, snapshot) {
            if (!text.trim()) {
                if (snapshot.user && Object.hasOwn(snapshot.user, 'gitBashPath'))
                    return { op: 'unset', path: ['gitBashPath'] };
            }
            else if (text !== snapshot.value?.gitBashPath) {
                return { op: 'set', path: ['gitBashPath'], value: text };
            }
        }
        function GitBashPage({ t, shellForm, useShellForm, useLinkProgress, notify }) {
            const snapshot = useShellForm(s => s);
            const [draft, setDraft] = React.useState();
            const [busy, setBusy] = React.useState(false);
            const progress = useLinkProgress(p => busy ? p : undefined);
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
                        notify({ key: 'save.review', path: confirmed.value?.gitBashPath });
                    }
                    else {
                        setDraft({ text, revision });
                        notify({ key: 'save.failed' });
                    }
                }
                catch (error) {
                    setDraft({ text, revision });
                    notify({ key: 'save.failed', reason: { error: error instanceof Error ? error.message : String(error) } });
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
                    if (change && !await savePath(change, text, draft ? draft.revision : latest.revision))
                        return;
                    setDraft(undefined);
                    const failureKey = change ? 'link.failedAfterSave' : 'link.failed';
                    try {
                        const response = await fetch('api/git-bash-on-win/rebuild', { method: 'POST', redirect: 'error' });
                        if (response.ok)
                            notify({ key: 'link.ok' });
                        else
                            notify({ key: failureKey, reason: await readFailure(response) });
                    }
                    catch (error) {
                        notify({ key: failureKey, reason: { error: error instanceof Error ? error.message : String(error) } });
                    }
                }
                finally {
                    locked.current = false;
                    setBusy(false);
                }
            }
            const h = React.createElement;
            let hint = t('path.hint');
            if (typeof progress === 'object') {
                hint = progress.completed !== undefined
                    ? t('link.files', { count: String(progress.completed), total: String(progress.total), path: progress.path })
                    : t('link.path', { path: progress.path });
            }
            else if (progress) {
                hint = t('link.' + progress);
            }
            return h('div', { className: 'dsh-git-bash-settings', 'data-linking': progress ? true : undefined,
                title: typeof progress === 'object' ? progress.path : undefined }, h('style', null, `
          .dsh-git-bash-settings > div { display: grid; grid-template-columns: minmax(0, 1fr) max-content; align-items: center; gap: 0.5rem; }
          .dsh-git-bash-settings > div > :last-child { padding-top: 0; }
          .dsh-git-bash-settings[data-linking] p[id] { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        `), h(SettingsForm, {
                // Rebuilding a saved path is an action even when the settings document is clean or read-only.
                state: { available: true, writable: true, dirty: !disabled && (snapshot.writable || !pathChange(value, snapshot)),
                    invalid: false, saving: busy, failed: false },
                labels: { unavailable: t('form.unavailable'), readOnly: '', saveFailed: t('save.failed'),
                    save: t('action.saveLink'), saving: t('action.linking') },
                onSave: () => { void saveAndLink(); }, onDiscard() { },
            }, h(SettingsValueField, {
                id: inputId, label: t('path.label'), placeholder: t('path.placeholder'), hint,
                text: value, disabled: disabled || !snapshot.writable,
                overridden: false, overriddenLabel: '', resetLabel: '', onReset() { }, invalid: false, invalidLabel: '',
                onEdit(text) {
                    setDraft(previous => ({ text, revision: previous ? previous.revision : snapshot.revision }));
                },
            })));
        }
        async function readFailure(response) {
            const text = await response.text();
            if (response.headers.get('content-type')?.includes('application/json')) {
                try {
                    const failure = JSON.parse(text);
                    if (typeof failure?.error === 'string')
                        return failure;
                }
                catch { /* Keep the original response if the host or proxy sent invalid JSON. */ }
            }
            return { error: text || `HTTP ${response.status}` };
        }
        function answer(action, id) {
            return fetch(feedbackUrl + '?action=' + action + '&id=' + encodeURIComponent(id), { method: 'POST', redirect: 'error' });
        }
        // Split the translated template before inserting values so even a path containing braces stays literal.
        function withCode(template, params) {
            if (!params)
                return template;
            return template.split(/(\{\w+\})/g).map((part, index) => {
                const name = part.slice(1, -1);
                return part.startsWith('{') && Object.hasOwn(params, name)
                    ? React.createElement('code', { key: index, style: { overflowWrap: 'anywhere' } }, params[name]) : part;
            });
        }
        function isDictionary(value) {
            return typeof value === 'object' && value !== null && !Array.isArray(value)
                && Object.values(value).every(message => typeof message === 'string');
        }
        return {
            inject: ['slots', 'configForms', 'locale', 'remote'],
            async apply(ctx) {
                const response = await fetch('api/git-bash-on-win/locales', { cache: 'no-store', redirect: 'error' });
                if (ctx.fiber.uid === null)
                    return;
                if (!response.ok) {
                    throw Object.assign(new Error(`Git Bash locales: HTTP ${response.status}`), {
                        localized: { key: 'error.localeHttp', params: { status: String(response.status) } },
                    });
                }
                const data = await response.json();
                if (ctx.fiber.uid === null)
                    return;
                const { zh, en } = data?.dictionaries ?? {};
                if (data?.ok !== true || !isDictionary(zh) || !isDictionary(en)) {
                    throw Object.assign(new Error('Invalid Git Bash locale dictionaries.'), { localized: { key: 'error.invalidLocaleDictionaries' } });
                }
                ctx.effect(() => ctx.locale.register(ns, 'zh', zh));
                ctx.effect(() => ctx.locale.register(ns, 'en', en));
                const progress = createSnapshotStore(undefined);
                const notices = createSnapshotStore(null);
                let sequence = 0;
                const notify = (message) => notices.set({ ...message, id: ++sequence });
                // Mount the browser projection once per plugin lifetime. The executor may start after this settings page.
                let projection;
                async function mountFeedback(signal) {
                    const reply = await fetch(feedbackUrl, { signal, cache: 'no-store', redirect: 'error' });
                    if (!reply.ok)
                        throw new Error('Git Bash feedback: HTTP ' + reply.status);
                    const contract = await reply.json();
                    signal.throwIfAborted();
                    await ctx.remote.$mount(contract);
                }
                function FeedbackOverlay({ t }) {
                    const local = React.useSyncExternalStore(notices.subscribe, notices.getSnapshot);
                    const [automatic, setAutomatic] = React.useState({});
                    const [submitted, setSubmitted] = React.useState();
                    const watching = React.useRef(false);
                    React.useEffect(() => {
                        const controller = new AbortController();
                        let retry;
                        const connect = async () => {
                            try {
                                await (projection ??= mountFeedback(controller.signal).catch(error => { projection = undefined; throw error; }));
                                if (controller.signal.aborted)
                                    return;
                                for await (const snapshot of ctx.get('remote.gitBashFeedback').watch(controller.signal)) {
                                    if (controller.signal.aborted)
                                        return;
                                    watching.current = true;
                                    progress.set(snapshot.progress);
                                    setAutomatic(snapshot);
                                    if (snapshot.success)
                                        notify({ key: 'link.ok' });
                                }
                            }
                            catch { /* The next subscription receives the pending confirmation and undismissed failure. */ }
                            if (!controller.signal.aborted) {
                                progress.set(undefined);
                                watching.current = false;
                                setAutomatic(previous => ({ failure: previous.failure }));
                                retry = setTimeout(() => { void connect(); }, 1500);
                            }
                        };
                        void connect();
                        return () => { controller.abort(); clearTimeout(retry); progress.set(undefined); };
                    }, []);
                    // Send consent only after React has committed the closed dialog.
                    React.useEffect(() => {
                        if (!submitted)
                            return;
                        const retry = () => setSubmitted(current => current === submitted ? undefined : current);
                        void answer('confirm', submitted).then(response => {
                            if (!response.ok && response.status !== 409)
                                retry();
                        }, retry);
                    }, [submitted]);
                    const confirmation = automatic.confirmation;
                    const open = confirmation && confirmation.id !== submitted;
                    React.useLayoutEffect(() => {
                        if (open) {
                            const close = document.querySelector('.dsh-git-bash-confirm button[aria-label]');
                            if (close)
                                close.disabled = true;
                        }
                    }, [open, confirmation?.id]);
                    if (open) {
                        return React.createElement(Modal, { key: 'confirmation', open: true, className: 'dsh-git-bash-confirm', title: 'Git Bash',
                            description: t(confirmation.sourceChanged ? 'link.confirmChanged' : 'link.confirmSetup'),
                            closeLabel: t('close'), onClose() { },
                            footer: React.createElement(Button, { type: 'button', autoFocus: true,
                                onClick: () => setSubmitted(confirmation.id) }, t('action.confirm')) });
                    }
                    const failure = automatic.failure;
                    const notice = failure ? { key: 'link.failed', ...failure } : local;
                    if (!notice)
                        return null;
                    const dismiss = () => {
                        if (failure) {
                            const close = () => setAutomatic(previous => previous.failure?.id === failure.id ? { ...previous, failure: undefined } : previous);
                            if (!watching.current) {
                                close();
                                return;
                            }
                            void answer('dismiss', failure.id).then(response => {
                                if (response.ok || response.status === 404 || response.status === 409)
                                    close();
                            }, () => { }); // Keep the close action available while the host still owns the failure.
                        }
                        else if (notices.getSnapshot() === local)
                            notices.set(null);
                    };
                    if (notice.key === 'link.ok') {
                        return React.createElement(Toast, { key: notice.id, text: t(notice.key), tone: 'success', onDone: dismiss });
                    }
                    let description;
                    let diagnostic;
                    if (notice.key === 'save.review') {
                        description = notice.path?.trim() ? withCode(t('save.reviewDetail'), { path: notice.path }) : t('save.reviewEmpty');
                    }
                    else if (!notice.reason) {
                        description = t('form.unavailable');
                    }
                    else {
                        const { localized, error } = notice.reason;
                        const template = localized && t(localized.key);
                        if (localized && template?.trim() && template !== localized.key) {
                            description = withCode(template, localized.params);
                            diagnostic = localized.diagnostic || undefined;
                        }
                        else {
                            description = t('error.unknown');
                            diagnostic = localized?.diagnostic || error;
                        }
                    }
                    const h = React.createElement;
                    if (diagnostic) {
                        description = h(React.Fragment, null, description, h('code', { style: { display: 'block', marginTop: 4, fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 12,
                                color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } }, diagnostic));
                    }
                    return h(Modal, { open: true, title: t(notice.key), description, closeLabel: t('close'), onClose: dismiss });
                }
                ctx.slots.inject('shell.overlay', () => ctx.slots.register({
                    name: 'shell.overlay', id: ns, locale: ns,
                }, FeedbackOverlay));
                const form = ctx.configForms.get('pwsh-sandbox');
                ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
                    name: 'plugins.bundle.config', key: ns, locale: ns,
                    inject: () => ({ notify, shellForm: form, hooks: { shellForm: form, linkProgress: progress } }),
                }, GitBashPage));
            },
        };
    },
});
