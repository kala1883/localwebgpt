# LWB-021 · 实现本地批准与拒绝 — 证据

**采集方式：** `node --import tsx scripts/evidence/lwb-021.ts`（**退出码 0**；**51 PASS / 0 FAIL / 6 NOT_RUN / 9 NOTE**）
**采集环境：** Windows 11 Home China 10.0.26200 / Node v22.20.0 / tsx 4.23.15 / PowerShell 7.6.6 / TypeScript 5.9.3 /
护栏后端 `powershell-pinvoke`（`available=true`、`supports_file_identity=true`）/
夹具仓库 `tests/fixtures/generated/testrepo`（21 个文件，其中可编辑且换行可写 10 个）
**测试套件：** `tests/unit/approvals.test.ts`（**36 例 / 6 组**，其中本轮新增 F 组 4 例）+
`tests/unit/control-plane.test.ts`（LWB-012 装配断言随控制操作增至 14 条而更新）+
全仓 `tests 1098 / suites 175 / pass 1098 / fail 0`
**静态检查：** `npx tsc --noEmit` 退出码 0；`node scripts/check-fsguard-imports.mjs` — **132 个文件**，未发现绕过
**原始日志：** 未入库（`*.log` 在 `.gitignore` 中，与 `lwb-006` ~ `lwb-020` 一致）。
下文引用的每条 `PASS` / `NOTE` 行均为运行输出的**逐字**摘录。

**门禁结论：G2 未通过，本任务不得被读成「审批链路已验收」。** 三条验收标准的证据全部采自
夹具副本与临时沙箱；**没有任何一次写入发生在真实工作区上**。更要紧的一条是：
**本任务交付到「排队」为止 —— 全部采集里没有任何一次批准被消费，也没有任何一次落盘**，
因为执行协调器（LWB-026）还不存在，而**消费只能发生在认领执行的那一刻**。
这符合 `docs/evidence/g2-read.md` 对 P3 的口径。

---

## 0. 这一轮的证据是在什么装置上采的

```
NOTE 护栏能力 — available=true backend=powershell-pinvoke supports_file_identity=true
NOTE 状态库 — schema_version=5 迁移 1,2,3,4,5；路径 C:\Users\mj\AppData\Local\Temp\lwb-evidence-021-GAhdVk\state.sqlite
NOTE 语料 — 夹具 21 个；可编辑且换行可写 10 个
NOTE LIMITS — MAX_EDITABLE_FILE_BYTES=2097152 MAX_CHANGE_FILES=20 APPROVAL_TTL_MS=600000（10 分钟）
NOTE 控制面 — 监听 http://127.0.0.1:6657；控制路由 18 条：/api/session、/api/status、/api/approvals/approve_and_apply、/api/approvals/list、/api/approvals/reject、/api/connections/list、/api/connections/pause、/api/connections/resume、/api/nonces、/api/session、/api/workspaces/describe、/api/workspaces/list、/api/workspaces/pause、/api/workspaces/register、/api/workspaces/relocate、/api/workspaces/remove、/api/workspaces/resume、/api/workspaces/reverify
NOTE 启动令牌 — 地址 http://127.0.0.1:0/#…（令牌在片段里，不进日志）
PASS 装置：真实 HTTP 兑换启动令牌，拿到会话与 CSRF 令牌 — 会话 s1-f1b806cac1ec
NOTE 修改集 α — chg_4fe70fb4-4fa9-43d3-bc43-790ee99bdaf4 digest=860baa699e3a96bec33bebdfb6d380080bec38eca4ad2e89e8814c894dbbcbe9 短核 860B-AA69
NOTE 修改集 β — chg_e30e3ef4-5a10-4915-b83f-2771d5486dee digest=d3e2546827b3104fc11cccd3472024f60804153e0749edd10223ab8001afd1bb 短核 D3E2-5468
NOTE 修改集 γ — chg_75f2e479-6f50-4552-a7f1-192aee76b50b digest=0ff52d6779e2796b8b8a1b7cb4c0b2ec78370cc0eb6741ce0f2b8cb6bd55ebcf 短核 0FF5-2D67
```

四件事决定了这轮证据能证明什么：

1. **修改集是走生产路径建出来的，不是脚本自己算好摘要再插进去的。** 三个修改集都由
   `prepareChange` 在夹具副本上产出。这一点很要紧：若摘要由脚本自算，「重算等于落库值」
   就退化成「同一个函数调用两次当然相等」；走 prepare 之后，摘要是**生产路径**算的，
   而批准侧的重算是**另一条独立代码**（`@lwb/approvals` 的 `reloadChangeSet`）算的。
2. **说 HTTP 就说 HTTP。** 采纳的不是仓储 API，而是 `createControlPlane` + 回环监听 +
   真实会话、真实 CSRF 头、真实一次性 nonce，用 `fetch` 驱动。因此「没有会话 → 401」
   「有会话没 nonce → 403」「同一个 nonce 重放 → 403」这些是**服务器真的这么答的**，
   而不是脚本读了一段代码后的转述。
3. **计数走第二条连接。** 所有 `approvals` / `operations` / `change_items` 的行数都由
   **另一条独立的 SQLite 连接**直接 `SELECT COUNT(*)` 得出，不借 `Repositories` 的内部连接。
4. **篡改用第三个修改集。** 「改动过的记录」按定义不可还原，因此 α 与 β 要留给后面的段落，
   篡改那一段单独用 γ。删旧插新时逐列照抄原行、**只改 `target_sha256` 一位** ——
   不引入新 blob、不动路径、不动基线，变掉的只有「将要写进去的是什么内容」。

另外一处取舍写在代码里：**批准侧的时钟被冻结**（`now: () => NOW_ISO`），而控制台会话的
时钟走真实时间（否则 cookie 会当场过期）。这不是为了让测试好写，而是因为
「有效期」这件事**本来就必须可复现** —— 判定读的是注入进来的时刻，不是「现在几点」。

---

## 1. 验收标准逐条

### 步骤 1 · 批准之前先由落库事实重载并重算摘要

任务书步骤 1：「决定前重新加载修改集摘要，验证批准的修改集与实际内容一致。」

```
PASS 重算摘要 == 生产路径（prepareChange）算出的摘要 — 860baa699e3a96be…
PASS 重算摘要 == 落库的 changesets.digest
PASS 重算所用的文件字段与摘要覆盖的是同一批（路径/操作/前后 sha 与大小/编码/换行/BOM） — {"path":"newline/lf.txt","op":"edit_text","before_sha256":"0821ee357bb28ac74141a02e385b9a74f035ac40766d647c99d0120c033f3efd","after_sha256":"206d55ff4ced0a5d363f2ae6194ae40f10cf568ce1c577a0baadc28043e3f1a7","before_size":30,"after_size":48,"encoding":"utf-8","newline":"lf","bom":false,"added_lines":1,"removed_lines":1}
PASS 修改集初始状态为待批准，且建立时没有产生任何批准 — state=PENDING_APPROVAL，approvals 0 行
```

这是整个任务的**前提**：批准绑定的是「重算出来的那串摘要」，不是「某个对象上的字段」。
把这一条单独放在验收 1 之前，是因为后面三条验收全都建立在它成立之上 ——
若重算做不到，「篡改后失效」这句话没有可比对的东西。

---

### 验收标准 1 · 本地批准的修改集有唯一摘要绑定；修改集内容改变后旧审批失效

#### 1.a 控制台按下「批准并应用」：真实 HTTP 走完，七项事实逐项落库

```
PASS a 控制台「批准并应用」按钮：真实 HTTP 200，修改集进入 QUEUED — 200 state=QUEUED operation=op_0d628e0536c349a3a4f6ef2d05b2f4df
PASS a 响应明确写着「尚未写入任何文件」 — 修改集已批准并排队，**尚未写入任何文件**。写入由本机执行协调器在开始前重新校验批准有效期与所有代次后进行。
PASS a 步骤 2 的七项事实逐项落在 approvals 行上（经**另一条连接**读出） — actor=console:s1-f1b806cac1ec digest=860baa699e3a… generation=1 policy=11 expires_at=2026-09-25T12:10:00.000Z
PASS a 批准行的身份不是任何入参：`actor` 是 `console:<session_id>`，由已鉴权的 IPC 通道身份给出 — console:s1-f1b806cac1ec
```

任务书步骤 2 点名要落库的七项事实 —— 谁 / 什么时候 / 哪个修改集 / 哪串摘要 /
哪个代次 / 哪个策略版本 / 何时过期 —— 这里逐项核对。其中两项值得单独说：

- **`actor` 是通道身份，不是入参。** 它是 `console:<session_id>`，由控制平面在调用
  处理器之前写进 `RequestContext`（`routes.ts`），而批准接口的入参里**根本没有**可以
  放下 `user_id` / `session_id` / `conversation_label` / `principal_id` 的位置（ADR-003 §4）。
  最后一条 `PASS` 就是这件事的断言：它是 `console:` 加上**服务器发出去的那个**
  `session_id`，逐字符相同。
- **`expires_at` 恰好是 10 分钟。** `LIMITS.APPROVAL_TTL_MS = 600000`，落库值
  `2026-09-25T12:10:00.000Z` 是冻结时刻 `12:00:00` 加 10 分钟 —— 不是「大约」。

「尚未写入任何文件」那句话也在响应里：它是**结构性**的事实而不是承诺 ——
本任务的交付物里不存在写入代码路径。

#### 1.b 拿 α 的摘要改掉末位一个字符去批 β

```
PASS b 把 α 的摘要改掉末位一个字符去批 β：真实 HTTP 被拒（CHANGE_STATE_INVALID） — 400 CHANGE_STATE_INVALID
PASS b β 上一条批准记录都没多（是「先比对后写」，不是「先记后拒」） — approvals 仍为 1 行
PASS b β 的状态仍然是待批准 — PENDING_APPROVAL
PASS b α 的批准仍然精确绑定 α 自己（一次越界的尝试没有动到它） — 短核 860B-AA69
```

三条断言各挡一种实现：拒绝挡「摘要不比对」；**行数不变**挡「先记一条再拒绝」
（后者在只看返回值时完全看不出来，而它会留下一条永远不该存在的批准）；
α 不受影响挡「拒绝时把别人的批准一起作废了」。

#### 1.c 记录被改动：重算不再等于落库值，于是旧决定一律失效

```
PASS c 装置：γ 的条目行确实被换掉了（删旧插新，因为不可变触发器只挡 UPDATE） — target_sha256 …db04a910（原 …db04a913）
PASS c 篡改后门禁拒绝放行，理由是 CHANGE_INTEGRITY（记录自身不一致） — APPROVAL_REQUIRED/CHANGE_INTEGRITY
PASS c 重载层报出的理由是 DIGEST_NOT_REPRODUCIBLE（重算值 ≠ 落库值） — CHANGE_STATE_INVALID/DIGEST_NOT_REPRODUCIBLE
PASS c 篡改后**没有**任何批准被写过，也没有任何状态被推进（拒绝是纯读的结论） — state=PENDING_APPROVAL，approvals 仍为 1 行
PASS c 不可变触发器确实挡下 UPDATE：改一行条目的正确写法只有删插 — UPDATE 被 change_items_immutable 拒绝
```

这一段演示的是**防线在触发器之外被绕过之后**会发生什么：有人绕过仓储层直接发了 SQL，
把「将要写进去的内容」换成了另一个哈希。两个独立的判定当场给出同一个结论：

| 层 | 结论 |
| --- | --- |
| `@lwb/approvals` 的 `evaluateApplyGate` | 拒绝，`reason=CHANGE_INTEGRITY` |
| `@lwb/approvals` 的 `reloadChangeSet` | 抛 `CHANGE_STATE_INVALID`，`reason=DIGEST_NOT_REPRODUCIBLE` |

最后一条 `PASS` 顺带把「正确的改法只有删插」钉在证据里 —— 也就是说，
上面那次篡改**必须**以「删一行、插一行」的形式完成，这本身就是不可变性的体现。

同一段还顺带覆盖了拒绝路径：验收最后一段里「对被改动过的 γ 做拒绝也被挡下」
（`400 CHANGE_STATE_INVALID`）说明拒绝**同样**要求摘要可复算 ——
「只是拒绝」不是一条可以跳过前置检查的捷径。

---

### 验收标准 2 · 模型只调用应用工具时返回 APPROVAL_REQUIRED

#### 2.a 门禁与策略层对同一个事实给出同一个答案

```
PASS a 门禁：没有任何批准时只得到 APPROVAL_REQUIRED / APPROVAL_MISSING — APPROVAL_REQUIRED/APPROVAL_MISSING
PASS a 策略层对同一个事实给出同一个错误码与理由（两处判定必须一致） — APPROVAL_REQUIRED/APPROVAL_MISSING；其余层失败 0 项
```

同一个事实在两处被判定：策略引擎（对模型工具调用整体裁定）与门禁（写入前的最后一道）。
两处若给出不同的结论，就会产生一个「策略说可以、门禁说不行」的组合，
而此时排障的人不知道该查哪一个。因此这条断言要求**错误码与理由都相同**，
且「除批准外没有别的层失败」—— 否则「主因是批准」这句话就没有意义。

#### 2.b–2.d 模型侧够不着批准，是三个层面的结构性事实

```
PASS b 能力表：mcp-adapter **不具备** approvals.decide，且它写在 NEVER_GRANTED_TO_MODEL 上 — 模型侧能拿到的只有 tools.read / tools.propose / tools.apply
PASS c 入参 schema：change_apply 拒绝 approved / force / user_id / session_id / conversation_label — strictObject：未知字段即拒绝；身份类字段连被读一次的机会都没有
PASS d 工具面：批准类名字是控制面方法，不可能出现在 tools/list — CONTROL_PLANE_ROUTES 共 12 个名字
PASS d 适配器：即使 daemon 把控制面方法报成「可用」，适配器也拒绝装配工具面 — SurfaceMismatchError：拒绝装配，而不是把控制面方法挂出去
```

三层是递进的，任一层单独成立都不够：

1. **能力表**：适配器算不出 `console` 这条 audience 的握手证明，因此这不是一条 `if` 判断，
   是密码学上的不可用。
2. **入参 schema**：`change_apply` 用 `z.strictObject`，那六个字段是**模式违规**。
   这意味着它们不是「被忽略了」，而是连被读一次的机会都没有。
3. **工具面**：即使 daemon 那边出错、把控制面方法报成可用，适配器也拒绝装配 ——
   失败方向是「少一个工具」，而不是「多一个能批准的工具」。

#### 2.e–2.g 真实 HTTP：两道门各自独立地挡住

```
PASS e 真实 HTTP：没有控制台会话的调用在会话门就被挡下（401）；参数里的 approved:true 没有任何作用 — 401 NOT_AUTHORIZED
PASS f 真实 HTTP：有会话但没有一次性 nonce → 403（nonce 是批准这条路上的必需要素） — 403
PASS g 整段跑完，β 上仍然一条批准记录都没有 — 同时 α 上有 1 条 —— 差别只来自有没有人在控制台上点过
```

`e` 那段请求体里带着 `approved: true`：它**没有任何作用**，因为请求在会话门就被挡下了
（上面的 2.c 已经说明它在模式层也活不下来）。`g` 是这一整段的收口：
α 上有 1 条批准，β 上 0 条 —— 唯一的差别是有没有人在控制台上真的点过那一下。

---

### 验收标准 3 · 重复点击批准不会制造第二次授权执行

有两种「第二次点击」，脚本分别打：

```
PASS a 控制台为本次动作申请到一次性 nonce — operation=/api/approvals/approve_and_apply，到期 1790342875309
PASS a 第一次点击：批准 + QUEUED + 唯一操作 — 200 state=QUEUED operation=op_0b8a6e3d53b6481bada42b06c0d942bc
PASS b 重放同一个 nonce：403（一次性） — 403 NOT_AUTHORIZED
PASS c 重新取一张 nonce 再点一次：仍然被拒（挡它的是「已经在排队」，不是 nonce） — 400 CHANGE_STATE_INVALID
PASS d 两次点击之后：批准恰好 +1 行，操作恰好 +1 行（经另一条连接读出） — approvals 1→2；operations 1→2
PASS d 修改集上仍然只有**一个**操作，状态为 QUEUED — UNIQUE(change_id) 是兜底；真正收敛的是「状态已不是待决定」这个前置判断
PASS e 批准未被消费：仍是 ACTIVE，`consumed_by` 与 `consumed_at` 均为空 — 执行协调器（LWB-026）还不存在，因此谁也无权消费 —— 消费只发生在认领执行的那一刻
```

**两种形态必须分开打**，因为它们由不同的机制挡住：

| 形态 | 像什么 | 挡住它的是 |
| --- | --- | --- |
| 同一个 nonce 重放 | 网络重试、双击、浏览器重发 | 一次性 nonce（403） |
| 重新取一张 nonce 再点一次 | 人真的又点了一次按钮 | 来源状态检查（不在 `PENDING_APPROVAL` 了） |

只测第一种会得出「nonce 就够了」的错误结论 —— 而 nonce 只证明「这是一次未被重放的、
绑定这份内容的动作」，它**不**阻止人再点一次。

`d` 是这一条验收的核心：两次点击之后**批准恰好 +1 行、操作恰好 +1 行**，
且修改集上仍然只有一个操作。`UNIQUE(change_id)` 是兜底，
但真正收敛的是来源状态检查 —— 它让第二次调用在**任何写入之前**就失败。

`e` 划清了本任务与 LWB-026 的边界：**批准没有被消费**。这不是遗漏，
而是设计 —— 消费只发生在执行协调器认领操作的那一刻，而那个协调器还不存在。

---

### 门禁语义 · 只判定，不消费；执行前用**本次**时刻重新判定

```
PASS a 连续三次执行前复核都放行（门禁是判定，不是占用） — 3 次判定中放行 3 次
PASS a 三次复核之后批准仍然是 ACTIVE —— 门禁不消费 — state=ACTIVE
PASS b 把判定时刻推到有效期之后（2026-09-25T12:11:00.000Z）不放行：APPROVAL_EXPIRED — APPROVAL_EXPIRED/APPROVAL_EXPIRED
PASS b 库里的状态仍然是 ACTIVE —— 有效期是**读的时候**投影出来的，只读路径不写库 — 与 approvals.list 用的是同一个投影函数，因此界面上显示的和门禁判定的一致
PASS b 策略层在同一个事实上也报 APPROVAL_EXPIRED（两处一致） — 1 项失败，主因 APPROVAL_EXPIRED
PASS b 未到期时策略层放行（因此上面那条不是「策略层总在拒绝」） — allow=true
```

这一节在钉两件事：

1. **门禁不消费。** 门禁要在很多地方跑（排队时、执行前复核时、返还结果前），
   而消费是**一次性**的。把它们写成一个函数，第一个调用点就会把批准烧掉 ——
   之后真正的执行拿到的是「已被使用」，而人看到一个再也执行不了的已批准修改集。
   因此连续三次判定都放行，批准仍然 `ACTIVE`。
2. **有效期不读「排队时是否有效」的标志位。** 判定时刻被推到有效期之后，
   同一个批准立刻变成 `APPROVAL_EXPIRED` —— 而**库里的状态仍然是 `ACTIVE`**。
   也就是说，「过期」是读取时投影出来的（`effectiveApprovalState`），
   只读路径不写库。这一点顺带解释了 `approvals.list` 为什么不需要一次性 nonce：
   它不产生状态变更。最后一条 `PASS` 是防自欺的 —— 证明策略层不是「总在拒绝」。

---

### 拒绝 · 终态，且不留下批准记录

```
PASS a 对被改动过的 γ 做拒绝：也被挡下（拒绝同样要求摘要可复算） — 400 CHANGE_STATE_INVALID
PASS a 拒绝不写入任何批准记录 — approvals 仍为 2 行
PASS b 完好的修改集上拒绝成功：状态进入 REJECTED（终态） — 200 state=REJECTED
PASS b 拒绝仍然不写入批准记录 — approvals 仍为 2 行
PASS c 拒绝之后再批准：被拒（终态不可逆） — 400 CHANGE_STATE_INVALID
PASS c 仍然没有批准记录产生 — approvals 仍为 2 行
```

拒绝是**终态**（`REJECTED` 在 `TERMINAL_CHANGE_STATES` 里），因此「拒绝之后再批准」
必须是失败的 —— 否则「拒绝」只是一次表态，而人不会再去点一个看起来已结束的条目。
`a` 那一段是意料之外但正确的一条：对被改动过的 γ 做拒绝也失败，
因为拒绝与批准共用同一套前置（重载 + 重算）。

---

### 收尾 · 关闭并重开状态库

```
PASS 重开之后，仅凭落库的行重算出的摘要与 prepare 写入的逐字符相同 — d3e2546827b3104f…
PASS 重开之后，批准仍然绑定同一串摘要，且仍是 ACTIVE — apr_039390fbbb1244f9819d64b0e158948e state=ACTIVE
PASS 重开之后，操作仍然只有一条且仍在 QUEUED（等待一个还不存在的执行器） — 本次采集里没有任何操作被推进，也没有任何批准被消费
PASS 重开之后独立调用 `canonicalChangeDigest` 与 `reloadChangeSet` 结论一致 — d3e2546827b3104f…
```

批准发生在控制台，执行发生在 daemon，中间隔着一次状态库往返、也隔着一次进程重启。
收尾这一段就是那句话的检验：**关库 → 重开 → 只凭磁盘上的字节重算**，
摘要逐字符相同、批准仍然绑在它上面。最后一条另外独立调了一次
`canonicalChangeDigest`（而不是只信 `reloadChangeSet` 的结论）——
两个入口对同一批落库的行给出同一个答案。

---

## 2. 两处**产品缺陷**，都是这一轮证据抓到的

两处都在 `apps/daemon/src/control/approvals.ts`，都在**控制操作处理器**这一层，
而单元测试结构上够不到那里。

### 2.1 每一次批准都返回 500，而批准其实已经落库了

**现象。** 第一轮运行：

```
FAIL a 控制台「批准并应用」按钮：真实 HTTP 200，修改集进入 QUEUED — 500 state=undefined operation=undefined
FAIL b 重放同一个 nonce：403（一次性） — 401 NOT_AUTHORIZED
PASS b β 上一条批准记录都没多（是「先比对后写」，不是「先记后拒」） — approvals 仍为 1 行
```

注意最后那一条：请求报 500，而 `approvals` **多了一行**。

**根因。** `recordDecision` 把 `short_code` / `state` / `decision_by` / `approval_id` /
`operation_id` / `operation_existed` 交给 `screenMetadata`，而
`packages/audit/src/screen.ts` 的键名白名单里**一个都没有**（只有 `policy_version` 在）。
`screenMetadata` 对不在清单里的键**抛出**（这是刻意的：静默丢弃会让审计少一个字段
而没有任何人知道）。于是每次批准都走成：事务提交 → 写审计 → 抛出一个普通 `Error`
→ 服务器折成 `INTERNAL_ERROR` / 500。

**为什么单元测试没抓到。** A–E 组全部直接调 `approveAndQueue` / `rejectChange`
（`@lwb/approvals`），**从不经过控制操作处理器** —— 而白名单只在处理器这一层被过。
E 组里唯一调处理器的用例期望的正是**被拒**，所以它在 `requireLocalConsole` 就返回了，
永远走不到审计那一步。这是「按层测」的盲区：每一层都测了，接缝处没有人测。

**修复。** 两条：

1. `packages/audit/src/screen.ts` 新增五个键（`short_code` / `change_state` /
   `approval_id` / `operation_id` / `operation_existed`），并在清单里逐条回答
   「它会带出内容吗」。
2. `apps/daemon/src/control/approvals.ts` 去掉 `decision_by`（决定者已经写在
   `connection_id` 列上，再往 metadata 放一份等于同一个事实有两个来源），
   并把 `root_generation` 改用既有的 `workspace_generation`（同一个事实不该有两个键名）。

**同时补的回归。** `tests/unit/approvals.test.ts` 新增 **F 组 4 例**，
**走控制操作处理器**而不是走包 API：批准成功、拒绝成功、只读操作不写任何行、
`approvals.list` 如实回报「批准还在、目标已排队」。F1 另外断言 metadata 里
**不含** `digest`、也不含 `decision_by` —— 前者是「审计回答哪一次决定，不回答哪一份内容」，
后者是上面那条去重。

### 2.2 批准的审计行没有 `request_id`

**现象。** F1 写完第一版后失败：

```
批准决定应当留下恰好一条审计事件
0 !== 1
```

**根因。** 审计表有 `request_id` 列（迁移 v2 加的），`recordDecision` 没填它。
一条「谁批准了什么」的记录因此无法与产生它的那次调用对上 ——
而「这次批准是哪一次点击」正是排障时第一个要问的问题。

**修复。** 从 `RequestContext` 取 `request_id` 传进 `recordDecision`。
它来自**已鉴权的通道**，不是入参。

### 2.3 一处**测试基础设施**的不稳定，未复现到根因

在 LWB-021 的三次全量运行里，有**一次** `tests/unit/control-plane.test.ts` 的
`LWB-012 · 验收标准 2` 报了一例失败，另两次为 `1098 / 1098 / fail 0`：

```
not ok 4 - 会话建立只认启动令牌这一条路：没有任何请求体字段能换来会话
  error: 'fetch failed'
  code: 'ERR_TEST_FAILURE'
  name: 'TypeError'
  stack: node:internal/deps/undici/undici:13510:13
```

这是**传输层**错误（`TypeError: fetch failed` 来自 undici），不是断言失败；
它与 LWB-021 的改动无关（那一例不经过批准接口），形态上像 keep-alive 连接池
与「测试自己关掉了服务器」之间的竞态。**没有定位到根因，因此不声称已修复**，
也不在测试里加「失败就重试」。记在这里，因为它会让后续的全量运行偶发变红。

---

## 3. 交付物

| 路径 | 说明 |
| --- | --- |
| `packages/approvals/src/gate.ts` | 执行前门禁：只判定不消费；与 `@lwb/policy` 的 `approvalFailures` 逐条对齐（本轮修正了 REVOKED / CONSUMED / EXPIRED 被读成「没有批准」的错误） |
| `packages/approvals/src/{decide,reload,index}.ts` | 重载并重算摘要、决定（批准 / 拒绝 / 批准并排队）、导出面 |
| `apps/daemon/src/control/approvals.ts` | 三个控制操作：`approvals.list`（只读）、`approvals.reject`、`approvals.approve_and_apply`；含本节 2.1 / 2.2 的修复 |
| `apps/daemon/src/control/{control-plane,index}.ts` | 变更类 / 只读类清单增至 14 条控制操作 |
| `packages/audit/src/screen.ts` | 键名白名单新增五个（见 2.1） |
| `packages/persistence/src/{migrations,repositories}.ts` | 迁移 v5：`approvals` 增 `root_generation` / `policy_version` 两个绑定列与两条约束 |
| `tests/unit/approvals.test.ts` | 36 例 / 6 组（A 重载 · B 决定 · C 门禁 · D 批准并应用 · E 模型不可批准 · **F 控制操作处理器**） |
| `tests/unit/control-plane.test.ts` | 装配断言随控制操作增至 14 条而更新 |
| `scripts/evidence/lwb-021.ts` | 本文件的采集脚本 |
| `docs/evidence/lwb-021/summary.md` | 本文件 |

## 4. 偏离项

- **本轮新增（编号见 `docs/PROGRESS.md`）**：`APPROVAL_DIGEST_MISMATCH` 这一分支
  **由构造不可达**。批准行受不可变触发器保护、修改集内容不可变，因此
  「批准绑定的摘要 ≠ 重算出的摘要」只能通过「批准指着一个别的修改集」出现，
  而那条路被 `ApprovalsRepo.create` 的 `INSERT … SELECT … WHERE id = ? AND digest = ?`
  与 `approvals_binding_matches_change` 两条约束一起挡掉了。
  它在门禁里仍然保留（作为纵深），但**没有任何一条受支持的路径能构造出它**，
  因此 C 组的按状态一致性循环里**刻意不含**这一格，而不是靠临时删触发器去制造它。
- **`approvals.list` 是只读的，因此它不带一次性 nonce。** 这决定了一条边界：
  「过期」由读取时投影（`effectiveApprovalState`），而不是在读取路径上顺手写库。
  代价是「已到期但库里的 `stored_state` 还是 ACTIVE」这个中间态在界面上可见 ——
  接口因此同时回报 `state` 与 `stored_state`，让两者的差可以被看见。
- **「用户确实看过这份内容」没有被证明。** nonce 目前仍由控制台**显式申请**，
  因此它证明的是「一次性 + 与内容绑定」，不证明「人看过」。后者要求 nonce 由
  渲染审核页的那次读取一并签发 —— 这条边界写在 `apps/daemon/src/control/session.ts`
  的文件头，本文件也照抄在此，免得被读成「审批链路已经完备」。
- **沿用偏离 56**：单文件工作区（`kind: 'file'`）提不出任何修改，本任务没有触碰这条。

## 5. 脱敏

- 本文件与采集脚本不打印任何文件正文。修改的内容一律是脚本自己写的中文标记行
  （「证据脚本写的第一行」等），正文从不回显。
- **不打印任何凭证、令牌或 cookie 值。** 启动令牌在日志里只以 `#…` 出现
  （令牌在片段里），会话只打印 `session_id`（`s1-f1b806cac1ec`）——
  它不是凭证，服务器接受的是 cookie 值与 CSRF 令牌，两者都不打印。
- 采集脚本的密钥 `lwb-evidence-021-key-…` 是**本脚本自己造的**假值，
  只存在于内存里，不落盘、不打印。
- 摘要（`digest`）在证据里**完整出现**。它不是凭证，也不再是内容本身：
  它是「哪一份内容」的指纹，而验证据要证明的正是这句话。
- 唯一出现的本机路径是临时沙箱路径（`C:\Users\mj\AppData\Local\Temp\lwb-evidence-021-…`），
  它随每次运行不同，且不是用户仓库的位置。

## 6. 未执行项（不得记为通过）

```
NOT_RUN 模型经真实 MCP 通道调用 `change_apply` — 五条 `change_*` 工具尚未实现（LWB-025/026）：工具面当前只为七个读工具注册了操作。本任务证明的是**它落地时会得到的那个答案**（门禁 → APPROVAL_REQUIRED），而不是「它现在就答这个」
NOT_RUN 批准被消费（状态进入 CONSUMED） — 消费只发生在执行协调器认领操作的那一刻（LWB-026），而它尚未装配；本任务交付到「排队」为止，因此全部采集里批准都停在 ACTIVE。消费路径的门禁拒绝在 tests/unit/approvals.test.ts 有用例覆盖
NOT_RUN 经由 daemon → 执行器 → 护栏的真实落盘 — LWB-026 未实现。本任务没有任何写入代码路径，`workspace_modified` 恒为 false
NOT_RUN 在真实工作区（非夹具副本）上执行任何一次写入 — G2 未通过（LWB-002 BLOCKED）；P3 门禁：可在契约冻结前提下继续实现，但不得在真实仓库上联调（docs/evidence/g2-read.md）
NOT_RUN 在真实 ChatGPT 网页端确认「模型不能自行批准」 — LWB-002 BLOCKED（真实账号与 Secure MCP Tunnel 凭证）。MCP Inspector 的成功不能替代它
NOT_RUN 「用户确实看过这份内容」 — nonce 目前仍由控制台显式申请，因此它证明的是「一次性与内容绑定」，不证明「人看过」；后者要求 nonce 由渲染审核页的那次读取一并签发（见 apps/daemon/src/control/session.ts 文件头）
```

**第一条值得展开**：本任务证明的是「模型单独调用应用工具**会**得到 `APPROVAL_REQUIRED`」，
而不是「它**现在**这么答」—— 因为那条工具还没挂出去。两者的差别是：
前者是门禁与策略层的实测结论（§1 验收 2.a），后者要等 LWB-025 把工具面接上。

## 7. 负向回归

| 场景 | 期望 | 证据 |
| --- | --- | --- |
| 拿甲修改集的摘要去批乙 | `CHANGE_STATE_INVALID`，**零**批准行 | 本轮 1.b |
| 摘要末位改一个字符 | 同上（`DIGEST_MISMATCH`） | 单元 C 组 |
| 直接 SQL 换掉条目行的目标哈希 | 门禁 `CHANGE_INTEGRITY`；重载 `DIGEST_NOT_REPRODUCIBLE`；零写入 | 本轮 1.c |
| 没有批准就应用 | `APPROVAL_REQUIRED` / `APPROVAL_MISSING`（门禁与策略层同码同因） | 本轮 2.a |
| 批准已过期 / 已撤销 / 已消费 | `APPROVAL_EXPIRED` / `APPROVAL_EXPIRED` / `CHANGE_STATE_INVALID`，与策略层逐条一致 | 单元 C 组 |
| 同一个 nonce 重放 | `403`（一次性） | 本轮 3.b |
| 重新取 nonce 再点第二次 | `CHANGE_STATE_INVALID`，批准与操作各只 +1 行 | 本轮 3.c / 3.d |
| 已经排队的修改集再被批准 | `NOT_AWAITING_DECISION` | 单元 D 组 |
| 拒绝之后再批准 | `CHANGE_STATE_INVALID`（终态不可逆） | 本轮拒绝段 |
| 无会话调用批准接口（体内带 `approved:true`） | `401 NOT_AUTHORIZED`；`approved` 无任何作用 | 本轮 2.e |
| 有会话但无 nonce | `403` | 本轮 2.f |
| `mcp-adapter` 身份的请求 + 六个身份字段 | `NOT_AUTHORIZED` / `ORIGIN_NOT_LOCAL`，零批准、状态不变 | 单元 E 组 |
| 控制路由要求一个模型侧也有的能力 | 注册期直接抛错（`/已授予 mcp-adapter/`） | 单元 E 组 |
| daemon 谎报控制面方法可用 | 适配器 `SurfaceMismatchError`，拒绝装配 | 本轮 2.d |
| 直接用 SQL `UPDATE change_items` | 不可变触发器拒绝 | 本轮 1.c |

## 8. 回退

- **能力开关。** 本任务**没有改动任何开关**：`read_enabled` / `git_enabled` /
  `proposal_enabled` / `direct_write_enabled` 的默认值仍为**全部关闭**（ADR-003 §5.1）。
  因此「回退」在本任务上的含义是**不打开开关**，而不是去删代码。
- **没有写入代码路径可回退。** 本任务的交付物里不存在任何写文件的代码：
  批准只到「排队」为止，`workspace_modified` 恒为 `false`。因此不存在
  「回滚一个已经落盘的改动」的问题 —— 也就不会走到 `git reset --hard` /
  `git clean` / `git checkout` / `git stash` 那条路上。
- **在途状态只有「已批准且已排队、尚未执行」。** 这些状态是**幂等事实**，
  方案 §7.2 要求网络断线、工具超时、进程重启都不能删除它们。回退时它们
  应当**保留**（重开后仍然可读，见收尾一段），而不是被清理。
- **迁移 v5 是加列 + 重建约束，方向仍然是一次的。** 加了两列与两条检查；
  回退到 v4 不会丢数据，但新版写下的 `root_generation` / `policy_version`
  会留在表里成为无主的列。
