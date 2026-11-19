# Backend design decisions

The backend design took shape on 15–17 November 2026. It lets a DSH profile run Git Bash on native Windows x64 under DSH's selected execution policy. The supported host is DSH 0.2.2-rc.2 with Node 26 or newer. An installation can use the `ucrt64` or `mingw64` Git for Windows layout.

Four observations drove the design. Stock Git Bash failed to start its Unix compatibility runtime, MSYS, in read-only and workspace-write modes. The first working executor scanned the source and three runtime trees on every command. Its cleanup could delete existing files in a directory it mistook for its cache, and its elevation worker could mistake a failed wait for helper exit. The backend kept the working DSH integration and changed how it starts Bash, owns storage and confirms completion.

## Integration with DSH

The plugin extends DSH's sandbox Bash executor. It checks the final `bash -c` arguments at DSH's deferred confinement callback and substitutes its private launcher there. If the arguments differ from the expected command, execution stops. DSH still handles approvals, sandbox policy, deadlines, output limits, spill files, background work and subprocesses. The adapter waits for the entire group of processes managed by DSH to exit before releasing the command's runtime.

The loader mounts the Bash executor, tool and presets under the existing DSH entry IDs and canonical module names. The settings editor uses those identities when it saves overrides. Renaming the Shell entry would send updates to a different place. The executor inherits the native Bash schema and adds one volatile setting, `gitBashPath`. Standalone programs declare the public runtime dependencies they import because the installed DSH profile disables automatic peer installation.

The executor owns command and rebuild lifetimes. The runtime cache owns generations, pins, views and collection. Both the cache and the elevated helper use the same Git discovery, inventory and linking functions. Native filesystem code handles file identity, reparse points and handle sharing. The process-family code owns the Windows Job (the group that holds the child processes), debug events and MSYS state for one launch. Keeping the low-level native operations separate lets the event loop manage its own state without exposing it to the cache. The setup broker receives a bound DSH subprocess capability.

## Why Bash uses a private process family

MSYS uses its installation path to name shared objects. A byte-identical private runtime got past the installed runtime's namespace failure, then failed to initialize its signal pipe. Changing the environment alone could not start a restricted shell. The plugin applies the startup and interprocess communication (IPC) adjustments only inside the new process family. Each launch checks its inherited policy and token, the private Job, the view and base paths, and the loaded MSYS module's identity and loader path. A file can have several hardlink names, which makes both path and identity relevant. Failure to establish those conditions stops the launch.

The installation-root adjustment applies in all three modes. In an experiment, two concurrent sessions per mode produced six distinct namespaces from one base. Removing the adjustment made different view paths converge on one namespace. The restricted modes also need IPC access appropriate to the token DSH assigned. Full-access needs only the namespace adjustment. Separate names give each session its own MSYS objects. Windows access controls determine which other sessions can open them.

Compatibility work uses DSH's Windows bindings and applies to the launched processes' data and call arguments. The installed programs and their access control lists (ACLs) stay intact. Environment changes apply to that command's children. Ordinary Git Bash, WSL and other hosts use their normal execution paths.

## One cache per DSH home, one base per generation

DSH supplies both the profile directory and the home. The executor keeps settings and offline package resolution profile-specific. Profiles in that home reuse `DSH_HOME/.dsh-git-bash-on-win` when their Git selections match. Activation does no filesystem preparation.

A **generation** is a fresh directory containing the Git layout selected for a build. Its base holds NTFS hardlinks to the source installation. The source and cache must occupy the same NTFS volume, in separate directory trees. Hardlinks share contents and security descriptors with the source. One base replaced three mode-specific trees, reducing 24,543 links to 8,181 in the measured installation. Every required pathname is retained, including Git aliases that name the same file. Publication fixes the layout. An in-place write to a shared file is visible through all its links.

A **pin** keeps one generation available to an executor. A command leases a **view**, a directory junction that points straight to the base and supplies the installation path MSYS sees. The physical base establishes the file boundary. The view gives the session its namespace. An extra junction per mode provided neither distinct contents nor additional protection.

## Root ownership and confined setup

The cache may create a new root exclusively or reuse a root with a valid ownership marker. The marker binds the schema and owner to the canonical path, volume and directory identity. Setup rejects a pre-existing unrecognized directory, including an empty one. It rechecks ownership after acquiring the writer lock. The generations container must be an ordinary directory on the admitted volume.

Everything inside the recognized root is disposable plugin storage. A list of individual files would add a second ownership record that could become incomplete during a crash. The filesystem walker descends only into ordinary directories, unlinks hardlink names, and removes recognized junctions and symbolic links as objects. Unknown reparse types and access errors stop strict removal. Cleanup never changes permissions or attributes to make a deletion succeed.

For a new generation the writer holds the cache lock through setup and publication.

1. Allocate a fresh generation ID at its final path. Try one hardlink from the admitted `usr/bin/bash.exe` to a temporary sibling of the future base. Unlink a successful probe before inventory. A permission denial at this specific link is the only automatic route to elevation.
2. Create the empty base and enumerate the selected source files in the process that will link them. The local and elevated paths share the same linker. It validates relative names and file types, creates parents in order, and links in bounded batches without overwriting existing names.
3. If linking fails after the probe, stop scheduling and drain the work already issued. The candidate stays unpublished and can be collected. Retrying partway through with elevation would repeat inventory and give a partially built tree a second lifetime.
4. After linking, create the internal `bin` junction, check the base layout, and open the six source/base anchor pairs. Each pair must identify the same ordinary file on the same volume. Record the identity, size and last-write time observed through the base handle.
5. Finish helper cleanup if elevation was used, open the new pin, and atomically replace `current.json` using DSH's public atomic writer. That replacement publishes the generation. A caller cancelled during the write may release the resulting pin. It never rolls the selector back.

The selector contains the schema version, generation ID, canonical source root, layout and six anchor stamps. Readers use bounded access and Schemastery validation. Each process keeps its full file list in memory only while linking. One atomic record avoids coordinating a pointer, a serialized inventory and a separate commit record. An interruption before publication can leave an unused candidate. Missing or invalid selector data causes fresh preparation.

## Restart and command costs

| Boundary | Work performed |
| --- | --- |
| Warm start | Read the selector, pin its generation, read the selected ID again, then check the layout, junction and six source/base anchors. A successful read needs no writer lock. |
| Cold or stale cache | Acquire the writer lock, check again in case another process finished, then prepare a generation if needed. An explicit rebuild requests a fresh generation. |
| Each command | Resolve the actual workspace and reject overlap with the recorded source or cache, including aliases and containment in either direction. This precedes DSH's workspace grants. Build the child environment from the admitted paths and layout. |
| Child launch | Check that the scoped view still points to the admitted base. Verify the process and module conditions for that family. A cached view name can outlive a change to its junction target. |

The anchors are `usr/bin/bash.exe`, `usr/bin/sh.exe`, `usr/bin/msys-2.0.dll`, the selected layout's `bin/git.exe`, `etc/profile` and `etc/install-options.txt`. Comparing source and base to the **saved** stamps detects a shared in-place change that comparing the two live names would miss. This sample keeps versioned dependencies such as OpenSSL out of the layout contract. A missing non-anchor can go undetected until use. Rebuilding restores missing links from the selected installation. Damaged shared bytes need a sound source.

The second selector read matters even when every anchor matches. A reader can see generation A, pause while another writer publishes B, then reach A after an interrupted collector has deleted one of its non-anchor files. A new directory handle alone would succeed. The second read rejects A. Once that check succeeds the pin protects the generation for the rest of its use. Each publication has a fresh ID.

A source pass measured about 873 ms using Node against 102 ms for native batch enumeration on 8,181 files. The design removes that pass from warm starts and ordinary commands. Five measured warm starts on a copied installation took 23–37 ms. Cold setup uses bounded Node traversal. A native directory-entry reader would add decoding work and could return stale size data for hardlink aliases. Directory timestamps also failed to change in the alias-write experiment. The saved stamp therefore comes from an open file.

## Command, view and rebuild lifetimes

`prepareRuntime` returns a pin with `lease` and `release` operations. Its owner and command leases share one non-inherited directory handle opened without delete sharing. A lease increments its local reference count before the first await. It releases the reference if workspace admission, view creation or cancellation prevents use. Retirement closes the pin to new leases. The last reference closes the handle, so a running command can finish after a replacement is ready.

Each pin has a private view directory. A tuple of mode, canonical workspace and session identifies a reusable junction. Concurrent callers share its creation promise. Failure removes the failed entry so a later command can retry. A call without a session gets a unique view and attempts to remove it on release. Shared views last until pin retirement. Every launch still validates its own view.

The first command starts one preparation shared by callers. A command can abandon its wait independently. The executor checks the selected Git path when work starts, after waits and before adopting a result. It also observes DSH's volatile setting updates while preparation or a rebuild is pending. Slot identity, cancellation and provider shutdown determine whether the resulting pin can still be used. An alias for the same installation can pass normal warm checks. A preparation failure stays visible to later commands until the selection changes or the user requests a rebuild.

The settings action calls `rebuildRuntime()`, which needs no workspace. If a ready pin exists, commands can keep using it while its replacement is built. A failed rebuild leaves that pin available. With no ready pin, rebuilding displaces unfinished initialization and becomes the shared preparation immediately. The executor joins superseded work before starting fresh setup. An overlapping rebuild gets a busy error. This avoids duplicate inventories and consent requests while preserving existing command leases.

Manual rebuilds send progress over the existing owner feedback stream. The ordinary linker reports completed file counts after each batch. During elevated linking, the unelevated executor watches relative names in the attempt's new base directory. Windows can coalesce those notifications, so the caption shows a recently observed path. Validation and publication use the same checks in both cases.

## Elevation and cancellation

The Windows User Account Control (UAC) consent dialog can block a native call. Terminating a JavaScript worker may still wait for that call. A small unelevated broker runs it in a DSH-owned process so local shutdown can stop and join the broker. Only the fixed link helper receives elevation.

When automatic setup needs elevation, it releases the writer lock before requesting confirmation from an interactive DSH owner. On confirmation it rechecks the source directory identity, layout and current cache. Another instance may already have finished. A headless user gets a command for the installed profile. An explicit linking action supplies the user's request to proceed to Windows consent.

Two temporary files have different lifetimes. The controller owns a non-inherited, delete-on-close setup lease. Its identity is bound into the plan and closing it revokes the attempt. The helper opens the existing plan exclusively, checks the source, cache, generation, empty base, layout and lease, then keeps the plan handle through inventory and linking. It rechecks the lease between bounded batches. This keeps a late or interrupted helper tied to the original attempt.

Success requires the helper to finish and close its plan handle, the broker to observe the helper's zero exit status and close its process handle, and DSH to confirm the broker's process group has settled. The native wait and close operations have separate error checks. A failed wait leaves exit unconfirmed. The parent closes the lease and removes the plan before publishing. Exit status and bounded error output are sufficient for this exchange.

Cancellation revokes the lease and joins local work. A Windows prompt can outlive the broker. Any independent helper still holding the plan prevents collection, and a late helper needs the live lease before it can start linking. In the manual delayed-consent check, the operator approved after local cancellation. That attempt published no generation and the fixture passed strict purge.

## Collection, shutdown and complete removal

A generation pin denies delete sharing on its directory. That alone does not protect child files. A collector must first acquire delete access to the generation itself and hold that handle while removing its contents. If a pin already exists the claim fails before traversal. If the collector wins, a new pin cannot open. Under the writer lock, ordinary collection preserves the selected generation, claims each unused generation, and unlinks its helper plan before touching the payload. A busy generation can wait for a later build or purge.

Normal shutdown cancels preparation, stops and joins owned commands and brokers, drains local writes, and closes native handles and locks. Failure to confirm exit or close a handle is an error. View cleanup is best effort inside the private cache. The validated base persists for the next DSH session.

Profile removal leaves the shared cache available. Complete removal from the home follows this order.

1. Remove the plugin-only `gitBashPath` override and preserve shared Shell values such as the timeout and output limit.
2. Close every DSH instance sharing the home. An idle executor without a pin could otherwise prepare the cache again.
3. Purge the home's `.dsh-git-bash-on-win` cache once. A blocked or interrupted purge reports failure.
4. After the purge succeeds, remove the plugin using DSH's official package operation. The repository's removal wrapper performs the purge before it calls DSH when invoked with `--purge-cache`.

Purge validates ownership, takes the writer lock, and claims delete access to the root and every ordinary generation. It unlinks helper plans and removes the selector before deleting payload, so an interruption cannot leave a partially deleted generation selected. It removes interior entries without following link targets, keeps the ownership marker until payload cleanup succeeds, and checks handle closure and removal of the root itself.

Offline recovery uses the packaged purge entry with the absolute shared cache path, followed by a Bash call after restart. It retains the package and Shell settings. Removing all cache names restores the source files' hardlink counts. NTFS records link creation and removal in change times, archive bits and journals. The plugin leaves those records to the filesystem.

## Verification behind these choices

The maintained tests use temporary DSH profiles and owned copies of Git. They cover markerless roots, junction targets, pin and collector exclusion in both orders, interrupted collection, cancellation, failed native waits, and rebuilds with commands in flight. Native integration runs Bash and Git through the installed DSH providers in all three modes. Teardown compares source contents, link counts and ACLs after strict purge. Separate operator-assisted checks exercised Windows approval, denial with error 1223, and delayed consent.
