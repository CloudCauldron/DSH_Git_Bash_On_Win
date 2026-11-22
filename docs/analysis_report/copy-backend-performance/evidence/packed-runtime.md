# Packed runtime timings

## Independent audit

The independent audit measured the installed release at `67d8a04` (tarball SHA-256 `849b7ea2a2b83001af04afe955ccac80edbb5c344465359a03ccf3eeccedf02f`) on Windows 11 x64 build 26200 with Windows Node 26.12.1, DSH 0.2.2-rc.5, and `ucrt64` Git 2.56.0.windows.4. Defender antivirus and real-time protection were reported off before and after the run. The shipping comparison used revision `33fa0a9039d193452ccab7eefc222144437f8aaa` on owned Git files, with direct Bash on the same owned tree as a full-access baseline.

The three workloads were `echo ok`, a command substitution containing a three-stage `printf | grep | wc` pipeline, and `git --version`. Each cell ran two excluded warmups and 24 timed rounds in balanced lane order, measuring from Shell resolution through command result, completion, and positive managed-range settlement. Every timed command returned its expected output and exit code.

Each cell gives median / nearest-rank p95 / maximum in milliseconds, followed by the count over one second.

| Mode | Workload | Copy | Shipping | Direct |
| --- | --- | --- | --- | --- |
| danger-full-access | builtin | 151.5 / 183.4 / 219.0 / 0 | 422.0 / 477.0 / 494.3 / 0 | 149.2 / 168.9 / 176.1 / 0 |
| danger-full-access | pipeline | 267.2 / 340.3 / 342.1 / 0 | 570.7 / 687.1 / 705.5 / 0 | 248.5 / 325.1 / 334.8 / 0 |
| danger-full-access | git | 185.1 / 281.1 / 304.2 / 0 | 460.1 / 567.5 / 598.0 / 0 | 182.6 / 209.1 / 216.6 / 0 |
| read-only | builtin | 322.7 / 351.1 / 352.5 / 0 | 586.0 / 631.9 / 639.4 / 0 | — |
| read-only | pipeline | 439.8 / 476.7 / 482.7 / 0 | 750.0 / 841.1 / 923.3 / 0 | — |
| read-only | git | 344.4 / 393.6 / 432.5 / 0 | 627.6 / 675.8 / 702.0 / 0 | — |
| workspace-write | builtin | 320.1 / 361.4 / 365.5 / 0 | 600.4 / 671.2 / 696.1 / 0 | — |
| workspace-write | pipeline | 430.7 / 495.7 / 533.1 / 0 | 772.1 / 873.1 / 874.6 / 0 | — |
| workspace-write | git | 346.6 / 419.0 / 496.2 / 0 | 636.7 / 747.2 / 834.0 / 0 | — |

Commands over one second totaled 0/216 on the copy backend, 0/216 on the shipping backend, and 0/72 on direct Bash.

| Separate measurement | Samples or result |
| --- | --- |
| Fresh generation preparation, ms | 399.01, 338.86, 334.80, 344.29, 322.71 |
| First warm admission in five fresh Node processes, ms | 23.93, 26.14, 26.29, 24.40, 25.47 |
| Ready read-only session use, ms | Median 1.02, p95 1.19, maximum 1.48 |
| Logical flat payload | 356 files and 92,929,414 bytes per generation |
| After a rebuild with an active pin, then releasing it | Two generations and 185,858,828 payload bytes. The following rebuild left one generation. |

Warm admission timed each fresh process's first call to the packed preparation code through pin acquisition (after Node startup and module import), confirming that the selector stayed byte-identical across every restart. Ready-use timing covered acquiring a use, canonicalizing and checking workspace overlap, admitting the reused view, and releasing the use, excluding shell startup. Payload totals count logical flat file bytes and omit filesystem allocation overhead, junctions, and cache metadata.

[All 504 audit samples and cache timings](audit-samples.json)

## Initial release qualification

An earlier run at `6c84a30` (archive SHA-256 `63e19312681d91493712c137ae9f6a067197f96cdb24272b480e150b3a7d6a29`, before the final README-only edits) used the same host, Git and shipping revisions, workloads, round counts, timing boundaries, and Defender-off state, except that warm admission ran inside the existing Node process.

| Mode | Workload | Copy | Shipping | Direct |
| --- | --- | --- | --- | --- |
| danger-full-access | builtin | 156.7 / 208.1 / 242.7 / 0 | 422.1 / 575.5 / 641.5 / 0 | 153.0 / 206.7 / 213.4 / 0 |
| danger-full-access | pipeline | 264.5 / 335.8 / 482.9 / 0 | 583.5 / 657.0 / 678.7 / 0 | 250.8 / 337.1 / 371.0 / 0 |
| danger-full-access | git | 191.5 / 242.7 / 352.4 / 0 | 466.3 / 608.1 / 645.2 / 0 | 189.3 / 229.4 / 258.2 / 0 |
| read-only | builtin | 329.5 / 383.8 / 427.9 / 0 | 595.6 / 713.5 / 731.3 / 0 | — |
| read-only | pipeline | 446.3 / 543.9 / 801.6 / 0 | 763.2 / 906.1 / 910.3 / 0 | — |
| read-only | git | 358.9 / 417.2 / 483.8 / 0 | 638.1 / 807.9 / 966.0 / 0 | — |
| workspace-write | builtin | 332.5 / 444.9 / 545.5 / 0 | 604.9 / 717.3 / 723.7 / 0 | — |
| workspace-write | pipeline | 455.4 / 543.1 / 562.0 / 0 | 775.1 / 930.4 / 1827.6 / 1 | — |
| workspace-write | git | 367.1 / 427.5 / 503.9 / 0 | 644.3 / 750.5 / 1154.4 / 1 | — |

All 216 copy commands and 72 full-access direct Bash commands finished within one second, while 2 of 216 shipping commands exceeded one second.

| Separate measurement | Samples or result |
| --- | --- |
| Fresh generation preparation, ms | 389.68, 330.82, 336.92, 349.04, 324.59 |
| Warm admission after closing the prior pin, ms | 13.33, 11.93, 11.34, 11.51, 11.64 |
| Ready read-only session use, ms | Median 1.00, p95 1.23, maximum 2.43 |
| Logical flat payload | 356 files and 92,929,414 bytes per generation |
| Retained after rebuilding with an active pin, then releasing it | Two generations, 185,858,828 payload bytes. The following rebuild left one generation. |

Ready-use timing and payload totals use the same measurement boundaries as the audit above.

[All 504 initial samples and cache timings](release-samples.json)

## Cold-copy provisioning

Before executor cutover, a standalone five-destination benchmark timed discovery through layout creation, private MSYS patching, file writes, admitted junctions, and final handle closure from the existing 355-file `ucrt64` source (92,906,374 bytes), excluding selector publication and shell launch. Defender real-time protection was off at both endpoints.

| Provisioning series | Five elapsed times, ms |
| --- | --- |
| First qualification | 366.26, 338.44, 324.92, 331.77, 325.11 |
| Audited build | 361.37, 322.61, 344.02, 423.72, 394.28 |

Because even the slowest sample in the first series took just 7.33% of a five-second budget (3.66% of a ten-second budget), sequential copying with per-file cancellation was fast enough without parallel copy complexity. Provisioning latency under active Defender remains unmeasured.

[Performance study](../README.md) · [Reproduction](../REPRODUCING.md)
