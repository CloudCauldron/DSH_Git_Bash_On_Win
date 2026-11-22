# Measuring the historical supervisor

Run these commands from the repository root in native Windows x64 Git Bash using Windows Node 26.12.1, pnpm 12.18.0, DSH 0.2.2-rc.2, and Git for Windows 2.56.0.windows.4 on an idle host with NTFS space for a disposable Git copy. The November 18 run used Windows 11 build 26200 on an Intel Core i9-12900HK.

```bash
git worktree add --detach ../dsh-supervisor-study 34d36c1
cd ../dsh-supervisor-study
pnpm install --ignore-scripts --frozen-lockfile
pnpm build
node --test test/benchmark-supervisor.ts
```

At `34d36c1`, the tracked benchmark measures the optimized supervisor: it acquires a runtime lease before timing, rotates direct Bash, a minimal Node parent, and the supervisor across nine measured rounds after one warmup each, and prints JSON observations. Group elapsed time by workload and launch path, and compute median CPU time and peak working set from the three separate resource samples.

Because the timing driver was added alongside the optimization, measuring the original supervisor requires checking out the parent commit in a second worktree and copying `test/benchmark-supervisor.ts` from `34d36c1`:

```bash
git worktree add --detach ../dsh-supervisor-original 34d36c1^
cd ../dsh-supervisor-original
git show 34d36c1:test/benchmark-supervisor.ts > test/benchmark-supervisor.ts
pnpm install --ignore-scripts --frozen-lockfile
pnpm build
node --test test/benchmark-supervisor.ts
```

Inspect the optimization diff and paired protocol from either worktree:

```bash
git diff 34d36c1^ 34d36c1 -- src/debugger/native-debug.ts
git show 34d36c1:docs/supervisor-benchmark.md
```

The paired comparison ran both builds for 12 rounds per workload (each running first in six pairs) and took context-write counts from one extra instrumented run per build and workload, whereas the tracked nine-round benchmark reports elapsed time and process resources only. [Recorded paired results](evidence/measurements.md#skipping-redundant-thread-context-writes)
