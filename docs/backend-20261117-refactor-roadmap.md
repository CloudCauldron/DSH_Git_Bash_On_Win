# BACKEND REFACTOR AND HARDENING ROADMAP — RECOVERABLE, SINGLE-BASE DESIGN

DSH Git Bash on Windows

Revised: 2026-11-17

Baseline: 6c410c5a2496c30c9883fe471b38d9920c5c2675

Status: Phase 0 contract baseline and Phases 1–4 implementation complete. Maintained native verification covers cache preparation, guarded provisioning/F4, executor readiness/rebuilding, direct scoped views, ownership, pins and recovery. Phases 5–6 (launcher/debugger integration and release verification, including real modal UAC) remain pending. Public command execution and release packaging remain gated.

The versioned specification is [docs/backend-20261117-refactor-roadmap.md](../docs/backend-20261117-refactor-roadmap.md), promoted from the local planning roadmap on 2026-11-17. The [Phase 0 review checklist](../docs/backend-20261117-contract-baseline.md) records the implementation gates and verification handoff.

This is the implementation specification. Historical rationale, rejected alternatives and probe recaps live in [backend-20261117-design-decisions.md](../docs/backend-20261117-design-decisions.md). Canonical contracts: coding/validation ownership (§1), APIs and executor coordination (§4), root admission (§5), setup/recovery (§6), warm admission/metadata (§7), pins/views (§8), disposal/uninstall (§9) and maintained verification (§10).

## IMPLEMENTATION WORKSPACE

Create a clean active implementation tree. The original files remain reference-only under `.deprecated/`:

```text
  .deprecated/src/             original runtime implementation
  .deprecated/README.md        original behavior/setup/uninstall documentation
  .deprecated/test/, .deprecated/poc/ original legacy tests and experiments
  .deprecated/lib/, .deprecated/artifacts/ original generated/package output
  .deprecated/scripts/, .deprecated/docs/ original tooling/documentation
  .deprecated/tsconfig*.json, .deprecated/pnpm-lock.yaml,
  .deprecated/pnpm-workspace.yaml and .deprecated/cordis.patch.yml
    original build/dependency/bundle configuration
```

The move retained `.git/`, `.gitignore`, `AGENTS.md`, `node_modules/`, `package.json`, `tmp/` and `eslint.config.mjs`; maintained `docs/` was added afterward. Contents and identities were preserved; the inventory is `tmp/deprecated-move-manifest-2026-11-15.json`. Per the user's 2026-11-17 instruction, keep `.deprecated/` intentionally excluded by the root `.gitignore`; do not force-add its contents. The archive is local reference-only material, while previously tracked originals remain recoverable from the baseline Git commit. Preserve `.deprecated/.gitignore`'s generated-artifact exclusions as well.

Implement this roadmap's interfaces and ownership. Selectively consult and migrate reviewed archived code for native DSH seams, Win32 ABI, MSYS hook predicates and process lifetime; do not reconstruct delicate verified behavior from memory or mechanically carry over old state abstractions.

Maintained source/build/runtime must not import, extend, copy at runtime or launch archive code, including through forwarding shims or symlinks. Exclude `.deprecated/`, `tmp/` and the historical harness transitively from maintained build/lint/package inputs. Historical reports refer to `.deprecated/<original-path>`; old probe imports of `../src` or `../lib` are not validation of the future implementation.

Before the package is runnable again:

- Create root `src/` and `scripts/` from §2; extract only the installed-DSH discovery slice needed by `scripts/plugin.ts` from the legacy tooling.
- Recreate/review root TypeScript, bundle and dependency configuration using the archive as reference. Declare the pinned public atomic-write dependency (§7.2).
- Update retained `package.json` and `eslint.config.mjs` for maintained inputs; include new `test/` in typecheck/lint and `node --test`, excluding tests from production output/packages. Do not port or depend on the archived harness/configs.
- Recreate the root README and clean `lib/` output before packaging. Retained manifest commands still reference missing old inputs; do not install or publish the incomplete root package.

Follow [AGENTS.md](../AGENTS.md): backend/runtime work only, native DSH capabilities, Windows-native Git Bash for shell work, and strict isolation to DSH's Windows Git Bash execution. Ordinary Git Bash, other hosts, WSL and non-Windows DSH remain unaffected. Keep managed artifacts in DSH-scoped, preferably plugin-private, directories. Do not modify installed Git/DSH contents or ACLs, global PATH/environment, registry keys or source attributes/timestamps. Hardlink bookkeeping effects are permitted; do not conceal them or claim bit-for-bit host restoration. Normal disposal and complete uninstall have distinct contracts in §9.

## 1. IMPLEMENTATION STYLE & ANTI-SPAGHETTI RULES

These rules apply to every implementation phase:

1. **Centralize defensive filesystem checks in `ntfs-filesystem.ts`.** Encapsulate non-reparse ancestor/target admission, `volumeSerial`/`fileId` reads and comparisons, writer locks, `.setup-owner` leases, `GenerationPin` directory handles, collector `DELETE` claims, and non-following file `unlink` / directory `rmdir` traversal in a small, composable set of primitives with checked `closeHandleChecked` cleanup built in. Keep Git policy and cache lifetime out of these primitives.
2. **Keep orchestration linear.** `runtime-cache.ts`, `git-installation.ts`, `provision-runtime.ts`, `link-helper.ts` and `index.ts` compose those primitives and pass admitted values across internal boundaries. They must not assemble raw Win32 flags, repeat path/reparse/identity checks inline, or bury workflows in nested defensive `try/catch` pyramids. Helpers take only values they use.
3. **Write contract-focused tests.** Maintained `test/` verifies safety, sharing, cancellation and execution contracts with small reusable helpers in `test/fixtures.ts`. Avoid bloated mock harnesses and brittle assertions on incidental internal call counts; use the coverage plan in §10.

### Boundary validation ownership map

| Boundary | Checks and reusable results |
| --- | --- |
| Pin establishment | Root ownership, generation/base/internal junctions, source selection and six anchors; retain admitted canonical paths/layout (§§5–7). |
| `pin.lease` | Canonicalize the actual workspace once, reject source/cache overlap before confinement, and create or await its pin-owned view promise (§8). |
| Environment construction | Pure path/string construction from the admitted view, recorded source and layout (§4.4). |
| `bash-launcher` | Parse invocation and validate inherited mode/token/policy; path admission belongs to `process-family` (§4.4). |
| `process-family` | One child launch-path admission, then actual Job membership, MSYS file identity and loader-path checks using retained family values (§4.4). |

Reuse observations within each call/family. Marker reads, anchors, internal-bin checks and ancestor walks belong at their designated boundaries, not in every helper. The child launch check remains mandatory: a parent pin neither freezes a junction's target nor transfers an opened path into the child.

## 2. TARGET LAYOUT — 14 PRODUCTION FILES, ONE SCRIPT HELPER

The active source/tooling tree below will be created during implementation. Its original predecessor is preserved under .deprecated/.

```text
src/
  index.ts
    GitBashExecutor: native schema, lazy singleflight slot, current-selection
    guard, explicit rebuild entry, command ownership and disposal.
  adapter.ts
    Existing narrow Cordis/Loader replacement/restoration.
  preset.ts
    Native preset adaptation.
  tool.ts
    Native Bash-tool re-export.
  cleanup.ts
    Packaged purge entry using the same orphan recovery as initialization.
  bash-launcher.ts
    Confined entry, argument/inherited-token/Job validation, child environment
    and all-mode installation-root hook contract.

  runtime/
    ntfs-filesystem.ts
      Necessary ancestor/reparse/volume/file identity operations; writer locks,
      UAC setup leases, pin handles and collector claims;
      exact-target filesystem operations. No Git policy or batch ABI decoder.
    git-installation.ts
      Git discovery, supported layouts/anchors, bounded Node inventory and
      linkFreshTree shared by cache preparation and the elevated helper.
      No cache selection, owner registry, process supervision or cleanup policy.
    runtime-cache.ts
      Root ownership, current metadata, warm admission and candidate allocation;
      generation/pin/view lifetime, publication, collection and purge.
      Calls Git file operations; does not implement a second linker.

  setup/
    provision-runtime.ts
      Elevation plan validation, setup-only lease and one awaited UAC operation.
      Uses DSH broker supervision; cancellation closes the lease.
    elevation-broker.ts
      Unelevated process hosting modal COM/UAC and official helper wait/close;
      exits zero only on confirmed helper success; bounded stderr diagnostics.
    link-helper.ts
      Fixed elevated linker with guarded admission, cancellation and no
      independent recursive cleanup.

  debugger/
    native-debug.ts
      Precise native bindings, x64 ABI, bounded remote-data/context helpers
      and SID/DACL construction. No retained process-family state.
    process-family.ts
      Private Job/family creation, events, module admission, MSYS hook state
      and settlement behind runPrivateBash.

scripts/
  installed-dsh.ts
    Installed CLI discovery, version check and module-resolution context; also
    usable by the isolated integration test without a personal profile.
  plugin.ts
    Official package-manager wrapper and verified cache purge.

test/
  runtime-cache.test.ts
    F1 root admission, full interior purge and warm/cold selection behavior.
  provisioning.test.ts
    F4 wait failure/nonzero exit, joins, cancellation and ordinary plan cleanup.
  pin-lifetime.test.ts
    Native pin/collector exclusion, interrupted collection and view lifetime.
  bash-execution.test.ts
    Real DSH execution across modes in an isolated temporary profile/workspace.
  fixtures.ts
    Small shared temporary-fixture and installed-DSH setup helpers, where reused.

.deprecated/
  Original source, tests, PoC, documentation, tooling and generated artifacts.
  Reference-only; contents preserved and excluded from maintained inputs.
  No legacy test/PoC port or compatibility layer is planned.
tmp/
  Research and review evidence; not a production dependency.
```

No runtime-coordinator.ts, support/, windows/, schema registry or extra module merely for a type. Keep actual package/process boundaries and the public package exports. Remove stale generated lib/ files and obsolete internal implementations when production callers migrate.

runtime-cache owns cache state and lifetime. git-installation owns source layout, inventory and file creation. provision-runtime owns the UAC plan/lifetime boundary; the helper imports its decoder and the shared linker, not CacheStore. Neither Git file functions nor NTFS helpers import runtime-cache or executor state. Plan data types may use type-only references to shared file-layout types; no generic schema registry or circular runtime imports are needed.

## 3. EXECUTION ORDER

| Phase | Implementation work and governing contracts |
| --- | --- |
| 0 — Approved contract baseline | Carry the approved invariants into implementation review: publication, normal shutdown, strict purge, crash/late-start interleavings, broker versus independent helper lifetime, source isolation and uses protected through retirement (§§6–9). |
| 1 — Bootstrap | Restore maintained inputs and test entry points under the workspace rules and §2. |
| 2 — Filesystem, cache and recovery | Implement §1 primitives, §4.5 Git operations, F1 admission (§5), pin/collector exclusion (§§6.5, 8) and metadata/warm admission (§7). |
| 3 — Optional elevation | Integrate the probe, guarded helper and F4 outcomes (§§6.1–6.4). Enable recovery for new attempts only when every helper/controller mutation follows this protocol; old or unguarded helpers cannot be assumed compatible. |
| 4 — Executor and views | Wire the factory/pin API, shared readiness, selection/rebuild guards (§§4.1–4.2) and direct scoped views (§8); defer the UI binding. |
| 5 — Launcher/debugger | Type/refactor §4.4 while preserving verified native behavior and DSH ownership. |
| 6 — Integration/package | Run §10, document recovery, freshness limits, explicit rebuilding and ownership/IO obstructions, then package. Implement guarded recovery rather than a permanent-freeze policy. |

Archive relocation and Phases 1–4 are complete. Continue reviewing new modules against these contracts and preserved behavior independently of obsolete test internals. The executor now owns shared readiness and guarded rebuilding; launcher/debugger behavior remains Phase 5.

## 4. MINIMAL INTERNAL APIs

Reuse DSH's `SandboxMode`, `SandboxExecutionPolicy`, `ShellExecution`, `Subprocess` and `NativePtr`. These are design contracts for the pending implementation.

### 4.1 Executor-facing preparation

```typescript
  interface RuntimePreparation {
    readonly cacheDirectory: string;
    readonly spawn: Subprocess['spawn']; // bound to the local DSH provider
    readonly gitBashPath?: string;
    readonly rebuild?: boolean; // default false; true requires a fresh generation
  }

  prepareRuntime(
    request: RuntimePreparation,
    signal: AbortSignal
  ): Promise<GenerationPin>;

  interface GenerationPin {
    lease(
      scope: Pick<SandboxExecutionPolicy, 'mode' | 'workspaceRoot' | 'sessionId'>,
      signal: AbortSignal
    ): Promise<RuntimeUse>;
    release(): Promise<void>;
  }

  interface RuntimeUse {
    readonly baseRoot: string;
    readonly installationRoot: string;
    readonly sourceRoot: string;
    readonly layout: GitLayout;
    release(): Promise<void>;
  }

  purgeRuntimeCache(cacheDirectory: string): Promise<void>;
```

The factory retains the private cache owner inside its returned pin. It resolves Git and admits source/cache separation without a workspace or confinement/ACL calls, then follows §7.1 or fresh setup (§6). Explicit `rebuild: true` bypasses current-generation reuse through that same pipeline. The executor captures bound `spawn` once for setup supervision only; it is neither metadata nor selection identity and does not introduce a subprocess service or pass a Context object.

`lease` owns command admission and pin/view lifetime (§8) before the executor's deferred DSH confinement callback. No workspace is inferred for a global settings action. `baseRoot` is the physical executable/DLL boundary; `installationRoot` supplies scoped namespace/child paths. `sourceRoot` is the recorded canonical path for scope separation/PATH filtering and need not still exist. `layout` is admitted once per pin; resolve the source again only when preparing a new pin.

`purgeRuntimeCache` is the offline operation in §6.5. Online rebuilding only replaces the invoking executor's selected runtime; it neither purges/modifies an existing generation nor forces other DSH instances to rotate their pins.

### 4.2 One readiness slot and an owned manual rebuild

```typescript
  interface PreparationSlot {
    readonly selection: string | undefined;
    readonly controller: AbortController;
    readonly ready: Promise<GenerationPin>;
    pin?: GenerationPin; // set only when this slot has admitted readiness
  }

  GitBashExecutor.rebuildRuntime(): Promise<void>;
```

Keep one readiness slot, one optional rebuild-operation reference and existing owned-work tracking. A rebuild uses the same slot shape; when it supplies readiness, `slot` and `rebuildOp` reference one object with one owner reference to its pin. Concurrent ordinary callers share readiness. A caller timeout/cancellation stops its wait, not shared setup; recheck that caller before use/launch. Failed readiness stays failed for an unchanged selection, avoiding repeated UAC/scans. A new provider/selection or explicit rebuild permits another preparation; a new purge invocation can retry after an obstruction clears.

At command/rebuild entry, read current `gitBashPath`; detach, abort and retire any slot or rebuild operation with a different selection before using or replacing it. After waits and before adoption/use, recheck current selection, object identity, `signal.aborted` and stopping. Ordinary completion requires `slot === this.slot`; rebuild completion requires `op === this.rebuildOp`. Release stale pins once, without rewinding an already published `current.json`.

Selection observation is boundary-driven. If a call observes B during A → B → A, the first A object stays detached/aborted even when A returns. An unobserved idle toggle leaves valid A work usable. Idle changes take effect at the next entry, completion or use check. Version-sensitive Cordis/Loader integration stays in `adapter.ts`.

`rebuildRuntime` captures current selection/cache and creates an operation calling `prepareRuntime` with `rebuild: true`:

- **Ready pin exists:** keep its slot serving commands. After guarded success, install the rebuild slot and retire the old pin using §8.1. Failure rejects the rebuild caller and preserves working readiness; existing uses keep their pins.
- **No ready pin:** abort/detach unfinished initialization, if any, and install the rebuild as shared readiness synchronously before any await. Settle superseded local preparation through §6.4 before starting fresh preparation. Commands join the rebuild promise; failure leaves that slot failed, with no automatic retry.

Waiters on a displaced slot recheck identity on fulfillment or rejection and follow current readiness unless their own signal was cancelled. Stale completion cannot overwrite the slot or transfer its pin to a caller. A local cleanup failure prevents replacement setup from starting. Consent already displayed remains subject to §6.4's cancellation limits.

The method resolves after fresh commit and guarded adoption. Reject overlapping rebuild calls as busy, without queuing/coalescing. The future UI disables its button until settlement; no frontend, route or separate recovery/coordinator service is part of this backend phase. Disposal applies §9 regardless of selection.

### 4.3 Elevated setup boundary

```typescript
  provisionRuntime(
    attempt: ProvisioningAttempt, // admitted empty base, layout and boundary identities
    signal: AbortSignal,
    spawn: Subprocess['spawn']
  ): Promise<void>;
```

This is the single awaited UAC operation selected by §6.1. `provision-runtime` owns the lease/plan and fixed broker supervision (§6.2); the helper inventories its source. Resolution requires the broker/DSH success contract there. Rejection is non-publishable and does not establish helper quiescence; cleanup follows §§6.4–6.5, not an outcome taxonomy or separate result/join API.

### 4.4 Launch and debugger admission

```typescript
  interface PrivateBashLaunch {
    readonly baseRoot: string;
    readonly installationRoot: string; // required for every mode
    readonly cwd: string;
    readonly command: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly compatibility: IpcCompatibility;
    readonly graceMs: number;
  }

  buildRuntimeEnvironment(
    installationRoot: string,
    sourceRoot: string,
    layout: GitLayout,
    ambient: NodeJS.ProcessEnv
  ): Record<string, string>;

  runPrivateBash(request: PrivateBashLaunch): Promise<PrivateFamilyExit>;
```

Use the scoped view for PATH, GIT_EXEC_PATH and GIT_TEMPLATE_DIR. Environment construction is pure path/string work from the recorded source and admitted layout, with neither `realpathSync(source)` nor a command-time `git.exe` layout probe. Logical sandbox mode remains explicit in policy and view keys.

`bash-launcher` parses inputs and validates inherited mode/token/policy once. `process-family` admits base, executable and view once per invocation, retains canonical results and the local MSYS identity, and rejects redirection away from the parent's admitted absolute base. A redirected realpath cannot redefine that boundary. Validate the owned view junction against the admitted base before any grant decision uses `installationRoot`. No duplicate launcher path checks, cache metadata, source probes, six-anchor checks or cache-stamp argv belong in the child.

At debug events, verify actual private Job membership, loaded MSYS file ID and actual loader path; reuse admitted family values for hook predicates/descendants. Native children need not all be Bash/private executables, but processes receiving MSYS repairs must meet the private module/path predicates. Missing required admission stops and joins the family; there is no unrestricted retry.

Require `installationRoot` and the startup-root namespace hook in every mode, including full-access. Pipe/default-DACL/mapping ACL repairs remain confined-mode-only; full-access uses zero ACL repairs. Roots and MSYS descendants share their own session key, and distinct scoped views must not collapse into one namespace. Preserve the established namespace/write-boundary behavior and fail closed on incompatible behavior. Namespace separation is not IPC confidentiality: peer reads, shared-logon-SID read-only writes and broad full-access rights remain within the documented limits of partial Windows DSH enforcement.

### 4.5 Git installation and shared file operations

```typescript
  type GitLayout = 'ucrt64' | 'mingw64';
  interface GitInstallation { readonly root: string; readonly layout: GitLayout }
  interface FreshLinkTree {
    readonly sourceRoot: string;
    readonly baseRoot: string;
    readonly files: readonly string[]; // validated unique normalized relative paths
  }

  discoverGitInstallation(setting?: string): GitInstallation;
  inventoryGitFiles(sourceRoot: string, checkActive: () => void): Promise<readonly string[]>;
  readAnchors(root: string, layout: GitLayout): Promise<AnchorStamps>;
  linkFreshTree(tree: FreshLinkTree, checkActive: () => void): Promise<void>;
```

These free functions and small data types live in `git-installation.ts`. `AnchorName`/`AnchorStamps` cover §7.2's six anchors. Inventory returns validated, normalized, unique relative pathnames under the fixed supported selection policy, not a stamp per leaf. Preserve distinct required names even when they share a file identity. The cache admits in-process arguments; privileged admission is §6.2.

Inventory uses cooperative bounded Node `readdir`/`lstat`/`stat` with necessary authoritative native boundary queries. Reuse source-directory observations within the pass; creation primitives retain ordinary-file, path/reparse, read-only and no-overwrite checks. Existing file targets are errors. Inventory and linking call `checkActive` before starting and between bounded batches (controller signal or helper lease); cancellation stops scheduling and drains issued work.

`linkFreshTree` derives unique parents and ancestors from the normalized list, excluding the already-created base. Create each once, shallow-to-deep, then schedule bounded file-link batches. Use §1 primitives for the required checks; workers do not call recursive `mkdir` per file. The permission probe and final junction creation belong to §6.1, outside this function. Each chosen process inventories its own empty-base pass once; no controller file list crosses UAC.

## 5. OWNERSHIP AND SCHEMA RULES — F1

Root admission is the ownership boundary:

- Exclusively create a missing cache root and write its ownership marker.
- Reject an existing markerless/unrecognized root before normal mutation or purge; a familiar name never authorizes adoption.
- Validate marker/schema, canonical path, root volume/file ID and non-reparse ancestors, plus source/cache separation in both directions for preparation.
- Revalidate admission after waiting for the cache writer lock before doing work.

The entire admitted interior is disposable plugin storage, including manually placed files and unexpected/malformed names. Ownership does not depend on per-leaf allowlists, directory registries, preservation lists or metadata-temp regexes; it never extends to external link targets. Structural and live-work protection still govern every removal (§6.5).

Admit the `generations` container dynamically as an ordinary same-volume directory; create it under the writer lock if missing. Do not persist its historical file ID. Generation IDs are validated API/selection keys, not a deletion whitelist.

Use standard Schemastery required/constant/bounded field and collection checks, consuming known validated values and ignoring irrelevant extra JSON properties. Missing ownership values are errors. Do not add a recursive exact-key validator, generic framework, control-file hardlink-count rule or backup-alias requirement. JSON reads require bounded ordinary no-reparse files; use ordinary named fields and path-aware bounds, not fixed 300-byte plan or 2 KB current-record limits.

Control corruption can prevent admission without changing ownership of the cache. Cleanup removes corrupt controls as owned objects without trusting their contents for arbitrary paths. Plan admission is §6.2; current metadata and public atomic writing are §7.2; deletion primitives and ordering are §6.5.

## 6. IN-PLACE SETUP, OPTIONAL ELEVATION AND GUARDED RECOVERY

### 6.1 Allocate, probe and link a fresh candidate

Hold the cache writer lock continuously through allocation, linking/UAC, final checks and publication. Revalidate §5 admission; require source/cache on the same NTFS volume and a supported layout. Allocate a fresh generation at its final path; that path remains unchanged through collection. The writer lock protects setup without a separate candidate hold; local work must settle under §6.4 before release.

Before inventory or base population, admit `usr/bin/bash.exe` and its ancestors as ordinary non-reparse objects, including the no-read-only rule, and try a no-overwrite hardlink to `generations/<id>/.probe`. This private sibling of base is the sole automatic local/UAC decision:

- Successful link: immediately unlink `.probe` without changing attributes/ACLs. Cleanup must succeed before proceeding; failure leaves guarded private residue and stops setup.
- `EACCES`/`EPERM` from structurally admitted **link creation**: choose UAC without a controller inventory or base reset.
- All other errors, including structural, read-only, cleanup and directory-creation failures: reject setup without automatic elevation.

After successful probe cleanup or admitted link-permission denial, create/admit the empty base once and capture its identity. Run §4.5's inventory/linker locally after probe success, or invoke §6.2 on denial. The probe establishes only that link's permission; mixed ACLs and concurrent changes remain possible, and no uniform Program Files outcome is assumed.

Any later inventory/link failure, including `EACCES`/`EPERM`, stops scheduling, drains issued work and rejects with the failing operation/path. Leave the partial candidate unpublished for §6.5; do not reset/recreate base, replace its admitted identity, resume partial links or run a second elevated pass. Resolve the source obstruction before retrying. After successful linking, create final internal junctions once using final paths, then follow §6.3.

### 6.2 UAC plan, setup lease, helper and broker

Only actual elevation creates `.setup-owner` and `plan.json`. The controller exclusively creates the non-inherited, delete-on-close setup lease, binds its path/identity in the plan and never recreates or reuses it for that attempt. Neither broker nor helper inherits it.

The bounded immutable plan contains `schemaVersion`, `attemptId`, `sourceRoot`, `cacheRoot`, `generationId`, `baseRoot`, `layout` and expected NTFS volume/file identities for source, cache, generation, base and `.setup-owner`. Derive generation and control paths from admitted cache/ID and require `baseRoot` to be exactly that generation's base. It contains no file list, anchor baseline or completion fields. Write and close the plan before starting the broker.

The fixed helper opens the existing plan with GENERIC_READ, sharing = 0, OPEN_EXISTING and no reparse following. Through that same handle it decodes input and independently validates source/cache separation, same-volume boundaries, root/generation/base/setup-lease identities, ordinary empty base and supported layout agreement with source. JSON alone grants no authority. Hold the plan through independent inventory and all mutation using §4.5's fixed source selection and linker; never create/replace the plan or perform independent recursive cleanup.

Before work/first mutation and between bounded inventory/link batches, check the lease through fresh short-lived metadata opens against its expected identity. Missing, delete-pending, mismatched or ambiguous observations stop scheduling. The helper holds no long-lived lease handle and cannot recreate it. Drain issued work behind the exclusive plan handle, then close that handle with checked handling.

Both fixed scripts start with a nonzero `exitCode`:

- The helper sets zero only after all linking and checked cleanup succeed.
- The broker has no cache-write role and checks setup is active before requesting elevation. It sets zero only after successful ShellExecuteEx with a process handle, `pollProcessExit` observing helper exit zero, and `closeHandleChecked` success. WAIT_FAILED, missing handles, nonzero helper exit and close failure remain failures.

The parent accepts only uncancelled, unsuperseded normal broker zero exit and DSH managed-range settlement. Use DSH's target outcome, not its internal runner's OS exit: the pinned runner publishes the target result, checks Job completion and terminates its Job with code 1. Bounded stderr is diagnostic only; no stdout JSON, result/cancel file, raw-handle transfer or controller exit receipt is a completion channel. Failed supervision or abnormal termination never proves success.

### 6.3 Final capture and publication

Under the writer lock after linking and confirmed setup joins:

1. Open all six source/base anchor pairs through authoritative handles. Admit file kinds/boundaries and require matching `volumeSerial`/`fileId` for each pair. Save each **base handle's** full `FileStamp` (identity, size, last-write time) as its §7.2 expectation. Do not compare size/mtime across the two handles, take a pre-link baseline, retry for stability or perform a second full-tree walk.
2. Admit required roots/final junctions. Close the optional setup lease with checked handling, ordinarily unlink its plan and clean owned temporaries. Only genuine absence is harmless; close/unlink failure stops publication. The successful probe was already removed in §6.1; local linking creates no UAC controls.
3. Acquire the fresh generation's §8.1 pin handle, atomically publish the complete `current.json` using §7.2 and return the pin.

Use ordinary non-following plan unlink. An active helper's share-none handle or a blocking reader can prevent it; this is a cleanup failure, not an additional setup state. Windows may defer physical removal after successful unlink until readers close. Publication/warm admission need no physical-absence polling, DELETE_PENDING protocol, receipt or post-commit control repair. Strict purge's completion condition remains directory removal (§6.5).

### 6.4 Cancellation and bounded local shutdown

Cancellation of shared setup closes `.setup-owner`; one caller cancelling its wait is governed by §4.2. Lease closure alone revokes the attempt, including late helpers. Do not unlink the plan as a second cancellation signal. Controller death closes the lease in the kernel; neither broker PID nor a later writer-lock holder can authorize the old attempt.

Allow a short cooperative grace while retaining observation, then terminate/join the unelevated broker through DSH if needed. Keep the writer lock while draining local linking, settling local native resources and attempting §6.5's guarded candidate cleanup; safe unpublished residue may remain for GC. Only then release the lock or finish local disposal. Local process/handle cleanup failure remains owned and reported. A late zero exit cannot resume publication after cancellation or observed selection supersession.

The broker hosts modal COM/UAC outside DSH so local shutdown can settle even while native consent work blocks. Stopping it or closing an observation handle does not promise dismissal of consent or termination/confirmed exit of an independent elevated helper. Such a helper may temporarily retain its plan while draining; its revoked candidate stays unpublished, GC defers it and purge cannot complete until guarded removal succeeds. F4 uses the public wait/close helpers in §6.2; broker hosting supplies this separate local-shutdown contract.

### 6.5 Uniform non-following collection and strict purge

Every cleanup uses §1 primitives: revalidate private boundaries, unlink regular names without changing their data/attributes/ACLs, and descend only into ordinary directories. Remove known junction/symlink objects without visiting targets, including at container/generation-name positions; never admit those as runtime trees. Unsupported reparse handling or access errors stop strict purge. Best-effort cleanup never follows unsafe paths, repairs attributes/permissions, uses `chmod` or recursive `fs.rm` on runtime hardlinks. Saved per-leaf identity and a surviving source pathname are not required to unlink owned names.

Before removing **any child of any ordinary generation directory**, acquire DELETE access on that directory with READ | WRITE | DELETE sharing and no-follow flags. A §8.1 pin blocks that claim; the held claim blocks a new pin. Hold it through traversal and `rmdir`, then close it with checked handling. The pin alone does not protect child files from deletion.

With the writer lock and claim held, unlink the candidate's plan **before payload traversal**. An active helper excludes unlink; a missing plan is harmless and all other failures stop that candidate's collection. Corrupt plan JSON needs no decoding; known reparse objects at its name are removed only as objects. A rejected setup is not permission to bypass these gates.

**Normal GC:** preserve the selected generation, claim each unused ordinary generation regardless of spelling, unlink its plan, then remove payload uniformly. Busy claims/plans or blocked final removal defer collection; unsupported types/ access errors are not evidence of disuse. Use no Bash-specific payload ordering or failure branch. A general root sweep must not bypass guarded generation cleanup; other root controls/contents are removed only during offline purge. Lifecycle GC may try/defer when busy; warm hits perform no GC (§7.1).

**Complete purge:** under the writer lock, in this order:

1. Preflight **all** ordinary generations and retain every DELETE claim before changing current or deleting payload. If any pin blocks a claim, release acquired claims and fail without payload deletion.
2. Unlink all candidate plans. A busy plan blocks completion; successful earlier control cleanup needs no rollback.
3. Unpublish `current.json`, then remove payload through the same unlinker. Keep each claim until its directory is removed and close it before parent removal.
4. Remove remaining owned contents, retaining root ownership metadata and the held writer lock until data cleanup succeeds. Remove the marker last among ordinary files, close the delete-on-close writer lock, then `rmdir` the root.

The writer lock excludes new preparation during preflight; pin/claim exclusion and §7.1's selector recheck protect warm readers, including after interrupted GC or purge. Every blocked removal, failed close or remaining directory makes purge explicitly incomplete. Both profile/fallback caches must be removed and source link counts restored for uninstall (§9). No provider owner registry or process census is added: idle executors holding neither pin nor preparation could recreate the cache, so all relevant DSH instances must be closed for offline purge.

## 7. LAZY INITIALIZATION AND WARM VERIFICATION

### 7.1 One lock-free warm path and writer fallback

Activation starts no preparation or UAC. The first real command or explicit rebuild calls the factory. For ordinary warm admission:

1. Validate existing root ownership and namespace paths read-only (§5). Read/validate bounded `current.json`, closing the metadata handle promptly.
2. Open the named generation's provisional §8.1 pin without the writer lock; validate the opened directory and boundaries.
3. Re-read safely admitted current metadata and require the same `generationId`. ID equality suffices because records are immutable per ID; IDs are never reused and publication never reselects a retired generation.
4. With the pin held, check requested canonical source, all six source/base anchors against §7.2's saved full stamps, and required roots/junctions. Recheck cancellation and selection before returning the pin.

Warm admission creates no owner lease, registration file or explicit filesystem write, inspects no setup controls and never waits for the writer lock on a hit. Close each metadata reader before further work. The selector recheck rejects a delayed open after interrupted collection released its claim, even if every anchor survived. Later publication is harmless once the recheck passes: the pin excludes collection under §6.5.

Missing/malformed safe metadata, a sharing/missing-directory race or eligibility miss closes the provisional handle and enters the writer path, which rechecks current before building. Do not loop optimistic retries. Cancellation, unsafe ownership/path/control objects and access failures remain errors; failed native closes remain owned. Initial recovery may retry a busy gate with bounded, cancellation-aware waits; a genuine cold miss may await UAC.

Provision a complete fresh base through §6 when no committed generation is usable: missing/unusable metadata, canonical source mismatch, anchor/layout mismatch or a concrete cache discrepancy. Missing/invalid current never promotes an unselected candidate. Explicit rebuild always takes that fresh path. A change only in `gitBashPath` spelling follows normal canonical-source eligibility and does not force inventory.

### 7.2 One immutable current record and six anchors

```typescript
  interface CurrentRuntime {
    readonly schemaVersion: 1;
    readonly generationId: string; // validated generation-ID format
    readonly sourceRoot: string;   // canonical absolute source root
    readonly layout: GitLayout;
    readonly anchors: Readonly<Record<AnchorName, FileStamp>>;
  }
```

Keep `AnchorName`, `AnchorStamps` and `FileStamp` in `git-installation.ts` for their consumers. `FileStamp` contains identity, size and last-write expectations captured from the base handle under §6.3. Anchor paths are a closed set in the versioned layout; incompatible layout/anchor-set changes require a schema/compatibility update:

```text
  usr/bin/{bash.exe,sh.exe,msys-2.0.dll}
  <architecture>/bin/git.exe
  etc/{profile,install-options.txt}
```

Supported architecture values are `ucrt64` and `mingw64`. OpenSSL ABI files, Perl and Git helpers remain in full inventory but are not mandatory anchors; no optional anchor pool or glob discovery. On warm admission, compare **both source and base against the saved full stamp**, not just each other. Hardlink counts, archive bits and bookkeeping change times are not fingerprints.

`current.json` is the sole published runtime record. Each process keeps its working relative-path inventory in memory; no persisted full inventory, per-generation commit/manifest, digest or second record accompanies it. Active pins retain their admitted record in memory when another owner publishes.

Publication (§6.3) uses the public pinned `@deepseek-ai/dsh-atomic-write` `writeFileAtomic`, explicit private metadata modes, an admitted existing parent and the cache writer lock. Its exclusive sibling-temp creation, same-volume atomic rename and bounded Windows sharing retries are sufficient. Its recursive parent mkdir is not root admission. Apply it only to plugin metadata, never runtime hardlinks or arbitrary user output; use neither an installed private implementation nor a custom writer/temp-name rule.

The atomic replacement is the sole commit: before it, the old complete selection remains and an interrupted candidate is unused; afterward, the new complete record is selected. Never rewrite an existing generation's expectations. This is not a power-loss transaction guarantee; no journal or fsync/flush framework is added.

### 7.3 Freshness limits and recovery

Warm checks establish recognized metadata, directory boundaries and unchanged anchors, not full source/cache-layout equality. Linking and §6.3's capture are not an atomic source snapshot: writes can enter the saved sample or occur afterward, and non-anchor replacement/addition/removal during setup can be included or missed. A deleted cached Perl module, source-only replacement/addition or cache modification by full-access/outside programs can survive restart while anchors still match.

An admitted live pin does no binary size/mtime comparison, source/base walk, inventory reread/hash or preparation-lock wait on commands. Source pathname replacement or a changed current record does not invalidate it. In-place writes and ACL changes propagate through hardlinks, including Bash/MSYS; §4.4's local module/loader/Job checks establish repair admission, not freshness. Each command still performs §8 scope/view admission.

Scope/view/module failure stops that execution without a scan on each retry. Ordinary nonzero exits are not automatic cache-corruption diagnoses or rebuild triggers. Explicit rebuilding (§4.2) restores layout from the currently installed source; it cannot repair source bytes damaged through a shared hardlink. Repair of Git itself is a separate user operation.

Use bounded Node traversal (§4.5), with no production FileIdBothDirectoryInfo decoder, DirectoryMetadataHint layer, cooldown/timer, watcher, journal service or per-command directory-timestamp sweep. Measure the final metadata/anchor path on the supported system during implementation; 5 ms is an unestablished target, not a promised result. The intended recovery is the future UI rebuild button; §9 retains the interim/offline CLI. Restart alone does not promise non-anchor repair.

## 8. GENERATION PINS AND DIRECT SCOPED VIEWS

The admitted cache selects its generation through `current.json` (§7.2). Each generation has one base and direct views:

```text
  generations/<id>/
    base/
      usr/
      architecture/
      etc/
      bin -> base/usr/bin
    views/<instance>/<scope> -> base
```

There is no `modes/<mode>` layer or `modeRoot` parameter. The view key includes pin instance, generation, explicit mode, canonical workspace and session. Separate pins for the same generation own distinct view namespaces. Agentless calls get unique per-call names within their pin namespace.

### 8.1 One native pin handle and local references

A pin opens the admitted generation directory for read access, FILE_SHARE_READ, OPEN_EXISTING, BACKUP_SEMANTICS and OPEN_REPARSE_POINT, without inheritance or delete sharing. Fresh acquisition/publication is §6.3; warm acquisition is §7.1. `refCount = 1` initially represents its owner slot/operation. A `RuntimeUse` retains this same native handle through a local reference, with no disk lease, separate generation hold or cross-process refCount.

For each `lease`:

1. Reject a retired pin and increment `refCount` once synchronously before the first await.
2. Canonicalize the actual workspace once, resolving ancestor/reparse aliases. Reject workspace/source and workspace/cache overlap in **both** containment directions using the pin's recorded canonical source and admitted cache paths. This must precede view creation and DSH confinement, whose workspace grants could otherwise reach hardlinked Git files.
3. Create or await §8.2's view promise, then check caller cancellation before returning `RuntimeUse`. Do not race creation against abort.
4. On acquisition failure/abort, `finally` unwinds that single reference; success transfers it to the use through execution. The reference already protects creation, so it needs no pending-creation counter or retained background task.

Lease performs only command scope/view readiness: no marker rereads, binary stats, internal-bin-junction checks or reused-view target queries. Child launch retains the independent §4.4 check.

All releases are idempotent. `pin.release()` retires the pin, refuses new uses and drops its owner reference once without waiting for outstanding executions. `use.release()` drops its reference once; for an agentless view, first attempt non-following `rmdir`. Session views remain. No live execution may outlast its final reference.

At zero on a retired pin, run one finalizer: attempt the entire private view-tree cleanup, clear the Map and always close the directory handle with checked handling, even if view removal fails. The last release awaits this attempt/close. Transient view-removal failure leaves cache-local residue without retained retry tasks, queues or disposal errors; native close failure remains owned/reported. Apply §6.5 path safety even to best-effort cleanup. Residue may remain while the generation is selected and is reclaimed by eligible GC/purge, not a promised next-startup sweep.

### 8.2 Memoized session views

Each pin owns `Map<string, Promise<string>>` keyed by an unambiguous tuple of mode, canonical workspace and sessionId. Insert the creation promise synchronously before yielding. First creation uses admitted private parents; concurrent/later leases await that promise without EEXIST coordination or repeated target queries.

Unexpected EEXIST is an error, never permission to adopt/delete an object this attempt did not create. On creation failure, the shared awaited promise cleans its own partial target without following links, evicts its entry even if cleanup also errors, and propagates failure to awaiters. Remaining private residue belongs to pin cleanup; a later lease can retry. Keep cleanup/eviction inside that promise, without detached rejecting catch/finally chains.

A cancelled waiter awaits the short local operation and unwinds under §8.1, without interrupting another waiter's creation. Session views persist across sequential/overlapping uses until final pin cleanup, with no per-view counters. Agentless views stay outside the Map and use §8.1's release path. The Map records creation only; it cannot replace child validation of an externally mutable junction.

## 9. DISPOSAL, OFFLINE RECOVERY AND UNINSTALL

On provider disposal:

- Block new work and signal running executions before waiting on setup.
- Cancel/drain owned preparation and settle local broker work under §6.4; stop/join owned confined Jobs. Disposal applies regardless of current selection.
- Release uses/pins under §8.1 and close every instance-owned native handle/lock, including any setup lease.
- Retain the validated cache and safely deferred private residue.

Local process/handle failures are errors; ephemeral cache-local cleanup is best effort. Disposal never converts unconfirmed elevated work into successful setup. Publication requires §6.2's actual helper success/join.

The interim rebuild CLI and continuing offline fallback are:

1. Close all DSH instances using the profile/package.
2. Invoke installed `lib/cleanup.js` with the absolute profile cache path; it also purges the package fallback cache through §6.5.
3. Retain the installed plugin and `gitBashPath` setting, restart DSH and let the next Bash command prepare cold.

For **complete uninstall**, remove any plugin-only `gitBashPath` override while preserving shared Shell settings, close all relevant DSH instances, successfully purge both profile and fallback `.runtime` caches (§6.5), then invoke official package removal. Restore plugin-created source link counts and preserve source contents/ACLs under the workspace/AGENTS constraints. Interrupted/blocked purge must fail explicitly and must never be reported as complete uninstallation.

## 10. MAINTAINED TESTS AND IMPLEMENTATION REVIEW

Add §2's small suite as modules become available, following §1's testing style. Run `node --test` against maintained code with `fs.mkdtemp` fixtures and native Windows Git Bash. No personal profile, archived harness, PoC or `tmp/` probe is a dependency. Bootstrap/typecheck/lint/package inclusion rules are in the workspace section; the following is the maintained coverage plan.

### Phase 0 — Approved contract baseline review

Record the approved ownership, publication, shutdown, strict purge, crash/late-start, broker/helper and retirement invariants before adding runtime modules. The [Phase 0 checklist](../docs/backend-20261117-contract-baseline.md) maps these contracts to later implementation and verification. Phase 0 is a documentation/review baseline, not evidence of passing maintained runtime tests; add those tests as their modules become available below.

### Phase 1 — Bootstrap and test entry points

Verify restored build/docs/dependencies/test scripts, DSH module/config identity, public dependencies (including atomic-write) and transitive archive/temporary-input exclusion. Isolate profile, workspace, caches and source copies where needed; workspace must not contain source/cache paths. Mutate only plugin-scoped fixture artifacts.

Phase 1 completed on 2026-11-17:

- Restored maintained TypeScript, ESLint, bundle, dependency/lockfile and README inputs. Production builds clean `lib/` and compile only `src/`; tooling/tests participate in typecheck and lint.
- Reviewed and migrated the narrow adapter/preset/tool seams, retained the native executor schema and extracted installed-CLI discovery into `scripts/installed-dsh.ts`. Tests resolve the selected CLI's public package-manager operations read-only. The package-manager entry rejects all operations until maintained installation and strict purge are available; cleanup rejects without a provisional wrapper API.
- Added `test/bootstrap.test.ts` and small ordinary-file fixtures. Seven tests passed with zero skips under Windows-native Git Bash, Windows x64 Node 26.12.1, pnpm 12.18.0 and installed DSH 0.2.2-rc.2. Coverage includes volatile schema identity, real Loader replacement/restoration without persisted configuration changes, public pinned dependencies/atomic writing, CLI resolution without a profile, independent invalid-selection checks, transitive compiler graphs, lint exclusions, clean output/public exports, package inclusion and CLI refusal across command/option orderings. Only absent CLI discovery can skip the installed check; validation/loading failures propagate.
- `pnpm install --ignore-scripts --frozen-lockfile`, `pnpm check`, `pnpm lint` and `pnpm test:windows` passed. Package inclusion was inspected through `pnpm --ignore-scripts pack --dry-run --json`; no plugin installation or release tarball was produced.
- Execution, rebuilding and cleanup deliberately reject until their implementation phases. `prepack` rejects release packaging. Runtime/cache/native-sharing/UAC/debugger and complete-uninstall correctness remain unverified; the Phase 1 wiring tests are not substitutes for later maintained runtime tests. Runtime/setup/debugger modules will be introduced with their implementations rather than empty scaffolds.

### Phase 2 — Source operations, ownership and native holds

Phase 2 completed on 2026-11-17:

- Added the three runtime modules in §2. Win32 flags, identity/kind/reparse admission, checked handle closure, writer/setup leases, pin/collector holds and non-following removal are centralized in `ntfs-filesystem.ts`. Git discovery, bounded inventory, fresh-tree linking and six-anchor capture remain separate from cache ownership and lifetime.
- Implemented F1 ownership, the lock-free read/pin/selector-recheck path, local probe/link/capture/atomic publication, guarded unused-generation collection, pin references/direct views and strict whole-interior purge. The cleanup entry purges both profile and fallback caches. Existing source contents/ACLs are untouched by production operations; hardlink bookkeeping retains the approved exception.
- Maintained Windows verification covers native sharing in both acquisition orders, ownerless warm admission while a writer is held, all-generation purge preflight, stale readers after interrupted arbitrary-order GC, interrupted purge, retained uses, cancellation, source separation, malformed controls, non-following cleanup and residue recovery. CLI verification uses an isolated package/profile/fallback fixture. No personal profile or archived helper is loaded.
- `pnpm check`, `pnpm lint` and `pnpm test:windows` pass: 35 tests, zero skips, including the seven bootstrap checks. The fixture metadata/anchor warm path measured approximately 11–13 ms on Windows x64 Node 26.12.1 with the pinned DSH dependencies; this is not a full-installation benchmark or a 5 ms guarantee.
- At Phase 2 completion, optional elevation remained gated for Phase 3. The implementation below replaces that gate with guarded provisioning; default tests still request no UAC. Executor/rebuild orchestration, child admission/debugger behavior and real DSH execution remain Phases 4–6; release installation and packaging stay gated.

The first subsequent audit round reduced repeated native observations and full ancestor walks, reused the SDK's Win32 errors, tightened canonical-path and dangling-junction admission, repaired default Git discovery and empty-root failure cleanup, and made link syscalls synchronous within bounded yielding batches so admitted writes cannot remain queued behind unrelated libuv work. Typecheck, lint and all 41 maintained Windows tests passed.

The second audit round replaced Node deletion with checked ordinary `DeleteFileW`/`RemoveDirectoryW`, preserving exact enumerated NTFS names through namespaced operations and refusing attribute repair. This avoids [libuv's read-only fallback](https://github.com/libuv/libuv/blob/v1.52.1/src/win/fs.c#L1125-L1154); it does not introduce a custom plan-retirement protocol. Root creation now reuses ordinary ownership admission after a competing process wins `mkdir`, while markerless roots remain refused. Three new regressions cover read-only source attributes, unusual owned names/link counts, and an actual separate-process root-creation interleaving. Typecheck, lint and all 44 Windows tests passed, with zero skips.

A further fresh-context audit found a false positive in the interrupted-GC test: its hook acquired the collector claim too late, after the provisional pin opened. The corrected test holds the writer lock and DELETE claim before delivering the delayed metadata snapshot, verifies actual non-anchor removal with every anchor intact, and checks selection B. A negative control removing the selector guard only in memory fails the corrected test as intended. No production hook was added; all 44 maintained tests, typecheck and lint pass after the correction.

`runtime-cache.test.ts` covers §5 markerless-root refusal, whole-interior ownership, non-following purge, current/anchor admission and cold/warm reuse. Exercise §4.5's shared source functions without per-leaf plan stamps.

`pin-lifetime.test.ts` uses real Win32 sharing for both pin/collector acquisition orders (§§6.5, 8.1), retain-before-await and idempotent releases. Verify ownerless warm admission and purge preflight finding a pin in **any** generation before payload deletion. Interrupt arbitrary-order GC with non-anchor payload removed and all anchors intact; a delayed reader must fail §7.1's selector recheck. Also interrupt purge after unpublication. Reparse ancestors must never send cleanup outside the cache. Normal view-removal failure must still close native resources, and later strict purge must remove the residue.

### Phase 3 — Fresh elevation and F4

Phase 3 completed on 2026-11-17:

- Added only §2's three setup modules. `provision-runtime.ts` owns the bounded plan, setup lease and one awaited broker operation; the fixed helper shares Git inventory/linking and imports no cache owner. NTFS admission and handle/deletion flags remain centralized.
- Only the admitted sibling probe's link-permission denial selects UAC. No controller inventory crosses elevation and no later failure resets/recreates the base. The helper binds paths and identities, requires an ordinary empty base and matching source layout, checks the setup lease between batches and retains its exclusive plan handle until issued work drains.
- Both scripts default to failure. Broker success requires ShellExecuteEx's process handle, public DSH `pollProcessExit` observing zero and checked handle close. The parent separately joins the DSH managed range, closes its lease before returning from provisioning, then captures final anchors, admits runtime boundaries and ordinarily unlinks the plan before publishing. Cancellation revokes the lease before bounded local broker shutdown; unconfirmed elevated work remains subject to guarded collection.
- Added the direct pinned Koffi dependency already used by the SDK solely for the broker's ShellExecuteEx/COM ABI. DSH retains process supervision, wait/close helpers and execution-policy ownership. No result channel, cancellation file, recursive helper cleanup, coordinator or new setup state machine was introduced.
- `pnpm check`, `pnpm lint` and `pnpm test:windows` pass: **84 tests, zero skips**. The native provider lane executes the fixed helper as an ordinary child over owned source files, verifies restored source link counts and unchanged contents/ACLs after purge, and stops/joins a broker fixture blocked in native Sleep. Fault cases cover F4, rejected range observation, cancelled inventory/batches, late helper refusal, delete-pending lease inactivity, final-anchor admission and control cleanup failures. Injected close failures occur after actual test-handle closure; they do not prove recovery from a kernel close failure.
- The explicitly invoked approval/denial lane is documented in the root README and opens real UAC only when requested. It was not run for this implementation. Actual consent/late-helper behavior and full DSH Bash execution remain manual/integration release gates; the default suite opens no consent prompt or personal profile.

`provisioning.test.ts` covers §6's setup/recovery contracts:

The first Phase 3 audit found two test false positives: a namespaced-path rejection occurred before the intended probe-cleanup blocker opened, and a populated old base masked revoked-lease admission in the late-helper test. Both fixtures now isolate the intended failures. In-memory negative controls omitting probe cleanup or disabling lease enforcement pass the original tests and fail the corrected tests at their expected rejection assertions. The native smoke test now runs the emitted broker and helper through actual COM/ShellExecuteEx/wait/close with only `runas` replaced by `open` in a test-only ESM preload. It retains source-integrity and strict-purge checks; actual elevated lifetime and modal consent remain separate manual gates. Production code is unchanged by this audit round.

The second audit corrected two production boundaries without new state or APIs. Failed broker outcomes now reject within the outcome promise, so lease revocation and shutdown do not wait indefinitely for surviving managed work; successful outcomes still require range settlement. Both callers revalidate the retained source/base Directory identities immediately after awaited inventory, before linking can adopt a replaced root. A shutdown-watchdog regression reproduces the former wait, and four ordinary-directory replacement cases fail when those revalidations are disabled in memory. Typecheck, lint and all **90** Windows tests pass, with zero skips. These checks do not promise atomic filesystem admission against arbitrary external mutations.

- Probe before inventory/base population; early link denial chooses UAC without a controller scan/reset, success removes the probe before inventory, and probe cleanup/structural/non-link failures never request UAC.
- Exercise the shared linker through both callers: existing-target refusal, structural/reparse/read-only admission, deduplicated parent creation before bounded file batches, and independent helper inventory after plan admission. Cancelled inventory stops scheduling and drains before plan close.
- A later permission failure drains/rejects without publication, UAC or base recreation; guarded GC later removes its candidate. Test final anchor identity/ kind admission and warm comparison with saved base stamps (§§6.3, 7.2).
- Default script failure, strict success with DSH managed-range settlement, WAIT_FAILED, nonzero helper exit and checked-close failure. Parent cancellation prevents publication despite a late broker zero exit. Native fault cases review the fixed script contract using public DSH wait/close helpers; success needs no result file/stdout protocol.
- Cancellation before plan admission and during active helper work; ordinary unlink exclusion must prevent payload deletion until the exclusive helper handle closes. A background reader blocks cleanup normally; after it releases, an old helper still refuses the revoked lease. Lease closure stops new batches, delete-pending leases are inactive, and new setup never authorizes an old plan.
- Failed unlink/checked close prevents publication; strict purge cannot succeed with a remaining directory. Exercise bounded local broker shutdown during blocked native work and guarded cleanup of unconfirmed elevated work.

Default tests open no consent prompt; actual UAC belongs to the manual lane below.

### Phase 4 — Executor and boundary ownership

Phase 4 completed on 2026-11-17:

- `index.ts` captures the bound setup spawn once and owns one readiness slot plus an optional rebuild operation. Activation performs no preparation. Callers independently cancel their waits; unchanged failures remain retained. Observed selection changes detach old objects, including A → B → A interleavings, without Loader subscriptions or configuration epochs.
- Rebuilding preserves an established ready pin until guarded success. Without one, it installs shared rebuild readiness synchronously, drains superseded preparation before replacement work, and gives new/displaced waiters the same result. Busy calls reject. Stale pins are released without undoing a published current record; existing uses retain their old native hold.
- The inherited DSH `executeArgv` seam acquires a use before deferred confinement, checks selection/cancellation again before launch, preserves the native wrapper argv, and supplies base/view/source/layout/mode. Full-access also uses a view. Disposal signals commands before awaiting setup and drains all local work; native cleanup failures remain reported and block replacement setup.
- Direct views reuse the Phase 2 cache implementation and centralized NTFS operations unchanged. Added native tests cover partial junction cleanup, eviction even when cleanup fails, EEXIST refusal, workspace aliases, independent pin namespaces, cancelled admission and the absence of repeated pin/child checks on a reused session view.
- `buildRuntimeEnvironment` in `git-installation.ts` constructs scoped PATH/Git paths from admitted layout and recorded source strings, without filesystem observations. The Phase 5 launcher will consume it.

Typecheck, lint and **119** maintained Windows tests pass with zero skips. Executor tests use real Cordis/Loader/DSH executor mechanics and native cache fixtures, but controlled command subprocess outcomes and UAC denial. They neither execute Bash nor perform workspace ACL grants. The public `execute` gate stays closed until Phase 5 supplies the launcher/family implementation. Redirected-view rejection at child launch, loaded-module/loader-path/Job/token checks, real process-family shutdown and all-mode execution remain Phase 5/6 verification; Phase 4 does not claim those results. No UI binding, extra coordinator, subprocess service or archive dependency was added.

The first independent Phase 4 audit corrected three gaps. Local handle/broker-cleanup failures are now recorded at the factory boundary even when readiness rejects before retirement; draining an ordinary source/setup failure no longer permanently poisons rebuilding. The existing NTFS close-failure check is reused, and only the actual local broker-shutdown boundary identifies process-cleanup failure. Retirement observes the result without recording errors again. The directory-creation primitive now rolls back its own newly created empty name if admission fails, preserving EEXIST refusal and permitting recovery from transient namespace-admission failure. Focused regressions failed on the original implementation and pass after these corrections. No real handles are leaked by the injected close-failure tests.

Use §1's ownership map as the review checklist. Cover §4.2 rebuild success and UAC cancellation preserving a ready pin. With no ready pin, rebuilding must supersede/settle unfinished work, become shared readiness before any await and give new/displaced waiters the same result without competing ordinary setup. Check failed readiness retention, stale-pin release, selection/object-identity/ cancellation/stopping guards, disposal and the busy guard. Existing uses retain old pins, while the adopted slot owns its new pin once.

Cover §8 workspace admission before confinement, concurrent/sequential reuse of one session-view promise and independent agentless views. A cancelled lease waits for admission/creation and unwinds exactly its one reference while another waiter can succeed. Creation failure cleans its own partial target, evicts, permits retry and produces no unhandled rejection. Unexpected EEXIST is neither adopted nor deleted by that attempt. Redirecting a reused view must fail at child launch.

Verify admitted layout propagation and the validation boundaries: lease has no repeated target queries, metadata/anchor reads or tree walks; launcher/debugger share one child path admission and retain actual loaded-module identity/path/Job checks. Assert these contracts and failures rather than incidental helper call counts.

### Phases 5–6 — Real execution, packaging and cleanup

`bash-execution.test.ts` runs production DSH integration in a temporary context across read-only, workspace-write and full-access. Check representative Bash/Git execution, policy-appropriate writes, direct-view namespace behavior, overlapping uses and disposal. Preserve real module/loader/Job/token admission; do not mock the hook engine or count wiring checks as execution.

The native lane requires Windows x64, pinned DSH and supported Git. Missing prerequisites are explicit skips with reasons; a supported release run must execute it. Use an owned writable source copy where needed to avoid automatic consent or installed-Git ACL changes. Actual UAC cancellation/late-helper scenarios remain an explicitly invoked manual integration lane; automated F4 faults do not prove modal-UAC behavior.

Every fixture ultimately joins processes and strictly purges artifacts. Cleanup failure fails verification even when a normal-disposal assertion permits residue. Separately verify source contents/ACLs and restored link counts, package inputs, profile/fallback purge and plugin-only setting removal. Review handle ownership, confinement, crash boundaries and §7.3's freshness limits alongside tests.

Existing probes are supporting primitive evidence, not this maintained suite. Their scope/limits and superseded experiments are documented in the [decision record](../docs/backend-20261117-design-decisions.md#planning-references).

## REFERENCE BASIS

**Archived original implementation (contents/line numbers preserved):**

-   .deprecated/src/private-runtime.ts:58-109 — original inventory/link layout.
-   .deprecated/src/private-runtime.ts:141-179 — separation, leases and cache lock.
-   .deprecated/src/private-runtime.ts:267-336 — old admission/preparation/scans.
-   .deprecated/src/private-runtime.ts:388-438 — views and child environment.
-   .deprecated/src/index.ts — executor lifetime and final argv construction.
-   .deprecated/src/ipc.ts:61-75, 197-208, 407-420 — base/namespace distinction.
-   .deprecated/src/native.ts — token checks independent of mode paths.
-   .deprecated/src/elevation-worker.ts — modal request/helper observation.
-   .deprecated/src/link-helper.ts — old owner/cancel/cleanup implementation.

**Pinned DSH APIs:**

-   extendWin32ProcessBindings, pollProcessExit, closeHandleChecked;
-   Subprocess.spawn, SubprocessHandle.terminate, done and waitForExit for the broker;
-   native policy, shell/subprocess and Cordis configuration/lifetime interfaces.

**Primary Windows references:**

-   [CreateHardLink file identity/security semantics](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createhardlinkw)
-   [Explicit and inherited ACL entries](https://learn.microsoft.com/en-us/windows/win32/secauthz/automatic-propagation-of-inheritable-aces)
-   [CreateFile sharing and lifetime rules](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
-   [ShellExecuteEx request/process-handle contract](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-shellexecuteinfow)
-   [ShellExecuteEx behavior](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecuteexw)
-   [Process termination access rights](https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights)
-   [Process-owned handles and shared thread resources](https://learn.microsoft.com/en-us/windows/win32/procthread/about-processes-and-threads)
-   [DeleteFile sharing and deferred deletion](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew)
-   [Process creation debug-event image handle](https://learn.microsoft.com/en-us/windows/win32/api/minwinbase/ns-minwinbase-create_process_debug_info)
-   [DLL load debug-event image handle](https://learn.microsoft.com/en-us/windows/win32/api/minwinbase/ns-minwinbase-load_dll_debug_info)
-   [RemoveDirectory emptiness and junction behavior](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-removedirectoryw)
-   [Hardlink and junction semantics](https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions)
-   [File buffer flushing](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)
-   [MoveFileEx flags and limits](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)

**Node reference:**

-   [Worker termination and JavaScript execution](https://nodejs.org/api/worker_threads.html#workerterminate)

**Additional locally inspected source:**

-   @deepseek-ai/dsh-bash-sandbox 0.2.2-rc.2, lib/index.js — execute supplies confine as a deferred executeArgv preparation callback;
-   @deepseek-ai/dsh-bash-local 0.2.2-rc.2, lib/index.js — executeArgv awaits that preparation before invoking subprocess.spawn.
-   .deprecated/src/private-runtime.ts:427+ — per-command git.exe layout probing replaced by the admitted layout field in RuntimeUse.
-   @deepseek-ai/dsh-atomic-write 0.2.2-rc.2, src/index.ts — writeFileAtomic / renameAtomicTemp, private-cache temp cleanup, documented fsync exclusion, and withFileLock's PID-based contract.
-   @deepseek-ai/dsh-subprocess-local 0.2.2-rc.2, src/spawn-runner.ts and src/windows-job.ts — separate target outcome/range settlement and Job termination with exit code 1; no plugin stdout completion protocol needed.
