# Packed runtime timings

## Independent audit

The independent audit measured the installed release at `67d8a04` on Windows 11 x64 build 26200, Windows Node 26.12.1, DSH 0.2.2-rc.5 and ucrt64 Git 2.56.0.windows.4. The tarball SHA-256 was `849b7ea2a2b83001af04afe955ccac80edbb5c344465359a03ccf3eeccedf02f`. Defender reported antivirus and real-time protection off before and after. The shipping comparison used revision `33fa0a9039d193452ccab7eefc222144437f8aaa` and owned Git files. Direct Bash ran on the owned tree in full access.

The three workloads were `echo ok`, a command substitution with a three-stage `printf | grep | wc` pipeline, and `git --version`. Each cell had two excluded warmups and 24 timed rounds. Lane order was balanced within each cell. Timing began at Shell resolution and included the result, completion and positive managed-range settlement. Every timed command returned its expected output and exit code.

Each cell gives median, nearest-rank p95 and maximum in milliseconds, followed by the count over one second.

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

Commands over one second totaled 0/216 on the copy backend, 0/216 on the shipping backend and 0/72 on direct Bash.

| Separate measurement | Samples or result |
| --- | --- |
| Fresh generation preparation, ms | 399.01, 338.86, 334.80, 344.29, 322.71 |
| First warm admission in five fresh Node processes, ms | 23.93, 26.14, 26.29, 24.40, 25.47 |
| Ready read-only session use, ms | Median 1.02, p95 1.19, maximum 1.48 |
| Logical flat payload | 356 files and 92,929,414 bytes per generation |
| After a rebuild with an active pin, then releasing it | Two generations and 185,858,828 payload bytes. The following rebuild left one generation. |

Each warm sample timed the new process’s first call to the packed preparation code through acquisition of the generation pin. Node startup and module import preceded the timer. The selector stayed byte-identical across every restart. Ready-use timing included acquiring a use, canonicalizing and checking workspace overlap, admitting the reused view and releasing the use. These measurements exclude shell startup. Payload sizes exclude filesystem allocation, junctions and cache metadata.

[All 504 audit samples and cache timings](audit-samples.json)

## Initial release qualification

The run recorded at `6c84a30` used the same host, Git and shipping revision, workloads, round count and timing boundary. Both Defender flags were false at each endpoint. The installed archive had SHA-256 `63e19312681d91493712c137ae9f6a067197f96cdb24272b480e150b3a7d6a29`. Only the two README files changed before the release was packed. This run measured warm admission in the existing Node process.

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

The installed copy completed all 216 timed commands within one second. Two of the 216 shipping commands took longer than one second. Direct Bash contributed 72 full-access samples.

| Separate measurement | Samples or result |
| --- | --- |
| Fresh generation preparation, ms | 389.68, 330.82, 336.92, 349.04, 324.59 |
| Warm admission after closing the prior pin, ms | 13.33, 11.93, 11.34, 11.51, 11.64 |
| Ready read-only session use, ms | Median 1.00, p95 1.23, maximum 2.43 |
| Logical flat payload | 356 files and 92,929,414 bytes per generation |
| Retained after rebuilding with an active pin, then releasing it | Two generations, 185,858,828 payload bytes. The following rebuild left one generation. |

Warm admission ran in the same Node process. Ready-use timing included acquiring a use, canonicalizing and checking workspace overlap, admitting the reused view and releasing the use. These measurements exclude shell startup. Payload sizes exclude filesystem allocation, junctions and cache metadata.

[All 504 initial samples and cache timings](release-samples.json)

## Cold-copy provisioning

Before executor cutover, a separate five-destination test timed discovery through layout creation, private MSYS patching, file writes, admitted junctions and final handle closure. The existing ucrt64 source contained 355 flat files totaling 92,906,374 bytes. Each sample used a fresh destination and the same source. Selector publication and shell launch were outside the interval. Defender real-time protection was off at both endpoints.

| Provisioning series | Five elapsed times, ms |
| --- | --- |
| First qualification | 366.26, 338.44, 324.92, 331.77, 325.11 |
| Audited build | 361.37, 322.61, 344.02, 423.72, 394.28 |

The longest sample in the first series consumed 7.33% of a five-second budget and 3.66% of a ten-second budget. These results supported sequential copying with per-file cancellation. They do not measure active-Defender provisioning.

[Performance study](../README.md) · [Reproduction](../REPRODUCING.md)
