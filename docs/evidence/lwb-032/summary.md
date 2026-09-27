# LWB-032 · 实现应用工具与操作查询 — 证据

**采集方式：** `node --import tsx scripts/evidence/lwb-032.ts`（**退出码 0**；**125 PASS / 0 FAIL / 6 NOT_RUN**）
**采集环境：** Windows 11 Home China 10.0.26200 / Node v22.20.0 / win32 x64 / PowerShell 7.6.6 / **真 NTFS**（`%TEMP%` 下的临时工作区）
**测试套件：** 见文末「测试套件」一节（类型检查、FsGuard 导入检查、`node --test` 各自的退出码与计数）
**原始日志：** 未入库（`*.log` 在 `.gitignore` 中，与 `lwb-006` ~ `lwb-031` 一致），
本次运行落在 `docs/evidence/lwb-032/raw.log`。下文引用的每条 `PASS` / `NOTE` 行均为运行输出的**逐字**摘录；
唯一的例外是少数长 JSON 回执被 `…` 截短（截短处不影响该行要说明的事实，完整值在 `raw.log` 里）。

**门禁结论：G0 与 G2 均未通过，G1 无裁定记录。** 本任务把 `change_apply` 接到了工具面上，
于是**模型第一次有了一个可以真的改动用户文件的工具** —— 因此这份证据的重点不是「它能写」，
而是「它凭什么才肯写」：一次调用只有在**绑定到唯一修改集摘要、一次性、有有效期**的
本地批准记录存在时才会落地（§2.2），而模型侧**连把 `approved` 传进来的机会都没有**：
那个字段过不了输入 schema（§2.7）。`change_apply` 的说明文案里没有一句正向承诺，
并且逐条禁止「未取得终态回执就宣称文件已保存」（§1.2 / §1.3）。

**这一轮里最要紧的一句话：回执不是一句话，是逐文件的两个真哈希；而「还没结论」是一个合法的回答。**
`tests_run` 恒为 `false`（§3.10）—— 落盘不等于通过测试；等待预算到点时返回的是
`in_progress: true` 而不是「已保存」（§6.1 ~ §6.5）；重复调用无论换不换幂等键都落到
**同一条操作**上（§4.4 / §4.5），而且护栏写入调用次数**一次都不增加**（§4.8 / §4.13）。

---

## 0. 这一轮的证据是在什么装置上采的

四条步骤的原文：

> 1. change_apply 只处理已批准修改集，返回稳定 operation_id；控制台批准并应用走相同服务。
> 2. 快速完成返回实际回执；未完成返回 RUNNING，后续使用 change_get 查询。
> 3. 重复调用无论是否使用同一幂等键，均返回该修改集唯一操作。
> 4. 工具说明禁止模型在未取得终态回执时宣称文件已保存。

三条验收标准的原文：

> (a) 网页批准/本地批准的差异有清晰提示，本地批准不可省略。
> (b) 断网、超时、重复点击和重复工具调用不产生第二次写。
> (c) 回执包括逐文件哈希和 tests_run:false，不把落盘当成功通过测试。

| 段 | 装置 | 为什么非这样不可 |
| --- | --- | --- |
| §0 | 真 NTFS 工作区 + 真 `PowerShellWinfsBackend` + 真 MCP 适配器 server + 真 `Client` | 本轮修掉的两处缺陷（回执折叠、重复调用的判定顺序）**在库这一层都看不见** —— 只有从适配器那一端发一次真的工具调用，才会走到出问题的那条路径上 |
| §1 | `tools/list` 的原始回包 | 步骤 4 管的是**模型看到的那段文字**；测契约里的常量不等于测模型实际收到的东西（§1.12 证明两者逐字相同） |
| §2 | 真提案 → 真本地批准 → 真 `change_apply` | 验收 (a) 的「本地批准不可省略」要的是「**没有**它时真的写不进去」，而那是要真跑一次才知道的 |
| §3 | 回执 vs **脚本自己独立读回的字节** | 验收 (c) 说回执要带逐文件哈希；自说自话的哈希不算证据 |
| §4 | 换键 / 不换键 / 并发两次调用 | 步骤 3 与验收 (b)；判据落在**护栏写入调用次数**上，比表行和指纹都更靠底层 |
| §5 | 控制台 `approveAndQueue` 与工具面各走一次 | 步骤 1 说「走相同服务」；「相同」的可核对形式是**同一个 `operation_id`** |
| §6 | 把原生应用器卡在写入前，`wait_ms: 0` 调用 | 步骤 2 的「未完成」在真盘上只有一种造法：让写入**真的**停在那儿 |
| §7 | 关掉 `direct_write_enabled`（其余照旧） | 重放走的是回执面，而回执是一条**出站**通路；这一格钉的是它不能成为绕开读开关的口子 |
| §8 | 关掉门禁 / 全局暂停，各自前后各取一次指纹 | 回退约束与验收 (b)：拦住之后**未决数据仍在**，而「拦住」这件事本身不得碰过用户文件 |

**装置自述（§0 逐字）：**

```
PASS §0.1 原生护栏后端可用（真 CreateFileW / WriteFile / FlushFileBuffers） — backend=powershell-pinvoke exclusive_handle=true flush=true 身份=true
PASS §0.2 跨文件事务为假（I11：一次执行的原子性不覆盖用户文件） — crash_atomic_replace=false
NOTE §0.3 平台 — win32 x64 / Node v22.20.0
PASS §0.5 工作区根真的是一个 NTFS 目录，且身份由**当场探测**得到 — volume_id=c6e22015…(8) file_id=00d60000000a…(16)
PASS §0.6 适配器列出的工具里有 change_apply — 共 12 个工具
```

§0.5 是这一整套证据的地基：工作区身份不是写死在夹具里的字符串，而是**当场**向
卷与文件问出来的（`volume_id` + `file_id`）。路径前缀在这个仓库里从来不是身份
（I05 / I03），所以任何一条「写到了对的地方」的结论，都必须踩在当场取回的
对象身份上。

---

## 1. 模型看到的是一个什么样的工具（步骤 4）

`change_apply` 的说明文案不是随手写的。§1.2 逐条断言它在说四件事，
§1.3 断言它**没有**说三句话：

```
PASS §1.2 工具说明里有「只有 APPLIED 才算落盘」 — 找「只有 state=APPLIED 才代表已落盘」
PASS §1.2 工具说明里有「in_progress 时不许说已保存」 — 找「绝不能」
PASS §1.2 工具说明里有「未完成时改查 change_get」 — 找「change_get」
PASS §1.2 工具说明里有「重复调用安全」 — 找「不会产生第二次写入」
PASS §1.3 工具说明里没有正向承诺「文件已保存」
PASS §1.3 工具说明里没有正向承诺「已写入成功」
PASS §1.3 工具说明里没有正向承诺「可以告诉用户已完成」
PASS §1.4 工具说明点明本工具**不产生批准**
PASS §1.5 工具说明点名 approved 这类参数不被接受
PASS §1.6 工具说明里不含本机绝对路径
```

§1.4 与 §1.5 值得单独说一句：这两句不是「友善提示」，而是把
`docs/` 里那几条禁止的反模式**写在了模型看得见的地方** ——
「模型永远不能自己批准」这件事，最便宜的防线就是别让它以为可以。

输入面同样是穷举过的：

```
PASS §1.7 change_apply 的输入只有 change_id 与 idempotency_key — 实际：change_id,idempotency_key
PASS §1.8 输入 schema 是严格的（additionalProperties=false）
PASS §1.9 change_apply 在策略表里有自己的一行 — action=change_apply
NOTE §1.10 策略动作 — change_apply → change_apply；change_get → snapshot_read
```

§1.12 这一格排除了「有两份文案」这种最容易悄悄发生的漂移：

```
PASS §1.12 适配器列出的描述**逐字**来自契约（没有第二份文案） — 契约长度=308 适配器长度=308
PASS §1.13 适配器列出的输入 schema 与契约里的字段集合一致 — 适配器=change_id,idempotency_key 契约=change_id,idempotency_key
```

---

## 2. 没有本地批准，它就写不进去（验收 a）

```
PASS §2.1 提案停在 PENDING_APPROVAL（本地批准不可省略） — state=PENDING_APPROVAL
PASS §2.2 没有本地批准时 change_apply 被拒绝，错误码是 APPROVAL_REQUIRED — code=APPROVAL_REQUIRED details={"reason":"APPROVAL_MISSING","request_id":"req-no-approval"}
PASS §2.3 被拒绝的应用**一个字节都没写**
PASS §2.4 被拒绝的应用**不建立操作行**
PASS §2.5 被拒绝的应用不产生护栏写入调用 — writes=[]
PASS §2.6 拒绝文案里不含本机绝对路径
```

三条「零」是同一个结论的三层：**盘上没变**（§2.3）、**账上没留**（§2.4）、
**护栏压根没被叫**（§2.5）。最后一层最要紧 —— 前面两层都可能是「写了又撤掉」，
而 `writes=[]` 排除了那个可能。

夹带身份字段的那一次：

```
PASS §2.7 approved / user_id 这类字段**连输入 schema 都过不去**（不是「传了但不生效」） — code=INVALID_ARGUMENT details={"reason":"INPUT_SCHEMA_VIOLATION","field":"approved,user_id","request_id":"req-no-approval"}
PASS §2.8 夹带身份字段的那次调用同样零写入
```

§2.7 的措辞是刻意的：`approved: true` 在这一层**不是**「被忽略」，而是
**请求根本不被受理**。这与 ADR-003 §4 那条禁止的反模式
（`if (args.approved) { apply(); }`）之间，不止隔着一次判空。

补上批准之后：

```
PASS §2.9 补上本地批准之后同一条修改集正常落地 — 调用成功 data={"change_id":"chg_073618bf-…","operation_id":"op_e36413886605469fa2e7b83a1811c995","state":"APPLIED","in_progress":false,"recovered":false,"files":[{"path":"note.txt","state":"VERIFIED","before_sha256":"c3f9c8c283a
PASS §2.10 落地时真的写了盘（护栏写入调用恰好一次） — writes=["writeFileGuarded(note.txt)"]
```

---

## 3. 回执是逐文件哈希，不是一句「成功」（验收 c）

```
PASS §3.2 终局状态是 APPLIED — state=APPLIED
PASS §3.4 回执带一个稳定的 operation_id — operation_id=op_14da94412…(35)
PASS §3.6 成功的逐文件结果只能是 VERIFIED — state=VERIFIED
PASS §3.7 before_sha256 等于**本脚本独立读回的**修改前字节 — 回执=c3f9c8c283a2…(64) 盘上（改前）=c3f9c8c283a2…(64)
PASS §3.8 after_sha256 等于**本脚本独立读回的**修改后字节 — 回执=ff4bebae5b91…(64) 盘上（改后）=ff4bebae5b91…(64)
PASS §3.9 提案声明的目标与盘上的结果一致（回执不是自说自话）
PASS §3.10 tests_run 恒为 false —— 落盘不等于通过测试 — tests_run=false
PASS §3.11 盘上真的变了字节
```

§3.7 与 §3.8 的比较对象是**脚本自己去读盘算出来的哈希**，不是回执里的另一个字段。
这是整份证据里为数不多的「用一个独立来源去核另一个来源」的地方；没有它，
§3.6 的 `VERIFIED` 就只是回执自己说自己好。

回执只有一个来源：

```
PASS §3.12 change_get 查得到同一条操作
PASS §3.13 change_get 的 operation_id 与 change_apply 的同一条
PASS §3.14 **两个工具给出逐字相同的逐文件回执**（回执只有一个来源）
PASS §3.15 operations 表上只有一行
PASS §3.17 回执逐字等于 `operationReceiptFor` 那条（写入侧没有第二份回执实现）
PASS §3.18 回执里不含本机绝对路径
PASS §3.19 回执里的路径是工作区内相对路径 — path=note.txt
```

§3.17 是**本轮修掉的一处真实缺陷**所在：写入那条路径原来自己拼回执，
于是同一个问题有两个答案，而这正是「回执说成功、盘上不是」的温床。
现在两条路径都折同一个函数（`operationReceiptFor`，它把执行日志折成逐文件结论），
§3.14 与 §3.17 分别从工具面和实现面把它钉住。

---

## 4. 重复调用不产生第二次写（步骤 3、验收 b）

```
PASS §4.4 同键重试返回**同一条** operation_id — 第一次=op_8f225c753…(35) 重试=op_8f225c753…(35)
PASS §4.5 换键重试返回**同一条** operation_id
PASS §4.6 重试的回执与第一次逐字相同（不是一份「看起来一样」的对象）
PASS §4.7 重复调用**一个字节都没再写**（指纹含修改时刻）
PASS §4.8 重复调用**没有产生第二次护栏写入** — 第一次之后=1 现在=1
PASS §4.9 operations 表上仍然只有一行
```

§4.7 的指纹是**大小 + 最后写入时刻 + 内容哈希**三样。只比内容的话，
「先写回原样再写一遍」这种第二次写是看不出来的；带上 `mtime` 才关得掉。

并发两次：

```
PASS §4.11 并发两次调用：成功的那几次给的是同一条 operation_id
PASS §4.12 并发之后 operations 表仍然只有一行
PASS §4.13 并发之后护栏写入调用恰好一次 — writes=["writeFileGuarded(note.txt)"]
```

§4.13 是本段最底层的一条判据。表上只有一行、指纹没变，都可能由「两次都执行了、
其中一次恰好没改动字节」造成；而**护栏被调用了几次**没有这种歧义。

**本轮修掉的第二处真实缺陷**就在这里：原先「已经应用过」的修改集再被调用时，
工具面拿到的是一句「批准已被消费」（`APPROVAL_CONSUMED`）—— 一次重复点击
换来的是一句关于批准内部的错误，而模型据此能得出的结论是「这次没成功」。
现在判定入口是 `canBeginWrite`（`operations` 表上还没有这一行 / 还停在 `QUEUED`），
不可认领的那些状态一律走重放，重放**走回执面**、按 `change_get` 的策略动作判定。
`tests/unit/change-receipt.test.ts` 用穷举把这条判据单独钉住，并且要求它与
应用服务读的是同一个导出函数（复制一份出来就不会跟着变）。

---

## 5. 两个入口、一件事（步骤 1）

```
PASS §5.1 控制台「批准并应用」把修改集推到排队，并建立唯一那条操作 — state=QUEUED operation=op_927a0a21f…(35)
PASS §5.4 工具面在控制台之后调用仍然成功
PASS §5.5 **两个入口落到同一条 operation_id** — 控制台=op_927a0a21f…(35) 工具面=op_927a0a21f…(35)
PASS §5.7 工具面拿到的逐文件回执与控制台逐字相同
PASS §5.9 护栏写入调用恰好一次 — writes=["writeFileGuarded(shared.txt)"]
```

「走相同服务」不是靠读代码确认的，是靠**同一个 `operation_id`** 确认的。
`packages/executor/src/apply-service.ts` 是那个唯一的服务；控制台与工具面
都经由它排队，因此 §5.9 的「恰好一次」是结构上的必然，而不是两次实现碰巧一致。

---

## 6. 没等到结论时，如实回答（步骤 2、验收 b）

这一段把原生应用器**真的卡在写入之前**（闸门），再用 `wait_ms: 0` 调用：

```
PASS §6.1 等待预算到点时**仍然成功返回**（不是超时错误） — state=VALIDATING in_progress=true
PASS §6.2 回执里 in_progress 为真 — in_progress=true
PASS §6.3 状态是执行中的那三个之一（不是终局） — state=VALIDATING
PASS §6.5 「没等到结论」不是「已保存」：此刻盘上还是原样
PASS §6.6 此刻已经有一条操作行了（但一次真正的写入还没发生）
PASS §6.7 执行中重放**成功返回**（不是一句关于批准的错误）
PASS §6.8 执行中重放只能得到「还在执行」 — state=VALIDATING
PASS §6.11 重放不得产生护栏写入调用 — writes=[]
PASS §6.12 装置自检：写盘必须真的被卡住过，否则本段什么都没验到
```

§6.12 是这一段的**自检**：如果闸门其实没卡住，那么 §6.1 ~ §6.11 全都会通过，
而它们证明的东西一件也没有。装置自检在这里不是修辞。

放行之后：

```
PASS §6.13 被放弃的等待也必须有终局 — state=APPLIED
PASS §6.14 放行之后的回执里带的是真哈希 — 回执=7b9a72466d39…(64) 盘上=7b9a72466d39…(64)
PASS §6.15 放行之后盘上真的写了一次
PASS §6.16 护栏写入调用恰好一次 — writes=["writeFileGuarded(slow.txt)"]
PASS §6.18 事后拿到的是 APPLIED 且 in_progress 为假
PASS §6.20 回执里那句「改用 change_get 查询」是可执行的
```

§6.20 验的是**文案的可执行性**：回执让模型改用 `change_get`，那就真的调一次
`change_get`，确认它查得到。一句没人验过的指引，迟早会指向一个查不到的地方。

---

## 7. 重放走的是回执面（本轮修复点）

```
PASS §7.2 直写关掉之后，**一次真正的写入**被拒绝 — code=POLICY_DENIED details={"policy_check":"connection","policy_reason":"CAPABILITY_FLAG_DISABLED",…}
PASS §7.3 拒绝的理由是那条开关本身（CAPABILITY_FLAG_DISABLED）
PASS §7.4 被拒的写入不建立操作行
PASS §7.5 **已经应用过的那条仍然答得出回执**（重放按读面判定）
PASS §7.8 重放给出的逐文件哈希仍然等于盘上的字节
PASS §7.9 重放不得再写一次
PASS §7.10 重放之后护栏写入调用仍然只有一次 — writes=["writeFileGuarded(note.txt)"]
PASS §7.11 读取能力关掉之后，重放同样被拒绝（回执不是绕开开关的口子）
```

这一段是本轮修掉第一处缺陷时顺带定下的**边界**：重放不执行写入，
但它仍然是一条**出站**通路（`change_receipt` 在 `EGRESS_SURFACES` 里），
所以它不能跳过策略判定。§7.2 与 §7.5 合起来说明这两件事被分开了：
**同一条修改集，写被拒、读仍答**；而 §7.11 说明读开关一关，回执也一起关 ——
回执不是绕过开关的口子。

---

## 8. 门禁与暂停：不可用时不许「看起来能用」（回退约束）

```
PASS §8.1 门禁关掉之后，已批准的修改集也写不进去 — code=POLICY_DENIED … CAPABILITY_FLAG_DISABLED
PASS §8.2 门禁关着时不得写盘
PASS §8.3 门禁关着时不得建立操作行
PASS §8.4 门禁关着时不产生护栏写入调用
PASS §8.5 门禁关掉之后，那条**未决**修改集仍然在（没有借机关掉数据） — state=APPROVED
PASS §8.6 它的条目与批准都还在（未决数据被保留，不是被清理） — items=1 approvals=1
PASS §8.7 关掉开关这件事本身**没有碰过用户文件**（回滚不能靠覆盖用户文件实现）
PASS §8.8 门禁重新打开之后，**同一份批准**仍然有效（上面那次拒绝确实是门禁造成的）
```

§8.5 ~ §8.7 是回退约束的**可核对形式**：「关闭相关能力开关」不得变成
「顺手把未决数据清了」，也不得变成「覆盖用户文件」。
§8.8 是这一段的对照组 —— 少了它，§8.1 的拒绝可能只是「那条批准本来就没用」。

暂停：

```
PASS §8.9 全局暂停时 change_apply 被拒绝，错误码是 PAUSED — code=PAUSED
PASS §8.10 暂停期间不得写盘
PASS §8.11 暂停期间不得建立操作行
PASS §8.12 暂停不改变修改集状态（只是拦住这次执行） — state=APPROVED
PASS §8.13 暂停解除之后，同一份批准仍然能落地
```

---

## 9. 交付物

```
PASS §9.1 交付物存在：packages/executor/src/apply-service.ts — 应用服务：控制台与工具面共用的那一个
PASS §9.1 交付物存在：apps/daemon/src/tools/handlers.ts — changeApply 与 replayApplied
PASS §9.1 交付物存在：packages/changes/src/execution-journal.ts — 日志折叠的共享词汇
PASS §9.1 交付物存在：packages/changes/src/query.ts — operationReceiptOf 折日志
PASS §9.1 交付物存在：tests/windows/daemon-apply-tool.test.ts — 真 NTFS 验收用例
PASS §9.1 交付物存在：tests/unit/change-receipt.test.ts — 回执折叠的穷举用例
```

任务书里写的交付物是 `apps/mcp-adapter/tools/apply.ts`。**这一条是偏离**，理由与
LWB-031 的同类偏离一致：本仓库的适配器是一层**纯传输**，它的 `tools/list` 逐字
转发契约里的描述与 schema（§1.12 正是这一点的证据），工具的实现在守护进程的
工具面这一侧。真按任务书的路径放，就会出现第二份文案与第二份 schema ——
而那正是 §1.12 要排除的东西。偏离已记入 `docs/PROGRESS.md`。

---

## 未执行项（必须标明的 NOT_RUN）

```
NOT_RUN 真实 ChatGPT 网页端批准一次应用 — G0 未通过；LWB-002 BLOCKED（无真实账号与隧道凭据）
NOT_RUN 网页批准与本地批准的差异在**界面上**的呈现 — W4 控制台界面尚未实现；本任务只到服务层（方案 §10.2）
NOT_RUN 断网（传输中断）之后的重放 — 需要真实隧道；本轮构造的是**超时**（§6）与**重复调用**（§4），不是断网
NOT_RUN 进程被杀 / 断电之后的重放 — 属 LWB-033 的崩溃专项；启动恢复本身已在 LWB-030 取证
NOT_RUN 两个进程同时应用同一条修改集 — 属 LWB-033 的竞争专项；本轮的并发是**同进程内**两次调用（§4.11）
NOT_RUN Git 暂存区不受影响 — 本任务不碰 Git；LWB-031 §8 已就 `change_revert_prepare` 取证过
```

验收 (a) 里「网页批准/本地批准的差异有清晰提示」这半句**没有**被本轮的证据覆盖：
本轮证明的是「本地批准不可省略」（§2.2）与「模型侧的 `approved` 不被受理」（§2.7），
而**界面**上那句话要等 W4 控制台（方案 §10.2 的主按钮「批准并应用」）。
把它标成 NOT_RUN，而不是拿 §2.2 去充数。

---

## 回退约束的落实

任务书原文：**关闭相关能力开关；保留执行日志与未决恢复数据；不得通过覆盖用户文件实现代码回滚。**

三条在本轮证据里的对应位置：

- **关闭开关**：`direct_write_enabled` 关掉后真正的写入变成 `POLICY_DENIED` /
  `CAPABILITY_FLAG_DISABLED`（§7.2），门禁关掉后已批准的修改集也写不进去（§8.1），
  全局暂停给出 `PAUSED`（§8.9）—— 三种「关法」都不写盘、不建操作行
  （§8.2 ~ §8.4、§8.10 ~ §8.11）。
- **保留未决数据**：门禁关掉期间，那条未决修改集仍在（§8.5），条目与批准都在（§8.6）。
- **不靠覆盖用户文件回滚**：关掉开关这件事本身没有碰过用户文件（§8.7）。

---

## 这一轮里发现并改掉的几处

**三处是代码里的真实缺陷。** 它们的共同点是「在库这一层看不见」：单元测试与库级用例
都是绿的，缺陷出现在**工具面把库用起来之后**的那条路径上 —— 这也是本文件的证据
非要从真 MCP 适配器发真调用不可的原因（§0 的表格）。

1. **回执折错了表**（`packages/changes/src/query.ts`）。
   `operation_item_results` 看起来就是「逐文件回执」的现成答案，但它**只有 `@lwb/recovery` 会写**，
   一次干净跑完的应用从来不往它里面插行。只读它的话，一次**成功**的应用会给出逐文件
   `UNKNOWN` + 两个哈希都是 `null`，而本任务的验收标准要的正是「回执包括逐文件哈希」。
   更糟的是它**看起来**像事实：`UNKNOWN` 是合法取值，读的人只会以为「这次没记下来」。
   真值来源是执行日志，折叠规则与 LWB-031 的撤销**共用**（`execution-journal.ts`）。
   钉住它的两格是 §3.14（两个工具逐字相同）与 §3.17（逐字等于 `operationReceiptFor`）。
2. **「执行中重放」掉进了认领，答的是一句关于批准的话**（`packages/executor/src/apply-service.ts`）。
   判定原本是「不是执行中的状态就返回」，于是**执行中**那一格掉进了认领，而批准在认领那一刻
   就被消费了 —— 调用方问「写完了没有」，得到的是 `APPROVAL_CONSUMED`。
   判据换成 `canBeginWrite`（不可认领）之后，「不可认领」与「不可能产生第二次写」是同一件事。
   钉住它的是 §6.7 ~ §6.11（写盘被真的卡住时重放，拿到「还在执行」且护栏调用次数不增）。
3. **审计范围表对 `change_revert_prepare` 的本机方案路径取不出来**（`packages/audit/src/ranges.ts` + 契约）。
   在路径成为结构化字段之前，本机方案的路径**只**存在于两句散文里，于是审计会把一次
   「模型手上明明拿到了文件名」的调用记成「什么也没读」。一条记不出事实的记录比没有记录更糟：
   它会被人当成结论。修法是让路径成为字段（`change.files[].path` 与 `local_actions[].path`）。

**另外两处改的是装置本身，不是产品。** 记在这里是因为它们同样值钱，而且**都曾以
「随机红」的面目出现过**：

4. **两条时钟混用**。工具面那口钟是**锚定**的，而协调器工厂若忘了传 `now` 就退回真实当下；
   批准与修改集的有效期却是工具面那口钟盖的章。于是一个用例里会出现「默认协调器能过、
   工厂协调器过期」，失败落在「批准已过期」上。修法是把 `now` 做成**必填** ——
   忘传是一处编译错误，而不是一次难查的红。
5. **控制平面测试因连接池复用而偶发红**。`tests/unit/control-plane.test.ts` 偶尔报
   `TypeError: fetch failed`（栈在 undici 里），两次观察到的失败点还落在**不同的**用例上，
   因此极容易被当成噪声忽略。根因是 undici 的**进程级**连接池 + 系统把同一个临时端口
   分给下一个用例。这一条本文件不留 `PASS`，因为它**不属于本任务**：它在本任务期间被
   猎到、定位并修掉，逐条记在 `docs/PROGRESS.md` 的偏离项 130。

五处都记在 `docs/PROGRESS.md` 的偏离项 **126–130**；交付物路径与任务书草案的不一致另记在 **131**。

---

## 测试套件

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查（全部包与适配器） | `npx tsc --noEmit` | 退出码 0，无输出 |
| 类型检查（控制台） | `npm run typecheck:console` | 退出码 0 |
| FsGuard 导入检查 | `npm run check:imports` | ✅ 已检查 **171** 个文件，未发现绕过 |
| 单元与真盘测试 | `npm run test` | **1548** tests / 244 suites / **0 fail** |
| 控制台测试 | `npm run test:console` | 41 passed (41) |
| 本任务新增的真盘用例 | `node scripts/run-tests.mjs tests/windows --grep daemon-apply-tool` | 11 tests / 1 suite / **0 fail** |
| 本任务新增的回执折叠用例 | `node scripts/run-tests.mjs tests/unit --grep change-receipt` | 20 tests / 3 suites / **0 fail** |
| 本任务新增的那一格源码自检 | `node scripts/run-tests.mjs tests/unit --grep control-plane` | 75 tests / 19 suites / **0 fail**（改动前为 74） |
| 以上五步的合取 | `npm run check` | **退出码 0** |
| 本任务交付的证据脚本 | `node --import tsx scripts/evidence/lwb-032.ts` | **退出码 0**；125 PASS / 0 FAIL / 6 NOT_RUN |

（逐次计数与历史对比见 `docs/PROGRESS.md` 的「当前仓库事实」一节 —— 本文件不重复抄写
一份会在下一次提交后过期的数字。全套件从上一轮的 1515 / 239 涨到 1548 / 244，这 **+33**
是逐文件数出来的：`change-receipt` +20（新）、`daemon-apply-tool` +11（新）、
`control-plane` +1（自检）、`daemon-tools` +1；`mcp-adapter` 改了很多行但用例数没变。）

**可复现性：** 本文件落地之前又独立跑了一遍证据脚本，两次的 158 行输出里**有 44 行不同**，
但每一行的**判定**（PASS / FAIL / NOT_RUN）与每一行里**由内容决定的值**都逐字节相同 ——
两次的 `digest` 都是 `cef450b38ca2…`、`short_code` 都是 `CEF4-50B3`、回执里的
`before_sha256` / `after_sha256`、行区间、理由串全都一样。不同的是**随机标识与临时路径**：
`chg_*` / `op_*` 的 uuid、`§0.5` 里那个临时目录的 NTFS `file_id`、`§4.7` 的 `mtime`
（它是真的修改时刻，不是常数）。这条是刻意分开写的：**「跑出来对」和「每次都跑出同一件事」
不是同一句话**，而这里要断言的正是前者 —— 脚本里凡是需要「每次都同一件事」的地方
（摘要、哈希、终局判定）都确实同一，凡是天生随机的（新 id、新目录）都如实随机。

**门禁：G0 未通过、G1 无判定记录、G2 未通过、G3 未通过、验收负责人未指定。**
本任务的证据**不**改变其中任何一条 —— 它覆盖的是「应用工具怎么接上工具面、回执从哪里来」
这一层，而它与真实仓库联调的许可仍以 `docs/evidence/g2-read.md` 的那句为准：
「P3 的编辑与审批可以在契约冻结的前提下继续实现，但**不得**在真实仓库上联调。」
**四个能力开关在本任务交付后照旧全关**，因此工具面仍然一律 `POLICY_DENIED` ——
`change_apply` 接进来了，不等于它现在能用。

