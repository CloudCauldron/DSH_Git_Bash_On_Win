import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Script } from 'node:vm';
import React from 'react';
import { Context } from '@deepseek-ai/cordis';
import { RebuildFeedback, type RebuildNotice } from '../src/rebuild-feedback.ts';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client';

const require = createRequire(import.meta.url);

await test('Save and link fences the path write and rebuilds once after confirmation or an unchanged path', async t => {
  type Snapshot = ConfigFormSnapshot<{ gitBashPath?: string }>;
  let state: Snapshot = { status: 'loading', value: undefined, revision: undefined, writable: false, user: {}, base: {} };
  const listeners = new Set<() => void>();
  const mutate = t.mock.fn<(ops: unknown[], revision: number) => Promise<boolean>>(async () => true);
  const form = {
    getSnapshot: () => state, mutate,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  function publish(patch: Partial<Snapshot>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  const ns = 'dsh-git-bash-on-win';
  const messages = (lang: string) => (require(ns + '/locale/' + lang + '.json') as { messages: Record<string, string> }).messages;
  const dictionaries = { zh: messages('zh'), en: messages('en') };
  const host = new Context();
  t.after(() => host.fiber.dispose());
  const feedback = new RebuildFeedback(host);
  const owner = host.extend({ invocation: { peer: { principal: { kind: 'owner' }, interactions: 'answer' } } });
  const dismiss = t.mock.fn((url: string) => feedback.handle(new Request('http://localhost/' + url, { method: 'POST' })));
  const rebuild = t.mock.fn(async () => new Response(null, { status: 204 }));
  const fetch = t.mock.fn(async (url: string, options: RequestInit) => {
    if (url === 'api/git-bash-on-win/locales') return Response.json({ ok: true, dictionaries });
    if (url === 'api/git-bash-on-win/feedback') return feedback.handle(new Request('http://localhost/' + url));
    if (url.startsWith('api/git-bash-on-win/feedback?action=dismiss')) return dismiss(url);
    assert.equal(url, 'api/git-bash-on-win/rebuild');
    assert.deepEqual({ ...options }, { method: 'POST', redirect: 'error' });
    return rebuild();
  });
  type PageProps = {
    shellForm: typeof form;
    useShellForm<T>(select: (s: Snapshot) => T): T;
    hooks: { linkProgress: ReturnType<typeof createSnapshotStore<RebuildNotice['progress']>> };
    useLinkProgress<T>(select: (s: RebuildNotice['progress']) => T): T;
    t(key: string, params?: Record<string, string>): string;
  };
  let Page!: React.ComponentType<PageProps>, Overlay!: React.ComponentType<Pick<PageProps, 't'>>;
  let injected!: Partial<PageProps>;
  function Modal({ description, children }: { description?: React.ReactNode; children?: React.ReactNode }) {
    return React.createElement('section', null, description, children);
  }
  function SettingsForm({ state, labels, onSave, children }: { state: { dirty: boolean; saving: boolean };
    labels: { save: string; saving: string }; onSave(): void; children: React.ReactNode }) {
    return React.createElement(React.Fragment, null, children, React.createElement('button', {
      type: 'button', disabled: !state.dirty || state.saving, onClick: onSave,
    }, state.saving ? labels.saving : labels.save));
  }
  function SettingsValueField() { return null; }
  function Toast() { return null; }
  function createSnapshotStore<T>(initial: T) {
    let value = initial;
    const listeners = new Set<() => void>();
    return {
      getSnapshot: () => value,
      set(next: T) { value = next; for (const listener of listeners) listener(); },
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
  }
  const applyContext = {
    remote: { async $mount() {} }, get: () => owner.get('gitBashFeedback'),
    fiber: { uid: 1 }, effect: (setup: () => unknown) => setup(),
    locale: { register() {} }, configForms: { get: () => form },
    slots: {
      inject: (_slot: string, setup: () => void) => setup(),
      register(entry: { name: string; inject(): Partial<PageProps> }, component: typeof Page & typeof Overlay) {
        if (entry.name === 'shell.overlay') Overlay = component;
        else { Page = component; injected = entry.inject(); }
      },
    },
  };
  const load = t.mock.fn<(entry: { factory(require: (name: string) => unknown): { apply(ctx: unknown): Promise<void> } }) => void>();
  const client = require.resolve(ns + '/client');
  new Script(readFileSync(client, 'utf8'), { filename: client }).runInNewContext({
    window: { __ModuleLoader__: { load } }, fetch, Error, AbortController, clearTimeout, setTimeout,
  });
  await load.mock.calls[0]!.arguments[0].factory(name => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore };
    return { SettingsForm, SettingsValueField, Button: 'button', Modal, Toast };
  }).apply(applyContext);

  let language: keyof typeof dictionaries = 'en';
  const useShellForm = <T,>(select: (s: Snapshot) => T) => select(React.useSyncExternalStore(form.subscribe, form.getSnapshot));
  const hooks = injected.hooks!;
  const useLinkProgress: PageProps['useLinkProgress'] = select =>
    select(React.useSyncExternalStore(hooks.linkProgress.subscribe, hooks.linkProgress.getSnapshot));
  const translate: PageProps['t'] = (key, params) => key === 'close' ? (language === 'en' ? 'Close' : '关闭')
    : (dictionaries[language][key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => params?.[name] ?? match);
  const page = () => React.createElement(React.Fragment, null,
    React.createElement(Page, { ...injected, shellForm: form, useShellForm, hooks, useLinkProgress, t: translate }),
    React.createElement(Overlay, { t: translate }),
  );
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(page()); });
  t.after(() => { renderer.unmount(); });
  const field = () => renderer.root.findByType(SettingsValueField);
  const button = () => renderer.root.findByType('button');
  function textOf(node: ReactTestInstance): string {
    return node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('');
  }
  function checkModal(key: string, description: string, code: string[] = [], raw?: string) {
    const modal = renderer.root.findByType(Modal);
    assert.equal(modal.props.open, true);
    assert.equal(modal.props.title, translate(key));
    assert.equal(textOf(modal), description);
    assert.deepEqual(modal.findAllByType('code').map(textOf), code);
    assert.equal(modal.props.children, undefined, 'feedback belongs in the description');
    assert.equal(modal.findAllByType('pre').length, 0);
    const blocks = modal.findAllByType('code').filter(node => node.props.style?.display === 'block');
    assert.deepEqual(blocks.map(textOf), raw === undefined ? [] : [raw]);
    for (const block of blocks) assert.equal(block.props.style.marginTop, 4);
    assert.equal(modal.props.closeLabel, translate('close'));
    assert.equal(renderer.root.findAllByType(Toast).length, 0);
    assert.equal(renderer.root.findByType(Page).findAllByType(Modal).length, 0);
  }
  const closeModal = () => act(() => { renderer.root.findByType(Modal).props.onClose(); });
  const edit = (value: string) => field().props.onEdit(value);
  const click = () => button().props.onClick();
  assert.equal(field().props.disabled, true);
  assert.equal(button().props.disabled, true);
  assert.equal(renderer.root.findAllByProps({ role: 'status' }).length, 0);
  assert.equal(renderer.root.findAllByType(Modal).length + renderer.root.findAllByType(Toast).length, 0);
  assert.equal(field().props.placeholder, dictionaries.en['path.placeholder']);
  assert.equal(field().props.label, dictionaries.en['path.label']);
  assert.equal(field().props.hint, dictionaries.en['path.hint']);
  assert.equal(button().props.type, 'button');
  assert.equal(renderer.root.findAllByType('form').length, 0);
  for (const event of ['onBlur', 'onKeyDown', 'onKeyUp', 'onCompositionEnd']) assert.equal(field().props[event], undefined);

  await act(async () => { publish({ status: 'ready', value: {}, writable: true, revision: 3 }); });
  assert.equal(field().props.text, '');
  const text = ' C:/Git/bin/bash.exe ';
  await act(async () => { edit('C:/Git'); });
  await act(async () => { publish({ revision: 4, value: { gitBashPath: 'from Host' } }); });
  await act(async () => { edit(text); language = 'zh'; renderer.update(page()); });
  assert.equal(field().props.label, dictionaries.zh['path.label']);
  assert.equal(field().props.hint, dictionaries.zh['path.hint']);
  assert.equal(field().props.placeholder, dictionaries.zh['path.placeholder']);
  assert.deepEqual(button().children, [dictionaries.zh['action.saveLink']]);
  assert.equal(field().props.text, text);
  assert.equal(mutate.mock.callCount(), 0);
  assert.equal(rebuild.mock.callCount(), 0);

  let confirm!: (accepted: boolean) => void;
  mutate.mock.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  await act(async () => { click(); click(); });
  assert.equal(button().props.disabled, true);
  assert.equal(field().props.disabled, true);
  assert.deepEqual(structuredClone(mutate.mock.calls.map(call => call.arguments)), [[[{ op: 'set', path: ['gitBashPath'], value: text }], 3]]);
  assert.equal(rebuild.mock.callCount(), 0, 'wait for Host acceptance');
  await act(async () => { publish({ revision: 5, value: {} }); confirm(false); });
  assert.equal(field().props.text, text);
  checkModal('save.review', '最近保存的路径为空');
  await act(async () => { language = 'en'; renderer.update(page()); });
  checkModal('save.review', 'The last saved path is empty.');
  await closeModal();
  mutate.mock.mockImplementationOnce(async () => { throw new Error('offline'); });
  await act(async () => { click(); });
  assert.equal(field().props.text, text);
  assert.equal(mutate.mock.calls[1]!.arguments[1], 5);
  checkModal('save.failed', translate('error.unknown') + 'offline', ['offline'], 'offline');
  await closeModal();

  assert.equal(rebuild.mock.callCount(), 0, 'refusal and save errors must not rebuild');

  await act(async () => { publish({ status: 'unavailable' }); });
  assert.equal(field().props.disabled, true);
  assert.equal(button().props.disabled, true);
  await act(async () => { publish({ status: 'ready', writable: false, value: { gitBashPath: 'inherited' } }); });
  assert.equal(field().props.disabled, true);
  assert.equal(button().props.disabled, true, 'this draft requires a write');
  assert.equal(renderer.root.findAllByProps({ role: 'status' }).length, 0);
  assert.equal(renderer.root.findAllByType(Modal).length + renderer.root.findAllByType(Toast).length, 0);
  await act(async () => { click(); });
  assert.equal(rebuild.mock.callCount(), 0);
  await act(async () => { renderer.unmount(); });
  assert.equal(listeners.size, 0);
  await act(async () => { renderer = create(page()); });
  assert.equal(field().props.text, 'inherited');
  assert.equal(button().props.disabled, false, 'no write required');
  await act(async () => { click(); publish({ writable: true, revision: 6 }); });
  assert.equal(rebuild.mock.callCount(), 1, 'read-only settings allow rebuilding an unchanged path');
  const priorToast = renderer.root.findByType(Toast).props.onDone;
  await act(async () => { edit('   '); });
  await act(async () => { click(); });
  assert.equal(field().props.text, 'inherited');
  assert.equal(mutate.mock.callCount(), 2, 'no user override to clear');
  await act(async () => { priorToast(); });
  assert.equal(renderer.root.findByType(Toast).props.text, translate('link.ok'), 'an expired toast cannot dismiss its successor');

  await act(async () => { publish({ user: { gitBashPath: 'custom', timeoutMs: 500 }, value: { gitBashPath: 'custom' } }); });
  await act(async () => { edit(' '); });
  await act(async () => { click(); });
  assert.deepEqual(structuredClone(mutate.mock.calls[2]!.arguments), [[{ op: 'unset', path: ['gitBashPath'] }], 6]);
  await act(async () => { publish({ revision: 7, value: { gitBashPath: 'inherited' }, user: { timeoutMs: 500 } }); });
  assert.equal(field().props.text, 'inherited');
  assert.equal(rebuild.mock.callCount(), 3, 'each allowed click rebuilt once');

  await act(async () => { edit(text); });
  mutate.mock.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  let finish!: (response: Response) => void;
  rebuild.mock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => { click(); click(); });
  assert.equal(mutate.mock.callCount(), 4);
  assert.equal(rebuild.mock.callCount(), 3);
  await act(async () => {
    publish({ revision: 8, value: { gitBashPath: text }, user: { gitBashPath: text, timeoutMs: 500 } });
    confirm(true);
  });
  assert.equal(rebuild.mock.callCount(), 4);
  assert.equal(field().props.disabled, true);
  assert.equal(button().props.disabled, true);
  await act(async () => { click(); });
  assert.equal(rebuild.mock.callCount(), 4, 'the click lock covers the pending POST');
  const path = 'C:/Tools/{path}/<&>/bin/bash.exe';
  await act(async () => { feedback.setProgress({ path, completed: 32, total: 64 }); });
  assert.equal(field().props.hint, 'Linked 32 of 64 · ' + path);
  assert.deepEqual(button().children, ['Linking…']);
  await act(async () => { feedback.setProgress(undefined); });
  assert.equal(field().props.hint, dictionaries.en['path.hint']);
  const localized = { key: 'error.readOnlySource', params: { path } };
  await act(async () => { finish(Response.json({ error: 'original diagnostic', localized }, { status: 500 })); });
  checkModal('link.failedAfterSave', translate(localized.key, { path }), [path]);
  assert.equal(field().props.text, text);
  assert.equal(button().props.disabled, false);
  await act(async () => { language = 'zh'; renderer.update(page()); });
  checkModal('link.failedAfterSave', translate(localized.key, { path }), [path]);
  await closeModal();
  assert.equal(rebuild.mock.callCount(), 4);
  rebuild.mock.mockImplementationOnce(async () => { throw new Error('offline'); });
  await act(async () => { click(); });
  checkModal('link.failed', translate('error.unknown') + 'offline', ['offline'], 'offline');
  await closeModal();
  assert.equal(rebuild.mock.callCount(), 5, 'disconnect does not retry the POST');
  await act(async () => { click(); });
  const toast = renderer.root.findByType(Toast);
  assert.equal(toast.props.text, translate('link.ok'));
  assert.equal(renderer.root.findByType(Page).findAllByType(Toast).length, 0);
  await act(async () => { toast.props.onDone(); });
  assert.equal(renderer.root.findAllByType(Toast).length, 0);
  assert.equal(rebuild.mock.callCount(), 6);
  assert.equal(mutate.mock.callCount(), 4, 'manual retries use the saved path without writing again');
  await act(async () => { edit('another path'); });
  mutate.mock.mockImplementationOnce(async () => {
    publish({ status: 'unavailable', revision: 9 });
    return false;
  });
  await act(async () => { click(); });
  assert.equal(field().props.text, 'another path');
  checkModal('save.failed', translate('form.unavailable'));
  await closeModal();
  await act(async () => { publish({ status: 'ready', revision: 10 }); });
  mutate.mock.mockImplementationOnce(async () => { throw new Error('offline'); });
  await act(async () => { click(); });
  assert.equal(mutate.mock.calls.at(-1)!.arguments[1], 8, 'an unavailable recovery snapshot preserves the draft fence');
  checkModal('save.failed', translate('error.unknown') + 'offline', ['offline'], 'offline');
  await closeModal();
  await act(async () => { publish({ revision: 11, value: { gitBashPath: 'Host path' } }); });
  mutate.mock.mockImplementationOnce(async () => false);
  await act(async () => { click(); });
  assert.equal(mutate.mock.calls.at(-1)!.arguments[1], 8, 'a transport error preserves the draft fence');
  checkModal('save.review', translate('save.reviewDetail', { path: 'Host path' }), ['Host path']);
  await closeModal();
  assert.equal(field().props.text, 'another path');
  assert.equal(rebuild.mock.callCount(), 6);
  // A known error can carry verbatim output from a subprocess as well as translated text.
  const diagnostic = 'Access denied\n<original> & {path}';
  const elevated = { key: 'error.elevatedSetup', params: { exit: '1', signal: 'null' }, diagnostic };
  rebuild.mock.mockImplementationOnce(async () => Response.json({ error: diagnostic, localized: elevated }, { status: 500 }));
  await act(async () => { edit('Host path'); });
  await act(async () => { click(); });
  checkModal('link.failed', translate(elevated.key, elevated.params) + diagnostic, ['1', 'null', diagnostic], diagnostic);
  await closeModal();
  rebuild.mock.mockImplementationOnce(async () => Response.json({
    error: diagnostic, localized: { key: 'error.unrecognizedInThisClient' },
  }, { status: 500 }));
  await act(async () => { click(); });
  checkModal('link.failed', '未知错误。' + diagnostic, [diagnostic], diagnostic);
  await closeModal();
  for (const blank of ['', ' \t ']) {
    await act(async () => { publish({ value: { gitBashPath: blank } }); });
    await act(async () => { edit('another path'); });
    mutate.mock.mockImplementationOnce(async () => false);
    await act(async () => { click(); });
    checkModal('save.review', '最近保存的路径为空');
    await closeModal();
  }
  await act(async () => { feedback.failed(new Error('first')); feedback.failed(new Error('second')); });
  checkModal('link.failed', translate('error.unknown') + 'first', ['first'], 'first');
  dismiss.mock.mockImplementationOnce(() => new Response(null, { status: 503 }));
  await closeModal();
  checkModal('link.failed', translate('error.unknown') + 'first', ['first'], 'first');
  await closeModal();
  checkModal('link.failed', translate('error.unknown') + 'second', ['second'], 'second');
  await closeModal();
  assert.equal(renderer.root.findAllByType(Modal).length, 0);
  assert.equal(dismiss.mock.callCount(), 3);
  assert.equal(fetch.mock.calls.filter(call => call.arguments[0].endsWith('/feedback')).length, 1, 'one stream contract across overlay remounts');
  assert.equal(fetch.mock.calls.filter(call => call.arguments[0].endsWith('/locales')).length, 1, 'one dictionary read per activation');
});
