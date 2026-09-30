# LocalWebGPT V1 操作手册

本手册用于 Windows 本机私有开发/自用连接。Secure MCP Tunnel 走本机向 OpenAI 发起的出站连接，不需要把本机 MCP 服务开放到公网；但 ChatGPT 会收到工具明确返回的文件内容，所以只登记你愿意授权的目录。Tunnel 适合开发模式，不等于可提交到公开插件目录的公网部署。

## 1. 准备与构建

需要 Windows、PowerShell 7、Git、Node.js `22.12.0` 或更新的 22.x，以及一个可用的 ChatGPT 开发者模式工作区。不要用管理员身份运行。

从源码仓库根目录执行：

```powershell
npm ci
npm run check
.\deployment\windows\build-runtime.ps1 -OutputDirectory "$env:LOCALAPPDATA\Programs\LocalWebGPT-v0.1.0"
```

输出目录必须是一个尚不存在的新目录。构建器会校验锁定依赖、Windows SQLite 原生模块和官方 tunnel-client 包，构建 Console，并生成 SPDX SBOM 与构建指纹。生成目录绑定绝对路径，之后不要移动它。没有签名安装器；遇到失败时保留输出目录供诊断，不要直接覆盖旧安装。

## 2. 设置 Tunnel 凭据

1. 在 [OpenAI Platform 的 Tunnels 设置](https://platform.openai.com/settings/organization/tunnels) 选择正确的 Platform 组织并创建 Tunnel，复制 `tunnel_id`。
2. 将目标 ChatGPT 工作区关联到该 Tunnel。仅把 Tunnel 建在 Platform 组织下，不保证它会出现在另一个 ChatGPT 工作区。
3. 在 Platform 创建供本机 tunnel-client 使用的 runtime API key。创建/管理 Tunnel 需要 Tunnels Read + Manage；运行 tunnel-client 或在 ChatGPT 中选择 Tunnel 需要 Tunnels Read + Use。ChatGPT Developer mode 是另一项独立的工作区设置。
4. 在 runtime 根目录创建/编辑 `.env`（源码运行则在仓库根目录）。保留已有配置，只添加或更新这些键：

```dotenv
tunnel_id=tunnel_从Platform复制的ID
runtime_API_key=本机runtime_key
snapshot_store_max_bytes=1073741824
```

`snapshot_store_max_bytes` 可省略，默认 1 GiB，硬上限 2 GiB。不要把真实 key 放进 Git、截图、聊天或日志；`.env` 不随 runtime 构建复制。运行配置检查：

```powershell
.\Start-LocalWebGPT.ps1 -ValidateOnly
```

该命令必须在 runtime 根目录执行；若从源码仓库运行，则使用：

```powershell
.\scripts\windows\Start-LocalWebGPT.ps1 -ValidateOnly
```

## 3. 先启动本机服务与 Tunnel

在 runtime 根目录执行：

```powershell
.\Start-LocalWebGPT.ps1
```

启动窗口保持打开。首次启动时按终端提示打开一次性本机控制台地址，在“ChatGPT 连接”页启用该连接。脚本完成本机连接检查后运行 tunnel-client；ChatGPT 创建/发现 MCP App 时需要这条本机 Tunnel 在线。不要再启动第二份 daemon 或 tunnel-client。

本机 tunnel-client 的 loopback 健康与就绪端点（当前默认管理端口为 `8080`）：

```powershell
Invoke-WebRequest http://127.0.0.1:8080/healthz
Invoke-WebRequest http://127.0.0.1:8080/readyz
```

两者都应返回 HTTP `200`。如安装的 tunnel-client 改了管理端口，以本机实际配置为准。管理 UI 是 `http://127.0.0.1:8080/ui`；不要把它转发到公网。

### 核对当前运行的代码版本

在 ChatGPT 工具面调用 `bridge_status`：

- `server_version` 是产品版本号（例如 `0.1.0`），不区分同一版本的不同源码构建。
- 打包 runtime 会返回 `build_id=sha256:<fingerprint>`；它应与 runtime 根目录 `docs/release/build-record.md` 的 source manifest SHA-256 对应。源码 checkout 返回 `source-checkout`。
- `build_id` 只是本机诊断指纹，不是签名或安全证明；目录授权仍由 workspace/tool grants 决定。
- 更新代码后若 `bridge_status` 仍没有 `build_id` 或指纹未变，先确认旧 daemon 已正常退出，再从目标 runtime 启动；之后在 ChatGPT Plugins 管理页执行 **Refresh tools** 并新建会话。只刷新工具元数据不会重载本机 daemon 代码。

## 4. 在 ChatGPT 网页创建 MCP App

1. 在 ChatGPT 打开 **Settings → Security and login**，启用 **Developer mode**（企业/教育工作区可能需要管理员先允许）。
2. 打开 **Plugins** 页面，点右上角 **Add → Create MCP App**。
3. 填名称（例如 `Local Workspace Bridge`）和简短描述。
4. 在 **Connection** 选择 **Tunnel**，填入与本机 `.env` 相同的 `tunnel_id`。不要填本机 `127.0.0.1` 地址或公开 URL。
5. Authentication 选 **No authentication**（本项目的 tunnel-client 已在 Tunnel 链路中认证）；勾选信任提示后点击 **Create**。
6. 等待 ChatGPT 完成 MCP 初始化并显示工具清单；核对工具名称/数量与本项目一致。
7. 新建聊天，点工具/插件菜单，选择 `Local Workspace Bridge`。Tunnel 必须继续运行。

官方步骤与可用性说明见 [Secure MCP Tunnel 指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 和 [连接并测试插件](https://developers.openai.com/plugins/deploy/connect-chatgpt)。Tunnel 用于私有开发测试；公开插件分发要求稳定可公开访问的 HTTPS MCP endpoint，不能只靠 Tunnel。

## 5. 在本机控制台按目录授权

首次网页调用前，在本机 Console 的“工作区”页：

1. 通常先登记一个**专用测试目录**（例如 `D:\LWB-Test`）。若你明确选择 `C:\` / `D:\` 这样的卷根，权限范围就是该卷内的所有可访问路径，会覆盖该卷上的窄目录授权。
2. 对刚创建的 ChatGPT 连接勾选所需工具：读取、搜索、Git 只读、文件修改。只开实际需要的项。
3. 保存授权。每个目录的工具 grant 是实际权限来源；`file_create` / `file_edit` / `file_delete` 在同一 MCP 调用内直接执行，多文件修改用 `change_prepare` → `change_apply`，都不再要求每次操作去 Console 点击批准。删除只需路径；daemon 在本次调用内保存完整基线快照（单文件上限 16 MiB）。`command_exec` 是另一个独立的高风险 grant，只能授予可写目录根。
4. 删除/撤销 workspace grant 或暂停连接后，再次调用应被拒绝。出现不确定结果时先查 Console 的更改/恢复页，不要盲目重试写入。

`command_exec` 支持 `cmd`、PowerShell 和 Bash，以运行 LocalWebGPT 的本机用户权限启动。它只把授权目录设为初始工作目录，并不构成沙箱：命令可能访问其他可访问路径、联网、绕过文件护栏且留下无法自动回滚的部分副作用。命令没有硬性运行时限；输出超限、撤销授权、暂停工作区或关闭 daemon 会停止它，但可能留下部分副作用。ChatGPT/MCP 调用方停止等待或断开连接不会自动取消本机进程；结果未知时先检查工作区，并复用原 `idempotency_key`，不得换新键盲目重跑。输出限量并做秘密/绝对路径筛查；只在一次性测试目录使用，并且只授予可信连接。每条用户意图必须使用一个稳定的 `idempotency_key`；确切重试复用原键。相同键可抑制重放，但不能把两个不同键推断为同一意图。虽然没有专用 Git 写工具，shell 仍可运行 `git commit` / `git push` 等任意命令；不要把工具列表误当成 shell 内部能力白名单。普通 `file_delete` 仍拒绝秘密/凭据硬拒绝路径、多硬链接对象及越出授权根的路径；这些文件工具的冲突检查、快照、审计、回读校验与紧急暂停继续生效。

### 本机 JSON 配置

控制台“配置”页管理会话期限，并展示受保护存储中的 `config/local-configuration.json`。该文件是会话期限和工作区 MCP 工具授权的权威配置；已有工作区及工具 grant 会在首次启动时迁入 JSON。SQLite 仍保存工作区物理身份和运行/审计记录，JSON 工具授权在每次访问时作为独立门禁核对。`session.idle_timeout_ms: 0` 表示不因空闲过期；`session.absolute_timeout_ms: null` 表示不设绝对期限，数字值范围为 1 分钟至 30 天。绝对期限无限时，启用的空闲期限仍会使会话过期。工作区注册、移除、重定位、暂停及工具授权仍需通过控制台的工作区页，以保留目录筛查、身份核验和审计流程；这些操作会同步更新 JSON。请通过控制台保存设置，不要手工改写 JSON；文件在 daemon 启动时读取。

## 6. 建议的网页验收顺序

只在刚才的专用测试目录进行写入。每一步都检查 ChatGPT 展示的工具调用与结果：

1. “列出当前连接已授权的工作区。”预期：`workspace_list`。
2. “列出这个测试工作区根目录文件。”预期：`file_list`。
3. “读取 `README.md` 并只总结第一段。”预期：`file_read`；内容必须来自工具回执。
4. “在此工作区创建 `acceptance-note.txt`，内容只有 `saved by workspace grant`，现在直接保存。”预期：`file_create` 返回 `state=APPLIED` 和回执。之后再要求读取该文件，并与磁盘字节核对。
5. 对测试文本文件先读取，再要求把某行的唯一标记改掉。预期：`file_edit` 使用该次读取的 `read_token` 和 SHA-256，返回 `APPLIED`；再次 `file_read` 并核对摘要。
6. 在同一临时目录新建一个 disposable 文本文件，直接请求 `file_delete`（不要先 `file_read`）。预期：返回 `APPLIED`，并确认路径不存在；二进制测试应仅查看 metadata-only 删除差异。
7. 对刚删除的文本测试文件调用 `change_revert_prepare`，检查它生成 `create_text` 逆提案，再用 `change_apply` 恢复。自动逆提案仅支持可逐字节重建的 UTF-8 文本（非混合换行，且小于 2 MiB）；二进制、超大或混合换行快照会明确拒绝近似恢复。
8. 若要测多文件，明确要求修改两个测试文件。预期：`change_prepare` 后对同一 `change_id` 调 `change_apply`；成功必须有 `APPLIED` 回执。不要在真实仓库首次试写/删除。
9. 撤销测试目录的“文件修改”授权，再请求一次写入或删除；预期拒绝且文件字节不变。

只有实际看到正确工具序列、`APPLIED` 回执、回读哈希一致和未授权拒绝，才能记录该项网页验收 PASS。代码/单元测试通过不等于 ChatGPT 网页已验收。

## 7. `424` / “本地工具面当前不可用”排查

1. 确认 `Start-LocalWebGPT.ps1` 的窗口仍在运行，且 tunnel-client `/healthz` 与 `/readyz` 都为 `200`。
2. 查看 tunnel-client 本机管理页 `/ui` 和启动日志；若断线，用项目的 Stop 命令正常停止后再启动，不要强杀进程，也不要并行启动第二份。
3. 核对 ChatGPT App 填的是 Tunnel ID，而不是 Server URL；Platform Tunnel 已关联到当前 ChatGPT 工作区；创建/运行者具备 Tunnels Read + Use。
4. 确认本机 Console 已启用这条连接。连接启用只控制工具发现，不自动登记工作区或授予读写。
5. 回到 Plugins 连接详情执行 Refresh（若界面提供），然后开新聊天重新选择 App。若仍失败，记录 HTTP 错误码、脱敏后的 tunnel-client 健康状态和 daemon 日志片段；不要贴 API key 或 one-time console URL。

## 8. 暂停、停止与恢复

正常停止：在另一个 PowerShell 窗口，从 runtime 根目录执行：

```powershell
.\Stop-LocalWebGPT.ps1
```

等待启动窗口提示完全退出。该命令只向当前 SID 的本机服务发送固定停止请求，会先停止接收新操作并等待在途 handler 排空，不按任意 PID 杀进程。

若网页调用超时或断开：在 Console 更改/恢复页确认操作状态与回执；不要重复创建或应用。状态目录 `%LOCALAPPDATA%\LocalWorkspaceBridge` 含数据库、快照、审计及恢复数据，停止/卸载时默认保留。恢复未决前，不要删除该目录或 runtime。
