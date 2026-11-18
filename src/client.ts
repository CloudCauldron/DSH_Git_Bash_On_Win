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
    const { Tag } = require('@deepseek-ai/dsh-client-ui-primitives') as {
      Tag: import('react').ComponentType<import('react').PropsWithChildren>;
    };

    type Messages = Record<string, string>;
    type FormStatus = 'loading' | 'ready' | 'unavailable';
    interface PageProps {
      t(key: string): string;
      useShellForm<T>(select: (snapshot: { status: FormStatus }) => T): T;
    }
    interface ClientContext extends Pick<import('@deepseek-ai/cordis').Context, 'fiber' | 'effect'> {
      locale: { register(ns: string, lang: string, messages: Messages): () => void };
      configForms: { get(id: string): unknown };
      slots: {
        inject(name: string, setup: () => void): void;
        register(entry: {
          name: string; key: string; locale: string;
          inject(): { shellForm: unknown; hooks: { shellForm: unknown } };
        }, component: typeof GitBashPage): void;
      };
    }

    function GitBashPage({ t, useShellForm }: PageProps) {
      const status = useShellForm(snapshot => snapshot.status);
      if (status === 'ready') return null;
      return React.createElement(Tag, null, t('form.' + status));
    }

    function isDictionary(value: unknown): value is Messages {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        && Object.values(value).every(message => typeof message === 'string');
    }

    return {
      inject: ['slots', 'configForms', 'locale'],
      async apply(ctx: ClientContext) {
        const response = await fetch('api/git-bash-on-win/locales', { cache: 'no-store' });
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
        const form = ctx.configForms.get('pwsh-sandbox');
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: ns, locale: ns,
          inject: () => ({ shellForm: form, hooks: { shellForm: form } }),
        }, GitBashPage));
      },
    };
  },
});
