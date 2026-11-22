import { asFailure, readFailure, registerClientLocale, renderFailure, withCode, type LocaleClientContext } from './locale/client.ts';
import type { Failure, LocalizedProps } from './locale/shared.ts';

declare global {
  interface Window {
    __ModuleLoader__: { load(entry: { id: string; factory(require: (name: string) => unknown): unknown }): void };
  }
}

window.__ModuleLoader__.load({
  id: 'dsh-git-bash-on-win',
  factory(require) {
    const ns = 'dsh-git-bash-on-win';
    const React = require('react') as typeof import('react');
    const { SettingsForm, SettingsValueField, Modal, Toast } = require('@deepseek-ai/dsh-client-ui-primitives') as
      Pick<typeof import('@deepseek-ai/dsh-client-ui-primitives'), 'SettingsForm' | 'SettingsValueField' | 'Modal' | 'Toast'>;

    type ShellSettings = { gitBashPath?: string };
    type ShellForm = import('@deepseek-ai/dsh-client-ui-settings/client').ConfigForm<ShellSettings>;
    type Snapshot = ReturnType<ShellForm['getSnapshot']>;
    type Feedback = { key: 'rebuild.ok' } | { key: 'save.review'; path?: string }
      | { key: 'save.failed'; reason?: Failure } | { key: 'rebuild.failed' | 'rebuild.failedAfterSave'; reason: Failure };
    interface PageProps extends LocalizedProps {
      shellForm: ShellForm;
      useShellForm<T>(select: (snapshot: Snapshot) => T): T;
    }
    interface ClientContext extends Pick<import('@deepseek-ai/cordis').Context, 'fiber' | 'effect' | 'configForms'> {
      locale: LocaleClientContext['locale'];
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

    function GitBashPage({ t, shellForm, useShellForm }: PageProps) {
      const snapshot = useShellForm(s => s);
      const [draft, setDraft] = React.useState<{ text: string; revision: number | undefined }>();
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState<Feedback>();
      const mounted = React.useRef(true);
      React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
      }, []);
      const locked = React.useRef(false);
      const inputId = React.useId();
      const value = draft?.text ?? snapshot.value?.gitBashPath ?? '';
      const disabled = busy || snapshot.status !== 'ready';

      async function saveAndRebuild() {
        if (locked.current) return;
        locked.current = true;
        setBusy(true);
        setNotice(undefined);
        let failureKey: 'save.failed' | 'rebuild.failed' | 'rebuild.failedAfterSave' = 'save.failed';
        try {
          const latest = shellForm.getSnapshot();
          if (latest.status !== 'ready') return;
          const text = draft?.text ?? latest.value?.gitBashPath ?? '';
          const change = pathChange(text, latest);
          if (change) {
            if (!latest.writable) return;
            if (!await shellForm.mutate([change], draft ? draft.revision : latest.revision)) {
              const confirmed = shellForm.getSnapshot();
              if (mounted.current) {
                if (confirmed.status === 'ready') setDraft({ text, revision: confirmed.revision });
                setNotice(confirmed.status === 'ready' ? { key: 'save.review', path: confirmed.value?.gitBashPath } : { key: 'save.failed' });
              }
              return;
            }
          }
          if (mounted.current) setDraft(undefined);
          failureKey = change ? 'rebuild.failedAfterSave' : 'rebuild.failed';
          const response = await fetch('api/git-bash-on-win/rebuild', { method: 'POST', redirect: 'error' });
          const result: Feedback = response.ok ? { key: 'rebuild.ok' } : { key: failureKey, reason: await readFailure(response) };
          if (mounted.current) setNotice(result);
        } catch (error) {
          if (mounted.current) setNotice({ key: failureKey, reason: asFailure(error) });
        } finally {
          locked.current = false;
          if (mounted.current) setBusy(false);
        }
      }

      const h = React.createElement;
      const dismiss = () => setNotice(current => current === notice ? undefined : current);
      return h(React.Fragment, null,
        h(SettingsForm, {
          // Rebuilding a saved path is an action even when the settings document is clean or read-only.
          state: { available: true, writable: true, dirty: !disabled && (snapshot.writable || !pathChange(value, snapshot)),
            invalid: false, saving: busy, failed: false },
          labels: { unavailable: t('form.unavailable'), readOnly: '', saveFailed: t('save.failed'),
            save: t('action.saveRebuild'), saving: t('action.rebuilding') },
          onSave: () => { void saveAndRebuild(); }, onDiscard() {},
          children: h(SettingsValueField, {
            id: inputId, label: t('path.label'), placeholder: t('path.placeholder'), hint: t('path.hint'),
            text: value, disabled: disabled || !snapshot.writable,
            overridden: false, overriddenLabel: '', resetLabel: '', onReset() {}, invalid: false, invalidLabel: '',
            onEdit(text) {
              setDraft(previous => ({ text, revision: previous ? previous.revision : snapshot.revision }));
            },
          }),
        }),
        notice?.key === 'rebuild.ok' ? h(Toast, { tone: 'success', text: t(notice.key), onDone: dismiss }) : notice &&
          h(Modal, { open: true, title: t(notice.key), closeLabel: t('close'), onClose: dismiss },
            notice.key === 'save.review' ? (notice.path?.trim() ? withCode(React, t('save.reviewDetail'), { path: notice.path }) : t('save.reviewEmpty'))
              : notice.reason ? renderFailure(React, t, notice.reason) : t('form.unavailable')),
      );
    }

    return {
      inject: ['slots', 'configForms', 'locale'],
      async apply(ctx: ClientContext) {
        await registerClientLocale(ctx, ns, 'git-bash-on-win');
        if (ctx.fiber.uid === null) return;
        const form = ctx.configForms.get<ShellSettings>('pwsh-sandbox');
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: ns, locale: ns,
          inject: () => ({ shellForm: form, hooks: { shellForm: form } }),
        }, GitBashPage));
      },
    };
  },
});
