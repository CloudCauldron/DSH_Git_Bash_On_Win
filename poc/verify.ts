import type { Mode } from './runtime.ts';

interface FileResult { written: boolean; removed?: boolean }
interface Diagnostic {
  token: { fingerprint: string; restricted: boolean; integrity: string; inJob: boolean; userSidInRestrictingList: boolean; authenticatedUsersInRestrictingList: boolean };
  tokenUnchanged: boolean;
  files: Record<string, FileResult>;
  filesAfterIpc?: Record<string, FileResult>;
  existingOutsideFiles: Record<string, { allowed: boolean }>;
  privatePipes: Array<{ variant: string; serverCreated: boolean; clientOpened?: boolean }>;
  namespaces: { creation: Array<{ created: boolean }> };
  grandchildInherited: { exitCode: number | null };
}
interface Run {
  mode: Mode; exitCode: number | null;
  diagnostic: Diagnostic | null;
  inheritedGrandchild: Diagnostic | null;
}
interface Shell { mode: Mode; name: string; exitCode: number | null; stdout: string }

/** Check observed safeguards; expected MSYS startup failure is reported separately. */
export function assess(report: Record<string, unknown>) {
  const checks: Array<{ name: string; passed: boolean }> = [];
  const check = (name: string, passed: unknown) => checks.push({ name, passed: passed === true });
  const runs = report.runs as Run[];
  const shells = report.shells as Shell[];
  check('three complete diagnostic runs', runs.length === 3 && runs.every(run => run.exitCode === 0 && run.diagnostic !== null));
  for (const run of runs) {
    const d = run.diagnostic;
    if (!d) continue;
    const confined = run.mode !== 'unconfined-control';
    check(`${run.mode}: restricted token state`, d.token.restricted === confined && d.token.integrity === (confined ? 'S-1-16-4096' : 'S-1-16-8192'));
    check(`${run.mode}: token unchanged after IPC`, d.tokenUnchanged);
    check(`${run.mode}: no user/AU SID added to restricting list`, !d.token.userSidInRestrictingList && !d.token.authenticatedUsersInRestrictingList);
    check(`${run.mode}: Job containment`, d.token.inJob);
    check(`${run.mode}: inherited descendant started`, d.grandchildInherited.exitCode === 0 && run.inheritedGrandchild !== null);
    if (run.inheritedGrandchild) {
      check(`${run.mode}: descendant retained token and Job`, run.inheritedGrandchild.token.fingerprint === d.token.fingerprint && run.inheritedGrandchild.token.inJob && run.inheritedGrandchild.tokenUnchanged);
    }
    for (const [stage, files] of [['before IPC', d.files], ['after IPC', d.filesAfterIpc], ['descendant', run.inheritedGrandchild?.files]] as const) {
      check(`${run.mode}: ${stage} file results present`, files !== undefined);
      if (!files) continue;
      for (const location of ['workspace', 'outside', 'temp']) {
        const expected = run.mode === 'unconfined-control' || (run.mode === 'workspace-write' && location !== 'outside');
        const result = files[location];
        check(`${run.mode}: ${stage} ${location} write`, result !== undefined && result.written === expected);
        if (result?.written) check(`${run.mode}: ${stage} ${location} probe removed`, result.removed);
      }
    }
    for (const operation of ['overwrite', 'append', 'rename', 'delete']) {
      check(`${run.mode}: outside ${operation}`, d.existingOutsideFiles[operation]?.allowed === !confined);
    }
    const pipe = (variant: string) => d.privatePipes.find(p => p.variant === variant);
    check(`${run.mode}: fresh logon-scoped private pipe`, pipe('explicit-logon-low')?.clientOpened);
    if (confined) {
      check(`${run.mode}: explicit user-only pipe remains denied`, pipe('explicit-user-admin-system')?.clientOpened === false);
      check(`${run.mode}: Low label alone does not bypass pipe DACL`, pipe('explicit-user-admin-system-low')?.clientOpened === false);
    }
    check(`${run.mode}: fresh private namespace usable`, d.namespaces.creation.length === 2 && d.namespaces.creation.every(n => n.created));
    for (const name of ['cmd', 'cmd-pipeline', 'pwsh']) {
      check(`${run.mode}: native ${name}`, shells.some(s => s.mode === run.mode && s.name === name && s.exitCode === 0 && s.stdout.includes('native-')));
    }
  }
  check('outside canary unchanged', report.outsideCanaryUnchanged);
  check('privileged parent verified denied outside mutations', report.restrictedOutsideFixturesUnchanged);
  check('installed DSH sources and runtime bytes unchanged', report.installedSourcesUnchanged);
  check('installed Git runtime bytes unchanged', report.installedGitRuntimeUnchanged);
  const copies = report.privateRuntime as Array<{ originalHash: string; copiedHashes: Record<string, string> }>;
  check('private runtime copies are byte-identical', copies.length === 2 && copies.every(file => Object.values(file.copiedHashes).every(hash => hash === file.originalHash)));
  const cleanup = report.cleanup as { temporaryRootRemoved: boolean; failures: string[] };
  check('temporary data and private namespace cleaned up', cleanup.temporaryRootRemoved && cleanup.failures.length === 0);
  const bash = shells.filter(s => s.name === 'git-bash' && s.mode !== 'unconfined-control');
  const verdict = bash.length === 2 && bash.every(s => s.exitCode === 0) ? 'startup-only; full feature parity not certified' : 'blocked: stock MSYS runtime does not start confined';
  return { verdict, passed: checks.filter(x => x.passed).length, total: checks.length, checks };
}

interface Phase2Run {
  mode: 'read-only' | 'workspace-write'; variant: string; copiesMatch: boolean;
  exitCode?: number; observerExitCode: number; stdout: string; error?: string;
  observerTokenUnchanged: boolean; observerDefaultDaclUnchanged: boolean;
  descendantMatchesSource: boolean; descendant: Diagnostic | null;
  outsideFixturesUnchanged: boolean; executablePagesWritten: boolean;
  processFamily: Array<{ pid: number; privateMsys: boolean; exited: boolean }>;
  trace: Array<{ event: string; pid: number; adjusted?: boolean; freshPrivatePipe?: boolean; fromPrivateMsys?: boolean; informationClass?: number; privateNamespaceVerified?: boolean; pageFileBacked?: boolean }>;
  namespacesAfterExit: Array<{ status: string }>;
}

/** Phase 2 assertions separate process-local compatibility from machine-state checks. */
export function assessPhase2(report: Record<string, unknown>) {
  const checks: Array<{ name: string; passed: boolean }> = [];
  const check = (name: string, condition: unknown) => checks.push({ name, passed: condition === true });
  const runs = report.runs as Phase2Run[];
  const modes = report.expectedModes as string[] | undefined;
  check('requested sandbox modes were exercised', !!modes?.length && modes.every(mode => runs.some(run => run.mode === mode)));
  for (const run of runs) {
    const label = `${run.mode}/${run.variant}`;
    check(`${label}: byte-identical private runtime`, run.copiesMatch);
    check(`${label}: observer completed`, run.observerExitCode === 0);
    check(`${label}: observer restriction state unchanged`, run.observerTokenUnchanged);
    check(`${label}: observer default DACL unchanged`, run.observerDefaultDaclUnchanged);
    check(`${label}: no executable-page writes requested`, run.executablePagesWritten === false);
    check(`${label}: owned process family exited`, run.processFamily.length > 0 && run.processFamily.every(process => process.exited));
    check(`${label}: outside fixtures unchanged`, run.outsideFixturesUnchanged);
    for (const [index, event] of run.trace.entries()) {
      if (!event.adjusted) continue;
      const privateProcess = run.processFamily.some(process => process.pid === event.pid && process.privateMsys);
      const constrained = event.event === 'CreateNamedPipeW' ? event.freshPrivatePipe
        : event.event === 'NtSetInformationToken' ? event.fromPrivateMsys && event.informationClass === 6
        : event.event === 'NtCreateSection' ? event.privateNamespaceVerified && event.pageFileBacked : false;
      check(`${label}: adjustment ${index} is confined to verified private MSYS IPC`, privateProcess && constrained);
    }
    if (run.variant !== 'ipc') continue;
    check(`${label}: verified private namespaces disappeared`, run.namespacesAfterExit.length > 0
      && run.namespacesAfterExit.every(namespace => namespace.status === '0xc0000034' || namespace.status === '0xc000003a'));
    check(`${label}: complete command exited successfully`, run.error === undefined && run.exitCode === 0);
    check(`${label}: MSYS executable child`, run.stdout.includes('@@DSH_MSYS_CHILD@@0\n'));
    check(`${label}: Bash pipeline`, run.stdout.includes('@@DSH_PIPELINE@@pipeline-ok\n'));
    check(`${label}: Bash outside redirection denied`, run.stdout.includes('@@DSH_BASH_WRITE@@outside:denied\n'));
    check(`${label}: Bash workspace redirection follows policy`, run.stdout.includes(`@@DSH_BASH_WRITE@@workspace:${run.mode === 'read-only' ? 'denied' : 'allowed'}\n`));
    check(`${label}: native descendant retained restrictions`, run.descendantMatchesSource && run.descendant?.tokenUnchanged);
    if (run.descendant) {
      check(`${label}: descendant remains in a Job`, run.descendant.token.inJob);
      for (const location of ['workspace', 'outside', 'temp']) {
        const expected = run.mode === 'workspace-write' && location !== 'outside';
        check(`${label}: descendant ${location} write`, run.descendant.files[location]?.written === expected);
      }
      for (const operation of ['overwrite', 'append', 'rename', 'delete']) {
        check(`${label}: descendant outside ${operation} denied`, run.descendant.existingOutsideFiles[operation]?.allowed === false);
      }
    }
  }
  for (const property of ['watchedFilesUnchanged', 'watchedSecurityUnchanged', 'canaryUnchanged']) check(property, report[property]);
  const before = report.ordinaryBashBefore as { exitCode: number; stdout: string } | undefined;
  const after = report.ordinaryBashAfter as { exitCode: number; stdout: string } | undefined;
  check('ordinary installed Git Bash behaves the same before and after', before?.exitCode === 0 && after?.exitCode === 0 && before.stdout === after.stdout);
  const cleanup = report.cleanup as { temporaryRootRemoved: boolean; addedAmbientLocks: string[]; environmentRestored: boolean } | undefined;
  check('private temporary tree removed', cleanup?.temporaryRootRemoved);
  check('no ambient ACL lock files added', cleanup?.addedAmbientLocks.length === 0);
  check('controller environment restored', cleanup?.environmentRestored);
  check('no cleanup errors', Array.isArray(report.cleanupErrors) && report.cleanupErrors.length === 0);
  const passed = checks.filter(check => check.passed).length;
  return { verdict: runs.some(run => run.variant === 'ipc') && passed === checks.length
    ? 'process-local IPC feasibility checks passed; production and full feature parity remain unvalidated'
    : 'incomplete or failed compatibility experiment', passed, total: checks.length, checks };
}
