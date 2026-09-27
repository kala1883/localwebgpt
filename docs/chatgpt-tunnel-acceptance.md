# ChatGPT 本地隧道接入与验收

本页区分两条不同的链路，避免把本地快照导出误当成 ChatGPT 接入。

中英文的项目介绍、从 Platform 创建 Tunnel/runtime key、`.env` 配置、创建 ChatGPT MCP App 和逐目录选工具的完整步骤见仓库根目录 [README.md](../README.md) 与 [README.en.md](../README.en.md)。

## A. ChatGPT → 本地 MCP 服务

顺序是：Platform 创建/关联 Tunnel 并签发 runtime key → 本机启动 daemon → 在本机控制台明确启用连接 → 启动并确认 `tunnel-client` 健康 → ChatGPT 开发者模式应用选择 Tunnel → 验证工具发现与调用。`tunnel-client` 从本机向 OpenAI 建立出站连接并转发 MCP 请求；ChatGPT 不直接访问本机 `localhost`。添加应用时配置的是隧道连接，不上传本地工作区或整个插件服务。

### 准备账号权限

在 [Platform Tunnel 设置](https://platform.openai.com/settings/organization/tunnels) 切换到正确组织，创建 Secure MCP Tunnel，复制 `tunnel_id`，并把 Tunnel 关联到拥有它的 Platform 组织和目标 ChatGPT 工作区。创建/编辑 Tunnel 需要 Platform `Tunnels Read + Manage`；运行客户端和在 ChatGPT 选择 Tunnel 需要 `Tunnels Read + Use`。在 Tunnel 设置流程中签发供 `tunnel-client` 使用的 **runtime API key**，并确认它具备 `Tunnels Read + Use`。官方指南没有保证所有账号显示完全相同的密钥创建按钮；若找不到明确的 runtime-key 创建入口，请向组织管理员确认，不要用普通项目 API key 替代。密钥只放本机 `.env`，不可粘贴到 ChatGPT 的 OAuth 表单。另让目标 ChatGPT 工作区获准使用 Developer mode；此权限与 Platform 隧道权限彼此独立。

### 启动本机服务

推荐直接运行一体化启动脚本：先在项目根（打包 runtime 则在 runtime 根）`.env` 中填写 `tunnel_id=...` 与 `runtime_API_key=...`，源码目录执行 `.\packaging\windows\Start-LocalWebGPT.ps1`，runtime 目录执行 `.\Start-LocalWebGPT.ps1`。脚本从 `.env` 读取配置，不回显凭据；若模型连接默认停用，会等待本机控制台确认启用，随后自动 doctor 并启动隧道。`.env` 已忽略且构建时不会复制，打包后需在 runtime 根单独创建。这样“读取本地配置 → 启动服务 → 本机启用 ChatGPT 连接 → 隧道开始接收请求”由一个命令串起来。

源码 checkout 可运行 `.\packaging\windows\Start-LocalWebGPT.ps1 -ValidateOnly` 检查项目根 `.env`，再运行 `.\packaging\windows\Start-LocalWebGPT.ps1`。打包 runtime 则运行 `.\Start-LocalWebGPT.ps1`。若需手工诊断，也可以在 Windows PowerShell 中设置当前会话变量。隧道 ID 不是密钥；runtime key 输入时隐藏。两者都不要提交到仓库、写入 YAML 或发送到聊天：

```powershell
$env:CONTROL_PLANE_TUNNEL_ID = 'tunnel_从 Platform 复制的 ID'
$key = Read-Host 'Runtime API key（输入隐藏）' -AsSecureString
$env:CONTROL_PLANE_API_KEY = [System.Net.NetworkCredential]::new('', $key).Password
Remove-Variable key
npm run chatgpt:local
```

启动器会先构建本地控制台，再启动 daemon；随后用同一组参数执行 `tunnel-client doctor`，通过后以前台方式启动隧道。若隧道子进程意外退出，启动器在原 daemon 内按 1、2、5、10、30、60 秒（封顶）退避，再运行 doctor；doctor 通过才重新启动隧道，doctor 失败则停止并要求操作者处理，避免凭据错误时无限空转。恢复过程中不会重建 daemon 或写执行器。runtime key 只在 tunnel-client 所需的环境里；它启动 MCP 子进程时，薄启动入口会先移除 runtime key、`OPENAI_API_KEY` 和 tunnel ID，再加载适配器。daemon 只向 tunnel-client 提供 MCP adapter 专属 IPC 凭据，不提供控制台 audience 凭据；秘密不进入命令行、配置文件或启动日志。Ctrl+C 用于结束前台隧道与本地服务。

也可从另一个 PowerShell 窗口请求停止 LocalWebGPT：源码目录运行 `.\packaging\windows\Stop-LocalWebGPT.ps1`，打包 runtime 根目录运行 `.\Stop-LocalWebGPT.ps1`。命令向本机控制管道发送固定停止请求，不按进程名或 PID 终止；服务会拒绝新操作、等在途处理器结束后关闭。若恰好在工具调用中停止，ChatGPT 可能收不到该次回执；重连后用 `change_get` 核对状态，不能盲目重复应用。Windows 下 Node 会强制终止本启动器自己创建的 tunnel-client 子进程，daemon 仍会等待已进入的操作结束后再关闭状态库。

daemon 启动后，从一次性本地控制台链接进入 **ChatGPT 连接** 页，选中“我确认……”并点击“在本机启用 ChatGPT 连接”；这一步只启用模型侧连接，不创建工作区授权。

**顺序不能交换：先本机启用，再在 ChatGPT 点 Create。** ChatGPT 创建 MCP App 时会立即请求 `tools/list`；本项目把工具目录也放在连接启用守卫之后。新装默认停用时，ChatGPT 会收到 `CONNECTION_DISABLED` 并创建失败。启用后，ChatGPT 可发现工具；实际工作区操作仍须获得本地逐工作区授权。

如果检查失败，先按 `doctor` 诊断处理，不要继续在 ChatGPT 侧创建应用。进程重启或更换 PowerShell 会话后，重新设置环境变量。结束后可清除当前会话变量：

```powershell
Remove-Item Env:CONTROL_PLANE_API_KEY, Env:CONTROL_PLANE_TUNNEL_ID -ErrorAction SilentlyContinue
```

### 在 ChatGPT 添加应用

先在本机控制台完成连接确认，并等待上一阶段的 `tunnel-client` doctor 通过、隧道处于运行状态。然后在 ChatGPT 开启 Developer mode，进入 Plugins，点加号新建开发者模式应用；Connection 选择 **Tunnel**，选中刚创建的隧道（或输入其 `tunnel_id`）。本项目没有 OAuth 授权服务器，因此 Authentication 选 **No authentication / None**；Tunnel runtime key 只给本地 `tunnel-client`，不要填进 OAuth 设置。创建后核对发现的工具。新开对话，从工具菜单添加该应用，再发起工具调用。若隧道列表为空，先检查它是否关联到目标 ChatGPT 工作区以及创建者是否有 Tunnels Read + Use。

传输连通只证明 ChatGPT 能到达 MCP 服务，不等于有工作区读写权限。在本地控制台为专用测试目录授予读取和“文件修改”工具后，验证“读取 → 单文件创建/编辑 → 回读”。获授目录中的写操作不再逐次等待批准，但仍检查路径、冲突、快照、审计和受保护执行器。模型拿到的具体工具结果会发送到 ChatGPT；工作区本身不会被整体上传。

## B. 本机恢复快照导出（与 ChatGPT 无关）

此验收只验证恢复页通过本地控制 API 取回受保护快照，并由浏览器写到操作者选择的新文件。它不启动 tunnel-client、不创建 ChatGPT 应用，也不把快照发送给 ChatGPT。

```powershell
npm run acceptance:lwb037-export
```

1. 打开终端打印的一次性控制台地址；地址含一次性令牌，不要粘贴到聊天或截图。
2. 进入“恢复与冲突”，确认临时记录显示 `THIRD_CONTENT`，即当前文件是第三方修改。
3. 勾选确认，分别测试“导出原版本快照”和“导出提议版本快照”，每次都选一个不存在的新 `.snapshot` 文件。
4. 对照页面给出的 SHA-256 和字节数；本夹具内容应分别是 `Acceptance fixture: original bytes` 与 `Acceptance fixture: proposed bytes`。
5. 再选一个已存在的目标文件，导出应取消且原文件字节不变。完成后在启动夹具的终端按 Ctrl+C；临时服务与临时测试目录会被清理。

该命令不是 ChatGPT 接入验收。若夹具已经在运行，不要启动第二份；使用原终端打印的一次性链接并在原终端结束它。

## 官方依据

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
