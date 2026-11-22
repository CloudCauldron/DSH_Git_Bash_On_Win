# Reproducing the historical process-family checks

Run these steps in native Windows x64 Git Bash using Node 26.12.1, pnpm 12.18.0, DSH 0.2.2-rc.2, and Git for Windows 2.56.0.windows.4, with free space on a single NTFS volume for disposable source copies, hardlinks, and profiles. Start in a separate worktree for the superseded backend:

```bash
git worktree add --detach ../dsh-family-study 6c410c5
cd ../dsh-family-study
pnpm install --ignore-scripts --frozen-lockfile
pnpm poc
node poc/phase2.ts --repair-ipc --repair-mappings --follow-family --both-modes
pnpm build
node test/plugin.ts --profile-only --structure-only
```

Check both the stock fixture's verdict and its assertion count, comparing restricted exits, outside-file probes, and cleanup checks against the [recorded feasibility results](evidence/feasibility.json). The early fixtures accept `DSH_POC_BASH` for Git's native `bin/bash.exe` and `DSH_POC_PACKAGE` for the installed DSH manifest.

## Shared runtime and UAC

Switch the disposable worktree to the November 17 revision; later fixtures accept `DSH_TEST_GIT_BASH` and `DSH_PACKAGE_JSON` when default discovery needs explicit absolute paths.

```bash
git switch --detach ca22535
pnpm install --ignore-scripts --frozen-lockfile
pnpm test:release
```

The suite covers warm admission, concurrent namespaces, cancellation, purge, and source comparisons. To test live UAC prompts on an interactive desktop, run each of these separately after building:

```bash
DSH_GIT_BASH_UAC_TEST=approve node --test --test-name-pattern='manual UAC' test/provisioning.test.ts
DSH_GIT_BASH_UAC_TEST=deny node --test --test-name-pattern='manual UAC' test/provisioning.test.ts
DSH_GIT_BASH_UAC_TEST=late node --test --test-name-pattern='manual UAC' test/provisioning.test.ts
```

Approve the first prompt and deny the second. For the delayed case, wait for `LOCAL SHUTDOWN COMPLETED` and then approve within the next 20 seconds if the prompt is still up; verify error 1223 on denial and an unpublished generation plus clean purge after cancellation. [Consent record](evidence/windows.md#native-release-and-uac-17-november)

## Installed profiles and 0.1.0

Repeat the checkout, frozen install, and `pnpm test:release` at `0163355` for the November 18 installed-package checks, and at `8e78258` (plugin 0.1.0) run the frozen install, `pnpm test:release`, and `pnpm test:browser` (requires Chrome). See the [installed-profile results](evidence/windows.md#installed-profiles-18-november) for the recorded WSL, headless, and Web checks.
