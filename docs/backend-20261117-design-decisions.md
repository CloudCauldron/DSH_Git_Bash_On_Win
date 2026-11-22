# Historical backend design decisions

This record describes the November 17 backend, whose hardlink cache and debugger supervisor have since been superseded by the [November 22 design](backend-20261122-design-decisions.md).

Designed on November 15–17, 2026, this backend let a DSH profile run Git Bash on native Windows x64 under DSH's selected execution policy. Later revisions supported DSH 0.2.2-rc.5 with Node `^24.21.0 || >=26` (including Desktop's bundled Node 24.21.0) and either the `ucrt64` or `mingw64` Git for Windows layout.

Four observations shaped the design: stock Git Bash could not start its Unix compatibility runtime (MSYS) in read-only or workspace-write mode; the first working executor scanned the source and three runtime trees on every command; its cleanup risked deleting unrelated files in a directory it mistook for its cache; and its elevation worker could mistake a failed wait for helper exit. This backend kept the working DSH integration while redesigning how it started Bash, owned storage, and confirmed completion.

[DSH integration](#integration-with-dsh) · [Process family](#why-bash-uses-a-private-process-family) · [Cache setup](#root-ownership-and-confined-setup) · [Command lifetimes](#command-view-and-rebuild-lifetimes) · [Removal](#collection-shutdown-and-complete-removal)

## Integration with DSH

The plugin extended DSH's sandbox Bash executor. At DSH's deferred confinement callback, it checked the final `bash -c` arguments and substituted its private launcher, aborting execution if the arguments did not match what was expected. DSH remained responsible for approvals, sandbox policy, deadlines, output limits, spill files, background work, and subprocesses, while the adapter waited for DSH's entire managed process group to exit before releasing the command's runtime.

The loader mounted the Bash executor, tool, and presets under DSH's existing entry IDs and canonical module names so the settings editor would save overrides to the right Shell entry. The executor inherited the native Bash schema and added one volatile setting, `gitBashPath`. Because installed DSH profiles disable automatic peer installation, standalone programs explicitly declared the public runtime dependencies they imported.

Responsibilities were split across four layers: the executor managed command and rebuild lifetimes; the runtime cache managed generations, pins, views, and collection (sharing Git discovery, inventory, and linking code with the elevated helper); native filesystem helpers handled file identity, reparse points, and handle sharing; and the process-family layer owned the Windows Job, debug events, and MSYS state for a single launch. Keeping low-level native work isolated let the event loop manage its own state without exposing it to the cache, while the setup broker received a bound DSH subprocess capability.

## Why Bash uses a private process family

MSYS derives the names of its shared objects from its installation path. Giving it a byte-identical private runtime cleared the installed runtime's namespace failure, only for initialization to fail next on the signal pipe; environment changes alone could not start a restricted shell. The plugin therefore applied startup and interprocess communication (IPC) adjustments strictly inside the new process family. Each launch verified its inherited policy and token, the private Job, the view and base paths, and both the loader path and file identity of the loaded MSYS module (since hardlinks can give one file multiple names). If any check failed, the launch stopped.

The installation-root adjustment ran in all three modes. In testing, two concurrent sessions per mode produced six distinct namespaces from one base, whereas removing the adjustment collapsed different view paths onto a single namespace. The two restricted modes also adjusted IPC permissions to match the token DSH assigned, while full access needed only the namespace change. Distinct names gave each session its own MSYS objects, and Windows access controls determined which other sessions could open them.

All compatibility changes used DSH's Windows bindings and touched only the launched processes' in-memory data, call arguments, and child environment. Installed programs and their access control lists (ACLs) stayed untouched, leaving ordinary Git Bash, WSL, and other hosts unaffected.

## One cache per DSH home, one base per generation

DSH supplies both a profile directory and a shared home. The executor kept settings and offline package resolution profile-specific, while profiles in the same home shared `DSH_HOME/.dsh-git-bash-on-win` whenever their Git selections matched. Activation itself performed no filesystem work.

A **generation** was a fresh directory holding the selected Git layout, built from NTFS hardlinks to the source installation on the same NTFS volume in a separate directory tree. Because hardlinks share both contents and security descriptors with the source, any in-place write to a shared file was visible through every link. Consolidating three mode-specific trees into one shared base cut the link count from 24,543 to 8,181 on the measured installation while keeping every required path, including Git aliases pointing to the same file. Once published, a generation's layout stayed fixed.

A **pin** kept a generation alive for an executor, and each command leased a **view**—a directory junction pointing straight to the base—to supply the installation path MSYS saw. The physical base defined the file boundary and the view defined the session's namespace; an extra junction per mode offered neither distinct contents nor extra isolation.

## Root ownership and confined setup

The cache created a new root exclusively or reused an existing root carrying a valid ownership marker bound to the schema, owner, canonical path, volume, and directory identity. Setup rejected any unrecognized pre-existing directory, even an empty one. A delete-on-close writer lock sat alongside the cache under the DSH home to serialize everything from ownership-marker creation through final root removal, and offline purge refused to proceed while that lock was held. The generations container had to be an ordinary directory on the admitted volume.

Everything inside an owned root counted as disposable plugin storage, avoiding a separate file manifest that a crash could leave incomplete. The cleanup walker descended only into ordinary directories, unlinked hardlinks, and removed recognized junctions and symbolic links without following targets. Unknown reparse types or access errors stopped strict removal, and cleanup never altered permissions or attributes to force a deletion.

Building a new generation held the cache writer lock through setup and publication:

1. Allocate a fresh generation ID at its final path and test a single hardlink from the admitted `usr/bin/bash.exe` to a temporary sibling of the future base, then unlink the probe before inventory. A permission denial on this probe was the only automatic trigger for elevation.
2. Create the empty base and enumerate the selected source files in the process performing the linking. Local and elevated linking shared the same implementation, validating relative names and file types, creating parent directories in order, and linking in bounded batches. Each native link took the open source file, the open destination directory, and a single child name, failing if the name already existed.
3. If linking failed after the probe, stop scheduling new work and drain calls already in flight, leaving the unpublished candidate for later collection. Retrying partway through with elevation would have duplicated inventory and given a partial tree a second lifetime.
4. Create the internal `bin` junction, verify the base layout, and open the six source/base anchor pairs. Each pair had to refer to the same ordinary file on the same volume, and setup recorded the identity, size, and last-write time observed through the base handle.
5. Complete helper cleanup if elevation was used, open the new pin, and atomically replace `current.json` through DSH's public atomic writer to publish the generation. If a caller was cancelled during the write, it could release the resulting pin, but it never rolled the selector back.

The selector stored the schema version, generation ID, canonical source root, layout, and six anchor stamps, read with bounded access and Schemastery validation. Keeping the full file list in memory only during linking and committing a single atomic record avoided coordinating a pointer, a serialized inventory, and a commit marker. An interruption before publication could leave an unused candidate behind, and a missing or invalid selector triggered fresh preparation.

## Restart and command costs

| Boundary | Work performed |
| --- | --- |
| Warm start | Read the selector, pin its generation, re-read the selected ID, then verify the layout, junction, and six source/base anchors. No writer lock is needed on a warm hit. |
| Cold or stale cache | Acquire the writer lock, re-check in case another process finished first, then build a new generation if needed. An explicit rebuild always requests a fresh generation. |
| Each command | Resolve the workspace before DSH grants and reject any overlap or containment in either direction with the recorded source or cache, including aliases. Build the child environment from the admitted paths and layout. |
| Child launch | Verify that the scoped view still points to the admitted base—since a cached view name can outlive a change to its junction target—and check the process and module conditions for that family. |

The six anchors were `usr/bin/bash.exe`, `usr/bin/sh.exe`, `usr/bin/msys-2.0.dll`, the selected layout's `bin/git.exe`, `etc/profile`, and `etc/install-options.txt`. Comparing both source and base against the **saved** stamps caught in-place edits that comparing the two live names to each other would miss, while keeping versioned dependencies like OpenSSL out of the layout contract. A missing non-anchor file could go undetected until use; rebuilding restored missing links from the source installation, though damaged shared bytes still required an intact source.

Re-reading the selector after opening the pin mattered even when every anchor matched. A reader could observe generation A, pause while another writer published B and an interrupted collector deleted a non-anchor file from A, and then still open a handle to A's directory. The second selector read caught that race and rejected A; once it passed, the pin protected the generation for the rest of its use, and every publication received a fresh ID.

On 8,181 files, a full source scan took about 873 ms in Node versus 102 ms with native batch enumeration, so the design kept full scans out of warm starts and ordinary commands. Five measured warm starts on a copied installation took 23–37 ms. Cold setup stuck with bounded Node traversal rather than a native directory-entry reader, because directory entries add decoding work and returned stale file sizes (and unchanged directory timestamps) after in-place writes to hardlink aliases; saved stamps therefore came from open file handles.

## Command, view and rebuild lifetimes

`prepareRuntime` returned a pin with `lease` and `release` operations. The owner and active command leases shared one non-inherited directory handle opened without delete sharing. Taking a lease incremented the local reference count before the first `await` and released it again if workspace admission, view creation, or cancellation stopped the command. Retiring a pin blocked new leases while closing the handle only when the last reference dropped, letting running commands finish after a replacement was published.

Each pin owned a private view directory, keying reusable junctions by `(mode, canonical workspace, session)` so concurrent callers shared one creation promise and failed attempts removed their partial entry for retry. Sessionless calls got a unique view that was removed on release, whereas shared views lived until pin retirement; every launch still re-validated its view.

The first command kicked off a single shared preparation that individual callers could stop waiting on without aborting peers. The executor re-checked the selected Git path at start, after awaits, and before adopting a result, watching DSH's volatile setting updates while preparation or a rebuild was pending; slot identity, cancellation, and provider shutdown determined whether the resulting pin remained usable. An alias to the same installation still passed normal warm checks, and a preparation error stayed sticky for subsequent commands until the selection changed or the user triggered a rebuild.

The settings action called `rebuildRuntime()` without needing a workspace. If a ready pin already existed, commands kept using it during the rebuild and fell back to it if the rebuild failed. Without a ready pin, the rebuild displaced any unfinished initialization and immediately became the shared preparation after joining the superseded work. Overlapping rebuilds returned a busy error, preventing duplicate inventories and UAC prompts without interrupting active command leases.

Manual rebuilds reported progress over the existing owner feedback stream. Ordinary linking reported completed file counts after each batch; during elevated linking, the unelevated executor watched relative names appearing in the new base directory and displayed a recently observed path, since Windows can coalesce directory-change notifications. Both paths ran the same validation and publication checks.

## Elevation and cancellation

Because a Windows User Account Control (UAC) prompt can block a native call—and terminating a JavaScript worker can stall waiting on that call—a small unelevated broker ran the call in a DSH-owned process that local shutdown could stop and join. Only the fixed link helper ran elevated, trusting the installed Node executable, the plugin code, and its dependencies across profiles owned by the same Windows user.

Desktop ran inside Electron with `ELECTRON_RUN_AS_NODE=1`, which UAC does not preserve across elevation. Before spawning the broker, the host therefore resolved the standalone Node binary in its installed payload through DSH's `resolvePrimaryRuntime`, letting the broker reuse its own executable for the elevated helper on both Desktop and the native CLI.

When automatic setup needed elevation, it released the writer lock before asking an interactive DSH owner for confirmation, then re-checked the source directory identity, layout, and current cache afterward in case another instance had already finished. Headless runs printed the equivalent command for the installed profile, while an explicit linking action went straight to Windows consent.

Two temporary files carried separate lifetimes. The controller held a non-inherited, delete-on-close setup lease whose identity was embedded in the plan file, so closing the handle revoked the attempt. It passed the plan's SHA-256 digest to the broker and helper as a separate argument. The helper opened the plan exclusively, verified the digest along with the source, cache, generation, empty base, layout, and lease, and kept the plan open while re-checking the lease between bounded batches so a late or interrupted helper stayed bound to its original attempt.

Completion required three confirmations: the helper had to finish and close its plan handle, the broker had to observe the helper's zero exit status and close its process handle, and DSH had to confirm that the broker's process group had settled. Native wait and close calls were checked separately so a failed wait left exit unconfirmed, and the parent closed the lease and removed the plan before publishing. Exit status and bounded error output were all the exchange needed.

Cancellation revoked the lease and joined local work. Although a Windows UAC prompt could outlive the broker, any helper still holding the plan blocked collection, and a late helper could not start linking without a live lease. In the manual delayed-consent check, approving the prompt after local cancellation published no generation and left the fixture clean for strict purge.

## Collection, shutdown and complete removal

Denying delete sharing on a pinned generation directory did not by itself stop deletions inside that directory, so collectors first claimed delete access on the generation directory and held that handle while removing its contents. An existing pin made that claim fail before traversal, and once a collector won the claim, no new pin could open. Under the writer lock, ordinary collection kept the selected generation, claimed each unused generation, and unlinked its helper plan before deleting payload, deferring any busy generation to a later build or purge.

Normal shutdown cancelled in-flight preparation, stopped and joined owned commands and brokers, drained local writes, and closed native handles and locks, treating any unconfirmed exit or close failure as an error. View cleanup inside the private cache was best effort, and the validated base persisted for the next DSH session.

Removing a single profile left the shared cache intact. Complete removal from a DSH home followed four steps:

1. Remove the plugin-only `gitBashPath` override while preserving shared Shell settings such as timeout and output limits.
2. Close every DSH instance sharing the home so an idle executor without a pin cannot rebuild the cache.
3. Purge the home's `.dsh-git-bash-on-win` cache once; a blocked or interrupted purge reported failure.
4. Remove the plugin through DSH's official package command. Invoking the repository's removal wrapper with `--purge-cache` ran the purge before calling DSH.

Purge took the writer lock, verified ownership, claimed delete access on the root and every ordinary generation, and unlinked helper plans and the selector before touching payload so an interruption could never leave a half-deleted generation selected. It removed interior entries without following links, kept the ownership marker in place until payload deletion succeeded, and confirmed that both the root and its sibling writer lock were gone.

Offline recovery ran the packaged purge entry against the absolute shared cache path and rebuilt on the next Bash command after restart, keeping the package and Shell settings intact. Removing all cache links restored the source files' hardlink counts, while NTFS continued to record its own change times, archive bits, and journals.

## Verification behind these choices

Tests at the historical revisions used temporary DSH profiles and owned copies of Git to cover markerless roots, junction targets, pin-versus-collector races in both orders, interrupted collection, cancellation, failed native waits, and rebuilds with commands in flight. Native integration exercised Bash and Git through installed DSH providers in all three modes and verified source contents, link counts, and ACLs after strict purge. Separate operator-assisted checks verified Windows UAC approval, denial with error 1223, and delayed consent. [Feasibility and installed-profile results](analysis_report/historical-process-family/README.md) · [Supervisor timings](analysis_report/historical-supervisor-benchmark/README.md)
