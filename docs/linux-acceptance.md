# 发布门禁与真实 Linux 验收

普通静态检查、Node/Bun 测试、Git Bash/Linux 脚本替身及浏览器回归分别证明对应边界。它们不证明官方 CLI 的安装、真实 systemd 用户服务或实际 Magpie 插件宿主已通过验收。本文的真实 Linux 入口是可选的独立操作，需要已准备好的专用一次性账户；脚本不会安装操作系统、创建账户、调用 sudo、连接生产服务器或读取日常 SSH/模型凭据。

## 发布门禁

从仓库根目录执行，使用 Node.js 22 或 24 和已有依赖：

```sh
npm ci --ignore-scripts --omit=optional
node scripts/release-check.mjs
```

包装器依次运行现有 `npm run check`、`npm test`、`npm run test:remote`、`npm run test:ui`、`npm run test:ui:remote`，补充明确的 Node SSH 回归、精确 Bun 1.4.3 全量测试、显式提供的实际宿主回归及 `npm pack --dry-run --ignore-scripts --json`。打包仅预览文件，不触发递归 prepack。浏览器须已安装，可用现有 `MIGPIE_UI_BROWSER` 指定 Chromium；否则在开发环境显式运行 `npm exec --no -- playwright install chromium`。依赖安装一律禁用生命周期脚本。

结果写入 `.local/release-check.json`，命令日志写入 `.local/release-logs/`。JSON 包含提交 SHA、dirty 标记、源码指纹、Node/Bun/宿主信息、OS/架构、每项 `passed` / `failed` / `not_run`、实际 npm 包文件清单和 `unaccepted`。同一提交但源码变更的 Linux 记录会因指纹不符被拒绝；文本 CRLF/LF 不影响指纹。指纹覆盖入口、清单、锁文件、src、page、scripts、tests，包括未跟踪文件，且运行结束会核对源码未变化。

未找到 Bun、未提供实际宿主或未提供真实 Linux 结果时，对应检查为 `not_run`。普通模式允许只有未运行项的报告退出 0，但其 `status` 为 `incomplete`、`complete` 为 false；任何实际失败均非零。`--strict` 要求全部项目通过，缺外部验收或可选 Linux 更新记录均非零。`npm run check:release` 已接入此包装器；`npm run check:release:strict` 接入严格模式。

```sh
node scripts/release-check.mjs --strict \
  --bun /absolute/path/to/bun \
  --host /absolute/path/to/official/host-current.js \
  --linux-result .local/linux-lifecycle-result.json
```

Windows PowerShell 的等价命令示例：

```powershell
node scripts/release-check.mjs --strict --bun 'C:/acceptance/bun.exe' --host 'C:/acceptance/host-current.js' --linux-result '.local/linux-lifecycle-result.json'
```

`--bun`、`--host` 需要绝对路径，环境变量分别是 `MIGPIE_RELEASE_BUN`、`MIGPIE_RELEASE_HOST`；未指定 Bun 时仅查 PATH，不搜索日常应用目录。宿主是操作者确认来自实际 Magpie 的已有 `host-*.js`，报告记录文件 SHA-256，包装器调用已有 [host-smoke.mjs](../scripts/host-smoke.mjs) 在源码副本与临时配置中运行，不重载日常宿主。Linux 结果也可由 `MIGPIE_RELEASE_LINUX_RESULT` 提供。`--output` 可改结果位置；`--skip-ui` 仅供拆分 CI 使用，会把两项浏览器回归记成 `not_run`，不能用于完整 strict 验收。

Linux JSON 是受信任验收操作者提供的证据文件，并非签名证明；不能拿手写结果、替身结果或其他源码版本的历史结果填充发布门禁。应保留对应 CI 日志、资产清单和验收记录。

## CI 覆盖

[verify.yml](../.github/workflows/verify.yml) 的 Node 矩阵为 Ubuntu、Windows × Node 22、24。每格安装精确 Bun **1.4.3**，执行无安装脚本的 `npm ci`，运行门禁的非 UI 部分，包括 Node 与 Bun 测试、单列 Node SSH 回归、生成脚本替身和包清单。Linux 单独一个 Node 24 job 安装锁定 Playwright 的 Chromium 并运行两项浏览器回归。日志/JSON 与截图分别上传为工作流 artifacts。

CI 缺实际宿主与专用 Linux 会话时如实保留未验收项。矩阵结果和单独 UI job 可供审阅，当前脚本不会自动合并不同 job 的 JSON 为一份完整 strict 结果。GitHub 托管 runner 上的 Linux 替身回归也不会被标为真实生命周期验收。

## 真实 Linux 环境准备

由环境维护者事先提供一次性的 Linux amd64/arm64 主机或 VM，并创建独立普通账户，例如 `magpie-acceptance-e3a`，登记 HOME 为 `/home/magpie-acceptance-e3a`。账户名须符合 `magpie-acceptance-` 加至少三位小写字母、数字、下划线或连字符；HOME basename 必须与账户名一致。UID 至少 1000，不能通过 sudo 启动脚本。这里不提供需要提权的自动建机步骤。

直接登录该账户，确认已有真正的 `systemd --user` 会话和 `/run/user/UID/bus`，保持会话直到验收及清理结束。可使用该环境预先准备的控制台或专用测试登录；无需复制真实私钥、SSH 配置、供应商密钥或 Magpie 账户数据。仅改 `HOME`、使用 root、仅启动假 systemctl、普通无用户总线的容器都不满足要求。

专用 HOME 应是新建目录，只允许系统默认 shell 启动文件及空 `.config` / `.cache` / `.local` 框架，不允许 `.ssh`、`.curlrc`、旧应用数据或已有 magpie.service。输入路径必须规范、绝对、无空白/控制字符、无符号链接，目录归当前用户且不能被组或其他人写入。仓库放在 HOME 外的独立路径，用户可写 `.local/` 报告目录。不要把一次性 HOME 设置为仓库目录、其父目录或子目录。

以下命令只核对已存在的环境，不安装任何系统组件：

```sh
id -un
getent passwd "$(id -u)"
systemctl --user show-environment >/dev/null
systemctl --user show magpie.service --property=LoadState --value
node --version
```

最后一个服务状态应为 `not-found`。脚本还要求 `/usr/bin` 中真实、root 所有且不可被普通用户修改的 sh/systemctl/loginctl/getent/id/curl/sha256sum/base64/mktemp/install/readlink/tar。PATH 固定为系统目录；不调用 shell 启动文件，不继承代理、SSH agent、供应商凭据或日常 XDG 目录。网络须可直接访问官方源。

## 固定官方资产与命令

操作者从可信官方发布资料取得准确版本、对应 Linux CLI URL 和 SHA-256，将它们放入清单。清单是参数输入，脚本不会自动接受随时间变化的 latest 作为安装版本。只允许 `https://github.com/yetone/magpie-releases/releases/download/<固定版本>/magpie-cli-linux-amd64` 或 arm64，同一 URL 中的版本必须与清单一致。

在仓库 `.local/pinned-releases.json` 创建以下结构，**先将占位符全部替换为实际官方值**。占位版本、缺失/伪造 SHA-256 都会被拒绝；这里不提供未经下载核实的哈希，也不编造下载总字节数：

```json
{
  "install": {
    "version": "REPLACE_WITH_FIXED_VERSION",
    "url": "REPLACE_WITH_FIXED_OFFICIAL_LINUX_ASSET_URL",
    "sha256": "REPLACE_WITH_TRUSTED_OFFICIAL_64_HEX_SHA256"
  }
}
```

仅在官方清单提供真实字节长度时才可添加正整数 `size`；省略时安装进度总量为未知，报告只记录实际观测字节。要验收更新，增加具有相同字段的顶层 `update` 对象，必须是第二个更新且哈希不同的版本。使用相同版本伪造更新会被拒绝。

在专用账户、仓库根目录执行：

```sh
node scripts/linux-lifecycle-smoke.mjs \
  --home /home/magpie-acceptance-e3a \
  --confirm-home /home/magpie-acceptance-e3a \
  --release-manifest .local/pinned-releases.json \
  --output .local/linux-lifecycle-result.json
```

等价环境变量是 `MIGPIE_LINUX_HOME`、`MIGPIE_LINUX_CONFIRM_HOME`、`MIGPIE_LINUX_RELEASE_MANIFEST`。HOME 必须是当前账户的实际登记 HOME，且当前 `HOME` 已与它相同。显式重复 HOME 表示确认该目录及该用户会话只用于一次性验收。报告应留在 HOME 外，以便删除账户后保留证据。

脚本通过子进程 `/usr/bin/sh -s` 执行现有 [actionScript / probeScript](../src/remote-scripts.mjs)，保持 install → enable_web → backup → restore → uninstall 的真实路径。安装使用原脚本的 HTTPS 下载、全新下载暂存目录与 SHA-256 校验；生成脚本通过 stdin 传入，控制工作目录与下载目录分开。不会在下载目录运行解释器，也不添加 curl/Magpie/systemctl 替身。备份使用随机生成的无秘密文本标记，恢复要求标记还原、多余文件消失、恢复前快照保留和用户服务重新运行；既不提交模型请求，也不执行会输出 Web 管理密钥的 `daemon web`。

提供 `update` 时，脚本先把第二资产下载到另一个新空目录并校验哈希，再确认官方 `https://usemagpie.ai/api/latest` 的版本、资产 URL、SHA-256 与第二资产一致，随后调用原 `actionScript("update")`。原生 `magpie update` 仍跟随官方 latest，不能强制历史目标；feed 已变化会拒绝运行，运行后版本及二进制 SHA-256 不一致也会失败。该前后校验不提供原生更新的版本锁定保证。未提供第二资产时完全不执行更新，`update` 为 `not_run`，JSON 为 `incomplete`，核心流程成功可退出 0，但 strict 发布门禁仍非零。

结果含 `kind: "magpie-linux-lifecycle"`、`execution: "real"`、`substitutes: false`、提交/指纹、真实 Linux 与用户会话证据、固定官方资产及逐动作结果。任一前置检查失败，后续动作仍是 `not_run`；Windows/Git Bash 运行入口也只会失败并生成未验收报告，不会退回替身。原始 CLI/systemd 输出不落报告或控制台，避免意外保存服务 Web key。

## 服务与数据清理

正常完成或中途失败后，脚本尝试在同一专用会话中卸载并停止服务，禁用 `magpie.service`，仅移除本次专用 HOME 下的用户单元、对应 enable 链接和 `.local/bin/magpie`，执行 `daemon-reload` 后检查 unit 为 `not-found`、程序缺失且服务未运行。临时下载/控制目录随本次运行清理；配置、随机标记和备份保留给操作者检查。脚本不递归删除 HOME，也不删除其他用户的数据。

若脚本被强制杀死、系统断电或清理为 failed，在**同一个专用账户**先执行：

```sh
systemctl --user stop magpie.service
systemctl --user disable magpie.service
```

检查专用 HOME 下 `.config/systemd/user/magpie.service`、`default.target.wants/magpie.service` 和 `.local/bin/magpie`；确认都属于此次一次性账户后，仅移除这些文件或链接，然后运行：

```sh
systemctl --user daemon-reload
systemctl --user reset-failed magpie.service
systemctl --user show magpie.service --property=LoadState --value
```

确认服务不再运行、单元为 `not-found` 后导出 HOME 外的 JSON，退出会话，由环境维护者回收整个一次性账户/VM。人工清理成功不能把已失败的验收 JSON 改成 passed；应换新账户按原步骤重跑。不应在日常 HOME 或生产会话照抄清理命令。

## 本次交付验证矩阵

| 项目 | 本次状态 | 证据与限制 |
| --- | --- | --- |
| 两个新增 Node 脚本语法、帮助入口 | 已测 | `node --check` 与 `--help`，无下载或系统变更 |
| 四文件 diff 空白检查 | 已测 | `git diff --check`；不包含真实环境验收 |
| Node/SSH/浏览器门禁执行 | 见验证记录 | 本机整合回归与最终计数见[验证记录](verification.md)，机器可读结果在 `.local/release-check.json` |
| CI Ubuntu/Windows × Node 22/24 | 已配置，未运行 | 工作流在推送/PR/手动触发后才产生结果 |
| 精确 Bun 1.4.3 | 本机未测 | 当前 Windows 环境无可用 Bun，不安装系统运行时 |
| 实际 Magpie host 文件回归 | 本机未测 | 当前无可用实际宿主；发布门禁记录 not_run |
| Linux 生成脚本替身 | 现有入口，非真实验收 | `test:remote` 的 curl/Magpie/systemd 均为替身，CI将执行 |
| 官方 CLI 下载、systemd 用户会话及完整生命周期 | 未测 | 当前无 VM/WSL/Linux；未下载 CLI、未连接生产 |
| 第二官方资产更新 | 未测 | 只有显式第二资产并满足官方 latest 校验时才可执行 |

历史验证范围见 [验证记录](verification.md)，现有开发入口见 [开发说明](development.md)。历史成功记录不会自动填充新门禁的外部验收项。
