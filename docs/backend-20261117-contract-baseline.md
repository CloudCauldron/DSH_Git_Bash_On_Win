# Phase 0 — Approved backend contract baseline

Recorded: 2026-11-17. Runtime baseline: `6c410c5a2496c30c9883fe471b38d9920c5c2675`.

Phase 0 records the approved implementation and review obligations. It does not implement or validate the future runtime. Phases 1–6 and their maintained tests remain pending.

The [roadmap](backend-20261117-refactor-roadmap.md) is the implementation specification; the [decision record](backend-20261117-design-decisions.md) explains its rationale and rejected alternatives. [AGENTS.md](../AGENTS.md) governs repository work. Section references below refer to the roadmap. This checklist adds no API, approval step or recovery state.

## 1. Workspace and implementation boundaries

- Keep `.deprecated/` intentionally Git-ignored, as directed by the user on 17 November. It is local reference material; do not force-add it or make it a maintained dependency. Selectively migrate reviewed native DSH seams, Win32 ABI, MSYS predicates and process-lifetime logic into the new ownership boundaries. Previously tracked originals are available in the baseline Git commit. Preserve the archive's contents and its local generated-artifact exclusions.
- Exclude `.deprecated/`, `tmp/` and the historical harness transitively from maintained build, lint and package inputs. No forwarding imports, runtime copies, symlinks or launches may make them dependencies.
- Phase 1 restores reviewed root source/tooling, TypeScript/bundle/dependency configuration, README and maintained test entry points. The retained manifest is not runnable now; do not install or publish it. Include maintained tests in typecheck/lint, exclude them from production output, and clean stale `lib/` before packaging.
- Follow §2's 14 production files and the two script entries, including the extracted installed-DSH discovery helper. Keep actual public/package/process boundaries. No coordinator, support hierarchy, schema registry or module solely for a type.
- Keep filesystem defenses in `runtime/ntfs-filesystem.ts`: non-reparse admission, identities, writer locks, setup leases, pin/collector handles, exact-target unlink/rmdir and checked closure. It owns neither Git policy nor cache lifetime.
- Keep orchestration linear. Cache, Git, provisioning, helper and executor code consume admitted values; they do not assemble Win32 flags, repeat boundary walks or build nested defensive catch chains. Helpers receive only the values they use.
- `runtime-cache.ts` owns selection, publication, pins/views and cleanup policy. `git-installation.ts` owns layouts, anchors, bounded inventory and the one linker shared with the helper. Neither Git functions nor NTFS primitives import cache/executor state.
- `elevated-linking.ts` owns the fixed plan and one awaited setup operation; the helper imports its decoder and the shared linker, not the cache owner. `native-debug.ts` owns precise bindings and bounded data helpers; `process-family.ts` retains family/hook state.
- Reuse DSH policy, mode, execution, subprocess and native pointer types, public wait/close helpers and pinned public atomic writing. Retain DSH approvals, confinement, deadlines and process ownership. No frontend, route, custom tool or general supervisor is introduced.

## 2. Validation and resource ownership

| Boundary / owner | Required observation or lifetime | Must stay outside this boundary |
| --- | --- | --- |
| Pin establishment / cache | Root ownership, canonical source selection, generation/base/internal junctions and six anchors; retain admitted paths/layout | Workspace inference and confinement |
| `pin.lease` / pin | Retain once before awaiting; canonicalize the actual workspace once; reject source/cache overlap both ways before view creation and confinement; await the pin-owned view | Marker/anchor rereads, tree walks, reused-view target queries |
| Environment builder | Pure strings from the admitted view, recorded source, layout and ambient environment | Source realpath, Git execution or layout rediscovery |
| Launcher | Parse invocation and validate inherited mode/token/policy once | Duplicated child path admission and cache metadata |
| Process family | One child base/executable/view admission; actual private Job, loaded MSYS identity and loader-path checks using retained family values | Cache stamps, source probes and unrestricted fallback |
| Cache writer lock | Allocation through linking/UAC, checks, commit or local cancellation settlement and guarded cleanup | Per-command use waits and warm-hit registration |
| Setup lease / controller | One exclusively created, non-inherited, delete-on-close lease only for actual UAC; close to revoke the attempt | Recreating the lease, transfer to broker/helper, warm owner files |
| Plan handle / helper | Open existing input share-none and no-follow; independently admit it; retain through inventory, mutation and draining; checked close | Independent recursive cleanup or authority from JSON alone |
| Generation pin | One non-inherited directory read handle with read sharing and no delete sharing; owner and uses share local references | Per-use disk holds, cross-process refcounts or a provider registry |
| Collector claim | Acquire directory DELETE access with read/write/delete sharing and no-follow before any generation child removal; retain through traversal/rmdir, then checked close | Assuming a pin directly prevents child-file deletion |

A parent pin does not freeze a junction target or transfer its opened path to the child. Each child must reject redirection away from the parent's admitted absolute base and validate its view before any installation-root grant decision.

## 3. Publication review gate

Review fresh preparation in this order (§§5–7):

1. Admit or exclusively create the owned root. Reject existing markerless/unrecognized roots before mutation or purge. Validate marker/schema, canonical root identity, non-reparse ancestors and source/cache separation; revalidate after acquiring the writer lock. Admit the generations container dynamically as an ordinary same-volume directory.
2. Hold the writer lock continuously. Require supported Git layout and same NTFS volume; allocate a fresh generation at its final path. Never reuse an ID or later republish a retired generation.
3. Before inventory/base population, admit `usr/bin/bash.exe` and ancestors, including the no-read-only rule, and try the no-overwrite sibling `.probe` link. Successful probe unlink must finish before inventory. Only EACCES/EPERM from structurally admitted link creation selects UAC. Structural, directory, read-only and cleanup errors do not.
4. Create/admit the empty base once. Inventory in the process performing the selected pass; no file list crosses UAC. Use normalized unique relative names, deduplicated shallow-to-deep parent creation and bounded link batches with cancellation/draining. Preserve distinct required names even when file identities coincide.
5. Any later failure drains and rejects with operation/path context, leaving an unpublished candidate for guarded collection. No partial resumption, base recreation or second elevated pass. Create final junctions once after successful linking.
6. Require completed local work and, for elevation, the strict helper/broker success and DSH settlement contract below. Open six source/base anchor pairs through authoritative handles; admit kinds/boundaries, compare pair identities, and save each base handle's full identity/size/last-write stamp. No cross-handle size/time comparison, pre-link baseline, stability loop or second full walk.
7. Admit final roots/junctions; checked-close the optional setup lease, ordinarily unlink its plan and clean owned temporaries. Genuine absence alone is harmless. Failed close/unlink prevents publication; no physical-absence polling or post-commit repair.
8. Acquire the fresh pin, then atomically replace the sole `current.json` through public pinned `@deepseek-ai/dsh-atomic-write` `writeFileAtomic`, with explicit private modes and an already admitted parent. Return the pin only after commit. Before replacement the old complete selection remains; afterward the new complete record is selected.

The immutable record contains schema version 1, generation ID, canonical source root, layout and six saved stamps: `usr/bin/{bash.exe,sh.exe,msys-2.0.dll}`, `<architecture>/bin/git.exe`, `etc/{profile,install-options.txt}`; architecture is `ucrt64` or `mingw64`. No second manifest, inventory, digest or completion record exists. Ordinary bounded no-reparse JSON reads use Schemastery known-field validation, ignoring irrelevant extras without defaulting missing ownership values.

Atomic replacement is the commit boundary, not a power-loss transaction guarantee.

## 4. Authorization, process completion and cancellation

The immutable UAC plan binds schema/attempt, source/cache/generation/base/layout and expected boundary/setup-lease identities. Paths are derived from admitted cache and generation ID; the base must be exactly that generation's empty base. The plan contains no file list, anchor baseline or completion fields; JSON alone grants no authority.

Both fixed scripts start with nonzero exit status. The helper sets zero only after successful linking and checked cleanup. The unelevated broker checks activity before requesting UAC, has no cache-write role, and sets zero only after ShellExecuteEx provides a handle, public `pollProcessExit` observes helper zero, and `closeHandleChecked` succeeds. Missing handles, WAIT_FAILED, nonzero helper exit and close failure reject.

The parent accepts only uncancelled, unsuperseded normal broker zero plus DSH managed-range settlement. Use DSH's target outcome: its internal runner's OS exit is not the broker result. Stderr is bounded diagnostics; there is no stdout/result-file protocol, raw-handle transfer or separate result/join API.

| Event | Required outcome |
| --- | --- |
| One command cancels its readiness wait | Stop that caller's wait; shared setup continues for others. Recheck the caller before lease/launch. |
| Owned setup is cancelled, superseded or disposed | Close the setup lease; retain observation for a short cooperative grace, then terminate/join the DSH-owned broker if needed. Drain local work, settle native resources and attempt guarded cleanup before releasing the writer lock. |
| Controller dies | Kernel lease closure revokes the old attempt. Neither a broker PID nor a later writer-lock owner authorizes it. |
| Helper starts late or is already running | Fresh short-lived lease checks before work and between bounded batches reject missing, delete-pending, mismatched or ambiguous leases. Already issued work drains behind the exclusive plan handle. |
| Broker is stopped during modal native work | Local shutdown can settle; consent dismissal and independent elevated-helper termination/exit are not promised. Keep an unconfirmed candidate unpublished and guarded. |
| Broker reports zero after cancellation | Do not publish or adopt. Cancellation/supersession cannot be undone by late success. |

Closing the lease is the cancellation signal. Ordinary plan unlink is cleanup/exclusion, not a second cancellation protocol. Failed supervision never establishes helper quiescence.

## 5. Required interleaving review

These are implementation/test obligations, not claims that Phase 0 has exercised them.

| Interleaving | Required safety result | Maintained verification |
| --- | --- | --- |
| Crash before / after current replacement | Before: candidate stays unused, old record remains. After: new complete selection is visible; active old pins remain valid. Missing/invalid current never promotes a candidate. | Phase 2 cache tests and publication review |
| Warm reader pauses after first current read; GC removes a non-anchor from the old generation and is interrupted with all anchors intact | After acquiring a provisional pin, the reader's second selected-ID read rejects the old generation. IDs/records are never reused or reselected. | Phase 2 pin tests |
| Purge is interrupted after unpublication | Delayed warm reader cannot admit partially removed payload, even if anchors survive. Root ownership remains while data cleanup is incomplete. | Phase 2 pin/cache tests |
| Reader wins pin acquisition before collection; collector wins DELETE claim before reader | First order blocks collection before any child removal; second order blocks a new pin. Close every acquired handle on failure. | Phase 2 real Win32 sharing tests |
| Purge finds a pin in any generation, including an unselected one | Preflight fails before changing current or deleting payload; release all claims already acquired. | Phase 2 pin tests |
| Active helper or a background reader blocks plan unlink | No candidate payload traversal. GC defers; strict purge fails. Once the reader releases, an old helper still refuses the revoked lease. | Phase 3 provisioning tests |
| Controller cancels/dies before helper admission or during a batch | A late helper cannot mutate under the revoked lease; issued work drains behind its plan handle. A fresh attempt cannot revive an old plan. | Phase 3 faults; actual UAC manual lane |
| Ready pin serves commands while rebuild succeeds/fails | Guarded success adopts the new pin then retires the old owner; existing uses retain it. Failure, including UAC cancellation, preserves ready service. | Phase 4 executor coverage |
| Rebuild replaces unfinished preparation | Install rebuild as shared readiness synchronously before any await; settle superseded local work before fresh setup. New/displaced waiters follow it on either fulfillment or rejection; local cleanup failure prevents new setup. | Phase 4 executor coverage |
| Selection A → B → A is observed / idle B is never observed | Observed B detaches/aborts the first A object permanently; an unobserved idle toggle need not discard valid A work. Current selection, object identity, cancellation and stopping guard every adoption/use. | Phase 4 executor coverage |
| Pin retires while lease admission/view creation or execution is active | Retain-before-await protects the whole use. Retirement refuses new leases and drops only its owner; final cleanup waits for the last reference. | Phases 2/4 pin/view coverage |
| Session-view waiters overlap, one aborts, creation fails or target already exists | Share one synchronously memoized promise; cancelled waiter awaits then unwinds once. Failure cleans only its own partial target and evicts even if cleanup fails; EEXIST authorizes neither adoption nor deletion. No detached rejection. | Phase 4 view coverage |
| A reused view is redirected after creation | Independent child path admission rejects the redirect before execution/repairs; memoization is not target authority. | Phases 4/5 launch coverage |

A warm hit reads current, opens a provisional pin, rechecks the selected ID, then validates canonical source, source/base stamps against the saved stamps and roots/junctions. It performs no explicit writes, owner registration, setup-control reads, writer-lock wait or GC. A safe miss closes the provisional handle and enters one writer fallback that rechecks current; no optimistic retry loop. Unsafe objects, access errors, cancellation and checked-close failures remain errors.

Executor readiness stays failed for an unchanged selection. New provider/selection or explicit rebuild permits another preparation. Rebuild always requires a fresh generation, rejects overlapping calls as busy and resolves only after commit and guarded adoption. Stale pins release once without rewinding published current metadata; a shared slot/rebuild operation has one pin owner.

## 6. Retirement, shutdown and strict purge

Session views persist across uses until pin finalization; agentless views use unique per-call names outside the session Map and attempt non-following removal at release. Releases are idempotent. Retirement drops the owner without waiting for executions. At zero references, one awaited finalizer attempts the whole private view tree, clears the Map and always checked-closes the pin. Transient cache-local view residue causes no retained task, queue or disposal error; failed native closure remains owned/reported.

Normal disposal blocks new work and signals running executions before waiting on setup. Cancel/drain preparations, settle local broker work, stop/join owned confined Jobs, release uses/pins and close every instance-owned handle/lock regardless of selection. Retain the validated cache and safely deferred private residue. Normal disposal is not complete uninstall.

All cleanup uses the same non-following primitives (§6.5). Unlink ordinary names without modifying data/attributes/ACLs; descend only into ordinary directories; remove known links as objects, including container/generation-name positions. Do not follow reparse targets, repair permissions/attributes or use recursive `fs.rm` on runtime hardlinks. Missing source pathnames and malformed control contents do not revoke ownership of admitted interior names.

Normal GC preserves current. Under the writer lock, claim each unused ordinary generation regardless of spelling, unlink its plan before payload traversal, remove uniformly, then rmdir and checked-close the claim. Busy claims/plans or blocked final removal defer; they do not prove disuse. No root sweep bypasses these gates and no Bash-first deletion order exists.

Strict offline purge under the writer lock must:

1. Preclaim **every** ordinary generation and retain all claims before changing current/deleting payload. Any blocked claim releases acquired claims and fails.
2. Unlink all candidate plans before payload. A busy plan blocks completion; earlier control cleanup needs no rollback.
3. Unpublish current, then traverse payload without following links. Hold each claim through its generation's removal; close it before parent removal.
4. Remove all remaining owned contents. Retain the ownership marker and writer lock until data cleanup succeeds; remove the marker last among ordinary files, close the delete-on-close writer lock, then rmdir the root.

Any blocked removal, failed native close or remaining directory means incomplete purge. Ownership covers the entire admitted interior, including unexpected names, but never external targets. Unsupported reparse handling/access errors stop strict purge.

Complete uninstall removes only plugin-specific `gitBashPath` configuration while preserving shared Shell settings, closes DSH instances using the profile, successfully purges its `.git-bash-on-win` cache, then invokes official package removal. Source link counts must be restored. Offline rebuilding uses that purge but retains package/settings. With no owner registry, an idle instance could recreate the cache; offline closure is still required. Cache location follows the later [profile-only decision](backend-20261117-design-decisions.md#one-fixed-cache-per-dsh-profile).

## 7. Source isolation and accepted limits

Workspace/source and workspace/cache overlap are rejected in both directions after canonicalization, before DSH confinement could grant access through runtime hardlinks. Preparation/rebuild needs no workspace. Managed artifacts stay in DSH-scoped, preferably plugin-private, directories.

Ordinary Git Bash, other hosts, WSL and non-Windows DSH remain unaffected. Do not change installed Git/DSH contents or ACLs, registry, global PATH/environment or source attributes/timestamps. Hardlink creation/removal may change filesystem-maintained timestamps, archive bits and journal/audit records; this exception does not permit writing attributes or hiding evidence. Uninstall does not promise bit-for-bit host restoration.

Every mode requires a scoped installation root and startup-root namespace hook. Pipe/default-DACL/mapping ACL repairs apply only in confined modes; full-access performs zero ACL repairs. Repairs require actual private Job, local MSYS identity and loader-path admission; failure stops/joins the family without unrestricted retry. Namespace separation does not promise IPC confidentiality or stronger enforcement than DSH supplies.

Six anchors are a bounded freshness sample, not full tree equality or an atomic source snapshot. Linking/capture can miss concurrent non-anchor changes; a live pin does no recurring freshness scan. Source path replacement or later publication does not invalidate its uses; in-place writes and ACL changes propagate through hardlinks. Module admission checks repair eligibility, not freshness. Restart and ordinary command failure do not imply repair or automatic rebuilding. Explicit rebuild restores layout from installed source but cannot repair damaged source bytes. No watcher, journal, cooldown, timer or directory-timestamp sweep is introduced; 5 ms remains an unmeasured target.

## 8. Verification handoff and Phase 0 result

| Phase | Evidence required as modules become available | Status after Phase 0 |
| --- | --- | --- |
| 1 | Restored maintained build/docs/dependencies, public atomic-write dependency, DSH module/config identity and transitive archive/tmp exclusion; maintained test entry points | Pending |
| 2 | `runtime-cache.test.ts` and `pin-lifetime.test.ts`: F1, full-interior non-following purge, cold/warm stamps, real native exclusion, interrupted collection and finalizer closure despite residue | Pending |
| 3 | `provisioning.test.ts`: sole probe decision, shared linker, cancellation/draining, strict F4 wait/exit/close outcomes, plan unlink exclusion, revoked late helpers and bounded local broker shutdown | Pending |
| 4 | Executor and view contracts above, including selection/rebuild guards, shared failed readiness, reference ownership, cancellation, eviction and child validation | Pending |
| 5–6 | `bash-execution.test.ts`: real DSH read-only/workspace-write/full-access execution, namespace/policy/Job/token/module behavior, overlapping uses/disposal; package and profile-cache uninstall validation | Pending |

Use small reusable `test/fixtures.ts` helpers, `fs.mkdtemp`, `node --test` and Windows native Git Bash. Isolate profile/workspace/cache/source copies; workspace cannot contain source/cache. Mutate only owned fixture artifacts. Default tests open no consent prompt; supported Windows x64/pinned DSH/Git release verification must run the native lane. Missing prerequisites are explicit skips, not passes. Actual modal-UAC cancellation/late-helper behavior requires its explicitly invoked manual lane.

Each fixture ultimately joins processes and strictly purges artifacts; cleanup failure fails verification even where normal disposal permits residue. Check source contents/ACLs and restored link counts, package inputs, profile-cache purge and plugin-only setting removal. Historical probes and wiring assertions do not prove future native execution.

Phase 0 review completed:

- Read workspace constraints, §§1–2 ownership/placement rules, §§4–9 contracts and §10 coverage against the decision record.
- Recorded publication, shutdown, purge, crash/late-start, broker/helper and retirement obligations above without adding runtime abstractions.
- Preserved the user's Git-ignored archive policy and versioned the implementation specification and rationale for subsequent phases.
- Verified the local archive against its relocation manifest: 72 file contents and 81 file/directory identities match; all 38 formerly tracked archived files match the baseline Git objects.
- Maintained runtime tests, native UAC execution and package/install verification have **not** run; their implementation begins in later phases.
