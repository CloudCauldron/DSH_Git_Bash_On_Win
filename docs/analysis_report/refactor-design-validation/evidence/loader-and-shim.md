# Loader identity, token admission and IPC

## Which file did Windows map?

On Windows 11 build 26200.9974, a file symlink named `runtime\usr\bin\bash.exe` pointed to a Bash in an owned source tree. Both directories contained ordinary, byte-identical copies of `msys-2.0.dll`. Two directory junctions named different views of the same runtime. On an unelevated rc.5 DSH launch, an external observer compared loader module names with mapped device filenames and NTFS file IDs.

| Image or entry | File ID on volume 2863384730 | Result |
| --- | ---: | --- |
| Executable at symlink target | 7881299348246800 | Mapped in all nine candidate launches |
| DLL beside the file symlink | 25614222881018460 | Mapped through the direct runtime path and both views in all three policies |
| DLL beside the target executable | 13510798882459950 | Same bytes, different file |
| Independent control DLL | 6755399441404207 | The 12 ordinary-file controls across source, control and two control views selected their expected DLLs |

All 21 trials identified both images. The loader reported each view’s own spelling for the same physical private DLL. All seven full-access launches reached the shell. The 14 unchanged restricted launches reached image mapping, then failed signal-pipe initialization with Win32 error 5 and `0xC0000142`. Only the creation of the test file symlink required consent. Ordinary fixture files and the installed originals retained their identities and hashes.

## Private image and Windows import binding

The prototype shim was a 20,992-byte x64 zero-CRT DLL, built with MSVC toolset 14.52.37025 and SDK 10.0.26100.0. It imported nine functions from KERNEL32 and 27 from ntdll, and exported one anchor. The [binary provenance](builds.md) identifies the shim and both MSYS images by digest.

The 64-bit Portable Executable (PE32+) patcher appended a 512-byte read-only import section (`.dshimp`), retained the 16,479-byte COFF/string tail and shifted its file pointer from `0x333800` to `0x333a00`. The stock image had an empty `DataDirectory[IAT]`. After relocating `DataDirectory[IMPORT]`, `ntdll!LdrpSnapModule` temporarily unprotected only the section containing the import directory. Its write to the original `.idata` at MSYS offset `0x35cc34` faulted with `0xC0000005`.

Populating `DataDirectory[IAT]` across `.idata` through `.dshimp` let the loader bind all three descriptors and restore `PAGE_READONLY`. The patcher checked every section spanned by the directory for purely read-only data. The shim admitted its sibling by full loader path and mapped file identity before adjusting five import address table (IAT) entries. These were `GetFinalPathNameByHandleW`, `CreateNamedPipeA`, `CreateProcessW`, `NtSetInformationToken` and `NtCreateSection`. The [production PE and native qualification](../../copy-backend-verification/evidence/native.md) covers both Git layouts.

## Why admission needs two sources of token evidence

During MSYS-to-MSYS `execve()`, Cygwin supplied a minimal Win32 environment to the child and transferred the POSIX environment later through `cygheap`. At `DllMain` time, even an ordinary MSYS child could lack both `TEMP` and `TMP`. Native parents normally supplied them.

With a selected Win32 temp path, the candidate derived DSH’s temp-write SID from that path and checked it against the restricting token and any SID bound into the view. A native parent supplying the wrong path failed admission. With both variables absent, a bound workspace-write view required the corresponding restricting SID and an allow entry in `TokenDefaultDacl`. An unbound view required one unambiguous temp-write capability with matching default-DACL evidence. Normal child execution and `env -i` both exercised this second path.

## Sessions, fork addresses and negative controls

Two sessions in each policy used the same physical runtime. All six namespaces matched the keys predicted from their view paths. An independent caller opened the workspace-write owner’s `cygpid.<pid>` process section through `NtOpenSection`.

| Caller | Read status | Write status |
| --- | --- | --- |
| Owner | 0 | 0 |
| Other workspace-write session | 0 | `0xC0000022` |
| Read-only session | 0 | `0xC0000022` |
| Full-access session | 0 | 0 |

The attached Bash run passed 32/32 checks. An initial detached run reached six ready sessions before losing its output handle. The subsequent detached run with piped harness output completed 32/32 at 11:11:31 UTC on November 21. The smaller `dash` image passed 34/34 on each host configuration. Restricted USER32-dependent programs had also failed during initialization on a separate private desktop, so the full Bash comparisons used the normal interactive desktop.

An exploratory read-only run reported 31/32 matching shim bases. With the in-shell PID read, the attached and detached suites each passed 96/96 parent/child base checks per image across three modes. The dedicated stress run passed another 300/300 per image. The MSYS base was `0x210040000`. The shim shared a per-copy ASLR base across each observed family. The tests also ran pipelines, substitution, Perl or gawk dynamic loads, workspace write probes, and child launches with empty environments. An earlier shipping fixture exceeded MSYS’s 260-byte UTF-8 installation-root budget on a long path, motivating the short views and admission limit.

Ten negative cases rejected mismatched policies, tokens or bound SIDs, malformed views, a tampered Win32 temp path and standalone loading. Restricted admission failures returned `0xC0000142` and the standalone DLL load returned null. The original Git files retained their bytes and link counts. Defender was inactive and an on-demand scan returned exit 2 (`0x80004005`). The later [active-Defender run](../../copy-backend-performance/evidence/image-loading.md#protection-comparison) measured pipeline timing.

[Design experiment summary](../README.md) · [Reproduction](../REPRODUCING.md)
