# **DSH Git Bash on Windows**

<p align="center">
  <a href="README_CN.md">中文</a> | <a href="README.md">English</a>
</p>

<span style="margin-left:2em;">&#8203;</span>为 **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)** 在 Windows x64 下提供 Git Bash 执行能力的扩展插件。

## **1 - 项目简介**

<span style="margin-left:2em;">&#8203;</span>DeepSeek Harness `0.2.2-rc.5` 在 Windows 下默认使用 PowerShell（`pwsh-sandbox` / `tool-pwsh`），直接切换为 Git Bash 会因 MSYS2 在受限沙箱令牌下权限受阻而无法启动。

<span style="margin-left:2em;">&#8203;</span>`dsh-git-bash-on-win` 为 Windows 版 DSH 提供开箱即用的 Git Bash 后端（支持 `ucrt64` 与 `mingw64` 布局），在保留沙箱限制、审批、超时、输出截断与后台托管等原生机制的同时，将终端工具切换为 Bash。

## **2 - 核心特性**

- 支持 DSH 的三种沙箱模式，沿用原生的工作区授权、审批、超时、标准流与后台任务管理。
- 每代运行环境独立复制 Git 的 `usr/bin` 普通文件（实测 ucrt64 约 89 MiB），其他资源通过目录联接访问。同一 DSH 主目录下的命令与配置共享匹配的版本。旧版本可能保留到下次构建或离线清理。
- 缓存和写锁位于 DSH 主目录内。插件保持 Git 原文件及其权限、注册表、全局环境和日常 Git Bash 环境不变。

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
   - **共享参数**：超时、输出上限、工作目录与退出宽限期仍在 **「Shell」** 设置页管理。

若手动编辑配置的 `cordis.patch.yml`，修改 `pwsh-sandbox.config` 时请务必保留原有的共享 Shell 参数（DSH 会整段替换 `config`）：

```yaml
- id: pwsh-sandbox
  config:
    gitBashPath: 'C:/Tools/Git/bin/bash.exe'
    # 在此保留原有的 timeoutMs、maxOutputBytes、graceMs 等共享 Shell 设置
```

### **3.2 - 自动准备与 Git 升级**

首次执行命令时，插件以当前用户权限准备缓存，无头模式也使用相同流程。升级 Git 前先关闭所有共享该主目录的 DSH 实例，升级完成后再启动。下一条命令检查 Git、MSYS 和软件包清单，发现变更时自动重建。自定义修改或缓存损坏后，可点击 **「保存并重建」** 强制重新复制。

若升级时仍有 DSH 实例运行，请暂停命令并关闭所有实例，完成升级并修复更新程序报告的问题，再启动 DSH。重试前先检查被中断命令的执行结果。若仍有问题，可手动重建，或关闭全部实例后按第 6.2 节离线清理。

## **4 - 命令行为**

管道、脚本和 Git 使用 Bash 语法。Windows ACL、MSYS 路径转换、Git 随附工具和原生 Windows 程序决定实际行为。DSH 管理进程范围并等待其结束。Windows 打包应用启动的原生后代可能在 DSH 报告结束后继续运行。

优先使用运行环境 PATH 中的 bash 或 sh。原生 `bin/bash.exe` 包装程序会启动已安装的 MSYS，在受限模式下可能失败。MSYS 子进程通过已安装的 `usr/bin` 路径启动时会重定向，原生程序硬编码该路径时会绕过此处理。受限模式下 Node 管道子进程可能报告 EPERM。Bash 对带引号的 Windows 扩展路径的处理与原生 argv 不同。

## **5 - 环境要求**

- **DeepSeek Harness**：`0.2.2-rc.5`（`web` / `desktop` 配置与 `dsh headless`）
- **操作系统**：原生 **Windows x64**，**NTFS** 分区（Linux、macOS 与 WSL 下会自动跳过）
- **Node.js**：原生 Windows x64，版本范围为 `^24.21.0 || >=26`。
- **Git for Windows**：包含 `ucrt64` 或 `mingw64` 布局
- **包管理器**：`pnpm`

## **6 - 安装、清理与卸载**

### **6.1 - 从源码安装插件**

从旧版硬链接后端切换前，请先用旧版的卸载流程彻底移除旧缓存。新格式会拒绝旧版缓存和无法确认所有权的目录。

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

    若直接使用原生 CLI，需**先**运行第 6.2 节清理命令，再执行 `dsh plugin --profile web remove dsh-git-bash-on-win --config.ignore-scripts=true`（多个配置使用此包时请逐个卸载，共享缓存只需清理一次）。

## **7 - 开发与测试**

<span style="margin-left:2em;">&#8203;</span>请在 **Windows 原生 Git Bash** 中执行以下命令。构建通过 `@typescript/native`（TypeScript 7）编译 `src/` 至受跟踪的 `lib/`，`typescript`（TypeScript 6）仅用于 ESLint；修改 `src/` 后请运行 `pnpm build` 并一并提交产物。

完整构建还会使用 x64 MSVC 和 Windows SDK 编译 `native/dsh-msys-compat.c`。`native/build.json` 记录发布工具版本、经审查的导入函数和获准的 DLL 哈希。工具发现使用 `vswhere`，优先选择固定工具集；开发时可通过 `DSH_MSVC_TOOLS_DIR`、`DSH_WINSDK_DIR` 和 `DSH_WINSDK_VERSION` 指定工具。开发构建验证 DLL 并报告实际工具版本及哈希；`pnpm build:release` 和 `pnpm pack` 还会强制校验发布记录。安装后的包不需要编译器。

`pnpm build:js` 和 `pnpm test:browser` 会保留此前完整构建的 DLL。请先运行 `pnpm build`，修改原生代码后也必须重新完整构建。

```bash
pnpm install --ignore-scripts --frozen-lockfile
pnpm check          # TypeScript 类型检查（src / scripts / test）
pnpm lint           # ESLint 检查（零警告）
pnpm build          # 重新构建 lib/
pnpm test:windows   # 运行全部单元与原生集成测试
pnpm test:release   # 环境预检 + check + lint + test:windows
pnpm test:browser   # Playwright 浏览器配置与弹窗测试
```

可通过 `DSH_BENCH_COLD_ONLY=1 node --test test/benchmark-runtime.ts` 测量冷复制耗时。
