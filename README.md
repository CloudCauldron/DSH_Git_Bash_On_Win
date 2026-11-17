# DSH Git Bash on Windows

Experimental Git Bash backend for native Windows x64, Node 26+ and DSH
**0.2.2-rc.2**. It provides lazy cache preparation, optional guarded UAC,
shared executor readiness, explicit rebuilding, scoped views, native Bash
execution and strict offline cache purge. There is no frontend or rebuild button.

The approved [roadmap](docs/backend-20261117-refactor-roadmap.md),
[contract baseline](docs/backend-20261117-contract-baseline.md) and
[design decisions](docs/backend-20261117-design-decisions.md) govern the implementation.
The [Phase 6 verification record](docs/backend-20261117-phase6-verification.md)
records supported-system results and remaining manual consent checks.
The local `.deprecated/` archive is reference material, excluded from maintained
source, tooling, tests, build output and packages. No archived runtime is launched.

## Development

Run these commands in **Windows-native Git Bash**:

```bash
pnpm install --ignore-scripts --frozen-lockfile
pnpm check
pnpm lint
pnpm test:windows
```

`pnpm build` cleans `lib/` before compiling only `src/`. `pnpm check` and lint
also cover `scripts/` and `test/`; `pnpm test` rebuilds and runs maintained
`node --test` cases. The TypeScript 7 compiler uses the `@typescript/native`
alias; TypeScript 6 supplies the API required by typescript-eslint.
Public DSH dependencies, including `@deepseek-ai/dsh-atomic-write`, are pinned.
Standalone launcher, broker, helper and cleanup imports are installed as explicit
dependencies, including their runtime peer requirements. Host-facing peer
constraints are retained. DSH profiles use `autoInstallPeers: false`; development
dependency resolution alone does not validate an installed package.
The broker declares Koffi 3.1.1 (the SDK's existing version) for ShellExecuteEx/COM,
which the SDK does not expose; process wait/close still use the public DSH helpers.

Bootstrap tests verify the native schema, Loader entry/configuration identity,
installed CLI discovery, public dependency resolution and transitive input
exclusion. They use disposable fixtures and never open a personal profile.
The native Phase 2 suites verify root ownership, bounded inventory/linking,
single-record publication, warm admission, pin/collector sharing, interrupted
collection/purge, view lifetime and cleanup. Fixtures contain owned source files;
tests verify restored source link counts and unchanged contents/ACLs after purge.
The Phase 3 suite verifies probe-only escalation, independent helper admission and
inventory, plan/lease sharing, cancellation/draining, failed native wait/exit/close
outcomes, and publication gates. It also runs the fixed helper through a real
isolated DSH subprocess provider and terminates a broker fixture blocked in a
native call. The broker smoke test changes only its ShellExecuteEx verb to `open`
through a test-only ESM preload, exercising the real COM/request ABI, argv,
process wait/close and emitted entry points without consent. The ordinary helper
may inherit the broker's Job; this does not test independent elevated lifetime.
The Phase 4 suite exercises the native executor's deferred confinement and deadline
mechanics, real Loader volatile updates, and actual NTFS cache/pin/view lifetime.
Command subprocess outcomes and UAC denial are controlled fixtures; it does not
launch Bash or grant workspace ACLs. It covers shared readiness, displaced waiters,
rebuild success/failure, stale completion, disposal, and cleanup failures. View
tests cover failed creation/cleanup, retry, unexpected EEXIST and validation ownership.
The native lane runs the emitted executor, launcher and debugger through
installed DSH sandbox/subprocess providers in a temporary context. It copies the
selected Git files into owned fixture storage before linking, so it never asks for
consent or changes installed Git ACLs. It exercises Bash/Git, pipelines, nested
shells, native descendants, mode-specific writes, namespace separation/reuse,
child admission failures, overlapping execution, cancellation and disposal.
Separate workspace sessions also probe a live MSYS pinfo mapping: the owner can
open it for writing, peer confined sessions can read but receive access-denied
for writing, and full-access retains write access. The probe never changes pinfo.
Every fixture joins its processes and strictly purges the cache; source
contents/ACLs and all copied source link counts are checked afterward. Missing
Windows x64, supported Git or pinned DSH prerequisites are explicit skips; a
release run must execute this lane. `DSH_TEST_GIT_BASH` can select its source Git.
Native fault tests retain the real hook engine and change only owned fixture
paths between launch admission and process creation. Close-failure injection in
the earlier suites reports failure after closing the test handle; it does not
reproduce an unrecoverable kernel handle fault. Modal consent remains a separate
manual lane.

For explicit manual consent checks, build first, then run either command in
Windows-native Git Bash and answer the Windows prompt as specified:

```bash
pnpm build
DSH_GIT_BASH_UAC_TEST=approve node --test --test-name-pattern='manual UAC' test/provisioning.test.ts
DSH_GIT_BASH_UAC_TEST=deny node --test --test-name-pattern='manual UAC' test/provisioning.test.ts
DSH_GIT_BASH_UAC_TEST=late node --test --test-name-pattern='manual UAC' test/provisioning.test.ts
```

This lane forces only the initial probe denial on an owned source fixture, then
uses the production broker/helper and strict fixture purge. It changes no installed
Git ACLs and opens no personal profile. It is not registered in the default suite.
For `late`, leave consent pending until `LOCAL SHUTDOWN COMPLETED` is printed
after the ten-second cancellation deadline, then approve within twenty seconds.
The test refuses publication and requires strict purge. If Windows dismisses the
prompt when the broker stops, this exercises modal cancellation only; it does not
establish that an independent late helper ran. Record what was observed. A busy
helper or unfinished prompt makes purge fail explicitly; resolve it and retry the
reported fixture's cleanup. These manual checks are not run by automated packaging.

`scripts/installed-dsh.ts` discovers the installed CLI without loading a profile.
If discovery is ambiguous, set `DSH_PACKAGE_JSON` for the current process to the
absolute installed `@deepseek-ai/dsh/package.json`. The selected CLI must match
the pinned release. Only an absent CLI skips the installed-CLI test; ambiguous,
invalid or broken installations fail validation. Packed-install tests use the
official DSH package operation in an isolated profile with private pnpm storage.
They exercise real tarball installation, standalone script resolution, both-cache
purge, blocked removal, bundle restoration and preservation of shared Shell
settings after removing the plugin-only override. No personal profile is opened.

Production package inputs are limited to `lib/`, `cordis.patch.yml`, `README.md`
and the manifest. `pnpm --ignore-scripts pack --dry-run --json` audits that allowlist.
`prepack` runs typecheck, lint and a clean production build. Before producing a
release artifact, run `pnpm test:release`: it also requires supported Windows,
installed pinned DSH and supported Git before running the maintained suite, so
missing native prerequisites cannot silently skip release verification.

## Packaging and installation

In Windows-native Git Bash:

```bash
pnpm test:release
pnpm pack --pack-destination artifacts
gitbash_pnpm="$(cygpath -m "$(type -P pnpm.exe)")"
node scripts/plugin.ts "$gitbash_pnpm" web add "$(cygpath -m "$PWD/artifacts/dsh-git-bash-on-win-0.1.0-experimental.1.tgz")"
```

Choose the intended profile instead of `web`. The repository wrapper delegates to
the pinned DSH public plugin-manager operation, including compatibility checks and
bundle reconciliation, using an absolute pnpm executable. It accepts only `add`
with an absolute tarball path or `remove dsh-git-bash-on-win`; lifecycle scripts
are disabled and arbitrary pnpm flags are not forwarded. Where native executable
lookup works, `dsh plugin --profile web add <tarball> --ignore-scripts` is equivalent.
Restart DSH unelevated after installation or bundle enable/disable changes.

For a nonstandard Git installation, set `gitBashPath` on the existing
`pwsh-sandbox` row through DSH's native configuration editor. Both `bin/bash.exe`
and `usr/bin/bash.exe` are accepted. A manual profile override can look like:

```yaml
- id: pwsh-sandbox
  config:
    gitBashPath: 'C:/Tools/Git/bin/bash.exe'
    # Preserve all existing shared Shell values here.
```

DSH replaces a patched `config` wholesale. Preserve existing timeout, output,
working-directory and grace settings when editing YAML. The cache and Git source
must share an NTFS volume; neither may overlap the actual workspace in either
containment direction. The profile cache is `<profile directory>/.git-bash-on-win`;
contexts without profile metadata use `<installed package>/.runtime`.

## Integration and isolation contract

The bundle is Windows-only. The adapter preserves native entry IDs, canonical
module names and Shell configuration. The native Bash schema is reused with one
additional volatile `gitBashPath` setting; presets and tools reuse DSH modules.
There is no frontend or custom settings UI.

Compatibility work stays within DSH's Windows Git Bash process family.
Ordinary Git Bash, other hosts, WSL and non-Windows DSH must remain unaffected.
Installed Git/DSH contents and ACLs, registry settings and global environment are
never modified. Managed artifacts stay in private DSH cache directories.

The launcher validates the inherited DSH mode/token, and the debugger admits the
base/executable/view once before spawning through DSH's public private-Job helper.
Loaded MSYS modules must have the admitted file identity, an actual loader path
inside that base, and private Job membership. The startup-root hook uses the
scoped view in every mode, including full-access; pipe/default-DACL/mapping grants
apply only in confined modes. Namespace separation does not promise IPC
confidentiality: peer reads, shared-logon-SID read-only writes and broad full-access
rights remain limits of DSH's partial Windows enforcement.

## Recovery and complete uninstallation

The cache layer provides guarded offline purge. Normal pin retirement retains
the validated cache, refuses new uses, and protects existing uses with the same
native directory handle until their last release. View cleanup is best effort;
native handle close failures remain errors. Executor disposal blocks new work,
signals commands before draining setup, and releases owned pins/uses. The launcher
joins debug-event exits and actual Job settlement before returning; after the root
exits, surviving descendants receive the configured grace period before Job
termination. Admission or native cleanup failure fails the execution without an
unrestricted retry.
The pinned native Shell exposes target completion before the subprocess range is
necessarily empty. A per-command Cordis receiver waits for DSH's existing
`waitForExit()` before releasing the runtime use, including cancellation or a
launcher crash; sibling subprocess consumers are unaffected. Failed range
observation is reported at disposal and retains the existing pin reference until
host-process exit, so an unconfirmed shutdown cannot authorize cache collection.

`GitBashExecutor.rebuildRuntime()` is implemented as a backend operation, with no UI
binding or workspace argument. It always prepares a fresh generation. A ready pin
continues serving commands until successful guarded adoption; failed rebuilding
preserves it. Without readiness, rebuilding cancels/drains unfinished preparation
and becomes the shared readiness for new and displaced callers. Overlapping rebuild
calls fail as busy. An unchanged failed selection is retained until explicit rebuild
or selection/provider replacement. Caller cancellation stops only that caller's
wait; disposal or observed selection changes cancel owned setup. An unresolved
local resource-cleanup failure blocks replacement setup and is reported at disposal.
Cleanup failures are retained even when preparation rejects before retirement;
ordinary source/setup errors during cancellation do not poison later rebuilding.
Failed admission of a newly created empty directory attempts exact non-following
rollback, allowing view creation to retry after a transient observation failure.
If that rollback is also obstructed, the pin retains ownership of its created
namespace for retry and final cleanup. Unexpected namespace EEXIST grants no such
ownership. Native failures inside lease acquisition are also retained when the
caller cancels or the selected pin changes.

Close all relevant DSH instances before running the **installed package's** entry:

```bash
node '<installed package>/lib/cleanup.js' '<absolute profile directory>/.git-bash-on-win'
```

This purges both the supplied profile cache and the package `.runtime` fallback.
Only a root with this implementation's valid ownership marker is admitted; an old,
markerless or unrecognized directory is refused without deletion. Recovery uses
ordinary plan unlink and native generation claims; a busy pin or plan prevents
completion. Deletion uses checked `DeleteFileW`/`RemoveDirectoryW` calls without
attribute repair; read-only files cause an explicit obstruction. Enumerated names
are addressed exactly, including unusual trailing characters. After an obstruction
clears, rerun purge. For offline rebuilding,
retain the package and settings. The next Bash call lazily prepares a fresh runtime.

| Obstruction | Recovery |
| --- | --- |
| Markerless, unrecognized or unsafe cache root/ancestor | Stop; the plugin has no authority to adopt or recursively remove it. Verify the selected path and ownership. |
| Live generation pin or writer lock | Close all DSH instances using the cache, then retry. Purge preclaims every generation before deleting payload. |
| Busy helper plan or unconfirmed late elevated work | Keep the candidate unpublished. Let the helper drain/release its plan; retry guarded purge. A new attempt never reauthorizes the old lease. |
| Access denial, read-only artifact, unsupported reparse point or failed close | Treat cleanup as incomplete and inspect the reported operation/path. The plugin never changes attributes or ACLs to force deletion. |
| Failure after the initial hardlink probe | Resolve the source/IO obstruction and explicitly rebuild. Setup drains and rejects without resetting the base or requesting another UAC pass. |

Once guards permit removal, normal preparation collects unused generations through
the same non-following primitives. It does not permanently freeze a rejected
candidate; warm hits perform no collection. Session-view residue can persist in a
selected generation until eligible collection or offline purge.

Complete uninstallation requires removing only the plugin-specific `gitBashPath`
override while preserving shared Shell settings, closing all relevant DSH
instances, successfully purging both caches, then using official package removal.
After removing that field through the native editor or editing its profile patch
(delete a manually added override row only if it becomes empty), the repository
wrapper performs purge before official removal:

```bash
node scripts/plugin.ts "$gitbash_pnpm" web remove dsh-git-bash-on-win
```

The wrapper leaves configuration editing to DSH/user ownership. For native CLI
removal instead, run the installed cleanup entry above first, then
`dsh plugin --profile web remove dsh-git-bash-on-win --ignore-scripts`.
Native package removal alone preserves settings and does not purge runtime caches.
If multiple profiles used the same installed package, purge each profile cache
before removing that package. An idle instance holding no pin is not detected by
purge and can recreate storage, so closing all relevant instances is mandatory.
Purge must not follow junctions/reparse points; interruptions, blocked removal
and failed native closes must fail explicitly. Never recursively delete these
caches as a substitute for guarded purge.

Source contents and ACLs must remain unchanged and source link counts must be
restored. Hardlink creation/removal changes filesystem-maintained timestamps,
archive bits and journal/audit records; this permitted bookkeeping is observable.
No bit-for-bit restoration of host state is promised.

The six-anchor warm check is a bounded freshness sample, not a full-tree
comparison. Restart does not promise non-anchor repair; explicit rebuild restores
layout from installed Git and cannot repair damaged source bytes.
Source pathname replacement does not invalidate an admitted live pin. In-place
writes and ACL changes propagate through hardlinks, including Bash/MSYS files.
Non-anchor additions, removals or replacements may be missed during preparation
or survive warm restart; setup is not an atomic source snapshot. Child module
checks admit repairs and execution, not freshness. Ordinary nonzero command exits
do not trigger rebuilding. Atomic current-record replacement is the publication
boundary, without a power-loss durability guarantee.

Preparation probes one Bash hardlink before inventory. Only a permission denial
from that link creation selects the fixed elevated linker; a later failure never
resets the base or triggers another UAC pass. The helper validates the immutable
plan and existing NTFS identities, inventories independently and holds the plan
exclusively while linking. Source contents and ACLs remain unchanged.

The parent requires an uncancelled normal broker zero exit and DSH managed-range
settlement before final admission and atomic publication of `current.json`.
Failed target outcomes revoke setup without waiting for surviving managed work.
Both linking callers revalidate their admitted source/base identities after
inventory and before writing payload; this is not an atomic source snapshot.
Cancellation closes the setup-only lease, then gives the broker a short grace
before DSH termination/join. This does not promise dismissal of consent or exit
of an independently elevated helper. Its revoked candidate stays unpublished;
the exclusive plan handle prevents guarded GC/purge from traversing active payload.
Once that obstruction clears, normal guarded recovery can remove the residue.

Preparation and recovery do not run archived helpers. Warm hits do not create
owner files, scan the tree, collect old generations or wait on the writer lock.
Native fixture measurements are reported by the tests; 5 ms remains an
unestablished target.
