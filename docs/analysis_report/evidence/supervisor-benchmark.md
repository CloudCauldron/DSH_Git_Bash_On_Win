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

Windows 11 x64 build 26200, native Node 26.12.1, DSH 0.2.2-rc.5 and ucrt64 Git 2.56.0.windows.4. Both Defender antivirus and real-time protection reported off before and after. The benchmark exercised the installed ordinary-copy package. The comparison used the emitted backend from revision `33fa0a9039d193452ccab7eefc222144437f8aaa` and an owned copy of Git. Direct Bash ran on the owned Git tree in full access. Each command started a fresh Bash through the DSH shell.

The three workloads were `echo ok`, a command substitution with a three-stage `printf | grep | wc` pipeline, and `git --version`. Each cell had two excluded warmups and 24 timed rounds. Lane order was balanced within each cell. Timing began at Shell resolution and included result, completion and positive managed-range settlement. Every timed command returned its expected output and exit code.

Each table cell gives median, nearest-rank p95 and maximum in milliseconds, followed by the count over one second.

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

<details>
<summary>All timed samples in round order, milliseconds</summary>

Values are rounded to 0.01 ms.

| Cell | 24 samples |
| --- | --- |
| danger-full-access/builtin/copy | 196.81, 208.09, 151.20, 153.57, 184.00, 151.72, 148.77, 176.00, 197.85, 172.59, 166.39, 242.69, 158.18, 145.28, 158.59, 155.19, 177.60, 150.24, 164.36, 148.50, 147.77, 143.94, 150.58, 151.74 |
| danger-full-access/builtin/direct | 155.50, 206.69, 180.61, 157.95, 142.98, 160.25, 140.98, 141.11, 179.18, 157.49, 144.51, 213.42, 136.81, 150.54, 157.13, 164.27, 189.53, 137.73, 168.13, 141.93, 148.28, 145.92, 142.77, 142.47 |
| danger-full-access/builtin/shipping | 433.44, 553.73, 424.54, 391.57, 415.81, 411.38, 380.23, 391.96, 575.53, 406.84, 437.00, 641.51, 380.97, 442.83, 423.36, 452.99, 420.90, 428.34, 423.41, 411.66, 407.22, 432.92, 388.02, 410.44 |
| danger-full-access/git/copy | 190.60, 191.30, 220.85, 166.62, 191.36, 191.61, 187.12, 172.93, 203.67, 217.61, 165.41, 240.12, 188.87, 202.81, 352.37, 181.84, 187.27, 200.03, 173.16, 242.66, 200.32, 200.19, 165.75, 199.96 |
| danger-full-access/git/direct | 192.43, 172.54, 209.11, 175.63, 166.88, 190.21, 184.30, 171.99, 200.38, 193.12, 158.52, 189.63, 163.50, 203.73, 258.16, 162.20, 164.44, 195.89, 162.70, 215.62, 179.25, 229.40, 195.33, 189.05 |
| danger-full-access/git/shipping | 481.20, 465.00, 433.35, 447.32, 485.56, 446.35, 433.67, 441.65, 645.17, 486.56, 553.12, 483.42, 470.56, 460.09, 608.09, 467.52, 457.41, 503.89, 443.56, 457.54, 455.98, 477.94, 451.39, 497.17 |
| danger-full-access/pipeline/copy | 259.21, 335.83, 262.31, 256.73, 311.67, 262.45, 238.99, 285.65, 328.13, 284.11, 268.83, 301.42, 267.09, 263.46, 482.87, 245.89, 265.58, 258.10, 225.26, 259.54, 252.96, 316.48, 267.29, 253.90 |
| danger-full-access/pipeline/direct | 293.11, 276.84, 265.22, 270.47, 272.01, 229.14, 219.11, 235.42, 250.16, 288.14, 231.29, 370.97, 249.45, 251.47, 302.20, 337.09, 213.14, 218.15, 214.17, 301.53, 260.83, 214.06, 212.92, 242.05 |
| danger-full-access/pipeline/shipping | 633.06, 656.97, 552.50, 556.63, 623.86, 626.56, 537.45, 592.48, 678.72, 630.09, 582.14, 582.54, 549.88, 582.75, 649.95, 549.73, 586.26, 584.28, 551.03, 565.55, 585.85, 546.97, 569.00, 616.25 |
| read-only/builtin/copy | 331.04, 340.20, 327.27, 328.00, 333.04, 316.13, 316.00, 333.54, 340.10, 332.35, 314.23, 427.94, 316.21, 342.59, 361.60, 296.77, 383.83, 342.09, 326.92, 323.30, 312.10, 332.11, 314.13, 325.42 |
| read-only/builtin/shipping | 637.36, 571.40, 596.22, 580.29, 635.20, 606.24, 581.38, 595.04, 731.34, 584.92, 582.89, 703.79, 582.44, 622.02, 713.52, 558.49, 671.06, 641.00, 573.91, 559.42, 565.86, 584.52, 613.45, 611.60 |
| read-only/git/copy | 348.97, 368.90, 388.56, 344.11, 387.06, 343.72, 349.44, 362.15, 331.63, 343.91, 355.93, 417.23, 415.31, 483.82, 332.99, 328.93, 396.82, 400.63, 369.12, 326.95, 350.36, 379.85, 330.47, 361.89 |
| read-only/git/shipping | 637.87, 624.26, 764.29, 636.50, 660.51, 621.04, 604.36, 621.99, 665.95, 679.27, 623.01, 807.85, 650.34, 966.00, 607.12, 698.96, 662.71, 638.34, 655.31, 603.27, 627.59, 631.84, 634.54, 640.06 |
| read-only/pipeline/copy | 425.12, 410.77, 801.57, 508.96, 485.73, 440.02, 477.14, 443.31, 450.52, 437.59, 448.25, 543.88, 433.18, 501.13, 422.26, 442.71, 470.18, 483.40, 438.13, 445.16, 451.02, 413.57, 405.53, 447.38 |
| read-only/pipeline/shipping | 792.45, 794.47, 778.55, 773.05, 850.05, 759.86, 758.24, 757.38, 906.08, 866.47, 714.97, 816.06, 718.58, 873.62, 745.89, 744.61, 910.26, 795.59, 761.94, 744.57, 758.62, 732.16, 763.71, 762.59 |
| workspace-write/builtin/copy | 325.95, 330.38, 369.89, 360.24, 545.47, 321.88, 331.95, 388.54, 313.57, 333.36, 334.31, 444.94, 386.28, 329.32, 323.12, 319.01, 336.24, 341.50, 332.95, 304.00, 354.24, 321.89, 325.47, 331.03 |
| workspace-write/builtin/shipping | 577.71, 606.01, 597.99, 598.18, 723.72, 591.59, 553.73, 637.62, 606.35, 580.01, 575.56, 717.31, 617.78, 599.82, 587.74, 577.82, 678.06, 667.67, 608.88, 603.72, 614.60, 599.95, 626.35, 625.17 |
| workspace-write/git/copy | 374.70, 406.93, 392.23, 352.34, 349.67, 393.60, 367.36, 378.22, 342.72, 327.57, 366.87, 503.86, 342.61, 336.19, 386.24, 427.46, 368.66, 388.11, 364.95, 342.74, 367.26, 331.73, 359.40, 362.83 |
| workspace-write/git/shipping | 652.86, 750.51, 630.85, 621.80, 714.99, 648.24, 632.10, 673.90, 617.40, 654.52, 637.24, 1154.42, 634.48, 617.49, 614.13, 748.63, 624.36, 605.52, 643.47, 660.56, 677.17, 614.41, 645.13, 698.79 |
| workspace-write/pipeline/copy | 415.01, 503.63, 428.55, 449.11, 562.03, 471.65, 445.82, 456.51, 438.01, 394.50, 406.99, 463.18, 460.94, 435.63, 543.07, 490.03, 457.48, 458.98, 404.83, 432.63, 477.97, 456.88, 419.67, 454.32 |
| workspace-write/pipeline/shipping | 748.94, 778.07, 744.38, 762.11, 930.42, 763.79, 799.63, 906.98, 822.10, 776.20, 740.91, 856.60, 841.23, 749.35, 1827.63, 776.66, 764.35, 764.85, 764.99, 768.85, 802.11, 773.97, 759.02, 797.89 |
| Ready read-only session use | 2.43, 1.12, 1.23, 1.23, 1.07, 1.16, 1.19, 1.02, 0.98, 1.07, 0.95, 1.18, 1.12, 0.97, 0.86, 0.91, 0.90, 0.94, 0.99, 0.96, 0.99, 1.00, 0.98, 0.93 |

</details>
