# DSH Git Bash on Windows

Experimental Git Bash backend for native Windows x64, Node 26+ and DSH
**0.2.2-rc.2**. It provides lazy cache preparation, optional guarded UAC,
shared executor readiness, explicit rebuilding, scoped views, native Bash
execution and strict offline cache purge. In DSH Web, open the sidebar, choose
**Plugins**, then select **Git Bash on Windows** under installed plugins to read
this README. The **Git Bash path** field and **Save and link** button appear
below it. Keep the current path and click the button to rebuild its hard links.

The approved backend roadmap, contract baseline and design decisions in `docs/`
govern the implementation. The Phase 6 verification record lists supported-system
results and remaining manual consent checks.
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

`lib/` is tracked in Git. After editing `src/`, run `pnpm build` and include
the regenerated JavaScript and declarations with the source change.
`pnpm build` cleans `lib/` before compiling only `src/`. `pnpm check` and lint
also cover `scripts/` and `test/`; `pnpm test` rebuilds and runs maintained
`node --test` cases. The TypeScript 7 compiler uses the `@typescript/native`
alias; TypeScript 6 supplies the API required by typescript-eslint.
The supervisor benchmark in `docs/` reports Windows command latency, launcher
memory and CPU measurements, with steps to reproduce them.
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

For explicit manual consent checks, build first, then run the selected command in
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
establish that an independent late helper ran. Record what was observed. A helper
holding its plan or another removal obstruction makes purge fail explicitly;
resolve it and retry the reported fixture's cleanup. A pending prompt alone may
outlive successful cleanup; the revoked lease still prevents late helper work.
These manual checks are not run by automated packaging.

`scripts/installed-dsh.ts` discovers the installed CLI without loading a profile.
If discovery is ambiguous, set `DSH_PACKAGE_JSON` for the current process to the
absolute installed `@deepseek-ai/dsh/package.json`. The selected CLI must match
the pinned release. Only an absent CLI skips the installed-CLI test; ambiguous,
invalid or broken installations fail validation. Checkout installation tests use the
official DSH package operation in an isolated profile with private pnpm storage.
They exercise local `file:` installation, standalone script resolution, profile-cache
purge, blocked removal, bundle restoration and preservation of shared Shell
settings after removing the plugin-only override. No personal profile is opened.

The installation test checks the files in the installed package against the
tracked build output, bundled locales, `cordis.patch.yml`, `README.md` and the manifest.
`pnpm test:release` verifies the supported Windows, DSH and Git prerequisites,
then runs type checking, lint, a clean build and the maintained test suite.

## Installing from the checkout

From the repository root in Windows-native Git Bash, register the checkout
with the intended DSH profile. The tracked `lib/` contains the runtime.
The wrapper passes an absolute pnpm executable to the DSH plugin manager.

```bash
pnpm install --ignore-scripts --frozen-lockfile
gitbash_pnpm="$(cygpath -m "$(type -P pnpm.exe)")"
node scripts/plugin.ts "$gitbash_pnpm" web add "file:$(cygpath -m "$PWD")"
```

Use `desktop` for a Desktop profile. On systems where DSH can resolve pnpm
by name, the equivalent CLI command is
`dsh plugin --profile web add "file:$(cygpath -m "$PWD")" --ignore-scripts`.
Installation and replacement retain the profile cache. The removal wrapper
purges it before removing the package. A live pin or unowned cache blocks removal.
Restart DSH unelevated after installation or bundle enable/disable changes.

For a nonstandard Git installation, enter the path to `bin/bash.exe` or
`usr/bin/bash.exe` on the plugin page and click **Save and link**.
The button saves any change, then asks the active executor to rebuild the hard
links once. With the path unchanged, it goes straight to rebuilding. Saving a
blank field clears the profile override and restores the inherited path, or
automatic discovery when no path is inherited. If DSH reports a configuration
conflict, review the last saved path before retrying. If linking fails
after a successful save, the path stays saved. Click again to retry linking.
Shared command timeouts and output limits remain on DSH's **Shell** page.

On the first Bash command, DSH checks the cached runtime. If it needs new
links, it tries one link with your normal permissions. A successful automatic
rebuild shows **Hard links created**. If the probe requires administrator
permission, the DSH window shows a confirmation dialog before Windows opens
UAC. The dialog identifies a detected change to Git's source files, or explains
that permission is needed for setup or cache recovery. Select **Confirm** to
continue. **Save and link** already requests the rebuild explicitly and proceeds
directly to UAC when needed. Only the fixed linker runs elevated.

An automatic rebuild failure appears in the **Could not create hard links**
dialog, including when you are in chat. An undismissed failure is available to
a reconnected window while the executor is running. Shell commands keep their
own timeouts. If a command times out before confirmation, retry the command
after linking succeeds.

If no interactive DSH window is available, including in `dsh headless`, a
probe that requires elevation stops and prints a command for **Windows Git
Bash**. Run the printed command from an ordinary terminal and retry the task
in a new DSH process. It invokes the installed package for the affected
profile and selected Git installation.

```bash
node '<installed package>/lib/link-runtime-cache.js' '<absolute DSH profile directory>' '<absolute path to bash.exe>' '<DSH installation anchor>'
```

The command uses the running DSH installation's bundle resolver to check that
the named profile enables this copy of the plugin. It reuses an already valid
runtime in that profile's private cache. Git and the profile
cache must be on the same NTFS volume.

`pnpm test:browser` exercises the confirmation and failure dialogs across three
tabs using a disposable Git fixture. To verify Windows consent as well, run
`DSH_GIT_BASH_UAC_TEST=deny pnpm test:browser` and choose **No**, then run
`DSH_GIT_BASH_UAC_TEST=approve pnpm test:browser` and choose **Yes**.

The field belongs to the existing `pwsh-sandbox` row. A manual profile override
can look like:

```yaml
- id: pwsh-sandbox
  config:
    gitBashPath: 'C:/Tools/Git/bin/bash.exe'
    # Preserve all existing shared Shell values here.
```

DSH replaces a patched `config` wholesale. Preserve existing timeout, output,
working-directory and grace settings when editing YAML. The cache and Git source
must share an NTFS volume; neither may overlap the actual workspace in either
containment direction. The only cache location is
`<profileContext.dir>/.git-bash-on-win`, fixed for each DSH profile. The plugin has
no cache-location setting. A DSH profile context is required when constructing the
executor; cache preparation remains lazy until a command or explicit rebuild.

## Integration and isolation contract

The bundle is Windows-only. The adapter preserves native entry IDs, canonical
module names and Shell configuration. The native Bash schema is reused with one
additional volatile `gitBashPath` setting; presets and tools reuse DSH modules.
The Loader mounts the adapter at the package root so DSH can discover its web
client. Code importing the executor class or its `Config` type uses
`dsh-git-bash-on-win/executor`. The client registers its configuration slot
after reading the bundled English and Chinese dictionaries through DSH Connection.
Changing the interface language preserves the current draft.

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

The active executor handles the owner-only `POST /api/git-bash-on-win/rebuild`
by calling `GitBashExecutor.rebuildRuntime()` once. It uses its configured Git
path and profile cache to prepare a fresh generation. A ready pin continues
serving commands until the new generation is adopted. A failed rebuild of the
same path preserves that pin. Without readiness, rebuilding cancels and drains
unfinished preparation and becomes the shared readiness for new and displaced
callers. Overlapping rebuild calls fail as busy. An unchanged failed selection is retained until explicit rebuild
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
node '<installed package>/lib/purge-runtime-cache.js' '<absolute profile directory>/.git-bash-on-win'
```

This purges the supplied profile cache.
Only a root with this implementation's valid ownership marker is admitted; an old,
markerless or unrecognized directory is refused without deletion. Recovery uses
ordinary plan unlink and native generation claims; a busy pin or plan prevents
completion. Deletion uses checked `DeleteFileW`/`RemoveDirectoryW` calls without
attribute repair; read-only files cause an explicit obstruction. Enumerated names
are addressed exactly, including unusual trailing characters. After an obstruction
clears, rerun purge. For offline rebuilding, retain the package and settings.
After purge succeeds, restart DSH. The next Bash command prepares a fresh
runtime, or you can click **Save and link** to rebuild immediately.

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
instances, successfully purging the profile cache, then using official package removal.
After removing that field through the native editor or editing its profile patch
(delete a manually added override row only if it becomes empty), the repository
wrapper performs purge before official removal:

```bash
pnpm install --ignore-scripts --frozen-lockfile
gitbash_pnpm="$(cygpath -m "$(type -P pnpm.exe)")"
node scripts/plugin.ts "$gitbash_pnpm" web remove dsh-git-bash-on-win
```

The wrapper leaves configuration editing to DSH/user ownership. For native CLI
removal instead, run the installed cache purge command above first, then
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

Entering the `current.json` atomic-write phase is the cancellation cutoff. Before
entry, cancellation prevents publication. Once entered, the factory drains the
write and returns the published pin on success even if cancellation arrives;
actual write or native cleanup failures still reject. Executor selection and
shutdown guards still release stale pins and prevent cancelled commands from
launching. Disposal waits for an initiated write rather than rolling it back.

Preparation probes one Bash hardlink before inventory. Only a permission denial
from that link creation selects the fixed elevated linker; a later failure never
resets the base or triggers another UAC pass. The helper validates the immutable
plan and existing NTFS identities, inventories independently and holds the plan
exclusively while linking. Source contents and ACLs remain unchanged.

The parent requires an uncancelled normal broker zero exit and DSH managed-range
settlement before final admission and atomic publication of `current.json`.
Provisioning retains the setup lease through the cache owner's synchronous final
anchor/root validation, then checked-closes it before plan cleanup and publication.
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
