# LWB-009 · 工作区登记、根身份校验与代次 — 证据

**实现提交：** `65b570a`
**任务状态：** DONE（三条验收标准均有实测支撑；四项本机无法构造的场景如实标记 NOT_RUN，见 §6）
**原始输出：** `docs/evidence/lwb-009/run.log`（`scripts/evidence/lwb-009.ts` 的完整 stdout，未编辑）

---

## 1. 环境

| 项 | 值 |
| --- | --- |
| 平台 | Windows 11 Home China 10.0.26200（`win32 x64`） |
| Node | v22.20.0 |
| PowerShell | 7.6.6（`pwsh`），.NET 10.0.12 |
| 护栏后端 | `powershell-pinvoke`（`available=true`） |
| 权限 | **非管理员**（与 LWB-007/008 一致，未使用任何提权操作） |
| 仓库分支 | `feat/lwb-p0-p2` |

---

## 2. 改动文件

| 文件 | 作用 |
| --- | --- |
| `packages/workspaces/package.json` | `@lwb/workspaces`，依赖 `@lwb/contracts`、`@lwb/persistence`、`@lwb/winfs` |
| `packages/workspaces/src/root-path.ts` | 候选根路径的语法校验（纯函数，不碰磁盘） |
| `packages/workspaces/src/screen.ts` | 筛查规则：盘符根、过宽目录、受保护存储、网络盘、云占位、非 NTFS、重叠根、物理别名 |
| `packages/workspaces/src/environment.ts` | **唯一**读环境变量之处；受保护对象身份的探测入口 |
| `packages/workspaces/src/registry.ts` | `WorkspaceRegistry`：登记、取用授权、核查身份、重新验证、移除 |
| `packages/workspaces/src/rejections.ts` | `RootRejectedError` 与拒绝理由枚举 |
| `apps/daemon/src/control/workspaces.ts` | 控制面入口，挂在 `workspaces.manage` 能力下（该能力不授予模型） |
| `native/winfs/src/ops.ts` | 新增 `WinfsVolumeInfo` 与 `WinfsOps.statVolume` |
| `native/winfs/src/powershell-backend.ts` | `statVolume` 的护栏实现（只搬运事实，不做策略判断） |
| `native/winfs/WinfsGuard.ps1` | `Op-StatVolume`：`GetVolumeInformationByHandleW` + `GetDriveTypeW` + 重解析点/云端标志 |
| `native/winfs/src/error-codes.ts` | 新增 `VOLUME_UNSUPPORTED`（不可重试） |
| `packages/persistence/src/migrations.ts` | 迁移 v2：`workspaces` 表重建；`requires_foreign_keys_off` 字段 |
| `packages/persistence/src/database.ts` | 迁移运行器：事务外开关外键 + 事务内 `foreign_key_check` 复验 |
| `packages/persistence/src/repositories.ts` | `WorkspacesRepo`：`findByIdentity`/`requireUsableById`/`markRemoved`/`bumpGeneration`/`relocate` |
| `scripts/check-fsguard-imports.mjs` | 补写规则 1 的真实条件（§5 第 1 条） |
| `tests/unit/workspaces.test.ts` | 63 条（全部为纯函数与桩注入，与机器环境无关） |
| `tests/unit/persistence.test.ts` | +2 条（v1→v2 迁移的数据存活与外键复验） |
| `tests/windows/workspaces-roots.test.ts` | 4 条，**真实磁盘 + 真实护栏** |
| `scripts/evidence/lwb-009.ts` | 本文件证据的可复现采集脚本 |

### 2.1 与任务书的偏差

任务书写交付物为 `apps/daemon/control/workspaces.ts`。实际放在
**`apps/daemon/src/control/workspaces.ts`**，与 LWB-008 的理由相同：
`scripts/check-fsguard-imports.mjs` 的 `BUSINESS_PREFIXES` 预先登记的是
`apps/daemon/src/control/`，且根 `tsconfig.json` 的 include 与 `package.json`
的 daemon 脚本均指向 `apps/daemon/src/`。以脚手架为准，不修改脚手架。

---

## 3. 执行命令与结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npx tsc --noEmit` | 0 | 无输出 |
| `node scripts/check-fsguard-imports.mjs` | 0 | 已检查 **57** 个文件，未发现绕过 |
| `node scripts/run-tests.mjs` | 0 | `# tests 264 # suites 43 # pass 264 # fail 0 # skipped 0` |
| `node --import tsx scripts/evidence/lwb-009.ts` | 0 | 全部观测项通过（全文见 §4 与 `run.log`） |

**测试计数变化：** 195 → **264**（+69）。

| 文件 | 新增 | 说明 |
| --- | --- | --- |
| `tests/unit/workspaces.test.ts` | 63 | 语法、筛查、重叠与别名、登记、代次、三条验收的桩级确认、控制操作 |
| `tests/windows/workspaces-roots.test.ts` | 4 | 真实 NTFS + 真实护栏 |
| `tests/unit/persistence.test.ts` | 2 | 迁移 v1→v2 |

`# skipped 0`：所有用例**实际执行**，包括 4 条需要真实磁盘句柄的 Windows 用例。
文件数 50 → 57 是新增的 7 个包内源文件；FsGuard 只收集 `packages`/`apps`/`native`，
不含 `tests/`，因此测试文件的增加不改变该计数。

---

## 4. 验收标准逐条

### 验收标准 1 · 单文件授权不会顺带暴露其整个父目录

```
NOTE 父目录 file_id — 0049000000086a46
NOTE 被授权文件 file_id — 0044000000086a4e
PASS 根身份是被授权文件自己的（不是父目录的）
PASS 根路径就是该文件 — …\lwb-evidence-009-k4ZdOV\single\only.txt
PASS 登记记录中没有任何字段等于父目录路径
PASS 授权快照的根是该文件
PASS 对照：目标经**目录根**可读 — 读到内容
PASS 判定：同一目标经**文件根**不可读 — 拒绝码 PATH_UNSAFE
PASS 父目录是**另一次**授权：与在册可写文件工作区重叠而被拒绝 — WRITABLE_ROOT_OVERLAP
PASS 同目录另一个文件是独立授权（身份不同）
PASS 两条授权互不涵盖：移除其一，另一条照常可用
```

**机制（结构性不可能，而不是「记得检查」）：** 单文件授权把**根**设为该文件
本身，`kind='file'`，根身份取自该文件句柄的 `file_id`。文件没有子项，因此
「文件根 + 相对路径」在结构上无法指到父目录里的任何东西。

另一条可选设计是「根 = 父目录 + 一张作用域表」，那样连表都不用重建。**没有采用**，
因为它要求**每一次**路径解析都记得去查作用域表 —— 忘掉一次就把整个父目录暴露了。
本工程在别处一律选「结构性不可能」，此处同理，代价是 §5 的那条表重建迁移。

**关于「对照 + 判定」这一对：** 单写一条 `viaFile.ok === false` 是**可以空洞通过**的
—— 目标文件若根本不存在，它也会是 `false`。因此同一目标先用**目录根**读一次，
确认它确实存在且读得到（`ok === true`），再用**文件根**读同一目标（`ok === false`）。
两条合起来才能说明「挡住它的是根的种类」。实测拒绝码是护栏给出的
`PATH_UNSAFE`：链在**打开任何东西之前**就看出「根是一个文件，而相对路径非空」，
于是直接拒绝，理由明说根是文件。

> 订正（LWB-010 期间）：本行原先记录为 `NOT_FOUND`（当时的行为是让内核去打开
> `…\only.txt\sibling.txt` 然后失败）。LWB-010 把「空相对路径 + 目录根」的判定
> 移进了逐级打开的链条 —— 因为**只有链条知道根是文件还是目录** —— 顺带让
> 文件根这一支变成了先判后开。结论（同一目标经文件根不可读）不变，
> 拒绝码与「是否碰过磁盘」变了：现在是零磁盘访问。

**父目录不是「被顺带授权」而是「另一次可以成立的授权」：** 实测登记父目录会被
`WRITABLE_ROOT_OVERLAP` 拒绝（与在册可写文件工作区重叠）。同目录下的另一个文件
则是**独立的物理对象**，可以单独登记，两条授权互不涵盖。

### 验收标准 2 · 同名路径被替换为另一目录后原授权失效

```
PASS 登记后身份未变 — unchanged
NOTE 原 file_id — 0042000000086a66
NOTE 替换后 file_id — 003a000000086a73
PASS NTFS 在同名路径上给出不同的文件身份
PASS 核查报告身份已变 — identity_changed
PASS 访问被拒绝 — WORKSPACE_GENERATION_CHANGED
PASS 拒绝原因标明是「根被替换」而不是「票据过期」 — root_replaced
PASS 拒绝访问**没有**顺手把登记改写成新对象（否则等于自动重新授权）
PASS 重新验证报告已重定位 — relocated
NOTE 重新验证后代次 — 1 → 2
PASS 重新验证递增代次
PASS 重新授权后当前代次可用
PASS 重新授权前签发的旧代次仍然不可用 — WORKSPACE_GENERATION_CHANGED
```

**机制：** 身份判定用**句柄上的** `volume_id + file_id`，不用路径字符串（I03）。
实测把原目录改名让开、在同一路径上新建一个目录 —— 路径字符串一模一样，
`file_id` 从 `0042000000086a66` 变为 `003a000000086a73`，授权随之失效。

**最重要的一条是「拒绝访问没有改写登记」：** 若实现成「探测到身份变了就顺手更新登记」，
那么任何能在同名路径上放一个目录的人就自动获得了授权 —— 这等于把工作区授权
变成「谁先创建路径谁说了算」。因此重新授权必须是本地操作者**显式**的
`reverify`，它才会改写登记并递增代次。旧的代次在重新授权后**仍然**不可用，
即重新授权不作废已发出的旧票据之外的任何东西，但也不复活它们。

**根消失与根被替换被区分对待**（`tests/windows/workspaces-roots.test.ts` 第 4 条）：
根不存在时 `verifyRootIdentity` 报 `missing`，拒绝访问的原因标记为 `root_missing`，
且**代次不动** —— 否则一次临时脱机（外接盘拔掉、网络断开）就会作废全部在途修改集。
把目录恢复回去后 `reverify` 报 `relocated`，因为它**是**另一个对象。

### 验收标准 3 · 移除工作区后旧修改集、读取票据和游标不能继续使用

```
PASS 在途修改集绑定签发时的代次 — 1
NOTE 移除后代次 — 1 → 2
PASS 移除递增代次
PASS 移除后不再启用
PASS 旧修改集的代次绑定已被打断
PASS 旧读取票据/游标（携带旧代次）被拒绝 — WORKSPACE_NOT_GRANTED
PASS 即使代次碰巧相同，已移除的工作区仍然不可用 — WORKSPACE_NOT_GRANTED
PASS 历史行仍在（审计可追溯）
PASS 默认列表不再包含已移除的工作区
```

**机制（两道锁，不是一道）：**

1. **代次锁。** 移除递增 `generation`，在途修改集绑定的是签发时的代次，
   因此绑定关系被打断。
2. **状态锁。** `requireUsableById` 额外查 `removed_at IS NULL AND enabled = 1`，
   因此**即使代次碰巧相同**也拒绝。实测这一条单独验证过（`sameGenTicket`）——
   只靠代次锁的话，「移除后又用同一个代次重新授权」就能让旧票据复活。

**移除是软移除，不是 `DELETE`：** `changesets.workspace_id` 是 `ON DELETE RESTRICT`，
而终态修改集被触发器钉住不得删除 —— 历史操作记录必须继续指向一个真实存在的行。
实测断言了「历史行仍在」与「默认列表不再包含它」同时成立。

**`WORKSPACE_NOT_GRANTED` 而不是 `NOT_FOUND`：** 已移除/已停用的工作区是**策略拒绝**，
不是「这个东西不存在」。用 `NOT_FOUND` 会让调用方（尤其是模型侧）以为是自己
写错了路径而反复重试，而真实原因是操作者撤销了授权。

### 4.1 步骤 2 的拒绝面（真实路径）

```
PASS 盘符根被拒绝（C:\） — DRIVE_ROOT
PASS 过宽用户目录（真实主目录）被拒绝 — BROAD_DIRECTORY
PASS 模型侧发起的登记被拒绝 — ORIGIN_NOT_LOCAL
```

第三项刻意用一条**本身完全合法**的路径（`<临时目录>\removable`）配合
`origin: 'model_surface'`。若来源检查被绕过，后面的形态检查不会替它兜住，
失败信息就会准确指向被绕过的那一条规则，而不是被另一条规则的拒绝掩盖过去。

### 4.2 实测：`statVolume` 单次耗时

```
NOTE statVolume — P50 1.14ms，P95 59.20ms（n=20）
PASS 单次根身份探测足够便宜，可以每次取用都做 — P95 59.20ms < 500ms
```

**这条数据是登记表「每次取用都重新探测根身份、不缓存」这个决定的依据。**
缓存方案会引入一个陈旧的「根还是原来那个」的判定窗口，而窗口内发生的替换
正是验收标准 2 要挡的事情。实测 P50 约 1.1ms（一次 `CreateFile` + 两次卷信息
查询的固有开销），可以承受每次访问都做一次。

**P95 与 P50 差约 50 倍，这个离群必须如实说明：** 20 次里最慢的几次是
`pwsh` 进程冷启动/被抢占造成的，不是文件系统调用的固有成本。因此这条数据的
正确读法是「**稳态**约 1ms，冷启动可到几十 ms」。若将来把护栏换成进程内原生模块，
P95 会随之消失；在过渡方案下，它的代价落在「一次工具调用的首帧延迟」上，
而不在工作区访问的正确性上。

---

## 5. 缺陷与修正（负向回归）

以下两处是**实现过程中发现并修正**的真实问题。它们的共同特征是
「**输出看起来是绿的，但结论不成立**」，因此记在这里而不是只留在提交信息里。

| # | 问题 | 后果 | 修正 |
| --- | --- | --- | --- |
| 1 | `check-fsguard-imports.mjs` 规则 1 的条件是 `isBusiness(relative) && !isAllowed(relative)`，即**两个列表都不在**的包被静默跳过 | 新增一个包时若忘了登记，它既「不被允许」也「不被检查」，而检查器照常打印「未发现绕过」。本次新增 `packages/workspaces/` 正落在这个盲区里 | 在 `ALLOWED_PREFIXES` 上方写明真实条件；并用**反向探针**证实覆盖有效（见下） |
| 2 | 证据脚本第一版把受保护存储根设在 `os.tmpdir()` 下（即用户目录内） | 「用户主目录」候选根同时命中 `PROTECTED_STORE` 与 `BROAD_DIRECTORY`，而 `assessBroadDirectory` 命中第一条即返回 —— 输出里只看到 `PROTECTED_STORE`，`BROAD_DIRECTORY` 这条规则**从未被真正验证**，但整段看起来是「通过」 | 把 `store_root` 移出用户目录（放到盘根下），并让整段在**新的空登记表**上运行 —— 旧登记表里已有的工作区会先触发 `WRITABLE_ROOT_OVERLAP`，把要验证的规则盖过去 |

**第 1 条的处置值得单独说明，因为「看代码想一遍」在这里不够用。**
加进 `BUSINESS_PREFIXES` 看似是在收紧，实际毫无作用 —— 因为
`isBusiness && !isAllowed` 这个条件本身把「被允许」的包排除在外，而在
`ALLOWED_PREFIXES` 里的条目同样不被检查。两类条目在**结果**上无法区分，
这正是该盲区的危险之处。因此没有停留在推理上，而是种了一个**故意违规**的探针：

```
packages/workspaces/src/__fsguard_probe.ts  →  import 'node:fs'
```

检查器报出 `{"rule":"FSGUARD_BYPASS","file":"packages/workspaces/src/__fsguard_probe.ts", …}` ——
证明新包确实在检查范围内。探针文件随后删除并确认已不存在，检查器回到 57 个文件、无违规。

**残留的 `assessBroadDirectory` 顺序事实：** 它按顺序逐条判定、命中第一条即返回，
因此一个同时命中多条规则的候选根只会报出**第一条**。这不是缺陷（都是拒绝，
方向是 fail-closed），但它会让「某条规则到底有没有生效」在证据里看不出来。
`scripts/evidence/lwb-009.ts:72-80` 记录了这一点与其处置办法，以免回退。

---

## 6. 已知限制与未执行项

| # | 项 | 说明 |
| --- | --- | --- |
| 1 | **重叠检测以规范化路径字符串为主，身份相等为辅** | 一个**改了名**的祖先目录若拼写不同，只有在祖先逐级身份比对能走到它时才被发现。完整的基于句柄的祖先证明属 **LWB-010**（逐级重解析点判定）。因此当前的拒绝面在「同一路径的不同拼写」上是可靠的，在「换了路径的同一个对象」上依赖身份索引 `(volume_id, root_file_id) WHERE removed_at IS NULL`，不覆盖祖孙关系 |
| 2 | 云占位文件的识别依赖 `FILE_FLAG_OPEN_REPARSE_POINT` | 打开时**不跟随**重解析点，因此不会把云端文件实体化到本地（那会是一次不受控的下载）。代价是同时报告了 `is_reparse` 与 `is_cloud_placeholder` 两个字段：前者对普通符号链接/Junction 也为真，判定云占位的依据是后者 |
| 3 | `drive_type = 'unknown'` 不等于「非网络盘」 | UNC 与非盘符根（如 `\\?\Volume{…}`）经 `GetDriveTypeW` 都返回 `unknown`。筛查**不**把 `unknown` 当作「一定不是网络盘」，而是逐条按更保守的规则判定 |
| 4 | 移除后别名与根路径**可以**被重新使用 | 三个唯一索引都是 `WHERE removed_at IS NULL` 的部分索引。这是**有意**的：否则移除过的别名与目录会被永久占用，本地操作者再也无法重新登记，一个纯粹由索引造成的死锁。代价是「同一个别名在不同时间可能指两个不同的对象」，因此别名不能作为身份 |
| 5 | 迁移 v2 是表重建 | SQLite 改不了 CHECK 约束。`PRAGMA foreign_keys` 在事务内是**静默无效**的，所以运行器必须在事务外关闭它，并在事务**内**以 `foreign_key_check` 复验后才能提交 —— 放到事务外复验的话，抛错时迁移已经提交，就成了「报了错但库已经坏了」 |

**未执行项（NOT_RUN）：**

| 项 | 原因 |
| --- | --- |
| 网络盘（`DRIVE_REMOTE`）被拒绝 | 本机没有映射网络驱动器，无法构造真实 `DRIVE_REMOTE`。该分支**仅在单元测试中以注入事实覆盖**，没有真实磁盘证据 |
| 云占位文件被拒绝 | 本机没有 OneDrive 一类的云端同步占位文件可供创建。同上，仅桩级覆盖 |
| 非 NTFS 卷被拒绝 | 本机全部为固定 NTFS 卷，无法构造 exFAT/ReFS 候选根。同上，仅桩级覆盖 |
| 祖先级 Junction 被拒绝 | 构造祖先级 Junction 需要开发者模式或管理员权限，本次会话无此权限。逐级重解析点判定由 **LWB-010** 的测试覆盖 |
| 真实 ChatGPT 网页经隧道调用 | 属 LWB-002，无账号与隧道凭证，保持 **BLOCKED**。MCP Inspector 成功不能替代 |

上述四项由 `scripts/evidence/lwb-009.ts` 以 `NOT_RUN` 行**显式打印**（见 `run.log`），
而不是从输出里省略 —— 「没看到失败」与「没跑过」必须能区分。

---

## 7. 回退

本任务**未**开启任何能力开关：`docs/adr/003-protocol-and-trust.md` §5.1 的五个开关
（含 `direct_write_enabled`）保持默认关闭。因此回退方式是：

1. 回退提交 `65b570a`（或移除 `packages/workspaces/`、`apps/daemon/src/control/`）；
2. **数据库迁移 v2 的撤销不是回退代码就能完成的** —— 已升级的库 schema_version = 2，
   而 `KNOWN_SCHEMA_VERSION` 由 `MIGRATIONS` 末项决定，回退代码后既有库会被
   「高于本程序理解的版本」拒绝打开（fail-closed，方向正确，但**不是**静默可用）。
   若确需回到 v1，须显式导出数据、以 v1 建库、再导入；
3. **无用户文件被写入** —— LWB-009 的全部操作都是登记与探测，实测中的文件读写
   只发生在测试临时目录（`C:\Users\mj\AppData\Local\Temp\lwb-evidence-009-*`，脚本退出前已删除）。

**不得**通过覆盖用户文件实现代码回滚（与 `docs/adr/001-scope.md` §3.1 一致）。
未决恢复数据：无。
