# Release qualification and installed profiles

Windows 11 x64 build 26200 qualified the plugin 0.2.2 release at `6c84a30` in native Git Bash with Windows Node 26.12.1, pnpm 12.18.0, and DSH 0.2.2-rc.5. The 35-file tarball (57,575 bytes) has SHA-256 `538475f1f13dda3324432bc07d78974ab3e1e701b096ca583891c36228a3119f`, bundling the 22,528-byte compatibility DLL with SHA-256 `0350d5533d5e887f47045ba1787db9dfaacbb9cffdbe5887feeb0e64a7ff75b7`.

| Check | Observed result |
| --- | --- |
| Release suite | Typecheck, lint, pinned clean build, 172 Windows tests (including live restricted tokens), one Chrome browser test, and one build/pack/install test all passed with zero skips or cancellations. Pointing `CHROME_PATH` at a nonexistent file failed preflight with exit 1 before creating a fixture home or touching any of the 29 library files' hashes or timestamps. |
| Package contents | Starting from two independent trees seeded with different invalid DLLs and obsolete debugger, setup, and feedback files, ordinary `pnpm` prepack produced byte-identical tarballs whose library files matched the tracked build. The archive contained the two catalogs, both READMEs, manifest, Cordis patch, and library, with the five direct runtime dependencies, peer declarations, and public entry points matching the checkout. |
| Packed profiles | Fresh rc.5 Web and Desktop profiles (using the official Web bundle template, scripts disabled, and `autoInstallPeers: false`) ran pipelines and Git across all three modes with shared host Cordis and Bash identities. Removing Web left the selector intact for Desktop to reuse, and complete removal preserved shared timeout and grace settings. After both executor processes exited, a standalone Node process resolved all purge imports inside the installed profile and removed the cache and writer lock. |
| Real Git layouts and source integrity | The packed-profile test passed on both `ucrt64` Git 2.56.0.windows.4 and `mingw64` Git 2.55.0.windows.1. An owned read-only `grep.exe` copied to a writable file with a distinct NTFS file ID, and source payload hashes, attributes, link counts, and recursive ACL records matched before preparation and after purge. |
| Actual Desktop | Electron 44.7.0 launched the rc.5 installer's executable and unmodified ASAR against a disposable home and user-data directory, suppressing protocol registration only in that test process. Each mode ran Git with no visible native child console, and only read-only refused a workspace write. Settings rebuilt to a fresh generation, navigation worked, Desktop exited 0, and offline purge succeeded. |
| Optional host tools | All 19 opted-in host cases passed against the installed tarball: packaged PowerShell 7.7.0.0 and DesktopAppInstaller 1.29.380.0 matched stock DSH's package identities and native exit codes (including restricted WinGet's `0x8A150001`), and GDB 16.3 ran the owned target in every mode. |
| Third-party launchers | From a native Node parent with inherited stdio, invoking installed `bin/bash.exe` or `usr/bin/bash.exe` by absolute path returned `0xC0000142` in read-only and workspace-write and succeeded in full access, while resolving `bash.exe` via the inherited `PATH` worked in all three modes. |
| Locale and production boundary | Both catalogs preserved all 70 messages, parameters, and metadata across 15 aligned groups, the four locale implementation files matched the [locale baseline](baseline.md#preserved-locale-bytes), and all 29 library files matched their recorded bytes. Dependency-graph and tarball checks found no local-only files, removed helpers, or alternate provisioning paths. |

## Cross-volume operation

On Windows 10 build 19045.4046 over a noninteractive SSH session, owned Git 2.56.1.windows.1 on `C:` and its DSH cache on `E:` reported distinct NTFS device IDs (7473946 and 652920), with the runtime's `etc` junction pointing across volumes to `C:`. Bash, grep, and Git ran under all three DSH policies, and an explicit rebuild published a new generation. Offline purge removed the cache and writer lock while all 364 source payload files kept their hashes, file IDs, and link counts, after which both temporary directories were deleted. This run used archive SHA-256 `63e19312681d91493712c137ae9f6a067197f96cdb24272b480e150b3a7d6a29` (identical to the release across all 33 non-README files) after fixing a missing DSH sandbox package on the remote host.

## Same-root PortableGit upgrade

Two official x64 PortableGit releases were extracted into disposable trees—2.56.0.windows.3 (archive SHA-256 `4fc27b779829a36df77911e3f4dea09c66c790dd6c5f7dfa3b6a5479f1fe354f`) and 2.56.0.windows.4 (`b1f3e52216e2ed6882d1bebfd4d3fdf319bec40d2edbbf9fd26ec4fd3fce7ed1`)—whose MSYS DLLs shared identical SHA-256 `2a89b7c31b323c42e2fb37900af087aeb27417694e630a210bc75b0369410bc7`. [Git for Windows .3 release](https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.3) · [Git for Windows .4 release](https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.4)

After closing all hosts and upgrading the selected tree in place, copying every newer file changed the MSYS DLL's timestamp, failing the test's unchanged-MSYS-stamp assertion. A second run kept the existing MSYS file untouched so only the other freshness inputs changed: `git.exe` grew from 4,412,744 to 4,412,760 bytes and `etc/package-versions.txt` changed from SHA-256 `2aa56fb4efaa21eb7179ff190a3b38f4d48a7e7f336ea80601c051874a2468a6` to `d845eb4c3a34dd134233841edf1c2e1bfc067b5843797b944f31145c5a3cb689`. The first command published a fresh generation, all three modes reported the new Git version, and the next restart reused it.

## Independent release audit

The README-only repack at `92825d7` contains 35 files (57,148 bytes, SHA-256 `849b7ea2a2b83001af04afe955ccac80edbb5c344465359a03ccf3eeccedf02f`). A direct diff against the prior release showed changes only in the two READMEs, with all 29 built library files (including the approved DLL) and all four locale files unchanged.

Audit changes through `67d8a04` were qualified on Windows 11 build 26200 with Windows Node 26.12.1, native Git Bash, and DSH 0.2.2-rc.5:

| Check | Result |
| --- | --- |
| Automated release suite | Typecheck, lint, clean pinned build, 172 core tests, the Chrome browser test, and the packed-profile release test passed with zero failures, cancellations, or skips, and two independent clean packs reproduced the archive digest above. Missing Chrome stopped preflight before creating a profile or changing any library byte or timestamp. |
| Saved configuration and confinement | Both Web and Desktop profile workers loaded their saved Git path through DSH's composed Shell and adapter entries. Read-only blocked both workspace and sibling writes, workspace-write allowed only the workspace write, full access allowed both, and an invalid stored Git path blocked publication. |
| Package contents and removal | An isolated Git index with a stale `lib/tool.js` failed the release check, and package-inventory validation rejected an injected local-only directory. Removing one profile deleted its package entry while preserving the selector; final removal removed the package entry, cache, and writer lock while keeping shared Shell settings intact. |
| Owned source and cleanup | Before-and-after hashes, NTFS attributes, link counts, and recursive ACL records matched across the owned Git tree, while a one-byte edit to `etc/package-versions.txt` failed the integrity check. Read-only source copies removed cleanly after validation, an external junction target kept its contents and read-only bit, missing DSH failed before cloning Git, and selecting a directory as a read-only payload was rejected. |
| Additional hosts | Using the archive above with zero skips, the packed-profile test passed on real `mingw64` Git 2.55.0.windows.1 and all 19 opted-in packaged-tool and GDB tests passed on `ucrt64` Git 2.56.0.windows.4. Earlier Electron/ASAR, cross-volume, and offline-upgrade runs exercised the exact same executable bytes. |

## Endpoint protection and timings

Active-Defender timing data comes from the November 21 [prototype retest](../../copy-backend-performance/evidence/image-loading.md#protection-comparison). Both Defender flags were off during the packed benchmarks, so active-Defender cold provisioning and scanning of the shipped DLL remain unmeasured. The [initial and audited distributions](../../copy-backend-performance/evidence/packed-runtime.md) identify each benchmarked archive, and the [Tencent single-file trial](../../copy-backend-performance/evidence/tencent-file.md) tested one disposable generation.

[Verification summary](../README.md) · [Reproduction](../REPRODUCING.md)
