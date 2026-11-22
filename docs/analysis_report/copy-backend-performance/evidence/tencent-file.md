# Tencent single-file timing check

The owner added a temporary Tencent exception for the private `r/usr/bin/msys-2.0.dll` in one disposable generation after the baseline finished. Both runs used the tarball verified at `6c84a30`, generation `c0e1d3622a394e50`, NTFS file ID `28991922603153532` and DLL SHA-256 `89fb6b5965c3044bb56a3de61345b77bff6e4618440e0f3c82c3338a70becf77`. The three DSH modes ran in the same sequence. Each workload had two warmups and 12 measured commands per mode. Timing included positive managed-range settlement. Defender reported real-time protection off in both runs.

| Workload | Tencent entry | Commands | Median (ms) | p95 (ms) | Maximum (ms) | Over 1 s |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Bash builtin | Before | 36 | 334.3 | 400.2 | 403.6 | 0 |
| Bash builtin | Active | 36 | 314.1 | 355.3 | 382.1 | 0 |
| Pipeline | Before | 36 | 449.9 | 587.0 | 610.4 | 0 |
| Pipeline | Active | 36 | 420.1 | 481.1 | 501.0 | 0 |

The second run had lower latency. The original one-second stalls were already absent in the baseline. With a single before/after pair, cache warming and ordinary run-to-run variation can also contribute to the difference. This check gives no basis for a permanent cache exclusion.

[Performance study](../README.md) · [Reproduction](../REPRODUCING.md)
