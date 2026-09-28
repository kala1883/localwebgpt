# LocalWebGPT（Local Workspace Bridge）

LocalWebGPT 是 Windows 本机 MCP bridge：ChatGPT 网页通过 OpenAI Secure MCP Tunnel 调用本机工具；操作者在本地控制台逐个登记目录/文件，并逐根选择允许的工具。它不会自动扫描或上传整个磁盘。工具返回的文件内容会发给 ChatGPT，因此“只读”仍然意味着内容离开本机。

English: [README.en.md](README.en.md) · 完整操作手册：[docs/operator-runbook.md](docs/operator-runbook.md) · V1 验收记录：[docs/release/V1-acceptance.md](docs/release/V1-acceptance.md) · 安装与升级：[docs/install-and-upgrade.md](docs/install-and-upgrade.md) · 接入验收：[docs/chatgpt-tunnel-acceptance.md](docs/chatgpt-tunnel-acceptance.md)

## 工作方式

```text
ChatGPT 网页 MCP App（Tunnel）
             ⇅ OpenAI Secure MCP Tunnel
本机 tunnel-client → MCP adapter / daemon → 控制台明确授权的目录
```

本机 `tunnel-client` 主动向 OpenAI 建立出站 HTTPS 连接；不需要给本机服务开放公网入站端口，也不要把 `localhost` 填成 ChatGPT 的公网 Server URL。Tunnel 只负责传输，不授予本地目录权限。公网发布插件是另一种部署方式，需要稳定、可公开访问的 HTTPS MCP endpoint；不属于本项目的本机 Tunnel 测试方式。

## 前置条件与权限

- Windows x64、Node.js `>=22.12.0`、npm；本仓库源码运行时需先安装依赖（`npm ci`）。
- 一个可使用 Developer mode 的 ChatGPT 工作区。
- OpenAI Platform 组织中的 Tunnel 管理/使用权限，以及到 OpenAI 的出站 HTTPS（默认 `api.openai.com:443`）。
- 权限彼此独立：创建/编辑 Tunnel 需要 Platform `Tunnels Read + Manage`；运行 `tunnel-client` 或在 ChatGPT 选择 Tunnel 需要 `Tunnels Read + Use`；ChatGPT Developer mode 还受单独的工作区设置/管理员策略控制。

## 1. 在 Platform 创建 Tunnel 并取得 `tunnel_id`

1. 用浏览器登录 [OpenAI Platform 的 Tunnel 设置](https://platform.openai.com/settings/organization/tunnels)，先在组织选择器切到正确的 Platform 组织。
2. 选择页面上的创建 Tunnel 操作，为 Tunnel 起一个容易识别的名字并创建。
3. 打开新 Tunnel 的详情，复制其 `tunnel_id`（格式类似 `tunnel_…`）。它是标识符，不是密钥。
4. 在 Tunnel 的组织/工作区关联设置中，加入拥有该 Tunnel 的 Platform 组织和稍后要连接它的 ChatGPT 工作区。只关联个人 Platform 组织时，它不一定会出现在 Enterprise/Edu 工作区。

如果页面没有创建/管理入口，请让 Platform 组织所有者或 RBAC 管理员授予上述权限。若目标 ChatGPT 工作区没有出现在关联项中，请联系该工作区管理员；企业关联无法自动确认时需由 OpenAI 账号团队处理。

## 2. 创建 runtime API key

`tunnel-client` 需要 **runtime API key** 来认证到 Tunnel control plane。请在 Platform 的 Tunnel 设置流程中创建/签发供 `tunnel-client` 使用的 runtime key，并确认它具备 `Tunnels Read + Use`。不要把它填到 ChatGPT MCP App 的 OAuth 区域；本项目的 ChatGPT App 选择 **No authentication**。

OpenAI 当前 Secure MCP Tunnel 指南说明了 runtime key 的用途与权限，但没有承诺所有账号都显示相同的逐按钮创建界面。若你在 Tunnel 设置中找不到明确的 runtime-key 创建/复制入口，先向组织管理员确认，不要猜测按钮，也不要用普通项目 API key 替代。复制出的密钥只保存到本机 `.env`，不要发到聊天、截图、日志或 Git。

## 3. 本机配置并启动

在仓库根目录创建 `.env`（打包版则在 runtime 根目录创建），内容按下面填写；把占位值替换成刚取得的真实值：

```dotenv
tunnel_id=tunnel_在Platform复制的ID
runtime_API_key=在Platform创建的runtime密钥
```

`.env` 已被 Git 忽略，打包脚本也不会把它复制进 runtime。新 checkout 首次运行时，在仓库根目录安装依赖：

```powershell
Set-Location 'D:\MyProjects\MyApps\LocalWebGPT'
npm ci
```

源码 checkout 每次启动前先验证 `.env`，再运行一体化脚本：

```powershell
Set-Location 'D:\MyProjects\MyApps\LocalWebGPT'
.\packaging\windows\Start-LocalWebGPT.ps1 -ValidateOnly
.\packaging\windows\Start-LocalWebGPT.ps1
```

验证成功应显示 `Project-root .env is valid; credential values were not displayed.` 且不显示密钥。启动脚本会启动本机 daemon，并打印一个**一次性、本机控制台链接**。在浏览器打开终端给出的完整链接（不要分享链接，它含临时授权令牌），进入 **ChatGPT 连接**，阅读确认项并点击 **在本机启用 ChatGPT 连接**。这只启用连接级工具发现，不会授权任何目录。确认后脚本继续运行 Tunnel doctor 并启动 `tunnel-client`；等终端报告检查通过、隧道运行正常后再创建 ChatGPT App。

> 为什么先做本机确认：本项目把 MCP 工具目录也放在连接启用守卫后面，ChatGPT 点击 Create 时会立即发现工具；未启用时可能因 `tools/list` 不可用而创建失败。这是 LocalWebGPT 的本地安全顺序；之后仍要保持本机脚本和 Tunnel 在线。

若 PowerShell 找不到 Node/npm，先安装符合要求的 Node.js 并重开终端。`.env` 检查失败时按错误提示修正字段名/格式；脚本不会回显密钥。

停止服务时，另开一个 PowerShell 窗口运行源码目录的 `.\packaging\windows\Stop-LocalWebGPT.ps1`（打包 runtime 根目录为 `.\Stop-LocalWebGPT.ps1`），然后等待启动窗口返回提示符。该命令只发固定的本机停止请求，不按 PID 结束进程；它会等在途操作完成后再关闭 daemon。

## 4. 在 ChatGPT 网页创建 MCP App

1. ChatGPT → **Settings** → **Security and login** → 开启 **Developer mode**（若工作区策略不允许，请联系管理员）。
2. 打开 **Plugins**，点右上角 **+ / Add**，新建开发者模式 App。
3. 填用户可见的名称和简介，例如 `Local Workspace Bridge` / `访问我在本机控制台明确授权的工作区`。
4. **Connection** 选择 **Tunnel**，选上面创建的 Tunnel；若列表没有它，可粘贴 `tunnel_id`。确认该 Tunnel 已关联当前 ChatGPT 工作区，且创建 App 的账号有 `Tunnels Read + Use`。
5. **Authentication** 选 **No authentication**。本项目的 Tunnel runtime key 由本机 `tunnel-client` 使用，不要粘贴进 ChatGPT 表单。
6. 勾选页面的风险确认并点 **Create**，检查 ChatGPT 发现的工具名称/说明。
7. 新开对话，从工具菜单（`+` / More / Tools）添加此 MCP App，再测试 `bridge_status`、`workspace_list` 等连接级工具。工具定义变化后，在 Plugins 管理页对连接执行 **Refresh**，然后新开对话复测。

## 5. 在本地控制台按目录授权工具

打开启动终端给出的本机控制台链接，进入 **工作区**：

1. 点击登记目录/文件，粘贴本机绝对路径。一般先从窄范围测试目录开始；若要让 ChatGPT 访问整个固定 NTFS 卷，可登记 `C:\` 或 `D:\`，这会覆盖该卷内的窄根授权，获授工具将作用于该卷内全部可访问目录。
2. 选择工作区模式：**只读**，或 **读取 + 修改**。修改模式允许稍后在该目录授权 ChatGPT 直接创建/编辑文本文件；授权后不再逐次本机批准。
3. 在该根的 **配置 ChatGPT 工具** 中逐项选择并保存：

   | 控制台授权 | MCP 工具范围 |
   | --- | --- |
   | 列出目录/文件名 | `file_list` |
   | 读取文件内容 | `file_read` 及相关快照/错误详情 |
   | 搜索文本 | `text_search` |
   | 读取 Git 状态与差异 | `git_status`、`git_diff` |
   | 创建/删除/应用修改集 | `file_create` / `file_delete` / `change_prepare` / `change_apply`，单次调用按 workspace 文件修改 grant 执行；删除在本机先快照，无须先 `file_read` |
   | 编辑既有文件 | `file_edit`；同一 workspace 必须同时获授“读取文件内容”和“文件修改” |
   | 执行命令（高风险） | `command_exec`；独立授权，支持 `cmd`、PowerShell、Bash |

每一项授权都只对该根生效；空选保存会撤销该根全部 ChatGPT 工具授权。实际调用还要求 ChatGPT 连接和工作区启用。读取、Git、文件修改和命令执行分别由本页的目录授权控制；平台验收状态只作说明，不再作为隐藏的全局功能开关。获授“文件修改”即允许在该目录直接创建/删除普通文件并应用修改集，不会逐次等待人工批准。编辑既有文件（包括 `file_edit` 和 `change_prepare` 中的编辑项）还需读取 grant，以取得最新哈希和 `read_token`；工具清单不会在缺少任一授权时暴露 `file_edit`。删除会在本机内部先读取并保存完整快照，单文件上限 16 MiB。

`command_exec` 是与“文件修改”分开的高风险授权：只适用于可写的目录工作区，单次最多运行 25 秒，输出有上限并经过秘密/本机绝对路径筛查。它以运行 LocalWebGPT 的 Windows 用户身份启动所选 shell；登记目录只作为**初始工作目录，不是沙箱**。命令仍可能访问该用户有权限的其他路径、联网，并绕过受保护文件执行器、逐文件冲突核对和快照回滚；超时、撤权或暂停时可能留下部分副作用。它也可以运行 `git commit` / `git push`、包安装等 shell 命令；这些没有独立 MCP 工具或额外语义保护。只向可信连接授予，并仅在专用测试目录验收。普通文件工具原有的路径范围、对象身份与版本冲突检查、秘密路径拒绝、审计和受保护执行器仍然生效。

## 6. 建议验收顺序与常见故障

先确认 Tunnel 进程在线，再依次调用 `bridge_status` → `workspace_list` → 对测试根执行 `file_list` / `file_read` / `text_search`。在本地控制台对**专用临时目录**授予所需工具后，测试 `file_create` / `file_edit` 并独立回读；删除测试直接调用 `file_delete` 并确认目标消失。多文件修改用 `change_prepare` 再 `change_apply`。命令执行须另行勾选 `command_exec`，先用 `Write-Output` / `echo` 等无副作用命令验证 shell、工作目录和回执，再测试撤权/暂停停止；不要让首次命令测试读写个人目录或运行安装/删除命令。

- 创建 App 报 424 / 无法获取工具列表：检查本机控制台的 ChatGPT 连接是否已启用、启动脚本是否仍在运行、`tunnel-client` 是否健康。
- Tunnel 下拉框为空：核对 Platform 组织/ChatGPT 工作区关联及创建者的 `Tunnels Read + Use`。
- 能看到 App 但读取/写入返回 `NOT_AUTHORIZED`：检查控制台里的该根工具授权和工作区状态；Tunnel 连通不代表文件授权。
- 工具刚变更但 ChatGPT 仍看到旧列表：Plugins 管理页 Refresh，再新开对话。

## 官方资料

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
