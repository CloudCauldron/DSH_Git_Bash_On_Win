# Codebase Conventions

## DSH APIs and UI conventions

- **Reuse existing capabilities:** Leverage built-in DSH APIs and interfaces whenever available instead of reinventing the wheel.
- **Stick to native UI:** Use DSH native controls and default styles by default. Avoid custom styles that introduce code redundancy and visual inconsistency.

## Isolation and clean uninstallation (mandatory)

- **Strict DSH scope:** All future changes must keep the plugin's runtime footprint and side effects exclusively within DSH's Git Bash execution on Windows. Ordinary Git Bash, other host programs, WSL, and non-Windows DSH must remain unaffected.
- **No persistent system-wide changes:** Never modify Windows registry keys, global `PATH` or environment variables, installed Git/DSH binaries or their ACLs, or the behavior of programs outside this DSH execution scope.
- **Confined artifacts:** Keep every plugin-managed hardlink, directory junction/view, temporary lock, and configuration artifact in DSH-scoped directories; prefer this plugin's own private directories.
- **Lifecycle and complete cleanup:**
  - **Process ownership and lease settlement:** Command process ownership is defined by DSH's managed process range (`waitForExit()`), matching stock `pwsh-sandbox` for Windows App Execution Aliases. Confirmed settlement establishes that DSH's managed range has settled and authorizes releasing the command's runtime lease; even it does not guarantee that every descendant spawned by a Windows AppModel-activated process has exited.
  - **Normal disposal:** Must terminate plugin-owned processes and close instance-owned native handles and locks so nothing remains locked after shutdown. Ephemeral artifacts inside the plugin's private cache directory (such as session views or interrupted setup state) should be cleaned up on a best-effort basis; leftovers confined within the cache directory may be deferred to subsequent GC or uninstallation.
  - **Complete uninstallation:** The validated hardlink cache persists across restarts as plugin-owned disposable storage. Complete uninstallation (remove any plugin-only `gitBashPath` override while preserving shared Shell settings, close all DSH instances sharing the home, and purge `DSH_HOME/.dsh-git-bash-on-win` once on complete removal) must remove the cache directory without following junctions/reparse points and restore source hardlink counts; interrupted or blocked purges must fail explicitly.
- **Approved NTFS metadata exception:** Hardlink creation/removal inherently changes filesystem-maintained metadata, including change timestamps, the archive bit, and journal/audit records. These bookkeeping effects are permitted; source contents and ACLs must remain unchanged, source link counts must be restored, and every artifact/configuration cleanup requirement still applies. Never write source attributes/timestamps or erase journals to conceal these effects; do not claim bit-for-bit host-state restoration or that backup/monitoring tools cannot observe them.

## Shell operations

If the codebase is located on Windows system, use Windows native git bash to perform shell operations on Windows.

## Git commit messages

- Both the subject line and the body must be in Simplified Chinese.
- Recommended subject format: `【<类型1>[/<类型2>...]】<简要描述>` — e.g. `修复: 解决番剧详情页加载失败的问题`.
- Common type words:

    ```plaintexr
    构建 → build
    (Build system or dependency changes, such as Webpack configuration modifications)
    杂项 → chore
    (Miscellaneous maintenance unrelated to business logic, such as code formatting)
    集成 → ci
    (Continuous integration configuration changes, such as Jenkins file adjustments)
    文档 → docs
    (Documentation-only updates, such as README modifications)
    性能 → perf
    (Performance optimizations, such as reducing algorithm complexity)
    更新 → feat
    (New features adding, such as adding a new module)
    修复 → fix
    (Bug fixing, such as fixing component render error)
    重构 → refactor
    (Code structure changes without altering functionality, such as module splitting)
    格式 → style
    (Code style adjustments, such as indentation or semicolon fixes)
    测试 → test
    (Adding or modifying test cases, such as completing unit tests)
    回退 → revert
    (Reverting a previous commit, such as undoing an incorrect merge)
    ```

- The body should explain the reason and impact of the change, not enumerate the touched files.

Example:

```plaintext
【修复】解决离线模式下封面图加载报错

离线模式时缓存键拼接遗漏了清晰度后缀，导致命中错误的缓存条目。
```
