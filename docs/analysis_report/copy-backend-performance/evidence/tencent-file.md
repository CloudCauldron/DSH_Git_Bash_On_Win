# Tencent single-file timing check

After a baseline run finished, the owner added a temporary Tencent exception for the private `r/usr/bin/msys-2.0.dll` in one disposable generation. Both runs tested the `6c84a30` tarball using generation `c0e1d3622a394e50` (NTFS file ID `28991922603153532`, DLL SHA-256 `89fb6b5965c3044bb56a3de61345b77bff6e4618440e0f3c82c3338a70becf77`), running all three DSH modes in the same order with two warmups and 12 measured commands per workload and mode through positive managed-range settlement. Defender real-time protection was off in both runs.

| Workload | Tencent entry | Commands | Median (ms) | p95 (ms) | Maximum (ms) | Over 1 s |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Bash builtin | Before | 36 | 334.3 | 400.2 | 403.6 | 0 |
| Bash builtin | Active | 36 | 314.1 | 355.3 | 382.1 | 0 |
| Pipeline | Before | 36 | 449.9 | 587.0 | 610.4 | 0 |
| Pipeline | Active | 36 | 420.1 | 481.1 | 501.0 | 0 |

Latency was lower in the second run, though the baseline already had zero commands over one second. Because this was a single before-and-after pair where cache warming and ordinary run-to-run variation also play a part, it does not justify a permanent cache exclusion.

[Performance study](../README.md) · [Reproduction](../REPRODUCING.md)
