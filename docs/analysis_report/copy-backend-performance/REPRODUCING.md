# Measuring the ordinary-copy runtime

Use native Windows x64 Git Bash in the repository root with Windows Node, pnpm, DSH 0.2.2-rc.5, a supported Git for Windows installation, and the pinned compiler/SDK. Keep the shipping commit `33fa0a9039d193452ccab7eefc222144437f8aaa` available in the local Git object database. The benchmark extracts its compiled backend and uses owned Git trees. [Toolchain manifest](../../../native/build.json) · [Benchmark source](../../../test/benchmark-runtime.ts)

```bash
pnpm install --ignore-scripts --frozen-lockfile
pnpm build:release
node --test test/benchmark-runtime.ts
DSH_BENCH_COLD_ONLY=1 node --test test/benchmark-runtime.ts
```

The full run packs and installs the plugin or accepts an existing archive via `DSH_TEST_TARBALL` (absolute or relative to the checkout). Record its reported hash. Use `DSH_TEST_GIT_BASH` for a non-default Git installation and `DSH_PACKAGE_JSON` for the installed DSH manifest if necessary. The cold-only command uses the built shim and exercises discovery and layout creation on five fresh destinations.

1. Run on an otherwise idle host with its normal protection settings. Record Windows, Git, Node and DSH versions and the reported protection state at both ends.
2. In the full benchmark, compare copy and shipping in all three modes and direct Bash in full access. Each workload has two excluded warmups and 24 rounds per supported lane. Check output, exit and positive DSH range settlement. For each cell use the median, nearest-rank p95 (23rd ordered observation), maximum and count over 1,000 ms.
3. Read cold, warm and ready-use measurements independently. Warm timing begins after a fresh Node process imports the preparation module and ends at pin acquisition. The test checks the selector bytes after each restart. Ready-use timing excludes process launch. Retained bytes count the ordinary flat payload and exclude junctions, metadata and allocation overhead.

The November 21 inert-load and stack captures and the later Tencent single-file check were independent operator studies. The maintained benchmark measures command time and cache costs. It neither collects those stacks nor changes endpoint settings. [Recorded diagnostic comparisons](evidence/image-loading.md) · [Single-file timing check](evidence/tencent-file.md)
