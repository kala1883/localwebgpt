# LWB-019 · 精确文本编辑契约与逐字节文本引擎 — 证据

**采集方式：** `node --import tsx scripts/evidence/lwb-019.ts`（**退出码 0**；**60 PASS / 0 FAIL / 7 NOT_RUN / 33 NOTE**）
**采集环境：** Windows 11 Home China 10.0.26200 / Node v22.20.0 / tsx 4.23.15 / PowerShell 7.6.6 / TypeScript 5.9.3 /
护栏后端 `powershell-pinvoke`（`supports_file_identity=true`、`supports_hardlink_count=true`、
`crash_atomic_replace=false`）/ 夹具仓库 `tests/fixtures/generated/testrepo`（HEAD `5eefeeedc616b82927d6424c4d78e64a39c6b8dc`，
根身份由护栏当场问出：`volume=b0e2c2db file=0002000000672a7d fs=NTFS`）
**测试套件：** `tests/unit/changes-edit.test.ts`（**57 例**，7 组）+
全仓 `tests 1006 / suites 162 / pass 1006 / fail 0`（LWB-018 时为 949 / 155）
**静态检查：** `npx tsc --noEmit` 退出码 0；`node scripts/check-fsguard-imports.mjs` — **125 个文件**，未发现绕过
**原始日志：** 未入库（`*.log` 在 `.gitignore` 中，与 `lwb-006` ~ `lwb-018` 一致）。
下文引用的每条 `PASS` / `NOTE` 行均为运行输出的**逐字**摘录，本文件不依赖那份日志才可读。

**门禁结论：G2 未通过。** 本任务的全部证据采自夹具测试根与一个临时沙箱，
**没有任何一次写入发生在真实工作区上**。这符合 `docs/evidence/g2-read.md` 对 P3 的口径
（「可以在契约冻结的前提下继续实现，但不得在真实仓库上联调」）。

---

## 0. 这一轮的证据是在什么装置上采的

```
NOTE 护栏能力 — available=true backend=powershell-pinvoke supports_file_identity=true supports_hardlink_count=true crash_atomic_replace=false
NOTE 语料 — 测试根 D:\MyProjects\MyApps\LocalWebGPT\tests\fixtures\generated\testrepo
NOTE 语料 — 共 21 个文件；可编辑且换行风格可写 10 个；可编辑但换行风格不可写 1 个（edge/bom-only.txt）
NOTE 语料 — 身份取自护栏 statVolume（真实 NTFS 卷序列号 + 文件索引），不是自己算的
NOTE 语料 — 策略硬拒绝 4 个（secrets/.env、secrets/aws.env、secrets/id_rsa、config/.env.example）；其中 config/.env.example 在夹具清单里写着 editable=true —— 清单字段是夹具意图，不是策略判定，本脚本按策略层裁定取语料
```

三件事决定了这轮证据能证明什么：

1. **票据是铸出来的，不是拼出来的。** 连负向用例（伪造、过期、跨连接）也走真实权威
   `createReadTicketAuthority({key})`，只改身份字段或签发时刻 —— 「伪造票据」是拿一张
   真票据**改一个字符**。手拼一个字符串只能证明「垃圾被拒绝」。
2. **字节是磁盘上的。** 全部编辑的输入来自 `tests/fixtures/generated/testrepo/` 里的真文件，
   身份（`volume_id` / `file_id`）来自护栏的 `statVolume`。不重新编码这件事只有拿真字节
   才验得出来。
3. **判据来自策略层而不是夹具清单。** 上面那条 `NOTE` 是一个**实测到的坑**：
   `config/.env.example` 在夹具清单里写着 `editable: true`，但 `HD-ENV`
   （`.env` / `.env.*` / `*.env`，方案 §4.3 明令不做 `.env.example` 豁免）连读都硬拒绝它。
   拿清单字段当策略结论，就会把一个根本读不到的文件算进「可编辑语料」，那一条证据是假的。
   本脚本改用 `classifyFile()` 裁定语料，于是可编辑语料从 11 个变成 **10 个**。

---

## 1. 验收标准逐条

### 验收标准 1 · 重复文本不会导致选错位置；旧内容不一致直接冲突

#### 1.1 装置前提：目标文件里**真的有两行完全相同的空行**

```
NOTE a 装置前提 — 文档/设计说明.md 第 2 行=""，第 5 行=""（两行文本完全相同）
PASS a 装置前提：目标文件里确实有两行完全相同的空行 — 第2行="" 第5行=""
```

这条不放宽。如果夹具里没有重复文本，「重复文本不会导致选错位置」就无从谈起 ——
所以脚本先把前提**打印出来**，而不是假定。

#### 1.2 改第 5 行：只有第 5 行变，第 2 行一字节不动

```
NOTE a1 区间 — 第 2 行字节 [15,16)，第 5 行字节 [60,61)（含行终止符）
PASS a1 改第 5 行：第 2 行所在的字节区间与原文逐字节相同 — 第 2 行区间 15..16（空行 + 换行，1 字节）
PASS a1 改第 5 行：除第 5 行外，整份文件逐字节相同 — 左前缀 60 字节相同；右后缀 239 字节相同；长度 300→318（差 18）
PASS a1 改第 5 行：第 5 行确实变成了新内容，第 2 行仍是空行 — 第2行="" 第5行="改过的第 5 行"
PASS a1 插入点定位：新内容落在第 5 行而不是第 2 行（行数不变，第 5 行起点偏移不变） — 行数 11→11；第 5 行起点 60→60
```

三条断言各挡一种实现：

- 「第 2 行区间逐字节相同」挡**按内容查找**：那种实现会在第 2 行命中（因为两行文本一样）并改错地方。
  区间**含行终止符**是刻意的 —— 只算内容的话，空行的区间是零长度，
  「这个区间没被动过」就成了一句空话，而空行正是本用例的主角。
- 「除第 5 行外整份文件相同」比「第 2 行没变」更强：它同时排除了「顺手做了格式归一」。
- 「第 5 行起点偏移不变」挡**把行删掉再插回去**：那种实现行数与内容都对，但整份文件的字节
  布局已经重排过。

#### 1.3 旧内容不一致：直接冲突

```
PASS a2 旧内容与第 2 行不符：FILE_VERSION_CONFLICT，且不改任何字节 — FILE_VERSION_CONFLICT/EDIT_BASELINE_MISMATCH
PASS a3 冲突诊断里不含文件内容（只给行号） — 无内容回显
NOTE a3 冲突诊断原文 — 第 1 行的内容与提案声明的不一致；本次修改未应用，请重新读取该文件。 {"reason":"EDIT_BASELINE_MISMATCH","path":"文档/设计说明.md","line":1}
PASS a4 读到之后磁盘变了：FILE_VERSION_CONFLICT（不是「按现在的字节硬改」） — FILE_VERSION_CONFLICT/BASELINE_HASH_MISMATCH
```

a2 与 1.2 是**不同**的失败模式：1.2 防的是「按内容查找」，a2 防的是
「内容对不上就算了」—— 后者会把一次本该拒绝的修改当成没看见。
a3 是独立的第三方检查：脚本拿该文件的真实行内容、以及脚本自己编的一段文本当探针，
去 `message` 与 `details` 里找，两条都不出现，而 `line` 明确给出是第几行。
a4 把「读到之后磁盘被改过」与「提案声明的内容对不上」分开：前者报 `BASELINE_HASH_MISMATCH`，
后者报 `EDIT_BASELINE_MISMATCH`，处置都是重读。

### 验收标准 2 · 未触及的字节与原文件完全一致

#### 2.1 整个可编辑语料的恒等编辑

```
PASS b1 全部可编辑夹具上「把一行替换成它自己」产物与原文件逐字节相同 — 检查了 10 个文件（期望 10，下界 10），不一致 0 个
NOTE b1 文档/设计说明.md — lf 300B → 300B sha 不变
NOTE b1 资料/2026年方案/📄笔记.txt — lf 58B → 58B sha 不变
NOTE b1 bom/with-bom.txt — lf+BOM 34B → 34B sha 不变
NOTE b1 newline/lf.txt — lf 30B → 30B sha 不变
NOTE b1 newline/crlf.txt — crlf 39B → 39B sha 不变
NOTE b1 newline/no-trailing-newline.txt — lf 27B → 27B sha 不变
NOTE b1 README.md — lf 58B → 58B sha 不变
NOTE b1 src/main.ts — lf 109B → 109B sha 不变
NOTE b1 src/staged.ts — lf 28B → 28B sha 不变
NOTE b1 src/untracked.ts — lf 31B → 31B sha 不变
```

**把第 1 行替换成它自己**：一次编辑都没有改变内容，所以产物里**任何一个字节**都不该变。
这是「没有偷偷重新编码 / 重新格式化 / 自动转码」这句话最强的形式 ——
它不依赖任何关于「哪些字节算未触及」的判断，而是整份字节的相等。

语料按 `classifyFile()` 筛，不按夹具清单的 `editable` 字段（原因见 §0 第 3 条）。
下界写死成 10 而不是用 `corpus.editable.length`：语料是自己筛出来的，
拿它自己当上界的话「筛空了」也会通过。

#### 2.2 CRLF：区间外的字节逐字节相同

```
NOTE b2 改的是第 2 行 — 原第 2 行字节区间 [13, 26)；左前缀 13 字节相同；右后缀 13 字节相同；长度 39→48（差 9）
PASS b2 CRLF 文件：区间外的字节逐字节相同 — 左前缀 13 字节相同；右后缀 13 字节相同；长度 39→48（差 9）
PASS b2 CRLF 文件：写回仍是 CRLF，行数不变 — newline=crlf lines=3→3
```

期望的字节区间由**脚本自己**用 `indexOf` 逐行扫描算出来，不从字节里探测换行风格
（风格由夹具清单传入），也不复用引擎的「累计 `Buffer.byteLength`」算法 ——
后者正是被测对象，用它算期望值等于用同一个错误同时污染两边。

#### 2.3 BOM

```
NOTE b3 BOM 文件 — 头部三字节 [239,187,191]，编码 utf-8-bom→utf-8-bom
PASS b3 BOM 保留（EF BB BF 三个字节原样在头部） — [239,187,191]
PASS b3 BOM 之外的字节：第 1 行（含其换行）逐字节相同
```

#### 2.4 无末尾换行：替换末行之后仍然没有末尾换行

```
NOTE b4 无末尾换行 — 产物末两字节 [191,135]（0x0a 表示多出了一个换行）
PASS b4 替换最后一行后，文件末尾仍然没有换行 — 末两字节 [191,135]
```

末尾多一个换行是这类实现最常见的「顺手行为」，而它会让 diff 里多出一行空行 ——
即用户没提出过的一次修改。

#### 2.5 在「末尾无换行」的文件末尾插入一行

```
NOTE b5 末尾插入 — 第 3 行插入后 27B → 43B
PASS b5 末尾插入：字节等于「原文件 + 一个换行 + 新行」，且末尾仍无换行 — 期望 43B，实际 43B
PASS b5 末尾插入：行数恰好 +1 — 2→3
```

这是全文最容易漏的一条：`a` 之后插入 `b`，写成 `a`+`b` 会得到 `ab` ——
**一行，内容错了**，而且不报任何错。正确的字节是 `a\nb`。

### 验收标准 3 · 无法偷偷在同一文件添加第二次隐含操作

#### 3.1 路径层

```
PASS c1 同一路径出现两次：拒绝 — INVALID_ARGUMENT/DUPLICATE_TARGET_PATH
PASS c2 同一路径换大小写拼写（newline/lf.txt / NEWLINE/LF.TXT）：拒绝（NTFS 大小写不敏感） — INVALID_ARGUMENT/DUPLICATE_TARGET_PATH
PASS c4 同一文件既 edit_text 又 replace_text：拒绝（换一种 op 不算换一个目标） — INVALID_ARGUMENT/DUPLICATE_TARGET_PATH
```

#### 3.2 物理层：真硬链接

```
NOTE c3 真硬链接 — target.txt 与 alias.txt：volume:file = c6e22015:00220000001e1456 / c6e22015:00220000001e1456，link_count=2
PASS c3 装置前提：两个名字确实是同一个物理文件（身份相同且 link_count≥2） — link_count=2
NOTE c3 逐项合法 — 两条各自校验：1 / 1 条通过
PASS c3 同一物理文件的两个名字：靠 volume:file_id 拒绝（路径层看不出来） — INVALID_ARGUMENT/DUPLICATE_TARGET_FILE
```

硬链接在**临时沙箱**里用 `New-Item -ItemType HardLink` 真造出来（不在夹具根里造 ——
那会改动夹具目录，让其它测试的清单对不上），身份由**护栏**当场问出。
`NOTE c3 逐项合法` 是必要的装置前提：两条修改项单独看都必须合法，
否则测到的是「某一条本身不合法」，而不是判重。

#### 3.3 一张票用两次

```
PASS c5 拿 A 文件的票去改 B 文件：拒绝 — READ_TOKEN_STALE/TICKET_PATH_MISMATCH
PASS c5 拿 B 文件的票配 A 文件的基线哈希：拒绝 — READ_TOKEN_STALE/TICKET_BASE_MISMATCH
```

「同一张票悄悄改第二个文件」是同一种偷袭的另一条路。票据里带着物理身份与基线哈希，
用到别处就该对不上。

#### 3.4 已知盲点：`create_text` 没有物理身份

见 §3 偏离项 57（`docs/PROGRESS.md`）—— 新建文件在提议阶段还不存在，`volume_id` / `file_id` 只能是 `null`，
因此两个 `create_text` 指向同一路径只会在**路径层**被抓到。
如果那条路径上已经存在一个**别的名字**（硬链接），路径层看不出来。
这一条的处置写在偏离项里，本任务不自行加规则。

### 步骤 4 · 四类明确拒绝

#### 4.1 未知编码

```
NOTE d1 无法解码的字节 — 识别结果 kind=binary reason=NUL_BYTE
PASS d1 无法解码的字节不产生可编辑的读取结果（识别阶段即判定） — kind=binary
PASS d1 无法解码的字节造不出读取票据（装置层与出站层同一条判据）
PASS d1 内容含单独代理项：拒绝（否则写出去的字节与提案声明的文本不同） — INVALID_ARGUMENT/CONTENT_NOT_ENCODABLE
```

前三条要说清一件事：**「未知编码」在这条链上是上游挡的**。票据来自一次成功的
`file_read`，而那次读取不会对无法解码的字节签发票据 —— 所以到不了编辑契约这一层。
这不是推脱：脚本把这条链**跑了一遍**（识别 → 铸票），而不是在文档里声称它成立。

剩下能到达契约层的一类是**内容**里的单独代理项：`\uD800` 单独出现时
`Buffer.from(s,'utf8')` 会静默换成 U+FFFD，于是「写出去的字节」与「提案声明的文本」
不是同一件东西。这一条由 `isEncodable` 挡下。

#### 4.2 混合换行的写入

```
NOTE d2 混合换行夹具 — newline/mixed.txt 在夹具清单里 editable=false newline=mixed
PASS d2 装置前提：混合换行文件在夹具清单里本就标记为不可编辑 — editable=false
PASS d2 不可编辑的票据：转述出站层的理由，拒绝 — READ_TOKEN_STALE/TICKET_NOT_EDITABLE
PASS d2 票据谎称可编辑：引擎层独立判一次，仍然拒绝写混合换行 — INVALID_ARGUMENT/NEWLINE_STYLE_NOT_WRITABLE
PASS d2 新内容里带 CR：拒绝（否则就是自己造出一个混合换行文件） — INVALID_ARGUMENT/CONTENT_HAS_CR
```

第二、三条是**两层独立**的判定：出站层在签发票据时已经裁定 `editable=false`；
引擎层不管票据怎么声称，自己在写入前又判一次换行风格。两条都跑，
是为了让「票据被伪造/被误传」不会变成「写进一个混合换行文件」。
最后一条挡住的是**自己造出**一个混合换行文件 —— 与「把它统一成 LF」一样，
那是自动格式化，本任务明令禁止。

#### 4.3 空路径

```
NOTE d3 空路径 — INVALID_ARGUMENT/CHANGE_PATH_INVALID path_reason=EMPTY
PASS d3 空路径：拒绝，且原因是路径语法本身 — INVALID_ARGUMENT/CHANGE_PATH_INVALID
NOTE d3 副作用 — 空路径被拒 ⇒ 单文件工作区（根即文件，相对路径为空）无法提议修改；记入偏离项，不在本任务里另开一套规则
```

#### 4.4 冲突区间

```
PASS d4 两个区间重叠：拒绝 — INVALID_ARGUMENT/OVERLAPPING_EDITS
PASS d4 同一插入点写两条插入：拒绝（先后顺序读不出来） — INVALID_ARGUMENT/OVERLAPPING_EDITS
PASS 对照：首尾相接的两个区间（[1,2) 与 [2,3)）允许，结果是两行各自换掉 — "甲\n乙\nlf-line-3\n"
PASS d4 对照：不相交的两行可以同时改，且按行号升序生效 — "甲" "lf-line-2" "丙"
```

**「首尾相接」这一条是本轮证据纠正了我自己的一个错误预期。** 证据脚本的第一版
把 `[1,2)` 与 `[2,3)` 写成「应当拒绝」，理由是「相接处谁负责第 1 行的换行有二义」——
实跑下来它被**允许**，而且结果正确（两行各自带上自己的终止符，字节区间不交）。
想清楚也确实如此：二义只发生在**零长度区间**（插入点）上，而那两种情况
（同一插入点写两条、插入点带 `old_lines`）已经各自被单独拒绝。
这条对照因此留在证据里 —— 它记录的是「实跑出来的规则」，而不是「凭印象的规则」。

两条对照（相接允许、不相交允许）是必要的：没有它们，「一律拒绝多区间」
也能通过上面两条。

#### 4.5 重复物理文件

见 §3.2（真硬链接 + 护栏给出的 `file_id`）。

### 票据是唯一的版本来源

```
NOTE 票据权威 — key_fingerprint=9685da17a6d06596（只有指纹，没有密钥）
PASS 票据格式：lwbrt_ 前缀 + 载荷 + HMAC — lwbrt_…
PASS 伪造票据（改一个字符）：签名不匹配 — READ_TOKEN_STALE/TICKET_BAD_SIGNATURE
PASS 乱写的票据：结构不完整 — READ_TOKEN_STALE/TICKET_MALFORMED
PASS 没有票据：拒绝（不会退回「按路径重新读一次」） — INVALID_ARGUMENT/READ_TOKEN_MISSING
PASS 别的部署的密钥签的票据：拒绝 — READ_TOKEN_STALE/TICKET_BAD_SIGNATURE
PASS 过期票据（TTL=3600000ms）：拒绝 — READ_TOKEN_STALE/TICKET_EXPIRED
PASS 别的连接读来的票据：拒绝（身份来自已认证通道，不来自参数） — READ_TOKEN_STALE/TICKET_CROSS_CONNECTION
PASS 别的工作区读来的票据：拒绝 — READ_TOKEN_STALE/TICKET_CROSS_WORKSPACE
PASS 工作区代次变了：拒绝 — READ_TOKEN_STALE/TICKET_GENERATION_MISMATCH
PASS 票据指向别的路径：拒绝 — READ_TOKEN_STALE/TICKET_PATH_MISMATCH
PASS 对照：只是大小写拼写不同，票据仍然有效（路径不是身份判据） — 放行
PASS 改第 1 行，但票据只返回过第 2 行：拒绝（落在「模型以为读过」的地方） — READ_TOKEN_STALE/EDIT_RANGE_NOT_READ
PASS 对照：票据返回过的第 2 行可以改 — 放行
```

三条对照（大小写放行、返回过的行放行）与十条拒绝成对存在。
一个「什么票据都不认」的实现在拒绝侧全绿，却把编辑功能变成一句空话 ——
而它还**看起来更安全**。

「别的部署的密钥签的票据」是拿另一把密钥真签出来的，不是改字符 ——
验的是 HMAC 校验本身，而不是格式校验。

`EDIT_RANGE_NOT_READ` 这一条是**行区间**这一层的核心：票据里记着本次读取实际返回过
哪几行，提案只能落在那个范围内。落在范围外说明模型在改「它以为它读过」的地方。

### 边界与上限

```
NOTE LIMITS — MAX_EDITABLE_FILE_BYTES=2097152 MAX_EDITS_PER_FILE=500 MAX_CHANGE_FILES=20 MAX_CHANGE_TOTAL_BYTES=8388608 READ_TOKEN_TTL_MS=3600000
PASS 编辑条数 501 > MAX_EDITS_PER_FILE：拒绝 — INVALID_ARGUMENT/TOO_MANY_EDITS
PASS 工具 schema 的 edits 上限与 LIMITS.MAX_EDITS_PER_FILE 是同一个数 — schema 也拒绝
PASS 对照：合法的单条编辑能通过 schema — 通过
PASS 对照：恰好 500 条能通过 schema（边界不是「一律拒绝多条」） — 通过
PASS 工具 schema 的 items 上限与 LIMITS.MAX_CHANGE_FILES 是同一个数 — schema 也拒绝
PASS 修改项 21 > MAX_CHANGE_FILES：拒绝 — INVALID_ARGUMENT/TOO_MANY_CHANGE_FILES
PASS 产物超过调用方给的上限 15B：拒绝（上限可调，边界跟着动） — SIZE_LIMIT_EXCEEDED/RESULT_TOO_LARGE
PASS 上限调到比文件还小：旧票不再放行 — SIZE_LIMIT_EXCEEDED/FILE_TOO_LARGE_FOR_EDIT
PASS 超限文件在夹具清单里标记为不可编辑 — 2544000B > 2097152B
```

schema 那几条用的是**已注册**的 `TOOL_INPUT_SCHEMAS.change_prepare` ——
也就是 MCP 工具面真正发布出去的那一份，而不是另构造一份等价的来测。
`恰好 500 条通过` 这条对照不能省：没有它，上面那条证明的是「schema 拒绝一切多条编辑」，
而不是「上限就是那个数」。契约层与工具 schema 用同一个 `LIMITS.MAX_EDITS_PER_FILE`，
两处各写一个数字迟早会分叉。

`上限调到比文件还小：旧票不再放行` 是本任务新加的一道闸门（见 §3 偏离项 68，`docs/PROGRESS.md`）：
票据里记的 `editable` 是**签发那一刻**的裁定，而上限是可调的 ——
上限调小之后，一张昨天签发的票据不该继续按昨天的限额生效。

### 三个入口的正常路径

```
PASS create_text：按声明写出 LF，BOM 是三字节 EF BB BF 而不是正文里的 U+FEFF — 头部 [239,187,191] bom=true newline=lf
PASS create_text：newline=crlf 时每一行都带 CRLF — 10B
PASS replace_text：整文件替换按字面落地，且换行风格跟随原文件 — 300B → 26B newline=lf
```

`inspectBytes` 把 BOM 单独报成 `bom: true`，`text` 里**不含** U+FEFF ——
因此字节层面的核对分成两半：头三个字节是什么，以及 BOM 之后的正文。
这是我在写这一节时被实跑纠正的第二个错误预期（原本断言 `text` 里带 `\ufeff`）。

---

## 2. 交付物与改动文件

| 文件 | 是什么 |
| --- | --- |
| `packages/changes/package.json` | 新包 `@lwb/changes`（在业务前缀清单内 ⇒ 静态检查保证它不 import `fs`） |
| `packages/changes/src/edit-contract.ts` | **提案 vs 票据**：路径、票据、基线声明、行区间形状、同一文件不得出现两次 |
| `packages/changes/src/text-engine.ts` | **提案 vs 基线字节**：逐行精确匹配、按原字节切片、重新识别产物并核对不变量 |
| `packages/changes/src/index.ts` | 两个文件的出口，并写明为什么分成两个文件 |
| `packages/contracts/src/limits.ts` | 新增 `MAX_EDITABLE_FILE_BYTES` 之外**新增** `MAX_EDITS_PER_FILE = 500`，并加入 `OPERATOR_TUNABLE_LIMITS` |
| `packages/contracts/src/tools.ts` | `edits` 的上限改用 `LIMITS.MAX_EDITS_PER_FILE`（与契约层同一个数） |
| `tests/unit/changes-edit.test.ts` | 57 例 / 7 组 |
| `scripts/evidence/lwb-019.ts` | 本证据的采集脚本 |

### 分层：为什么是两个文件

`edit-contract.ts` 里全部是「提案 vs **票据**」的关系，
`text-engine.ts` 里全部是「提案 vs **基线字节**」的关系。混在一起会让
「票据校验」这类安全判定和「第几行对不上」这类业务判定共享一条错误路径 ——
而两者的处置完全不同（前者是**重读**，后者是**冲突**）。

### 字节保真是**构造出来**的，不是**推断出来**的

引擎不 decode → 改 → encode，而是把「未触及的区域」直接从原 buffer 切片拼起来
（`body.subarray`）。理由是往返恒等（decode→encode 得到原字节）是一条**未经验证的前提**，
而不成立时它会**静默**失败 —— 用户文件里多出几个 U+FFFD，没有任何报错。

那条前提因此被降级成一个**每次执行都跑的断言**（`assertByteLayout` 用累计偏移
核对真实字节布局），外加对**产物**重新跑一次 `inspectBytes` 并核对行数 / BOM /
换行风格 / 正文。§1.2.1 那条恒等编辑（10 个文件、一个字节都不许变）是这条构造的端到端表达。

---

## 3. 偏离项

| # | 是什么 | 为什么这么处置 |
| --- | --- | --- |
| 56（改写） | **空路径被明确拒绝**（任务书步骤 4 原文要求），因此**单文件工作区无法提议修改** | 单文件工作区的相对路径就是空串，而步骤 4 明写「空路径…明确拒绝」。两条要求直接冲突，本任务按任务书原文实现，并把这个后果写进代码注释与证据（`NOTE d3 副作用`），不自行给单文件工作区开一套例外规则 |
| 57 | `create_text` 在提议阶段**没有物理身份**（文件还不存在），因此两个 `create_text` 指向同一路径只在**路径层**被判重；若那条路径上已存在一个硬链接形式的别名，路径层看不出来 | 物理身份来自票据，而新建文件没有票据。补法要等 LWB-020/022（修改集准备与状态机）拿到「执行时刻的目录快照」之后才谈得上，本任务不自行加规则 |
| 68（新增） | `MAX_EDITABLE_FILE_BYTES` 在**契约层**又查了一遍（用票据上的 `size`），错误码 `SIZE_LIMIT_EXCEEDED` / `reason=FILE_TOO_LARGE_FOR_EDIT` | 这个字段原本只是 `ChangeValidationContext` 上一个**没人用**的声明 —— 一个声明了却不生效的选项比没有它更坏。接上之后它有用：上限是**可调**的，而票据记的是签发那一刻的裁定，调小上限之后旧票不该继续放行 |
| 69（新增） | `replace_text` 的换行处理是**字面**的：内容里的 `\n` 按原文件的换行风格改写成 CRLF 落盘，但不额外补末尾换行、不做任何「智能」处理 | 与 `edit_text` 的区域规则统一到同一条判据上（区域 = 内容 + 该行的终止符）。「按字面」这条要在 LWB-020 的差异预览里如实显示，不能让用户以为末尾换了行 |
| 70（新增） | `truncated:false` 但行范围**不是**全文件 的票据，是一张**自相矛盾**的票据；`replace_text` 仍然拒绝它 | 这是纵深防御：正常路径上出站层不会签出这种票。留这条是因为「两张互相矛盾的声明里挑一个信」正是将来出错的方式 |
| 61~67 | 保持不变（见 `docs/PROGRESS.md`） | 本任务不涉及 |

---

## 4. 脱敏

- **证据里没有任何密钥。** 票据权威的固定密钥只出现在证据脚本与单元测试里
  （`lwb-evidence-019-key-…`、`lwb-test-key-…`），**不进生产路径**；生产密钥由
  daemon 从 `@lwb/secure-store` 的 `runtime` 类凭证取出。打印出来的是
  `key_fingerprint=9685da17a6d06596`（16 位十六进制），它由密钥算出来但不足以反推。
- **证据里没有任何用户文件正文。** 唯一一处打印产物的位置是
  `对照：首尾相接的两个区间…`，它打的是**单元测试自己造的**三行文本
  （`newline/lf.txt` 的夹具内容，本来就在仓库里）。`a3 冲突诊断原文` 打印的是
  引擎的 `message`，其中只有行号。
- **票据只打印格式**（`lwbrt_…`），不打印内容 —— 票据是 bearer 凭证，拿到它就能改那个文件。
  脚本里唯一的票据级断言是 `startsWith('lwbrt_')` 与前缀长度，比对用的是**载荷里的事实**
  （`path` / `generation` / `connection_id`），从不回显票据本身。

---

## 5. 未执行项（不得记为通过）

| 未执行 | 为什么 |
| --- | --- |
| 在**真实工作区**（非夹具）上执行任何一次写入 | G2 未通过（LWB-002 BLOCKED）；P3 的门禁是「可在契约冻结前提下继续实现，但不得在真实仓库上联调」 |
| 经由 daemon → 执行器 → 护栏的真实落盘 | LWB-020/021/022 未实现：本任务的交付物是**纯函数**（由 `check-fsguard-imports.mjs` 强制不 import `fs`），真实落盘属于后续任务 |
| 五条 `change_*` 工具端到端可用 | 未实现：它们当前按 LWB-018 步骤 4 返回 `NOT_IMPLEMENTED`，本任务没有改动工具面 |
| 审批后才应用、一次性、带过期 | LWB-021 未实现：本任务不做任何批准判定，`approved:true` 在本任务的代码里**没有入口** |
| `MAX_CHANGE_TOTAL_BYTES` 的强制执行 | 未实现：整份修改集的总字节上限属于 LWB-020；本任务只逐文件设限 |
| 崩溃原子替换 / 跨文件事务 | 护栏自检报告 `crash_atomic_replace=false`、`cross_file_transaction=false`（I11）：本任务的字节引擎只产生新字节，不负责落盘 |
| 在真实 ChatGPT 网页端提出一次编辑 | LWB-002 BLOCKED（真实账号与 Secure MCP Tunnel 凭证）；MCP Inspector 的成功不能替代它 |

---

## 6. 负向回归

以下每一条都在 `tests/unit/changes-edit.test.ts` 与
`scripts/evidence/lwb-019.ts` 里各有一份，改动本任务的代码后必须仍然全部拒绝：

| 负向用例 | 期望 |
| --- | --- |
| 同一路径两次 / 换大小写 / 换 op | `INVALID_ARGUMENT` / `DUPLICATE_TARGET_PATH` |
| 同一物理文件的两个名字（真硬链接） | `INVALID_ARGUMENT` / `DUPLICATE_TARGET_FILE` |
| 两个区间重叠、同一插入点两条插入 | `INVALID_ARGUMENT` / `OVERLAPPING_EDITS` |
| `old_lines` 与磁盘不符 | `FILE_VERSION_CONFLICT` / `EDIT_BASELINE_MISMATCH` |
| 磁盘字节与票据版本不符 | `FILE_VERSION_CONFLICT` / `BASELINE_HASH_MISMATCH` |
| 伪造 / 过期 / 跨连接 / 跨工作区 / 跨代次 / 跨路径 / 跨基线的票据 | `READ_TOKEN_STALE`（各自的 reason） |
| 行区间落在票据没返回过的行上 | `READ_TOKEN_STALE` / `EDIT_RANGE_NOT_READ` |
| 混合换行写入（票据谎称可编辑时） | `INVALID_ARGUMENT` / `NEWLINE_STYLE_NOT_WRITABLE` |
| 没有换行风格的文件上写多行 | `INVALID_ARGUMENT` / `NEWLINE_STYLE_NOT_WRITABLE` |
| 空路径 / 绝对路径 / 上级引用 | `INVALID_ARGUMENT` / `CHANGE_PATH_INVALID` |
| 行元素带 `\r` / `\n` / NUL / 单独代理项 | `INVALID_ARGUMENT` / `EDIT_LINE_HAS_NEWLINE` / `EDIT_LINE_HAS_NUL` / `EDIT_LINE_NOT_ENCODABLE` |
| 插入却带 `old_lines` | `INVALID_ARGUMENT` / `EDIT_INSERT_WITH_OLD_LINES` |
| `truncated` 为真的票据做整文件替换 | `READ_TOKEN_STALE` / `REPLACE_RESULT_TRUNCATED` |
| 行范围不全的票据做整文件替换 | `READ_TOKEN_STALE` / `REPLACE_REQUIRES_FULL_READ` |
| `create_text` 内容带 CR / NUL / 单独代理项 / `bom:false` 却以 U+FEFF 开头 | `INVALID_ARGUMENT`（各自的 reason） |
| `edits` 为空 / 超过 500 条；修改项为空 / 超过 20 项 | `INVALID_ARGUMENT` / `EDITS_EMPTY` / `TOO_MANY_EDITS` / `CHANGE_ITEMS_EMPTY` / `TOO_MANY_CHANGE_FILES` |

---

## 7. 回退

按任务书要求：**关闭相关能力开关**（`proposal_enabled` 保持 `false`；
`direct_write_enabled` 恒为 `false`，本任务没有改动这两个开关的默认值），
保留执行日志与未决恢复数据，**不得通过覆盖用户文件实现代码回滚**。

本任务的交付物是纯函数且**没有任何调用方**（五条 `change_*` 工具仍是
`NOT_IMPLEMENTED`），因此回退这件事的当前形态是：撤掉本次提交即可，
磁盘上不会留下任何本任务写出的字节 —— 本任务从未写过磁盘。
