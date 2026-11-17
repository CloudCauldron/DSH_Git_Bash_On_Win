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

After the profile-only change, `pnpm pack --pack-destination artifacts` completed with its
normal prepack checks. `artifacts/dsh-git-bash-on-win-0.1.0-experimental.1.tgz`
contains exactly the 31 expected production/package files (44,691 bytes). SHA-256:
`969305dc65530ac228a1bb9317c78dc69978b44fad34f34076e8b6b8d02d357f`.
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
- Live pins in the profile cache block package removal;
  the dependency remains installed and the pinned selection remains intact.
- Unowned profile-cache directories block removal. No markerless directory is adopted
  or recursively deleted by the plugin.
- Offline rebuild cleanup removes the profile cache while preserving the package
  and `gitBashPath`. Complete removal purges that cache before official removal.
- Package installation preserves the profile cache and its selected generation.
  Executor construction requires a DSH profile before registering the Shell service.
- The documented manual removal of only `gitBashPath` preserves shared Shell
  values. Official package removal preserves that patch; the subsequent native
  config dump restores the original bundle composition and timeout setting.
- Source contents/ACLs remain unchanged and source hardlink counts are restored.
  Fixtures strictly purge their caches before removing their ordinary test files.

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

## Adversarial audit round 1 — former cache design

A context-independent reviewer and the implementing agent inspected Phase 6 and
the pinned public DSH code. Native isolated experiments reproduced two package
cleanup bypasses: upgrading could let pnpm remove an existing `.runtime` without
guarded purge, and a missing installed manifest could be mistaken for package
absence during removal. At that stage, the wrapper was changed to locate the fixed
package entry directly and purge its cache before either operation. The later
[profile-only decision](backend-20261117-design-decisions.md#one-fixed-cache-per-dsh-profile)
removed this package-cache lifecycle and its tests altogether.

Both reviewers also found that a manual deny/late assertion could lose an
unexpectedly fulfilled pin. The manual test now retains and finally releases it,
then verifies source contents/ACLs/link counts after strict purge. An early-approval
attempt during this audit exercised that failing-assertion cleanup path.
`pnpm test:release` passed again: typecheck, lint, clean build and all 139 tests,
zero failures or skips (68.74 seconds). No recent native/bootstrap fixture
directories remained after the audit runs.

## Adversarial audit round 2

A fresh context-independent reviewer examined the full Phase 6 change, current
corrections, roadmap contracts and pinned DSH implementations. No further actionable
defect was found. The dependency closure is justified by actual public imports:
the ACL API loads `dsh-skill → dsh-scope`, the Win32 API loads `dsh-error`, and
related services require Cordis. The installed-host identity test checks that
these standalone dependencies do not split the native Shell/schema identities.

The in-context pass reused the existing timer helper, removed redundant error
assertions and an unnecessary repeated purge, and scoped the manual probe mock
immediately around the protected operation. Typecheck, lint and clean packaging
passed. This round introduced no runtime module, middleware or state model, and
did not rerun or claim additional UAC interactions. Audit confidence is bounded by
the supported environment and the explicit manual observations below.

## Profile-only implementation

The [profile-only decision](backend-20261117-design-decisions.md#one-fixed-cache-per-dsh-profile)
is implemented in the executor, cleanup CLI and package wrapper. Active source,
tooling, tests, generated code and ignore rules contain no package-cache path.
The former cleanup fixture was removed; the real packed-profile test now verifies
cache retention on installation and strict purge before removal. A new test checks
that missing profile context fails before Shell registration. Fixture teardown
again requires strict purge of every tracked cache, with no exception for removed
package directories.

`pnpm test:release` passed typecheck, lint, a clean build and **139 tests with zero
failures or skips** (69.63 seconds). Packaging and its 31-file allowlist also passed.
The cache-location change did not alter the broker/helper protocol; the earlier
manual observations below remain the recorded UAC evidence.

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
Complete uninstall requires successful purge of all relevant profile
caches and removal of the plugin-only setting before official package removal.
Close every relevant DSH instance first: an idle instance without a pin can recreate
a cache. Hardlink bookkeeping effects remain permitted and observable; no
bit-for-bit restoration of host state is claimed.
