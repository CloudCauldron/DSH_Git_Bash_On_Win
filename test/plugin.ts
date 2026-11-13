import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { Context } from '@deepseek-ai/cordis';
import type { ShellExecRequest, ShellExecution } from '@deepseek-ai/dsh-shell';
import { extendWin32ProcessBindings, pollProcessExit, closeHandleChecked, type NativePtr } from '@deepseek-ai/dsh-win32-process';
import { loadRuntime, createContext, installedSource } from '../poc/runtime.ts';
import { createTestScope } from '../poc/scope.ts';
import { createNativeDiagnostics } from '../poc/windows.ts';
import { readProfileVerification, verifyProfile } from './profile.ts';

const installed = await loadRuntime();
const native = await createNativeDiagnostics(installed);
const processApi = extendWin32ProcessBindings(({ kernel32, bind }) => ({
  openProcess: bind(kernel32, 'OpenProcess', 'void *', ['uint32', 'int', 'uint32']) as (access: number, inherit: number, pid: number) => NativePtr | null,
}));
const controllerToken = native.token().public;
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scope = createTestScope('dsh-gitbash-plugin-');
const checks: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), root: scope.root, checks };
const reportPath = join(source, process.argv.includes('--structure-only') ? 'test/results/profile-structure.json' : process.argv.includes('--profile-only') ? 'test/results/profile.json' : 'test/results/plugin.json');
mkdirSync(dirname(reportPath), { recursive: true });
const check = (name: string, passed: boolean, detail?: unknown) => {
  checks.push({ name, passed, ...detail !== undefined ? { detail } : {} });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
  assert(passed, name);
};
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const slash = (value: string) => value.replaceAll('\\', '/');
const pluginDir = join(scope.root, 'plugin');
const workspace = join(scope.root, '工作 空間');
const outside = join(scope.root, 'outside');
const bash = 'C:/Program Files/Git/bin/bash.exe';
const git = 'C:/Program Files/Git/cmd/git.exe';
const webRequire = (await import('node:module')).createRequire(installed.cliRequire.resolve('@deepseek-ai/dsh-web-app'));
const peers = Object.keys(JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).peerDependencies) as string[];
let ctx: Context | undefined;
let hardlinkSnapshot: (() => unknown) | undefined;
let hardlinkSourcesBefore: unknown;
const ordinary = () => spawnSync(bash, ['--noprofile', '--norc', '-c', "printf 'ordinary-bash-ok\\n'"], { encoding: 'utf8', cwd: scope.root });
const ordinaryBefore = ordinary();
const registryKeys = ['HKCU\\Software\\GitForWindows', 'HKLM\\SOFTWARE\\GitForWindows', 'HKCU\\Software\\Cygnus Solutions', 'HKLM\\SOFTWARE\\Cygnus Solutions', 'HKCU\\Software\\Cygwin', 'HKLM\\SOFTWARE\\Cygwin', 'HKCU\\Software\\MSYS2', 'HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'];
const registry = () => Object.fromEntries(registryKeys.map(key => {
  const result = spawnSync('C:/Windows/System32/reg.exe', ['query', key, '/s'], { encoding: 'utf8' });
  return [key, { status: result.status, hash: createHash('sha256').update(result.stdout).update(result.stderr).digest('hex') }];
}));
const registryBefore = registry();
const activeProfile = join(process.env.USERPROFILE!, '.dsh/profiles/web');
const watched = [bash, git, 'C:/Program Files/Git/usr/bin/bash.exe', 'C:/Program Files/Git/usr/bin/msys-2.0.dll',
  installed.manifest, join(dirname(installed.manifest), 'lib/bin.js'),
  ...['lib/index.js', 'lib/runner.js', 'src/token.ts', 'src/acl.ts'].map(file => installedSource(installed, '@deepseek-ai/dsh-sandbox-windows-acl', file)),
  ...['@deepseek-ai/dsh-subprocess-local', '@deepseek-ai/dsh-bash-sandbox'].map(name => installedSource(installed, name, 'lib/index.js')),
  ...['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].map(file => join(activeProfile, file))].filter(existsSync);
const watchedDirectories = ['C:/Program Files/Git', 'C:/Program Files/Git/usr/bin', 'C:/Program Files/Git/ucrt64/bin', 'C:/Program Files/Git/etc', dirname(installed.manifest),
  dirname(installed.baseRequire.resolve('@deepseek-ai/dsh-sandbox-windows-acl/package.json')), activeProfile].filter(existsSync);
const filesBefore = Object.fromEntries(watched.map(file => [file, hash(file)]));
const securityBefore = Object.fromEntries(watched.map(file => [file, native.fileSecurityHash(file)]));
const directoriesBefore = Object.fromEntries(watchedDirectories.map(file => [file, native.fileSecurityHash(file)]));
report.watchedFiles = watched;
report.watchedDirectories = watchedDirectories;
try {
  for (const directory of [pluginDir, workspace, outside]) mkdirSync(directory);
  cpSync(join(source, 'lib'), join(pluginDir, 'lib'), { recursive: true });
  cpSync(join(source, 'package.json'), join(pluginDir, 'package.json'));
  cpSync(join(source, 'cordis.patch.yml'), join(pluginDir, 'cordis.patch.yml'));
  mkdirSync(join(pluginDir, 'node_modules/@deepseek-ai'), { recursive: true });
  for (const name of peers) {
    let manifest: string | undefined;
    for (const require of [installed.baseRequire, installed.cliRequire, installed.aclRequire, webRequire]) {
      try { manifest = require.resolve(`${name}/package.json`); break; } catch {}
    }
    if (!manifest) throw new Error(`Cannot resolve the installed DSH peer ${name}`);
    symlinkSync(dirname(realpathSync(manifest)), join(pluginDir, 'node_modules', name), 'junction');
  }
  const { RuntimeDirectory, gitRoot, runtimeFiles, contains, purgeRuntime, removePrivateTree } = await import(pathToFileURL(join(pluginDir, 'lib/private-runtime.js')).href);
  const sources = await runtimeFiles(gitRoot(bash)) as Array<{ source: string }>;
  const sourceSnapshot = () => Object.fromEntries(sources.map(file => {
    const stat = statSync(file.source, { bigint: true });
    return [file.source, { hash: hash(file.source), security: native.fileSecurityHash(file.source), links: String(stat.nlink), mode: String(stat.mode), modified: String(stat.mtimeNs), identity: String(stat.ino) }];
  }));
  const sourceBefore = sourceSnapshot();
  hardlinkSnapshot = sourceSnapshot;
  hardlinkSourcesBefore = sourceBefore;
  report.hardlinkSourceCount = sources.length;
  report.runtimeSource = 'direct hardlinks to installed Program Files Git; setup helper alone is elevated';
  if (!process.argv.includes('--profile-only')) {
  assert.throws(() => readProfileVerification(join(scope.root, 'missing-verification.json'), { status: 1, stderr: 'UAC diagnostic sentinel' }),
    error => error instanceof Error && error.message.includes('exited 1') && error.message.includes('missing verification.json') && error.message.includes('UAC diagnostic sentinel'));
  check('missing profile verification reports exit status and subprocess stderr', true);
  const manager = new RuntimeDirectory(join(scope.root, 'hardlinks'), gitRoot(bash), workspace);
  try {
    await assert.rejects(manager.prepare(gitRoot(bash), 'read-only', workspace), /EPERM/);
    check('read-only installed Git fails closed without ACL changes', true);
    // Synthetic files exercise refresh without duplicating or modifying binaries.
    const fixture = join(scope.root, 'source-fixture');
    mkdirSync(join(fixture, 'usr/bin'), { recursive: true });
    writeFileSync(join(fixture, 'usr/bin/bash.exe'), 'version-one');
    writeFileSync(join(fixture, 'usr/bin/msys-2.0.dll'), 'fixture');
    const before = await manager.prepare(fixture, 'read-only', workspace);
    check('runtime entries use hardlinks', statSync(before.bash, { bigint: true }).ino === statSync(join(fixture, 'usr/bin/bash.exe'), { bigint: true }).ino);
    check('unchanged source reuses runtime', (await manager.prepare(fixture, 'read-only', workspace)).root === before.root);
    check('bin resolves to the one private usr/bin', realpathSync(join(before.root, 'bin/msys-2.0.dll')) === realpathSync(join(before.root, 'usr/bin/msys-2.0.dll')));
    const one = manager.view(before, 'one'), same = manager.view(before, 'one'), two = manager.view(before, 'two');
    check('session views are distinct junctions to reused hardlinks', one.installationRoot === same.installationRoot && one.installationRoot !== two.installationRoot && realpathSync(one.installationRoot) === realpathSync(two.installationRoot));
    renameSync(join(fixture, 'usr/bin/bash.exe'), join(fixture, 'usr/bin/old.exe'));
    writeFileSync(join(fixture, 'usr/bin/bash.exe'), 'version-two');
    const after = await manager.prepare(fixture, 'read-only', workspace);
    check('source replacement publishes refreshed hardlinks', before.root !== after.root && readFileSync(after.bash, 'utf8') === 'version-two' && readFileSync(before.bash, 'utf8') === 'version-one');
    await assert.rejects(manager.prepare(gitRoot(bash), 'read-only', scope.root), /outside the workspace/);
    check('workspace enclosing runtime is rejected before ACL grants', true);
    const nested = join(workspace, '..git');
    mkdirSync(nested);
    check('containment distinguishes dot-prefixed children from parent traversal', contains(workspace, nested) && contains(workspace, workspace)
      && !contains(workspace, dirname(workspace)) && !contains(workspace, workspace + '-sibling'));
    await assert.rejects(manager.prepare(nested, 'read-only', workspace), /outside the workspace/);
    const nestedParent = join(workspace, '..profile');
    assert.throws(() => new RuntimeDirectory(join(nestedParent, 'runtime'), fixture, workspace), /outside the workspace/);
    check('workspace-enclosed runtime is rejected before creating any parent directories', !existsSync(nestedParent));
    const invalidSourceParent = join(scope.root, 'invalid-source-runtime');
    assert.throws(() => new RuntimeDirectory(invalidSourceParent, nested, workspace), /outside the workspace/);
    check('workspace-enclosed source is rejected before creating runtime directories', !existsSync(invalidSourceParent));
    const sourceParent = join(fixture, 'plugin-runtime');
    assert.throws(() => new RuntimeDirectory(join(sourceParent, 'runtime'), fixture, workspace), /outside the installed Git directory/);
    check('runtime inside the source is rejected before creating any parent directories', !existsSync(sourceParent));
    const junction = join(scope.root, 'redirected-parent');
    const workspaceBefore = readdirSync(workspace);
    symlinkSync(workspace, junction, 'junction');
    try {
      for (const parent of [junction, join(junction, 'missing', '.git-bash-on-win')]) {
        assert.throws(() => new RuntimeDirectory(parent, fixture, workspace), /runtime parent reparse point/);
      }
      check('parent and ancestor junctions are refused without touching their target', fs.lstatSync(junction).isSymbolicLink()
        && existsSync(workspace) && JSON.stringify(readdirSync(workspace)) === JSON.stringify(workspaceBefore));
    } finally { fs.rmdirSync(junction); }
    symlinkSync(join(scope.root, 'absent-target'), junction, 'junction');
    try {
      assert.throws(() => new RuntimeDirectory(junction, fixture, workspace), /runtime parent reparse point/);
      check('dangling parent junction is rejected and preserved', fs.lstatSync(junction).isSymbolicLink() && !existsSync(join(scope.root, 'absent-target')));
    } finally { fs.rmdirSync(junction); }
    const replacedParent = join(scope.root, 'replaced-parent');
    const savedParent = replacedParent + '-saved';
    const protectedTarget = join(scope.root, 'protected-empty-target');
    mkdirSync(protectedTarget);
    const replaced = new RuntimeDirectory(replacedParent, fixture, workspace);
    await replaced.dispose();
    renameSync(replacedParent, savedParent);
    symlinkSync(protectedTarget, replacedParent, 'junction');
    try {
      await assert.rejects(purgeRuntime(replacedParent), /runtime parent reparse point/);
      check('cache purge refuses a redirected parent and preserves the empty external target', existsSync(protectedTarget)
        && readdirSync(protectedTarget).length === 0 && fs.lstatSync(replacedParent).isSymbolicLink());
    } finally {
      fs.rmdirSync(replacedParent);
      renameSync(savedParent, replacedParent);
      await purgeRuntime(replacedParent);
    }
  } finally { await manager.dispose(); }
  check('normal disposal retains the verified current generation without instance leases', existsSync(manager.directory)
    && !readdirSync(manager.directory).some(name => name.startsWith('.owner-')));
  await purgeRuntime(manager.directory);
  check('explicit purge removes the persistent runtime cache', !existsSync(manager.directory));
  const retryParent = join(scope.root, 'retry-cleanup');
  const retry = new RuntimeDirectory(retryParent, gitRoot(bash), workspace);
  const locked = join(retry.directory, 'fixture.txt');
  writeFileSync(locked, 'cleanup retry');
  await retry.dispose();
  const unlink = fs.unlinkSync;
  const rmdir = fs.rmdirSync;
  let unlinkAttempts = 0, parentAttempts = 0;
  try {
    fs.unlinkSync = path => { if (String(path) === locked && ++unlinkAttempts === 1) throw Object.assign(new Error('Transient unlink lock'), { code: 'EBUSY' }); unlink(path); };
    fs.rmdirSync = path => { if (String(path) === retryParent && ++parentAttempts === 1) throw Object.assign(new Error('Transient parent lock'), { code: 'EACCES' }); rmdir(path); };
    syncBuiltinESMExports();
    await purgeRuntime(retryParent);
  } finally { fs.unlinkSync = unlink; fs.rmdirSync = rmdir; syncBuiltinESMExports(); }
  check('a single cache purge retries both unlink and parent removal automatically', unlinkAttempts === 2 && parentAttempts === 2 && !existsSync(retryParent));
  const interrupted = new RuntimeDirectory(join(scope.root, 'interrupted-cleanup'), gitRoot(bash), workspace);
  const blocked = join(interrupted.directory, 'fixture.txt');
  writeFileSync(blocked, 'interrupted cleanup');
  await interrupted.dispose();
  let blockedAttempts = 0;
  try {
    fs.unlinkSync = path => { if (String(path) === blocked) { blockedAttempts++; throw Object.assign(new Error('Simulated sharing violation'), { code: 'EBUSY' }); } unlink(path); };
    syncBuiltinESMExports();
    await assert.rejects(purgeRuntime(interrupted.directory), /Simulated sharing violation/);
  } finally { fs.unlinkSync = unlink; syncBuiltinESMExports(); }
  check('persistent cleanup failure is reported after three attempts with ownership retained', blockedAttempts === 3 && existsSync(blocked));
  await purgeRuntime(interrupted.directory);
  check('interrupted cleanup can be retried without leaving artifacts', !existsSync(interrupted.directory));

  const gitRun = (...args: string[]) => {
    const result = spawnSync(git, args, { cwd: workspace, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Fixture git ${args[0]}: ${result.stderr}`);
  };
  gitRun('-c', 'init.templateDir=', 'init', '--quiet');
  writeFileSync(join(workspace, 'sample 文本.txt'), 'alpha\nbeta\n');
  gitRun('add', '.');
  gitRun('-c', 'user.name=DSH Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=NUL', 'commit', '--quiet', '-m', 'fixture');
  writeFileSync(join(workspace, 'sample 文本.txt'), 'alpha\nchanged\n');
  writeFileSync(join(outside, 'canary.txt'), 'unchanged');
  ctx = await createContext(installed) as unknown as Context;
  const { default: Projections } = await installed.load(installed.baseRequire, '@deepseek-ai/dsh-session-projection');
  await ctx.plugin(Projections);
  const { default: Policy } = await installed.load(installed.baseRequire, '@deepseek-ai/dsh-sandbox-policy');
  await ctx.plugin(Policy, { mode: 'read-only', workspaceRoot: workspace });
  const { default: Plugin } = await import(pathToFileURL(join(pluginDir, 'lib/index.js')).href);
  const provider = ctx.plugin(Plugin, { gitBashPath: bash, graceMs: 300, maxOutputBytes: 1024, maxSpillBytes: 4096 });
  await provider;
  assert(ctx.shell, 'shell service activated');
  const payload = join(scope.root, 'payload');
  mkdirSync(payload);
  for (const name of ['child.ts', 'windows.ts', 'runtime.ts']) cpSync(join(source, 'poc', name), join(payload, name));
  const run = async (mode: 'read-only' | 'workspace-write' | 'danger-full-access', command: string, extra: Partial<ShellExecRequest> = {}) => {
    const request = ctx!.shell.resolve({ command, workdir: workspace, timeoutMs: 20_000,
      sandboxPolicy: { mode, workspaceRoot: workspace, sessionId: `verify-${mode}` } as NonNullable<ShellExecRequest['sandboxPolicy']>, ...extra });
    const execution = await ctx!.shell.execute(request);
    const result = await execution.result();
    (report.runs ??= [] as unknown[]);
    (report.runs as unknown[]).push({ mode, command, result });
    return result;
  };
  const grandchildCode = "console.log('probe-grandchild:'+process.pid); setTimeout(()=>{},30000)";
  const childCode = `console.log('probe-child:'+process.pid); require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchildCode)}],{stdio:'inherit'}); setTimeout(()=>{},30000)`;
  const familyCommand = [process.execPath, '-e', childCode].map(value => quote(slash(value))).join(' ');
  const watchFamily = async (execution: ShellExecution, handles: Map<string, NativePtr>) => {
    while (handles.size < 2 && execution.status === 'running') {
      for (const match of execution.observed.stdout.readFrom(0).text.matchAll(/^probe-(child|grandchild):(\d+)$/gm)) if (!handles.has(match[1]!)) {
        // Caller-owned handles retain exact identity even if Windows reuses a PID.
        const handle = processApi.openProcess(0x101001, 0, Number(match[2]));
        assert(handle, `OpenProcess(probe descendant): ${processApi.getLastError()}`);
        handles.set(match[1]!, handle);
      }
      if (handles.size < 2) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(handles.size, 2, 'both probe processes must actually start');
  };
  const familyStopped = async (handles: Map<string, NativePtr>) => {
    const until = performance.now() + 3000;
    while ([...handles.values()].some(handle => pollProcessExit(processApi, handle) === undefined) && performance.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return [...handles.values()].every(handle => pollProcessExit(processApi, handle) !== undefined);
  };
  const closeFamily = async (execution: ShellExecution, handles: Map<string, NativePtr>) => {
    try { execution.kill(); await execution.done; }
    finally {
      try {
        for (const handle of handles.values()) if (pollProcessExit(processApi, handle) === undefined) {
          assert(processApi.terminateProcess(handle, 1), `TerminateProcess(probe): ${processApi.getLastError()}`);
        }
        assert(await familyStopped(handles), 'test-owned descendants must be joined before cleanup');
      } finally { for (const handle of handles.values()) closeHandleChecked(processApi, handle, 'probe descendant'); }
    }
  };
  let firstSessionTemp: string | undefined;
  // Interactive UAC is setup time; keep it outside the short command probes.
  let lastHeartbeat = performance.now(), longestGap = 0;
  const heartbeat = setInterval(() => { const now = performance.now(); longestGap = Math.max(longestGap, now - lastHeartbeat); lastHeartbeat = now; }, 50);
  let setup;
  try { setup = await run('read-only', 'true', { timeoutMs: 120_000 }); }
  finally { longestGap = Math.max(longestGap, performance.now() - lastHeartbeat); clearInterval(heartbeat); }
  check('private hardlink runtime setup completes before command probes', setup.exitCode === 0, setup);
  check('UAC setup keeps the DSH event loop responsive', longestGap < 3000, { longestTimerGapMs: Math.round(longestGap) });
  const runtimeInstance = join(pluginDir, '.runtime');
  const runtimeGeneration = join(runtimeInstance, 'generations', JSON.parse(readFileSync(join(runtimeInstance, 'current.json'), 'utf8')).generation);
  const privateRoot = join(runtimeGeneration, 'danger-full-access');
  const { debugPrivateBash } = await import(pathToFileURL(join(pluginDir, 'lib/ipc.js')).href);
  for (const unidentified of [false, true]) {
    const marker = join(workspace, `loader-failure-${unidentified}.txt`);
    const faulty = { ...installed, load: async (require: NodeJS.Require, name: string) => {
      const module = await installed.load(require, name);
      return name !== '@deepseek-ai/dsh-win32-process' ? module : { ...module, extendWin32ProcessBindings: (extension: unknown) => {
        const api = module.extendWin32ProcessBindings(extension);
        return { ...api, modulePath: () => 0, ...unidentified ? { filePath: () => 0 } : {},
          waitDebug: (event: Buffer, milliseconds: number) => {
            const result = api.waitDebug(event, milliseconds);
            if (result && event.readUInt32LE() === 6) event.writeBigUInt64LE(0n, 40);
            return result;
          },
        };
      } };
    } };
    const failed = await debugPrivateBash(faulty, { privateRoot, bash: join(privateRoot, 'usr/bin/bash.exe'), cwd: workspace,
      command: `printf escaped > ${quote(slash(marker))}`, pipeSid: native.token().logon, followFamily: true,
      repairPipe: false, timeoutMs: 10_000 });
    check(unidentified ? 'unidentifiable DLL load fails closed before the command runs' : 'unresolved MSYS loader path fails closed at startup',
      failed.error?.includes(unidentified ? 'Cannot identify a loaded module' : 'Cannot resolve the MSYS loader path after process startup')
        && failed.exited && !existsSync(marker), failed);
  }
  for (const mode of ['read-only', 'workspace-write'] as const) {
    const result = await run(mode, "printf 'alpha\\nbeta\\n' | grep alpha | sed 's/alpha/ALPHA/' | awk '{ print $1 \"-pipeline\" }'; git --no-optional-locks status --short; git --no-pager diff --no-ext-diff; cygpath -w \"$PWD\"");
    check(`${mode}: Git, MSYS pipeline, Unicode/spaces cwd`, result.exitCode === 0 && result.stdout.text.includes('ALPHA-pipeline') && result.stdout.text.includes('+changed') && result.stdout.text.includes('工作 空間'), result);
    const libraries = await run(mode, "perl -MFile::Spec -e 'print qq(perl-library-ok\\n)'; git -c sendemail.aliasesFile= send-email --dump-aliases && printf 'git-perl-ok\\n'; file 'sample 文本.txt'; awk -l ordchr 'BEGIN {print ord(\"A\")}'");
    check(`${mode}: Perl Git helpers, file database, and gawk modules use private runtime data`, libraries.exitCode === 0
      && libraries.stdout.text.includes('perl-library-ok') && libraries.stdout.text.includes('git-perl-ok') && libraries.stdout.text.includes('text') && libraries.stdout.text.includes('65'), libraries);
    if (mode === 'read-only') {
      check('plugin runtime directly hardlinks the installed Git binaries', statSync(join(runtimeGeneration, mode, 'usr/bin/bash.exe'), { bigint: true }).ino === statSync('C:/Program Files/Git/usr/bin/bash.exe', { bigint: true }).ino);
    }
    const input = await run(mode, "IFS= read -r line; printf '%s|%s|%s' \"$line\" \"$DSH_PLUGIN_TEST\" \"$ORDINARY_TEST\"", { stdin: '輸入 value\n', env: { ORDINARY_TEST: 'env value' }, dshEnv: { DSH_PLUGIN_TEST: 'trusted' } });
    check(`${mode}: stdin and ordinary/trusted environment`, input.stdout.text === '輸入 value|trusted|env value', input);
    const temp = await run(mode, 'test_file=$(mktemp) || exit $?; printf "temp-ok "; cygpath -w "$test_file"; rm -- "$test_file"');
    check(`${mode}: MSYS temporary files follow the native policy`, mode === 'workspace-write' ? temp.exitCode === 0 && temp.stdout.text.startsWith('temp-ok ') : temp.exitCode !== 0 && temp.sandbox?.denied === true, temp);
    const denied = await run(mode, `printf overwrite > ${quote(slash(join(outside, 'canary.txt')))}`);
    check(`${mode}: outside write denied`, denied.exitCode !== 0 && denied.sandbox?.denied === true && readFileSync(join(outside, 'canary.txt'), 'utf8') === 'unchanged', denied);
    for (const operation of ['overwrite', 'append', 'rename', 'delete']) writeFileSync(join(outside, `${mode}-${operation}.txt`), 'fixture-original');
    const fixture = 'base64=' + Buffer.from(JSON.stringify({ manifest: installed.manifest, bash, pwsh: '', workspace, outside, mode })).toString('base64');
    const child = await run(mode, [process.execPath, join(payload, 'child.ts'), fixture, '--grandchild', '--mutate-fixtures'].map(value => quote(slash(value))).join(' '), { stdoutMaxBytes: 64_000 });
    const frame = child.stdout.text.split(/\r?\n/).find(line => line.startsWith('@@DSH_POC_GRANDCHILD@@'));
    const descendant = frame ? JSON.parse(frame.slice('@@DSH_POC_GRANDCHILD@@'.length)) : undefined;
    check(`${mode}: native descendant keeps restricted token, Low integrity, and Job`, child.exitCode === 0 && descendant?.token.restricted && descendant.token.integrity === 'S-1-16-4096' && descendant.token.inJob && !descendant.token.userSidInRestrictingList && !descendant.token.authenticatedUsersInRestrictingList && descendant.tokenUnchanged, descendant);
    check(`${mode}: descendant workspace/temp policy and outside mutations`, descendant.files.workspace.written === (mode === 'workspace-write') && descendant.files.temp.written === (mode === 'workspace-write') && !descendant.files.outside.written && Object.values(descendant.existingOutsideFiles).every((value: any) => !value.allowed) && ['overwrite', 'append', 'rename', 'delete'].every(operation => readFileSync(join(outside, `${mode}-${operation}.txt`), 'utf8') === 'fixture-original'));
    const policy = { mode, workspaceRoot: workspace, sessionId: `verify-${mode}` } as NonNullable<ShellExecRequest['sandboxPolicy']> & { mode: typeof mode };
    const confined = await ctx.sandbox.confine([process.execPath, join(payload, 'child.ts'), fixture, '--grandchild', '--mutate-fixtures'], policy);
    const baseline = ctx.subprocess.spawn({ argv: confined.argv, cwd: workspace, graceMs: 300, signal: AbortSignal.timeout(20_000),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64_000 }, stderr: { maxBytes: 4096 } } });
    await baseline.done;
    const nativeFrame = baseline.collected.stdout!.readFrom(0).text.split(/\r?\n/).find(line => line.startsWith('@@DSH_POC_GRANDCHILD@@'));
    const nativeChild = nativeFrame ? JSON.parse(nativeFrame.slice('@@DSH_POC_GRANDCHILD@@'.length)) : undefined;
    check(`${mode}: descendant token restrictions exactly match original DSH runner`, nativeChild?.token.fingerprint === descendant.token.fingerprint, { native: nativeChild?.token, throughBash: descendant.token });
    if (mode === 'workspace-write') firstSessionTemp = dirname(descendant.files.temp.path);
    const output = await run(mode, "awk 'BEGIN { for (i=0;i<20000;i++) printf \"x\"; print \"TAIL\" }'");
    check(`${mode}: native output truncation/spill`, output.exitCode === 0 && output.stdout.truncated && output.stdout.text.endsWith('TAIL\n'), output);
    const startedAt = performance.now();
    const timedExecution = await ctx.shell.execute(ctx.shell.resolve({ command: familyCommand, workdir: workspace, timeoutMs: 15_000, sandboxPolicy: policy }));
    const handles = new Map<string, NativePtr>();
    try {
      await watchFamily(timedExecution, handles);
      const timed = await timedExecution.result();
      (report.runs as unknown[]).push({ mode, command: familyCommand, result: timed });
      check(`${mode}: timeout kills the started child and grandchild`, handles.size === 2 && timed.timedOut && !timed.aborted
        && performance.now() - startedAt < 22_000 && await familyStopped(handles), timed);
    } finally { await closeFamily(timedExecution, handles); }
    const abort = new AbortController();
    const abortedExecution = await ctx.shell.execute(ctx.shell.resolve({ command: familyCommand, workdir: workspace, onExpiry: 'none', signal: abort.signal, sandboxPolicy: policy }));
    const abortedHandles = new Map<string, NativePtr>();
    try {
      await watchFamily(abortedExecution, abortedHandles);
      abort.abort();
      const aborted = await abortedExecution.result();
      (report.runs as unknown[]).push({ mode, command: familyCommand, result: aborted });
      check(`${mode}: AbortSignal cancellation kills the started family`, aborted.aborted && !aborted.timedOut && await familyStopped(abortedHandles), aborted);
    } finally { await closeFamily(abortedExecution, abortedHandles); }
    const background: ShellExecution = await ctx.shell.execute(ctx.shell.resolve({ command: familyCommand, workdir: workspace,
      onExpiry: 'none', sandboxPolicy: { mode, workspaceRoot: workspace } }));
    const backgroundHandles = new Map<string, NativePtr>();
    try {
      await watchFamily(background, backgroundHandles);
      check(`${mode}: background handle remains live`, background.status === 'running');
      const killedAt = performance.now();
      background.kill(); await background.done;
      check(`${mode}: background kill settles`, background.status === 'killed' && performance.now() - killedAt < 5000 && await familyStopped(backgroundHandles));
    } finally { await closeFamily(background, backgroundHandles); }
  }
  const otherSession = { mode: 'workspace-write', workspaceRoot: workspace, sessionId: 'verify-second-session' } as NonNullable<ShellExecRequest['sandboxPolicy']>;
  const concurrent = await Promise.all([run('workspace-write', "printf 'one\\n' | sed 's/one/first/'; cygpath -w /; sleep 0.2"),
    run('workspace-write', "printf 'two\\n' | grep two; cygpath -w /; sleep 0.2", { sandboxPolicy: otherSession })]);
  check('concurrent sessions use private MSYS runtime successfully', concurrent.every(result => result.exitCode === 0), concurrent);
  const siblingTemp = await run('workspace-write', `printf cross > ${quote(slash(join(firstSessionTemp!, 'cross-session.txt')))}`, { sandboxPolicy: otherSession });
  check('IPC compatibility preserves private-temp isolation between sessions', siblingTemp.exitCode !== 0 && siblingTemp.sandbox?.denied === true, siblingTemp);
  const inheritedFile = join(firstSessionTemp!, 'created-by-native.txt');
  const inheritedWorkspaceFile = join(workspace, 'created-by-native.txt');
  const nativeCreate = 'require("node:fs").writeFileSync(process.argv[1],"original");require("node:fs").writeFileSync(process.argv[2],"original")';
  const created = await run('workspace-write', [process.execPath, '-e', nativeCreate, inheritedFile, inheritedWorkspaceFile].map(value => quote(slash(value))).join(' '));
  check('native descendant creates fixtures under its original grants', created.exitCode === 0, created);
  for (const [name, mode, extra] of [['read-only', 'read-only', {}], ['sibling session', 'workspace-write', { sandboxPolicy: otherSession }]] as const) {
    const overwrite = await run(mode, `printf changed > ${quote(slash(inheritedFile))}`, extra);
    check(`${name} cannot overwrite the native child's private-temp file`, overwrite.exitCode !== 0 && readFileSync(inheritedFile, 'utf8') === 'original', overwrite);
  }
  const readOnlyOverwrite = await run('read-only', `printf changed > ${quote(slash(inheritedWorkspaceFile))}`);
  check('read-only cannot overwrite a native-child workspace file', readOnlyOverwrite.exitCode !== 0 && readFileSync(inheritedWorkspaceFile, 'utf8') === 'original', readOnlyOverwrite);
  const sharedWorkspace = await run('workspace-write', `printf updated > ${quote(slash(inheritedWorkspaceFile))}`, { sandboxPolicy: otherSession });
  check('sibling workspace session retains its native project write grant', sharedWorkspace.exitCode === 0 && readFileSync(inheritedWorkspaceFile, 'utf8') === 'updated', sharedWorkspace);
  const releaseParent = join(workspace, 'release-probe-parent.txt');
  const orphanCommand = `${familyCommand} & while ! test -f ${quote(slash(releaseParent))}; do sleep 0.05; done; printf 'parent-done\\n'`;
  const orphanedExecution = await ctx.shell.execute(ctx.shell.resolve({ command: orphanCommand, workdir: workspace, timeoutMs: 15_000,
    sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workspace, sessionId: 'verify-workspace-write' } as NonNullable<ShellExecRequest['sandboxPolicy']> }));
  const orphanedHandles = new Map<string, NativePtr>();
  try {
    await watchFamily(orphanedExecution, orphanedHandles);
    writeFileSync(releaseParent, 'release', { flag: 'wx' });
    const orphaned = await orphanedExecution.result();
    (report.runs as unknown[]).push({ mode: 'workspace-write', command: orphanCommand, result: orphaned });
    check('shell range settles after its parent exits', orphaned.exitCode === 0 && orphaned.stdout.text.endsWith('parent-done\n') && !orphaned.timedOut, orphaned);
    check('background descendants cannot outlive their completed shell range', await familyStopped(orphanedHandles));
  } finally { await closeFamily(orphanedExecution, orphanedHandles); }
  const full = await run('danger-full-access', "printf 'explicit-full-access\\n'");
  check('explicit danger-full-access policy retains native result facts', full.exitCode === 0 && full.sandbox?.mode === 'danger-full-access', full);
  const instance = runtimeInstance;
  const viewsDirectory = join(runtimeGeneration, 'views');
  const viewCount = () => existsSync(viewsDirectory) ? readdirSync(viewsDirectory).reduce((count, owner) => count + readdirSync(join(viewsDirectory, owner)).length, 0) : 0;
  const viewsBefore = viewCount();
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const releasePromise = new Promise<void>(resolve => { release = resolve; });
  const cancelPreparation = new AbortController();
  const delayed = (ctx.shell as any).executeArgv(ctx.shell.resolve({ command: 'true', workdir: workspace, onExpiry: 'none', signal: cancelPreparation.signal,
    sandboxPolicy: { mode: 'read-only', workspaceRoot: workspace } }), async () => {
    entered();
    await releasePromise; // Deliberately model native preparation ignoring cancellation briefly.
    return ['bash', '-c', 'true'];
  }) as Promise<ShellExecution>;
  const cancelled = assert.rejects(delayed, /cancel preparation/);
  try {
    await enteredPromise;
    check('agentless view exists while native preparation is blocked', viewCount() === viewsBefore + 1);
    cancelPreparation.abort(new Error('cancel preparation'));
    await cancelled;
  } finally { release(); }
  await new Promise(resolve => setImmediate(resolve));
  const preparing = (ctx.shell as any).preparing as Set<Promise<unknown>>;
  while (preparing.size) await Promise.allSettled([...preparing]);
  check('aborted native preparation releases its agentless view', viewCount() === viewsBefore);
  // Move an idle mode tree into a separate synthetic Git installation. The
  // configured source must stay outside the cache that garbage collection owns.
  const alternativeRoot = join(scope.root, 'alternative-git');
  renameSync(privateRoot, alternativeRoot);
  mkdirSync(join(alternativeRoot, 'cmd'));
  writeFileSync(join(alternativeRoot, 'cmd/git.exe'), 'discovery-only fixture; native Git is in its architecture directory', { flag: 'wx' });
  writeFileSync(join(alternativeRoot, 'usr/share/dsh-alternative-root.txt'), 'alternative-root-selected\n', { flag: 'wx' });
  const originalConfig = (ctx.shell as any).config;
  // This standalone composition has no Loader. Commit the validated reference
  // with the same native primitive the Loader uses for volatile-only edits.
  const { updateVolatile } = await installed.load(installed.cliRequire, '@deepseek-ai/cosmokit');
  const candidate = provider.resolveConfig({ ...provider.config, gitBashPath: join(alternativeRoot, 'usr/bin/bash.exe') }) as Record<string, unknown>;
  updateVolatile((ctx.shell as any).config.gitBashPath, candidate.gitBashPath);
  const alternative = await run('read-only', 'cat /usr/share/dsh-alternative-root.txt; git --version', { timeoutMs: 120_000 });
  check('a nonstandard gitBashPath changes the executed source without replacing the executor', (ctx.shell as any).config === originalConfig && alternative.exitCode === 0
    && alternative.stdout.text.startsWith('alternative-root-selected\n') && alternative.stdout.text.includes('git version'), alternative);
  const disposalProcess = await ctx.shell.execute(ctx.shell.resolve({ command: 'sleep 20', workdir: workspace, onExpiry: 'none',
    sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workspace, sessionId: 'verify-workspace-write' } as NonNullable<ShellExecRequest['sandboxPolicy']> }));
  const stoppingEntered = new Promise<void>(resolve => { entered = resolve; });
  const stoppingRelease = new Promise<void>(resolve => { release = resolve; });
  const stoppingCall = (ctx.shell as any).executeArgv(ctx.shell.resolve({ command: 'true', workdir: workspace, onExpiry: 'none', signal: AbortSignal.timeout(10_000),
    sandboxPolicy: { mode: 'read-only', workspaceRoot: workspace } }), async () => {
    entered(); await stoppingRelease; return ['bash', '-c', 'true'];
  }) as Promise<ShellExecution>;
  const stoppedPreparation = assert.rejects(stoppingCall, /provider is stopping/);
  await stoppingEntered;
  let disposed = false;
  const disposing = provider.dispose().then(() => { disposed = true; });
  try {
    await stoppedPreparation;
    await disposalProcess.done;
    await new Promise(resolve => setImmediate(resolve));
    check('provider disposal cancels and joins preparation after its caller settles', !disposed
      && readdirSync(instance).some(name => name.startsWith('.owner-')));
  } finally { release(); await disposing; }
  await ctx.fiber.dispose(); ctx = undefined;
  check('plugin disposal joins and kills its active execution', disposalProcess.status === 'killed');
  check('plugin disposal retains the current runtime and removes its owner lease', existsSync(join(instance, 'current.json'))
    && !readdirSync(instance).some(name => name.startsWith('.owner-')));
  await purgeRuntime(instance);
  removePrivateTree(alternativeRoot);
  check('complete cleanup removes the persistent cache and alternative source fixture', !existsSync(instance) && !existsSync(alternativeRoot));
  }
  if (process.argv.includes('--profile') || process.argv.includes('--profile-only')) await verifyProfile(installed, scope.root, workspace, check, report);
  check('all hardlink source contents, ACLs, and link counts restored', JSON.stringify(sourceSnapshot()) === JSON.stringify(sourceBefore));
} catch (error) {
  report.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  console.error(report.error); process.exitCode = 1;
} finally {
  try { await ctx?.fiber.dispose(); } catch (error) { report.disposalError = String(error); process.exitCode = 1; }
  const after = ordinary();
  report.installedFilesUnchanged = watched.every(file => hash(file) === filesBefore[file]);
  report.installedSecurityUnchanged = watched.every(file => native.fileSecurityHash(file) === securityBefore[file]);
  report.installedDirectorySecurityUnchanged = watchedDirectories.every(file => native.fileSecurityHash(file) === directoriesBefore[file]);
  report.registryKeys = registryKeys;
  report.registrySnapshotUnchanged = JSON.stringify(registry()) === JSON.stringify(registryBefore);
  report.ordinaryBashUnchanged = ordinaryBefore.status === 0 && after.status === 0 && ordinaryBefore.stdout === after.stdout && ordinaryBefore.stderr === after.stderr;
  report.controllerTokenUnchanged = native.token().public.fingerprint === controllerToken.fingerprint && native.token().public.defaultDaclHash === controllerToken.defaultDaclHash;
  report.allHardlinkSourcesUnchanged = hardlinkSnapshot !== undefined && JSON.stringify(hardlinkSnapshot()) === JSON.stringify(hardlinkSourcesBefore);
  try { report.cleanup = scope.dispose(); } catch (error) { report.cleanupError = String(error); process.exitCode = 1; }
  report.completedAt = new Date().toISOString();
  const cleanup = report.cleanup as { temporaryRootRemoved?: boolean; addedAmbientLocks?: string[]; environmentRestored?: boolean } | undefined;
  for (const [name, passed] of Object.entries({ installedFilesUnchanged: report.installedFilesUnchanged,
    installedSecurityUnchanged: report.installedSecurityUnchanged, registrySnapshotUnchanged: report.registrySnapshotUnchanged,
    installedDirectorySecurityUnchanged: report.installedDirectorySecurityUnchanged,
    ordinaryBashUnchanged: report.ordinaryBashUnchanged, controllerTokenUnchanged: report.controllerTokenUnchanged,
    allHardlinkSourcesUnchanged: report.allHardlinkSourcesUnchanged,
    temporaryCleanup: cleanup?.temporaryRootRemoved && cleanup.environmentRestored && cleanup.addedAmbientLocks?.length === 0 })) {
    checks.push({ name, passed: passed === true });
    if (passed !== true) process.exitCode = 1;
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`Report: ${reportPath}`);
}
