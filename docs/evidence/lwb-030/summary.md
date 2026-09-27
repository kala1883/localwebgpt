# LWB-030 · 启动恢复与未知结果协调 — 证据

**采集方式：** `node --import tsx scripts/evidence/lwb-030.ts`（**退出码 0**；**176 PASS / 0 FAIL / 8 NOT_RUN / 2 NOTE**）
**采集环境：** Windows 11 Home China 10.0.26200 / Node v22.20.0 / win32 x64 / PowerShell 7.6.6 / **真 NTFS**（`%TEMP%` 下的临时工作区）
**测试套件：** 见 §9（类型检查、FsGuard 导入检查、`node --test`、vitest 各自的退出码与计数）
**原始日志：** 未入库（`*.log` 在 `.gitignore` 中，与 `lwb-006` ~ `lwb-029` 一致），
本次运行落在 `docs/evidence/lwb-030/raw.log`。下文引用的每条 `PASS` / `NOTE` 行均为运行输出的**逐字**摘录。

**门禁结论：G0 与 G2 均未通过。** 本任务交付的是**「上一个进程留下的现场」怎么被重新观测、
怎么被定案、以及唯一那条写入路径的授权**；它**不**让模型能读恢复记录 ——
`authorize` / `repair` / `records` 都不在工具面里（§8 静态钉住）。
`change_apply` 仍未接入工具面（LWB-032），因此**今天恢复这条路只能由测试与取证脚本驱动**。

**这一轮里最要紧的一句话：恢复的定案来自重新观测，不是来自账上的自述。**
下面每一处「回来了」都对应一次真的 `readFileGuarded`；而「没有写」是用**文件指纹**
（大小 + 最后写入时刻 + 内容哈希）证明的，不是用内容证明的。

---

## 0. 这一轮的证据是在什么装置上采的

四条步骤的原文：

> 1. 启动时先处理未终结操作，再开放工作区写能力。
> 2. 在受控句柄下比较当前身份/哈希与旧、新状态；分为未变、目标已达、第三种内容和身份不明。
> 3. 只有可证明安全的状态协调才自动完成；第三种内容保留原样，要求本地人工处理。
> 4. 恢复写入需要本地恢复授权；禁用连接不妨碍操作者查看恢复记录。

三条验收标准的原文：

> (a) 写入完成但应答丢失后，重启查询收敛为实际已达状态，不重复修改。
> (b) 用户在崩溃后继续编辑时不被自动恢复覆盖。
> (c) 数据库/快照不完整时默认暂停，不能当成新安装清空历史。

| 段 | 装置 | 为什么非这样不可 |
| --- | --- | --- |
| §0 | 真护栏后端的**自述** + `sqlite_master` 里的表/索引/触发器 | 「不可让渡的那几条」要用**真库的结构**验，读源码得出来的只是意图 |
| §1 | 真盘上留下一个 `APPLYING` 的操作，**关库**后再用同一个文件重开 | 步骤 1 说的是**次序**；而「重启」只有把上一个进程留下的一切原样交出去才算数 |
| §2 | 四格各在**真文件**上造一次（含删除重建） | 「身份不明」那一格的关键是**真对象身份**；编一个身份填进去，那一格就永远为假 |
| §3 | 真写盘之后，定案前后比**文件指纹** | 「一个字节都不写」的可核对形式是「三样都没变」，而不是「内容没变」 |
| §4 | 跑完 applier、**不跑协调器** | 这就是「写得完、应答丢」那个窗口本身，不是它的模拟 |
| §5 | 崩溃之后用户**真的**再写一次 | 验收 (b) 要的是一份**不属于插件**的现场，构造不出来就没有这一条 |
| §6 | 真删快照对象 / 真让护栏调用抛 / 真把库文件写成垃圾 | 验收 (c) 说「不完整」，而「不完整」有三种，行为各不相同 |
| §7 | 真签发、真消费、真在签发之后再改盘 | 「绑死在此刻的现场」只有在下一次观测里才看得见 |

**装置自述（§0 逐字）：**

```
PASS 原生护栏可用 — backend=powershell-pinvoke
PASS 护栏自述**不**提供跨文件事务 — 这句话是恢复流程必须逐条目写的理由
PASS 护栏自述**不**提供崩溃原子替换 — 因此「替换」在这台机器上不是一次原子动作
      环境自述：Microsoft Windows NT 10.0.26200.0 / PowerShell 7.6.6
PASS 状态库结构版本是 7 — KNOWN_SCHEMA_VERSION=7
PASS 恢复动作的词表被冻结在迁移里，且只有一条 — FROZEN_RECOVERY_DECISIONS=["ROLLBACK_TO_BASELINE"]
PASS 表里**没有**任何指向「写到目标」的动作 — 「把基线补写成目标」这条路在被授权执行的动作里不存在
PASS 一个操作上不会有两条同时有效的授权 — 部分唯一索引：一次授权不会被两个执行者各用一次
PASS 授权不得从非 ACTIVE 状态退回去
PASS 授权与它绑定的那次现场不可改写 — operation_id / workspace_id / volume_id 与摘要都锁死在 UPDATE 上
```

> **`FROZEN_RECOVERY_DECISIONS` 只有一条，而且它不指向「写到目标」。**
> 这是本任务在**库结构**上划的线：被授权执行的动作里根本没有「把基线补写成目标」这一项，
> 因此「不许重放旧批准」（§8.3 / §8.4）不是一条靠自觉遵守的规则，而是一条**写不出来的代码路径**。

---

## 1. 步骤 1：扫描把未终结操作标为待恢复，**不重放**

```
PASS 装置：真盘上两个文件都写成了 — kind=applied
      · 启动恢复：上一个进程留下 1 个未终结操作，已全部标为待恢复（未重放、未改字节）。
      · 启动恢复：操作 op_ae83d9ea11514173b638d82e7ed8503b（ws_ev30）经重新观测后协调为 APPLIED；本次定案没有写入任何字节。
PASS 扫描认出 1 个未终结操作 — leftovers=1
PASS 扫描**没有**重放它，而是重新观测后定案 — reconciled=1
PASS 没有留待人工
PASS 没有判定不成的
PASS 操作收敛到 APPLIED — state=APPLIED
PASS 并且被标为「经恢复协调而来」 — recovered=true
PASS 修改集同步收敛
PASS 它是一个收场的记录
PASS 扫描前后每个文件的大小、最后写入时刻、内容哈希三者全等 — 内容不变不足以说明没写过 —— 把同样的字节再写一遍也让内容不变
PASS 日志里有「上一个进程退出」那一条 — stages=item_intent,item_written,item_flushed,item_verified,item_intent,item_written,item_flushed,item_verified,recovery_swept,recovery_reconciled
PASS 日志里**没有**任何一条说「写了字节」 — recovery_repaired 这个阶段名本身就意味着动过字节
PASS 那条「标记」日志说清了「没有重放、没有改动字节」 — error_code=PROCESS_EXITED_DURING_EXECUTION
PASS 再重启一次：没有未终结操作 — leftovers=0
PASS 再重启一次：什么都没被改
PASS 两次扫描之间磁盘也没被动
```

**`recovered=true` 记的是什么。** 它记的是「这一次定案是恢复流程做出的」，
**不是**「我们确定是我们写的」—— 后者从来就不在判定里（方案 §8.4：内容等于目标并不总能证明是谁写的）。
§3 第二格是它的反面证据：全部还在基线上、定案为 `ROLLED_BACK` 时 `recovered` 是 **false**，
因为那条路上没有字节被写回去过。

**日志的阶段名与状态机的枚举名是两套词**（`RECOVERY_STAGE` 的文件头写明了理由）：
日志回答「发生过什么」，把它写成状态的第二份副本，会让「状态是 `APPLIED` 但日志说人工」
这种真正的矛盾再也读不出来。上面那一行 `stages=…` 里因此出现的是
`recovery_swept` / `recovery_reconciled`，而不是 `APPLYING` / `APPLIED`。

---

## 2. 步骤 2：判定四格，全部在真文件上

```
PASS 判定：d-target ⇒ TARGET_REACHED — kind=TARGET_REACHED
PASS 折叠：d-target ⇒ APPLIED / ALL_TARGET — kind=APPLIED reason=ALL_TARGET
PASS 观测带回了**真对象的身份**（d-target） — file_id=00760000000a3090
PASS 判定**只读**：没有写下任何一条日志 — before=4 after=4
PASS 判定**只读**：磁盘未被碰（d-target）
PASS 判定：d-original ⇒ ORIGINAL — kind=ORIGINAL
PASS 折叠：d-original ⇒ ROLLED_BACK / ALL_ORIGINAL — kind=ROLLED_BACK reason=ALL_ORIGINAL
PASS 观测带回了**真对象的身份**（d-original） — file_id=006e0000000a31a0
PASS 判定**只读**：没有写下任何一条日志 — before=0 after=0
PASS 判定**只读**：磁盘未被碰（d-original）
PASS 判定：d-third ⇒ THIRD_CONTENT — kind=THIRD_CONTENT
PASS 折叠：d-third ⇒ MANUAL / THIRD_CONTENT — kind=MANUAL reason=THIRD_CONTENT
PASS 观测带回了**真对象的身份**（d-third） — file_id=00420000000a31ef
PASS 判定**只读**：没有写下任何一条日志 — before=4 after=4
PASS 判定**只读**：磁盘未被碰（d-third）
PASS 判定：d-replaced ⇒ IDENTITY_UNKNOWN — kind=IDENTITY_UNKNOWN
PASS 折叠：d-replaced ⇒ MANUAL / IDENTITY_UNKNOWN — kind=MANUAL reason=IDENTITY_UNKNOWN
PASS 而它说得出是「身份变化」而不是「内容不对」 — reason=REPLACED_OBJECT
PASS 内容与目标逐字节相同，判定**仍然**不是「目标已达」 — §8.4：内容等于目标并不总能证明是谁写的
PASS 判定**只读**：没有写下任何一条日志 — before=4 after=4
PASS 判定**只读**：磁盘未被碰（d-replaced）
NOTE 四格的「凭什么」是可区分的 — 后两格都定不了案（kind 都是 MANUAL），而 reason 一个说「有一个我们不该覆盖的内容」，另一个说「对象不是被批准的那一个」。把两者合成一句「人工处理」会丢掉操作者唯一需要的线索。
```

**第四格是在真盘上造出来的，不是编的。** 「对象被替换过」这一格用**删除重建**构造：
护栏的文件索引取自 `BY_HANDLE_FILE_INFORMATION` 的两个索引字段，含 NTFS 的序列号，
**改名不改变它，删除重建会改变它**（这句话写在 `WinfsGuard.ps1` 的 `Get-FileIdHex` 注释里，
LWB-027 起写入路径就在用它比对）。脚本里因此有一道**装置自检**：
删除重建之后重新读一次文件索引，若它没变就报「装置不可用：这一格在真盘上没造出来」，
而不是让下面那条断言去证明一件没发生的事。

**为什么 `d-replaced` 的 `reason` 是 `IDENTITY_UNKNOWN` 而不是 `THIRD_CONTENT`。**
`reconciliationOf` 的判据顺序是**有意的**（`plan.ts` 里写明了），
`IDENTITY_UNKNOWN` 排在 `THIRD_CONTENT` 与 `MIXED` 之前：一个「三条已达 + 一条判不出」
如果折叠成 `MIXED`，那是一个**比真实原因更含糊**的答案，而操作者要读的恰恰是「哪一条判不出、为什么」。

---

## 3. 步骤 3：自动定案的两格，以及它们**不写字节**

```
PASS 全部已达 ⇒ 自动定案
PASS 定案为 APPLIED — after=APPLIED
PASS 定案报告里带着一份计划摘要（64 位十六进制） — plan_digest=8798b02bd6e4d7a6…
PASS 逐条目回执记成「核验到目标状态」 — state=RECOVERED_TARGET
PASS 回执上的 before 记的是**被批准的那份基线**
PASS 回执上的 after 记的是**这一次观测到的内容**
PASS 回执上没有错误码 — error_code=null
PASS 被标为经恢复协调而来
PASS 自动定案**没有**改写文件（大小/时刻/内容全等）
PASS 全在基线上 ⇒ 自动定案为 ROLLED_BACK — after=ROLLED_BACK
PASS 而它**没有**被标成「经恢复协调而来」 — 这条路上没有字节被写回去过，把它记成 recovered 会伪造一次写入
PASS 逐条目回执记成「核验到原状态」 — state=RECOVERED_ORIGINAL
PASS 该工作区不再需要恢复
PASS 这一格同样没碰文件
NOTE 「不写字节」是怎么量的 — 比的是**文件指纹**：大小 + 最后写入时刻 + 内容哈希。只比内容的话，一次「把同样的字节再写一遍」也会通过，而 mtime 会变。三样全等才叫没写过。
```

**回执上的两个哈希各记一件事**：`before_sha256` 是**被批准的那一份基线**（稳定锚点），
`after_sha256` 是**这一次观测到的内容**。一个哈希不声称归属，也不声称时间 ——
这与 §8.4 那句「恢复回执应说明『核验到目标状态』，不编造执行归属或时间」是一致的。

---

## 4. 验收 (a)：写得完、应答丢 ⇒ 收敛为「已应用」，不重复修改

```
PASS 装置：两个文件都写成了 — kind=applied
PASS 装置：docs/a.txt 的盘上字节等于被批准的目标
PASS 装置：deep/nest/b.txt 的盘上字节等于被批准的目标
      · 启动恢复：操作 op_560ac71a02b84c31b478499537bffc72（ws_ev30）经重新观测后协调为 APPLIED；本次定案没有写入任何字节。
PASS 重启后收敛为 APPLIED
PASS recovered=true（这一次定案是恢复流程做的）
PASS finished_at 有值（它不是一条悬着的记录）
PASS 修改集同步收敛为 APPLIED
PASS 这个工作区**不再**需要恢复
PASS 自动定案的有 2 个条目 — items=2
PASS 两个条目的判定都是「目标已达」
PASS 两条回执都是「核验到目标状态」
PASS **不重复修改**：两个文件的大小、时刻、内容哈希三者全等
```

**崩溃点是按验收标准挑的，不是模拟的。** `apply.ts` 落完盘就停在 `APPLYING`
（终局由协调器的 `#finalize` 落，见 LWB-027/028 的证据）。于是「写得完、应答丢」
这个窗口就等于「跑完 applier、不跑协调器」—— 它**就是**那个窗口本身。
两个文件分布在 `docs/` 与 `deep/nest/` 下，`deep/nest/` 是本次新建的目录，
顺带覆盖了「一次执行既要建目录又要跨目录写」的形状。

**「不重复修改」的判据是文件指纹，不是内容。** 只比内容的话，一次
「把同样的字节再写一遍」也会通过 —— 而 `mtime` 会变。三样全等才叫没写过。

---

## 5. 验收 (b)：用户在崩溃后继续编辑 ⇒ 恢复不覆盖

```
PASS 第三种内容**不**被自动定案
PASS 它落到「留待人工」 — awaiting_manual=1
PASS 原因是「第三种内容」 — reason=THIRD_CONTENT
PASS 操作停在待恢复
PASS 修改集同样停在待恢复
PASS 工作区被标着需要恢复
PASS 回执**不**声称任何一种「回来了」 — state=UNKNOWN
PASS 而它说得出为什么 — error_code=THIRD_CONTENT
PASS 回执上的 before 仍是被批准的那份基线
PASS 恢复记录读得到
PASS 记录里逐条目列得出这一条 — path=live.txt
PASS 记录里的操作状态是待恢复
PASS 记录里带着人工那一条日志
PASS 记录里**没有**「收场成功」那一条
PASS 一条授权都没有（没人批过什么）
PASS 脱敏：这一段日志文本里没有本机绝对路径
PASS 脱敏：记录的条目路径里没有本机绝对路径
PASS 收场判据是**拒绝**的（有现场不属于我们） — repair=refused
PASS 因此连恢复授权都签发不出来 — code=RECOVERY_REQUIRED
PASS 授权表里一条都没有
PASS 用户那一次编辑的字节与时刻**一个都没变**
```

**两条防线，一条是「不写」，一条是「连授权都签不出来」。**
前者是判定层：第三种内容落到人工，一个字节不动。后者是收场层：
只要还有第三种内容或身份不明，`repair` 就是**拒绝**的（`HAS_UNRESOLVED_ITEMS`），
因此**不存在**「在还有别的现场要处理的时候误触发一次收场」这条路径。

**人工那一步里没有「把目标补写上去」这条路。** §8.4 原文要求「不重放旧批准」；
上面这条 `repair=refused` 就是它在代码里的形态 —— 越过第三种内容就要动别人的内容，
而那条线正是整件事的边界。

---

## 6. 验收 (c)：数据库/快照不完整 ⇒ 默认暂停

### 甲：快照缺失 ⇒ 收场停下，历史仍然读得到

```
PASS 装置：第一条有基线快照可删
PASS 装置：快照对象确实不在了
      · 恢复写入中止：a.txt：取不到基线字节，取不到本条目的基线快照：快照对象缺失，拒绝继续（极可能是状态库与磁盘不一致）：objects/79/79ac23d0f17abbf585aaca3c85e44286654cef1803867a04829aecf29a79a31c。
PASS 扫描照常跑完（判定不需要快照）
PASS 装置：收场判据在快照缺失之前是成立的
PASS **一条都没收回来** — repaired=0
PASS 并且说得出为什么
PASS 原因是「取不到快照」
PASS 脱敏：那句原因里没有本机绝对路径
PASS 日志里有「收场失败」那一条 — stages=…,recovery_swept,recovery_manual_required,recovery_repair_failed
PASS 日志里**没有**「收场成功」那一条
PASS 状态没动：仍然是待恢复
PASS 历史读得到：那条授权还在记录里
PASS 而它已经被消费过（那是一次真实的动作）
PASS 逐条目回执仍然读得到
PASS **一个字节都没写**：文件指纹全等
```

**扫描那一步不读快照，收场那一步才读。** 判定表全部建立在**对工作区的观测**上
（`verdict.ts` 的文件头写明了），因此删掉快照不会让判定变成「判不成」——
它让**收场**停下。这条区别本身就是要证的事：把两者混在一起，
「快照没了」会被误报成「现在是什么都没看清」。

**「不完整」与「新安装」的区别在这里是可核的**：快照没了，而那条**已被消费**的授权
仍然在恢复记录里读得到 —— 历史留在原处。

### 乙：护栏不可用 ⇒ 判定不成，原样留着

```
PASS 护栏不可用时仍然把它标成待恢复 — leftovers=1
PASS 判定不成 ⇒ 进 undecidable — undecidable=1
PASS 它**不**被算进「留待人工」 — 判都没判成，谈不上人工判定
PASS 它**不**被算进「自动定案」
PASS 状态原样留着
PASS 恢复记录仍然读得到
PASS 工作区仍然带着未处理的恢复记录（写能力关着）
PASS 扫描那一条日志仍然在
PASS 判定不成时**一个字都没改**磁盘
```

**`undecidable` 与 `awaiting_manual` 是两件事**，而且必须分开：
前者是「连现在是什么都没看清」（一条事实的缺席），后者是「看清了，而它不属于我们」。
合成一格会让「护栏挂了」被报成「有一个我们不该覆盖的内容」，把操作者送去查一个不存在的东西。

这是本文件**唯一**一处非生产代码：一个逐方法转发的 `WinfsOps`，
只让 `readFileGuarded` 抛。它插的位置正是「判定做不成」那一条要问的地方 ——
真实现里这是 pwsh 起不来、或护栏进程中途消失时的形态。

### 丙：库文件坏掉 ⇒ 拒绝打开，不凭空建新库

```
PASS 坏掉的库**拒绝打开** — code=STORAGE_UNAVAILABLE
PASS 拒绝打开时**没有**改写那个文件
PASS 文件长度也没变（没有被截断成空库）
PASS 现场没有多出一个新库文件
```

`openDatabase` 的五条 fail-closed 条件（有用户表但无迁移记录 / 结构比本版本新 /
迁移校验和不符 / `PRAGMA` 值不符 / 文件坏了）在 LWB-006 的单元测试里逐条覆盖，
本条只补上**真文件**上的那一格：把一个 8192 字节的垃圾写进去，
它拒绝打开，而且那些字节**一个都没被改写**。

---

## 7. 步骤 4：本地恢复授权 —— 签发、钉住现场、一次性

```
PASS 混合态 ⇒ 不自动定案
PASS 原因是 MIXED — reason=MIXED
PASS 而收场判据是**允许**的
PASS 唯一的动作是「收回基线」，不是「写到目标」 — action=ROLLBACK_TO_BASELINE
PASS 收场目标按 seq 倒序（最后写的先收回） — targets=a.txt
      · 恢复授权已签发：操作 op_9c308695767442b7ba843ad7b6d7eb44，决定 ROLLBACK_TO_BASELINE，涉及 1 个条目，有效期至 2026-09-26T07:19:44.983Z。
PASS 授权签发出来了 — id=rec_ev30_0001
PASS 它钉住的是**此刻的现场**：一个 64 位摘要
PASS 有效期是 §9.3 的那个数字（10 分钟，与本地批准同一个） — 剩余 600s / 上限 10min
PASS 授权表里是 ACTIVE
PASS 同一份现场重算两次，收场目标逐条相同
PASS 收回了一条 — repaired=1
PASS 没有失败 — failed=null
PASS 定案是 ROLLED_BACK
PASS 授权一次性：用过了
PASS 操作定案为已回滚
PASS 修改集同步定案为已回滚
PASS 工作区不再需要恢复
PASS 第一个文件回到了基线字节
PASS 而它确实被改过（与写完之后那一份不同）
PASS 第二个文件（用户撤销过的那一个）一个字节都没被动
PASS 两条回执都是「核验到原状态」 — RECOVERED_ORIGINAL,RECOVERED_ORIGINAL
PASS 日志里有「收场成功」那一条 — stages=…,recovery_swept,recovery_manual_required,recovery_repaired,recovery_reconciled
PASS 收场那一条说清了「按本地恢复授权」
PASS 脱敏：收场日志里没有本机绝对路径
```

**乙：授权签发之后磁盘又被改过 ⇒ 消费被拒绝，且不烧掉授权**

```
PASS 装置：混合态，因此授权签得出来
PASS 拒绝执行 — code=RECOVERY_REQUIRED
PASS **没有**消费掉那条授权（它还在，只是对这份现场不成立）
PASS **没有**碰磁盘
PASS 状态仍是待恢复
```

**丙：禁用连接不妨碍查看恢复记录**

```
PASS 装置：连接已停用
PASS 装置：该工作区仍然被标成待恢复
PASS 停用之后恢复记录照样读得到
PASS 逐条目清单还在 — items=1
PASS 日志还在 — journal=6
PASS 操作状态还是待恢复
PASS 停用连接**没有**让收场变得可行（它本来就因为第三种内容被拒） — repair=refused
```

**「本轮唯一的一条恢复写入」是怎么被限住的。** 三处独立的东西：
① 被授权执行的动作词表里只有 `ROLLBACK_TO_BASELINE`（§0 已验，库里冻结）；
② 授权钉住的是一个**计划摘要** —— 签发之后有人动过盘，摘要就对不上，
**在一次写入发生之前**被数据库拒绝（§7 乙），而不是写到一半才发现；
③ 写回的前置条件是「对象身份 **且** 内容哈希同时成立」，由护栏在自己的句柄里核。

**被拒绝的消费不烧掉授权。** 一件「环境还没准备好」的尝试不该白白烧掉操作者的授权；
反过来，一次**成功**的消费是终局的（`CONSUMED`，且触发器不许退回 `ACTIVE`，§0 已验）。

**禁用连接与恢复记录的关系是刻意的。** 一个「停用连接之后连记录都看不了」的恢复流程，
会把人逼到「先把连接启用起来」这条路上 —— 而启用连接比看记录危险得多。
上面丙组第二条同时证明了反面：停用连接**没有**让收场变得可行。

---

## 8. 边界：模型侧够不到恢复包（静态判据）

```
PASS 模型侧扫到了文件（装置自检） — files=12
PASS 模型侧没有任何文件 import 恢复包（含相对路径与动态 import） — offenders=(无)
PASS 模型侧不提恢复授权表与「收场成功」这个阶段名 — files=(无)
PASS 装配根导入了恢复服务
PASS 装配根**确实** await 了启动扫描
PASS 启动扫描排在工具面**之前**（步骤 1 的「先处理，再开放」是一处行序） — sweep@1298 < surface@15408
PASS 逐工作区的 recovery_required 接的是真查询，不是常量
PASS 装配根里已经没有旧的那句「一律 false」
PASS 回退约束：恢复包里不存在 `git reset/checkout/stash/clean`
PASS 回退约束：恢复包里不存在删除文件的调用
```

**「先处理，再开放」在代码里是一处行序，而不是一句注释。**
`assembly.ts` 里 `sweepStartup()` 出现在 `createToolSurface(` **之前**
（字节偏移 1298 < 15408）。这个判据在 `tests/unit/recovery-boundary.test.ts` 里
也有一条同形的静态检查，本段是它在**真仓库文件**上的复算。

**`recovery_required` 今天接的是真查询。** 装配根里
`capabilityFlagsWith(BRIDGE_GATES, (workspace) => recovery.requiresRecovery(workspace))`
—— 它不再是 LWB-025 时期的 `() => false`。
关掉能力开关是**回退动作**；把它硬编码成假会让一个真值查询变成一句谎。

**回退约束的静态可核形式**：「不得通过覆盖用户文件实现代码回滚」落在三条上，
其中两条在这里被钉住 —— 恢复包里没有 `git reset/checkout/stash/clean`，
也没有删除文件的调用（本工程不删文件：一个多余的文件是可逆的，
因此宁可要求人工处理它，`CREATED_OBJECT_NOT_REMOVED`）。

---

## 9. 测试套件与门禁

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查（全部包与适配器） | `npx tsc --noEmit` | 退出码 0，无输出 |
| 类型检查（控制台） | `npm run typecheck:console` | 退出码 0 |
| FsGuard 导入检查 | `npm run check:imports` | ✅ 已检查 **168** 个文件，未发现绕过 |
| 单元与真盘测试 | `npm run test` | **1485** tests / 238 suites / **0 fail** |
| 控制台测试 | `npm run test:console` | 41 passed (41) |
| 以上五步的合取 | `npm run check` | **退出码 0** |
| 本任务交付的证据脚本 | `node --import tsx scripts/evidence/lwb-030.ts` | **退出码 0**；176 PASS / 0 FAIL / 8 NOT_RUN / 2 NOTE |

（逐次计数与历史对比见 `docs/PROGRESS.md` 的「当前仓库事实」一节 —— 本文件不重复抄写
一份会在下一次提交后过期的数字。）

> **`npm run check` 在本次采集期间**先红过一次：`node scripts/run-tests.mjs tests/windows`
> 单独跑时 241 / 242，红在 `tests/windows/files-search.test.ts` 的第一条，报的是
> `undefined !== 'src/app.ts'`。**与本任务无关**（把本任务新增的那个真盘用例挪开再跑，
> 仍然 241 / 242），是搜索的 3 秒预算按**挂钟**走、14 个测试文件并行时先于搜索本身用尽。
> 诊断、修法与**反向探针**逐条记在 `docs/PROGRESS.md` 的偏离项 120。
> 修完之后 `tests/windows` 连续三次 242 / 242，上表那一次 `npm run check` 是修完之后跑的。

**门禁：G0 未通过、G1 无判定记录、G2 未通过、G3 未通过、验收负责人未指定。**
本任务的证据**不**改变其中任何一条 —— 它覆盖的是 P3 阶段里「执行之后账怎么收场」这一层，
而它与真实仓库联调的许可仍以 `docs/evidence/g2-read.md` 的那句为准：
「P3 的编辑与审批可以在契约冻结的前提下继续实现，但**不得**在真实仓库上联调。」

---

## 10. 未执行项（`NOT_RUN`，逐字）

```
NOT_RUN 真实 ChatGPT 网页端验收（读—写—回读） — LWB-002 BLOCKED：需要真实账号在 Platform 侧建立 Secure MCP Tunnel 并完成控制台步骤；MCP Inspector 成功不能代替网页验收，因此这一条不计入 PASS
NOT_RUN 「写到一半进程真的被杀」留下的现场 — 护栏的写入是一次请求内的 校验→截断→写入→刷盘→回读，中间没有可以从外面插进去的窗口，本机也没有故障注入。「写得完、应答丢」这一格由 §4 覆盖；「读到一半」那一格由判定表覆盖
NOT_RUN `recovery_required` 真的挡住了一次新的写入 — 协调器尚未装配进守护进程（LWB-032）。今天它是一个**真实查询**的布尔（§8 已验），但「它被写路径读到并拒绝」要等接线完成
NOT_RUN 撤销一次**已终结**的提议 — 属 LWB-031。本任务的收场是「把已经写下去的收回来」，不是用户可见的撤销
NOT_RUN 跨卷 / 只读卷 / 卷被拔掉 — 同 LWB-027/028/029：本机只有一个固定卷，造不出第二种
NOT_RUN 两个进程真的同时抢同一块地 — 属 LWB-033（竞争/崩溃/故障专项）；LWB-026 已经用真跨进程取证证过互斥与接管
NOT_RUN 恢复授权过期之后被拒绝 — 真盘上要等十分钟才走到，而它证明的与 `tests/unit/recovery-persistence.test.ts` 同一条规则；单元那一份已经把「过期 ⇒ 拒绝」钉住
NOT_RUN 新建条目已达目标之后的收场 — `repairOf` 对 `TARGET_REACHED` 的新建条目一律拒绝（`CREATED_OBJECT_NOT_REMOVED`）：护栏没有删除操作，本工程不去造一个。真盘上造这一格要写 `create_text`，而它的裁决与改写条目同一张表 —— 单元测试 C 组已穷尽
```

**「写到一半进程真的被杀」这一条要写清楚它为什么造不出来**，而不是含糊过去：
护栏的写入是一次请求内的 校验→截断→写入→刷盘→回读，**中间没有可以从外面插进去的窗口**，
而本机没有故障注入。因此真正被覆盖的是**它的两侧**：
「写完了但应答丢了」（§4，真盘）与「读到一半」（判定表的 `OBSERVATION_TRUNCATED` 那一格，单元）。

---

## 11. 这一轮里发现并改掉的三处（都不在测试里，在代码里）

> 第 0 处不在恢复流程里，而在**库层的公共代码**上 —— 它是写恢复授权表的
> `CHECK` 约束时撞出来的，而它影响的是**五个**调用点；第 1、2 处是恢复流程自己的。

0. **`isUniqueViolation` 原本按 `SQLITE_CONSTRAINT` 前缀匹配**（`repositories.ts`）。
   构造一条**畸形摘要**（不是 64 位十六进制）期待 `CHECK constraint failed`，
   拿到的却是「该操作已存在有效恢复授权」—— 一句与实际原因无关的话。
   SQLite 的约束错误码至少六类，而那个函数的**五个调用点全部**把 `true`
   解释成「已存在，去读那一行」。收窄到 `_UNIQUE` / `_PRIMARYKEY` 之后，
   畸形输入以 `SQLITE_CONSTRAINT_CHECK` 原样上抛：那是**内部不变量被破坏**
   的信号，不该被任何调用点当成一个正常分支吃掉。
   逐条记在 `docs/PROGRESS.md` 的偏离项 119。

1. **`MANUAL` 那一支原本不写逐条目回执。** 发现的方式是测试里
   `records().items` 读出 `[]` —— 也就是说，一份**正等着人工处理**的记录，
   在操作者最需要逐条目清单的那一刻，清单里一条都没有。
   修法是让 `reconcile` 的 `MANUAL` 分支在**一个短事务**里写回执
   （`receiptStateOf` → 全部 `UNKNOWN`，`receiptReasonOf` → `THIRD_CONTENT`
   或身份不明的原因）。这是**记录**，不是**定案**：它不改状态、不写字节，
   一条都不声称「回来了」。`UNKNOWN` 这个回执状态本来就是为这一格准备的。
2. **`receiptReasonOf` 这个纯函数**随之被抽出来，把「判定 → 回执上的 `error_code`」
   收成一处：只有「没能给出结论」的两种有码，`ORIGINAL` / `TARGET_REACHED`
   是**结论**，给它们配一个错误码会把一次核验说成一次出错。

**这几处改动之后，全套测试的计数从 1473 变成 1485（+12，正是新增的那个真盘用例），
没有任何既有行为改变。** 第 0 处**改变了行为**（原先被吞掉的 `CHECK` 失败现在上抛），
因此它在别处另有一条独立的见证：`tests/unit/recovery-persistence.test.ts` 的 A4
断言 `assert.throws(…, /CHECK constraint failed/)`，而**它是先红后绿的** ——
在收窄之前它拿到的不是那句话，而是「该操作已存在有效恢复授权」。

## 12. 装置本身的一处诚实说明

`#liftBlockade` 有 `PREVIOUS_NOT_TERMINAL` / `SLOT_OPERATION_MISSING` 两个分支，
它们在生产认领路径（`claim.ts`）上**走不到** —— 那条路径在阻断写槽**之前**就
先把操作标成了 `RECOVERY_REQUIRED`。因此本文件只断言了可达的那个结果
（`blockade.kind === 'cleared'`），另两个分支的可核形式在
`tests/unit/recovery-plan.test.ts` 与真盘用例的「定案时解除写阻断」一条里。
一个没人能走到、却在证据里报 `PASS` 的分支，比没有这一条更糟。
