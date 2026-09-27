# LWB-007 证据：受保护存储与凭证管理

- 日期：2026-09-25
- 环境：Windows 11 Home China 26200 / Node v22.20.0 / npm 10.9.3 / tsx 4.23.15 / PowerShell 7（`pwsh`，DPAPI 经 P/Invoke 调用）
- 实现提交：`2b25f2f`（feat(LWB-007): 受保护存储、DPAPI 凭证与内容寻址快照）
- 可复现命令：`npm run typecheck && npm run check:imports && npm run test`
- 证据采集脚本：`npx tsx scripts/evidence/lwb-007.ts`（退出码 0）

> 本文件只记录**实际执行过**的结果。未执行的项在最后一节显式列出，不写成通过。
> 本机为 Windows Home 版，**未使用管理员权限**，所有操作均在当前用户下完成。

---

## 1. 交付物与改动文件

| 文件 | 作用 |
| --- | --- |
| `packages/secure-store/SecureStore.ps1` | 常驻助手：ACL 加固/回读、DPAPI 保护/解除保护、身份查询 |
| `packages/secure-store/src/helper-client.ts` | 助手客户端（JSON 行协议、串行化、超时不吞错）与两个能力接口 |
| `packages/secure-store/src/layout.ts` | 受保护根与子目录的**唯一定义** |
| `packages/secure-store/src/acl.ts` | 允许清单判定 + 加固流程（回读校验，失败即拒绝启动） |
| `packages/secure-store/src/credentials.ts` | 三类凭证的 DPAPI 存储，按类别做 entropy 域分离 |
| `packages/secure-store/src/redaction.ts` | 日志/参数/诊断包脱敏 |
| `packages/secure-store/src/protected-paths.ts` | 受保护路径预过滤 + 身份判定 + 广泛目录判定 |
| `packages/blob-store/src/layout.ts` | 内容寻址布局（`objects/<aa>/<sha256>`）与引用形状校验 |
| `packages/blob-store/src/store.ts` | 先落盘后引用、完整性校验、无引用回收 |
| `tests/unit/secure-store.test.ts` | 45 条用例 |
| `tests/unit/blob-store.test.ts` | 22 条用例 |
| `scripts/evidence/lwb-007.ts` | 本文件所有实测数据的采集来源 |

改动：`tsconfig.json`（`paths` 中 `@lwb/secure-store`/`@lwb/blob-store` 在 LWB-005 已预置，本次仅新增 `scripts/**/*.ts` 到 `include`，使证据脚本也受类型检查）、`package-lock.json`（新增两个 workspace）。

---

## 2. 三个验收标准

### 2.1 模型无法通过任何文件工具读取凭证、日志库或审批数据库 ✅

分三层，每层都有实测。

**(a) 受保护根的 ACL 被改成显式 DACL 并回读核对。** 采集脚本在临时目录上执行实际加固：

```text
加固前实测 access_rules_protected: false（12 条继承规则）
加固后实测 access_rules_protected: true
加固后实测规则（3 条）:
  S-1-5-18                NT AUTHORITY\SYSTEM       Allow FullControl
  S-1-5-32-544            BUILTIN\Administrators    Allow FullControl
  S-1-5-21-...-1001       MJ-LAPTOP-FVES0\mj        Allow FullControl
7 个目录全部 acceptable=true
PASS  加固后 ACL 只含允许清单内的主体
```

**加固前的实测结果直接决定了本模块的设计。** 本机 `%LOCALAPPDATA%` 下的默认 DACL 有 **12 条**继承规则，其中：

- `MJ-LAPTOP-FVES0\CodexSandboxUsers` —— 本机自定义组，`DeleteSubdirectoriesAndFiles, Modify`；
- `S-1-15-3-2968813833-…` —— 一个 AppContainer 包 SID，`FullControl`；
- 另有 8 个 `S-1-21-…`/`S-1-5-21-…` 形式的、甚至**解析不出名称**的主体，多数带 `Modify` 或 `Write`。

因此本模块采用**允许清单**（只接受当前用户、SYSTEM、Administrators，其余一律违规）而不是
「拒绝 Everyone / Users / Authenticated Users」这类黑名单——黑名单在本机上第一个就漏掉了
`CodexSandboxUsers`。这条判断由 `tests/unit/secure-store.test.ts` 用真实 SID 形状钉住。

**(b) 判定留在 TypeScript 侧，PowerShell 只回答「磁盘上现在是什么」。** `assessAcl()` 是纯函数，
被测到 8 条用例，含「继承未断」「无法解析的主体」「加固把服务自己关在门外」三种保守拒绝。

**(c) 受保护根不得被挂载为工作区（I13）。** `assessBroadDirectory()` 拒绝三类候选：受保护根本身、
受保护根的祖先、系统级广泛目录（USERPROFILE / LOCALAPPDATA / APPDATA / ProgramData / SystemRoot /
Program Files / TEMP / 当前盘根）。实测：

```text
把受保护根的父目录注册为工作区: {"accepted": false, "reason": "该目录包含本地服务的受保护存储（凭证、状态库、快照、日志），不得作为工作区。"}
PASS  受保护根的祖先不得作为工作区
```

语法层（`isProtectedPathSyntax`）与身份层（`findProtectedIdentityMatch`）在**同一个文件里显式分层**，
头注释写明前者「**不是**安全边界」。真正的判定比对的是原生层在已打开句柄上读到的
`volume_id + file_id`，字符串别名、Junction、8.3 短名都伪造不了它。

### 2.2 快照缺失或哈希不符时应用被拒绝 ✅

`BlobStore.getVerified()` 在三种情况下抛出，且**不返回任何字节**。实测三条拒绝路径：

| 情况 | 触发方式 | 实测结果 |
| --- | --- | --- |
| 内容哈希不符 | 把对象**原地改一个 bit**（长度不变，长度检查发现不了） | `BlobIntegrityError: 快照内容哈希与登记值不符`，`expected=50f55cbc…`、`actual=dacc96e8…` |
| 被截断 | 覆写为前 5 字节 | `BlobIntegrityError: 快照长度与登记值不符` |
| 对象缺失 | 删除对象文件 | `BlobMissingError: 快照对象缺失，拒绝继续（极可能是状态库与磁盘不一致）` |

前两条的区别是刻意的：长度不符时**不读完整个文件**即可判定，因此 `actual_sha256` 为 `null`；
把「没算」写成「算出来不一样」会让排障时误以为字节被改成了另一个完整文件。

**「先持久化后入库引用」不是注释里的约定，而是一条被测试证明的性质。**
用例「先落盘后引用：登记发生时字节已经在磁盘上」把替身仓储的 `ensure()` 做成在调用瞬间
`existsSync(对象路径)`，断言结果为 `true`。顺序颠倒会产生「数据库里有一条指向不存在字节的快照」，
而回滚恰恰要在最坏的时刻读它。`putAndRegister()` 把这个顺序固定在函数体内，调用方无从颠倒；
登记后还会**立刻回读校验**一次，把不一致挡在修改集进入可执行状态之前。

同时，`put()` 的去重分支在复用既有对象前会**先验证它确实是那个内容**——否则一次既有的损坏会被
传播成「所有引用都指向坏字节」。用例「去重时若盘上已有的字节已被损坏，拒绝复用」覆盖此路径。

### 2.3 日志、进程参数、导出的诊断包没有明文凭证 ✅

**(a) 磁盘上没有明文。** 真实 DPAPI 往返后直接读原始文件字节：

```text
磁盘文件大小（字节）: 553
磁盘文件（已脱敏）: { "v": 1, "class": "runtime", "created_at": "…", "protection": "dpapi-current-user",
                     "ciphertext": "AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAAmd4rsQ1l1EOl93ZYUApUxAAAAAACAAAAAAAQZgAAAAEAACAAAABb…" }
PASS  DPAPI 往返一致 — 长度 45
PASS  磁盘上没有明文凭证
```

密文以 `AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA` 开头，是 DPAPI blob 的标准前缀（`01000000D08C9DDF0115D1118C7A00C04FC297EB` 的 base64），
说明写入路径确实经过了 `CryptProtectData`，而不是自制的编码。

**(b) 类别之间不可互换（域分离）。** 用 `runtime` 的 entropy 加密，再用 `ipc`/`console` 的 entropy 解：

```text
PASS  换类别 entropy 解不开（域分离） — DPAPI 解密失败（Win32 13）
```

Win32 13 = `ERROR_INVALID_DATA`。这条挡住的是「用低权限类别的凭证冒充高权限类别」——
若三类凭证共用一个文件或一段 entropy，把 `console.cred` 拷成 `ipc.cred` 就能让控制台冒充 IPC 身份。
凭证文件里另存了自述的 `class` 字段作为第二道，`tests/unit/secure-store.test.ts` 对两者都各有用例。

**(c) 机制不可用时**没有**明文回退。** 这条是本节最重要的一条：一个「先明文存着，回头再加密」的
降级路径会让整套机制变成空话，而调用方从接口上分辨不出来。用例
「机制不可用时拒绝写入，且**不**留下任何文件」断言 `set()` 抛 `CredentialUnavailableError`
**且 `existsSync(凭证文件) === false`**——用磁盘状态证明，而不是相信错误信息。

**(d) 脱敏。** `redact()` 先用**注册值精确替换**，再用特征表兜底。顺序被专门测过：
反过来会让特征表先把已注册机密的**片段**替换掉，导致精确匹配再也命中不了。
`assertNoRegisteredSecret()` 在导出诊断包前做最后一道闸，**发现残留就抛错拒绝导出**，
而不是「打码后照样导出」——打码失败与没打码的后果相同。

脱敏过程本身发现并修掉了一个真实缺陷：`prefixed-token` 规则原先只接受 `-` 分隔符，
于是 GitHub 的 `ghp_…` 整类漏过；测试失败暴露了这一点，现改为 `[-_]`。

命令行参数的脱敏是**补救而非许可**：命令行对同账户的任何进程可读
（`Get-CimInstance Win32_Process`），因此凭证本来就不该出现在参数里。这一点写在代码注释里，
避免后来者把它当成「可以把 token 放参数里了」。

---

## 3. 执行记录

### 3.1 命令与退出码

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm install` | 0 | `added 2 packages`（`@lwb/secure-store`、`@lwb/blob-store` 接入 workspace） |
| `npx tsc --noEmit` | 0 | 无输出 |
| `node scripts/check-fsguard-imports.mjs` | 0 | `✅ FsGuard 导入检查通过（已检查 36 个文件，未发现绕过）` |
| `node scripts/run-tests.mjs` | 0 | `# tests 140 / # pass 140 / # fail 0 / # skipped 0` |
| `npx tsx scripts/evidence/lwb-007.ts` | 0 | `全部观测项通过。` |

用例计数（单文件实跑，非估算）：

```text
node scripts/run-tests.mjs --grep secure-store   →  # tests 45  # pass 45  # fail 0  # skipped 0
node scripts/run-tests.mjs --grep blob-store     →  # tests 22  # pass 22  # fail 0  # skipped 0
```

LWB-006 结束时全量为 73 条；本次 +67（45 + 22）。

**关于 `check-fsguard-imports` 的文件数没有变化（36）**：该数字统计的是 `BUSINESS_PREFIXES`
下的文件，而 `packages/secure-store/`、`packages/blob-store/` 位于 `ALLOWED_PREFIXES`
（它们在 LWB-005 建骨架时就被预置在那里，因为这两个包的本职工作就是碰文件系统与加密设施）。
`blob-store` 完全没有依赖，`secure-store` 只依赖 `@lwb/contracts`。

### 3.2 真实 Windows 保护机制确实被执行了

DPAPI 相关用例**不是**跳过的：`# skipped 0`。`SecureStoreHelper.start()` 用一次 `whoami` 探测
确认 `Add-Type` 编译完成（首次约 1 秒），失败时**不抛**而是置 `#startupError`，
由 `isAvailable()` 决定降级方式——本包一律拒绝启用。真实调用返回：

```text
助手可用: true
当前用户 SID: S-1-5-21-4247710454-1492826582-129756499-1001
```

缺少 `pwsh` 的环境里，这 7 条用例会**显式打印警告并 skip**，不计入通过；本次全部实际执行。

### 3.3 fsync 的实测结果（一条必须如实记录的限制）

```text
put 结果: { …, "file_synced": true, "directory_synced": false }
```

**文件内容 fsync 成功；目录项 fsync 在 Windows 上失败。** Node 拒绝以读取方式打开目录
（`EISDIR`/`EPERM`），`FlushFileBuffers` 对目录句柄也不可用。`#syncDirectory()` 捕获失败后
**如实返回 `false`**，而不是假装成功：本模块不为「改名已持久」背书，那句话在 Windows 上依赖
NTFS 的元数据日志，属于操作系统而非本程序的保证。调用方（daemon）若需要更强的持久性语义，
必须自己承担并另行验证。

---

## 4. 负向回归

除上表外，本次还实测了以下**必须失败**的路径：

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| `.env.example` 作为待读文件 | 拒绝（不得自动豁免） | `isProtectedPathSyntax` 返回 `{kind:'basename'}` ✅ |
| 受保护根的祖先作为工作区 | 拒绝 | `{accepted:false, reason:'…包含本地服务的受保护存储…'}` ✅ |
| 快照引用含 `objects/aa/../../../../etc/passwd` | 拒绝且**不删除任何文件** | 跳过并记录原因；同目录下的 canary 文件内容不变 ✅ |
| 分片与哈希不一致的引用 | 拒绝 | 抛「分片与哈希不一致」 ✅ |
| 大写 / 截短 / 绝对路径形式的引用 | 拒绝 | 全部抛错 ✅ |
| 引用计数不为 0 却被标为 `pending_gc` | 跳过而非删除 | `collected.length === 0`，对象仍在 ✅ |
| 存在在途操作时回收 | 拒绝 | `refused=true`，未删除任何字节 ✅ |
| 未接入状态库时回收 | 拒绝 | `refused=true`，理由「无法得知引用计数」 ✅ |
| 空凭证写入 | 拒绝 | 抛 `CredentialCorruptError` ✅ |
| 凭证 JSON 损坏 | 报「损坏」而非「不存在」 | 抛 `CredentialCorruptError` ✅ |
| 校验失败的对象被标记为已核实 | 不得标记 | `verified === []` ✅ |
| 调用方声明的哈希与字节不符 | **落盘前**拒绝 | 抛错，且两个候选路径均不存在 ✅ |

最后一条值得单说：如果先写盘再校验，写进去的错误字节就被永久固化了（内容寻址意味着
它会被当成一个合法的、可被引用的对象）。因此 `put()` 在 `expectedSha256` 不符时
**一个字节都不写**，用例直接断言磁盘上没有产生文件。

---

## 5. 已知限制与未执行项

**未执行（不得视为通过）：**

- **端到端「模型无法读取凭证」未经真实 ChatGPT Web 会话验证。** 本次证明的是
  「ACL 被设成只允许当前用户/SYSTEM/Administrators」与「凭证不以明文落盘」这两件**本机可观测**的事。
  从模型侧发起一次真实读取尝试属于 LWB-002 的范围，而 LWB-002 因缺少真实账号与 Secure MCP Tunnel 处于 BLOCKED。
- **未做跨账户验证**：没有第二个 Windows 账户可用于实际尝试读取受保护目录。
  判定依据是 DACL 的允许清单，不是一次真实的越权尝试。
- **未做崩溃/断电下的持久性测试**：`directory_synced=false`（§3.3），改名操作在断电后的可见性未测。
- **审批数据库（`bridge.sqlite`）与恢复快照目录尚未接入 daemon**，因此「模型读不到它们」目前只由
  ACL 与路径判定保证，尚无一条端到端的拒绝证据。这需要 LWB-008/LWB-012 完成后补测。
- **`SecureStore.ps1` 的加固路径只在临时目录上实测过**，未在真实
  `%LOCALAPPDATA%\LocalWorkspaceBridge` 上执行 —— 那会改动用户机器的真实权限，不属于本次范围。

**已知限制：**

- 三类凭证的 entropy 是**固定常量**，其作用是域分离而不是保密（详见 `credentials.ts` 头注释）。
- 特征表（`SECRET_PATTERNS`）只覆盖已知形状，是第二道网而非保证；主要手段始终是注册值精确替换。
- `.env` 前缀规则会误杀 `.environment` 这类罕见文件名（有意选择 fail-closed）。
- `broadDirectoryProbes()` 比较的是**字符串**，同 `isProtectedPathSyntax` 一样是预过滤；
  真实判定依赖身份比对，而身份比对需要原生层（LWB-010 已提供 `winfs` 侧能力，尚未在此串联）。

---

## 6. 回退

- 关闭相关能力开关即可停用：本任务的产物是库，不改变任何既有行为。
  `packages/secure-store` 与 `packages/blob-store` 目前没有任何调用方（daemon 尚未接入），
  因此回退 = 不接入，或将 `tsconfig.json` 的 `paths` 与两个包目录一并移除，其余代码不受影响。
- 测试与证据脚本可独立删除，不影响其他任务的产物。
- **未对用户文件做任何改动**：所有实测均在 `%TEMP%` 下的临时目录中进行，
  证据脚本在 `finally` 中停止助手并删除临时目录。唯一被改动权限的目录是临时目录本身。
- 未使用 `git reset --hard` / `git clean` / `git checkout` / `git stash`，未改动 `docs/` 下的三份方案文档。
