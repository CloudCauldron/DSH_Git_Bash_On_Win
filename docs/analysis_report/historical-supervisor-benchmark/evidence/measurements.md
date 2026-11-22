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

[Supervisor study](../README.md) · [Reproduction](../REPRODUCING.md)
