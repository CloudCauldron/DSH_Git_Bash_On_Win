# Runtime performance and image-load delays

**Packaged backend, November 22–23, 2026.** In the independent audit, the ordinary-copy backend had a lower median latency than the shipping supervisor across every policy and workload, and all 504 timed commands settled cleanly. Five first-time warm admissions in fresh Node processes took 23.93–26.29 ms, and reusing a ready read-only session cost 1.02 ms at the median before shell startup. On the measured `ucrt64` installation, two pinned or retained generations occupied 185,858,828 logical payload bytes.

**Earlier prototype, November 21.** Ten of 72 pipelines exceeded one second on the first run. Separate captures showed Windows waiting while mapping the private MSYS DLL before Bash reached its first command, and an inert image load reproduced the same delay. Neither later protection configuration reproduced the one-second pipeline tail; the captures pinpoint where the stall occurred, though its kernel-side cause remains unknown.

| Evidence | Contents |
| --- | --- |
| [Packed runtime timings](evidence/packed-runtime.md) | Initial and audited copy/shipping/direct distributions, provisioning, admission, ready use and storage. All 24 rounds per cell are preserved in the [initial samples](evidence/release-samples.json) and [audit samples](evidence/audit-samples.json). |
| [Prototype image-load investigation](evidence/image-loading.md) | Paired timings, loader stacks, fork and inert-load controls, and the original Tencent, active-Defender and Defender real-time-off comparison. |
| [Tencent single-file comparison](evidence/tencent-file.md) | A separate before/after test on one unchanged private MSYS file in a disposable release generation. The baseline already had zero commands over one second. |

The packed benchmark ran with Defender antivirus and real-time protection off; the active-Defender timings come from the earlier candidate. [Reproduction](REPRODUCING.md) · [Release qualification](../copy-backend-verification/README.md) · [Analysis index](../README.md)
