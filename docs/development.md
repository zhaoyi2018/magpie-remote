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

页面测试的父框架还模拟 Magpie 的 10 秒 `hello` 启动期限。回归分别阻塞通信桥和启动样式表，并使通信桥加载失败，要求页面仍能及时响应宿主并在资源恢复后进入管理页。启动页与管理页均在样式表前执行 `theme.js`，启动页的宿主通信桥异步加载。

上述 HTTP 浏览器测试不等同于 Windows 原生 WebView2 验收。Magpie 0.1.3078 / WebView2 157.0.4341.46 的隔离桌面验证发现：入口 HTML 可读取，但沙箱发起的脚本、样式、图标及后续宿主文件导航绕过原生资源处理，实际访问 `wails.localhost` 并失败。直接在入口 HTML 使用 meta refresh 跳转到已认证的本机管理服务已通过同版本原生桌面验证，无需依赖启动脚本或第二个宿主 HTML。

`npm run prepare:desktop` 在 `.local/desktop-plugin` 生成本机安装入口，保持源码和发布包不含运行地址。包名使用 `migpie-remote-desktop`，使 Magpie 为兼容入口分配独立页面标识，避免替换安装后复用原插件的失败页面缓存。它导入当前 `src/plugin.mjs`，通过内部第三参数 `launcherFile` 指定生成页面；不增加用户可传入的插件选项。管理服务启动后，`publishDesktopLauncher` 校验回环认证 URL、原子发布 HTML；退出时仅清理自己发布的内容，恢复占位文件以供 Magpie 在下次启动后台之前发现页面。安装及替换步骤见[操作指南](usage.md)。

`npm run test:ui:desktop` 拒绝所有宿主子资源请求，验证直接入口仍能完成沙箱握手、显示在线状态、加载完整样式与图标并打开新建连接弹窗。`tests/desktop-launcher.test.mjs` 覆盖非法地址拒绝、旧宿主清理保护、真实插件关闭和重启后的地址更新；`tests/publish-file.test.mjs` 覆盖 Windows 临时文件锁重试，以及持续失败时旧入口和临时凭据的处理。该浏览器测试需结合原生桌面验收，不能单独证明某个 WebView 版本可用。

`check` 同时检查插件卡片和页面使用同一个 SVG、图标解码后的内容不超过 1 MB、`package.json` 不超过 GitHub 插件发现读取的 1 MB 上限。更新 `page/icon.png` 或 `page/icon-dark.png` 后运行 `npm run icons`；生成器会更新 `page/icon.svg` 和 `package.json` 中的 `magpie.icon`，无需手工粘贴图标数据。

测试专用的固定 Ed25519 密钥保存在 `tests/fixtures.mjs`，包含未加密和加密样本，不能用于实际服务器。固定样本避免 ssh2 随机生成某些前导零公钥时出现的偶发解析失败；测试同时核对私钥解析结果与声明的公钥。这些样本与其他测试文件均不随 npm 包发布。

`tests/passwords.test.mjs` 覆盖密码加密与重载、留空保留和显式替换、服务器信息重新绑定、切换认证移除密文、版本冲突、篡改或丢失密钥、并发密钥创建、加密备份恢复、管理页保存后无额外凭据登录，以及宿主启动和断网后的密码重连。所有密码和服务均为本地测试数据。

`tests/reconnect.test.mjs` 通过停止 / 重开本机 SSH 服务及 `tests/network-proxy.mjs` 的双向丢包代理，验证显式断线、静默断网、恢复、退避上限、手动停止、临时凭据缺失和跨连接隔离。测试缩短保活与重试间隔，不修改系统网卡、防火墙或日常连接。`tests/backups.test.mjs` 验证快照轮换、无变化不轮换、损坏文件原样保留、过期预览、备份失败、并发恢复和连接停止；HTTP 测试覆盖主配置损坏时的已认证恢复入口。

`tests/consistency.test.mjs` 验证旧版本写入与删除保护、同连接排队冲突、独立连接互不冲突、无变化版本稳定，以及删除失败保护和运行记录清理。`tests/forward-diagnostics.test.mjs` 使用本机 SSH 服务、迟到通道回调及可注入的本地目标连接，验证双向目标超时、真实拒绝与恢复、旧请求不覆盖新结果和快照隔离；不使用外部不可达地址模拟超时。HTTP 测试还覆盖并发页面编辑的版本保护。

`tests/forward-conflicts.test.mjs` 覆盖远端端口查询协议、IPv4/IPv6 与多进程、用户名/UID、权限受限、畸形响应、查询失败/超时和取消；真实回环 SSH/TCP 端口冲突验证失败消息、规则和日志中的占用者线索，以及释放占用后重试、预设继续/回滚和其他转发可用。进程查询响应使用受控数据；`test:remote` 另在真实 POSIX shell 中运行生成的 `ss`/`lsof` 脚本，工具使用替身。`test:ui` 验证真实绑定拒绝后，失败窗口、规则行与运行日志均显示进程/PID/用户，窄屏不溢出。

`tests/runtime-logs.test.mjs` 验证轻量 HTTP 快照不含日志、认证后的单连接日志读取、旧内部接口兼容、返回副本和单连接查询不复制其他会话日志。`tests/remote-storage.test.mjs` 验证损坏记录下的安全本地编辑、删除/重新绑定/全局恢复保护、原始字节保留、重复/并发重读、保留失败和缺失文件继续阻断、修复后完整加载及已派发任务保持未知；HTTP 恢复入口继续要求认证。SSH 导入回归覆盖公开反向监听被警告并跳过后，其余预设可在本机 SSH 服务正常启动。

`tests/remote-results.test.mjs` 覆盖恢复协议的空尾字段、Base64 路径、重复/矛盾记录与摘要字段白名单；`tests/remote.test.mjs` 另验证派发前重启、派发边界保存失败、旧记录保守核实、历史查询/轮换、损坏历史保护与恢复结果跨重启保留。`tests/sessions.test.mjs` 注入远端取消监听的拒绝、超时和断链，要求关闭受影响 SSH、释放双向监听且独立连接仍能传输。

`tests/lan-detection.test.mjs` 验证 IPv4/IPv6 子网辅助排序、跨网段与下一跳路由、缺少路由或不同 SSH 入口时仍验证实际 HTTP、失效网卡地址拒绝、取消和鉴权失败回退；`tests/remote-http.test.mjs` 验证 HTTP 解析及受限供应商管理请求。`tests/provider-link.test.mjs` 使用真实临时局域网监听和 SSH 会话，覆盖同网段/跨网段路由证据下的零转发直连、按实际可达性双向切换、供应商去重、保存响应丢失回读、密钥轮换、插件重启、旧记录迁移及手动配置保护；路由证据使用受控响应。`test:remote` 还在隔离 POSIX shell 中运行实际 curl，验证 JSON 与凭据转义、代理及 curlrc 绕过和禁止重定向；页面回归验证访问方式、直连地址与 SSH 断开后的待检测提示。

`provider-save.mjs` 按官方 Web 编辑器的请求字段构造保存数据。`tests/provider-save.test.mjs` 验证新增/更新标记、可编辑设置与 false/0/null 保留、只读/脱敏字段隔离、模型选择投影、旧版模型列表兼容和异常结构拒绝。对接测试的 HTTP 服务返回真实接口形式的模型/令牌展示对象，并校验保存字段类型及新增 ID 冲突，避免宽松的整对象 upsert 掩盖 HTTP 400。

手动覆盖使用 `remote_provider_sync({connectionId, overwrite: true})`，不写入配置开关。供应商对接回归覆盖直连/SSH 下地址和密钥恢复、其他设置与手动供应商/转发保留、下一轮恢复默认保护、归属记录/供应商类型/停用/清除密钥保护，以及覆盖响应丢失后的普通核对与隧道清理。工具回归校验布尔参数和单次作用域；页面回归校验确认与取消、确认期间切换服务器、重复点击只提交一次和后续普通检测不携带覆盖参数。

`tests/remote-exec.test.mjs` 使用本机真实 SSH 通道验证标准输入、双输出、分片 UTF-8 实时标准输出、退出状态、输出上限、超时与断线。`tests/remote.test.mjs` 使用隔离状态文件和注入的远端响应验证生命周期预览、去重、环境变化、普通配置归档、恢复预览绑定、分片进度校验、下载阶段断线后的未知结果、卸载范围和 Web 转发冲突。`npm run test:remote` 通过标准输入向真实 POSIX shell 传入生成脚本，使用临时 HOME 和假的 Magpie / systemd 命令，并用逐步写入的临时文件验证下载字节在任务结束前输出；Windows 自动定位 Git Bash，也可用 `MIGPIE_BASH` 指定。它验证脚本行为，不下载程序或改变真实服务。

`npm run test:ui:remote` 通过真实管理服务、受控 SSH 测试服务和 `allow-scripts` iframe，验证远程面板的检测、预览确认、后台任务、下载字节与速度、可信总量下的百分比、阶段切换与终态清理、刷新和跨连接响应隔离，以及未知结果、无口令备份与恢复、统一日志去重、敏感链接清理和 390px 布局。SSH 测试服务仅识别固定脚本并返回测试响应，不执行部署。截图默认保存到 `.local/remote-ui-regression/`。

页面回归还覆盖已有 Web 服务的回环重建入口、systemd 覆盖配置拒绝、日志仅按需请求、日志读取失败保留缓存并重试、切换连接后的迟到日志隔离，以及损坏任务记录的保留原件/修复后重读/零远端重放。

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
