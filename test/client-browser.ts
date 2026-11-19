import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { chromium, type Locator, type Page } from 'playwright-core';
import { installedDsh } from '../scripts/installed-dsh.ts';
import { localSpawn, runtimeFixture } from './fixtures.ts';
import { purgeRuntimeCache } from '../src/runtime/runtime-cache.ts';

async function checkDiagnostic(dialog: Locator, explanation: string, diagnostic: string) {
  const description = dialog.locator('p'), code = description.locator('code').last();
  assert.equal(await description.textContent(), explanation + diagnostic);
  assert.equal(await code.textContent(), diagnostic);
  assert.deepEqual(await code.evaluate(el => {
    const style = getComputedStyle(el);
    return [style.display, style.marginTop, style.whiteSpace, style.fontSize];
  }), ['block', '4px', 'pre-wrap', '12px']);
  assert.equal(await dialog.locator('pre').count(), 0);
}

async function openPlugins(page: Page, url: string) {
  await page.addLocatorHandler(page.getByRole('button', { name: /^(继续|Continuer)$/ }), button => button.click());
  await page.addLocatorHandler(page.getByRole('dialog', { name: /^(开始使用|Commencez)$/ }), dialog => dialog.getByRole('button').first().click());
  await page.goto(url);
  await page.getByRole('button', { name: /^(插件|Plugins)$/ }).click();
}

async function openPlugin(page: Page, url: string) {
  await openPlugins(page, url);
  await page.locator('[data-plugin-package="dsh-git-bash-on-win"]').getByRole('button', { name: /Windows Git Bash|Git Bash on Windows/ }).first().click();
  return page.getByRole('textbox', { name: /^(Git Bash 路径|Git Bash path)$/ });
}

await test('installed DSH presents link failures and conflicts in native dialogs and success in a native toast', async t => {
  const runtime = installedDsh();
  const spawn = await localSpawn(t);
  assert.ok(spawn);
  const fixture = await runtimeFixture(t, 'ucrt64', join('home', 'profiles', 'web', '.git-bash-on-win'));
  const valid = fixture.request.gitBashPath!, originalLinks = (await stat(valid)).nlink;
  const home = join(fixture.directory, 'home'), profile = join(home, 'profiles/web');
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
    TMP: fixture.directory, TEMP: fixture.directory, TMPDIR: fixture.directory };
  const cli = join(dirname(runtime.manifest), 'lib/bin.js'), cwd = fixture.workspace;
  execFileSync(process.execPath, [cli, '--profile', 'web', '--dump-config'], { cwd, env });
  const pnpm = process.env.npm_execpath?.endsWith('.exe') ? process.env.npm_execpath
    : execFileSync('where.exe', ['pnpm.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]!;
  await writeFile(join(profile, '.npmrc'), `store-dir=${join(home, 'store').replaceAll('\\', '/')}\nstate-dir=${join(home, 'state').replaceAll('\\', '/')}\n`);
  const repo = resolve(import.meta.dirname, '..');
  execFileSync(process.execPath, [join(repo, 'scripts/plugin.ts'), pnpm, 'web', 'add', 'file:' + repo.replaceAll('\\', '/')], { cwd, env });

  const gate = join(home, 'deny-probe'), attempts = join(home, 'elevation-attempts'), manual = process.env.DSH_GIT_BASH_UAC_TEST;
  const progressPrefix = 'etc/' + 'long-name-'.repeat(15);
  const progressGate = join(home, 'hold-link-progress');
  await Promise.all(Array.from({ length: 32 }, (_, i) =>
    writeFile(join(fixture.source, progressPrefix + i + '.txt'), 'fixture')));
  const realConsent = manual === 'approve' || manual === 'deny';
  const preload = join(home, 'fixture-preload.mjs'), driver = join(profile, 'fixture-command.mjs');
  // Scope fault injection to this host and the owned fixture. Default browser runs can never open UAC.
  await writeFile(preload, `
    import fs from 'node:fs';
    import timers from 'node:timers/promises';
    import { basename, toNamespacedPath } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.linkSync, write = fs.writeFileSync;
    // Pause at the linker's normal yield so the browser can inspect a real, completed batch.
    const immediate = timers.setImmediate;
    let linkedSample = false;
    timers.setImmediate = async (...args) => {
      while (linkedSample && fs.existsSync(${JSON.stringify(progressGate)})) await timers.setTimeout(20);
      return immediate(...args);
    };
    fs.linkSync = (source, target) => {
      if (source === toNamespacedPath(${JSON.stringify(join(fixture.source, 'usr/bin/bash.exe'))}) && basename(target) === '.probe' && fs.existsSync(${JSON.stringify(gate)}))
        throw Object.assign(Error('fixture probe'), { code: 'EPERM' });
      original(source, target);
      if (source.startsWith(toNamespacedPath(${JSON.stringify(join(fixture.source, progressPrefix))}))) linkedSample = true;
    };
    fs.writeFileSync = (path, ...args) => {
      if (typeof path === 'string' && basename(path) === 'plan.json' && path.startsWith(toNamespacedPath(${JSON.stringify(fixture.cache)}))) {
        write(${JSON.stringify(attempts)}, 'plan\\n', { flag: 'a' });
        if (!${realConsent}) throw Error('fixture plan creation failed');
      }
      return write(path, ...args);
    };
    syncBuiltinESMExports();
  `);
  // A normal shell request with an overlapping fixture workspace exercises preparation
  // but cannot execute the fixture's text-only bash.exe after a successful rebuild.
  await writeFile(driver, `
    export const inject = ['connection', 'shell'];
    export function apply(ctx) {
      ctx.connection.fetch.register({ path: '/api/fixture-command', methods: ['POST'], requestBody: 'buffered',
        async fetch() {
          try {
            const ex = await ctx.shell.execute(ctx.shell.resolve({ command: 'true', sandboxPolicy: {
              mode: 'read-only', workspaceRoot: ${JSON.stringify(fixture.source)} } }));
            return Response.json(await ex.result());
          } catch (error) { return Response.json({ error: error.message }); }
        } });
    }
  `);
  const patch = join(home, 'fixture-patch.json');
  await writeFile(patch, JSON.stringify([{ insert: [{ id: 'fixture-command', name: pathToFileURL(driver).href }] }]));
  const host = spawn({ argv: [process.execPath, '--import', pathToFileURL(preload).href, cli, 'web', '--patch', patch,
    '--no-open', '--host', '127.0.0.1', '--port', '0'],
    cwd, env, graceMs: 500, signal: AbortSignal.timeout(realConsent ? 300_000 : 120_000),
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 32_768 } } });
  try {
    const output = createInterface({ input: host.stdout! });
    let url: string | undefined;
    for await (const line of output) {
      url = /^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\S*)/.exec(line)?.[1];
      if (url) break;
    }
    assert.ok(url, 'DSH must announce its authenticated Web URL');
    const browser = await chromium.launchPersistentContext(join(fixture.directory, 'browser'), { env, locale: 'zh-CN',
      executablePath: process.env.CHROME_PATH ?? join(process.env.ProgramFiles!, 'Google/Chrome/Application/chrome.exe') });
    try {
      const first = await browser.newPage();
      let rebuilds = 0;
      first.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/git-bash-on-win/rebuild') rebuilds++; });
      await openPlugins(first, url);
      await first.locator('[data-plugin-item="shell"]').getByRole('button').first().click();
      const shellSave = first.getByRole('button', { name: '保存', exact: true });
      const saveClass = await shellSave.getAttribute('class');
      assert.ok(saveClass);
      const input = await openPlugin(first, url);
      const button = first.getByRole('button', { name: '保存并链接', exact: true });
      assert.equal(await button.getAttribute('class'), saveClass);
      const measure = () => input.evaluate(el => {
        const row = el.parentElement!.parentElement!;
        const bounds = row.getBoundingClientRect(), box = el.getBoundingClientRect();
        const hint = document.getElementById(el.getAttribute('aria-describedby')!)!;
        const button = row.querySelector('button')!.getBoundingClientRect();
        return { left: box.left - bounds.left, right: bounds.right - button.right, gap: button.left - box.right,
          hint: hint.textContent, hintBelow: hint.getBoundingClientRect().top >= box.bottom,
          input: box.width, button: button.width, sameRow: box.top < button.bottom && button.top < box.bottom };
      });
      const viewport = first.viewportSize()!;
      const wide = await measure();
      await first.setViewportSize({ ...viewport, width: 720 });
      const narrow = await measure();
      for (const row of [wide, narrow]) {
        assert.equal(row.hint, '填写 bash.exe 的完整路径，DSH 会用它运行命令。');
        assert.ok(row.hintBelow);
        assert.ok(Math.abs(row.left) < 1 && Math.abs(row.right) < 1 && row.gap > 0 && row.sameRow);
      }
      assert.ok(narrow.input < wide.input && narrow.button === wide.button);
      await first.setViewportSize(viewport);
      const missing = join(cwd, 'missing', 'bin', 'bash.exe');
      await input.fill(missing);
      const failed = first.waitForResponse(res => new URL(res.url()).pathname === '/api/git-bash-on-win/rebuild');
      await button.click();
      const response = await failed;
      assert.equal(response.status(), 500);
      const { error, localized } = await response.json();
      assert.deepEqual(localized, { key: 'error.gitNotFound', params: { bin: 'bin/bash.exe', usrBin: 'usr/bin/bash.exe' } });
      assert.doesNotMatch(error, /gitBashPath/);
      const modal = first.getByRole('dialog', { name: '路径已保存，但链接建立失败', exact: true });
      await modal.waitFor();
      assert.equal(await modal.getAttribute('aria-modal'), 'true');
      assert.equal(await modal.locator('p').textContent(), '未找到受支持的 Git for Windows。请将 Git Bash 路径设置为 bin/bash.exe 或 usr/bin/bash.exe 的绝对路径。');
      assert.deepEqual(await modal.locator('code').allTextContents(), ['bin/bash.exe', 'usr/bin/bash.exe']);
      assert.equal(await modal.getByText(error, { exact: true }).count(), 0);
      assert.equal(await modal.evaluate(el => el.parentElement?.parentElement === document.body), true);
      assert.equal(await first.locator('[data-plugin-config]').getByText(error).count(), 0);
      await modal.getByRole('button', { name: '关闭' }).click();
      await modal.waitFor({ state: 'detached' });
      assert.equal(await input.inputValue(), missing);
      assert.equal(rebuilds, 1);

      await button.click();
      const retry = first.getByRole('dialog', { name: '链接建立失败', exact: true });
      await retry.waitFor();
      await first.keyboard.press('Escape');
      await retry.waitFor({ state: 'detached' });
      assert.equal(rebuilds, 2);

      await input.fill('an unsubmitted draft');
      const second = await browser.newPage();
      const otherInput = await openPlugin(second, url);
      await otherInput.click();
      assert.equal(await otherInput.inputValue(), missing);
      await otherInput.fill(valid);
      await writeFile(progressGate, '');
      try {
        await second.getByRole('button', { name: '保存并链接', exact: true }).click();
        const progress = second.locator('[data-plugin-config] p').filter({ hasText: progressPrefix });
        await progress.waitFor();
        assert.equal((await measure()).hint, wide.hint, 'another tab keeps the hint for its own draft');
        const counts = /^已链接 (\d+)\/(\d+) · etc\//.exec(await progress.innerText());
        assert.ok(counts && Number(counts[1]) > 0 && Number(counts[1]) < Number(counts[2]));
        assert.equal(await second.getByRole('button', { name: '正在链接…' }).isDisabled(), true);
        assert.equal(await progress.evaluate(el => getComputedStyle(el).textOverflow === 'ellipsis'
          && el.scrollWidth > el.clientWidth && el.clientHeight === parseFloat(getComputedStyle(el).lineHeight)), true);
      } finally { await unlink(progressGate); }
      const toast = second.getByRole('alert').filter({ hasText: '已建立链接' });
      await toast.waitFor();
      assert.equal(await toast.evaluate(el => el.parentElement === document.body), true);
      assert.equal(await toast.innerText(), '已建立链接');
      await second.getByText('填写 bash.exe 的完整路径，DSH 会用它运行命令。', { exact: true }).waitFor();
      await toast.waitFor({ state: 'detached' });

      await button.click();
      const conflict = first.getByRole('dialog', { name: '未保存', exact: true });
      await conflict.waitFor();
      assert.deepEqual(await conflict.locator('code').allTextContents(), [valid]);
      assert.equal(await conflict.locator('p').innerText(), `最近保存的路径为 ${valid}，请核对后重试。`);
      await conflict.getByRole('button', { name: '关闭' }).click();
      assert.equal(await input.inputValue(), 'an unsubmitted draft');
      assert.equal(rebuilds, 2, 'a refused save must not rebuild');
      // Let the second tab clear the override without rebuilding against the system Git installation.
      await second.route('**/api/git-bash-on-win/rebuild', route => route.fulfill({ status: 204 }), { times: 1 });
      await otherInput.fill('');
      await second.getByRole('button', { name: '保存并链接', exact: true }).click();
      await toast.waitFor();
      await button.click();
      await conflict.waitFor();
      assert.equal(await conflict.locator('p').innerText(), '最近保存的路径为空');
      assert.equal(await conflict.locator('code').count(), 0);
      assert.equal(rebuilds, 2);

      const french = await browser.browser()!.newContext({ locale: 'fr-FR' });
      try {
        const page = await french.newPage();
        const path = await openPlugin(page, url);
        assert.equal(await page.locator('html').getAttribute('lang'), 'fr');
        await path.fill(missing);
        const save = page.getByRole('button', { name: 'Save and link', exact: true });
        await save.click();
        const dialog = page.getByRole('dialog', { name: 'Path saved, but link creation failed' });
        await dialog.waitFor();
        assert.equal(await dialog.locator('p').textContent(), 'Supported Git for Windows was not found. In the Git Bash path field, enter the absolute path to bin/bash.exe or usr/bin/bash.exe.');
        assert.deepEqual(await dialog.locator('code').allTextContents(), ['bin/bash.exe', 'usr/bin/bash.exe']);
        await page.keyboard.press('Escape');

        const diagnostic = 'ENOENT: "C:/Git/bin/bash.exe"\n<original> & {path}';
        await page.route('**/api/git-bash-on-win/rebuild', route => route.fulfill({
          status: 500, json: { error: diagnostic },
        }), { times: 1 });
        await save.click();
        const raw = page.getByRole('dialog', { name: 'Could not create links', exact: true });
        await raw.waitFor();
        await checkDiagnostic(raw, 'Unknown error.', diagnostic);
        await page.keyboard.press('Escape');

        await page.route('**/api/git-bash-on-win/rebuild', route => route.fulfill({
          status: 500, json: { error: diagnostic, localized: { key: 'error.rebuildBusy', diagnostic } },
        }), { times: 1 });
        await save.click();
        await raw.waitFor();
        await checkDiagnostic(raw, 'Git Bash links are being rebuilt. Try again when the rebuild finishes.', diagnostic);
      } finally { await french.close(); }

      const field = await openPlugin(second, url);
      const saveSelection = async (path: string) => {
        await second.route('**/api/git-bash-on-win/rebuild', route => route.fulfill({ status: 204 }), { times: 1 });
        await field.fill(path);
        const saved = second.waitForResponse(res => new URL(res.url()).pathname === '/api/git-bash-on-win/rebuild');
        await second.getByRole('button', { name: '保存并链接', exact: true }).click();
        await saved;
        await toast.waitFor();
      };
      await saveSelection(join(cwd, 'another-missing', 'bin', 'bash.exe'));
      await first.goto(url);
      const runShell = () => first.evaluate(async () => (await fetch('api/fixture-command', { method: 'POST' })).json() as Promise<{ error: string }>);
      const failedAutomatically = first.getByRole('dialog', { name: '链接建立失败', exact: true });
      assert.match((await runShell()).error, /Git for Windows/);
      await failedAutomatically.waitFor();
      await failedAutomatically.getByRole('button', { name: '关闭' }).click();
      await failedAutomatically.waitFor({ state: 'hidden' });

      // Save the fixture selection without an explicit rebuild. Force a real source-stamp mismatch.
      await saveSelection(valid);
      const previous = (await fixture.current()).generationId;
      await writeFile(join(fixture.source, 'etc/profile'), 'updated Git installation');
      await writeFile(gate, '');
      // DSH already holds a hot-reload HTTP/1 stream in each tab. A second streaming GET per tab
      // exhausts Chromium's same-origin pool here, blocking the third settings page and the consent POST.
      const third = await browser.newPage();
      await openPlugin(third, url);
      const priorFailure = second.getByRole('dialog', { name: '链接建立失败', exact: true });
      if (manual !== 'approve') {
        await second.route('**/api/git-bash-on-win/rebuild', route => route.fulfill({ status: 500, json: { error: 'prior manual error' } }), { times: 1 });
        await second.getByRole('button', { name: '保存并链接', exact: true }).click();
        await priorFailure.waitFor();
      }
      const pending = runShell();
      const consent = first.getByRole('dialog', { name: 'Git Bash', exact: true });
      const other = second.getByRole('dialog', { name: 'Git Bash', exact: true });
      await Promise.race([Promise.all([consent, other, third.getByRole('dialog', { name: 'Git Bash', exact: true })].map(modal => modal.waitFor())),
        pending.then(result => { throw new Error('Shell settled before confirmation: ' + JSON.stringify(result)); })]);
      assert.equal(await consent.locator('p').innerText(), 'Git Bash 原文件发生变化，需要获取管理员权限以重新链接。');
      assert.equal(await consent.getByRole('button', { name: '关闭' }).isDisabled(), true);
      await first.keyboard.press('Escape');
      await first.mouse.click(2, 2);
      assert.equal(await consent.isVisible(), true);
      await assert.rejects(access(attempts), { code: 'ENOENT' });
      const confirm = consent.getByRole('button', { name: '确认' });
      await confirm.focus();
      console.log(realConsent ? 'Windows UAC: please ' + manual + ' the fixture linker prompt now.' : 'Testing confirmed linking failure');
      const confirmed = first.waitForResponse(res => new URL(res.url()).searchParams.get('action') === 'confirm');
      await first.keyboard.press('Enter');
      const receipt = await confirmed;
      assert.equal(receipt.status(), 204);
      assert.equal(await second.evaluate(async url => (await fetch(url, { method: 'POST' })).status, receipt.url()), 409);
      await Promise.all([consent.waitFor({ state: 'hidden' }), other.waitFor({ state: 'hidden' })]);
      await third.close();
      const result = await pending;
      assert.equal(await readFile(attempts, 'utf8'), 'plan\n');
      if (manual === 'approve') {
        assert.match(result.error, /overlap/i);
        assert.notEqual((await fixture.current()).generationId, previous);
        await first.getByRole('alert').filter({ hasText: '已建立链接' }).waitFor();
      } else {
        const reason = realConsent ? /ShellExecuteExW failed \(Win32 1223\)/ : /fixture plan creation failed/;
        assert.match(result.error, reason);
        assert.equal((await fixture.current()).generationId, previous);
        await failedAutomatically.waitFor();
        assert.match(await failedAutomatically.innerText(), reason);
        await priorFailure.getByText(reason).waitFor();
        assert.equal(await priorFailure.getByRole('button', { name: '关闭' }).isEnabled(), true);
        await first.reload();
        await failedAutomatically.waitFor();
        await failedAutomatically.getByRole('button', { name: '关闭' }).click();
        await failedAutomatically.waitFor({ state: 'hidden' });
      }
      await unlink(gate);
      if (manual !== 'approve') {
        // Closing the shared automatic failure reveals the earlier tab-local error.
        await priorFailure.getByText('prior manual error').waitFor();
        await priorFailure.getByRole('button', { name: '关闭' }).click();
        // A new selection retries the failed preparation with ordinary permissions.
        await saveSelection(valid.replaceAll('\\', '/'));
        await toast.waitFor({ state: 'detached' });
        const rebuilt = first.getByRole('alert').filter({ hasText: '已建立链接' });
        const [shell] = await Promise.all([runShell(), rebuilt.waitFor()]);
        assert.match(shell.error, /overlap/i);
        assert.equal(await consent.count(), 0);
        assert.equal(await readFile(attempts, 'utf8'), 'plan\n');
      }
    } finally { await browser.close(); }
  } finally {
    host.terminate();
    assert.equal(await host.waitForExit(AbortSignal.timeout(10_000)), true);
    await purgeRuntimeCache(fixture.cache);
    assert.equal((await stat(valid)).nlink, originalLinks);
  }
});
