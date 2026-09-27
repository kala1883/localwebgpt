# LWB-006 证据：SQLite 模型与迁移

- 日期：2026-09-25
- 环境：Windows 11 Home China 26200 / Node v22.20.0 / npm 10.9.3 / tsx 4.23.15 / better-sqlite3 13.0.3
- 实现提交：`7d08f69`（feat(LWB-006): SQLite 状态模型、迁移机制与仓储层）
- 可复现命令：`npm run typecheck && npm run check:imports && npm run test`

> 本文件只记录**实际执行过**的结果。未执行的项在最后一节显式列出，不写成通过。

---

## 1. 交付物与改动文件

| 文件 | 作用 |
| --- | --- |
| `packages/persistence/package.json` | 包声明（依赖 `@lwb/contracts`、`better-sqlite3`） |
| `packages/persistence/src/migrations.ts` | 13 张表、13 个唯一索引、4 个普通索引、10 个触发器；方案 §7/§7.1/§7.2 的数据模型 |
| `packages/persistence/src/database.ts` | 打开、PRAGMA 实测核对、迁移执行、立即事务 |
| `packages/persistence/src/repositories.ts` | 10 个仓储，所有 SQL 封在此文件内 |
| `packages/persistence/src/index.ts` | 导出面 |
| `tests/unit/persistence.test.ts` | 42 条用例（单文件实跑计数，非估算） |

**与任务书的偏离（必须显式说明）**：任务书写交付物为 `packages/persistence/migrations/`。
本实现把迁移放在 `packages/persistence/src/migrations.ts`（代码内常量）**而不是**外部 `.sql` 目录。
理由：本工程没有构建步骤，运行时直接执行 TS 源文件；迁移若放在外部目录，
打包或部署时漏带不会导致启动失败，**而会创建一个空库继续服务** —— 这正是本任务第 2 条验收标准禁止的后果。
放在代码内，漏带迁移在语法上不可能发生。代价是迁移文本与代码同仓同语言，需要靠测试守护其不可变性（已实现，见 §3.4）。

---

## 2. 三个验收标准

### 2.1 重复执行不能插入第二条同一修改集的应用操作 ✅

三层防护，逐层实测：

1. **模式层**：`CREATE UNIQUE INDEX operations_change_uq ON operations(change_id)`。
2. **仓储层**：`OperationsRepo.create()` 捕获唯一冲突后返回 `{ kind: 'exists', operation }`，
   而不是抛错、更不是新建第二条。
3. **行为层**：用例「换了幂等键也只会得到同一个操作，不会产生第二个」——
   用 `key-A` 建 `op_1`，再用 `key-B` 建 `op_2`，断言返回的是 `op_1`，且
   `SELECT COUNT(*) FROM operations WHERE change_id = ?` 等于 1。

补充：`operations` 上有 `BEFORE DELETE` 触发器，操作记录不可删除——否则删掉再建即可绕过唯一约束。

### 2.2 迁移失败不会默默创建一个空库继续服务 ✅

`openDatabase()` 在**任何**失败路径上都抛出 `BridgeError(STORAGE_UNAVAILABLE)` 且**不返回连接**，实测覆盖 5 种失败：

| 场景 | 用例 | 结果 |
| --- | --- | --- |
| 有表但无迁移记录（外来库） | 「既有表却缺少迁移记录：拒绝打开，而不是当成空库」 | 抛 `STORAGE_UNAVAILABLE` |
| 已应用迁移的文本被改动 | 「已应用迁移的文本被改动（校验和不符）：拒绝打开」 | 抛错，details 里同时给出记录值与重算值 |
| 库的模式版本高于本程序 | 「模式版本高于本程序：拒绝打开」 | 抛错，details 含 `found_version: 99` |
| 迁移 SQL 中途失败 | 「迁移中途失败：整体回滚，不留下半截模式」 | 抛错，且**回滚后残留表集合仍为 `['connections','schema_migrations']`、迁移版本记录为 0 条** |
| 无法进入 WAL / `synchronous` 未达 FULL / `busy_timeout` 未生效 | `configurePragmas()` 的三处实测断言 | 抛错（见 §3.3） |

### 2.3 数据库事务不被误认为能原子提交外部文件 ✅（用**反向**用例证明）

用例「回滚 SQLite 事务不会撤销已经落盘的文件改动」：

1. 在工作区文件写入「原始内容」；
2. 开一个 `BEGIN IMMEDIATE` 事务，事务内既写审计事件、又改用 `node:fs` 改写该文件，然后抛错；
3. 事务回滚后重新打开数据库，断言 **`audit_events` 为 0 条**（数据库确实回滚了）；
4. 断言文件内容**仍是事务中被改写的内容**（文件没有、也不可能回滚）。

这条用例是**故意写成会「失败」的正确行为**：它把「跨文件 ACID 不存在」钉死成可执行的断言，
防止后续有人把 `withImmediateTransaction` 当跨文件事务用。
`withImmediateTransaction` 的文档注释同时写明该边界。

---

## 3. 数据模型与关键约束（逐项）

### 3.1 表与索引

13 张表（从实际库中 `sqlite_master` 读出，不是手数）：
`schema_migrations`、`connections`、`workspaces`、`grants`、`blobs`、`changesets`、
`change_items`、`operations`、`operation_item_results`、`approvals`、`journal_entries`、
`idempotency_records`、`audit_events`。其中 `schema_migrations` 由迁移机制自管理，其余 12 张是业务表。

13 个唯一索引、4 个普通索引、10 个触发器，同样由 `sqlite_master` 读出。

关键唯一索引：

| 索引 | 挡住的问题 |
| --- | --- |
| `workspaces_identity_uq(volume_id, root_file_id)` | 同一物理目录被登记两次；以及「同名路径换对象」 |
| `workspaces_root_uq(canonical_root COLLATE NOCASE)` | 换大小写写法重复登记同一目录 |
| `change_items_path_uq(change_id, canonical_path_key)` | 同一物理文件在一次修改集里被操作两次 |
| `operations_change_uq(change_id)` | 一个修改集产生两个操作 |
| `idempotency_uq(principal_id, tool, key)` | 同键不同请求被静默覆盖 |
| `blobs_content_uq(sha256, size)` | 相同内容重复落盘 |
| `approvals_active_uq(change_id) WHERE state='ACTIVE'` | 同一修改集同时存在两个有效批准 |

`canonical_path_key` 存的是规范化路径的**小写**形式，因为 Windows 路径大小写不敏感：
`src/main.ts` 与 `SRC\Main.TS` 必须被认为是同一个文件。用例「同一物理文件在一次修改集里只能出现一次（大小写不敏感）」实测覆盖。

### 3.2 触发器强制的不变量

| 触发器 | 强制内容 |
| --- | --- |
| `changesets_content_immutable` | 修改集的 owner/workspace/代次/策略版本/摘要/创建时间**不可改**，只有 `state` 可流转 |
| `changesets_terminal_tombstone` | 终态修改集**不得删除**（否则旧 `change_id` 变回可执行任务） |
| `change_items_immutable` | 修改集条目不可改 |
| `change_items_create_has_no_base` | `create_text` 不得携带基线身份或基线哈希 |
| `change_items_edit_requires_base` | `edit_text` / `replace_text` **必须**携带基线身份与哈希 |
| `operations_no_delete` | 操作记录不得删除 |
| `journal_no_delete` | 日志为追加写，不得删除 |
| `approvals_no_reactivate` | 批准不得从 `CONSUMED`/`REVOKED`/`EXPIRED` 退回 `ACTIVE` |
| `approvals_immutable_binding` | 批准的 change_id/摘要/批准人/创建时间不可改 |
| `idempotency_immutable_key` | 幂等记录的键与 `request_hash` 不可改（只能报冲突，不能覆盖） |

`change_items.encoding` 的 CHECK 只允许 `('utf-8','utf-8-bom')`：
`unknown` 编码与二进制文件**在模式层**就写不进可执行计划，而不是靠上层自觉。
用例「不可编辑的编码写不进可执行计划」实测覆盖。

### 3.3 PRAGMA 是**实测核对**，不是「设了就算」

`configurePragmas()` 在设置之后立即回读实际值并断言，任一不符即拒绝打开：

- `foreign_keys`：必须为 1。这是**每连接**设置且默认关闭；不核对的话所有 `REFERENCES` 形同注释。
- `journal_mode`：文件库必须为 `wal`。不核对的话，在不支持 WAL 的路径上会静默停留在 delete 模式，
  而调用方以为已经拿到了 WAL 的语义。内存库的实测值是 `memory`，用例按实测值断言而不是按预期值。
- `synchronous`：必须为 2（FULL）。WAL 下 FULL 表示每次提交都对 WAL 做 fsync。
  状态库承载批准与操作日志，「断电后丢掉已提交的批准」是不可接受的失败模式，因此不接受 NORMAL 的折中。
- `busy_timeout`：必须等于设定值。用例「busy_timeout 是有界的」用两个连接实测：
  一个持 `BEGIN IMMEDIATE`，另一个写入在约 200 ms 后抛 `SQLITE_BUSY`（实测耗时断言 `>=150ms && <5000ms`），
  释放锁后同一连接立即可写——证明等待是**有界**的，不会把 daemon 挂死。

### 3.4 迁移文本不可变，且与契约的漂移由测试发现

每条迁移的 sha256 在首次应用时写入 `schema_migrations.checksum`，之后每次打开重新计算比对。

这里有一个必须显式记录的设计取舍：**迁移 SQL 里的枚举值一律写成冻结字面量，不引用 `@lwb/contracts`**。
若引用活值，将来契约新增一个状态就会改变 v1 的迁移文本，
使**所有既有数据库**在启动时因校验和不符被拒绝——一个纯类型层面的改动会变成数据不可用。

漂移改由测试发现：用例「冻结的修改集状态集合等于契约当前定义」直接比对
`Object.keys(CHANGE_STATE_LABELS)`，终态集合比对 `TERMINAL_CHANGE_STATES`。
契约改了而迁移没跟，测试失败；这是正确的失败位置。

---

## 4. 已知限制（必须承认，不得当作已解决）

| 限制 | 说明 |
| --- | --- |
| 只有一种迁移，没有**真实的**升级路径证据 | 当前 `MIGRATIONS` 长度是 1。v1→v2 的升级、降级、部分失败恢复**全部未验证**——本任务没有第二版迁移可测。这是最大的未验证项。 |
| 未验证多进程并发 | `busy_timeout` 的有界性已实测，但「两个 daemon 实例同时操作同一状态库」的完整场景未构造。V1 假定单实例。 |
| 未验证断电（而非进程崩溃） | 崩溃用例是 `process.exit(70)` 强制结束进程。物理断电后的磁盘状态**未验证**（与 ADR-002 §6 同一限制）。 |
| 未验证网络盘/非 NTFS 卷上的 WAL | `configurePragmas` 会在实测到非 WAL 时拒绝打开，但该拒绝分支**未在真实网络盘上构造过**。 |
| `audit_events.metadata` 的「不得含源码正文/凭证」只有注释约定 | 结构化校验属 `packages/audit/`（LWB-018），本次未实现。当前只在类型注释里写明。 |
| 迁移以 TS 常量而非 `.sql` 目录交付 | 与任务书字面不同，理由见 §1；若评审要求外部文件，需同时提供漏带检测机制，否则会重新引入「空库继续服务」的风险。 |

---

## 5. 未执行项（明确标注 NOT_RUN，不得当成通过）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| v1→v2 真实升级迁移 | **NOT_RUN** | 没有第二版迁移可测 |
| 降级/回滚到旧模式版本 | **NOT_RUN** | V1 不提供降级路径 |
| 多进程并发写同一状态库 | **NOT_RUN** | 未构造 |
| 断电后的磁盘一致性 | **NOT_RUN** | 需要物理操作或虚拟机控制 |
| 网络盘 / 非 NTFS 卷 | **NOT_RUN** | 本机只有 NTFS |
| 跨用户 / 跨机 DPAPI | **NOT_RUN** | 属 LWB-007 |

---

## 6. 回退方式

本任务**不涉及**用户工作区文件，回退是纯代码与状态层的：

1. 删除 `packages/persistence/` 与 `tests/unit/persistence.test.ts`；
2. 从 `tsconfig.json` 移除 `@lwb/persistence` 路径映射，并运行 `npm install` 解除 workspace 链接；
3. 状态库文件（尚未有默认路径，当前由调用方传入）直接删除——其中不含用户文件内容，
   只含工作区元数据、批准与操作日志；
4. **不得**通过改动已发布的迁移来「回退」：那会让既有数据库因校验和不符而拒绝启动。
   需要回退模式变更时，正确做法是新增一条 v2 迁移。

回退后系统退化为**无状态**：读取与提议链路若已依赖状态库（读取票据、幂等、审计），
必须一并停用，而不是改用内存态"大致等价"地继续跑——那会让幂等与批准失去持久依据。

---

## 7. 执行记录

```
$ node -v
v22.20.0

$ npx tsc --noEmit
(无输出)                                          EXIT=0

$ node scripts/check-fsguard-imports.mjs
✅ FsGuard 导入检查通过（已检查 26 个文件，未发现绕过）。   EXIT=0

$ node scripts/run-tests.mjs
运行 4 个测试文件：
  - tests/unit/contracts-path.test.ts
  - tests/unit/persistence.test.ts
  - tests/windows/winfs-guard.test.ts
  ...
# tests 73
# pass 73
# fail 0
# skipped 0
# duration_ms 2599.9602                             EXIT=0
```

单文件复核（用于区分「本任务的用例」与「整套回归」）：

```
$ node --test --import tsx tests/unit/persistence.test.ts
# tests 42
# pass 42
# fail 0

$ node scripts/run-tests.mjs tests/unit
# tests 61
# pass 61
# fail 0
```
