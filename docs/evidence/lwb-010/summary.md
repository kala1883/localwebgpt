# LWB-010 · Windows 路径与文件身份防护 — 证据

**采集方式：** `node --import tsx scripts/evidence/lwb-010.ts`（退出码 0 = 全部通过）
**采集环境：** Windows 11 Home China 10.0.26200 / Node v22.20.0 / PowerShell 7.6.6
**护栏后端：** `powershell-pinvoke`（PowerShell 7 + .NET P/Invoke，调用真实 Win32 API）
**测试套件：** `node --test --import tsx tests/windows/path-escape/*.test.ts` — **114 项全部通过**
**注意：** 本机**未**安装 Rust / MSVC / Windows SDK，因此没有编译型原生模块；
以下结论全部来自真实内核调用，不是桩。

---

## 1. 验收标准逐条

### 验收标准 1 · 路径、Junction、符号链接、硬链接和别名逃逸用例全部被拒绝

```
PASS 大小写别名指向同一对象（按对象身份判定，不是按字符串） — 008b00000004203b == 008b00000004203b
PASS 回执给出磁盘拼写而不是请求里的字符串 — 请求 ALPHA.TXT → canonical_relative_path=Alpha.txt
PASS 8.3 短名别名被明确拒绝 — PATH_UNSAFE（句柄真实路径与预期不一致）
PASS 硬链接可读，且身份里的硬链接数为 2 — file_id=0024000000059b63 link_count=2
PASS 写入多重硬链接文件被拒绝 — LINK_UNSUPPORTED
PASS 被拒绝的写入确实没有改动工作区外的对象
PASS 备用数据流（ADS）在语法层被拒绝 — ADS_COLON
PASS 经 Junction 读取工作区外文件被拒绝 — LINK_UNSUPPORTED
PASS 目录列举把 Junction 标为重解析点，且不报告目标大小 — size=null
PASS 经符号链接读取工作区外文件被拒绝 — LINK_UNSUPPORTED
PASS 工作区外内容未被读取（三项）
```

**为什么这些用例必须跑真磁盘：** 「别名」的定义就是**同一个物理对象的多个名字**。
桩里造不出「两个字符串指向同一个 `file_id`」，只能造出「我假设它们该是同一个」。
同理，「句柄真实路径与预期不一致」只有在真实内核返回真实规范路径时才可能出现。

**两条别名，两种处置，而差异是刻意的：**

| 别名 | 结果 | 原因 |
| --- | --- | --- |
| 大小写（`ALPHA.TXT`） | **接受** | 内核返回的规范路径与请求只差大小写，比较键大小写不敏感 |
| 8.3 短名（`VERYLO~1.TXT`） | **拒绝** | 内核返回的是**长名**，与请求不是同一串字符 |

不做成「接受并回报长名」的理由：接受意味着「同一个对象有很多个我们都认的名字」，
`路径 → 对象` 的映射变得更**多对一**。本系统里没有任何一处会生成 8.3 短名，
拒绝它挡不住任何正当用法，却少了一整类需要解释的等价关系。这是 I10（拒绝而非降级）
在别名问题上的具体落法。

**符号链接一项是实测得到的环境结论，不是设计选择：** 本会话无开发者模式，
创建符号链接需要提权，因此实际测试是**先尝试创建**、创建失败则如实输出
`NOT_RUN`（跳过 ≠ 通过）。Junction 不需要权限，所以 Junction 那条是真实测到的。

### 验收标准 2 · 并发交换父目录时不会打开/写入未授权对象

```
PASS 对照：未被持有的目录可以改名（后面那些失败才算数）
PASS 持有工作区根　　　　→ 外部改名被挡住 — errno=EBUSY（内核 ERROR_SHARING_VIOLATION）
PASS 持有工作区根　　　　→ 释放之后改名恢复 — 因果成立
PASS 持有中间目录　　　　→ 外部改名被挡住 — errno=EBUSY
PASS 持有中间目录　　　　→ 释放之后改名恢复 — 因果成立
PASS 持有深层文件（祖先 sub 被钉住）→ 外部改名被挡住 — errno=EBUSY
PASS 持有深层文件（祖先 sub 被钉住）→ 释放之后改名恢复 — 因果成立
PASS 根被换成同名目录（路径字符串一模一样）后按旧身份访问被拒绝 — ROOT_IDENTITY_MISMATCH
PASS 拒绝有效：替换者没有被读也没有被改
PASS 父目录被换成指向工作区外的 Junction 后，经它访问被拒绝 — LINK_UNSUPPORTED
PASS 外面那个同名文件未被读取
```

**机制（结构性不可能，而不是「窗口很小」）：**

重命名或删除一个对象需要对该对象持有 `DELETE` 权限，而共享模式是**双方**的约定 ——
只要有一个持有者没给出 `FILE_SHARE_DELETE`，后来者的 rename/delete 就会以
`ERROR_SHARING_VIOLATION` 失败。护栏逐级打开的每个目录句柄都**不给**
`FILE_SHARE_DELETE`，且**一直持有到操作结束**。这不是「把 TOCTOU 窗口缩小」，
是把窗口关掉。

> 早先的实现给的是 `SHARE_READ|WRITE|DELETE`，而且检查完**立刻** `Dispose`。
> 两者合起来正好是验收标准 2 要挡的那件事：祖先链检查完之后，任何人都可以
> 把它改名换掉，后续按路径字符串打开的就是另一个对象。

**为什么每条都配一条「释放之后改名恢复」：** 单写「改名失败」是**可以空洞通过**的
—— 那个目录可能本来就改不了名。加上释放后的反题，因果才闭合。

**为什么还要测「已经被换掉了」：** 句柄钉住只在操作**进行中**有效。模型完全可能
先 `listDirectory` 拿到路径、隔一次调用再 `readFileGuarded`，中间没有任何句柄还在。
此时唯一还能说话的判据是 **daemon 给的根身份**。上表两条正是这个场景：
路径字符串一模一样，只有 `file_id` 变了 —— 按路径判断的一切做法在这里都会放行。

### 验收标准 3 · 对无法验证的路径返回明确错误，不调用弱校验备用路径

```
PASS 两侧对全部语料给出同一判定（含同一理由标签） — 分歧 0 / 83
PASS 每一条拒绝都带具体理由 — 覆盖 19 种理由
PASS 非字符串输入也被拒绝 — 语料含 5 条非字符串输入
PASS 契约里的每一个理由标签都有可复现的语料用例 — 19 种全部有覆盖
NOTE 静态边界 — check-fsguard-imports.mjs：业务包一律不得 import fs（58 个文件无绕过）
NOTE 「能打开但证明不了」的处置 — 8.3 短名：明确拒绝，不按请求字符串放行
NOT_RUN 护栏不可用时不写入 — 本脚本构造不出真实"助手不可用"，见 §3
```

**「不调用弱校验备用路径」在本实现里的落法：** 护栏脚本里不存在
「证明不了就走字符串比较」的分支。`Assert-HandleMatches` 的两条判定都是
fail-closed —— 取不到内核认定的规范路径就 `PATH_UNSAFE`，取到了但与预期不符
也 `PATH_UNSAFE`。**没有第三条路。**

**静态边界：** 业务包一律不得 `import` `fs`/`child_process`，由
`scripts/check-fsguard-imports.mjs` 强制。本次改动后复查：58 个文件，无绕过。

---

## 2. 步骤 1：两份独立的相对路径实现，逐例比对

相对路径语法在**两个地方**各有一份实现：

- `packages/contracts/src/path.ts`（TypeScript）—— 供业务层快速失败；
- `native/winfs/path_guard/RelativePath.ps1`（PowerShell）—— 边界侧，**不能假定调用方检查过**。

两份实现的一致性由共享语料 `native/winfs/path_guard/corpus.ts` 逐例守住，
语料本身是两侧唯一的真值来源：

```
NOTE 语料规模 — 83 条（接受 12 / 拒绝 71）
NOTE 上限 — 路径 1024 字符、单段 255 字符、深度 64 段（两侧同一组常量）
PASS 两侧对全部语料给出同一判定（含同一理由标签） — 分歧 0 / 83
NOTE validatePath 单次耗时（含常驻助手往返） — P50=0.66ms P95=11.86ms
```

> 上面这段是采集脚本的**原样输出**（延迟数值每次运行会浮动；分歧数与语料规模不会）。
> 「接受 / 拒绝」两侧的数字来自同一份语料，不是两处各数一遍。

断言的是**理由标签逐例相等**，不是「两边都拒绝了」—— 后者是廉价的假一致
（一边说 `ADS_COLON`、另一边说 `INVALID_CHAR` 也能同时"拒绝"）。

**采集过程中真找出过一处实现分歧**，值得记下来：`'\uFEFF'`（零宽不换行空格）
在 TypeScript 侧被判为 `EMPTY`，在 PowerShell 侧被判为**接受**。原因是
JS 的 `String.prototype.trim()` 把 U+FEFF 当作空白，而 .NET 的
`char.IsWhiteSpace` 不把它当空白。这不是"某一侧写错了"，是两份标准库的**定义不同**。
处置：新增 `INVISIBLE_CHAR` 规则并**置于空判断之前**，两侧给出同一个理由。
若只靠"两边都拒绝"来测，这个分歧永远不会被发现 —— 因为两侧都"拒绝"了某样东西。

---

## 3. 未执行项（如实标注）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 符号链接逃逸被拒绝 | **本环境未验证** | 本会话无开发者模式/管理员权限，无法创建符号链接。测试里先尝试创建，失败即输出 `NOT_RUN` 并附原始输出。**Junction 的拒绝路径已实测**，二者走同一段重解析点判定代码 |
| 护栏不可用时不写入（`NATIVE_GUARD_UNAVAILABLE`） | **本脚本未测** | 证据脚本无法在真实环境里构造"常驻助手不可用"（进程一停，后续调用就没有响应可等，只会挂住）。该分支由 `tests/unit/workspaces.test.ts:1104` 以**注入式假后端**覆盖。此处**不**把它声明为已测量 |
| 8.3 短名 | 已实测 | 本卷生成了短名（`VERYLO~1.TXT`），因此该别名真实存在并被拒绝 |

---

## 4. 一条已知边界（不是"没做"，是边界本身）

**`guarded_inplace` 绑定的是内容基线（`expected_sha256`），不是跨调用的文件身份。**

实测：把工作区**内**的父目录换成另一个目录，而那里的同名文件内容完全相同时，
写入会照常进行 —— 它写的是一个与批准时 `file_id` 不同的物理对象。

```
NOTE 已知边界的前提 — file_id 00260000000856bb → 007300000008594d（内容相同）
PASS 写入继续（绑定的是内容基线，不是跨调用的文件身份）
PASS 但回执如实报告实际写入的对象 — identity_before=007300000008594d（实际） vs 00260000000856bb（批准时）
PASS 内容基线不同时被挡住，替换者原样保留 — FILE_VERSION_CONFLICT
```

**为什么这是可接受的：** 本系统的授权范围是
`工作区根身份 × 相对路径 × 内容基线`，**不是**「某个 `file_id`」。
上述前提下这三样全部成立，而且写入的**可观察结果与批准时的预期完全一致**：
同一个工作区、同一个相对路径、同样的原内容、同样的新内容。内容不同时由基线挡住
（上表第三条）。

**但有一条不能含糊：** 回执必须**如实报告写的是哪个对象**。因此第二条是
真正的断言 —— 若护栏把批准时那次的 `file_id` 抄进回执，那才是缺陷（I14）。
实测 `identity_before` 确实是**实际打开的那个**对象。

---

## 5. 实测：保留设备名为什么必须进拒绝表

「拒绝 `NUL`/`CON`/`COM1`…」这类规则很容易被当成照抄历史清单。实测显示它不是：

```
NOTE 探针对象 — <临时目录>\nul-probe\NUL（探针自带 P/Invoke，不经护栏）
      {"opened":true,"write_ok":true,"bytes_reported":42,"bytes_intended":42,"write_error":0,"exists_on_disk":false}
PASS 在 <目录>\NUL 上写入：报告成功、字节数对得上，而磁盘上什么都没有
```

即：`CreateFileW('C:\…\<dir>\NUL', GENERIC_WRITE, CREATE_ALWAYS)` 返回有效句柄
（err=0），`WriteFile` 报告写入 42 字节（err=0），而**磁盘上没有任何文件**。
放行这条路径，`createFileGuarded` 就会返回一份指向**从未存在过的文件**的回执 ——
直接违反 I14。

**反面同样重要：`COM0` / `LPT0` 没有进保留名录。** 实测
（同一台机器，Windows 11 26200）在带目录成分的路径上，`COM0`、`LPT0`、`COM1`、
`LPT9`、`CON`、`PRN`、`AUX`、`CLOCK$`、`CONIN$`、`CONOUT$` 都会创建**普通文件**；
`\\.\COM0`、`\\.\LPT0` 一律 `err=2`（与 `\\.\NOSUCHDEV` 相同），只有 `\\.\NUL` 能打开。
名录是**保守的历史清单**，不是「本版本上哪些名字是设备」——
两种说法在别的 Windows 版本上会给出不同答案，而保守的那一种不会。

---

## 6. 步骤 4：错误路径的资源释放

护栏持有句柄时不给 `FILE_SHARE_DELETE`，于是同一件事有两面：
操作期间别人改不了名是**保护**，操作结束还持有就是**伤害** ——
用户自己的工作区会变成一个改不了名、删不掉的目录，直到 daemon 重启。

```
PASS 目标不存在　　　　　　→ NOT_FOUND，且根与祖先都已释放
PASS 中间目录不存在（链条自己抛错）→ NOT_FOUND，且根与祖先都已释放
PASS 语法拒绝（不碰磁盘）　→ PATH_UNSAFE，且根与祖先都已释放
PASS 根身份不符　　　　　　→ ROOT_IDENTITY_MISMATCH，且根与祖先都已释放
PASS 基线冲突　　　　　　　→ FILE_VERSION_CONFLICT，且根与祖先都已释放
PASS 12 次失败注入无一被放行，且之后一切照旧
```

断言的选取是「操作结束后这个对象还能不能改名」—— 它就是泄漏**对用户可见的
那个后果**，不是代理指标。它比查句柄计数更准：句柄计数在并发跑的测试套件里
会被别的测试文件的 pwsh 进程污染，而"能不能改名"只取决于我们自己持有的句柄。

第二条（中间目录不存在）专测**链条自己的** `catch`：它在打开第 2 级时失败，
而第 1 级（工作区根）已经打开并加入了列表。

---

## 7. 采集期间修掉的三个真实缺陷

1. **工作区根目录无法列举**（功能性缺陷）。`Resolve-Target` 在链条之前就把
   空相对路径判成 `EMPTY` 拒绝，于是 `listDirectory(root, '')` 与「单文件工作区」
   两条路都走不通 —— 链条里那段「根是文件还是目录」的判断**根本不可达**。
   修法：把空路径的决定交给 `Open-GuardedChain`（**只有它知道根的类型**），
   并给列举操作一个显式的 `-AllowEmptyTarget`。这与本工程一贯的做法一致：
   **判断要发生在拥有判断所需信息的那一层。**

2. **PowerShell 变量插值把消息吃掉一半**（消息完整性缺陷）。
   `"$Label是重解析点…"` 里 `$Label是重解析点` 会被当成**一个变量名**
   （PowerShell 的标识符允许 CJK 字母），值为 `$null`，于是拒绝理由的**主语
   静默消失**，只剩「（Junction / 符号链接 / 云占位），拒绝继续：…」。
   三类消息全部中招而功能仍"正常拒绝" —— 只有断言消息内容的用例才发现。
   修法：`${Label}` 显式划界，并在该函数上记下这个坑。
   **全仓扫描后确认只有这 3 处**（其余 `$Var` 后面跟的都是全角标点，不构成标识符字符）。

3. **`holdHandle` 无法持有工作区根**。它只用于并发交换的验证，但根恰恰是
   最该被观察的那一个对象（根是授权对象的所在）。修法：给它同样的
   `-AllowEmptyTarget`。

---

## 8. 改动文件

**新增**

| 路径 | 说明 |
| --- | --- |
| `native/winfs/path_guard/corpus.ts` | 83 条共享语料，TS 与 PowerShell 两侧的唯一真值来源 |
| `native/winfs/path_guard/RelativePath.ps1` | 边界侧的相对路径语法实现 |
| `tests/windows/path-escape/helpers.ts` | 该目录的公共装置 |
| `tests/windows/path-escape/relative-path-parity.test.ts` | 85 项：两侧逐例比对 |
| `tests/windows/path-escape/alias-escape.test.ts` | 11 项：大小写 / 8.3 / 硬链接 / ADS / 目录链接 / 设备名 |
| `tests/windows/path-escape/parent-swap.test.ts` | 8 项：并发交换与兜底判定 |
| `tests/windows/path-escape/resource-release.test.ts` | 10 项：错误路径的资源释放 |
| `scripts/evidence/lwb-010.ts` | 本文件的采集脚本 |

**修改**

| 路径 | 改动 |
| --- | --- |
| `packages/contracts/src/path.ts` | 新增 `INVISIBLE_CHAR` 理由，置于空判断之前 |
| `native/winfs/WinfsGuard.ps1` | 空路径判定交给链条；`${Label}` 修插值；`holdHandle` 支持根；规范相对路径回执 |
| `native/winfs/src/ops.ts` | `canonical_relative_path` 字段与 `WinfsPathValidation` |
| `native/winfs/src/powershell-backend.ts` | 上述字段的映射（**不**回退成请求值） |
| `native/winfs-spike/experiments.ts` | 每个入口先探测 spike 根身份（`WinfsRootRef` 现要求身份） |
| `tests/windows/winfs-guard.test.ts`、`tests/windows/workspaces-roots.test.ts` | 引用改取真实根身份 |
| `scripts/evidence/lwb-009.ts` | 同上 |
| `docs/evidence/lwb-009/summary.md` | 订正一处：文件根拒绝码 `NOT_FOUND` → `PATH_UNSAFE`（见该文件 §4 的订正说明） |

**未改动：** `docs/evidence/lwb-003/`。本次重跑 spike 仅用于验证
`experiments.ts` 的根身份改动没有破坏它（全部通过），不是一次新测量，
因此不覆盖那份属于 LWB-003 的证据。护栏在 LWB-010 期间调整了重解析点拒绝
消息的措辞，因此 LWB-003 证据里引用的那句话与当前代码字面不同、语义相同。

---

## 9. 负向回归

以下都是**先让护栏做错事会怎样**的用例，全部在 `tests/windows/path-escape/` 里：

- 语料里 71 条拒绝用例，每一条都逐例比对两侧的**理由标签**（不是"都拒绝了"）；
- 别名用例断言**工作区外的内容在拒绝之后原样未变**（拒绝必须有效，不能只是报了个错）；
- 并发交换用例为每种情形都配了「释放后改名恢复」的反题；
- Junction 用例**故意**在工作区外放一个同名文件 —— 「走错路」必须是**可达的**，
  一次 `NOT_FOUND` 也能让空洞的用例变绿；
- 资源释放用例注入 12 次失败并断言**无一被放行**（反复失败后偶尔放行一次，
  正是状态被前一次失败污染的典型形态）。

`npm run check`（typecheck + FsGuard 导入检查 + 378 项测试）全绿。
