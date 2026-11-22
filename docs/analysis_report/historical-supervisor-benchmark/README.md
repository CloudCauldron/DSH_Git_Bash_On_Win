# Historical supervisor overhead

On November 18, 2026, the original Windows executor launched Bash inside a private Job and processed Windows debug events. On DSH 0.2.2-rc.2, that path took 412 ms at the median for a Bash builtin. Direct Bash took 174 ms on the same warm fixture. Both measurements began after runtime acquisition.

The supervisor subsequently checked live thread state before writing it. Across a builtin, one external child and 50 sequential children, this removed 93–95% of context writes. The optimized build won 6, 5 and 7 of 12 elapsed-time pairs respectively. The study found no consistent reduction in command time.

This study used full access on one host. The later rc.5 study timed commands from Shell resolution through managed-range settlement and includes restricted modes. [November 18 timings, CPU and memory](evidence/measurements.md) · [Historical benchmark procedure](REPRODUCING.md) · [Ordinary-copy performance](../copy-backend-performance/README.md) · [Analysis index](../README.md)
