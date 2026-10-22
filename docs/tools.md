# 工具接口

插件通过 OpenCode v1 的 `tool` hook 注册工具，Magpie 将其提供为 MCP。包名是 `migpie-remote`，因此标准完整名称带 `migpie-remote_` 前缀。若宿主实际显示的名称不同，以工具列表为准。

| 工具 | 必填参数 | 返回与行为 |
| --- | --- | --- |
| `migpie-remote_connections` | 无，传 `{}` | 所有配置及对应会话快照；不创建连接 |
| `migpie-remote_save_connection` | `connection` | 新建或完整替换一条配置；已有活跃会话时拒绝修改 |
| `migpie-remote_remove_connection` | `connectionId` | 删除已断开的配置，返回 `removed: true` |
| `migpie-remote_connect` | `connectionId` | 认证后建立会话，并启动保存的预设转发；已连接时返回现有会话 |
| `migpie-remote_disconnect` | `connectionId` | 断开会话并释放全部转发；保留配置 |
| `migpie-remote_status` | 无；可选 `connectionId` | 单个会话或全部运行记录 |
| `migpie-remote_forward_add` | `connectionId`, `forward` | 创建临时转发，返回实际绑定端口 |
| `migpie-remote_forward_remove` | `connectionId`, `forwardId` | 停止单条转发和通道，返回 `stopped: true` |

## 连接配置

`save_connection` 接收 `{"connection":{…}}`。连接对象：

| 字段 | 约束与默认值 |
| --- | --- |
| `id` | 必填；1–64 个字母、数字、下划线或连字符；首字符为字母或数字 |
| `host`, `username` | 必填；非空文本，不含控制字符 |
| `name` | 默认等于 `id` |
| `port` | 1–65535；默认 22 |
| `identityFile`, `knownHostsFile` | 可选绝对路径，或以 `~/` 开头 |
| `agent` | 可选 socket 路径、Windows 命名管道或受 ssh2 支持的 agent 标识 |
| `passwordEnv`, `passphraseEnv` | 可选环境变量名称，不能填写秘密原文 |
| `hostFingerprint` | 可选 `SHA256:…` 公钥指纹，43 位 Base64，无末尾 `=` |
| `forwards` | 可选预设转发数组，默认 `[]`；其中的 id 不能重复 |

至少配置一种可用认证来源。未知连接字段会被拒绝。`save_connection` 为完整替换，不会与旧字段合并，因此更新时需带上要保留的配置。

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

`id`、`direction`、`bindPort`、`targetPort` 必填。`direction` 为 `c2s` 或 `s2c`；绑定端口允许 0–65535，目标端口允许 1–65535。省略两个主机字段时均使用 `127.0.0.1`。同一连接不能存在重复转发 id，也不能重复占用相同方向的同一监听地址和非零端口。

两侧地址的解释见[操作指南](usage.md)。该工具仅创建当前会话的转发；把同一对象放入连接的 `forwards` 数组才能持久保存。

## 状态与错误

会话状态是 `connecting`、`connected`、`disconnected` 或 `failed`。转发状态是 `starting`、`listening`、`stopping` 或 `failed`。`status` 包含地址、用户名、已观察到的公钥指纹、连接时间、当前转发及最近错误，不返回密码、口令或私钥内容。

当 SSH 公钥尚未通过信任校验时，可能已经取得其指纹；只有 `state: connected` 才表示该会话已通过校验和认证。

取消连接会终止正在连接的会话。取消或超时发生在远程转发分配期间时，会关闭 SSH 会话以释放可能已经建立的远程监听。已完成的 `connect` 调用之后，旧调用的取消信号不会断开长期会话。

错误以工具异常返回，由 Magpie 转换为 MCP 错误。配置文件损坏时会报错，保存操作不会覆盖损坏文件。工具使用 JSON Schema 声明参数，并在插件内部再次校验配置、标识符及端口。

接口定义来源：[plugin.mjs](../src/plugin.mjs)；运行校验来源：[config.mjs](../src/config.mjs)。返回[文档导航](README.md)。
