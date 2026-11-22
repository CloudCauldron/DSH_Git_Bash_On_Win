# Historical supervisor overhead

On November 18, 2026, the original Windows executor launched Bash inside a private Job and handled Windows debug events. On DSH 0.2.2-rc.2, a Bash builtin took 412 ms at the median through the supervisor versus 174 ms for direct Bash on the same warm fixture, both timed after runtime acquisition.

Skipping redundant thread-context writes by inspecting live thread state first cut context writes by 93–95% across a builtin, one external child, and 50 sequential children, yet the optimized build won only 6, 5, and 7 of 12 elapsed-time pairs respectively, showing no consistent wall-clock speedup.

These measurements covered full-access mode on one host; the later rc.5 study times commands from Shell resolution through managed-range settlement across all three policies. [November 18 timings, CPU and memory](evidence/measurements.md) · [Historical benchmark procedure](REPRODUCING.md) · [Ordinary-copy performance](../copy-backend-performance/README.md) · [Analysis index](../README.md)
