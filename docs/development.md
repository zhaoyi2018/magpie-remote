# 开发与发布

## 开发命令

代码是标准 ESM JavaScript，没有编译步骤。后端测试使用 Node 内置测试库，浏览器回归使用开发依赖 `playwright@1.64.0`；运行依赖锁定为 `ssh2@1.17.0`。

```powershell
npm ci --ignore-scripts --omit=optional
npm run check
npm test
```

`check` 检查 JavaScript 语法、入口导出和本地 Markdown 文件链接。测试临时启动仅监听本机随机端口的 SSH/TCP 服务，验证密码和私钥认证、真实双向数据流及异常清理。测试不会连接配置中的真实服务器。

`npm run test:ui` 启动临时管理服务和 `allow-scripts` iframe，实际操作密码保存与编辑、取消清空、Enter 单次提交、并发配置冲突和转发保存 / 启动期间的关闭保护，并验证转发数据往返及桌面 / 窄屏布局。首次可运行 `npx playwright install chromium`；Windows 未安装 Playwright Chromium 时会使用已有 Edge，也可通过 `MIGPIE_UI_BROWSER` 指定 Chromium 可执行文件。截图默认保存到不入库的 `.local/ui-regression/`，可用 `MIGPIE_UI_ARTIFACTS` 指定目录。浏览器检查独立于 `npm test`；发布前运行 `npm run check:release`，一次完成静态、Node 和页面回归，不需要日常 Magpie 或生产凭据。

`check` 同时检查插件卡片和页面使用同一个 SVG、图标解码后的内容不超过 1 MB、`package.json` 不超过 GitHub 插件发现读取的 1 MB 上限。更新 `page/icon.png` 或 `page/icon-dark.png` 后运行 `npm run icons`；生成器会更新 `page/icon.svg` 和 `package.json` 中的 `magpie.icon`，无需手工粘贴图标数据。

测试专用的固定 Ed25519 密钥保存在 `tests/fixtures.mjs`，包含未加密和加密样本，不能用于实际服务器。固定样本避免 ssh2 随机生成某些前导零公钥时出现的偶发解析失败；测试同时核对私钥解析结果与声明的公钥。这些样本与其他测试文件均不随 npm 包发布。

`tests/passwords.test.mjs` 覆盖密码加密与重载、留空保留和显式替换、服务器信息重新绑定、切换认证移除密文、版本冲突、篡改或丢失密钥、并发密钥创建、加密备份恢复、管理页保存后无额外凭据登录，以及宿主启动和断网后的密码重连。所有密码和服务均为本地测试数据。

`tests/reconnect.test.mjs` 通过停止 / 重开本机 SSH 服务及 `tests/network-proxy.mjs` 的双向丢包代理，验证显式断线、静默断网、恢复、退避上限、手动停止、临时凭据缺失和跨连接隔离。测试缩短保活与重试间隔，不修改系统网卡、防火墙或日常连接。`tests/backups.test.mjs` 验证快照轮换、无变化不轮换、损坏文件原样保留、过期预览、备份失败、并发恢复和连接停止；HTTP 测试覆盖主配置损坏时的已认证恢复入口。

`tests/consistency.test.mjs` 验证旧版本写入与删除保护、同连接排队冲突、独立连接互不冲突、无变化版本稳定，以及删除失败保护和运行记录清理。`tests/forward-diagnostics.test.mjs` 使用本机 SSH 服务、迟到通道回调及可注入的本地目标连接，验证双向目标超时、真实拒绝与恢复、旧请求不覆盖新结果和快照隔离；不使用外部不可达地址模拟超时。HTTP 测试还覆盖并发页面编辑的版本保护。

`tests/remote-results.test.mjs` 覆盖恢复协议的空尾字段、Base64 路径、重复/矛盾记录与摘要字段白名单；`tests/remote.test.mjs` 另验证派发前重启、派发边界保存失败、旧记录保守核实、历史查询/轮换、损坏历史保护与恢复结果跨重启保留。`tests/sessions.test.mjs` 注入远端取消监听的拒绝、超时和断链，要求关闭受影响 SSH、释放双向监听且独立连接仍能传输。

`tests/remote-exec.test.mjs` 使用本机真实 SSH 通道验证标准输入、双输出、分片 UTF-8 实时标准输出、退出状态、输出上限、超时与断线。`tests/remote.test.mjs` 使用隔离状态文件和注入的远端响应验证生命周期预览、去重、环境变化、普通配置归档、恢复预览绑定、分片进度校验、下载阶段断线后的未知结果、卸载范围和 Web 转发冲突。`npm run test:remote` 通过标准输入向真实 POSIX shell 传入生成脚本，使用临时 HOME 和假的 Magpie / systemd 命令，并用逐步写入的临时文件验证下载字节在任务结束前输出；Windows 自动定位 Git Bash，也可用 `MIGPIE_BASH` 指定。它验证脚本行为，不下载程序或改变真实服务。

`npm run test:ui:remote` 通过真实管理服务、受控 SSH 测试服务和 `allow-scripts` iframe，验证远程面板的检测、预览确认、后台任务、下载字节与速度、可信总量下的百分比、阶段切换与终态清理、刷新和跨连接响应隔离，以及未知结果、无口令备份与恢复、统一日志去重、敏感链接清理和 390px 布局。SSH 测试服务仅识别固定脚本并返回测试响应，不执行部署。截图默认保存到 `.local/remote-ui-regression/`。

如需使用与宿主一致的 Bun：

```powershell
bun test tests --timeout 15000
```

Magpie 的缓存 Bun 未加入 PATH 时，可使用其可执行文件的绝对路径运行同样的命令。

## SVG 图标复用约定

页面和弹窗中的 SVG 图标统一由[公共图标模块](../page/icons.js)管理，开发时遵守以下约定：

- 使用图标前先检查公共库，已有相同或同义图标时直接复用，不重复添加。
- 静态位置使用 `data-icon="图标名称"`，由 `renderIcons()` 统一渲染；动态创建和切换图标使用公共模块的 `icon()`、`setIcon()`。
- 公共库中确实没有所需图标时，才在 `page/icons.js` 的 `definitions` 中新增，并使用明确、可复用的名称。页面 HTML 和业务脚本中不单独定义或复制 SVG 路径、`symbol`。
- 图标颜色和尺寸通过公共样式及所在组件的 CSS 调整，不为样式差异新增同一图标的副本。

## 与 Magpie 规范对应

| 规范要求 | 本项目实现 |
| --- | --- |
| 包入口可由 `exports["./server"]`、`main` 等定位 | 两者均指向根目录 `index.mjs` |
| 入口支持 `export default { id, server }` | 仅导出该对象，辅助函数位于 `src/` |
| 插件函数接收 `input, options`，返回 hooks | `createPlugin` 启动页面后台并返回空对象，不注册 MCP 工具或模型供应商 |
| 页面操作可以取消 | 本机 HTTP 请求中断时将取消信号传入会话层 |
| npm 安装不会运行依赖安装脚本 | 纯 JavaScript 路径已在禁用脚本、排除可选原生包的安装下测试 |
| Git / 目录安装需要已存在的入口文件 | 全部运行源码随 Git 跟踪，无 `dist` 依赖 |
| 页面与插件卡片的图标字段不同 | `magpie.page.icon` 使用包内路径，`magpie.icon` 使用内嵌 SVG data URI |

规范来源：[官方中文文档](https://usemagpie.ai/docs/zh/plugins)、[官方英文文档](https://usemagpie.ai/docs/plugins)。SSH 接口来源：[ssh2 官方仓库](https://github.com/mscdex/ssh2)。类型与图标配置核对日期为 2026-10-23，后续升级应复核宿主接口。

本插件仅作为用户管理页面使用；服务端入口是页面后台的启动方式，不应为隐藏标签而删除 `main` / `exports`，否则宿主会跳过 SSH 后台。Magpie 当前的「已安装」卡片判断将有服务端入口、但没有工具或其他受支持类型的页面回退标成「供应商」；该标签不表示本插件注册了供应商。要让此类插件只显示「页面」，需由 Magpie 修改类型判断。升级后重新加载插件；不同 Magpie 版本的具体展示以实际界面为准。

## 独立宿主验证

项目提供 `scripts/host-smoke.mjs`，直接启动已有的 Magpie 插件宿主文件，而不会加载日常使用的插件清单或账户。两个参数分别是 Bun 可执行文件和 Magpie 缓存的 `host-*.js` 文件的绝对路径：

```powershell
node scripts/host-smoke.mjs 'C:/path/to/bun.exe' 'C:/path/to/host-current.js'
```

脚本自动把入口、src、page 和清单复制到临时源码目录，排除原目录的 `page/.runtime/`，通过目录链接复用已安装依赖。子进程使用独立 HOME、USERPROFILE、XDG 目录和认证文件，只装入该隔离副本。随后通过宿主 RPC 检查没有注册工具或供应商，并通过该宿主启动的页面后台验证测试配置、SSH 认证、双向转发数据往返、断线自动重连、备份预览恢复、取消重连意图、释放端口与删除配置。测试结束后关闭该子进程并清理其临时目录及依赖链接，不删除源依赖。该脚本只用于开发验证，内部宿主协议变化时需要复核。

宿主只向临时副本的 `page/.runtime/` 发布启动地址，日常源码的启动文件不会被覆盖；无需事先手动复制源码。`--ui` 通过 `getEndpoint` 回调读取该副本的地址；纯页面验证同样通过 `startUIHarness({getEndpoint})` 使用隔离管理服务。`tests/host-sandbox.test.mjs` 验证发布与清理前后源启动文件、源码和依赖均保持不变。

若通过完整 Magpie CLI 做隔离测试，也需为子进程设置独立的 HOME、USERPROFILE、XDG_CONFIG_HOME、XDG_CACHE_HOME 和未占用的 MAGPIE_ADDR，避免读写日常配置。Windows 自动化使用 PowerShell 7 的 `pwsh -NoProfile`。

## 修改与发布

修改源码后运行 `npm run check` 和 `npm test`。发布前使用 `npm run check:release` 生成 `.local/release-check.json`，包含源码指纹、提交、运行时、逐项结果与包清单；缺少 Bun、实际宿主或真实 Linux 记录会标为 `not_run`，报告为 `incomplete`。`npm run check:release:strict` 要求全部验收通过，可附 `-- --bun <绝对路径> --host <绝对路径> --linux-result <JSON>`。真实 Linux 入口、固定官方资产与清理见[发布门禁与 Linux 验收](linux-acceptance.md)。在 Magpie 桌面重新加载此插件后，宿主才会读取修改。

```powershell
npm pack --dry-run
```

`prepack` 会执行静态检查和测试。包文件白名单只包含运行源码、说明、示例和许可证；测试、脚本、安装依赖、私钥、环境文件与本地数据不随 npm 包发布。

远程仓库为 `git@github.com:zhaoyi2018/migpie-remote.git`，尚未执行 npm 发布。Git 安装所需的 `package.json` 和运行源码保留在仓库中；社区列表登记和 npm 发布需单独执行。

可视化管理页由 `page/` 和 `src/web-server.mjs` 实现，页面后台操作共用会话。开发时可给宿主验证脚本追加 `--ui`，它会提供带 Magpie iframe 沙箱策略的浏览器测试入口；输入 `check` 验证页面所创建转发的数据往返，输入 `close` 退出。启动信息 `page/.runtime/` 不应提交或发布。

源码依据：[package.json](../package.json)、Git 仓库中的 `scripts/check.mjs` 和 `scripts/host-smoke.mjs`；这些开发脚本不随 npm 包发布。返回[文档导航](README.md)。
