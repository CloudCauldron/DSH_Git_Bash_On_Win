# Reproducing the historical process-family checks

Use native Windows x64 Git Bash, Node 26.12.1, pnpm 12.18.0, DSH 0.2.2-rc.2 and Git for Windows 2.56.0.windows.4. Give the fixtures space on one NTFS volume for disposable source copies, hardlinks and profiles. Start a separate checkout for the superseded backend.

```bash
git worktree add --detach ../dsh-family-study 6c410c5
cd ../dsh-family-study
pnpm install --ignore-scripts --frozen-lockfile
pnpm poc
node poc/phase2.ts --repair-ipc --repair-mappings --follow-family --both-modes
pnpm build
node test/plugin.ts --profile-only --structure-only
```

Read the stock fixture’s verdict as well as its assertion count. Compare restricted exits, outside-file and cleanup checks with the [recorded feasibility results](evidence/feasibility.json). The early fixtures accept `DSH_POC_BASH` for Git’s native `bin/bash.exe` and `DSH_POC_PACKAGE` for the installed DSH manifest.

## Shared runtime and UAC

In the disposable checkout, select the November 17 revision. Later fixtures use `DSH_TEST_GIT_BASH` and `DSH_PACKAGE_JSON` when default discovery needs an absolute path.

```bash
git switch --detach ca22535
pnpm install --ignore-scripts --frozen-lockfile
pnpm test:release
```

The suite covers warm admission, concurrent namespaces, cancellation, purge and source comparisons. To repeat real consent on an interactive desktop, run each of these separately after the build.

```bash
DSH_GIT_BASH_UAC_TEST=approve node --test --test-name-pattern='manual UAC' test/provisioning.test.ts
DSH_GIT_BASH_UAC_TEST=deny node --test --test-name-pattern='manual UAC' test/provisioning.test.ts
DSH_GIT_BASH_UAC_TEST=late node --test --test-name-pattern='manual UAC' test/provisioning.test.ts
```

Approve the first prompt and deny the second. In the delayed case, wait for `LOCAL SHUTDOWN COMPLETED`, then approve within the following 20 seconds if the prompt is still visible. Check for error 1223 on denial and an unpublished generation and successful purge after cancellation. [Consent record](evidence/windows.md#native-release-and-uac-17-november)

## Installed profiles and 0.1.0

Repeat the checkout, frozen install and `pnpm test:release` at `0163355` for the November 18 installed-package checks. At `8e78258` (plugin 0.1.0), run the frozen install, `pnpm test:release` and `pnpm test:browser`. The browser check needs Chrome. The recorded WSL, headless and Web observations have their own scope in the [installed-profile results](evidence/windows.md#installed-profiles-18-november).
