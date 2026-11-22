# Native DLL qualification and real Git inputs

On November 22, 2026, the native code and PE patcher were tested independently while the shipping executor still used its supervisor. The final production DLL is identified in the [release record](release.md).

## Token and image admission

Before changing native admission, the independent probe ran through DSH rc.5's actual full-access, read-only and workspace-write process paths. `TokenLogonSid` returned one entry, 44 bytes, attributes `0xc0000007`, SID offset 24 and SID length 20 in every mode. Its SID and attributes matched the independent `TokenGroups` result. Both restricted tokens had integrity RID 4096 and retained the logon SID in their restricting list. Full-access had RID 8192 and no restricting SIDs. Production uses a bounded, aligned 96-byte buffer, requires the `0xc0000000` logon-ID mask and checks count/returned length/SID bounds. It does not require equality to the incidental full attribute word or claim domain-account coverage.

At commit `0f245e9`, the approved DLL was **23,040 bytes**, SHA-256 **`d492dca0460a91c75569dd78684309a7e2b6d45d51f5479f448901c14bf1e277`**. Two isolated input trees produced identical bytes before the release manifest was pinned at that revision. The build used MSVC toolset `14.52.37025`, compiler `19.52.37029`, linker `14.52.37029.0`, SDK `10.0.26100.0`. Independent dumpbin output agreed on imports, the sole anchor export and mitigations. The manifest permits only reviewed named imports. Unused allowlisted names are permitted. Unknown or ordinal imports and unapproved loader, thread or heap functions fail verification.

## Git inputs

| Real Git input | Observed source runtime |
| --- | --- |
| Installed ucrt64 `2.56.0.windows.4`, copied into owned fixtures | Bash package `5.3.015-2`, MSYS `3.6.10-4`. MSYS DLL 3,373,151 bytes, SHA-256 `2a89b7c31b323c42e2fb37900af087aeb27417694e630a210bc75b0369410bc7`. |
| Official mingw64 `2.55.0.windows.1`, extracted into an owned fixture | `PortableGit-2.55.0-64-bit.7z.exe` matched the release SHA-256 `dfa8cad3ce7e685b9bfbbb2125afcf7c68d4f53490426702ffac367dac62e928`. Bash package `5.3.015-1`, MSYS `3.6.9-2`. MSYS DLL 3,368,543 bytes, SHA-256 `2ea49553e4c03055dcf1c4a2bef54668081a07663fba283f4b34cf70f2157191`. [Official release](https://github.com/git-for-windows/git/releases/tag/v2.55.0.windows.1) |

Source admission depends on Portable Executable (PE) structure. The release tags and hashes above identify the two measured inputs. Across the initial qualification and subsequent reviews, both layouts ran the following controls.

| Boundary | Observations |
| --- | --- |
| Sessions and fork | All three policies, including bound and agentless workspace-write, ran native and MSYS children, pipelines, substitutions and dynamically loaded Perl/gawk modules. Tests covered TEMP precedence, TMP fallback and absent variables, with 100 parent/child base checks per mode and session form. Six simultaneous views matched their predicted namespaces. |
| Images and IPC | An independent observer found both private DLLs and read-only pages at all five hooked import address table (IAT) entries. Section read/write status was `0/0` for the owner and full-access peer, and `0/0xc0000022` for workspace-write and read-only peers. |
| Refused admission | Wrong policy, token or bound SID, malformed views or logon replies, ambiguous temp capabilities, and tampered, oversized or invalid temp paths were refused. Controls covered foreign or duplicate MSYS mappings, false loader names or mapped identity, missing/odd/oversized loader paths, standalone loading and failed IAT-protection restoration. |
| Section permissions | Exact, prefix, owner, deny and insufficient access-control entries were distinguished. The tests checked preservation of owner, group, system ACL and descriptor control bits. |
| Child redirection | Tests covered source/runtime children, the separate native wrapper, extended and expanded names, argv[0], missing or denied private targets and input/expansion/output bounds. A failed rewrite could never start the original executable. Concurrent initialization published one result and a terminal root-resolution error stayed terminal. |
| PE patching and build | A separately encoded 4 KiB PE32+ fixture exercised the production patcher. Tests covered named, ordinal and repeated import descriptors, preservation of original sections and COFF/string/GNU debug data, initialized-data size and overflow, Windows ImageHlp checksum agreement and exact header capacity. Malformed, signed, already patched, unsafe-IAT and unsupported-tail inputs were rejected. Build checks covered changing a candidate before hash approval, strict tool/hash verification, compiler failure and cleanup failures preventing publication. |

## Initial checks

| Check | Final result |
| --- | --- |
| `pnpm check`, `pnpm lint`, `pnpm build` | Passed, native Windows Git Bash and Windows Node, zero lint warnings. |
| `pnpm build:release` | Passed, recorded tools and approved DLL hash. |
| `node --test test/pe.test.ts test/native-compat.test.ts` with `DSH_TEST_GIT_BASH` selecting the real mingw64 archive | 37 passed, 0 failed/cancelled/skipped in 137,146.026 ms. |
| `pnpm test:windows` with the default ucrt64 installation | 224 passed, 0 failed/cancelled/skipped in 124,716.7251 ms. Includes the shipping backend's existing lifecycle, purge and installed-profile checks. |
| `pnpm test:browser` with a deliberately nonexistent `DSH_MSVC_TOOLS_DIR` | 1 passed, 0 failed/cancelled/skipped in 147,871.8205 ms. The DLL retained its approved hash, and no native compiler was required. |
| Browser entry with the DLL temporarily absent | Expected early failure with `Run pnpm build first` guidance. The DLL was restored before normal testing. |
| `pnpm pack` | Passed, prepack performed the strict release build. The 51-file tarball contains exactly one DLL, byte-identical to the approved artifact, and no native sources, build/test scripts or compiler intermediates. |

All DSH fixture processes settled and the owned sources passed teardown checks. The recorded archive had SHA-256 `f296dc045a12ecbb183bb2726d2a6e74647acec6655a0e2bb2f83fa5f94df805`. Browser and archive checks used the 23,040-byte candidate identified above.

## Independent native reviews

The original qualification above describes commit `0f245e9`. Independent review found gaps in import-table overlap and IAT coverage, namespace matching, and security descriptor preservation. The revised PE reader checks adjacent virtual sections, the complete image size and separate, section-bounded thunk tables. The shim limits the section grant to the MSYS namespace component, requires an exact access mask, and uses the original descriptor when rebuilding it would lose control information.

Two isolated MSVC builds produced the revised 23,040-byte DLL with SHA-256 `abccf046d49c2e9e956cf1f6d7b47bf78a00126827906a16f64af2fdde2e1d0c`. Before updating the release hash, the real mingw64 2.55.0 PE/native suite passed all 39 checks, including the dumpbin comparison, token observations, fork stress, IPC matrix and negative controls. The archive SHA-256 matched the original acquisition record.

A second independent review found that a native host could dynamically load the shim beside a mapped private MSYS image. The DLL now checks the Windows static-load indicator before changing process state. Tests independently check sibling identity and dynamic-load refusal from an otherwise eligible view. Agentless admission also checks both numeric components against DSH's temp SID range. The PE reader rejects mismatched import terminators and an empty debug directory with a nonzero address. [Windows DLL entry-point contract](https://learn.microsoft.com/en-us/windows/win32/dlls/dllmain)

The resulting 23,040-byte DLL reproduced in two isolated builds with the recorded MSVC/SDK versions. The real mingw64 PE/native suite passed 41 of 41 before approving SHA-256 `12600387d1f3172bb6ed2e606082538304839fe900c226b11cff3ebab858b6d3`. The preceding revision passed 226 of 226 tests on the installed ucrt64 Git.

A third independent review found no outstanding native qualification issue at `c6ba4eb`. On Windows 11 build 26200.9974 in native Git Bash, `pnpm check` and `pnpm lint` passed. The full ucrt64 2.56.0 Windows suite passed 228 of 228 on that revision’s DLL. The browser suite passed 1 of 1 with an invalid compiler override. All three positive suites recorded zero skips, cancellations or failures.

An isolated archive of the commit produced the expected browser preflight error with the DLL removed. Normal `pnpm pack` then ran the strict release build. The 51-entry tarball contained one DLL matching the approved hash and excluded test sources, build tools and compiler intermediates. A separate byte comparison of both real MSYS images found all 14 original section headers, all original section payloads and the COFF tail intact after the 512-byte insertion. All four on-disk locale checksums matched the baseline.

## PE structure and long-path follow-up

The reviewed baseline was `21aea77`. A fresh release build reproduced its 23,040-byte DLL and both Git layouts passed the baseline 29 PE checks. Independent reads of the three historical DLL blobs and all four on-disk locale files matched the recorded hashes. The original build accepted a descriptor with a nonzero timestamp and forwarder chain, duplicate section addresses after an empty section, and empty import names. ImageHlp calculated a different checksum for a fixture with an odd NT header offset.

On Windows Node 26.12.1, a 353-character tilde path failed Win32 long-name expansion with error 3 and its 357-character extended form succeeded. On both real Git layouts, five source path spellings ran an owned `true.exe` while its private copy existed and all five failed after that copy was removed. Both MSYS binaries contained the global and session namespace templates. The `cygpid` object for a live process in each layout was in its global MSYS directory. The pinned upstream section-creation code explains the distinct use of the session directory.

The lowercase-drive invocation processed an invalid CLI flag in this environment. The build now uses Node’s entry-point flag directly. Supplying both explicit tool roots also worked with `ProgramFiles(x86)` absent. The native observer read U+FFFD after Node assigned a lone surrogate to an environment value. Its replacement test passes the UTF-16 code unit directly through Win32 inside a DSH workspace-write process and checks the conversion error.

The reviewed candidate built to 22,528 bytes. Two isolated MSVC builds with invalid ambient compiler and linker settings produced SHA-256 `8772d736117ea2de013eac37b2d51e115ed87ca06e7b07c06d00e9876ba3b27f`. Dumpbin confirmed the imports, anchor export and mitigations. The final strict build and the single DLL in the 51-entry prepack tarball reproduced that hash.

| Check on Windows 11 build 26200.9974, native Git Bash | Result |
| --- | --- |
| PE and native suites on real Git 2.55.0 mingw64 and 2.56.0 ucrt64 | 48/48 on each. Both ran on the normal interactive desktop with live DSH read-only and workspace-write tokens at integrity RID 4096, plus full access. |
| `pnpm test:release` with the installed ucrt64 Git | Typecheck and lint passed. The full Windows suite passed 235/235, including all ten bootstrap tests. |
| Browser suite with a nonexistent compiler override | 1/1. Removing the DLL from a separate fixture produced the expected early diagnostic. |

All positive suites reported zero failures, cancellations or skips. The four locale file hashes matched the [locale baseline](baseline.md#preserved-locale-bytes). During verification, a test-only linker error was corrected and the frozen offline install restored checkout dependency links that a temporary baseline build had redirected. The final results above were collected with the repaired checkout. The lockfile retained its original bytes.

[Verification summary](../README.md) · [Reproduction](../REPRODUCING.md)
