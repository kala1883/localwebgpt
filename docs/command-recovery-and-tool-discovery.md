# 命令隔离恢复与 MCP 工具发现修复

日期：2026-10-14。目标契约版本：0.2.1。命令协议仍为 1.0.0。

## 本轮完成与运行边界

本轮修复源码已经写入，根 TypeScript 检查、控制台类型检查、定向核心回归、Windows 集成与原生进程测试、恢复面板组件测试、控制台生产构建均已实际执行。源码与前端构建完成不等于运行实例已加载。

最后一次生产 bridge_status（本轮 req_165）仍为 contract_version=0.2.0，命令限额全局32、每连接8，当前占位2、隔离2、storage_fault=false，文件占位0。测试没有向生产实例新增隔离任务。当前连接重新发现 command_ 前缀仍只有 command_exec；不能宣称 ChatGPT 已经获得三个任务管理接口。

以下两个旧任务没有被本轮删除、重新执行、按 PID 终止或释放：

- job_632e2a8b-23c7-4b1b-99af-7eba12e99b56
- job_60e33c4e-c184-4a8b-881b-f81cc2f93858

本机查询的 Windows 上次启动时间为 2026-10-10T12:20:51.8676950Z，早于这两个任务。因此此次 LocalWebGPT 服务重启不能作为它们的进程已经结束的证据。没有重建旧命令/PID 的可靠证据，不能自动确认。未改动 data_agent 的业务文件。

## 1. 不再只有进入隔离、没有退出路径

新增状态 RECOVERED_UNKNOWN。它不再占用命令名额，但 completion_unknown 仍为 true，明确保留业务结果未知。恢复不会把任务伪装成 EXITED/CANCELLED，不修改原 command_exec 幂等引用，不重跑原命令，不自动回滚业务文件。

### 迟到终止确认

CommandProcessManager 已返回 TERMINATION_UNKNOWN 后，仍可接收迟到的真实终止证据。只有实际观察到主进程退出、管道关闭，并且原受管进程树终止助手明确成功，才调用独立的 on_termination_confirmed。销毁管道、父进程退出、时间经过、助手返回失败均不足以恢复。

CommandJobManager 记录回调与任务最终落账的竞态，防止迟到证据丢失。符合条件时，以 process_observation / late_termination 恢复。失败仍保留占位。此实现沿用现有终止助手，不是 Windows Job Object 沙箱，也不证明故意脱离管理的进程全部消失。

### 受控本地恢复

本地控制台现有“恢复”页增加“命令任务恢复”面板。入口独立于命令执行额度和 ChatGPT 工具清单。

- GET /api/commands/jobs：本地会话读取隔离/恢复记录，最多100条并显式标记截断，未恢复任务优先。
- POST /api/commands/recover：本地会话、既有 CSRF 与单次 nonce；逐任务核验全部相关进程已停止后，勾选确认并手动输入完整任务号。

路由要求的 changes.read / approvals.decide 能力不授予 MCP 身份。没有新增模型可调用的强制清理接口。操作者身份来自已经认证的控制台会话，拒绝入参伪造 actor、force、PID、任意证据来源。

恢复依据为本机实际核验进程树，或实际核验完整操作系统重启发生在任务执行之后。仅选择选项不等于执行了系统核验。无法证明时保持隔离，不要勾选确认。恢复面板提交失败时要求刷新核对，不会自动重复提交。

手工恢复明确记录 source=local_operator，而非伪造 process_observation；termination_confirmed 不被手工确认改成操作系统观测成功。具体依据和时间保留在 resolution 中。

### 原子恢复记录

RepositoryCommandJobStore.resolve 在同一事务中：核对任务归属、TERMINATION_UNKNOWN 和 expected_updated_at；写入 lwb.command_job_recovery.v1 的持久化恢复证据；更新任务为 RECOVERED_UNKNOWN。证据包括原失败原因、操作者身份、依据、时间、恢复标识和业务结果 UNKNOWN。确认提交后才释放一次内存许可或移除恢复隔离占位。

存储失败回滚全部写入并保留名额；重复恢复不重复释放；迟到回调不会覆盖已有人工证据。原命令幂等记录和历史不删除。重启通过已持久化的恢复状态避免再次占位。

## 2. 工具清单统一与变化通知

新增 withCommandJobCatalog，统一 IPC 注册清单、状态诊断和 catalogView，避免本地视图仍只显示16个基础工具。command_exec 获授权时，应同时发现 command_status、command_list、command_cancel，共19个工具。若执行已开放却缺少管理接口，适配器拒绝发布这份不完整清单，并明确报告缺失；重复名称也被拒绝。

适配器声明 tools.listChanged，并在 MCP 初始化后发送一次通知、在目录变化时发送 notifications/tools/list_changed。有界串行检测不会并发堆积；断线清理；查询失败不被解释成空目录，也不会扩大授权。

bridge_status 增加可选 tool_surface：catalog_version、available_tools 和 client_inventory=not_observed。服务端只能证明本连接授权目录，不能假装观察到了 ChatGPT 最终接收的工具列表。

### 必须区分 ChatGPT 的已批准工具快照

OpenAI 官方文档明确：已批准的工作区 MCP 应用使用工具和输入的冻结快照，服务端更新并不自动变成已批准的新动作。管理员须刷新并审阅更新；新动作可能默认未启用。本地重启与 list_changed 通知不能替代此步骤。

官方参考（2026-10-14 核对）：

`https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt`

`https://help.openai.com/en/articles/20001497-troubleshooting-plugins-apps-in-chatgpt`

## 3. 激活与验收

先正常停止、启动 LocalWebGPT，使新 daemon、adapter 和控制台加载本轮代码。不要从正在执行的桥接命令中强杀它自身，不要删除任务日志来制造空闲名额。重启后 bridge_status.contract_version 应为0.2.1；原8/32限额不变。

然后在 ChatGPT 对应应用管理页刷新 Local Workspace Bridge 的工具清单。对受管理的工作区应用，官方路径为 Workspace settings → Apps → Local Workspace Bridge → Action control → Refresh；新版管理入口可能在 Plugins → Manage Legacy Apps。由有管理权限且连接有效的操作者审阅并启用 command_status、command_list、command_cancel。无需重新创建应用，也不应反复扩大已经存在的工作区权限。

最后重新发现工具并实际查询一个本连接任务。MCP SDK 测试已经验证19个工具及三个管理调用，但这不是当前生产 ChatGPT 会话已经刷新成功的证据。

旧隔离任务通过新本地恢复面板逐项处理。只有实际核验后才能确认恢复；业务迁移仍需根据磁盘文件状态判断哪些步骤已执行，不能因释放名额就宣称业务任务完成。

## 4. 实際本机验证

环境：Windows，Node.js v24.9.0。完整日志根目录：.lwb-local/repair-validation-20261014/。

| 验证 | 本轮最终结果 | 证据目录 |
| --- | --- | --- |
| 根 tsc --noEmit | 通过 | types/ |
| 控制台 vue-tsc | 通过 | types/ |
| 核心池、任务、恢复、MCP SDK 传输回归 | 45项：43通过、0失败、2平台跳过 | core-tests/ |
| Windows 生产注册、SQLite命令链、真实进程、迟到确认、证据不足 | 21项：20通过、0失败、1环境跳过 | windows-final/ |
| 恢复面板组件 | 4项全部通过 | console-tests/ |
| 控制台生产构建 | 通过 | console-build/ |

核心恢复事务故障用例使用生产仓储适配器配合可回滚的内存 Repositories 替身；不能把它说成真实 SQLite 故障注入测试。Windows命令集成使用真实SQLite与生产注册，但不是人工操作本机生产恢复面板的验收。MCP SDK测试使用真实Server/Client和内存传输，并用受控IPC返回；不等于云端应用快照已刷新。

Windows既有输出超限用例曾遇到有限输出命令先自然退出、助手未确认的竞态。本轮将“确定终止”夹具保持存活，并新增独立测试确认助手未给出成功证据时必须保留未知状态，而不是放松生产终止条件。

额外运行的既有 console-host-view.spec.ts 仍在第67行失败。用本轮修改前、哈希匹配的 ConsoleHostView.vue 独立副本对照，同一测试在同一位置失败；临时副本已清理，未更改原测试以掩盖失败。证据在 host-baseline/。不宣称全量 npm run check 或全部既有控制台测试通过。

## 5. 改动保护与回退

本轮没有 Git 提交，没有硬重置仓库，没有删除或重写生产任务记录，没有调整模型权限。混合换行文件只做唯一锚点的定点替换，保留其他原始字节。

原字节备份和逐文件SHA回执在：

- .lwb-local/repair-command-core-20261014-backup/
- .lwb-local/repair-command-wiring-20261014-backup/

回退前须比较当前SHA，避免覆盖后续修改。若已经产生RECOVERED_UNKNOWN记录，不得直接回退到不认识该状态的旧版解析器；应先设计兼容读取迁移并保留恢复证据，不能删记录解决兼容问题。
