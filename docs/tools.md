# 工具接口

插件通过 OpenCode v1 的 `tool` hook 注册工具，Magpie 将其提供为 MCP。包名是 `migpie-remote`，因此标准完整名称带 `migpie-remote_` 前缀。若宿主实际显示的名称不同，以工具列表为准。

| 工具 | 必填参数 | 返回与行为 |
| --- | --- | --- |
| `migpie-remote_config_backups` | 无 | 列出备份标识、时间、来源、连接数量及有效性；当前配置损坏时仍可用 |
| `migpie-remote_config_backup` | 无 | 手动保存当前有效配置，返回备份元数据 |
| `migpie-remote_config_restore_preview` | `backupId` | 预览恢复连接、将移除的连接及当前文件有效性，返回 revision；不改变配置和会话 |
| `migpie-remote_config_restore` | `backupId`, `revision`；可选 `stopConnections` | 保留旧配置后恢复；有活跃连接、连接请求或重试时需明确传 true，否则拒绝；恢复后保持停止 |
| `migpie-remote_ssh_config_preview` | 无；可选 `configPath` | 只读预览系统 SSH 配置，返回 revision、候选主机及是否已存在 |
| `migpie-remote_ssh_config_import` | `revision`, `aliases`；可选 `configPath`, `includeForwards` | 仅新增选中且支持的连接；原子保存，跳过已存在 id，不连接 SSH |
| `migpie-remote_connections` | 无，传 `{}` | 返回 `{connection, revision, session}` 数组；不创建连接 |
| `migpie-remote_save_connection` | `connection`；更新时必填 `expectedRevision` | 新建或完整替换一条配置，返回 `{connection, revision}`；已有活跃会话时拒绝修改 |
| `migpie-remote_remove_connection` | `connectionId`, `expectedRevision` | 删除已断开的配置并清理其运行记录，返回 `removed: true` |
| `migpie-remote_connect` | `connectionId` | 认证后建立会话，并启动保存的预设转发；已连接时返回现有会话 |
| `migpie-remote_disconnect` | `connectionId` | 断开会话并释放全部转发；保留配置 |
| `migpie-remote_status` | 无；可选 `connectionId` | 单个会话或全部运行记录 |
| `migpie-remote_forward_add` | `connectionId`, `forward` | 创建临时转发，返回实际绑定端口 |
| `migpie-remote_forward_remove` | `connectionId`, `forwardId` | 停止单条转发和通道，返回 `stopped: true` |
| `migpie-remote_forward_save` | `connectionId`, `forward`, `expectedRevision` | 保存转发预设，返回 `{forward, revision}`，不启动监听；可在 SSH 已连接时保存 |
| `migpie-remote_forward_delete` | `connectionId`, `forwardId`, `expectedRevision` | 先删除预设再停止转发；版本冲突或配置写入失败保留原隧道，停止失败明确报告部分结果 |
| `migpie-remote_remote_status` | `connectionId`；可选 `refresh` | 读取环境缓存与最新远端任务；显式刷新会探测并核实未知结果 |
| `migpie-remote_remote_preview` | `connectionId`, `action` | 返回变更清单、提示和短时 revision，不执行变更 |
| `migpie-remote_remote_apply` | `connectionId`, `action`, `revision` | 提交预览的固定操作，立即返回后台任务；更新口令仅从管理页独立提交 |
| `migpie-remote_remote_operation` | `connectionId`；可选 `operationId` | 返回此连接最新任务，不包含原始命令输出或凭据 |
| `migpie-remote_remote_web` | `connectionId`；可选 `port` | 显式读取官方管理链接并建立临时回环 SSH 转发；返回的链接含管理密钥 |

远程生命周期的操作范围、备份口令、断线核实和卸载边界见[远程 Magpie 管理](remote.md)。

## SSH 配置的选择导入

先调用 `ssh_config_preview` 读取用户和系统配置，或指定 `configPath`。候选的 `selectable` 为 true 且 `exists` 为 false 时才可选择。把同一次预览返回的 `revision` 和勾选项的原始 `alias` 数组传给 `ssh_config_import`；`includeForwards` 默认为 true。导入时配置发生变化会要求重新预览。

返回 `{imported, skipped}`，均为数组。已存在 id 会跳过，不覆盖连接，也不改变已建立的会话。没有勾选的候选不导入，系统 SSH 配置始终只读。完整字段、错误、支持范围和前端接入约定见 [SSH 配置导入](ssh-import.md)。

## 连接配置

`save_connection` 接收 `{"connection":{…}}`。连接对象：

| 字段 | 约束与默认值 |
| --- | --- |
| `id` | 必填；1–64 个字母、数字、下划线或连字符；首字符为字母或数字 |
| `host`, `username` | 必填；非空文本，不含控制字符 |
| `name` | 默认等于 `id` |
| `port` | 1–65535；默认 22 |
| `authMethod` | 可选 `password`、`agent`、`key`、`environment`；`password` 使用本机加密保存的密码，其他已配置来源可作为回退 |
| `autoStartForwards` | 可选布尔值，默认 true；认证成功后自动启动预设转发 |
| `forwardFailurePolicy` | 可选 `rollback`（默认）或 `continue`；预设发生可恢复错误时，全部回滚或保留连接并继续其余预设；远程分配状态不明时仍关闭 SSH |
| `autoConnect` | 可选布尔值，默认 false；插件宿主启动或重载时尝试连接一次 |
| `autoReconnect` | 可选布尔值，默认 false；网络故障自动退避重试；显式断开或宿主关闭时取消 |
| `identityFile`, `knownHostsFile` | 可选绝对路径，或以 `~/` 开头 |
| `agent` | 可选 socket 路径、Windows 命名管道或受 ssh2 支持的 agent 标识 |
| `passwordEnv`, `passphraseEnv` | 可选环境变量名称，不能填写秘密原文 |
| `hostFingerprint` | 可选 `SHA256:…` 公钥指纹，43 位 Base64，无末尾 `=` |
| `forwards` | 可选预设转发数组，默认 `[]`；其中的 id 不能重复 |

至少配置一种可用认证来源。未知连接字段会被拒绝。`save_connection` 为完整替换，因此更新时需带上要保留的公开配置；密码密文由后端保留和管理，不接收调用方提交的 `encryptedPassword`。管理页通过独立的 `credentials.password` 请求字段提交要加密保存的新密码，不把密码放入 `connection` 或工具参数。MCP 可以连接和编辑已有密码连接；首次设置或更换密码在管理页完成。密码认证下省略新密码会保留原密码，切换到其他认证方式会移除当前密文。

`connections` 和 `save_connection` 返回的连接配置均去除密码密文，通过同级 `hasSavedPassword` 布尔值表示是否已保存密码。明文和密文均不进入页面快照或工具结果。配置备份保留密文，不包含本机的 `connections.json.key`；恢复到其他机器时需另行安全迁移密钥或重新填写密码。

### 并发修改与版本校验

`connections` 的每一行包含独立的 `revision`，表示这一条规范化配置的内容版本。修改连接、保存预设或删除时，将读取到的版本作为顶层参数 `expectedRevision` 提交；它不属于 `connection` 或 `forward` 对象。不同连接的修改互不冲突；没有内容变化的保存保持原版本，不轮换备份。

```js
const row = (await call("connections")).find((item) => item.connection.id === "dev-server");
const saved = await call("save_connection", {
  connection: { ...row.connection, name: "开发服务器" },
  expectedRevision: row.revision,
});
// saved.connection 是保存后的配置，saved.revision 可用于下一次修改。
```

新建连接可省略 `expectedRevision` 或传 `null`，两者都仅允许创建不存在的 id。更新已有配置省略版本会返回 `CONFIG_REVISION_REQUIRED`；版本格式无效返回 `CONFIG_REVISION_INVALID`；内容已变化、已删除或新建 id 已存在时返回 `CONFIG_CONFLICT`。冲突不写入文件，不生成备份，也不会停止正在运行的转发。遇到冲突应保留草稿，重新读取并对照配置，再由调用方提交修改，不能自动取得新版本后覆盖。

升级后需刷新 Agent 的工具定义。旧的无版本更新、预设保存和删除调用会被拒绝；`save_connection` 和 `forward_save` 的返回结构也已增加包装，分别读取 `connection` / `forward` 与 `revision`。配置文件仍为 version 1，既有配置和备份无需迁移。本保护依赖同一个宿主的写入队列，未增加跨进程锁。

## 转发配置

```json
{
  "connectionId": "dev-server",
  "forward": {
    "id": "web",
    "direction": "c2s",
    "bindHost": "127.0.0.1",
    "bindPort": 18080,
    "targetHost": "127.0.0.1",
    "targetPort": 8080
  }
}
```

`id`、`direction`、`bindPort`、`targetPort` 必填。可选 `name` 为 1–100 个字符的显示名称，支持中文；省略时管理页显示 `id`。`direction` 为 `c2s` 或 `s2c`；绑定端口允许 0–65535，目标端口允许 1–65535。省略两个主机字段时均使用 `127.0.0.1`。同一连接不能存在重复转发 id，也不能重复占用相同方向的同一监听地址和非零端口。

两侧地址的解释见[操作指南](usage.md)。该工具仅创建当前会话的转发；把同一对象放入连接的 `forwards` 数组才能持久保存。

也可以使用 `forward_save` 单独保存预设，需携带所属连接的 `expectedRevision`，成功后返回 `{forward, revision}`。若同 id 转发正在运行，需先停止再编辑。管理页新建转发时，已连接 SSH 可「创建并启动」，取消「保存为预设」只创建当前会话的临时转发；未连接时可「保存预设」，连接成功后按自动启动设置运行。预设保存成功但启动失败时会保留预设并提示错误。管理页与 MCP 共用会话。

## 配置恢复流程

调用 `config_backups` 选取有效备份，随后 `config_restore_preview({backupId})` 返回 `backupId`、`createdAt`、`revision`、`currentValid`、`currentCount`、`connectionCount`、`connections` 和 `removed`。连接清单只含 `{id, name}`，不包含认证引用或凭据。将同一次预览的标识与 revision 传入 `config_restore`；页面确认恢复时传入 `stopConnections: true`。

恢复返回 `{restored: true, connectionCount, preserved}`，`preserved.backupId` 指向恢复前的有效配置，损坏原文件则用 `preserved.recoveryFile` 返回保留路径；原文件不存在时无需保留。恢复不启动恢复后的配置。过期预览返回 `CONFIG_RESTORE_STALE`，恢复期间其他修改返回 `CONFIG_RESTORE_BUSY`，当前连接未明确允许停止时返回 `CONFIG_RESTORE_ACTIVE`。备份无效或不可读时拒绝恢复；备份保留失败时不替换原配置。恢复过程如果因文件变化或磁盘写入失败而中止，已经停止的连接仍保持停止，需手动连接。

## 状态与错误

会话状态是 `connecting`、`connected`、`disconnected` 或 `failed`。转发状态是 `starting`、`listening`、`stopping` 或 `failed`。`status` 包含地址、用户名、已观察到的公钥指纹、连接时间、当前转发及最近错误；另有 lastConnectedAt 和 logs（time、level、message）。已创建会话的 `forwardErrors` 数组以 `{id, message}` 记录当前会话中启动失败的规则，重试成功后移除对应项；页面将它与预设合并显示，失败项不计入运行中的转发。每个连接保留最近 200 条内存日志，重连后延续，宿主重启后清空，不返回密码、口令或私钥内容。

每条运行转发另外返回 `targetConnection: {state, lastAttemptAt?, lastSuccessAt?, lastFailureAt?, error?}`。`state` 为 `unknown`、`connecting`、`succeeded` 或 `failed`，描述最近发起的目标连接；旧请求的迟到结果不覆盖新请求的状态。`succeeded` 仅证明目标 TCP 连接及 SSH 通道建立，不证明应用协议或业务健康。连接失败保留监听和 SSH 会话，成功重试后清除当前 `lastError` / `error`，保留失败时间和历史日志，并记录恢复事件。停止再启动转发时重新开始统计。

目标建立超时返回 `FORWARD_TARGET_TIMEOUT`，连接失败为 `FORWARD_TARGET_FAILED`，传输异常为 `FORWARD_STREAM_FAILED`，建立前请求关闭为 `FORWARD_TARGET_CANCELLED`；这些是转发快照中的错误，不触发 SSH 自动重连。它们与远程监听分配超时 `FORWARD_TIMEOUT` 不同，后者仍关闭会话。删除连接成功后清除该连接的会话、重连意图和日志，全局 `status` 不再返回它；普通断开继续保留运行历史。删除写入失败时保留原配置与运行记录。

`forward_delete` 先提交预设删除，再移除重连意图并停止运行转发。配置版本冲突、备份或主文件写入失败均不停止现有隧道。若提交后停止失败，返回 `FORWARD_STOP_FAILED`，消息明确说明预设已删除；重新读取状态，重试停止或断开 SSH 以释放监听。远程清理结果不明时仍沿用关闭 SSH 的规则。临时转发没有预设写入步骤。

当 SSH 公钥尚未通过信任校验时，可能已经取得其指纹；只有 `state: connected` 才表示该会话已通过校验和认证。

取消连接会终止正在连接的会话。取消或超时发生在远程转发分配期间时，会关闭 SSH 会话以释放可能已经建立的远程监听。已完成的 `connect` 调用之后，旧调用的取消信号不会断开长期会话。

错误以工具异常返回，由 Magpie 转换为 MCP 错误。配置文件损坏时会报错，保存操作不会覆盖损坏文件。工具使用 JSON Schema 声明参数，并在插件内部再次校验配置、标识符及端口。

已创建会话额外返回 `reconnect: {enabled, state, attempts, nextRetryAt?, reason?}`。重连状态为 `idle`、`connecting`、`waiting`、`paused`、`stopped`，页面的「等待重连」由 `waiting` 派生，原会话状态枚举不变。等待和重连中的配置仍算活跃，修改前需断开。计数为本轮已安排的自动尝试次数，稳定连接 30 秒后归零；手动停止清除下一次尝试。失败时的 `error` 为 `{code, message, category, retryable}`，另保留原 `lastError`。

管理 HTTP API 的操作错误体为 `{error, code, message, category, retryable}`；缺少可用凭据时还返回 `credentialFields`（`password` / `passphrase`），页面据此提示本次输入。`category` 区分 `network`、`authentication`、`credentials`、`trust`、`forward`、`configuration`、`cancelled` 和其他 `operation`。只有已识别的网络中断、连接拒绝、网络不可达、临时 DNS 故障及 SSH 超时可重试；未知握手错误与无法解析的主机名不会无限重试。

常见代码包括 `SSH_NETWORK`、`SSH_DISCONNECTED`、`SSH_TIMEOUT`、`SSH_AUTH_FAILED`、`SSH_CONNECTION_FAILED`、`CREDENTIALS_REQUIRED`、`KEY_INVALID`、`KEY_UNAVAILABLE`、`HOST_KEY_REJECTED`、`HOST_KEY_UNAVAILABLE`、`FORWARD_BIND_FAILED`、`FORWARD_REJECTED`、`FORWARD_TIMEOUT`、`CONFIG_INVALID`、`CONFIG_UNREADABLE`、`CONFIG_BACKUP_FAILED`、`CONFIG_BACKUP_INVALID` 和 `OPERATION_CANCELLED`。管理地址过期仍返回 `MANAGEMENT_EXPIRED`。这些代码不保证在宿主转换后的 MCP 错误中保留相同结构。

接口定义来源：[plugin.mjs](../src/plugin.mjs)；运行校验来源：[config.mjs](../src/config.mjs)。返回[文档导航](README.md)。
