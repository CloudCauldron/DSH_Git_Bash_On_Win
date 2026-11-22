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

## Refactor Phase 1, 22 November 2026

Phase 1 adds the canonical zero-CRT shim, bounded PE reader/fixed patcher, native build manifest/script and maintained qualification tests. The shipping executor, debugger, cache publisher, settings UI and dependency graph remain unchanged until their scheduled cutover. No backend selector, provisioning flag, launcher, supervisor or runtime import from scratch was added. The four `src/locale/` files retain the Phase 0 hashes.

Before changing native admission, the independent probe ran through DSH rc.5's actual full-access, read-only and workspace-write process paths. `TokenLogonSid` returned one entry, 44 bytes, attributes `0xc0000007`, SID offset 24 and SID length 20 in every mode; its SID and attributes matched the `TokenGroups` oracle. Both restricted tokens had integrity RID 4096 and retained the logon SID in their restricting list; full-access had RID 8192 and no restricting SIDs. Production uses a bounded, aligned 96-byte buffer, requires the `0xc0000000` logon-ID mask and checks count/returned length/SID bounds. It does not require equality to the incidental full attribute word or claim domain-account coverage.

At the original Phase 1 commit `0f245e9`, the approved DLL was **23,040 bytes**, SHA-256 **`d492dca0460a91c75569dd78684309a7e2b6d45d51f5479f448901c14bf1e277`**. Two isolated input trees produced identical bytes before the hash was recorded in [the build manifest](../../../native/build.json). Tools matched the Phase 0 pins: MSVC toolset `14.52.37025`, compiler `19.52.37029`, linker `14.52.37029.0`, SDK `10.0.26100.0`. Independent dumpbin output agreed on imports, the sole anchor export and mitigations. The manifest permits reviewed named-function membership; unused allowed names pass, while unknown, ordinal, loader, thread and heap imports fail verification.

| Real Git input | Observed source runtime |
| --- | --- |
| Installed ucrt64 `2.56.0.windows.4`, copied into owned fixtures | Bash package `5.3.015-2`, MSYS `3.6.10-4`; MSYS DLL 3,373,151 bytes, SHA-256 `2a89b7c31b323c42e2fb37900af087aeb27417694e630a210bc75b0369410bc7`. |
| Official [mingw64 `2.55.0.windows.1`](https://github.com/git-for-windows/git/releases/tag/v2.55.0.windows.1), extracted into owned scratch and copied into fixtures | `PortableGit-2.55.0-64-bit.7z.exe` matched the release SHA-256 `dfa8cad3ce7e685b9bfbbb2125afcf7c68d4f53490426702ffac367dac62e928`. Bash package `5.3.015-1`, MSYS `3.6.9-2`; MSYS DLL 3,368,543 bytes, SHA-256 `2ea49553e4c03055dcf1c4a2bef54668081a07663fba283f4b34cf70f2157191`. |

These are measured versions, not a source-hash admission list. Both layouts passed the same native matrix using the final DLL: three policies, bound and agentless workspace-write, fresh/native/MSYS children, TEMP precedence/TMP fallback/absent environment, pipelines, substitution, dynamically loaded Perl/gawk modules and 100 parent/child base checks per mode and session form. Six simultaneous views had distinct predicted namespaces; an independent process observer found the private MSYS/shim mappings and read-only protection at all five hooked IAT slots. The four-caller section matrix was owner read/write `0/0`, workspace/read-only peers `0/0xc0000022`, and full-access peer `0/0`; peer reads remain allowed.

Negative checks cover wrong token/policy/bound SID, malformed view grammar, malformed logon replies, ambiguous agentless capabilities, tampered/oversized/invalid selected TEMP, foreign and duplicate MSYS mappings, falsified loader names and actual mapped identity, absent/odd/oversized matching loader paths, standalone shim loading, and exact/prefix/owner/deny/insufficient ACEs with owner/group/SACL/control preservation. Hook 5 tests cover source/runtime redirection, native-bin nonmatching, extended and expanded paths, argv0, missing/denied private targets, input/expansion/output bounds, no original launch on rewrite errors, concurrent once initialization, and a terminal root-resolution error that is not retried. A failed IAT-protection restoration rejects admission.

The independent 4 KiB PE32+ fixture passes the real patcher with no production exception. PE tests cover named, ordinal-only, mixed and repeated descriptors; original sections and COFF/string/GNU debug-link data; initialized-data delta/overflow; Windows ImageHlp checksum agreement; header capacity at the exact boundary; and malformed, signed, duplicate-patched, unsafe-IAT and unsupported-tail rejection. Build tests exercise a changed valid candidate before hash approval, strict tool/hash rejection, compiler failure, checked scratch cleanup and injected cleanup failure with no published DLL.

| Check | Final result |
| --- | --- |
| `pnpm check`, `pnpm lint`, `pnpm build` | PASS; native Windows Git Bash and Windows Node, zero lint warnings. |
| `pnpm build:release` | PASS; recorded tools and approved DLL hash. |
| `node --test test/pe.test.ts test/native-compat.test.ts` with `DSH_TEST_GIT_BASH` selecting the real mingw64 archive | 37 passed, 0 failed/cancelled/skipped; 137,146.026 ms. |
| `pnpm test:windows` with the default ucrt64 installation | 224 passed, 0 failed/cancelled/skipped; 124,716.7251 ms. Includes the shipping backend's existing lifecycle, purge and installed-profile checks. |
| `pnpm test:browser` with a deliberately nonexistent `DSH_MSVC_TOOLS_DIR` | 1 passed, 0 failed/cancelled/skipped; 147,871.8205 ms. The DLL retained its approved hash, and no native compiler was required. |
| Browser entry with the DLL temporarily absent | Expected early failure with `Run pnpm build first` guidance; the DLL was restored before normal testing. |
| `pnpm pack` | PASS; prepack performed the strict release build. The 51-file tarball contains exactly one DLL, byte-identical to the approved artifact, and no native sources, build/test scripts or compiler intermediates. This is one packaging check, not Phase 4's two-tarball/install qualification. |

All DSH-launched fixture processes joined their managed ranges and owned source copies passed guarded teardown checks. No installed Git/DSH files, live profiles/caches, global environment, registry values or endpoint-protection settings were changed. Raw logs and archive provenance remain ignored local evidence. Phase 0's real-mingw64 prerequisite gap is resolved. Actual Electron/ASAR, cross-volume, active-Defender, production copying/cutover and final release qualification remain the later-phase checks; no optional alias/debugger qualification or live upgrade was attempted.

### Phase 1 audit follow-up

The original qualification above describes commit `0f245e9`. Independent review found gaps in import-table overlap and IAT coverage, namespace matching, and security descriptor preservation. The revised PE reader checks adjacent virtual sections, the complete image size and separate, section-bounded thunk tables. The shim limits the section grant to the MSYS namespace component, requires an exact access mask, and uses the original descriptor when rebuilding it would lose control information.

Two isolated MSVC builds produced the revised 23,040-byte DLL with SHA-256 `abccf046d49c2e9e956cf1f6d7b47bf78a00126827906a16f64af2fdde2e1d0c`. Before updating the release hash, the real mingw64 2.55.0 PE/native suite passed all 39 checks, including the dumpbin comparison, token observations, fork stress, IPC matrix and negative controls. The archive SHA-256 matched the original acquisition record.

A second independent review found that a native host could dynamically load the shim beside a mapped private MSYS image. The DLL now checks the Windows static-load indicator before changing process state. Tests independently check sibling identity and dynamic-load refusal from an otherwise eligible view. Agentless admission also checks both numeric components against DSH's temp SID range. The PE reader rejects mismatched import terminators and an empty debug directory with a nonzero address. [Windows DLL entry-point contract](https://learn.microsoft.com/en-us/windows/win32/dlls/dllmain)

The resulting 23,040-byte DLL reproduced in two isolated builds with the recorded MSVC/SDK versions. The real mingw64 PE/native suite passed 41 of 41 before approving SHA-256 `12600387d1f3172bb6ed2e606082538304839fe900c226b11cff3ebab858b6d3`. The preceding revision passed 226 of 226 tests on the installed ucrt64 Git.

A third independent review found no outstanding Phase 1 issue at `c6ba4eb`. On Windows 11 build 26200.9974 in native Git Bash, `pnpm check` and `pnpm lint` passed. The full ucrt64 2.56.0 Windows suite passed 228 of 228 on the final DLL. The browser suite passed 1 of 1 with an invalid compiler override. All three positive suites recorded zero skips, cancellations or failures.

An isolated archive of the commit produced the expected browser preflight error with the DLL removed. Normal `pnpm pack` then ran the strict release build. The 51-entry tarball contained one DLL matching the approved hash and excluded test sources, build tools and compiler intermediates. A separate byte comparison of both real MSYS images found all 14 original section headers, all original section payloads and the COFF tail intact after the 512-byte insertion. All four on-disk locale checksums matched Phase 0.

### Independent report review

The reviewed baseline was `21aea77`. A fresh release build reproduced its 23,040-byte DLL and both Git layouts passed the baseline 29 PE checks. Independent reads of the three historical DLL blobs and all four on-disk locale files matched the recorded hashes. The original build accepted a descriptor with a nonzero timestamp and forwarder chain, duplicate section addresses after an empty section, and empty import names. ImageHlp calculated a different checksum for a fixture with an odd NT header offset.

On Windows Node 26.12.1, a 353-character tilde path failed Win32 long-name expansion with error 3 and its 357-character extended form succeeded. On both real Git layouts, five source path spellings ran an owned `true.exe` while its private copy existed and all five failed after that copy was removed. Both MSYS binaries contained the global and session namespace templates. The `cygpid` object for a live process in each layout was in its global MSYS directory. The pinned upstream section-creation code explains the distinct use of the session directory.

The lowercase-drive invocation processed an invalid CLI flag in this environment. The build now uses Node’s entry-point flag directly. Supplying both explicit tool roots also worked with `ProgramFiles(x86)` absent. The native observer read U+FFFD after Node assigned a lone surrogate to an environment value. Its replacement test passes the UTF-16 code unit directly through Win32 inside a DSH workspace-write process and checks the conversion error.

The reviewed candidate built to 22,528 bytes. Two isolated MSVC builds with invalid ambient compiler and linker settings produced SHA-256 `8772d736117ea2de013eac37b2d51e115ed87ca06e7b07c06d00e9876ba3b27f`. Dumpbin confirmed the imports, anchor export and mitigations. The final strict build and the single DLL in the 51-entry prepack tarball reproduced that hash.

| Check on Windows 11 build 26200.9974, native Git Bash | Result |
| --- | --- |
| PE and native suites on real Git 2.55.0 mingw64 and 2.56.0 ucrt64 | 48/48 on each. Both ran on `WinSta0\Default` with live DSH read-only and workspace-write tokens at integrity RID 4096, plus full access. |
| `pnpm test:release` with the installed ucrt64 Git | Typecheck and lint passed. The full Windows suite passed 235/235, including all ten bootstrap tests. |
| Browser suite with a nonexistent compiler override | 1/1. Removing the DLL from a separate fixture produced the expected early diagnostic. |

All positive suites reported zero failures, cancellations or skips. The four locale file hashes matched Phase 0. During verification, a test-only linker error was corrected and the frozen offline install restored checkout dependency links that a temporary baseline build had redirected. The final results above were collected with the repaired checkout. The lockfile retained its original bytes.

## Refactor Phase 2, shallow copy provisioning

Windows 11 x64 build 26200.9974 ran native Git Bash, Windows Node 26.12.1 and DSH 0.2.2-rc.5. The provisioning process had medium integrity, a deny-only Administrators SID and no symbolic-link privilege. Windows Developer Mode was off. All copies and directory junctions were created unelevated in disposable directories. The shipping publisher continued to serve the executor tests.

An independent enumeration compared each complete source tree with its generation at the root, `usr` and `usr/bin`. It checked every retained name, junction target, ordinary file identity, link count and payload. For the two private DLLs it compared the output with the fixed PE transformation and the bundled shim. Both layouts retained 11 resource junctions.

| Git for Windows | Ordinary destination files | Logical bytes | Patched MSYS SHA-256 |
| --- | ---: | ---: | --- |
| ucrt64 2.56.0.windows.4 | 356 | 92,929,414 | `89fb6b5965c3044bb56a3de61345b77bff6e4618440e0f3c82c3338a70becf77` |
| mingw64 2.55.0.windows.1 | 366 | 95,656,587 | `fa125878d5ab8a96cf2c4d7ab40eba995b9df7a2772d0a282b84031a0f7faafa` |

Owned copies of both Git releases ran Bash, sh, Git, a layout `libexec/git-core` binary, `/usr/libexec/lessecho.exe` and a dynamically loaded Perl module through stock DSH in full access, read-only and workspace-write. The native suite observed integrity RID 4096 for both restricted policies. A real Git helper with a read-only attribute and a read/execute ACL retained its source bytes, ACL, attributes and link count. Its copy was independently writable and inherited the same ACL as a new file in the destination directory.

A regression check removed or replaced required source entries after successful discovery. The builder rejected missing entries, type changes and junction substitutions before creating either private directory. The package-boundary test recognizes the bare `tmp` name comparison used to exclude Git’s scratch directory and continues to reject repository scratch paths in imports, file operations and launch arguments.

The cache tests cover one source and destination parent hold for flat file copying, exclusive source reads, cancellation between files, disk-full and close errors, collision preservation and combined rollback diagnostics. Exact-limit ASCII and CJK/supplementary paths built successfully. One extra byte failed before any payload was created. Both source and compiled modules resolved the packaged shim to the same file. Its SHA-256 and the four locale file hashes matched the Phase 1 evidence.

The cold benchmark used the installed ucrt64 Git as a read-only source and five fresh destinations in a disposable DSH home. Timing began with discovery and included generation creation, reading the bundled shim, patching MSYS, file writes, junction admission and final handle closure. The source had 355 ordinary files totaling 92,906,374 bytes. The first generation took **366.26 ms**. The four repeats took **338.44, 324.92, 331.77 and 325.11 ms**. The longest sample used 7.33% of a 5 s budget and 3.66% of a 10 s budget. These measurements support retaining sequential copying with a cancellation point after each file. Command deadlines and selector publication are Phase 3 work.

Defender reported both antivirus and real-time protection disabled before and after the benchmark. **Active-Defender provisioning cost is UNVERIFIED.** Each destination was fresh and the source content was reused. Only C: was a suitable mounted local NTFS volume. **Cross-volume execution and cleanup are UNVERIFIED.** Host security settings and disk configuration were preserved.

| Final check | Result |
| --- | --- |
| TypeScript, ESLint and native Windows build | Passed |
| Focused cache, PE and native suites on ucrt64 | 97/97 |
| Full Windows suite on ucrt64 | 249/249 |
| PE and native suites on real mingw64 | 49/49 |
| Cold benchmark | 5 fresh generations, all successful |

All three test suites recorded zero failures, cancellations and skips.

### Independent Phase 2 audit

At `f365bdf`, equivalent Bash selections containing a dot component or repeated separator failed discovery for both supported entry points. Normalizing the lexical parent restores those spellings and keeps the interior reparse checks. A cache junction through a second junction to the correct Git directory also passed admission. Admission now requires the stored target to point directly to the admitted path and checks that it still resolves. Direct, indirect, redirected and dangling fixtures exercised the shared check.

With the default Git discovery locations removed from a test process, the required native fixture exited successfully and counted one skip. The strict fixture now resolves its own prerequisites before sharing the real provider setup with the optional execution test. Repeating the missing-Git probe produced exit code 1, one failure and zero skips.

A CJK temporary path exposed a false mismatch in the protected-copy ACL test. The old comparison used a UTF-16 path length to slice console-encoded output. The test now compares complete ACL records for a copied file and a fresh file at the same path, and uses the current user's numeric SID for the read/execute grant.

A second review at `509bf0c` found that NTFS assigned distinct ordinary directories named `K` and `K` different file IDs, although JavaScript lowercased both names to `k`. Both path comparisons had accepted a junction to the wrong directory. The shared check now walks the stored target without following reparses and verifies the admitted directory identity. Tests cover the two distinct objects, an intermediate junction in the target's parent path, alternate casing of the same object, replacement at the same name, and preservation of a native close failure.

A real Git-root junction named `usr` exposed a second selection ambiguity. Its native wrapper was mistaken for the internal Bash of the junction's parent. Both supported entries now select the correct root through that junction and in an ordinary installation directory named `usr`. The cache and pin-lifetime suites passed 77/77 on the revised admission code. The view cancellation and rollback tests inject failures at the stored-target read.

At `d186781`, placing an unrelated ordinary file named `ucrt64` beside the installation named `usr` prevented discovery through its native wrapper. That file belongs to the enclosing candidate root. Discovery now admits each supported root independently and reports the first admission error if neither qualifies. A native handle-close error remains fatal even when the other root would qualify. The regression and all 49 cache tests passed.

At `bffaa94`, a valid mingw64 installation containing an ordinary root file called `ucrt64` built correctly after selection, but discovery failed while looking for `ucrt64/bin/git.exe`. An incomplete earlier default installation could also block a valid later default. Discovery now checks the required source entries before probing layouts. A missing path or an ordinary file/directory mismatch cannot establish a layout. Reparses, read errors and native close failures keep their diagnostics. Explicit selection still reports a malformed mandatory directory. Both original failures reproduced before the correction. All 78 cache and pin-lifetime checks passed afterward.

Independent reviewers signed off on the measured Phase 2 scope at `b6b60fb`. Typecheck, lint and build passed on Windows 11 native Git Bash and Windows Node. The focused ucrt64 suites passed 99/99, the full Windows suite passed 251/251, and the real mingw64 PE and native suites passed 49/49. Each recorded zero failures, cancellations and skips. Complete fresh generations again matched the file counts, byte counts, private DLL hashes and 11 junction targets recorded above for both layouts. The four locale file hashes matched Phase 0.

The first fresh ucrt64 generation took 361.37 ms. Repeats took 322.61, 344.02, 423.72 and 394.28 ms. Defender real-time protection was off at both endpoints. Active-Defender timing and cross-volume operation remain unverified.


## Refactor Phase 3 · Production cutover

The production executor, publisher and settings page use the ordinary-copy cache on Windows 11 build 26200. Verification used native Git Bash, Windows Node 26.12.1 and DSH 0.2.2-rc.5. Typecheck, lint and the clean release build passed. The Windows suite passed 163/163, the browser suite 1/1, the separate mingw64 executor matrix 8/8, and mingw64 PE/native checks 49/49. The browser-only build preserved the DLL, and a missing-DLL fixture failed before starting a browser. All four raw locale implementation hashes matched the Phase 0 table.

| Boundary | Observation |
| --- | --- |
| Copy publication and cleanup | Independent writers converged on one selector at cold start and after a Git-only update. Killing a writer during a copy or just after rename left the old or new complete publication. A late collector-close error preserved the new selector. Active commands and idle peers retained A across publication of B. Release left old copies available for the next build or offline purge. |
| Offline purge | A real mapped image and a delete-sharing blocker prevented complete removal. The marker survived and the retry succeeded. With explicit user approval, an elevated fixture created one NTFS file symlink in the test cache. The ordinary account purged the cache and verified the external target still contained its original bytes. An injected unknown reparse tag stopped traversal. Production preparation and purge ran unelevated. |
| Real executor | Git for Windows 2.56.0.windows.4 (ucrt64) and 2.55.0.windows.1 (mingw64) ran the core command matrix in all three modes. Native image and four-caller IPC observations confirmed session isolation. The stock runner rejected a substituted workspace SID before Bash started. Restricted native Node pipes and the native Git wrapper, and quoted extended executable paths inside Bash, retained the recorded Gate 4 limitations. |
| Native image | Direct launch by fully shortened 8.3 paths originally failed in all modes with native exit 0xC0000142. After resolving the admitted view name, both Git layouts passed. Shortened malformed and wrong-policy views still failed admission. Two independently compiled input trees produced identical DLL bytes. MSVC 19.52.37029, linker 14.52.37029.0 and SDK 10.0.26100.0 produced SHA-256 `0350d5533d5e887f47045ba1787db9dfaacbb9cffdbe5887feeb0e64a7ff75b7`. |
| Packaged programs and debugger | The opted-in host suite compared PowerShell 7.7.0.0 and DesktopAppInstaller 1.29.380.0 with stock DSH. Package identities and native exits matched under all three modes. Restricted WinGet returned 0x8A150001. GDB 16.3 ran a fixture-owned target in every mode. |
| Actual Desktop | The executable and unmodified app.asar came from the supplied Windows x64 rc.5 installer. Electron 44.7.0 used an isolated DSH home and browser profile. The test suppressed Desktop's protocol-handler registration for this process. Bash ran Git in all three modes. Only read-only refused the workspace write. Each native child reported no visible console and 1,539 window samples found no new visible console. Settings rebuild, toast and navigation passed. Desktop exited with code 0 and the ordinary offline purge succeeded. |

Cross-volume and active-Defender measurements remain open for release qualification. The Desktop result applies to the packaged host and isolated profile used here.

### Independent Phase 3 audit

On Windows 11 build 26200, the first audit reproduced delayed timeout delivery during native workspace lookup, repeated recording of one close failure, and loss of an explicit environment key. Cache tests also exposed a growing owner marker during cold start, a missing payload masking a separate read failure, and a patched DLL too large for warm admission. The corrections in `de5ad38` passed the Windows suite (166/166) and browser suite (1/1). The short-path tests now require Windows to supply a different leaf spelling.

A second review traced the admitted workspace through the installed DSH confinement service. The executor now gives stock DSH a private policy copy with the canonical workspace. A test checks the incoming path and keeps the caller's policy frozen. Explicit blank settings use default Git discovery, including when the settings document is read-only. A worker published a different Git root while the parent process held the old pin, and a later build collected the released generation.

Both rounds passed typecheck and lint. The final Windows suite passed 166/166. The real mingw64 executor matrix passed 8/8 and packaged PowerShell, WinGet and GDB qualification passed 19/19. The supplied rc.5 Desktop executable and app.asar ran the audited package in an isolated profile. All three modes ran Git and reported no visible native child console. No new visible console was observed in 1,568 samples. Settings rebuild, navigation, normal exit and offline purge passed. The four locale implementation hashes and the release DLL hash matched the cutover record above.
