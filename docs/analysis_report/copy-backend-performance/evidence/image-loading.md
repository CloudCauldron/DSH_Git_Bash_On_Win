# Prototype pipeline stalls and Windows image loading

On November 21, 2026, a Windows 11 x64 laptop (build 26200.9974, Core i9-12900HK) ran DSH 0.2.2-rc.5, Node 26.12.1 and ucrt64 Git 2.56.0.windows.4. The candidate used four executable file symlinks, a prebuilt private MSYS image and the original compatibility DLL. All retests retained those images. [Prototype binary digests](../../refactor-design-validation/evidence/builds.md)

## Warm commands on the prototype

The candidate used a prepared view. The shipping 0.2.2 supervisor used a hardlink cache on an owned Git copy. Direct Bash ran on the owned tree in full access. The two direct restricted controls failed signal-pipe initialization with `0xC0000142` and were excluded. Timing ran from Shell resolution to command result, completion and positive managed-range settlement. A fixed seed ordered workload and policy groups, with balanced lane order, two excluded warmups and 24 timed rounds in each cell.

The table gives median / nearest-rank p95 / minimum / maximum in milliseconds. The difference and percentage use unrounded medians. The last column counts paired rounds in which the candidate finished sooner.

| DSH mode | Workload | Direct native Bash | Shipping supervisor | Candidate | Δ ms | Median reduction | Faster |
|---|---|---|---|---|---|---|---|
| danger-full-access | builtin | 165 / 187 / 140 / 196 | 447 / 478 / 413 / 517 | 166 / 738 / 137 / 751 | 281 | 62.9% | 21/24 |
| danger-full-access | pipeline | 277 / 399 / 219 / 421 | 622 / 720 / 541 / 773 | 293 / 1421 / 264 / 5428 | 329 | 52.9% | 20/24 |
| danger-full-access | git | 202 / 277 / 157 / 290 | 482 / 535 / 429 / 550 | 205 / 763 / 172 / 768 | 278 | 57.6% | 20/24 |
| read-only | builtin | Unsupported | 617 / 710 / 570 / 725 | 334 / 888 / 297 / 904 | 283 | 45.9% | 20/24 |
| read-only | pipeline | Unsupported | 779 / 878 / 705 / 923 | 462 / 1568 / 406 / 1612 | 317 | 40.7% | 21/24 |
| read-only | git | Unsupported | 647 / 757 / 588 / 759 | 374 / 617 / 327 / 919 | 274 | 42.3% | 23/24 |
| workspace-write | builtin | Unsupported | 635 / 695 / 569 / 708 | 341 / 896 / 310 / 953 | 294 | 46.3% | 18/24 |
| workspace-write | pipeline | Unsupported | 814 / 932 / 706 / 940 | 496 / 1612 / 403 / 1732 | 318 | 39.1% | 20/24 |
| workspace-write | git | Unsupported | 674 / 741 / 614 / 763 | 400 / 937 / 334 / 968 | 274 | 40.6% | 18/24 |

The candidate won 181/216 pairs. Across the nine equally weighted cells it took 102.19 s, compared with 138.66 s for shipping, saving 36.47 s (26.3%). Its p95 was higher in eight cells. All ten candidate samples over one second were successful pipelines with empty stderr. They occurred in the second half of the rounds, nine following shipping and one following direct Bash. The original 5,427.9 ms maximum had only end-to-end timing and remains individually unexplained.

A separate builtin control added a command pin, selector, workspace and junction checks around a held owner pin. After 12 pairs per policy the median within-pair increases were 2.3 ms in full access, 1.9 ms in read-only and 0.5 ms in workspace-write. This tested sensitivity to lease handling before the release publisher existed.

## Where the elapsed time went

A marked replay timed DSH confinement and spawn, the first Bash statement, the command-substitution child and range exit. Four of 72 pipelines exceeded one second. The process-time rows cover 33 fast and three slow sampled roots. The other rows cover 68 fast and four slow pipelines. Intervals overlap.

| Candidate pipeline phase | Under 1 s, median ms | Over 1 s, median ms | Slow range, ms |
|---|---|---|---|
| Request start → DSH spawn call | 1 | 1 | 1–2 |
| Inside confinement callback | 1 | 1 | 1–1 |
| Synchronous subprocess spawn API | 11 | 10 | 8–13 |
| Windows root Bash creation → first statement | 23 | 573 | 566–590 |
| First statement → command-substitution child ready | 17 | 539 | 534–542 |
| Inside substitution after child ready (pipeline + wait) | 85 | 150 | 100–216 |
| Substitution complete → last shell marker | 5 | 5 | 3–20 |
| Last shell marker → measured endpoint | 39 | 43 | 37–48 |
| OS root exit → positive range wait | 39 | 45 | 37–47 |

The marked replay had 15/216 candidate commands over one second, including runs with and without process sampling. Shipping and direct had none. The largest clock-anchor residual was 0.066 ms. In an independent replay of the exact unmarked pipeline, all 120 commands succeeded. Full-access matched-stock had 0/20 over one second, deployed executable links 1/20, deployed ordinary copies 5/20 and matched patched MSYS 6/20. The deployed-link fixtures in read-only and workspace-write had 4/20 and 2/20 respectively. Ordinary executable copies could exhibit the same delay.

Builtin-only subshells reproduced the delay before the child's first statement. Of 60 full-access forks per layout, startup exceeded 400 ms for six matched-patched, six deployed-copy and five deployed-link children. Matched stock and the two stock executable-copy and executable-link controls had zero. Typical fork startup was 14–16 ms, and the patched-layout maxima were 543–555 ms.

## File-specific stack evidence

In four full-access snapshots, covering both root and fork child in both deployed layouts, the loader worker was in `LdrpMapDllNtFileName → NtCreateSection` on the private `msys-2.0.dll`. The main thread was in `LdrpInitializeProcess → LdrpDrainWorkQueue → NtWaitForSingleObject`. File arguments were resolved in the same live process, before its first shell marker.

| Fixture / role | Windows PID | Snapshot age ms | File resolved at age ms | First shell statement age ms |
|---|---|---|---|---|
| deployed-link / root | 25460 | 146 | 204 | 566 |
| deployed-link / fork child | 22388 | 154 | 219 | 529 |
| deployed-copy / root | 3612 | 146 | 211 | 567 |
| deployed-copy / fork child | 27564 | 137 | 193 | 544 |

All four workspace-write snapshots showed the same stacks. Three file arguments resolved to private MSYS and one was unavailable. Read-only had the timing signature without a resolved file-handle capture. Diagnostic snapshots were excluded from the timing distributions.

An ordinary native process using inert `LoadLibraryExW` reproduced the half-second step with both the deployed private MSYS file and a fresh byte-identical stock copy. The call skipped import resolution and DLL initialization, so the delay could occur before compatibility code ran. Raw opens, separate section/map controls and the installed stock file did not reproduce it in this small run. Two delayed MSYS process starts can account for a reproduced pipeline tail. No per-driver trace identified what delayed image-section creation inside the kernel.

## Protection comparison

The original host had Tencent reported on (owner reading `0x41000`) and Defender antivirus and real-time protection off. In both retests Security Center reported Tencent `0x40000` at the start and end. In the first retest Defender reported both flags on. In the second, antivirus stayed on and real-time protection was off at both endpoints. The owner selected the active-Defender run as the release record's evidence for that configuration.

| Metric | Tencent reported on | Defender real-time on | Defender real-time off |
|---|---|---|---|
| Candidate pipeline >1 s | 10/72 | 0/72 | 0/72 |
| Candidate pipeline median, ms | 443 | 536 | 417 |
| Candidate pipeline p95, ms | 1612 | 659 | 542 |
| Candidate pipeline max, ms | 5428 | 764 | 577 |
| Exact deployed-link pipeline >1 s | 7/60 | 0/60 | 0/60 |
| Exact deployed-link pipeline p95 / max, ms | 1574 / 1685 | 669 / 706 | 578 / 654 |
| Sampled Bash processes >400 ms to first MSYS visibility | 14/272 | 0/275 | 0/269 |
| Maximum such visibility time, ms | 540 | 83 | 67 |
| All workloads >1 s, direct | 0/72 | 0/72 | 0/72 |
| All workloads >1 s, shipping | 0/216 | 13/216 | 0/216 |
| All workloads >1 s, candidate | 10/216 | 0/216 | 0/216 |

| Main candidate pipeline mode | Original median / p95 / max, ms | Defender on median / p95 / max, ms | Defender real-time off median / p95 / max, ms | Defender real-time off >1 s |
|---|---|---|---|---|
| Full access | 293 / 1421 / 5428 | 327 / 425 / 438 | 263 / 371 / 407 | 0/24 |
| Read-only | 462 / 1568 / 1612 | 576 / 671 / 764 | 436 / 529 / 531 | 0/24 |
| Workspace-write | 496 / 1612 / 1732 | 559 / 627 / 629 | 443 / 573 / 577 | 0/24 |

The exact replay used 20 deployed-link pipelines per mode. Visibility is the sampler’s interval from process creation to first observation of MSYS. Short-lived processes could escape sampling. Each retest kept the binaries, seed, workloads and round counts fixed.

## Fresh-copy inert loads

The table gives first loader-call times in milliseconds. Each retest column contains five independent invocations with new, hash-checked files, followed by shuffled loads. The last column counts all 120 loads per input in the real-time-off repeat.

| Input | Original first load | Defender on, five first loads | Defender real-time off, five first loads | Real-time off >400 ms |
|---|---|---|---|---|
| Installed stock MSYS | 0.46 | 0.51, 0.48, 0.46, 0.45, 0.49 | 0.45, 0.49, 0.47, 0.52, 0.46 | 0/120 |
| Fresh stock MSYS copy | 503.7 | 8.38, 3.11, 0.75, 0.29, 0.82 | 7.98, 0.27, 0.63, 0.74, 0.30 | 0/120 |
| Deployed private MSYS | 507.7 | 10.3, 0.80, 0.89, 0.59, 0.96 | 12.3, 0.28, 0.60, 0.79, 0.29 | 0/120 |
| Fresh private MSYS copy | 513.5 | 0.74, 0.88, 0.93, 0.29, 0.50 | 4.32, 0.34, 1.18, 0.29, 0.31 | 0/120 |
| Deployed shim | 61.5 | 0.70, 0.89, 2.84, 0.39, 0.54 | 16.5, 0.34, 2.59, 3.96, 0.30 | 0/120 |
| Fresh shim copy | 23.8 | 0.71, 0.86, 0.61, 0.37, 0.72 | 7.71, 0.30, 0.79, 1.00, 0.36 | 0/120 |

The half-second signature did not recur under either later configuration. The active-Defender retest also had a higher candidate pipeline median and 13 shipping commands above one second. These were sequential runs on one machine. Cache state, time and host activity varied alongside the reported protection state. The evidence identifies a pre-entry image-load stall, without attributing it to a security product or certifying an exclusion. [Separate release-file comparison](tencent-file.md)

[Performance study](../README.md) · [Reproduction](../REPRODUCING.md)
