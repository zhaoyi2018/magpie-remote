# 开发与发布

## 开发命令

代码是标准 ESM JavaScript，没有编译步骤。开发依赖仅使用 Node 内置测试库，运行依赖锁定为 `ssh2@1.17.0`。

```powershell
npm ci --ignore-scripts --omit=optional
npm run check
npm test
```

`check` 检查 JavaScript 语法、入口导出和本地 Markdown 文件链接。测试临时启动仅监听本机随机端口的 SSH/TCP 服务，验证密码和私钥认证、真实双向数据流及异常清理。测试不会连接配置中的真实服务器。

如需使用与宿主一致的 Bun：

```powershell
bun test tests --timeout 15000
```

Magpie 的缓存 Bun 未加入 PATH 时，可使用其可执行文件的绝对路径运行同样的命令。

## 与 Magpie 规范对应

| 规范要求 | 本项目实现 |
| --- | --- |
| 包入口可由 `exports["./server"]`、`main` 等定位 | 两者均指向根目录 `index.mjs` |
| 入口支持 `export default { id, server }` | 仅导出该对象，辅助函数位于 `src/` |
| 插件函数接收 `input, options`，返回 hooks | `createPlugin` 返回 `{ tool }` |
| 工具参数支持 JSON Schema | 10 个工具声明 JSON Schema，内部另有运行校验 |
| `ctx.abort` 是取消信号 | 连接和新增转发将其传入会话层 |
| npm 安装不会运行依赖安装脚本 | 纯 JavaScript 路径已在禁用脚本、排除可选原生包的安装下测试 |
| Git / 目录安装需要已存在的入口文件 | 全部运行源码随 Git 跟踪，无 `dist` 依赖 |
| 工具通过 `/mcp/magpie/tools` 暴露 | 由 Magpie 自身注册，本包无需另开 HTTP 服务 |

规范来源：[用户提供的中文文档](https://usemagpie.ai/docs/zh/plugins)、[本次实际读取的官方英文文档](https://usemagpie.ai/docs/plugins)。SSH 接口来源：[ssh2 官方仓库](https://github.com/mscdex/ssh2)。规范核对日期为 2026-10-22，后续升级应复核宿主接口。

## 独立宿主验证

项目提供 `scripts/host-smoke.mjs`，直接启动已有的 Magpie 插件宿主文件，而不会加载日常使用的插件清单或账户。两个参数分别是 Bun 可执行文件和 Magpie 缓存的 `host-*.js` 文件的绝对路径：

```powershell
node scripts/host-smoke.mjs 'C:/path/to/bun.exe' 'C:/path/to/host-current.js'
```

脚本给子进程配置独立 HOME、USERPROFILE、XDG 目录和认证文件，只装入当前项目。随后通过宿主 RPC 保存测试配置、SSH 认证、创建两个方向的转发、实际传输数据、停止转发、断开并删除配置。测试结束后关闭该子进程并清理其临时目录。该脚本只用于开发验证，内部宿主协议变化时需要复核。

若通过完整 Magpie CLI 做隔离测试，也需为子进程设置独立的 HOME、USERPROFILE、XDG_CONFIG_HOME、XDG_CACHE_HOME 和未占用的 MAGPIE_ADDR，避免读写日常配置。Windows 自动化使用 PowerShell 7 的 `pwsh -NoProfile`。

## 修改与发布

修改源码后运行 `npm run check` 和 `npm test`；涉及 SSH 生命周期、流或依赖时，再验证 Bun 和实际插件宿主。在 Magpie 桌面重新加载此插件后，宿主才会读取修改。

```powershell
npm pack --dry-run
```

`prepack` 会执行静态检查和测试。包文件白名单只包含运行源码、说明、示例和许可证；测试、脚本、安装依赖、私钥、环境文件与本地数据不随 npm 包发布。

远程仓库为 `git@github.com:zhaoyi2018/migpie-remote.git`，尚未执行 npm 发布。Git 安装所需的 `package.json` 和运行源码保留在仓库中；社区列表登记和 npm 发布需单独执行。

可视化管理页由 `page/` 和 `src/web-server.mjs` 实现，服务与工具共用会话。开发时可给宿主验证脚本追加 `--ui`，它会提供带 Magpie iframe 沙箱策略的浏览器测试入口；输入 `check` 验证页面所创建转发的数据往返，输入 `close` 退出。启动信息 `page/.runtime/` 不应提交或发布。

源码依据：[package.json](../package.json)、Git 仓库中的 `scripts/check.mjs` 和 `scripts/host-smoke.mjs`；这些开发脚本不随 npm 包发布。返回[文档导航](README.md)。
