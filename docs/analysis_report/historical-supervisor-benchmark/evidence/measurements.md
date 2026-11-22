# Supervisor measurements

On November 18, 2026, a Windows 11 x64 laptop (Intel Core i9-12900HK) ran Git for Windows 2.56.0.windows.4, Node 26.12.1, and DSH 0.2.2-rc.2. Every launch shared the same warm Git copy, session view, environment, and DSH subprocess provider in full-access mode, timing from after runtime acquisition through confirmed process exit.

## Original supervisor

Direct launches ran Bash straight from the harness; the Node parent launched Bash with inherited standard streams and waited for exit; and the production supervisor additionally set up a private Job, checked the runtime, and handled Windows debug events. After one warmup per path, the table reports medians across nine timed rounds in rotating launch order.

| Work in one Bash invocation | Direct Bash | Node parent | Supervisor | Added vs. direct |
| --- | ---: | ---: | ---: | ---: |
| `printf ok` | 174 ms | 221 ms | 412 ms | 239 ms |
| One external `true.exe`, then `printf ok` | 209 ms | 266 ms | 474 ms | 264 ms |
| 50 sequential `true.exe` children, then `printf ok` | 2,130 ms | 1,652 ms | 3,006 ms | 877 ms |

Differences use unrounded medians. On the 50-child loop, elapsed times ranged across 1.53–3.40 s for direct Bash, 1.57–1.84 s for the Node parent, and 2.87–4.34 s for the supervisor.

Three additional launches per cell sampled the reporting Node process, where peak working set includes shared resident pages and CPU time sums user and kernel time:

| Workload | Node parent peak | Supervisor peak | Node parent CPU | Supervisor CPU |
| --- | ---: | ---: | ---: | ---: |
| Builtin | 52.1 MiB | 61.8 MiB | 46 ms | 155 ms |
| One external child | 52.1 MiB | 62.2 MiB | 46 ms | 218 ms |
| 50 external children | 52.1 MiB | 69.0 MiB | 30 ms | 780 ms |

## Skipping redundant thread-context writes

To cut debug-event writes, the supervisor was changed to check live thread state before writing during DLL loads (checking live state matters because a thread can lose settings during MSYS startup). Both builds, direct Bash, and the Node parent ran in rotating order for 12 rounds, with each supervisor running first in six pairs, and one separate instrumented launch per build and workload counted context writes.

| Workload | Median before | Median after | Pairs faster after (of 12) | Writes before | Writes after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Builtin | 426 ms | 434 ms | 6 | 86 | 4 |
| One external child | 458 ms | 459 ms | 5 | 165 | 10 |
| 50 external children | 3,296 ms | 3,333 ms | 7 | 3,847 | 282 |

On the 50-child loop, the median paired difference favored the optimization by 53 ms—ranging from 2.14 s faster to 0.78 s slower across individual pairs—while median supervisor CPU moved from 718 to 702 ms and peak working set from 69.0 to 69.1 MiB. Although the drop in context writes repeated across all three workloads, wall-clock times shifted in both directions.

[Supervisor study](../README.md) · [Reproduction](../REPRODUCING.md)
