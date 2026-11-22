# Native DLL qualification and real Git inputs

On November 22, 2026, the native compatibility DLL and PE patcher were qualified independently while the shipping executor still used its debugger supervisor. The final production DLL is identified in the [release record](release.md).

## Token and image admission

Before revising native admission, an independent probe ran through DSH rc.5's live full-access, read-only, and workspace-write process paths on a local Windows account. In every mode, `TokenLogonSid` returned one 44-byte entry with attributes `0xc0000007`, SID offset 24, and SID length 20, matching `TokenGroups`. Both restricted tokens ran at integrity RID 4096 and kept the logon SID in their restricting list, whereas full access ran at RID 8192 with no restricting SIDs. Production reads into a bounded, aligned 96-byte buffer, checks the `0xc0000000` logon-ID mask (rather than requiring the full `0xc0000007` word), and validates count, returned length, and SID bounds; domain accounts remain untested.

At commit `0f245e9`, two isolated builds with MSVC toolset `14.52.37025`, compiler `19.52.37029`, linker `14.52.37029.0`, and SDK `10.0.26100.0` produced an identical **23,040-byte** DLL (SHA-256 **`d492dca0460a91c75569dd78684309a7e2b6d45d51f5479f448901c14bf1e277`**) before pinning the release manifest. Independent `dumpbin` output matched on imports, the single anchor export, and mitigations. Verification enforces membership in the reviewed named-import allowlist—allowing unused entries while rejecting unknown or ordinal imports and unapproved loader, thread, or heap APIs.

## Git inputs

| Real Git input | Observed source runtime |
| --- | --- |
| Installed `ucrt64` `2.56.0.windows.4`, copied into owned fixtures | Bash package `5.3.015-2`, MSYS `3.6.10-4`. MSYS DLL 3,373,151 bytes, SHA-256 `2a89b7c31b323c42e2fb37900af087aeb27417694e630a210bc75b0369410bc7`. |
| Official `mingw64` `2.55.0.windows.1`, extracted into an owned fixture | `PortableGit-2.55.0-64-bit.7z.exe` matched the release SHA-256 `dfa8cad3ce7e685b9bfbbb2125afcf7c68d4f53490426702ffac367dac62e928`. Bash package `5.3.015-1`, MSYS `3.6.9-2`. MSYS DLL 3,368,543 bytes, SHA-256 `2ea49553e4c03055dcf1c4a2bef54668081a07663fba283f4b34cf70f2157191`. [Official release](https://github.com/git-for-windows/git/releases/tag/v2.55.0.windows.1) |

Source admission checks Portable Executable (PE) structure rather than a version whitelist; the table above identifies the two real inputs exercised across initial qualification and the follow-up reviews below.

| Boundary | Observations |
| --- | --- |
| Sessions and fork | All three policies—including bound and agentless workspace-write—ran native and MSYS children, pipelines, substitutions, and dynamically loaded Perl and gawk modules. Tests covered `TEMP` precedence, `TMP` fallback, and absent variables across 100 parent/child base checks per mode and session form, while six concurrent views matched their predicted namespaces. |
| Images and IPC | An independent observer confirmed both private DLLs were mapped and all five hooked import address table (IAT) entries sat on read-only pages. Process-section read/write status was `0/0` for the owner and full-access peer, and `0/0xc0000022` for workspace-write and read-only peers. |
| Refused admission | Tests rejected wrong policies, tokens, or bound SIDs; malformed views or logon replies; ambiguous temp capabilities; tampered, oversized, or invalid temp paths; foreign or duplicate MSYS mappings; forged loader names or mapped identities; missing, odd, or oversized loader paths; standalone loading; and failed IAT-protection restoration. |
| Section permissions | Exact, prefix, owner, deny, and insufficient ACEs were distinguished while verifying preservation of owner, group, system ACL, and descriptor control bits. |
| Child redirection | Tests exercised source/runtime children, the distinct native wrapper, extended and expanded names, `argv[0]`, missing or denied private targets, and input/expansion/output length bounds. A failed rewrite never fell back to the original executable, concurrent initialization published one result, and a terminal root-resolution error stayed terminal. |
| PE patching and build | A separately encoded 4 KiB PE32+ fixture ran through the production patcher, testing named, ordinal, and repeated import descriptors; preservation of original sections and COFF/string/GNU debug tails; initialized-data size and overflow; Windows ImageHlp checksum agreement; exact header capacity; and rejection of malformed, signed, already patched, unsafe-IAT, and unsupported-tail images. Build checks covered testing candidates before hash approval, strict tool/hash enforcement, compiler failures, and cleanup failures blocking publication. |

## Initial checks

| Check | Final result |
| --- | --- |
| `pnpm check`, `pnpm lint`, `pnpm build` | Passed, native Windows Git Bash and Windows Node, zero lint warnings. |
| `pnpm build:release` | Passed, recorded tools and approved DLL hash. |
| `node --test test/pe.test.ts test/native-compat.test.ts` with `DSH_TEST_GIT_BASH` selecting the real `mingw64` archive | 37 passed, 0 failed/cancelled/skipped in 137,146.026 ms. |
| `pnpm test:windows` with the default `ucrt64` installation | 224 passed, 0 failed/cancelled/skipped in 124,716.7251 ms. Includes the shipping backend's existing lifecycle, purge and installed-profile checks. |
| `pnpm test:browser` with a deliberately nonexistent `DSH_MSVC_TOOLS_DIR` | 1 passed, 0 failed/cancelled/skipped in 147,871.8205 ms. The DLL retained its approved hash, and no native compiler was required. |
| Browser entry with the DLL temporarily absent | Expected early failure with `Run pnpm build first` guidance. The DLL was restored before normal testing. |
| `pnpm pack` | Passed, prepack performed the strict release build. The 51-file tarball contains exactly one DLL, byte-identical to the approved artifact, and no native sources, build/test scripts or compiler intermediates. |

All fixture processes settled and owned Git sources passed teardown checks. The browser and archive checks used the 23,040-byte candidate above, producing tarball SHA-256 `f296dc045a12ecbb183bb2726d2a6e74647acec6655a0e2bb2f83fa5f94df805`.

## Independent native reviews

An independent review of `0f245e9` caught gaps in import-table overlap and IAT coverage, namespace matching, and security-descriptor preservation. The revised PE reader validates adjacent virtual sections, full image size, and separate section-bounded thunk tables, while the shim confines section grants to the MSYS namespace component, requires an exact access mask, and keeps the original descriptor whenever rebuilding it would drop control bits. Two isolated MSVC builds reproduced the revised 23,040-byte DLL (SHA-256 `abccf046d49c2e9e956cf1f6d7b47bf78a00126827906a16f64af2fdde2e1d0c`); before updating the pinned hash, the real `mingw64` 2.55.0 PE/native suite passed 39/39 (including `dumpbin`, token checks, fork stress, IPC matrix, and negative controls) against the original archive digest.

A second review noted that a native host could dynamically load the shim next to a mapped private MSYS image, so the DLL now checks Windows's static-load indicator before altering process state, backed by tests for sibling identity and dynamic-load refusal. Agentless admission was tightened to check both numeric components against DSH's temp SID range, and the PE reader now rejects mismatched import terminators and empty debug directories with nonzero addresses. [Windows DLL entry-point contract](https://learn.microsoft.com/en-us/windows/win32/dlls/dllmain)

Two isolated builds with the recorded MSVC/SDK toolchain reproduced the 23,040-byte DLL (SHA-256 `12600387d1f3172bb6ed2e606082538304839fe900c226b11cff3ebab858b6d3`), passing 41/41 on `mingw64` PE/native before approval and 226/226 on `ucrt64` on the preceding revision.

A third review at `c6ba4eb` found no open native issues. On Windows 11 build 26200.9974 in native Git Bash, `pnpm check`, `pnpm lint`, the full `ucrt64` 2.56.0 Windows suite (228/228), and the browser suite with an invalid compiler override (1/1) all passed with zero skips, cancellations, or failures. Removing the DLL from an isolated archive triggered the expected browser preflight error, and `pnpm pack` produced a 51-entry tarball containing only the approved DLL with no test sources, build tools, or compiler intermediates. A byte-level comparison of both real MSYS images confirmed that all 14 original section headers, original section payloads, and the COFF tail stayed intact after the 512-byte insertion, and all four locale files matched the baseline.

## PE structure and long-path follow-up

At baseline `21aea77`, a fresh release build reproduced its 23,040-byte DLL, both Git layouts passed the 29 baseline PE checks, and all three historical DLL blobs plus the four locale files matched their recorded hashes. Testing exposed four PE edge cases accepted by the original reader—descriptors with nonzero timestamps or forwarder chains, duplicate section addresses after an empty section, empty import names, and an odd NT header offset where ImageHlp computed a different checksum.

Long-path and namespace checks on Windows Node 26.12.1 showed that a 353-character tilde path failed Win32 long-name expansion with error 3 while its 357-character extended form succeeded. Across both Git layouts, all five source-path spellings ran an owned `true.exe` while its private copy existed and failed once that copy was removed. Both MSYS binaries contained global and session namespace templates, placing live `cygpid` objects in the global MSYS directory—matching the pinned upstream code that reserves the session directory for other uses.

Two environment quirks were also resolved. Because a lowercase-drive invocation tripped CLI entry detection, the build script now checks Node's entry-point flag directly (and works with explicit tool roots even when `ProgramFiles(x86)` is unset). Separately, because Node replaces lone surrogates with U+FFFD before Windows sees them, the invalid-UTF-16 test now injects the code unit directly via Win32 inside a DSH workspace-write process and verifies the conversion error.

The resulting candidate shrank to 22,528 bytes. Two isolated MSVC builds with invalid ambient compiler and linker settings produced identical bytes (SHA-256 `8772d736117ea2de013eac37b2d51e115ed87ca06e7b07c06d00e9876ba3b27f`), confirmed by `dumpbin` for imports, anchor export, and mitigations and matched by both the strict release build and the 51-entry `prepack` tarball.

| Check on Windows 11 build 26200.9974, native Git Bash | Result |
| --- | --- |
| PE and native suites on real Git 2.55.0 `mingw64` and 2.56.0 `ucrt64` | 48/48 on each, running on the normal interactive desktop under live DSH read-only and workspace-write tokens (integrity RID 4096) plus full access. |
| `pnpm test:release` with the installed `ucrt64` Git | Typecheck, lint, and the full Windows suite (235/235, including all ten bootstrap tests) passed. |
| Browser suite with a nonexistent compiler override | 1/1 passed; removing the DLL from a separate fixture triggered the expected early diagnostic. |

All positive suites finished with zero failures, cancellations, or skips, and the four locale files matched the [locale baseline](baseline.md#preserved-locale-bytes). Mid-verification, a test-only linker error was fixed and a frozen offline install restored checkout dependency links that a temporary baseline build had redirected without changing the lockfile; all final results above came from the repaired checkout.

[Verification summary](../README.md) · [Reproduction](../REPRODUCING.md)
