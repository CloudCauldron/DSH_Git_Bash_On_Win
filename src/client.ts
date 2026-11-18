// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Augments the host Window in a classic script.
interface Window {
  __ModuleLoader__: {
    load(entry: { id: string; factory(require: (name: string) => unknown): unknown }): void;
  };
}

window.__ModuleLoader__.load({
  id: 'dsh-git-bash-on-win',
  factory(require) {
    const ns = 'dsh-git-bash-on-win';
    const React = require('react') as typeof import('react');
    const { Input, Button } = require('@deepseek-ai/dsh-client-ui-primitives') as {
      Input: import('react').ComponentType<import('react').ComponentProps<'input'>>;
      Button: import('react').ComponentType<import('react').ComponentProps<'button'>>;
    };

    type Messages = Record<string, string>;
    type ShellSettings = { gitBashPath?: string };
    type ShellForm = import('@deepseek-ai/dsh-client-ui-settings/client').ConfigForm<ShellSettings>;
    type Snapshot = ReturnType<ShellForm['getSnapshot']>;
    type Feedback = { key: 'link.ok' } | { key: 'save.review'; path?: string }
      | { key: 'save.failed'; reason?: string } | { key: 'link.failed' | 'link.failedAfterSave'; reason: string };
    interface PageProps {
      t(key: string, params?: Record<string, string>): string;
      shellForm: ShellForm;
      useShellForm<T>(select: (snapshot: Snapshot) => T): T;
    }
    interface ClientContext extends Pick<import('@deepseek-ai/cordis').Context, 'fiber' | 'effect' | 'configForms'> {
      locale: { register(ns: string, lang: string, messages: Messages): () => void };
      slots: {
        inject(name: string, setup: () => void): void;
        register(entry: {
          name: string; key: string; locale: string;
          inject(): { shellForm: ShellForm; hooks: { shellForm: ShellForm } };
        }, component: typeof GitBashPage): void;
      };
    }

    function pathChange(text: string, snapshot: Snapshot) {
      if (!text.trim()) {
        if (snapshot.user && Object.hasOwn(snapshot.user, 'gitBashPath')) return { op: 'unset' as const, path: ['gitBashPath'] };
      } else if (text !== snapshot.value?.gitBashPath) {
        return { op: 'set' as const, path: ['gitBashPath'], value: text };
      }
    }

    function GitBashPage({ t, shellForm, useShellForm }: PageProps) {
      const snapshot = useShellForm(s => s);
      const [draft, setDraft] = React.useState<{ text: string; revision: number | undefined }>();
      const [feedback, setFeedback] = React.useState<Feedback>();
      const [busy, setBusy] = React.useState(false);
      const locked = React.useRef(false);
      const inputId = React.useId();
      const value = draft?.text ?? snapshot.value?.gitBashPath ?? '';
      const disabled = busy || snapshot.status !== 'ready';

      async function savePath(change: NonNullable<ReturnType<typeof pathChange>>, text: string, revision: Snapshot['revision']) {
        try {
          if (await shellForm.mutate([change], revision)) return true;
          const confirmed = shellForm.getSnapshot();
          if (confirmed.status === 'ready') {
            setDraft({ text, revision: confirmed.revision });
            setFeedback({ key: 'save.review', path: confirmed.value?.gitBashPath });
          } else {
            setDraft({ text, revision });
            setFeedback({ key: 'save.failed' });
          }
        } catch (error) {
          setDraft({ text, revision });
          setFeedback({ key: 'save.failed', reason: error instanceof Error ? error.message : String(error) });
        }
        return false;
      }

      async function saveAndLink() {
        if (locked.current) return;
        locked.current = true;
        setBusy(true);
        try {
          const latest = shellForm.getSnapshot();
          if (latest.status !== 'ready') return;
          const text = draft?.text ?? latest.value?.gitBashPath ?? '';
          const change = pathChange(text, latest);
          if (change && !latest.writable) return;
          setFeedback(undefined);
          if (change && !await savePath(change, text, draft ? draft.revision : latest.revision)) return;
          setDraft(undefined);
          try {
            const response = await fetch('api/git-bash-on-win/rebuild', { method: 'POST', redirect: 'error' });
            if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
            setFeedback({ key: 'link.ok' });
          } catch (error) {
            setFeedback({ key: change ? 'link.failedAfterSave' : 'link.failed', reason: error instanceof Error ? error.message : String(error) });
          }
        } finally {
          locked.current = false;
          setBusy(false);
        }
      }

      let message;
      if (feedback?.key === 'link.ok') message = t(feedback.key);
      else if (feedback?.key === 'save.review') message = t(feedback.key, { path: feedback.path || t('path.empty') });
      else if (feedback) message = t(feedback.key, { reason: feedback.reason ?? t('form.unavailable') });
      const status = snapshot.status !== 'ready' ? 'form.' + snapshot.status : !snapshot.writable ? 'form.readOnly' : undefined;
      const h = React.createElement;
      return h('div', null,
        h('label', { htmlFor: inputId }, t('path.label')),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '0.5rem' } },
          h(Input, { id: inputId, value, placeholder: t('path.placeholder'), disabled: disabled || !snapshot.writable,
            onChange(event) {
              const text = event.currentTarget.value;
              setDraft(previous => ({ text, revision: previous ? previous.revision : snapshot.revision }));
              setFeedback(undefined);
            },
          }),
          h(Button, { type: 'button', disabled: disabled || (!snapshot.writable && !!pathChange(value, snapshot)),
            onClick: () => { void saveAndLink(); },
          }, t('action.saveLink')),
        ),
        status && h('p', { role: 'status' }, t(status)),
        message && h('p', { role: 'status' }, message),
      );
    }

    function isDictionary(value: unknown): value is Messages {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        && Object.values(value).every(message => typeof message === 'string');
    }

    return {
      inject: ['slots', 'configForms', 'locale'],
      async apply(ctx: ClientContext) {
        const response = await fetch('api/git-bash-on-win/locales', { cache: 'no-store', redirect: 'error' });
        if (ctx.fiber.uid === null) return;
        if (!response.ok) throw new Error(`Git Bash locales: HTTP ${response.status}`);
        const data = await response.json() as { ok?: boolean; dictionaries?: { zh?: unknown; en?: unknown } } | null;
        if (ctx.fiber.uid === null) return;
        const { zh, en } = data?.dictionaries ?? {};
        if (data?.ok !== true || !isDictionary(zh) || !isDictionary(en)) {
          throw new Error('Invalid Git Bash locale dictionaries.');
        }
        for (const [lang, messages] of Object.entries({ zh, en })) {
          ctx.effect(() => ctx.locale.register(ns, lang, messages));
        }
        const form = ctx.configForms.get<ShellSettings>('pwsh-sandbox');
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: ns, locale: ns,
          inject: () => ({ shellForm: form, hooks: { shellForm: form } }),
        }, GitBashPage));
      },
    };
  },
});
