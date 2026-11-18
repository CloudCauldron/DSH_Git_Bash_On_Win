import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { chromium, type Locator, type Page } from 'playwright-core';
import { installedDsh } from '../scripts/installed-dsh.ts';
import { localSpawn, runtimeFixture } from './fixtures.ts';

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

async function openPlugin(page: Page, url: string) {
  await page.addLocatorHandler(page.getByRole('button', { name: /^(继续|Continuer)$/ }), button => button.click());
  await page.addLocatorHandler(page.getByRole('dialog', { name: /^(开始使用|Commencez)$/ }), dialog => dialog.getByRole('button').first().click());
  await page.goto(url);
  await page.getByRole('button', { name: /^(插件|Plugins)$/ }).click();
  await page.locator('[data-plugin-package="dsh-git-bash-on-win"]').getByRole('button', { name: /Windows Git Bash|Git Bash on Windows/ }).first().click();
  return page.getByRole('textbox', { name: /^(Git Bash 路径|Git Bash path)$/ });
}

await test('installed DSH presents link failures and conflicts in native dialogs and success in a native toast', async t => {
  const runtime = installedDsh();
  const spawn = await localSpawn(t);
  assert.ok(spawn);
  const fixture = await runtimeFixture(t, 'ucrt64', join('home', 'profiles', 'web', '.git-bash-on-win'));
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

  const host = spawn({ argv: [process.execPath, cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
    cwd, env, graceMs: 500, signal: AbortSignal.timeout(120_000),
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
      const input = await openPlugin(first, url);
      const button = first.getByRole('button', { name: '保存并链接', exact: true });
      const measure = () => input.evaluate(el => {
        const field = el.parentElement!, row = field.parentElement!;
        const bounds = row.parentElement!.getBoundingClientRect(), box = field.getBoundingClientRect();
        const button = row.querySelector('button')!.getBoundingClientRect();
        return { left: box.left - bounds.left, right: bounds.right - button.right, gap: button.left - box.right,
          input: box.width, button: button.width, sameRow: box.top < button.bottom && button.top < box.bottom };
      });
      const viewport = first.viewportSize()!;
      const wide = await measure();
      await first.setViewportSize({ ...viewport, width: 720 });
      const narrow = await measure();
      for (const row of [wide, narrow]) {
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
      const modal = first.getByRole('dialog', { name: '路径已保存，但硬链接建立失败', exact: true });
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
      const retry = first.getByRole('dialog', { name: '硬链接建立失败', exact: true });
      await retry.waitFor();
      await first.keyboard.press('Escape');
      await retry.waitFor({ state: 'detached' });
      assert.equal(rebuilds, 2);

      await input.fill('an unsubmitted draft');
      const second = await browser.newPage();
      const otherInput = await openPlugin(second, url);
      await otherInput.click();
      assert.equal(await otherInput.inputValue(), missing);
      const valid = join(fixture.source, 'usr/bin/bash.exe');
      await otherInput.fill(valid);
      await second.getByRole('button', { name: '保存并链接', exact: true }).click();
      const toast = second.getByRole('alert').filter({ hasText: '已建立硬链接' });
      await toast.waitFor();
      assert.equal(await toast.evaluate(el => el.parentElement === document.body), true);
      assert.equal(await toast.innerText(), '已建立硬链接');
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
        const dialog = page.getByRole('dialog', { name: 'Path saved, but hard link creation failed' });
        await dialog.waitFor();
        assert.equal(await dialog.locator('p').textContent(), 'Supported Git for Windows was not found. In the Git Bash path field, enter the absolute path to bin/bash.exe or usr/bin/bash.exe.');
        assert.deepEqual(await dialog.locator('code').allTextContents(), ['bin/bash.exe', 'usr/bin/bash.exe']);
        await page.keyboard.press('Escape');

        const diagnostic = 'ENOENT: "C:/Git/bin/bash.exe"\n<original> & {path}';
        await page.route('**/api/git-bash-on-win/rebuild', route => route.fulfill({
          status: 500, json: { error: diagnostic },
        }), { times: 1 });
        await save.click();
        const raw = page.getByRole('dialog', { name: 'Could not create hard links', exact: true });
        await raw.waitFor();
        await checkDiagnostic(raw, 'Unknown error.', diagnostic);
        await page.keyboard.press('Escape');

        await page.route('**/api/git-bash-on-win/rebuild', route => route.fulfill({
          status: 500, json: { error: diagnostic, localized: { key: 'error.rebuildBusy', diagnostic } },
        }), { times: 1 });
        await save.click();
        await raw.waitFor();
        await checkDiagnostic(raw, 'Git Bash hard links are being rebuilt. Try again when the rebuild finishes.', diagnostic);
      } finally { await french.close(); }
    } finally { await browser.close(); }
  } finally {
    host.terminate();
    assert.equal(await host.waitForExit(AbortSignal.timeout(10_000)), true);
  }
});
