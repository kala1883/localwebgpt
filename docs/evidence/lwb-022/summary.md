# LWB-022 · 实现状态机与幂等存储 — 证据

**采集方式：** `node --import tsx scripts/evidence/lwb-022.ts`（**退出码 0**；**34 PASS / 0 FAIL / 7 NOT_RUN / 2 NOTE**）
**采集环境：** Windows 11 Home China 10.0.26200 / Node v22.20.0 / tsx 4.23.15 / TypeScript 5.9.3 /
状态库 `schema_version=5`（迁移 1,2,3,4,5）/ 临时目录中的 **SQLite 文件库**（不是内存库）
**测试套件：** `tests/unit/change-state-machine.test.ts`（**32 例 / 7 组**，新增）+
`tests/unit/idempotency.test.ts`（**34 例 / 5 组**，新增）+
全仓 `tests 1164 / suites 185 / pass 1164 / fail 0`（LWB-021 时为 1098 / 175）
**静态检查：** `npx tsc --noEmit` 退出码 0；`node scripts/check-fsguard-imports.mjs` — **138 个文件**（LWB-021 时为 132），未发现绕过
**原始日志：** 未入库（`*.log` 在 `.gitignore` 中，与 `lwb-006` ~ `lwb-021` 一致）。
下文引用的每条 `PASS` / `NOTE` 行均为运行输出的**逐字**摘录。

**门禁结论：G2 未通过，本任务不得被读成「状态流转已验收」。** 三条验收标准的证据全部采自
临时沙箱与**合成内容**的修改集；**没有任何一次写入发生在真实工作区上**，也没有任何一次落盘
（LWB-026 未实现）。这符合 `docs/evidence/g2-read.md` 对 P3 的口径。

**本任务不访问文件系统，因此本脚本不设 Windows 门槛**（没有 `WINDOWS_ONLY` 早退）。
这一点本身是条信息：它说明「终态不可逆」不是靠某个平台调用实现的，而是纯状态与约束。

---

## 0. 这一轮的证据是在什么装置上采的

```
NOTE 状态库 — schema_version=5 迁移 1,2,3,4,5
NOTE 库文件 — C:\Users\mj\AppData\Local\Temp\lwb-evidence-022-yBUnWv\state.sqlite
NOTE 平台 — win32（本任务不访问文件系统，故不设 Windows 门槛）
PASS 0.1 转移表覆盖全部冻结状态（遍历的前提） — 修改集 13 态 / 操作 8 态 / 批准 4 态
PASS 0.2 墓碑态由转移表推出，且等于契约与冻结清单 — 修改集墓碑 REJECTED,EXPIRED,INVALIDATED,APPLIED,ROLLED_BACK,FAILED_NO_CHANGE,CONFLICT；操作墓碑 APPLIED,ROLLED_BACK,FAILED_NO_CHANGE,CONFLICT；批准墓碑 CONSUMED,REVOKED,EXPIRED
```

三件事决定了这轮证据能证明什么：

1. **库是文件库，而且用了第二条独立连接。** 本任务的核心断言是「保证住在数据库里，
   不住在进程内存里」（方案 §7.2：「网络断线、工具超时、进程重启都不能删除幂等事实」）。
   用内存库采这一条会**同义反复**：内存库随连接消失，而「消失之后还在」正是要被证明的事。
   因此 2.3 ~ 2.7 全部用**另一条 `openDatabase` + 另一个 `Repositories`** 发起，
   2.8 更是把主连接关掉再重开。
2. **行数一律走旁路连接。** 所有 `SELECT COUNT(*)` 都经由新开的连接执行（`countRows`），
   不借被测进程里的 `Repositories`。
3. **修改集的**内容**是合成的**（blob 行是真的、字节不是）。本任务三条验收只关于**状态与标识**，
   与文件内容无关；「prepare 在真实夹具上产出修改集」已由 LWB-020 在真实 NTFS 副本上采集过。
   在 LWB-022 里再跑一遍 prepare 只是把 LWB-020 的结论再说一次，却会让本脚本多依赖一层
   与它无关的装置。**这是一处刻意的取舍，不是遗漏**，因此写在这里而不是只在代码注释里。

---

## 1. 验收标准逐条

### 验收标准 2 · 不可从 APPLIED、REJECTED、EXPIRED 倒退到可再次执行状态

否定式断言，因此它是**遍历**出来的，不是读出来的：把转移表当图走闭包，检查终态能到达的
集合里有没有可执行状态。**先证明表覆盖了全部状态**（0.1），否则「表里没有某个状态」会让
这一条静默通过 —— 不在表里的状态可达集合为空，而空集里当然没有可执行状态。

```
PASS 1.1 每个终态的可达闭包里都没有可执行状态 — 走了 7 个可达状态，违规 0 个
PASS 1.2 非平凡性：可执行状态确实能从前面的状态到达 — PENDING_APPROVAL 可达 13 个状态
PASS 1.3 终态 × 可执行状态：一条边都没有 — 21 个组合，违规 0
PASS 1.4 夹具已走到 APPLIED
PASS 1.5 试图把 APPLIED 退回可执行状态：全部按终态拒绝 — QUEUED:TERMINAL_STATE VALIDATING:TERMINAL_STATE APPLYING:TERMINAL_STATE
PASS 1.6 拒绝之后状态与行数都没变 — state=APPLIED，changesets 1 行
PASS 1.7 三个墓碑（APPLIED / REJECTED / EXPIRED）退回 QUEUED 一律被拒 — APPLIED→QUEUED CHANGE_STATE_INVALID/TERMINAL_STATE | REJECTED→QUEUED CHANGE_STATE_INVALID/TERMINAL_STATE | EXPIRED→QUEUED CHANGE_STATE_INVALID/TERMINAL_STATE
PASS 1.9 操作态的四个墓碑没有出边 — APPLIED:0 出边 ROLLED_BACK:0 出边 FAILED_NO_CHANGE:0 出边 CONFLICT:0 出边
PASS 1.10 批准离开 ACTIVE 后回不去（应用层与触发器同一句话） — 墓碑 CONSUMED,REVOKED,EXPIRED
```

**1.2 是本段最容易被漏掉的一条。** 一张**全空的**转移表能让 1.1 通过 —— 而那样的表
什么也没保证。1.2 断言 `QUEUED / VALIDATING / APPLYING` 三个可执行状态**确实**
能从 `PENDING_APPROVAL` 到达，把 1.1 从「空集上没有违规」变成一句有内容的话。

**1.4 ~ 1.7 是在真库上真的走出来的。** `APPLIED` 不是直接改状态改出来的，而是沿着
`APPROVED → QUEUED → VALIDATING → APPLYING → APPLIED` 五跳走出来的；`REJECTED` 与
`EXPIRED` 也各自从 `PENDING_APPROVAL` 真走一步。然后才试着退回，并数 `changesets` 行数。

---

### 验收标准 1 · 并发重复调用收敛到同一操作

```
PASS 2.1 第一次排队：状态 QUEUED、操作创建、existed=false — op=op_0017，operations 1 行
PASS 2.2 换一个幂等键再排：被拒绝，操作数不变 — CHANGE_STATE_INVALID/(无 reason)，operations 1 行
PASS 2.3 第二条连接直接建操作：撞唯一索引，返回既有那一个 — kind=exists，返回 op_0017
PASS 2.4 两条连接看到的是同一个操作（保证住在数据库里） — operations 1 行
PASS 2.5 第二条连接重放排队：在任何写入之前被拒 — CHANGE_STATE_INVALID/(无 reason)
PASS 2.6 A 持立即事务时 B 的写入超时失败（无脏写） — SQLITE_BUSY：database is locked
PASS 2.7 提交后 B 重试撞唯一索引，仍然只有一个操作 — operations 2 行
PASS 2.8 重开数据库之后：操作仍在，重排仍被收敛（幂等事实不在内存里） — op=op_0017，重排 CHANGE_STATE_INVALID/(无 reason)
```

收敛由**两条独立机制**保证，2.2 与 2.3 分别打在它们身上：

| 机制 | 它挡的是什么 | 证据 |
| --- | --- | --- |
| 来源状态检查（表驱动） | 第二次调用**根本走不到写入** | 2.2、2.5 —— 失败发生在任何写入之前 |
| `UNIQUE(change_id)` | 状态检查被绕过时仍然只有一行 | 2.3、2.4、2.7 —— 另一条连接也只有一个操作 |

**2.6 证明的是串行化，不是并行下的行为**，这一点必须说清：`better-sqlite3` 是同步的，
同一进程内造不出两个真正并行的执行流。2.6 用「A 持立即事务时 B 的写入拿不到锁」证明
**没有丢失更新**（不是两边各写一份然后合并），而不是证明两个进程并行时的行为。
真正的多进程验证列在「未执行项」。

**2.8 是方案 §7.2 的逐字复核**（「进程重启都不能删除幂等事实」）：关掉主连接、重新打开、
重新查 —— 操作还在，重排仍然被收敛。

---

### 验收标准 3 · 所有未知结果都可以用 operation_id 查询，不要求重新发同一写任务

这条的实现方式是**签名**：`queryOperation` 的入参只有 `operation_id`，因此
「查询要求调用方记得别的东西」这种退化在类型上就写不出来。C1 用具例把它钉住
（`Parameters<typeof queryOperation>['length']` 必须是 `2`），3.8 在运行期复核。

```
PASS 3.1 排队中：IN_PROGRESS，且要求用 operation_id 查询（不是重发） — kind=IN_PROGRESS saved=false file_effect=unknown
PASS 3.2 写入并核验后：APPLIED / saved=true / file_effect=changed — kind=APPLIED verified_items=1
PASS 3.3 查询带回逐文件结果与追加日志（可核验，不是一句话） — items=1 journal=2 条
PASS 3.4 状态是 APPLIED 但没有逐文件回执：只报 UNKNOWN，不报已保存 — kind=UNKNOWN，operation.state=APPLIED
PASS 3.5 operation=APPLIED 但有一个文件是 UNKNOWN：结论升级为 NEEDS_RECOVERY — kind=NEEDS_RECOVERY unknown_items=[ci_0038]
PASS 3.6 写了一半（RECOVERY_REQUIRED）：NEEDS_RECOVERY，且禁止重发同一写任务 — kind=NEEDS_RECOVERY
PASS 3.7 查一个不存在的 operation_id：不抛错，答案是 UNKNOWN — found=false kind=UNKNOWN
PASS 3.8 查询只依赖 operation_id（查询签名里没有幂等键） — operation_id=op_0030
PASS 3.9 查询是只读的：行数与操作状态都没有变化 — operations 6 行，逐文件结果 2 行
PASS 3.10 七种答案里只有 APPLIED 的 saved 为真；三种「不知道」都要求查询 — IN_PROGRESS,APPLIED,FAILED_NO_CHANGE,CONFLICT,ROLLED_BACK,NEEDS_RECOVERY,UNKNOWN
```

**3.4 与 3.5 是「未知不是失败」最要紧的两条。**

- **3.4**：操作状态是 `APPLIED`，但一个逐文件回执都没有。此时报的是 `UNKNOWN` 而**不是**
  已保存 —— 「操作说成功」只是一句话，没有回执的成功是**没有证据的成功**。
- **3.5**：操作状态同样是 `APPLIED`，但有一个文件是 `UNKNOWN`。结论**升级**为
  `NEEDS_RECOVERY`。这一条体现的是优先级：**逐文件的事实压过操作自己的结论**。

**3.7** 是「未知不是失败」的另一面：查一个不存在的 id **不抛错**。抛错会让
「你抄错了 id」与「它真的不存在」在调用方看来是同一件事，而两者都不该让调用方去
**重发一次写任务**。

---

### 标识符与残余路径

```
PASS 4.1 七个形状不合法的标识符全部被解析函数拒绝 — 空串=IDENTIFIER_EMPTY 太短=IDEMPOTENCY_KEY_TOO_SHORT 太长=IDENTIFIER_TOO_LONG 含换行=IDENTIFIER_CONTROL_CHARS 含 NUL=IDENTIFIER_CONTROL_CHARS 非字符串=IDENTIFIER_NOT_A_STRING 查询 id 为空=OPERATION_ID_REQUIRED
PASS 4.2 残余路径（状态检查被绕过）：existed=true 且没有新建第二个操作 — existed=true op=op_orphan_0050，operations 6 → 7 行
PASS 4.3 同一个幂等键用于两个修改集：仍然是两个操作（键只是记账） — op_0060 vs op_0061
PASS 4.4 没有操作记录时是 UNKNOWN（不是失败） — kind=UNKNOWN message=现有记录不足以判定本次写入的结果；请用 oper…
```

**4.1 是本轮证据抓到的一处缺陷，见第 2 节 2.1。** 4.3 复核方案 §7 的原话
（「相同 change_id 无论几个 apply 键，只关联一个 operation」的**反面**）：
幂等键只记账，不参与「要不要新建操作」的判定 —— 两个修改集共用一个键，仍然是两个操作。

**品牌类型「不可互赋」这一条不在本脚本里**，因为它只在编译期存在（运行期就是字符串）。
它的验证在 `tests/unit/idempotency.test.ts` 里用 `@ts-expect-error` 钉住，由
`npx tsc --noEmit` 核对；`@ts-expect-error` 的方向是反的 —— 保证被悄悄删掉时它才报错。

---

## 2. 一处**产品缺陷**，是本轮证据抓到的

### 2.1 三个拒绝分支里有一个不带 `reason`

`packages/idempotency/src/ids.ts` 的 `requireIdentifier` 有三条拒绝路径，其中两条带
`details.reason`（`IDENTIFIER_TOO_LONG` / `IDENTIFIER_CONTROL_CHARS`），而
「不是字符串 / 是空串」那一条**没有**：

```ts
// 修改前
if (typeof value !== 'string' || value.length === 0) {
  throw new BridgeError('INVALID_ARGUMENT', `字段 ${field} 必须是非空字符串。`);
}
```

证据脚本 4.1 的断言是「七个不合法形状**各自**报告一个非 `undefined` 的理由」，
它把这一条抓了出来：

```
FAIL 4.1 七个形状不合法的标识符全部被解析函数拒绝 — 空串=undefined 太短=IDEMPOTENCY_KEY_TOO_SHORT 太长=IDENTIFIER_TOO_LONG 含换行=IDENTIFIER_CONTROL_CHARS 含 NUL=IDENTIFIER_CONTROL_CHARS 非字符串=undefined 查询 id 为空=OPERATION_ID_REQUIRED
```

**为什么这是个缺陷而不是风格问题：** 本工程对拒绝的要求是「说清是哪一种」
（`tests/unit/approvals.test.ts` 的原话：只说「抛了个错」不足以证明拒绝的是这件事）。
「不是字符串」与「是空串」的排障方向完全不同 —— 一个要去查调用方传错了类型，
一个要去查传了一个空值 —— 合成一句会让回报里只剩「参数不对」。

**修法：** 拆成两条，各自的理由名说清自己是什么（`IDENTIFIER_NOT_A_STRING` /
`IDENTIFIER_EMPTY`）。第 4.1 条随后转绿。单元测试 `idempotency.test.ts` A3 同步收紧，
把这两个理由名钉住。

---

## 3. 交付物

| 文件 | 性质 | 内容 |
| --- | --- | --- |
| `packages/changes/src/state-machine.ts` | 新增 | 三张转移表（修改集 / 操作 / 批准）、图遍历、表检查、与仓储层的接线 |
| `packages/changes/src/single-flight.ts` | 新增 | 同键单飞锁（从 `prepare.ts` 移出，供两处共用） |
| `packages/idempotency/` | 新增包 | `ids.ts`（四个品牌标识符）、`outcome.ts`（七种答案）、`operations.ts`（排队与查询）、`index.ts` |
| `packages/contracts/src/change.ts` | 修改 | 补 `OperationState` / `OPERATION_STATES` / `APPROVAL_STATES` |
| `packages/contracts/src/limits.ts` | 修改 | 补 `MIN/MAX_IDEMPOTENCY_KEY_CHARS` |
| `packages/contracts/src/tools.ts` | 修改 | 幂等键 schema 改为读 `LIMITS`，不再各写一个数字 |
| `packages/approvals/src/decide.ts` | 修改 | `approveAndQueue` 改为两步流转 + 委托 `queueOperation`（见第 4 节 4.1） |
| `packages/approvals/src/gate.ts` | 修改 | `EXECUTION_STATES` 指向 `@lwb/changes` 的 `EXECUTION_CHANGE_STATES` |
| `packages/changes/src/prepare.ts`、`index.ts`、`packages/approvals/package.json` | 修改 | 接线与导出 |
| `tests/unit/change-state-machine.test.ts` | 新增 | 32 例 / 7 组 |
| `tests/unit/idempotency.test.ts` | 新增 | 34 例 / 5 组 |
| `scripts/evidence/lwb-022.ts` | 新增 | 34 PASS / 0 FAIL / 7 NOT_RUN |

---

## 4. 偏离项

### 4.1 `approveAndQueue` 从「一步跳」改成「两步走」（顺带修掉一处与方案 §8.1 不符）

**原先的实现**在同一个事务里把修改集从 `PENDING_APPROVAL` 直接推进到 `QUEUED`。
方案 §8.1 的状态图里**没有这条边**（骨架是 `PENDING_APPROVAL → APPROVED → QUEUED`）。

这不是形式问题。加上这条边的代价是：**「绕过批准直接排队」变成一条合法转移**，
从此任何调用点都能这么写，而状态机再也说不出「QUEUED 的唯一前驱是 APPROVED」。
因此改的是**代码**而不是图 —— 现在两步都走，`queueOperation` 的两条调用路径
（控制台的「批准并应用」与将来的执行器）用同一个 `from: ['APPROVED']`。

**原子性没有变化**：两步在同一个**立即事务**里（`Repositories.transaction`），
外界看不到中间的 `APPROVED`，LWB-021 验收标准 1（「三件事同生同死」）的用例全部照旧通过。
这一点有回归用例钉住：`change-state-machine.test.ts` D5 断言
`PENDING_APPROVAL → QUEUED` **不是**一条边。

**这处不符合是被 LWB-022 的新表检查抓出来的**，而不是被读代码读出来的：
`transitionChange` 的表检查让 LWB-021 的三条用例当场变红。

### 4.2 数据库**不**禁止终态回退，挡它的是应用层

方案 §7.2 要求状态流转「使用数据库条件更新」—— 实现是
`ChangesRepo.transition` 的 `WHERE state IN (…)` 加 `@lwb/changes` 的表检查，两层都在
应用侧。本库**没有**「终态不得流转出去」的触发器。

这一条是被**量出来的**，不是推断的（第 1 节 1f）：

```
NOTE 边界：库层不挡终态回退 — 直接 UPDATE 可以把 APPLIED 改回 QUEUED（改动 1 行）；挡它的是 @lwb/changes 的转移表与 ChangesRepo.transition 的条件写（应用层），不是数据库触发器 —— 见「未执行项」与偏离项
```

**这不是「验收标准 2 没达成」**：验收标准说的是系统行为，而系统里**没有**任何一条路径
能发出那条 SQL（`scripts/check-fsguard-imports.mjs` 让业务包只能经 `Repositories` 触达库）。
但它是**纵深防御上的一个缺口**，而且缺口位置很扎眼：同一个迁移文件里，
`changesets_terminal_tombstone` 已经为**删除**写了这句保证，却没有为**更新**写。

**建议（不在本任务范围内，交给 LWB-024/026 或下一次迁移）：** 照
`approvals_no_reactivate` 的样子加一条 `BEFORE UPDATE ON changesets`，
`WHEN OLD.state IN (墓碑) AND NEW.state <> OLD.state` 时 `RAISE(ABORT)`。
本任务不做，理由有二：任务书的交付物里没有迁移；且迁移文件是**校验和冻结**的，
新增迁移有跨任务影响，不该由本任务顺手改掉。

### 4.3 `queueOperation` 的 `change_id` 收品牌类型，代价是每个边界多一行转换

`QueueOperationInput.change_id` 是 `ChangeId`（品牌），而项目里既有的调用点手上都是
普通 `string`。品牌挡住的是**隐式**赋值（比如把刚查回来的 `OperationId` 顺手当成
`change_id` 传进去「重新排一次队」），代价是每个边界要显式写一次 `asChangeId(...)`。

**这个取舍的边界要说清**：`as*` 四个解析函数的入参是 `unknown`（它们必须如此 ——
未受信输入进来时就是一个不知道类型的东西），因此 `asChangeId(someOperationId)`
**可以**编译通过。品牌挡的是隐式赋值，**不是**显式重新贴标签。这是有意的：
显式那一步会把函数名摆在那里，在评审里看得见；隐式赋值看不出来。

---

## 5. 脱敏

- 采集全程在临时目录（`%TEMP%\lwb-evidence-022-*`）内进行，脚本结束时删除。
- 本任务不读文件内容、不写文件、不启动任何外部进程、不发任何网络请求。
- 状态库里没有密钥：`connections` 行只有别名与 `principal_kind`，令牌与 secret 不落库
  （`@lwb/secure-store`）。夹具用的影子值全是合成的十六进制串，不是任何真实哈希。
- 日志中的绝对路径是临时目录，不含用户名以外的信息。

---

## 6. 未执行项（不得记为通过）

脚本以 `NOT_RUN` 逐条列出（输出中为 `NOT_RUN` 行，共 7 条）：

| 未执行项 | 为什么 |
| --- | --- |
| 真的两个进程并行发起同一次排队 | `better-sqlite3` 同步，同进程造不出并行执行流。2.6 证明的是**串行化**，不是并行行为。真正的多进程验证需要两个 daemon 进程，而装配根（`main.ts`）尚不存在 |
| 数据库层禁止终态回退 | 本库没有这样的触发器（见 4.2）。1f 已经**量到**直接 UPDATE 可以改回去 |
| 写入真的落盘、然后回滚 | LWB-026 未实现；本任务交付物里没有任何写文件的代码路径。第 3 节的状态是仓储层直接推出来的 |
| 批准被消费（ACTIVE → CONSUMED） | 消费发生在执行器认领操作时（LWB-026）。本脚本全程未消费任何批准 |
| 在真实工作区上联调 | G2 未通过（LWB-002 BLOCKED）；P3 门禁：不得在真实仓库上联调 |
| 在真实 ChatGPT 网页端确认模型无法自行排队 | LWB-002 BLOCKED。MCP Inspector 的成功不能替代它 |
| 品牌类型「不可互赋」的**运行期**证据 | 品牌只在编译期存在。该条由 `tsc --noEmit` + `@ts-expect-error` 核对，运行期无法复现 |

---

## 7. 负向回归

| # | 反例 | 期望 | 覆盖 |
| --- | --- | --- | --- |
| 1 | 从 `APPLIED` 退回 `QUEUED` / `VALIDATING` / `APPLYING` | `TERMINAL_STATE` 拒绝，状态与行数不变 | 1.5、1.6、1.7 |
| 2 | 从 `REJECTED` / `EXPIRED` 退回 `QUEUED` | 同上 | 1.7 |
| 3 | 从 `APPLIED` 走到 `ROLLED_BACK`（「合法」的去处也不许） | `TERMINAL_STATE` | `change-state-machine.test.ts` D2b |
| 4 | 来源集合里混入终态 | 拒绝（检查**每一个**来源，不是只看 `from[0]`） | D3 |
| 5 | 来源里已含目标（`APPLIED → APPLIED`） | `NO_OP`，比 `TERMINAL_STATE` 更精确 | D1 |
| 6 | 来源集合为空 | `INTERNAL_ERROR` / `NO_SOURCE_STATES`，不是「悄悄成功」 | D6 |
| 7 | `PENDING_APPROVAL → QUEUED`（绕过批准排队） | 图里没有这条边，`ILLEGAL_EDGE` | D5、B5、4.2 |
| 8 | 换一个幂等键重排同一个修改集 | 被拒，操作数不变 | 2.2 |
| 9 | 绕过状态检查直接建第二个操作 | 撞 `UNIQUE(change_id)`，返回既有操作 | 2.3、2.4、2.7、4.2 |
| 10 | A 持立即事务时 B 写入 | `SQLITE_BUSY`，无脏写 | 2.6 |
| 11 | 进程重启后重排 | 仍被收敛，操作还在 | 2.8 |
| 12 | `APPLIED` 但没有逐文件回执 | 报 `UNKNOWN`，不报已保存 | 3.4 |
| 13 | 逐文件有 `UNKNOWN` 而操作是 `APPLIED` | 升级为 `NEEDS_RECOVERY` | 3.5 |
| 14 | 逐文件是 `RECOVERED_ORIGINAL`（与「已应用」矛盾） | 不算回执，降级 | `idempotency.test.ts` D7 |
| 15 | 查一个不存在的 `operation_id` | 不抛错，答 `UNKNOWN` | 3.7 |
| 16 | 空串 / 非字符串 / 含换行 / 超长 / 太短的标识符 | 各自被拒，**且各自带理由** | 4.1（抓到 2.1 的缺陷） |
| 17 | 同一个幂等键用在两个修改集上 | 仍然是两个操作（键不参与判定） | 4.3 |
| 18 | 借 `request_id` 当幂等键、借 `OperationId` 当 `ChangeId` | 编译错误 | `idempotency.test.ts` 类型钉子（`tsc` 核对） |

---

## 8. 回退

- 本任务**没有任何运行时开关**：它是纯逻辑与约束，没有引入新的能力。
  回退 = 撤掉 `packages/idempotency/` 与 `packages/changes/src/state-machine.ts`，
  并把 `approveAndQueue` 的排队部分恢复成内联写法（4.1 的两步流转要保留，
  否则会重新踩回「绕过批准排队」那条边）。
- **不涉及用户文件**：本任务不写盘，回退不需要动任何用户数据，
  因此「不得通过覆盖用户文件实现代码回滚」这条约束在本任务里没有触发条件。
- 状态库**向前兼容**：本任务**没有新增迁移**（`KNOWN_SCHEMA_VERSION` 仍是 5），
  因此回退不需要降级数据库；库里已有的 `changesets` / `operations` 行在新旧代码下同义。
- 未决恢复数据：本任务不产生新的恢复状态；`RECOVERY_REQUIRED` 的处置仍归 LWB-026。
