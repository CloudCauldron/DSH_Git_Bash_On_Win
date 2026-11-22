# Reproducing the Windows measurements

Run these commands from the checkout root with native Windows x64 Node and Git Bash, DSH 0.2.2-rc.5, Git for Windows and Chrome. The release build also needs the MSVC and Windows SDK versions in `native/build.json`. Allow space on NTFS for disposable Git copies, profiles and runtime generations. See the [build instructions](../../README.md#7---development-and-testing).

## Verify the release

```bash
pnpm install --ignore-scripts --frozen-lockfile
pnpm test:release
```

The gate preflights the installed tools, runs typecheck and lint, builds the release, and runs the Windows, browser and packed-profile tests. The independent builds compare their tarballs and check the rebuilt library against the Git index. Look for zero failures, cancellations and skips. If discovery needs help, set `DSH_PACKAGE_JSON` to the installed CLI manifest, `DSH_TEST_GIT_BASH` to a supported Bash executable or `CHROME_PATH` to the Chrome executable. Use absolute paths for these overrides.

## Measure the package

Run the timing test on an otherwise idle machine. To reuse a particular archive, set `DSH_TEST_TARBALL` to its path before running the benchmark or optional host tests. Both accept a path relative to the checkout and report the archive digest. With the variable unset, each command packs a release for its own run.

```bash
node --test test/benchmark-runtime.ts
DSH_TEST_WINGET=1 node --test test/qualify-host.ts
```

The benchmark measures fresh preparation, warm admission in a new Windows Node process, ready-use overhead, retained generations and end-to-end commands through DSH settlement. For the separate five-sample cold-copy check, run `DSH_BENCH_COLD_ONLY=1 node --test test/benchmark-runtime.ts` after a full build. The optional host suite exercises packaged PowerShell, WinGet and GDB. The WinGet opt-in permits its usual diagnostic logs. [Timing results](evidence/supervisor-benchmark.md#phase-4-packed-runtime) · [Release verification](evidence/windows-verification.md#phase-4-release-qualification)

## Interpreting earlier runs

The early stock-shell, process-family and profile fixtures are in Git at `6c410c5`. Their counts include expected failures in control runs. The later Windows and Web acceptance records identify the revisions used for each measurement. [Feasibility results](evidence/feasibility.json) · [Windows verification record](evidence/windows-verification.md)
