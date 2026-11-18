# Windows Git Bash 插件配置页实施路线图

适用版本为项目锁定的 DSH `0.2.2-rc.2`。完成后的入口是 **侧边栏 → 插件 → 已安装的 Git Bash 插件**。DSH 提供详情页的返回导航、标题、说明和插件管理操作。插件贡献的区域只有一个「Git Bash 路径」文本框和一个位于右侧的「保存并链接」按钮。官方「终端」页继续管理共享 Shell 设置。

## 1. 接通客户端发现

配置页沿用 DSH 原生控件和默认样式，重建操作限定在原生 Windows DSH 的当前 profile 内。[项目约定](../AGENTS.md)

DSH 的 Client Modules 按 **Loader 条目的模块名** 发现客户端。现有 `git-bash-adapter` 行加载的是 `dsh-git-bash-on-win/adapter`。这个版本会跳过包子路径。运行时由 adapter 导入的执行器也不会产生一个新的包根 Loader 条目。仅在清单里增加 `./client` 导出还不足以让页面出现。[当前挂载方式](../cordis.patch.yml) · [当前模块映射](../src/adapter.ts)

**包根用于加载插件，执行器用 `/executor` 默认导入。** 当前 `src/adapter.ts` 已导出 Cordis 使用的 `apply` 和 `inject`，`src/index.ts` 已默认导出 `GitBashExecutor`、具名导出类型 `Config`。公开入口由 `package.json` 决定，可以直接映射到这两个文件的构建产物。DSH `0.2.2-rc.2` 使用的 Loader 对包根取得适配器模块，对 `/executor` 取得执行器类，两者都遵循原有的 `unwrapExports` 行为。[包清单](../package.json) · [适配器](../src/adapter.ts) · [执行器](../src/index.ts)

| 使用方 | 公开入口 | 构建产物 |
| --- | --- | --- |
| DSH Loader 和需要手动挂载插件的代码 | `dsh-git-bash-on-win` | `lib/adapter.js`，类型为 `lib/adapter.d.ts` |
| 需要执行器类或其配置类型的代码 | `dsh-git-bash-on-win/executor` | `lib/index.js`，类型为 `lib/index.d.ts` |

1. 将 `main`、`types`、`exports["."]` 指向适配器的对应产物，新增 `exports["./executor"]` 指向现有执行器产物。将补丁切换到包根时一并移除 `exports["./adapter"]`。NodeNext 构建会照常生成这两个模块及声明。这个映射直接复用现有文件，无需增加转导出文件或在包根额外导出执行器。[构建配置](../tsconfig.build.json)
2. 在 `cordis.patch.yml` 中保留 `git-bash-adapter` 条目 ID，将模块名改为裸包名。同步把适配器表中 `pwsh-sandbox` 的替换目标改为 `dsh-git-bash-on-win/executor`。继续使用 `entry.parent.tree.import()` 和 `ctx.loader.unwrapExports()` 装载替换目标，保留原生 Shell 条目 ID、模块名和配置对象。
3. 原先从包根默认导入执行器或导入其 `Config` 的调用方，只需在模块名后加 `/executor`。需要直接交给 `ctx.plugin()` 的代码可以使用 `import * as GitBashAdapter from 'dsh-git-bash-on-win'`。DSH 正常启动时由 Loader 挂载，业务代码无需手动导入适配器。

   ```ts
   import GitBashExecutor, { type Config } from 'dsh-git-bash-on-win/executor';
   ```

4. 更新 bootstrap 夹具的替换映射、补丁的模块名断言和安装包身份测试。用临时 profile 的 resolver 验证 Loader 从包根挂载适配器，`/executor` 默认类继承宿主的 `SandboxBashExecutor`，共享 schema 字段仍是宿主的原对象。直接导入 `src/index.ts` 或 `lib/index.js` 的实现测试继续验证同一文件。[入口及安装包测试](../test/bootstrap.test.ts)

5. 按 DSH 双端包格式声明 `dsh.client.platform: "web"`、客户端依赖和 `exports["./client"]`，保留 `dsh.bundle.platforms: ["win32"]`。浏览器产物按 DSH 的 `window.__ModuleLoader__.load` 格式注册，模块 ID 与包名一致。可沿用 ThinkPad 上 DSH Session Deletion 的单文件客户端构建方式，由宿主提供 React 和 UI primitives。客户端使用 `slots`、`configForms`、`locale` 服务，清单声明对应的插件管理、设置和本地化模块依赖。将客户端产物和所用中英文文案纳入实际安装包。包列表的本地化标题、说明可沿用 DSH 的 `./locale/*.json` 约定。

**本步验收**　在临时 Windows Web profile 安装实际构建出的包，确认注册了一个客户端模块、一个 Git Bash 执行器。用原生设置服务读取同一 profile 的 `pwsh-sandbox`，确认生效的 schema 同时含有 `gitBashPath` 和原生共享字段。没有 Web 服务的 Windows CLI 也应能执行原有 Git Bash 命令。

## 2. 把一个字段接入原生详情页

在客户端注册 keyed 插槽 `plugins.bundle.config`，键为完整包名 `dsh-git-bash-on-win`。插件管理器会在已安装包的详情页内渲染该插槽。截图中的官方「终端」使用 `plugins.item`，这是官方插件列表的入口。包级插槽在本版只传入 `view: 'page'`，不传行级 `form`。因此本插件应直接取 `ctx.configForms.get('pwsh-sandbox')`。这也正是官方 Shell 页在 Windows 使用的配置来源。

- 使用 DSH 原生 `Input` 和 `Button`。输入框标签为「Git Bash 路径」，右侧唯一按钮的文案固定为「保存并链接」。有配置时显示 Host 确认的路径。缺省时保持空白，placeholder 为「留空则自动查找 Git Bash 路径」。打开页面只读配置。Git 查找仍由后端在执行命令或明确请求重建时进行。[Git 发现实现](../src/runtime/git-installation.ts)
- 输入只更新页面草稿。切换窗口、Tab 移出输入框、在输入框内按 Enter 或确认输入法候选词，都不会保存或链接。返回同一已打开的页面可继续编辑，离开详情页或刷新会丢弃未提交的草稿。沿用官方「终端」页先编辑、再明确提交的习惯。输入框与 `type="button"` 按钮放在普通布局中，只给按钮绑定提交逻辑，避免表单隐式提交。键盘用户可用 Tab 聚焦按钮，再用 Enter 或空格激活同一个点击处理函数。
- 激活按钮时才判断是否需要保存。只处理 `pwsh-sandbox` 的 `gitBashPath` 字段。空串或全空白视为清除，通过表单快照的 `user` 判断当前 profile 是否有覆盖，有则 `unset`，没有则跳过写入。清除后恢复继承值，无继承路径时由后端自动查找。非空路径保留其中的空格，有变化才 `set`。路径未改也可以点击按钮，直接按已配置的路径或自动查找结果重新建立硬链接。
- 用 `form.mutate(ops, expectedRevision)` 提交变更，revision 取自开始编辑时的快照。后台刷新不能覆盖未提交草稿。保存被拒绝、版本冲突或请求异常时，保留输入并提示用户核对后重试。共享 Shell 字段继续由官方「终端」页管理。表单不可用或部署只读时，呈现对应状态。

**本步验收**　从侧边栏点击一次插件即看到字段。修改或清空后点击「保存并链接」，重开时显示 Host 确认的值。对照修改前后的 profile，只有目标路径覆盖发生了预期变化。官方终端页的超时和输出上限仍能独立编辑并用于 Git Bash。

## 3. 让按钮调用当前执行器一次

后端已完成两处模块改名。在线重建仅在硬链接探测遇到权限不足时进入 `src/setup/elevated-linking.ts`，由它管理提权计划、租约和代理进程。离线恢复和卸载使用 `src/purge-runtime-cache.ts`，构建后的命令为 `node '<installed package>/lib/purge-runtime-cache.js' '<absolute profile directory>/.git-bash-on-win'`。运行前须关闭使用该 profile 的所有 DSH 实例。[提权链接模块](../src/setup/elevated-linking.ts) · [缓存清除入口](../src/purge-runtime-cache.ts) · [README 操作说明](../README.md)

在 Git Bash 执行器实例的作用域内，通过 Cordis 可选注入 `connection` 接入 Web 操作。例如，用 `ctx.connection.fetch.register` 注册一个仅接收 `POST` 的精确路径 `/api/git-bash-on-win/rebuild`，声明 `requestBody: 'buffered'`。处理函数等待该实例的 `rebuildRuntime()` 完成再返回成功。请求无需携带路径、profile 或缓存目录。DSH Connection 负责 Host/Origin 校验、身份认证、精确路由的 owner 限制和调用方 fiber 销毁时的路由撤销。这样即可复用 DSH 的 Web 接入能力，CLI 执行器也无需依赖 Web 服务。[现有重建方法](../src/index.ts) · [重建和销毁约定](backend-20261117-design-decisions.md)

1. 按钮是唯一提交入口。激活时锁定本次操作，暂时禁用输入框和按钮，防止双击或键盘重复激活。依次执行必要的字段写入和一次重建请求。有改动就等待 Host 确认，保存失败立即停止。没有改动就直接请求重建。处理中状态和反馈只属于这一次操作。
2. 重建成功后显示「硬链接已建立」。若路径已保存而后端重建失败，保留已确认的配置，提示「路径已保存，硬链接建立失败」及后端原因。用户可修正路径，或原样再次点击以仅重试链接。两步结果分别呈现。操作结束后恢复控件，按钮文字始终为「保存并链接」。断线后不自动重发。
3. 在线重建沿用已有的缓存、锁、并发和销毁逻辑。已有可用实例在同一选择的重建失败时继续按现有契约工作。按钮直接调用在线重建方法。硬链接、目录视图、锁和中断残留均由现有 profile 私有缓存管理。沿用现有受限提权流程，源文件内容、ACL、全局 PATH 和注册表须保持原状。创建及删除硬链接产生的 NTFS 元数据记录遵循项目既有例外。[维护及卸载说明](../README.md)

## 4. 用实际安装包验收

| 场景 | 通过条件 |
| --- | --- |
| 构建和发现 | 更新现有产物、导出和 Loader 身份断言。实际安装包中有浏览器入口及其资源，DSH 原生插件列表只出现一个包入口。返回、重新进入和重启后均可打开。 |
| 首次打开与回显 | 空 profile 只显示 placeholder，打开、刷新、未编辑即失焦均为零写入、零 Git 探测。已有自定义路径原样回显。 |
| 草稿与明确提交 | 输入半条路径后切换窗口、Tab 失焦、在输入框按 Enter 或确认输入法候选词，均为零写入、零重建。回到同一页面草稿仍在，刷新后回显 Host 已保存值。鼠标点击和键盘聚焦按钮后激活产生相同结果。 |
| 保存与链接 | 在临时 profile 预设共享字段。改路径点一次，延迟保存回包，验证只写一次、确认前零重建、确认后一次重建。清空或全空白按覆盖情况执行 `unset` 或跳过写入。路径未变仍可重建，双击不重复执行。所有情况均保留共享字段及固定按钮文案。 |
| 失败与重试 | 保存被拒绝、版本冲突或请求异常时保留草稿且不重建。保存成功但重建失败时，反馈区分两步结果，再次点击相同路径只重试链接。 |
| 运行时 | 在一次成功重建后实际执行 Bash 命令。复用现有缓存和子进程测试验证 DSH 关闭时的生命周期，并检查离开页面后 UI 订阅释放。 |
| 隔离和卸载 | 验证普通 Windows CLI、普通 Git Bash 及 WSL2 对照环境。只有使用本插件的原生 Windows DSH profile 提供操作。用实际安装包的 `lib/purge-runtime-cache.js` 在临时 profile 验证离线清除。按 README 完整卸载，保留共享 Shell 设置，清除插件路径覆盖与私有缓存，验证源硬链接计数恢复。受阻清理仍须显式失败。 |

自动化优先扩展现有 bootstrap/安装包测试，加一个覆盖字段提交顺序和重建次数的客户端测试，再用实际 DSH Web 检查一次侧边栏入口。Windows 发布检查沿用 `pnpm test:release`。最后更新 README 中“没有前端或重建按钮”的现状描述，以及用户实际看到的入口和恢复方式。

## 核对依据

- DSH `0.2.2-rc.2` 的 `@deepseek-ai/dsh-client-ui-plugin-manager`，见 `src/client/slot-contract.ts` 和 `PluginManagerPage.tsx`，分别定义三种配置插槽和包详情页传入的参数。
- 同版本的 `@deepseek-ai/dsh-client-ui-settings-shell`、`@deepseek-ai/dsh-client-ui-settings`，见 `shell-card-controller.ts` 与 `config-form-types.ts`，分别给出实际配置命名空间和按字段写入协议。
- 同版本的 `@deepseek-ai/dsh-client-modules` 和 `@deepseek-ai/dsh-client-connection`，见 `src/client/manifest.ts`、`src/index.ts` 和 Connection 的 `src/rpc-host.ts`，用于核对包根发现、原生请求准入与路由生命周期。
- ThinkPad 上的 `DSH會話刪除 - DSH_Session_Deletion`，见 `package.json` 和 `src/client.ts` 的双端包声明、客户端加载格式与宿主控件使用方式。
