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

## Refactor Phase 0, 22 November 2026

The starting checkout is `33fa0a9039d193452ccab7eefc222144437f8aaa` on `be_refactor`; `main` still retains that shipping revision. Initial status contained only the untracked [approved design record](../../backend-20261122-design-decisions.md), now retained with this evidence. Phase 0 records the baseline; it does not implement the copy backend or change the existing hardlink/uninstall contract.

A self-contained Git bundle of `main` passed `git bundle verify` with complete history and no prerequisites. Its SHA-256 is `435c53b552a9f73364119bf09c3ad13157a9b205c155f11aa509959307a5cf97`. The retained revision includes the old `scripts/plugin.ts` removal command, `lib/purge-runtime-cache.js`, their runtime modules, package manifest, lockfile and removal instructions. External dependencies still require the recorded package installation. Recover the complete revision when the old uninstaller is needed; do not transplant its entry script into a later backend. No live plugin was uninstalled.

All validation commands used `C:\Program Files\Git\bin\bash.exe --noprofile --norc` and Windows Node, with an unelevated token. Execution fixtures copy installed Git bytes into owned temporary sources before creating links. Profile/browser fixtures use their own DSH homes, package-manager state and browser data. Their guarded teardown purges owned caches and checks source bytes, ACLs and link counts. Live profiles/caches were not used as test destinations. This work did not change installed Git/DSH contents or ACLs, security settings, registry values or global environment. Production source, generated artifacts, dependencies and configuration remain unchanged.

### Preserved locale bytes

These SHA-256 values were captured before the tests and checked again afterward against the raw file bytes:

| File | SHA-256 |
| --- | --- |
| `src/locale/catalogs.ts` | `bbf83e2b7982c42288aa0469c88de5681ebde4722cb21fbad04f132c8830c94b` |
| `src/locale/client.ts` | `43b562b44abcfbc70da4f9ab5135f4f94a36a17c5b66990392e575aba72c3c0d` |
| `src/locale/errors.ts` | `0a463d259fa626fcf0ffeaea8d933169c3de5f2c884d3574bc9fb56508349a98` |
| `src/locale/shared.ts` | `801550e078a2d46c963e0385f267dcd88f1b33dc7ec65d875c25d3aab9c8ad13` |

### Host prerequisites

| Prerequisite | Observation and qualification boundary |
| --- | --- |
| Windows / Node / pnpm | Windows 11 x64, build `26200`; Windows Node `v26.12.1` at `C:\Program Files\nodejs\node.exe`; pnpm `12.18.0`. |
| DSH | Installed CLI `0.2.2-rc.5`, resolved through `scripts/installed-dsh.ts` from its native pnpm global installation. No `DSH_PACKAGE_JSON` override. |
| Real ucrt64 Git | `C:\Program Files\Git`, `2.56.0.windows.4`; package list reports Bash `5.3.015-2` and MSYS runtime `3.6.10-4`. No `DSH_TEST_GIT_BASH` override. The MSYS image is AMD64, 3,373,151 bytes, SHA-256 `2a89b7c31b323c42e2fb37900af087aeb27417694e630a210bc75b0369410bc7`. |
| Real x64 mingw64 Git | **NOT LOCATED / UNVERIFIED.** The installed Git and the Visual Studio Git found by discovery use ucrt64. Synthetic mingw64 fixture results do not qualify a real release. An owned official mingw64 archive remains a Phase 1 prerequisite. |
| Native build tools | `vswhere` found `C:\Program Files\Microsoft Visual Studio\18\Community`. Default MSVC toolset `14.52.37025`, x64 compiler `19.52.37029`, linker `14.52.37029.0`. SDK `10.0.26100.0` headers and x64 `kernel32.lib`/`ntdll.lib` exist under `C:\Program Files (x86)\Windows Kits\10`. These match the planned pins; Phase 0 does not compile or approve a new shim. |
| Chrome | `C:\Program Files\Google\Chrome\Application\chrome.exe`, version `158.0.8127.37`; default browser-test path, no `CHROME_PATH` override. |
| Actual DSH Electron/ASAR Desktop | **NOT LOCATED / UNVERIFIED.** No DSH Desktop executable/ASAR pair, matching registered application or running host was found. Unrelated Electron applications and CLI/profile tests are not Desktop evidence. Actual-host qualification remains blocked until this prerequisite is supplied. |
| Separate local NTFS volumes | Only `C:` is an available lettered local NTFS volume. An unlettered 1.2 GB volume was not used or mounted. Cross-volume copying/launch/purge remains **UNVERIFIED**. |
| Endpoint protection | `Get-MpComputerStatus` returned `AMServiceEnabled=false`, `AntivirusEnabled=false`, `RealTimeProtectionEnabled=false`. Security Center also registers Tencent protection; registration alone does not establish its active scanning behavior. Active-Defender copying and final-image qualification remain **UNVERIFIED**; no settings or exclusions were changed. |
| Developer Mode | The `AppModelUnlock` registry key was absent in the read-only query. No setting was enabled; Phase 2 still owns the ordinary-copy/no-UAC qualification. |

Discovery inspected Program Files, Program Files (x86), per-user Programs, Desktop, Documents, Downloads, source and project directories, and names under the existing DSH home. The application/process checks were read-only. Nine directories under WindowsApps and Google CrashReports denied traversal; no permissions were changed. “Not located” describes this bounded search, not proof that no portable installation exists elsewhere.

### Baseline checks

The following are the shipping revision's existing commands, run sequentially where they rebuild `lib/`. Type checking and linting ran independently. Raw output and the verified backup remain in ignored local evidence; nothing under scratch is a production or package input.

| Command | Result |
| --- | --- |
| `pnpm check` | PASS; exit 0. |
| `pnpm lint` | PASS; exit 0, zero warnings. |
| `pnpm test:windows` | PASS; 187 tests, 0 failures, 0 cancelled, 0 skipped; test-runner duration 158,988.5111 ms. |
| `pnpm test:browser` | PASS; 1 test, 0 failures, 0 cancelled, 0 skipped; test-runner duration 127,753.387 ms. |
| `pnpm test:release` | PASS; prerequisite checks, check, lint, clean build and 187 tests; 0 failures, 0 cancelled, 0 skipped; test-runner duration 81,107.6336 ms. |

The current `test:release` preflights DSH/Git and then runs check, lint and the Windows suite. It does not yet include browser tests, native-shim verification, two-tree reproducibility or final tarball qualification. The browser command above is a separate run. Those future release checks and actual Desktop qualification are not implied by this baseline.

`DSH_GIT_BASH_UAC_TEST` was unset for every run. The optional manual approve/deny/late tests are conditionally unregistered, not counted as skips; browser elevation responses are fixture-controlled. Zero skipped tests therefore does not certify real UAC consent, real mingw64, Electron/ASAR, cross-volume behavior or active-Defender performance. No optional alias/debugger qualification was attempted.

Phase 0 is complete with no existing failures observed in the five required commands. The prerequisite gaps above remain explicit later-phase qualification requirements. Final hash comparison preserved all four locale files and the recorded old-uninstaller files; clean builds left no generated diff. No backend, build workflow, dependency, UI or locale implementation was changed.
