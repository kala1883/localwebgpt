# G2 · 只读阶段门禁 — 判定与依据

**判定：未通过。**
**判定日期：** 2026-09-25（依据 LWB-013 ~ LWB-018 六项任务的证据）
**判定人：** 无 —— 本仓库从未指定验收负责人（`docs/adr/001-scope.md` §6），
因此这份文件是**证据汇总与结论陈述**，不是一次被授权的验收签署。

---

## 1. 门禁原文与它拆成的两个子句

`docs/LWB_COMPLETE_PLAN.md` §12 的分期表：

```
| P2 只读能力 | 013–018 | 列表、读取、搜索、只读 Git、MCP、审计配额 | G2：真实网页读取且内容出站可追踪 |
```

这句话用「且」连了两个子句，它们的**证据来源不同**，因此必须分开判：

| # | 子句 | 判据落在哪 | 判定 |
| --- | --- | --- | --- |
| (a) | **真实网页读取** | ChatGPT 网页端经 Secure MCP Tunnel 调用这些工具并拿到真实内容 | **NOT_RUN** —— 依赖 BLOCKED 的 LWB-002 |
| (b) | **内容出站可追踪** | 本机侧能逐次回答「哪次调用读了什么、什么出去了、什么被拦住了」 | **已证** —— `docs/evidence/lwb-018/summary.md` |

**「且」意味着 (b) 成立不改变整体判定。** 一个把出站记得分毫不差、但从未被真实网页
调用过的系统，通过的是 (b)，不是 G2。

### 1.1 子句 (a)：为什么是 NOT_RUN 而不是「通过」

- LWB-002（真实 ChatGPT 网页接入与 Secure MCP Tunnel）状态为 **BLOCKED**：
  本环境没有真实 ChatGPT 账号，也没有隧道凭据。
- **MCP Inspector 的成功不能替代它。** 这不是本仓库自定的严格：方案 §1 已写明
  「账号或隧道门禁未通过时，可以继续做本地 Inspector 验证，但**不能宣称**用户的
  『ChatGPT 网页本地读写』目标已完成」。
- 今天证据链到的最远处是「真 MCP 客户端 + 真进程 + 真命名管道」
  （`tests/windows/mcp-adapter-e2e.test.ts`，10 例，LWB-017）。这一段是真的，
  但它**不是**网页端：客户端是本机测试进程，传输是内存/命名管道，中间没有隧道。

### 1.2 子句 (b)：已证的部分，以及它的边界

`node --import tsx scripts/evidence/lwb-018.ts`（退出码 0；40 PASS / 0 FAIL / 5 NOT_RUN / 8 NOTE）
在**真实护栏 + 真实 NTFS + 生成出来的夹具仓库**上给出：

| 要求 | 证据（逐字摘录见 LWB-018 证据 §1） |
| --- | --- |
| 读了哪些文件、哪些范围 | 同一文件两页的区间不同（`1-400` / `401-800`）⇒ 范围是算出来的 |
| 哪些字节出去了 | 出站字节取自预算记账的增量，与范围行同时给出（`bytes_out=21200`） |
| 被拒绝的调用指向了什么 | `拦下了=[secrets/.env(整文件/无区间)]`（策略拒绝也留痕） |
| 撤权后旧结果不返回 | 处理器读完文件后撤权 ⇒ `REVOKED_BEFORE_RETURN`，信封里搜不到正文 |
| 撤权后旧游标不返回 | 暂停前签发的真游标在工作区暂停/恢复后均被拒（`PAUSED` / `READ_TOKEN_STALE`） |
| 审计写不进去就不返回内容 | 只删审计两张表 ⇒ `STORAGE_UNAVAILABLE` / `AUDIT_WRITE_FAILED` |
| 审计里没有正文 | 92 条文本列逐条比对 3 个内容探针，全无命中；正向对照命中相对路径 |

**这一半的边界**（与 G2 的判定无关，但读这份文件的人需要知道）：

- 全部证据采自**生成出来的测试根**，不是任何真实仓库（这是验收标准 3 本身要求的）；
- 一条边界**判定悬置**：连接暂停→恢复后，暂停前签发的游标仍然可用
  （票据绑工作区代次与连接 id，未绑连接代次）。按任务书 LWB-013 的原文实现一致、
  按守卫自己「调用进行中」的口径不一致，两种读法都写在偏离项 61；
  本轮按 `NOT_RUN` 记，不自行选一个。**它不是「G2 未通过」的原因** ——
  G2 未通过只有一个原因：子句 (a) 从未在真实网页上跑过。
- 审计记了范围与字节，**没有**记文件版本（无哈希列，偏离项 64）。

---

## 2. P2 的交付与证据（LWB-013 ~ LWB-018）

| 任务 | 状态 | 证据（退出码均为 0） |
| --- | --- | --- |
| LWB-013 文件读取 | DONE | `scripts/evidence/lwb-013.ts` — 44 PASS / 0 FAIL / 4 NOT_RUN |
| LWB-014 目录列举 | DONE | `scripts/evidence/lwb-014.ts` — 30 PASS / 0 FAIL / 4 NOT_RUN |
| LWB-015 本地文本搜索 | DONE | `scripts/evidence/lwb-015.ts` — 26 PASS / 0 FAIL / 5 NOT_RUN |
| LWB-016 只读 Git | DONE | `scripts/evidence/lwb-016.ts` — 118 PASS / 0 FAIL / 5 NOT_RUN |
| LWB-017 MCP 适配器与工具面 | DONE | `scripts/evidence/lwb-017.ts` — 68 PASS / 0 FAIL / 4 NOT_RUN |
| LWB-018 审计、限额与读取验收证据 | DONE | `scripts/evidence/lwb-018.ts` — 40 PASS / 0 FAIL / 5 NOT_RUN / 8 NOTE |

全仓回归：`tests 949 / suites 155 / pass 949 / fail 0`（其中 `tests/windows` 192 例 / 21 套，
真实 NTFS + 真实护栏）；`npx tsc --noEmit` 退出码 0；
`node scripts/check-fsguard-imports.mjs` 检查 122 个文件、未发现绕过。

六项任务各自的 `NOT_RUN` 全部是同一类：**真实 ChatGPT 网页端到端验收**
（以及本机无法构造的场景，如网络盘、云占位、符号链接创建权限）。
没有一项是「跳过了本可以跑的测试」。

---

## 3. 门禁未通过带来的约束（现在生效）

1. **四个能力开关保持全关**：`read_enabled` / `git_enabled` / `proposal_enabled` /
   `direct_write_enabled` 全部 `false`（`apps/daemon/src/gates.ts` 的推导，
   在 P2 证据里以生产装配的原样输出被断言）。
2. **不得进入真实目录开发联调**（方案 §12 与 LWB-018 验收标准 3）：
   本阶段的一切实测都发生在 `tests/fixtures/generated/` 之下。
3. **不提前启用直写**（LWB-018 步骤 4）：五个 `change_*` 工具在 daemon 侧
   **没有实现也没有注册**（`NOT_IMPLEMENTED`，而不是「被开关关掉」）。
4. **不得把 MCP Inspector 的本地成功读成 G2 的一半。**

---

## 4. 让 G2 通过需要什么

| # | 动作 | 谁 |
| --- | --- | --- |
| 1 | 提供真实 ChatGPT 账号与 Secure MCP Tunnel 凭据，完成 LWB-002 | 操作者 |
| 2 | 在真实页面上让模型调用 `file_list` / `file_read`（可加 `text_search` / `git_status` / `git_diff`），确认拿到的内容与夹具/仓库一致 | 操作者 |
| 3 | 用 `scripts/evidence/lwb-018.ts` 的同一组查询核对那次会话的审计：范围、字节、结果码与页面上看到的一致 | 操作者 + 本仓库 |
| 4 | 指定**验收负责人**并签署（`docs/adr/001-scope.md` §6 至今空缺） | 操作者 |

第 4 条不是形式要求：G0 与 G1 今天的状态正是「没有任何人被指定来判断它们过没过」的后果 ——
见下一节。

---

## 5. 前置门禁的现状（读这份判定时必须一起读）

| 门禁 | 条件 | 现状 |
| --- | --- | --- |
| **G0** | 两项 PoC 与身份边界通过 | **未通过**（`docs/PROGRESS.md`「尚未闭合的门禁」）：6 项中只有路径与写入保护有实测证据，其余依赖真实账号与隧道 |
| **G1** | 越界、错身份和伪批准被拒绝 | **无判定记录** —— 本仓库的任何一处都**没有**写过 G1 过没过。P1 的八项任务里七项 DONE（LWB-002 BLOCKED、LWB-004 PARTIAL），相关证据散在 `docs/evidence/lwb-009` ~ `lwb-012`，但从未汇总成一次 G1 判定 |
| **验收负责人** | 有人对「过没过」负责 | **未指定**（ADR-001 §6） |

因此 G2 未通过这件事有两层含义：**它自己没满足**（子句 (a) NOT_RUN），
且**它的上游也悬着**（G0 未通过、G1 无判定记录）。
把这两层混成一句「等网页接上就好了」，会让 G0/G1 那两笔账在 P3 开始之后依然没人认领。

---

## 6. 结论

- **G2：未通过。** 子句 (a) 真实网页读取为 `NOT_RUN`（LWB-002 BLOCKED），
  子句 (b) 内容出站可追踪已由 LWB-018 在真实护栏与真实 NTFS 上证得。
- 门禁未通过对 P3 的影响：**约束 3（不提前启用直写）与约束 2（只用测试根）继续生效**；
  P3 的编辑与审批可以在契约冻结的前提下继续实现，但**不得**在真实仓库上联调。
- 本文件不得被读成「G2 的一半过了所以可以放开一半」。

## 7. 2026-09-27 状态补充：网页元数据通路可用，内容读取仍未验收

本节覆盖 §1.1 中“无真实账号/隧道”的历史前提，不删除当时的判定记录：

- 本机进程树当时可见 `chatgpt-local`、`tunnel-client` 与 MCP adapter 子进程；Chrome 同时有已认证的本机 ConsoleHost 页面。
- 同一 Chrome 中现存的 ChatGPT 对话显示一次网页回复，报告 ChatGPT 已识别一个启用的工作区并读到其元数据；ConsoleHost 也显示该工作区及逐工具授权已保存。这是**既有对话页面的观察**，没有在此补发新请求，且没有独立的 MCP 原始调用日志，因此只作部分网页证据。
- ConsoleHost 的真实 `/api/status` 读数仍是 `read_enabled=false`、`git_enabled=false`、`proposal_enabled=false`、`direct_write_enabled=false`。未观察到 `file_list` / `file_read` / `text_search` 的真实内容返回，也未将网页可见内容与本机审计的文件范围、出站字节逐项核对。

**更新后的判定：G2 仍未通过，但原因不再是“没有账号或隧道”。** 网页连接与工作区元数据通路有部分观察；原文要求的真实网页文件内容读取及出站审计对照仍为 `NOT_RUN`。G0、G1 和验收负责人签署状态也未改变，不能据此打开全局门禁或宣称 G2 通过。

## 8. 2026-09-27：真实 ChatGPT 网页文件读取与搜索（部分验收）

操作者明确要求直接打开门禁并进行网页验收。为完成本次验收，已启动一个**当前进程级**的全开门禁实例；源代码中的 `BRIDGE_GATES` 已恢复为全关默认，因此下次重启会回到默认状态。当前实例报告的 `*_verified=true` 是本次操作员授权的运行时验收窗口读数，**不是**对 G0/G1/G2/G3/G4 的永久签署或发布判定。

ChatGPT 管理页执行 `Refresh tools` 后，在新对话中选择 Local Workspace Bridge，观察到：

| 网页实际调用 | 结果 |
| --- | --- |
| `bridge_status` | `ok=true`；读取、Git、提议、写能力运行时读数为 true；服务未暂停 |
| `workspace_list` | `ok=true`；只返回已授权的「本项目目录」工作区 |
| `file_list`（根层，`depth=0`） | 成功，17 个根条目；`.git`、`node_modules`、`package-lock.json` 被排除；一个被拒绝条目不返回名称；`incomplete=true` 仅因未递归 9 个子目录 |
| `file_read`（`README.md`） | `NOT_FOUND`；根目录没有该文件，未将其描述为读取成功 |
| `file_read`（`package.json`） | 成功；网页实际收到 `name`、`version` 与 `scripts` 内容 |
| `file_search`（`chatgpt:local`） | 成功返回命中路径与短片段；报告 25 个凭据类文件整份排除，没有返回其内容 |
| `change_prepare`（新建根目录临时探针） | 返回 `change_id=chg_14dc10d0-27df-4093-a1b9-54242fe653ae`，状态 `PENDING_APPROVAL`，`workspace_modified=false`；没有调用 `change_apply` |

上述网页结果证明：工具清单刷新后，真实 ChatGPT 已能调用文件列表、文件读取、搜索和提议工具；`package.json` 内容确实经 MCP 返回至 ChatGPT。它**尚不构成 G2/G3 通过**：本次没有完成 Console 本地批准、`change_apply` 与回读，也没有把网页可见内容逐项与本机审计的范围/字节/结果码做关联核对。新 daemon 的一次性本机 Console 会话没有通过当前浏览器自动化建立，提案仍待本机操作者审批；期间工作区文件字节未改变。G0/G1/G2/G3/G4 的正式签署状态不因此改写。
