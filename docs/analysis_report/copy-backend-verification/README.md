# Ordinary-copy release verification

The November 22–23, 2026 runs qualified the Windows executor that copies Git’s flat `usr/bin` payload, patches the private MSYS image and gives each session its own junction view. The main host ran Windows 11 x64 build 26200, Windows Node 26.12.1 and DSH 0.2.2-rc.5. The release ran Bash and Git in all three policies on ucrt64 Git 2.56.0.windows.4 and mingw64 Git 2.55.0.windows.1.

| Question | Answer and evidence |
| --- | --- |
| What identifies the inputs? | The starting shipping commit, tool versions and four raw locale-file hashes are in the [baseline](evidence/baseline.md). The [native qualification](evidence/native.md) identifies the official mingw64 archive, PE checks, earlier DLL hashes and independent reviews. |
| Can the ordinary account build and safely reuse the tree? | Both layouts used 11 resource junctions. Ordinary payload files had independent identities and inherited cache permissions. Audits covered discovery through ambiguous paths, reparse targets, close failures and cache admission. [Provisioning results](evidence/provisioning.md) |
| Does the executor retain confinement and lifetime semantics? | Tests exercised real restricted tokens, confirmed waits, simultaneous readers during rebuild, cancellation and source preservation. Actual Electron/ASAR runs covered child-console visibility and Settings rebuild. [Executor cutover and audits](evidence/executor.md) |
| Does the packed plugin install, survive restart and uninstall? | Two independent packs matched. Web and Desktop profile workers reused one generation. A standalone process resolved purge dependencies inside the installed profile and removed the cache and lock after both hosts exited. [Release and audit](evidence/release.md) |
| Which deployment boundaries were tested separately? | A real Windows 10 host used Git and cache on different NTFS volumes. A same-root offline PortableGit upgrade triggered automatic rebuild even when the source MSYS stamp stayed identical. [Cross-volume test](evidence/release.md#cross-volume-operation) · [Offline upgrade](evidence/release.md#same-root-portablegit-upgrade) |

The active-Defender timing evidence was collected on the earlier prototype. Cold provisioning and scanning of the final DLL under active Defender remain unmeasured. [Protection comparison](../copy-backend-performance/evidence/image-loading.md#protection-comparison) · [Reproduction](REPRODUCING.md) · [Current design](../../backend-20261122-design-decisions.md) · [Analysis index](../README.md)
