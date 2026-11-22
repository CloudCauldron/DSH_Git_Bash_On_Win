# Prototype binary provenance and reproducible builds

On November 21, 2026, the candidate zero-CRT shim was compiled from 56,860 bytes of C source (SHA-256 `44d8ba16f8612d3ed1e77c8bce9297eae533b63163cd18d989a046504a545148`) using x64 MSVC toolset 14.52.37025, compiler 19.52.37029, linker 14.52.37029.0, and SDK 10.0.26100.0.

| Image | SHA-256 |
| --- | --- |
| Original 20,992-byte candidate shim used in functional and latency trials | `e96cd85eb43b60281352f89cc0d3d28dbe0f585d76fe9f84245599111c857227` |
| Source MSYS, `ucrt64` Git 2.56.0.windows.4 | `2a89b7c31b323c42e2fb37900af087aeb27417694e630a210bc75b0369410bc7` |
| Patched private MSYS paired with the candidate | `240b8120ccc8672c5f70c239481558160e51beaa36018547da99c173555c1b33` |

## Byte comparison

Each build pair compiled identical source from two different absolute directories with a 1.2-second delay between runs, producing a 20,992-byte shim each time.

| Configuration | SHA-256, build A | SHA-256, build B | Byte differences |
| --- | --- | --- | --- |
| Default timestamps | `2948e58f5d666e6e32297444efa98a6e910c6a13143ea7969dfa62eefeda7aed` | `618cc7d0b7189994357aab05a2c0b9b5b9ebde201496e407154445531a4a4a39` | 2, at `0xd0` (COFF timestamp) and `0x461c` (POGO debug timestamp) |
| `/Brepro` at compile and link | `36db46e3731a4ae173359a69189e58ad923ed30ed06c353ec7e201acc17623e2` | `36db46e3731a4ae173359a69189e58ad923ed30ed06c353ec7e201acc17623e2` | 0, despite different intermediate object hashes |

Comparing default build A against the original functional-test shim found only four differing bytes, all inside those two timestamp fields. The deterministic `/Brepro` image carried POGO and REPRO debug entries with timestamp `0x27787d0a`, and PE checks confirmed x64 architecture, the single anchor export, mitigations, and named imports from `KERNEL32` and `ntdll`.

## Build order and profile installation

An initial packaging rehearsal at `f264f384e109d276c6ba6f2406fa3578f0d44341` used a harmless marker DLL. Clean builds cleared any pre-seeded marker, and once rebuilt and staged, two pnpm 12.18.0 archives matched byte for byte (49 files, SHA-256 `753c98fe4507f8b1ccc90d2788b882ee450f3273326d7d8cffce87fe9454ceeb`), with both Web and Desktop profiles loading the marker and returning 600.

Repeating with the real deterministic shim demonstrated why the canonical native source belongs outside `lib/`: the clean step cleared a pre-seeded DLL before the native build recreated it, and two `pnpm pack` archives produced 49 identical members and matching compressed bytes (SHA-256 `7ca51be484b40499448b7a817239c8350177d667ef8e16460fb5c376e83fb1f6`). Both installed profiles resolved all package files and the executor, standalone loading refused initialization as expected, and the installed shim passed all 10 live smoke checks (including Bash and `dash` pipelines across all three policies plus unchanged restricted-shell negative controls).

These runs used prototype profile installations; see [release verification](../../copy-backend-verification/evidence/release.md) for actual Electron/ASAR and shipped-archive results. The [latency investigation](../../copy-backend-performance/evidence/image-loading.md) used the original prebuilt shim throughout.

[Design experiment summary](../README.md) · [Reproduction](../REPRODUCING.md)
