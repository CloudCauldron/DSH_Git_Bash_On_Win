# Process-family runtime and installed profiles

The November 17–19 backend and installed-profile runs used native Windows 11 x64 build 26200, Node 26.12.1, pnpm 12.18.0, DSH 0.2.2-rc.2, and Git for Windows 2.56.0.windows.4.

## Runtime and cache

| Observation | Result |
| --- | --- |
| One Git installation, three policy modes | One base held 8,181 hardlinks (down from 24,543 in the previous three-tree layout). Two concurrent sessions per mode produced six distinct MSYS namespaces, and repeating a command reused its session's namespace. |
| Namespace control | Disabling the installation-root adjustment collapsed all session views onto one namespace. In a live workspace-write test, a peer session could still read another session's MSYS mapping while Windows denied write access, confirming that access rights come from Windows security descriptors rather than names alone. |
| Cold inventory comparison | Across 8,181 files in 761 directories, a warm Node traversal took 873 ms at the median versus 102 ms for native batch enumeration. However, a hardlink alias still reported 7 bytes in its directory entry after a write grew the file to 37 bytes, whereas opening the file returned the current size. |
| Warm admission on 17 November | Opening a pin and checking six saved anchor files took 36.87, 25.49, 33.98, 23.31, and 28.01 ms on the copied installation, and 12.87 ms on the small fixture. |

## Native release and UAC, 17 November

The profile-cache revision at `ca22535` passed type checking, lint, a clean build, and 139 tests with zero skips (69.63 seconds runner duration). Bash, Git, pipelines, and nested shells ran under all three policies alongside tests for overlapping commands, cancellation, and disposal, and teardown verified source file hashes, link counts, and ACLs after purge.

| Manual consent case | Elapsed | Observation |
| --- | ---: | --- |
| Approved | 2.56 s | Operator selected Yes and setup completed. |
| Denied | 5.52 s | Windows returned cancellation code 1223 and no generation was published. |
| Approved after cancellation | 30.48 s | The controller cancelled at ten seconds; the operator approved the still-open prompt after twenty seconds. No generation was published and strict purge restored the fixture, though the controller could not observe whether an elevated helper started afterward. |

## Installed profiles, 18 November

At `0163355`, installing the checkout into a temporary profile through DSH's package manager passed 166 tests with zero failures or skips, checking installed runtime files, locale exports, the executor's DSH superclass, and the shared Shell schema. Comparing 8,944 file and directory ACL records exposed a locale-dependent summary line in `icacls` output, so the check was updated to inspect exit status and the ACL records themselves.

| Exercise | Observation |
| --- | --- |
| Web settings | Opening the plugin, editing an unsaved path, and switching language created no cache. Saving a valid path issued one rebuild request and created a Bash hardlink sharing the source's NTFS identity, and both path and generation survived a host restart. |
| Shared Shell settings | Under a 128-byte output limit, Bash returned its version in the retained tail and DSH wrote the full output to a spill file; a six-second sleep moved to the background at the configured 1,800 ms deadline. |
| Headless and platform controls | The installed Windows headless profile reported Bash `5.3.15(2)-release`, the stock profile reported PowerShell major version 7, and DSH on Arch Linux under WSL2 skipped the Windows bundle with a byte-identical configuration dump. |
| Recovery and removal | Offline purge kept the installed package and settings intact, restored source link counts, and let the next headless command build a fresh generation; complete removal kept shared timeout and output-limit settings. |
| Redirected rebuild | After the fix at `fb3059c`, a `307` response from the rebuild endpoint failed without sending a request to the redirect target, and retrying the original request published a generation. |
| Browser feedback | The installed page preserved the saved path after a linking failure, showed a native error dialog on failure and a toast on success, and surfaced a conflict dialog with no rebuild request when saving a stale draft from a second tab. |

## Version 0.1.0 cleanup, 19 November

On Windows x64 build 26200, the release check passed type checking, lint, a clean build, and 172 tests with zero failures or skips (97.12 seconds runner duration), verifying installation contents without the optional detail document. The separate installed-browser test passed in 61.18 seconds, covering settings, native error dialogs, and the success toast.

[Process-family study](../README.md) · [Reproduction](../REPRODUCING.md)
