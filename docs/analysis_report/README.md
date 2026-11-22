# Analysis findings

The November 12–19 Windows runs studied the historical process-family backend.

- **Can Bash run under the selected sandbox policy?** Stock MSYS failed to start in both restricted modes. The private process family ran Bash and its children in both. The controls failed as expected, the fixture's outside files kept their contents, and ordinary Git Bash still worked. [Feasibility results](evidence/feasibility.json)
- **Can sessions share a runtime tree?** Two sessions in each of the three modes used one base and produced six distinct MSYS namespaces. On the measured Git installation this reduced the cache from 24,543 hardlinks to 8,181. Five warm opens took 23.31–36.87 ms. The release and installed-profile runs also covered cancellation, strict cache removal, restored source link counts and preservation of shared Shell settings. [Windows verification](evidence/windows-verification.md)
- **What does supervision cost?** The original supervisor added 239 ms to the median time for a Bash builtin on the benchmark host. Skipping redundant thread-context writes cut those writes by 93–95% in the three measured workloads. The paired timings showed no consistent improvement in elapsed time. [Supervisor measurements](evidence/supervisor-benchmark.md)

The 0.1.0 cleanup passed the native release and installed-browser checks on November 19. The current ordinary-copy backend has separate [release results](evidence/windows-verification.md#independent-phase-4-audit) and [reproduction steps](REPRODUCING.md).
