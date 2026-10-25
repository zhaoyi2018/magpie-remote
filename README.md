# magpie-remote

为 **Magpie** 提供 SSH 连接管理、双向 TCP 端口转发和远程 Magpie 生命周期管理。

在 Magpie 侧栏的 **SSH 连接** 页面中，可管理服务器、连接和断开，以及保存、启动、停止和删除 c2s / s2c 端口转发。「远程 Magpie」面板可检测 Linux 环境，预览并执行安装、更新、用户服务启停和保留配置的卸载，通过 SSH 转发访问官方 Web 管理供应商与 Agent。Agent 也可以通过 **Tools / MCP** 操作同一批配置、SSH 会话与远端任务。

本插件采用「页面＋工具」形式：`magpie.page` 提供侧栏页面，服务端注册 SSH 和远程管理工具，不注册模型供应商。启用且宿主成功加载后，「已安装」中显示「页面」和「工具」类型。保留服务端入口，让 SSH 管理后台随插件自动启动；纯页面插件不会启动该后台。

插件卡片、侧栏和页面复用同一个支持明暗主题的 SVG Logo。`magpie.icon` 内嵌图标供插件卡片读取，`magpie.page.icon` 指向包内的 `page/icon.svg`。替换原始 PNG Logo 后运行 `npm run icons` 同步生成两处配置。

安装或重新加载插件后，在侧栏打开「SSH 连接」，新增服务器并选择登录方式。选择「密码」可直接输入密码，点击「保存并连接」后登录；密码以 AES-256-GCM 密文写入配置，本机随机密钥单独保存。其他方式先尝试已有认证来源，需要时提示输入本次凭据；本次凭据不保存。已连接时可创建并启动转发，未连接时保存预设；预设按连接的自动启动设置运行，也可选择个别预设失败时保留连接并继续启动其他规则。

Windows 桌面内嵌页面的来源为 `http://wails.localhost`，v0.2.1 已将它加入允许嵌入的来源名单，修复服务正在运行时仍显示「127.0.0.1 拒绝连接」的问题。升级后在「设置 → 插件」中关闭再开启本插件，让插件宿主重新读取代码。

管理服务随插件启动，只监听本机随机回环端口。启动页在当前 Magpie iframe 内导航到该服务；服务使用独立随机访问标识和 API 认证，共用现有 SSH 后端。`webUI: false` 可关闭页面服务，`uiPort` 可指定端口。插件目录需允许写入 `page/.runtime/`，其内容不进入 Git 或 npm 包。

| 功能 | 行为 |
| --- | --- |
| 连接管理 | 新建、编辑、搜索、状态筛选、重连和删除；支持多个独立会话 |
| SSH 配置导入 | 页面预览和勾选导入，支持 Include；已有连接跳过，导入后不自动连接 |
| SSH 认证 | 加密保存的密码、私钥文件、SSH agent，或通过环境变量提供密码与私钥口令 |
| c2s / `-L` | 在客户端监听，把流量通过 SSH 发往服务器侧目标 |
| s2c / `-R` | 在服务器监听，把流量通过 SSH 发往客户端侧目标 |
| SSH 生命周期 | 认证完成才算已连接；可单独停止转发；断线时释放资源 |
| 远程 Magpie | Linux 用户安装、更新、服务启停、启用 Web 与卸载；变更先预览，更新先加密备份 |
| 供应商与 Agent | 建立临时回环 SSH 转发，访问远端官方 Web 管理；插件内嵌编辑界面尚未加入 |
| 远端任务 | 保存每连接最新操作，页面刷新后继续查看；断线结果待核实，禁止自动重放 |
| 自动重连 | 按连接启用；仅网络故障退避重试，手动停止即取消；认证和公钥问题暂停等待处理 |
| 配置备份恢复 | 保存前自动备份，保留最近 5 份；支持手动备份、预览恢复和损坏配置恢复 |
| 持久化 | 保存连接配置和预设转发；运行中的会话保留在宿主内存中 |
| 运行日志 | 查看认证、断线、转发启停和错误；每个连接保留最近 200 条内存日志 |

## 安装和接入

开发需要 Node.js 22 或更高版本。Magpie 使用自己的 Bun 运行插件，代码无需构建。依赖 `ssh2` 使用纯 JavaScript 路径，不依赖安装脚本或原生扩展。

在 PowerShell 7 中进入项目目录：

```powershell
npm ci --ignore-scripts --omit=optional
npm run check
npm test
magpie plugin add .
```

也可以在 Magpie 的「设置 → 插件 → 添加插件」中填写项目文件夹的绝对路径。文件夹安装会直接加载源文件。

在 Magpie 中找到插件提供的工具，复制其 MCP 服务地址，并填入所用 Agent 的 MCP 设置。默认地址为：

```text
http://127.0.0.1:3425/mcp/magpie/tools
```

实际地址以 Magpie 的插件工具页面为准；如果网关要求密钥，按该 Agent 的 MCP 设置方式配置请求认证。

## 使用示例

以下 JSON 是工具的参数，不是终端命令。示例中的服务器地址和用户名需要替换。私钥对应的服务器主机公钥需已存在于 `~/.ssh/known_hosts`，也可以提供核对过的 `hostFingerprint`。

新建请求只允许不存在的连接 id。更新、保存预设或删除时，先读取 `connections` 返回的该连接 `revision`，再以顶层 `expectedRevision` 提交；配置已变化时会拒绝覆盖。升级后需刷新 Agent 的工具定义，完整参数和返回结构见[工具接口](docs/tools.md)。

先调用 `migpie-remote_save_connection`：

```json
{
  "connection": {
    "id": "dev-server",
    "name": "开发服务器",
    "host": "server.example.com",
    "port": 22,
    "username": "developer",
    "identityFile": "~/.ssh/id_ed25519"
  }
}
```

再调用 `migpie-remote_connect`，等待结果的 `state` 为 `connected`：

```json
{ "connectionId": "dev-server" }
```

调用 `migpie-remote_forward_add`，把客户端的 `18080` 转发到服务器的 `127.0.0.1:8080`：

```json
{
  "connectionId": "dev-server",
  "forward": {
    "id": "server-web",
    "direction": "c2s",
    "bindPort": 18080,
    "targetPort": 8080
  }
}
```

创建 s2c 时，服务器的 `13425` 会转发到客户端的 `127.0.0.1:3425`：

```json
{
  "connectionId": "dev-server",
  "forward": {
    "id": "local-magpie",
    "direction": "s2c",
    "bindPort": 13425,
    "targetPort": 3425
  }
}
```

这样，服务器上的应用可访问 `http://127.0.0.1:13425` 到达客户端的 Magpie 网关；应用仍需使用网关要求的认证信息。

调用 `migpie-remote_status` 查看会话和转发，调用 `migpie-remote_disconnect` 释放该连接的全部转发。这两个工具都接受 `{"connectionId":"dev-server"}`。临时转发不会自动写入配置；需要下次连接时启动的转发应放进连接的 `forwards` 数组，见[完整示例](examples/connection.json)。

## 文档和验证

- [文档导航](docs/README.md)：配置、工具参数、架构、开发发布和验证记录。
- [操作指南](docs/usage.md)：认证、主机公钥、双向转发与常见问题。
- [工具接口](docs/tools.md)：21 个工具的参数与状态语义。
- [远程 Magpie 管理](docs/remote.md)：安装、更新、备份口令、任务核实和官方 Web 入口。
- [SSH 配置导入](docs/ssh-import.md)：预览与选择导入、支持范围及页面接入约定。
- [验证记录](docs/verification.md)：已完成的测试及尚未验证的部署场景。

Next 阶段已加入断网自动重连和配置备份恢复。自动重连默认关闭，在连接编辑器中按需开启；页面顶部「备份与恢复」提供手动备份与预览恢复。恢复会停止全部连接并保留原配置，完成后按需手动连接。

本轮补充配置版本保护、目标连接超时与恢复诊断，以及删除连接后的运行记录清理。配置文件和既有备份无需迁移；旧的无版本更新调用会明确拒绝，页面会保留冲突草稿供对照。

远程管理首版支持普通 Linux amd64/arm64 的用户安装，供应商和 Agent 通过转发后的官方 Web 管理，插件内嵌编辑留待后续。更新先创建加密备份；断线或超时结果保持待核实。使用范围与操作流程见[远程 Magpie 管理](docs/remote.md)。

`npm run check:release` 汇总静态、Node、隔离 POSIX 脚本和两套 iframe 页面回归；`test:ui` 验证既有连接与转发，`test:ui:remote` 验证远程管理。另在 Bun 和实际隔离 Magpie 宿主验证工具注册与原有 SSH 流程。测试使用临时配置、回环 SSH 和受控响应，未执行真实 Linux 官方安装、升级或 systemd 部署；完整计数、证据与边界见[验证记录](docs/verification.md)。

插件依据[官方中文插件规范](https://usemagpie.ai/docs/zh/plugins)开发；本次中文版访问失败时，使用了[官方英文版](https://usemagpie.ai/docs/plugins)核对入口、工具接口与运行边界。
窗口里的页面开发参考https://usemagpie.ai/docs/zh/plugins#pages

许可证：[MIT](LICENSE)。
