# Phase 6 — Integration, packaging and recovery verification

Recorded: 2026-11-17. Starting implementation: `a74148a`.
Contracts: [roadmap §§1–10](backend-20261117-refactor-roadmap.md) and
[AGENTS.md](../AGENTS.md). The Phase 0 checklist remains a historical baseline.

## Result and supported environment

All shell work used Windows-native Git Bash. Verification ran on Windows 11 x64
(10.0.26200), Node 26.12.1, pnpm 12.18.0, DSH 0.2.2-rc.2 and Git for Windows
2.56.0.windows.4. The initial maintained suite passed 138 tests without skips.
After Phase 6 changes, `pnpm test:release` passed typecheck, lint, a clean build and
**139 tests, zero failures, zero skips** (114.62 seconds for the test runner).

The real native lane executed Bash/Git, pipelines, nested shells and descendants
through production DSH subprocess/sandbox providers in read-only, workspace-write
and full-access modes. It retained real token, Job, loader and module admission,
checked direct-view namespaces and actual mapping access, and exercised overlapping
commands, cancellation and disposal. Owned source copies kept installed Git out
of confinement grants and automatic consent. Teardown joined owned processes,
strictly purged caches and compared every copied source file's contents, link
count and ACLs. A failed cleanup is a failed test.

Five warm admissions against the real copied Git installation measured **36.87,
25.49, 33.98, 23.31 and 28.01 ms**. The small synthetic fixture measured 12.87 ms.
These are local observations during the suite, not latency guarantees; the 5 ms
target is not established. Warm admission is the metadata/anchor path, not a full
tree freshness check or per-command scan.

## Packaging and installed-profile coverage

The initial `pnpm pack --pack-destination artifacts` completed with its normal prepack checks.
That `artifacts/dsh-git-bash-on-win-0.1.0-experimental.1.tgz` contained
exactly the 31 expected production/package files (44,581 bytes). SHA-256:
`c17c1077d530e6850674dd59f416100197ff1cb4071e69954d1437a22e70d549`.
The generated tarball and detailed logs under `test/results/` remain Git-ignored.

`prepack` now runs typecheck, lint and a clean production build. `test:release`
checks native Windows, pinned installed DSH and supported Git prerequisites before
the maintained suite, so absent native prerequisites cannot turn a release run
into skipped execution coverage. Normal portable test runs retain explicit skips.

The new maintained package test creates a real tarball, installs it with DSH's
public plugin-manager operation into an isolated profile, and uses private pnpm
store/state paths. It neither loads a personal profile nor changes installed
Git/DSH, global environment, registry or ACLs. Package contents remain restricted
to production `lib/`, the manifest, bundle patch and README. Compiler graphs, lint
and package checks exclude archive, temporary research, tests and tooling inputs.

This test reproduced missing `@deepseek-ai/dsh-win32-process` resolution in an
installed helper: DSH's native profile configuration disables automatic peer
installation. The manifest now explicitly installs the standalone scripts'
public runtime dependency closure, retaining host-facing peer constraints and
the pinned versions. The test uses neither a repository `node_modules` junction
nor a custom resolver to conceal missing installed dependencies.

Coverage includes:

- Official bundle activation and restoration, platform refusal, and strict
  wrapper argument admission before profile operations. The wrapper supports
  only adding an absolute tarball or removing this plugin, with scripts disabled.
- Installed-host superclass and Shell schema identity through DSH's public
  profile resolution service, including the newly installed standalone dependencies.
- Packaged helper/launcher argument rejection after successful dependency loading,
  and successful execution of the packaged offline cleanup entry.
- Live pins in either profile or package fallback cache block package removal;
  the dependency remains installed and the pinned selection remains intact.
- Unowned fallback directories block removal. No markerless directory is adopted
  or recursively deleted by the plugin.
- Offline rebuild cleanup removes both caches while preserving the package and
  `gitBashPath`. Complete removal purges both caches before official removal.
- The documented manual removal of only `gitBashPath` preserves shared Shell
  values. Official package removal preserves that patch; the subsequent native
  config dump restores the original bundle composition and timeout setting.
- Source contents/ACLs remain unchanged and source hardlink counts are restored.
  The fixture recognizes already-absent caches after pnpm removes their parent;
  any remaining cache still requires strict purge before fixture-tree removal.

## Ownership and recovery review

No runtime coordinator, UI, new production module, alternative linker or raw
filesystem defense was added. The wrapper calls `purgeRuntimeCache`; package
compatibility and reconciliation remain DSH responsibilities. Settings editing
remains with DSH/the user, following the README's complete-uninstall sequence.

| Contract | Review and maintained evidence |
| --- | --- |
| Linear orchestration and centralized primitives | The 14 production modules retain their existing boundaries. Tooling composes the public package operation and existing guarded purge. |
| Publication and helper authorization | Existing provisioning/F4 tests require uncancelled broker success and managed-range settlement, revoke the setup lease on cancellation, reject late helpers and gate deletion on plan unlink. No result/receipt protocol or new helper authority is introduced. |
| Live execution and retirement | Executor/view tests retain before awaiting, keep old uses through rebuild, reject redirected views at launch and wait for command-range settlement before final release. Native family tests exercise actual Job/token/module ownership. |
| Crash/collection boundary | Existing tests cover pin/collector exclusion in both orders, all-generation purge preflight and interrupted collection/unpublication. Selector recheck prevents warm admission of a partially collected generation. No power-loss durability claim is added. |
| Recoverable cleanup | Failed candidates remain unpublished. Guarded GC defers busy pins/plans and later reclaims eligible residue; strict purge reports blocked IO, unsupported paths and close failures. There is no permanent-freeze policy or permission/attribute repair. |
| Source and host isolation | Canonical workspace/source/cache separation precedes confinement. Fixtures use owned copies; standalone imports use pinned public APIs. Source hardlink bookkeeping remains observable and is not concealed. |
| Freshness | Six saved anchor stamps are a bounded sample. Live pins do no freshness walk; non-anchor damage may survive restart. Explicit rebuilding restores layout from the current source but cannot repair damaged shared bytes. |

## Adversarial audit round 1

A context-independent reviewer and the implementing agent inspected Phase 6 and
the pinned public DSH code. Native isolated experiments reproduced two package
cleanup bypasses: upgrading could let pnpm remove an existing `.runtime` without
guarded purge, and a missing installed manifest could be mistaken for package
absence during removal. The wrapper now locates the fixed package entry directly
with existing NTFS primitives and purges the fallback before either operation.
Profile-cache purge remains removal-only. Regressions exercise pinned and unowned
fallbacks, retry after release, and missing-manifest refusal. No new state or
coordination layer was added.

Both reviewers also found that a manual deny/late assertion could lose an
unexpectedly fulfilled pin. The manual test now retains and finally releases it,
then verifies source contents/ACLs/link counts after strict purge. An early-approval
attempt during this audit exercised that failing-assertion cleanup path.
`pnpm test:release` passed again: typecheck, lint, clean build and all 139 tests,
zero failures or skips (68.74 seconds). No recent native/bootstrap fixture
directories remained after the audit runs.

## Manual verification and limits

With the user's help, real UAC approval passed (2.56 seconds); the user confirmed
clicking Yes on the prompt. Denial passed again with an assertion requiring the
actual `ShellExecuteExW` cancellation code **1223** (5.52 seconds), rather than
accepting any setup failure. Delayed consent passed (30.48 seconds): the controller
cancelled at ten seconds, the user confirmed the prompt remained and was approved
after twenty seconds, no cancelled attempt was published, and strict purge and
source-restoration checks completed. The test also now asserts that local shutdown
settles within five seconds of cancellation.

These observations establish approval, denial and delayed consent after controller
cancellation. They do not independently establish that an elevated helper actually
started after the broker stopped: the detached helper's process exit is not observed
by the cancelled controller. No receipt or extra production protocol was added.
A pending prompt alone need not block purge; a helper holding its plan does.
Stopping the broker does not promise prompt dismissal or independent-helper
termination. The revoked lease and guarded cleanup remain the authorization boundary.

Normal disposal may retain cache-local view residue while closing owned resources.
Complete uninstall requires successful purge of all relevant profile/fallback
caches and removal of the plugin-only setting before official package removal.
Close every relevant DSH instance first: an idle instance without a pin can recreate
a cache. Hardlink bookkeeping effects remain permitted and observable; no
bit-for-bit restoration of host state is claimed.
