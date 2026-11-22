# Runtime performance and image-load delays

**Packaged backend, November 22–23, 2026.** In the independent audit, the ordinary-copy backend had a lower median than the shipping supervisor in every policy and workload. All 504 timed commands settled. Five first admissions in fresh Node processes took 23.93–26.29 ms. The median cost of reusing a ready read-only session was 1.02 ms before shell startup. Two pinned or retained generations occupied 185,858,828 logical payload bytes on the measured ucrt64 installation.

**Earlier prototype, November 21.** Ten of 72 pipelines exceeded one second on the first run. In separate captures, Windows waited while mapping private MSYS before Bash reached its first command. The delay also occurred with an inert image load. Neither of the two later protection configurations reproduced the one-second pipeline tail. The experiments locate the observed stall but leave its kernel-side cause unresolved.

| Evidence | Contents |
| --- | --- |
| [Packed runtime timings](evidence/packed-runtime.md) | Initial and audited copy/shipping/direct distributions, provisioning, admission, ready use and storage. All 24 rounds per cell are preserved in the [initial samples](evidence/release-samples.json) and [audit samples](evidence/audit-samples.json). |
| [Prototype image-load investigation](evidence/image-loading.md) | Paired timings, loader stacks, fork and inert-load controls, and the original Tencent, active-Defender and Defender real-time-off comparison. |
| [Tencent single-file comparison](evidence/tencent-file.md) | A separate before/after test on one unchanged private MSYS file in a disposable release generation. The baseline already had zero commands over one second. |

The packed benchmark ran with Defender antivirus and real-time protection reported off. The active-Defender result concerns the earlier candidate. [Reproduction](REPRODUCING.md) · [Release qualification](../copy-backend-verification/README.md) · [Analysis index](../README.md)
