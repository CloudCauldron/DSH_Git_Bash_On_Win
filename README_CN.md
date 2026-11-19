# **DSH Git Bash on Windows**

<span style="margin-left:2em;">&#8203;</span>为 **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)** 在 Windows x64 下提供 Git Bash 执行能力的扩展插件。

## **1 - 项目简介**

<span style="margin-left:2em;">&#8203;</span>DeepSeek Harness `0.2.2-rc.2` 在 Windows 下默认使用 PowerShell（`pwsh-sandbox` / `tool-pwsh`），直接切换为 Git Bash 会因 MSYS2 在受限沙箱令牌下权限受阻而无法启动。

<span style="margin-left:2em;">&#8203;</span>`dsh-git-bash-on-win` 为 Windows 版 DSH 提供开箱即用的 Git Bash 后端（支持 `ucrt64` 与 `mingw64` 布局），在保留沙箱限制、审批、超时、输出截断与后台托管等原生机制的同时，将终端工具切换为 Bash。

## **2 - 核心特性**

- **完整支持 DSH 三种沙箱模式**
  在 `read-only`、`workspace-write` 与 `danger-full-access` 下均可直接运行 Git Bash，无需放宽沙箱或改用 WSL，支持管道、子 Shell、原生子进程与多会话并发。
- **单份硬链接共享，几乎不额外占用磁盘空间**
  通过 NTFS 硬链接复用本机 Git 文件，全模式共用同一份基础目录，无需复制额外副本。
- **零侵入宿主环境**
  不修改 Windows 注册表、全局 `PATH`、环境变量及源 Git / DSH 的文件内容与权限（ACL）。日常 Git Bash 与 WSL 不受影响，按流程卸载清理后可还原源文件硬链接计数。

## **3 - 使用指南**

### **3.1 - 配置 Git Bash 路径与手动链接**

1. 在 DSH Web 左侧边栏进入 **「插件」**，选择 **「DSH Git Bash on Windows」**。
2. 在 **「Git Bash 路径」** 中按需填写并点击 **「保存并链接」**：
   - **自动查找（推荐）**：留空即可自动探测常见安装目录下的 Git for Windows。
   - **手动指定**：便携版或自定义安装可填入 `bin/bash.exe` 或 `usr/bin/bash.exe` 的绝对路径。
   - **恢复默认**：清空输入框并点击 **「保存并链接」**，清除覆盖路径并恢复默认探测。
   - **链接进度**：输入框下方会显示链接进度和当前相对路径，链接结束后恢复路径说明。
3. 常见操作说明：
   - **多标签页冲突**：若其他窗口先行保存过修改，界面会弹出 **「未保存」** 提示并列出最新路径，核对后重试即可。
   - **保存后链接失败**：已保存的路径会继续保留，排除路径或权限问题后再次点击 **「保存并链接」** 即可。
   - **共享参数**：超时、输出上限、工作目录与退出宽限期仍在 **「Shell」** 设置页管理。

若手动编辑配置的 `cordis.patch.yml`，修改 `pwsh-sandbox.config` 时请务必保留原有的共享 Shell 参数（DSH 会整段替换 `config`）：

```yaml
- id: pwsh-sandbox
  config:
    gitBashPath: 'C:/Tools/Git/bin/bash.exe'
    # 在此保留原有的 timeoutMs、maxOutputBytes、graceMs 等共享 Shell 设置
```

### **3.2 - 自动建链、权限确认与无头模式**

- **自动准备**：首次执行 Bash 命令或 Git 升级导致关键文件变更时自动建立硬链接，完成后提示 **「已建立链接」**。
- **按需授权（UAC）**：若 Git 位于 `C:\Program Files\Git` 等受保护目录，建链时会按需请求一次管理员授权。授权仅用于创建硬链接，日常命令仍以普通权限运行。
- **无头模式（`dsh headless`）**：无交互窗口且需提权时，终端会中止并打印修复命令；在 Windows Git Bash 中运行后重启 DSH 重试即可：

    ```bash
    node '<已安装插件目录>/lib/link-runtime-cache.js' '<DSH 配置目录绝对路径>' '<bash.exe 绝对路径>' ['<DSH 安装锚点路径>']
    ```

## **4 - 注意事项**

<span style="margin-left:2em;">&#8203;</span>使用和排错时请注意以下事项：

1. **Git 与 DSH 配置须位于同一 NTFS 分区**
   Windows 硬链接无法跨盘符创建，也不支持 FAT32 / exFAT 等非 NTFS 文件系统。Git 安装目录与 DSH 配置目录（默认 `.dsh\profiles\<配置名>`，可通过 `DSH_HOME` 调整）必须处于同一 NTFS 卷。
2. **勿在同一配置中混用其他改写 Shell 的插件**
   插件直接复用原生 `pwsh-sandbox`、`tool-pwsh` 与 `preset-standard`、`preset-ptc`、`preset-cordis` 条目，请勿混用其他 Shell 替换插件或改动对应模块名。
3. **源目录、缓存目录与工作区不得重叠**
   缓存固定位于 `<配置目录>/.git-bash-on-win`（不支持更改）。Git 源目录、缓存目录与命令工作区三者不可相同或互相包含，路径沿途应避免经过 Junction 或符号链接。
4. **源 Git 文件不可设为「只读」**
   部分便携版 Git 文件若带有 Windows「只读」属性，请先取消只读属性后再建链或清理。
5. **缓存体积与文件更新**
   硬链接共享源文件磁盘数据，文件管理器显示的体积并非额外占用；原地修改源文件会同步生效。升级 Git 或附属文件缺失时，在插件页点击 **「保存并链接」** 即可重建。
6. **普通权限运行，勿直接递归删除缓存**
   安装、更新及日常使用请以普通权限启动 DSH；切勿用 `rm -rf` 或文件管理器强删 `.git-bash-on-win`，清理时须先关闭所有相关 DSH 实例再执行第 6.2 节命令。

## **5 - 环境要求**

- **DeepSeek Harness**：`0.2.2-rc.2`（`web` / `desktop` 配置与 `dsh headless`）
- **操作系统**：原生 **Windows x64**，**NTFS** 分区（Linux、macOS 与 WSL 下会自动跳过）
- **Node.js**：`>= 26`（原生 Windows x64）
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

2. 以普通权限重启 DSH 即可使用（安装或更新会保留现有缓存）。

### **6.2 - 离线清理缓存与故障排查**

<span style="margin-left:2em;">&#8203;</span>需要重置缓存或清理残留时，请**先关闭所有使用该配置的 DSH 实例**（含后台空闲实例），再运行离线清理命令：

```bash
node '<已安装插件目录>/lib/purge-runtime-cache.js' '<DSH 配置目录绝对路径>/.git-bash-on-win'
```

常见阻碍排查：

| 遇到的问题 | 处理方式 |
| :---: | :---: |
| 无法确认所有权或含重解析点 | 核对路径是否为该配置下的 `.git-bash-on-win` |
| 目录被占用或存在活动引用 | 关闭所有使用该配置的 DSH 进程后重试 |
| 存在未退出的提权计划或阻塞 | 等待提权辅助进程释放句柄后重新清理 |
| 拒绝访问或只读文件阻碍 | 解除对应路径的只读属性或占用后重试 |
| 链接中断或源目录异常 | 检查源 Git 完整性后点击 **「保存并链接」** 重试 |

清理成功后重启 DSH 即可按需重建，或点击 **「保存并链接」** 立即重建。

### **6.3 - 彻底卸载插件**

<span style="margin-left:2em;">&#8203;</span>如需彻底卸载插件并还原源文件硬链接计数，请按顺序操作：

1. **移除配置项**：在原生配置编辑器或 `cordis.patch.yml` 中仅删去 `pwsh-sandbox` 下的 `gitBashPath`（保留 `timeoutMs`、`maxOutputBytes`、`graceMs` 等共享设置；若手动添加的条目已为空可一并删除）。
2. **关闭相关 DSH 实例**：退出所有使用该配置的 DSH 进程（含空闲实例），防止后台重建缓存。
3. **清理缓存并卸载插件**：在 **Windows 原生 Git Bash** 中执行卸载脚本（自动先清缓存再卸载）：

    ```bash
    gitbash_pnpm="$(cygpath -m "$(type -P pnpm.exe)")"
    node scripts/plugin.ts "$gitbash_pnpm" web remove dsh-git-bash-on-win
    ```

    若直接使用原生 CLI，需**先**运行第 6.2 节清理命令，再执行 `dsh plugin --profile web remove dsh-git-bash-on-win --ignore-scripts`（多配置共用同一包时需逐个清理各配置缓存）。

## **7 - 开发与测试**

<span style="margin-left:2em;">&#8203;</span>请在 **Windows 原生 Git Bash** 中执行以下命令。构建通过 `@typescript/native`（TypeScript 7）编译 `src/` 至受跟踪的 `lib/`，`typescript`（TypeScript 6）仅用于 ESLint；修改 `src/` 后请运行 `pnpm build` 并一并提交产物。

```bash
pnpm install --ignore-scripts --frozen-lockfile
pnpm check          # TypeScript 类型检查（src / scripts / test）
pnpm lint           # ESLint 检查（零警告）
pnpm build          # 重新构建 lib/
pnpm test:windows   # 运行全部单元与原生集成测试
pnpm test:release   # 环境预检 + check + lint + test:windows
pnpm test:browser   # Playwright 浏览器配置与弹窗测试
```

如需手动验证真实 UAC 弹窗或运行监督器基准测试，先执行 `pnpm build`，再按需运行：

```bash
# 真实 UAC 弹窗验证（approve / deny / late）
DSH_GIT_BASH_UAC_TEST=approve node --test --test-name-pattern='manual UAC' test/provisioning.test.ts
DSH_GIT_BASH_UAC_TEST=deny node --test --test-name-pattern='manual UAC' test/provisioning.test.ts
DSH_GIT_BASH_UAC_TEST=late node --test --test-name-pattern='manual UAC' test/provisioning.test.ts

# 浏览器集成 UAC 验证
DSH_GIT_BASH_UAC_TEST=deny pnpm test:browser
DSH_GIT_BASH_UAC_TEST=approve pnpm test:browser

# 监督器基准测试
node --test test/benchmark-supervisor.ts
```
