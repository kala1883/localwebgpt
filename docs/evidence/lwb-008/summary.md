# LWB-008 · 单实例、认证 IPC 与生命周期 — 证据

**实现提交：** `14c23c6`
**任务状态：** DONE（三条验收标准均有实测支撑；已知限制见 §6）

---

## 1. 环境

| 项 | 值 |
| --- | --- |
| 平台 | Windows 11 Home China 10.0.26200（`win32 x64`） |
| Node | v22.20.0 |
| PowerShell | 7.6.6（`pwsh`） |
| 权限 | **非管理员**（与 LWB-007 一致，未使用任何提权操作） |
| 仓库分支 | `feat/lwb-p0-p2` |

---

## 2. 改动文件

| 文件 | 作用 |
| --- | --- |
| `packages/ipc/package.json` | `@lwb/ipc`，依赖 `@lwb/contracts`、`@lwb/secure-store` |
| `packages/ipc/src/audience.ts` | audience 闭集、能力映射、`NEVER_GRANTED_TO_MODEL`、凭证互异校验 |
| `packages/ipc/src/handshake.ts` | 挑战—应答证明、按 audience 派生密钥 |
| `packages/ipc/src/pipe-name.ts` | 由 SID 派生管道名；绑定即互斥 |
| `packages/ipc/src/framing.ts` | 行分隔 JSON 分帧 + 2 MiB 硬上限 |
| `packages/ipc/src/operations.ts` | 操作注册表：能力要求绑定在操作名上 |
| `packages/ipc/src/server.ts` | 会话状态机、`attachSocket` 适配 |
| `packages/ipc/src/client.ts` | 客户端握手、分帧、超时归类 |
| `packages/ipc/src/lease.ts` | 写执行器租约与栅栏令牌 |
| `packages/ipc/src/process-probe.ts` | 存活探针（`process.kill(pid, 0)`） |
| `packages/ipc/src/single-instance.ts` | 控制管道绑定 / 释放 |
| `apps/daemon/src/lifecycle/process-start-time.ts` | 启动时刻查询与 `StartTimeCache` |
| `apps/daemon/src/lifecycle/child-processes.ts` | 子进程登记与退出清理 |
| `tests/unit/ipc.test.ts` | 44 条（含真实命名管道集成） |
| `tests/unit/lifecycle.test.ts` | 10 条（含真实进程与真实 pwsh 助手） |
| `scripts/evidence/lwb-008.ts` | 本文件证据的可复现采集脚本 |

### 2.1 与任务书的偏差

任务书写交付物为 `apps/daemon/lifecycle/`。实际放在 **`apps/daemon/src/lifecycle/`**，
因为 `scripts/check-fsguard-imports.mjs` 的 `ALLOWED_PREFIXES` 预先登记的是
`apps/daemon/src/lifecycle/`（用于放行 `child_process`），且根 `tsconfig.json`
的 include 与 `package.json` 的 `daemon` 脚本均指向 `apps/daemon/src/`。
命名不一致本身是任务书与既有脚手架之间的差异，此处以脚手架为准，不修改脚手架。

---

## 3. 执行命令与结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npx tsc --noEmit` | 0 | 无输出 |
| `node scripts/check-fsguard-imports.mjs` | 0 | 已检查 50 个文件，未发现绕过 |
| `node scripts/run-tests.mjs` | 0 | `# tests 195 # pass 195 # fail 0 # skipped 0` |
| `node --import tsx scripts/evidence/lwb-008.ts` | 0 | 全部观测项通过（全文见 §4） |

**测试计数变化：** 140 → 195（新增 55 条：`ipc.test.ts` 45 条、`lifecycle.test.ts` 10 条）。
`# skipped 0`，即所有用例**实际执行**，包括需要真实 `pwsh` 的那几条。

---

## 4. 验收标准逐条

### 验收标准 1 · 第二个 daemon 不会并发写同一个状态库/工作区

实测输出：

```
PASS 首个实例取得控制管道
PASS 第二个实例被拒绝
     拒绝理由: 控制管道 \\.\pipe\LocalWorkspaceBridge.<sid-hash> 已被占用，
              说明本用户下已有 daemon 在运行。…
PASS 释放后可重新绑定（崩溃一次不会永久占死）
```

**机制：** 绑定控制管道这一动作本身就是互斥量。「检查名字是否被占用」与
「绑定这个名字」在操作系统里是同一个原子操作，不存在检查通过、绑定失败的窗口。
进程退出（含崩溃、被强杀）时由**操作系统**释放管道名，因此没有锁文件方案
「持有者是否还活着」的启发式问题，也没有 PID 复用问题。

覆盖的负向情形：

| 情形 | 期望 | 实测 |
| --- | --- | --- |
| 同 SID 第二次绑定 | 拒绝 | `occupied` |
| 释放后重新绑定 | 允许 | `acquired` |
| 不同 SID 并发绑定 | 互不阻塞 | 均 `acquired` |
| 设置 `LWB_HOME` 后管道名 | 不变 | 不变 |
| 非法 SID | 拒绝而非拼名 | 抛错 |

最后一条针对的绕过路径：若管道名受环境变量影响，「同一用户两个 `LWB_HOME`」
会变成两条互不可见的管道，单实例保证被一个环境变量绕过。

### 验收标准 2 · 伪造本地连接、错误 audience 的凭据被拒绝

实测输出（全部走**真实命名管道**）：

```
PASS 正确凭证可以连接
     授予能力: ["tools.read","tools.propose","tools.apply"]
PASS 适配器调用控制台专属操作被拒绝 — CAPABILITY_DENIED
PASS 适配器调用自身能力内的操作成功
PASS 伪造凭证被拒绝 — 本地服务端拒绝连接：连接凭证无法通过校验。
PASS 控制台凭证冒充适配器被拒绝 — 本地服务端拒绝连接：连接凭证无法通过校验。
PASS 适配器凭证冒充控制台被拒绝（分离是双向的） — …
PASS 未注册的连接标识被拒绝 — 本地服务端拒绝连接：该连接标识未在本机注册，拒绝。
     服务端审计事件: ["handshake_ok","capability_denied","handshake_failed",…]
```

**机制：** 挑战—应答，**凭证从不过线**。双方各自持有凭证、只交换随机数，
凭证仅用于计算 HMAC；服务端随机数一次性使用。这样做的必要性与威胁模型一致：
本设计明确**不**防护同账户恶意进程，因此任何依赖「管道本身保密」的方案
前提就是错的。抓到的报文在另一次连接上没有用。

**能力要求绑定在操作名上**，请求方只能选操作名、选不了它需要什么权限。
若让请求携带 `capability` 字段，就是一个自证清白的结构。

**「算得对」不等于「被允许」：** `verifyHandshake` 先查连接注册表再验证明。
顺序刻意的 —— 反过来会让任何持有凭证者自造一个身份。

覆盖的负向情形：

| 情形 | 期望错误码 | 实测 |
| --- | --- | --- |
| 伪造凭证 | `BAD_PROOF` | ✅ |
| 控制台凭证冒充适配器 | `BAD_PROOF` | ✅ |
| 适配器凭证冒充控制台 | `BAD_PROOF` | ✅ |
| 未注册 `connection_id` | `CONNECTION_ID_MISMATCH` | ✅ |
| 重放同一 `client_nonce` | `NONCE_REUSED` | ✅ |
| 换 `server_nonce` 后重放整条报文 | `BAD_PROOF` | ✅ |
| 篡改 `pid` | `BAD_PROOF` | ✅ |
| 未知 audience | `UNKNOWN_AUDIENCE` | ✅（会话层） |
| 字段类型错误 | `MALFORMED`（不抛异常） | ✅ |
| 适配器调用 `workspaces.manage` | `CAPABILITY_DENIED` | ✅ |
| 握手前的 `request` 报文 | `PROTOCOL_ERROR` + 断开，且**不执行** | ✅ |

最后一条值得单独说明：若实现成「不认识的报文先放着、等握手完成后处理」，
攻击者只要在连接刚建立时抢先发一条 `request` 就能在未认证状态下让请求被执行。
实测断言了两件事：收到 `PROTOCOL_ERROR`，且操作处理器**未被调用**。

### 验收标准 3 · 超时或租约到期不会直接允许另一个执行器与仍存活的旧执行器同时写

实测输出：

```
PASS 执行器 A 取得租约
     执行器 A 栅栏令牌: 1
PASS 过期但旧执行器仍存活 → 拒绝接管 — HELD_BY_LIVE_EXECUTOR
PASS 探针不可用 → 拒绝接管（不当作「已退出」） — CANNOT_PROVE_HOLDER_GONE
PASS 旧执行器确实已退出 → 允许接管
     执行器 B 栅栏令牌: 2（必须大于 A 的）
PASS 接管后令牌递增
PASS 被接管后旧执行器（不同标识）的写入被拒绝 — 写执行器标识不匹配（当前 exe-b）…
PASS 同标识重新取得租约会推进令牌 — 1 → 2
PASS 同标识但令牌过期 → 写入被拒绝（栅栏令牌本身有效）
     — 栅栏令牌已失效（当前 2，请求 1），拒绝写入。这通常意味着本执行器已被接管。
```

**机制：** 接管需要**两个**条件同时成立 —— 租约已过期 **且** 能证明旧持有者已不在。

租约到期的唯一含义是「没有收到续约」。没收到续约至少有三类原因：持有者真的死了、
持有者活着但被挂起（休眠/断点/虚拟机暂停/CPU 饥饿）、续约请求没送达。
只有第一类允许接管；另外两类接管就得到两个同时写的进程。

| 情形 | 期望 | 实测 |
| --- | --- | --- |
| 租约未到期 | `LEASE_NOT_EXPIRED` | ✅ |
| 到期 + 旧持有者存活 | `HELD_BY_LIVE_EXECUTOR` | ✅ |
| 到期 + 探针抛异常 | `CANNOT_PROVE_HOLDER_GONE` | ✅ |
| 到期 + 旧持有者已退出 | 接管，令牌递增 | ✅ |
| 到期 + PID 被复用（启动时刻不同） | 接管 | ✅ |
| 到期 + 取不到启动时刻 | 判为存活，拒绝接管 | ✅ |
| 到期未续约的写入 | 拒绝 | ✅ |
| 续约 | 令牌不变 | ✅ |
| 释放后令牌不回退 | 递增 | ✅ |

**为什么需要栅栏令牌（不能只靠「接管时检查一次」）：**
即便接管判定出错（进程在「判定死亡」与「新持有者开工」之间又活了过来），
旧持有者的写入仍必须被拒绝。因此令牌在**每次写入**都校验，
而不是在连接建立时校验一次 —— 后者会让一个已失去租约的执行器
在整个连接生命周期内保持写权限。

### 4.1 步骤 3 的「父进程异常后不得留下旧写执行器」

分两部分：

**(a) 写执行器。** 执行器**不直接写文件** —— 它通过 daemon 提交修改集，
而 daemon 是唯一的写入者。旧 daemon 死亡时其管道随之消失，
旧执行器无法与新的 daemon 建立连接（握手需要连接标识预先注册），
因此「旧执行器与新实例并行写」在本架构下只有一条路径：
新旧执行器都通过**同一个** daemon 提交。而那条路径由租约 + 栅栏令牌覆盖（见上）。

**(b) 原生助手子进程。** 实测：

```
PASS daemon 退出时终止已登记子进程 — 已终止 ["sleeper"]，顽抗 []
PASS 终止后用操作系统事实确认进程已不在
PASS 父进程关闭 stdin 后助手自行退出
```

`SecureStore.ps1:209-210` 是 `$line = [Console]::In.ReadLine(); if ($null -eq $line) { break }`。
本文件中的用例**实测**了这条缓解：起一个真实 pwsh 助手、确认它能响应请求
（否则「退出」可能只是启动失败），然后只关闭 stdin、不发任何终止信号，
断言它在 15 秒内自行退出且进程已不在。

「终止后用操作系统事实确认」一句是刻意的：`child.kill()` 的返回值
不构成「进程已死」的证据，必须重新问操作系统。

---

## 5. 设计缺陷与修正（负向回归）

以下三处是**实现过程中发现并修正**的真实缺陷。写在这里而不是只留在提交信息里，
因为它们的共同特征是「测试全绿但结论不成立」。

| # | 缺陷 | 后果 | 修正 |
| --- | --- | --- | --- |
| 1 | `deriveAudienceKey(ipcSecret, audience)` 从**一把共用凭证**派生所有 audience 的密钥 | 任何持有 `ipc_secret` 者都能对**任意** audience 算出有效证明。audience 分离只是文档上的一句话，不是密码学性质 | 改为按 audience **各自持有**的凭证派生；新增 `assertAudienceSecretsDistinct`，两类凭证相同则拒绝启动 |
| 2 | 「旧执行器写入被拒绝」的用例实际命中的是**标识**检查 | 栅栏令牌可能是一段永不生效的死代码，而测试仍然全绿 | 补一条只可能被令牌检查挡住的用例（同标识、令牌已推进） |
| 3 | `pwsh -Command '<脚本>' <pid>` 把 pid **拼接**到脚本文本后，而非放进 `$args` | 实测 `ParserError`；脚本看似执行了，实际什么都没查，探针恒失败 | 改用环境变量 `LWB_PROBE_PID` 传参 |

第 1 条尤其说明问题：它的失败是**静默的** —— 共用凭证时系统一切照常工作，
只有 audience 分离悄悄没了。这类缺陷不会被「功能是否正常」的测试发现。

另有 3 处测试自身的问题已修正（记此以备复核）：
断言层次放错（把会话层的 audience 合法性检查写成了 `verifyHandshake` 的断言）、
只读第一帧而漏掉后面的拒绝回执（第一帧是 `hello` 挑战）、
以及断言了一个服务端从未使用的注册表（该断言恒真，是句空话）。

---

## 6. 已知限制与未执行项

| # | 项 | 说明 |
| --- | --- | --- |
| 1 | **daemon 被强杀时子进程不会被回收** | `terminateAll` 不会执行。缓解仅在被助手一侧（监听 stdin 关闭并自行退出），且**不覆盖助手本身卡死**的情形。彻底解法是 Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），需 `native/` 真正实现后才能提供 |
| 2 | 启动时刻探针需要 `pwsh` | 无 `pwsh` 时 `StartTimeCache.refresh` 失败 → 启动时刻为 `null` → 按「无法排除 PID 复用」处理 → **接管被拒绝**。方向是 fail-closed |
| 3 | 租约不持久化 | 令牌只在单个 daemon 实例生命周期内单调。跨重启的单调性未提供，理由是跨重启的旧执行器本就无法与新 daemon 通信 |
| 4 | 时序攻击 | 用 `timingSafeEqual`，但**不**把它当作一条安全论据 —— 本地管道上攻击者可直接读进程内存 |
| 5 | 管道名可见 | 管道名不是安全边界，任何进程都能尝试连接；边界是握手。已在 `pipe-name.ts` 注释中写明 |
| 6 | 能力表是静态的 | 收紧策略对已有连接立即生效（每次请求重新查表），但**新增** audience 需要改代码，没有运行时注册路径 |

**未执行项（NOT_RUN）：**

| 项 | 原因 |
| --- | --- |
| 真实 ChatGPT 网页经隧道调用 | 属 LWB-002，无账号与隧道凭证，保持 BLOCKED |
| 两个**真实 daemon 进程**并发启动 | 已用同进程内双绑定覆盖同一 OS 语义；跨进程版本待 daemon 可执行后补 |
| 租约在真实长时间挂起（休眠）下的行为 | 需人工制造休眠，本会话未执行 |
| 非管理员下的完整 daemon 生命周期 | daemon 主体属 LWB-009 及其后，本任务只交付 IPC 与生命周期层 |

---

## 7. 回退

本任务**未**开启任何能力开关：`docs/adr/003-protocol-and-trust.md` §5.1 的五个开关
（含 `direct_write_enabled`）保持默认关闭。因此回退方式是：

1. 回退提交 `14c23c6`（或从 `packages/ipc/`、`apps/daemon/src/lifecycle/` 移除文件）；
2. 无数据库迁移需要撤销 —— LWB-008 未新增表、未修改 `packages/persistence/` 的 schema；
3. 无用户文件被写入 —— 本任务的全部写入都发生在测试临时目录与命名管道中。

**不得**通过覆盖用户文件实现代码回滚（与 `docs/adr/001-scope.md` §3.1 一致）。
未决恢复数据：无。
