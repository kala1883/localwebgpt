# LWB-002 · 平台能力核实（Secure MCP Tunnel）— 证据与阻塞点

**初次采集状态（2026-09-26）：BLOCKED。**
**当前状态（2026-09-28）：PARTIAL，见 §12。** 工具刷新与命令工具的真实网页调用已通过；任务书要求的真实文件读—写—回读仍未完成。
**初次采集日期：** 2026-09-26
**采集环境：** Windows 11 Home China 10.0.26200（**未提权**）/ 真实网络
**本文件不含任何凭证。** 下文出现的唯一一个「像密钥」的字符串是配置文件里的
**环境变量引用**（`env:CONTROL_PLANE_API_KEY`），不是密钥本身。

---

## 1. 任务书对这一项的要求（逐字）

`docs/LWB_TASKS.json` 的 LWB-002：

> **执行步骤 2：** 核实 tunnel-client 在目标 Windows 环境的受支持运行方式；
> 按官方当前说明安装，**不自行猜测命令参数**。
>
> **验收：** 真实网页账号完成可复现的读—写—回读；**MCP Inspector 成功不能代替网页验收**；
> 无法确定单用户访问边界时不得授权真实目录；
> 账号不支持写入或隧道不可用时**明确 BLOCKED**，不能把写工具伪装成只读绕过限制。

两句话定了这份文件的形状：**(a)** 安装方式必须来自官方说明，不能猜；
**(b)** 判定只有「真实网页跑通」与「明确 BLOCKED」两种，没有中间态。

---

## 2. 官方说明是怎么取回来的（含一处工具侧限制）

`WebFetch` 对 `developers.openai.com` 与 `platform.openai.com` 报
「Unable to verify if domain … is safe to fetch」—— 这是**工具侧的域名安全校验**，
不是网络不通。`WebSearch` 在本环境同样不可用。**`curl` 两条都能取到**，
因此下面所有官方原文都是 `curl` 取回的，不是凭记忆写的。

```
$ curl -sS -o /tmp/tunnel-guide.html -w "HTTP=%{http_code} SIZE=%{size_download} URL=%{url_effective}\n" \
    "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels"
HTTP=200 SIZE=405640 URL=https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
CURL_EXIT=0

$ curl -sS -o /tmp/tc-release.json -w "HTTP=%{http_code} SIZE=%{size_download}\n" \
    "https://api.github.com/repos/openai/tunnel-client/releases/tags/v0.0.15"
HTTP=200 SIZE=137448
CURL2_EXIT=0
```

**这条限制本身值得记在证据里**：它意味着本仓库的自动化流程**不能在无人值守时**
自行核对官方文档。任何一次「按官方说明」的动作都必须是有人在环的 —— 这与任务书
「不自行猜测命令参数」的要求方向一致。

---

## 3. 官方安装与运行命令（**逐字**摘自官方指南的代码块）

```
export CONTROL_PLANE_API_KEY="sk-..."

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile local-stdio \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --mcp-command "python /path/to/server.py"

tunnel-client doctor --profile local-stdio --explain
tunnel-client run --profile local-stdio
```

官方指南里另有两处与运行方式有关、且**与默认假设不同**的说明，逐字摘录：

```
--mcp-server-url https://mcp.internal.example.com/mcp
```
```
tunnel-client doctor --profile <profile> --explain
```

以及出站目标（用于兼容矩阵）：

```
api.openai.com:443
mtls.api.openai.com:443
```

### 3.1 一处**必须按官方说明才能知道**的差别：`--profile` 收名字，不收路径

实测发现的（**不是猜的**，是官方 CLI 自己拒绝的）：

```
$ tunnel-client doctor --profile profiles/lwb-local.yaml --explain
CHECK config_source   FAIL invalid profile name "profiles/lwb-local.yaml": path separators are not allowed
```

`profiles list` 给出了目录：

```
$ tunnel-client profiles list
No profiles found in C:\Users\mj\.config\tunnel-client
```

`profiles --help` 给出了官方的第二条路：

```
Flags:
      --profile-dir string   Profile directory override
```

而 `doctor --help` 里 `--config` 的原文是：

```
--config string   Path to YAML config file (env.TUNNEL_CLIENT_CONFIG). Precedence: flags > environment > YAML > defaults
```

**两条路的区别是官方的，不是本仓库的**：`--profile <name>` 按**名字**在
profile 目录里找（默认 `%USERPROFILE%\.config\tunnel-client`），
`--config <path>` 收**路径**。把前者当后者用会被当场拒绝，
而报错信息（`path separators are not allowed`）说清了自己要什么 ——
这正是「不自行猜测命令参数」这条要求想防的那种错误。

本仓库用的是 **`--config <path>`** 那条，因为配置文件按仓库布局放在
`.lwb-local/tunnel-client/v0.0.15/profiles/lwb-local.yaml`（`.lwb-local/` 在 `.gitignore` 里）。

---

## 4. 本机实际做了什么（每一条都有退出码）

### 4.1 下载与校验

```
$ sha256sum tunnel-client-v0.0.15-windows-amd64.zip
3b53133a1e24d43f63088d843860cb1701a4c3ed6390de2e19f69089e43bddc1 *tunnel-client-v0.0.15-windows-amd64.zip

$ grep "windows-amd64.zip" SHA256SUMS.txt
b3ae67ede4db56a8ba18b4b4f1fa8fb0e18f7823ecf2bd266a1ad0dc3c8ac5b6  tunnel-client-runtime-cloudflared-v0.0.15-windows-amd64.zip
aa5ddb14dddd602fa59f3e6f4401aa8a79a218e341466226b7434127dff65dbc  tunnel-client-runtime-v0.0.15-windows-amd64.zip
3b53133a1e24d43f63088d843860cb1701a4c3ed6390de2e19f69089e43bddc1  tunnel-client-v0.0.15-windows-amd64.zip
```

**校验通过**：下载物的 SHA-256 与官方 `SHA256SUMS.txt` 中同名条目的哈希**逐字符相同**。
校验和文件本身是随 release 一起取回的，因此这一步比的是两个独立来源。

解压后 `bin/` 的内容（大小以字节计）：

| 文件 | 字节 |
| --- | --- |
| `tunnel-client.exe` | 22 523 904 |
| `cloudflared.exe` | 39 751 680 |
| `LICENSE` / `NOTICE` | 10 758 / 551 |
| `cloudflared-manifest.json` | 1 038 |
| `tunnel-client-v0.0.15-windows-amd64.spdx.json` | 234 305 |
| `tunnel-client-v0.0.15-windows-amd64-licenses.txt` | 13 456 |

`bin/tunnel-client.exe` 自身的 SHA-256（供日后比对，官方 `SHA256SUMS.txt` 只列 zip，不列解压产物）：

```
$ sha256sum bin/tunnel-client.exe
1946de55a038313a9b9b2458d05fe1719fa9cf1f20a94dd5f38fc26a98bfdd42 *bin/tunnel-client.exe
```

### 4.2 能不能跑

```
$ tunnel-client.exe --version
0.0.15+a390c168ff1b2d14e73a95991c186c6aba3ff5a0 (git sha: a390c168ff1b2d14e73a95991c186c6aba3ff5a0)
VERSION_EXIT=0
```

已跑通、退出码均为 0 的子命令：`help quickstart`、`profiles samples show sample_mcp_stdio_local`、
`init`、`profiles list`、`doctor`、`doctor --explain`。

### 4.3 `doctor` 的结果（**这是本项的阻塞点**）

```
$ tunnel-client.exe doctor --config profiles/lwb-local.yaml --explain
CHECK config_source            PASS profiles/lwb-local.yaml
CHECK profile_load             PASS profiles/lwb-local.yaml
CHECK control_plane_api_key    FAIL parse config file profiles/lwb-local.yaml: invalid control_plane.api_key reference "env:CONTROL_PLANE_API_KEY": environment variable "CONTROL_PLANE_API_KEY" is not set
CHECK tunnels_management_url   PASS https://platform.openai.com/settings/organization/tunnels
CHECK runtime_api_keys_url     PASS https://platform.openai.com/settings/organization/api-keys
CHECK admin_api_keys_url       PASS https://platform.openai.com/settings/organization/admin-keys
CHECK chatgpt_connector_settings_url PASS https://chatgpt.com/#settings/Connectors
CHECK codex_plugin             SKIP Codex detected; Tunnel MCP plugin not installed (run `tunnel-client codex plugin install`)

RESULT fail
FAILED_CHECKS control_plane_api_key
EXIT_CODE 2
```

**除 `control_plane_api_key` 外全部 PASS。** `codex_plugin` 是 SKIP 而不是 FAIL ——
它是可选的 Codex 集成，与本项目的 MCP 通道无关。

`--explain` 里那一段「What to do next」直接给出了官方要求的下一步与地址（逐字）：

```
CHECK control_plane_api_key   FAIL
Why this matters:
  tunnel-client cannot poll the control plane or complete tunnel registration without this key.

What to do next:
  1. create or inspect the runtime key in https://platform.openai.com/settings/organization/api-keys
  2. export CONTROL_PLANE_API_KEY=...
  3. if your tunnel key already lives in another environment variable, map it with `export CONTROL_PLANE_API_KEY=$YOUR_EXISTING_TUNNEL_KEY_ENV`
  4. if you also need admin CRUD, create a separate admin key in https://platform.openai.com/settings/organization/admin-keys
  5. rerun: tunnel-client doctor
  6. if it passes, run: tunnel-client run --config profiles/lwb-local.yaml
```

**那五条就是本项的阻塞清单**，且它们全部要求账号持有人本人在浏览器里操作。

---

## 5. 官方对权限的要求（**逐字**摘自官方指南）

这一节是 LWB-002 验收里「无法确定单用户访问边界时不得授权真实目录」那句话的判据来源。
官方把两类权限**明确分开**：

```
Platform tunnel permissions and ChatGPT developer-mode access are separate:
```
```
Creating or editing a tunnel requires Tunnels Read + Manage.
```
```
Running tunnel-client or selecting the tunnel while creating an app requires Tunnels Read + Use.
```
```
ChatGPT developer mode is a separate workspace permission. For Enterprise/Edu, a workspace admin grants developer-mode access; the user then enables it in Settings → Security and login.
```
```
Ask the target ChatGPT workspace admin for developer-mode access, and ask the target Platform organization owner/RBAC admin for tunnel permissions.
```
```
If the tunnel does not appear in ChatGPT, verify that the tunnel is associated with the target ChatGPT workspace, not only with a Platform organization, and that the app creator has Tunnels Read + Use.
```

两条结论，对本项目的威胁模型**直接相关**：

1. **权限是组织级的，不是项目级的。** 官方原文：
   「Tunnel permissions are organization-level, not project-level.」
   因此「单用户访问边界」这件事**不是本仓库能自行决定的** —— 它取决于那个
   ChatGPT 工作区里有几个人、以及他们各自被授予了什么角色。
2. **tunnel 必须关联到目标 ChatGPT 工作区**，只关联 Platform 组织是不够的。
   关联错了的表现是「tunnel 在 ChatGPT 里根本不出现」，而不是一条报错。

**这也解释了为什么本项是 BLOCKED 而不是 PARTIAL**：任务书要求
「无法确定单用户访问边界时不得授权真实目录」，而**「工作区里有几个人、谁有 Tunnels Use」
这件事本机看不到** —— 它只存在于操作者的账号设置里。

---

## 6. 本机配置文件的内容（无凭证）

`.lwb-local/tunnel-client/v0.0.15/profiles/lwb-local.yaml`：

```yaml
config_version: 1
control_plane:
  base_url: "https://api.openai.com"

  tunnel_id: "tunnel_00000000000000000000000000000000"
  api_key: "env:CONTROL_PLANE_API_KEY"
health:
  # Keep a fixed port when you want a stable local admin URL.
  # For concurrent or clean-room runs, switch listen_addr to "127.0.0.1:0" and
  # set url_file so another process can discover the resolved /healthz, /readyz,
  # /metrics, and /ui base URL.
  listen_addr: "127.0.0.1:8080"
  # url_file: "/tmp/tunnel-client-health.url"
admin_ui:
  open_browser: false
log:
  level: info
  format: json
mcp:
  commands:
    - channel: main
      command: "node --version"
```

（上面是文件的**逐字**内容，含注释。空行与注释来自 `tunnel-client init` 的模板。）

两处占位符都是**刻意的**，且都在文件里写明了：

- `tunnel_id` 是 32 个零。真的 id 只能由操作者在 Platform 上创建后得到。
- `api_key` 用的是官方的 `env:VARNAME` 引用形式，**密钥本身不落盘**
  （`doctor` 的报错信息里也只出现变量名，不出现值）。
- `mcp.commands[0].command` 是 `node --version`：一个**明确无害**的占位符，
  用来在不接任何东西的前提下让 `doctor` 能把配置整体验一遍。

---

## 7. 仍未做的（不得读成通过）

```
NOT_RUN 真实网页账号完成可复现的读—写—回读 — 没有 tunnel_id，没有 runtime key，隧道未启动过
NOT_RUN tunnel-client run 成功启动一次 — 门禁是 doctor 全绿，而它当前的 RESULT 是 fail
NOT_RUN 确定单用户访问边界（工作区里有几个人、谁有 Tunnels Use） — 只存在于操作者的账号设置里
NOT_RUN MCP Adapter 作为 mcp.commands 的子进程被拉起 — 见 §7.2
```

### 7.1 为什么不是 PARTIAL

`PARTIAL` 会让人读成「做了一半，剩下的一半是工程」。
本项的剩下部分**一件都不是工程**：创建 tunnel、创建 runtime key、授权、
开启 developer mode —— 四件事全部要求**账号持有人本人在浏览器里**操作。
本机这边能做的已经做完了，因此状态是 **BLOCKED**，且阻塞点已经被收窄成一句可执行的话
（§8）。

### 7.2 一个已知的、尚未解决的设计问题：适配器怎么被拉起

`mcp.commands[0].command` 是一个**命令行字符串**，而本仓库的 MCP Adapter 需要
三样东西才能启动：`LWB_IPC_SECRET`、连接 id、命名管道名。把它们写进命令行字符串
意味着**密钥出现在进程命令行里**（在 Windows 上任何同用户进程都能读到），
这与「凭证不得出现在日志、证据或诊断输出里」这条约束直接冲突。

官方的示例用的是 `--mcp-command "python /path/to/server.py"`，即命令字符串这一条路。
因此在配置文件里裸写适配器命令**不是**一个可接受的方案。

已知的可行方向是**启动器**（`packaging/launcher/`，任务书 LWB-039）：
配置文件里写的是启动器的路径，由启动器读出 DPAPI 里那份 `ipc` 凭证、
把它**只放进子进程的环境**（不放命令行、不落日志），再 exec 适配器。
这条路径**尚未交付**，本节把它写下来是为了让「为什么现在还不能接上」有一个具名的原因，
而不是等到联调那天才发现。

---

## 8. 只有操作者能做的事（本项的全部剩余工作）

按官方 `doctor --explain` 给出的顺序整理；每条都标了它对应的官方原文。

| # | 动作 | 官方依据 |
| --- | --- | --- |
| 1 | 在 **Platform → Tunnels** 创建 tunnel，拿到 `tunnel_id` | `CHECK tunnels_management_url PASS https://platform.openai.com/settings/organization/tunnels` |
| 2 | 在 **Platform → API keys** 创建 runtime key，并授予 **Tunnels Read + Use** | 「Running tunnel-client or selecting the tunnel while creating an app requires Tunnels Read + Use.」 |
| 3 | 把该 tunnel **关联到目标 ChatGPT 工作区**（不只是 Platform 组织） | 「verify that the tunnel is associated with the target ChatGPT workspace, not only with a Platform organization」 |
| 4 | 取得 **ChatGPT developer mode** 权限（工作区管理员授予），然后在 **Settings → Security and login** 里自行开启 | 「ChatGPT developer mode is a separate workspace permission.」 |
| 5 | 在 **ChatGPT → Plugins** 用加号建一个 developer-mode 应用，Connection 选 **Tunnel**，选中该 tunnel | 「Go to ChatGPT Plugins, select the plus button to create a developer-mode app, and choose Tunnel under Connection.」 |

第 1、2 条的产物（`tunnel_id` 与 key）**只经由环境变量交给本仓库**，
不写入任何文件、不粘贴进证据：

```
# 操作者在自己终端里（Windows）：
$env:CONTROL_PLANE_API_KEY = "<runtime key>"
```

第 3 条里那句「工作区里有几个人、谁有 Tunnels Use」是本项目**单用户前提**的判据来源。
在它被确认之前，按任务书原文：**不得授权真实目录**。

---

## 9. 结论

- **LWB-002：BLOCKED。** 阻塞点已从「不知道怎么装」收窄成
  **「两个只有账号持有人能创建的凭据 + 两项只有管理员能授予的权限」**（§8 的五条）。
- **本机侧能做的已经做完且都有退出码**：官方文档与 release 元数据取回（`curl`，HTTP 200）、
  下载物按官方 `SHA256SUMS.txt` 校验通过、解压、`--version` 报出带 git sha 的版本、
  五个子命令运行成功、`doctor` 除 API key 外全绿。
- **`MCP Inspector 成功不能代替网页验收`**：本文件里没有任何一条断言涉及真实网页 ——
  一次都没有连上过隧道。隧道的**服务端**（Platform 上的那个 tunnel）今天不存在。
- **不得把写工具伪装成只读绕过限制**：本仓库的四个能力开关仍然全关，
  `change_apply` / `change_revert_prepare` **不在工具面上**（`IMPLEMENTED_TOOL_NAMES` 10 条）。
  这条约束在本项 BLOCKED 期间由 LWB-025 的证据 4.3 逐条钉住。

---

## 10. 2026-09-27 补记：本机启动链已接线，账号侧仍 BLOCKED

本文件 §7.2 的“适配器怎么被拉起尚未交付”是 **2026-09-26 采集时的结论**。本轮加入了有限的本机前台启动链：

- `npm run chatgpt:local` 构建同源控制台、启动 daemon、用实际 MCP stdio 命令运行 `tunnel-client doctor`，通过后以前台方式运行 Secure MCP Tunnel。
- CLI 参数按本机安装的 tunnel-client v0.0.15 `run --help` / `doctor --help` 核对；不依赖 `.lwb-local` 中尚为占位的 `tunnel_id` 与 `node --version` profile。runtime key 仅通过 `env:CONTROL_PLANE_API_KEY` 引用，不进入 argv 或配置文件。
- daemon 向 tunnel-client 提供的本地 IPC 变量只有 `mcp-adapter` audience；其 stdio 启动入口在导入适配器模块前清除继承来的 `CONTROL_PLANE_API_KEY`、`OPENAI_API_KEY` 与 `CONTROL_PLANE_TUNNEL_ID`。
- `npm run chatgpt:local` 的 Vite 构建通过；当前 PowerShell 会话缺少 tunnel_id/runtime key，启动器明确退出且**未启动 daemon 或 tunnel-client**。纯参数与环境清理单元测试 **3/3 PASS**。daemon runtime 的 Windows 子进程环境断言因本用户已有验收 daemon 占用单实例管道而跳过。

因此这项改动**不改变 LWB-002 状态**：尚无 tunnel_id/runtime key、平台权限和 ChatGPT 工作区授权，也没有一次真实 tunnel run 或 ChatGPT 网页调用。代码启动入口已在，账号凭据、MCP 子进程实跑、网页工具发现、读—本地批准写—回读都仍须以后续人在环证据验证。操作步骤见 `docs/chatgpt-tunnel-acceptance.md`。

## 11. 2026-09-27 ChatGPT Create 返回 424 的实机定位

- 用户提供的浏览器错误为 HTTP `424 Failed Dependency`，内层 JSON-RPC `-32603`（本地工具清单不可用）。附件终端日志已脱敏；本文不保存 tunnel ID、runtime key、一次性控制台 URL 或 token。
- 同一日志中 `tunnel-client doctor` 为 `RESULT ok`，但 `mcp_server_reachable` 对 stdio 目标标为 `SKIP`；随后 ChatGPT 的工具清单请求触发适配器日志 `tools/list 失败：工具清单被本机拒绝：CONNECTION_DISABLED`。因此网络/Tunnel 已连通，失败不是公网或 key。
- 根因：`ensureAdapterConnection` 新建模型连接为 `enabled=false`；`tools.catalog` 经 `withToolGuard` → `resolveConnection` 检查后拒绝。适配器把拒绝收敛成安全的通用 MCP `-32603`，故网页没有暴露本地拒绝码。
- 修复：ConsoleHost 增加“ChatGPT 连接”页，通过本地会话、CSRF 和一次性 nonce 调用现有 `connections.resume/pause`；启用需本机确认并审计，不会更改任何 workspace grants 或 G0/能力门禁。适配器未实现 OAuth，因此开发模式 Tunnel 连接使用 No authentication / None；此设置不等于放行文件访问。
- 验证：ConnectionView UI 测试 **2/2 PASS**、控制台 Vite 构建通过，根与控制台类型检查及静态导入检查通过。尚未重启用户的真实 tunnel 进程或再次点击 ChatGPT Create；下一步由用户在重启后打开本机控制台、启用连接，再重试发现工具。文件读写验收仍 NOT_RUN，G0 仍关闭。

## 12. 2026-09-28 Manage Refresh tools 与命令工具真实网页调用

- 在现有 Local Workspace Bridge Manage 页底部执行 **Refresh tools**，不更改 ChatGPT 的工具权限级别、本机连接状态或任何 workspace grant。操作者随后确认新工具出现；本次也从插件页打开 Temporary chat，composer 中明确附带 `@Local Workspace Bridge`。
- 实际 ChatGPT 工具回执：`workspace_list` 找到启用的 `maas_business`；随后 `command_exec` 使用 `powershell` 执行仅向 stdout 输出标记的 `Write-Output 'LWB_COMMAND_OK'`，返回 `exit_code=0`、`timed_out=false`、`output_truncated=false`、stdout=`LWB_COMMAND_OK`。该命令不读、创建、编辑或删除文件。当前 Console 仍显示只有 `maas_business` 有独立 `command_exec` grant；`本项目目录` 没有该 grant。
- 同一条用户请求只要求一次 `workspace_list` 与一次 `command_exec`，但本机只读审计查询在 `2026-09-28T09:18:03Z` 至 `09:18:15Z` 发现了四个不同请求：`req_49`/`req_50` 为两次获准的 `workspace_list`，`req_51`/`req_52` 为两次获准的 `command_exec`。因此“新工具能被发现和执行”通过，但该回合实际发生重复工具调用；审计不存命令正文/逐次 stdout，无法仅凭审计证明两个命令参数完全相同。两个请求的会话回执均未显示文件操作；重复调用行为列为待关注，不把模型最终摘要中的“两种工具”误读成“总共只调用两次”。
- 本次只验证了工具元数据刷新、`workspace_list` 和授权工作区上的无文件副作用 `command_exec` smoke。没有进行真实文件写入、回读、冲突、断连/重连或恢复测试；单用户/工作区成员边界也没有重新核验。因此 LWB-002 与 LWB-041 继续 **PARTIAL**，不把 command smoke 扩写成完整读—写—回读验收。

## 13. 2026-09-28 Temporary Chat 中的文件工具验收

- Manage 页刷新工具后，在新的 Temporary Chat 中实际调用 `workspace_list`、`file_create`、`file_read`、`file_edit`、`file_read`。`workspace_list` 返回启用的 `maas_business`（`ws_2db8a9f54fe181181d70d0ba87ab056a`），其 `read_enabled=true`、`proposal_enabled=true`、`direct_write_enabled=true`、`recovery_required=false`。`workspace_list` 不返回逐工具 grant 清单；以下实际工具回执才是逐项能力的证据。
- 仅在 `maas_business` 根创建唯一测试文件 `LWB_ACCEPTANCE_20260928_7F3A9C.txt`，内容为 `LWB_ACCEPTANCE_CREATED_V1`（UTF-8、无 BOM、无末尾换行）。`file_create` 返回 `state=APPLIED`、`in_progress=false`、逐文件 `VERIFIED`；基线哈希为空，目标 SHA-256 为 `794531e6354024957c29e92594fac05a4e344c0bce93f527584bf8535a7f9d18`。回读来源是磁盘，`truncated=false`、`redacted=false`、`editable=true`，返回内容和 SHA 与创建回执一致。
- 随后用该次 `file_read` 签发的读取票据与基线 SHA，将第 1 行从 `LWB_ACCEPTANCE_CREATED_V1` 精确改为 `LWB_ACCEPTANCE_EDITED_V2`。`file_edit` 返回 `state=APPLIED`、`in_progress=false`、逐文件 `VERIFIED`；回执前后 SHA 分别为 `794531e6354024957c29e92594fac05a4e344c0bce93f527584bf8535a7f9d18` 与 `67cca070f5b4edfc7c0247138a1923ea9d86a4fd737282a60c20acb066b55390`。第二次 `file_read` 从同一磁盘路径回读 `LWB_ACCEPTANCE_EDITED_V2`，SHA 与 edit 回执一致，`truncated=false`、`redacted=false`。
- 这是指定小文件的真实网页读—写—回读 PASS，不代表多文件冲突、断连/重连、拒绝路径、命令失败或恢复矩阵通过。MCP 回执中的 `tests_run=false` 仅表示工具没有运行项目测试；文件写入结果本身已由 `APPLIED`、`VERIFIED` 和两次磁盘回读确认。没有读取或改动其他业务文件，也未记入读取票据值。测试文件目前仍存在；等待用户对删除此专用测试文件的 action-time 确认后，再补记删除验收结果。
- 本节补充并更新 §12 的早期状态：Manage 刷新后的 `file_create`、`file_read`、`file_edit` 能力已在 ChatGPT 网页真实调用，不再是 NOT_RUN。LWB-002 / LWB-041 仍 **PARTIAL**，尚有其余验收矩阵。
