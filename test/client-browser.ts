import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright-core';
import { installedDsh } from '../scripts/installed-dsh.ts';
import { localSpawn, runtimeFixture } from './fixtures.ts';

async function openPlugin(page: Page, url: string) {
  await page.addLocatorHandler(page.getByRole('button', { name: '继续', exact: true }), button => button.click());
  await page.addLocatorHandler(page.getByRole('dialog', { name: '开始使用' }), dialog => dialog.getByRole('button').first().click());
  await page.goto(url);
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await page.locator('[data-plugin-package="dsh-git-bash-on-win"]').getByRole('button', { name: /Windows Git Bash/ }).first().click();
  return page.getByRole('textbox', { name: 'Git Bash 路径' });
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
      const missing = join(cwd, 'missing', 'bin', 'bash.exe');
      await input.fill(missing);
      const failed = first.waitForResponse(res => new URL(res.url()).pathname === '/api/git-bash-on-win/rebuild');
      await button.click();
      const response = await failed;
      assert.equal(response.status(), 500);
      const reason = await response.text();
      assert.match(reason, /Git for Windows was not found/);
      const modal = first.getByRole('dialog', { name: '路径已保存，但硬链接建立失败', exact: true });
      await modal.waitFor();
      assert.equal(await modal.getAttribute('aria-modal'), 'true');
      assert.equal(await modal.getByText(reason, { exact: true }).count(), 1);
      assert.equal(await modal.evaluate(el => el.parentElement?.parentElement === document.body), true);
      assert.equal(await first.locator('[data-plugin-config]').getByText(reason).count(), 0);
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
      const toast = second.getByRole('alert').filter({ hasText: '硬链接已建立' });
      await toast.waitFor();
      assert.equal(await toast.evaluate(el => el.parentElement === document.body), true);
      assert.equal(await toast.innerText(), '硬链接已建立');
      await toast.waitFor({ state: 'detached' });

      await button.click();
      const conflict = first.getByRole('dialog', { name: '未保存', exact: true });
      await conflict.waitFor();
      assert.ok((await conflict.innerText()).includes(valid));
      await conflict.getByRole('button', { name: '关闭' }).click();
      assert.equal(await input.inputValue(), 'an unsubmitted draft');
      assert.equal(rebuilds, 2, 'a refused save must not rebuild');
    } finally { await browser.close(); }
  } finally {
    host.terminate();
    assert.equal(await host.waitForExit(AbortSignal.timeout(10_000)), true);
  }
});
