# 远端资源库同步 API

同步由插件宿主读取 `input.directory` 对应的本机 Magpie 数据目录，并通过已连接的 SSH 会话写入远端当前用户的 Magpie。远端需为现有远程管理支持的 Linux 用户安装。同步无需 systemd 或远端发布源网络访问。

## 请求与响应

管理服务使用 `POST /<token>/api/call`、`Authorization: Bearer <token>` 和 `Content-Type: application/json`。请求格式为 `{ "method": "…", "args": { … } }`。内部工具使用同一组方法名和参数。HTTP 成功返回 `200` 和 `{ "result": … }`。操作请求错误返回 `400` 和 `{ "code", "error", "message", "category", "retryable" }`。后台任务失败则由任务查询的 `result.error` 返回。认证与地址错误沿用管理服务的 `401`、`403`、`404` 行为。

| 方法 | `args` | `result` |
| --- | --- | --- |
| `remote_status` | `connectionId`，可选 `refresh` | `actions.library_sync` 提供 `enabled`，禁用时有 `code`、`reason`。`instance.capabilities` 中的 `library_sync` 表示 CLI 帮助确认支持原生生效命令。`operation` 是当前任务。`refresh: true` 会检测环境并核实未知结果 |
| `remote_preview` | `connectionId`、`action: "library_sync"`、`categories`，可选 `mode` | 预览，含 `revision`、分类摘要、变更和警告 |
| `remote_apply` | `connectionId`、`action: "library_sync"`、预览的 `revision` | 异步任务。相同 revision 重复提交返回同一任务，分类和策略变更需重新预览 |
| `remote_operation` | `connectionId`，可选 `operationId` 或 `history: true` | 当前任务、指定任务，或 `{ connectionId, limit, operations }`。`limit` 为最多保留的 20 条旧任务，另加当前任务 |
| `remote_backups` | `connectionId` | `{ connectionId, backups, observedAt }`，包括同步前的归档备份。恢复时使用 `remote_preview` 的 `action: "restore"` 与 `backupId`，再用 `remote_apply` 确认 |
| `remote_recover` | `connectionId`、`operationId`、`confirmed: true` | 核实结果或解除未知任务的限制，返回任务详情 |

`categories` 是 `instructions`、`skills`、`mcp`、`commands` 的任意非空子集，无重复。`mode` 为 `merge` 或 `mirror`，默认 `merge`。`merge` 保留远端独有项，同名项采用本机内容。`mirror` 还会移除所选分类内的远端独有项。两种策略均保留未选分类以及下文说明的机器专属数据。

预览的 `result` 结构如下。`library.counts` 和 `library.details` 只含所选分类。`revision` 为不透明的 64 位十六进制字符串，有效期 5 分钟，每条连接只保留最近一次预览。它绑定连接、远端环境、本机和远端快照、分类及策略。

```json
{
  "connectionId": "example",
  "action": "library_sync",
  "revision": "…",
  "summary": "同步资源库",
  "changes": ["…"],
  "warnings": ["…"],
  "backupMode": "archive",
  "library": {
    "categories": ["mcp"],
    "mode": "merge",
    "activation": "supported",
    "counts": { "mcp": { "added": 1, "updated": 0, "removed": 0, "skipped": 0, "preserved": 0 } },
    "details": {
      "mcp": {
        "added": [{ "name": "example", "kind": "entry", "envCount": 1 }],
        "updated": [], "removed": [], "skipped": [], "preserved": []
      }
    },
    "warnings": [{ "code": "WINDOWS_STDIO_MCP", "category": "mcp", "name": "example", "message": "…" }]
  }
}
```

- `library.activation` 为 `supported`、`unsupported` 或 `gateway_mode`，表示预览时可确认的生效能力。
- 每条明细包含 `name`、`kind`。`kind` 为 `entry`、`shared_instructions`、`instruction_set` 或 `instruction_set_file`。MCP 可含 `envCount` 或 `headerCount`。
- `skipped` 和 `preserved` 的 `reason` 为 `local_symlink`、`local_instruction_file`、`remote_instruction_file`、`local_mcp`、`remote_local_mcp`、`remote_here`、`remote_here_transport_conflict` 或 `remote_off_here`。同一项可能同时出现在变更和保留列表中，例如 MCP 更新了分配的 Agent 同时保留了远端启动覆盖。
- `library.warnings` 是非阻断的结构化跨平台提示。MCP 命令、参数、环境变量和请求头的值均不在预览中返回。

## 异步结果

任务含 `id`、`action`、`revision`、`state`、`step`、`dispatch`、`message`、`createdAt`、`updatedAt` 和 `library: { categories, mode, configState, syncState }`。可选字段包括 `progress: { downloadedBytes, totalBytes, bytesPerSecond, updatedAt }`、`diagnostic: { step, exitCode, reason }`、`error: { code, message, category, retryable }` 和 `result: { backupDirectory }`。上传的 `downloadedBytes` 是已经交给 SSH 通道的字节数。

| 字段 | 枚举与含义 |
| --- | --- |
| `state` | `running`、`succeeded`、`failed`、`unknown`，最后一种需要刷新环境核实 |
| `dispatch` | `pending`、`possible`，分别表示尚未派发和可能已经派发远端脚本 |
| `step` | `checking`、`packing_library`、`executing`、`preparing`、`verifying`、`uploading`、`checking_upload`、`preparing_backup`、`backing_up`、`saving_binary`、`applying_library`、`syncing_library`、`completed`、`failed`、`unknown` |
| `configState` | `not_applied`、`applied`、`rolled_back`、`unknown`，反映远端资源库落盘情况 |
| `syncState` | `not_started`、`synced`、`unchanged`、`unsupported`、`no_agents`、`gateway_mode`、`failed`、`unknown`，反映原生 Agent 生效结果 |

`unsupported`、`no_agents`、`gateway_mode` 可以伴随 `state: "succeeded"`，此时资源库已写入。`unchanged` 表示 Magpie 报告 Agent 无需变更，CLI 未提供可进一步确认的 Agent 名单时也可能涵盖无 Agent 的情况。若原生同步失败，任务为 `failed`，此时 `configState: "applied"` 表示资源已落盘，`result.backupDirectory` 可用于恢复。原生同步过程中已经发生的 Agent 写入可能留在 Magpie 配置目录之外。

| 错误码 | 含义 |
| --- | --- |
| `REMOTE_LIBRARY_OPTIONS` | 分类、策略或请求参数无效 |
| `REMOTE_LIBRARY_LOCAL_UNAVAILABLE`、`REMOTE_LIBRARY_LOCAL_READ_FAILED` | 本机数据目录或 `library.json` 缺失，或读取失败 |
| `REMOTE_LIBRARY_INVALID`、`REMOTE_LIBRARY_PROTOCOL` | 资源库数据格式或远端快照响应无效 |
| `REMOTE_LIBRARY_PATH`、`REMOTE_LIBRARY_LIMIT` | 不安全的路径、文件类型或资源超出上限 |
| `REMOTE_LIBRARY_READ_FAILED`、`REMOTE_LIBRARY_FAILED` | 远端快照读取失败或内部处理失败 |
| `REMOTE_PREVIEW_STALE` | revision 失效，或连接、资源、远端环境在确认前后发生变化 |
| `REMOTE_LIBRARY_CHECKSUM` | 上传尺寸或 SHA-256 不符 |
| `REMOTE_LIBRARY_SYNC_FAILED` | 原生 `magpie library sync` 失败 |
| `REMOTE_NOT_CONNECTED`、`REMOTE_NOT_INSTALLED`、`REMOTE_UNSUPPORTED`、`REMOTE_PREREQUISITE`、`REMOTE_BUSY` | SSH、安装、环境、命令依赖或操作锁不满足 |
| `REMOTE_ACTION_FAILED`、`REMOTE_RESULT_UNKNOWN` | 远端步骤失败或缺少可验证结果。后台任务也沿用现有的 SSH、超时、任务记录和本地持久化错误码 |

## 文件与机器专属字段

- `instructions` 包含 `library.json` 的 `instructions`、`library/instructions.md` 和 `library/instruction-sets/`。指令集按 `id` 合并，通常从 `<id>.md` 读取。指令集的 `file` 是本机文件引用，本机链接项会跳过。远端同名已有链接保留。
- `skills` 包含 `library.json` 中的 `skills` 和 `library/skills/` 下的目录。同名目录整体更新。扫描发现一个条目或其子项是本机软链或 Windows junction 时，会跳过整个条目，并保留远端同名项。目录根软链、路径穿越和其他特殊文件会中止同步。远端条目内的软链在构造快照和搬移目录时不会解引用。
- `mcp` 和 `commands` 同步对应的 `library.json` 条目，保留本机每个条目的 `agents`，包括空列表。`local: true` 的本机 MCP 跳过，同名或远端独有的 `local: true` MCP 保留。在已确认的 Magpie 格式中，`mcp here` 把便携启动参数保存在 `shared`，而远端有效的顶层 `command`、`args`、`env` 作为本机覆盖保留。Skill 的 `offHere`、`home` 及自定义命令的 `taken` 为机器专属数据。
- 插件写入 `library.json` 时保留远端原有 `applied`、`projects` 及其他未选字段。写入完成后由远端 Magpie 使用自己的 `applied` 记录增量生效。MCP 凭据通过 SSH 传输并由远端 Magpie 配置保存。插件日志、任务状态和错误消息仅使用受控字段。操作前归档依照既有备份机制存放于远端 `0700` 目录，归档未加密。
- 每个快照的 `library.json` 上限为 4 MiB，单个资源文件 16 MiB，资源文件合计 64 MiB，最多 4,096 个文件系统条目，路径最多 1,024 字节和 32 层。上传以 SHA-256 验证，校验通过后才创建操作前备份并提交。`library.json` 通过同文件系统上的重命名原子替换，多个资源目录按条目搬移，提交阶段异常时尝试回滚。操作锁与其他插件远端任务共享。外部 Magpie 客户端使用独立的写入机制，因此同步期间的外部并发写入由多次快照复核尽量检测。
