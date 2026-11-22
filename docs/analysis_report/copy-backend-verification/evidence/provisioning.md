# Provisioning and Git layout verification

Provisioning tests ran on Windows 11 x64 build 26200.9974 with native Git Bash, Windows Node 26.12.1, DSH 0.2.2-rc.5, and Developer Mode off. The test process ran unelevated at medium integrity with a deny-only Administrators SID and no symbolic-link privilege, creating all copies and directory junctions inside disposable directories while the shipping publisher still backed the executor tests.

An independent tree walk compared each complete source tree against its generated runtime at the root, `usr`, and `usr/bin`, checking every retained name, junction target, ordinary file identity, link count, and payload while verifying both private DLLs against the fixed PE patch and bundled shim. Both layouts kept 11 resource junctions.

| Git for Windows | Ordinary destination files | Logical bytes | Patched MSYS SHA-256 |
| --- | ---: | ---: | --- |
| `ucrt64` 2.56.0.windows.4 | 356 | 92,929,414 | `89fb6b5965c3044bb56a3de61345b77bff6e4618440e0f3c82c3338a70becf77` |
| `mingw64` 2.55.0.windows.1 | 366 | 95,656,587 | `fa125878d5ab8a96cf2c4d7ab40eba995b9df7a2772d0a282b84031a0f7faafa` |

Owned copies of both releases ran Bash, sh, Git, a layout `libexec/git-core` binary, `/usr/libexec/lessecho.exe`, and a dynamically loaded Perl module through stock DSH in full access, read-only, and workspace-write (with the native suite observing integrity RID 4096 under both restricted policies). Copying a real Git helper marked read-only with a read/execute ACL left the source bytes, ACL, attributes, and link count untouched, while the copy stayed independently writable and inherited the destination directory's ACL.

## Failure and boundary controls

Discovery and build steps were tested separately: removing or swapping required source entries after discovery caused the builder to reject missing files, type mismatches, and substituted junctions before creating either private directory.

Cache tests verified single source/destination parent holds during flat copying, exclusive source reads, per-file cancellation, disk-full and close errors, collision preservation, and combined rollback diagnostics. Exact-limit ASCII and CJK/supplementary paths built cleanly while adding a single extra byte failed before writing any payload. Source and compiled modules resolved the same packaged shim file, matching the SHA-256 and four locale hashes from [native qualification](native.md).

The standalone [cold-copy timings](../../copy-backend-performance/evidence/packed-runtime.md#cold-copy-provisioning) measured sequential copying and per-file cancellation on a single NTFS volume with Defender real-time protection off.

| Initial qualification | Result |
| --- | --- |
| TypeScript, ESLint and native Windows build | Passed |
| Focused cache, PE and native suites on `ucrt64` | 97/97 |
| Full Windows suite on `ucrt64` | 249/249 |
| PE and native suites on real `mingw64` | 49/49 |
| Cold benchmark | 5 fresh generations, all successful |

All three test suites recorded zero failures, cancellations, or skips.

## Discovery and junction audit

Several targeted reviews tightened path discovery, junction admission, and error reporting before cutover:

- **`f365bdf` (lexical paths, indirect junctions, and test controls).** Equivalent Bash paths containing `.` segments or repeated separators had failed discovery; normalizing the lexical parent fixed both entry points while keeping interior reparse checks intact. Because a cache junction pointing through a second junction to the right Git directory had passed admission, admission now checks that the stored target points directly to the admitted path and still resolves (verified with direct, indirect, redirected, and dangling fixtures). Two test bugs were also fixed: removing default Git paths had let the required native fixture pass with one skip (it now fails with exit 1 and zero skips), and a CJK temp path broke UTF-16 slicing of console ACL output (the test now compares full ACL records against a fresh sibling file using the current user's numeric SID).
- **`509bf0c` (Unicode case folding and `usr`-named roots).** NTFS gave distinct ordinary directories named `K` and `K` different file IDs even though JavaScript lowercases both to `k`, letting junctions to the wrong directory slip past string comparison. The shared check now walks the stored target without following reparse points and matches the admitted directory's NTFS identity, verified across those two names, intermediate parent junctions, alternate casing, in-place replacement, and preserved native close errors. A second bug mistook the native wrapper of a Git-root junction named `usr` for its parent's internal Bash; both entries now resolve the right root through that junction and inside an ordinary `usr` directory. Cache and pin-lifetime suites passed 77/77, including view cancellation and rollback tests injecting failures at the stored-target read.
- **`d186781` (enclosing-root fallback).** An unrelated file named `ucrt64` sitting beside an installation named `usr` blocked discovery via its native wrapper. Discovery now evaluates each candidate root independently and reports the first error if neither qualifies (while keeping native handle-close errors fatal), passing the regression and all 49 cache tests.
- **`bffaa94` (layout probing and default fallback).** An ordinary root file named `ucrt64` inside a valid `mingw64` tree broke layout discovery, and an incomplete earlier default installation could shadow a valid later default. Discovery now validates required source entries before probing layouts, rejecting missing paths and type mismatches without masking reparse, read, or close errors, while explicit selection still reports malformed mandatory directories. Both regressions reproduced beforehand, and all 78 cache and pin-lifetime checks passed afterward.
- **`b6b60fb` (audited provisioning build).** Typecheck, lint, build, the focused `ucrt64` suites (99/99), the full Windows suite (251/251), and the real `mingw64` PE/native suites (49/49) all passed with zero failures, cancellations, or skips. Fresh generations reproduced the exact file counts, byte totals, private DLL hashes, and 11 junction targets above for both layouts, and the four locale hashes matched the [baseline](baseline.md#preserved-locale-bytes).
- **`6b091b7` (path validation and handle-close rollback).** This follow-up rejected drive-relative Bash paths and selections with a trailing separator, checked the volume before reading a held file, and preserved handle-close errors during rollback. Before the fix, two of four targeted controls failed; afterward, the compiled discovery/reader control passed along with 130/130 targeted real-`mingw64` tests. One full Windows run hit a transient package-installation failure (250/251), and the repeat passed 251/251.

[Verification summary](../README.md) · [Reproduction](../REPRODUCING.md)
