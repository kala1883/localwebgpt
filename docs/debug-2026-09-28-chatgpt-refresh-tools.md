# 2026-09-28：ChatGPT 工具元数据不同步排查记录

## 结论与适用范围

本次 LocalWebGPT 已实现 `command_exec` 及单文件修改工具，但 ChatGPT 会话曾只获得旧工具目录和旧描述。操作者在该 MCP 连接的 **Manage 页面滚动到最底部，点击 Refresh tools** 后，管理页出现新增工具；随后会话发现 16 个工具，并通过本地 `command_exec` 在目标工作区完成真实命令验证。

**直接故障归类：连接／会话所用的 MCP 工具元数据没有及时更新，不是模型训练知识过时，也不是项目没有实现命令执行。** 现有证据未唯一定位 ChatGPT 内部的连接缓存、动作同步或会话装载层，不将某一内部缓存机制写成已经证实的根因。

本记录依据 2026-09-28 的项目协作会话、操作者提供的启动日志和诊断 JSON、桥接工具读取源码的结果及真实命令回执整理。下文区分现场事实、代码推导、被纠正的假设和未验证事项；不复制密钥、一次性控制台链接或本机个人目录。

日常操作入口见根目录 [启动命令.md](../启动命令.md)。本记录适用于当次 Developer mode / Secure MCP Tunnel 连接，不泛化为所有发布模式的更新流程。

## 1. 初始现象

目标是在 `maas_business` 所对应的 `business_service` 目录执行命令。连接可以读取文件和查询 Git 状态，但会话最初没有 `command_exec`。

排查期间会话侧曾分别获得 12、9、12 个工具，最终恢复为 16 个。这里的数量来自向会话提供的可调用工具发现结果，**不是每一次本地 MCP 原始 `tools/list` 响应的抓包结果**，不能直接当成服务器始终只挂出这些工具。

旧 12 个工具集合缺少：

```text
file_create
file_edit
file_delete
command_exec
```

同时，旧的 `change_apply` 描述仍要求每次先取得本地操作者批准；磁盘上的新版契约已改为在工作区拥有文件修改授权时应用，无需逐次本机批准。故障不仅是缺少工具名，也包含工具定义版本不一致。

## 2. 排查过程与证据

### 2.1 先确认实现存在，而不是根据会话清单推断未开发

实际读取的关键实现位置：

| 层级 | 源码 | 当次确认内容 |
| --- | --- | --- |
| 工具契约 | `packages/contracts/src/tools.ts` | 包含 `command_exec`、输入 Schema、描述与风险标记 |
| 可见性过滤 | `apps/daemon/src/tools/catalog.ts` | 命令工具要求独立的 `command_exec` grant、可写目录工作区 |
| 处理器 | `apps/daemon/src/tools/handlers.ts` 中 `commandExecTool()` | 授权检查、调用命令进程管理器、运行期间复核撤权和暂停 |
| 进程执行 | `apps/daemon/src/lifecycle/command-processes.ts` | 使用 `spawn()` 启动 shell，不是模拟返回 |
| 运行时装配 | `apps/daemon/src/runtime/assembly.ts` | 创建并注入 `CommandProcessManager` |
| MCP 定义构造 | `apps/mcp-adapter/src/surface.ts` | 从 `TOOLS_BY_NAME` 获取契约，构造返回的工具名称、描述和 Schema |

结论：代码中已经存在真实的命令执行实现。不能由“当前会话没有该工具”推导“项目没有开发该功能”。这些源码证据当时尚不能替代真实连接调用验收。

### 2.2 纠正过期进程判断

`docs/PROGRESS.md` 曾记录旧 `feat/lwb-p0-p2` daemon 未退出、尚不支持新版停止协议的历史现场。排查中一度将其作为当前故障的主要解释。

操作者随后明确纠正：旧进程已经停止，旧分支已删除，当前从 `main` 的 LocalWebGPT 项目目录启动。提供的启动日志包含当前启动流程、控制台构建、daemon 装配和 Tunnel doctor 结果。后续排查采用该更新事实，不再要求重复停止旧分支进程。

历史进度记录不应删除或篡改为“从未发生”，但也不能继续充当当前进程状态。本记录更新的是本次故障状态，不宣称仅凭 `server_version=0.1.0` 就能证明某个 Git 提交已在运行。

启动日志的“工具面 17 个”也经源码核对：`apps/daemon/src/tools/operations.ts` 返回 `IMPLEMENTED_TOOL_NAMES` 加内部 `tools.catalog`，因此当时为 **16 个工具处理器 + 1 个内部清单操作**。这是内部注册数量，不是 ChatGPT 已启用的 17 个工具。

### 2.3 权限与工具定义不能混为一谈

连接级状态中 `direct_write_enabled=true`，不能证明某个目录已授予 `command_exec`。同样，授权行数量不能说明每行具体包含哪些 grant。

排查中曾读取到默认低风险权限；之后按操作者指定插件的准确 ID 查询，插件自身权限明确为 **Allow all actions**。因此，“插件仅允许低风险动作”不再是当时缺少新工具的解释。这个设置不替代本地目录 grant，也不能刷新已经发现的工具定义。

当时 `workspace_list` 的摘要未提供独立命令 grant 的实际值，因此没有凭摘要直接断言操作者漏勾命令权限。

### 2.4 找到源码规则与旧会话集合的矛盾

当前 `catalog.ts` 中，下列工具依赖相同的 `propose` grant：

```text
change_prepare
file_create
file_delete
change_apply
change_revert_prepare
```

旧会话能看到 `change_prepare`、`change_apply` 和 `change_revert_prepare`，却看不到 `file_create`、`file_delete`。仅由当次读取的同一份授权过滤代码，不能产生这种组合。单独漏授 `command_exec` 也无法解释它。

此外，授权过滤只决定工具是否出现，不会将契约中的新版描述改回旧审批文案。

因此，可以确定“本轮磁盘契约与会话获得的定义不一致”，但在取得中间交互证据前，不能直接断言是某一个缓存层，也不能反过来否认操作者已启动新版的事实。

### 2.5 沿工具发现链路检查，而不是只看启动成功

```text
ChatGPT 工具发现请求
  → Tunnel
  → 本机 tunnel-client
  → MCP adapter 的 tools/list
  → daemon 的 tools.catalog 按 grant 计算可见工具
  → adapter 从 @lwb/contracts 构造名称、描述和 Schema
  → tunnel-client 接收并回传响应
  → ChatGPT 管理页工具元数据
  → 会话可调用工具
  → 实际 tools/call 与回执
```

项目 adapter 在 `apps/mcp-adapter/src/server.ts` 中记录 `tools/list：挂出 N 个工具（名称……）`。诊断应比较各层的当前结果；源码存在、daemon 已启动、文件读取成功，只能证明链路的部分环节，不能证明此次工具发现已完整更新。

## 3. 诊断快照：记录了什么，没有证明什么

操作者通过本机只读 HTTP 请求取得刷新前后快照，读取接口为：

```text
GET http://127.0.0.1:8080/health
GET http://127.0.0.1:8080/health/mcp
GET http://127.0.0.1:8080/health/response-delivery
```

当次响应中 runtime 版本为 `0.0.15+a390c168ff1b2d14e73a95991c186c6aba3ff5a0`。下列时间保留日志原始 UTC 表示，不混用本地时区。

| 字段 | before | after |
| --- | --- | --- |
| 快照采集时间 | `2026-09-28T09:09:39.7783482Z` | `2026-09-28T09:10:17.8118618Z` |
| runtime instance | 同一个实例 | 未变 |
| MCP child generation | 同一个子进程代次 | 未变 |
| `initialize_epoch` | `24` | `24` |
| 初始化观测时间 | `2026-09-28T09:04:35.7468176Z` | 未变 |
| 初始化结果 | `ok=true`，服务名 `local-workspace-bridge` | 未变 |
| `tools_list.ok` | `false` | `false` |
| `tools_list.tool_names` | `[]` | `[]` |
| `tools_list.complete` | `false` | `false` |
| `tools_list.partial / limited` | 均为 `false` | 未变 |
| 响应交付 attempts / accepted / completed | `71 / 71 / 71` | 未变 |
| 响应交付 retries / terminal_failures | `0 / 0` | 未变 |

随后操作者确认管理页确实出现新增工具，会话也实际发现并调用成功。因此，这组快照**没有捕获到可用于证明该次管理页更新的工具清单变化**。

不得从这组数据推出以下结论：

- `ok=false`、空数组且 `complete=false`，不等于服务器成功返回零个工具。
- 快照没有变化，不等于操作者未执行 Refresh tools，也不等于管理页更新失败。
- 组件级累计响应成功数不是某一条 `tools/list` 的端到端关联证明。
- 接口名叫 `/health/mcp`，不代表已经验证它能完整覆盖每一次管理页刷新路径。

当时未继续定位该诊断快照为何未覆盖此次变化；这属于观测范围的待验证问题，不应妨碍已取得的真实调用证据。

## 4. 最终操作与真实验收

### 4.1 准确的页面入口

操作者最终确认的入口是：

```text
ChatGPT → Local Workspace Bridge → Manage
    → 滚动到页面最底部
    → 点击 Refresh tools
    → 查看刷新后的工具名称与定义
```

**必须写明 Manage 页面最底部的 Refresh tools。** 仅写“刷新一下”“管理页 Refresh”容易让人误做浏览器刷新或找错位置。该页面位置是 2026-09-28 操作者实际确认的 UI 事实，不承诺未来版本永远不变。

代码刚变更时先加载新版服务；已确认新版运行时不反复重启。刷新后核对新增动作是否启用，再测试会话。建议新建会话重新添加连接，但本次已有会话在后续轮次也成功发现了新工具，不能将“必须放弃原会话”写成该次恢复的已证实条件。

### 4.2 工具目录验证

刷新后，会话发现 **16 个工具**，此前缺少的 `file_create`、`file_edit`、`file_delete`、`command_exec` 均出现；`change_apply` 描述也更新为新版工作区授权语义。

工具总数只记录当次基线。后续新增功能或缩小 grant 会改变可见数量，应逐项比较期望工具及定义，不以“永远必须 16 个”作为验收规则。

### 4.3 命令执行验证

先调用 `workspace_list` 取得当前工作区 ID，再在 `maas_business` 工作区通过真实 `command_exec` 执行 PowerShell 标记输出和目标工作目录比较。该次目标为操作者指定的 `business_service`，仅输出目录比较布尔值，没有回传本机绝对路径。

历史工具回执：

```json
{
  "request_id": "req_25",
  "shell": "powershell",
  "exit_code": 0,
  "duration_ms": 594,
  "timed_out": false,
  "output_truncated": false,
  "output_withheld": false,
  "stdout": "LWB_COMMAND_OK\r\nLWB_CWD_MATCH=True\r\n"
}
```

这是回执的相关字段摘要，不是完整原始响应。原始 `stderr` 还包含 PowerShell 首次加载模块的 CLIXML progress 消息，未在此全文复制；没有把它说成空 stderr。`req_25` 仅用于关联该次历史会话，不假定请求编号跨重启或会话全局唯一。

验证命令没有创建、修改或删除项目文件，没有执行构建、安装、Git 提交或数据库迁移。已证明的闭环是：

```text
ChatGPT 发起 command_exec → 本地目标工作区执行 → 返回真实结果
```

未由此次 smoke 证明的内容包括：其他工具的写入/删除结果、Maven 或前端构建、长任务、并发、撤权/暂停、超时后的副作用和回滚。

## 5. 误判修正与后续排查规则

| 当时走偏的判断 | 修正方式 |
| --- | --- |
| 会话无工具，所以项目未实现 | 分开验证源码实现、服务端暴露、会话发现与真实执行 |
| 旧进度文档说旧 daemon 未停，所以当前仍是旧进程 | 采用操作者更新后的现场证据，历史记录只作历史 |
| 缺少写入工具一定是低风险权限设置 | 按准确插件 ID 读取设置，并分开分析元数据、动作开关和本地 grant |
| 点过刷新或重启后应该自动好 | 指定 Manage 页面最底部的 Refresh tools，并检查实际名称和描述变化 |
| `/health/mcp` 空清单能决定刷新是否成功 | 检查成功性、完整性、观测时间和覆盖范围；不能否认管理页与真实调用结果 |
| 固定数量或进程在线等于能力验收通过 | 对目标工具进行最小无文件写入调用，读取真实退出码、输出与工作目录核对结果 |

再次发生时，先找到“源码 → 本地发现结果 → 管理页 → 会话 → 调用回执”的第一处不一致，再检查该边界。不要在没有新证据时循环重启、重复建议扩大权限，或重新开发已经存在的工具。

命令执行仍属于独立的高风险能力，工作区目录只是初始工作目录，不是 OS 沙箱。排障不授权越界读写、秘密访问或绕过文件工具保护；不为了发现工具而授予整个磁盘。

## 6. 更新流程、资料依据与状态快照

后续工具更新操作统一按根文档 [启动命令.md](../启动命令.md) 的“工具更新后必须执行”一节进行：加载新版 → 核对目标目录授权 → Manage 最底部 Refresh tools → 核对动作与定义 → 会话发现 → 最小调用验收。

官方一般流程与本次实测证据分开使用：

- [OpenAI：Connect and test your plugin — Refresh metadata](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata)：工具元数据变更后部署或重启服务、刷新连接、确认元数据变化并进行新会话测试。查阅日期：2026-09-28。
- [OpenAI：Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)：存在动作控制与更新后需检查新动作启用状态的说明；具体管理方式受账号、工作区和发布模式影响。查阅日期：2026-09-28。
- **Manage 页面最底部的 Refresh tools**、诊断快照、16 个工具发现及上述命令回执：来自本次操作者和真实工具交互，不伪称官方页面提供了相同 UI 位置或事故内部根因。

最终状态：工具目录更新已验证；目标目录 `command_exec` smoke 已通过；ChatGPT 内部具体不同步环节及诊断快照覆盖问题未唯一定位；其他工具行为和项目构建不在本次命令验收范围。此记录补充后不改变既有安全评审或整个产品的验收等级。
