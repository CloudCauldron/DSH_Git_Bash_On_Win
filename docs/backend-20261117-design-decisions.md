# Backend design decisions

Decisions recorded on 15–16 November 2026; Phase 0 contract baseline recorded on 17 November. Runtime implementation and maintained verification are pending.

The backend will make Git Bash work inside DSH on native Windows x64 while retaining DSH's execution policy, tools and settings. We chose a small compatibility layer, one shared runtime base, lazy preparation and explicit ownership of files and processes. Ordinary Git Bash, other applications, WSL and non-Windows DSH keep their existing behavior.

This record explains the choices behind the [implementation roadmap](backend-20261117-refactor-roadmap.md). It also records the alternatives we dropped, so an older proposal or prototype does not quietly become a requirement again.

The latest 16 November review removes configuration epochs and the executor's Loader event subscription, replaces unfinished initialization with shared rebuild readiness, and simplifies anchor capture to identity checks plus a saved base stamp. The earlier removal of custom plan retirement, Bash-first deletion and mid-tree elevation fallback remains in place, as does the small UAC broker for local shutdown. The decisions below replace earlier rules in place. These planning reviews changed no runtime code; this follow-up ran no native probe or UAC session.

## Starting point from the audit

The review covered backend APIs, code organization, lifecycle, unnecessary complexity and reuse of DSH. It excluded UI design. We compared the implementation with the installed DSH sources and used two independent reviews to challenge the conclusions.

The audit found that the small executor, tool and preset adapters already reused DSH well. Generated output and historical reports were not treated as production bloat simply because they occupied the repository. The changes centered on four findings:

| Finding | Decision |
| --- | --- |
| Cleanup could delete unrelated files in an adopted cache directory | Verify root ownership before any adoption or purge; treat its interior as disposable and retain safe traversal/lifetime checks |
| Every command verified the source and all three runtime trees under a shared lock | Move full verification out of ordinary commands and remove duplicate runtime trees |
| Verification depended on a particular local profile and installation layout | Exclude the disposable harness from maintained inputs and use isolated probes for new work |
| The elevation worker treated a failed wait as helper exit | Use the official wait/close helpers and preserve the difference between failure and unresolved cleanup |

The initial recommendation was targeted hardening rather than replacing the working compatibility mechanism. Once the new ownership and API design was settled, we chose a clean implementation tree while retaining the verified native behavior as reference.

## DSH integration and scope

### Reuse the native shell and tool machinery

The executor continues to extend DSH's sandbox Bash executor and replace the expected final shell arguments at its existing extension point. An unexpected argument layout stops execution rather than bypassing the wrapper. DSH keeps responsibility for approvals, policy resolution, command deadlines, output collection, spill files, background work and subprocess ownership.

We rejected a replacement shell service, custom Bash tool and custom general process supervisor. They would duplicate behavior that already works. The setup broker introduced later also uses DSH subprocess ownership rather than a parallel supervisor implementation.

The native Bash schema and volatile configuration references stay in use. Only the Git Bash path needs a plugin-specific setting. The existing tool and preset adapters remain small, and there is no frontend or custom settings UI in this work.

### Preserve native configuration identity

The adapter preserves DSH's entry IDs, canonical module names and existing Shell configuration. Native configuration editing uses those identities when it persists overrides.

An ordinary entry rename would look simpler, but could change where settings are saved or create unwanted profile changes. The narrow loader adapter therefore remains. The reviewed baseline is DSH `0.2.2-rc.2` with Node 26 or newer. The adapter's dependence on the pinned DSH and Cordis contracts is a reason to review those versions before expanding support.

Installation and removal also use the official plugin-manager operation. The repository wrapper supplies an absolute package-manager executable where bare-name lookup fails. This fixes executable lookup without changing global PATH or replacing the installer.

Reuse follows the public SDK boundary. For example, the audit found a similar argument-quoting helper in upstream source, but it was not publicly exported. Keeping a small local quoting routine avoids a dependency on that internal path.

### Keep compatibility work inside the private process family

MSYS, the compatibility runtime behind Git Bash, encounters failures involving startup paths and IPC security descriptors. Changing environment variables alone is insufficient. We retain the verified process-local startup and IPC adjustments, using DSH's Win32 bindings and Job primitives.

The TypeScript compatibility code uses DSH's existing native dependencies and hardware breakpoints to change selected data and call arguments in the new private family. Native calls and returns still run, and executable code pages stay unchanged. Before applying repairs, the debugger verifies the private Job, MSYS module identity and loader path. DSH remains unelevated and keeps its original token restrictions.

Handle cleanup follows the native API's ownership rules. Windows-managed debug-event handles are kept separate from handles the plugin must close. We also assess termination across the debugger and DSH's outer Job together; a short local cleanup loop alone is not a reason to introduce another process supervisor.

System-wide fixes would affect programs outside the plugin's scope. Installed Git and DSH binaries, their ACLs, the registry and the global environment therefore remain unchanged. A compatibility failure stops that execution; an unrestricted retry would bypass the selected policy.

## Implementation and legacy code

### Archive the old implementation without discarding its verified behavior

The agreed design changes enough ownership and API boundaries that a clean active tree is easier to build and review. The original implementation now lives in [`.deprecated/`](../.deprecated/README.md).

We moved the original source, tests, PoC, documentation, build configuration and generated output while retaining Git history, repository instructions, the package manifest, installed dependencies, ESLint configuration and planning files. An archive-local ignore file preserves the existing exclusions for generated reports and artifacts. Per the user’s 17 November instruction, the root .gitignore intentionally excludes the entire local .deprecated/ archive; do not force-add it. Previously tracked originals remain recoverable from the baseline Git commit. The original file contents and identities were checked after the move.

The archive remains a reference for DSH integration, native ABI details and MSYS hook behavior. We will selectively migrate reviewed logic instead of reconstructing delicate native code from memory. Old state abstractions do not have to survive merely because that logic once lived inside them.

Maintained code, build configuration and runtime entry points will not import or execute the archive. Forwarding shims would turn the archive back into an active dependency. Root configuration and documentation must be rebuilt before the retained package manifest is runnable again.

### Leave the old harness behind and maintain focused new tests

The old tests and PoC remain unchanged in the archive and outside maintained build, lint and package inputs. Their internal imports may remain broken relative to the new design.

We dropped the plan to create several support modules and migrate all legacy test imports. That work would preserve a harness whose assumptions and private API access were already scheduled to change. We extract only the installed-DSH discovery helper needed by the maintained installation script.

This also replaces the early proposal to rewrite the legacy profile tests for a clean machine. Their personal-profile assumptions stay in the archive; we do not carry them into maintained validation. TypeScript and lint exclusions are paired with dependency checks, since an excluded file can still be pulled in by an import or runtime file copy.

Archiving the legacy tests does not mean leaving the new backend without maintained tests. Add a small node --test suite using temporary fixtures: ownership/namespace cleanup, provisioning/F4 outcomes, native pin lifetime, and real DSH Bash execution across modes. A small shared fixture helper may support those files. Include new tests in typecheck and lint, exclude them from production packages, and never import .deprecated/ or tmp/.

The native integration lane uses Windows x64, the pinned DSH and a supported Git installation in a temporary context, with no personal profile. Use an owned writable Git source copy where necessary so the default run does not request UAC or change installed Git permissions. Missing prerequisites are explicit skips; release verification must actually run the supported Windows lane. Real modal UAC remains a separately invoked integration exercise. Mocked failure cases complement native checks without claiming to reproduce consent dialogs.

This replaces reliance on prose gates and disposable probes alone. The tests assert the new public/internal contracts, not compatibility with archived internals or incidental implementation steps. Final fixture cleanup failures fail verification; tests may intentionally leave private residue at normal disposal and then verify its later purge.

Use test results alongside code and lifecycle review. New probes should answer concrete questions, such as whether two views share an MSYS namespace or whether a late helper can write during recovery. The namespace probe disabled the hook in a control run to check whether the hook caused the separation.

The initial audit used lint, type checking, build, 11 focused regressions, package installation/removal checks and 61 profile structure checks. The structure checks established wiring and settings behavior; the later native experiment addressed live namespace isolation. Repository shell work and native verification use Windows Git Bash. Probe profiles, workspaces and runtime artifacts are disposable, and the active profile stays unchanged.

## Modules and internal APIs

### Keep related cache state together

The target has 14 production files. The main boundaries are:

| Component | Responsibility |
| --- | --- |
| Executor | DSH command integration, shared preparation, selection changes and disposal |
| Runtime cache | Root ownership, current metadata, candidate allocation, generations, pins/views and collection |
| Git installation files | Discovery, layout/anchors, bounded inventory and the shared fresh-tree linker |
| NTFS helpers | Native filesystem identity, reparse checks and handle operations |
| Setup code | Fixed plan, unelevated broker process and elevated helper lifetime |
| Debugger code | Native data access, MSYS hook rules and process-family events |
| Small entry adapters | Native tools, presets, loader integration and packaged cleanup |

We removed the proposed `windows/` folder because it grouped unrelated work by platform. Debugger bindings belong with the debugger; token validation belongs with the launcher; filesystem mechanisms belong with the runtime.

We merged cache ownership and cache lifecycle because both operate on the same control files and generation state. Splitting them required passing internal state between modules without creating an independent responsibility.

We previously folded Git discovery and inventory into the cache because it had one consumer. The shared fresh-tree linker now serves cache preparation and the elevated helper, and cache lifetime already has substantial responsibilities. Restore runtime/git-installation.ts for discovery, layout/anchor definitions, inventory and linking. Free functions and small data types are enough; no installation service or wrapper class is needed. runtime-cache.ts keeps ownership, selection, pins/views and collection.

This adds one focused module rather than treating 13 files as a quota. The small tool, preset and cleanup entries remain separate because DSH loads them through distinct public contracts. Combining those files would not relieve cache-state density. Git file functions do not import CacheStore or process supervision; the helper imports the plan decoder and shared linker without importing the cache owner.

The debugger uses two files. `native-debug.ts` holds typed Win32 bindings, bounded remote-data and context helpers, and SID/DACL builders. `process-family.ts` owns the Job, debug loop, module admission, breakpoint state and MSYS hooks behind `runPrivateBash`.

We initially planned a third file for the MSYS hooks. Reviewing the archived `arm`, `onHit` and `eventOnce` functions showed how closely they share process, thread, module and breakpoint state. Keeping them together avoids exporting that state or adding callbacks just to cross a file boundary. Native helpers may borrow a handle for an operation; they do not retain the process family's state or lifetime.

We also keep one compatibility engine rather than duplicating it for experiments. Production always follows the private family and uses a coherent repair policy for its mode; experimental capture and independent repair switches stay out of its launch API. The generic `NativeRuntime` module-loading interface used by diagnostics is replaced by the pinned production dependencies.

### Return a pin that owns what the caller needs

The executor calls `prepareRuntime(request, signal)` and receives a `GenerationPin`. The pin exposes `lease(scope, signal)` and `release()`, retaining its private cache owner internally. The request now also carries one bound local DSH `Subprocess.spawn` capability for setup supervision. It is neither cache metadata nor part of selection identity; no Context object or new subprocess service crosses this boundary.

This replaces separate `CacheStore.open`, `prepare` and `lease(store, pin, ...)` calls. The caller no longer passes the same source and workspace through consecutive setup operations or keeps a store alongside its pin.

Preparation validates the source and cache without a workspace argument. Each command's `pin.lease(scope, signal)` checks its own workspace before the executor invokes DSH's confinement callback. The installed DSH executor defers confinement through that callback, so the overlap check can run before workspace grants reach any hardlinks. Moving the check into the already-confined launcher would be too late.

### Keep coordination in the executor

A private preparation slot contains the selected Git Bash path, abort controller, promise for the pin and the pin once ready. Rebuilding can run beside an established ready pin. Otherwise its operation becomes the shared readiness slot. Existing execution and owned-work tracking handle settlement; two references to the same operation do not create two pin owners.

We dropped `RuntimeCoordinator`, its six-state public status model and `RefreshReason`. The executor already owns this lifecycle, and the separate module mostly repeated that responsibility.

Read gitBashPath at command/rebuild entry and recheck it after waits, before adoption or use. If a slot or rebuild operation has a different selection, detach and abort it, retiring any owned pin before using the new selection. Completion also checks slot/operation object identity, its AbortSignal and provider stopping. Release stale results instead of adopting them.

Remove the epoch counter and loader/volatile-update subscription. If a call observes B during A -> B -> A, it detaches and aborts the first A operation; matching A again cannot revive that object. If B is never observed at a work boundary, the original A preparation remains useful when the setting is A again. Discarding it would only repeat setup.

This accepts that an idle setting change does not immediately cancel work or release a ready pin. The next command, rebuild or completion checks the current selection. We rejected subscribing merely to remember transient values: the executor needs the current selection and operation ownership, while version-sensitive Cordis/Loader integration stays in adapter.ts. Even an immediate-invalidation listener would not need an epoch once it detached and aborted the old objects, but this design needs no listener.

We initially dropped `refreshRuntime()` because no production caller had been identified. The planned UI rebuild button now supplies a concrete use case. We will implement a narrow `rebuildRuntime(): Promise<void>` method with the backend in Phase 4, and defer the UI binding. This does not restore the generic refresh/status service.

Failed readiness stays failed for ordinary calls, so repeated commands do not repeatedly scan or request UAC. Rebuild failure preserves an established ready pin; without one, the shared rebuild slot remains failed. An observed selection change uses normal cache eligibility, while an explicit rebuild requires a fresh generation.

### Use narrow contracts and existing validation tools

Use DSH's policy, mode, execution and native-handle types. Native bindings should have specific signatures and named calls instead of a string-indexed dispatch table accepting arbitrary arguments.

Helpers take only the values they use. The environment builder receives the view, recorded source path, admitted layout and ambient environment. It does pure path/string work, without a full runtime object or command-time discovery. The archived builder probes git.exe to choose ucrt64/mingw64 on every call; the pin already knows that layout. Carry the closed layout value in RuntimeUse and through the launcher input. Remove realpathSync(source) as well: source paths are for PATH filtering and scope comparison, not a live binary dependency.

Some FFI declarations need a small assertion where the native library cannot express the exact signature. Keep that assertion at the binding site so it does not weaken the rest of the code.

The same principle applies to any adapter required by the inherited configuration schema's TypeScript type. Preserve native defaults, volatility and persistence rather than changing runtime behavior to make the type declaration easier.

Schemastery already provides the required field, version, range and collection checks. We rejected a custom recursive exact-key validator. Unknown JSON properties are ignored, and code consumes only known validated fields. Missing ownership values are errors rather than values to fill with defaults.

An unused JSON property cannot authorize deletion outside the cache. Filesystem authority comes from strict root admission; the whole interior is disposable plugin storage. Structural checks, generation holds and helper gates still determine how and when it can be removed. Link targets outside the cache remain untouched.

## Runtime files and session views

### Use hardlinks in private DSH storage

Runtime files remain NTFS hardlinks to the installed Git files. This avoids maintaining another set of copied program binaries and preserves their shared file identity and security descriptors.

The cost is the same-volume requirement and, for protected Git installations, UAC permission to create links. Only the fixed link helper receives that elevation.

The persistent cache lives in the DSH profile to keep native paths short and survive restarts. Compositions without profile metadata use the package's private fallback cache. Rebuilding a disposable tree for every command or restart would repeatedly pay the linking and elevation cost.

Source and cache paths stay separate in both containment directions, checked before creating runtime artifacts. Each command compares its canonical workspace with the pin's recorded canonical source path and admitted cache root before DSH confinement can propagate workspace grants. Workspace canonicalization must also resolve aliases into those trees. The old source path need not still exist to run that cached generation. Preparation itself neither grants workspace access nor needs a session root. Environment changes apply only to the child execution.

Creating and removing hardlinks changes NTFS bookkeeping, including change times, the archive bit and journal records. We accept those filesystem effects. We do not rewrite attributes or timestamps to conceal them.

### Keep one base per generation

Three full mode trees already linked the same source objects, so they did not provide separate file contents or file ACLs. We chose one shared base per generation as the only architecture.

For 8,181 selected source paths, this reduces cache links from 24,543 to 8,181. The current design probes permission first, then inventories in the process that will link the tree. The local and early-UAC paths each inventory once; a later permission failure stops setup without an elevated retry. Both callers use the same fresh-tree linker and finish with fixed checks. Warm startup and ordinary commands walk neither tree.

Keep every required relative pathname, including Git's own aliases that share a file ID. Cleanup removes names in the admitted cache directory, and link-count checks account for those aliases. Deduplicating the layout by file ID would lose required names.

The layout is immutable once published: the plugin does not repair a live base in place. Hardlinks still share in-place source writes, so a generation is not a frozen copy of file contents.

### Make the scoped view carry namespace identity

Every execution uses a pin-owned view directly targeting the base. Its key includes the pin instance, generation, mode, canonical workspace and session. Separate pin instances cannot remove each other's views even when they use the same generation. Agentless calls receive distinct per-call names within that pin's view namespace.

Each pin keeps a `Map<string, Promise<string>>` for session views, keyed by an unambiguous tuple of mode, canonical workspace and session ID. Store the creation promise before yielding. Concurrent and later leases await the same promise, so they need no filesystem EEXIST coordination or repeated view-target queries. The archived RuntimeDirectory.view already used an in-memory map; promises adapt that ownership to asynchronous creation.

First creation uses admitted private parent paths and refuses an unexpected existing junction. If creation fails, the shared promise cleans up any partial target it created without following links, evicts its Map entry and propagates the failure to its awaiters. Evict even when cleanup itself reports an error; remaining private residue belongs to pin cleanup. A later lease can retry. An EEXIST failure does not authorize deleting or adopting an object this attempt did not create. Keep this handling inside the awaited promise rather than attaching a detached rejecting cleanup chain.

Each lease increments refCount once before its first await, awaits workspace admission and view creation, then checks caller cancellation. If acquisition fails or was aborted, finally releases that one reference. A successful use keeps it until release. This ordinary lease reference already prevents pin finalization during creation, so no pending-creation counter, abort race or background task is needed. The trade-off is that cancellation waits for the short local operation to settle; it does not interrupt another caller's shared creation.

We dropped permanently cached rejections because a transient creation failure should not disable the session until a new pin is prepared. Cleanup and eviction allow the next call to retry with the same safety checks. Clear the map during final pin cleanup. Agentless views retain unique per-call names and stay outside the map.

Every lease still admits its actual workspace before confinement. Each child launch validates the view junction and its base target in process-family. A cached promise records creation, not the current state of an externally mutable junction. The installed DSH confinement seam grants workspace/temp paths, not installationRoot, so repeating the view query in lease would add no earlier ACL boundary. Rejecting a changed view at launch remains mandatory. Releasing one command does not remove a session view that another command may still use.

Session views remain until pin retirement and zero use references, without per-view counters. Agentless views have one user and a unique name, so release attempts non-following rmdir before dropping the reference. Pin finalization attempts the remaining view-tree cleanup. Transient removal failures can leave cache-local residue for later generation GC or purge; there is no per-command queue or retained view-removal task.

We removed the intermediate `modes/<mode>` junctions and the `modeRoot` parameter. They added no data, ACL or lifetime boundary once every mode used a scoped view.

Two paths remain useful: `baseRoot` establishes the physical executable and DLL boundary; `installationRoot` supplies the scoped MSYS identity and child execution paths. Logical mode remains explicit in policy and the view key.

### Require the namespace hook in every mode

The targeted Windows experiment ran two concurrent sessions in each mode against one physical base. It observed six distinct MSYS namespaces, stable reuse on repeated commands, and the same measured access behavior as the three-tree baseline. Removing the installation-root hook made different view inputs collapse into one namespace.

That result makes the startup-root hook mandatory in every mode, including full-access. Pipe, default-DACL and mapping grant repairs remain confined-mode-only. Read-only uses the token's existing logon security identifier (SID); workspace-write uses its existing private-temp SID. Using a shared grant for workspace sessions would weaken their write boundary. The full-access cases obtained distinct namespaces with zero ACL repairs.

Distinct names keep sessions from accidentally sharing an MSYS namespace. In the probe, other sessions could still read the test objects, and the shared logon SID allowed writes to objects in read-only scopes. Full-access retained its broad permissions. These results were the same in both layouts; stronger IPC confidentiality would require a separate access-policy change.

### Use one native handle per pin and local references for commands

A `GenerationPin` owns one non-inheritable read handle on its generation directory, with read sharing but no delete sharing. Its in-memory `refCount` starts at one for the owner slot or preparation operation. A `RuntimeUse` retains that same handle through a local reference; it creates no lease file and opens no generation hold of its own.

Before any await, pin.lease checks that the pin is accepting uses and increments the counter once. It awaits workspace admission and view creation before checking caller cancellation. Its finally releases that reference on failure or abort; successful acquisition transfers it to the RuntimeUse. No separate creation reference exists. Releases are idempotent. Retirement prevents new uses and drops the owner reference. At zero references, one finalizer attempts non-following view cleanup and closes the native handle even if view removal fails.

Session-use release normally drops a reference; agentless release also attempts its unique junction removal. The last release on a retired pin awaits finalization. Retiring a pin with outstanding uses does not wait for their executions.

The revised AGENTS.md separates normal disposal from complete uninstallation. At zero references, attempt private view removal and always close the native generation handle with checked error handling. Drop the retained view-cleanup obligation, disposal retry and failure propagation for transient cache-local residue. A failed native close or surviving owned process remains a real error.

The earlier retry obligation followed the former requirement that normal disposal remove every instance artifact. That requirement has changed. Views are isolated by pin instance inside a persistent disposable cache, so a leftover junction need not block shutdown. It may remain while the generation is current; later collection or uninstall purge removes it when eligible. We do not promise removal on the next startup or add a periodic sweeper.

Best effort applies to removing private artifacts, not to following unsafe paths, changing source ACLs/attributes or dropping live handles. Stop unsafe traversal and keep useful diagnostics; do not broaden cleanup to external targets.

The directory handle alone does not prevent deletion of child files. Collection must first obtain DELETE access to the generation directory. A pin denying delete sharing blocks that open, so the collector must stop before deleting any child. Its DELETE-access handle uses read/write/delete sharing, allowing Node traversal while preventing a new pin from opening without delete sharing. Hold the collector handle through removal and close it after `rmdir`.

A disposable Windows probe passed eight checks for compatible pin opens, collector exclusion, Node child operations and final directory removal. It verified these primitives in one process, not the complete refCount or crash lifecycle. The fixture was removed.

We removed separate candidate holds as well. The cache writer lock remains held through allocation, linking, UAC, final fixed checks and publication; collection needs the same lock. A fresh generation's pin handle is opened before publication and lock release. Warm admission always uses the lock-free read/pin/selector-recheck path below. Native sharing excludes overlapping collection; the selector check rejects a generation left by interrupted collection. The helper's exclusive plan handle protects an elevated process that survives controller death.

This replaces ambiguous references to candidate, provider and execution disk leases with two mechanisms: the writer lock protects setup, and one pin handle plus local references protects execution. Root owner leases are now removed. A separate lease exists only for an actual UAC attempt; warm pins create no owner files.

Uses from an existing pin do not wait for the preparation lock. An observed selection mismatch retires the old pin before new use; a manual rebuild retires a ready pin only after successful replacement. Existing uses retain its handle and views until they finish, and other DSH processes retain their own pins. Native handle/process cleanup stays owned until settled. Transient view-removal failures create no retained retry obligation.

## Initialization and cache verification

### Initialize on the first real Bash call

We rejected eager activation warmup. It could display UAC before any Bash request, required a startup fallback workspace, and added intermediate readiness and shutdown cases. The recurring performance problem came from scanning on every command, not from lazy initialization.

Normally the first real call starts one shared preparation, which later callers reuse. An explicit rebuild request can start that pipeline before the first command, without an active session. Each command still supplies its own scope when it leases the runtime. The plugin does no preparation merely because it was enabled.

Caller cancellation and preparation cancellation remain different lifetimes. One timed-out caller should not abort work needed by another. Provider disposal or an observed selection mismatch cancels owned preparation. Rebuilding also supersedes unfinished initialization when there is no ready pin. A cancelled command is checked again before leasing or launch, so it does not execute later when preparation finishes.

### Use fixed anchors on a warm restart

We first planned to walk both source and cache after a restart, then reduced that to a cache-only walk against the saved inventory. The latest review removed that recurring walk too. The measured Node scans took roughly 0.9–1.7 seconds; calling a scan on every restart “rare” understated its cost.

The chosen policy is:

| Situation | Work |
| --- | --- |
| Cold cache, changed anchors, a different source or unusable metadata | Probe permission; inventory in the chosen local/elevated pass, link a fresh candidate, then check anchor identities, save base stamps and check boundaries |
| Valid current generation on restart | Read current, acquire the pin, recheck the selected ID and verify six source/base anchor pairs without the writer lock |
| Ordinary command using a prepared pin | Admit workspace before confinement and await the pin's view promise; the child checks the view/base path, module identity, loader path and Job |
| Explicit rebuild, including suspected non-anchor cache damage | Probe and provision a fresh generation through the same pipeline; the future UI invokes the executor hook |
| Interim CLI or offline recovery | Close DSH, purge the caches through the existing cleanup entry, then restart for lazy rebuilding |

The six mandatory anchors are `usr/bin/bash.exe`, `usr/bin/sh.exe`, `usr/bin/msys-2.0.dll`, `<architecture>/bin/git.exe`, `etc/profile` and `etc/install-options.txt`. Check identity, size and last-write time against saved expectations in source and base. Comparing the two live hardlinks only to each other would miss a shared in-place update.

We replaced the 16-path set because it made OpenSSL ABI filenames and auxiliary tools part of plugin compatibility. An OpenSSL major-version change or moved Git helper should not reject an otherwise supported core layout. Cold inventory still includes those files, but warm admission no longer requires them by name. We chose the six core paths over dynamic candidate sampling to keep a closed schema without optional-file discovery rules. All six exist in the inspected `ucrt64` installation; `mingw64` remains the other supported layout. A genuine core-layout change still needs a compatibility update.

This choice gives up full cache-layout verification at restart. A deleted non-anchor Perl module, an extra cached file or a source-only replacement may remain undetected while the anchors match. Confined sessions cannot normally alter the base, but full-access commands and outside programs can. Six anchors detect fewer non-core changes than sixteen. We accept that smaller sample for stable layout requirements and faster startup; it is not proof that every Git update or file change will be detected.

The intended user-facing recovery is a button in the future UI that requests an online rebuild. The packaged `lib/cleanup.js` entry is the interim CLI route and an offline fallback: close all DSH instances using the caches, run that entry with the profile cache path, then restart and make a Bash call. It purges the profile and package fallback caches while leaving the package and settings intact. Restart alone is not advertised as repairing every missing cache file.

A failed debugger module/path admission stops execution. Replacing a source pathname does not. Neither starts a scan on each command retry. A new provider or selection permits initialization to reassess the source/base anchor set; an explicit rebuild forces a new generation. An ordinary command failure is not automatically diagnosed as cache corruption.

We also dropped `recheckSource`. Observing a different `gitBashPath` starts a new preparation slot, but eligibility follows the resolved installation and anchors. An alias to the same installation may reuse the same generation. A setting toggle is not an implicit force-scan command; rebuilding is a separate explicit request.

We removed missing-pointer recovery that searched and promoted unselected inventories. `current.json` is now the entire disk admission record, with no per-generation inventory to search. If safely admitted current metadata is missing or malformed, build a fresh generation. A crash before publication can still discard a completed candidate and require relinking, but there is no longer a gap between two generation metadata writes. Existing pins retain their admitted record in memory and their native hold.

### Use one lock-free warm path and retain the selector check

A healthy published generation should remain available while another DSH instance waits on UAC. We removed the lock-first branch. Warm preparation reads current, opens its generation pin, rechecks the selected generation ID, then verifies the source selection, six anchor pairs and boundaries. The committed record follows completed setup and ordinary control cleanup. Warm admission has no control-file inspection or setup state machine. Return the admitted pin directly, without owner registration or a filesystem write.

We retained the selector recheck for a concrete failure case. A reader can capture generation A, then pause. Another owner publishes B, claims DELETE access on A and starts collection. Once an interrupted collector's handle closes, the delayed reader can open A successfully. The earlier fixture removed a non-anchor first and left all six anchors intact, demonstrating why handle exclusion alone was insufficient.

The second read rejects A because it is no longer selected. Compare generation IDs, not complete JSON bytes: every publication uses a fresh ID and records are never rewritten or republished for an old ID. A later pointer change after this check is harmless because the reader now holds the pin and excludes collection. No persistent tombstone or retirement rename is needed.

We removed the later Bash-first deletion rule. GC only collects unselected IDs, and purge unpublishes current before deleting payload. Once either collector releases its claim after an interruption, a delayed reader fails the selector recheck before looking at anchors. If the reader acquired its pin first, the collector could not claim the directory. Under these rules, leaving all six anchors intact cannot cause false warm admission.

Use the standard non-following unlinker for every payload entry. There is no Bash-specific failure-halt branch or before/after-Bash fault matrix. Keep the stronger test: remove arbitrary non-anchor payload, leave every anchor intact, interrupt collection and verify that the delayed reader rejects the stale selection. Also cover interrupted purge after unpublication. Never reuse or republish a generation ID; relaxing that rule would require revisiting this proof.

On a missing/malformed record, missing/busy generation or eligibility miss, close provisional handles and enter the waiting writer path, which rechecks current before building. There is no optimistic retry loop. Unsafe root/path types and access errors remain errors. Short metadata reads and the upstream writer's bounded Windows rename retries remain; an earlier probe observed EPERM with a deliberately held-open reader.

Purge needs one ordering correction. After claiming DELETE access to a selected generation, retire current.json before deleting any children. Otherwise interrupted purge could leave a partially removed tree still selected, defeating the recheck. Keep the root ownership marker until every generation is gone so cleanup can resume. If a reader wins the pin first, the purge claim fails; if purge wins, a delayed reader loses its open or sees the missing selector. No root owner registration remains; purge preclaims every ordinary generation before deleting payload.

This replaces the former rule to remove both current and root metadata after all generation data. Only root ownership must remain until the end. Warm hits do no GC or writer-lock waiting; real cold misses still use the writer path. The existing six-check native fixture supports these interleavings; its separate handle-based plan-retirement experiment is historical. All fixtures were removed.

### Keep cache freshness separate from debugger admission

Six source/base anchors are checked when establishing a pin. Once ready, lease checks workspace admission before confinement and awaits view creation, with no binary stats or reused-view queries. Child launch owns view/base validation. We removed entryExpectations from RuntimeUse, the launcher arguments and PrivateBashLaunch.

The preceding revision moved the pin's saved Bash/MSYS stamps into debug-event handling to preserve two per-command baseline checks. That detected some post-pin identity, size or timestamp changes, but coupled cache metadata to the launcher and low-level debugger. We now accept the same post-pin freshness limit for these entries as for the rest of the cache.

The debugger keeps its process-local correctness checks: private Job/token admission, the private executable and actual MSYS loader path, and loaded MSYS file identity matched to the DLL admitted under baseRoot for that family. The startup-path hook uses that same local identity. An image handle may name another hardlink alias, so file identity does not replace the loader-path check. Native children are not all Bash or private executables; processes receiving MSYS repairs must satisfy the private module/path predicates. A required check that cannot be established stops the family.

This follows the role of the archived debugger without making it a cache-integrity service. Its own native identity/PE checks remain; no cache stamps or current.json reads cross the launch boundary. In-place binary changes can go undetected after pin admission, including changes to Bash or MSYS. We do not claim byte immutability or periodic source-update detection.

Source pathname replacement alone still does not invalidate an existing cached generation. The recorded canonical source path remains useful for workspace separation and PATH filtering, without opening source binaries at launch. There is no timer or anchor cooldown. [Windows hardlink semantics](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createhardlinkw) distinguish shared file data from replaceable pathnames.

### Preserve ready pins and replace unfinished preparation when rebuilding

Keep `GitBashExecutor.rebuildRuntime(): Promise<void>` for the planned UI button. It captures the current Git selection/cache, requires no workspace, and calls the same preparation pipeline with rebuild: true. It never purges a live generation or forces another DSH instance to rotate its pin.

Only an established ready pin needs protection from rebuild failure. If the current slot has a pin, keep it serving commands while a separate rebuild operation runs. Adopt the new pin after successful preparation and current-selection, operation-identity, cancellation and stopping checks. Then retire the old pin; existing uses keep their references. Failure leaves that ready slot intact.

If there is no ready pin, abort and detach unfinished initialization and install the rebuild operation as shared readiness before any await. Both rebuildRuntime and command readiness await the same preparation; the method returns void after adoption. Settle the superseded local work through the existing cancellation path before starting fresh preparation. New commands join the rebuild, and waiters on the displaced slot follow current readiness after either fulfillment or rejection unless they were themselves cancelled. A stale result cannot overwrite the replacement and is released once.

Failure without an established pin leaves the shared rebuild slot failed, just like failed initial preparation. There is no old attempt to restore or automatic retry. Disposal and selection mismatches retain ownership of cancelled work until it settles; a local cleanup failure prevents the replacement setup from starting.

This restores one ready-pin check and drops the previous choice to let cold initialization and rebuilding compete. That uniform-looking rule could finish a full cold build only to run another inventory and UAC request. Simply aborting and clearing the slot would also be insufficient: the next command could start competing preparation while the rebuild waits. Installing shared readiness immediately removes that gap and the need to test two competing cold completion orders.

Cancellation cannot retract consent already displayed by Windows. If an old attempt has reached UAC, replacing it still follows the broker's existing cancellation limits. The new rule avoids duplicate active preparations and their avoidable prompts; it does not add a dialog-management protocol.

We continue to reject invalidating a working pin at rebuild request time. A cancelled UAC prompt should not break commands that were already ready. New commands can therefore use a suspected damaged cache while replacement runs, subject to normal scope/view/module checks. Rebuilding does not repair damaged source bytes shared through hardlinks.

The method resolves after fresh publication and adoption. Stale results never rewind an already published current.json. The future UI disables its button until settlement; overlapping rebuild calls get a busy error, with no queue or coalescing. No epoch, generic coordinator, public status service, route or UI is introduced.

### Use Node traversal for cold, invalidated and explicitly rebuilt runtimes

Native batch enumeration was substantially faster in the local measurement: about 102 ms warm median versus 873 ms for one Node source pass over 8,181 files in 761 directories. We nevertheless chose bounded, cancellable Node traversal for production.

Removing per-command and warm-restart scans delivers the main benefit. Optimizing the remaining cold, invalidated or explicitly requested inventories would add a native record decoder, alignment and buffer rules, plus handling for stale metadata at hardlink aliases.

The hardlink probe showed why that matters: after a write through one name, the other directory entry still reported 7 bytes while opening the file reported the current 37 bytes. Both parent directory timestamps were unchanged. Shared data does not make every directory-entry observation current.

We dropped the production batch decoder and `DirectoryMetadataHint` model. A Git version identifies a release, but cannot reveal a deleted cached file or a source replacement that kept the same version. Directory timestamps do not provide a recursive change record either. The native prototype remains research material if profiling later justifies its complexity.

We also rejected per-command directory-timestamp sweeps, filesystem watchers and a journal service. They would add monitoring and recovery work to a design whose ordinary commands already need no full scan. The measurements did not establish the proposed 10–15 ms complete-verification target. The newer 5 ms anchor-check estimate also needs measurement; reading and validating the saved metadata has a cost.

Node traversal stops scheduling after cancellation and waits for work already issued. Necessary native identity and reparse checks remain at filesystem boundaries.

### Assign checks to their actual boundaries

The previous wording could be implemented as repeated realpath/stat work at every function call. Use this ownership map instead:

| Boundary | Checks and reusable results |
| --- | --- |
| Pin establishment | Root ownership, generation/base/internal junctions, source selection and six anchors; retain admitted canonical paths/layout |
| pin.lease | Canonicalize the actual workspace once, reject source/cache overlap before confinement, and create or await its pin-owned view promise |
| Environment construction | Pure path/string construction from the admitted view, source and layout |
| bash-launcher | Parse invocation and validate inherited mode/token/policy; do not repeat process-family path admission |
| process-family | One child launch-path admission, then actual Job membership, MSYS file identity and loader-path checks using cached family values |

Do not repeat marker reads, anchors or internal-bin checks on each command. Reuse a canonicalization result within the call/family. Keep one view/base check at every child launch: the generation pin prevents cooperating collection, but does not freeze a junction's target or transfer an opened path into the child. Remove repeated view checks from lease and consolidate the archived launcher/debugger path work in process-family. Compare with the admitted absolute base path supplied by the parent, rather than treating a newly redirected realpath as the new boundary. Workspace overlap checks remain before confinement because those grants can reach hardlinked source files.

## Ownership and metadata

### Make the admitted root the ownership boundary

The audit's F1 loss occurred because the plugin adopted a markerless directory and deleted a pre-existing file. Keep the root guard: exclusively create a new cache, or validate the marker, schema, canonical path, root identity, non-reparse boundary and source/cache separation before use. An existing unrecognized root remains untouched. Recheck admission after waiting for the writer lock.

Once admitted, the entire root interior is plugin-owned disposable storage. Remove the preservation rules for unrelated-looking top-level files, nonmatching generation names and metadata-temp patterns. Users placing files inside that admitted cache should expect purge to delete them. This authority does not extend to files outside the root or to link targets.

Earlier revisions used per-leaf records, then a per-generation registry, then a reserved generations namespace. We dropped each layer as the ownership model became clearer. The updated AGENTS.md now makes the root boundary sufficient. No ownership registry, reservation receipt, interior preservation list or empty-shell exception is needed.

Keep structural and lifetime checks separate from ownership. Preparation requires an ordinary same-volume generations container and validates generation IDs as selection/attempt keys. Purge can remove unexpected interior names, but must still obtain generation DELETE claims, retire helper admission and respect live pins and setup. A known junction or symlink can be removed as an object; it cannot be used as a runtime tree or traversed during cleanup.

The container's historical file ID remains absent from metadata. A recreated ordinary empty container has the same role. Live identity/path checks still bind operations to the inspected objects, without becoming another ownership registry.

Fresh setup is protected by the writer lock. Before successful publication, open the pin handle. On cancellation, close the attempt-specific setup lease and settle local work before releasing that lock; an unconfirmed helper can remain only behind its plan gate in an unpublished candidate. Ownership of all cache data does not make active setup disposable.

### Unlink names without touching their targets

Namespace ownership identifies the private subtree; safe deletion prevents changes to installed Git or traversal outside it.

The walker unlinks regular names without changing data, attributes or permissions. It removes known junction/symlink objects anywhere inside the admitted root without visiting their targets, and descends only into ordinary directories. Unsupported reparse handling or access errors stop strict purge; best-effort normal cleanup never follows a target to work around them. A generation child that is itself a junction is not admitted as a tree; [Windows can remove a junction regardless of its target's contents](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-removedirectoryw), so `rmdir` success is not an admission check.

We retain explicit unlink and rmdir operations rather than recursive removal that may repair permissions on Windows error paths. Removing a private hardlink name does not need a saved identity for that leaf or the continued presence of its original source. A damaged helper plan is not a deletion allowlist and need not prevent otherwise authorized cleanup.

### Publish one small current record

The full persisted inventory lost its consumers when we removed restart tree walks, per-file deletion authority and missing-pointer promotion. Keeping thousands of unused file records would add serialization, parsing and validation without changing admission.

We chose to put the remaining fields directly in `current.json`: schema version, generation ID, canonical source root, supported layout and the six core anchor expectations. There is no `inventory.json` or per-generation `commit.json`. Each linking process keeps its working inventory only in memory; the temporary helper plan contains no file list.

The record uses ordinary named fields and a bounded reader. Its size depends on paths and serialization; the earlier two-process fixture's 16-anchor record was 2,049 bytes. That was evidence for the former sample, not a bound on the current schema. We do not make 2 KB a hard limit or introduce a packed format to meet that estimate.

The earlier design bound two files with a generation ID and briefly added an inventory digest. Removing the digest simplified that arrangement; folding admission data into the pointer now removes the association entirely. No digest, envelope, canonical JSON, signatures or transaction log is needed.

After complete linker processing, actual joins, final fixed checks and ordinary setup-control cleanup, acquire the fresh generation's pin handle and atomically replace `current.json` through an owned sibling temp. This is the single generation-publication operation. Before replacement, readers see the previous complete record; afterward they see the new complete record. Each publication uses a fresh generation ID, and active pins keep their admitted record in memory.

This removes the crash window between inventory and pointer writes. It does not make all preceding filesystem work durable as one transaction. An unused candidate can still be collected after interruption; missing or invalid current metadata still causes a fresh build.

### Keep metadata rules small and reuse DSH atomic writing

Internal JSON is plugin-owned metadata. Require ordinary bounded no-reparse reads and temp-and-rename replacement. Keep nlink checks removed, and drop the proposed hardlink-backup behavior and alias-preservation tests. Manually making aliases of control files is not a feature the backend needs to support.

Use the public @deepseek-ai/dsh-atomic-write writeFileAtomic utility. We inspected its pinned source again: it creates an exclusive random-suffix sibling, renames it over the destination and retries transient Windows rename errors. Its parent mkdir runs only after the plugin has admitted the existing parent; it does not replace root ownership checks. Publication still holds the cache writer lock.

The earlier custom writer tracked exclusive temp ownership; a later revision justified the upstream failure cleanup through reserved temp-name patterns. Neither is needed under the current root-owned model. The admitted cache interior, including temporary files, is disposable plugin storage. Reuse the utility without temp regexes or personal-file preservation rules. Root admission remains mandatory before calling it.

Do not apply this utility to runtime hardlinks or arbitrary user output paths. Use explicit metadata modes and the public pinned dependency; do not import an installed private implementation. No local atomic writer or separate rename retry loop is needed. Crash durability remains outside this replacement primitive's promise.

Keep the existing native cache writer/owner mechanisms. The upstream PID-based file lock is not a replacement for the helper gate: a controller can die while an elevated helper remains alive or consent is pending.

## Setup and recovery

### Probe permission before inventory or base population

After source/cache and fresh-generation admission, try one no-overwrite hardlink from usr/bin/bash.exe to `generations/<id>/.probe`. Check the anchor and its ancestors for ordinary types, reparse points and the read-only attribute first. Keep the probe inside the private candidate and on the admitted volume. Immediately unlink it on success; a cleanup failure stops setup without elevation or attribute repair.

An EACCES/EPERM from this admitted link attempt can request UAC before the full inventory or any base children exist. Create and admit the empty base once for the selected pass. This removes the wasted controller walk on the early-UAC path and avoids tearing down a base containing only usr/bin. A user declining that UAC request no longer discards a completed controller inventory.

We rejected using base/usr/bin/bash.exe as the probe because it coupled permission detection to directory construction and reset. The sibling probe adds one temporary hardlink on a successful local path; removing it restores that link count, with the approved NTFS bookkeeping effects. Its success says nothing about another file's ACL or a later permission change. The measured 0.9–1.7 second scans explain the potential saving, but neither a universal Program Files failure rate nor a fixed time saving is established.

Other errors do not automatically request UAC. Inventory, directory creation, probe cleanup, unsafe paths and read-only attributes remain their own failures. The helper may discover an unsupported later source entry after consent; accepting that ordering avoids a full pre-consent scan. Discovery and fixed boundary/layout admission still run before the probe.

### Share one fresh-tree linker and inventory in the process that uses it

Both callers use inventoryGitFiles and linkFreshTree from runtime/git-installation.ts. The inventory validates normalized unique relative names and the supported source selection. The linker retains ordinary-file/reparse/read-only checks, no-overwrite creation and bounded work. Derive parents once, create them shallow-to-deep, then schedule links.

Keep plan.json limited to schema/attempt identity, sourceRoot, cacheRoot, generationId, baseRoot, layout and expected NTFS identities for source, cache, generation, base and .setup-owner. The helper independently admits those objects and inventories its source. It holds its exclusive plan handle through inventory and linking. Both functions use a small checkActive callback: the controller checks its signal, and the helper checks its setup lease between bounded batches.

We rejected serializing thousands of path strings. The helper still needed to validate that list; local enumeration gives it the fixed selection policy directly. Each selected pass starts with an empty base and inventories once. Create final internal junctions after successful linking.

The sibling probe is now the sole automatic local/UAC decision. If it succeeds but any later inventory or link fails, stop scheduling, drain issued work and reject setup with the failing operation and path. Leave the unpublished candidate for ordinary guarded GC. Do not wipe/recreate base, capture a replacement identity, discard inventory for an elevated retry or resume partial links.

This rejects the previous mid-tree reset-and-escalate pipeline and its dedicated tests. Mixed ACLs and concurrent permission changes are possible, so we do not describe every later denial as a broken installation. We choose an ordinary setup failure for that case: the user must resolve the source obstruction before retrying. Automatic recovery from it is not worth a second privileged pass and a second base lifetime.

### Capture anchor expectations after linking

After successful setup and joins, open the six source/base anchor pairs through authoritative handles. Check ordinary file kinds and boundaries, and require matching volumeSerial/fileId for each pair. This establishes that the two opened names refer to the same NTFS file object. Save the base handle's FileStamp, including identity, size and last-write time, in current.json.

Remove the setup-time size/last-write comparison between the two handles. It could detect a write in the interval between observations, but it did not create an atomic snapshot or prevent a write immediately afterward. The identity check and one recorded sample are sufficient for this capture step. Do not add a pre-link baseline, repeated reads or a stability loop.

Warm admission still compares both source and base against the saved full stamp. Retaining size and last-write time there detects later shared in-place changes that identity alone would miss. Choosing the base observation gives one clear baseline; it does not weaken those warm checks.

We accept that writes during capture can become part of the baseline or happen after it. Keep ordinary identity/kind admission and warm-stamp tests. Drop setup-time fault-injection requirements for pre-link versus post-link replacement and cross-handle drift; they test a timing protocol we no longer need. Existing probe reports remain historical evidence.

### Use broker exit status as the completion contract

F4 is a direct native wait/close defect. Reuse DSH's public pollProcessExit and closeHandleChecked, validate the helper exit code, and never treat wait failure as proof of exit. This fix works with either a worker or a broker; F4 alone does not justify another process.

Both fixed scripts start with a nonzero process.exitCode. The helper sets zero only after linking and checked plan-handle closure. The broker sets zero only after ShellExecuteEx returns a process handle, pollProcessExit confirms helper exit zero, and closeHandleChecked succeeds. Missing handles, WAIT_FAILED, nonzero helper exit and close failure remain errors.

The parent accepts only uncancelled normal broker success with its DSH managed range settled. Use the SDK's target outcome, not the internal runner's exit code. Bounded stderr supplies diagnostics; no result.json, stdout JSON, raw handle transfer or completion union is needed.

provisionRuntime is one awaited UAC operation, invoked only after an admitted permission denial at the probe. Rejection leaves the candidate unpublishable and does not prove helper exit. Failure cleanup still needs the directory claim and plan-unlink guard.

### Cancel only the UAC attempt, without warm owner files

Only actual elevation creates .setup-owner. The controller creates this non-inherited lease exclusively with delete-on-close, binds its NTFS identity in the plan and never recreates or reuses it for the attempt. Root owner files and a cancellation marker are unnecessary.

Closing the lease is the cancellation mechanism. The helper checks it through fresh short-lived metadata opens before work and between bounded inventory/link batches. Missing, delete-pending, mismatched or ambiguous observations stop scheduling. Already-issued work drains while the helper retains its exclusive plan handle. Controller death releases the lease in the kernel.

Do not also delete the plan to signal cancellation. After local supervision settles, ordinary guarded cleanup can unlink it, or GC can do so later. A background reader may block that unlink, but it cannot keep the attempt authorized: a late helper must still check the revoked lease. The existing setup-lease fixture demonstrated this case with a share-none reader; it did not measure antivirus behavior.

The two files now have distinct jobs. The lease says whether this attempt may continue; the plan supplies immutable input and excludes collection while the helper holds it. Neither the provider PID nor the current writer-lock holder identifies a cancelled attempt reliably. Keep both files for those separate responsibilities, without a second retirement protocol.

### Keep the broker for local shutdown, separately from F4

We retain elevation-broker.ts as a small unelevated process owned by DSH Subprocess.spawn. It hosts modal COM/UAC work and observes the helper through the public wait/close functions. Its only completion protocol is exit status. The extra process costs startup and supervision, but keeps a blocked native call outside the DSH process.

A Worker thread would be sufficient if disposal could wait for ShellExecuteExW to return. Node's [termination contract](https://nodejs.org/api/worker_threads.html#workerterminate) addresses JavaScript execution, not interruption of arbitrary native calls. [ShellExecuteEx flags](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-shellexecuteinfow) do not supply a dependable immediate-return cancellation mechanism. The existing native-Sleep fixture supports this distinction: Worker.terminate waited about 1,454 ms, while a separate process stopped and joined in about 15 ms. Those are fixture timings, not a UAC deadline or proof of the proposed DSH integration.

We choose responsive local cancellation and disposal over waiting indefinitely for the user to resolve consent. On cancellation, close the setup lease and allow the short cooperative grace while retaining observation. Stop/join the broker through DSH only if needed, then drain and close local resources before releasing the writer lock. A timer or unref on a Worker would leave native work inside DSH and would not satisfy that ownership rule.

Killing the broker does not promise to dismiss secure-desktop consent or stop an already elevated helper. It can lose confirmation of helper exit; accept that cost and leave the revoked candidate unpublished behind its plan gate. A late helper cannot start mutation without the lease, and a running helper drains at its next cancellation check. Publication still requires confirmed helper success. GC skips a busy candidate, and purge must finish its removal.

Controller death can leave an independent helper with either hosting choice, so moving back to a Worker would not remove orphan recovery. Revisit the broker only if we deliberately accept waiting for consent during disposal or obtain a verified cancellable native launch API. Do not infer elevated termination authority from owning the broker; [Windows process access rights](https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights) remain separate.

### Keep the plan as input and an active-helper gate

The controller writes and closes plan.json before starting the broker. The helper opens it with GENERIC_READ, sharing = 0, OPEN_EXISTING and no reparse following, reads bounded input through that same handle and holds it through inventory and mutation. It independently admits the plan's paths, identities, empty base and setup lease. It never creates or replaces the plan. The [Windows sharing contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) makes that exclusive handle incompatible with deletion.

After confirmed helper exit, close the setup lease and unlink the plan normally. During collection, first hold the cache writer lock and generation DELETE claim, then unlink the plan before any payload. If a helper owns it, unlink fails and collection stops for that candidate. If unlink wins, a delayed helper cannot open the input. A missing plan is harmless; access errors are not absence. A known reparse object is removed as an object, without reading its target as a plan.

Remove deleteExclusivePlan, its custom DELETE/read-attributes open, FileDispositionInfo call and selected sharing flags. The setup lease already revokes cancellation and late mutation. Ordinary unlink supplies the remaining exclusion needed for collection, so a second admission-retirement transition adds no useful guarantee.

Ordinary Windows deletion can still be deferred by open handles; switching APIs does not abolish that filesystem behavior. Treat successful unlink and errors through the usual cleanup contract, without modeling DELETE_PENDING in publication or warm admission. A failed unlink prevents publication or payload traversal; GC can defer it, and purge cannot succeed until directories are removed. Do not infer success from access denied. See [Windows deletion behavior](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew).

Retain focused checks for helper/unlink exclusion, late admission after lease closure, blocked cleanup and strict purge completion. Drop the seven-check custom-deleter matrix and the requirement to publish/warm-admit under a deliberately held delete-pending plan. Those older probe results remain evidence about Windows primitives, not requirements to preserve the discarded protocol.

### Finish setup before publishing

Under the cache writer lock, finish linking, confirm helper/broker success and joins when elevation was used, capture final anchor pairs and admit boundaries. Close the setup lease with checked handling, unlink its plan normally and clean up temporaries. The successful probe was already removed before linking. Acquire the pin and atomically publish the complete current.json record only after those operations succeed.

A real close or unlink failure leaves the candidate unpublished. There is no custom retirement result, control-cleanup receipt, physical-absence polling or committed-control repair phase. Warm admission relies on the committed record and generation checks, without inspecting setup filenames. This keeps ordinary file cleanup separate from cache eligibility.

The ordering covers normal execution and process interruption, not every power-loss durability case. Missing or invalid current metadata still causes a fresh build.

### Collect every unused generation through the same path

Normal GC holds the writer lock and preserves current. For each unused ordinary generation, claim directory DELETE access, unlink any plan before payload traversal, remove contents with the non-following unlinker, remove the directory and close the claim. A busy plan or pin defers collection. Malformed plan JSON does not prevent owned cleanup, and a known link at its name is removed only as an object.

Payload order is uniform. Remove the Bash-first operation, special failure-halt branch and associated fault-injection requirements. Pin/collector exclusion plus the selector recheck already prevents partial-tree admission. Root ownership, reparse safety and ordinary deletion errors still apply to every entry.

A missing plan requires no recovery state. The candidate may have used local setup or completed control cleanup. The writer lock excludes controller mutation, and a helper requires the existing plan and live setup lease before writing. No root owner registry, candidate classification or per-generation inventory is needed.

Complete purge first acquires and retains DELETE claims on all ordinary generations. Any live pin blocks preflight before payload deletion. Unlink all plans, then unpublish current before removing any payload. A busy plan blocks purge; successful earlier control cleanup needs no rollback. Keep root ownership until data removal succeeds so interrupted cleanup can resume. Never reuse or republish generation IDs.

Missing current metadata causes a fresh build instead of a search for promotable candidates. Existing pins retain their admitted record and native hold when another generation becomes current.

## Shutdown and uninstallation

The updated AGENTS.md makes normal disposal strict about active resources and best effort about ephemeral files inside the private persistent cache. Stop and join owned confined Jobs and local broker work, drain controller writes, and close instance-owned native handles and locks, including any setup-only lease. Attempt agentless/session-view cleanup, but do not retain failed view-removal tasks or fail disposal over transient private residue.

If secure-desktop consent or an independently elevated helper remains unconfirmed after bounded local shutdown, leave its revoked unpublished candidate for guarded recovery. A surviving helper may still hold its own plan handle; that is distinct from leaking a handle in the disposed DSH instance. Later GC skips a busy candidate, and purge reports failure while its guards or removals remain blocked. A pending late helper cannot mutate after its setup lease is revoked. No successful publication is inferred from shutdown cancellation.

Complete uninstall remains strict: remove the optional plugin-only gitBashPath override while preserving shared Shell settings, close the relevant DSH instances, purge both profile and package fallback caches, then remove the package. Purge verifies root ownership, excludes preparation with the writer lock, preclaims every generation against live pins, unlinks helper plans and removes every interior entry without following reparse targets. Unknown names inside that admitted root are not personal storage to preserve.

After all generation claims and plan unlinks succeed, unpublish current before payload removal. Keep the root ownership marker while data cleanup is incomplete. Once contents are gone, remove that marker last among ordinary files, close the held delete-on-close writer lock and remove the root itself. Any blocked removal, failed native close or remaining directory makes purge fail explicitly. Do not replace this with a catch-all recursive delete or broaden markerless-root admission.

Source contents, attributes and ACLs remain unchanged, and removing all cache hardlinks restores their link counts. Approved NTFS bookkeeping effects remain the documented exception. Normal disposal intentionally retains the cache; it does not claim uninstall-level restoration. Without root owner files, an idle executor holding no pin/preparation is not detected by purge and could recreate the cache later. Closing all relevant DSH instances remains the uninstall procedure; no process census is added.

DSH's native package removal has no cache-purge hook and preserves configuration. Keep the repository wrapper and packaged cleanup entry so removal includes both caches and plugin-only settings. Temporary private residue is allowed at normal shutdown; incomplete purge is never complete uninstallation.

## How the plan changed

This table tracks the starting points and proposals that led to the final design. Some were intermediate choices; others were considered and dropped.

| Topic | Earlier approach or proposal | Final choice and reason |
| --- | --- | --- |
| Implementation approach | Refactor the existing tree in place | Start with a clean active tree once the design is settled, and selectively reuse verified archived behavior |
| Legacy tests | Preserve test logic and port PoC support, then rely on prose/probes alone | Archive the old harness and create focused maintained tests for the new contracts using isolated fixtures |
| Module layout | Broad platform/service splits, then 13 files with Git work folded into cache | Use 14 files: a shared Git-files module serves cache and helper; keep debugger hooks with their owning loop |
| Runtime layout | Three physical trees, then a shared base with mode and session junctions | Use one base with direct scoped views; the mode junctions had no remaining role |
| Startup | Background inspection and provisioning after checking a fallback workspace | Prepare on the first command or an explicit rebuild; activation starts no work |
| Coordination API | A separate coordinator and generic refresh hook, then no manual hook until a caller existed | Keep the private slot and implement a narrow rebuild hook for the now-planned UI button; defer UI wiring |
| Cache API | Separate open/prepare/lease calls and command-time layout probes | Return a self-contained pin/use with admitted paths/layout; construct environment strings without rediscovery |
| Workspace admission | Require workspaceRoot during preparation and manual rebuilding | Preparation checks source/cache; each command's lease checks its workspace before DSH confinement; rebuildRuntime takes no arguments |
| Restart verification | Walk both source and cache, then only the cache, after every restart | Check metadata and fixed anchors; accept undetected non-anchor damage and provide explicit rebuilding |
| Warm pin acquisition | Lock-first, retries and an additional Bash-first collection rule | One lock-free read/pin/selected-ID recheck; native exclusion and selector ordering suffice even when interrupted deletion leaves every anchor intact |
| User-facing recovery | Treat closing DSH and running the cleanup CLI as the long-term workflow | Plan an online UI rebuild button using the existing generation pipeline; retain the CLI as an interim route and offline fallback |
| Rebuild lifetime | Invalidate working readiness, or always run independently and accept duplicate cold work | Preserve only established ready pins; otherwise cancel unfinished setup and install the rebuild as shared readiness before awaiting settlement |
| Rebuild adoption guards | Preparation revisions, then a configuration epoch driven by Loader events | Check current selection, slot/operation identity, cancellation and stopping at work boundaries; idle A -> B -> A need not discard valid A work |
| Rebuild lock scope | Let established-pin leases wait on the cache writer lock held during setup | Derive uses/views through a pin's local references; keep the writer lock for allocation, setup, commit and collection |
| Pin lifetime | Candidate/provider/execution disk holds and root owner files | One directory handle plus local refs per pin; writer lock for preparation; a setup-only lease exists only for UAC cancellation |
| Repeated rebuild requests | Coalesce concurrent rebuild calls in the backend | Disable the future UI button while pending and reject an overlapping backend call as busy; no queue or coalescing |
| Selection changes | Force a source inventory through a private recheckSource flag, even for aliases | Resolve the new selection and apply normal eligibility; settings are not a hidden rebuild command |
| Inventory implementation | Prioritize native batch enumeration after the benchmark | Use Node traversal for cold, invalidated or explicitly rebuilt runtimes and remove recurring scans instead |
| Persisted inventory | Keep every source-file record after setup or serialize names for UAC | Store only source/layout/anchor admission data in current.json; each linking process inventories in memory and the plan contains no file list |
| Mandatory anchors | Require 16 paths including versioned OpenSSL DLLs and helpers, or sample candidates dynamically | Require six core paths; stable names and a closed schema take precedence over the extra non-core coverage |
| Per-command anchors | Repeated cache stats, then saved entry stamps passed into debugger events | Cache anchors at pin establishment only; debugger owns local module identity/path checks without cache FileStamp coupling |
| Scoped view cleanup | Per-command shared-view removal, then retain every view for pin lifetime | Retain shared session views, remove unique agentless views on release, and sweep leftovers at retirement |
| Scoped view creation | Coordinate through EEXIST, then retain rejected promises and pending-work references | Memoize creation, clean up and evict failures for retry, and use the lease's single reference through admission/creation/cancellation; validate each child launch |
| Finalization failure | Keep a native pin, then retain a view-cleanup retry obligation | Best-effort private view removal with no retained task; checked native close remains mandatory under the revised AGENTS.md |
| JSON validation | Add recursive rejection of unknown keys | Validate and consume known fields; keep strict ownership checks for filesystem objects |
| JSON hardlink count | Require nlink === 1, then add alias-backup preservation checks | Ordinary bounded metadata reads and atomic replacement; no link-count rule or backup-alias feature/tests |
| Atomic metadata writing | Custom temp ownership, then reserved temp-name patterns | Reuse the public DSH utility after root/parent admission; the whole interior is plugin-owned and needs no temp regex |
| Deletion authority | Per-leaf records, per-generation registry, then restricted interior namespaces | Verify root ownership once at admission; all interior names are disposable, subject to structural and live-work checks |
| Generation placement | Build in a per-attempt staging payload, move it and rewrite final-target junctions | Build directly in a fresh generation directory and publish only through current.json |
| Directory registration | Two-write reservation, then one registration write and an empty-shell exception | Remove the child registry and exception; empty and nonempty unused namespace generations use the same cleanup |
| Container identity | Persist the generations directory's file ID in the root marker | Bind ownership to the root and validate the reserved container dynamically; allow an ordinary empty container to be recreated |
| Unelevated setup | Write the helper protocol and acquire its gate for the in-process pass too | Link from memory under the writer lock; create the plan/gate file only when elevation is required |
| Permission detection | Inventory first and probe at base/usr/bin/bash.exe | Probe at a private sibling before inventory/base population; one extra link/unlink removes the common scan and reset cost |
| Later permission failure | Wipe/recreate a partial base and retry through UAC with a new inventory | Drain and reject setup after a successful probe; leave the unpublished candidate for GC and use no second privileged pass |
| Newly created target checks | All-file stamp checks, then different elevated/unelevated rules | Use one fresh-link contract with structural admission and no-overwrite; keep six final anchor observations |
| Anchor capture | Pre-link baselines, then cross-handle size/mtime agreement and setup timing fault tests | Check pair identity/kind/boundaries and save the base stamp once; retain full saved-stamp comparisons only for warm admission |
| Final setup verification | Repeat a full source/base walk after the linker finishes | Complete the applicable linker contract, join setup and check anchors/boundaries; accept that non-anchor changes may escape detection |
| Provisioning completion | Split result/join, then a flat outcome plus broker JSON and helper result | One awaited UAC operation succeeds on the strict broker zero-exit contract; errors use guarded cleanup, with no result/stdout protocol or outcome union |
| Modal worker lifetime | Repair the Worker wait loop, or stop a separate broker on cancellation | F4 uses public wait/close helpers either way; retain the small DSH-owned broker so disposal need not wait for blocked consent, accepting unconfirmed helper recovery |
| Orphan handling | Permanent freeze, then provider owner/cancel/result controls | Writer lock for local setup, exclusive plan gate for helper mutation, and one UAC-only lease for cancellation/death; no warm owner registry |
| Helper gate file | Separate .helper-lease, then custom plan retirement | The plan is input and a share-none active-helper gate; ordinary unlink before payload collection provides exclusion |
| Plan cancellation and retirement | Delete on cancellation, custom sharing/disposition rules and DELETE_PENDING admission tests | Cancel solely through the setup lease; unlink the plan after supervision or under guarded GC; remove the extra state machine and test matrix |
| Publication and controls | Physical-absence checks, then a custom pending-file tolerance protocol | Confirm success, close the lease and perform ordinary cleanup before publishing; no control-file inspection on warm admission; strict purge requires directory removal |
| Missing-pointer recovery | Fully validate and promote an unselected inventory to avoid relinking | Missing or invalid current metadata causes a fresh build; no per-generation metadata search remains |
| Generation collection | Directory classifications, root owners and Bash-first deletion | Claim generations, unlink plans, unpublish for purge, then unlink payload uniformly; selector recheck already rejects partially collected generations |
| Shutdown cleanup boundary | Every leftover private view blocked normal disposal | Normal disposal releases active resources and attempts private-file cleanup; uninstall purge requires complete removal and restored source link counts |
| Commit binding | Bind inventory and pointer with IDs and briefly a digest | Eliminate the second record and publish all admission fields in one atomic replacement |

## Implementation order

Bootstrap maintained inputs and tests, then separate Git file work from cache lifetime. Establish root admission, pin/collector exclusion, read-only warm admission, purge preflight and single-record publication. Add native sharing tests with those modules.

Implement the sibling probe as the only elevation choice and share one fresh-tree linker. Later link failure drains work and leaves an unpublished candidate for GC. Keep inventory local to each pass, check final anchor identities and record base stamps, and cancel UAC through the setup-only lease. Retain warm-stamp validation without capture-time drift or replacement fault matrices. Use the public wait/close helpers and strict broker success contract. Test ordinary plan-unlink exclusion, late helper refusal after cancellation, blocked cleanup and strict purge completion. For interrupted collection, leave all anchors intact and verify selector rejection; no Bash-first ordering is needed.

Phase 4 preserves ready pins on rebuild failure and replaces unfinished initialization with shared rebuild readiness. Cover cancellation settlement, new/displaced waiters sharing that readiness, stale-result release, current-selection/object-identity guards, the busy guard and disposal. Remove the Loader notification test and competing cold-completion matrix. Assign workspace admission and session-view promises to lease, pure environment construction to admitted values and child view/path/module admission to process-family. Cover view waiters, cancellation, reference unwind, failure eviction/retry and redirected views. Real DSH smoke, manual UAC, package and complete-purge checks follow.

## Revisiting decisions

Deferred ideas should return only when their original reason for rejection changes. A measured cold-setup bottleneck could justify revisiting native enumeration. The planned UI rebuild button is an example of a new requirement that justified restoring a narrow operation without restoring the discarded coordinator service.

When such a requirement appears, update the decision and its rationale here. The presence of an older prototype or an earlier recommendation is not itself a reason to restore it.

## Planning references

The approved specification and review baseline are versioned in `docs/`:

- [Current implementation roadmap](backend-20261117-refactor-roadmap.md)
- [Phase 0 contract baseline and review checklist](backend-20261117-contract-baseline.md)

Historical planning and probe results remain in the local, Git-ignored `tmp/` directory:

- [Backend architecture audit](../tmp/backend-architecture-audit-2026-11-15.md)
- [Single-base isolation verification](../tmp/single-base-isolation-verification-2026-11-15.txt)
- [Native enumeration and hardlink measurements](../tmp/ntfs-strategy-verification-2026-11-15.txt)
- [Guard sharing and delayed-helper probe results](../tmp/orphan-guard-evidence-2026-11-15.json)
- [Pin directory-handle sharing probe](../tmp/pin-directory-hold-evidence-2026-11-16.json)
- [Two-process optimistic warm-admission probe](../tmp/optimistic-warm-pin-evidence-2026-11-16.json)
- [Plan gate and source-replacement probe](../tmp/plan-gate-review-evidence-2026-11-16.json)
- [Interrupted admission and immediate retirement probe](../tmp/admission-retirement-review-evidence-2026-11-16.json)
- [Native worker-thread versus child-process cancellation probe](../tmp/uac-hosting-review-evidence-2026-11-16.json)
- [Setup-only lease and ownerless purge probe](../tmp/setup-lease-purge-review-evidence-2026-11-16.json)
- [Read/delete-sharing plan retirement probe](../tmp/plan-retirement-sharing-evidence-2026-11-16.json)

The enumeration note records an earlier recommendation to prioritize native scanning and keep mode views. Those recommendations were superseded by the Node traversal and direct-view decisions above; the measurements remain useful.

The guard-sharing report describes an earlier two-file design. The current plan uses the plan file itself as the gate, only for elevation. The directory-handle, optimistic-admission and plan-gate probes verify native sharing and selected interleavings; their fixtures were removed. The full root-admission, linker, debugger, refCount, UAC and crash lifecycles still need maintained tests and implementation review.

The plan-retirement-sharing report tested the now-discarded custom deleter. Its seven checks and delete-pending publication scenario are not implementation requirements. The hosting report used native Sleep, not UAC; retain it as evidence of the process/thread cancellation distinction without treating its timings as a shutdown guarantee.

[AGENTS.md](../AGENTS.md) contains the repository constraints. The [archived README](../.deprecated/README.md) describes the original implementation.
