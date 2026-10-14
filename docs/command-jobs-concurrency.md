# 命令作业与并发隔离实施记录

日期：2026-10-09。工作区：本项目目录。

## 2026-10-14：隔离恢复与工具发现修复（最新）

新增本地控制台“命令任务恢复”面板、事务化恢复证据、RECOVERED_UNKNOWN 状态及迟到终止确认处理；统一19项工具清单并补上 MCP 清单变化通知。详细实现、回退边界、完整证据及激活步骤见 `docs/command-recovery-and-tool-discovery.md`。

本轮定向核心回归43通过/2平台跳过，Windows回归20通过/1环境跳过，恢复面板4项通过，根/控制台类型检查及前端生产构建通过；上述目标测试无失败。既有主界面测试在修改前基线中也于相同位置失败，单独记录，未宣称全量检查通过。

源码目标契约版本0.2.1；最后运行实例仍为0.2.0，需正常重启加载本次修复。生产两个旧隔离任务未释放，须在新本地面板实际核验后逐项恢复。ChatGPT 当前仍只发现16个基础工具；应用的已批准工具快照须由操作者在应用管理页刷新、审阅并启用新增动作，本地重启不能替代该步骤。以下为扩容及旧实现的历史记录。

## 2026-10-14：命令任务名额扩容

命令任务默认上限调整为每连接 8 个、全局 32 个，统一定义在 `packages/contracts/src/command-job.ts` 的 `COMMAND_JOB_LIMITS`。生产装配的 `commandPoolFor(files)` 直接使用命令专用限额，不再从文件池复制容量；文件读写池及其自定义限额保持不变（文件池原默认值仍为每连接 2、全局 4）。满额时不排队启动新进程；取消和诊断的独立入口保持原有设置。

`TERMINATION_UNKNOWN` 继续占用名额，重启不会清空未知任务，也不会重跑旧命令。本次修改前诊断为当前连接占用 2/2，两个任务均已隔离；新版本生效且没有其它占用变化时，该连接仍保留 2 个隔离占位，并有 6 个新任务名额。

上限在 daemon 启动时加载，修改源码不等于当前运行实例已生效。2026-10-14 本机重启后已通过 `bridge_status.concurrency.commands` 核对 `max_per_connection=8`、`max_concurrent=32`；详细验收见下方补记。

已更新池容量测试，并补充默认 8 个任务、满额幂等重放、名额释放复用及“2 个恢复隔离任务 + 6 个新任务”的回归用例。扩容写入当时，2026-10-14 本机命令预检被 `CONCURRENCY_LIMIT_EXCEEDED` 拒绝，尚未运行测试；该阻塞已在本次重启后解除。验证入口如下，实际运行结果见补记，不能用下方 2026-10-09 的历史证据代替：

```text
npm run typecheck
node --import tsx --test tests/unit/command-concurrency-pools.test.ts tests/unit/command-jobs.test.ts
```

### 2026-10-14：重启后本机验收补记

运行环境为 Windows（win32）/ Node.js v24.9.0。当前工具发现返回 16 个基础工具，包含命令执行及文件创建、编辑和修改应用；工作区声明已授予的 `command_status`、`command_list`、`command_cancel` 三个新工具仍未出现在当前会话的可调用清单，不能将本轮视为完整工具面验收。

在 `data_agent` 执行 PowerShell `Write-Output 'LWB_POWERSHELL_PROBE_OK'`，实际收到标记，回执为 EXITED / exit_code=0 / termination_confirmed=true / slot_held=false。CMD 探针虽然返回 exit_code=0，但未返回预期输出标记，未计入完整 CMD 通路已验证的证据。通过 `file_create` 创建本项目 `.lwb-local/restart-validation-20261014-0625.cjs`，回执 APPLIED / VERIFIED；未改动 data_agent 的业务文件。

本机实际运行 `node node_modules/typescript/bin/tsc --noEmit`（与 package.json 的根目录 typecheck 脚本使用同一编译器和参数），exit_code=0。随后运行上面两份命令测试，添加 `--test-reporter=tap` 保存结果：31 项测试，29 通过、0 失败、0 取消、2 项按 Windows 平台条件跳过。通过项包含每连接 8 / 全局 32 的限额、文件池隔离、两个恢复占位加六个新任务、幂等重放，以及 100 条真实短命令、真实长进程取消和输出上限测试。

报告和日志位于 `.lwb-local/restart-validation-20261014-0625/`，摘要为 `report.json`，详细 TAP 输出为 `command-tests.stdout.log`。验收原任务 `job_604afb51-bd4a-4117-b2ef-b62c2a0b9fb4` 通过相同幂等键查询，未重复执行，最终 EXITED / exit_code=0 / termination_confirmed=true / slot_held=false。结束后的 bridge_status 回执 req_19 显示命令占位回到 2/8，全局 2/32，仅保留两个原有 TERMINATION_UNKNOWN；没有新增隔离占位。

本轮没有清除旧任务或幂等记录，没有修改运行源代码，没有执行目录迁移。尚未运行 npm run check、控制台类型检查及全部 Windows 集成测试；g0_platform_verified 和 native_guard_verified 仍为 false。未知任务恢复接口和三个任务管理工具的端到端暴露仍需另行修复与验收。

## 2026-10-09 实施结论（以下为历史记录）

三阶段的主要运行代码已经写入项目，但整体验收尚未完成，不能将本记录作为“全部完成”或“已上线”的证明。11 个运行代码文件和 3 个测试文件的写入回执均为 APPLIED / VERIFIED。本文是另一个新增文档文件。当前 daemon 未重启，最后一次 bridge_status 仍返回 contract_version=0.1.0；新代码的组合契约为 0.2.0。

当前工作区没有 command_exec 授权，因此没有在本机运行完整类型检查、Windows 回归或全量测试；没有启动 Django、改动业务数据库、停止业务进程或改变权限。

## 阶段一：资源池隔离和诊断

保留已有 concurrency-pools.ts，命令作业使用 commandPoolFor(files)，文件工具继续使用原文件池。默认两池各自为全局 4、每连接 2；生产装配沿用原生效限额。命令长期运行不会继续占用文件池的许可。

并发闸门新增按当前连接隔离的 inspect()：占槽数、全局总数、等待数、最老占槽时长和不透明许可标识。经过的时间改用单调时钟，原 snapshot() 和重复释放报错语义保留。

bridge_status 新增 concurrency.files、concurrency.commands 和 command_job_protocol。命令诊断给出本连接的 job_id、状态、时长、隔离占位与存储故障，不返回其它连接标识或命令文本。执行请求、取消请求、诊断请求使用分别有界的入口；取消不依赖命令执行池尚有空位。

这里保证的是“命令池满额不会导致文件工具因共享额度被拒绝”，不是保证磁盘、原生护栏或其它独立后端永远不会阻塞。

## 阶段二：受管理的命令作业

command_exec 默认只等待 1000 毫秒，wait_ms 可设为 0 至 5000；这是本次等待窗口，不是命令执行硬时限。未完成时返回原任务 job_id 和真实状态。客户端不再等待不会隐式重跑或杀死任务。

新增三个工具，继承当前工作区的 command_exec 授权，并复查当前连接与任务归属：

| 工具 | 行为 |
| --- | --- |
| command_status | 按 job_id 查询；默认仅元数据，include_output=true 才请求保留的终态输出 |
| command_list | 当前连接、当前仍获授权工作区的任务列表；分页上限 50 |
| command_cancel | 请求停止指定原任务；不接受 PID、force 或用户自报的连接身份 |

同键请求在检查执行额度之前查询原记录。相同键、相同命令返回同一个任务；同键不同命令返回 IDEMPOTENCY_CONFLICT。旧版没有 job_id 的幂等记录继续抑制重放，不得换键盲目重跑。

作业元数据复用现有幂等仓储并在事务中建立：原请求引用、任务记录、连接内索引在启动进程前完成持久化。不增加数据库表，不落盘命令文本、cwd、PID、stdout 或 stderr。输出经现有安全检查，最多收集 24 KiB，内存保留默认 10 分钟、最多 256 个终态任务。终态索引有界；用于防止重复执行的持久化元数据没有新增删除策略，不能把它描述为磁盘使用永久固定。

后台任务持续检查暂停、授权撤销、工作区和连接代次、配置修订以及恢复状态。查询输出仍经过现有授权链、敏感信息处理和出站预算。每次工具调用写审计；任务启动后发生的错误会明确提示可能已有副作用。

## 阶段三：有界清理和真实终态

保留现有 terminate-command-tree.ts：Windows 使用异步、有界的 taskkill 助手并检查结果；不会按用户输入的 PID 或进程名批量终止进程。

命令管理器分别观察主进程退出、输出管道关闭和终止助手结果。主进程退出后输出排空默认最多等待 1000 毫秒；终止确认默认等待约 3000 毫秒，并有最终返回保护。助手卡住或终止无法确认时，返回 TERMINATION_UNKNOWN 并保留命令隔离占位，不伪造 CANCELLED，也不通过计数归零继续放入新命令。

CANCELLING 仅表示已请求取消；不能据此宣称进程已停止。重启发现旧的非终态任务也转为 TERMINATION_UNKNOWN，不复用旧 PID、不自动重跑、不自动释放未知占位。

明确边界：这不是原生 Windows Job Object 隔离实现，也不能证明任意故意脱离管理的后代全部消失。termination_confirmed 描述本管理流程观察到的主命令、管道及终止结果，不是操作系统沙箱证明。当前没有新增操作者确认并清除未知隔离占位的接口；此类任务仍需本机确认和受控恢复，不能通过删除日志或清空计数处理。

## 实际验证证据

隔离环境为 Linux / Node.js v22.16.0。23 项核心测试通过，额外连续执行 3 轮，每轮均 23 通过、0 失败。每轮含 10 万次许可申请释放、100 条真实短命令、真实长进程取消、输出超限、继承管道和清理无法确认等测试；其它测试用可控驱动覆盖幂等竞态、跨连接隔离、撤权、重启、存储失败及事务回滚。

核心严格 TypeScript 检查通过。隔离检查对仓储仅使用已读取契约的类型替身，对基础契约仅使用三个限额常量；不是完整项目依赖检查。10 份容器中的 TypeScript 源码副本语法检查通过；这也不等于全项目类型检查。核心代码和测试副本的哈希与本机写入回执一致。

| 验证 | 状态 |
| --- | --- |
| 核心 23 项回归及额外 3 轮重复 | 已通过，隔离环境 |
| 核心严格类型检查 | 已通过，限定依赖边界 |
| 新增 Windows 集成测试 6 项 | 已写入，未运行 |
| 更新原 Windows 命令测试 | 已写入，未运行 |
| 完整项目类型检查和全量测试 | 未运行 |
| 重启后 MCP 发现与真实调用 | 未运行，当前仍为旧运行实例 |

## 尚需完成的验收项

1. 本机迁移 tests/unit/daemon-tools.test.ts 的旧契约断言。该文件读取的中间页出现脱敏和 editable=false，本轮没有根据脱敏结果改写它。已经确认的旧预期包括：16 个工具名、旧输出 schema、command-only 工作区只列 command_exec，以及短命令同步完成假设。
2. 迁移时从 tool-surface-v2.ts 引入生产工具清单和输出 schema；旧 guard.ts 两张静态表的分区测试仍应针对旧 16 个基础工具，不能简单替换成 19 后宣称新工具绕过审计。新的三个命令管理工具由 command-job-tools.ts 的独立审计和权限检查覆盖，应保留相应集成测试。command-only 的 granted_tools 预期应加入 status/list/cancel。短命令测试可显式使用 wait_ms=5000，超出时应查询终态。还需检查其它旧适配器测试夹具是否与新输出 schema 一致。
3. 在本机按既有夹具初始化流程运行以下检查，修复真实依赖和 Windows 端发现的问题。下列命令本轮均未通过桥接执行，不是已通过记录。

```text
npm run typecheck
node --import tsx --test tests/unit/command-jobs.test.ts
node --import tsx --test tests/windows/command-jobs-integration.test.ts tests/windows/daemon-command-exec.test.ts tests/windows/command-processes.test.ts
npm run check
```

4. 检查通过后，在本机协调重启 daemon 和 MCP adapter，再刷新连接工具清单。验收应看到 contract_version=0.2.0、command_job_protocol=1.0.0 和三个新工具；已有两个长期任务时，文件读取、同键查询与取消仍应可用。当前不能把源码已保存视为运行实例已升级。

## 回退和改动保护

按本轮修改集回执回退对应文件；先比较当前哈希，避免覆盖用户后续修改。不得使用全仓硬重置，不得删除业务数据或幂等记录。已有 concurrency-pools.ts 与 terminate-command-tree.ts 的改动被保留，不属于本轮新增的可随意删除内容。没有创建 Git 提交。
