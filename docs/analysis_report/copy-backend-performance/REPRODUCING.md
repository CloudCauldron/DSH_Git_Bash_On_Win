# Measuring the ordinary-copy runtime

Run these commands from the repository root in native Windows x64 Git Bash using Windows Node, pnpm, DSH 0.2.2-rc.5, a supported Git for Windows installation, and the pinned compiler and SDK. Keep shipping commit `33fa0a9039d193452ccab7eefc222144437f8aaa` in the local Git object database so the benchmark can extract its compiled backend alongside owned Git trees. [Toolchain manifest](../../../native/build.json) · [Benchmark source](../../../test/benchmark-runtime.ts)

```bash
pnpm install --ignore-scripts --frozen-lockfile
pnpm build:release
node --test test/benchmark-runtime.ts
DSH_BENCH_COLD_ONLY=1 node --test test/benchmark-runtime.ts
```

The full run packs and installs the plugin—or accepts an existing archive via `DSH_TEST_TARBALL` (absolute or relative to the checkout)—and prints the archive hash. Set `DSH_TEST_GIT_BASH` to test a non-default Git installation and `DSH_PACKAGE_JSON` if DSH manifest discovery needs an override. The cold-only run uses the built shim to time discovery and layout creation across five fresh destinations.

1. Run on an idle host under its normal protection settings, recording the Windows, Git, Node, and DSH versions along with the reported protection state before and after.
2. The full benchmark compares the copy and shipping backends across all three policies and direct Bash in full access, running two excluded warmups and 24 timed rounds per lane and checking output, exit status, and positive DSH range settlement. Summarize each cell with its median, nearest-rank p95 (23rd ordered observation), maximum, and count over 1,000 ms.
3. Evaluate cold, warm, and ready-use costs separately. Warm admission starts after a fresh Node process imports the preparation module, ends at pin acquisition, and checks that the selector bytes stay identical across restarts. Ready-use timing excludes shell launch, and retained byte counts cover only the flat payload (excluding junctions, metadata, and filesystem allocation overhead).

The November 21 inert-load and stack captures and the later Tencent single-file check were one-off operator studies; the maintained benchmark covers only command time and cache costs and does not collect stack traces or change endpoint settings. [Recorded diagnostic comparisons](evidence/image-loading.md) · [Single-file timing check](evidence/tencent-file.md)
