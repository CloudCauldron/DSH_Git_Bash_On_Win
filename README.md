# **DSH Git Bash on Windows**

<p align="center">
  <a href="README_CN.md">中文</a> | <a href="README.md">English</a>
</p>

<span style="margin-left:2em;">&#8203;</span>An extension plugin that provides Git Bash execution support for **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)** on Windows x64.

## **1 - Overview**

<span style="margin-left:2em;">&#8203;</span>DeepSeek Harness `0.2.2-rc.5` uses PowerShell (`pwsh-sandbox` / `tool-pwsh`) by default on Windows, and switching directly to Git Bash prevents the shell from starting because MSYS2 encounters permission restrictions under a restricted sandbox token.

<span style="margin-left:2em;">&#8203;</span>`dsh-git-bash-on-win` provides an out-of-the-box Git Bash backend for DSH on Windows (supporting both `ucrt64` and `mingw64` layouts), switching the terminal tool to Bash while preserving native mechanisms such as sandbox restrictions, approvals, timeouts, output truncation, and background job management.

## **2 - Key Features**

- **Full Support for All Three DSH Sandbox Modes**: Run Git Bash directly under `read-only`, `workspace-write`, and `danger-full-access` without relaxing the sandbox or switching to WSL, while preserving native workspace grants, approvals, timeouts, standard streams, and background job management.
- **Lightweight, Shared Runtime Cache**: Each runtime build copies only the regular files in Git's `usr/bin` directory (about 89 MiB on a measured `ucrt64` install) and accesses other Git resources through directory junctions. Commands and profiles sharing a DSH home reuse the same matching cache; superseded copies may remain until a later rebuild or offline cleanup.
- **Strict Isolation**: The cache and its writer lock live inside the DSH home. Installed Git files and ACLs, global environment variables, the Windows registry, and ordinary Git Bash remain untouched.

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

### **3.2 - Automatic Preparation and Git Upgrades**

<span style="margin-left:2em;">&#8203;</span>The first command automatically prepares the runtime cache using your normal user permissions (including in headless mode). Before upgrading Git, close all DSH instances sharing the same DSH home and keep them closed until the upgrade finishes. On the next command, the plugin checks the installed Git and MSYS binaries along with the package list, and automatically rebuilds the cache if anything has changed. If you made custom edits or suspect cache damage, click **Save and rebuild** to force a fresh copy.

<span style="margin-left:2em;">&#8203;</span>If Git was upgraded while DSH was still running, stop issuing new commands and close all instances. Let the upgrade finish (and repair Git if the updater reported errors), then reopen DSH. Check the results of any interrupted commands before retrying them. If problems persist, click **Save and rebuild**, or close all instances and follow the offline cleanup steps in Section 6.2.

### **3.3 - Starting a New Session After Disabling the Plugin**

<span style="margin-left:2em;">&#8203;</span>In DSH `0.2.2-rc.5`, clicking **New Session** after disabling the plugin may reopen a blank session created while the plugin was enabled. By design, DSH keeps existing sessions on their original agent preset version when plugins are toggled: commands in that session now run in PowerShell, while the AI still sees a tool named `bash` and may try Bash syntax first. Typically, the AI will switch to PowerShell on its own once a Bash command fails, and sessions newly created after disabling the plugin use `pwsh` from the start.

## **4 - Differences from Native Linux Bash**

<span style="margin-left:2em;">&#8203;</span>Everyday Bash syntax—quoting, pipes, redirection, command substitution, and common Git commands (such as `printf '%s\n' main | grep -Fx main` or `git status --short`)—works just like on Linux. Under the hood, however, commands run the Windows builds shipped with Git for Windows, so scripts that rely on Linux-only tools, devices, or services still require a Linux environment. Keep the following Windows-specific differences in mind:

- **Paths and permissions**: Use MSYS paths such as `/c/Work` inside Bash; MSYS translates path arguments for Windows programs as needed. Avoid launching executables via Windows extended-length paths (such as `\\?\...`) inside Bash (a limitation of Git Bash itself). File access follows NTFS and Windows ACLs, with workspace and temporary-directory permissions granted by DSH.
- **Nested shells**: Start nested shells via `bash` or `sh` on `PATH` (from an MSYS parent, running the installed `usr/bin/bash.exe` also works). Avoid Git's native `bin/bash.exe` wrapper—it bypasses `PATH`, launches the installed MSYS directly, and fails in restricted modes.
- **Third-party launchers**: In `read-only` and `workspace-write`, a native Windows program that launches Git Bash using its installed absolute path (such as `C:\Program Files\Git\bin\bash.exe` or `C:\Program Files\Git\usr\bin\bash.exe`) bypasses this plugin's runtime and fails to start Bash. Configure it to invoke `bash` or `sh` from the inherited `PATH` instead.
- **Native tools and debuggers**: PowerShell pipelines into Git tools and GDB debugging of a local target executable work across all three sandbox modes. In restricted modes, however, piped child processes spawned by Node.js return `EPERM` (a DSH sandbox limitation that also occurs with the default PowerShell backend). Other GUI app aliases and debuggers have not been broadly qualified and should be tested case by case.
- **Packaged apps, exit codes, and process lifetime**: Store-packaged CLI tools like PowerShell and WinGet keep the same app package identity and native exit codes as DSH's default backend (including WinGet's `0x8A150001` error in restricted modes), though Bash only surfaces the low 8 bits of a native exit code. In addition, DSH only waits for its managed process range to exit, so child processes spawned by a packaged app may continue running after a command returns.

## **5 - Requirements**

- **DeepSeek Harness**: `0.2.2-rc.5` (`web` / `desktop` profiles and `dsh headless`)
- **Operating System**: Native **Windows x64** on an **NTFS** volume (automatically skipped on Linux, macOS, and WSL)
- **Node.js**: Native Windows x64, `^24.21.0 || >=26`.
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

    If using the native CLI directly, run the Section 6.2 cleanup command **first**, and then run `dsh plugin --profile web remove dsh-git-bash-on-win --ignore-scripts` (remove the package from each remaining profile; purge the home cache only once).

## **7 - Development and Testing**

<span style="margin-left:2em;">&#8203;</span>Run the commands below in **native Windows Git Bash**. Running `pnpm build` compiles both `src/` and the native compatibility library (`native/dsh-msys-compat.c`) into the tracked `lib/` directory; after editing source files, rebuild and commit the updated artifacts alongside your changes.

<span style="margin-left:2em;">&#8203;</span>A full build requires x64 MSVC and the Windows SDK (for development only—installed plugin packages need no compiler). The build script locates the toolchain automatically, or you can override it with `DSH_MSVC_TOOLS_DIR`, `DSH_WINSDK_DIR`, and `DSH_WINSDK_VERSION`. Release builds (`pnpm build:release` and `pnpm pack`) also verify the tool versions and DLL hash against `native/build.json`.

<span style="margin-left:2em;">&#8203;</span>`pnpm build:js` and `pnpm test:browser` rebuild only the JavaScript bundle and reuse the DLL from a prior full build, so run `pnpm build` once first and again after any native changes.

```bash
pnpm install --ignore-scripts --frozen-lockfile
pnpm check          # TypeScript type-checking
pnpm lint           # ESLint check (zero warnings)
pnpm build          # Full build of lib/ (including native compatibility DLL)
pnpm test:windows   # Run unit and native integration tests
pnpm test:browser   # Run Playwright browser tests
pnpm test:release   # Full pre-release verification (preflight, checks, release build, and all tests)
```

<span style="margin-left:2em;">&#8203;</span>If Chrome is installed in a non-default location, set `CHROME_PATH` to its executable. For optional checks, you can also run `node --test test/benchmark-runtime.ts` (runtime benchmarks) or `DSH_TEST_WINGET=1 node --test test/qualify-host.ts` (packaged PowerShell, WinGet, and GDB compatibility checks).
