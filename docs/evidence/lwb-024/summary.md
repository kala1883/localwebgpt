# LWB-024 · 失效与保留（三条验收标准） — 证据

**采集方式：** `node --import tsx scripts/evidence/lwb-024.ts`（**退出码 0**；**37 PASS / 0 FAIL / 5 NOT_RUN / 1 NOTE**）
**采集环境：** Windows 11 Home China 10.0.26200 / Node v22.20.0 / tsx 4.23.15 / TypeScript 5.9.3
**测试套件：** `tests/unit/changes-invalidation.test.ts`（**77 例 / 6 组**，新增，node 运行器）+
全仓 `tests 1234 / suites 195 / pass 1234 / fail 0`（LWB-023 时为 1193 / 189）+
`apps/console/tests/*.spec.ts` **41 例 / 2 文件**（vitest，本任务未改动，仍全绿）
**静态检查：** `npx tsc --noEmit` 退出码 0；`node scripts/check-fsguard-imports.mjs` —
**148 个文件**（LWB-023 时为 147），未发现绕过
**原始日志：** 未入库（`*.log` 在 `.gitignore` 中，与 `lwb-006` ~ `lwb-023` 一致）。
下文引用的每条 `PASS` / `NOTE` 行均为运行输出的**逐字**摘录。

**门禁结论：G2 未通过，本任务不得被读成「失效与清理已在真实仓库上可用」。** 三条验收标准的证据
全部采自**合成的工作区 / 连接 / 修改集**与**临时目录里的真实字节**；没有任何一次工作区收缩
作用在真实仓库上（G2 未通过，且 `docs/evidence/g2-read.md` 要求 P3 不得在真实仓库上联调）。
**执行协调器 `packages/executor/coordinator.ts`（LWB-026）尚未交付**，因此「不会自动落盘」这句话
在本任务里能证到的是**门的那一侧**（所有入口都拒绝），不是**文件的那一侧**（文件真的没被写）。
这条差别被写成了 `NOT_RUN`，没有与 `PASS` 合并。

**本任务不启动外部进程、不发网络请求。** 唯一的真实副作用是 §3 里对**临时目录**（`os.tmpdir()`
下 `mkdtemp` 出来的目录）中真实文件的回收，`finally` 中被 `rm -rf` 兜底清理。

---

## 0. 这一轮的证据是在什么装置上采的

三条验收标准的原文说的分别是**判定**、**判定**、**磁盘**：

> 离线前批准、重连后过期的任务**不会自动落盘**。
> 权限缩小时**不能应用**老计划。
> 清理**不会删除**运行中、待恢复或仍在撤销窗口的快照。

前两条的落点是同一个函数 `evaluateApplyGate`，第三条的落点是 `BlobStore.collectGarbage`。
两者的装置不同，因此分开采集：

| 段 | 装置 | 为什么非这样不可 |
| --- | --- | --- |
| §1 §2 | **真 SQLite**（`:memory:`）+ 真仓储 + 真时钟注入 | 这两条标准说的都是「同一批行、两个时刻」或「一批行、一次收缩」。用假仓储写断言，等于把「行是不是真的这么落的」这一半留给想象；而 `expires_at`、代次、`state` 恰恰都在行上 |
| §3 | **真字节** + 真 `BlobStore.collectGarbage` | 「清理不会删除」只有数**磁盘上还剩几个文件**才算证到。对内存里的引用计数做断言，证明不了它没删文件 |
| §6 | 真 `scripts/run-tests.mjs` | 见 §6：单测的**退出码与计数**是本段唯一的产出，复述一句「测试通过」不是证据 |

§1 §2 的每一个用例都在**真**库上先断言一次「收缩**之前**放行」。没有这条前置，「收缩之后被拒绝」
可能来自任何别的原因 —— 包括一个恒真的拒绝。§2.1 的五条收缩路径逐条都是这个形状：

```
工作区被停用：收缩前=放行 → 收缩后=WORKSPACE_DISABLED（全部理由 WORKSPACE_DISABLED+GENERATION_CHANGED，码 PAUSED，状态未改=true）
工作区被移除：收缩前=放行 → 收缩后=WORKSPACE_REMOVED（全部理由 WORKSPACE_REMOVED+WORKSPACE_DISABLED+GENERATION_CHANGED，码 WORKSPACE_NOT_GRANTED，状态未改=true）
工作区代次前移（重定位 / 重新授权）：收缩前=放行 → 收缩后=GENERATION_CHANGED（全部理由 GENERATION_CHANGED，码 WORKSPACE_GENERATION_CHANGED，状态未改=true）
策略版本变化（连带代次前移）：收缩前=放行 → 收缩后=GENERATION_CHANGED（全部理由 GENERATION_CHANGED+POLICY_VERSION_CHANGED，码 WORKSPACE_GENERATION_CHANGED，状态未改=true）
归属连接被本地操作者禁用：收缩前=放行 → 收缩后=CONNECTION_DISABLED（全部理由 CONNECTION_DISABLED，码 CONNECTION_DISABLED，状态未改=true）
```

**这一段的判据是三条，不是一条**：放行过、被拒绝、**理由具名且只有那几条**。只断言「被拒绝」，
一个把所有情况都判成拒绝的实现同样通过。

---

## 1. 验收标准 1 —— 离线前批准、重连后过期不会自动落盘

```
同一批落库事实：T0(2026-09-25T10:00:00.000Z) → ready；2026-09-25T10:11:00.000Z → refused/APPROVAL_EXPIRED
PASS 1.1 前提：T0 时刻这条计划是放行的（否则后面的拒绝可能来自别的原因）
PASS 1.2 离线 11 分钟后落在批准有效期之外：门禁拒绝，理由是「批准过期」
PASS 1.3 行没有变、只有 now 变了 —— 判定是每次现算的，不是读排队时写下的标志位 — 同一 change_id、同一批准 id、同一份摘要，两个时刻两个答案
PASS 1.4 拒绝之后批准行本身没有被改写（只判定，不写） — 落库状态仍是 ACTIVE，被投影成 EXPIRED 的只是判定结果
PASS 1.5 对照：同一时刻、同一修改集，换一份未过期的批准后又放行 — 新批准 apr_0006；实际 ready
PASS 1.6 重连清理收掉的是**批准**（1.5 新签的那份到点作废），修改集仍是 APPROVED — 2026-09-25T10:22:00.000Z 一轮收掉 0 个修改集、1 条批准；修改集状态 APPROVED（它自己的有效期到 2026-09-26T10:00:00.000Z）
PASS 1.7 批准过期此时是**行上的事实**，不再只是判定时的投影：门禁给的理由与 1.2 相同，来源换了
PASS 1.8 批准仍有效、修改集自己到期了：拒绝来自修改集那条 24 小时有效期 — 批准 ACTIVE（2026-09-25T10:10:00.000Z 到期），修改集有效至 2026-09-25T10:01:00.000Z
PASS 1.9 判定不消费：两次判定（放行一次、拒绝一次）前后，状态与日志逐字段相同 — {"change_state":"APPROVED","approvals":["apr_0016:ACTIVE"],"operation_state":null,"journal":[]}
PASS 1.11 越过修改集自身的有效期后再清一次：那一行被收成 EXPIRED，并出现在清理报告里 — 2026-09-26T10:01:00.000Z 收掉 3 个修改集；状态 EXPIRED
```

### 1.1 为什么这条标准要分成 1.2 / 1.3 / 1.4 三问

「不会自动落盘」这句话本身不可观测 —— 可观测的是**判定为什么变**。1.2 证拒绝，1.3 证拒绝的
**成因必须是 `now`**：同一 `change_id`、同一批准 id、同一份摘要，只换 `now` 就换答案。若判定读的是
排队时写下的标志位（`is_valid: true` 之类），两个时刻必然给出同一个答案，1.3 当场失败。

1.4 是 1.3 的反面：**拒绝是一个投影，不是一次写**。批准行仍是 `ACTIVE`，被投影成 `EXPIRED` 的只是判定结果。
这一条挡的是「判定顺手把行改了」那种实现 —— 它同样能让 1.2 通过，但代价是每次排障性质的判定
都在改库，而「查询不写库」是这个项目反复要求的性质（见 LWB-022 的 idempotency 取证）。

1.5 是对照组。没有它，「1.2 拒绝了」就也可能是撞上了别的判据；有了它，同一时刻同一修改集
**换一份未过期的批准又放行**，拒绝的成因被夹到只剩批准有效期这一条。

### 1.2 两个不同的时钟（本任务修掉的一处混淆）

批准的有效期是 **10 分钟**（`LIMITS.APPROVAL_TTL_MS`），修改集是 **24 小时**（`LIMITS.CHANGE_TTL_MS`）。
它们不是同一个时钟，1.6 与 1.11 分别从两侧取证：

- **1.6** 在 `T0 + 22 分钟`清一次：收掉的是**批准**（1 条），修改集**原地不动**（仍是 `APPROVED`，
  它自己的有效期到次日 `T0 + 24h`）。
- **1.11** 越过 `T0 + 24 小时`再清一次：被收成 `EXPIRED` 的是**那一行**，并出现在清理报告里。

只做其中一侧，另一侧的实现可以全错而全绿：一个把「批准过期」当成唯一过期判据的实现，
会留下一份 24 小时后仍然 `APPROVED` 的老计划；一个只收修改集不看批准的实现，会留下
一份 `EXPIRED` 的修改集挂着一份 `ACTIVE` 的批准 —— 而那正是门禁最想避免的组合。

1.8 证的是第三条边：批准**仍然有效**、修改集自己到期了，拒绝的理由是 `CHANGE_EXPIRED`，
且这个判定同样不消费批准（`ttlApproval.state === 'ACTIVE'`）。

### 1.3 `NOTE 1.10` —— 这段话证到哪一步

```
NOTE 1.10 「不自动落盘」这句话在本次采集里能证到哪一步 — 能证：通往写入的那道门（门禁 + 执行前复核）在所有入口上都拒绝，且拒绝不依赖调用方的自述。不能证：文件真的没被写 —— 写入方是执行协调器（LWB-026），尚未交付，因此本脚本观察不到一次真实的落盘尝试。这一条列在文末的未执行项里
```

**把这条写成 `NOTE` 而不是 `PASS` 是刻意的。** 「门拒绝」与「文件没被写」在证据强度上不是一回事：
一个把门禁接在写入**之后**的装配，两条断言都过，文件却已经被写了。因此文末那条 `NOT_RUN`
与本节并列存在，不互相顶替。

---

## 2. 验收标准 2 —— 权限缩小时不能应用老计划

### 2.1 门禁可达的那一侧（2.1 ~ 2.3）

五条收缩路径逐条取证见 §0 的摘录。2.2 / 2.3 是**批量**入口：按工作区或按连接失效。
两者都断言了**别人分毫未动**（`repos.changes.requireById(b.change_id).state === 'APPROVED'`）——
只断言「我那条被作废了」，一个把全库作废的实现同样通过。

### 2.2 撤销批准，与「再签一份复活不了它」（2.4 ~ 2.6）

```
PASS 2.4 失效把挂在身上的批准一并收掉，并记下它去了哪里 — approval_to=REVOKED trigger=WORKSPACE_RELOCATED
PASS 2.5 被失效的修改集：门禁拒绝，理由是「批准已被撤销」（批准这一格先于状态被问） — APPROVAL_REVOKED / APPROVAL_EXPIRED
PASS 2.6 再签一份批准在数据库层是允许的，但它复活不了这个计划 — 新批准 apr_0067 落库状态=ACTIVE；门禁=refused
```

2.5 与 2.6 是一对，缺一条就不成立：

- 2.5 问「失效之后门禁说什么」。答案是 `APPROVAL_REVOKED`。**这一格最初写的是
  `CHANGE_STATE_INVALID`，是错的** —— 门禁**先问批准、再问修改集状态**，而一份已被撤销的批准
  是更具体的答案。这条次序不是实现细节：它决定了操作者在界面上看到的是哪一句话。
- 2.6 是它的补充取证。`approvals.create` 在数据库层**会成功** —— `approvals_active_uq` 是一个
  `WHERE state = 'ACTIVE'` 的**部分**唯一索引，只挡「第二条 ACTIVE」，而它只重核摘要。
  因此「再签一份批准」挡不住任何东西，**挡住复活的必须是修改集已经不在 `APPROVED`**。
  在这一刻批准那一格变得无可指摘，拒绝的理由因此变成 `CHANGE_STATE_INVALID`。

只做撤销不做失效，等于把一次明确的「停」变成「再点一下就能继续」；只做失效不撤批准，
会留下「修改集已作废、批准却还是 ACTIVE」的组合（`invalidation.ts:406` 的注释说明了收批准
必须在改状态**之前**：反过来的话，一次崩溃就留下那个组合）。

### 2.3 理由的**全集**与次序（2.7 ~ 2.10）

```
PASS 2.7 多因同时成立时理由**一条不少**，且按固定次序排列（排列与发现顺序无关） — 实际 WORKSPACE_REMOVED+WORKSPACE_DISABLED+GENERATION_CHANGED+CONNECTION_DISABLED
PASS 2.8 十条理由全部被点到名：七条有真实门禁入口，三条今天只有纯函数入口 — 门禁可达 7 条；纯函数 3 条
PASS 2.10 每个理由都映射到一个错误码（映射表是全函数） — WORKSPACE_MISSING→WORKSPACE_NOT_GRANTED WORKSPACE_REMOVED→WORKSPACE_NOT_GRANTED WORKSPACE_DISABLED→PAUSED GENERATION_CHANGED→WORKSPACE_GENERATION_CHANGED POLICY_VERSION_CHANGED→WORKSPACE_GENERATION_CHANGED CONTRACT_VERSION_CHANGED→WORKSPACE_GENERATION_CHANGED OWNER_CONNECTION_MISSING→NOT_AUTHORIZED CONNECTION_DISABLED→CONNECTION_DISABLED CHANGE_EXPIRED→CHANGE_STATE_INVALID CHANGE_STATE_INVALID→CHANGE_STATE_INVALID
```

`reasons` 与 `primary` 是两个不同的答案，两处对同一批事实必须一致：`primary` 是给操作者的
**一句话**，`reasons` 是排障要的**全景**。2.7 断言 `reasons` 是固定次序的**子序列**
（与发现顺序无关），2.1 断言每一格的全部理由都逐字对得上。

**2.8 里那句「三条今天只有纯函数入口」不是免责声明，是判据。** 三条理由逐条给出了装置与
不可达原因，摘录：

```
  WORKSPACE_MISSING: WORKSPACE_MISSING
    门禁不可达的原因：`workspaces` 没有删除路径（移除走的是 markRemoved + 代次前移），因此「行不在了」今天造不出来。而判据仍必须有：库文件被外部改动、或将来加入清理时，它就是那条路径
  OWNER_CONNECTION_MISSING: OWNER_CONNECTION_MISSING
    门禁不可达的原因：`connections` 没有删除路径（禁用走 setEnabled），同上
  CONTRACT_VERSION_CHANGED: CONTRACT_VERSION_CHANGED
    门禁不可达的原因：它的真实触发是**契约升级**：升级前建立的修改集停在库里，升级后重连时被判为不可执行。要经由门禁触发就得真的改掉 CONTRACT_VERSION 并重建修改集，那会把仓库自身的状态带进证据里
```

「今天造不出来的那三条写它做什么」这个问题有一个具体答案：它们不是**今天的**路径，是**库文件
被外部改动**或**将来加入清理**时的路径。把它们删掉，那些情况会以「一个没被判据覆盖的输入」
出现，而不是以「一个已知的缺口」出现。

---

## 3. 验收标准 3 —— 清理不会删除运行中、待恢复或仍在撤销窗口的快照

这一段的装置与 §1 §2 不同：**真字节**。夹具在临时目录里落 12 个对象文件，引用计数打到零，
然后调用**生产模块本身**的 `BlobStore.collectGarbage`。

```
PASS 3.1 前提：这些快照的字节真的在磁盘上，且引用计数已经是零 — 磁盘上 12 个夹具文件（期望 12）；待回收 12 个
  逐条判据：running=IN_EXECUTION validating=IN_EXECUTION awaiting=AWAITING_RECOVERY young=WITHIN_RETENTION_WINDOW old=(不在保护清单里) diverged=AWAITING_RECOVERY
  计数：{"IN_EXECUTION":2,"AWAITING_RECOVERY":2,"WITHIN_RETENTION_WINDOW":1,"NOT_TERMINAL":11}
PASS 3.2 运行中的两个、待恢复的两个（含分叉的那一个）、窗口内的一个都在保护清单里 — 分叉那条=AWAITING_RECOVERY（只看修改集状态会漏掉它）
PASS 3.3 窗口右端是「终结时刻 + 保留期」，差一毫秒仍受保护、正好到期就不受保护 — retain_until=2026-10-08T10:00:00.000Z
  磁盘文件数：回收前 12 → 回收后 10；本轮回收 2 个对象、跳过 10 个
PASS 3.4 磁盘上少掉的**恰好**是窗口已满的那两个文件（不是「少了几个」，是「就是那两个」） — 删掉 2 个，全部属于窗口已满的那一条；留下 10 个
PASS 3.5 运行中、待恢复（含分叉）与窗口内的字节一个都没少，且仍标记为待回收 — 留下的仍然只是「待回收」，没有被顺手改成别的状态
PASS 3.6 跳过时给出了具名理由（「跳过」不能是一句无声的什么都不做） — 该快照属于一次正在执行中的写入，回收会让它在半途失去原始字节。 | 该快照属于一次待恢复的操作，回收会让回滚取不到原始字节。 | 该快照仍在撤销窗口内（保留期未满），回收会让操作者无法回退这次写入。
PASS 3.7 反向探针：撤掉 protect 后，窗口内的与运行中的字节**都被删了** — 没有 protect 时本轮删掉 4 个 —— 因此 3.4/3.5 里那些「留下」是判据挣来的，不是没东西可删
PASS 3.8 全局谓词为假时确实什么都不删 —— 但那让这条标准空洞地成立，所以它替不了逐对象判据 — refusal_reason=存在在途操作或未决恢复，拒绝回收。
PASS 3.9 这些受保护的快照引用计数全部是零（保护不是靠引用计数挣来的） — 判据问的是「谁还可能需要这些字节」，而不是「计数是多少」
```

### 3.1 3.7 与 3.8 —— 这一段最关键的两条

**3.7 是反向探针。** 3.4 / 3.5 说的是「**这些**留下了」。一个把 `protect` 写死成
「全部保留」的实现能让 3.4 / 3.5 全部通过 —— 只要那 12 个文件本来就不该被删。3.7 撤掉 `protect`
再跑一次同一个 `collectGarbage`，**4 个**（窗口内的 + 运行中的）当场被删。于是 3.4 / 3.5 里那些
「留下」是**判据挣来的**，不是「没东西可删」。

**3.8 是一条自我否定式的取证。** `collectGarbage` 原本有一个全局谓词
`isSafeToCollect`，它为假时整轮回收被拒。这条标准**可以**靠它空洞地成立：只要在有任何在途
操作时拒绝整轮回收，「不会删除运行中的快照」就永远为真 —— 因为什么都不删。3.8 显式地把这条
路走了一遍并记录它的 `refusal_reason`，然后说明为什么它替不了逐对象判据：

> 一个全局布尔值说不出「这一批里，运行中的那些留下、撤销窗口已满的那些删掉」这句话。
> 用全局为真去代替它，会删掉仍在窗口内的字节；用全局为假，则让「清理不会删除正在使用的
> 快照」空洞地成立。 —— `packages/blob-store/src/store.ts` 的注释

代码里的这段话与 3.8 的断言是同一段推理的两侧，因此 `protect` 是一次**新增**而不是替换，
`isSafeToCollect` 原样保留，四条条件（待回收 + 全局安全 + 逐对象保护 + 有仓储）**同时**成立才删。

### 3.2 分叉的那一个（E2 暴露的一处真实缺陷）

夹具里有一个**故意分叉**的装置：修改集是 `QUEUED`，它的操作是 `RECOVERY_REQUIRED`。
这个装置暴露了一处真实缺陷：

`planSnapshotRetention` 原本用 `OperationsRepo.listUnfinished()` 取「在途操作」。那个方法问的是
**「上一个进程留下了什么」**（为 LWB-030 的启动恢复准备的），而保留策略问的是
**「这些字节还有人在等吗」**。两者的差集正是 `RECOVERY_REQUIRED`：一个**已经不在运行、
但明确在等恢复**的操作，在 `listUnfinished` 的语义里不算「未完成」。于是它会从保护清单里
漏掉，回收照删，而那一刻回滚取不到原始字节。

修法是新增 `OperationsRepo.listByStates(states)`，并由转移表推出集合 —— 不写死清单：

```
PASS 5.1 可失效 ⊆ 未终结，且两者**不是**同一个集合（分界点在「写入是否已经开始」） — 可失效 3 个 / 未终结 6 个
PASS 5.2 「不可失效」不等于「已终结」：清理不能凭前者认为事情结束了 — 差集 VALIDATING,APPLYING,RECOVERY_REQUIRED
```

§5 的这两个集合都由 `CHANGE_TRANSITIONS` / `OPERATION_TRANSITIONS` **推出**，而不是手抄：

```
  可失效 PENDING_APPROVAL,APPROVED,QUEUED
  未终结 PENDING_APPROVAL,APPROVED,QUEUED,VALIDATING,APPLYING,RECOVERY_REQUIRED
  待批准 APPROVED,PENDING_APPROVAL,QUEUED
```

5.2 的那条差集是这张表的**用途**：`VALIDATING` / `APPLYING` / `RECOVERY_REQUIRED` 三个状态
**不可失效、但也没终结**。清理不能因为「它已经不能失效了」就认为这件事结束了 —— 那三个状态
恰恰是「字节还被需要」的那三个。

---

## 4. 审计保留的是必要元数据，不是原文副本

```
  审计元数据：{"change_id":"chg_0134","workspace_id":"ws_audit","digest":"a9e659…","state":"PENDING_APPROVAL","created_at":"2026-09-25T10:00:00.000Z","ended_at":"2026-09-25T10:00:00.000Z","item_count":1,"added_lines":2,"removed_lines":0,"before_bytes":0,"after_bytes":156}
PASS 4.1 字节被回收后仍拿得到审计所需的元数据（不是静默丢失）
PASS 4.2 元数据里没有工作区相对路径，也没有正文片段 — 长度 315 字节
PASS 4.3 元数据的字段就是那十一个：身份（两个标识符 + 摘要 + 状态 + 两个时刻）与规模（条目数 + 行数 + 字节数），没有别的 — 实际字段 added_lines,after_bytes,before_bytes,change_id,created_at,digest,ended_at,item_count,removed_lines,state,workspace_id
PASS 4.4 规模与身份对得上：条目数、字节数、摘要 — item_count=1 after_bytes=156
PASS 4.5 它不抛：排障路径上「这个修改集已经不在了」是一个正常答案
```

4.3 是一条**字段白名单**，不是子串黑名单。4.2 只证明「我没搜到 `src/` 与 `SECRET-BODY`
这两个词」，而白名单证明「它没带别的东西」—— 名单里边没有的东西和有的东西同样重要：
没有任何相对路径（`change_id` / `workspace_id` 是**标识符**，不是路径）、没有任何正文、
没有任何 blob id 与对象名。

4.5 是一条关于**排障路径**的判据：`reclaimedChangeMetadata` 对不存在的 id 返回 `null` 而不是抛。
回收之后再回答「刚才那次写的是什么」是一个正常的问题，不该由一个异常来回答。

---

## 6. 可复现的测试命令与输出

```
  # tests 77
  # suites 12
  # pass 77
  # fail 0
  # skipped 0
PASS 6.1 本任务的单元测试在 node 运行器下全部通过 — 退出码 0
```

§6 是脚本**自己启动**运行器并把输出抄进日志，而不是复述一句「测试通过」。
`scripts/evidence/lwb-024.ts` 里的这段是唯一一处「证据脚本再跑一次测试」的地方，
存在的理由是：单测的**退出码与计数**是它唯一的产出，而一条无法复现的命令行不是证据。

---

## 7. 本任务修掉的偏离（逐条记录，不静默）

| # | 偏离 | 表现 | 修法 |
| --- | --- | --- | --- |
| 1 | `planSnapshotRetention` 用 `listUnfinished()` 取在途操作 | **待恢复的快照被回收**，回滚取不到原始字节。只有构造「修改集 QUEUED / 操作 RECOVERY_REQUIRED」的分叉夹具才暴露 | 新增 `OperationsRepo.listByStates`，集合由 `OPERATION_TRANSITIONS` 推出 |
| 2 | 批准有效期与修改集有效期被当成同一个时钟 | 一次 `T0+22min` 的清理被误读成「计划已经落不了盘」 | §1.6 与 §1.11 两侧分开取证 |
| 3 | 门禁拒绝原因的顺序被当成实现细节 | 失效之后报 `CHANGE_STATE_INVALID`，掩盖了「这次停是从批准那头进来的」这个更具体的事实 | 2.5 断言 `APPROVAL_REVOKED`，2.6 作为状态那半边的补充 |
| 4 | `markRemoved` 会连带把工作区置为不可用 | 「工作区被移除」一格的理由实际有三条，最初只写了二条 | 2.1 那一格写全三条，并说明 `primary` 为什么仍是 `WORKSPACE_REMOVED` |
| 5 | 「跳过」可能是一句无声的什么都不做 | 3.6 要求每个被跳过的对象给出具名原因 | `collectGarbage` 的 `skipped[].reason` |
| 6 | 全局谓词可以替掉逐对象判据 | 3.8 显式走一遍并说明它让标准空洞地成立 | `protect` 是新增，`isSafeToCollect` 原样保留，四条条件同时成立 |

**另外记录两条库层事实**（不是缺陷，是判据的前提，写在这里以免下次重新发现）：

- `approvals_active_uq` 是**部分**唯一索引（`WHERE state = 'ACTIVE'`），且 `approvals.create`
  只重核摘要。因此**数据库层允许**给一个已失效的修改集再签一份批准 —— 挡住复活的必须是
  修改集状态。见 §2.2。
- `WorkspacesRepo.setEnabled` 与 `markRemoved` **都会**前移代次。因此「同一个代次下被停用」
  在生产路径上不可达 —— 这也解释了为什么 2.1 的每一格都同时带 `GENERATION_CHANGED`。

---

## 8. 未执行项（不得记为通过）

```
NOT_RUN 观察一次真实的落盘尝试被拦下（验收标准 1 的端到端那一半） — 写入方是执行协调器 `packages/executor/coordinator.ts`（LWB-026），尚未交付。因此本脚本能证的是「通往写入的那道门在所有入口上都拒绝」，不能证「文件真的没被写」——这两句话在证据强度上不是一回事，不合并
NOT_RUN 在真实工作区上联调（重定位 / 停用 / 移除一条真实工作区） — G2 未通过（LWB-002 BLOCKED）；P3 门禁：可在契约冻结前提下继续实现，但不得在真实仓库上联调（docs/evidence/g2-read.md）
NOT_RUN 在真实 ChatGPT 网页端确认模型无法自行批准或解除失效 — LWB-002 BLOCKED（真实账号与 Secure MCP Tunnel 凭证）。MCP Inspector 的成功不能替代它
NOT_RUN 由定时任务真正触发的那一次回收 — 定时触发与守护进程装配根（apps/daemon/src/main.ts）尚未交付。本节跑的是被装配后应当被调用的那一次 `collectGarbage`，输入与判据都是生产模块本身
NOT_RUN 「解除失效」这条路径 — 本任务只做失效，不做反向。`INVALIDATED` 在转移表里是终态、没有任何出边 —— 这是刻意的：解除失效等于让一次已经作废的批准复活，而它的下一步动作应当是重新读取、重新提议
```

前四条与 LWB-023 的四条是同一批依赖（LWB-002 / LWB-026 / 装配根），第五条是本任务特有的
**范围边界**：本任务只做失效，不做反向。把它写成 `NOT_RUN` 而不是省略，是因为「解除失效」
是一个**看起来该有**的能力 —— 而它是被刻意排除的。

---

## 9. 这次改动的文件

| 文件 | 变化 |
| --- | --- |
| `packages/changes/src/invalidation.ts` | **新增**（996 行）：失效判定、批量失效、过期清理、快照保留、审计元数据 |
| `packages/changes/src/index.ts` | 导出上述模块（15 个值 + 14 个类型） |
| `packages/persistence/src/repositories.ts` | 新增 `OperationsRepo.listByStates`（偏离项 1 的修法） |
| `packages/approvals/src/gate.ts` | 调用 `revalidateExecutionBindings`；`ApplyGateReason` 合并 8 条 `ExecutionBindingReason`，错误码映射转发到唯一那一份 |
| `packages/blob-store/src/store.ts` | `collectGarbage` 新增逐对象 `protect` 判据（第四条条件） |
| `tests/unit/changes-invalidation.test.ts` | **新增**（1360 行 / 77 例 / 6 组） |
| `tests/unit/approvals.test.ts` | 夹具把工作区推到第 7 代（否则 LWB-024 起门禁会正确地拒绝） |
| `scripts/evidence/lwb-024.ts` | **新增**（1193 行）：本文件所有引文的来源 |

---

## 10. 结论

三条验收标准在**合成工作区 + 真字节**上成立，逐条对应到可复现的 `PASS` 行。
**没有任何一条证据采自真实工作区**，且「不会自动落盘」这条只证到了门的那一侧。
因此：

- 本任务**不得**被读成「失效与清理已在真实仓库上可用」。
- `read_enabled` / `git_enabled` / `proposal_enabled` / `direct_write_enabled` 仍然**全部默认关闭**；
  本任务没有改动任何一个开关的默认值。
- 下一步（LWB-025 起的提议工具与写执行）在契约冻结的前提下可以继续实现，
  但仍不得在真实仓库上联调（`docs/evidence/g2-read.md`）。
