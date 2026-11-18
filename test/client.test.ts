import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Script } from 'node:vm';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client';

const require = createRequire(import.meta.url);

await test('the path field preserves the first revision and only saves on explicit activation', async t => {
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
  const fetch = t.mock.fn(async (url: string) => {
    assert.equal(url, 'api/git-bash-on-win/locales');
    return Response.json({ ok: true, dictionaries });
  });
  type PageProps = {
    shellForm: typeof form;
    useShellForm<T>(select: (s: Snapshot) => T): T;
    t(key: string, params?: Record<string, string>): string;
  };
  let Page!: React.ComponentType<PageProps>;
  const applyContext = {
    fiber: { uid: 1 }, effect: (setup: () => unknown) => setup(),
    locale: { register() {} }, configForms: { get: () => form },
    slots: {
      inject: (_slot: string, setup: () => void) => setup(),
      register(_entry: unknown, component: typeof Page) { Page = component; },
    },
  };
  const load = t.mock.fn<(entry: { factory(require: (name: string) => unknown): { apply(ctx: unknown): Promise<void> } }) => void>();
  const client = require.resolve(ns + '/client');
  new Script(readFileSync(client, 'utf8'), { filename: client }).runInNewContext({ window: { __ModuleLoader__: { load } }, fetch, Error });
  await load.mock.calls[0]!.arguments[0].factory(name => name === 'react' ? React : { Input: 'input', Button: 'button' }).apply(applyContext);

  let language: keyof typeof dictionaries = 'en';
  const useShellForm = <T,>(select: (s: Snapshot) => T) => select(React.useSyncExternalStore(form.subscribe, form.getSnapshot));
  const page = () => React.createElement(Page, { shellForm: form, useShellForm,
    t: (key, params) => dictionaries[language][key]!.replace(/\{(\w+)\}/g, (_, name: string) => params![name]!),
  });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(page()); });
  t.after(() => { renderer.unmount(); });
  const input = () => renderer.root.findByType('input');
  const button = () => renderer.root.findByType('button');
  const status = () => renderer.root.findAllByProps({ role: 'status' }).flatMap(node => node.children);
  const edit = (value: string) => input().props.onChange({ currentTarget: { value } });
  const click = () => button().props.onClick();
  assert.equal(input().props.disabled, true);
  assert.equal(button().props.disabled, true);
  assert.ok(status().includes(dictionaries.en['form.loading']!));
  assert.equal(input().props.placeholder, dictionaries.en['path.placeholder']);
  assert.equal(renderer.root.findByType('label').props.htmlFor, input().props.id);
  assert.equal(button().props.type, 'button');
  assert.equal(renderer.root.findAllByType('form').length, 0);
  for (const event of ['onBlur', 'onKeyDown', 'onKeyUp', 'onCompositionEnd']) assert.equal(input().props[event], undefined);

  await act(async () => { publish({ status: 'ready', value: {}, writable: true, revision: 3 }); });
  assert.equal(input().props.value, '');
  const text = ' C:/Git/bin/bash.exe ';
  await act(async () => { edit('C:/Git'); });
  await act(async () => { publish({ revision: 4, value: { gitBashPath: 'from Host' } }); });
  await act(async () => { edit(text); language = 'zh'; renderer.update(page()); });
  assert.equal(input().props.placeholder, dictionaries.zh['path.placeholder']);
  assert.deepEqual(button().children, [dictionaries.zh['action.saveLink']]);
  assert.equal(input().props.value, text);
  assert.equal(mutate.mock.callCount(), 0);

  let confirm!: (accepted: boolean) => void;
  mutate.mock.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  await act(async () => { click(); click(); });
  assert.equal(button().props.disabled, true);
  assert.equal(input().props.disabled, true);
  assert.deepEqual(structuredClone(mutate.mock.calls.map(call => call.arguments)), [[[{ op: 'set', path: ['gitBashPath'], value: text }], 3]]);
  await act(async () => { publish({ revision: 5, value: {} }); confirm(false); });
  assert.equal(input().props.value, text);
  assert.ok(status().includes(dictionaries.zh['save.review']!.replace('{path}', dictionaries.zh['path.empty']!)));
  await act(async () => { language = 'en'; renderer.update(page()); });
  assert.ok(status().includes(dictionaries.en['save.review']!.replace('{path}', dictionaries.en['path.empty']!)));
  mutate.mock.mockImplementationOnce(async () => { throw new Error('offline'); });
  await act(async () => { click(); });
  assert.equal(input().props.value, text);
  assert.equal(mutate.mock.calls[1]!.arguments[1], 5);
  assert.ok(status().includes(dictionaries.en['save.failed']!.replace('{reason}', 'offline')));

  await act(async () => { publish({ status: 'unavailable' }); });
  assert.equal(input().props.disabled, true);
  assert.equal(button().props.disabled, true);
  await act(async () => { publish({ status: 'ready', writable: false, value: { gitBashPath: 'inherited' } }); });
  assert.equal(input().props.disabled, true);
  assert.equal(button().props.disabled, true, 'this draft requires a write');
  await act(async () => { renderer.unmount(); });
  assert.equal(listeners.size, 0);
  await act(async () => { renderer = create(page()); });
  assert.equal(input().props.value, 'inherited');
  assert.equal(button().props.disabled, false, 'no write required');
  await act(async () => { click(); publish({ writable: true, revision: 6 }); });
  await act(async () => { edit('   '); });
  await act(async () => { click(); });
  assert.equal(input().props.value, 'inherited');
  assert.equal(mutate.mock.callCount(), 2, 'no user override to clear');

  await act(async () => { publish({ user: { gitBashPath: 'custom', timeoutMs: 500 }, value: { gitBashPath: 'custom' } }); });
  await act(async () => { edit(' '); });
  await act(async () => { click(); });
  assert.deepEqual(structuredClone(mutate.mock.calls[2]!.arguments), [[{ op: 'unset', path: ['gitBashPath'] }], 6]);
  await act(async () => { publish({ revision: 7, value: { gitBashPath: 'inherited' }, user: { timeoutMs: 500 } }); });
  assert.equal(input().props.value, 'inherited');
  assert.equal(fetch.mock.callCount(), 1);
});
