# Windows verification records

The backend and installed-profile runs used native Windows 11 x64 build 26200, Node 26.12.1, pnpm 12.18.0, DSH 0.2.2-rc.2 and Git for Windows 2.56.0.windows.4.

## Runtime and cache

| Observation | Result |
| --- | --- |
| One Git installation, three policy modes | One base held 8,181 hardlinks. The previous layout required 24,543. Two concurrent sessions per mode produced six distinct MSYS namespaces. Repeating a command reused its session's namespace. |
| Namespace control | Disabling the installation-root adjustment made the session views share one namespace. Names alone do not determine access rights. In a live workspace-write test, a peer session could read the MSYS mapping and Windows denied its request to open the mapping for writing. |
| Cold inventory comparison | For 8,181 files in 761 directories, the warm median for a Node traversal was 873 ms. A native batch enumeration took 102 ms. A hardlink alias still reported 7 bytes in its directory entry after a write grew the file to 37 bytes. Opening the file returned the current size. |
| Warm admission on 17 November | The copied installation took 36.87, 25.49, 33.98, 23.31 and 28.01 ms. The small fixture took 12.87 ms. The operation opened a pin and checked six saved anchor files. |

## Native release and UAC, 17 November

The profile-cache version at `ca22535` passed type checking, lint, a clean build and 139 tests with zero skips. The test runner took 69.63 seconds. Bash, Git, pipelines and nested shells ran under all three policies. The fixtures exercised overlapping commands, cancellation and disposal. Teardown purged the cache and compared the copied source files' hashes, link counts and access control lists (ACLs).

| Manual consent case | Elapsed | Observation |
| --- | ---: | --- |
| Approved | 2.56 s | The operator selected Yes and setup completed. |
| Denied | 5.52 s | Windows returned cancellation code 1223. The attempt published no generation. |
| Approved after cancellation | 30.48 s | The controller cancelled at ten seconds. The prompt remained visible and the operator approved after twenty seconds. The attempt published no generation and strict purge restored the fixture. The controller could not observe whether a helper subsequently started. |

## Installed profiles, 18 November

The checkout-install release run recorded at `0163355` passed 166 tests with zero failures or skips. The official package operation installed the checkout into a temporary profile. The tests checked installed runtime files, locale exports, the executor's DSH superclass and the shared Shell schema. Comparing 8,944 file and directory ACL records identified a language-dependent summary line in `icacls` output. The comparison now checks the command's exit status and the ACL records themselves.

| Exercise | Observation |
| --- | --- |
| Web settings | Opening the plugin, editing an unsaved path and changing language created no cache. Saving a valid path issued one rebuild request and produced a Bash hardlink with the same NTFS identity as the source. The path and generation survived a host restart. |
| Shared Shell settings | With a 128-byte output limit, Bash returned its version in the retained tail and DSH supplied the full-output file. A six-second sleep went into the background at the configured 1,800 ms deadline. |
| Headless and platform controls | The installed Windows headless profile reported Bash `5.3.15(2)-release`. The stock headless profile reported PowerShell major version 7. Under Arch Linux on WSL2, DSH skipped the Windows bundle and produced a byte-identical configuration dump. |
| Recovery and removal | Offline purge preserved the installed package and settings and restored the source link counts. The next headless command built a fresh generation. Complete removal preserved the shared timeout and output limit. |
| Redirected rebuild | After the redirect fix at `fb3059c`, a 307 from the rebuild endpoint produced an error. The redirect target received zero requests. Retrying the original request published a generation. |
| Browser feedback | The installed page kept the saved path after a linking failure, showed a native error dialog, and showed a toast after successful linking. A stale draft in a second tab produced a conflict dialog and no rebuild request. |

## Version 0.1.0 cleanup, 19 November

On Windows x64 build 26200, the release check passed type checking, lint, a clean build and 172 tests with zero failures or skips (97.12 seconds for the test runner). The installation test checked the package contents with the optional detail document absent. The separate installed-browser test passed in 61.18 seconds, including settings, native error dialogs and the success toast.
