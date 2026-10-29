# 系统 SSH 配置的预览与选择导入

管理页提供 SSH 配置的预览、勾选和导入流程。以下同时记录页面使用的内部操作，供开发维护参考；它们不注册为 MCP 工具。验证范围见[验证记录](verification.md)。

## 读取范围

不传 `configPath` 时，按用户配置优先、系统配置补充默认值的顺序读取：

| 平台 | 用户配置 | 系统配置 |
| --- | --- | --- |
| Windows | `%USERPROFILE%\.ssh\config` | `%ProgramData%\ssh\ssh_config` |
| Linux / macOS | `~/.ssh/config` | `/etc/ssh/ssh_config` |

传入 `configPath` 后，只读取该文件和它引用的 Include 文件。路径支持绝对路径、`~/`、`${变量}` 及支持的路径替换符。相对 Include 路径以用户的 `~/.ssh` 或系统配置目录为基准，不以某个被包含文件的位置为基准。Include 支持 `*`、`?`、字符集合及词典顺序展开，也会检查循环引用。

只把 `Host` 中具体的主机别名列为候选；`Host *`、`Host *.example` 和否定模式参与配置匹配，不单独成为连接。同一个 Host 声明的多个具体别名分别列出。同名普通选项取先出现的值；多个 IdentityFile 和转发声明分别收集。

读取限制为最多 64 个配置文件、每文件 256 KiB、合计 2 MiB、12 层 Include 和 500 个具体别名；单次 Include 路径展开最多 128 项。文件或 Include 超限、无法读取时会在来源信息或候选错误中提示；具体别名只预览前 500 个。读取不修改源文件，不连接服务器，不调用 `ssh -G`，不会执行 Match exec、代理命令或登录命令，也不读取私钥内容。

默认位置与语法依据：[Microsoft 的 Windows OpenSSH 配置说明](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration)、[OpenSSH ssh_config 手册](https://man.openbsd.org/ssh_config)。具体支持范围以本页和源码为准。

## 字段映射与边界

| SSH 配置 | 导入结果 |
| --- | --- |
| `Host` | 显示名称为原别名；符合插件格式时直接作为 id，其他别名使用稳定转换后的 id |
| `HostName` | 服务器地址；省略时使用别名，支持 `%%` 和 `%h` |
| `User` | 用户名；省略时使用宿主的本地用户名 |
| `Port` | SSH 端口；默认 22 |
| `IdentityFile` | 只保存第一条私钥路径；多条时提示。未指定时可识别已存在的默认 RSA / ECDSA / Ed25519 私钥路径 |
| `IdentityAgent` | Agent 地址；支持 `SSH_AUTH_SOCK` 及环境变量引用 |
| `UserKnownHostsFile` | 第一条 known_hosts 路径；多条时提示，插件仍校验服务器公钥 |
| `LocalForward` | TCP c2s 预设，支持指定监听地址及方括号 IPv6 地址 |
| `RemoteForward` | TCP s2c 预设；不支持 SOCKS 动态转发和 Unix socket |
| `GatewayPorts` / `ClearAllForwardings` | 解析本地默认监听范围，以及是否清除预设转发 |

路径支持 `~`、`${变量}`、`%%`、`%d`、`%u`；解析连接字段后还支持 `%h`、`%n`、`%p`、`%r`、`%k`、`%L`、`%l`。Include 阶段不支持依赖具体主机的替换符。相对私钥 / known_hosts 路径、未知替换符或缺失环境变量会提示，避免猜测文件位置。

`Match all` 和能静态判断的 host、originalhost、user、localuser 条件可参与匹配。无法静态判断的 Match、ProxyJump、ProxyCommand、证书、HostKeyAlias 等会将受影响条目标记为需手动配置，不能勾选导入。`IdentitiesOnly yes` 和 `IdentityAgent none` 当前也不能等价映射，需手动配置。普通未映射选项会列在 warnings 中。未知或非 TCP 转发会提示并跳过该条转发，基本连接仍可导入。

`StrictHostKeyChecking no` 等设置不会关闭本插件的主机公钥校验。未带入有效私钥时，连接前仍需提供可用的 Agent 或密码。导入仅新增配置和可选预设，不自动建立 SSH 会话。

## 预览接口

管理页通过本机服务的认证入口 `POST api/call` 调用内部操作 `ssh_config_preview`，不能直接从 Magpie 初始启动页跨沙箱请求。

```json
{
  "method": "ssh_config_preview",
  "args": {
    "configPath": "~/.ssh/config"
  }
}
```

`configPath` 可省略；结果在 HTTP 响应的 `result` 中。

| 返回字段 | 含义 |
| --- | --- |
| `files` | `{path, exists, error?}` 数组，含主配置和已读取的 Include 来源 |
| `revision` | 此次配置快照的 SHA-256 标识；导入时原样提交 |
| `candidates[].alias` | SSH 原始别名，作为勾选和导入的唯一选择值 |
| `candidates[].source` / `line` | 原别名声明的位置 |
| `candidates[].profile` | 规范化后的连接；字段无效时可能不存在 |
| `candidates[].selectable` | 是否支持导入基本连接；未映射的可忽略选项另行提示 |
| `candidates[].exists` | 相同连接 id 是否已经存在；已有连接不得覆盖 |
| `candidates[].warnings` / `errors` | 展示给用户的提示和阻止导入的原因，均为数组 |

前端只允许选择 `selectable === true && exists === false` 的候选。初始不选中任何主机；支持单选、多选和全选可导入项。存在 errors 或没有 profile 时应显示原因，不应直接访问 profile 的字段。

## 导入接口

内部操作 `ssh_config_import` 的 `revision` 必须使用上一次预览实际返回的值：

```js
const preview = await call("ssh_config_preview", { configPath: "~/.ssh/config" });
// 用户勾选后，使用原 alias；不要改用转换后的 profile.id。
const result = await call("ssh_config_import", {
  configPath: "~/.ssh/config",
  revision: preview.revision,
  aliases: ["dev-server"],
  includeForwards: true,
});
```

`aliases` 为 1–500 个不重复的别名。`includeForwards` 默认为 true；关闭时只导入连接，不带任何转发预设。`configPath` 必须与预览一致；预览时省略，导入时也应省略。

导入时重新读取配置并核对 revision。文件或解析结果发生变化时拒绝写入，提示重新预览；前端不应自动接受新的配置继续导入。全部所选条目均通过校验后才进入同一次原子存储操作。

结果为 `{imported, skipped}`：imported 是实际新增的连接对象数组；skipped 是 `{id, reason}` 数组。即使预览后另一个操作创建了相同 id，也只会跳过，保留已有连接、修改和会话。未勾选条目不导入，源 SSH 配置不变。

## 管理页接入约定

复用页面现有 `call(method, args)` 包装器，它负责本机服务的 Bearer 认证和错误处理。打开弹窗可以自动预览；用户修改配置路径后，必须让旧预览失效。导入按钮在未勾选或导入进行中禁用；导入失败保留错误和选择，允许用户重新读取。

当前新版页面使用 `import-config` 入口、`import-dialog` 弹窗、`import-path` 路径输入、`preview-import` 预览按钮、`import-list` 候选列表、`import-all` 全选、`import-forwards` 转发选项和 `confirm-import` 导入按钮。接入时需统一页面与脚本中的控件 id，避免混用旧稿的 `ssh-import-*` 控件名。

完成后刷新连接列表，显示实际 imported / skipped 数量；可选中第一条新增连接，但不自动连接。系统 SSH 配置发生变化时仍要求重新预览；已有连接始终跳过，不能用导入操作覆盖。

实现依据：[配置读取](../src/ssh-config.mjs)、[工具入口](../src/plugin.mjs)、[原子存储](../src/store.mjs)。返回[文档导航](README.md)。
