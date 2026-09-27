# LWB-013 · 一致的文件读取与读取票据 — 证据

**采集方式：** `node --import tsx scripts/evidence/lwb-013.ts`（退出码 0；**44 PASS / 0 FAIL / 4 NOT_RUN**）
**采集环境：** Windows 11 Home China 10.0.26200 / Node v22.20.0 / tsx 4.23.15 / PowerShell 7.6.6
**测试套件：** `tests/unit/files-read.test.ts`（**45 项全部通过**，磁盘用桩）+
`tests/windows/files-read.test.ts`（**14 项全部通过**，真实 NTFS + 真实护栏）；全仓 `tests 626 / pass 626 / fail 0`
**静态检查：** `npx tsc --noEmit` 退出码 0；`node scripts/check-fsguard-imports.mjs` — **83 个文件**，未发现绕过（LWB-012 时为 79）
**原始日志：** 未入库（`*.log` 在 `.gitignore` 中，与 `lwb-006` ~ `lwb-012` 一致）。
下文引用的每条 `PASS` / `NOT_RUN` 行均为运行输出的**逐字**摘录，本文件不依赖那份日志才可读。

---

## 1. 验收标准逐条

### 验收标准 1 · 中文、emoji、BOM、CRLF、无末尾换行读取正确

```
NOTE 夹具清单 — 21 项，由 tests/fixtures/build-fixtures.ts 生成
NOTE 因单行超限而单独验的夹具 — edge/long-line.txt（单行 9000 字节）
NOTE 整份可读的夹具 — 14 项：文档/设计说明.md | 资料/2026年方案/📄笔记.txt | bom/with-bom.txt | edge/bom-only.txt | newline/lf.txt | newline/crlf.txt | newline/mixed.txt | newline/no-trailing-newline.txt | edge/empty.txt | README.md | src/main.ts | src/staged.ts | src/untracked.ts | node_modules/fake-dep/index.js
PASS 逐个夹具：正文逐字节相同、哈希/行数/换行/BOM 与独立的清单一致 — 14 项全部一致
PASS 形态：中文路径与正文 — 文档/设计说明.md → 11 行 / lf / BOM=false / editable=true
PASS 形态：emoji 路径 — 资料/2026年方案/📄笔记.txt → 2 行 / lf / BOM=false / editable=true
PASS 形态：UTF-8 BOM — bom/with-bom.txt → 2 行 / lf / BOM=true / editable=true
PASS 形态：CRLF — newline/crlf.txt → 3 行 / crlf / BOM=false / editable=true
PASS 形态：无末尾换行 — newline/no-trailing-newline.txt → 2 行 / lf / BOM=false / editable=true
PASS 形态：混合换行 — newline/mixed.txt → 4 行 / mixed / BOM=false / editable=false
PASS 形态：空文件 — edge/empty.txt → 0 行 / none / BOM=false / editable=true
PASS 形态：仅 BOM — edge/bom-only.txt → 0 行 / none / BOM=true / editable=true
PASS emoji 出现在**路径**里时，回执路径仍是磁盘拼写（句柄取回，不是请求字符串的转写） — 回执 path="资料/2026年方案/📄笔记.txt"
PASS 混合换行的文件可读，但**不给**可编辑票据（写回会静默改掉其它行） — editable=false；理由：文件混用多种换行风格（或含单独 CR）；写回会静默改变其它行的字节，因此不提供编辑。
```

**判据是「这次读回来的就是磁盘上的全部字节」，不是「这个文件看起来对」。**
逐项比对的每一项都取自 `manifest.json` —— 一份由 `tests/fixtures/build-fixtures.ts`
**独立实现**（它自己算行数与换行）产出的清单，而不是把实现的输出再断言一遍。
本文件第一次采集时就在这条上翻过车：见 §4.1，那次 FAIL 是**过滤器**写错了
（把 `edge/long-line.txt` 算进了"整份可读"），产品行为本身是正确的 ——
这恰好说明这条断言有区分能力。

**"混合换行不可编辑"不是保守，是唯一自洽的选择。** `newline/mixed.txt` 里有单独 `\r`。
把它读成 `lf`，写回时那些 `CR` 会被静默换成 `LF` —— 一份被判为"可编辑"的文件在保存后
多出一堆字节差异，而模型以为自己做的是行级小改。归入 `mixed` 的后果是这个文件
不可编辑，代价**可见**。

**BOM 被剥离、但哈希仍描述整份磁盘字节。** `bom/with-bom.txt` 的 `bom=true`、
`encoding=utf-8-bom`，而 `sha256` 与清单里那个 34 字节文件的哈希一致。
`bytes_returned` 比磁盘少 3 字节（BOM），`content` 里没有 `U+FEFF`。
解码器用 `ignoreBOM: true`：若再让 `TextDecoder` 剥一次，一份**正文自身**以
`U+FEFF` 开头（而 BOM 已单独处理）的文件会被静默吃掉一个字符，而 `sha256`
仍然对得上 —— 一个不会报错的错。

### 验收标准 2 · 截断结果不会冒充完整文件

```
PASS 超长行：按 MAX_LINE_BYTES 截断并标注行号，且整份结果标为 truncated — truncated_lines=[1]、正文 8192 字节（磁盘上 9001 字节）
PASS 超长行被截断的文件不得给出可编辑票据（截断后的正文不是原文） — 第 1 行超过单行上限 8192 字节，已按上限截断；截断后的正文不是磁盘原文，不能作为编辑基线。
PASS 大文件首页：标出总行数、给出下一页游标，且明确 truncated — 48000 行中的第 1..401 行；游标=有
PASS 逐页读完 1200 行：拼接结果与磁盘字节逐字相同（分页不丢行、不重复、不空转） — 5 页、覆盖 1200 行、拼接 30084 字节（磁盘 30084 字节）
PASS 只读前 3 行时会说清楚"这不是整个文件"（truncated 为真，且总行数照给） — 返回第 1..4 行、共 1200 行、truncated=true
PASS 超过 MAX_READABLE_FILE_BYTES（16777216）的文件按上限拒绝，且**一个字节都没读** — SIZE_LIMIT_EXCEEDED，真实读取次数 0
NOTE 三个上限 — 可读 16777216 字节 / 可编辑 2097152 字节 / 单行 8192 字节 / 单页 400 行
```

**"冒充完整文件"有三种形态，每一种都单独验了：**

| 形态 | 判据 | 实测 |
|---|---|---|
| 单行被截断 | `truncated_lines` 非空，且 `content` 不含该行原文 | `edge/long-line.txt` → `[1]`、8192 ≠ 9001 字节 |
| 只有前面若干行 | `truncated === true` + `total_lines` 照给 + `next_cursor` | 1200 行文件只读 3 行 → `1..4`、`共 1200 行` |
| 只读了中间一段 | `start_line` / `end_line_exclusive` 与实际返回一致 | 大文件首页 → `1..401` |

**`truncated === false` 是"`content` 就是整个文件的正文"的唯一凭据。**
契约里写明了三条置真的情形，任何调用方都不能从"看起来读完了"推断它 ——
因此证据里比对的是这个标志，而不是"行数对上了""字节数看着像"。

**分页拼接是逐字节比对，不是行数比对。** 1200 行的 CRLF 文件按 250 行一页读 5 次，
把 5 段正文拼起来与磁盘上的 30084 字节**逐字相同**。行数对上但内容错位（丢一行、
重复一行、把 CRLF 拆开）都会让这条失败。

**游标只承载起点，不承载页大小。** 续读要拿到同样大的页必须带同样的 `max_lines`；
不带就回到硬上限（`tests/windows/files-read.test.ts` 里钉住了这一条）。
不把页大小写进游标，是因为契约把 `max_lines` 定义为**每次调用的参数**，
而把页大小偷偷塞进游标会让同一个参数在不同调用上含义不同。

**上限是硬的，而且排在读字节之前。** 一个 16 MiB + 1 字节的文件返回
`SIZE_LIMIT_EXCEEDED`，**真实文件打开次数为 0** —— 受控句柄只提供整文件读取，
所以"先读进来再判断是不是太大"等于没有上限。

### 验收标准 3 · 伪造或跨工作区重放读取票据被拒绝

```
NOTE 真实票据 — lwbrt_eyJraW5kIjoicmVhZC…（长度 689）
NOTE 密钥指纹 — b5c000523eddda1b
PASS 拒绝：改掉票据的最后一个字符 — 理由 TICKET_BAD_SIGNATURE
PASS 拒绝：用另一把密钥对同一份载荷重新签名 — 理由 TICKET_BAD_SIGNATURE
PASS 拒绝：把别的字符串当票据 — 理由 TICKET_WRONG_PREFIX
PASS 拒绝：把分页游标当读取票据用（同一个权威签发，只是 kind 不同） — 理由 TICKET_WRONG_PREFIX
PASS 拒绝：票据过期（有效期是唯一失效机制，因此必须真的生效） — 理由 TICKET_EXPIRED
PASS 对照：绑定项全部一致时，票据被接受（上面的拒绝不是"谁来都拒"）
PASS 拒绝：跨连接重放（换一条 connection_id） — 理由 TICKET_CROSS_CONNECTION
PASS 拒绝：跨工作区重放（换一个 workspace_id） — 理由 TICKET_CROSS_WORKSPACE
PASS 拒绝：代次失效（工作区被移除后重建） — 理由 TICKET_GENERATION_MISMATCH
PASS 拒绝：拿这张票据去改另一个文件 — 理由 TICKET_PATH_MISMATCH
PASS 对照：大小写不同但指向同一对象的路径**被接受**（真正的身份判据是 volume/file/hash 三项） — TICKET.TXT 与磁盘上的 ticket.txt 视为同一文件
PASS 拒绝：提案声明的基线与票据记录的版本不一致 — 理由 TICKET_BASE_MISMATCH
PASS 票据绑定项齐全，且**不含正文**（只有哈希、身份与范围） — 20 个字段：canonical_path, connection_id, editable, editable_blockers, expires_at, file_id, generation, issued_at, kind, range_end_exclusive, range_start, raw_bytes_sha256, redacted, size, total_lines, truncated, truncated_lines, v, volume_id, workspace_id
PASS 票据里的卷/文件身份与**护栏当场取回的身份**一致，范围与实际返回一致 — file_id=006c0000… sha256=ba336a0bf02c… 范围 1..4
```

**每一条拒绝都点名了理由标签，而不是只断言"抛错了"。** `READ_TOKEN_STALE` 是这一族
共用的错误码，光看码分不出"签名不对"与"过期了"；把 `reason` 逐条钉住，
才让"某天某个绑定项悄悄不再被检查"这件事有办法被发现。

**两个对照是这段证据的一半。** 只有拒绝的那 7 条时，"全都拒了"同样可以解释成
"这个权威对谁都拒"或"我的装置把票据弄坏了"。因此：

- 绑定项全部一致时必须**被接受**（证明权威本身工作正常）；
- `TICKET.TXT` 与磁盘上的 `ticket.txt` 必须**被接受** —— 真正的身份判据是
  `volume_id` / `file_id` / `raw_bytes_sha256` 三项，路径这一项只用来抓
  "明显不是同一个文件"。做成过严（按字节比路径）的代价是 NTFS 上每一次
  大小写不一致的正常提案都被判成跨文件重放，而**过严的实现会让上面 7 条全绿**。

**签名覆盖的是传输中的那串字节，不是重新序列化的结果。**
`mac = HMAC(key, payloadB64)`，验证时对**收到的** `payloadB64` 原文重算，通过之后才解析。
改成"解析 → 规范化 JSON → 算 MAC"的话，签名的对象就成了规范化函数的像，
而那个函数是有损的（`canonicalJson` 做 NFC 规范化）：一份 NFD 形式的路径可以被改写成
NFC 形式而签名不变 —— 路径正是本票据的绑定项，让它在签名之后仍有等价改写空间，
等于把「按身份而非字符串」这条反过来用。

**票据里没有正文，也没有任何能换来批准的东西。** 20 个字段全部列出并逐项断言，
它是一个**无状态**的签名载荷：不随读取次数增长（内存表会被"读一万个文件"撑爆，
那正是本任务要防的那类事），代价是有效期成为唯一的失效机制 —— 因此
`READ_TOKEN_TTL_MS` 必须存在且必须真的生效（上面那条过期用例）。

---

## 2. 实测：读取过程中有写冲突则失败

```
PASS 装置前提：另一个进程在目标上持有一个排他写句柄 — 另一进程持有 busy.txt 的写句柄（access=write, share_mode=none），身份 004d0000…
PASS 文件被另一个进程独占时读取失败，且失败原因是**共享冲突**而不是"文件不存在" — FILE_BUSY（护栏码 FILE_BUSY、Win32 32）
PASS 元数据预检同样失败（它也要打开句柄取哈希，没有"轻量到不受影响"这回事） — FILE_BUSY
PASS 对照：持有者进程退出后同一文件可以正常读取（因此上面那条确实是那个句柄造成的） — 读回 23 字节
```

**这不是模拟。** 冲突来自 Win32 的共享模式语义：另一个 PowerShell 进程
（`ResidentHelper`，与生产后端**同一份脚本**）以 `share_mode: none` 打开了 `busy.txt`，
读取侧的开句柄请求与它冲突，内核返回 `ERROR_SHARING_VIOLATION`（32），
护栏映射成 `FILE_BUSY`。失败原因的**具体性**是重点：`NOT_FOUND` 会让模型去重试
一个不存在的路径，`FILE_BUSY` 才是"等一会儿再试"。

**必须把持有者放进另一个进程。** `holdHandle` 的语义就是"故意不释放句柄"，
而句柄只随进程退出被内核回收 —— 这恰好让最后那条对照成为可能：
持有者进程退出之后，同一个文件必须能正常读回来。没有这一步，
"读不了"也可能只是因为这个文件本来就打不开。

**元数据预检一视同仁。** `file_stat` 也要打开句柄取哈希，因此同样 `FILE_BUSY` ——
没有"轻量到不受影响"这回事，这一点被单独钉住了。

---

## 3. 实测：硬拒绝在读字节之前生效 / 元数据预检的定位

```
PASS 硬拒绝：.env（真实读取次数必须为 0） — POLICY_DENIED，规则 HD-ENV，真实读取次数 0
PASS 硬拒绝：.env.example（真实读取次数必须为 0） — POLICY_DENIED，规则 HD-ENV，真实读取次数 0
PASS 硬拒绝：id_rsa（真实读取次数必须为 0） — POLICY_DENIED，规则 HD-SSH-KEY，真实读取次数 0
PASS certain 级命中的令牌被脱敏后再出站，其余正文仍可读 — "# LWB 测试诱饵：公开示例格式的假 token。\nGITHUB_TOKEN=[REDACTED:github-token]\nSLACK_TOKEN=[REDACTED:slack-token]\n"
PASS 脱敏过的读取拿不到可编辑票据（否则改写会落在一段被替换过的正文上） — 内容因敏感信息策略被脱敏，脱敏结果不能用于编辑。；脱敏替换会改写命中片段（可能跨行），返回正文的行号不再与磁盘一一对应。
PASS 读取不改动被读的对象：夹具文件哈希与清单一致 — 4d5215090804…
PASS file_stat 给出哈希与尺寸，但不含正文、不含票据、且永远不可编辑 — sha256=02cb14899b8b… size=23 editable=false
PASS 硬拒绝路径连元数据都不给（否则 file_stat 就成了存在性/大小/哈希探针） — POLICY_DENIED
```

**顺序是"预检 → 读字节 → 身份比对 → 出站"，而预检用的是句柄给出的规范拼写。**
每一次读取在**读任何字节之前**先拿空载荷过一次出站闸门，问的是"这个路径有没有资格
往外走内容"。上面三条硬拒绝的**真实文件打开次数为 0** —— 正文没有经过 daemon 的内存，
这不是靠"记得先检查"做到的，而是靠顺序。

**`.env.example` 不豁免。** 这是方案里明确的一条：示例文件常常是从真实 `.env`
复制出来再删几行的，而"删干净了没有"由不得模型判断。

**脱敏是唯一一处"正文与磁盘不同"的合法情形，因此它必须付出代价：**
拿不到可编辑票据（否则改写会落在一段被 `[REDACTED:…]` 替换过的正文上），
且明确告知返回正文的行号不再与磁盘一一对应（命中可能跨行，私钥块就是）。
同时 `sha256` 仍然是**磁盘原始字节**的哈希 —— 脱敏不改变"读的是哪个版本"。

**`file_stat` 不签发读取票据。** 契约里 `FileStatData` 根本没有这个字段，
于是"拿 stat 的结果去编辑"在**类型上**就不可能，不需要靠约定。
它仍然两次打开做身份比对、仍然过闸门 —— 但硬拒绝路径连元数据都不给，
否则它就成了 `.env` 的存在性/大小/哈希探针。

---

## 4. 采集过程中发现并修复的真实缺陷

三条。第一条是**过滤器**的缺陷（产品行为正确），第二条是**真实产品缺陷**
（只有接上真实护栏才暴露），第三条是**行索引的差一**，由一个独立实现的清单抓到。

### 4.1 证据脚本把"文件够小"当成了"这次读回来的是全部字节"

第一次采集的结果是 **43 PASS / 1 FAIL**，唯一那条 FAIL 是：

```
FAIL 逐个夹具：正文逐字节相同、哈希/行数/换行/BOM 与独立的清单一致 — edge/long-line.txt: 正文与磁盘字节不同 | edge/long-line.txt: 整份可读的文件被标成了截断
```

`edge/long-line.txt` 只有 9001 字节、1 行 —— 尺寸与行数都远在
`MAX_READABLE_FILE_BYTES`（16 MiB）与 `MAX_READ_LINES`（400）之内，
于是被过滤器算进了"整份可读"。但它那**一行本身**超过了 `MAX_LINE_BYTES`（8 KiB），
读出来必然是被截断的 8192 字节。

**产品是对的，判据是错的。** 正确的判据是"这次读回来的就是磁盘上的全部字节"，
而"这个文件看起来够小"是它的一个**近似**，且恰好在这个夹具上不成立。
修法是让过滤器真的去读一遍文件、算出最长行的字节数，超过上限就排除
（并在 NOTE 里点名它被排除了 —— 排除一个夹具必须是**看得见**的行为，
否则过滤器会变成一个把失败藏起来的地方）。

这条值得记的原因是它的失效方向：一个**过松**的过滤器会把"产品正确的行为"
报成 FAIL（噪声，会被学会忽略），而一个**过严**的过滤器会把真正的缺陷藏起来。
因此这里不做任何"看起来差不多就跳过"的模糊判定。

### 4.2 护栏的 `resolvePath` 不返回规范拼写，真实读取**全部**失败

`tests/windows/files-read.test.ts` 第一次运行时 **14 项里 12 项失败**，
全部是同一条：

```
TypeError: Cannot read properties of undefined (reading 'includes')
    at assertRelativePath (packages/egress/src/clearance.ts:142:12)
    at emitContent (packages/egress/src/clearance.ts:171:3)
    at readFile (packages/files/src/read.ts:478:3)
```

根因是**边界层的类型谎言**：`PowerShellWinfsBackend.resolvePath()` 返回的对象里
根本没有 `canonical_relative_path`（护栏的 `resolvePath` 操作也没算它），
但它用 `as unknown as WinfsReadResult` 强转成了读结果 —— 于是"少给了一个字段"
这件事既不被编译器发现，也不被单元测试发现（单元测试的桩**照契约**提供了这个字段，
所以它验的是流水线、验不到边界）。

于是真实路径上 `probe.canonical_path` 是 `undefined`，一路穿到出站闸门，
在 `path.includes('\\')` 处炸成 `TypeError`。**这意味着接上真实护栏之后
`readFile` 一次都跑不通** —— 而这正是"桩测不出边界"的典型形态。

修法三处，方向都是"让不可能写错"而不是"记得写对"：

1. 护栏的 `resolvePath` 操作开始返回 `canonical_relative_path`
   （它已经在 `try` 块里持有根句柄与目标句柄，`Get-CanonicalRelativePath` 是现成的）。
   这一项**必须**在预检阶段就有：预检发生在读任何字节之前，那时还没有
   `readFileGuarded` 的结果可用，而预检要判的正是"磁盘上那个名字"。
2. 后端**去掉 `as unknown as` 强转**，改成把对象标成 `WinfsReadResult` 的完整字面量 ——
   于是"护栏少给了一个字段"从此是**编译错误**。改完之后 `tsc` 通过，
   说明那个对象确实满足契约（这一点本身就是原强转在掩盖缺陷的证据）。
3. `gatePathFor()` 的判断由 `=== null` 改成 `== null`：类型上只可能是
   `string | null`，但护栏实现是外部边界，漏报会给出 `undefined`，
   而两者的含义完全相同（"无法证明目标在根之下"），都该拒绝。
   `''` **不在此列**：空串是单文件工作区里"目标就是根"的合法拼写。

### 4.3 行索引在末尾换行后多算一个空行

`packages/files/src/decode.ts` 的 `indexLines()` 在文件以 `\n` 结尾时会多产生一行：
`'a\n'` 被数成 2 行，而磁盘上只有 1 行。第二行是 `[len, len)` 那个空区间，
**并不存在**，而它是**可编辑**的 —— 于是一段编辑区间可以延伸到文件末尾之外。

抓到它的不是自洽的单元测试，而是**夹具清单**：`manifest.json` 里的 `lineCount`
由 `tests/fixtures/build-fixtures.ts` 独立算出，两侧对同一批夹具给出了不同结论
（`文档/设计说明.md` 12≠11、`edge/long-line.txt` 2≠1、`large/big.txt` 48001≠48000）。
修法是在末尾换行后终止循环（`if (pos === text.length) break;`），
并把这段经过写进了代码注释 —— 因为"文件头写着 1 行、代码算 2 行"这件事，
下一次仍然只能靠一个外部判据发现。

---

## 5. 偏离项与设计取舍

### 5.1 契约新增两个常量与一个字段

`packages/contracts/src/limits.ts` 新增 `MAX_READABLE_FILE_BYTES`（16 MiB，
高于 `MAX_EDITABLE_FILE_BYTES` 与 `MAX_CHANGE_TOTAL_BYTES`：**能读的东西比能改的多**）
与 `READ_TOKEN_TTL_MS`（1 小时，签名的票据无状态，有效期是唯一失效机制）；
`packages/contracts/src/read.ts` 的 `FileReadData` 新增 `truncated_lines`。
三项都记在 `docs/PROGRESS.md` 的偏离项里。

两个常量同时加进了 `OPERATOR_TUNABLE_LIMITS`（本地操作者可覆盖的限额清单）——
因此本次改动**扩大了可覆盖限额的集合**。附带发现并记录（不属本任务交付面）：
`NON_RELAXABLE_LIMITS`（「可收紧、不可放宽」）**已导出但无人读取**，
`validateLimitOverride` **没有任何调用点**，而它也不检查 `NON_RELAXABLE_LIMITS`
——它只校验键在可覆盖清单内、值是正整数。也就是说「只能收窄」这条安全语义
目前在契约里**只是声明**。本次新增的两个键都**不在** `NON_RELAXABLE_LIMITS` 里，
因此没有静默违反任何既有语义；但限额覆盖的落地（接线与收紧方向校验）
必须在 LWB-018 取证，不能读成「已经生效」。

### 5.2 「分页」不使结果不可编辑

契约里 `editable` 的说明是「该文件是否可被编辑」，而方案 §6.3 的规则是
「编辑区间必须在读取票据的**已见范围**内」。两者合起来只有一种自洽的实现：
票据绑定实际返回的行范围，编辑必须落在范围内（`coversEditRange`）。
若把"本次没返回整个文件"直接判成不可编辑，那么任何超过 400 行的文件都永远无法编辑。

换句话说：**不可编辑性的来源是"这段正文不能作为基线"，不是"这段正文只是一部分"。**
行号错位、被截断、被脱敏、混用换行都属于前者；分页不属于。
（这条解释记在 `packages/files/src/read.ts` 的 `editableBlockers` 文档注释里。）

### 5.3 单文件工作区的根：闸门看到的是根的文件名

`gatePathFor()` 在规范路径为空串时改用 `basename(root_path)`。
空串是"目标就是根对象"的合法拼写，而**空串不命中任何按名字匹配的硬拒绝规则**
（`classifyFile('')` 返回 allow）—— 于是"把 `.env` 登记成一个单文件工作区"
就能绕过 `HD-ENV`。**这一条在 `read.ts` 里补上了**（单文件工作区读 `.env` 现在被拒）。

但**登记侧的同一类问题没有修**：`packages/workspaces` 的 `screenRoot()`
没有使用 `@lwb/contracts` 里已经导出、却无人调用的 `isProtectedPathSyntax()`。
两者是不同的后果（登记侧拦的是"把密钥文件设成工作区根"，读取侧拦的是"把它的内容送出去"），
本任务只修了后者。**这条留给 LWB-014 或后续任务**，因为改登记侧会动到
工作区语义与既有迁移，不属于 LWB-013 的交付面。

### 5.4 护栏的 `PERMISSION_DENIED` / `IO_ERROR` 刻意不映射成"听起来合理"的码

契约里没有 ACL 拒绝的等价码。`PATH_UNSAFE` 的语义是"路径或身份不安全，不会降级"，
而这里路径没问题、是权限不够；`POLICY_DENIED` 更不对 —— 那意味着本地策略拒绝，
用户去改策略是白费功夫。因此它们落到 `INTERNAL_ERROR` 并在 `details` 里带上
`winfs_code` 与 `win32_error`。**给一个听起来合理的码会把调用方引向错误的方向**，
这比一个"诚实但不好看"的码更危险。

### 5.5 两次打开的身份比对有一个已知残余

本实现的写冲突检测是"探针取身份 → 读取字节 → 比对身份与尺寸"。
它抓得住替换、改名、尺寸变化，但**抓不住"同一个对象被一个已存在的写句柄就地改成了同样大小"**
—— 那种情况下两次打开看到的 `file_id` 与 `size` 完全相同。
残余风险由写入侧的 `base_sha256` 复核兜住（I07：写入前在同一个句柄内校验基线），
因此这一层的缺口不会变成"基于旧内容写入"。

### 5.6 交付物路径

任务书写 `packages/files/read.ts` 与 `packages/contracts/read.ts`。实际为
`packages/files/src/{decode,read-token,read}.ts`、`packages/contracts/src/read.ts`，
以仓库既有的 `src/` 约定与 `check-fsguard-imports.mjs` 的前缀规则为准
（同偏离项 7 / 16 的理由：放在约定之外会让代码落在两个清单之外）。
`packages/files/` 的 `BUSINESS_PREFIXES` 前缀是 LWB-005 建骨架时**预置**的
（同偏离项 5 描述的 `apps/console/`，属前瞻性声明），本任务是第一个真正往里放文件的，
该前缀由此从声明变为实际生效。`scripts/check-fsguard-imports.mjs` **本次未修改**。
覆盖有效性以**反向探针**证实（偏离项 9 的要求）：

```
$ cat > packages/files/src/__probe_tmp.ts <<'EOF'
import { readFile } from 'node:fs/promises'; …
$ node scripts/check-fsguard-imports.mjs
❌ FsGuard 导入检查发现 1 处违规：
  [FSGUARD_BYPASS] packages/files/src/__probe_tmp.ts:1
      导入 "node:fs/promises"
EXIT=1
$ rm packages/files/src/__probe_tmp.ts && node scripts/check-fsguard-imports.mjs
✅ FsGuard 导入检查通过（已检查 83 个文件，未发现绕过）。   EXIT=0
```

---

## 6. 未执行项（不得记为通过）

```
NOT_RUN 真实 ChatGPT Web 端到端读取验收 — 需要真实账号与 Secure MCP Tunnel 凭据；LWB-002 仍为 BLOCKED
NOT_RUN 两个 daemon 实例之间的并发读写仲裁 — 本证据证明的是**句柄层面**的跨进程冲突（持有者与读取者各是一个 PowerShell 进程）；daemon 级仲裁属多实例场景，V1 是单用户单 daemon，不提供也不声称提供
NOT_RUN 超大文件（> 16 MiB）的分页读取 — V1 按契约直接拒绝；分页只覆盖 MAX_READABLE_FILE_BYTES 以内的文件
NOT_RUN NTFS 之外的卷（ReFS / 网络盘 / 云占位文件） — 本机只有 NTFS；LWB-009 的卷形态判定覆盖了拒绝路径，但未在真实 ReFS 上采集
```

第一项是硬门禁：**MCP Inspector 里的成功不能替代真实网页验收**，
本任务的读取能力是否真的能在 ChatGPT Web 里被模型调用，本环境无法自证。

第二项的范围要说清楚：本证据证明的**不是**模拟 ——
持有者与读取者确实是两个操作系统进程，冲突来自真实的 Win32 共享模式语义。
未被覆盖的是"两个 daemon"这个部署形态，而那不在 V1 范围内。

第三项：`MAX_READABLE_FILE_BYTES` 以上的文件按契约直接拒绝，
因此不存在"超大文件分页"这条路径，也就无从采集。

---

## 7. 变更文件

| 文件 | 行数 | 内容 |
|---|---|---|
| `packages/files/src/decode.ts` | 272 | 字节事实识别（BOM/NUL/严格 UTF-8）、行索引、换行判定、按字节截断 |
| `packages/files/src/read-token.ts` | 459 | 签名读取票据与分页游标；取用校验 `assertReadTokenMatches`；`coversEditRange` |
| `packages/files/src/read.ts` | 781 | 探针 → 预检 → 受控读取 → 身份比对 → 出站 → 分页 → 票据；`statFile` |
| `packages/files/src/index.ts` | 22 | 导出与本包的边界说明 |
| `packages/files/package.json` | — | 新工作区包 `@lwb/files` |
| `packages/contracts/src/limits.ts` | +2 常量 | `MAX_READABLE_FILE_BYTES`、`READ_TOKEN_TTL_MS` |
| `packages/contracts/src/read.ts` | +1 字段 | `FileReadData.truncated_lines` |
| `native/winfs/WinfsGuard.ps1` | +6 | `resolvePath` 操作返回 `canonical_relative_path`（§4.2） |
| `native/winfs/src/powershell-backend.ts` | ±12 | `resolvePath` 映射规范拼写；去掉 `as unknown as` 强转（§4.2） |
| `tests/unit/files-read.test.ts` | 1093 | 45 项（磁盘用桩） |
| `tests/windows/files-read.test.ts` | 473 | 14 项（真实 NTFS + 真实护栏） |
| `scripts/evidence/lwb-013.ts` | 819 | 本证据的采集脚本 |

`scripts/check-fsguard-imports.mjs` 的**配置未改**（`packages/files/` 已在 LWB-005
建骨架时预置进 `BUSINESS_PREFIXES`）。检查器只收集 `packages/`、`apps/`、`native/`
三个根下的 `.ts`（排除 `.d.ts`，跳过 `generated` 等目录），因此
**79 → 83 恰好是新增的四个 `packages/files/src/*.ts`** —— 两个测试文件与证据脚本
在 `tests/`、`scripts/` 下，不在收集范围内，不计入这个数。

---

## 8. 回归

```
$ npx tsc --noEmit                                    → 退出码 0
$ node scripts/check-fsguard-imports.mjs              → 83 个文件，未发现绕过
$ node scripts/run-tests.mjs                          → tests 626 / pass 626 / fail 0
$ node scripts/run-tests.mjs tests/windows            → tests 144 / pass 144 / fail 0
$ node --import tsx scripts/evidence/lwb-012.ts       → 50 PASS / 0 FAIL / 4 NOT_RUN，退出码 0
$ node --import tsx scripts/evidence/lwb-013.ts       → 44 PASS / 0 FAIL / 4 NOT_RUN，退出码 0
```

LWB-010 的 Windows 用例集（`tests/windows/`）在本次改动后**重新跑过** ——
`resolvePath` 的返回值变了，而那份用例断言过它的回执形状，因此上面那一行是
本次的运行结果，不是上一轮的引用。
