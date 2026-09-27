# LWB-020 · 实现不可变修改集和差异预览 — 证据

**采集方式：** `node --import tsx scripts/evidence/lwb-020.ts`（**退出码 0**；**57 PASS / 0 FAIL / 9 NOT_RUN / 36 NOTE**）
**采集环境：** Windows 11 Home China 10.0.26200 / Node v22.20.0 / tsx 4.23.15 / PowerShell 7.6.6 / TypeScript 5.9.3 /
护栏后端 `powershell-pinvoke`（`supports_file_identity=true`、`crash_atomic_replace=false`、`cross_file_transaction=false`）/
夹具仓库 `tests/fixtures/generated/testrepo`（HEAD `5eefeeedc616b82927d6424c4d78e64a39c6b8dc`，21 个文件）
**测试套件：** `tests/unit/changes-prepare.test.ts`（**56 例**，7 组）+
全仓 `tests 1062 / suites 169 / pass 1062 / fail 0`（LWB-019 时为 1006 / 162）
**静态检查：** `npx tsc --noEmit` 退出码 0；`node scripts/check-fsguard-imports.mjs` — **127 个文件**，未发现绕过
**原始日志：** 未入库（`*.log` 在 `.gitignore` 中，与 `lwb-006` ~ `lwb-019` 一致）。
下文引用的每条 `PASS` / `NOTE` 行均为运行输出的**逐字**摘录，本文件不依赖那份日志才可读。

**门禁结论：G2 未通过。** 本任务的全部证据采自夹具测试根与一个临时沙箱，
**没有任何一次写入发生在真实工作区上** —— 本任务的交付物里也**不存在**写入代码路径。
这符合 `docs/evidence/g2-read.md` 对 P3 的口径（「可以在契约冻结的前提下继续实现，
但不得在真实仓库上联调」）。

---

## 0. 这一轮的证据是在什么装置上采的

```
NOTE 护栏能力 — available=true backend=powershell-pinvoke supports_file_identity=true crash_atomic_replace=false cross_file_transaction=false
NOTE 夹具原树 — D:\MyProjects\MyApps\LocalWebGPT\tests\fixtures\generated\testrepo（只读；快照 138 项）
NOTE 工作区 — C:\Users\mj\AppData\Local\Temp\lwb-evidence-020-4J5apu\workspace（夹具的副本；副本的 file_id 与原树不同，因此票据身份必须取自实际被读的对象）
NOTE 状态库 — schema_version=4 迁移 1,2,3,4；路径 C:\Users\mj\AppData\Local\Temp\lwb-evidence-020-4J5apu\state.sqlite
NOTE 工作区根身份 — c6e22015:00cd000000045048 generation=1 （取自护栏 statVolume；不是路径字符串比较）
NOTE 语料 — 夹具 21 个；可编辑且换行可写 10 个：文档/设计说明.md、资料/2026年方案/📄笔记.txt、bom/with-bom.txt、newline/lf.txt、newline/crlf.txt、newline/no-trailing-newline.txt、README.md、src/main.ts、src/staged.ts、src/untracked.ts
PASS 装置前提：同一条路径经 statVolume（绝对路径）与 readFileGuarded（根 + 相对路径）报出的身份一致 — c6e22015:001d0000001e1506
NOTE LIMITS（与 DEFAULT_PREPARE_LIMITS 同源） — MAX_EDITABLE_FILE_BYTES=2097152 MAX_CHANGE_FILES=20 MAX_CHANGE_TOTAL_BYTES=8388608 CHANGE_TTL_MS=86400000
```

四件事决定了这轮证据能证明什么：

1. **工作区是夹具的副本，不是夹具本身。** 副本的 `file_id` 与原树必然不同（NTFS 的
   文件索引在创建时分配）。因此任何「票据里的身份取自路径字符串 / 取自夹具清单」
   的实现都会当场炸掉，而只有真正拿护栏问出身份的实现能跑通。脚本另外对**原树**
   做了首尾快照 —— 证明整场跑下来它连 mtime 都没动过。
2. **语料按策略层裁定，不看夹具清单的 `editable` 字段。** 这是 LWB-019 实测到的坑，
   本轮沿用：`config/.env.example` 在清单里写着 `editable: true`，而 `HD-ENV`
   连读都硬拒绝它（方案 §4.3 明令不做 `.env.example` 豁免）。拿清单字段当结论，
   就会把一个根本读不到的文件算进「可编辑语料」。见 §1.d2。
3. **「不写」有三条互相独立的证据。** 运行期计数（护栏写方法被调用 0 次）、
   静态扫描（`prepare.ts` 源码里不出现写方法名）、以及整棵目录树的逐字节快照。
   三者任一单独成立都可能骗人：计数为 0 可能是「什么都没跑」，
   静态扫描可能是「方法名被间接调用」，快照可能是「刚好没比对到」。
4. **摘要要能被重算，才算真的绑住了内容。** 「批准绑定摘要」这句话在跨进程时成立，
   前提是执行那一刻能从状态库里把同一个摘要重新算出来。因此脚本先用**第二条连接**、
   整场跑完再**关库重开**，两次都只拿落库的行重算，逐字符比对。

---

## 1. 验收标准逐条

### 验收标准 1 · prepare 不改变用户工作区任何文件

#### 1.a 三种 op 各自的前后整树比对

```
NOTE a edit_text — chg_623ec278-1f2d-4e47-b19b-8b4135ba9fab state=PENDING_APPROVAL workspace_modified=false files=1 digest=e6fabac1d0ddbdb5…
PASS a edit_text：整棵工作区目录树逐字节不变（含 mtime 与目录项增删） — 快照 138 项，逐项相同
PASS a edit_text：返回值声明 workspace_modified=false — false
NOTE a replace_text — chg_5e01b834-c3d4-4f2b-92e2-3ac87c1dc9e6 state=PENDING_APPROVAL workspace_modified=false files=1 digest=9e53218e362b5fa5…
PASS a replace_text：整棵工作区目录树逐字节不变（含 mtime 与目录项增删） — 快照 138 项，逐项相同
PASS a replace_text：返回值声明 workspace_modified=false — false
NOTE a create_text — chg_2dcf6b67-1c54-435a-866c-b533155fccbc state=PENDING_APPROVAL workspace_modified=false files=1 digest=ae4d2216865e7883…
PASS a create_text：整棵工作区目录树逐字节不变（含 mtime 与目录项增删） — 快照 138 项，逐项相同
PASS a create_text：返回值声明 workspace_modified=false — false
PASS a create_text 的目标文件在 prepare 之后仍然不存在（工作区里没有它） — 不存在
```

快照的每一项是 `相对路径 → 内容 SHA-256 + 大小 + mtime`，目录记 `dir mtime`，
并且**目录项的增删**也算差异（`出现：` / `消失：`）。三种 op 各自独立快照一次：
即使某一段真的写了，也能定位到是哪一个 op 写的。

「返回值声明 `workspace_modified=false`」是另一条独立的断言：`ChangeSetView` 把这个
字段声明成字面量 `false`，因此它不是「本次打算不写」，而是「这条返回值没有别的可能」
（`prepare.ts` 的注释写明了这一点）。

新建类提案额外查一次**目标文件是否真的不存在** —— 一个只凭返回值判断的脚本
会漏掉「文件建出来了但状态没落库」。

#### 1.b 运行期：护栏的写方法一次都没被调用

```
PASS a 运行期：护栏的写方法（writeFileGuarded / createFileGuarded）一次都没有被调用 — 读方法被调用了 3 次，故计数不是空转
PASS a 运行期：prepare 确实读了文件（否则上面那条可能是「什么都没跑」） — reads=3 probes=3
PASS 收尾：整场跑完，护栏写方法累计调用次数仍为 0 — 读方法累计 35 次、路径探针 41 次
```

护栏被包了一层**记录型**包装器：写方法照常**转发**到真实护栏，只是先记一笔。
转发而不是直接抛错，是因为这样「不写」的证据就不是「它撞墙了」，而是「它压根没往那走」；
而万一真走了，那一笔写会真实发生，随后被目录树快照抓到 —— 两道证据互相独立。

第二条 `PASS` 是防自欺的：如果 `reads=0`，那么「写方法调用 0 次」只说明这段代码
什么都没干。整场跑完再统计一次，是因为三段验收之外还有风险与拒绝面那一段。

#### 1.c 静态：`prepare.ts` 源码里不出现任何写方法名

```
NOTE a 静态扫描 — prepare.ts 里出现 readFileGuarded、resolvePath；未出现任何写方法名
PASS a 静态：prepare.ts 源码里不出现任何写方法名（结构性保证，不靠作者记得） — 只出现 readFileGuarded、resolvePath
```

这一条与运行期计数是**不同的证据**：运行期计数证明「这次没写」，静态扫描证明
「这条代码路径里没有写的能力」。后者不受测试用例覆盖面影响 —— 一个没被任何
用例走到的分支若能写文件，运行期计数是看不见它的。

断言同时要求 `readFileGuarded` 与 `resolvePath` **都出现**（各 3 处）：否则
「把文件删空」也能让这条通过。

#### 1.d prepare 不产生批准、也不产生执行记录

```
NOTE a 状态库 — approvals 0 → 0；operations 0 → 0
PASS a prepare 全程不产生 approvals 行、不产生 operations 行 — approvals=0 operations=0
PASS d2 被硬拒绝的路径一个都没有进入可编辑语料：修改集这一层拿不到它们的票据 — 硬拒绝 4 个、可编辑 10 个，两者不相交
NOTE d2 硬拒绝语料 — secrets/.env、secrets/aws.env、secrets/id_rsa、config/.env.example（含 config/.env.example：`.env.example` 不被自动豁免）
```

计数用**独立的第二条连接**直接 `SELECT COUNT(*)`，不借用 `Repositories` 的内部连接 ——
它本就不该被暴露。`approvals` 与 `operations` 是「批准发生了」与「写入发生了」的
两个事实来源，两者都保持 0，说明 prepare 阶段既没有批准也没有落盘。

`d2` 是同一件事在语料侧的体现：四个被 `HD-ENV` / 私钥规则硬拒绝的路径，
一个都没有出现在可编辑语料里 —— 它们连票据都拿不到，因此**不可能**进入任何修改集。
注意 `config/.env.example` 在夹具清单里写着 `editable: true`，而 `HD-ENV` 拒绝它；
这条 `PASS` 顺带把「`.env.example` 不被自动豁免」钉在了证据里。

---

### 验收标准 2 · 相同幂等请求得到同一修改集，变更内容得到不同摘要

#### 2.b1 同键同内容 → 同一个修改集

```
NOTE b1 第一次 — change_id=chg_f3d592e7-aaab-4d75-b2f2-f95bc44623fd digest=8e94a6275256e1753cbf0911676eb4ec2f7a5aa6f5f24c33262e1ad012267f17 short=8E94-A627 replay=false
NOTE b1 第二次 — change_id=chg_f3d592e7-aaab-4d75-b2f2-f95bc44623fd digest=8e94a6275256e1753cbf0911676eb4ec2f7a5aa6f5f24c33262e1ad012267f17 short=8E94-A627 replay=true
PASS b1 同一个键 + 同一份内容 → 同一个 change_id、同一个 digest — 一致
PASS b1 第二次被标记为幂等重放（没有新建修改集） — first=false second=true
PASS b1 重放返回的逐文件预览与第一次逐字段相同 — 1 个文件
```

三条断言各挡一种实现：`change_id` 相同挡「同键也新建」；`replay=false → true`
挡「两次都新建但恰好算出同一个摘要」；预览逐字段相同挡「重放返回一个空壳修改集」——
后者在只看摘要时是看不出来的，因为摘要来自落库的条目，而不是来自这次返回的对象。

#### 2.b2 内容不同 → 不同的修改集、不同的摘要

```
NOTE b2 换内容 — change_id=chg_a53bed4e-f524-4e85-ade1-946b81cf6f0f digest=3effe5285f7c40bba4e7631283f262c5cce25bc577b44b7ea4a18c87f3e346a4 short=3EFF-E528
PASS b2 内容不同 → change_id 不同、digest 不同、短核对编号不同 — 8E94-A627 ≠ 3EFF-E528
```

只有「相同请求 → 相同摘要」是不够的：一个把摘要写死的实现也能满足它。
`b2` 与 `b1` 合起来才是「摘要**区分**内容」这句话。短核对编号是给人眼比对的
（`shortCodeOf` 取摘要前 8 位），因此它也一并要求不同 —— 编号相同而摘要不同
意味着屏幕上两处看起来一样，而它们其实是两份不同的修改。

#### 2.b3 同键换内容 → 冲突，且既有修改集一字未改

```
NOTE b3 同键换内容 — IDEMPOTENCY_CONFLICT/IDEMPOTENCY_KEY_REUSED；既有修改集 digest 仍为 8e94a6275256e175…
PASS b3 同一个键换一份内容 → IDEMPOTENCY_CONFLICT，且既有修改集一字未改 — IDEMPOTENCY_CONFLICT/IDEMPOTENCY_KEY_REUSED
```

这是幂等最容易被做错的一格：如果实现「同键就覆盖」，那么一次重试会悄悄把用户
已经看过的修改集换成另一份内容，而批准很可能还是针对旧的那份做的。
`idempotency_immutable_key` 触发器在库层挡住了覆盖，这里从**契约层**再验一次。

#### 2.b4 摘要可由「只读落库的行」重算

```
NOTE b4 第二条连接重算 — 落库 digest=8e94a6275256e175… 重算=8e94a6275256e175… 改动一个 hash 后=420ac84551c1e993…
PASS b4 用独立连接、仅凭落库的行重算出的摘要与落库值逐字符相同 — 逐字符相同
PASS b4 摘要真的覆盖内容：把预览里一个 after_sha256 改掉，摘要就变 — 改了之后 digest 变了（说明摘要不是只绑定 ID 之类的元数据）
PASS b4 重算覆盖的字段确实来自落库：契约版本 / 策略版本 / 代次 / 工作区 — 0.1.0 / 11 / 1 / ws-evidence-020
PASS 收尾：关闭并重开状态库后，仅凭落库的行重算出的摘要与建立时逐字符相同 — 8e94a6275256e175… == 8e94a6275256e175…
```

这一条是**本任务里最重要的一条**，因为它决定了「批准绑定摘要」在跨进程时是不是
一句空话：批准发生在控制台，执行发生在 daemon，中间隔着一次状态库往返。若摘要只能
靠内存里的对象重算，那一刻就没有可比对的东西。

- `b4` 用**第二条连接**（与写入连接无关）读落库的行重算，逐字符相同。
- 「改动一个 hash 后摘要变了」是防「摘要其实没覆盖内容」：一个只哈希
  `workspace_id` 的实现也能通过第一条。改动的是**预览里的** `after_sha256`，
  即「人工核对时看到的那一列」。
- 收尾那一条是**关库 → 重开**：进程退出再进来能拿到的只有磁盘上的字节。
  它比 `b4` 强，因为第二条连接仍与第一条共存于同一进程。

#### 2.b5 全语料：内容不同的文件不会撞摘要

```
PASS b5 全部可编辑语料各建一份修改集，摘要两两不同 — 建了 10 份、得到 10 个互不相同的摘要（下界 10）
PASS b5 短核对编号也两两不同 — 10 个
```

下界写死成 10 而不是用 `corpus.editable.length`：语料是脚本自己筛出来的，
拿它自己当上界的话「筛空了」也会通过。

---

### 验收标准 3 · 预览显示的最终字节与待应用 blob 一致

#### 3.c1 三方一致

```
PASS c1 全部可编辑语料：预览的 after_sha256/after_size == 快照库实际字节 == 独立拼装的产物 — 检查了 10 个文件（下界 10）
NOTE c 文档/设计说明.md — lf 300B → 325B，增量 +1/−1，三方哈希一致
NOTE c 资料/2026年方案/📄笔记.txt — lf 58B → 79B，增量 +1/−1，三方哈希一致
NOTE c bom/with-bom.txt — lf+BOM 34B → 56B，增量 +1/−1，三方哈希一致
NOTE c newline/lf.txt — lf 30B → 60B，增量 +1/−1，三方哈希一致
NOTE c newline/crlf.txt — crlf 39B → 67B，增量 +1/−1，三方哈希一致
NOTE c newline/no-trailing-newline.txt — lf 27B → 53B，增量 +1/−1，三方哈希一致
NOTE c README.md — lf 58B → 83B，增量 +1/−1，三方哈希一致
NOTE c src/main.ts — lf 109B → 114B，增量 +1/−1，三方哈希一致
NOTE c src/staged.ts — lf 28B → 40B，增量 +1/−1，三方哈希一致
NOTE c src/untracked.ts — lf 31B → 40B，增量 +1/−1，三方哈希一致
```

**「预览 ↔ blob」两方比对是不够的**：两方同时错就是「一致」。因此这里有三方：

| 方 | 来源 | 判据 |
| --- | --- | --- |
| 一 | 预览里声明的 | `after_sha256` / `after_size` |
| 二 | 快照库里**实际的字节** | `blobs.getVerified()` 读回来再哈希 |
| 三 | **独立拼装** | 只用磁盘原字节 + 解码索引，按「第 1 行的字节区间」手工拼一遍 |

第三方刻意不复用 prepare 的任何中间量。同时核对旧 blob 的哈希等于磁盘原文件
（否则「before 侧」可能是凭空造的），以及落库条目的 `target_sha256` 等于预览的
`after_sha256`（否则预览与将要执行的东西是两回事）。

#### 3.c2 边界样本：换行 / BOM / 编码声明与 blob 实际字节吻合

```
NOTE c2 newline/crlf.txt 第 1 行 — 声明 crlf/false/utf-8；实测 crlf/false；末字节 "\n"；与独立拼装一致 true
PASS c2 newline/crlf.txt：预览声明的 newline/bom/encoding 与 blob 实际字节一致 — crlf/false/utf-8
PASS c2 newline/crlf.txt：末尾行终止符形态保持不变（仍然有） — 末字节 "\n"
NOTE c2 bom/with-bom.txt 第 1 行 — 声明 lf/true/utf-8-bom；实测 lf/true；末字节 "\n"；与独立拼装一致 true
PASS c2 bom/with-bom.txt：预览声明的 newline/bom/encoding 与 blob 实际字节一致 — lf/true/utf-8-bom
PASS c2 bom/with-bom.txt：末尾行终止符形态保持不变（仍然有） — 末字节 "\n"
NOTE c2 newline/no-trailing-newline.txt 第 2 行 — 声明 lf/false/utf-8；实测 lf/false；末字节 ""；与独立拼装一致 true
PASS c2 newline/no-trailing-newline.txt：预览声明的 newline/bom/encoding 与 blob 实际字节一致 — lf/false/utf-8
PASS c2 newline/no-trailing-newline.txt：末尾行终止符形态保持不变（仍然没有） — 末字节 ""
```

声明不是被信任的，而是被**反向核对**的：把 blob 的字节重新解码一遍，
它的 `newline` / `bom` 必须与预览声明的相同；CRLF 的文件里必须真的出现 `0x0d`，
其余文件里必须一个 `0x0d` 都没有。

`no-trailing-newline.txt` 那一条改的是**第 2 行，也就是末行** —— 它没有行终止符。
产物必须仍然没有终止符。「写入时顺手补一个换行」是一种真实且常见的破坏，
而它在这份夹具上会让「未触及的字节保持不变」失效。

#### 3.c3 增量行数落库后可直接读回

```
NOTE c3 落库的增量行数 — newline/no-trailing-newline.txt +1/−1
PASS c3 预览里的增量行数可以直接从 change_items 的列读回（不需要重算） — +1/−1
```

`added_lines` / `removed_lines` 是迁移 v4 特意加进 `change_items` 的列。
理由与 `b4` 同源：预览要在**执行之后**仍然能被复现（控制台事后查看、审计追问），
而那时原始字节已经不在内存里了。只从落库的行重建预览，增量行数必须还是同一个数。

#### 3.c4 新建文件的预览：before 侧为空

```
NOTE c4 新建 — before=null after=2005e9ff3b6fe319… 头部 [239,187,191]
PASS c4 create_text：before 侧为空、after 侧逐字节等于提交内容（含 BOM 与 CRLF） — 18B
```

头部 `[239,187,191]` 就是 UTF-8 BOM。产物被要求**逐字节**等于
`'\uFEFF甲\r\n乙\r\n丙\r\n'`，因此「BOM 丢了」「CRLF 被归一成 LF」都会失败。
`before_sha256` 为 `null` 而不是空串哈希，是契约上的区分：
「原来没有这个文件」与「原来是个空文件」是两件事，摘要里也分得开。

---

### 拒绝面：建立修改集时的当场复核

#### 票据相关的七种拒绝

```
PASS e1 票据过期 → READ_TOKEN_STALE/TICKET_EXPIRED，且不留下修改集 — READ_TOKEN_STALE/TICKET_EXPIRED；修改集 30 → 30
PASS e2 票据属于别的连接 → READ_TOKEN_STALE/TICKET_CROSS_CONNECTION，且不留下修改集 — READ_TOKEN_STALE/TICKET_CROSS_CONNECTION；修改集 30 → 30
PASS e3 票据属于别的代次（撤权后不继承） → READ_TOKEN_STALE/TICKET_GENERATION_MISMATCH，且不留下修改集 — READ_TOKEN_STALE/TICKET_GENERATION_MISMATCH；修改集 30 → 30
PASS e4 票据属于别的工作区 → READ_TOKEN_STALE/TICKET_CROSS_WORKSPACE，且不留下修改集 — READ_TOKEN_STALE/TICKET_CROSS_WORKSPACE；修改集 30 → 30
PASS e5 票据指向别的路径 → READ_TOKEN_STALE/TICKET_PATH_MISMATCH，且不留下修改集 — READ_TOKEN_STALE/TICKET_PATH_MISMATCH；修改集 30 → 30
PASS e6 票据声称不可编辑（出站层已判定） → READ_TOKEN_STALE/TICKET_NOT_EDITABLE，且不留下修改集 — READ_TOKEN_STALE/TICKET_NOT_EDITABLE；修改集 30 → 30
PASS e7 提案声明的基线与票据记录不一致 → READ_TOKEN_STALE/TICKET_BASE_MISMATCH，且不留下修改集 — READ_TOKEN_STALE/TICKET_BASE_MISMATCH；修改集 30 → 30
```

除 `e1`（用一张**真的**过期的票 —— 在过期时刻之后铸）之外，其余都是拿一张
字段全对、**只改一项**的真票。理由是：手拼一个垃圾字符串只能证明「垃圾被拒绝」，
证明不了「这一项被单独校验」。

每条同时断言**修改集数量不变**（`30 → 30`）：一次失败的 prepare 若留下半个修改集，
用户会在控制台看到一个永远无法批准的条目，而这类残留只有查表才看得见。

`e3` 是撤权路径的那一条：工作区代次递增之后，撤权前签发的票据一律失效，
因此「撤销授权」不需要去追着删票据 —— 代次不匹配就把它们全废了。
`e6` 是出站层那条：一张声称「不可编辑」的票据不得用于编辑，
即使它的身份、路径、基线全对。

#### 磁盘在读取之后被换掉：三个方向

```
PASS e8 读取之后文件被追加：READ_TOKEN_STALE/TICKET_SIZE_MISMATCH（不是「按现在的字节硬改」） — READ_TOKEN_STALE/TICKET_SIZE_MISMATCH
PASS e9 读取之后同尺寸原地改写：READ_TOKEN_STALE/TICKET_CONTENT_MISMATCH（尺寸判据抓不到的，内容判据抓得到） — READ_TOKEN_STALE/TICKET_CONTENT_MISMATCH
PASS e10 读取之后文件被删掉重建：READ_TOKEN_STALE/TICKET_IDENTITY_MISMATCH（尺寸与内容都还原了，只有身份能抓住） — file_id 001c0000001e1577 → 001d0000001e1577；READ_TOKEN_STALE/TICKET_IDENTITY_MISMATCH
```

这三条是一条链，各挡一种更弱的实现：

- `e8`：只比尺寸是抓不住 `e9` 的（同尺寸改写），所以必须有内容判据。
- `e9`：只比内容哈希是抓不住 `e10` 的 —— 删掉重建之后内容一模一样。
- `e10`：把文件删掉再写回同样的字节，尺寸与哈希**都相同**，只有 NTFS 的文件索引
  变了（`001c…` → `001d…`）。这一条只能靠护栏问出的 `file_id` 抓住，
  而它正是「按字符串前缀判路径安全」这类实现永远抓不到的东西（I05）。

#### 落点、形状与上限

```
PASS e11 create_text 撞上已存在的文件：FILE_VERSION_CONFLICT/TARGET_EXISTS（绝不覆盖） — FILE_VERSION_CONFLICT/TARGET_EXISTS
PASS e12 create_text 撞上已存在的目录：FILE_VERSION_CONFLICT/TARGET_EXISTS — FILE_VERSION_CONFLICT/TARGET_EXISTS
PASS e13 create_text 的父目录不存在：NOT_FOUND（V1 只支持在已存在的父目录里新建） — NOT_FOUND/(无 reason)
PASS e14 同一个文件在一次修改集里出现两次：INVALID_ARGUMENT/DUPLICATE_TARGET_PATH — INVALID_ARGUMENT/DUPLICATE_TARGET_PATH
PASS e15 相对路径里的 `..`：INVALID_ARGUMENT/CHANGE_PATH_INVALID，且 path_reason=PARENT_REF — INVALID_ARGUMENT/CHANGE_PATH_INVALID path_reason=PARENT_REF
PASS e16 修改集总字节上限：SIZE_LIMIT_EXCEEDED/CHANGE_TOTAL_TOO_LARGE（上限可调，边界跟着动） — SIZE_LIMIT_EXCEEDED/CHANGE_TOTAL_TOO_LARGE
```

`e11` 与 `e12` 用同一个码，是因为调用方不必区分「提议时被拒」与「执行时被拒」——
护栏把 `CREATE_NEW` 撞上已有对象判为 `FILE_VERSION_CONFLICT`，prepare 提前给出同一个答案。
`e13` 的原因值得写下来：护栏对「目标不存在」与「父目录也不存在」给的是同一个
`NOT_FOUND`，只判目标是否存在，会把一份**永远执行不了**的修改集放进队列 ——
它看起来待批准，批准之后必然失败。

`e16` 把上限调到 1 字节：如果拒绝来自某个写死的常量而非可注入的上限，
这条就会失败。

#### 幂等键的可用性与「模型制造批准」的旁路

```
NOTE e17 越界编辑 — READ_TOKEN_STALE/EDIT_RANGE_NOT_READ
PASS e17 参数校验失败不占用幂等键：改对之后同一个键仍然建出了修改集 — first=READ_TOKEN_STALE/EDIT_RANGE_NOT_READ second=chg_9f09862b-4a78-439e-8a46-f59331d001d8
NOTE e18 approved:true 之类的额外字段 — state=PENDING_APPROVAL approval_required=true 活动批准=无
PASS e18 输入里的 approved/user_id/conversation_label 不产生任何批准：初态恒为 PENDING_APPROVAL — PENDING_APPROVAL，活动批准记录 0 条
```

`e17`：越界编辑报的是 `READ_TOKEN_STALE`/`EDIT_RANGE_NOT_READ` 而不是参数错误 ——
补救办法是「重新读取」，因此它属于票据失效。同时它验证了一件容易漏掉的事：
**校验失败不得占用幂等键**。占用了的话，模型改对参数重试会撞上
`IDEMPOTENCY_CONFLICT`，而它手里并没有那个修改集。

`e18` 是本任务的红线：输入里塞 `approved: true` / `user_id` / `conversation_label`
（ADR-003 §4 点名的三个反模式字段），结果必须是**什么都不发生** ——
`state` 恒为 `PENDING_APPROVAL`、`approval_required` 恒为 `true`、
`approvals` 表里 0 条活动记录。这三个字段既不参与判定，也不落 `metadata`：
本任务的契约里根本没有它们的位置。

#### 不可变：落库之后改不动

```
PASS e19 修改集一经建立内容不可变：另一条连接改 change_items / changesets 都被触发器拒绝 — change_items 拒绝；changesets 拒绝
PASS e19 被拒绝之后落库摘要仍然不变 — a6551590bcc6a140…
```

用**另一条连接**直接发 `UPDATE`（绕开仓储 API），因此证明的是库层的触发器，
而不是某段 TypeScript 的自觉。「被拒绝之后摘要仍然不变」是防「触发器抛错了，
但行已经被改了」这种半成功状态。

#### 风险提示

```
      [notice] MULTIPLE_FILES — 本次修改涉及 2 个文件；批准前请逐个核对。
      [warning] WHOLE_FILE_REPLACED — 整文件替换（不是逐行补丁）：newline/lf.txt
      [notice] NEW_FILE_CREATED — 新建文件：证据-新建3.ps1
      [warning] EXECUTABLE_OR_SCRIPT — 可执行或脚本文件：证据-新建3.ps1
PASS d1 整文件替换 + 新建脚本 + 多文件：四条风险提示都出现 — MULTIPLE_FILES、WHOLE_FILE_REPLACED、NEW_FILE_CREATED、EXECUTABLE_OR_SCRIPT
PASS d1 风险由落库事实推导、不落库：再推导一次结果相同 — 4 条
```

风险**不落库**，而是每次从 `change_items` 重新推导。这样做的代价是每次预览都要
算一遍，收益是风险规则可以改而历史修改集不会被追认为「当时提示过」——
一条落库的风险提示会在修改集建立之后与事实脱钩。上面第二条 `PASS` 就是这条性质：
拿落库的行再推导一次，结果与当次返回的逐字节相同。

---

## 2. 一处**产品缺陷**：在工作区根下新建文件

这一轮证据抓到了一个单元测试抓不到的缺陷，值得单独记。

**现象。** 第一轮运行（`create_text` 的目标是工作区根下的 `证据-新建.txt`）：

```
FAIL 验收 1 段跑完 — PATH_UNSAFE：相对路径为空，而工作区根是一个目录：C:\Users\mj\AppData\Local\Temp\lwb-evidence-020-CU6IhC\workspace。本操作需要一个具体目标；列举根目录请用 listDirectory。（护栏码 PATH_UNSAFE）
      details={"winfs_code":"PATH_UNSAFE","win32_error":0}
          at toBridgeError (D:\MyProjects\MyApps\LocalWebGPT\packages\files\src\guard-bridge.ts:233:10)
          at resolveTarget (D:\MyProjects\MyApps\LocalWebGPT\packages\files\src\guard-bridge.ts:322:35)
```

**根因。** `requireCreatable` 把目标路径的父目录算出来探一次，而顶层文件的父目录
是空串：`path.lastIndexOf('/') === -1` → `parent = ''`。护栏的 `resolvePath` 对
「目录根 + 空相对路径」是**故意**拒绝的（那句错误提示是护栏自己写的，它还指出了
正确的做法是 `listDirectory`）。于是「在工作区根下新建一个文件」——一次完全正常的
提案 —— 变成了 `PATH_UNSAFE`。

**为什么单元测试没抓到。** 夹具桩 `tests/tools/fixture-ops.ts` 对空相对路径是**宽松**的
（它把 `''` 当成根，按 `expect` 判类型），而全部 `create_text` 用例走的都是子目录
（`docs/新增.md`）。桩比真实护栏松，缺陷就落在两者之间。

**修复。** 与 `@lwb/files` 的目录列举走同一条路（`list.ts` 的 `resolveBase` 早就
处理过这同一个护栏行为）：父目录是目录工作区的根时，不再多探一次，根的目录性质
取自作用域（登记工作区时写下的 `kind`），根的身份由护栏在**每一次** `Open-GuardedChain`
里重新核实（句柄算出的卷序列号与文件索引必须与请求里的 `root_volume_id` /
`root_file_id` 逐位相同，否则 `ROOT_IDENTITY_MISMATCH`）。省掉的是一次**重复**的证明，
不是一次缺失的证明。唯一真正少掉的是根目录的硬链接计数 —— NTFS 的目录不支持硬链接
（`CreateHardLinkW` 对目录直接失败），目录的别名只能是重解析点，而重解析点由护栏
逐级判定拒绝；父目录是**子**目录时那条检查仍然照常执行。

**修复后**（本节开头的完整 PASS 列表即修复后的运行）：验收 1 的 `create_text`
段落、验收 3 的 `c4`、拒绝面的 `e11`/`e12` 全部通过。

**同时补的回归。** `tests/unit/changes-prepare.test.ts` 增加一例
「在目录工作区的根下新建文件 → 正常建立」，并在注释里**写明它证明不了那件事**
（桩对空相对路径宽松，因此这一例在修复前后都通过），真正抓住它的是本文件的
Windows 证据。这样桩的这处宽松就有据可查，而不是一处没人知道的差异。

---

## 3. 交付物

| 路径 | 说明 |
| --- | --- |
| `packages/changes/src/digest.ts` | 规范化摘要（长度前缀编码，逐字段无歧义）与请求指纹；`shortCodeOf` |
| `packages/changes/src/prepare.ts` | 重读 → 校验 → 字节引擎 → 快照库 → 落库 → 预览；含本节第 2 条的修复 |
| `packages/changes/src/index.ts` | 导出面 |
| `packages/changes/package.json` | 包描述与依赖 |
| `tests/unit/changes-prepare.test.ts` | 56 例 / 7 组 |
| `scripts/evidence/lwb-020.ts` | 本文件的采集脚本 |
| `docs/evidence/lwb-020/summary.md` | 本文件 |

（`digest.ts`、`prepare.ts`、`index.ts`、`package.json`、`changes-prepare.test.ts`
与 `lwb-020.ts` 均在本任务的实现提交里；提交哈希见 `docs/PROGRESS.md`。）

## 4. 偏离项

- **偏离 56（沿用 LWB-019）**：单文件工作区（`kind: 'file'`）提不出任何修改 ——
  那种工作区里唯一的位置是空串，而空路径在 `requirePath` 里被明确拒绝。
  方向保守，且以一条明确的 `EMPTY` 出现。
- **本轮新增**：`requireCreatable` 对「父目录是工作区根」不再探针，
  改取作用域的 `kind`（见第 2 节）。**根目录的硬链接计数因此不再被检查**；
  判断依据是 NTFS 的目录不支持硬链接。这条判断**没有**被本轮的证据直接验证
  （夹具里没有硬链接目录，且现实中造不出来），因此它是本文件里唯一一处
  靠先验知识而非实测支撑的取舍，写明在此。

## 5. 脱敏

- 本文件与采集脚本不打印任何文件正文。`e18` 等用例里出现的文本都是脚本自己写的
  中文标记；引用的夹具内容仅为行号与行内容长度（`+1/−1`）。
- 硬拒绝语料（`secrets/.env`、`secrets/aws.env`、`secrets/id_rsa`、`config/.env.example`）
  只出现**路径**，从不出现内容 —— 它们是公开示例格式的假值，但脚本里也没有读它们的代码。
- 采集脚本不打印任何凭证、密钥或票据正文；票据只以「铸出来的一张」形式存在，
  输出里从不回显。

## 6. 未执行项（不得记为通过）

```
NOT_RUN 在真实工作区（非夹具副本）上执行任何一次写入 — G2 未通过（LWB-002 BLOCKED）；P3 门禁：可在契约冻结前提下继续实现，但不得在真实仓库上联调（docs/evidence/g2-read.md）
NOT_RUN 经由 daemon → 执行器 → 护栏的真实落盘 — LWB-021/022 未实现：本任务的交付物不包含任何写入代码路径
NOT_RUN 审批后才应用、一次性、带过期 — LWB-021 未实现；本任务只证明「建立修改集不产生批准」
NOT_RUN 五条 change_* 工具端到端可用 — 未实现：它们当前按 LWB-018 步骤 4 返回 NOT_IMPLEMENTED，本任务没有改动工具面
NOT_RUN 名称不同但指向同一物理文件的两个条目被 prepare 的身份层拒绝 — 除非真建硬链接，否则造不出「两个不同路径、同一 file_id」；该判据的单元级证据在 tests/unit/changes-prepare.test.ts，真实硬链接证据在 docs/evidence/lwb-019
NOT_RUN 硬链接文件（link_count > 1）在 prepare 阶段被拒 — 夹具语料里没有硬链接，且副本无法自然产生；该拒绝的单元级证据在 tests/unit/changes-prepare.test.ts
NOT_RUN 超过 MAX_EDITABLE_FILE_BYTES 的文件在 prepare 阶段被拒的 Windows 级证据 — 夹具里 large/big.txt 已在清单层标为不可编辑，走不到 prepare；该拒绝的单元级证据在 tests/unit/changes-prepare.test.ts
NOT_RUN 崩溃原子替换 / 跨文件事务 — I11 与护栏自检均报告 crash_atomic_replace=false、cross_file_transaction=false；本任务不负责落盘
NOT_RUN 在真实 ChatGPT 网页端提出一次编辑 — LWB-002 BLOCKED（真实账号与 Secure MCP Tunnel 凭证）；MCP Inspector 的成功不能替代它
```

另有两处**单元测试做不到**、本轮也没有在 Windows 上做到的性质，它们不是缺陷
而是夹具语料的边界，一并写在这里以免被读成「已覆盖」：

- **身份层去重**（两个不同路径指向同一个 `file_id` → `DUPLICATE_TARGET_FILE`）：
  除非真建硬链接，否则造不出来。路径层的同文件重复（`DUPLICATE_TARGET_PATH`）
  已被 `e14` 在 Windows 上覆盖。
- **`LINK_UNSUPPORTED` / `PARENT_HARDLINKED`**：同上。

## 7. 负向回归

本轮新增/加固的负向用例（全部在 `tests/unit/changes-prepare.test.ts` 与
`scripts/evidence/lwb-020.ts` 里，且每条都断言「不留下修改集」）：

| 场景 | 期望 |
| --- | --- |
| 票据过期 / 跨连接 / 跨代次 / 跨工作区 / 跨路径 / 基线不符 / 声称不可编辑 | `READ_TOKEN_STALE` + 各自的 `reason`，修改集数不变 |
| 读取之后被追加 / 同尺寸改写 / 删掉重建 | `TICKET_SIZE_MISMATCH` / `TICKET_CONTENT_MISMATCH` / `TICKET_IDENTITY_MISMATCH` |
| `create_text` 撞上文件 / 目录 / 父目录不存在 | `FILE_VERSION_CONFLICT`（前两者）/ `NOT_FOUND` |
| 同一文件在提案里出现两次 | `INVALID_ARGUMENT/DUPLICATE_TARGET_PATH` |
| 路径含 `..` | `INVALID_ARGUMENT/CHANGE_PATH_INVALID` + `path_reason=PARENT_REF` |
| 超出修改集总字节上限 | `SIZE_LIMIT_EXCEEDED/CHANGE_TOTAL_TOO_LARGE` |
| 越界编辑 | `READ_TOKEN_STALE/EDIT_RANGE_NOT_READ`，且幂等键不被占用 |
| 输入里带 `approved: true` / `user_id` / `conversation_label` | 无任何批准产生 |
| 直接用 SQL 改 `change_items` / `changesets` | 触发器拒绝，摘要不变 |

## 8. 回退

- **能力开关。** 本任务没有改动任何开关：`read_enabled` / `git_enabled` /
  `proposal_enabled` / `direct_write_enabled` 的默认值仍为**全部关闭**
  （ADR-003 §5.1）。因此「回退」在本任务上的含义是**不打开开关**，
  而不是去删代码。
- **没有写入代码路径可回退。** 本任务的交付物里不存在任何写文件的代码：
  三条验收的第一条就是这件事（运行期计数 0 / 静态扫描 0 / 整树快照不变）。
  因此不存在「回滚一个已经落盘的改动」的问题 —— 也就不会走到
  `git reset --hard` / `git clean` / `git checkout` / `git stash` 那条路上。
- **保留执行日志与未决恢复数据。** 本任务不产生执行记录（`operations` 全程 0 行）
  与恢复数据，因此没有需要保留的在途状态。修改集本身是**不可变**的：
  `changesets` 的内容字段与 `change_items` 整行都由触发器保护，
  回退不会也不能改写它们。
- **不得通过覆盖用户文件实现代码回滚。** 这条在本任务上不适用 ——
  没有任何用户文件被本任务的代码修改过（包括那份临时沙箱，它在结束时被删除，
  而真实夹具原树的首尾快照逐项相同）。
