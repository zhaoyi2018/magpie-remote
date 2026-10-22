# 架构说明

## 模块关系

```mermaid
flowchart TD
  Agent[支持 MCP 的 Agent] --> Gateway[Magpie Plugin tools]
  Gateway --> Host[Bun 插件宿主]
  Host --> Entry[index.mjs / default server]
  Entry --> Tools[src/plugin.mjs / 10 个工具]
  Page[Magpie 内嵌启动页] --> UI[本机管理服务与页面]
  Entry --> UI
  UI --> Tools
  Tools --> Config[src/config.mjs / 校验]
  Tools --> Store[src/store.mjs / 配置持久化]
  Tools --> Sessions[src/sessions.mjs / 会话与转发]
  Sessions --> Trust[src/host-keys.mjs / 主机公钥]
  Sessions --> SSH[ssh2 Client]
  SSH --> Server[SSH 服务器]
  Store --> File[connections.json]
```

插件只导出一个 OpenCode v1 对象，辅助函数放在 `src/`。`createPlugin` 默认启动只监听回环地址的管理服务，并在 `page/.runtime/` 发布启动地址；不会自动建立 SSH 连接。每个连接拥有自己的 SSH 客户端、转发映射和 TCP 资源集合。

## 连接与预设转发

```mermaid
sequenceDiagram
  participant A as Agent
  participant T as 工具入口
  participant P as ProfileStore
  participant M as SessionManager
  participant S as SSH 服务器
  A->>T: connect(connectionId)
  T->>P: 读取连接配置
  P-->>T: 校验后的配置
  T->>M: connect(profile, signal)
  M->>S: SSH 握手及主机公钥校验
  M->>S: 用户认证
  S-->>M: ready
  M->>M: 标记 connected
  loop 保存的预设转发
    M->>M: addForward
  end
  alt 全部成功
    M-->>A: 会话与转发快照
  else 任意预设失败
    M->>M: 关闭会话并释放全部资源
    M-->>A: 工具错误
  end
```

工具入口按连接 id 串行处理修改、连接与转发操作，独立连接可以并行。断开操作会立即取消同一连接等待中的连接请求。配置写入另有进程内串行队列；临时文件写完后重命名替换，避免留下半个 JSON。

## TCP 数据路径

```mermaid
flowchart LR
  subgraph C[客户端]
    Listen[net.Server]
    Local[本地 TCP 目标]
  end
  subgraph H[SSH 加密连接]
    Out[forwardOut channel]
    In[forwardIn / tcp connection channel]
  end
  subgraph S[服务器侧]
    Target[远端 TCP 目标]
    Remote[远端监听]
  end
  Listen -->|c2s| Out --> Target
  Remote -->|s2c| In --> Local
```

c2s 在本地监听，每条入站 TCP 连接通过 `forwardOut` 建立独立 SSH 通道。s2c 通过 `forwardIn` 请求服务器监听，收到与已登记端口匹配的连接后才连接本地目标并接受 SSH 通道。流通过 Node/Bun stream 的 `pipe` 转发并保持背压。

关闭转发会销毁它的活跃通道和 socket；关闭会话会销毁 SSH 客户端，并关闭所有本地监听。远端监听随 SSH 连接终止释放。转发不执行远程 shell，也不解析应用协议。

## 生命周期与边界

```mermaid
stateDiagram-v2
  [*] --> disconnected
  disconnected --> connecting: connect
  connecting --> connected: SSH ready
  connecting --> failed: 校验失败或认证失败或超时
  connecting --> disconnected: 显式断开
  connected --> failed: 传输错误或远程转发失败
  connected --> disconnected: 显式断开或远端关闭
  failed --> connecting: 再次连接
  failed --> disconnected: 显式断开
```

配置和预设保存在文件中；会话、当前动态端口和临时转发仅保存在宿主内存中。宿主重载后需要重新连接。当前配置目录不具备跨进程写锁。

Magpie 公开页面桥接只提供受限读取和插件选项操作。启动页完成握手后，在当前 iframe 内导航到独立回环管理服务。服务通过自己的随机访问标识与 API 认证调用共用工具，不调用 Magpie 管理 API，也不修改其 iframe 沙箱。页面支持原生主题消息、配置管理、连接控制和转发操作。插件宿主具备网络和文件权限，主机信任由本插件显式校验。

源码依据：[入口](../index.mjs)、[工具](../src/plugin.mjs)、[校验](../src/config.mjs)、[存储](../src/store.mjs)、[会话](../src/sessions.mjs)、[主机公钥](../src/host-keys.mjs)。官方运行边界见 [Magpie 插件文档](https://usemagpie.ai/docs/plugins)。返回[文档导航](README.md)。
