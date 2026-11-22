# Windows design experiments

On November 21–22, 2026, proof-of-concept experiments on Windows 11 build 26200.9974 (with DSH 0.2.2-rc.5, native Node 26.12.1, and `ucrt64` Git 2.56.0.windows.4) tested whether a private MSYS runtime could replace the shipping backend's Windows debugger. Some prototype fixtures used executable file symlinks, whereas the final release uses ordinary copies.

| Design question | Observation |
| --- | --- |
| Could one physical DLL serve distinct sessions? | Windows mapped the single private DLL while retaining each view's path, allowing six simultaneous sessions to produce six distinct predicted namespaces. [Loader identity, token admission and IPC](evidence/loader-and-shim.md) |
| When can a command release its runtime lease? | Stock DSH's managed range settled while a native child spawned by packaged PowerShell was still running. [Process-lifetime counterexample](evidence/managed-range.md) |
| Which commands worked? | The ordinary-copy and four-file-symlink fixtures produced identical verdicts and exit codes across all 72 trials each, with nine failures defining the accepted limits. [Command and alias matrix](evidence/command-parity.md) |
| What does pinning a generation protect? | A pinned session picked up a replaced upstream helper through a file symlink while its private copy kept the original behavior; new ordinary copies inherited cache permissions and stayed writable even for a read-only source. [Publication, upgrades and copy semantics](evidence/storage.md) |
| Could the same inputs produce the same package? | Two independent deterministic builds of the candidate DLL and two staged tarballs matched byte for byte. [Build and package provenance](evidence/builds.md) |

The [image-load investigation](../copy-backend-performance/evidence/image-loading.md) used these early candidate binaries, while [release verification](../copy-backend-verification/README.md) covers the independently qualified production artifacts. [Reproduction and scope](REPRODUCING.md) · [Analysis index](../README.md)
