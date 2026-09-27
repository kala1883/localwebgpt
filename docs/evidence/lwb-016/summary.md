# LWB-016 · 只读 Git 查询 — 证据

**采集方式：** `node --import tsx scripts/evidence/lwb-016.ts`（退出码 0；**118 PASS / 0 FAIL / 5 NOT_RUN**）
**采集环境：** Windows 11 Home China 10.0.26200 / Node v22.20.0 / tsx 4.23.15 / PowerShell 7.6.6 /
护栏后端 `powershell-pinvoke` / git 2.43.0.windows.1（**仅证据脚本用来造夹具与取参考输出，产品代码不调用它**）
**测试套件：** `tests/git/git-reader.test.ts`（**49 例**，磁盘用桩）+
`tests/windows/git-reader.test.ts`（**11 例**，真实 NTFS + 真实护栏 + 真实 `.git`）；
全仓 `tests 827 / suites 135 / pass 827 / fail 0`
**静态检查：** `npx tsc --noEmit` 退出码 0；`node scripts/check-fsguard-imports.mjs` — **98 个文件**，未发现绕过（LWB-015 时为 90，本次新增 8）
**原始日志：** 未入库（`*.log` 在 `.gitignore` 中，与 `lwb-006` ~ `lwb-015` 一致）。
下文引用的每条 `PASS` / `NOTE` 行均为运行输出的**逐字**摘录，本文件不依赖那份日志才可读。

---

## 1. 验收标准逐条

### 验收标准 1 · 查询前后 `.git/index`、refs、配置和工作区内容不变

```
NOTE 查询前的树摘要 — 79 个文件，digest=287d07b26b6014a3…
PASS 查询前后整棵树逐文件 sha256 完全相同 — 79 个文件
PASS 点名核对：.git/index 与 manifest 生成时的那份一致 — 由上面的整树摘要覆盖（逐文件 sha256）
PASS 点名核对：.git/HEAD 与 manifest 生成时的那份一致 — 由上面的整树摘要覆盖（逐文件 sha256）
PASS 点名核对：.git/config 与 manifest 生成时的那份一致 — 由上面的整树摘要覆盖（逐文件 sha256）
PASS 连查两次结果逐字节相同（没有被自己的第一次查询改变）
PASS diff 之后整棵树仍然逐文件相同 — 79 个文件
PASS 写调用没有碰护栏（护栏的写入口一次都没被调用）
PASS 账本非空时的断言 的错误码 — 期望 INTERNAL_ERROR，实际 INTERNAL_ERROR（只读虚拟文件系统拒绝了库的写入尝试，本次调用的结果不再可信，因此整次失败。）
```

**这条标准不能靠「我们没写」这句话成立，因此判据落在三种互不相同的观察上。**

1. **整棵树的逐文件 sha256 在查询前后拼成的摘要完全相同 —— 而且包含 `.git/**`。**
   少看一个目录就等于少验一条：「查询可能碰到的东西」与「被检查的东西」必须是
   同一个集合。夹具仓库旁的 `.git` 里 index、HEAD、config、refs、objects 全在其中。
2. **连查两次结果逐字节相同。** 一个「读的时候顺手把索引 stat 缓存刷新回去」的
   实现，第一次调用就会改掉 `.git/index`，而第二次读到的索引与第一次不同 ——
   这条比第 1 条更早报警，且它不依赖摘要比较。
3. **护栏的写入口一次都没被调用。** 在**真实后端**上把 `writeFileGuarded` /
   `createFileGuarded` 包成抛错（不是「记一笔然后放行」），跑完一次完整状态查询后
   计数为 0：写通道不是「被拒绝」，是**从来没有被走到**。

第 3 条之外还有一层：只读虚拟 fs 的写方法被逐个调用。**证据脚本**在真实后端上
点了 10 个（`NOTE 被拒绝的写调用 — 10/10`，与库的 `FileSystem` 契约对齐），
**单元测试**点了 12 个（多出 `readlink` 与记账形状这两条），全部 `EPERM` 拒绝、
全部记账，且**一次都没有到达护栏**（`tests/git/git-reader.test.ts`
「写调用一次都没有碰护栏」断言 `resolve` / `read` / `list` 三个计数器全为 0）。
账本非空时整次调用失败：

```
PASS 账本非空时的断言 的错误码 — 期望 INTERNAL_ERROR，实际 INTERNAL_ERROR（只读虚拟文件系统拒绝了库的写入尝试，本次调用的结果不再可信，因此整次失败。）
PASS 断言只报次数、不报那些路径 — {"reason":"READONLY_FS_WRITE_ATTEMPT","attempts":10}
PASS 干净的账本上断言不抛
```

方案 §9.1 的双重约束因此是两件事，两件都做到了：写方法**拒绝**（写不会发生），
以及账本非空时**整次失败**（发生了就不返回结果）。

### 验收标准 2 · 已暂存、未暂存、未跟踪和删除状态可区分

期望值来自**夹具生成器**在造夹具时记下的 `git status --porcelain`
（`manifest.git_status_porcelain`），不是本文件算出来的 —— 自己算一份期望值等于
拿实现验实现：状态解码只要和 porcelain 的读法一起错，两边会同时错成同一个样子。

```
PASS porcelain 有四条（装置前提） —  D src/deleted.ts | A  src/staged.ts |  M 文档/设计说明.md | ?? src/untracked.ts
PASS 状态可区分：src/deleted.ts — porcelain「 D」→ 期望 {"head":"unmodified","worktree":"deleted"}，实际 {…"worktree":"deleted"}
PASS 状态可区分：src/staged.ts — porcelain「A 」→ 期望 {"head":"added","worktree":"unmodified"}，实际 {…"head":"added","worktree":"unmodified"}
PASS 状态可区分：文档/设计说明.md — porcelain「 M」→ 期望 {"head":"unmodified","worktree":"modified"}，实际 {…"worktree":"modified"}
PASS 状态可区分：src/untracked.ts — porcelain「??」→ 期望 {"head":"absent","worktree":"untracked"}，实际 {…"worktree":"untracked"}
PASS 未被改动的已提交文件报告为 unmodified/unmodified — {"path":"README.md","head":"unmodified","worktree":"unmodified"}
```

夹具只覆盖四种状态中的每一样各一条。**另外两条 porcelain 组合在临时仓库上采**
（用 git CLI 现造，因此可以任意改动它）：

```
NOTE 临时仓库 porcelain —  M app/config.txt |  M app/crlf.txt |  M app/stable.txt | ?? app/untracked.txt | AM app/staged.txt | D  app/removed.txt
PASS 状态可区分：app/staged.txt — porcelain「AM」→ 期望 {"head":"added","worktree":"modified"}
PASS 状态可区分：app/removed.txt — porcelain「D 」→ 期望 {"head":"deleted","worktree":"absent"}
PASS head_commit 是最后一次提交 — e592a5abcbda27636f479a24961446cec183109c
```

`AM` / `D ` 这两条是**故意造**的：`git commit` 提交的是索引，所以「先暂存、再改一次」
与「先提交、再 `git rm`」的次序决定了它们成不成立 —— 次序写反时 `AM` 会悄悄退化成
` M`，而那时的证据看起来仍然「通过」。次序写在脚本里（`scripts/evidence/lwb-016.ts`
`sandboxRepo()`）。

行解码本身是纯函数，因此单独穷举过：

```
PASS 可达组合恰好 15 种 — 0,0,0 0,0,3 0,2,0 0,2,2 0,2,3 1,0,0 1,0,1 1,0,3 1,1,0 1,1,1 1,1,3 1,2,0 1,2,1 1,2,2 1,2,3
PASS 9 种不可达组合全部报错，一条都不猜 — 9/9
PASS 不可达组合 0,0,1 的错误里不带路径 — {"reason":"UNEXPECTED_STATUS_ROW","combo":"0,0,1"}
```

那 9 种组合出现的**唯一**原因是库的编码变了。那时按现有规则算出来的会是一条
**看起来正常的错状态**，而错状态比报错危险 —— 所以抛错，且错误里只带那三个数字、
不带路径：这个分支的前提正是「我们对库的理解已经不成立」，既然前提都不成立，
就不能再假设这一行里的路径是一条可以回显的路径。

### 验收标准 3 · 只读 fs 发现库试图写入时测试失败，不能悄悄放行

见验收标准 1 的后半。补一条**结构上**的观察：库的契约要求 `writeFile` / `unlink` /
`mkdir` / `rmdir` / `rm` / `chmod` / `rename` / `appendFile` / `truncate` / `utimes`
都存在（缺一个，库会在需要它的时候报 `TypeError`，而那是另一种难查的失败），
因此它们是**存在但拒绝**，不是不存在：

```
PASS 只读 fs 暴露了 writeFile（库的契约要求它存在）
PASS writeFile 拒绝且带错误码 — code=EPERM
…（10 个写方法逐个，均为 PASS）
PASS 写调用没有碰护栏（护栏的写入口一次都没被调用）
PASS 账本记下了每一次拒绝 — 10
```

`refresh:false` 不是唯一的防线，而是**第一层**：它的默认值是 `true`，而 `true` 会
让 `statusMatrix` 回写索引的 stat 缓存 —— 那是「查询改写了它正在读的东西」。
第二层是 fs 根本没有写通道，第三层是账本非空即整次失败。

### 验收标准 4 · 秘密文件和未授权历史 blob 不能借 diff 输出；不支持的格式显式降级

```
PASS 硬拒绝的路径不出现在 entries 里
PASS 它们计入 policy_hidden_count — count=4，期望 4
PASS 整份状态结果里不出现任何硬拒绝路径的名字
PASS 该路径在 HEAD 里确实有对象（这条拒绝才有意义）
PASS diff 硬拒绝路径 的错误码 — 期望 POLICY_DENIED，实际 POLICY_DENIED（该路径命中硬拒绝规则 HD-ENV，不会读取、不会比较，也不会经任何出站面返回内容。）
PASS 硬拒绝错误里不含该内容、也不含路径名 — {"code":"POLICY_DENIED","details":{"hard_deny_rule":"HD-ENV"},"name":"BridgeError"}
PASS 未改动的秘密文件：零 hunk，且结果里不含凭证 — []
PASS 拒绝里不带该路径的内容，并说明 V1 只比较存在的一侧 — {"winfs_code":"NOT_FOUND","win32_error":2}
```

被点名的是夹具里 4 个**已提交**的秘密文件（它们在 HEAD 的 blob 里）：
`secrets/.env`、`secrets/aws.env`、`secrets/id_rsa`、`config/.env.example`。
「已提交」这一点是这条证据成立的前提 —— 一个从未提交过的文件本来就不在对象库里，
拒绝它证明不了「未授权历史 blob 不能借 diff 输出」。`secrets/token.txt`
**不在**名单里：策略表里没有一条规则匹配它的路径，它是普通条目、内容由 `file_read`
那一层脱敏。把「脱敏」与「硬拒绝」并成一件事会让这条证据看起来更严，实际是错的。

秘密不入 diff 的**原理**不是过滤，而是「两侧相同就一个字节都不发」：

```
PASS 未脱敏也如实说（没有改动就没有内容可脱敏）
```

`secrets/token.txt` 没有改动，因此不进入任何 hunk。这一点与
`docs/evidence/lwb-011/summary.md` 里那句「搜索与 Git 差异的真实调用点尚未接线」
接上：本次把那个调用点钉住了 —— 改动行确实经过出站闸门：

```
NOTE config.txt 的 hunk — [{…"lines":[" mode=demo","-password = \"[REDACTED:keyword-secret-value]\"","+password = \"[REDACTED:keyword-secret-value]\""]}]
PASS likely 档命中被脱敏，hunk 里不是磁盘原文
PASS 脱敏以 `[REDACTED:规则]` 的形式出现在 hunk 行里
PASS 原始值没有跟着出去
PASS old_sha256 是 HEAD 里那份的摘要（不受脱敏影响）
PASS certain 档凭证出现在改动行 的错误码 — 期望 SECRET_DETECTED，实际 SECRET_DETECTED
PASS 阻断错误里不含那段凭证、也不含文件名 — {"code":"SECRET_DETECTED","details":{"reason":"HUNK_SCREEN_BLOCKED","hunk_index":1,"hunk_count":1},"name":"BridgeError"}
```

两档的归宿不同，这是设计而非巧合：likely 档**脱敏后照发**，certain 档**整块阻断**
（错误的 `details` 里只有 hunk 下标与总数，没有内容、也没有文件名）。

「不支持的格式显式降级为仅文件能力」：

```
PASS 外置 gitdir 的仓库 的错误码 — 期望 GIT_LAYOUT_UNSUPPORTED，实际 GIT_LAYOUT_UNSUPPORTED（.git 是一个文件（gitdir 指针，常见于 linked worktree 或 submodule），仓库本体在本工作区之外。）
PASS 原因码是 GITDIR_FILE — {"reason":"GITDIR_FILE"}
PASS 外置 gitdir 的 diff 的错误码 — 期望 GIT_LAYOUT_UNSUPPORTED（同一条）
PASS 同一工作区的 file_read 仍然可用 — sha256=acb07b4aa9f7…
PASS 不是仓库的目录 的错误码 — 期望 NOT_FOUND，实际 NOT_FOUND（该工作区不是 Git 仓库（找不到 .git）。普通文件读取不受影响。）
PASS 原因码是 NO_GIT_DIR — {"reason":"NO_GIT_DIR"}
```

两个码刻意不同：「这里没有仓库」用 `NOT_FOUND`，调用方不会去改参数（参数怎么改
都不会变出一个仓库）；「这里有仓库但读不懂」用 `GIT_LAYOUT_UNSUPPORTED`，
并保证**同一工作区的普通文件读取照常可用** —— 降级的是 Git 能力，不是工作区。
单文件工作区同理，用 `NOT_FOUND` + `FILE_WORKSPACE`，错误文本里明说
「普通文件读取不受影响」（`tests/windows/git-reader.test.ts` 有一例专门断言这句话）。

---

## 2. 实测：只有真实磁盘与真实仓库才暴露的行为

### 2.1 `GitWalkerFs.stat` 拼出来的是 `<根>/.`，而 `.` 段必须当无操作

这是本任务**唯一一处会 100% 触发**的真实缺陷。库的遍历根节点 `_fullpath` 就是
`'.'`，而 `stat` 那一句是 ``fs.lstat(`${dir}/${entry._fullpath}`)`` ——
于是受控 fs 收到的是 `…\testrepo/.`。第一版把带 `'.'` 段的路径判为非法，
结果是 `statusMatrix` 在遍历的第一步就失败：诊断时直接调库看到的是
`ENOENT: no such file or directory, lstat '.'`（库自己拼出来的那句话，因此
看起来像路径根本没传对），而经过 `wrapGitFailure` 之后调用方看到的是
`INTERNAL_ERROR` / `reason: GIT_READ_FAILED`。§4.5 的反向验证第一行就是这一条：
把 `'.'` 重新判为非法，真实仓库上的四条状态用例立刻全红。

修法是让 `'.'` 段成为**无操作**（`packages/git-reader/src/meta-fs.ts` 的
`toRelative`）。两条不能反的次序：

- 归一化必须排在**策略判定之前**。`.git/./config` 先收敛成 `.git/config`，
  才轮得到 `HD-GIT-CONFIG` 拦它；反过来就是给了一条绕过窄范围清单的路
  （判的时候看到的是 `.git/./config`，读的时候是 `.git/config`）。
- `'..'` 与 `'.'` **不同**：它真的能走出工作区，因此照旧拒绝。

### 2.2 `_walk` 在 `map` 之前就对每个兄弟节点 `readdir` 过

剪枝发生在 `map` 里（返回 null 就不进入子树），而 `readdir` 在那之前已经调用了。
因此 `filepaths:['src']` 的一次查询，账本里**必然**含有 `secrets/` 之类的
范围外路径。这不是库的 bug，是它的实现次序 —— 但它直接决定了
`policy_hidden_count` 该怎么说：那个数字说的是「**你问的这个范围里**有几条被摘掉」，
范围外的路径与用户问的东西无关，必须筛掉。判据按**路径段边界**而不是裸前缀
（`src2/a.ts` 不该因为它以 `src` 开头就被算进来）。

### 2.3 `.git/config` 是我们内部解析想读的东西，不是用户可见的路径

同一次查询里 `HD-GIT-CONFIG` 会拦下 `.git/config`，于是它进了 fs 层的账本。
把它算进 `policy_hidden_count` 会让用户看到一个**他自己永远不可能看见**的文件
被计成「从他视野里摘掉了一条」。现在 `isGitInternalPath()` 把它筛掉：

```
PASS 内部路径（.git/config）不计入「工作区被摘掉几条」 — 若把 .git/config 算进去会得到 5
PASS 限定范围后 policy_hidden_count 也随之缩小（其它目录的秘密没被问到） — count=0
```

「两个判断点不能相加」这条原则在这里落成了代码：`meta.policyHiddenPaths()`
（fs 层看见每一次询问，因此**包括**那些从来没变成一行的路径）与
`assemble()` 里的逐行复核（兜底：万一有一行绕过了 fs 层）**不共用代码路径**，
复核若发现账本里没有的行就并进集合 —— 只计数，不回显名字。

---

## 3. 偏离项与设计取舍

### 3.1 `.git` 内部是**窄范围清单**，形状也是清单的一部分（偏离项 39）

`GIT_FILE_ALLOW` 要的是 `.git/objects/<2 位十六进制>/<38 位十六进制>` ——
一个完整的 oid，而不是「`objects/` 下面随便什么」。放行任意名字等于放行
`.git/objects/` 下的全部文件。这一点在本任务的测试里被**证成事实**：
第一版用例写了 `.git/objects/ab/cdef`，于是它被清单拒绝（`ENOENT`），
而当时的失败信息看起来像「对象读不到，可能是库的调用方式不对」。
修法是把夹具改成真实的 40 位 oid，并把 `ab/cdef` **保留为一个反例**
（`tests/git/git-reader.test.ts` 的窄范围清单表里那条 `allowed: false`）。

同样刻意不放开的：

- `.git/hooks/pre-commit` —— 本层不执行 hooks，也就没有理由读它；
- `.git/logs/HEAD` —— reflog 不在只读状态/差异所需范围内；
- `.git/objects/<ab>` 这种两字符**分片目录**不可列举（`GIT_DIR_ALLOW` 不含它）：
  开放它等于允许把整个对象库的名字列出来，而「模型能枚举 `.git` 内部」正是
  本任务要排除的形态。库找松散对象时 `lstat` 的是具体路径，不需要列举分片目录。

### 3.2 库为「读不到」编造的行必须在结果层摘掉（偏离项 40）

`statusMatrix` 的遍历是三棵树求并集。一个**被跟踪**的 `.env` 在 HEAD 与 STAGE 里
都是 blob，于是库内部那句 `if ((workdirType === 'tree' || workdirType === 'special') && !isBlob) return`
不成立（`isBlob` 看的是三棵树**之一**），它照样会排出一行 `[1, 0, 3]` ——
读作「工作区里被删了」。**那不是事实，是我们没读。**

受控 fs 能保证「不去读」，保证不了「不出现在结果里」：前者问库要什么，
后者问策略让不让说。因此结果层必须按**同一份规则表**再过一遍。
「没能比对」与「没有改动」也因此必须是两件不同的事，单列在 `excluded` 里：

```
PASS diff 一个已被删除的文件 的错误码 — 期望 NOT_FOUND …（文件不存在：…\src\deleted.ts（护栏码 NOT_FOUND））
```

`excluded` 的三条原因（`FILE_TOO_LARGE` / `IDENTITY_UNAVAILABLE` / `LINK_UNSUPPORTED`）
各有一个真实触发形态，写在 `tests/git/git-reader.test.ts` 里：超过单文件比对上限、
列举与 stat 之间被删掉、重解析点。重解析点为什么算「没能比对」而不是「链接」：
如实报成链接会让库去 `readlink`，而我们的 `readlink` 是拒绝的 ——
**不跟随**就意味着我们无法回答「链接目标的内容是什么」，那正是比对需要的东西。

### 3.3 `ignored` 状态**没有**，而且这是实测结论不是遗漏（偏离项 41）

被忽略的文件要出现在结果里，只能靠 `statusMatrix` 的 `ignored: true`，
而那个开关会同时让工作区遍历**进入 `.git/`** 并返回 `.git/**` 的路径（实测）。
也就是说「能不能看见被忽略的文件」与「模型能不能枚举 `.git` 内部」是同一个开关。
既然后者是本任务明确要排除的形态，前者只能不要 —— 契约的 `GitFileStatus`
因此没有 `ignored`，被忽略的文件在结果里完全不存在，也不进任何计数字段。

### 3.4 比较的是**原始字节**，不套用 Git 的语义（偏离项 42）

```
PASS CRLF 与 LF 之间确实产生差异（原始字节语义） — [{…"lines":["-line-one","-line-two","+line-one\r","+line-two\r"]}]
PASS note 点明了换行转换没有被套用
```

`core.autocrlf` 与 `.gitattributes` 会改变「什么算差异」，而套用它们要先读
`.git/config` —— 那条路径被 `HD-GIT-CONFIG` 硬拒绝，读它需要为「让比较更像
git diff」而开一个口子。**不做**：差异按原始字节算，`note` 里明说这一点，
并说明工作区的 CRLF 与对象库里的 LF 在这里是一处真实差异，而 `git diff`
可能什么都不显示。这不是「不支持的 Git 行为」，是一个**被选定**的语义：
比较的对象是磁盘上的字节与对象库里的字节，两者的 sha256 都如实给出。

同一条原则的另一个面：二进制两侧不产出文本差异。

```
PASS 二进制一侧 → binary=true 且没有 hunk
PASS 说明里给出原因码而不是字节 — …旧侧（HEAD）含 NUL 字节，按二进制处理：不产出文本差异。…
PASS 两侧摘要仍然是原始字节的摘要
```

### 3.5 只在**三处**判「这个路径在不在 `.git` 里」，判法一致

`.git` 在策略层是**搜索排除**（`SE-VCS`），不是硬拒绝 —— 那是 LWB-013 的决定，
本任务不改它。本任务拒绝的是**本工具**接受这种路径，理由有两条：`.git/info/exclude`
这类文件是文本，而 `git_diff` 会把工作区侧内容原样拼进差异里，于是「模型指定一个
路径、工具返回它的内容」会绕过内部窄范围清单；以及 `git_status({path:'.git'})`
今天返回空结果，靠的是库的 `isIgnored()` 里写死了 `basename === '.git'` ——
一条我们无法保证下次升级还在的库内规则。判据要握在自己手里。

```
PASS .git/hooks/pre-commit 被拒绝 — code=ENOENT
PASS .git/config 被拒绝 — code=ENOENT
PASS .git/logs/HEAD 被拒绝 — code=ENOENT
```

逐段判、不只看开头（`sub/.git/HEAD` 也拒），与 `@lwb/policy` 的 `classifyFile`
用的是同一个判法，因此两处对「这是不是 `.git` 内部」的答案一致。

### 3.6 布局降级只降 Git 能力（偏离项 43）

V1 对外置 gitdir、alternates、未支持对象格式与特殊索引一律
`GIT_LAYOUT_UNSUPPORTED`，`reason` 区分具体是哪种，且**普通文件读取仍可用**。
`layout_warning` 在支持但有限制时给出说明（当前实现下为 `null`，
因为所有「有限制」的形态都被判成了不支持）。

---

## 4. 采集过程中发现并修复的真实缺陷

### 4.1 `statusMatrix` 在真实仓库上 100% 失败（`lstat '.'`）

见 §2.1。这是本任务最重要的一次发现：**单元测试用桩时不会出现**（桩不拼
`${dir}/.`），只有在真实仓库上跑才会 —— 而它一旦存在，`git_status` 与 `git_diff`
在任何仓库上都不可用。修复后由 `tests/git/git-reader.test.ts` 的
「库在根节点上拼出来的 `<root>/.` 认作工作区根，而不是 ENOENT」钉住。

### 4.2 助手进程死掉时，调用方被一个管道错误盖住了真正的原因

`native/winfs/src/helper-client.ts`。原来的实现里 `child.stdin` 没有 `'error'`
监听器：助手退出后 `stdin.write()` 触发一个未处理的 Socket `'error'` 事件，
**整个进程**被 `ERR_STREAM_WRITE_AFTER_END` 带走 —— 真正的原因
（「助手为什么不在」）反而看不到了。修法是三件事：

1. `stdin` 上挂 `'error'`（吞掉，它只是症状）；`'exit'` / `'error'` 记录
   **首次**原因，并把当时留在 `stderr` 的尾巴（有界，最后 500 字节）拼进去；
2. 待决调用一次性全部以 `NATIVE_GUARD_UNAVAILABLE` 失败，而不是永远挂着；
3. 已知助手不在时 `call()` **直接返回**，不去写已经结束的管道 ——
   写在已结束的管道上抛的是管道错误，而真正的原因是助手为什么不在，
   那条信息在这里更准确。

这一条落在**生产代码**里而不是测试里：它是真实的失败模式（助手崩溃、被强杀、
PWSH 未安装），而原来的行为是「调用方进程整个消失」。

### 4.3 `policy_hidden_count` 两次算错，两次都是「把不属于这个数字的东西算了进去」

见 §2.2 与 §2.3。第一次把「库只是路过」的范围外路径算进去（5 而不是 4，
且与请求的范围无关），第二次把 `.git/config` 算了进去。两次都不是实现写错，
而是**这个数字的语义没有被写清楚** —— 现在它的定义写在
`packages/contracts/src/git.ts` 的字段注释里：计数只覆盖
「请求范围内、且不是 `.git` 内部」的路径。

### 4.4 证据脚本自己造了一条「装置前提是假的」用例

`diff 硬拒绝路径` 第一次跑出来的是 `装置前提失败：git_diff secrets/aws.env 应被允许` ——
证据脚本的 `decisionFor()` 会断言判定被允许，而被拒绝的路径不适用（`allow:false`
正是要被检验的前提）。修法是把 `rawDecision` 与 `decisionFor` 分开，并给
`gitDiffTool` 加 `expectAllow` 参数。这条与本任务的产品代码无关，但它说明了一件事：
**装置自己抛错会让「工具必须拒绝」这条测试因为错误的原因「通过」**，
同类的坑在 `tests/windows/git-reader.test.ts` 里又踩了一次（`.git/config`
同时是 `HD-GIT-CONFIG` 的硬拒绝路径），两次都用同一个办法修：判定用原始结果，
只断言错误码与 `reason`。

### 4.5 负向验证：几条关键用例确实会失败

只证「测试通过」不能说明测试在测东西。本次对三条最关键的用例做了反向验证
（改坏实现 → 用例必须失败 → 改回）：

| 反向验证 | 改法 | 结果 |
|---|---|---|
| 根节点的 `.` 段 | 让 `toRelative` 把 `'.'` 段判为非法（回到第一版） | `tests/windows/git-reader.test.ts` **7 pass / 4 fail**（前 4 条状态用例全红），观测到的错误是 `INTERNAL_ERROR` 且 `reason: GIT_READ_FAILED`（「读取 Git 状态时失败；未返回任何结果。」）—— 真实仓库上 `git_status` 整个不可用 |
| 只读 fs 的写通道 | 让 `refuseWrite` 只记账、不抛 | `tests/git/git-reader.test.ts` **48 pass / 1 fail**，「12 个写方法全部拒绝…」红（`Missing expected rejection.`）—— 拒绝这件事**有**独立的用例守着，不靠账本那条兜底 |
| `.git/objects` 的形状 | 把清单放宽成 `^\.git\/objects\/.*$` | `tests/git/git-reader.test.ts` **48 pass / 1 fail**，`ab/cdef` 那条反例红 —— 它存在的理由就是让「放宽清单」这个动作**一定有测试红** |

三次都改回原样后重跑全绿（`tests 827 / pass 827`）。第一次验证里那条
「底层原因」要说清楚：`lstat '.'` 这个文本**只在诊断时直接调库**看得到
（`wrapGitFailure` 只把 `library` 的错误并成 `GIT_READ_FAILED`，
不把库的原文回显给调用方），因此它不是测试输出里的字符串 ——
测试输出里的就是上表第二列那一行。

---

## 5. 脱敏

本文件的夹具里所有凭证都是**形状合规的假值**（`ghp_` + 36 位、
`AKIA` + 16 位、PEM 正文、`password = "…"`），不是真实凭证，也不来自任何真实系统。

- 采集脚本**不打印任何凭证值**：输出里只有布尔、计数、长度、规则名
  （`[REDACTED:keyword-secret-value]` 是规则标识，不是值）与假值本身被
  **断言缺席**的那些片段名。
- `PASS 原始值没有跟着出去` 与 `PASS 阻断错误里不含那段凭证、也不含文件名`
  是运行时的实际比对结果：脚本对 `JSON.stringify(结果)` 与错误对象逐个查找
  `ghp_` / `PRIVATE KEY` / `AKIA…` / `hunter2…`，找到任何一个就把该条判为 FAIL
  并把片段打出来 —— 也就是说，**这份日志之所以干净，是因为它在运行时不干净就会自己报警**。
- 临时仓库与降级用的目录都在 `%TEMP%` 下的独立临时目录里，运行结束后删除。
  夹具仓库全程只被读取（整树摘要前后相同）。

---

## 6. 未执行项（不得记为通过）

```
NOT_RUN 真实 ChatGPT Web 端到端 Git 读取验收 — 需要真实账号与 Secure MCP Tunnel 凭据；LWB-002 仍为 BLOCKED
NOT_RUN MCP Inspector 上的 git_status / git_diff 工具面 — 工具面属 LWB-017；本任务交付的是 packages/git-reader/（纯函数入口），没有 MCP 层可挂
NOT_RUN 数万文件级仓库上的状态查询耗时与内存 — 本证据的规模是「一次调用能看多远」；大仓库的吞吐与内存属性能采集，不在本任务的四条验收标准内
NOT_RUN NTFS 之外的卷上的仓库（ReFS / 网络盘 / 云占位文件） — 本机只有 NTFS；护栏的卷形态判定覆盖了拒绝路径，但未在真实 ReFS 上采集
NOT_RUN 真实损坏的 .git（截断的 index / 坏对象头 / 超限 pack） — 已知形态由布局检查覆盖（本任务实测了外置 gitdir 与缺失 .git）；其余属损坏恢复场景，V1 未定义行为
```

这五行由采集脚本自己打印（`scripts/evidence/lwb-016.ts` 的末段），
因此**它们和 PASS 行一样是运行输出的一部分**，不是本文件事后补记的。

第一项是硬门禁：**MCP Inspector 成功不能替代真实网页验收**，因此
「Git 查询能不能真的被 ChatGPT Web 里的模型调用」本环境无法自证。
第二项要说清楚：本任务交付的是 `packages/git-reader/`（纯函数入口），
MCP 工具面在 LWB-017 —— 那一条必须在 LWB-017 里另行取证，不能拿本文件顶替。

---

## 7. 变更文件

| 文件 | 行数 | 内容 |
|---|---|---|
| `packages/git-reader/src/meta-fs.ts` | 891 | 只读虚拟 fs：窄范围清单、`.git` 判定、`toRelative` 归一化、账本、比对读取与预算 |
| `packages/git-reader/src/status.ts` | 392 | `git_status`：起飞前检查 → 探针/预检 → `statusMatrix` → 行后处理与计数 |
| `packages/git-reader/src/diff.ts` | 653 | `git_diff`：三种比较、原始字节语义、二进制判定、出站闸门 |
| `packages/git-reader/src/preflight.ts` | 240 | 两条工具共用的起飞前检查（工作区形态 / `.git` 内部 / 探针 / 布局 / 只读账本断言） |
| `packages/git-reader/src/text-diff.ts` | 215 | 文本差异（自实现，不引入 diff 库；行级 LCS + 上下文） |
| `packages/git-reader/src/layout.ts` | 241 | 布局判定：`.git` 是文件 / 外置 gitdir / alternates / 对象格式 |
| `packages/git-reader/src/limits.ts` | 64 | `GitLimits` 与默认值（可被本地操作者收紧） |
| `packages/git-reader/src/index.ts` | 32 | 导出与包边界说明 |
| `packages/contracts/src/git.ts` | +78 | `git_status` / `git_diff` 契约；`policy_hidden_count` 的语义写进字段注释 |
| `packages/contracts/src/limits.ts` | +40 | `MAX_GIT_*` 限额 |
| `native/winfs/src/helper-client.ts` | +58 | 助手死亡时的失败语义（见 §4.2） |
| `tests/git/git-reader.test.ts` | 436 | 49 例：行解码、窄范围清单、归一化、账本、exclusions、缓存（磁盘用桩） |
| `tests/windows/git-reader.test.ts` | 465 | 11 例（真实 NTFS + 真实护栏 + 真实 `.git` + 夹具仓库） |
| `scripts/evidence/lwb-016.ts` | 777 | 本证据的采集脚本 |

`native/winfs/src/helper-client.ts` 的改动是**任务外的缺陷修复**（§4.2）：
它由本任务采集时的一次真实崩溃暴露，与 Git 无关，但会让任何一次护栏调用
在助手退出后带走整个进程，因此在这里一并修掉并登记。

**没有**引入：HTTP 模块、Git CLI 调用、`child_process`（`check-fsguard-imports.mjs`
的 `BUSINESS_PREFIXES` 覆盖 `packages/git-reader/`，`node:crypto` 之外的
Node 内置一律不可用 —— 98 个文件、未发现绕过）。`isomorphic-git` 的用法
限制在 `statusMatrix` / `currentBranch` / `resolveRef` / `readBlob` 四个入口，
hooks / textconv / external diff 一概不执行。

---

## 8. 回归

```
$ npx tsc --noEmit                                    → 退出码 0
$ node scripts/check-fsguard-imports.mjs              → 98 个文件，未发现绕过
$ node scripts/run-tests.mjs                          → tests 827 / suites 135 / pass 827 / fail 0
$ node scripts/run-tests.mjs tests/windows            → tests 182 / pass 182 / fail 0
$ node --import tsx scripts/evidence/lwb-016.ts       → 118 PASS / 0 FAIL / 5 NOT_RUN，退出码 0
```

测试数对得上：LWB-015 时为 767，本次新增 60（49 + 11），`767 + 60 = 827`。
`tests/windows` 从 171 增至 182（新增的 11 例）。

`lwb-011.ts` 里那条「Git 差异侧调用点待接线」的登记在本任务里**已闭合**（§1 验收 4），
`docs/PROGRESS.md` 的 LWB-011 行已随之更新。
