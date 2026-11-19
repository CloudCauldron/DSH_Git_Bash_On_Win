# **DSH Git Bash on Windows**

<span style="margin-left:2em;">&#8203;</span>An extension plugin that provides Git Bash execution support for **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)** on Windows x64.

## **1 - Overview**

<span style="margin-left:2em;">&#8203;</span>DeepSeek Harness `0.2.2-rc.5` uses PowerShell (`pwsh-sandbox` / `tool-pwsh`) by default on Windows, and switching directly to Git Bash prevents the shell from starting because MSYS2 encounters permission restrictions under a restricted sandbox token.

<span style="margin-left:2em;">&#8203;</span>`dsh-git-bash-on-win` provides an out-of-the-box Git Bash backend for DSH on Windows (supporting both `ucrt64` and `mingw64` layouts), switching the terminal tool to Bash while preserving native mechanisms such as sandbox restrictions, approvals, timeouts, output truncation, and background job management.

## **2 - Key Features**

- **Full Support for All Three DSH Sandbox Modes**
  Run Git Bash directly under `read-only`, `workspace-write`, and `danger-full-access` without relaxing the sandbox or switching to WSL, with support for pipelines, subshells, native child processes, and multiple concurrent sessions.
- **Single Shared Hard Link Base with Virtually No Extra Disk Usage**
  Reuses local Git files via NTFS hard links and shares one base directory across all modes, with no extra copies required.
- **Isolated in the DSH profile directory without altering the host environment**
  All runtime files and hard links are stored in the DSH profile's cache directory, without modifying the Windows Registry, global `PATH`, environment variables, or the contents and permissions (ACLs) of the source Git and DSH files. Everyday Git Bash and WSL remain unaffected. A complete uninstall and cleanup restores the source files' hard-link counts (creating or removing hard links may update NTFS change timestamps, archive bits, and journal or audit records).

## **3 - Usage Guide**

### **3.1 - Configuring the Git Bash Path and Manual Linking**

1. In the left sidebar of DSH Web, open **Plugins** and select **DSH Git Bash on Windows**.
2. Fill in **Git Bash path** as needed and click **Save and link**:
   - **Auto-detect (recommended)**: Leave blank to automatically locate Git for Windows in common installation directories.
   - **Manual path**: For portable or custom installations, enter the absolute path to `bin/bash.exe` or `usr/bin/bash.exe`.
   - **Reset to default**: Clear the input field and click **Save and link** to remove the override path and restore default detection.
   - **Linking progress**: The hint below the input shows linking progress and the current relative path. It returns to the path description when linking ends.
3. Common usage notes:
   - **Multi-tab conflict**: If another window saved changes first, a **Changes were not saved** prompt appears listing the latest path; review it and try again.
   - **Link failure after saving**: The saved path is preserved; resolve the path or permission issue and click **Save and link** again.
   - **Shared settings**: Timeout, output limit, working directory, and exit grace period are still managed on the **Shell** settings page.

If you edit the profile's `cordis.patch.yml` manually, be sure to preserve the existing shared Shell settings when modifying `pwsh-sandbox.config` (DSH replaces the entire `config` block):

```yaml
- id: pwsh-sandbox
  config:
    gitBashPath: 'C:/Tools/Git/bin/bash.exe'
    # Keep existing shared Shell settings here, such as timeoutMs, maxOutputBytes, and graceMs
```

### **3.2 - Automatic Linking, Permission Confirmation, and Headless Mode**

- **Automatic setup**: Hard links are created automatically on the first Bash command or when a Git upgrade modifies key files, displaying **Links created** when finished.
- **On-demand elevation (UAC)**: If Git is located in a protected directory such as `C:\Program Files\Git`, administrator permission is requested once on demand when creating links. Elevation is used solely to create hard links; everyday commands still run with standard privileges.
- **Headless mode (`dsh headless`)**: When elevation is required without an interactive window, the process aborts and prints a recovery command in the terminal; run it in Windows Git Bash, then restart DSH and retry:

    ```bash
    node '<installed plugin directory>/lib/link-runtime-cache.js' '<absolute DSH profile directory>' '<absolute bash.exe path>' ['<DSH installation anchor path>']
    ```

## **4 - Important Notes**

<span style="margin-left:2em;">&#8203;</span>Please keep the following points in mind when using or troubleshooting the plugin:

1. **Git and the DSH profile must be on the same NTFS volume**
   Windows hard links cannot be created across drive letters, and non-NTFS filesystems such as FAT32 and exFAT are not supported. Both the Git installation directory and the DSH profile directory (`.dsh\profiles\<profile-name>` by default, adjustable via `DSH_HOME`) must reside on the same NTFS volume.
2. **Do not combine with other shell-replacing plugins in the same profile**
   The plugin directly reuses the native `pwsh-sandbox`, `tool-pwsh`, `preset-standard`, `preset-ptc`, and `preset-cordis` entries. Do not mix it with other shell-replacement plugins or modify those module names.
3. **Source directory, cache directory, and workspace must not overlap**
   The cache location is fixed at `<profile directory>/.git-bash-on-win` (cannot be changed). The Git source directory, cache directory, and command workspace must not be identical or contain one another, and paths along the way should avoid passing through junctions or symbolic links.
4. **Source Git files must not be marked "Read-only"**
   If files in a portable Git installation carry the Windows "Read-only" attribute, clear the read-only attribute before creating links or running cleanup.
5. **Cache size and file updates**
   Hard links share on-disk data with the source files, so the size reported in File Explorer does not represent additional disk usage; modifying source files in place takes effect across the links as well. After upgrading Git or if supporting files are missing, click **Save and link** on the plugin page to rebuild.
6. **Run with standard privileges and do not recursively delete the cache directly**
   Launch DSH with standard privileges for installation, updates, and everyday use. Never force-delete `.git-bash-on-win` with `rm -rf` or File Explorer; when cleaning up, close all relevant DSH instances first and then run the command in Section 6.2.

## **5 - Requirements**

- **DeepSeek Harness**: `0.2.2-rc.5` (`web` / `desktop` profiles and `dsh headless`)
- **Operating System**: Native **Windows x64** on an **NTFS** volume (automatically skipped on Linux, macOS, and WSL)
- **Node.js**: `>= 26` (native Windows x64)
- **Git for Windows**: With a `ucrt64` or `mingw64` layout
- **Package Manager**: `pnpm`

## **6 - Installation, Cleanup, and Uninstallation**

### **6.1 - Installing from Source**

1. In **native Windows Git Bash**, change to the repository root to install dependencies and register the plugin (the repository already includes `lib/`; if you have modified `src/`, run `pnpm build` first):

    ```bash
    pnpm install --ignore-scripts --frozen-lockfile
    gitbash_pnpm="$(cygpath -m "$(type -P pnpm.exe)")"
    node scripts/plugin.ts "$gitbash_pnpm" web add "file:$(cygpath -m "$PWD")"
    ```

    - To install into **DSH Desktop**, replace `web` with `desktop`; if multiple DSH installations exist, you can set `DSH_PACKAGE_JSON` to the absolute path of the target `@deepseek-ai/dsh/package.json`.
    - If DSH can resolve `pnpm` by name, you can also run `dsh plugin --profile web add "file:$(cygpath -m "$PWD")" --ignore-scripts` directly.

2. Restart DSH with standard privileges to begin using it (installation or updates preserve any existing cache).

### **6.2 - Offline Cache Cleanup and Troubleshooting**

<span style="margin-left:2em;">&#8203;</span>When you need to reset the cache or clean up leftover artifacts, **close all DSH instances using this profile first** (including idle background instances), then run the offline cleanup command:

```bash
node '<installed plugin directory>/lib/purge-runtime-cache.js' '<absolute DSH profile directory>/.git-bash-on-win'
```

Troubleshooting common obstructions:

| Issue | Resolution |
| :---: | :---: |
| Ownership cannot be verified or path contains a reparse point | Verify that the path points to `.git-bash-on-win` under that profile |
| Directory is in use or has active references | Close all DSH processes using this profile and retry |
| Active elevation plan has not exited or is blocking cleanup | Wait for the elevated helper process to release its handles and retry cleanup |
| Access denied or blocked by read-only files | Clear the read-only attribute or release locks on the affected path and retry |
| Interrupted linking or source directory issue | Verify the integrity of the source Git installation, then click **Save and link** to retry |

After cleanup succeeds, restart DSH to rebuild on demand, or click **Save and link** to rebuild immediately.

### **6.3 - Complete Uninstallation**

<span style="margin-left:2em;">&#8203;</span>To completely uninstall the plugin and restore the original hard link counts on source files, follow these steps in order:

1. **Remove the configuration entry**: In the native config editor or `cordis.patch.yml`, delete only `gitBashPath` under `pwsh-sandbox` (keep shared settings such as `timeoutMs`, `maxOutputBytes`, and `graceMs`; if a manually added entry becomes empty, you may remove it as well).
2. **Close related DSH instances**: Exit all DSH processes using this profile (including idle instances) to prevent the cache from being rebuilt in the background.
3. **Clean up the cache and uninstall the plugin**: Run the uninstall script in **native Windows Git Bash** (it automatically cleans up the cache before uninstalling):

    ```bash
    gitbash_pnpm="$(cygpath -m "$(type -P pnpm.exe)")"
    node scripts/plugin.ts "$gitbash_pnpm" web remove dsh-git-bash-on-win
    ```

    If using the native CLI directly, run the Section 6.2 cleanup command **first**, and then run `dsh plugin --profile web remove dsh-git-bash-on-win --ignore-scripts` (if multiple profiles share the same package, clean up each profile's cache individually).

## **7 - Development and Testing**

<span style="margin-left:2em;">&#8203;</span>Run the following commands in **native Windows Git Bash**. The build compiles `src/` into the tracked `lib/` directory via `@typescript/native` (TypeScript 7), while `typescript` (TypeScript 6) is used only for ESLint; after modifying `src/`, run `pnpm build` and commit the updated build artifacts alongside your changes.

```bash
pnpm install --ignore-scripts --frozen-lockfile
pnpm check          # TypeScript type-checking (src / scripts / test)
pnpm lint           # ESLint check (zero warnings)
pnpm build          # Rebuild lib/
pnpm test:windows   # Run all unit and native integration tests
pnpm test:release   # Environment preflight + check + lint + test:windows
pnpm test:browser   # Playwright browser configuration and dialog tests
```

To manually verify real UAC prompts or run the supervisor benchmark, run `pnpm build` first, then run the commands below as needed:

```bash
# Real UAC prompt verification (approve / deny / late)
DSH_GIT_BASH_UAC_TEST=approve node --test --test-name-pattern='manual UAC' test/provisioning.test.ts
DSH_GIT_BASH_UAC_TEST=deny node --test --test-name-pattern='manual UAC' test/provisioning.test.ts
DSH_GIT_BASH_UAC_TEST=late node --test --test-name-pattern='manual UAC' test/provisioning.test.ts

# Browser-integrated UAC verification
DSH_GIT_BASH_UAC_TEST=deny pnpm test:browser
DSH_GIT_BASH_UAC_TEST=approve pnpm test:browser

# Supervisor benchmark
node --test test/benchmark-supervisor.ts
```
