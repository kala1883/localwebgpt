# LWB-025 · 接入修改提议工具并验收审批闭环 — 证据

**采集方式：** `node --import tsx scripts/evidence/lwb-025.ts`（**退出码 0**；**65 PASS / 0 FAIL / 4 NOT_RUN**）
**采集环境：** Windows 11 Home China 10.0.26200 / Node v22.20.0 / win32 / 真实 NTFS + 真实 pwsh 护栏
**测试套件：** 见 §7（全仓回归、`tests/windows`、vitest、FsGuard 导入检查各自的退出码与计数）
**原始日志：** 未入库（`*.log` 在 `.gitignore` 中，与 `lwb-006` ~ `lwb-024` 一致），
本次运行落在 `docs/evidence/lwb-025/raw.log`。下文引用的每条 `PASS` / `NOTE` 行均为运行输出的**逐字**摘录。

**门禁结论：G3 未通过，本任务不得被读成「提议—批准闭环已在真实网页上可用」。** 三条验收标准里，
第 1、2 条在**真 MCP 客户端 + 真 IPC 处理器 + 真 SQLite + 真实 NTFS 身份**上成立；第 3 条在
**开关推导（穷尽 8 格）+ 真实工具面清单**上成立。**没有任何一条证据采自真实 ChatGPT 网页端** ——
LWB-002 仍 BLOCKED（`tunnel_id` 与 API key 未申请），而任务书明写「MCP Inspector 成功不能代替网页验收」。
**执行协调器 `packages/executor/coordinator.ts`（LWB-026）尚未交付**，因此本任务能证到的是
**提议侧**（提案真的建立了、状态真的是 `PENDING_APPROVAL`、工作区真的一个字节都没动），
不是**落盘侧**（批准之后文件真的被写）。这条差别写成了 `NOT_RUN`，没有与 `PASS` 合并。

**本任务不启动外部进程、不发网络请求。** 唯一真实的副作用发生在**临时目录**（`os.tmpdir()` 下
`mkdtemp` 出来的工作区副本）里，`finally` 中被 `rm -rf` 兜底清理；夹具原树
（`tests/fixtures/generated/testrepo`）全程只被读取。

---

## 0. 这一轮的证据是在什么装置上采的

三条验收标准的原文说的分别是**说明文案**、**时序**、**配置**：

> 工具 descriptions 明确先读取、再提议、等待真实批准。
> 待审批时不会长时间挂起 MCP 调用或无限轮询。
> G3 通过时仍可保持直写开关关闭。

因此装置分三段，且**每一段都必须经过真实链路**：

| 段 | 装置 | 为什么非这样不可 |
| --- | --- | --- |
| §1 | 真 MCP `Client`（`InMemoryTransport`）+ daemon 的**真** `catalog` | 这一条说的是「模型读到的字」。工具的 `description` / `annotations` 是**出站契约**，只有从 `tools/list` 那一侧读回来才算数 |
| §2 §3 | 真 MCP 客户端 → **真 IPC 处理器** → 真 SQLite → **真实 NTFS 句柄身份** | 「一个字节都没动」只有数**磁盘上的字节**才算证到；对内存里的意图做断言证明不了它没写 |
| §4 | `capabilityFlagsFrom`（**穷尽 8 格**）+ 以该取值**真装配**出来的第二个 harness，问它的 `tools/list` | 「开关关着」与「工具面看不到写工具」是两件事，而后者才是模型能观察到的那个 |

**工作区是夹具的副本，不是夹具本身** —— 这一条不是格式要求，它让票据里的文件身份
**天然必须**取自「实际将要被读的那个对象」：

```
PASS 护栏提供句柄级身份与独占打开 — identity=true exclusive=true
PASS 工作区是夹具的副本而不是夹具本身 — 夹具 file=0002000000672a7d 副本 file=002900000009ca0b；两次 stat 的 volume=c6e22015 一致
```

两次 `stat` 的 `volume_id` 相同而 `file_id` 不同：同一个卷上的两个不同对象。
若实现把身份取自**路径字符串**（而不是打开后的句柄），这一格仍然会通过 ——
因此它挡不住那种实现，它挡的是**更早的一类错误**：把夹具本身当成工作区，
于是所有「工作区没被改动」的断言都在验「我没动源材料」。

**运行期护栏台账（`withLedger`）**是本文件里出现次数最多的一个装置：它把
`PowerShellWinfsBackend` 包一层 `Proxy`，逐次记下 `resolvePath` / `readFileGuarded` / `writeFileGuarded` /
`createFileGuarded` 的调用与实参。用 `Proxy` 而不是展开对象是有原因的：真实后端的方法在**原型**上，
`{...backend}` 会把它们全丢掉 —— 那会让台账恒为空，而一个恒为空的写台账恰好能让
「写方法一次都没被调用」永远通过。

---

## 1. 验收标准 1 / 步骤 1 —— 说明写清了顺序，提议工具被标为会改变状态

```
PASS change_prepare 的说明包含全部要点（5 条）
PASS change_get 的说明包含全部要点（4 条）
PASS change_list 的说明包含全部要点（2 条）
PASS change_prepare 的 readOnlyHint=false — 实际=false
PASS change_get 的 readOnlyHint=true — 实际=true
PASS change_list 的 readOnlyHint=true — 实际=true
PASS 清单里没有 change_apply / change_revert_prepare — 清单=bridge_status,workspace_list,file_list,text_search,file_read,git_status,git_diff,change_prepare,change_get,change_list
PASS 挂出去的就是 daemon 已实现的那一组 — 已实现=10 条
```

判据是**短语清单**，逐条对应任务书上的一句话：

| 工具 | 要求的短语 | 它在回答哪一问 |
| --- | --- | --- |
| `change_prepare` | `必须先 file_read` / `read_token` / `PENDING_APPROVAL` / `绝不能` / `文件已经保存` | 「先读取、再提议、等待批准」的顺序，以及**不能伪称已保存** |
| `change_get` | `不要` / `重新发起` / `APPLIED` / `tests_run` | 断线之后**不要重复提议**，以及批准之后要跑哪些测试 |
| `change_list` | `当前连接` / `不返回其它连接` | 这个清单的**边界**在哪 |

**为什么是短语而不是「描述了顺序」这种印象判断。** 「说明里写了先读再提议」这句话本身不可观测；
可观测的是**那几个词在不在模型读到的字符串里**。用短语还有第二个作用：它让
「说明被改短了」这件事当场变成一条失败断言，而不是一次安静的能力退化。

### 1.1 `readOnlyHint` 为什么值得单独取证

```
PASS change_prepare 的 readOnlyHint=false — 实际=false
PASS change_get 的 readOnlyHint=true — 实际=true
PASS change_list 的 readOnlyHint=true — 实际=true
```

`readOnlyHint` 是**唯一**一个模型能读到的「这个调用会不会改东西」的提示。它不参与任何一次
授权判定（不是批准证据），标错也不会让任何调用失败 —— 它只会让模型**在没有心理负担的情况下重试**。
因此步骤 1 的那半句「保证提议工具标注为会改变服务状态」，落点就是这个布尔值。

### 1.2 写工具**不挂出去**，而不是「挂出去但每次拒绝」

```
PASS 清单里没有 change_apply / change_revert_prepare
```

这一条挡的是另一种「看起来更安全」的实现：把两个写工具也挂出去，然后在处理器里拒绝。
两者的证据面完全不同 —— 后者在下一次改装配时**没有任何一条断言会失败**，
而前者（不挂出去）会在 `IMPLEMENTED_TOOL_NAMES` 一旦扩到 12 条时立刻失败。

---

## 2. 步骤 2 —— 提议返回等待批准，且工作区一个字节都没动

```
NOTE 工作区快照（调用前） — 138 项，全部逐项记下 sha256/size/mtime
PASS 目标文件可编辑 — editable=true blockers=[]
PASS change_prepare 成功
PASS 状态是 PENDING_APPROVAL — state=PENDING_APPROVAL
PASS workspace_modified 恒为 false — 实际=false
PASS 不是幂等重放 — 实际=false
PASS 摘要非空且是 64 位十六进制 — digest=958312b75c70…(64)
PASS next_action 明说尚未写入任何文件 — next_action=修改集已建立，**尚未写入任何文件**。请把完整差异交给本地操作者，在控制台核对后批准；批准必须…
PASS next_action 明说批准只能由本地操作者完成
PASS 状态库里没有这条修改集的任何批准记录 — 实际 0 行
PASS 整棵工作区目录树逐项相同 — 138 项全部比对通过
PASS 运行期护栏的写方法一次都没被调用 — writes=[]
NOTE 本次提案实际打开过的路径 — reads=[resolvePath(newline/lf.txt) readFileGuarded(newline/lf.txt)]
```

### 2.1 「一个字节都没动」有四条互相独立的证据

| # | 断言 | 它单独能证明什么 | 它单独**不能**证明什么 |
| --- | --- | --- | --- |
| a | 整棵目录树 138 项逐项相同（sha256 + size + mtime + 目录项增删） | 观察到的落盘状态没变 | 一个「写了又还原」的实现能通过 |
| b | 运行期护栏的写方法调用 **0** 次（`writes=[]`） | 根本没走到写那一层 | 绕开护栏直接 `fs` 的实现能通过 |
| c | 状态库里这条修改集**没有任何批准记录**（0 行） | 「待批准」不是一句文案 | 批准写在别处（比如内存）的实现能通过 |
| d | `next_action` 的文案面（「尚未写入任何文件」+「模型与 MCP 通道都无法批准」） | 模型读到的那句话没有撒谎 | 说对了但做错了的实现能通过 |

**四条都不是充分条件，合起来才排除掉那四类实现。** 只留 (a)，一个先写后还原的实现通过；
只留 (b)，一个绕过护栏的实现通过；只留 (c)，批准记在内存里的实现通过；只留 (d)，纯文案实现通过。

### 2.2 台账里能读到的那一行（`reads=`）

```
NOTE 本次提案实际打开过的路径 — reads=[resolvePath(newline/lf.txt) readFileGuarded(newline/lf.txt)]
```

这一行是 `NOTE` 而不是 `PASS`：它没有阈值可断言。它的用处是**在出错时把「它到底碰过什么」直接摊开** ——
本次提案只打开过它自己声明的那一个文件，没有碰目录树、没有碰第二个工作区。

---

## 3. 验收标准 2 —— 待审批时不挂起、不轮询

```
PASS change_list 成功
PASS 5 次查询之间状态、批准、回执一格未动 — 唯一答案=PENDING_APPROVAL|approval=null|operation=null
PASS 查询结果里 approval 为 null（尚无批准记录） — approval=null
PASS 查询结果里 operation 为 null（尚无执行） — operation=null
PASS 查询结果里的状态仍是 PENDING_APPROVAL — state=PENDING_APPROVAL
PASS 带 path 的 change_get 成功
PASS 差异是单页：next_cursor 为 null — 实际=null
PASS 差异内容是一段 unified diff（行号头 + 两侧标记） — unified 前 60 字=--- a/newline/lf.txt
+++ b/newline/lf.txt
@@ -1,3 +1,3 @@
-l
PASS 每一次调用都在上界之内 — 最慢的一次 change_get#1=11.1ms，上界 15000ms；逐条=change_list:4.3ms change_get#1:11.1ms change_get#2:3.8ms change_get#3:3.1ms change_get#4:3.3ms change_get#5:3.0ms change_get(带差异):6.2ms
```

### 3.1 「不轮询」被否证成一条可判定的断言

连续 5 次 `change_get`，**每一次的答案都必须逐字相同**。这条断言的力量来自它的反面：

- 若后台有个循环在推进这个修改集，五次之间**迟早**会有一格变化 —— 状态、`approval`、`operation` 三个字段里任何一个动了，唯一答案就不再唯一；
- 若实现是「等批准等到超时」，它**根本走不到第五次** —— 第一次就撞上 15 秒的上界。

两个失败形态各由一条断言覆盖，因此不需要去证明「没有循环」这种不可观测的命题。

### 3.2 上界 15 秒这个数字是怎么来的

这是一次**本地**调用：内存传输 + 内存库 + 一个三行文件。正常在毫秒级。
15 秒对一次「等批准」的实现来说**远远不够** —— 恰恰因此，越过它说明的是
「有一个等待循环」，而不是「这次慢了」。实测最慢的一次 11.1 ms，与上界差三个数量级。

### 3.3 `change_get` 是**单页**工具

```
PASS 差异是单页：next_cursor 为 null
```

`change_get` 拒绝游标（见 §5.5 的 `CURSOR_NOT_SUPPORTED`）。这不是省事：
一个接受游标的 `change_get` 意味着差异可以被**分页**，而分页意味着「操作者看到的那一屏」
可能不是「他批准的那一份完整内容」—— 批准绑定的是摘要，不是页。

---

## 4. 验收标准 3 —— 提议可用的同时，直写开关保持关闭

这一段的装置与前两段不同。**必须先说清一件事**：本次采集装置的 `GATES_ON` 三条门禁全为真，
按 `capabilityFlagsFrom` 推出来的 `direct_write_enabled` 是**真**：

```
NOTE 本次采集装置的门禁（三条全开 ⇒ 直写为真） — {"read_enabled":true,"git_enabled":true,"proposal_enabled":true,"direct_write_enabled":true,"recovery_required":false}
```

因此验收 3 描述的那条配置**不是本装置的取值**，而是需要构造出来的产品配置。

```
PASS 8 种门禁取值下，直写只有在原生护栏也通过时才为真 — g0=0 native=0 §3=0 ⇒ read=0 propose=0 direct=0；g0=0 native=0 §3=1 ⇒ read=0 propose=0 direct=0；g0=0 native=1 §3=0 ⇒ read=0 propose=0 direct=0；g0=0 native=1 §3=1 ⇒ read=0 propose=0 direct=0；g0=1 native=0 §3=0 ⇒ read=0 propose=0 direct=0；g0=1 native=0 §3=1 ⇒ read=1 propose=1 direct=0；g0=1 native=1 §3=0 ⇒ read=0 propose=0 direct=0；g0=1 native=1 §3=1 ⇒ read=1 propose=1 direct=1
NOTE 验收 3 所指的配置（G0 与 §3 过、原生护栏未过） — {"read_enabled":true,"git_enabled":true,"proposal_enabled":true,"direct_write_enabled":false,"recovery_required":false}
PASS 该配置下读取与提议可用
PASS 该配置下直写关闭 —— 这正是那个额外与项的作用 — direct_write=false
PASS 该配置下 change_prepare 可用 — 清单=bridge_status,workspace_list,file_list,text_search,file_read,git_status,git_diff,change_prepare,change_get,change_list
PASS 该配置下 change_get 可用 — 清单=…（同上）
PASS 该配置下 change_list 可用 — 清单=…（同上）
PASS 该配置下 change_apply 不出现（直写关着） — 清单=…（同上）
PASS 该配置下 change_revert_prepare 不出现（直写关着） — 清单=…（同上）
PASS 门禁全开时写工具仍不在清单上（原因是「未实现」，见 IMPLEMENTED_TOOL_NAMES）
PASS 已实现的那一组就是挂出去的那一组 — 已实现 10 条
```

### 4.1 为什么是穷尽 8 格，而不是测「那一格」

`capabilityFlagsFrom` 收三个布尔，共 8 种取值。只测一两格的话，至少两种错误实现能通过：
「`direct_write_enabled` 恒为真」与「四个开关永远取同一个值」。8 格全列之后，
**直写恰好在且仅在「三条全过」时为真**，两个错误实现各有一格当场失败。

那一格的答案是：

| 门禁 | read | git | propose | direct |
| --- | --- | --- | --- | --- |
| `g0 ∧ §3` 为真、`native_guard` 为假 | ✅ | ✅ | ✅ | ❌ |

这正是 `capabilityFlagsFrom` 里那个**额外与项**（`platform_ready && native_guard_verified`）存在的理由：
**提议能力属于「读」那一侧，写能力需要原生护栏那句独立的保证。**

### 4.2 断言下在**工具面清单**上，不是下在开关上

```
PASS 该配置下 change_prepare 可用 — 清单=…
PASS 该配置下 change_apply 不出现（直写关着） — 清单=…
```

这一节真的按 `PROPOSAL_READY` 的取值**又装配了一个 harness**，并问它真实的
`tools/list`。理由是：开关算对了而工具面挂错了工具，是这条验收里唯一有**产品后果**的失败形态 ——
开关是内部状态，清单才是模型看到的东西。

### 4.3 两个「清单里没有」是两个不同的原因

```
PASS 该配置下 change_apply 不出现（直写关着）
PASS 门禁全开时写工具仍不在清单上（原因是「未实现」，见 IMPLEMENTED_TOOL_NAMES）
```

同一句话（「清单里没有 `change_apply`」）有**两个不同的原因**：在本装置里是
**它还没实现**（`IMPLEMENTED_TOOL_NAMES` 是 10 条），在 `PROPOSAL_READY` 配置里是
**开关挡住了**。两条断言分开写，是为了让「清单里没有」不被读成「开关挡住了」——
一个把两个原因混起来的读法，会在 LWB-032 把 `change_apply` 实现出来之后
得到一个错误的结论（「开关失效了」），而实际上那一天开关才开始第一次起作用。

---

## 5. 负向：硬拒绝、身份字段、归属、游标、代次、幂等

### 5.1 硬拒绝发生在 `prepare` 阶段，且**内容从未被打开过**

```
PASS 读取 config/.env 被拒绝 — code=POLICY_DENIED details={"policy_check":"file_rules","policy_reason":"HARD_DENY_RULE","hard_deny_rule":"HD-ENV","failure_count":1,"request_id":"req-lwb025"}
PASS 对 config/.env 的 create_text 提案被拒绝 — code=POLICY_DENIED details={"reason":"HARD_DENY_IN_PROPOSAL","hard_deny_rule":"HD-ENV","blocked_at":"prepare","request_id":"req-lwb025"}
PASS 对 config/.env 的拒绝发生在 prepare 阶段（不是留到执行时） — details={…"blocked_at":"prepare"…}
PASS 读取 config/.env.example 被拒绝 — code=POLICY_DENIED … "hard_deny_rule":"HD-ENV" …
PASS 对 config/.env.example 的 create_text 提案被拒绝 — code=POLICY_DENIED … "hard_deny_rule":"HD-ENV" …
PASS 对 config/.env.example 的拒绝发生在 prepare 阶段（不是留到执行时） — details={…"blocked_at":"prepare"…}
PASS 硬拒绝路径的内容一次都没有被打开过 — 台账里没有 .env：reads=[]
```

三条断言，缺一条就有一种实现能通过：

1. **被拒绝** —— 一个不拒的实现失败。
2. **`blocked_at: 'prepare'`** —— 一个「提案照建、留到执行时再拒」的实现，第 1 条照过。而那种实现的产品后果是：模型建出一份永远不可能成功的提案，操作者在控制台上看到它、核对它、点批准，然后失败。
3. **`reads=[]`** —— 一个「先把文件读进来再判断要不要拒」的实现，前两条照过。而那种实现的产品后果是：`.env` 的内容进了进程内存（也进了错误路径的射程）。

`.env.example` 与 `.env` 走同一格是刻意的：`HD-ENV` 匹配 `.env`、`.env.*` 与 `*.env`，
**`.env.example` 不在豁免名单里**。它是本仓库里最容易被「顺手放行」的一个路径 ——
它长得像模板、内容像占位符 —— 而放行它的代价是给「把真值填进模板」留了一条路。

### 5.2 身份字段是**输入违约**，不是「被忽略」

```
PASS 入参里的 approved 被拒绝（输入违约，不是「被忽略」） — code=INVALID_ARGUMENT details={"reason":"INPUT_SCHEMA_VIOLATION","field":"items","request_id":"req-lwb025"}
PASS 入参里的 user_id 被拒绝（输入违约，不是「被忽略」） — code=INVALID_ARGUMENT …
PASS 入参里的 session_id 被拒绝（输入违约，不是「被忽略」） — code=INVALID_ARGUMENT …
PASS 入参里的 conversation_label 被拒绝（输入违约，不是「被忽略」） — code=INVALID_ARGUMENT …
PASS 入参里的 principal_id 被拒绝（输入违约，不是「被忽略」） — code=INVALID_ARGUMENT …
```

**「被拒绝」与「被忽略」是两种不同的产品行为，本仓库要的是前者。** 「忽略」意味着
一个携带 `approved: true` 的调用会**正常成功**（只是那个字段不生效）——
于是模型从返回里学到的是「这个字段可以带」，而不是「这个字段不许带」。
契约用 `additionalProperties: false` 把它变成 `INVALID_ARGUMENT`，
断言的措辞因此逐字写着「不是『被忽略』」。

`principal_id` 也在这一组里：按 ADR-003 §4，它**只**能来自已认证的 IPC 通道身份，
不能来自工具参数。一个把 `principal_id` 收进参数的实现，等于把「我是谁」交给调用方填。

### 5.3 归属：不是自己的修改集，回答与「不存在」**逐字相同**

```
PASS 别的连接查不存在的 id 与查别人的 id：回答逐字相同 — 不存在={"code":"NOT_FOUND","message":"没有找到该修改集。","category":"business","auto_retry":"never","details":{"request_id":"req-foreign"}} 别人的={…（逐字相同）…}
PASS 两种回答的明细逐字相同，且没有任何判别键（只有审计关联 ID） — details keys=request_id 两条相同=true
PASS 对照：本连接查同一条 id 查得到
```

两条回答只要有一处不同（一个码、一句话、一个 `reason`），就是一个
**「本机是否存在这个 id」的预言机**。因此比较的是**整段 JSON**，不是「码相同」。

`details` 里那条 `request_id` 是每次调用都会带的审计关联 ID，两次回答里必然相同，
**它不是判别信息** —— 因此第二条断言要求「明细逐字相同**且**没有除 `request_id` 以外的键」。
一条 `reason=NOT_OWNER` 就足以把两种情况分开，而那是这条性质的全部意义。

**第三条是对照组，没有它前两条是恒真的。** 一个把所有查询都答成 `NOT_FOUND` 的实现，
能让前两条漂亮地通过。

### 5.4 `change_list` 列别人的工作区：空列表，不是拒绝

```
PASS change_list 里全部是本连接建立的修改集 — 1 条
PASS 列别人的工作区得到空列表而不是拒绝（否则那个 id 变成可穷举的） — 调用成功 data={"changes":[],"next_cursor":null,"truncated":false}
```

「拒绝」与「空列表」的选择在这里是**安全性质**，不是产品偏好：
一个对别人的工作区报错的实现，会让「这个工作区存不存在」变成一个可穷举的问题。
空列表让两种情况给出同一个答案。

### 5.5 游标

```
PASS change_get 不接受游标（单页工具） — code=INVALID_ARGUMENT details={"reason":"CURSOR_NOT_SUPPORTED","request_id":"req-lwb025"}
PASS change_list 的形状不对的游标被拒绝而不是从头开始 — code=INVALID_ARGUMENT details={"reason":"CURSOR_MALFORMED","request_id":"req-lwb025"}
```

`CURSOR_MALFORMED` 的取值是**拒绝**，不是**从头开始**。第二句那段措辞是有意的：
一个「游标坏了就返回第一页」的实现在分页语义下会沉默地重复内容，
而操作者看到的是「清单好像有两份一样的」。

### 5.6 幂等

```
PASS 同键同内容重放：同一条 change_id、idempotent_replay=true
PASS 同键换内容：返回冲突且不动既有修改集 — code=IDEMPOTENCY_CONFLICT details={"reason":"IDEMPOTENCY_KEY_REUSED","tool":"change_prepare","request_id":"req-lwb025"}
PASS 冲突之后既有修改集仍然是 PENDING_APPROVAL — state=PENDING_APPROVAL
```

第三条是前两条的补充：**冲突必须不动既有行**。一个「冲突了就覆盖掉旧的」的实现
能让前两条通过，而它的产品后果是：模型补发一次不同内容，操作者手上那条正在核对的提案
**在背后被换掉了** —— 而他核对的是摘要，摘要变了，他核对的那一屏已经不作数。

### 5.7 代次：两张票据来自不同代次，当场拒绝

```
PASS 被篡改的读取票据被拒绝 — code=READ_TOKEN_STALE details={"reason":"TICKET_BAD_SIGNATURE","request_id":"req-lwb025"}
NOTE 代次推进 — 1 → 2（bumpGeneration，与撤权/重登记同一条路）
PASS 同一份提案里两张票据来自不同代次：当场拒绝 — code=READ_TOKEN_STALE details={"reason":"TICKET_GENERATION_DISAGREE","request_id":"req-lwb025"}
PASS 对照：只拿旧代次那张票据也拒绝 — code=WORKSPACE_GENERATION_CHANGED details={"policy_check":"generation","policy_reason":"GENERATION_CHANGED","hard_deny_rule":null,"failure_count":1,"request_id":"req-lwb025"}
```

**这一格走过一次弯路，记在这里。** 第一版的做法是把票据尾部改掉几个字符，
期望走到 `TICKET_GENERATION_DISAGREE` —— 实际拿到的是 `TICKET_BAD_SIGNATURE`（票据先被验签），
于是那个分支一次都没被走到，而断言在**看错的理由上**通过了。
改法是**真的把代次推上去**（`repos.workspaces.bumpGeneration(workspace.id)`，与撤权/重登记同一条路），
在推进前后各读一个文件拿到两张**各自合法**的票据，再把它们放进同一份提案。

代次不只出现在这里：它是 §2、§3 里那些票据能被信任的原因 ——
读的时候工作区是第 N 代，提案的时候必须还是第 N 代，且**同一份提案里所有票据必须是同一代**。

---

## 6. 本任务记录在案的偏离

| # | 偏离 | 说明 |
| --- | --- | --- |
| 1 | 交付物路径与任务书草案不一致 | 任务书写的是 `apps/mcp-adapter/tools/changes.ts`；实际落在 **daemon 侧**（`apps/daemon/src/tools/{handlers,catalog,guard,access}.ts` + `packages/changes/src/query.ts` + `packages/contracts/src/tool-outputs.ts`）。理由与后果见 `docs/PROGRESS.md` 偏离项 97 |
| 2 | 纯 `create_text` 提案的代次回退 | 见偏离项 98 |
| 3 | 别名缺口：短名与硬链接指向被硬拒绝的目标 | 见偏离项 99 —— 由 **LWB-027** 的按对象身份复核收口 |
| 4 | 证据脚本第一版的 `why()` 措辞在肯定断言上会印出「（调用成功了，而它本该被拒绝）」 | 已改为二分的措辞（成功印 `data=…`，失败印 `code=… details=…`）。**这条改动本身是必要的**：一个在所有情况下都印「本该被拒绝」的断言说明会让一次真实的失败被读成噪音 |
| 5 | 证据脚本第一版不退出 | `PowerShellWinfsBackend` 的常驻 `pwsh` 助手持有管道，脚本打印完汇总后事件循环不空转，`EXIT=$?` 永远等不到。修法是 `finally` 里 `await backend.dispose()`（与 `lwb-017` / `lwb-020` 一致），并**放在 `rm` 之前** —— 助手活着的时候删不掉工作区 |

前三条是产品侧的（写在 `docs/PROGRESS.md` 的偏离项清单里），后两条是证据脚本自身的。

---

## 7. 可复现的测试命令与输出

```
$ node --import tsx scripts/evidence/lwb-025.ts
PASS 65 / FAIL 0 / NOT_RUN 4
LWB-025 RESULT PASS
EXIT=0

$ node scripts/run-tests.mjs
# tests 1252 # suites 197 # pass 1252 # fail 0 # skipped 0 # todo 0
NODE_EXIT=0

$ node scripts/run-tests.mjs tests/windows
# tests 210 # suites 23 # pass 210 # fail 0 # skipped 0 # todo 0
WINDOWS_EXIT=0        （真实 NTFS + 真实 pwsh 护栏 + 真命名管道）

$ node scripts/check-fsguard-imports.mjs
✅ FsGuard 导入检查通过（已检查 156 个文件，未发现绕过）。
FS_EXIT=0             （LWB-024 时为 155，新增的是 packages/changes/src/query.ts）

$ npm run test:console          # vitest run（happy-dom）
Test Files  2 passed (2)   Tests  41 passed (41)
VITEST_EXIT=0

$ npx tsc --noEmit
TSC_EXIT=0
```

**退出码是本节的唯一产出。** 一条无法复现的命令行不是证据，因此这里给出的是命令、
退出码与计数本身，而不是「测试通过」这句复述。

其中 `tests/windows` 那一行值得单独看：本任务的全部判定都建立在**真实 NTFS 句柄身份**上
（工作区副本的 `file_id` 与夹具不同、票据绑定的是打开后的对象），
因此它跑的不是替身而是真实护栏 —— 这一点在 §0 的 `PASS 工作区是夹具的副本而不是夹具本身` 里可以直接读到。

---

## 8. 未执行项（不得记为通过）

```
NOT_RUN 真实 ChatGPT 网页端完成一次提议→批准→回读 — 需要真实账号与 Secure MCP Tunnel 凭据；LWB-002 BLOCKED
NOT_RUN 批准之后确实落盘并逐文件核验 — 执行协调器属 LWB-026，尚未交付；本脚本一次批准都没有产生
NOT_RUN 拒绝之后工作区不变 — 拒绝入口在本机控制台（LWB-021 已单独取证）；本脚本从工具面无法产生拒绝
NOT_RUN 修改摘要后旧批准失效 — 批准入口在本机控制台（LWB-024 已单独取证）
```

四条是**同一类**：它们都是**批准侧**的断言，而本任务的工具面**没有批准入口** ——
批准只能由本地操作者在控制台上完成（这正是 ADR-003 与「模型不可批准」那条约束的形状）。

- 第 1 条是任务书原文的**步骤 3**（「真实网页测试批准前无文件变化、拒绝无变化、改摘要旧批准无效」）。
  它整条依赖真实网页，因此整条是 `NOT_RUN`。
- 第 2 条依赖 LWB-026（执行协调器）。**注意它与 §2 不是同一件事**：§2 证的是
  「提议不改文件」，它证的是「批准之后改文件」。
- 第 3、4 条的在别处取证：拒绝路径与「改摘要旧批准失效」分别由 LWB-021 / LWB-024 的证据覆盖，
  本脚本**无法从工具面产生**这两件事，因此不在这里复述它们的结论。

另外记一条本任务的**边界**（不是缺陷，是判据的前提）：

> **`BRIDGE_GATES` 是一个全为 `false` 的常量，是刻意的、需要人去改的。**
> 因此 §4 里那条 `PROPOSAL_READY` 配置是在**测试装置内**构造出来的，
> 不是生产装配根启动时的取值。要在生产装配根上观察那一格，需要有人真的去改那个常量 ——
> 而那正是 G0/G2/G3 的判定该做的事情，不是一次证据采集该做的事情。

---

## 9. 这次改动的文件

| 文件 | 变化 |
| --- | --- |
| `packages/contracts/src/tool-outputs.ts` | 新增三个工具的输出 schema 与数据类型（`change_prepare` / `change_get` / `change_list`） |
| `packages/audit/src/ranges.ts` | 新增 `change_*` 的文件访问提取器（出站可追踪要覆盖新工具） |
| `packages/changes/src/query.ts` | **新增**（668 行）：`NOT_FOUND` 单值化、归属判定、`viewFor`、`changeGetDataOf`、`changeListDataOf`、游标编解码、差异分页与出站脱敏 |
| `packages/changes/src/index.ts` | 导出查询层 |
| `apps/daemon/src/tools/handlers.ts` | 三个 `change_*` 处理器 |
| `apps/daemon/src/tools/catalog.ts` | `AVAILABILITY` 增三行；`readOnlyHint` 与说明文案 |
| `apps/daemon/src/tools/guard.ts` | `TOOL_POLICY_ACTIONS` 接线 |
| `apps/daemon/src/tools/access.ts` | `presented` 参数 |
| `packages/persistence/src/repositories.ts` | `ChangesRepo.list` 的复合游标 |
| `packages/files/src/text-diff.ts` | 从 `packages/git-reader/src/text-diff.ts` **移动**过来（`DIFF_MAX_DP_CELLS` 一并），使 `@lwb/changes` 不必经由 git-reader 才能渲染差异 |
| `packages/git-reader/src/{diff,limits}.ts` | 改为从 `@lwb/files` 取 |
| `tests/tools/harness.ts` | 夹具增补（`ops()` / `probe` / `contextFor`） |
| `tests/unit/daemon-tools.test.ts` | 随工具面扩到 10 条更新 |
| `tests/unit/mcp-adapter.test.ts` | **覆盖改成记录出来的**（见下） |
| `scripts/evidence/lwb-025.ts` | **新增**（1009 行）：本文件所有引文的来源 |

### 9.1 适配器测试的覆盖方式改了一次

`tests/unit/mcp-adapter.test.ts` 里那条「七个工具都能被调用到」原先的写法是：
一张静态入参表跑一遍，末尾拿名字数组与 `IMPLEMENTED_TOOL_NAMES` 对拍。
**那样一来「覆盖」证明的只是「表里写了这些名字」—— 表可以写全而一个都不真跑。**
现在 `covered` 只由**真正调用并成功**的工具名填充，末尾那句断言因此是在说
「这些工具都跑通了、结果都过了 `outputSchema`」。三个 `change_*` 的入参**只能**从前一步的结果里取
（`file_read` 的 `sha256` + `read_token`，`change_prepare` 的 `change_id`），
硬编码不出来。

---

## 10. 结论

三条验收标准逐条成立，对应到可复现的 `PASS` 行：

- **验收 1**：三个工具的说明各含全部要求的短语，`change_prepare` 的 `readOnlyHint=false`，
  两个写工具**不在清单上**。
- **验收 2**：5 次查询答案逐字相同、每一次都在 15 000 ms 上界之内（实测最慢 11.1 ms）、
  `change_get` 是单页工具。
- **验收 3**：穷尽 8 格门禁取值下，直写**有且仅有**在三条门禁全过时为真；
  在「§3 过、原生护栏未过」那条配置下真装配出来的工具面里，提议三件在、写两件不在。

**但没有任何一条证据采自真实 ChatGPT 网页端。** 因此：

- 本任务**不得**被读成「提议—批准闭环已在真实网页上可用」；
- **G3 未通过**（判定见 `docs/evidence/g3-proposal.md`）；
- `read_enabled` / `git_enabled` / `proposal_enabled` / `direct_write_enabled` 仍然**全部默认关闭**；
- 下一步（LWB-026 执行协调器与随后的真实写入）在契约冻结的前提下可以继续实现，
  但仍不得在真实仓库上联调（`docs/evidence/g2-read.md`）。
