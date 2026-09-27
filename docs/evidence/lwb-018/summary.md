# LWB-018 · 读取审计、配额、撤权与阶段验收 — 证据

**采集方式：** `node --import tsx scripts/evidence/lwb-018.ts`（退出码 0；**40 PASS / 0 FAIL / 5 NOT_RUN / 8 NOTE**）
**采集环境：** Windows 11 Home China 10.0.26200 / Node v22.20.0 / tsx 4.23.15 / PowerShell 7.6.6 /
护栏后端 `powershell-pinvoke`（`Microsoft Windows NT 10.0.26200.0`）/
夹具仓库 `tests/fixtures/generated/testrepo`（HEAD `5eefeeedc616b82927d6424c4d78e64a39c6b8dc`，
根身份由护栏当场问出：`volume=b0e2c2db file=0002000000672a7d fs=NTFS`）
**测试套件：** `tests/unit/daemon-audit.test.ts`（**47 例**，7 组）+
`tests/unit/control-plane.test.ts`（新增连接控制与审计断言）+ `tests/unit/persistence.test.ts`（迁移 v3）；
全仓 `tests 949 / suites 155 / pass 949 / fail 0`；其中 `tests/windows` **192 例 / 21 套**（真实 NTFS + 真实护栏）
**静态检查：** `npx tsc --noEmit` 退出码 0；`node scripts/check-fsguard-imports.mjs` — **122 个文件**，未发现绕过（LWB-017 时为 113）
**原始日志：** 未入库（`*.log` 在 `.gitignore` 中，与 `lwb-006` ~ `lwb-017` 一致）。
下文引用的每条 `PASS` / `NOTE` 行均为运行输出的**逐字**摘录，本文件不依赖那份日志才可读。

**门禁结论：G2 未通过。** 见 `docs/evidence/g2-read.md` —— 该门禁的另一半（**真实网页读取**）
依赖 BLOCKED 的 LWB-002，本轮**未执行**，因此不记通过。

---

## 0. 这一轮的证据是在什么装置上采的

```
PASS 护栏可用 — powershell-pinvoke；Microsoft Windows NT 10.0.26200.0 / PowerShell 7.6.6
PASS 护栏提供句柄级身份 — identity=true exclusive=true
NOTE 夹具根身份（由护栏当场问出） — volume=b0e2c2db file=0002000000672a7d fs=NTFS
NOTE 夹具 HEAD — 5eefeeedc616b82927d6424c4d78e64a39c6b8dc
NOTE 门禁（本次证据运行） — g0/native_guard/section3 全开 —— 见「验收 3」里的生产装配对照
```

三件事决定了这轮证据能证明什么：

1. **真实护栏 + 真实 NTFS + 生成出来的夹具仓库。** 审计要回答「哪些文件范围出去了」，
   而这句话只有在**真的读过文件**时才有内容可答；内存桩上跑出来的范围表证明不了
   范围与磁盘上的行是对应的。
2. **门禁在证据脚本里显式打开，在生产装配里保持全关。** 同一个脚本前后两次列出
   工具清单：全关时只有 `bridge_status` 与 `workspace_list`，全开时是七个只读工具。
   这不是两套配置，是同一份装配代码在两个门禁取值下的输出 —— 见验收 3。
3. **夹具仓库不是真实仓库。** 它由 `tests/fixtures/build-fixtures.ts` 生成，
   带自己的 HEAD，且两个根（`testrepo` 与 `outside-canary`）都在生成目录之下。

---

## 1. 验收标准逐条

### 验收标准 1 · 可回答某次工具调用读取和返回了哪些文件范围

#### 1.1 范围是**算出来的**，不是常量

```
PASS 真读一页大文件成功，且 sha256 与夹具清单一致 — sha256=50716ebb6f94…(64) 行=1–401 bytes=21200 editable=false
PASS 第一页签发了续读游标 — 游标长度=503
      tool=file_read outcome=allow code=null bytes_out=21200 出去了=[large/big.txt:1-400] 拦下了=[无] 重复事件=false
PASS 第二页的区间与第一页不同（区间是逐次算出来的，不是常量） — 第一页起于 1，第二页起于 401
      tool=file_read outcome=allow code=null bytes_out=21200 出去了=[large/big.txt:401-800] 拦下了=[无] 重复事件=false
```

第二页是**拿第一页签发的真游标**续读出来的。这一条是必要的：只在第一页上断言
「范围是 1–400」，一个把 `start_line` 写成常量的实现同样能通过。两页的起止不同，
才把「范围由本次调用算出来」与「范围是写死的」分开。

`bytes_out` 与 `出去了` 的字节数一致（21200），因为出站字节记的是**预算记账的增量**
（`guard.ts` 的 `budget.chargedTotal - chargedBefore`），而预算是内容出站时扣的。
两者一起读才成立：只有范围没有字节，说明不了内容真的出去了。

#### 1.2 被拒绝的调用也要留下痕迹，且目标路径在「拦下了」那一侧

```
PASS 硬拒绝文件被拒 — code=POLICY_DENIED
PASS 被拒绝的调用：目标路径记在「拦下了」一侧，出站字节为 0 — tool=file_read outcome=deny code=POLICY_DENIED bytes_out=0 出去了=[无] 拦下了=[secrets/.env(整文件/无区间)] 重复事件=false
```

审计要回答的是两半：「什么出去了」与「什么被挡住了」。只记前一半的审计，
在排查「为什么模型看不到那个文件」时要靠猜。因此失败路径用**入参里的目标路径**
（`targetFileAccess`）而不是「空数组」—— 后者断言的是「本次调用没有指向任何文件」，
那是另一句话。

「拦下了」那一侧的行 `delivered=false`，这是迁移 v3 对 `delivered` 的定义：
**读了但没出去**。把它记成「没读」是另一种谎（`guard.ts` 的 `withholdRow` 注释）。

#### 1.3 列举：条数与审计行数一致

```
PASS 列举：目录本身 + 每个条目各一行，条数与结果一致 — 条目 12 条，审计行 13 行；
     tool=file_list outcome=allow code=null bytes_out=0 出去了=[(整文件/无区间) .git(整文件/无区间) README.md(整文件/无区间) bom(整文件/无区间) config(整文件/无区间) edge(整文件/无区间) large(整文件/无区间) newline(整文件/无区间) node_modules(整文件/无区间) secrets(整文件/无区间) src(整文件/无区间) 文档(整文件/无区间) 资料(整文件/无区间)] 拦下了=[无] 重复事件=false
```

13 = 12 个条目 + **被列举的那个目录自己**。目录自己那行不是凑数：一次列举让
模型知道了这个目录存在、它叫什么、它在工作区里的位置，而那正是列举本身的载荷。

**这一条的 `bytes_out=0` 值得单独说明**：条目名不经过出站闸门的预算记账
（预算只在 `emitContent` 里扣，而列举的载荷是条目名不是正文）。因此 `bytes_out=0`
的意思是「这些字段不计入预算」，**不是**「什么都没出去」。这是一条真实的口径差，
已登记为偏离项 65。

#### 1.4 `git_diff`：两侧哈希如实给出

```
PASS git_diff：整文件访问被记下来，且两侧哈希如实给出 — tool=git_diff outcome=allow code=null bytes_out=0 出去了=[README.md(整文件/无区间)] 拦下了=[无] 重复事件=false comparison=head_vs_worktree old=4c123fb33477…(64) new=4c123fb33477…(64)
```

两侧哈希相同（README.md 未被改动），差异为空，因此出站字节为 0 而文件行仍是
「整文件」。这两个字段一个都不能单独读：只看 `file_access` 会把「参与判定的文件」
读成「内容出去了」。已登记为偏离项 66。

#### 1.5 审计里没有正文，但有相对路径

```
PASS 审计里没有任何一条夹具正文 — 92 条文本列，逐条比对 3 个内容探针
PASS 同一份审计里**有**相对路径（它不是空的，上面的结论才有意义） — 探针之一：large/big.txt 在审计文本列里
```

这两条必须成对。第一条单独存在时，一个**什么都没写**的审计库也能通过。
因此第二条在同一份转储上做**正向**断言：探针之一是夹具里存在、且确实被读过一次的
相对路径。3 个内容探针取自三份不同的夹具文件（含中文路径与 48000 行的 `large/big.txt`）
的第 1 / 124 / 2 行 —— 逐行内容，不是文件名。

92 条文本列 = 审计两张表的全部文本字段（`tool`、`request_id`、`connection_id`、
`error_code`、`path`、`outcome`…），逐条比对。

#### 1.6 补充信息（`metadata`）穿过同一道筛查

```
PASS 白名单之外的键被筛查拒绝（含绝对路径一类） — 审计补充信息的键 path 不在允许清单内。新增键必须同时回答「它会带出内容吗」。
PASS 白名单内的键照常通过 — {"reason":"HANDLER_REFUSED","in_flight":1,"limit":2}
```

`metadata` 是审计里**唯一**由调用方逐次决定内容的列，因此它是最容易变成
「顺手把一段正文塞进去」的地方。`screenMetadata` 是白名单制的：键必须在
`ALLOWED_METADATA_KEYS` 里、值必须是标量且不超过 200 字符、不含绝对路径与控制字符，
**不合格就抛**（不是静默丢弃 —— 静默丢弃会让写入方以为它记上了）。

`in_flight` / `limit` / `principal_kind` 是本任务新增的三个键。它们是**数字**与
**闭集枚举值**：判断一个键能不能收，问的是「它会带出内容吗」而不是「它现在装的是什么」。

### 验收标准 1 补充 · 审计写不进去 ⇒ 不返回内容（fail-closed）

```
PASS 记录写不进去 ⇒ 返回失败而不是内容 — code=STORAGE_UNAVAILABLE reason=AUDIT_WRITE_FAILED
PASS 该失败的信封里没有本机存储的原文 — message=本次调用已完成，但审计记录无法写入，因此结果未发送。
PASS 失败信封里没有文件内容
```

这是**刻意的降级方向**：一条送不出去的记录等于一次没有记录的出站。代价是一次存储
故障会让工具面整体不可用 —— 而那时状态库本身也读不出授权，工具面本来就不该继续工作。

证据脚本用的手法是**只删审计两张表**（`DROP TABLE audit_file_access; DROP TABLE audit_events;`），
让读取路径完好、只有审计写入失败。这样这条断言证明的是**审计写入**这一件事，
不会与「授权链也读不出来」混在一起。另有一条相反的装置在单元测试里：
整库关掉后守卫返回 `STORAGE_UNAVAILABLE` + `reason=GUARD_FAILED`（见 §4.2）。

### 验收标准 2 · 撤权后旧游标、缓存、Git 结果也不能返回

#### 2.1 游标是**撤权之前**签发的

```
NOTE 暂停前签发的游标 — 长度 503
PASS 连接暂停 ⇒ 旧游标与任何新请求都被拒 — tool=file_read outcome=deny code=CONNECTION_DISABLED bytes_out=0 出去了=[无] 拦下了=[large/big.txt(整文件/无区间)] 重复事件=false
PASS 工作区暂停 ⇒ 旧游标被拒 — tool=file_read outcome=deny code=PAUSED bytes_out=0 出去了=[无] 拦下了=[large/big.txt(整文件/无区间)] 重复事件=false
PASS 工作区恢复后代次递增 ⇒ 旧游标仍失效（票据绑代次） — code=READ_TOKEN_STALE reason=CURSOR_GENERATION_MISMATCH；...
PASS 恢复之后新的一次读取照常成功 — tool=file_read outcome=allow code=null bytes_out=21200 出去了=[large/big.txt:1-400] 拦下了=[无] 重复事件=false
```

游标取自**暂停之前**。手写一个游标只能证明「垃圾被拒绝」，而这条验收标准问的是
「**以前签发的**游标在撤权后还能不能用」—— 两者是不同的用例。

最后一条同样必要：一个「撤权后什么都读不了」的实现能通过前三条，却把「恢复」
变成了一句空话。恢复**之后**新的一次读取必须照常成功，游标有效期才是真的按代次算的。

#### 2.2 已知边界：连接暂停→恢复后，暂停前的游标**仍然可用**

```
NOTE 已知边界：连接暂停→恢复后，暂停前签发的游标仍可用 — 未绑连接代次（偏离项 61）；本次实测 被接受
NOT_RUN 「暂停→恢复也必须作废旧游标」这个更严的口径 — 未满足：票据未绑连接代次（偏离项 61）。按任务书 LWB-013 的原文（票据绑连接、工作区代次、路径、文件版本）实现是一致的 —— 两种读法都记在这里，不自行选一个记成通过
```

工作区一侧做对了（票据绑工作区代次：暂停后 `PAUSED`、恢复后 `READ_TOKEN_STALE`），
连接一侧绑的是**连接 id**而不是连接**代次**。这条边界有两种读法，证据脚本不替
验收负责人选一个：

- 按任务书 LWB-013 的原文「生成签名读取票据，绑定**连接**、工作区代次、路径、
  文件版本和实际返回范围」—— 实现与规格一致（连接以 id 参与绑定，代次绑定的是工作区）。
- 按守卫自己在**调用进行中**采取的口径（连接代次一变就撤回已经算好的结果，
  `guard.ts` 的 `recheck`）—— 那么「恢复之后还能接着读」就是同一件事上的两种尺度。

第一条读法下这条验收通过，第二条读法下它不通过。**因此它记为 `NOT_RUN` 而不是通过，
也不是「实现缺陷」** —— 判定需要一次决定（偏离项 61 写了两种读法的后果与修法范围），
而验收负责人至今未指定。它今天为什么不构成实际风险（停用期间请求到不了处理器、
进行中的调用会被当场拦下），写在偏离项 61 的「今天不构成实际缺口」一段。

#### 2.3 出站预算不因暂停/恢复而重置

```
PASS 暂停/恢复不重置出站预算窗口（账仍然算在同一条连接上） — 暂停前 charged=84800 used=84800；恢复后 charged=84800 used=84800
NOTE 预算快照（不含内容） — {"limit_bytes":67108864,"used_bytes":84800,"buckets":1,"charged_total":84800,"denials":0}
```

这一条不在任务的书面验收标准里，是**反向**验证：若恢复会清零，那么「暂停→恢复」
就是一条重置出站窗口的路径，而窗口是「这条连接一小时内最多带走多少字节」的
唯一表达。数字两侧相同才说明账记在同一条连接上。

#### 2.4 结果已经读出来、但在返回途中被撤回

```
PASS file_read：撤权后的结果不得返回 — code=CONNECTION_DISABLED
PASS file_read：信封里没有正在读的那段内容
PASS file_read：审计记「读了但没出去」，出站字节照记（不回退） — tool=file_read outcome=deny code=CONNECTION_DISABLED bytes_out=58 出去了=[无] 拦下了=[README.md:1-3] 重复事件=false reason=REVOKED_BEFORE_RETURN
```

这是在**处理器内部、文件读完那一刻**撤权的（把钩子挂在护栏的 `readFileGuarded` 上）。
时序是确定的：授权在调用开始时成立，在返回时不成立。三条断言各拦一件事：

- 错误码 —— 调用**失败**而不是成功返回；
- 信封里搜不到刚读到的那一行 —— 错误码对但内容跟着错误信息一起漏出去的情况，只有这一条能抓住；
- 审计记「读了但没出去」，**且出站字节照记**（58 字节不回退）。

第三条的字节数不是零：预算是被真实扣减的。**刻意不回退** —— 回退会让「反复触发撤回」
变成一种重置出站窗口的手段（与 2.3 同一条理由）。

### 验收标准 2 补充 · 限额：只能收窄，且闸门取的是**生效值**

```
PASS 收紧被接受，且生效值进了限额表 — accepted=MAX_CONCURRENT_READS rejected=0
PASS 放宽被拒绝，且理由是方向而不是语法 — reason=限额 MAX_CONCURRENT_READS 只能收紧：当前 4，配置要求 5
PASS 不可调的固定项被拒绝 — reason=限额 MAX_CONCURRENT_WRITES_PER_WORKSPACE 不允许由配置覆盖
PASS 闸门取的是**生效值**而不是初值 — 生效上限=1，初值=4
PASS 并发额度耗尽 ⇒ 本次未执行，且不说成「读过了」 — tool=file_list outcome=deny code=CONCURRENCY_LIMIT_EXCEEDED bytes_out=0 出去了=[无] 拦下了=[无] 重复事件=false
PASS 被额度挡下的调用：没有任何文件行（连目标路径都不记 —— 它没执行） — attempted=0 delivered=0
PASS 出站额度用尽 ⇒ 结果不出站，且审计记 0 字节 — tool=file_read outcome=deny code=EGRESS_BUDGET_EXCEEDED bytes_out=0 出去了=[无] 拦下了=[文档/设计说明.md(整文件/无区间)] 重复事件=false
PASS 出站额度最终被用尽（这条路径真的被走到了） — 3 次成功后 第 4 次被拒：EGRESS_BUDGET_EXCEEDED reason=WINDOW_LIMIT_EXCEEDED used=900 limit=1024 本次要送=300
```

第 4 条（闸门取生效值）是这几条里最容易假通过的一条：把限额叠加接上、却让闸门
仍按 `LIMITS` 初值建，前三条**全部照样通过**，而「配了收紧但不生效」在运行时的
表现与「没配」一模一样。

第 6 条是口径题：并发额度挡下的调用**没有执行**，因此审计里连目标路径都没有。
这与 §1.2（策略拒绝**记**目标路径）看起来矛盾，实际是同一条规则的两个方向 ——
记的是「这次调用**指向**了什么」，而一次没被执行的调用没有指向任何东西。

「只能收窄」这条语义在 LWB-018 之前**对任何键都不成立**：`NON_RELAXABLE_LIMITS`
里当时只有 `MAX_CONCURRENT_WRITES_PER_WORKSPACE`，而那一项不在可调集合内 ——
两条清单互不相交，于是那句规矩永远不会被触发。本次把它改名为 `TIGHTEN_ONLY_LIMITS`
并放进了真正在可调集合内的两个并发键（偏离项 28）。

### 验收标准 3 · G2 通过前只能用测试根，不能开放真实仓库写入

```
NOTE 本轮用到的根 — D:\MyProjects\MyApps\LocalWebGPT\tests\fixtures\generated\testrepo ｜ D:\MyProjects\MyApps\LocalWebGPT\tests\fixtures\generated\outside-canary
PASS 两个根都在生成出来的夹具目录之下 — 生成目录=D:\MyProjects\MyApps\LocalWebGPT\tests\fixtures\generated
PASS 夹具根不是任何真实仓库（它由 build-fixtures 生成，且带自己的 HEAD） — generated_by=tests/fixtures/build-fixtures.ts HEAD=5eefeeedc616b82927d6424c4d78e64a39c6b8dc
PASS 生产装配（门禁全关）⇒ 可用工具恰好是 bridge_status 与 workspace_list — bridge_status、workspace_list
PASS 生产装配下四个能力开关全 false（含 direct_write_enabled） — {"read_enabled":false,"git_enabled":false,"proposal_enabled":false,"direct_write_enabled":false,"recovery_required":false}
PASS 清单覆盖契约里的全部 12 个工具名 — 12 条：bridge_status、workspace_list、file_list、text_search、file_read、git_status、git_diff、change_prepare、change_get、change_list、change_apply、change_revert_prepare
PASS 契约里的写工具全部 NOT_IMPLEMENTED（不是「被开关关掉」） — change_prepare=NOT_IMPLEMENTED、change_get=NOT_IMPLEMENTED、change_list=NOT_IMPLEMENTED、change_apply=NOT_IMPLEMENTED、change_revert_prepare=NOT_IMPLEMENTED
PASS daemon 侧没有注册任何写工具（注册表里查不到） — change_apply / change_prepare 均未注册
PASS 门禁开启时可用工具恰好是契约里的七个已实现工具 — bridge_status、workspace_list、file_list、text_search、file_read、git_status、git_diff
```

这一条有三层：

1. **根是夹具。** 断言的是「本次用到的两个根都在生成目录之下」，而不是「我们没用真实仓库」——
   前者是可判定的，后者是一句声明。
2. **写通道不存在，而不是被关掉。** 五个 `change_*` 的 `reason` 是 `NOT_IMPLEMENTED`，
   `operations.lookup('change_apply') === undefined`。这两件事与「开关关着」是可区分的：
   开关关着意味着「打开就能用」，`NOT_IMPLEMENTED` 意味着没有这段代码。
   这一条正是 LWB-018 步骤 4「不提前启用直写」要的证据。
3. **生产装配下四个开关全 false。** 不是证据脚本关的 —— 那是 `capabilityFlagsWith`
   在门禁全关时的输出，也就是生产路径的默认值。

---

## 2. 步骤对照（方案 LWB-018 的四步）

| 步骤 | 落地位置 | 证据 |
| --- | --- | --- |
| 1. 记录连接、工具、授权工作区、被返回文件及范围、版本、字节和结果码，默认不存正文 | `packages/audit/`（`record.ts` 写两张表、`ranges.ts` 从结果里提取范围、`screen.ts` 筛选补充信息）、迁移 v3 新增 `audit_file_access` | §1.1–§1.6、§1 补充 |
| 2. 每次/每连接并发与出站字节限制；临返回再次检查授权 | `packages/limits/`（`overrides.ts` 叠加、`concurrency.ts` 闸门）、`apps/daemon/src/tools/guard.ts`（7 步顺序） | 「验收标准 2 补充」、§2.4 |
| 3. 暂停连接后阻断新请求和未发送结果 | `apps/daemon/src/control/connections.ts`（`connections.pause` / `resume`，能力 `connections.manage`）、`guard.ts` 的 `recheck` | §2.1–§2.3 |
| 4. 运行完整只读阶段验收，不提前启用直写 | 本文件 + `docs/evidence/g2-read.md` | §验收 3 |

**步骤 1 里有两处对不上，如实登记：**

- 任务书写的是「被返回文件及范围、**版本**、字节和结果码」。今天审计记了**范围**与
  **字节**，**没有**记版本：`audit_file_access` 表没有 `sha256` 列，而七个工具里
  只有 `file_read` 的结果带哈希，`file_list` / `text_search` / `git_status` 根本不
  产出「某个文件的某个版本」这个说法。见偏离项 64。
- 「默认不保存源码正文」做到了，且有正向对照（§1.5）。

---

## 3. 偏离项（与 PROGRESS 的编号对应）

| 编号 | 一句话 |
| --- | --- |
| 61 | 读取票据绑了**工作区**代次与连接 **id**，没绑**连接代次** ⇒ 连接暂停→恢复后旧游标仍可用（本轮实测确认；按任务书原文一致、按守卫自己的进行中口径不一致，判定悬置） |
| 62 | 授权拒绝（`CAPABILITY_NOT_GRANTED` → `NOT_AUTHORIZED`）在审计里记成 `outcome: 'error'` 而不是 `deny` |
| 63 | 补充信息筛查的覆盖面：工具面与控制面穿过 `screenMetadata`，`packages/workspaces` 的登记路径**不穿过** |
| 64 | 审计不记文件**版本**（无哈希列），而任务书这一行列了「版本」 |
| 65 | 出站字节预算只对**正文**记账：目录条目名、Git 状态条目名走 `screenText` 但不计预算 |
| 66 | `file_access.delivered` 的粒度是**文件范围**不是字节：`git_diff` 对无差异的文件也记 `delivered=true`（`bytes_out=0`） |
| 28（更新） | `validateLimitOverride` 现在有调用方了（`resolveLimits`），但**装配根仍不存在** ⇒ 「生效」这件事没有生产入口 |
| 38（更新） | 同 28：`SearchLimits` 的覆盖入口仍未接线 |
| 55（更新） | `paused` 现在**有来源**了（守卫读 `status().paused`），但把状态库里的值接到这个字段上的人仍然只有一个**不存在的**装配根 |

每条的理由与影响写在 `docs/PROGRESS.md` 对应编号处。

---

## 4. 采集过程中发现并修复的真实缺陷

### 4.1 并发拒绝被记成「存储不可用」（错的是新加的键，不是并发）

单元测试第一次跑「并发额度耗尽」时得到的错误码是 `STORAGE_UNAVAILABLE`，
而不是 `CONCURRENCY_LIMIT_EXCEEDED`。根因：守卫在并发拒绝时写的补充信息里有
`in_flight` 与 `limit` 两个**新键**，而 `ALLOWED_METADATA_KEYS` 还没有它们 ——
`screenMetadata` 按设计**抛错**，于是 `recordAndReturn` 兜住、返回存储错误。

这个缺陷的形状值得记住：它**不是**「筛查太严」，而是**筛查的失败方式**。
筛查在写入方没有准备的情况下抛出，会让一条业务拒绝被记成一次基础设施故障 ——
而两者在审计里的含义、在与模型对话时的说法、在排查时的方向**完全不同**。
修法是把两个键加进白名单（它们是数字，答得出「会带出内容吗」这个问题），
而不是把 `screenMetadata` 改成不抛。

### 4.2 守卫自己的异常会逃到 IPC 兜底路径（那里带本机排障文本）

单元测试里把整个状态库关掉再调用工具，得到的是一句
`The database connection is not open` —— **异常穿出了守卫**，落到 IPC 的兜底路径上。
`readFacts`（第 3 步）读不出前像时抛，而那时 `try` 还没进。

生产路径上这条异常会把本地排障文本原样送给模型（`errors.ts` 的消毒只覆盖
**被包装过的**错误）。修法是在守卫里补一个 `catch`：

```
return fail(requestId, 'STORAGE_UNAVAILABLE', GUARD_FAILED_MESSAGE, { reason: 'GUARD_FAILED' });
```

它与 `rowsOf` 的 `catch` 是同一个理由，也因此它是**实指的**而不是兜底话术：
这一段 `try` 里唯一的抛出源就是状态库。修完后又加了一条单元测试，
专门钉「整库关掉」这条路径（此前只有「只删审计表」那条）。

### 4.3 证据脚本自己写了 `workspace_id: ''`，于是撤权窗口一次都没被走到

§2.4 那条用例第一版跑出来的结果是：

```
FAIL file_read：撤权后的结果不得返回 — code=INVALID_ARGUMENT
FAIL file_read：审计记「读了但没出去」，出站字节照记（不回退） — ... outcome=error code=INVALID_ARGUMENT bytes_out=0 ... reason=HANDLER_REFUSED
```

入参里是一个手写的空工作区 id，调用在**入参校验**就结束了，文件从来没被读过，
于是「读完之后撤权」这个窗口从未进入。**两条断言都报出了结果**，只是结果不是
它们想说的那件事 —— 而如果当时的断言写得更松一点（比如只查「结果里没有内容」），
它会**通过**，并且证明了一件与标题无关的事。

修法是让入参从装置里取（`harness.workspace.id`），使「工具真的读到了东西」
成为断言的前提而不是假设。修后同一条用例的 `bytes_out=58`、`拦下了=[README.md:1-3]`
—— 读到过、也扣了账，这才对得上「读了但没出去」。

---

## 5. 脱敏

- 证据脚本的输出**逐行检查过**：没有本机用户名、没有绝对路径以外的身份信息。
  出现的绝对路径形如 `D:\MyProjects\MyApps\LocalWebGPT\tests\fixtures\generated\testrepo`
  —— 它是仓库内路径，且是本工程自己的夹具根；**真实仓库路径从未进入**这台装置的
  任何一次调用（验收 3 钉住这一点）。
- 审计转储在打印前经过文本列提取，只比对探针、只打印**相对**路径与结构化字段。
  正文探针（3 个）只在「有没有出现」这一个布尔结论里出现，不打印。
- 控制面凭证、`.env` 一类**从未出现在任何输出里**：夹具里的 `secrets/.env` 只以
  路径形态出现在「拦下了」那一侧（§1.2），其内容在任何一次运行里都没有被读过
  —— 那次调用被硬拒绝挡在了读之前。
- 未使用任何真实凭据：本轮全部证据在本机、夹具、门禁全开的测试装置上采集。

---

## 6. 未执行项（不得记为通过）

```
NOT_RUN G2 的另一半：**真实网页读取**且内容出站可追踪 — LWB-002 BLOCKED：需要真实 ChatGPT 账号与 Secure MCP Tunnel 凭证；本机没有。本文只就给得出证据的那一半（内容出站可追踪）作答，因此 **G2 未通过**
NOT_RUN ChatGPT 网页端发现并调用这些工具 — LWB-002 BLOCKED（同上）；MCP Inspector 的成功不能替代它
NOT_RUN MCP Inspector 手工验证 — 未执行：本轮证据只到「真 MCP 客户端 + 真进程 + 真管道」（见 LWB-017 证据）
NOT_RUN 真实仓库（非夹具）上的读取与审计 — G2 通过前不得进入真实目录联调；本轮全部证据采自生成出来的测试根
NOT_RUN 「暂停→恢复也必须作废旧游标」这个更严的口径 — 未满足：票据未绑连接代次（偏离项 61）。按任务书 LWB-013 的原文（票据绑连接、工作区代次、路径、文件版本）实现是一致的 —— 两种读法都记在这里，不自行选一个记成通过
```

最后一条与其余四条的性质不同：前四条是**环境不允许**（本机没有真实账号与隧道），
最后一条是**判定悬置** —— 它按更严的口径不通过、按任务书原文则一致，
两种读法都写在偏离项 61 里，等待一次明确决定。把它记成通过或记成缺陷，
都是替没被指定的验收负责人做决定。

---

## 7. 变更文件

**新增包**

- `packages/audit/`（`index.ts` / `record.ts` / `ranges.ts` / `screen.ts`）—— 审计写入、
  结果范围提取、补充信息白名单筛查
- `packages/limits/`（`index.ts` / `overrides.ts` / `concurrency.ts`）—— 限额叠加与方向校验、
  并发闸门

**daemon**

- `apps/daemon/src/tools/guard.ts`（新）—— 七步守卫：暂停 → 并发位置 → 前像 → 处理器 →
  返回前复查 → 写审计 → 释放
- `apps/daemon/src/control/connections.ts`（新）—— `connections.list/pause/resume`
- `apps/daemon/src/tools/{index,handlers,operations}.ts` —— 守卫接线、`status`/`limits` 入参、
  操作注册

**契约与持久化**

- `packages/contracts/src/{errors,limits}.ts` —— `TIGHTEN_ONLY_LIMITS` 更名与语义修正（原名
  `NON_RELAXABLE_LIMITS`，与可调集合**不相交** ⇒ 「只能收紧」对任何键都不成立）、
  `validateLimitDirection`
- `packages/persistence/src/{migrations,repositories}.ts`（迁移 v3：`audit_events` 增列 +
  `audit_file_access` 新表、连接 `generation`、审计查询）
- `packages/ipc/src/audience.ts` —— 新能力 `connections.manage`（四处装配期断言同步）

**证据与测试**

- `scripts/evidence/lwb-018.ts`（新）
- `tests/unit/daemon-audit.test.ts`（新，47 例）、`tests/unit/{control-plane,persistence}.test.ts`、
  `tests/tools/harness.ts`（新增 `egress_bytes_per_hour` / `concurrency` 注入点）

---

## 8. 回归

```
$ node scripts/run-tests.mjs
# tests 949  # suites 155  # pass 949  # fail 0  # skipped 0  # todo 0

$ node scripts/run-tests.mjs tests/windows
# tests 192  # suites 21  # pass 192  # fail 0  # skipped 0

$ npx tsc --noEmit
EXIT=0

$ node scripts/check-fsguard-imports.mjs
✅ FsGuard 导入检查通过（已检查 122 个文件，未发现绕过）。

$ node --import tsx scripts/evidence/lwb-018.ts
# 40 PASS / 0 FAIL / 5 NOT_RUN / 8 NOTE
EXIT=0
```

LWB-017 时为 `tests 902 / suites 148`。本轮 +47 例（`daemon-audit.test.ts` 全部）
与其余三处新增断言。
