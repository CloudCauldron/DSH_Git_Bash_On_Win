# Publication, upgrades and copy semantics

## A directory pin protects a generation's lifetime

Two independent DSH hosts ran read-only and full-access sessions, each holding a native directory pin on generation A. After publishing generation B for a third session, a same-named helper in A's **source** was replaced while each command ran both the symlinked helper and a private ordinary copy.

| Observation | Both pinned A sessions, linked / private | New B session, linked / private |
| --- | --- | --- |
| Before selecting B | 0 / 0 | — |
| After selecting B | 0 / 0 | 1 / 1 |
| After replacing the helper at A's source path | **1 / 0** | 1 / 1 |

The helpers used Git's unchanged `true` and `false` executables, and a separate junction-and-script control showed the same split (A2 / A1) in both old sessions. Although an optional per-command fingerprint caught changes already present at admission, a running command could still launch another helper later. The final design therefore owns every flat executable copy and requires all DSH hosts sharing an installation to close during Git upgrades, since resource directories remain junction-backed.

A live pin blocked collection with Win32 error 32 and a collector's exclusive claim blocked new readers, while readers could still physically open a retired directory after publication—which is why warm admission pins the directory and then re-reads the selector. A second writer waited through a 300 ms window and acquired the lock once released, and killing the writer on either side of the atomic rename left either the old or new generation intact (simulating process crashes rather than power loss).

## Consent and strict removal

| Control | Observation |
| --- | --- |
| File-symlink creation | Unelevated creation failed with `EPERM`; denying UAC returned Windows error 1223 with no helper exit and zero links, while approving the identical retry exited 0 and created four links. The final ordinary-copy publisher needs no elevation. |
| Attempt identity | Closing an ordinary lease revoked the attempt, and reusing its path with a new identity kept the earlier attempt revoked. |
| ACL and mapped-image blockers | A restrictive fixture ACL blocked creation and deletion until undoing those test entries restored the saved DACL bytes and allowed normal cleanup. A running mapped executable rejected write-open (`EBUSY`) and replacement (`EPERM`) until exit. |
| No-follow purge | A markerless root kept its payload and selector untouched. A data handle denying delete sharing blocked removal with Win32 error 32 (a metadata-only handle did not), retiring the selector while preserving the ownership marker so a retry removed both root and lock. |
| External targets | Across interrupted and successful purges, all 23 external junction-control records—covering contents, identities, link counts, attributes, timestamps, ownership, and DACLs—matched, while candidate purge removed file symlinks and an abandoned view without following targets. |

Only one NTFS volume was available for these experiments; the packaged backend later passed a [two-volume check](../../copy-backend-verification/evidence/release.md#cross-volume-operation).

## How to copy a read-only executable

Windows Node 26.12.1 (libuv 1.52.1) copied a protected, read-only source into a cache directory with a different DACL. Both Node copy paths (and the experimental native writer) inherited the cache directory's DACL, while differing on the `ReadOnly` attribute:

| Destination primitive | ReadOnly | Other observations |
| --- | --- | --- |
| `fs.copyFile` | Propagated from source | Destination ACL matched a fresh cache sibling. |
| Fresh exclusive `wx` creation after a held native read | Clear | Independent file ID, writable destination, and ordinary unlink; a collision returned `EEXIST` without touching existing bytes, and the source read hold rejected rename and write with `EBUSY`. |
| Experimental handle-relative native writer | Clear | One link, six writes, inherited cache ACL; a collision returned Win32 183, rollback removed only the newly created entry, and five opens matched five closes. |

While a directory hold denied delete access, an empty directory could still be converted to a reparse point; an experimental handle-relative writer refused a redirected parent (Win32 1921) whereas a path-based create followed it. Because the private cache assumes cooperating hosts rather than an adversarial process running as the same user, the release uses pinned source and destination parents with `wx` creation and checks read-only source preservation through purge. [Release checks](../../copy-backend-verification/evidence/release.md)

## Other findings from integration review

Integration review caught three prototype gaps fixed in the release: the prototype accepted a new PE section header past `SizeOfHeaders`, whereas production checks both the declared header extent and raw space; a missing private child could fall back to the installed executable and drop the compatibility DLL, whereas the shipped redirect returns the private-target error; and alternate spellings of one workspace produced different derived SIDs, so the executor now passes the canonical workspace to DSH before grants.

A scripts-disabled dependency probe with automatic peer installation off first exercised nine direct packages, and a narrower probe resolved the five imports required by standalone code and round-tripped native metadata without external fallback. Host entries kept shared Cordis and Bash identities, and source and emitted modules resolved the bundled DLL to the same file; full standalone purge and saved-profile runs were verified later on the installed package. [Packed profiles and purge](../../copy-backend-verification/evidence/release.md)

[Design experiment summary](../README.md) · [Reproduction](../REPRODUCING.md)
