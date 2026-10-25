# 远程 Magpie 管理

连接 SSH 后，在「远程 Magpie」页检测当前登录用户的环境。首版支持普通 Linux amd64/arm64 的用户安装：安装、更新、用户服务启停、启用官方管理页面和保留配置的卸载。供应商与 Agent 通过官方管理页面操作；插件内的独立编辑界面尚未加入。

## 使用流程

1. 建立 SSH 连接，打开「远程 Magpie」，点击检测环境。SSH 已连接与 Magpie 正在运行是独立状态。
2. 未安装时预览安装。后台从官方 `https://usemagpie.ai/api/latest` 读取 CLI 资产 URL 和 SHA-256；远端下载后校验，再安装到 `~/.local/bin/magpie`。本步骤不启动服务。
3. 点击启用管理页面，预览后安装当前用户的 systemd 服务，网关使用回环地址，管理页面使用 `127.0.0.1:3430`。无 systemd 用户会话时保留程序安装，服务操作会明确拒绝。
4. 获取管理链接。后台显式读取 `magpie daemon web` 的回环链接，并建立随机本地端口到远端 Web 端口的 c2s 转发。将链接复制到外部浏览器访问官方页面，管理供应商和远端当前用户下的 Agent。保持 SSH 连接；断开后本地入口失效。

管理链接携带有权限修改远端配置、查看供应商密钥的 Web key，不要分享。它与模型调用使用的 gateway key 不同。链接只在显式请求后返回，不进入操作记录或本地 SSH 配置；切换连接和页面退出时清空显示。`magpie-web` 是此入口使用的临时转发标识，同名其他规则不会被覆盖。

默认 Gateway 模式会隐藏 Agent 页面；需要管理远端 Agent 时，在远端官方页面的通用设置关闭 Gateway 模式。Agent 指远端已安装或已配置的 CLI/桌面工具，各工具的字段和生效条件不同，并非通用远程任务或进程管理。

## 更新与备份

更新预览后输入至少 12 个字符的本次备份口令。口令通过独立凭据字段提交，经 SSH 标准输入传给官方 `magpie backup`，不进入命令行、操作记录或日志。

先创建远端加密配置备份并复制旧程序，然后执行 `magpie update`。备份失败会阻止更新。原服务正在运行时才重启并检查健康状态；原停止状态不主动启动。备份目录为 `${XDG_CONFIG_HOME:-$HOME/.config}/magpie-remote/backups/<操作 UUID>/`，包含 `config.magpie` 和旧程序 `magpie`。请自行保存口令并按需转移备份；本插件不自动删除远端备份。

官方备份不包含订阅和插件登录；恢复具有合并语义，不能视为磁盘完整快照。旧程序副本不代表跨版本配置一定可以降级。首版不提供自动回退按钮，更新失败后查看实际版本、服务与备份，在服务器按官方恢复流程处理。

## 操作进度与断线

变更必须先读取预览，再提交其短时 revision。提交前复核连接配置、程序哈希与服务文件哈希。相同 revision 重复提交返回同一任务；同一连接同一时刻只执行一个变更。页面刷新不取消后台任务，也不会自动重发安装或更新。

本地 `connections.json.remote.json` 保存最近环境与每个连接的最新任务；文件损坏时明确报错，不覆盖旧内容。插件重启后原运行任务标为结果待核实。远端使用 `magpie-remote/operation.lock` 互斥，并将结果写入 `magpie-remote/operations/<UUID>/state`。

SSH 断开、超时、通道没有明确退出码时，变更任务标为结果待核实。重新连接后检测环境，只有取得远端明确的完成记录并确认操作锁已释放，才解除状态。不根据版本或服务看似正常就自动重试。若锁残留或记录缺失，请在服务器核实进程与变更，不要直接重复部署。关闭 SSH 通道不能保证远端进程一定终止。

有运行中或待核实任务时不能删除连接或恢复全局 SSH 配置。待核实任务允许更新同一服务器的 SSH 凭据以便重新连接，不能把这条连接改指向另一台服务器。

## 卸载与支持边界

自动卸载只接受当前用户 `~/.local/bin/magpie` 的非符号链接普通文件，先通过官方命令移除已安装用户服务，再删除程序。保留供应商配置、登录信息与备份。卸载前通过官方页面恢复仍接入该网关的 Agent，插件不会自动改写各 Agent 配置。

首版不接管系统路径、包管理器安装、容器或 system 服务；不运行 sudo，不自动开启 linger。用户服务能否在退出 SSH 后持续运行取决于服务器的用户会话和 linger 设置。当前操作契约按 Magpie 0.1.1472 及 0.1.1476 官方资料核对，旧版本会拒绝变更，后续版本仍需复核兼容性。

预览与哈希复核可以发现部分并发变化，但不是与其他 Magpie 进程共享的事务锁。操作期间不要同时从另一个客户端修改同一安装。后台只调用固定操作，不提供任意 shell 工具。

## 工具接口

| 工具 | 参数 | 结果 |
| --- | --- | --- |
| `remote_status` | `connectionId`、可选 `refresh` | 缓存环境与最新任务；`refresh: true` 连接后探测并核实未知任务 |
| `remote_preview` | `connectionId`、`action` | `revision`、变更清单、提示、是否需要备份口令 |
| `remote_apply` | `connectionId`、`action`、预览的 `revision` | 立即返回后台任务，后续查询状态 |
| `remote_operation` | `connectionId`、可选 `operationId` | 此连接最新任务或 `null` |
| `remote_web` | `connectionId`、可选 `port` | 临时本地访问地址和带管理 key 的登录链接 |

`action` 为 `install`、`update`、`start`、`stop`、`restart`、`enable_web`、`uninstall`。`update` 的口令由管理页通过独立 `credentials.backupPassphrase` 提交，不放进 MCP 参数或模型上下文。

返回[文档导航](README.md)。官方依据：[服务、更新和备份](https://github.com/yetone/magpie/blob/v0.1.1476/docs/reference.md)、[发布清单定义](https://github.com/yetone/magpie/blob/v0.1.1476/internal/update/update.go)、[Web 管理](https://usemagpie.ai/docs/docker#web)、[Remote 网关边界](https://usemagpie.ai/docs/remote)。
