# Windows design experiments

On November 21–22, 2026, the project tested whether a private MSYS runtime could replace the Windows debugger used by the shipping backend. These were proof-of-concept runs on Windows 11 build 26200.9974, with DSH 0.2.2-rc.5, native Node 26.12.1 and ucrt64 Git 2.56.0.windows.4. Some fixtures used executable file symlinks. The eventual release provisions ordinary copies.

| Design question | Observation |
| --- | --- |
| Could one physical DLL serve distinct sessions? | Windows mapped the private DLL and retained separate view paths. Six simultaneous sessions subsequently produced six predicted namespaces. [Loader identity, token admission and IPC](evidence/loader-and-shim.md) |
| When can a command release its runtime lease? | Stock DSH’s managed range settled while a native child of packaged PowerShell remained alive. [Process-lifetime counterexample](evidence/managed-range.md) |
| Which commands worked? | The copy and four-file-symlink fixtures produced identical verdicts and exit codes across 72 cases each. Nine observed failures define the accepted limits. [Command and alias matrix](evidence/command-parity.md) |
| What does pinning a generation protect? | A pinned session ran a changed upstream helper through a file symlink. Its private copy kept the old behavior. New ordinary files inherited cache permissions and remained writable with a read-only source. [Publication, upgrades and copy semantics](evidence/storage.md) |
| Could the same inputs produce the same package? | Two independent deterministic builds of the actual candidate DLL and two staged archives matched byte for byte. [Build and package provenance](evidence/builds.md) |

The [image-load investigation](../copy-backend-performance/evidence/image-loading.md) used the early candidate binaries. The [release verification](../copy-backend-verification/README.md) identifies the independently qualified production artifacts. [Reproduction and scope](REPRODUCING.md) · [Analysis index](../README.md)
