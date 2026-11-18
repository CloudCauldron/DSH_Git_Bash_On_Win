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
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store') as typeof import('@deepseek-ai/dsh-client-store');
    const { Input, Button, Modal, Toast } = require('@deepseek-ai/dsh-client-ui-primitives') as {
      Input: import('react').ComponentType<import('react').ComponentProps<'input'>>;
      Button: import('react').ComponentType<import('react').ComponentProps<'button'>>;
      Modal: import('react').ComponentType<{ open: boolean; title: string; description: string; closeLabel: string; onClose(): void }>;
      Toast: import('react').ComponentType<{ text: string; onDone(): void }>;
    };

    type Messages = Record<string, string>;
    type ShellSettings = { gitBashPath?: string };
    type ShellForm = import('@deepseek-ai/dsh-client-ui-settings/client').ConfigForm<ShellSettings>;
    type Snapshot = ReturnType<ShellForm['getSnapshot']>;
    type Feedback = { key: 'link.ok' } | { key: 'save.review'; path?: string }
      | { key: 'save.failed'; reason?: string } | { key: 'link.failed' | 'link.failedAfterSave'; reason: string };
    interface LocalizedProps { t(key: string, params?: Record<string, string>): string }
    interface PageProps extends LocalizedProps {
      notify(message: Feedback): void;
      shellForm: ShellForm;
      useShellForm<T>(select: (snapshot: Snapshot) => T): T;
    }
    interface ClientContext extends Pick<import('@deepseek-ai/cordis').Context, 'fiber' | 'effect' | 'configForms'> {
      locale: { register(ns: string, lang: string, messages: Messages): () => void };
      slots: {
        inject(name: string, setup: () => void): void;
        register<P>(entry: { name: string; key?: string; id?: string; locale: string; inject?(): object },
          component: import('react').ComponentType<P>): void;
      };
    }

    function pathChange(text: string, snapshot: Snapshot) {
      if (!text.trim()) {
        if (snapshot.user && Object.hasOwn(snapshot.user, 'gitBashPath')) return { op: 'unset' as const, path: ['gitBashPath'] };
      } else if (text !== snapshot.value?.gitBashPath) {
        return { op: 'set' as const, path: ['gitBashPath'], value: text };
      }
    }

    function GitBashPage({ t, shellForm, useShellForm, notify }: PageProps) {
      const snapshot = useShellForm(s => s);
      const [draft, setDraft] = React.useState<{ text: string; revision: number | undefined }>();
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
            notify({ key: 'save.review', path: confirmed.value?.gitBashPath });
          } else {
            setDraft({ text, revision });
            notify({ key: 'save.failed' });
          }
        } catch (error) {
          setDraft({ text, revision });
          notify({ key: 'save.failed', reason: error instanceof Error ? error.message : String(error) });
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
          if (change && !await savePath(change, text, draft ? draft.revision : latest.revision)) return;
          setDraft(undefined);
          try {
            const response = await fetch('api/git-bash-on-win/rebuild', { method: 'POST', redirect: 'error' });
            if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
            notify({ key: 'link.ok' });
          } catch (error) {
            notify({ key: change ? 'link.failedAfterSave' : 'link.failed', reason: error instanceof Error ? error.message : String(error) });
          }
        } finally {
          locked.current = false;
          setBusy(false);
        }
      }

      const h = React.createElement;
      return h('div', null,
        h('label', { htmlFor: inputId }, t('path.label')),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '0.5rem' } },
          h(Input, { id: inputId, value, placeholder: t('path.placeholder'), disabled: disabled || !snapshot.writable,
            onChange(event) {
              const text = event.currentTarget.value;
              setDraft(previous => ({ text, revision: previous ? previous.revision : snapshot.revision }));
            },
          }),
          h(Button, { type: 'button', disabled: disabled || (!snapshot.writable && !!pathChange(value, snapshot)),
            onClick: () => { void saveAndLink(); },
          }, t('action.saveLink')),
        ),
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
        const notices = createSnapshotStore<(Feedback & { id: number }) | null>(null);
        let sequence = 0;
        const notify = (message: Feedback) => notices.set({ ...message, id: ++sequence });

        function FeedbackOverlay({ t }: LocalizedProps) {
          const notice = React.useSyncExternalStore(notices.subscribe, notices.getSnapshot);
          if (!notice) return null;
          const dismiss = () => { if (notices.getSnapshot() === notice) notices.set(null); };
          if (notice.key === 'link.ok') {
            return React.createElement(Toast, { key: notice.id, text: t(notice.key), onDone: dismiss });
          }
          const description = notice.key === 'save.review'
            ? t('save.reviewDetail', { path: notice.path || t('path.empty') })
            : notice.reason ?? t('form.unavailable');
          return React.createElement(Modal, { open: true, title: t(notice.key), description, closeLabel: t('close'), onClose: dismiss });
        }

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: ns, locale: ns,
        }, FeedbackOverlay));
        const form = ctx.configForms.get<ShellSettings>('pwsh-sandbox');
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: ns, locale: ns,
          inject: () => ({ notify, shellForm: form, hooks: { shellForm: form } }),
        }, GitBashPage));
      },
    };
  },
});
