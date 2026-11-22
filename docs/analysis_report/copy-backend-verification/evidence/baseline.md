# Shipping baseline and preserved locale files

On 22 November 2026 the starting point was `33fa0a9039d193452ccab7eefc222144437f8aaa`. All five checks used native Windows Git Bash and an unelevated Windows Node process. The fixtures used owned Git copies and isolated DSH profiles. A Git bundle of the starting revision passed verification with complete history and no prerequisites (SHA-256 `435c53b552a9f73364119bf09c3ad13157a9b205c155f11aa509959307a5cf97`).

## Preserved locale bytes

These SHA-256 values were captured before the tests and checked again afterward against the raw file bytes.

| File | SHA-256 |
| --- | --- |
| `src/locale/catalogs.ts` | `bbf83e2b7982c42288aa0469c88de5681ebde4722cb21fbad04f132c8830c94b` |
| `src/locale/client.ts` | `43b562b44abcfbc70da4f9ab5135f4f94a36a17c5b66990392e575aba72c3c0d` |
| `src/locale/errors.ts` | `0a463d259fa626fcf0ffeaea8d933169c3de5f2c884d3574bc9fb56508349a98` |
| `src/locale/shared.ts` | `801550e078a2d46c963e0385f267dcd88f1b33dc7ec65d875c25d3aab9c8ad13` |

## Host at baseline

Windows 11 x64 build 26200, Node 26.12.1, pnpm 12.18.0, DSH 0.2.2-rc.5 and Chrome 158.0.8127.37. Default discovery found ucrt64 Git 2.56.0.windows.4, MSVC toolset 14.52.37025 (compiler 19.52.37029, linker 14.52.37029.0) and SDK 10.0.26100.0. Developer Mode was off. These runs exercised the shipping hardlink backend.

## Results

| Command | Result |
| --- | --- |
| `pnpm check` | Passed, exit 0. |
| `pnpm lint` | Passed, exit 0, zero warnings. |
| `pnpm test:windows` | Passed, 187 tests, 0 failures, 0 cancelled, 0 skipped, test-runner duration 158,988.5111 ms. |
| `pnpm test:browser` | Passed, 1 test, 0 failures, 0 cancelled, 0 skipped, test-runner duration 127,753.387 ms. |
| `pnpm test:release` | Passed, prerequisite checks, check, lint, clean build and 187 tests, 0 failures, 0 cancelled, 0 skipped, test-runner duration 81,107.6336 ms. |

The release command at this revision preflighted DSH and Git. The browser test ran separately. The optional real-consent cases were unregistered, and the browser simulated consent responses. No alias or debugger qualification ran here. All four locale files and the old uninstaller matched the baseline after the clean builds.

At this point only the ucrt64 layout and one local NTFS volume were available. Subsequent runs qualified [real mingw64](native.md), [Electron Desktop, cross-volume operation and an offline upgrade](release.md). Defender antivirus and real-time protection were both inactive. Registering a product with Security Center alone does not establish whether it scanned a particular file.

[Verification summary](../README.md) · [Reproduction](../REPRODUCING.md)
