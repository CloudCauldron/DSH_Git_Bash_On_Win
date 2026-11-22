# Loader identity, token admission and IPC

## Which file did Windows map?

On Windows 11 build 26200.9974, a file symlink at `runtime\usr\bin\bash.exe` pointed to `bash.exe` in an owned source tree while both directories held ordinary, byte-identical copies of `msys-2.0.dll`, and two directory junctions exposed distinct views of the runtime. Across unelevated rc.5 DSH launches, an external observer compared loader module names with mapped device filenames and NTFS file IDs.

| Image or entry | File ID on volume 2863384730 | Result |
| --- | ---: | --- |
| Executable at symlink target | 7881299348246800 | Mapped in all nine candidate launches |
| DLL beside the file symlink | 25614222881018460 | Mapped through the direct runtime path and both views in all three policies |
| DLL beside the target executable | 13510798882459950 | Same bytes, different file |
| Independent control DLL | 6755399441404207 | The 12 ordinary-file controls across source, control and two control views selected their expected DLLs |

All 21 trials identified both images, with the loader reporting each view's own path for the single physical private DLL. All seven full-access launches reached the shell, while the 14 unpatched restricted launches mapped the images and then failed signal-pipe initialization with Win32 error 5 and `0xC0000142`. Only creating the test file symlink needed elevation; ordinary fixture files and installed originals kept their identities and hashes.

## Private image and Windows import binding

The prototype shim was a 20,992-byte x64 zero-CRT DLL compiled with MSVC toolset 14.52.37025 and SDK 10.0.26100.0, importing nine functions from `KERNEL32` and 27 from `ntdll` and exporting one anchor (see [binary provenance](builds.md) for digests).

The PE32+ patcher appended a 512-byte read-only import section (`.dshimp`), preserved the 16,479-byte COFF/string tail, and shifted its file pointer from `0x333800` to `0x333a00`. Because the stock image left `DataDirectory[IAT]` empty, relocating `DataDirectory[IMPORT]` caused `ntdll!LdrpSnapModule` to unprotect only the section holding the import directory, faulting with `0xC0000005` when writing to `.idata` at MSYS offset `0x35cc34`.

Populating `DataDirectory[IAT]` across `.idata` through `.dshimp` (after verifying every spanned section contained purely read-only data) let the loader bind all three descriptors and restore `PAGE_READONLY`. Once loaded, the shim checked its sibling's full loader path and mapped file identity before hooking five IAT entries: `GetFinalPathNameByHandleW`, `CreateNamedPipeA`, `CreateProcessW`, `NtSetInformationToken`, and `NtCreateSection`. See [production PE and native qualification](../../copy-backend-verification/evidence/native.md) for both Git layouts.

## Why admission needs two sources of token evidence

During MSYS-to-MSYS `execve()`, Cygwin passes a minimal Win32 environment to the child and transfers the POSIX environment later through `cygheap`, so even an ordinary MSYS child can lack both `TEMP` and `TMP` at `DllMain` time (whereas native parents normally provide them).

When a Win32 temp path is present, admission derives DSH's temp-write SID from that path and verifies it against the restricting token and any SID bound into the view, rejecting a native parent that supplies the wrong path. When both variables are absent—as in normal MSYS children and `env -i`—a bound workspace-write view requires the matching restricting SID plus an allow entry in `TokenDefaultDacl`, while an unbound view requires one unambiguous temp-write capability with matching default-DACL evidence.

## Sessions, fork addresses and negative controls

Two concurrent sessions in each policy shared the same physical runtime, and all six namespaces matched the keys predicted from their view paths. Opening a workspace-write owner's `cygpid.<pid>` process section from an independent caller via `NtOpenSection` produced:

| Caller | Read status | Write status |
| --- | --- | --- |
| Owner | 0 | 0 |
| Other workspace-write session | 0 | `0xC0000022` |
| Read-only session | 0 | `0xC0000022` |
| Full-access session | 0 | 0 |

The attached Bash suite passed 32/32 checks. An initial detached run reached six ready sessions before losing its output handle, and a repeat with piped harness output passed 32/32 at 11:11:31 UTC on November 21; the smaller `dash` image passed 34/34 in both configurations. Because restricted `USER32`-dependent programs failed initialization on a separate private desktop, full Bash comparisons ran on the normal interactive desktop.

After an exploratory read-only run saw 31/32 matching shim bases, switching to an in-shell PID read yielded 96/96 matching parent/child bases per image across three modes in both attached and detached runs, plus 300/300 per image in dedicated stress runs. MSYS loaded at `0x210040000`, and the shim shared a per-copy ASLR base within each family. These runs also covered pipelines, command substitution, Perl and gawk dynamic modules, workspace-write probes, and empty-environment launches; hitting MSYS's 260-byte UTF-8 installation-root limit on an earlier long-path fixture motivated the short view names and admission guard.

Ten negative controls rejected mismatched policies, tokens, or bound SIDs, malformed views, tampered Win32 temp paths, and standalone DLL loads (returning `0xC0000142` on restricted failures and `NULL` on standalone load), while installed Git files kept their original bytes and link counts. Defender was inactive on this host—an on-demand scan returned exit 2 (`0x80004005`)—and active-Defender pipeline timing was measured later in the [protection comparison](../../copy-backend-performance/evidence/image-loading.md#protection-comparison).

[Design experiment summary](../README.md) · [Reproduction](../REPRODUCING.md)
