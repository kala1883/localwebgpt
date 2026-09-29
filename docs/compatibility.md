# 兼容性矩阵

- 版本：v1（对应方案 design-v1.0）
- 日期：2026-09-27
- 关联任务：LWB-004（建立）、LWB-002（外部接入，**PARTIAL；真实内容读写验收未完成**）
- 相关文档：`docs/adr/003-protocol-and-trust.md` §2、`docs/security/threat-model.md`

> **本表只记录实际验证过的组合。** 未验证的组合不写「推测可用」，
> 写「未验证」；不可用的写「不支持」并给出原因。
> 方案 §1.2：「不以 latest 作为可复现交付版本」。

---

## 1. 状态取值

| 取值 | 含义 |
| --- | --- |
| **已验证** | 在本机实际执行过，有证据文件或提交可查 |
| **已锁定** | 版本已固定并安装，但尚未被任何代码使用，因此没有行为证据 |
| **未验证** | 未执行过。**不得**被下游当作已确认 |
| **不支持** | 已知不可用，或设计上排除 |

---

## 2. 运行时与工具链

| 组件 | 版本 | 状态 | 证据 |
| --- | --- | --- | --- |
| Windows | 11 Home China，10.0.26200 | **已验证** | 全部本机测试与证据 |
| Node.js | v22.20.0 | **已验证** | `node --version`；140 条测试通过 |
| npm | 10.9.3 | **已验证** | `npm install` 成功接入 2 个新 workspace |
| TypeScript | 5.9.3 | **已验证** | `npx tsc --noEmit` 退出码 0 |
| tsx | 4.23.15 | **已验证** | 测试运行器与证据脚本的执行方式 |
| better-sqlite3 | 13.0.3 | **已验证** | LWB-006：42 条用例，含 WAL/同步级别的实测核对 |
| zod | 4.6.5 | **已锁定** | 已安装，契约层使用（LWB-005） |
| isomorphic-git | 1.42.2 | **已锁定** | 已安装，**零使用**（LWB-016 才引入） |
| `@modelcontextprotocol/sdk` | 1.30.1 | **已锁定** | 已安装，**零使用**（LWB-017 才引入） |
| PowerShell | 7.6.6 | **已验证** | 原生护栏（LWB-003/010）与受保护存储（LWB-007） |
| .NET | 10.0.12 | **已验证** | `RuntimeInformation.FrameworkDescription` |
| Rust / MSVC / Windows SDK | —— | **不支持** | 本机未安装；见 ADR-002 §5 的过渡方案与替换触发条件 |

**引擎约束**：`package.json` 的 `engines.node >= 22.12.0`。
本工程直接执行 TypeScript 源文件（`tsx` + `node --test`），
daemon 主程序 / 适配器 / 包层与全部测试直接执行 TypeScript；控制台静态页面由 Vite 构建后交给 daemon 同源托管。
这影响了一处设计决策（迁移以 TS 常量而非外部 `.sql` 交付），理由见
`docs/evidence/lwb-006/summary.md` §1。

**例外：控制台（LWB-023 起）有构建步骤。** `apps/console/views/` 与
`apps/console/components/` 是 Vue 3 单文件组件（方案 §10 选定 Vue 3），
需要 Vite 与 `@vitejs/plugin-vue` 编译，由 `vue-tsc` 而不是 `tsc` 检查类型，
并由 vitest 在 happy-dom 里渲染。因此：

| 项 | 状态 | 说明 |
| --- | --- | --- |
| vue | 3.5.43 | **已验证** — LWB-023：41 条渲染用例 |
| @vitejs/plugin-vue | 6.0.9 | **已验证** — 编译两个 SFC |
| vite | 8.3.1 | **已验证** — 生产构建与 daemon 静态资产表 |
| vitest | 5.0.2 | **已验证** — `*.spec.ts` 的第二个测试运行器 |
| @vue/test-utils | 2.5.1 | **已验证** — DOM 断言与事件断言 |
| happy-dom | 20.14.5 | **已验证** — vitest 的 DOM 环境 |
| vue-tsc | 3.3.11 | **已验证** — `apps/console/tsconfig.json` 退出码 0 |

`npm run daemon` 的 `predaemon` 步骤先构建 `apps/console/dist/`；daemon 启动时只装入
固定的 `index.html` 与 `assets/` 文件名表，`GET /` 和资源请求经同一个回环端口返回。
单测直接调用 `startDaemon()` 时默认不装入静态资产，因此 LWB-035 证据装置里的
`/` 404 断言仍描述该装置设置，不代表 CLI 启动路径。

`apps/console/src/` 仍是纯 TypeScript、不依赖 DOM，因此**同时**受根
tsconfig（无 DOM lib）检查 —— 这不是重复劳动，根那份验的是
「这层逻辑不需要浏览器」，而那正是它能在 node 运行器里被测到的原因。

**两套测试运行器**：`*.test.ts` 归 node 运行器，`*.spec.ts` 归 vitest。
按**文件名后缀**分而不是按目录分，是为了让放错地方这件事**响亮地失败**
（详见 `apps/console/vitest.config.ts` 的文件头）。`npm run check`
两个都跑，漏掉一个会让它整体失败。


---

## 3. 外部接入（**基础网页工具链已验证；LWB-002 仍 PARTIAL**）

本节是 LWB-002 的范围。历史进程/读取观察见 `docs/evidence/g2-read.md` §7；
2026-09-29 的真实 ChatGPT 网页验收见 `docs/evidence/live-workspace-grants-20260929.md`：
在新对话中通过 Plugins → Local Workspace Bridge → Try in chat，成功调用 `workspace_list`、
在获授的 `maas_business` 中执行 28.859 秒无文件/网络副作用的命令，并在“本项目目录”对唯一临时
文件完成创建/读取/编辑/回读/删除/NOT_FOUND。它证明当前账号、连接与这两个 workspace 的已授工具
在该次会话可调用；不证明完整搜索/冲突/撤权/重连矩阵、审计范围核对或多账户边界。

| 项 | 状态 | 说明 |
| --- | --- | --- |
| ChatGPT 网页工具发现与 `workspace_list` 元数据 | **已验证（基础）** | 真实新对话调用成功；当前 `workspace_list` 返回名称/legacy flags，但未返回源码已实现的 `granted_tools` |
| ChatGPT 网页文件读取/修改/删除 | **已验证（受控临时文件）** | `file_create`/`file_read`/`file_edit`/`file_delete` 全部返回可核验终态，最后 `NOT_FOUND`，本机再确认路径不存在；不代表大文件或所有编码已测 |
| ChatGPT 网页搜索及内容出站审计 | **未完成** | 真实网页尚未验证搜索覆盖范围与每段内容的审计/脱敏记录关联 |
| Secure MCP Tunnel 的 `tunnel_id` / API key / Platform 权限范围 | **部分已观察** | 真实 ChatGPT→Bridge 调用成功；凭据值和精确 Platform 权限未读取或记录 |
| tunnel-client 在目标 Windows 环境的基本运行 | **已验证（包内）** | runtime 构建固定并校验 `tunnel-client` v0.0.15 的官方 archive hash，包内版本命令成功；活动 daemon 缺 `build_id`，不能把当前进程绑定到该包。睡眠唤醒与断线重连未验证 |
| 协商到的 MCP 协议修订（protocol revision） | **未验证** | `lwb-ipc-v1` 是本地 IPC 标识，不是 MCP protocol revision；本次没有保存原始 `initialize.protocolVersion` |
| 账号写能力 / 网页端命令能力 | **已验证（该账号/该 grant）** | 真实网页在获授 workspace 完成文件生命周期，并在 `maas_business` 执行 28.859 秒命令；不泛化到其他账号/workspace，官方文档冲突仍见 §4 |
| 刷新/断线/重连 | **部分** | 操作者执行 Manage → Refresh tools 后新工具出现；网页新会话调用成功。隧道断线、重连与睡眠唤醒未实测 |

**MCP Inspector 的成功不能替代真实网页验收。** 目前已有真实网页基础读写与命令 smoke，但不能替代搜索/脱敏审计、冲突恢复、拒绝、断线重连和对抗对话验收。

外部账号及隧道权限的精确范围仍未审计；实际工具授权仍由本地连接和逐 workspace/tool grants 决定，不由 G0/G2/G3 诊断字段关闭或打开。若操作者登记 `C:\` / `D:\` 这类固定 NTFS 卷根，授权范围就是整卷，会覆盖同卷内较窄的根授权；工具返回的内容会发送给 ChatGPT。秘密路径和插件自身状态目录仍硬拒绝。

---

## 4. 已记录的官方资料冲突

方案 §1.1 记录了两处，**原样保留，不选边**：

1. **账号写权限范围**：开发者指南写明 Pro/Plus 等网页账号可使用读写工具；
   帮助中心另一篇文章仍将 Pro 描述为读/fetch 范围。
2. **隧道的能力边界**：隧道提供的是**连通性**，不是鉴权系统；
   「私有隧道 + 单用户」不等于「请求可区分」（ADR-003 §4）。

**处理方式**：把冲突当作**证据缺口**保留，用真实账号实测裁决，
而不是从两处文档里挑一处更有利的采信。

---

## 5. 平台能力边界

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 本地 NTFS | **支持** | V1 的唯一目标 |
| UNC / 网络盘 | **不支持** | 方案 §5.1 明确排除 |
| WSL 映射路径（`\\wsl$\…`） | **不支持** | 同上 |
| 云占位 / 同步目录（未验证状态） | **不支持** | 同上 |
| 大小写敏感目录 | **不支持** | 同上；身份判定不依赖大小写 |
| Junction / 符号链接 | **拒绝**（不是「不支持」） | 检测到即报错，不尽力而为（I06） |
| 硬链接（文件链接数 > 1） | **拒绝** | ADR-002：无法证明写入影响唯一对象 |
| FAT32 / exFAT / ReFS | **未验证** | 本机无此类卷；`volume_id + file_id` 语义不同，须先验证 |
| 目录项 fsync | **不支持** | Win32 不支持对目录句柄 `FlushFileBuffers`。实测 `directory_synced: false`，见 `docs/evidence/lwb-007/summary.md` §3.3 |

---

## 6. 内容与编码

| 项 | 状态 | 说明 |
| --- | --- | --- |
| UTF-8（无 BOM） | **支持** | 夹具覆盖 |
| UTF-8 with BOM | **支持** | 写入**必须保留** BOM，不得静默丢弃；夹具 `bom/with-bom.txt`、`edge/bom-only.txt` |
| CRLF / LF / 混合换行 | **支持** | **保留**原样，不静默归一化；夹具 `newline/` 四个样本 |
| UTF-16 / 其它编码 | **不支持**（V1） | `change_items.encoding` 的 CHECK 约束只允许 `utf-8` 与 `utf-8-bom`，未知编码**无法进入可执行计划** |
| 超大文件（> 2 MiB） | **只读、不可编辑** | 夹具 `large/big.txt` = 2 544 000 字节 |
| 超长行 | **有界返回** | 夹具 `edge/long-line.txt` = 9 001 字节单行 |
| 空文件 / 仅 BOM | **支持** | 夹具 `edge/empty.txt`、`edge/bom-only.txt` |
| 中文 / emoji 路径 | **支持** | 夹具 `文档/设计说明.md`、`资料/2026年方案/📄笔记.txt` |

---

## 7. 状态库

| 项 | 取值 | 说明 |
| --- | --- | --- |
| 引擎 | SQLite（better-sqlite3 13.0.3） | 同步 API，与进程模型一致 |
| journal mode | **WAL** | **实测核对**，不是「设置成功」 |
| synchronous | **FULL (2)** | 实测读回核对 |
| `busy_timeout` | 5000 ms | 实测核对 |
| 外键 | **ON**（含只读连接） | 读路径同样受益 |
| 模式版本 | 由迁移常量决定；**高于本程序即拒绝启动** | 不建空库掩盖损坏（A24） |
| 迁移校验和 | SHA-256，**不符即拒绝打开** | 已应用迁移的文本被改动时拒绝 |
| 跨文件事务 | **不存在** | SQLite 的原子提交**不扩展**到用户工作区文件（I11） |

---

## 8. 版本升级与回退

| 场景 | 行为 |
| --- | --- |
| 库的模式版本高于本程序 | **拒绝启动**，报出 `found_version`。不建空库、不降级读 |
| 已应用迁移的文本被改动 | **拒绝启动**，同时给出记录值与重算值 |
| 迁移执行中途失败 | 整体回滚；**不留下半截模式**，也不留下可用空库 |
| 升级后回退到旧版本 | 旧版本会因模式版本过新而拒绝启动——这是**有意**的，避免旧代码按旧语义误读新数据 |
| 卸载 | 删除受保护根即可；**不得**删除未决恢复数据（A25） |

---

## 9. 维护规则

1. 新增依赖时**必须**在 §2 加一行，并注明是「已锁定」还是「已验证」。
2. 任何版本变更都要重跑全量检查并把结果记入 `docs/PROGRESS.md`。
3. 未验证的组合**不得**在其它文档里被引用为已确认。
4. 官方资料发生变化时，**更新本文件**，不改写旧的测试事实（方案 §1.2）。
