# Measuring the historical supervisor

Use native Windows x64 Git Bash, Windows Node 26.12.1, pnpm 12.18.0, DSH 0.2.2-rc.2 and Git for Windows 2.56.0.windows.4. The November 18 host used Windows 11 build 26200 and an Intel Core i9-12900HK. Start from the repository root on an otherwise idle host with NTFS space for the Git copy.

```bash
git worktree add --detach ../dsh-supervisor-study 34d36c1
cd ../dsh-supervisor-study
pnpm install --ignore-scripts --frozen-lockfile
pnpm build
node --test test/benchmark-supervisor.ts
```

The tracked benchmark at this revision measures the optimized supervisor. It acquires a runtime lease before timing, rotates direct Bash, a minimal Node parent and the supervisor across nine measured rounds after one warmup each, and prints JSON observations. Group elapsed time by workload and launch path. Compute median CPU time and peak working set separately from the three resource samples.

To exercise the original supervisor with the same timing driver, create another disposable worktree from the study checkout. The driver was added with the optimization. Retrieve that one tracked file at its recorded revision.

```bash
git worktree add --detach ../dsh-supervisor-original 34d36c1^
cd ../dsh-supervisor-original
git show 34d36c1:test/benchmark-supervisor.ts > test/benchmark-supervisor.ts
pnpm install --ignore-scripts --frozen-lockfile
pnpm build
node --test test/benchmark-supervisor.ts
```

Inspect the recorded change and paired protocol from either worktree.

```bash
git diff 34d36c1^ 34d36c1 -- src/debugger/native-debug.ts
git show 34d36c1:docs/supervisor-benchmark.md
```

The paired study ran both builds for 12 rounds per workload, with each first in six pairs. Context-write counts came from one additional instrumented run per build and workload. The tracked nine-round benchmark reports elapsed time and process resources only. [Recorded paired results](evidence/measurements.md#skipping-redundant-thread-context-writes)
