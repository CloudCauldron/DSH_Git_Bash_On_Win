# **DSH Git Bash on Windows**

<p align="center">
  <a href="README_CN.md">中文</a> | <a href="README.md">English</a>
</p>

<span style="margin-left:2em;">&#8203;</span>An extension plugin that provides Git Bash execution support for **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)** on Windows x64.

## **1 - Overview**

<span style="margin-left:2em;">&#8203;</span>DeepSeek Harness `0.2.2-rc.5` uses PowerShell (`pwsh-sandbox` / `tool-pwsh`) by default on Windows, and switching directly to Git Bash prevents the shell from starting because MSYS2 encounters permission restrictions under a restricted sandbox token.

<span style="margin-left:2em;">&#8203;</span>`dsh-git-bash-on-win` provides an out-of-the-box Git Bash backend for DSH on Windows (supporting both `ucrt64` and `mingw64` layouts), switching the terminal tool to Bash while preserving native mechanisms such as sandbox restrictions, approvals, timeouts, output truncation, and background job management.

## **2 - Key Features**

- **Full Support for All Three DSH Sandbox Modes**
  Run Git Bash directly under `read-only`, `workspace-write`, and `danger-full-access` without relaxing the sandbox or switching to WSL, with support for pipelines, subshells, native child processes, and multiple concurrent sessions.
- Each generation copies the flat Git `usr/bin` payload (about 89 MiB on the measured ucrt64 installation). Other Git resources use directory junctions. Commands and profiles sharing a DSH home reuse one matching generation. Pinned or retired copies can remain until a later build or offline purge.
- The cache and its sibling writer lock live under the DSH home. The plugin leaves installed Git files, ACLs, global environment, registry and ordinary Git Bash unchanged.

## **3 - Usage Guide**

### **3.1 - Configuring the Git Bash Path and Manual Rebuilding**

1. In the left sidebar of DSH Web, open **Plugins** and select **DSH Git Bash on Windows**.
2. Fill in **Git Bash path** as needed and click **Save and rebuild**:
   - **Auto-detect (recommended)**: Leave blank to automatically locate Git for Windows in common installation directories.
   - **Manual path**: For portable or custom installations, enter the absolute path to `bin/bash.exe` or `usr/bin/bash.exe`.
   - **Reset to default**: Clear the input field and click **Save and rebuild** to remove the override path and restore default detection.
3. Common usage notes:
   - **Multi-tab conflict**: If another window saved changes first, a **Changes were not saved** prompt appears listing the latest path; review it and try again.
   - **Rebuild failure after saving**: The saved path is preserved; resolve the path or permission issue and click **Save and rebuild** again.
   - **Shared settings**: Timeout, output limit, working directory, and exit grace period are still managed on the **Shell** settings page.

If you edit the profile's `cordis.patch.yml` manually, be sure to preserve the existing shared Shell settings when modifying `pwsh-sandbox.config` (DSH replaces the entire `config` block):

```yaml
- id: pwsh-sandbox
  config:
    gitBashPath: 'C:/Tools/Git/bin/bash.exe'
    # Keep existing shared Shell settings here, such as timeoutMs, maxOutputBytes, and graceMs
```

### **3.2 - Automatic preparation and Git upgrades**

The first command prepares the runtime with the user's ordinary permissions, including in headless mode. Close every DSH instance sharing the home before upgrading Git and keep them closed until the upgrade finishes. The next command checks the installed Git and MSYS binaries and the package list, and rebuilds changed generations automatically. **Save and rebuild** forces a fresh copy after custom edits or damage.

If Git was upgraded with DSH open, stop issuing commands and close all instances. Finish the upgrade, repair Git if its updater failed, and reopen DSH. Review interrupted commands before running them again. If problems persist, use **Save and rebuild**, or close all instances and use the offline purge below.

## **4 - Command behavior**

Pipelines, shell scripts and Git use Bash syntax. Windows ACLs, MSYS path conversion, the installed Git toolset and native Windows programs determine how these commands behave. DSH supplies workspace and temporary-directory grants and waits for its managed process range. Native descendants of a Windows packaged application can outlive the settlement DSH reports.

Use Bash or sh from the runtime PATH. The native `bin/bash.exe` wrapper launches the installed runtime and can fail under restricted tokens. The plugin redirects explicit installed `usr/bin` children started by MSYS. Native programs that hardcode that path bypass the redirect. Piped native Node children can report EPERM in restricted modes. Bash treats quoted extended Windows executable paths differently from native argv.

## **5 - Requirements**

- **DeepSeek Harness**: `0.2.2-rc.5` (`web` / `desktop` profiles and `dsh headless`)
- **Operating System**: Native **Windows x64** on an **NTFS** volume (automatically skipped on Linux, macOS, and WSL)
- **Node.js**: Native Windows x64, `^24.21.0 || >=26`.
- **Git for Windows**: With a `ucrt64` or `mingw64` layout
- **Package Manager**: `pnpm`

## **6 - Installation, Cleanup, and Uninstallation**

### **6.1 - Installing from Source**

Before installing over the legacy hardlink backend, complete removal using the old version’s uninstaller. This cache format refuses legacy and unowned roots.

1. In **native Windows Git Bash**, change to the repository root to install dependencies and register the plugin (the repository already includes `lib/`; if you have modified `src/`, run `pnpm build` first):

    ```bash
    pnpm install --ignore-scripts --frozen-lockfile
    gitbash_pnpm="$(cygpath -m "$(type -P pnpm.exe)")"
    node scripts/plugin.ts "$gitbash_pnpm" web add "file:$(cygpath -m "$PWD")"
    ```

    - To install into **DSH Desktop**, replace `web` with `desktop`; if multiple DSH installations exist, you can set `DSH_PACKAGE_JSON` to the absolute path of the target `@deepseek-ai/dsh/package.json`.
    - If DSH can resolve `pnpm` by name, you can also run `dsh plugin --profile web add "file:$(cygpath -m "$PWD")" --ignore-scripts` directly.

2. For subsequent updates, close all hosts sharing this DSH home and update the plugin in each installed profile before restarting. Start DSH with standard privileges.

### **6.2 - Offline Cache Cleanup and Troubleshooting**

<span style="margin-left:2em;">&#8203;</span>When you need to reset the cache or clean up leftover artifacts, **close all DSH instances sharing this DSH home first** (including idle background instances), then run the offline cleanup command:

```bash
node '<installed plugin directory>/lib/purge-runtime-cache.js' '<absolute DSH home>/.dsh-git-bash-on-win'
```

Troubleshooting common obstructions:

| Issue | Resolution |
| :---: | :---: |
| Ownership cannot be verified or path contains a reparse point | Verify that the path points to `.dsh-git-bash-on-win` under `DSH_HOME` |
| Directory is in use or has active references | Close all DSH processes sharing this DSH home and retry |
| Access denied or a blocked cache file | Resolve the reported obstruction and retry the ownership-checked purge |
| Interrupted preparation or source directory issue | Verify the integrity of the source Git installation, then click **Save and rebuild** to retry |

After cleanup succeeds, restart DSH to rebuild on demand, or click **Save and rebuild** to rebuild immediately.

### **6.3 - Complete Uninstallation**

<span style="margin-left:2em;">&#8203;</span>When removing the plugin from one profile, clear that profile’s override as in step 1, close its hosts, and omit `--purge-cache` from the command below. Other profiles can continue using the cache. To completely uninstall the plugin, follow these steps in order:

1. **Remove the configuration entry**: For each profile being uninstalled, use the native config editor or `cordis.patch.yml` to delete only `gitBashPath` under `pwsh-sandbox` (keep shared settings such as `timeoutMs`, `maxOutputBytes`, and `graceMs`; if a manually added entry becomes empty, you may remove it as well).
2. **Close related DSH instances**: Exit all DSH processes sharing this DSH home (including idle instances) to prevent the cache from being rebuilt in the background.
3. **Clean up the cache and uninstall the plugin**: Run the uninstall script in **native Windows Git Bash** (it automatically cleans up the cache before uninstalling):

    ```bash
    gitbash_pnpm="$(cygpath -m "$(type -P pnpm.exe)")"
    node scripts/plugin.ts "$gitbash_pnpm" web remove dsh-git-bash-on-win --purge-cache
    ```

    If using the native CLI directly, run the Section 6.2 cleanup command **first**, and then run `dsh plugin --profile web remove dsh-git-bash-on-win --config.ignore-scripts=true` (remove the package from each remaining profile; purge the home cache only once).

## **7 - Development and Testing**

<span style="margin-left:2em;">&#8203;</span>Run the following commands in **native Windows Git Bash**. The build compiles `src/` into the tracked `lib/` directory via `@typescript/native` (TypeScript 7), while `typescript` (TypeScript 6) is used only for ESLint; after modifying `src/`, run `pnpm build` and commit the updated build artifacts alongside your changes.

Full builds also compile `native/dsh-msys-compat.c` with x64 MSVC and the Windows SDK. `native/build.json` records the release tool versions, reviewed imports and approved DLL hash. Discovery uses `vswhere` and prefers the pinned toolset; development overrides are `DSH_MSVC_TOOLS_DIR`, `DSH_WINSDK_DIR` and `DSH_WINSDK_VERSION`. Development builds verify the DLL and report their actual tools/hash; `pnpm build:release` and `pnpm pack` additionally enforce the release pins. Installed packages need no compiler.

`pnpm build:js` and `pnpm test:browser` preserve the DLL from a prior full build. Run `pnpm build` first, and again after any native edit.

```bash
pnpm install --ignore-scripts --frozen-lockfile
pnpm check          # TypeScript type-checking (src / scripts / test)
pnpm lint           # ESLint check (zero warnings)
pnpm build          # Rebuild lib/
pnpm test:windows   # Run all unit and native integration tests
pnpm test:release   # Environment preflight + check + lint + test:windows
pnpm test:browser   # Playwright browser configuration and dialog tests
```

Cold copy provisioning can be measured with `DSH_BENCH_COLD_ONLY=1 node --test test/benchmark-runtime.ts`.
