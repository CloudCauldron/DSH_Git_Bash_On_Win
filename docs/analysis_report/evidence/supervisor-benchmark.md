# Supervisor measurements

On 18 November 2026, a Windows 11 x64 laptop with an Intel Core i9-12900HK ran Git for Windows 2.56.0.windows.4, Node 26.12.1 and DSH 0.2.2-rc.2. Each launch used the same warm Git copy, session view, environment and DSH subprocess provider in full-access mode. Timing began after acquiring the runtime and ended at confirmed process exit.

## Original supervisor

The direct run launched Bash. The Node parent launched the same Bash with inherited standard streams and waited for exit. The production supervisor also established a private Job, checked the runtime and processed Windows debug events. Each path ran once to warm up. The table gives the median of nine timed rounds with rotating launch order.

| Work in one Bash invocation | Direct Bash | Node parent | Supervisor | Added vs. direct |
| --- | ---: | ---: | ---: | ---: |
| `printf ok` | 174 ms | 221 ms | 412 ms | 239 ms |
| One external `true.exe`, then `printf ok` | 209 ms | 266 ms | 474 ms | 264 ms |
| 50 sequential `true.exe` children, then `printf ok` | 2,130 ms | 1,652 ms | 3,006 ms | 877 ms |

Differences use the unrounded medians. Direct runs of the 50-child loop ranged from 1.53 to 3.40 seconds. The node-parent range was 1.57–1.84 seconds and the supervisor range was 2.87–4.34 seconds.

Three additional launches per cell measured the reporting Node process. Peak working set includes shared resident pages. CPU time sums user and kernel time.

| Workload | Node parent peak | Supervisor peak | Node parent CPU | Supervisor CPU |
| --- | ---: | ---: | ---: | ---: |
| Builtin | 52.1 MiB | 61.8 MiB | 46 ms | 155 ms |
| One external child | 52.1 MiB | 62.2 MiB | 46 ms | 218 ms |
| 50 external children | 52.1 MiB | 69.0 MiB | 30 ms | 780 ms |

## Skipping redundant thread-context writes

The supervisor began comparing live thread state with the desired settings before writing during DLL loads. Live state matters because a thread can lose settings during MSYS startup. The comparison ran both builds, direct Bash and the Node parent in rotating order for 12 rounds. Each supervisor ran first in six paired comparisons. Counts of context writes came from a separate instrumented launch per build and workload.

| Workload | Median before | Median after | Pairs faster after (of 12) | Writes before | Writes after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Builtin | 426 ms | 434 ms | 6 | 86 | 4 |
| One external child | 458 ms | 459 ms | 5 | 165 | 10 |
| 50 external children | 3,296 ms | 3,333 ms | 7 | 3,847 | 282 |

For the 50-child loop the median paired difference favored the change by 53 ms. Individual pairs ranged from 2.14 seconds faster to 0.78 seconds slower. Median supervisor CPU time moved from 718 to 702 ms and peak working set from 69.0 to 69.1 MiB. The reduction in context writes was repeatable across the three workloads. The wall-clock results varied in both directions.

## Phase 4 packed runtime

The independent audit measured the installed release at `67d8a04` on Windows 11 x64 build 26200, Windows Node 26.12.1, DSH 0.2.2-rc.5 and ucrt64 Git 2.56.0.windows.4. The tarball SHA-256 was `849b7ea2a2b83001af04afe955ccac80edbb5c344465359a03ccf3eeccedf02f`. Defender reported antivirus and real-time protection off before and after. The shipping comparison used revision `33fa0a9039d193452ccab7eefc222144437f8aaa` and owned Git files. Direct Bash ran on the owned tree in full access. The original Phase 4 measurements are retained at `6c84a30`.

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

<details>
<summary>All timed samples in round order, milliseconds</summary>

Values are rounded to 0.01 ms.

| Cell | 24 samples |
| --- | --- |
| danger-full-access/builtin/copy | 150.66, 141.12, 140.38, 143.31, 160.50, 151.08, 158.53, 150.31, 144.08, 138.67, 183.44, 172.62, 219.00, 147.43, 161.33, 140.76, 154.49, 150.31, 153.46, 144.15, 176.88, 160.53, 151.84, 166.46 |
| danger-full-access/builtin/direct | 159.01, 137.29, 152.48, 149.34, 166.48, 155.90, 168.92, 149.02, 150.79, 145.87, 167.85, 156.18, 176.11, 142.52, 157.28, 139.71, 148.98, 130.80, 140.13, 136.80, 146.00, 153.39, 140.10, 135.91 |
| danger-full-access/builtin/shipping | 434.29, 397.45, 409.05, 422.69, 419.70, 409.65, 423.88, 443.18, 420.83, 425.95, 440.67, 436.26, 477.00, 411.99, 436.99, 414.14, 426.92, 412.99, 429.14, 410.24, 421.35, 494.28, 421.19, 420.04 |
| danger-full-access/git/copy | 206.49, 186.88, 172.30, 189.03, 159.96, 179.48, 205.45, 200.97, 191.45, 165.14, 170.73, 281.05, 216.77, 184.86, 304.21, 177.01, 180.08, 176.69, 175.83, 170.65, 215.06, 185.24, 168.23, 196.05 |
| danger-full-access/git/direct | 216.58, 178.88, 180.48, 188.14, 179.21, 194.39, 172.39, 195.90, 158.71, 157.11, 174.30, 191.58, 198.82, 184.74, 209.13, 170.24, 164.29, 187.99, 192.56, 171.96, 193.64, 175.64, 168.02, 189.07 |
| danger-full-access/git/shipping | 470.64, 455.75, 473.92, 471.29, 462.77, 415.44, 439.57, 454.89, 441.94, 462.13, 443.29, 460.48, 549.11, 485.39, 598.03, 430.91, 463.75, 455.08, 446.15, 454.94, 474.78, 567.50, 459.67, 455.79 |
| danger-full-access/pipeline/copy | 261.76, 234.86, 248.27, 299.79, 277.00, 266.84, 268.48, 242.70, 241.56, 255.12, 295.79, 267.53, 342.10, 263.34, 340.33, 278.22, 260.48, 273.80, 245.28, 239.59, 281.52, 269.37, 247.11, 286.50 |
| danger-full-access/pipeline/direct | 314.54, 256.44, 295.32, 279.08, 198.75, 247.87, 252.69, 217.14, 217.57, 203.44, 234.28, 293.84, 325.09, 250.23, 334.84, 214.15, 217.06, 230.49, 227.76, 237.12, 303.15, 249.11, 246.75, 251.20 |
| danger-full-access/pipeline/shipping | 615.41, 541.88, 566.82, 635.77, 641.25, 554.04, 574.54, 551.73, 588.86, 552.78, 588.05, 671.88, 705.46, 581.50, 613.04, 514.56, 565.70, 545.28, 538.96, 504.91, 609.80, 687.15, 563.10, 548.41 |
| read-only/builtin/copy | 338.62, 335.79, 314.67, 336.97, 319.28, 320.43, 303.16, 325.92, 304.47, 303.17, 329.35, 352.54, 351.11, 310.99, 326.28, 316.08, 320.72, 323.80, 323.39, 312.04, 321.98, 313.69, 338.28, 324.92 |
| read-only/builtin/shipping | 601.05, 629.71, 585.97, 631.90, 575.18, 567.73, 586.09, 580.08, 565.42, 580.53, 614.78, 618.90, 639.41, 590.63, 557.34, 579.94, 593.67, 583.57, 605.07, 563.75, 623.60, 565.78, 627.76, 583.89 |
| read-only/git/copy | 393.61, 341.63, 328.82, 333.58, 340.99, 377.98, 340.59, 366.96, 348.77, 337.20, 351.74, 432.49, 372.12, 370.26, 344.00, 330.62, 348.30, 370.05, 337.74, 334.56, 362.65, 337.49, 332.25, 344.70 |
| read-only/git/shipping | 628.06, 651.15, 632.16, 609.37, 624.26, 661.04, 593.96, 660.42, 627.19, 616.22, 596.46, 667.81, 702.03, 636.46, 645.57, 615.77, 616.99, 604.51, 587.89, 612.04, 675.80, 637.41, 644.37, 618.20 |
| read-only/pipeline/copy | 458.82, 455.49, 418.06, 447.77, 440.94, 452.67, 434.31, 463.95, 476.67, 420.33, 411.76, 452.98, 482.67, 388.50, 373.46, 417.20, 450.15, 442.08, 447.70, 428.51, 438.62, 427.24, 434.88, 438.34 |
| read-only/pipeline/shipping | 765.81, 739.45, 759.35, 751.66, 725.64, 735.86, 769.64, 841.08, 744.18, 773.71, 761.88, 792.08, 923.31, 748.25, 694.40, 713.01, 751.81, 744.27, 723.49, 747.60, 757.03, 735.31, 763.33, 745.04 |
| workspace-write/builtin/copy | 344.39, 298.36, 309.56, 306.49, 327.92, 334.06, 311.33, 361.37, 317.66, 314.93, 350.09, 342.35, 365.51, 336.88, 305.81, 305.40, 301.62, 327.45, 316.46, 310.89, 324.07, 316.14, 329.90, 322.58 |
| workspace-write/builtin/shipping | 608.22, 598.51, 580.94, 571.00, 588.24, 619.65, 602.23, 606.04, 590.64, 605.66, 621.72, 671.17, 610.11, 603.14, 597.63, 584.61, 598.38, 575.65, 618.59, 595.09, 637.39, 696.14, 588.38, 566.47 |
| workspace-write/git/copy | 354.68, 326.10, 337.48, 356.78, 418.95, 327.44, 368.36, 333.05, 344.59, 326.95, 372.53, 373.42, 496.22, 342.91, 367.03, 332.61, 348.56, 326.68, 328.57, 339.81, 412.04, 350.47, 332.12, 370.30 |
| workspace-write/git/shipping | 674.82, 626.60, 747.21, 615.17, 668.20, 625.27, 660.64, 602.64, 648.63, 644.87, 714.36, 674.23, 833.95, 635.52, 631.94, 643.07, 622.27, 582.99, 618.43, 589.03, 634.65, 668.28, 633.93, 637.84 |
| workspace-write/pipeline/copy | 420.42, 448.04, 382.04, 392.87, 444.25, 414.14, 453.21, 397.36, 435.60, 427.97, 462.11, 495.66, 533.11, 419.02, 452.58, 395.84, 429.60, 426.04, 425.00, 404.76, 442.44, 443.61, 431.72, 449.70 |
| workspace-write/pipeline/shipping | 790.86, 744.59, 774.13, 703.94, 836.72, 743.48, 729.59, 756.84, 718.92, 759.74, 785.17, 873.07, 874.62, 792.46, 793.98, 703.01, 703.25, 789.26, 747.00, 770.09, 751.32, 815.49, 805.09, 783.02 |
| Ready read-only session use | 1.00, 0.96, 0.92, 0.89, 1.09, 1.03, 1.11, 1.16, 1.00, 1.09, 1.48, 1.05, 1.06, 1.19, 0.91, 0.90, 1.04, 0.98, 0.95, 0.98, 1.01, 1.14, 1.04, 1.00 |

</details>

### Tencent file-only timing check

The owner added a temporary Tencent exception for the private `r/usr/bin/msys-2.0.dll` in one disposable generation after the baseline finished. Both runs used the tarball verified at `6c84a30`, generation `c0e1d3622a394e50`, NTFS file ID `28991922603153532` and DLL SHA-256 `89fb6b5965c3044bb56a3de61345b77bff6e4618440e0f3c82c3338a70becf77`. The three DSH modes ran in the same sequence. Each workload had two warmups and 12 measured commands per mode. Timing included positive managed-range settlement. Defender reported real-time protection off in both runs.

| Workload | Tencent entry | Commands | Median (ms) | p95 (ms) | Maximum (ms) | Over 1 s |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Bash builtin | Before | 36 | 334.3 | 400.2 | 403.6 | 0 |
| Bash builtin | Active | 36 | 314.1 | 355.3 | 382.1 | 0 |
| Pipeline | Before | 36 | 449.9 | 587.0 | 610.4 | 0 |
| Pipeline | Active | 36 | 420.1 | 481.1 | 501.0 | 0 |

The second run had lower latency. The original one-second stalls were already absent in the baseline. With a single before/after pair, cache warming and ordinary run-to-run variation can also contribute to the difference. This check gives no basis for a permanent cache exclusion.
