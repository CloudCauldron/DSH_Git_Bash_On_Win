import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { installedDsh } from '../scripts/installed-dsh.ts';
import { profileEnvironment, localSpawn, runFixtureCommand, runtimeFixture, success } from './fixtures.ts';
import { purgeRuntimeCache } from '../src/runtime/runtime-cache.ts';

async function checkDiagnostic(dialog: Locator, explanation: string, diagnostic: string) {
  assert.ok((await dialog.textContent())?.includes(explanation));
  assert.equal(await dialog.locator('code').last().textContent(), diagnostic);
}

async function newPage(context: BrowserContext) {
  const page = await context.newPage();
  await page.addLocatorHandler(page.getByRole('button', { name: /^(继续|Continuer|Continue)$/ }), button => button.click());
  await page.addLocatorHandler(page.getByRole('dialog', { name: /^(开始使用|Commencez|Get started)$/ }), dialog => dialog.getByRole('button').first().click());
  return page;
}

async function openPlugins(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole('button', { name: /^(插件|Plugins)$/ }).click();
}

async function openPlugin(page: Page, url: string) {
  await openPlugins(page, url);
  await page.locator('[data-plugin-package="dsh-git-bash-on-win"]').getByText('DSH Git Bash on Windows', { exact: true }).click();
  return page.getByRole('textbox', { name: /^(Git Bash 路径|Git Bash path)$/ });
}

await test('installed DSH presents rebuild failures and conflicts in native dialogs and success in a native toast', { timeout: 300_000 }, async t => {
  await access(new URL('../lib/dsh-msys-compat.dll', import.meta.url)).catch(cause => {
    throw new Error('Missing compatibility DLL. Run pnpm build first.', { cause });
  });
  const runtime = installedDsh();
  const spawn = await localSpawn(t);
  const fixture = await runtimeFixture(t, 'ucrt64', join('home', '.dsh-git-bash-on-win'));
  const valid = fixture.request.gitBashPath!, originalLinks = (await stat(valid)).nlink;
  const home = join(fixture.directory, 'home'), profile = join(home, 'profiles/web');
  const env = profileEnvironment(fixture.directory, home);
  const cli = join(dirname(runtime.manifest), 'lib/bin.js'), cwd = fixture.workspace;
  success(await runFixtureCommand(spawn, [process.execPath, cli, '--profile', 'web', '--dump-config'], cwd, env, t.signal));
  const pnpm = process.env.npm_execpath?.endsWith('.exe') ? process.env.npm_execpath
    : execFileSync('where.exe', ['pnpm.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]!;
  const repo = resolve(import.meta.dirname, '..');
  success(await runFixtureCommand(spawn, [process.execPath, join(repo, 'scripts/plugin.ts'), pnpm, 'web', 'add',
    'file:' + repo.replaceAll('\\', '/')], cwd, env, t.signal));

  // Extend only this installed fixture with one translated label; the other keys fall back to English.
  const catalogs = await realpath(join(profile, 'node_modules/dsh-git-bash-on-win/locale'));
  assert.ok(catalogs.startsWith(await realpath(fixture.directory) + sep));
  await writeFileAtomic(join(catalogs, 'fr.json'), JSON.stringify({ messages: { 'action.saveRebuild': 'Enregistrer et reconstruire' } }), { mode: 0o600 });

  const gate = join(home, 'hold-rebuild'), entered = join(home, 'rebuild-entered');
  const preload = join(home, 'hold-rebuild.mjs');
  await writeFile(preload, `
    import fs from 'node:fs/promises';
    import { existsSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { setTimeout } from 'node:timers/promises';
    const read = fs.readFile;
    fs.readFile = async function(path, ...args) {
      if (String(path).endsWith('/dsh-msys-compat.dll') && existsSync(${JSON.stringify(gate)})) {
        await fs.writeFile(${JSON.stringify(entered)}, '');
        while (existsSync(${JSON.stringify(gate)})) await setTimeout(15);
      }
      return read(path, ...args);
    };
    syncBuiltinESMExports();
  `);
  const host = spawn({ argv: [process.execPath, '--import', pathToFileURL(preload).href, cli, 'web',
    '--no-open', '--host', '127.0.0.1', '--port', '0'],
    cwd, env, graceMs: 500, signal: t.signal,
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
      const first = await newPage(browser);
      let rebuilds = 0;
      first.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/git-bash-on-win/rebuild') rebuilds++; });
      await openPlugins(first, url);
      await first.locator('[data-plugin-item="shell"]').getByRole('button').first().click();
      const shellSave = first.getByRole('button', { name: '保存', exact: true });
      const saveClass = await shellSave.getAttribute('class');
      assert.ok(saveClass);
      const input = await openPlugin(first, url);
      await first.getByRole('paragraph').filter({ hasText: /^在 Windows x64 上使用 Git Bash 执行命令，遵循 DSH 当前的沙箱策略。$/ }).waitFor();
      const button = first.getByRole('button', { name: '保存并重建', exact: true });
      assert.equal(await button.getAttribute('class'), saveClass);
      const viewport = first.viewportSize()!;
      for (const width of [viewport.width, 720]) {
        await first.setViewportSize({ ...viewport, width });
        assert.ok(await input.isVisible() && await button.isEnabled());
        await input.focus();
        await first.getByText('填写 bash.exe 的完整路径，DSH 会用它运行命令。', { exact: true }).waitFor();
      }
      await first.setViewportSize(viewport);
      const missing = join(cwd, 'missing', 'bin', 'bash.exe');
      await input.fill(missing);
      const failed = first.waitForResponse(res => new URL(res.url()).pathname === '/api/git-bash-on-win/rebuild');
      await button.click();
      const response = await failed;
      assert.equal(response.status(), 500);
      const { error, messages } = await response.json();
      assert.deepEqual(messages, [{ key: 'error.gitNotFound', params: { bin: 'bin/bash.exe', usrBin: 'usr/bin/bash.exe' } }]);
      assert.doesNotMatch(error, /gitBashPath/);
      const modal = first.getByRole('dialog', { name: '路径已保存，但运行环境重建失败', exact: true });
      await modal.waitFor();
      assert.equal(await modal.getAttribute('aria-modal'), 'true');
      assert.ok((await modal.textContent())?.includes('未找到受支持的 Git for Windows。请将 Git Bash 路径设置为 bin/bash.exe 或 usr/bin/bash.exe 的绝对路径。'));
      assert.deepEqual(await modal.locator('code').allTextContents(), ['bin/bash.exe', 'usr/bin/bash.exe']);
      assert.equal(await modal.getByText(error, { exact: true }).count(), 0);
      assert.equal(await modal.evaluate(el => el.parentElement?.parentElement === document.body), true);
      assert.equal(await first.locator('[data-plugin-config]').getByText(error).count(), 0);
      await modal.getByRole('button', { name: '关闭' }).click();
      await modal.waitFor({ state: 'detached' });
      assert.equal(await input.inputValue(), missing);
      assert.equal(rebuilds, 1);

      await button.click();
      const retry = first.getByRole('dialog', { name: '运行环境重建失败', exact: true });
      await retry.waitFor();
      await first.keyboard.press('Escape');
      await retry.waitFor({ state: 'detached' });
      assert.equal(rebuilds, 2);

      await input.fill('an unsubmitted draft');
      const second = await newPage(browser);
      const otherInput = await openPlugin(second, url);
      await otherInput.click();
      assert.equal(await otherInput.inputValue(), missing);
      await otherInput.fill(valid);
      await second.getByRole('button', { name: '保存并重建', exact: true }).click();
      const toast = second.getByRole('alert').filter({ hasText: '运行环境已重建' });
      await toast.waitFor();
      assert.equal(await toast.evaluate(el => el.parentElement === document.body), true);
      assert.equal(await toast.locator(':scope > :first-child svg').count(), 1);
      assert.equal(await toast.innerText(), '运行环境已重建');
      await second.getByText('填写 bash.exe 的完整路径，DSH 会用它运行命令。', { exact: true }).waitFor();
      await toast.waitFor({ state: 'detached' });

      await button.click();
      const conflict = first.getByRole('dialog', { name: '未保存', exact: true });
      await conflict.waitFor();
      assert.deepEqual(await conflict.locator('code').allTextContents(), [valid]);
      assert.ok((await conflict.textContent())?.includes(`最近保存的路径为 ${valid}，请核对后重试。`));
      await conflict.getByRole('button', { name: '关闭' }).click();
      assert.equal(await input.inputValue(), 'an unsubmitted draft');
      assert.equal(rebuilds, 2, 'a refused save must not rebuild');
      // Let the second tab clear the override without rebuilding against the system Git installation.
      await second.route('**/api/git-bash-on-win/rebuild', route => route.fulfill({ status: 204 }), { times: 1 });
      await otherInput.fill('');
      await second.getByRole('button', { name: '保存并重建', exact: true }).click();
      await toast.waitFor();
      await button.click();
      await conflict.waitFor();
      assert.ok((await conflict.textContent())?.includes('最近保存的路径为空'));
      assert.equal(await conflict.locator('code').count(), 0);
      assert.equal(rebuilds, 2);

      const unsupported = await browser.browser()!.newContext({ locale: 'it-IT' });
      try {
        const page = await newPage(unsupported);
        await openPlugin(page, url);
        assert.equal(await page.locator('html').getAttribute('lang'), 'en');
        await page.getByRole('button', { name: 'Save and rebuild', exact: true }).waitFor();
      } finally { await unsupported.close(); }

      const french = await browser.browser()!.newContext({ locale: 'fr-FR' });
      try {
        const page = await newPage(french);
        const path = await openPlugin(page, url);
        assert.equal(await page.locator('html').getAttribute('lang'), 'fr');
        await page.getByRole('paragraph').filter({
          hasText: /^Run commands with Git Bash on Windows x64 under DSH's current sandbox policy\.$/,
        }).waitFor();
        await path.fill(missing);
        const save = page.getByRole('button', { name: 'Enregistrer et reconstruire', exact: true });
        await save.click();
        const dialog = page.getByRole('dialog', { name: 'Path saved, but runtime rebuild failed' });
        await dialog.waitFor();
        assert.ok((await dialog.textContent())?.includes('Supported Git for Windows was not found. In the Git Bash path field, enter the absolute path to bin/bash.exe or usr/bin/bash.exe.'));
        assert.deepEqual(await dialog.locator('code').allTextContents(), ['bin/bash.exe', 'usr/bin/bash.exe']);
        await page.keyboard.press('Escape');

        const diagnostic = 'ENOENT: "C:/Git/bin/bash.exe"\n<original> & {path}';
        await page.route('**/api/git-bash-on-win/rebuild', route => route.fulfill({
          status: 500, json: { error: diagnostic },
        }), { times: 1 });
        await save.click();
        const raw = page.getByRole('dialog', { name: 'Could not rebuild the runtime', exact: true });
        await raw.waitFor();
        await checkDiagnostic(raw, 'Unknown error.', diagnostic);
        await page.keyboard.press('Escape');

        await page.route('**/api/git-bash-on-win/rebuild', route => route.fulfill({
          status: 500, json: { error: diagnostic, messages: [{ key: 'error.priorCleanupFailed' }, { key: 'error.commandRangeUnconfirmed' }], diagnostic },
        }), { times: 1 });
        await save.click();
        await raw.waitFor();
        await checkDiagnostic(raw, 'Previous runtime cleanup failed.; DSH command range settlement was not confirmed.', diagnostic);
      } finally { await french.close(); }

      await second.close();
      await first.goto(url);
      const field = await openPlugin(first, url);
      await field.fill(valid);
      await writeFile(gate, '');
      try {
        await button.click();
        await first.waitForFunction(() => !!document.querySelector('button:disabled'));
        await assert.doesNotReject((async () => {
          for (let i = 0; i < 500; i++) {
            if (await access(entered).then(() => true, () => false)) return;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          throw Error('The backend never entered rebuild');
        })());
        await openPlugin(first, url);
        await button.click();
        const busy = first.getByRole('dialog', { name: '运行环境重建失败' });
        await busy.getByText('Git Bash 运行环境正在重建。').waitFor();
        await first.keyboard.press('Escape');
      } finally { await unlink(gate); }
      // Change the live DSH preference and render the plugin again in the same document.
      await first.getByRole('button', { name: '账号菜单', exact: true }).click();
      await first.getByRole('menuitem', { name: '设置', exact: true }).click();
      const settings = first.locator('[data-shortcut-modal="settings"]');
      await settings.getByRole('button', { name: '通用设置', exact: true }).click();
      await settings.getByRole('button', { name: '中文', exact: true }).click();
      await first.getByRole('menuitem', { name: 'English', exact: true }).click();
      await settings.getByRole('button', { name: 'Close', exact: true }).click();
      if (!await first.getByRole('textbox', { name: 'Git Bash path', exact: true }).isVisible()) await openPlugin(first, url);
      await first.getByRole('textbox', { name: 'Git Bash path', exact: true }).waitFor();
      await first.getByRole('button', { name: 'Save and rebuild', exact: true }).waitFor();
    } finally { await browser.close(); }
  } finally {
    host.terminate();
    assert.equal(await host.waitForExit(AbortSignal.timeout(10_000)), true);
    await purgeRuntimeCache(fixture.cache);
    assert.equal((await stat(valid)).nlink, originalLinks);
  }
});
