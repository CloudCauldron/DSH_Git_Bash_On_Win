# Windows Git Bash supervisor benchmark

## DLL-load optimization

Skipping redundant thread-context writes removed about 93–95% of those writes
during DLL loads. The paired Windows benchmark showed no consistent change in
elapsed time.

| Workload | Median before | Median after | Faster after, out of 12 pairs | DLL-load context writes, before → after |
|---|---:|---:|---:|---:|
| Bash builtin | 426 ms | 434 ms | 6 | 86 → 4 |
| One external child | 458 ms | 459 ms | 5 | 165 → 10 |
| 50 sequential external children | 3,296 ms | 3,333 ms | 7 | 3,847 → 282 |

On 2026-11-18, the same warm fixture ran the original supervisor, the optimized
supervisor, direct Bash and the minimal Node parent in rotating order for 12
rounds per workload. Each supervisor ran first in six of their 12 comparisons.
The table gives the median for each build. Thread-context write counts came
from one separate instrumented launch per build and workload. Thread and event
counts can vary between launches.

For the 50-child loop, the median paired difference was 53 ms faster after the
change, but individual differences ranged from 2.14 s faster to 0.78 s slower.
Median supervisor CPU time was 718 ms before and 702 ms after across three
separate samples. Peak working set was 69.0 and 69.1 MiB, respectively.

The handler still reads each tracked thread's live breakpoint settings. A
thread can lose those settings during MSYS startup while its desired hook
addresses stay the same. Checking the live state let the optimized supervisor
skip 3,498 of 3,780 writes it would otherwise have made in the instrumented
50-child run. Timings cover the full-access fixture described below.

## Original baseline

On a Windows 11 x64 laptop with a warm runtime, the original supervisor added
239 ms to the median elapsed time for a Bash builtin, 264 ms for one short-lived
external process, and 877 ms for a loop of 50 external processes. The supervisor
process itself peaked at about 62–69 MiB across those workloads.

### Elapsed time

Medians of nine launches per cell. The difference and ratio use the unrounded
supervised and direct medians.

| Workload in one Bash invocation | Direct Bash | Minimal Node parent | Production supervisor | Added vs. direct | Time ratio vs. direct |
|---|---:|---:|---:|---:|---:|
| `printf ok` builtin | 174 ms | 221 ms | 412 ms | +239 ms | 2.38× |
| One `/usr/bin/true.exe`, then the builtin | 209 ms | 266 ms | 474 ms | +264 ms | 2.26× |
| 50 sequential `/usr/bin/true.exe` children, then the builtin | 2,130 ms | 1,652 ms | 3,006 ms | +877 ms | 1.41× |

The loop had the widest spread. Direct launches ranged from 1.53 to 3.40 s,
the minimal Node parent from 1.57 to 1.84 s, and supervised launches from
2.87 to 4.34 s. These samples support a launch-cost comparison on this host.
Dividing the loop difference by 50 would mix fixed startup costs and run-to-run
variation into a per-child estimate.

### Supervisor process resources

Each cell is the median of three additional launches. A Node exit hook read
`process.resourceUsage()` for the reporting PID. Peak working set measures
resident memory and includes shared pages. CPU time sums user and kernel time.
Bash, its children and the parent DSH host have separate process counters.

| Workload | Minimal Node peak | Supervisor peak | Minimal Node CPU | Supervisor CPU |
|---|---:|---:|---:|---:|
| Builtin | 52.1 MiB | 61.8 MiB | 46 ms | 155 ms |
| One external child | 52.1 MiB | 62.2 MiB | 46 ms | 218 ms |
| 50 external children | 52.1 MiB | 69.0 MiB | 30 ms | 780 ms |

## Method and reproduction

Measured on 2026-11-18 with an Intel Core i9-12900HK, Windows build 26200,
Node 26.12.1, Git for Windows 2.56.0.windows.4 and DSH 0.2.2-rc.2.

All three paths used the same DSH subprocess provider, copied Git installation,
private runtime generation, working directory, Bash arguments and effective
runtime environment. The direct path started Bash as the managed process. The
minimal Node parent started the same Bash with inherited standard streams and
waited for exit. The production path started the compiled plugin launcher with
all its usual checks and debugger handling.

The benchmark used `danger-full-access` inside a disposable DSH fixture so all
three paths could execute the same workload. Restricted modes perform additional
compatibility work and need separate measurements. The timed interval covered
process creation through confirmed exit, including Node startup on both Node
paths. Runtime preparation and lease acquisition finished before timing. The
production figures include private Job setup, admission and compatibility work
alongside Windows debug events.

Each path ran once to warm up before nine rounds with rotating launch order.
Every invocation had to return zero and print the expected marker. Resource
sampling ran separately to keep the exit hook out of the timing measurements.
The fixture released its lease, purged its cache, and verified source file
contents, ACLs and hardlink counts on teardown.

Run from the checkout in Windows-native Git Bash with the supported DSH and Git
installations available. The benchmark prints one JSON observation per sample.

```bash
pnpm install --ignore-scripts --frozen-lockfile
pnpm build
node --test test/benchmark-supervisor.ts
```
