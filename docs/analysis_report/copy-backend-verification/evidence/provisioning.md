# Provisioning and Git layout verification

Windows 11 x64 build 26200.9974 ran native Git Bash, Windows Node 26.12.1 and DSH 0.2.2-rc.5. The provisioning process had medium integrity, a deny-only Administrators SID and no symbolic-link privilege. Windows Developer Mode was off. All copies and directory junctions were created unelevated in disposable directories. The shipping publisher continued to serve the executor tests.

An independent enumeration compared each complete source tree with its generation at the root, `usr` and `usr/bin`. It checked every retained name, junction target, ordinary file identity, link count and payload. For the two private DLLs it compared the output with the fixed PE transformation and the bundled shim. Both layouts retained 11 resource junctions.

| Git for Windows | Ordinary destination files | Logical bytes | Patched MSYS SHA-256 |
| --- | ---: | ---: | --- |
| ucrt64 2.56.0.windows.4 | 356 | 92,929,414 | `89fb6b5965c3044bb56a3de61345b77bff6e4618440e0f3c82c3338a70becf77` |
| mingw64 2.55.0.windows.1 | 366 | 95,656,587 | `fa125878d5ab8a96cf2c4d7ab40eba995b9df7a2772d0a282b84031a0f7faafa` |

Owned copies of both Git releases ran Bash, sh, Git, a layout `libexec/git-core` binary, `/usr/libexec/lessecho.exe` and a dynamically loaded Perl module through stock DSH in full access, read-only and workspace-write. The native suite observed integrity RID 4096 for both restricted policies. A real Git helper with a read-only attribute and a read/execute ACL retained its source bytes, ACL, attributes and link count. Its copy was independently writable and inherited the same ACL as a new file in the destination directory.

## Failure and boundary controls

Discovery and construction were tested separately. Removing or replacing required source entries after discovery caused the builder to reject missing files, type changes and substituted junctions before creating either private directory.

The cache tests cover one source and destination parent hold for flat file copying, exclusive source reads, cancellation between files, disk-full and close errors, collision preservation and combined rollback diagnostics. Exact-limit ASCII and CJK/supplementary paths built successfully. One extra byte failed before any payload was created. Both source and compiled modules resolved the packaged shim to the same file. Its SHA-256 and the four locale file hashes matched the [native qualification](native.md).

The standalone [cold-copy timings](../../copy-backend-performance/evidence/packed-runtime.md#cold-copy-provisioning) exercised the sequential copy and its per-file cancellation points. These host runs used a single NTFS volume with Defender real-time protection off.

| Initial qualification | Result |
| --- | --- |
| TypeScript, ESLint and native Windows build | Passed |
| Focused cache, PE and native suites on ucrt64 | 97/97 |
| Full Windows suite on ucrt64 | 249/249 |
| PE and native suites on real mingw64 | 49/49 |
| Cold benchmark | 5 fresh generations, all successful |

All three test suites recorded zero failures, cancellations and skips.

## Discovery and junction audit

At `f365bdf`, equivalent Bash selections containing a dot component or repeated separator failed discovery for both supported entry points. Normalizing the lexical parent restores those spellings and keeps the interior reparse checks. A cache junction through a second junction to the correct Git directory also passed admission. Admission now requires the stored target to point directly to the admitted path and checks that it still resolves. Direct, indirect, redirected and dangling fixtures exercised the shared check.

With the default Git discovery locations removed from a test process, the required native fixture exited successfully and counted one skip. The strict fixture now resolves its own prerequisites before sharing the real provider setup with the optional execution test. Repeating the missing-Git probe produced exit code 1, one failure and zero skips.

A CJK temporary path exposed a false mismatch in the protected-copy ACL test. The old comparison used a UTF-16 path length to slice console-encoded output. The test now compares complete ACL records for a copied file and a fresh file at the same path, and uses the current user's numeric SID for the read/execute grant.

A second review at `509bf0c` found that NTFS assigned distinct ordinary directories named `K` and `K` different file IDs, although JavaScript lowercased both names to `k`. Both path comparisons had accepted a junction to the wrong directory. The shared check now walks the stored target without following reparses and verifies the admitted directory identity. Tests cover the two distinct objects, an intermediate junction in the target's parent path, alternate casing of the same object, replacement at the same name, and preservation of a native close failure.

A real Git-root junction named `usr` exposed a second selection ambiguity. Its native wrapper was mistaken for the internal Bash of the junction's parent. Both supported entries now select the correct root through that junction and in an ordinary installation directory named `usr`. The cache and pin-lifetime suites passed 77/77 on the revised admission code. The view cancellation and rollback tests inject failures at the stored-target read.

At `d186781`, placing an unrelated ordinary file named `ucrt64` beside the installation named `usr` prevented discovery through its native wrapper. That file belongs to the enclosing candidate root. Discovery now admits each supported root independently and reports the first admission error if neither qualifies. A native handle-close error remains fatal even when the other root would qualify. The regression and all 49 cache tests passed.

At `bffaa94`, a valid mingw64 installation containing an ordinary root file called `ucrt64` built correctly after selection, but discovery failed while looking for `ucrt64/bin/git.exe`. An incomplete earlier default installation could also block a valid later default. Discovery now checks the required source entries before probing layouts. A missing path or an ordinary file/directory mismatch cannot establish a layout. Reparses, read errors and native close failures keep their diagnostics. Explicit selection still reports a malformed mandatory directory. Both original failures reproduced before the correction. All 78 cache and pin-lifetime checks passed afterward.

The audited provisioning build at `b6b60fb` passed its final checks. Typecheck, lint and build passed on Windows 11 native Git Bash and Windows Node. The focused ucrt64 suites passed 99/99, the full Windows suite passed 251/251, and the real mingw64 PE and native suites passed 49/49. Each recorded zero failures, cancellations and skips. Complete fresh generations again matched the file counts, byte counts, private DLL hashes and 11 junction targets recorded above for both layouts. The four locale file hashes matched the [baseline](baseline.md#preserved-locale-bytes).


The subsequent revision `6b091b7` rejected drive-relative Bash paths and selections with a trailing separator, checked the volume before reading a held file, and preserved handle-close diagnostics during rollback. Before correction, two of four targeted controls failed. Afterward, the compiled discovery/reader control passed and the targeted real-mingw64 run passed 130/130. One full Windows run passed 250/251 with a failure during package installation. The repeat passed 251/251.

[Verification summary](../README.md) · [Reproduction](../REPRODUCING.md)
