# Publication, upgrades and copy semantics

## A directory pin protects a generation’s lifetime

Two independent DSH hosts ran commands in read-only and full-access sessions, each holding a native directory pin on generation A. They selected B for a third session, then replaced a same-named helper in A’s **source**. Each command called the linked helper and a second, ordinary private copy.

| Observation | Both pinned A sessions, linked / private | New B session, linked / private |
| --- | --- | --- |
| Before selecting B | 0 / 0 | — |
| After selecting B | 0 / 0 | 1 / 1 |
| After replacing the helper at A’s source path | **1 / 0** | 1 / 1 |

The helpers used the unchanged Git `true` and `false` executables. A separate junction and command-script control observed the same split (A2 / A1) in both old sessions. An optional per-command fingerprint detected a change already present at admission. A command could still launch another helper later. The final design owns every flat executable copy and requires all DSH hosts sharing the installation to close throughout Git upgrades, because resource directories still point into Git.

A live pin blocked collection with Win32 32, and a collector’s exclusive claim blocked new readers. Readers could still physically open a retired directory after publication, which explains the pin-then-reread selector check. A second writer waited through a 300 ms observation interval and acquired the lock after release. Terminating the writer on either side of the atomic rename left the old or new complete generation selected. These were process-death tests. Power-loss durability was unmeasured.

## Consent and strict removal

| Control | Observation |
| --- | --- |
| File-symlink creation | The ordinary account got `EPERM`. Denying UAC returned Windows error 1223, no helper exit and zero links. Approving the identical retry returned exit zero and created four links. The eventual ordinary-copy publisher operates unelevated. |
| Attempt identity | Closing a lease revoked the attempt. Reusing its path with a new identity kept the old attempt revoked. This test used an ordinary lease. |
| ACL and mapped-image blockers | A restrictive fixture ACL denied creation and deletion. Undoing only the test entries restored the saved DACL bytes and allowed ordinary cleanup. A running mapped executable refused write-open (`EBUSY`) and replacement (`EPERM`). Both worked after exit. |
| No-follow purge | A markerless root retained its payload and selector. A data handle denying delete sharing blocked removal with Win32 32. The selector was retired, the ownership marker survived and retry removed the root and lock. A metadata-only handle had failed to create this blocker. |
| External targets | Across interrupted and successful purge, all 23 external junction-control records matched. Candidate purge removed file symlinks and an abandoned view without following them. The comparison included contents, identities, link counts, attributes, timestamps, ownership and DACLs. |

Only one NTFS volume was available in this experiment. The packaged backend later passed the [two-volume check](../../copy-backend-verification/evidence/release.md#cross-volume-operation).

## How to copy a read-only executable

Windows Node 26.12.1 with libuv 1.52.1 copied a protected, read-only source into a cache with a different DACL. Both destination files inherited the cache directory’s DACL. Their attributes differed.

| Destination primitive | ReadOnly | Other observations |
| --- | --- | --- |
| `fs.copyFile` | Propagated from source | Destination ACL matched a fresh cache sibling. |
| Fresh exclusive `wx` creation after a held native read | Clear | Independent file ID, writable destination and ordinary unlink. A collision returned `EEXIST` and preserved the existing bytes. The source read hold denied rename and write with `EBUSY`. |
| Experimental handle-relative native writer | Clear | One link, six writes, inherited cache ACL. A collision returned Win32 183. Rollback removed only its newly created entry. Five opens matched five closes. |

A directory hold denied delete access but an empty directory could still change reparse type. A handle-relative experiment refused a redirected parent (Win32 1921), while a path-based create followed it. The release uses pinned source and destination parents and `wx` in a private cache shared by cooperating hosts. Deliberate modification by another process running as the same user lies outside that contract. The actual release also checks read-only source preservation through purge. [Release checks](../../copy-backend-verification/evidence/release.md)

## Other findings from integration review

The prototype accepted a new PE section header beyond `SizeOfHeaders`. The production patcher checks both the declared header extent and available raw space. A missing private child in the prototype could fall back to the installed executable and lose the compatibility module. The shipped redirect reports the private-target failure. Different spellings of the same workspace also produced different derived SIDs, leading the executor to give DSH the canonical workspace before grants.

A scripts-disabled dependency probe with automatic peer installation off first exercised nine direct packages. A narrower probe resolved the five imports needed by standalone code and round-tripped native metadata with external fallback disabled. Host entries retained shared Cordis and Bash identity. Source and emitted modules resolved the bundled DLL to the same file. Full standalone purge and saved-profile execution were verified later with the installed package. [Packed profiles and purge](../../copy-backend-verification/evidence/release.md)

[Design experiment summary](../README.md) · [Reproduction](../REPRODUCING.md)
