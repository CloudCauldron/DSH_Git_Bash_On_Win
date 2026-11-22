# Reproducing the analysis

Run the commands from the checkout root in Windows-native Git Bash. The measurements used x64 Node 26.12.1, pnpm 12.18.0, DSH 0.2.2-rc.2 and Git for Windows 2.56.0.windows.4. Use an NTFS temporary directory with space for a copy of the selected Git files and the test profiles. The fixtures create both the source copy and the hardlink cache there.

The release check discovers the installed DSH CLI and Git. If discovery needs help, set `DSH_PACKAGE_JSON` to the absolute path of the installed `@deepseek-ai/dsh` package manifest and `DSH_TEST_GIT_BASH` to the absolute path of Git's `bin/bash.exe` or `usr/bin/bash.exe`. The browser check also needs Chrome. Set `CHROME_PATH` to its executable if it is outside the standard Windows installation directory.

## Run the checks on the current checkout

```bash
pnpm install --ignore-scripts --frozen-lockfile
pnpm test:release
pnpm test:browser
```

1. The release command checks the native prerequisites, type checks, lints, rebuilds the package and runs the maintained tests. Look for zero failures and skips. The native execution test prints five warm-admission samples for a real Git copy. The cache test prints one sample for a small fixture.
2. The execution tests exercise all three DSH policies, repeated and concurrent sessions, mapping access, cancellation and disposal. Fixture teardown purges the cache and compares every copied source file's hash and hardlink count, along with the ACL records. The installation test checks the package through DSH's own plugin manager in a temporary profile.
3. The browser test installs the checkout in a temporary Web profile. It exercises the settings form, saved paths, rebuilds, localized feedback and conflicting edits in separate tabs. The default run uses fixture responses for elevation. The real consent checks below require an operator.

## Measure cold copy provisioning

Run on an otherwise idle machine. The benchmark provisions five fresh generations from the selected Git installation into a disposable DSH home and reports elapsed milliseconds, file counts, logical bytes and Defender status at both ends.

```bash
pnpm build
DSH_BENCH_COLD_ONLY=1 node --test test/benchmark-runtime.ts
```

The original supervisor comparison is recorded with its workloads and measurements. [Historical measurements](evidence/supervisor-benchmark.md)

## Check Windows consent

Build first. Run one case at a time from an interactive desktop. Each case uses an owned source copy and the production broker and linker.

```bash
DSH_GIT_BASH_UAC_TEST=approve node --test --test-name-pattern='manual UAC' test/provisioning.test.ts
DSH_GIT_BASH_UAC_TEST=deny node --test --test-name-pattern='manual UAC' test/provisioning.test.ts
DSH_GIT_BASH_UAC_TEST=late node --test --test-name-pattern='manual UAC' test/provisioning.test.ts
```

Choose Yes for `approve` and No for `deny`. For `late`, leave the prompt open until the test prints `LOCAL SHUTDOWN COMPLETED`, then approve within the following 20 seconds if the prompt is still visible. Record whether the prompt remained. The denial check expects Windows error 1223. The delayed check requires the cancelled generation to stay unpublished and the cache purge to succeed.

## Interpreting the older runs

The early stock-shell, process-family and profile fixtures are in Git at `6c410c5`. Their counts include checks of expected failures in the control runs. [Feasibility results](evidence/feasibility.json)

The later backend and Web acceptance runs give their revisions alongside the results. The test counts belong to those revisions. The original one-off directory-enumeration timings and manual Web, headless and WSL observations are historical measurements. [Windows verification record](evidence/windows-verification.md)
