# ADR-005：逐工作区命令执行授权

- 状态：**已决定**
- 日期：2026-09-28
- 关联范围：`command_exec` MCP 工具与逐 workspace grant
- Supersedes：ADR-001 §3.1 中「不提供任意 Shell」的产品范围决定；不撤销其记录的权限绕过风险

## 决定

新增 `command_exec` 工具，可选择 `cmd`、PowerShell 或 Bash。调用必须提供一个已登记的目录工作区和命令文本；命令以该工作区根目录作为初始工作目录。执行须同时满足连接启用、工作区启用、工作区为可写模式，并且该 workspace 对当前连接单独获授 `command_exec`。此 grant 不等同于 `read`、`propose` 或 `git_read`。

用户已通过该目录的 `command_exec` grant 授权命令能力，不再逐次弹出批准。`command_exec` 工具标为非只读、破坏性且可触达开放世界。

## 限制与已知边界

- 这是以 LocalWebGPT 当前 Windows 用户身份执行的任意 shell 代码。设置 `cwd` 只决定命令从哪里开始；shell 可以 `cd`、访问该用户有权访问的其它路径、连接网络或启动其它程序。它**不是目录沙箱**，也不保证只触碰获授权根。
- 它不经 FsGuard 句柄写入器，不提供逐文件冲突校验、快照回滚、精确受影响文件列表或跨文件恢复。`file_access` 审计行只记授权根这一执行范围，不声称枚举命令实际访问的全部文件。命令超时、撤权、暂停或进程退出时可能已有部分副作用。
- 每次最长运行 25 秒；stdout 与 stderr 合计最多采集 24 KiB。输出会去除终端控制序列，检测到本机绝对路径或高置信度秘密时整段隐藏，并通过现有出站预算记账。命令本身可直接访问网络；输出筛查不阻止命令自身联网外传。
- 子进程只继承构建/运行常用的有限环境白名单，不继承 daemon 的 IPC、tunnel 或 API 凭据变量。撤销 grant、暂停服务或改变工作区代次会触发停止；正常 daemon 退出也会回收已登记的子进程。Windows 以 `taskkill /T /F` 终止命令树；强杀 daemon 时仍受 OS 子进程所有权限制，不能承诺孤儿清理。
- 只允许目录工作区，不能在只读模式中开放。工作区路径和 tool grant 仍须在控制台逐目录选择；不默认启用。

## 为什么接受这项能力

用户明确要求在已授权目录执行常见命令，并以 workspace/tool grant 作为授权来源。工程不把仅设置 cwd 说成安全隔离；风险由独立、醒目的命令 grant 暴露给本地操作者。它不会改变普通文件工具的 FsGuard、秘密路径、冲突校验和快照语义。

## 2026-09-28 补充：命令调用的同键重放

真实网页 smoke 的只读审计观察到，同一用户消息触发了多个独立 `command_exec` request ID。为降低传输重试或调用重放造成重复副作用的风险，命令工具现要求 `idempotency_key`，并复用受保护状态库的幂等记录：

- 请求指纹绑定 `(workspace_id, shell, command)`；同键不同指纹返回 `IDEMPOTENCY_CONFLICT`。同键重放在进程启动前被拦截，返回 `COMMAND_REPLAY_SUPPRESSED`。
- 状态库只保留请求哈希和 `started` / `not_started` 标记，不保存命令文本、stdout 或 stderr。若执行后输出交付失败，同键重试仍不会重新启动命令；操作者/模型应先检查工作区状态。
- 此保证是**每个幂等键至多启动一个进程**，不是语义 exactly-once：调用方若为重复意图另造新键，仍会被视作新执行。命令 grant 仍是唯一授权来源；幂等键不增加审批步骤，也不构成命令沙箱。

## 2026-09-28 补充：同键命令重放抑制

真实 ChatGPT smoke 中，一条用户请求在审计里出现了两个不同的 `command_exec` request ID。为降低网络重试或调用重放造成重复副作用的风险，工具现在要求调用方提供稳定的 `idempotency_key`：

- 键作用域为 `(principal_id, tool, key)`；请求指纹覆盖 workspace、shell 与命令文本，但只将 SHA-256 和执行状态写入受保护状态库，不保存命令正文或 stdout/stderr。
- 同一键/同一请求首次调用后才启动进程；同键重放返回 `COMMAND_REPLAY_SUPPRESSED` 且不启动第二个进程。同键不同请求返回 `IDEMPOTENCY_CONFLICT`。
- 若第一次执行结果丢失，系统不重放命令输出。调用方必须检查工作区状态；不得为了重跑同一意图而换一个键。**不同幂等键代表新的执行**，因此模型若为重复调用另造新键，服务端无法推断二者是同一意图。

幂等键是重放保护，不是命令沙箱、逐次审批或对任意 shell 的 exactly-once 语义；命令仍只在显式 workspace grant 下运行，且可能触及初始 cwd 之外的路径。

## 应重新决定的条件

若产品要求命令**严格不能访问 workspace 之外**、不能联网或不能启动任意进程，则当前实现不满足；需要真正的 Windows AppContainer/Job Object 沙箱后再开放，或移除此工具。仅增加命令 allowlist 文案不能把它变成沙箱。
