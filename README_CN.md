# **DSH Git Bash on Windows**

<p align="center">
  <a href="README_CN.md">中文</a> | <a href="README.md">English</a>
</p>

<span style="margin-left:2em;">&#8203;</span>为 **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)** 在 Windows x64 下提供 Git Bash 执行能力的扩展插件。

## **1 - 项目简介**

<span style="margin-left:2em;">&#8203;</span>DeepSeek Harness `0.2.2-rc.5` 在 Windows 下默认使用 PowerShell（`pwsh-sandbox` / `tool-pwsh`），直接切换为 Git Bash 会因 MSYS2 在受限沙箱令牌下权限受阻而无法启动。

<span style="margin-left:2em;">&#8203;</span>`dsh-git-bash-on-win` 为 Windows 版 DSH 提供开箱即用的 Git Bash 后端（支持 `ucrt64` 与 `mingw64` 布局），在保留沙箱限制、审批、超时、输出截断与后台托管等原生机制的同时，将终端工具切换为 Bash。

## **2 - 核心特性**

- **完整支持 DSH 三种沙箱模式**：在 `read-only`、`workspace-write` 与 `danger-full-access` 下直接运行 Git Bash，沿用原生的工作区授权、审批、超时、标准流与后台任务管理，无需放宽沙箱或切换到 WSL。
- **轻量共享的运行时缓存**：每次构建运行环境仅复制 Git `usr/bin` 目录下的普通文件（实测 `ucrt64` 约 89 MiB），其余资源通过目录联接复用。同一 DSH 主目录下的命令与配置会共享匹配的缓存版本，被替换的旧缓存可能保留至下次重建或离线清理。
- **严格隔离、无全局侵入**：缓存与写锁均存放在 DSH 主目录内，不修改已安装的 Git 原文件及权限、系统注册表、全局环境变量，也不影响日常使用的 Git Bash。

## **3 - 使用指南**

### **3.1 - 配置 Git Bash 路径与手动重建**

1. 在 DSH Web 左侧边栏进入 **「插件」**，选择 **「DSH Git Bash on Windows」**。
2. 在 **「Git Bash 路径」** 中按需填写并点击 **「保存并重建」**：
   - **自动查找（推荐）**：留空即可自动探测常见安装目录下的 Git for Windows。
   - **手动指定**：便携版或自定义安装可填入 `bin/bash.exe` 或 `usr/bin/bash.exe` 的绝对路径。
   - **恢复默认**：清空输入框并点击 **「保存并重建」**，清除覆盖路径并恢复默认探测。
3. 常见操作说明：
   - **多标签页冲突**：若其他窗口先行保存过修改，界面会弹出 **「未保存」** 提示并列出最新路径，核对后重试即可。
   - **保存后重建失败**：已保存的路径会继续保留，排除路径或权限问题后再次点击 **「保存并重建」** 即可。
   - **共享参数**：超时、输出上限、工作目录与退出宽限期仍在 **「终端」** 设置页管理。

若手动编辑配置的 `cordis.patch.yml`，修改 `pwsh-sandbox.config` 时请务必保留原有的共享 Shell 参数（DSH 会整段替换 `config`）：

```yaml
- id: pwsh-sandbox
  config:
    gitBashPath: 'C:/Tools/Git/bin/bash.exe'
    # 在此保留原有的 timeoutMs、maxOutputBytes、graceMs 等共享 Shell 设置
```

### **3.2 - 自动准备与 Git 升级**

<span style="margin-left:2em;">&#8203;</span>首次执行命令时，插件会以当前用户权限自动准备运行环境缓存（无头模式流程相同）。升级 Git 前，请先关闭所有共用该主目录的 DSH 实例，待升级完成后再重新启动。之后执行下一条命令时，插件会自动检查 Git、MSYS 及软件包清单，发现变化便自动重建缓存。若曾手动改动或怀疑缓存损坏，可随时点击 **「保存并重建」** 强制刷新。

<span style="margin-left:2em;">&#8203;</span>若升级 Git 时仍有 DSH 实例在运行，请先停止执行新命令并关闭所有实例，待升级完成（若更新程序报错则先修复 Git）后再重启 DSH。重新执行此前中断的命令前，请先确认其执行结果；若问题依旧，可点击 **「保存并重建」**，或关闭全部实例后按第 6.2 节执行离线清理。

## **4 - 与原生 Linux Bash 的使用差异**

<span style="margin-left:2em;">&#8203;</span>日常的 Bash 写法（引号、管道、重定向、命令替换及常见 Git 命令，例如 `printf '%s\n' main | grep -Fx main`、`git status --short`）与 Linux 上基本一致。不过底层运行的仍是 Git for Windows 自带的 Windows 版工具；若脚本依赖 Linux 独有的程序、设备或系统服务，仍需在 Linux 环境中使用。在 Windows 上运行时，主要需留意以下几点：

- **路径与权限**：在 Bash 中可使用类似 `/c/Work` 的 MSYS 路径，调用 Windows 程序时 MSYS 会按需转换路径参数；不要直接在 Bash 中用 Windows 扩展长度路径（如 `\\?\...`）调用可执行文件（Git Bash 自身限制）。文件访问仍由 NTFS 和 Windows ACL 控制，工作区与临时目录权限由 DSH 统一授予。
- **嵌套 Shell**：在命令内再启动 Shell 时，请直接通过 `PATH` 调用 `bash` 或 `sh`（从 Bash 内直接调用已安装的 `usr/bin/bash.exe` 也可行）。避免调用 Git 自带的 `bin/bash.exe` 包装程序，它会绕过 `PATH` 直接启动原始 MSYS，在受限模式下会失败。
- **第三方程序启动 Git Bash**：在 `read-only` 和 `workspace-write` 模式下，原生 Windows 程序若写死了 Git 安装路径（例如 `C:\Program Files\Git\bin\bash.exe` 或 `C:\Program Files\Git\usr\bin\bash.exe`），会绕过插件运行环境导致 Bash 无法启动。请改为通过继承的 `PATH` 调用 `bash` 或 `sh`。
- **原生程序与调试工具**：通过 PowerShell 管道调用 Git 工具，以及使用 GDB 调试本地目标程序，在三种模式下均可正常工作；但在受限模式下，Node.js 通过管道启动子进程会报 `EPERM`（DSH 沙盒限制，默认 PowerShell 后端亦然）。其他 GUI 应用别名和调试器暂未逐一验证，需按实际场景测试。
- **应用商店打包工具与退出码**：PowerShell、WinGet 等打包应用会保持与 DSH 默认后端一致的应用包身份和原生退出码（例如 WinGet 在受限模式下仍会返回 `0x8A150001`），不过 Bash 仅会返回原生退出码的低 8 位。另外，DSH 只会等待自身托管的进程结束，打包应用额外拉起的子进程可能会在命令返回后继续运行。

## **5 - 环境要求**

- **DeepSeek Harness**：`0.2.2-rc.5`（`web` / `desktop` 配置与 `dsh headless`）
- **操作系统**：原生 **Windows x64**，**NTFS** 分区（Linux、macOS 与 WSL 下会自动跳过）
- **Node.js**：原生 Windows x64，版本范围为 `^24.21.0 || >=26`。
- **Git for Windows**：包含 `ucrt64` 或 `mingw64` 布局
- **包管理器**：`pnpm`

## **6 - 安装、清理与卸载**

### **6.1 - 从源码安装插件**

1. 在 **Windows 原生 Git Bash** 中进入仓库根目录安装依赖并注册插件（仓库已包含 `lib/`，改动过 `src/` 请先运行 `pnpm build`）：

    ```bash
    pnpm install --ignore-scripts --frozen-lockfile
    gitbash_pnpm="$(cygpath -m "$(type -P pnpm.exe)")"
    node scripts/plugin.ts "$gitbash_pnpm" web add "file:$(cygpath -m "$PWD")"
    ```

    - 若安装到 **DSH Desktop**，将 `web` 改为 `desktop`；若有多个 DSH 安装，可用 `DSH_PACKAGE_JSON` 指定目标 `@deepseek-ai/dsh/package.json` 绝对路径。
    - 若 DSH 可按名称解析 `pnpm`，也可直接运行 `dsh plugin --profile web add "file:$(cygpath -m "$PWD")" --ignore-scripts`。

2. 后续更新时，请先关闭共用该主目录的所有宿主，更新各个已安装此插件的配置，再以普通权限重启 DSH。

### **6.2 - 离线清理缓存与故障排查**

<span style="margin-left:2em;">&#8203;</span>需要重置缓存或清理残留时，请**先关闭所有共用该主目录的 DSH 实例**（含后台空闲实例），再运行离线清理命令：

```bash
node '<已安装插件目录>/lib/purge-runtime-cache.js' '<DSH 主目录绝对路径>/.dsh-git-bash-on-win'
```

常见阻碍排查：

| 遇到的问题 | 处理方式 |
| :---: | :---: |
| 无法确认所有权或含重解析点 | 核对路径是否为 `DSH_HOME` 下的 `.dsh-git-bash-on-win` |
| 目录被占用或存在活动引用 | 关闭所有共用该主目录的 DSH 进程后重试 |
| 拒绝访问或缓存文件被占用 | 解除报告的阻碍后重试离线清理 |
| 准备中断或源目录异常 | 检查源 Git 完整性后点击 **「保存并重建」** 重试 |

清理成功后重启 DSH 即可按需重建，或点击 **「保存并重建」** 立即重建。

### **6.3 - 彻底卸载插件**

<span style="margin-left:2em;">&#8203;</span>若只从一个配置移除插件，请按第 1 步清除该配置的覆盖项，关闭使用它的宿主，并省略下方命令中的 `--purge-cache`，其他配置可继续使用缓存。如需彻底卸载插件，请按顺序操作：

1. **移除配置项**：针对每个要卸载插件的配置，在原生配置编辑器或 `cordis.patch.yml` 中仅删去 `pwsh-sandbox` 下的 `gitBashPath`（保留 `timeoutMs`、`maxOutputBytes`、`graceMs` 等共享设置；若手动添加的条目已为空可一并删除）。
2. **关闭相关 DSH 实例**：退出所有共用该主目录的 DSH 进程（含空闲实例），防止后台重建缓存。
3. **清理缓存并卸载插件**：在 **Windows 原生 Git Bash** 中执行卸载脚本（自动先清缓存再卸载）：

    ```bash
    gitbash_pnpm="$(cygpath -m "$(type -P pnpm.exe)")"
    node scripts/plugin.ts "$gitbash_pnpm" web remove dsh-git-bash-on-win --purge-cache
    ```

    若直接使用原生 CLI，需**先**运行第 6.2 节清理命令，再执行 `dsh plugin --profile web remove dsh-git-bash-on-win --ignore-scripts`（多个配置使用此包时请逐个卸载，共享缓存只需清理一次）。

## **7 - 开发与测试**

<span style="margin-left:2em;">&#8203;</span>以下命令均需在 **Windows 原生 Git Bash** 中运行。执行 `pnpm build` 会将 `src/` 与原生兼容库 `native/dsh-msys-compat.c` 一并编译到受跟踪的 `lib/` 目录；修改源码后，请重新构建并将更新后的产物一并提交。

<span style="margin-left:2em;">&#8203;</span>完整构建依赖本地的 x64 MSVC 与 Windows SDK（仅开发构建时需要，已安装的插件包无需编译器）。构建脚本会自动查找工具链，也可通过 `DSH_MSVC_TOOLS_DIR`、`DSH_WINSDK_DIR` 和 `DSH_WINSDK_VERSION` 手动指定。发布构建（`pnpm build:release` 与 `pnpm pack`）还会对照 `native/build.json` 校验工具版本及 DLL 哈希。

<span style="margin-left:2em;">&#8203;</span>`pnpm build:js` 和 `pnpm test:browser` 只会重新编译脚本部分并复用此前构建好的 DLL，因此首次拉取代码或修改原生代码后，请先运行一次 `pnpm build`。

```bash
pnpm install --ignore-scripts --frozen-lockfile
pnpm check          # TypeScript 类型检查
pnpm lint           # ESLint 检查（零警告）
pnpm build          # 完整构建 lib/（含原生兼容 DLL）
pnpm test:windows   # 运行单元与原生集成测试
pnpm test:browser   # 运行 Playwright 浏览器测试
pnpm test:release   # 发布前完整校验（环境预检、代码检查、发布构建及全部测试）
```

<span style="margin-left:2em;">&#8203;</span>若 Chrome 未安装在默认路径，可通过 `CHROME_PATH` 指定可执行文件位置。此外，还可根据需要运行 `node --test test/benchmark-runtime.ts`（性能基准测试）或 `DSH_TEST_WINGET=1 node --test test/qualify-host.ts`（验证打包版 PowerShell、WinGet 与 GDB 的兼容性）。
