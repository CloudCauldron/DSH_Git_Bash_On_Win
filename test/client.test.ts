import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Script } from 'node:vm';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
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
  const rebuild = t.mock.fn(async () => new Response(null, { status: 204 }));
  const fetch = t.mock.fn(async (url: string, options: RequestInit) => {
    if (url === 'api/git-bash-on-win/locales') return Response.json({ ok: true, dictionaries });
    assert.equal(url, 'api/git-bash-on-win/rebuild');
    assert.deepEqual({ ...options }, { method: 'POST', redirect: 'error' });
    return rebuild();
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
  assert.deepEqual(renderer.root.findByType('label').children, [dictionaries.zh['path.label']]);
  assert.equal(input().props.placeholder, dictionaries.zh['path.placeholder']);
  assert.deepEqual(button().children, [dictionaries.zh['action.saveLink']]);
  assert.equal(input().props.value, text);
  assert.equal(mutate.mock.callCount(), 0);
  assert.equal(rebuild.mock.callCount(), 0);

  let confirm!: (accepted: boolean) => void;
  mutate.mock.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  await act(async () => { click(); click(); });
  assert.equal(button().props.disabled, true);
  assert.equal(input().props.disabled, true);
  assert.deepEqual(structuredClone(mutate.mock.calls.map(call => call.arguments)), [[[{ op: 'set', path: ['gitBashPath'], value: text }], 3]]);
  assert.equal(rebuild.mock.callCount(), 0, 'wait for Host acceptance');
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

  assert.equal(rebuild.mock.callCount(), 0, 'refusal and save errors must not rebuild');

  await act(async () => { publish({ status: 'unavailable' }); });
  assert.equal(input().props.disabled, true);
  assert.equal(button().props.disabled, true);
  await act(async () => { publish({ status: 'ready', writable: false, value: { gitBashPath: 'inherited' } }); });
  assert.equal(input().props.disabled, true);
  assert.equal(button().props.disabled, true, 'this draft requires a write');
  await act(async () => { click(); });
  assert.equal(rebuild.mock.callCount(), 0);
  await act(async () => { renderer.unmount(); });
  assert.equal(listeners.size, 0);
  await act(async () => { renderer = create(page()); });
  assert.equal(input().props.value, 'inherited');
  assert.equal(button().props.disabled, false, 'no write required');
  await act(async () => { click(); publish({ writable: true, revision: 6 }); });
  assert.equal(rebuild.mock.callCount(), 1, 'read-only settings allow rebuilding an unchanged path');
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
  assert.equal(input().props.disabled, true);
  assert.equal(button().props.disabled, true);
  await act(async () => { click(); });
  assert.equal(rebuild.mock.callCount(), 4, 'the click lock covers the pending POST');
  const reason = 'source busy <&>';
  await act(async () => { finish(new Response(reason, { status: 500 })); });
  assert.ok(status().includes(dictionaries.en['link.failedAfterSave']!.replace('{reason}', reason)));
  assert.equal(input().props.value, text);
  assert.equal(button().props.disabled, false);
  await act(async () => { language = 'zh'; renderer.update(page()); });
  assert.ok(status().includes(dictionaries.zh['link.failedAfterSave']!.replace('{reason}', reason)));
  assert.equal(rebuild.mock.callCount(), 4);
  rebuild.mock.mockImplementationOnce(async () => { throw new Error('offline'); });
  await act(async () => { click(); });
  assert.ok(status().includes(dictionaries.zh['link.failed']!.replace('{reason}', 'offline')));
  assert.equal(rebuild.mock.callCount(), 5, 'disconnect does not retry the POST');
  await act(async () => { click(); });
  assert.ok(status().includes(dictionaries.zh['link.ok']!));
  assert.equal(rebuild.mock.callCount(), 6);
  assert.equal(mutate.mock.callCount(), 4, 'manual retries use the saved path without writing again');
  await act(async () => { edit('another path'); });
  mutate.mock.mockImplementationOnce(async () => {
    publish({ status: 'unavailable', revision: 9 });
    return false;
  });
  await act(async () => { click(); });
  assert.equal(input().props.value, 'another path');
  assert.ok(status().includes(dictionaries.zh['save.failed']!.replace('{reason}', dictionaries.zh['form.unavailable']!)));
  await act(async () => { publish({ status: 'ready', revision: 10 }); });
  mutate.mock.mockImplementationOnce(async () => { throw new Error('offline'); });
  await act(async () => { click(); });
  assert.equal(mutate.mock.calls.at(-1)!.arguments[1], 8, 'an unavailable recovery snapshot preserves the draft fence');
  await act(async () => { publish({ revision: 11, value: { gitBashPath: 'Host path' } }); });
  mutate.mock.mockImplementationOnce(async () => false);
  await act(async () => { click(); });
  assert.equal(mutate.mock.calls.at(-1)!.arguments[1], 8, 'a transport error preserves the draft fence');
  assert.ok(status().includes(dictionaries.zh['save.review']!.replace('{path}', 'Host path')));
  assert.equal(input().props.value, 'another path');
  assert.equal(rebuild.mock.callCount(), 6);
  assert.equal(fetch.mock.callCount(), 1 + rebuild.mock.callCount(), 'one dictionary read per activation');
});
