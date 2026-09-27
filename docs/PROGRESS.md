# LWB 实施进度

- 更新时间：2026-09-26（**P3 已完成 LWB-019 ~ LWB-030，P4 已开始（LWB-031、LWB-032 完成）**；P0–P2 共 18 项任务到终态：15 项 DONE、2 项 PARTIAL、1 项 BLOCKED，P3 另 12 项 DONE、P4 另 2 项 DONE；**G2 未通过**（`docs/evidence/g2-read.md`）、**G3 未通过**（`docs/evidence/g3-proposal.md`）；P3 按 G2 那份判定的口径推进 ——「可在契约冻结的前提下继续实现，但不得在真实仓库上联调」；**装配根已建立**：`apps/daemon/src/main.ts` + `apps/daemon/src/runtime/`，`npm run daemon` 现在能真正启动（见「当前仓库事实」；四个能力开关仍全关，真实目录联调仍被 G0 挡住）；**提议工具已接入工具面**（`change_prepare` / `change_get` / `change_list`，`IMPLEMENTED_TOOL_NAMES` 7 → 10），两个写工具**按设计仍不挂出去**；**写执行协调器已交付**（`packages/executor/`：物理工作区互斥、短事务认领、租约与接管判定，三条验收标准都在两个**真实 OS 进程** + 真 SQLite 磁盘文件 + 真进程探针上成立），但它**尚未接入工具面**（接线属 LWB-032）、**恢复流程已交付**（LWB-030：`packages/recovery/` 的判定·折叠·编排三件，加 `docs/recovery-playbook.md`）；**受保护的既有文件写入已交付**（`packages/executor/src/native-adapter.ts`：真 Win32 句柄 + 刷盘 + 独立回读核对，三条验收标准都在**真 NTFS** 上成立 —— 冲突不落半个字节、写入期间普通竞争保存被共享模式挡住、回读哈希等于已批准的新哈希），但它**同样尚未接入工具面**；**不覆盖的文本文件创建已交付**（`native-adapter.ts` 的 `vetCreate` + `WinfsGuard.ps1` 的 `Op-CreateFileGuarded`：只用 `CREATE_NEW`、绝不退化成一次覆盖写，三条验收标准都在**真 NTFS** 上成立 —— 三种占位形态与一次真竞争窗口都不覆盖、缺父目录不隐式 `mkdir`、ACL 与属性逐项等于普通方式建的同目录文件），**于是 `create_text` 从「按设计被拒」变成了「能建但同样没有入口」**；**逐条目执行日志与持久化边界已交付**（`packages/executor/src/journal.ts` + `apply.ts`：阶段 A/A2/B/C 四段、`item_intent → item_written → item_flushed → item_verified` 四条写入阶段、有界回滚、跨文件折叠与终局判定，四条步骤都在**真 NTFS + 真 SQLite + 真多进程**的装置上成立；这一轮发现并修掉一处**真实的脱敏漏洞** —— 护栏消息里带着目标的绝对路径，而它经「抛出的 `RECOVERY_REQUIRED` → 协调器终局落账」那条路进过执行日志）；**于是执行器这一侧的五样东西（协调器、改写、创建、日志与折叠、恢复）都已存在** —— 但**仍然不是**「写盘已经可用」：今天**没有任何一条从模型出发的路径**能走到它们（`change_apply` 仍在 `IMPLEMENTED_TOOL_NAMES` 之外，接线属 LWB-032），**恢复流程已交付**（LWB-030），于是那个恒为 `false` 的 `recovery_required` **接上了真查询**（装配根里读 `recovery.requiresRecovery(workspace)`）—— 但它**仍然拦不住任何人**，因为协调器还没接线（LWB-032），没有任何写入路径会去读它；**安全撤销提议已交付**（LWB-031：`packages/changes/src/revert.ts` —— 撤销是**一条新的修改集**而不是把旧的抹掉、逆提案按**当前**字节重算、三种冲突各自明确、新建文件只输出**本地方案**由操作者自己删；三条验收标准都在**真 NTFS + 真 SQLite 磁盘文件 + 真 git 仓库 + 真执行器**的装置上成立，并配**反向探针**把折叠规则逐条改坏验守卫真的会红），但它**同样没有工具面入口**（`change_revert_prepare` 的接线属 LWB-032）；**LWB-002 的隧道侧已按官方说明装好并跑通 `doctor`**（只差操作者在 Platform 上创建 `tunnel_id` 与 runtime key），；**应用工具已接入工具面（LWB-032）—— 契约里的 12 个工具至此全部有实现与输出契约**：`change_apply` 走 `packages/executor/src/apply-service.ts`（控制台「批准并应用」与工具面**共用的唯一实现**，重放与首次应用走同一个函数），因此上面几处「尚未接入工具面 / 接线属 LWB-032」的说法到这一轮**全部作废** —— 写执行协调器、受保护的改写、不覆盖的创建、逐条目日志、启动恢复、撤销提议**都经由这一条路被模型够到了**；但**模型仍然不能自己批准**：唯一的批准来源是 `approvals` 表里那条绑定修改集摘要的一次性记录（I06），而模型侧的 `approved` / `user_id` 连 `change_apply` 的输入 schema 都过不去；**四个能力开关照旧全关**（门禁没通过，工具面因此仍然一律 `POLICY_DENIED`）。这一轮修掉**三处真实缺陷**（回执折错了表 /「执行中重放」掉进认领、答的是一句关于批准的话 / 审计范围表对 `change_revert_prepare` 的本机方案路径取不出来 —— 见偏离项 126–128），其余见 `docs/evidence/platform-capability.md`；**竞争、崩溃与故障专项测试已交付（LWB-033）** —— 竞争五格与故障五格都在真 NTFS + 真第三方动作（`rename` / `rm` / `writeFile`）上成立，并补上本仓库此前缺的那一格「服务退出」的真身（真子进程 + 真 `SIGKILL` + 真启动恢复，两次恢复都写**零个字节**），G4 的判定为**未通过**（`docs/evidence/g4-write.md`）；**安全暂停与紧急停用已交付（LWB-034）** —— `packages/executor/src/pause.ts` 的 `PauseService`（① 落库 → ② 中止在途写入 → ③ 废止排队授权 → ④ 交回**现值现算**的状态）与 `apps/daemon/src/control/pause.ts` 的三个控制操作（`service.pause` / `service.resume` / `service.pause_status`，能力 `service.control`，**不授予模型侧**：模型自己把服务停掉是一次拒绝服务）；「不粗暴杀写进程」落在**不杀进程、只中止意图**上 —— 写盘的手在**自己的**安全边界停下，因此它能把「我停了 / 我写到一半」如实落库，而「已经算好、还没发出的结果」在返回前被工具面拦下（审计里那一行是 `deny` / `REVOKED_BEFORE_RETURN`，措辞是「未发送」而不是「未执行」）；**暂停是落库的**（迁移 v8），重启之后仍然有效（中止信号一出生就是中止的），而恢复**不恢复任何批准** —— 紧急按钮不是一次带副作用的深呼吸；这一轮修掉**一处真实缺陷**（`engage()` 用两口钟写下了同一件事的两个时刻，于是「有人按下停用」会被记成「那条批准本来就过期了」，见偏离项 135）与**一处装置缺陷**（测试夹具的协调器没接上停止源，见偏离项 136）；**首次配置与连接状态界面已交付（LWB-035）** —— `apps/console/src/setup/` 的六个模块（读数与时刻 · 四条腿与「平台能不能被调用」· 门禁与登记表单 · 按下去要说出的五件事 · 脱敏诊断 · 按处境挑选的本地启动帮助）与 `SetupView.vue` / `WorkspacesView.vue` 两个页面，判定全在**纯 TypeScript** 里（仓库的 tsconfig 没有 DOM），`.vue` 只负责摆到屏幕上；**证据第一次接上了真的服务端**：这份证据不是按契约形状合成的探针数据，它启动**生产装配根**、用控制台**自己的**兑换链路换到真会话、用**自己的**客户端在真控制面上登记一个真工作区，再把真响应喂进控制台**自己的**解析与判定 —— 三条验收标准的数据源因此都是真的；**同一份证据把一件必须写下来的事实量了出来**：界面的判定**不是**安全边界 —— 一个真 socket 上的、会说谎的服务器能让它说出「直写：已打开」（§6.1），真正的边界在服务端的门禁常量与能力表上（§3.8 在真服务端上量了那条结构性事实：自报的 21 条路由里没有任何「改门禁 / 改能力开关」的入口）；验收标准 3 的判决点是**同一份全绿读数在一小时之后**既不可调用、本机服务那一格也变成「读数已过期」（判定是**时间函数**，不是值函数）；这一轮发现并修掉**一处真实缺陷**（`GET /api/status` 不回报机器身份，于是验收标准 1 的「当前哪台机器」在真服务端上**永远**是「未知」，而它与「这次读取失败了」长得一模一样 —— 修在服务端并配了回归，见偏离项 140）与**两处装置缺陷**（cookie 的值被当成 `Cookie` 头；一张会话密钥被当作「名字」**打印进了证据** —— 后者留下的是一道结构性防线：拿 `@lwb/contracts` 声明的凭证形状复查每一行打印出去的字，见偏离项 141 / 142）；**差异查看与批准体验已交付（LWB-036）** —— `apps/console/src/changes/` 多出四个模块（复核覆盖 · 逐文件翻页与键盘映射 · 刷新的节奏 · 响应的解析），并把「复核」接成 `approvalAffordance` 的**必填**输入，于是「批准入口能不能出现」在类型上**必然**经过「全都看过没有」：没看全的文件、被截断的差异、服务端说读不到内容 —— 三种情形**都让批准消失而拒绝留下**，而三者各自给出不同的下一步（`UNSEEN_FILES` / `TRUNCATED_DIFF` / `CONTENT_UNAVAILABLE`）；`DiffView.vue` / `ChangeDetailView.vue` / `ChangesView.vue` 三个页面把判定摆到屏幕上，判定全在**纯 TypeScript** 里（仓库的 tsconfig 没有 DOM），`.vue` 只负责显示；服务端这侧新增 `changes.list` / `changes.get` 两条控制操作（**只在控制面上，不在工具面上** —— 模型读修改集走 `change_get`，按 `owner_connection_id` 收窄到它自己提议的那些，而控制台读的是**本机上的**全部），证据仍用 LWB-035 那套装置，**唯一合成的东西是「本机存着一条修改集」这条输入**（四个开关全关，真实模型面产不出一条修改集），而每一句结论都从真 HTTP 响应读出来；这一轮发现并修掉**一处真实缺陷**（`changes.get?path=` 的闸门判定排在两次快照读取**之后**，于是「工作区暂停」被报成 `INTERNAL_ERROR` / HTTP 500 /「本地服务内部错误。」—— 码、状态、以及那句话对操作者的意思**三件一起错**，见偏离项 145）、**一处注释与实现不符**（`groupHunks` 的截断说明写的是一个更安全但没实现的策略，见偏离项 146）与**三处装置缺陷**（一条断言编码了错误模型、两条扫描判定恒真，见偏离项 147 / 148）；**验收标准 2 落在真盘上的一条新用例**（本地点击与工具调用同时发生只写一次，护栏写入调用次数为 1）；七项未执行照旧标 `NOT_RUN`（浏览器键盘走查、读屏软件、真实工作区上的内容读取、网页验收、真仓库联调、真批准并应用、两侧差异渲染的逐字节比对））
- 基线：`docs/LWB_COMPLETE_PLAN.md`（design-v1.0）、`docs/LWB_DEVELOPMENT_TASKS.md`

> 本文件是**实施状态的唯一事实来源**。
> `LWB_COMPLETE_PLAN.md` / `LWB_DEVELOPMENT_TASKS.md` / `LWB_TASKS.json` 三份文档
> 是冻结的设计基线，**不被修改**——把已完成的任务在基线里改标记，
> 会让「设计说了什么」与「实际做了什么」难以区分。

状态取值：`DONE`（已实现并有实测证据）/ `PARTIAL`（部分实现）/ `BLOCKED`（无法在此环境执行）/
`NOT_STARTED`。

---

## 2026-09-27 本轮继续：LWB-037（PARTIAL）

- 已交付恢复与历史页面：apps/console/views/RecoveryView.vue、HistoryView.vue，以及无 DOM 的恢复/历史判定与响应解析模块；恢复页同时展示原版本、提议版本、当前观测版本和审计账本。
- 已接入本地控制面：recovery.list/get/export_snapshot、recovery.keep_current/repropose/authorize/repair、history.list。保留当前与重新提议只落审计、不清除待恢复状态；恢复写入必须经控制台身份、显式确认、一次性授权、服务端重新观测和既有受保护执行器。
- 快照导出已打通：服务端按 operation/item/version 绑定一次性 nonce，只从受保护 BlobStore 读取并核对；响应只回到本地控制台。界面在用户确认后打开浏览器保存选择器，先检查目标不存在，再核对长度与 SHA-256 后写入；目标路径不传给 daemon，每次导出都重新确认。
- 本轮验证 `npm run typecheck`、`npm run typecheck:console`、`npm run check:imports` 均通过。上一轮单元 1279/1279、Windows 307/307、控制台 158/158 的记录属于导出接线前，本轮没有重跑自动化测试。
- 已补同源控制台宿主（LWB-039 的一部分）：`npm run console:dev` 会构建 Vue 页面，再由 daemon 从固定资产表托管；启动链接兑换后由宿主创建控制客户端并接到恢复/历史页面，导出按钮现在可以走完保存选择器、nonce 绑定的快照读取、摘要核对和本机文件写入。
- 已加一次性浏览器验收夹具：`npm run acceptance:lwb037-export` 会用临时受保护存储与临时 NTFS 工作区创建一条“当前内容是第三方版本”的待恢复操作，打印一次性控制台链接并保持服务运行；Ctrl+C 后关闭服务并删除整棵临时目录。它不使用默认 LWB_HOME，也不触碰项目工作区。
- 本轮验证：根/控制台类型检查、FSG 导入护栏和 Vite 生产构建通过；本机 HTTP 静态宿主冒烟读到 `/` 200，页面引用的 JS/CSS 两个资产均 200。Windows/unit/Vitest 全量套件未在这轮重跑。
- LWB-037 仍未记 DONE：还需在真实浏览器里完成下面的导出验收；读屏/键盘走查和真实 ChatGPT 网页验收仍是 NOT_RUN。LWB-039 的睡眠唤醒、隧道重连和显式开机启动仍未实现。

## 2026-09-27 本轮继续：ChatGPT Secure MCP Tunnel 前台启动链（LWB-039 groundwork，PARTIAL）

- 新增 `npm run chatgpt:local`：先构建本地控制台，再启动 daemon；随后以当前进程环境中的 `CONTROL_PLANE_TUNNEL_ID` / `CONTROL_PLANE_API_KEY` 运行 tunnel-client `doctor`，通过后以前台方式运行隧道。
- daemon 提供一个窄的 `mcpAdapterEnvironment()`：只传数据管道名、`conn-chatgpt-web`、适配器版本和 `mcp-adapter` audience 密钥；不把控制台 audience 密钥或启动令牌放入隧道环境。runtime key 通过官方支持的 `env:CONTROL_PLANE_API_KEY` 引用传给 tunnel-client；`run-mcp-adapter.ts` 在导入 MCP 代码前清除 runtime key、`OPENAI_API_KEY` 和 tunnel ID。
- 按已安装 tunnel-client v0.0.15 的 `run --help` / `doctor --help` 实测，启动器使用其支持的 `--control-plane.api-key`、`--control-plane.tunnel-id` 与 `--mcp.command` 参数，不依赖 `.lwb-local` 中仍为占位的 profile。MCP stdio 命令为 `node --import tsx apps/mcp-adapter/src/main.ts`。
- 新增 `docs/chatgpt-tunnel-acceptance.md`，明确区分 ChatGPT 隧道接入与 LWB-037 本地快照保存验收，并给出账号准备、启动、网页添加 Tunnel 和测试步骤。
- 验证：根 TypeScript 检查、FsGuard 导入检查、隧道参数与环境清理单元测试 **3/3 PASS**、控制台 Vite 构建通过。缺少账号凭据时实际运行 `npm run chatgpt:local`，启动器明确报告缺少 `CONTROL_PLANE_TUNNEL_ID` / `CONTROL_PLANE_API_KEY` 并退出，**未启动 daemon / tunnel**。新增的 daemon 凭据传递 Windows 集成断言因已有临时验收 daemon 占用本用户单实例管道而 **SKIP**，尚未取得运行时断言结果。
- **LWB-002 仍 BLOCKED**：Platform tunnel_id/runtime key、Tunnels Read + Use 与 ChatGPT 工作区 developer mode/关联均需账号持有人配置；本机没有真实网页连接。真实 ChatGPT 工具发现、读取、批准写入、回读仍是 NOT_RUN。当前 G0/能力门禁仍关闭，不得用真实工作区试写。
- 完整操作手册：`docs/chatgpt-tunnel-acceptance.md`。本地恢复导出只在原 `lwb037-export` 临时进程中继续验收；两条链路互不替代。

## 2026-09-27 本轮：MCP 工具发现错误修复（基于用户实机证据）

- 用户浏览器返回 424 / 内层 MCP JSON-RPC `-32603`；脱敏终端记录显示 `tunnel-client doctor RESULT ok`、随后 `tools/list` 本地错误码为 `CONNECTION_DISABLED`。Doctor 对 stdio 目标本来就标记网络探测 `SKIP`，所以 Doctor 通过并不证明 MCP 工具清单可用。
- 原因：daemon 首次登记模型连接时默认 `enabled=false`；工具目录 IPC 操作也经过连接启用守卫。以前同源恢复/历史 ConsoleHost 没有连接控制页，ChatGPT 初次拉取 tools/list 就失败。
- 修复：`ConsoleHostView` 新增“ChatGPT 连接”页，列出本机模型连接；启用需本机已认证控制台、明确复选确认及一次性 nonce；停用仍可随时操作。控制面继续执行 `connections.manage`、审计与 CSRF/nonce；不改 G0、能力 flags 或 workspace grants。
- 已更新 `docs/chatgpt-tunnel-acceptance.md`：daemon+tunnel 启动后，先在本机 ConsoleHost 启用模型连接，再回 ChatGPT 重试 Create。ChatGPT Authentication 选 No authentication / None 是因为本地适配器无 OAuth 授权服务器；这不授予工作区权限。
- 验证：根/控制台类型检查、FsGuard 导入检查通过；ConnectionView 定向 UI 测试 **2/2 PASS**；生产构建成功。真实 ChatGPT Create/工具发现尚未重试；重启 daemon 以加载新静态页面后，需用户从本机一次性控制台链接执行启用，再回网页重试。真实 workspace 读写仍被 G0 门禁关闭。

## 2026-09-27 本轮：启动说明凭证清理

- `启动命令.md` 曾包含一段符合 OpenAI API project-key 格式的明文凭证；现已替换为调用安全交互式启动脚本，不含 key 或 tunnel ID。工作树扫描未发现其他符合高置信度模式的完整 key 值。
- 只在一个本地 Git 历史提交中找到该前缀；当前本地 refs 未显示远程分支包含该提交，但不能据此证明它从未推送。凭证是否有效未知，应由账号持有人在 OpenAI Platform Security settings 撤销并轮换；本轮不改写 Git 历史。
- 新增 `scripts/secret-scan.ts` / `scripts/check-secrets.ts`，接入 `npm run check:secrets` 与根 `npm run check`；只报文件/行号/类型、不回显匹配内容。模式单测 **3/3 PASS**，当前工作树扫描 PASS；明确不扫描 Git 历史。

## 2026-09-27 本轮：Windows CI 基线

- 仓库此前没有 `.github/workflows`。新增 `windows-checks.yml`：只读 `contents` 权限，固定 Actions commit，Windows runner 使用 Node 22.22.2，生成 NTFS 测试夹具后运行完整 `npm run check`（包含 secret scan）。关闭 npm cache，避免为提速引入共享缓存面。
- 工作流尚未推送/运行；本机只完成 YAML 文本差异检查，远端 GitHub Actions 结果仍未验证。

## 2026-09-27 本轮：控制台逐目录 MCP 工具授权

- 同源 ConsoleHost 新增“工作区与工具授权”页：可登记目录/单文件，并为每个根分别配置 ChatGPT 的目录列表、文件读取、文本搜索、Git 只读及修改提议工具；空选保存会撤销该根的 ChatGPT 访问。新登记默认不附带任何模型授权。控制台 URL 使用启动时打印的一次性本机链接；本机本次观察到的实际端口是 **5339**，不是产品契约固定端口。
- 新增本地控制面 `workspaces.access.list/set`：固定目标为 `conn-chatgpt-web`，模型通道不能调用；服务端拒绝 `apply` / `control` 等控制权限、未知或重复能力、已移除根，以及只读根上的提议权限。变更继续经过 CSRF + 内容绑定的一次性 nonce，并写审计记录。
- 本机 Chrome 的现存 ConsoleHost 页面读回 **1 个启用工作区**，页面显示目录列表、文件读取、文本搜索、Git 只读和修改提议五项授权已保存；同页全局 `read_enabled` / `git_enabled` / `proposal_enabled` / `direct_write_enabled` 仍全为 `false`。同一 Chrome 中既有的 ChatGPT 对话历史显示此前网页已取得该工作区的 `workspace_list` 元数据；这是既有对话记录观察，不是本轮重新发起的 MCP 调用。**没有文件内容读取、搜索、提议或写入发生。**因此网页连接与工作区元数据链路有部分真实观察，G0/G2/G3 仍未通过，LWB-002 的“读—写—回读”验收仍未完成。
- 真实浏览器观察发现界面曾把“根的提议模式”直接描述为“允许模型提出修改”，忽略 per-root grant、ChatGPT 连接启停与全局 `proposal_enabled`。现已修正风险说明及暴露摘要：只有连接启用、工作区启用、该根 grant 与相关全局能力门禁全部满足时，才把该根计入当前可调用；已保存提议 grant 与当前可用能力分开显示。G4a 新增回归覆盖“有提议 grant 但全局门禁关闭”。
- 本轮验证：根/控制台类型检查、Vite 生产构建、FsGuard 导入检查、secret scan 均通过；逐目录服务端授权 **4/4 PASS**、视图模型 **55/55 PASS**、控制面烟测 **2/2 PASS**、ConsoleHost 接线 **1/1 PASS**、工作区授权视图 **27/27 PASS**。最终 `npm run check`：主测试 **1758 项 / 1745 PASS / 0 FAIL / 13 SKIP**；控制台 **164/164 PASS**。
- 当前用户的 daemon/tunnel 进程仍在运行；本轮没有停止或重启它。刚修正的暴露摘要已构建并经测试，但当前浏览器页可能仍载入进程启动时的旧静态资源，需在计划好的服务重启后再核对新文案。真实文件读取与写入验收仍 NOT_RUN，权限设置不等同于打开门禁。

## 2026-09-27 本轮：读取门禁状态说明校正

- 核对确认 `read_enabled` 不是 grant 表里的可写字段：生产值由 `g0_platform_verified && compatibility_section3_passed` 推导；逐目录 grant 只能授予具体工具，不能越过全局门禁。G0/兼容性仍为 `false`，所以读取仍未打开。
- 修正 `bridge_status.limitations` 与首次配置页中过时的“网页端发现/调用未经验证”措辞；现在区分 `bridge_status` / `workspace_list` 的元数据通路已有部分观察，与真实文件内容读、专用测试目录写入回读、身份边界和断连重连等完整验收尚未通过。没有改动 `BRIDGE_GATES` 常量或用户授权。
- 回归验证：`gate-combinations.test.ts` + `console-setup.test.ts` **61/61 PASS**，SetupView **30/30 PASS**，bridge_status 限制说明定向用例 **1/1 PASS**；根/控制台类型检查及 Vite 构建通过。修改未触发新的文件内容读取。
- bridge_status 限制说明另补兼容性 §3：它与 G0 一样参与读取/Git/提议的全局开关推导；不只报告元数据链路的部分成功，也点名当前第二个阻断条件。

## 2026-09-27 本轮继续：LWB-039 隧道子进程恢复（PARTIAL）

- `chatgpt:local` 现在监督长驻 `tunnel-client run`：子进程意外退出后按 1/2/5/10/30/60 秒退避，重启前重新运行 doctor；doctor 失败时停止，不带错误凭据无限重试。
- 恢复只重启 tunnel-client 子进程，保留同一个 daemon/执行器实例；Ctrl+C 可中断退避并按原有 finally 关闭服务。单实例防护和授权/审批检查仍由 daemon 原有边界负责。
- 新增 3 项监督器单测：退避重连、doctor 失败停止、退避封顶。真实睡眠/唤醒、操作系统网络恢复与长期运行还未实测；每用户启动器与开机启动也未实现，所以 LWB-039 仍为 PARTIAL。
- 增加一体化 `packaging/windows/Start-LocalWebGPT.ps1`：隐藏输入 runtime key 并启动同一前台链；新装连接停用时，daemon 等待本机 Console 的显式确认，确认后才跑 doctor 和 Tunnel。等待走现有连接控制 API/审计链，不直改数据库，也不创建 workspace grants。
- 新增两条连接等待/取消单测；本轮根类型检查、启动器测试 **9/9**、ConnectionView 测试 **2/2**、FsGuard 导入检查（212 文件）通过。源码目录启动脚本做了假 tunnel ID + 空 key 冒烟，按预期在启动 daemon 前拒绝；两个 PS1 均解析通过。真实终端—浏览器—Tunnel 的联动尚未重启验收。
- 首次配置页新增折叠式门禁说明，区分 G0 平台接入、G2 只读/出站审计、G3 提议/审批与实际运行时开关；说明启动或连接启用都不授予目录。setup 页面测试 **30/30 PASS**，控制台类型检查通过。

## 2026-09-27 本轮继续：LWB-040 升级拒绝保护证据（PARTIAL）

- 加强“较新 schema 由旧程序打开时拒绝启动”的回归：不仅断言 `STORAGE_UNAVAILABLE`，还在拒绝前后逐字节比较状态库，证明旧程序没有迁移、截断或重建较新数据库。
- 新增 `packaging/windows/build-runtime.ps1` 与 `docs/install-and-upgrade.md`：要求用户指定仓库外的新输出目录；拷贝运行树而不带 `.git`、完整 `node_modules`、本机 profile/凭据；验证官方 tunnel-client 压缩包 SHA-256 并提取许可证；在输出目录安装锁定依赖、核对 SQLite Windows x64 预编译二进制摘要、运行两层类型检查、FsGuard 导入检查、控制台生产构建和原生 SQLite smoke。
- 2026-09-27 在全新仓库外 staging 对完整 `build-runtime.ps1` 重跑：Node **v22.20.0** 下 `npm ci --ignore-scripts` 安装 252 个包；根/控制台类型检查、214 文件导入检查、40 模块 Vite 生产构建、校验过的 tunnel-client **v0.0.15** 和 better-sqlite3 原生 SQLite smoke 均通过。npm 对 `abbrev` / `nopt` 仍有两条非阻断 `EBADENGINE` 警告（CI 固定用 v22.22.2）。之后在 staging 执行 `npm run chatgpt:local`，将 tunnel 变量仅在该 PowerShell 子进程设为空，脚本按预期 exit 2，daemon/tunnel 均未启动。构建输出保留于 `%TEMP%\LocalWebGPT-runtime-validation-42392e46642b4cc2aa29f31d874ef954` 以供复核；系统拦截了自动清理仓库外目录的尝试，未重试删除。
- LWB-040 仍未完成：升级前备份/恢复流程、schema 升级兼容策略、卸载与状态保留语义、签名安装器均未实现或验收。

## 2026-09-27 本轮继续：启动凭据改为项目根 `.env`

- `packaging/windows/Start-LocalWebGPT.ps1` 不再交互询问凭据；从运行根目录 `.env` 读取现有键名 `tunnel_id` / `runtime_API_key`，并兼容规范环境名。重复、缺失、格式错误均在启动前拒绝，错误文本不包含配置值；调用前的 PowerShell 环境变量在脚本退出时恢复。
- 更新启动、安装和隧道验收说明。打包流程继续排除 `.env`；用户需在打包 runtime 根单独创建，防止凭据进入产物。
- `.env` 当前在本机存在且被 Git 忽略；本轮仅核对了变量名，没有读取、展示或暂存变量值。
- 验证：`-ValidateOnly` 退出码 0 且只报告通过；启动契约 **10/10 PASS**；secret-scan 回归 **4/4 PASS**；完整 `npm run check` 为主测试 **1760 / 1747 PASS / 0 FAIL / 13 SKIP**、控制台 **164/164 PASS**；`git diff --check` 通过。未重启真实 daemon/tunnel。
- 推送前安全阻断：本地未推送历史提交 `805a9aa` 的 `启动命令.md` 含一个 key-shaped 凭据；后续提交虽已从当前文件移除，历史对象仍保留。当前 `.env` 凭据与该值经本机单向摘要比较为不同；远端目前只有 `origin/main` 且不包含该提交。**不得直接推送原分支历史**；旧凭据应在 Platform 撤销，之后需由操作者选择保留提交历史的本地脱敏重写，或使用 squash 到 `origin/main` 的无泄漏集成提交。

## 2026-09-27 本轮继续：ChatGPT 网页文件读取/搜索验收（PARTIAL）

- 操作者要求直接打开并网页验收。当前运行中的 daemon 以全开门禁完成本次会话；`apps/daemon/src/gates.ts` 已恢复全关源代码默认，下次重启会关闭。运行时 `*_verified=true` 是本次验收窗口授权读数，不是 G0/G4 正式签署。
- ChatGPT 的 Local Workspace Bridge 管理页刷新工具后，网页真实调用 `bridge_status`、`workspace_list`、`file_list`、`file_read`、`file_search` 和 `change_prepare`。根目录列表 17 项；`README.md` 不存在而如实 `NOT_FOUND`；`package.json` 被实际读取；`chatgpt:local` 搜索命中；25 个凭据类文件被整份排除，未读取 `.env`。
- 网页准备的临时 CREATE 提案 `chg_14dc10d0-27df-4093-a1b9-54242fe653ae` 为 `PENDING_APPROVAL`，`workspace_modified=false`，没有 `change_apply`。Console 会话需由操作者在 Chrome 手动打开新启动终端打印的一次性链接；浏览器自动化拦截新本机端口。**G2 内容读取可记为真实网页 PASS 证据，但整体 G2 仍未通过**（审计/出站字节关联未核对）；写入闭环未完成，未声称 G3/G0/G4 通过。

## 阶段 0

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| LWB-001 冻结范围、风险边界与验收样例 | PARTIAL | `docs/adr/001-scope.md`（范围/排除项/默认限制/不变量→验收→测试映射）、`tests/fixtures/`（21 个确定性夹具，含中文路径/BOM/CRLF）；**验收负责人未指定**（ADR-001 §6），因此不记 DONE |
| LWB-002 真实 ChatGPT 网页接入与 Secure MCP Tunnel | **PARTIAL** | 历史安装证据见 `docs/evidence/platform-capability.md`（tunnel-client **v0.0.15** 与官方 SHA-256）；2026-09-27 本机进程树可见 `chatgpt-local` / `tunnel-client` / MCP adapter 子进程，Chrome 的本地 ConsoleHost 已认证，既有 ChatGPT 对话可见 workspace-list 元数据回复（限制与判定见 `docs/evidence/g2-read.md` §7）。真实网页的文件内容读取、人工批准写入与回读、断连重连、身份边界签署仍未完成；全局能力门禁仍关闭。 |
| LWB-003 原生句柄护栏技术与崩溃语义验证 | DONE | `docs/adr/002-writer-semantics.md`、`docs/evidence/lwb-003/`、`native/winfs-spike/` |
| LWB-004 协议、信任边界、威胁模型与兼容性文档 | PARTIAL | `docs/adr/003-protocol-and-trust.md`、`docs/security/threat-model.md`、`docs/compatibility.md`、`docs/adr/README.md`；**步骤 1 只完成了一半**——本机工具链版本已锁定并实测，但**协议修订与 tunnel-client 版本无法锁定**（依赖 BLOCKED 的 LWB-002）。**G0 未通过** |

## 阶段 1

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| LWB-005 工程骨架、契约层与静态检查 | DONE | `packages/contracts/`、`scripts/check-fsguard-imports.mjs`、`scripts/run-tests.mjs` |
| LWB-006 SQLite 模型与迁移 | DONE | `packages/persistence/`、`tests/unit/persistence.test.ts`（42 例）、`docs/evidence/lwb-006/summary.md` |
| LWB-007 受保护存储与凭证管理 | DONE | `packages/secure-store/`、`packages/blob-store/`、`tests/unit/{secure-store,blob-store}.test.ts`（45+22 例）、`docs/evidence/lwb-007/summary.md`；**机制层回归后补**：`tests/windows/secure-store-acl.test.ts`（5 例，真实 pwsh 助手 + 真实 NTFS）—— 原先的 45 例全部走替身，判定层覆盖到了而机制层一次没跑过，一个只有真跑才暴露的缺陷因此存活至今，见偏离项 96 |
| LWB-008 本地 IPC 与 daemon 生命周期 | DONE | `packages/ipc/`、`apps/daemon/src/lifecycle/`、`tests/unit/{ipc,lifecycle}.test.ts`（45+10 例，含真实命名管道与真实 pwsh 助手）、`docs/evidence/lwb-008/summary.md` |
| LWB-009 工作区注册、身份校验与代次 | DONE | `packages/workspaces/`、`apps/daemon/src/control/workspaces.ts`、`native/winfs/src/ops.ts`（`statVolume`）、`packages/persistence/`（迁移 v2）、`tests/unit/workspaces.test.ts`（63 例）、`tests/windows/workspaces-roots.test.ts`（4 例，真实 NTFS + 真实护栏）、`docs/evidence/lwb-009/summary.md`；**4 项本机无法构造的场景（网络盘/云占位/非 NTFS/祖先级 Junction）已显式标记 NOT_RUN** |
| LWB-010 路径安全与文件身份防护 | DONE | `native/winfs/path_guard/`（共享语料 83 条 + 边界侧语法实现）、`tests/windows/path-escape/`（114 例：两侧逐例比对 85 + 别名逃逸 11 + 并发交换 8 + 资源释放 10）（真实 NTFS + 真实护栏）、`docs/evidence/lwb-010/summary.md`；**符号链接一项本会话无权限创建，已显式标记 NOT_RUN**（Junction 走同一段重解析点判定，已实测） |
| LWB-011 策略引擎与出站内容预算 | DONE | `packages/policy/`（硬拒绝/搜索排除两份独立规则表、五层能力交集、只能收窄的豁免）、`packages/egress/`（出站闸门、两档秘密检测、每连接滑动窗口预算）、`packages/contracts/src/errors.ts`（新增 `SECRET_DETECTED`）、`tests/unit/{policy,egress}.test.ts`（65+50 例）、`docs/evidence/lwb-011/summary.md`；**搜索（LWB-015）与 Git 差异（LWB-016）的真实调用点当时尚未实现，该调用点接线必须在这两项任务里另行取证**，本任务只证到闸门层；**搜索侧的接线已由 LWB-015 补齐并经真实磁盘取证**（`packages/search/src/scan.ts` 只经 `emitContent` 出片段），**Git 差异侧已由 LWB-016 补齐并经真实磁盘取证**（`packages/git-reader/src/diff.ts` 的 hunk 只经 `emitContent` 出站） |
| LWB-012 本地控制面与操作者认证 | DONE | `apps/daemon/src/control/`（`origin.ts` 来源判定、`session.ts` 启动令牌/会话/CSRF/一次性 nonce、`routes.ts` 注册期能力断言、`server.ts` 0–7 号闸门、`control-plane.ts` 由能力表推导路由）、`apps/console/src/auth/`（框架无关的控制台认证层）、`packages/contracts/src/control.ts`（凭证形状唯一定义）、`packages/egress/src/secrets.ts`（第 15 条规则 `control-plane-token`）、`tests/unit/control-plane.test.ts`（74 例）、`docs/evidence/lwb-012/summary.md`；**控制台界面属 LWB-035，本任务只交付其认证层**；**真实浏览器与 ChatGPT Web 端到端验收均为 NOT_RUN** |

## 阶段 2

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| LWB-013 文件读取 | DONE | `packages/files/src/{decode,read-token,read}.ts`、`tests/unit/files-read.test.ts`（45 例，磁盘用桩）、`tests/windows/files-read.test.ts`（14 例，真实 NTFS + 真实护栏）、`scripts/evidence/lwb-013.ts`、`docs/evidence/lwb-013/summary.md`；**真实 ChatGPT Web 端到端读取验收为 NOT_RUN**（依赖 BLOCKED 的 LWB-002）；**采集过程中发现并修复了一个真实缺陷**：护栏的 `resolvePath` 不返回规范拼写，使真实路径上的读取全部失败（见偏离项 19） |
| LWB-014 目录列举 | DONE | `packages/files/src/{guard-bridge,list}.ts`（读写共用的边界规则从 `read.ts` 中拆出）、`packages/files/src/read-token.ts`（`lwblc_` 前缀的列举游标）、`native/winfs/WinfsGuard.ps1`（`listDirectory`：ordinal 有序、`after_name` 可续、常驻内存有界、重解析点不 stat）、`tests/unit/files-list.test.ts`（32 例，磁盘用桩）、`tests/windows/files-list.test.ts`（21 例，真实 NTFS + 真实护栏 + 真实 junction）、`scripts/evidence/lwb-014.ts`、`docs/evidence/lwb-014/summary.md`；**真实 ChatGPT Web 端到端列举验收为 NOT_RUN**（依赖 BLOCKED 的 LWB-002）；**采集过程中定位并修复了两处真实缺陷**：护栏拒绝「解析目录工作区的根」使真实目录上的根列举全部失败，以及单文件工作区把判决路径当回执路径（见偏离项 29 / 30） |
| LWB-015 搜索 | DONE | `packages/search/src/{query,walk,scan,search}.ts`（字面量查询、有界有序可续的候选发现、单文件扫描、入口与覆盖范围）、`packages/contracts/src/search.ts`（`text_search` 契约）、`packages/files/src/read-token.ts`（`lwbsq_` 前缀的搜索游标 + `assertSearchCursorMatches`）、`packages/files/src/guard-bridge.ts`（列举与搜索**共用**一份游标锚点判定：两条路径各写一遍 `..` 检查，迟早会在某一处漏掉分支）、`tests/search/{query,walk,scan,text-search}.test.ts`（20+14+27+21=82 例，磁盘用桩）、`tests/windows/files-search.test.ts`（6 例，真实 NTFS + 真实护栏 + 真实 junction + 越过护栏目录窗口的大目录）、`scripts/evidence/lwb-015.ts`、`docs/evidence/lwb-015/summary.md`；**真实 ChatGPT Web 端到端搜索验收为 NOT_RUN**（依赖 BLOCKED 的 LWB-002）；**采集过程中发现并修复了一处真实缺陷**：整文件预筛与逐片预筛的边界夹具第一版只做了前边界，两个判定都是 `false` —— 那条用例当时测的是「没有凭证的文件」（见偏离项 34 与 `docs/evidence/lwb-015/summary.md` §4.1）；**两处测试用例起初因错误的原因通过**（夹具的页大小让见证条目落在别的文件上 / 空结果上的空断言），已各加一条装置前提并做了反向验证 |
| LWB-016 只读 Git | DONE | `packages/git-reader/src/{meta-fs,status,diff,preflight,text-diff,layout,limits,index}.ts`（只读虚拟 fs：写方法全部拒绝 + 账本非空即整次失败；`.git` 内部窄范围清单；行解码 15 种可达组合、9 种不可达报错；原始字节语义的三处比较）、`packages/contracts/src/git.ts`（+78：契约与 `policy_hidden_count` 的语义）、`packages/contracts/src/limits.ts`（+40：`MAX_GIT_*`）、`native/winfs/src/helper-client.ts`（+58：助手死亡时的失败语义，见偏离项 44）、`tests/git/git-reader.test.ts`（49 例，磁盘用桩）、`tests/windows/git-reader.test.ts`（11 例，真实 NTFS + 真实护栏 + 真实 `.git` + 夹具仓库）、`scripts/evidence/lwb-016.ts`（118 PASS / 0 FAIL / 5 NOT_RUN）、`docs/evidence/lwb-016/summary.md`；**真实 ChatGPT Web 端到端 Git 验收为 NOT_RUN**（依赖 BLOCKED 的 LWB-002），**MCP 工具面属 LWB-017**；**LWB-011 遗留的「Git 差异侧出站调用点未接线」已在本任务闭合**（likely 档在 hunk 行里现身、certain 档整块阻断）；**采集过程中发现并修复了一处会 100% 触发的真实缺陷**：库在遍历根节点上拼出 `<根>/.`，凡是把 `.` 段判为非法的实现都会让 `git_status` 在任何仓库上失败（见偏离项 45） |
| LWB-017 MCP 适配器与工具面 | DONE | `apps/daemon/src/tools/{index,handlers,operations,catalog,access,errors}.ts`（装配、处理器、操作表、可用性清单、授权链、错误消毒；`change_*` 不实现也不挂出）、`apps/daemon/src/gates.ts`（门禁与能力开关推导，**默认全关**）、`apps/mcp-adapter/src/{main,server,surface,config}.ts` + `stdio/guard.ts`（先保护 stdout 再读配置、清单只来自本地契约、转发与翻译）、`packages/contracts/src/{tool-outputs,tool-catalog,wire-shape}.ts`（七个工具的输出 schema 与**成功/失败两种信封**、编译期双向核对）、`tests/unit/daemon-tools.test.ts`（34 例）、`tests/unit/mcp-adapter.test.ts`（31 例，真 MCP 客户端 + 内存传输）、`tests/windows/mcp-adapter-e2e.test.ts`（10 例，真进程 + 真命名管道）、`scripts/evidence/lwb-017.ts`（68 PASS / 0 FAIL / 4 NOT_RUN，全部在**真实护栏 + 真实 NTFS** 上跑）、`docs/evidence/lwb-017/summary.md`；**真实 ChatGPT Web 端与 MCP Inspector 的验收为 NOT_RUN**（依赖 BLOCKED 的 LWB-002）；**采集过程中发现并修复了一处真实缺陷**：适配器拿**成功**信封的 schema 去解析 daemon 的失败返回，使每一次业务失败（策略拒绝、未授权、超限）都被折成 `INTERNAL_ERROR`「本地服务内部错误」——真实答案是「被拒绝了」，排查方向被引到反的方向（见偏离项 48，含变异验证：改回那行有 4 条用例立刻失败） |
| LWB-018 审计、限额与读取验收证据 | DONE | `packages/audit/`（`record.ts` 写事件+文件范围、`ranges.ts` 从结果里提取范围、`screen.ts` 补充信息白名单筛查**不合格即抛**）、`packages/limits/`（`overrides.ts` 限额叠加与方向校验、`concurrency.ts` 并发闸门）、`apps/daemon/src/tools/guard.ts`（七步：暂停 → 并发位置 → 前像 → 处理器 → 返回前复查 → 写审计 → 释放）、`apps/daemon/src/control/connections.ts`（`connections.list/pause/resume`，能力 `connections.manage`）、`packages/persistence/`（迁移 v3：`audit_events` 增 `request_id`/`tool`/`bytes_out`、新表 `audit_file_access`）、`packages/ipc/src/audience.ts`（新能力四处装配期断言）、`packages/contracts/src/limits.ts`（`NON_RELAXABLE_LIMITS` → `TIGHTEN_ONLY_LIMITS` 并修正语义，见偏离项 28）、`tests/unit/daemon-audit.test.ts`（47 例）、`scripts/evidence/lwb-018.ts`（40 PASS / 0 FAIL / 5 NOT_RUN / 8 NOTE，真实护栏 + 真实 NTFS + 生成出来的夹具仓库）、`docs/evidence/lwb-018/summary.md`、**`docs/evidence/g2-read.md`（G2 判定：未通过）**；**G2 的另一半「真实网页读取」为 NOT_RUN**（依赖 BLOCKED 的 LWB-002），因此**不得**读成只读阶段已验收；**一条判定悬置**：连接暂停→恢复后、暂停前签发的游标仍可用（票据绑工作区代次与连接 id，未绑连接代次）—— 按任务书 LWB-013 的原文与实现一致，按守卫自己「进行中」的口径则不一致，两种读法都记在偏离项 61，本轮按 `NOT_RUN` 记而不自行选一个；**采集过程中发现并修复了两个真实缺陷**：新加的审计补充信息键未进白名单，使一次并发拒绝被记成 `STORAGE_UNAVAILABLE`（把业务拒绝说成基础设施故障），以及守卫自身的异常会逃到 IPC 兜底路径、把本机排障文本（`The database connection is not open`）送给模型（见 `docs/evidence/lwb-018/summary.md` §4.1 / §4.2）；**第三个是证据脚本自己的错**：手写的空 `workspace_id` 让「读完再撤权」这个窗口一次都没被走到，而两条断言照样报了结果（§4.3） |

---

## 阶段 3

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| LWB-019 精确文本编辑契约 | DONE | `packages/changes/`（新包：`edit-contract.ts` 提案 vs **票据**——路径/票据/基线声明/行区间形状/同一文件不得出现两次；`text-engine.ts` 提案 vs **基线字节**——逐行精确匹配、按原字节切片拼装、重新识别产物并核对不变量；`index.ts` 写明为何分成两个文件）、`packages/contracts/src/limits.ts`（新增 `MAX_EDITS_PER_FILE = 500` 并入 `OPERATOR_TUNABLE_LIMITS`）、`packages/contracts/src/tools.ts`（`edits` 上限改用同一个常量）、`tests/unit/changes-edit.test.ts`（57 例 / 7 组）、`scripts/evidence/lwb-019.ts`（**60 PASS / 0 FAIL / 7 NOT_RUN / 33 NOTE**，真实夹具字节 + 真实 NTFS 身份 + 真硬链接）、`docs/evidence/lwb-019/summary.md`；**没有任何一次写入发生在真实工作区上**（G2 未通过，P3 门禁）；**三处自己的错误预期被实跑纠正**并留在证据里：首尾相接的区间其实**允许**（二义只在零长度插入点上）、`inspectBytes` 的 `text` **不含** BOM（BOM 单独报成 `bom:true`）、可编辑语料要按**策略层**筛而不是按夹具清单的 `editable` 字段（`config/.env.example` 在清单里是 `editable:true`，而 `HD-ENV` 连读都硬拒绝它）；**一处真实缺陷被修掉**：`ChangeValidationContext.max_editable_file_bytes` 是声明了却没人用的死选项，已接上 `SIZE_LIMIT_EXCEEDED/FILE_TOO_LARGE_FOR_EDIT`（偏离项 68） |
| LWB-020 不可变修改集与差异预览 | DONE | `packages/changes/src/digest.ts`（新：长度前缀逐字段编码的规范化摘要、请求指纹、短核对编号）、`packages/changes/src/prepare.ts`（新：重读 → 票据复核 → 逐字节产物 → 快照库 → 落库 → 预览；**源码里不出现任何写方法名**）、`packages/changes/src/index.ts`、`tests/unit/changes-prepare.test.ts`（56 例 / 7 组）、`scripts/evidence/lwb-020.ts`（**57 PASS / 0 FAIL / 9 NOT_RUN / 36 NOTE**，真实夹具副本 + 真实 NTFS 身份 + 真实护栏）、`docs/evidence/lwb-020/summary.md`；**验收 1「不改变工作区任何文件」有三条互相独立的证据**（运行期护栏写方法调用 0 次 / `prepare.ts` 源码静态扫描 0 处 / 整棵目录树 138 项逐字节快照含 mtime 与目录项增删）；**验收 2 的摘要在两个独立时点被重算**（第二条连接、以及关库重开后，都只凭落库的行重算，逐字符相同）—— 这是「批准绑定摘要」在执行那一刻仍然成立的前提；**验收 3 是三方一致**（预览声明 == 快照库实际字节 == 独立拼装的产物），两方比对会让「两方一起错」读成一致；`approved:true` / `user_id` / `conversation_label` 三个反模式字段实测**不产生任何批准**；**一处真实缺陷被发现并修掉，且是单元测试结构上抓不到的那种**：`requireCreatable` 拿 `parent = ''` 去探护栏，使「在工作区根下新建文件」全部报 `PATH_UNSAFE`（夹具桩对空相对路径是宽松的，故快速层永远看不见，见偏离项 71） |
| LWB-021 本地批准与拒绝 | DONE | `packages/approvals/`（新包：`gate.ts` 执行前门禁**只判定不消费**、与 `@lwb/policy` 的 `approvalFailures` 逐条对齐；`reload.ts` 由落库事实重载并重算摘要；`decide.ts` 批准 / 拒绝 / 批准并排队）、`apps/daemon/src/control/approvals.ts`（三个控制操作：`approvals.list` 只读、`approvals.reject`、`approvals.approve_and_apply`）、`packages/persistence/`（迁移 v5：`approvals` 增 `root_generation` / `policy_version` 两个绑定列与两条约束）、`tests/unit/approvals.test.ts`（36 例 / 6 组，A 重载 · B 决定 · C 门禁 · D 批准并应用 · E 模型不可批准 · **F 控制操作处理器**）、`tests/unit/control-plane.test.ts`（装配断言随控制操作增至 14 条而更新）、`scripts/evidence/lwb-021.ts`（**51 PASS / 0 FAIL / 6 NOT_RUN / 9 NOTE**，真实回环控制面 + 真实会话/CSRF/一次性 nonce + 真实 SQLite + 真实夹具副本）、`docs/evidence/lwb-021/summary.md`；**本任务交付到「排队」为止** —— 全部采集里没有任何一次批准被消费、也没有任何一次落盘（执行协调器 LWB-026 尚未装配），`workspace_modified` 恒为 `false`；**三条验收标准都是否定性断言**，因此证据的做法是「真的做那件事，然后数行数」（第二条独立连接 `SELECT COUNT(*)`），摘要的重算走的是**另一条独立代码**（`reloadChangeSet`）而不是同一个函数调两次；**两处真实缺陷被发现并修掉**：(a) `screenMetadata` 的键名白名单不含 `recordDecision` 用的任何键，使**每一次**批准/拒绝都在决定提交之后抛错、HTTP 折成 500 —— 操作者看到报错而修改集其实已排队（最坏的那种形态），且 A–E 组因为直接调包 API、从不经过处理器而结构上抓不到；(b) 批准的审计行没有 `request_id`，「谁批准了什么」无法与产生它的那次调用对上，两处均已在偏离项 73 记明并补了 F 组回归；**一次全量运行里出现过 1 例传输层 flake**（`tests/unit/control-plane.test.ts` 的 `fetch failed`，来自 undici），**未复现到根因，不声称已修复**，已记在 `docs/evidence/lwb-021/summary.md` §2.3 |
| LWB-022 实现状态机与幂等存储 | DONE | `packages/changes/src/state-machine.ts`（新：三张转移表 + 图遍历 + 表检查，与仓储层接线）、`packages/changes/src/single-flight.ts`（新：同键单飞锁）、`packages/idempotency/`（新包：`ids.ts` 四个品牌标识符、`operations.ts` 排队与查询、`outcome.ts` 七种答案）、`packages/contracts/src/{change,limits,tools}.ts`（补 `OperationState` / `APPROVAL_STATES` / 幂等键长度常量）、`packages/approvals/src/decide.ts`（`approveAndQueue` 改为两步流转，见偏离项 77）、`tests/unit/change-state-machine.test.ts`（32 例 / 7 组）、`tests/unit/idempotency.test.ts`（34 例 / 5 组）、`scripts/evidence/lwb-022.ts`（**34 PASS / 0 FAIL / 7 NOT_RUN / 2 NOTE**，文件库 + 两条独立连接 + 关库重开）、`docs/evidence/lwb-022/summary.md`；**本任务不访问文件系统、不写盘**，全部证据采自临时沙箱与**合成内容**的修改集（理由写在证据 §0），因此**没有任何一次写入发生在真实工作区上**；**验收标准 2（终态不可逆）是遍历出来的否定式断言**，配一条**非平凡性**前提（否则一张全空的转移表能让它静默通过）；**验收标准 1（并发收敛）由两条独立机制分别取证** —— 来源状态检查（第二次调用走不到写入）与 `UNIQUE(change_id)`（绕过检查仍只有一行），收在文件库上做因此**保证住在数据库里而不是进程内存里**；**验收标准 3 的「不要求重发」写在签名里**（`queryOperation` 只收入 `operation_id`，类型层钉住）；**两处真实缺陷被发现并修掉**：(a) `requireIdentifier` 三个拒绝分支里有一个不带 `reason`，使「不是字符串」与「是空串」在回报里被合成一句（证据脚本 4.1 抓出，见偏离项 79）；(b) `approveAndQueue` 原先走的 `PENDING_APPROVAL → QUEUED` **不在方案 §8.1 的图里**，补这条边等于把「绕过批准直接排队」变成合法转移（见偏离项 77）；**一处纵深防御缺口被量出来并如实登记**：库层没有「终态不出去」的触发器，直接 SQL 可以把 `APPLIED` 改回 `QUEUED`（实测改动 1 行，见偏离项 78） |
| LWB-023 待批准页面 | DONE | `apps/console/src/changes/{suspicious,facts,approval,index}.ts`（新：纯 TS 视图模型 —— 按**码位**遍历的可疑字符检出与分类、系统事实与模型摘要**分区**、批准入口判定与幂等键；不依赖 DOM，因此**同时**受根 tsconfig（无 DOM lib）检查）、`apps/console/views/ChangesView.vue`、`apps/console/components/DiffView.vue`（新：两个 Vue 3 SFC，正文一律按文本渲染，**不出现 `v-html`**）、`apps/console/{package.json,vitest.config.ts,tsconfig.json}`（新：本仓库**第一处构建步骤**，见下节与偏离项 84）、`apps/console/tests/{changes-view,diff-view}.spec.ts`（41 例 / 2 文件，vitest + happy-dom 的真 DOM 断言）、`tests/unit/console-changes.test.ts`（29 例 / 4 组，node 运行器）、`scripts/check-fsguard-imports.mjs`（**修掉一处本任务踩出来的静态检查盲区**：`.vue` 既不被收集、也不落在业务前缀里，写在 `<script setup>` 里的 `import fs` 一路通过，见偏离项 82）、根 `package.json` / `tsconfig.json`、`docs/compatibility.md` §2、`scripts/evidence/lwb-023.ts`（**28 PASS / 0 FAIL / 7 NOT_RUN / 3 NOTE**，含两处反向探针）、`docs/evidence/lwb-023/summary.md`；**三条验收标准各有一层判定证据（node 运行器）与一层渲染证据（happy-dom 的真 DOM）**；**验收 1 用置换探针**（8 个互不相同的摘要 —— 含空串、4000 个 `A`、方向控制字符包裹、冒充事实的 JSON、注入串 —— 产出**逐字段同一**的 `facts`），配 1.5「这 8 个摘要都原样留在 `model_prose` 里」，让「干脆把摘要整段丢掉」也过不了；**验收 2 的「提示了」与「原始字符没进 DOM」是两条独立断言**，只留前一条会让「警告了但照样把字符渲染出来」读成通过（`html()` 里搜不到 RLO 才算数）；**验收 3 是 3 会话 × 6 状态 × 3 有效期 = 54 格全矩阵**（无会话 0 格可批准）+「可批准的有且只有 1 格」，否则一个**恒返回 false** 的实现也能过；**采集过程中被自己的语料扫描抓出**：`diff-view.spec.ts` 第一版注释里逐字写进了 U+202E 与 U+E004，而这正是本模块要防的东西，已按 `String.fromCodePoint` 改写并把这段过程留在注释里；**五处既有的字面不可见字符按设计未改**（属别的任务的范围，动它们会让本次提交混范围），以**两向清单**逐条写明理由（见偏离项 86）；**本任务不访问真实工作区**（G2 未通过，P3 门禁）—— 控制台**没有数据源**（没有任何控制操作返回修改集视图，`change_get` 属 LWB-025，装配根 `apps/daemon/src/main.ts` 也尚未交付），41 处渲染断言的数据全部是按 `@lwb/contracts` 形状合成的探针数据 |
| LWB-024 失效与保留 | DONE | `packages/changes/src/invalidation.ts`（**新**，996 行：`revalidateExecutionBindings` 十条理由一次算清、`invalidateChangeSet` / `invalidateMany` / `invalidatePendingForWorkspace` / `invalidatePendingForConnection`、`sweepExpired`、`snapshotGuard` / `planSnapshotRetention`、`reclaimedChangeMetadata`；集合一律由 `CHANGE_TRANSITIONS` / `OPERATION_TRANSITIONS` **推出**而不是手抄）、`packages/changes/src/index.ts`（导出 15 个值 + 14 个类型）、`packages/persistence/src/repositories.ts`（新增 `OperationsRepo.listByStates`，见偏离项 87）、`packages/approvals/src/gate.ts`（门禁末段调用 `revalidateExecutionBindings`；`ApplyGateReason` 合并 8 条 `ExecutionBindingReason`，错误码映射**转发**到唯一那一份而不是重写）、`packages/blob-store/src/store.ts`（`collectGarbage` 新增**逐对象** `protect` 判据 —— 第 4 条条件，与原来的全局 `isSafeToCollect` **同时**成立才删）、`tests/unit/changes-invalidation.test.ts`（**新**，1360 行 / 77 例 / 6 组）、`tests/unit/approvals.test.ts`（夹具把工作区推到第 7 代，否则 LWB-024 起门禁会正确地拒绝）、`scripts/evidence/lwb-024.ts`（**新**，1193 行；**37 PASS / 0 FAIL / 5 NOT_RUN / 1 NOTE**）、`docs/evidence/lwb-024/summary.md`；**三条验收标准分别落在「真 SQLite + 真仓储 + 注入时钟」与「真字节 + 真 `collectGarbage`」两种装置上**；**验收 1 拆成三问**（1.2 拒绝 / 1.3 成因**必须是 `now`** —— 同一 change_id、同一批准 id、同一摘要，只换 now 就换答案 / 1.4 拒绝是投影不是写，批准行仍 `ACTIVE`），配 1.5 的对照组，否则「拒绝了」也可能来自别的判据；**两个有效期是两个时钟**，1.6（`T0+22min` 收掉的是**批准**、修改集原地不动）与 1.11（越过 `T0+24h` 才收掉那一行）从两侧取证，只做一侧的实现可以全错而全绿；**验收 2 的每一格都先断言「收缩前放行」**，只断言「被拒绝」会让一个恒真的拒绝通过；**两条互为补充的取证**：2.5 报 `APPROVAL_REVOKED`（门禁**先问批准、再问状态** —— 最初写成 `CHANGE_STATE_INVALID`，是把判定次序当成了实现细节）与 2.6（`approvals_active_uq` 是 `WHERE state='ACTIVE'` 的**部分**唯一索引，`approvals.create` 在已失效的修改集上**会成功**，因此挡住复活的是修改集状态，不是数据库）；**验收 3 的关键是 3.7 反向探针**（撤掉 `protect` 再跑同一个 `collectGarbage`，窗口内的与运行中的 4 个字节**当场被删** —— 于是 3.4/3.5 里的「留下」是判据挣来的，不是没东西可删）与 3.8（显式走一遍全局谓词为假的那条路并记下 `refusal_reason`，说明它为什么让这条标准**空洞地成立**）；**采集过程中发现并修掉一处会让回滚取不到原始字节的真实缺陷**：`planSnapshotRetention` 原本用 `OperationsRepo.listUnfinished()` 取在途操作，而那个方法问的是「上一个进程留下了什么」（不含 `RECOVERY_REQUIRED`），保留策略问的是「这些字节还有人在等吗」—— 由「修改集 QUEUED / 操作 RECOVERY_REQUIRED」的分叉夹具暴露，见偏离项 87；**本任务不访问真实工作区**（G2 未通过，P3 门禁），且**「不会自动落盘」只证到门的那一侧**（执行协调器 LWB-026 尚未交付），这条差别写成 `NOT_RUN` 而没有与 `PASS` 合并 |
| LWB-025 接入修改提议工具并验收审批闭环 | DONE | `packages/contracts/src/tool-outputs.ts`（三个工具的输出 schema 与数据类型）、`packages/changes/src/query.ts`（**新**，668 行：`NOT_FOUND` **单值化**（带任何判别键都会让「本机有没有这个 id」变成可穷举）、归属判定、`viewFor`、`changeGetDataOf`、`changeListDataOf`、游标编解码、差异分页与出站脱敏）、`packages/changes/src/index.ts`、`apps/daemon/src/tools/{handlers,catalog,guard,access}.ts`（三个处理器 + 可用性 + 策略动作 + 说明文案）、`packages/audit/src/ranges.ts`（`change_*` 的文件访问提取器）、`packages/persistence/src/repositories.ts`（`ChangesRepo.list` 的复合游标）、`packages/files/src/text-diff.ts`（**从 `packages/git-reader/src/text-diff.ts` 移动过来**，`DIFF_MAX_DP_CELLS` 一并 —— 否则 `@lwb/changes` 要渲染差异就得先依赖 git-reader）、`tests/unit/mcp-adapter.test.ts`（**覆盖方式改成记录出来的**，见下）、`tests/unit/daemon-tools.test.ts`、`scripts/evidence/lwb-025.ts`（**新**，1009 行；**65 PASS / 0 FAIL / 4 NOT_RUN**）、`docs/evidence/lwb-025/summary.md`、`docs/evidence/g3-proposal.md`；**`IMPLEMENTED_TOOL_NAMES` 7 → 10** —— 这个常量是编译期装置：加名字会**故意**打断四张表（`catalog.ts` 的 `AVAILABILITY`、`handlers.ts` 的 `TOOL_POLICY_ACTIONS` 与 `TOOL_HANDLERS`、`packages/audit/src/ranges.ts` 的 `FILE_ACCESS_EXTRACTORS`），漏接线是**编不过**而不是运行期少一个工具；**验收 1 的判据是短语清单**（「说明里写了先读再提议」不可观测，可观测的是那几个词在不在模型读到的字符串里），配 `readOnlyHint=false` —— 那是**唯一**一个模型能读到的「这次调用会不会改东西」的提示，不参与授权判定，标错只会让模型**没有心理负担地重试**；**验收 2 把「不轮询」否证成可判定的断言**（连续 5 次查询答案必须逐字相同：有推进循环则迟早变一格，等批准到超时则走不到第五次），上界 15 秒是本地调用毫秒级实测的反衬（最慢 11.1 ms）；**验收 3 穷尽 8 格门禁取值**（只测一格的话「直写恒为真」与「四个开关永远相同」两种错误实现都能过），并在 `PROPOSAL_READY`（§3 过、原生护栏未过）下**真装配出第二个 harness**再问它的 `tools/list` —— 断言下在**清单**上而不是开关上，因为开关对而清单挂错工具才是这条验收里唯一有产品后果的失败形态；**「清单里没有 `change_apply`」被拆成两条原因不同的断言**（本装置里是**未实现**，`PROPOSAL_READY` 里是**开关挡住**），否则 LWB-032 交付后那句断言会给出错误结论；**负向里三条一组的硬拒绝**（被拒绝 / `blocked_at:'prepare'` / `reads=[]`）—— 少第一条放行不拒的实现，少第二条放行「提案照建、执行时才拒」（产品后果：模型建出一份永远不可能成功的提案，操作者核对并点批准，然后失败），少第三条放行「先读进来再判断要不要拒」（`.env` 内容进进程内存）；**身份字段是输入违约不是被忽略**（「忽略」意味着带 `approved:true` 的调用**会成功**，模型学到的是这个字段可以带）；**归属用整段 JSON 比对**（一个码或一句话不同就是「本机有没有这个 id」的预言机），并要求 `details` **除 `request_id` 外没有别的键**（那条 `request_id` 每次调用都带、必然相同，不是判别信息），配一条对照组（本连接查得到）；**采集过程中修掉三处**：(a) 票据代次那条最初靠改票据尾部，实际先撞 `TICKET_BAD_SIGNATURE`，分支一次没走到而断言在**看错的理由上**通过 —— 改成真的 `bumpGeneration`（偏离项 100）；(b) 证据脚本打印完汇总**不退出**，常驻 pwsh 助手钉住事件循环，`finally` 里补 `backend.dispose()` 且**放在 `rm` 之前**（助手活着时删不掉工作区）；(c) `why()` 在肯定断言上也印「（调用成功了，而它本该被拒绝）」；**交付物路径与任务书草案不一致**（任务书写 `apps/mcp-adapter/tools/changes.ts`，实际落在 daemon 侧，见偏离项 97）；**本任务不访问真实工作区**（G2 未通过，P3 门禁），且**「批准之后落盘」这一半是 `NOT_RUN`**（执行协调器 LWB-026 尚未交付；批准入口在本机控制台，工具面无法产生批准）—— 「提议不改文件」与「批准之后改文件」是两件事，不合并
| LWB-026 写执行协调器 | DONE | `packages/executor/`（**新包**：`coordinator.ts` 认领 → 写盘 → 收尾三段各自成事务、`claim.ts` 单一认领入口、`slot-rules.ts` 纯判定（无 IO，故可穷举）、`ordering.ts` 队列次序、`index.ts`）、`packages/executor/package.json`（补 `@lwb/idempotency` 依赖 —— `coordinator.ts` 一直在 import 它，清单里漏了）、`tests/unit/executor-coordinator.test.ts`（**新**，25 例 / 6 组：A 互斥 · B 租约与接管 · C 探针惰性 · D 不重启 · E 次序 · F 两个唯一入口）、`scripts/evidence/lwb-026.ts`（**新**，约 950 行；**49 PASS / 0 FAIL / 7 NOT_RUN / 1 NOTE**）、`docs/evidence/lwb-026/summary.md`；**装置是「真 SQLite 磁盘文件 + 两个真实操作系统进程 + 真进程探针」**，而不是同进程里的两条连接 —— 执行器身份是 `(pid, started_at)`，同进程开两条连接 pid 相同，验收 3 里「持有者还活着」那一格会**空洞地成立**（脚本因此自己 spawn 自己，`--worker hold|stall|writing|try`）；**三条验收标准各占用一节且各自有一条「唯一变量对照」**：验收 1（同一工作区不并发应用两个修改集）与验收 2（不同连接共享物理约束）在 §2 用**同一块地、两个连接的写手**取证，验收 2 的正面证明**不是**「另一块地没有槽行」（那只是说还没人用过它），而是让第三个进程去认领**另一块物理身份**上的新修改集并**必须拿到** —— 令牌 `1 → 2` 同时证明「残留槽行是被覆盖而不是被删掉重来」（删掉会让令牌重置成 1，而令牌只增不减正是接管判定的依据）；验收 3（旧执行器未退出不因心跳超时启动新写执行器）在 §3 把**两个数字分开构造**（租约真的过期 + 持有者真的活着），判据是**三件事同时成立**（新写手被拒绝 / 地没有被阻断 / 上一个操作没有被标成待恢复）—— 单独任何一条都不够，「一律拒绝」能过第一条，「一律阻断」能过前两条而把每次心跳抖动升级成人工介入；**「事务不跨过等待」的判据是两件事一起成立**（父进程写库耗时 14 ms —— `busy_timeout` 是 5000 ms，被攥住的长事务会表现为卡顿或 `SQLITE_BUSY` —— **且**写手进程此刻还没退出），只断前者可以靠「先让写手写完再写库」通过，而那恰是要禁止的东西；**「一寸都没动」是一次四项比对**（change 状态 / operation 状态 / `findActive` 那条仍可用的批准 / 槽的五个字段），只断「状态没变」会让「状态没变但批准被吃掉」通过（产品后果：操作者点了一次批准、什么也没发生，第二次再点已无批准可用）；**心跳那一格读两次真行而不是 `heartbeat()` 的返回值**（恒返回成功的 heartbeat 会让「租约在续」在任何实现下成立）；**采集过程中发现并修掉一处真实缺陷**：`#finalize` 原本对所有终局用同一组来源状态 `['QUEUED','VALIDATING','APPLYING'] → 'APPLIED'`，而 `refuseTransition` 要求**每一个**声明的来源都有那条边、`VALIDATING → APPLIED` 不是边 —— 这一句在**声明上**就非法，抛 `CHANGE_STATE_INVALID`，且抛出点在**字节已经写完之后**（修改集与操作卡在 `VALIDATING`，文件已经改了：记账与磁盘不一致，且记账那一侧看起来像「还没开始写」）；改成来源状态**由报告推出**（`applied ⇒ ['APPLYING']`；`conflict`/`no_change ⇒ ['VALIDATING']`，因为这两件事在校验阶段就定了；无报告 ⇒ 三者皆可）+ 一段只在两行**同时**停在 `VALIDATING` 时才补跳的兜底，并补 D6 让写盘人**违反契约**（不记执行意图就交回 `applied`）时协调器仍落到 `APPLIED`；**一处 fail-closed 的真实结论被采出来并登记**：`RECOVERY_REQUIRED` **不在** `TERMINAL_CHANGE_STATES` 里（终态的定义是「不可再回到可执行状态」，而待恢复的操作恰恰要回到 `APPLIED`/`ROLLED_BACK`），于是**每一次真实阻断都会留下一个尚未终结的前驱**，而 `clearBlockade` 要求前驱已终结 —— **LWB-030 落地之前没有任何一条真实路径能解除阻断**（见偏离项 101）；**本任务不访问真实工作区**（G0/G2 未通过），**写盘人是故意假的**（真实写入属 LWB-027），**协调器尚未接入工具面** —— `change_apply` 仍是 `IMPLEMENTED_TOOL_NAMES` 之外的名字、模型看不到它（接线属 LWB-032），且 `packages/executor/` 在导入检查的**业务前缀**里，「协调器不碰文件系统」因此是**编译期**性质而非约定；**唯一的真实副作用**发生在 `os.tmpdir()` 下 `mkdtemp` 出来的临时库文件上，`finally` 中 `rm -rf` 且在**关库之后**执行 |
| LWB-027 受保护的既有文件写入 | DONE | `packages/executor/src/native-adapter.ts`（**新**：`createNativeApplier` —— 校验 → 写入 → 回读三段，与 LWB-026 的协调器接口对接；它在导入检查的**业务前缀**里，因此「适配器不碰普通文件 API」是**编译期**性质而不是约定）、`packages/executor/src/index.ts`、`native/winfs/WinfsGuard.ps1`（**修掉一处会让并发证据自己松手的真实缺陷**，见偏离项 103）、`tests/unit/executor-native-adapter.test.ts`（**新**，971 行 / 22 例 / 4 组：A 三步的顺序 · B 写之前退出的两类原因与优先级 · C 写入开始之后唯一诚实的处置是进恢复 · D 记不上账就不写 —— 假护栏穷尽**分类**，每种护栏错误该报成冲突、拒绝，还是「必须进恢复」）、`tests/windows/executor-write-path.test.ts`（**新**，396 行 / 4 例：三条验收标准在真盘上各一格）、`scripts/evidence/lwb-027.ts`（**新**，1018 行；**55 PASS / 0 FAIL / 5 NOT_RUN / 4 NOTE**，退出码 0）、`docs/evidence/lwb-027/summary.md`；**装置是真 NTFS + 真 `PowerShellWinfsBackend` + 真 `CreateFileW`/`FlushFileBuffers` + 真 SQLite + 真快照库 + 真 `claimForExecution`** —— 与 LWB-026 是同一套协调器，只把那个「故意假的写盘人」换成了真的；**三个验收标准各占一节且判据都可机器核对**：验收 2 是「磁盘字节的 sha256 == 条目里已批准的 `target_sha256`」（BOM 与 CRLF **逐字节**比对，不是「解码后一样」；长度与快照登记尺寸一致，防的是「回读拿到缓存旧字节」）配一次**独立回读**（另起一次护栏调用，不复用写入那次的返回值）与护栏**回执**（`readback_ok` 与 `flushed` 同时为真）；验收 1 前半**用两种手法分开取证**——「原地改写」与「删除重建」：前者只有内容哈希能拦，后者**只有对象身份能拦**（`GetFileInformationByHandle` 的 file_id，改名/替换都会变），两格放在一起才说明「批准的是**那一个对象**，不是那个位置」；验收 1 后半用的是护栏自己的 `holdHandle`（spike 专用，**刻意不在 `WinfsOps` 里**），因为正式的 `Op-WriteFileGuarded` 是**一次请求内的开→写→刷→回读→关**、没有可被别的进程插进去的窗口 —— 因此这一格证明的是**那组共享标志的性质**（`GENERIC_READ|GENERIC_WRITE` + 仅 `FILE_SHARE_READ`），不是 `Op-WriteFileGuarded` 内部的时序，这条边界写在测试文件头与证据 §3 的两条 NOTE 里；**同一节还有反向断言**：持有期间**我们自己的**写入路径也必须失败（`FILE_BUSY` / Win32 32），而不是降级成普通文件 API —— 那是「能力不足返回错误、不降级」在另一侧的正面证据；**验收 3 用两次真的失败构造 `RECOVERY_REQUIRED`**：只读目标 ⇒ **打开**就失败（`PERMISSION_DENIED` / Win32 5，`crossed_truncate=false`、`already_written=0`、磁盘原样）；把文件**只读映射**起来再写 ⇒ `SetEndOfFile` 失败（`IO_ERROR` / Win32 1224 `ERROR_USER_MAPPED_FILE`，`crossed_truncate=true` 且详情带着**现场**：`observed_size` / `observed_sha256` / `observed_at_utc`，磁盘字节未变）—— `crossed_truncate=true` 是**保守**读法（「已经走到截断之后，剩下的不由我们说了算」，**不是**「字节一定被改过」），这层意思写在证据 §4 的 NOTE 里，`NOT_RUN` 那一格（崩溃真的留下部分字节）也留在同处；**采集过程中发现并修掉一处真实缺陷，而它恰好在本任务要证明的那件事上**：`Op-HoldHandle` 起初把持有的句柄留在函数局部变量里，`.NET` 的 `SafeFileHandle` 是终结器对象，函数一返回、局部变量一不可达，GC 就能把句柄关掉 —— 同一段代码连跑 20 轮曾出现 **19/20**，也就是说靠它做的用例本身有约二十分之一的间歇失败率，而那会以「环境抖动」的样子出现在回归里；修法是让护栏把句柄留在一个脚本作用域的列表里（`$script:LwbHeldHandles`），活到助手进程退出为止，同一测量随后**两次独立运行都是 20/20**（详见偏离项 103，测试文件头与 summary §0.2 都写明「若有人把引用留存去掉，这里会以一种看起来像环境抖动的方式开始偶发失败」）；**两处我自己的错误预期被实跑纠正**并如实留在证据里：失败之后重提同一个修改集拿到的是 `INTENT_RECORD_FAILED`（正确 —— 账上已经写着「可能写过」，重来是恢复流程的事），以及**阶段 A 的拒绝返回 `{kind:'refused'}` 而不是抛**（只有写后失败才抛）；**一个分支在真 NTFS 上够不到，标成 `NOT_RUN` 而不是拿假装置冒充**：写入路径尾段那次 `classifyFile` 硬拒绝需要「同一个对象有两个名字」（符号链接/硬链接），而造链接要管理员权限或开发者模式，本工程不得要求管理员 —— 该分支由单元测试 B6 的假盘覆盖，证据 §5d 与 summary §5.2 都写明这条交接；**`crash_atomic_replace` / `cross_file_transaction` 两个常量仍是 `false`**，能力标志里没有任何一处宣称原子替换（「崩溃会留下部分字节」是 `NOT_RUN`：无法按需杀死一个**正在写盘**的护栏进程并保证它停在半途）；**本任务不访问真实工作区**（G0/G2 未通过）—— 全部写入发生在 `os.tmpdir()` 下 `mkdtemp` 出来的真实目录里，`finally` 中先 `backend.dispose()` 再 `rm -rf`（助手活着时删不掉工作区）；**脱敏有一对真的对照**：护栏**原始**消息里确实带着本机绝对路径（故意留在 `raw.log` 里当证据，`拒绝访问：C:\Users\…\Temp\lwb-027-…\readonly-6\notes.txt`），适配器交出的那一份把它换成了 `<工作区根>`，且全部失败详情 617 字符里没有本机绝对路径、也没有临时目录名 —— 因此这条检查不是空操作 |
| LWB-028 不覆盖的文本文件创建 | DONE | `packages/executor/src/native-adapter.ts`（`vetCreate` —— 创建的阶段 A；与改写**不复用一段代码**，因为两条路的判据方向相反：「那个对象还是被批准的那一个」对「那个名字还没被占」）、`native/winfs/WinfsGuard.ps1`（`Op-CreateFileGuarded`：只用 `CREATE_NEW`、绝不 `CREATE_ALWAYS`/`OPEN_ALWAYS`、失败后**不删**半个对象、`actual_state` 只在创建**成功**之后才挂上去）、`native/winfs/src/ops.ts` + `src/powershell-backend.ts`（`WinfsCreateResult` 与 `createFileGuarded`，回执**按白名单逐字段拼装**）、`tests/unit/executor-native-adapter.test.ts`（22 → **31 例**：B1 改写、B9 改指向、新增 E 组 E1–E9，假盘的 `createFileGuarded` 照 `CREATE_NEW` 的规矩判定）、`tests/windows/executor-create-path.test.ts`（**新**，7 例真 NTFS）、`scripts/evidence/lwb-028.ts`（**新**；**61 PASS / 0 FAIL / 7 NOT_RUN / 2 NOTE**，退出码 0）、`docs/evidence/lwb-028/summary.md`；**装置与 LWB-027 同一套**（真 NTFS + 真 `CreateFileW` + 真 SQLite + 真快照库 + 真 `claimForExecution`），只把「改写既有文件」换成「新建一个名字」；**三条验收标准各占一节、判据都可机器核对**：验收 1 用**三种占位形态**（精确同名 / **大小写别名** —— NTFS 认为 `Case.txt` 与 `case.txt` 是同一个名字，说明里给的是**磁盘上的拼写**而不是条目里的 / 一个**目录**占着那个名字），每一格都断言 **`createFileGuarded` 调用次数为 0**（计数器插在护栏边界上）—— 那才是「绝不覆盖」的 falsifiable 形式：只比「返回值是 conflict」的实现完全可以先发一次创建再收拾残局，而收拾残局就是覆盖；**最要紧的一格是 §2 丙**：抢跑发生在「适配器探完之后、护栏被调用之前」，也就是第一条验收标准真正问的那段窗口 —— 真护栏调用照常发出，失败来自 `CREATE_NEW` 自己（判定与创建是**同一次系统调用**，因此从「刚才不存在」到「真的创建」之间没有可插进去的间隙），抢跑者的 25 个字节**一个都没被碰**，`details.object_created=false`；**验收 3 的「不隐式建目录」在磁盘上反证**：拒绝之后那一级目录**依然不存在**（只断「返回 conflict」的话，一个先 `mkdir -p` 再创建的实现也能过，而它的副作用是多出一串目录），父路径上是一个**文件**那一格另有一条「那个文件既没被删也没被改名」；**「不动 ACL、不设执行权限」的判据是与对照组逐项比对**（新对象的安全描述符 == 同目录下普通方式建的那一个，逐项比属主与每条 ACE，且**非继承 ACE = 0**；工作区根的 ACL == 一个刚 `mkdir` 出来的目录）—— 因为 NTFS 上**没有**执行位，护栏若调用过 `SetSecurityInfo` 只能体现为 ACL 上多出一条 ACE，那会让两份摘要不再相同；**护栏回执刻意与改写同形**（`target_sha256` / `readback_ok` / `flushed` / `bytes_written` 一个不少）：创建**没有基线可对**，因此「护栏收到的到底是不是我们批准的那份字节」是唯一一处把「批准的内容」与「写下去的内容」连起来的检查；**实测纠正了我对 Win32 码的猜测**：本机 `CreateFileW` + `CREATE_NEW` 撞上已存在的目标返回 **80**（`ERROR_FILE_EXISTS`）而不是 183，两者都在同一张映射表里归 `FILE_VERSION_CONFLICT` —— 可核对的是**映射后的码**，码本身是实现细节（见偏离项 107）；**一格诚实的例外与其代价被摊开写**：抢跑那一格「一个对象都没创建出来」本来够格报 `conflict`，但状态机转移表里**没有** `APPLYING → CONFLICT` 这条边、而阶段 B 已经把账推到了 `APPLYING`，因此它照抛 `RECOVERY_REQUIRED`（代价：一次多余的人工核验；换来的是不为这一格去改那张图）—— `details` 里把 `object_created=false` 明写出来让人一眼看见（`writeFailure` 的注释与证据 §2.3 的 NOTE 各写一遍）；**脱敏的对照对是「同一句护栏话」**（护栏原始消息 `文件已存在，CREATE_NEW 拒绝覆盖：<绝对路径>` vs 经 `writeFailure`→`sanitize` 之后的 `<工作区根>\created.txt`），且方法上的坑记在证据 §6：**必须让失败发生在阶段 C** —— 阶段 A 的冲突说明是适配器自己用相对拼写写的，拿它证明「脱敏有效」永远为真；第一道脱敏在更外面（后端回执按白名单拼装，护栏的 `absolute_path` 根本走不到调用方，同一节正面量过）；**采集时我自己的三处构造错误**（缺 BOM 让「形态不符」那一格变成了成功、脱敏那一格拿已占用的目标去构造阶段 C 失败、假盘里抢跑者「追加」而不是「替换」）如实记在偏离项 108；**本任务不访问真实工作区**（G0/G2 未通过）—— 全部创建发生在 `os.tmpdir()` 下的真实目录里，`finally` 中先 `backend.dispose()` 再 `rm -rf` |
| LWB-029 多文件日志与持久化边界 | DONE | `packages/executor/src/journal.ts`（**新**：条目级日志的追加与读取、折叠函数 `aggregateOf` / `describeOutcomes` / `itemOutcomes`、脱敏 `redactRoot`）、`packages/executor/src/apply.ts`（**新**：阶段 A 校验 → A2 快照持久化 → B 记账 → C 逐条目写入 → 收尾四段；四条写入阶段 `item_intent` → `item_written` → `item_flushed` → `item_verified`、有界回滚、失败分类与折叠）、`packages/executor/src/native-adapter.ts`（`guardFailureFacts` 的判据换成护栏的 `touched` 那一行；`guardDetails` 的字段改成枚举形态）、`packages/executor/src/coordinator.ts`（终局落账 + 改动级日志行）、`tests/unit/executor-journal.test.ts`（**新**，35 例 / 7 组，折叠与条目日志的全组合）、`tests/windows/executor-journal-boundary.test.ts`（**新**，9 例真 NTFS，逐条链路都真）、`tests/unit/executor-native-adapter.test.ts`（J 组 J1/J2）、`scripts/evidence/lwb-029.ts`（**新**；**71 PASS / 0 FAIL / 7 NOT_RUN / 2 NOTE**）、`docs/evidence/lwb-029/summary.md`；**执行日志零迁移** —— `journal_entries` 沿用 LWB-006 就有的那张表，证据用 `PRAGMA table_info` 在**真库**上逐列比对（10 个列名逐字相符），否掉了「顺手建张新表」这条路；**四条步骤各自的判据都不是看返回值**：步骤 1 是**一个时刻**上的次序（`onFirstWrite` 钩子在**任何字节落盘之前**回调，钩子里把全部条目的旧/新 blob 都在对象目录里 `existsSync` 一遍 —— 次序只能在一个时刻上量）、步骤 2 是逐条目四个阶段 + 全局 `seq` 严格递增、步骤 3 是收回失败后**磁盘上真的留着**与基线不同的字节（真盘哈希比对，证明 `restore_failed` 不是一句措辞）、步骤 4 是逐条目小结 + 折叠；**这一轮发现并修掉一处真实的脱敏漏洞**：护栏的消息在它自己的坐标系里写着目标的**绝对路径**（`WinfsGuard.ps1` 的 `Open-Guarded` 把 `$Path` 拼进去），这句话走三条出口 —— 条目级日志（`appendItemEvent` 落库前脱敏，安全）、报告（出口处还有一道 `sanitize`，安全）、**抛出去的 `RECOVERY_REQUIRED`**（协调器 `#finalize` 接住它、把 `error.message` **原样**写进一条**改动级**日志行，而那一行**不经过** `appendItemEvent`）—— 工作区根就是这样进执行日志的；修法是在**造出那句话的地方**（`apply.ts` 三处拼装点）脱敏，而不是在出口上，理由是**出口是从代码里长出来的**：今天三个、明天接一个新汇报面就是四个，修在源头时每多一个出口都自动安全（这条规则写在 `apply.ts` 那段注释里）；**并且验证了修改咬得住** —— 把 `guardLine` 改回原样后单元 J1/J2 **双双变红**并把泄漏的那一行原样打出来（`…护栏拒绝（PERMISSION_DENIED，Win32 5）：拒绝访问：C:\lwb-027\repo\src\a.ts。…`），放回去即恢复绿 —— 没有这一步，无法区分「修好了」与「本来就没漏」；**判据从 `actual_state` 换成 `touched` 是一次语义修正而不是改名**：旧推理把「护栏没给 `actual_state`」读成「现场未知」，可它的缺席常常只是「护栏没走到那一步」，那是**确切知道没动过** —— 于是只读目标、`CREATE_NEW` 撞名这两格**总是**付一次人工核验的代价（LWB-028 的旧 NOTE 自己就把那次核验记成「**多余的**」），而磁盘上明明什么都没发生；新判据「没带 `touched` = 没越过破坏性区域」对改写与创建两条路**同向成立**，因此恢复流程只需要读一个字段（`guard_verdict` / `guard_touched` 取代 `crossed_truncate` / `object_created`），两格的代价连同它们的特例一起消失，而「不为这两格改状态机那张图」这条约束**没有被放弃**（`APPLYING → CONFLICT` 这条边依然不存在，证据里专门断言 `change.state` 仍停在 `APPLYING`）；**「部分完成绝不当成全成功」是这一轮反复验的反方向**：`{written, untouched} ⇒ unfinished`、单条目全 `written ⇒ applied`、账本少一个条目 ⇒ `unfinished`（`expectedItems` 是硬判据），三条一起才说明「不给 applied」这件事本身有意义 —— 一个永远返回 `unfinished` 的实现能过前两条；**「写下去的三条回执在同一个事务里」是设计不是实现细节**：中途抛异常时 `written`/`flushed`/`verified` 要么全在要么全不在，代价是「盘上写了、账上只有 intent」这一格**存在**（证据 §4 甲：磁盘已是批准过的内容、折叠说 `unfinished`、交给人的话是「状态未知」而不是「没写成功」），换来的是**不存在**「账上写了、盘上没写」那一格（后者会让恢复流程去回滚一份根本不存在的改动）；**「账记不上就不许写」也是可核对的**：`item_intent` 写在一个隐式事务里且在**任何护栏调用之前**，停在它上面时磁盘逐字节未变（§4 乙）；**验收 3 用了静态 + 动态两半，任何一半单独都不够**：静态是 `packages/executor/` 里连 `child_process` 都 import 不进来（该目录在导入检查的**业务前缀**里，故这是**编译期**性质）且四个源文件对 6 个模式零命中；动态是把**真 git 仓库当工作区**、起点布置成「栈里压着一条 + 一处未提交」，跑一次真的失败批量（它真的写了目标字节又写了回去），前后比对 `HEAD` / `stash list` / `status --porcelain` / `show-ref` / reflog 五项一致 —— 动态那一半**只能证明「没留下痕迹」**（一个 `stash` 完又恰好恢复原状的实现同样能过），静态那一半只覆盖那四个文件，**两半合起来才闭合**；**一处改动判据的诚实交代**：`git hash-object <file>` == `git rev-parse HEAD:<file>` 这一条是被一次 FAIL 换来的 —— 第一版拿「磁盘字节的 sha256」比「`git show` 出来的字节」，红的原因是 Git 在 `add` 时按 `core.autocrlf` 把 CRLF 存成了 LF，**是判据错了、不是实现错了**；**一处发现如实改掉了自己的说法**：证据标题原写「快照在阶段 A 通过之后、A2 之前消失」，实测拒绝发生在**阶段 A**（`vet` 取目标快照时就发现对象缺失），比 A2 那条持久化边界更早 —— 不是缺陷，是**更便宜也更早**的失败点，验收要的「快照持久化失败 ⇒ 零写入」已由七条断言满足，而更窄的那个构造归单元 H 组；**LWB-027 与 LWB-028 各有 5 处 / 6 处断言被重新指向**（从「抛了没有」换成「账上那条终局是哪个阶段」+「磁盘字节对不对」，是更具体不是更宽松），两份 `summary.md` 同步更新、逐条记在 `docs/evidence/lwb-029/summary.md` 的 §8.2；**还发现 LWB-028 §5c 的注入夹具本身自相矛盾**（它补报一句「我什么都没动」却在磁盘上留下一个真的 45 字节新对象），修法是给注入补上 `touched: true` —— 「夹具可以撒谎、断言不该跟着撒谎」的一个实例；**本任务不访问真实工作区**（G0/G2 未通过）、**不发网络请求**、**不涉及任何凭据**，唯一的真实副作用发生在 `os.tmpdir()` 下 `mkdtemp` 出来的临时工作区（含验收 3 那个真 git 仓库），`finally` 中先 `disposeWinfsBackend()` 再 `rm -rf`；**交付物路径与任务书草案不一致**（任务书写 `packages/executor/*`，实际落在 `packages/executor/src/`，与 LWB-026/027/028 一致，见偏离项 97） |
| LWB-030 启动恢复与未知结果协调 | DONE | `packages/recovery/`（**新包**：`verdict.ts` 判定 —— **只读**地重新观测一次，把「当前是什么」分成未变/目标已达/第三种内容/身份不明四格，观测带**受控句柄下的真对象身份**；`plan.ts` 折叠与摘要 —— `reconciliationOf` 的判据次序是**有意的**（判不出的先问、再问是不是清一色）、`repairOf` 只产出 `ROLLBACK_TO_BASELINE` 一个动作、计划摘要按可观测量（身份·哈希·磁盘拼写·卷·根）规范化编码；`service.ts` 编排 —— `sweepStartup` / `reconcile` / `authorize` / `repair` / `records`，加 `RECOVERY_REQUIRED → APPLIED|ROLLED_BACK` 的收场）、`packages/persistence/src/migrations.ts`（**迁移 v7**：`recovery_authorizations` 表 + 部分唯一索引 `recovery_authorizations_active_uq`（一个操作上不会有两条同时有效的授权）+ 两条触发器 （`no_reactivate` / `immutable_binding`）+ `operation_item_results`）、`packages/persistence/src/repositories.ts`（`RecoveryAuthorizationsRepo`、`OperationsRepo.setItemResult`、逐条目回执的读写；**并修掉一处真实缺陷**：`isUniqueViolation` 原本按 `SQLITE_CONSTRAINT` **前缀**匹配，会把一次 `CHECK` 失败报成「已存在有效授权」，见偏离项 119）、`packages/changes/src/invalidation.ts`（`ExpirySweepReport` 新增 `expired_recovery_authorizations` —— 与批准**分开计数**，因为过期的后果不同：一个是「那次写入不能再开始」，一个是「那堆字节还得继续等人」）、`apps/daemon/src/runtime/assembly.ts`（**启动扫描排在工具面之前**：`await recovery.sweepStartup()` 出现在 `createToolSurface(` 之前；`recovery_required` 从 `() => false` 换成真查询）、`tests/unit/recovery-{verdict,plan,persistence,boundary}.test.ts`（4 个文件）、`tests/windows/recovery-converge.test.ts`（12 例真盘）、`scripts/evidence/lwb-030.ts`（**176 PASS / 0 FAIL / 8 NOT_RUN / 2 NOTE**）、`docs/evidence/lwb-030/summary.md`、`docs/recovery-playbook.md`（给本机操作者的九节手册）；**四条步骤与三条验收标准都在真 NTFS + 真 SQLite 上成立** —— (a) 写得完、应答丢 ⇒ 收敛为 `APPLIED`，且两个文件的**指纹三者全等**（不重复修改）；(b) 崩溃后用户继续编辑 ⇒ 第三种内容留待人工，`repair` 连**授权都签发不出来**（`HAS_UNRESOLVED_ITEMS`），用户那一次编辑的字节与时刻一个都没变；(c) 快照缺失 / 护栏不可用 / 库文件坏掉三种「不完整」各自 fail-closed，**坏掉的库拒绝打开且一个字节都没被改写**；**「不写字节」是用文件指纹（大小 + 最后写入时刻 + 内容哈希）量的**，不是用内容量的 —— 只比内容的话，一次「把同样的字节再写一遍」也会通过；**「身份不明」那一格是在真盘上用删除重建造出来的**（护栏的文件索引含 NTFS 序列号，改名不变、删除重建会变），并配一道**装置自检**：索引若没变就报「装置不可用」，绝不让断言去证明一件没发生的事；**「把基线补写成目标」在库结构上就是写不出来的**：被授权执行的动作词表冻结成 `["ROLLBACK_TO_BASELINE"]` 一条，里面没有它；授权钉住一个**计划摘要**，签发之后有人动过盘，就在**一次写入之前**被库拒绝（且**不消费**那条授权 —— 一次环境没准备好的尝试不该烧掉操作者的授权）；**模型侧够不到这条路径**（`authorize` / `repair` / `records` 都不在工具面里）由 `tests/unit/recovery-boundary.test.ts` 静态钉住，并在真仓库文件上复算；**MANUAL 分支原本不写逐条目回执**，于是正等着人工处理的记录里一条条目都没有 —— 被发现并修掉；**本任务不访问真实工作区**（G0/G2 未通过）、**不发网络请求**、**不涉及任何凭据**，唯一的真实副作用发生在 `os.tmpdir()` 下 `mkdtemp` 出来的临时工作区，`finally` 中先 `disposeWinfsBackend()` 再 `rm -rf` |
| LWB-031 实现安全撤销提议 | DONE | `packages/changes/src/revert.ts`（**新**，1362 行：`planRevert` 逐条目判定 → `prepareRevert` 落成一条**新的**修改集；`REVERTIBLE_CHANGE_STATES` 是**单值** `['APPLIED']`；`REVERT_JOURNAL_STAGES` 是 `@lwb/executor` 的 `ITEM_STAGE` 的**镜像**（依赖方向不允许 `@lwb/changes` import `@lwb/executor`，因此这份重复消不掉 —— 由真盘用例的 A5 **逐键**把守，集合相等不够：对调 `verified` 与 `failed` 两个值集合不变而含义相反）、`packages/changes/src/index.ts`（导出面）、`tests/windows/changes-revert.test.ts`（**新**，30 例 / A–G 七组）、`scripts/evidence/lwb-031.ts`（**新**，约 1000 行；**107 PASS / 0 FAIL / 8 NOT_RUN**）、`docs/evidence/lwb-031/summary.md`；**装置是「真 NTFS + 真护栏 + 真 SQLite 磁盘文件 + 真 `BlobStore` + 真 `createNativeApplier`」**，而且源修改集是**执行器真的跑完**的 `APPLIED`（§0 自检）—— 撤销的前提是「上一次真的应用过」，夹具要是假的，后面每一条「回到基线」都无从谈起；**步骤 1（逆操作生成新的修改集）是四条性质而不是一句话**：§1.2 ~ §1.5 分别钉住新 id、新摘要、停在 `PENDING_APPROVAL`、以及**自己那条新的有效期窗口** —— 最后一条是结构性的：`CHANGE_TRANSITIONS` 里 `APPLIED: []` 是空数组，而 `EXPIRABLE_STATES` 算出来是 `[PENDING_APPROVAL, APPROVED, QUEUED]`，**`APPLIED` 不在里面**，撤销因此**不可能**沿用原计划的有效期；**逆提案锚在「当前」而不是「快照」**（§1.7 提案的 `base_sha256` 等于盘上此刻的字节，§1.7b 而它写下去的目标内容逐字节等于旧快照里的**基线**，§1.9 在真盘上端到端验完）—— 撤销是**按当前文件重算**出来的一次改写，不是「把历史字节灌回去」，这也正是它对**行**有效的唯一理由；**步骤 2 的三种冲突各占一格**（§2.1 第三种内容 / §2.2 被删掉 / §2.3 删除重建），理由串逐条带出，错误**码**是 `FILE_VERSION_CONFLICT`（这一格要模型做的是「重新读一次再来」，不是「这条路走不通」），而「提议阶段一个字节都不写」是用**指纹**（大小 + 最后写入时刻 + 内容哈希）量的；§2.3 是这一节里最容易被糊过去的一格 —— 删掉重建、内容一模一样，只比内容它会**通过**，而 `file_id` 变了、那个文件已经不是我们改过的对象了，真盘上能造出它靠的是 NTFS 的文件索引（含序列号，改名不变、删除重建会变）；**「不知道」与「没写过」是两回事（§2.5）**：护栏不可用 ⇒ `GUARD_UNAVAILABLE`、护栏读了但失败 ⇒ `READ_FAILED`，两条路都落到 `CONFLICT` 且**都不生成提案**，而护栏消息里带着的**绝对路径**没有被带进计划文本 —— §2.5d/§2.5e 是一对反向探针（后者证明那句路径真的在替身消息里，否则前者是空的），这条是 LWB-029 那处脱敏漏洞留下的教训，在这里成了**一开始就写对**的东西；**步骤 3（撤销新增文件视为删除）在代码里是一条写不出来的路径**：§3.13 的四条静态探针查 `revert.ts` 的源码文本 —— 不出现 `writeFileGuarded` / `createFileGuarded` / `DeleteFile` / `removeFileGuarded`，§3.14/§3.15 是它们的反向探针（同一个探法去找读取与路径探测，必须找得到）；新建条目 ⇒ `LOCAL_DELETE_REQUIRED`、**不进提案**，本地方案带着动作名（`DELETE_CREATED_FILE`）、路径与哈希出去，而它最要紧的是**不说什么**：新建条目**没有基线**可锚，所以「这个文件就是那次创建留下的」这件事没有任何东西可以锚定，方案因此明说「本服务**不声称**它一定由本次修改创建」（方案 §8.3），§3.8b 是配套的一句 —— 不能因为有一条要人动手就把整件事停住；**§5 回答的是整个任务的地基问题：「上次应用之后是什么」从哪里来** —— 答案只有执行日志一个来源；这里拦下了**一处真实缺陷**：`operation_item_results` 那张表看起来更自然，但它只在 `@lwb/recovery` 的 `reconcile` 里被写，**正常路径根本不写它**，照它折叠会让撤销在 **100% 的普通情况下**拿不到回执、然后报一个听起来很合理的「回执不完备」（偏离项 122）；采集时又撞出**第二处真实事实**：真操作的日志**不是**只有条目级行，它最后还有一条 `write_applied` 而 `item_id` 是 `NULL`，因此「取整条日志的最后一行」会取到一条**不属于任何条目**的行 —— 折叠必须**先按 `item_id` 过滤**再取 `seq` 最大者（偏离项 123）；**`skipped` 需要自己的裁决**（执行时它**已经是**批准的那份内容，执行器跳过了它 ⇒ 那份内容不是本次执行留下的，撤销**没有资格**动手），理由串因此是 `EXECUTION_SKIPPED` 而不是 `THIRD_CONTENT` —— 两者对操作者说的是完全不同的话；**不认识的阶段名 ⇒ 冲突，不是「没写过」**（`default:` 返回 `unaccounted` / `RECEIPT_INCOMPLETE`）：将来执行器加了新阶段名，撤销会**停下来**，而不是把「我不认识」读成「什么也没发生」然后去覆盖一个文件；**验收 (a) 后续人工修改不会被回滚覆盖**：§4.1 ~ §4.3 人改过之后 ⇒ `CONFLICT` / `THIRD_CONTENT`、整条提议被拒绝（不做部分撤销，与方案 §10.2 的「没有默认部分批准」同一条规则），§4.4 人的那次编辑**大小 + 写入时刻 + 内容**三个都没变 —— 只比内容的话，一次「把同样的字节再写一遍」也会通过，而那次写入已经把用户的时间戳抹掉了，§4.5 再补一句「盘上就是人写的那份字节」；**验收 (b) 旧修改的回执不可被篡改成「未发生」**：§7.2/§7.4 是**逐行逐列**的指纹（对 `changesets` / `change_items` / `operations` ⋈ 回执 / `journal_entries` ⋈ 操作四组查询做原始 `SELECT *`）—— 因为「篡改」不只是改一个值，还包括**抹掉重来**；§7.8 四条内容列被触发器挡住、§7.9 ~ §7.11 条目/日志/操作记录各自不可改不可删，§7.7 是正面证据（撤销之后库里是**两条**记录，不是一条）；**§7.8b 是一条被降级的断言**：第一版的 §7.8 断言 `UPDATE changesets SET state = …` 会被拒 —— **它是错的**，`changesets_content_immutable` 有意**不**守 `state`（状态必须能流转，规则在 `assertChangeTransition` 里，不在触发器里），改法不是删掉它而是拆成三句：§7.8b 说清**为什么**、§7.8c 直接验代码那一侧的守卫**真的会拒**（五条「从 APPLIED 回流」全抛）、§7.8d 是它的**反向探针**（`PENDING_APPROVAL → APPROVED` 是合法的，不该被拒 —— 没有这一句，一个「一律拒绝」的实现也能让 §7.8c 全绿）；**验收 (c) 撤销不改变 Git 暂存区、也不执行 `reset --hard`**：§8.1/§8.4 的判据是 `.git/index` 的**字节**，§8.2/§8.5 是第二重（暂存区**输出**逐字不变），§8.6 ~ §8.8 各补一格（HEAD / stash / 暂存区条目数），§8.9 的五条静态探针查源码文本（`reset --hard` / `git clean` / `git checkout` / `git stash` / **`child_process`** —— 第五条不是顺手加的：没有它，前四个都可以靠「拼一个字符串再传进 shell」绕过去），§8.10/§8.11 钉住依赖方向（`@lwb/changes` 不依赖 git 读取器、也不依赖执行器）；**§8.5b 是同 §7.8b 的一处降级**：第一版的 §8.5 断言整条 `git status` 不变 —— **那也是错的**，撤销**真的重写了工作区的文件**，` M src/a.txt` 那一行**本来就应该**消失，把「工作区没变」写成保证既是一句过度声称、又掩盖了这次撤销确实生效了这件事；**§5.7 的反向探针是把折叠规则故意改坏再跑一遍**（`.lwb-local/probe-g.py`：改坏 → 跑用例 → 原样还原，任何一步不干净就直接抛），四条变异**全部被咬住**；其中第一条（改成「只认第一条 `verified`」）是唯一一条**正常路径看不出来**的 —— A 组与 B 组照旧全绿，因为夹具是正常执行的、条目级行只有那一条 `verified`，两种规则给出同一个结论，只有 G 组（往真日志里追加真行）能分辨它们，这也正是 G 组存在的理由；而**装置的第一版 G1 没有咬住它** —— 第一版追加 `item_restored` **并且**把基线写回盘上，于是**第二种防线**（`observePath` 当场观测）在正确实现与变异实现下都得出 `ALREADY_ORIGINAL`，那条用例在**为错误的理由通过**；改成围绕 `item_skipped`（盘上停在目标内容）之后才咬住，因为那是唯一一个两种折叠规则会得出**不同动作**的夹具、且变异那一边的动作是危险的那一个（它会去重写一个我们从没写过的文件）；**本任务不访问真实工作区**（G0/G2 未通过）、**不发网络请求**、**不涉及任何凭据**，唯一的真实副作用发生在 `os.tmpdir()` 下 `mkdtemp` 出来的临时工作区与临时 git 仓库，`finally` 中先关库、再 `disposeWinfsBackend()`、再 `rm -rf` |
| LWB-032 实现应用工具与操作查询 | DONE | `packages/executor/src/apply-service.ts`（**新**：`applyChange` —— 控制台「批准并应用」与工具面 `change_apply` **共用的唯一实现**；`canBeginWrite` 是「这次调用有没有可能开始一次写入」的**单一判据**，工具面与它读同一个导出函数，因此「不可认领」与「不可能产生第二次写」在结构上是同一件事；等待预算 15 秒到点就**如实回答**`in_progress: true` 并让调用方去 `change_get` 查，**不取消**写入 —— 取消一个写了一半的执行，得到的正是「不知道写到了哪」）、`apps/daemon/src/tools/handlers.ts`（`changeApply` + `replayApplied`：重放**不执行写入**，但它仍是一条**出站**通路，因此照旧过策略判定，按 `change_get` 的动作（`snapshot_read`）判）、`packages/changes/src/query.ts`（`operationReceiptFor` 折**执行日志**）、`packages/changes/src/execution-journal.ts`（**新**：日志折叠的共享词汇，与 LWB-031 的撤销共用同一套折叠规则）、`packages/contracts/src/{tools,change,tool-outputs}.ts`（`change_apply` 的说明文案与 `OperationReceipt`；说明里逐条禁止「未取得终态回执就宣称文件已保存」，并点名 `approved` 这类参数不被接受）、`packages/audit/src/ranges.ts`、`apps/daemon/src/tools/{catalog,access,guard}.ts`、`tests/windows/daemon-apply-tool.test.ts`（**新**，11 例真 NTFS）、`tests/unit/change-receipt.test.ts`（**新**，20 例，把回执折叠的每一种终局穷举）、`scripts/evidence/lwb-032.ts`（**新**；**125 PASS / 0 FAIL / 6 NOT_RUN**）、`docs/evidence/lwb-032/summary.md`；**四条步骤与三条验收标准都在真 NTFS + 真 SQLite + 真 MCP 适配器（真 server + 真 `Client`）+ 真工具面**上成立：回执的两个哈希等于**脚本独立读回**的盘上字节、`tests_run` 恒为 `false`、换不换幂等键都落到**同一条** `operation_id`，而「没有第二次写」的判据落在**护栏写入调用次数**上（比表行与指纹都更靠底层）；**这一轮修掉三处真实缺陷**（见偏离项 126–128），另有一处装置自证的问题（两条时钟混用，见偏离项 129）；**本任务不访问真实工作区**（G0/G2 未通过）、**不发网络请求**、**不涉及任何凭据**，唯一的真实副作用发生在 `os.tmpdir()` 下 `mkdtemp` 出来的临时工作区，`finally` 中先关适配器与装置、再 `rm -rf` |
| LWB-033 竞争、崩溃与故障专项测试 | DONE | `tests/windows/concurrency/`（**新目录**：`rig.ts` —— 596 行的真盘竞争装置，三项指纹（内容哈希 + 大小 + 最后写入时刻）的比对、`withRace` 的八方法显式门面、两个**授权外**看门文件（工作区内一个、工作区外一个）每次运行前后各取一次指纹；`parallel-save` / `identity-swap` / `creation-race` 三文件 **17 例**）、`tests/fault-injection/`（**新目录**：`fault-rig.ts` —— 真短写 `crashInWrite`（护栏自己的 `half_write_then_crash`：真 `SetEndOfFile`、真半份 `WriteFile`、真 `[Environment]::Exit(43)`）、真杀助手 `killGuardHelpers`（等到 `Win32_Process` 里真的查不到）、第二连接占写锁 `openLocker`；`guard-death` / `persistence-boundaries` / `no-network` 三文件 19 例，加上本任务新交付的 `daemon-death.test.ts` 3 例 ⇒ **22 例 / 7 套**）、`tests/unit/gate-combinations.test.ts`（**新**，16 格门禁取值穷举 / **6 例**）、`apps/daemon/src/gates.ts`（`PlatformGates` 增 `g4_concurrency_fault_passed`，`direct_write_enabled` 增一个**与项**；`BRIDGE_GATES` 仍是全 `false` 的常量）、`tests/tools/harness.ts`（`GATES_OFF` / `GATES_ON` 两组夹具）、`scripts/evidence/lwb-033.ts`（**新**；**111 PASS / 0 FAIL / 6 NOT_RUN**，退出码 0）、**`docs/evidence/g4-write.md`（G4 判定：未通过）**、`docs/evidence/lwb-033/summary.md`；**装置一律是真件**：真 NTFS 工作区 + 真 `PowerShellWinfsBackend` + 真 `WinfsGuard.ps1` + 真 SQLite **磁盘文件**（`:memory:` 的两个连接是两个不同的库，「忙」在内存库上没有对应的真实机制）+ 真第三方动作（Node 的 `rename` / `rm` / `writeFile`）；**竞争五格各自的判据都落在盘上的字节上**：并行保存 ⇒ `ROLLED_BACK` 且盘上是**第三方那一份**（逐字节）；同内容换身份（`rm` + 同名重建）⇒ 失败原因指名 **文件 ID 不符**而不是哈希不符（装置自查那行同时断言 `sha256 相同=true`，即注入真的换掉了对象而字节一模一样）；第三种状态 ⇒ 第三态**原样留着**，既没被写成我们的目标也没被「恢复」成基线；目录交换 ⇒ 旧对象挪到旁边仍是基线、新目录里的同名文件一个字节都没被碰；`CREATE_NEW` 竞争 ⇒ `ROLLED_BACK` 而别人建的那一个原样留着（**Win32 80**）；**每一格都有对照组**（无人竞争 / 没换对象 / 无人占用 / 权限未动 ⇒ 必须写成），否则「拒绝了」与「本来就写不成」看起来一样；文件占用与权限变化**分成两格**并给出真实的内核拒绝（`FILE_BUSY` / **Win32 32** 与 `PERMISSION_DENIED` / **Win32 5**，前者由护栏自己的 `holdHandle` 用 `GENERIC_WRITE|FILE_SHARE_READ` 造出）；**故障侧的要紧处是「不知道」不敢说成已知**：护栏被杀掉时调用方拿到的是客户端**合成**的失败，它一个字节的下落都没说 —— 判据因此是三值（`TOUCHED` / `NOT_TOUCHED` / `UNKNOWN`，见偏离项 133），账上那条失败记的是**同一个**错误码（判决与记录同源）；短写那一格从盘上量到**真的半截**（长度 = 目标的一半、字节逐位等于目标前半段）并要求终局是 `RECOVERY_REQUIRED`、账上是 `意图 → 失败 → 恢复被跳过`、**没有**「已恢复」这种假收场；**「服务退出」这一格此前只有两个近似**（LWB-030 的「重启」其实是关掉库连接再打开、进程一直活着且 `finally` 全都跑完；LWB-026 的 `SIGKILL` 杀的是假写盘人）—— 新交付的 `daemon-death.test.ts` 起一个**真执行者**（同一份文件的 `--worker` 分支：真后端、真应用器、真协调器、真状态库），等它停在两个**确定的**停机点（那一次 `WriteFile` 的两侧）再 `SIGKILL`，然后跑**真** `sweepStartup`：死在动笔之前 ⇒ `ROLLED_BACK` / `ALL_ORIGINAL`，死在动笔之后 ⇒ `APPLIED` / `ALL_TARGET`，**两次恢复都写零个字节**（判据是三项指纹全等，不是报告里的措辞），并配一条反向探针（不杀 ⇒ `APPLIED` + 四个阶段 + 改动级只有一条 `write_applied`）；**断网那一格不注入任何东西**：它证明的是一件关于代码的事 —— 执行段的 36 个 `.ts` 里没有一个网络导入、也没有一个不需要导入的网络调用，配一条**自查**（同一条判据在 `packages/ipc/src/client.ts` 上必须命中 `node:net`）与三格边界（子进程只有本地 pwsh 助手 / 助手脚本里没有网络 cmdlet）；**步骤 3 的「反复执行」判的是累积而不是覆盖率**：同一个故障跑三轮，盘、账与工作区目录**逐项相同**，再加一句「第一轮那一格本身是对的」—— 三条一样错的记录也能互相通过；**三条验收标准的落地**：(a) 见上（每一格都带授权外文件的指纹比对与「没有错误的 APPLIED」）；(b) 第三种内容不被自动覆盖（竞争侧留原样、恢复侧 `reconciliationOf` 判 `MANUAL` 且 `repair` 连授权都签不出来）；(c) 写进**推导**里而不靠记性 —— `direct_write_enabled = platform_ready && native_guard_verified && g4_concurrency_fault_passed`，16 格穷举证明直写**有且仅有**在三条门禁全过时为真；**采集过程中发现并修掉两处真实缺陷 + 一处装置缺陷**（见偏离项 132 / 133 / 134，其中前两处是「库这一层看不见」的那一类：单元测试全绿）；**G4 的判定是「未通过」**（`docs/evidence/g4-write.md`：门禁原文里的 P4 范围是 026–034 而 LWB-034 尚未交付、两个故障面 `NOT_RUN`、上游三条门禁悬着且无人签署）；**本任务不访问真实工作区**（G0/G2 未通过）—— 全部取证发生在 `os.tmpdir()` 下的真实目录里，“不覆盖用户文件实现代码回滚”这条回退约束因此是可核对的：本轮没有任何一次执行靠「写回去」让断言通过 |
| LWB-034 实现安全暂停与紧急停用 | DONE | `packages/executor/src/pause.ts`（**新**：`PauseService` —— `engage()` 的四步次序是**正确性的一部分**（① 落库 `paused = 1` 先让它成为事实 → ② 中止在途写入（**同一个** `AbortController`，不换新的）→ ③ `invalidateMany(…, trigger: 'SERVICE_PAUSED')` 废止排队授权 → ④ 交回一份**现值现算**的状态）；① 在 ② 之前是刻意的 —— 工具面与 `applyChange` 读的是**库**，先落库意味着 ① 之后开始的每一次写入都会在**开始之前**被拒，于是 ② 只需要收拾那些在 ① 之前就已经开始的；`release()` 先清标志、再换上一个**新**的 `AbortController`（两步之间**没有** `await`），构造函数在库说「停着」时**一出生就中止信号**（不写 `updated_at`、不重复废止）；状态里那个 `unrecallable_file_rows` 是步骤 3 后半句的**读数**，口径取「已经离开本进程」**更大**的那一侧）、`apps/daemon/src/control/pause.ts`（**新**：`service.pause` / `service.resume` / `service.pause_status` 三条控制操作，能力 `service.control` 在 `NEVER_GRANTED_TO_MODEL` 里逐条钉住；**入参只接受空对象，多一个字段就显式拒绝** —— 迁移 v8 刻意没有 `reason` 列，而一个被静默忽略的字段会让人以为它被记下来了；审计元数据只写四个**计数**与一个**闭集枚举**的失败原因，`persist_error` / `revoke_error` 的**原文**进 daemon 日志与响应、**不进审计** —— SQLite 的错误消息里会带本机绝对路径，而 `screenMetadata` 对绝对路径是**抛错**：把原文塞进审计会让一条本该记录「有人按过紧急停用」的记录**在落库失败的那一刻写不出来**）、`packages/persistence/src/migrations.ts`（**迁移 v8**：`service_pause` 单行表，`CHECK (id = 1)` + `CHECK ((paused = 1) = (paused_at IS NOT NULL))`，刻意没有 `reason` 列、也不预置行）、`packages/persistence/src/repositories.ts`（`ServicePauseRepo` 与 `AuditRepo.countDeliveredFileAccess`）、`packages/executor/src/coordinator.ts`（新增**外部停止源** `stop?: () => AbortSignal` —— 收的是**取信号的函数**而不是信号本身，因为「停用 → 恢复 → 再停用」的第二轮必须落在**新**的那个信号上；每次执行开始时取一次、`finally` 里把监听器摘掉）、`apps/daemon/src/tools/guard.ts`（第 1 步多一格暂停判据：`leased` 类操作一律阻断；第 5 步在返回前复查暂停，命中则交回一个 `error_code: PAUSED` / `metadata.reason: REVOKED_BEFORE_RETURN` 的**撤回信封**，`file_access` 逐行 `delivered=false`，而出站字节**照记不退还**）、`apps/daemon/src/gates.ts`（`limitationsOf` 的暂停三句：已停用 / **尚未完成**（还有 N 件写入正握着写盘权）/ N 个写入操作处于待恢复状态）、`packages/audit/src/screen.ts`（四个新键进白名单）、`packages/contracts/src/{status,tool-outputs}.ts`、`apps/daemon/src/tools/handlers.ts`（`pause_status` 与 `bridge_status` 的 `paused_at` / `pause` / 限制说明）、`packages/changes/src/invalidation.ts`（`SERVICE_PAUSED` 触发因）、`packages/ipc/src/audience.ts`、`tests/unit/pause.test.ts`（**新**，22 例 / 4 组：落库 · 废止排队授权 · 如实报告 · 控制操作）、`tests/windows/daemon-pause.test.ts`（**新**，4 例真 NTFS：写到一半停用 / 停用那一刻的读数 / 不重放旧批准 / 两面说的是同一件事）、`scripts/evidence/lwb-034.ts`（**新**，约 1000 行；**61 PASS / 0 FAIL / 5 NOT_RUN**，退出码 0）、`docs/evidence/lwb-034/summary.md`；**装置是「真 NTFS + 真 `PowerShellWinfsBackend` + 真工具面 + **生产那个** `registerPauseOperations` 控制面 + 真 SQLite」**，闸门装在 `WinfsOps.writeFileGuarded` 上（第一个文件真的落盘之后、第二个开始之前）—— 这一格问的正是「**盘上**已经变了一个文件时按下停用会怎样」；**验收 1「不会粗暴杀写进程而假装零影响」是两条一起证**：盘上第一个文件就是被批准的那些字节、第二个与两个授权外看门文件（工作区内一个、工作区外一个）**一个字节都没动**，而停用之后护栏栈仍然可用、解除之后文件读得到 —— 我们停的是**写入**，不是**进程**；**同一格里还有三个装置自检**（只写了一个文件就停住 / 停用真的被按下过 / 停用之前真的有过一次「内容已经出去」的读取），因为一个**没挂上**的闸门会让这次执行一路写成 `APPLIED`，而「盘上第一个文件变了」那一组断言**照样通过**；**步骤 3 的前半句**（阻止未发出的工具结果）判的是**两件事一起**：审计里 `delivered` 为空**且** `attempted` 记着那两个文件 —— 把「碰过但没答」记成「没碰」是另一种谎，而「未发送」与「未执行」对操作者意味着完全不同的下一步；**步骤 3 的后半句**（记录已返回的内容无法撤回）有它自己的读数（`unrecallable_file_rows`），判据是**两行合起来**：先证明这个读数**能不是 0**，再证明被挡住的那次读取**没有**被算进去；**验收 2「暂停后重连不重放旧批准」**两半都验：恢复**不恢复**任何批准，且那条旧批准真的不能用 —— 回答里 `details.reason` 是 `APPROVAL_REVOKED`、给人看的那句话说的是「撤销」不是「过期」（两者的下一步完全不同），并配一条对照组（恢复之后**新**提案照常落地，否则上面那句「写不进去」只是「这装置不写盘」）；**验收 3「恢复态如实报告」的工具那一半成立**：工具面数得出那一次待恢复、限制说明里有一句讲它、控制面说得出是**哪一次**（操作号 / 修改集 / 工作区逐字对得上），两面数的是**同一个数**；**而界面那一半是 `NOT_RUN`**（控制台的按钮属 LWB-035 之后的界面任务）—— 这句话必须写在证据里，而不是让「均如实报告」看起来已经全部成立；**「正在停止」是一个读数不是一个说法**：按下那一刻报告里那条记录的操作号必须**逐字等于**账上那一次操作（一个凑出来的读数会让界面在真正要紧的那一刻指错方向），且它的状态是 `APPLYING`、持有者就是本进程、`slot_blocked=false`（这是一次正常停用，不是抢锁）；`holder_pid` 是本工程**唯一**一处把进程号交给界面的地方，它只在控制台这条通道上（工具面只有计数）；**暂停活过重启用的是真库文件**（`openDatabase({path})` → `closeDatabase` → 再 `openDatabase`）：重开之后库里仍然写着「停着」、新实例的**中止信号一出生就是中止的**（在停用期间被认领的执行会在第一个安全边界停下）、而重启**不重写** `paused_at`（那会让它从「操作者什么时候按的」变成「本进程什么时候起来的」—— 一次重启把一句假话写进了一条安全记录）；**这一轮发现并修掉一处真实缺陷与一处装置缺陷**（`engage()` 的两口钟、夹具没接上停止源 —— 见偏离项 135 / 136），另顺手改掉两处会让**证据本身变成假话**的东西（两条随迁移必然变红的模式版本钉子、一个只被断言过 0 的计数器 —— 见偏离项 138 / 139）；**本任务不访问真实工作区**（G0/G2 未通过）、**不发网络请求**、**不涉及任何凭据**，全部取证发生在 `os.tmpdir()` 下的真实目录里，「不通过覆盖用户文件实现代码回滚」因此是可核对的：每一次「没变」的断言都打在**盘上的字节**上，而停用中止的是**意图**，它不替任何人回滚已经落下的字节 |

| LWB-035 完成首次配置和连接状态界面 | DONE | `apps/console/src/setup/`（**新目录，7 个文件**：`readings.ts` 读数与时刻 —— `Reading<T>` 把**值**与**取到它的时刻**绑在一起，因为一个只有 `value` 的界面分不清「读到一个值」与「这个值还算数」，而验收标准 3 没有它就无从判定；`platform.ts` 四条腿（daemon / 适配器 / 隧道 / 账号验收）与「平台能不能被调用」；`capabilities.ts` 四个门禁格 + 控制台自己再与一遍 + 登记表单的四个字段与暴露摘要；`pause.ts` 按下去之后**必须说出来的五件事**与「按下 / 恢复」的不对称判据；`diagnostic.ts` 三层擦洗 + 一次终检（**终检的对象是最终要复制出去的那串字节**）；`help.ts` 按处境挑选的本地启动帮助 —— 没有处境时**一条都不给**）、`apps/console/views/SetupView.vue` 与 `apps/console/views/WorkspacesView.vue`（**新**，props 驱动、不取数；判定全在 `src/setup/` 的纯函数里）、`apps/daemon/src/runtime/assembly.ts`（状态投影多一格 `machine: { hostname, os, arch }` —— **这一处是本轮发现的真实缺陷，见偏离项 140**）、`tests/unit/console-setup.test.ts`（**新**，54 例 / 7 组）、`apps/console/tests/setup-view.spec.ts`（**新**，29 例 / 5 组）、`apps/console/tests/workspaces-view.spec.ts`（**新**，25 例 / 3 组）、`tests/windows/daemon-assembly.test.ts`（**+1 例**：机器身份的回归）、`scripts/evidence/lwb-035.ts`（**新**，562 行；**51 PASS / 0 FAIL / 6 NOT_RUN**，退出码 0）、`docs/evidence/lwb-035/summary.md`；**装置是「真装配根 + 真控制面 + 控制台自己的兑换链路与客户端 + 真读数」** —— 与前几份界面证据（按契约形状合成的探针数据）不同，这一份**启动生产装配根**（`startDaemon`，与 `npm run daemon` 同一个函数，只有存储根被 `--home` 覆盖到临时目录），再用控制台**自己的** `bootstrapConsoleSession` 兑换**打印出来的**那张一次性令牌、用**自己的** `ControlClient`（摘要 + 一次性 nonce + CSRF + Origin）在真控制面上登记一个真工作区，把真响应喂进控制台**自己的**解析与判定；**三条验收标准的数据源因此都是真的**：(a)「哪台机器」在 §3.2 由服务端回报、目录在哪由真登记的 `workspaces.list` 回答（`3.11` 判的是**逐字符相同** —— 不做规范化，界面显示的必须是操作者给出的那个写法），(b) `3.7` 直写关着且理由是**门禁自己**给的 4 项（G0 排第一），`3.8` 在真服务端上量了一件结构性事实：自报的 21 条路由里**没有**任何「改门禁 / 改能力开关」的入口，(c) 验收标准 3 的判决点是 §4 —— **同一份**全绿读数在一小时之后既不可调用、本机服务那一格也变成「读数已过期」（判定是**时间函数**，不是值函数），断网那条理由排在**最前**，缺一份读数（没发现坏消息）**不等于**可调用，门禁缺一格整份作废；**§6 把一句必须写进证据的事实量了出来：界面的判定不是安全边界** —— 一个真 socket 上的、会说谎的服务器**能**让界面说出「直写：已打开」（`6.1` 通过），真正的边界在服务端的门禁常量与能力表上；**这一层里最容易漏掉的三条断言**：整页不得声称「正常在线」而帮助里那条**规则原文**必须还在（A1 的断言范围因此缩到通栏与那四格）、**无读数**必须渲染成「无读数」而不是「未通过」（B2）、`paused === null` 必须渲染成 `data-paused="unknown"` 而不是 `"false"`（C4）；**§8 的自查抓到过一次真泄漏**（会话 cookie 的值被当作「名字」打印进了证据，见偏离项 142），修完之后留下的是一道**结构性**防线：拿 `@lwb/contracts` 声明的凭证形状（与 `packages/egress` **同一条规则**）复查每一行打印出去的字；**本任务不访问真实工作区**（G0/G2 未通过）、**不发外部网络请求**（唯一的网络往来是本机回环上的控制面）、**不涉及任何凭据的生成或使用**（唯一接触到的凭证是启动令牌与会话 cookie，两者都由本机服务当场签发、当场用掉） |
| LWB-036 完善差异查看与批准体验 | DONE | `apps/console/src/changes/`（**新增四个文件、改两处**：`review.ts`（**新**，337 行）复核覆盖 —— `ReviewCoverage` / `reviewCoverageOf({change, progress, gate})` / `recordPage` / `recordFullTexts`；`gate` 与 `progress` 是**输入**而不是两次查询，于是 `approvalAffordance` 的 `coverage` 是**必填**的，「批准入口能不能出现」在类型上**必然**经过「全都看过没有」，而 `ContentGate` 把「服务端说读不到内容」与「界面还没读到」分成两件事（它们要操作者做的下一步不同）；`paging.ts`（**新**，149 行）逐文件翻页与键盘映射 —— `REVIEW_KEYMAP` 是唯一一份方向表，按钮与键盘都走 `actionFor`，`stepFile` 到边界**停住**而不回绕（回绕会让「看完了」与「清单少了一项」长得一样）；`refresh.ts`（**新**，260 行）刷新的节奏 —— `REFRESH_ENDPOINT` 是一个**同源路径**、终态即停、不在前台就不排下一次、`SingleFlight` 把在途请求并成一次；`detail.ts`（**新**，463 行）把 `changes.get` 的响应解析成类型正确的对象（缺字段落 `null`，**唯独内容闸门落「拒绝」**）；`approval.ts`（改，92 行变动：判定次序 会话 → 修改集 → 状态 → 有效期 → 摘要 → **复核**，最后一步是新增的）；`index.ts`（导出面，七个文件的分工写在文件头））、`apps/console/components/DiffView.vue`（改，487 行）、`apps/console/views/ChangeDetailView.vue`（**新**，716 行）、`apps/console/views/ChangesView.vue`（改，606 行）、`apps/daemon/src/control/changes.ts`（**新**，501 行：`changes.list` / `changes.get` 两条控制操作 —— **本次修掉的那处真实缺陷就在这里，见偏离项 145**）、`apps/daemon/src/control/{control-plane,index}.ts`、`apps/daemon/src/tools/access.ts`、`apps/daemon/src/runtime/assembly.ts`（把复核读取接进真装配根）、`packages/changes/src/{index,query.ts}`、`packages/ipc/src/audience.ts`、`tests/unit/control-changes.test.ts`（**新**，790 行 / 18 例：登记与能力 · 闸门的形状（含「一个字节都没读」—— 对象目录被清空）· 不许出现 `canonical_root` 与操作者身份）、`tests/unit/console-changes.test.ts`（+681 行）、`tests/unit/control-plane.test.ts`（+36 行）、`apps/console/tests/change-detail-view.spec.ts`（**新**，577 行 / 30 例）、`apps/console/tests/{changes-view,diff-view}.spec.ts`（+19 例）、`tests/windows/daemon-apply-tool.test.ts`（**+1 例真 NTFS**：本地点击与工具调用同时发生 —— 验收标准 2）、`tests/windows/daemon-assembly.test.ts`（+6 行：控制面名字表里加 `changes.get` / `changes.list`，并写明它们**不在**工具面上 —— 模型读修改集走的是 `change_get`（按 `owner_connection_id` 收窄到它自己提议的那些），而控制台读的是**本机上的**全部修改集，两件事的判据不同所以是两个名字）、`scripts/evidence/lwb-036.ts`（**新**，1452 行；**74 PASS / 0 FAIL / 7 NOT_RUN**，退出码 0）；**装置与 LWB-035 同一套**（真装配根 + 真控制面 + 控制台**自己的**兑换链路与客户端 + 真读数），被证的事不同 —— **这一份里唯一合成的东西是「本机存着一条修改集」这条输入**：四个能力开关全关（`capabilityFlagsFrom` 每格 false，`gates.ts` 不接受任何配置覆盖），真实模型面**不可能**产出一条修改集，因此这条输入只能造；造的是**输入**不是**结论**：修改集经真的 `BlobStore`（真字节 `putAndRegister` + `verify` 回读核对）与真的 `ChangesRepo.create` 落进**运行中那个守护进程的**库（`openDatabase` 第二条连接，WAL 由 LWB-006 强制并核对过），随后每一句结论都从**真 HTTP 响应**读出来；**步骤 3 是本轮最要紧的一条**：400 行改成 10 行的删除在完整渲染里是 390 行删除（§9.2），撞上 2048 字节的上界时 `truncated` 置真且**不发出下一页的游标**（§9.5），于是复核算作「没看全」、**批准入口消失**（`TRUNCATED_DIFF`，§9.7），而**拒绝仍然给得出来**（§9.8 是它的对照）—— 「看不到」这个状态下唯一还成立的动作是拒绝；**这一轮因此修掉了我自己对截断的一处错误模型**：`groupHunks` 的文档注释说「丢掉装不下的那一条 hunk」，而代码从来是**在行边界切、按实际带上的行重数表头**（§9.6b 逐条核对 hunk 头里声明的行数等于它实际带出来的行数）—— 两句话给出的是**不同的表头**，照着注释去读证据里那个 `@@` 会算错（偏离项 146）；**验收标准 (a) 用真数据穷举四格**（§8）：只看过一个文件 ⇒ 覆盖不完整且缺口**按路径点名**；那个文件从未显示过 ⇒ 批准入口消失、理由是 `UNSEEN_FILES`；**拒绝**仍然给得出来；三个文件都看过 ⇒ 覆盖完整、批准入口出现，且那句话里的文件数就是**服务端清单的长度**（不是界面自己数出来的数）；§8.7 是**多给一个文件**的反例（把「看过的那几个」与「提案里的全部」分开），§8.8/§8.9 用**真闸门**（§6.7/§7 实测的那一格）落到 `unavailable` / `CONTENT_UNAVAILABLE` —— 理由不是「你没看」而是「看不到」；§8.6 钉住批准动作的幂等键绑的是**这一份摘要**（`console-approve:<change_id>:<short_code>`）；**验收标准 (b) 落在真盘上的一条新用例**（两条路同时进来，护栏写入调用次数为 1，两条回答指向**同一条** `operation_id`），本轮 windows 的 **+1** 就是它；**验收标准 (c) 是 §11 的递归扫描**：`apps/console/{src,views,components}` 24 个文件里**没有一处可加载的外部引用**（`src=` / `href=` / `fetch(` / `url(` / `@import`），代码行里出现的绝对地址**只有回环**，第三方跟踪脚本的引用零命中，指向外部主机的客户端**构造期**就抛（凭据与请求体没有一条路能出去），界面代码里的绝对地址**没有一个指向模型侧**；**步骤 2 由「刷新的目标是一个同源路径」钉住**（§10.1：没有主机可填，因此「向 ChatGPT 推送唤醒」这条路的容身之处不存在），另有四个判决点（待批准且在前台 / 不在前台 / 会话没了 / 终态）、一次**真的**状态流转后重读（§10.5 在真库上把修改集转成 `REJECTED` 再读一次）、以及同键在途只发一次；**两处装置缺陷**：§9.6 的第一版断言编码的是我对截断的错误模型（§9.6b 是补上来的正确判据，偏离项 147），§11 的两条判定一条被 `Array.filter` 的异步回调骗过（恒返回全部）、一条把 `SuspiciousEntry` 读成了跟踪器（`/i` 下 `sentry` 匹配 `…ousEntry`，偏离项 148）；**这一层里最容易漏掉的三条断言**：`truncated` 与 `unavailable` 都必须让**批准**消失而**拒绝**留下（少了后者，一个「看不全就什么都不让做」的界面会让操作者无法拒绝一份他不想批准的东西）、`next_cursor` 为 `null` **不等于**看全了（它说的是「没有下一页」）、「看全了」的判据是**每一条差异都渲染过**而不是「翻到了最后一页」；**本任务不访问真实工作区**（G0/G2 未通过）、**不发外部网络请求**（唯一的网络往来是本机回环上的控制面）、**不涉及任何凭据的生成或使用**（唯一接触到的凭证是启动令牌与会话 cookie，两者都由本机服务当场签发、当场用掉），脱敏由证据脚本的**逐行自查**把守（拿 `@lwb/contracts` 声明的凭证形状复查每一行打印出去的字，§13.1：101/102 行干净）；**七项未执行**：浏览器里的键盘走查（键映射在 §9.11 ~ §9.13 里量到了，但「按下去屏幕上真的翻页了」属浏览器）、读屏软件实际怎么念、**在真实工作区根上读文件内容**（闸门关着，这一条本文件证明不了）、真实 ChatGPT 网页验收、真仓库联调、点一次真批准并应用、以及工具面与界面两侧差异渲染的**逐字节**比对 —— 全部标 `NOT_RUN` 而不与 `PASS` 合并 |
---

## 当前仓库事实

```
$ node scripts/run-tests.mjs
# tests 1736 # suites 274 # pass 1736 # fail 0  # skipped 0   （含 tests/windows，仅在 Windows 上真正执行；LWB-035 时为 1679 / 267，LWB-034 时为 1678，LWB-033 时为 1620 / 260，LWB-032 时为 1548 / 244，LWB-031 时为 1515 / 239，LWB-030 时为 1485 / 238，LWB-029 时为 1390 / 223；本轮 **+57 例 / +7 套**，三处来源逐一对得上：`tests/unit/control-changes.test.ts` 新 18 例 / 3 套、`tests/unit/console-changes.test.ts` 29 → 67 例 / 4 → 8 套、`tests/unit/control-plane.test.ts` 例数不变（75）而那 +36 行是**就地改断言**（改判据不是加用例），另加 `tests/windows/daemon-apply-tool.test.ts` 的 1 例 —— 18 + 38 + 1 = 57，3 + 4 = 7；这一轮**没有删除任何用例**，也没有改动既有用例的数目）

$ node scripts/run-tests.mjs tests/windows
# tests 307  # suites 33  # pass 307  # fail 0  # skipped 0   （真实 NTFS + 真实护栏 + 真实 pwsh 助手；LWB-035 时为 306，本次 **+1** 是 `tests/windows/daemon-apply-tool.test.ts` 里那条「本地点击与工具调用同时发生：只有一条操作、只写一次」—— 验收标准 2 的落点；同一个文件里 `daemon-assembly.test.ts` 的 +6 行只是往控制面名字表里加了两个名字，**不是**新用例，故套数仍是 33；LWB-034 的 4 例真盘暂停用例与之一起把 300 抬到 305，LWB-033 时为 300 / 32，LWB-032 时为 283 / 29，LWB-031 时为 272 / 28，LWB-030 时为 242 / 27；故障注入那一组**不计在这里** —— `tests/fault-injection/` 与 `tests/unit/` 同在 `tests/windows/` 之外，它自己的计数见下一节）

$ node scripts/check-fsguard-imports.mjs
✅ FsGuard 导入检查通过（已检查 191 个文件，未发现绕过）。   （**这个数只随文件增减变化，与业务/允许两条前缀规则无关** —— 见偏离项 95；LWB-035 时为 184、LWB-034 时为 173、LWB-033 时为 171、LWB-032 时为 171、LWB-029 时为 164、LWB-028 时为 162；本轮的 **+7** 是数出来的，且**不是**按「新增了几个文件」估的 —— `apps/console/src/changes/` 下 4 个 `.ts`（`detail` / `paging` / `refresh` / `review`）、`apps/console/views/ChangeDetailView.vue`、`apps/console/tests/change-detail-view.spec.ts`、`apps/daemon/src/control/changes.ts`，与 `git status` 里这一轮的新增文件逐个对得上。`roots` 只含 `packages` / `apps` / `native`，因此 `tests/` 与 `scripts/` 下的新增（`tests/unit/control-changes.test.ts`、`scripts/evidence/lwb-036.ts`）**不在**这个数里；而 `apps/console/tests/*.spec.ts` 在 `apps/` 下、**在**范围里（它们只 import `vue` 与视图本身））

$ npm run daemon                                   # 装配根（apps/daemon/src/runtime/，不在任务书内 —— 见偏离项 92）
# 打印受保护存储根、控制台地址、数据管道、能力开关（全关）、清理结果；
# Ctrl+C 之后**先清理再退出**。四个能力开关全关，因此工具面一律 POLICY_DENIED —— 这是当前门禁下的正确结果。

$ npx tsc --noEmit
EXIT=0

$ npm --workspace @lwb/console run typecheck      # vue-tsc -p apps/console/tsconfig.json
EXIT=0

$ npm --workspace @lwb/console run test           # vitest run（happy-dom）
# Test Files 5 passed (5)  # Tests 144 passed (144)   （`diff-view` 28 · `changes-view` 32 · `change-detail-view` 30 · `setup-view` 29 · `workspaces-view` 25；LWB-035 时为 4 文件 / 95 例，本轮 **+1 文件 / +49 例** —— 新文件 30 例，加上 `changes-view` 与 `diff-view` 里为 LWB-036 补的 19 例）
EXIT=0

$ npm run check                                   # typecheck + typecheck:console + check:imports + test + test:console
EXIT=0

$ node --import tsx scripts/evidence/lwb-010.ts
EXIT=0

$ node --import tsx scripts/evidence/lwb-011.ts
# 38 PASS / 0 FAIL / 1 NOT_RUN
EXIT=0

$ node --import tsx scripts/evidence/lwb-012.ts
# 50 PASS / 0 FAIL / 4 NOT_RUN
EXIT=0

$ node --import tsx scripts/evidence/lwb-013.ts
# 44 PASS / 0 FAIL / 4 NOT_RUN
EXIT=0

$ node --import tsx scripts/evidence/lwb-014.ts
# 30 PASS / 0 FAIL / 4 NOT_RUN / 1 NOTE   （LWB-015 改动后重新采集）
EXIT=0

$ node --import tsx scripts/evidence/lwb-015.ts
# 26 PASS / 0 FAIL / 5 NOT_RUN
EXIT=0

$ node --import tsx scripts/evidence/lwb-016.ts
# 118 PASS / 0 FAIL / 5 NOT_RUN
EXIT=0

$ node --import tsx scripts/evidence/lwb-017.ts
# 68 PASS / 0 FAIL / 4 NOT_RUN
EXIT=0

$ node --import tsx scripts/evidence/lwb-018.ts
# 40 PASS / 0 FAIL / 5 NOT_RUN / 8 NOTE
EXIT=0

$ node --import tsx scripts/evidence/lwb-019.ts
# 60 PASS / 0 FAIL / 7 NOT_RUN / 33 NOTE
EXIT=0

$ node --import tsx scripts/evidence/lwb-020.ts
# 57 PASS / 0 FAIL / 9 NOT_RUN / 36 NOTE
EXIT=0

$ node --import tsx scripts/evidence/lwb-021.ts
# 51 PASS / 0 FAIL / 6 NOT_RUN / 9 NOTE
EXIT=0

$ node --import tsx scripts/evidence/lwb-022.ts
# 34 PASS / 0 FAIL / 7 NOT_RUN / 2 NOTE
EXIT=0

$ node --import tsx scripts/evidence/lwb-023.ts
# 28 PASS / 0 FAIL / 7 NOT_RUN / 3 NOTE
EXIT=0

$ node --import tsx scripts/evidence/lwb-024.ts
# 37 PASS / 0 FAIL / 5 NOT_RUN / 1 NOTE
EXIT=0

$ node --import tsx scripts/evidence/lwb-025.ts
# 65 PASS / 0 FAIL / 4 NOT_RUN
EXIT=0

$ node --import tsx scripts/evidence/lwb-026.ts        # 真库文件 + 真跨进程（自 spawn 自己）
# 49 PASS / 0 FAIL / 7 NOT_RUN / 1 NOTE
EXIT=0

$ node --import tsx scripts/evidence/lwb-027.ts        # 真 NTFS + 真 Win32 句柄 + 真护栏助手
# 58 PASS / 0 FAIL / 5 NOT_RUN / 5 NOTE   （LWB-029 重跑；原 55 / 0 / 5 / 4，5 处断言被重指）
EXIT=0

$ node --import tsx scripts/evidence/lwb-028.ts        # 同一套真 NTFS 装置 + 真护栏助手
# 64 PASS / 0 FAIL / 7 NOT_RUN / 2 NOTE   （LWB-029 重跑；原 61 / 0 / 7 / 2，6 处断言被重指）
EXIT=0

$ node --import tsx scripts/evidence/lwb-029.ts        # 真 NTFS + 真 SQLite + 真多进程
# 71 PASS / 0 FAIL / 7 NOT_RUN / 2 NOTE
EXIT=0

$ node --import tsx scripts/evidence/lwb-030.ts        # 真 NTFS + 真 SQLite + 真 pwsh 护栏
# 176 PASS / 0 FAIL / 8 NOT_RUN / 2 NOTE   （启动恢复：判定四格 / 三条验收标准 / 授权签发与消费）
EXIT=0

$ node --import tsx scripts/evidence/lwb-031.ts        # 真 NTFS + 真 SQLite + 真 git 仓库
# 107 PASS / 0 FAIL / 8 NOT_RUN   （撤销提议：逆操作生成**新的**修改集 / 三种冲突各自明确 / 新建文件只输出本地方案）
EXIT=0

$ node --import tsx scripts/evidence/lwb-032.ts        # 真 NTFS + 真 SQLite + 真 MCP 适配器 + 真工具面
# 125 PASS / 0 FAIL / 6 NOT_RUN   （应用工具：回执逐文件哈希 / 重复调用不产生第二次写 / 未完成如实回答 in_progress）
EXIT=0

$ node --import tsx scripts/evidence/lwb-033.ts        # 真 NTFS + 真护栏 + 真进程死亡 + 真 SQLite 文件库
# 111 PASS / 0 FAIL / 6 NOT_RUN   （竞争五格 / 故障五格 / 断网无故障面的静态证明 / 真 SIGKILL 一个真执行者再跑真启动恢复 / 门禁六格）
EXIT=0

$ node --import tsx scripts/evidence/lwb-034.ts        # 真 NTFS + 真护栏 + 真工具面 + 真控制面 + 真 SQLite 文件库
# 61 PASS / 0 FAIL / 5 NOT_RUN   （写到一半停用 / 「正在停止」的读数 / 停用不重放旧批准 / 工具面与控制面说同一件事 / 暂停活过重启）
EXIT=0

$ node --import tsx scripts/evidence/lwb-035.ts        # **真装配根 + 真控制面 + 控制台自己的兑换链路与客户端**
# 51 PASS / 0 FAIL / 6 NOT_RUN   （三行实测（`/` 与 `/index.html` 都 404、`/api/status` 401）/ 真令牌兑换与一次性 / 真读数喂进控制台判定 / 验收标准 3 的反例 / 脱敏诊断跑在真数据上 / 一个会说谎的服务器 / 真 vitest 与真 node 计数 / 自查（路径与凭证形状））
EXIT=0

$ node --import tsx scripts/evidence/lwb-036.ts        # 真装配根 + 真控制面 + 控制台自己的兑换链路与客户端（**装置同 LWB-035，被证的事不同**）
# 74 PASS / 0 FAIL / 7 NOT_RUN   （复核读取的真 HTTP 形状 / 修掉的那处缺陷的判据：缺这一句话时是 500 · INTERNAL_ERROR，补上之后是 400 · POLICY_DENIED（§7）/ 验收标准 (a) 的四格穷举 / 步骤 3 的大范围删除与行边界截断 / 步骤 2 的四个刷新判决 / 验收标准 (c) 的递归扫描 / 真 vitest 与真 node 计数 / 自查（路径与凭证形状））
EXIT=0
```

### 构建步骤与测试运行器（LWB-023 起有变化）

LWB-023 引入了本仓库的**第一处构建步骤**与**第二个测试运行器**。这两件事都改变
了仓库级事实，因此单列在这里，而不只写在任务的证据文件里。

| 项 | 之前 | 现在 |
| --- | --- | --- |
| 构建步骤 | 无。直接执行 TS 源文件（`tsx` + `node --test`） | 控制台 Vue 页面由 Vite 构建；`npm run daemon` 的 `predaemon` 先构建 `apps/console/dist/`，daemon 从固定资产表同源托管。daemon 主程序 / 适配器 / 包层与其余测试仍直接运行 TS |
| 根 tsconfig 覆盖 | 全部 `.ts` | 仍覆盖 `apps/console/src/`（**刻意不排除**：那一层「不依赖 DOM」这件事正需要无 DOM lib 的配置来把关），但排除 `.vue` 与 `apps/console/tests` |
| 类型检查 | `tsc --noEmit` | 加 `vue-tsc -p apps/console/tsconfig.json` |
| 测试运行器 | `*.test.ts` → node 运行器 | `*.test.ts` → node 运行器；**`*.spec.ts` → vitest（happy-dom）** |
| `npm run check` | typecheck + check:imports + test | 再加 `typecheck:console` 与 `test:console`（5 步） |
| 静态导入检查 | 只收 `.ts`，业务前缀到 `apps/console/src/` | 收 `.vue`（只解析 `<script>` 块，**掩空白以保行号**），业务前缀放宽到 `apps/console/`（见偏离项 82） |

**按文件名后缀分运行器，而不是按目录分。** 理由是失败方向：把一个 vitest 用例命名为
`.test.ts`，node 运行器会去收它并因无法 `import .vue` 而**响亮地报错**；按目录分则会出现
「两个运行器都不收、双双报成功」的静默盲区 —— 而那正是本工程反复记录的失败形态
（偏离项 9/15/20）。对应的兼容性文档更新在 `docs/compatibility.md` §2。

## 需要注意的既有偏离

1. **原生护栏后端是 PowerShell + .NET P/Invoke（过渡方案）**，不是编译型原生模块。
   本机没有 Rust / MSVC / Windows SDK / .NET SDK。决策、实测延迟与替换触发条件见 ADR-002 §5。
2. **迁移以 TS 常量交付**，不是任务书写的 `packages/persistence/migrations/` 目录。理由见
   `docs/evidence/lwb-006/summary.md` §1。
3. **LWB-002 处于 BLOCKED**：隧道侧的安装与自检（2026-09-26）**已经做完**，
   剩下的是两个只有账号持有人能创建的凭据（`tunnel_id`、runtime key）与两项只有管理员能授予的权限
   （Tunnels Read + Use、ChatGPT developer mode）—— 逐条见
   `docs/evidence/platform-capability.md` §8。该任务的通过条件包含「真实网页验收」，
   MCP Inspector 成功**不能**替代；**今天一次都没有连上过隧道**。
4. **Windows 上目录项 fsync 不可用**（`directory_synced: false`，Win32 不支持对目录句柄
   `FlushFileBuffers`，Node 也拒绝以读取方式打开目录）。快照内容本身已 fsync；
   「改名已持久」这句话依赖 NTFS 元数据日志，属操作系统保证，本程序不为其背书。
   实测见 `docs/evidence/lwb-007/summary.md` §3.3。
5. **`apps/daemon/src/lifecycle/` 与 `apps/daemon/src/control/` 已建立，`apps/console/`
   仍不存在。** `scripts/check-fsguard-imports.mjs` 中针对 `apps/console/` 的前缀规则仍是
   **前瞻性声明**（LWB-005 建立骨架时预置）。注意 `apps/daemon/src/lifecycle/`
   在允许清单（可用 `child_process`）而不在业务清单内，因此规则 1 对它不生效 ——
   这是有意的，它是进程边界的实现者；`apps/daemon/src/control/` 则相反，它在**业务清单**
   内（LWB-009 加入），必须通过受控接口访问文件系统。
6. **`isomorphic-git` 已由 LWB-016 引入并实测**（`statusMatrix` / `currentBranch` /
   `resolveRef` / `readBlob` 四个入口），用法限制与实测结论见偏离项 39 / 41 / 45 / 47；
   `@modelcontextprotocol/sdk` **仍然零使用**，等 LWB-017。在真正用起来之前，
   它的兼容性状态是「已锁定」而非「已验证」（`docs/compatibility.md` §2）。
7. **LWB-008 交付物目录与任务书不一致**：任务书写 `apps/daemon/lifecycle/`，
   实际为 `apps/daemon/src/lifecycle/`，以 `check-fsguard-imports.mjs` 的
   `ALLOWED_PREFIXES` 与 `package.json` 的 `daemon` 脚本为准。理由见
   `docs/evidence/lwb-008/summary.md` §2.1。
8. **daemon 被强杀时子进程不会被回收**（无 Job Object，需 `native/` 真正实现）。
   缓解仅在助手一侧监听 stdin 关闭，不覆盖助手卡死。见
   `docs/evidence/lwb-008/summary.md` §6 第 1 条。
9. **`check-fsguard-imports.mjs` 的规则 1 存在一个静默盲区**：条件是
   `isBusiness && !isAllowed`，因此**两个清单都不在**的包既不被允许、也不被检查，
   而检查器照常打印「未发现绕过」。新增包时必须显式写进其中一个清单。
   仅靠阅读无法区分「在 ALLOWED 清单里」与「哪个清单都不在」——两者结果相同，
   只能用**反向探针**（种一个故意违规的文件，确认检查器报错，再删除）证实覆盖有效。
   本次即以该法证实 `packages/workspaces/` 在检查范围内。见
   `docs/evidence/lwb-009/summary.md` §5 第 1 条。
10. **迁移 v2（`workspace_kind_allows_single_file`）是表重建，不能靠回退代码撤销**。
    已升级的库 `schema_version = 2`，回退代码后会被 `KNOWN_SCHEMA_VERSION` 判为
    「高于本程序理解的版本」而拒绝打开 —— 方向是 fail-closed，但**不是**静默可用。
    确需回到 v1 须显式导出/重建/导入。见 `docs/evidence/lwb-009/summary.md` §7。
11. **写入绑定的是内容基线，不是跨调用的文件身份。** 把工作区**内**的父目录换成另一个
    目录、而那里的同名文件内容完全相同时，`writeFileGuarded` 会照常写入一个
    `file_id` 与批准时不同的对象。这是**已知边界**：本系统的授权范围是
    「工作区根身份 × 相对路径 × 内容基线」，三者在此前提下全部成立，且可观察结果
    与批准预期一致；内容不同时由基线挡住。回执里的 `identity_before/after` 必须是
    **实际打开的那个**对象（已断言）。见 `docs/evidence/lwb-010/summary.md` §4。
12. **`WinfsGuard.ps1` 里有一个不在生产接口里的 `holdHandle` 操作。** 它故意不释放句柄，
    唯一用途是让并发交换父目录的验证能观察「护栏持有整条链时外部能否改名」。
    它**不在** `WinfsOps` 接口里，因此 TypeScript 生产代码够不着它；
    仅由
    `tests/windows/path-escape/parent-swap.test.ts` 与 `scripts/evidence/lwb-010.ts`
    经真实的行 JSON 协议调用。不要把它的存在读成「生产接口有这么一个口子」。
13. **PowerShell 消息里的变量插值有 CJK 陷阱。** `"$Label是重解析点…"` 会被解析成
    一个名为 `Label是重解析点` 的变量（值为 `$null`），拒绝理由的**主语静默消失**
    而功能仍然"正常拒绝"。变量名后紧跟非 ASCII 字符时一律写 `${Label}`。
14. **`change_apply` 要求 `propose`，不要求 `apply`。** 冻结契约
    （`packages/contracts/src/capabilities.ts`）把 `apply` 放进 `CONTROL_ONLY_CAPABILITIES`，
    模型凭据永远拿不到它；若 `change_apply` 要求 `apply`，模型调用它只会得到
    `NOT_AUTHORIZED`，而工具契约（`packages/contracts/src/tools.ts:276`）与 LWB-028
    的验收标准要求的是 `APPROVAL_REQUIRED`。调和方式是：**能力决定「能不能发起」，
    批准决定「能不能落地」** —— 写入的授权来源自始至终是本地操作者的批准，不是能力位。
    连接层另有一条独立检查：模型侧凭据里出现任何控制面专属能力即判该凭据无效。
    见 `docs/evidence/lwb-011/summary.md` §5。
15. **`packages/policy/` 与 `packages/egress/` 已加入 `check-fsguard-imports.mjs` 的
    `BUSINESS_PREFIXES`**（LWB-011），因此两者都在业务清单内、必须通过受控接口访问
    文件系统。覆盖有效性已用**反向探针**证实（两个包各验证一次，见偏离项 9 与
    `docs/evidence/lwb-011/summary.md` §6）。文件数由 58 增至 66。
    LWB-010 期间实测中招 3 处，全部仓扫描后确认只有那 3 处（其余 `$Var` 后面跟的是
    全角标点，不构成标识符字符）。见 `docs/evidence/lwb-010/summary.md` §7 第 2 条。
16. **控制台认证层放在 `apps/console/src/auth/`，不是任务书写的 `apps/console/auth/`。**
    理由与偏离项 7 相同：静态检查按 `apps/console/src/` 前缀识别业务包，放在 `src/` 之外
    会让这层代码**落在两个清单之外** —— 既不被允许、也不被检查，而检查器照常打印
    「未发现绕过」（同偏离项 9 的静默盲区）。见 `docs/evidence/lwb-012/summary.md` §5.1。
17. **控制平面凭证是一条独立的出站秘密规则（第 15 条 `control-plane-token`），
    不是 LWB-011 既有规则的延伸。** 既有各条保护的是**用户的**秘密（`.env` 里的密钥、
    私钥、云厂商令牌），这一条保护的是**本程序自己的授权凭据**（启动令牌 / 会话 /
    CSRF / 一次性 nonce）—— 泄露它等于把「批准」这件事本身交出去，持有者可以批准
    自己的写入。因此它必须在 `certain` 档（形状即凭证，没有"可能是占位符"的余地），
    且形状定义与签发端共用 `packages/contracts/src/control.ts`，避免生成端与筛查端漂移。
    这条规则使 `docs/evidence/lwb-011/summary.md` 的规则清单由 14 条变为 15 条，
    该证据文档已按 15 条重新采集（仅规则清单与计数变化，验收结论不变）。
18. **`apps/console/src/auth/` 是框架无关的纯 TypeScript，不能依赖浏览器全局。**
    仓库 tsconfig 只有 `lib: ["ES2023"]`、**没有 DOM lib** —— 这不是疏漏，是有意的：
    它让这一层不可能依赖 `History`、`window` 之类的全局，于是能在 node 里被直接测试，
    从而「我先在浏览器里点一遍」不会被误当成验证。需要浏览器概念时用结构化类型
    （如 `HistoryLike`），不用 `Pick<History, …>`。
    **控制台界面（六个页面）属 LWB-035，本任务不交付。**
19. **护栏的 `resolvePath` 曾经不返回 `canonical_relative_path`，使接上真实护栏后的读取
    **一次都跑不通**。单元测试看不见它：桩**照契约**提供了这个字段，验的是流水线，
    验不到边界。真正把它抓出来的是 `tests/windows/files-read.test.ts`（真实 NTFS +
    真实护栏），首次运行 14 例中 12 例在同一条 `undefined.includes` 上失败。
    根因是**边界层的类型谎言** —— 后端用 `as unknown as WinfsReadResult` 强转一个
    缺字段的对象，于是「护栏少给了一个字段」既不报编译错、也不被桩拦下。
    修法三处：护栏补上该字段；后端**去掉强转**改成完整字面量（从此漏字段是编译错误）；
    `gatePathFor` 的判据由 `=== null` 放宽到 `== null`（护栏是外部边界，漏报给
    `undefined`，含义与 `null` 相同即「无法证明在根之下」，都拒绝；`''` 不在此列，
    它是单文件工作区里「目标就是根」的合法拼写）。见
    `docs/evidence/lwb-013/summary.md` §4.2。
20. **`packages/files/` 的前缀是 LWB-005 建骨架时预置的**（与偏离项 5 说的
    `apps/console/` 同类，属**前瞻性声明**），LWB-013 是第一个真正往里放文件的包，
    该前缀由此从声明变为实际生效。文件数 79 → 83，增量**恰好是新增的四个
    `packages/files/src/*.ts`** —— 检查器只收集 `packages/`、`apps/`、`native/`
    三个根下的 `.ts`，两个测试文件与证据脚本在 `tests/`、`scripts/` 下，不计入。
    该包**不直接接触文件系统**（所有磁盘访问都经过注入的 `WinfsOps`），
    放进业务清单是为了让「将来有人图省事直接 `import fs`」变成检查器报错，
    而不是靠约定。覆盖有效性已用**反向探针**证实（种一个故意违规的文件，
    检查器报 `FSGUARD_BYPASS` 并以 1 退出，删除后恢复通过），同偏离项 9 的要求。
    `scripts/check-fsguard-imports.mjs` 本次**未修改**。
21. **LWB-013 的交付物路径与任务书不一致**：任务书写 `packages/files/read.ts`，
    实际为 `packages/files/src/{decode,read-token,read}.ts`。理由与偏离项 7 / 16 相同：
    静态检查按 `src/` 前缀识别业务包，放在约定之外会让代码**落在两个清单之外**
    （同偏离项 9 的静默盲区）。契约侧同：`packages/contracts/src/read.ts`。
22. **契约新增两个常量与一个字段**（LWB-013）：`MAX_READABLE_FILE_BYTES`（16 MiB）、
    `READ_TOKEN_TTL_MS`（1 小时）、`FileReadData.truncated_lines`。
    可读上限**高于**可编辑上限与单次改动上限 —— 能读的东西比能改的多，
    方向是刻意的。签名的读取票据是无状态的（不随读取次数增长，因此不会被
    「读一万个文件」撑爆），代价是**有效期成为唯一的失效机制**，故该常量必须存在。
23. **「分页」不使结果不可编辑。** 契约说 `editable` 表示「该文件是否可被编辑」，
    方案 §6.3 要求编辑区间落在读取票据的**已见范围**内；两者合起来只有一种自洽实现：
    票据绑定实际返回的行范围，编辑必须落在范围内。若把「本次没返回整个文件」
    直接判成不可编辑，任何超过一页（400 行）的文件都永远无法编辑。
    **不可编辑性的来源是「这段正文不能作为基线」，不是「这段正文只是一部分」** ——
    行号错位、被截断、被脱敏、混用换行属于前者，分页不属于。见
    `docs/evidence/lwb-013/summary.md` §5.2。
24. **单文件工作区读 `.env` 的硬拒绝缺口在读取侧已补，登记侧未补。**
    规范路径为空串表示「目标就是根」，而空串不命中任何按名字匹配的硬拒绝规则，
    于是「把 `.env` 登记成单文件工作区」可以绕过 `HD-ENV`。读取侧现在改用
    `basename(root_path)` 过闸门（已实测拒绝）。但 `packages/workspaces` 的
    `screenRoot()` **没有**使用 `@lwb/contracts` 里已导出却无人调用的
    `isProtectedPathSyntax()` —— 登记侧拦的是「把密钥文件设成工作区根」，
    后果与读取侧不同，**本任务只修了后者，前者留给 LWB-014 或后续任务**。
    在此记录以免被读成「已经修好了」。
25. **护栏的 `PERMISSION_DENIED` / `IO_ERROR` / `VOLUME_UNSUPPORTED` 刻意映射成
    `INTERNAL_ERROR`**，并在 `details` 里保留 `winfs_code` 与 `win32_error`。
    契约里没有 ACL 拒绝的等价码：`PATH_UNSAFE` 的语义是「路径或身份不安全」，
    而这里路径没问题、是权限不够；`POLICY_DENIED` 更不对 —— 那意味着本地策略拒绝，
    用户去改策略是白费功夫。**给一个听起来合理的码会把调用方引向错误的方向。**
26. **两次打开的身份比对有一个已知残余**：本实现的写冲突检测是「探针取身份 →
    读取字节 → 比对身份与尺寸」，抓得住替换/改名/尺寸变化，但**抓不住「同一个对象
    被一个已存在的写句柄就地改成了同样大小」**（两次打开的 `file_id` 与 `size` 相同）。
    残余由写入侧的 `base_sha256` 在同一个句柄内复核兜住（I07），
    因此这一层缺口不会变成「基于旧内容写入」。见
    `docs/evidence/lwb-013/summary.md` §5.5。
27. **分页游标只承载起点，不承载页大小。** 续读要拿到与上一页同样大的页，
    必须带同样的 `max_lines`；不带就回到硬上限（`MAX_READ_LINES`），
    即得到一页**更大**的结果。不把页大小写进游标，是因为契约把 `max_lines`
    定义为**每次调用的参数** —— 偷偷塞进游标会让同一个参数在不同调用上含义不同。
    该语义已写进 `packages/files/src/read.ts` 的 `resolveStartLine` 文档注释，
    并由 `tests/windows/files-read.test.ts` 钉住。
28. **限额覆盖已接线一半，「生效」仍没有生产入口。**（LWB-013 登记，LWB-018 更新）
    LWB-018 之前：`NON_RELAXABLE_LIMITS` **已导出但无人读取**，`validateLimitOverride`
    **没有任何调用点**。LWB-018 修掉了两件事：
    - **那份清单本身是错的。** 它里面只有 `MAX_CONCURRENT_WRITES_PER_WORKSPACE`，
      而那一项**不在** `OPERATOR_TUNABLE_LIMITS` 内 —— 两条清单互不相交，于是
      「可以收紧、不能放宽」这条语义**对任何一个键都不成立**，配置永远碰不到它。
      现改名为 `TIGHTEN_ONLY_LIMITS` 并放进真正可调的两个并发键
      （`MAX_CONCURRENT_READS` / `MAX_CONCURRENT_READS_PER_CONNECTION`）。
      固定项另立 `FIXED_LIMITS`，「不可调」与「可收紧不可放宽」从此是两件事。
    - **方向校验落地。** 新增 `validateLimitDirection(key, value, current)`，由
      `packages/limits/src/overrides.ts` 的 `resolveLimits` 调用 —— 这是
      `validateLimitOverride` 的第一个调用点。方向拿**当前值**比而不是初值：
      覆盖是分层叠加的，拿初值比会让「先放宽、再声称没放宽」成为一条可行路径。
    **仍未闭合的部分：`resolveLimits` 没有生产调用方。** 它的结果要去的地方
    （`ToolHandlerDeps.effective_limits` → `concurrencyGateFor`）已经存在且被测试与
    证据脚本使用，但**装配根还不存在**（见偏离项 55 与 `apps/daemon/src/main.ts` 缺席），
    因此「本地配置能收紧限额」这件事今天是**可判定但不可用**的。
    「在 LWB-018 取证」这条要求因此只完成了一半，本项**保持记录**。
29. **判决路径按「问的是不是同一个问题」分为两个函数，而不是加一个开关**（LWB-014）。
    护栏的 `resolvePath` **刻意拒绝**空相对路径（目录工作区里「根」不是一次寻址），
    而读取与列举都要算出一个「用来过闸门的名字」：读取问的是「我要读的这个**文件**
    叫什么」，目录工作区里根本没有这个文件；列举问的是「我要枚举的这个**基准**叫什么」，
    根永远有一个名字。两者的共同部分是 `requireCanonicalPath`（取不到句柄规范路径即
    拒绝，绝不退回请求里的字符串）与 `rootNameOf`，分歧点各写各的。
    **读取侧保持原样不放宽**（`gatePathFor`，由
    `tests/unit/files-read.test.ts` 的 `EMPTY_PATH_FOR_DIRECTORY_WORKSPACE` 钉住）——
    为了「列举好写」而放宽读取，是把一条已证过的拒绝改成了没有用例覆盖的放过。
30. **列举的「起点」有两条来路：探针，或直接取作用域事实**（LWB-014）。
    `resolveBase()` 只在「目录工作区 + 空相对路径」这一种输入上跳过探针，
    直接取 `canonical: ''` 与 `root_volume_id` / `root_file_id`。
    这不是省掉一次证明：护栏的 `Open-GuardedChain` **每一次**调用都会用句柄算出的
    卷序列号与文件索引比对请求里声明的根身份，不符即 `ROOT_IDENTITY_MISMATCH`。
    因此写进游标的 `base_file_id` 仍是每次被重新核实过的值。
    另：`singleFileListing()` 曾把**判决路径**当回执路径，使单文件工作区的
    `path` 回成文件名而不是空串（与 `file_read` 在同一工作区里的约定不一致）；
    现在回执路径与判决路径是两个值，`docs/evidence/lwb-014/summary.md` §4.2 记录了
    这次真实运行才暴露出来的一对缺陷。
31. **`MAX_DIRECTORY_ENTRIES = 200` 意味着「整棵树一次列完」在设计上就不存在**（LWB-014）。
    沙箱里 1050 条的目录在默认限额下**任何** `depth` 都不可能一次覆盖，
    因此断言「被拒绝的条目不在结果里」时，必须用不会在它之前填满页面的深度 ——
    ordinal 序（`.env` < `.ssh` < `big` < `ghp_`）决定了谁先被处理完，这一条已写进
    `tests/windows/files-list.test.ts` 的文件头注释。跨页一致的证法是**两条独立的
    翻页路径互相印证**（200 与 50 两种页大小各翻一遍，序列逐条相同），
    而不是「和一次列完比」——后者在大目录上根本构造不出来。
32. **`.ssh` 被 `HD-CREDENTIAL-STORE` 硬拒绝，这一事实改变了多处夹具的预期**（LWB-014）。
    `.ssh` 与 `.env` 一样在**列举阶段就被丢弃**且**从不被枚举**。注意偏离项 24 的
    登记侧缺口**仍然敞开**：`packages/workspaces` 的 `screenRoot()` 至今没有调用
    `isProtectedPathSyntax()`。本任务只证到「把它登记成工作区根之后，列举会被拒」
    （`HD-PLUGIN-STATE` / `HD-ENV`，见 `docs/evidence/lwb-014/summary.md` 验收标准 3），
    **没有**堵住登记这个入口本身。

33. **搜索的秘密预筛判的是整个文件，代价是每个文件一次全量筛查**（LWB-015）。
    判据取自整份解码后的文本，而不是「拼出来的片段里有没有」：跨行形状的凭证
    （私钥正文）在被切成一行的片段里认不出来，逐片筛查会把**正文本身**原样送出去。
    代价实测为 16 MiB 约 73–264 ms（视内容而定），且**每个被扫描的文件都要付**，
    不管它有没有命中。三处兜底：读取之前的尺寸预检、单次扫描字节上限、deadline。
    本任务**没有**做「先看有没有命中再决定要不要全量筛查」的优化 ——
    那会形成「命中越少筛得越少」的形状，而漏掉的那一类正是「凭证所在行没有命中」的文件。
34. **逐片那一遍预筛不是冗余，两个判定互不蕴含**（LWB-015）。
    `\b` 在**输入起点**处成立：令牌前面接一个词字符时整份文本判不出，
    而从令牌第一个字符起切的片段判得出；私钥那一条则是反过来。
    这条在本任务里被**证成事实**而不是留在注释里 —— 第一版边界夹具只做了前边界那一半，
    于是 `screenText(整行).has_certain` 与 `screenText(片段).has_certain` **都是 false**，
    那条用例当时测的是「没有凭证的文件」（`docs/evidence/lwb-015/summary.md` §4.1）。
    现在两侧都在屏幕上断言，夹具一旦落不到边界上用例立刻失败。
35. **`secret_files` 是 `scanned_files` 的子集，且不让整次搜索失败**（LWB-015）。
    与 `file_read` 的 certain 档**抛错**不同：搜索一次可能扫几百个文件，
    一个文件里的凭证不该让剩下的 99% 变成一条错误（在大仓库里那等于搜索永远不可用）。
    字节确实读了，因此同时计入 `scanned_files` / `scanned_bytes`，另计 `secret_files`
    并把 `complete` 置为 false。但**两个口径必须一致**：同一个文件不可能
    「整体读不出来、但能搜出一部分」，因此含高置信度凭证的文件在两条路径上都不出站内容。
36. **`skipped_files` 不含「没进入的目录里的文件」**（LWB-015，与偏离项 31 同源）。
    `skipped_files = 搜索排除/重解析点的**文件** + 不匹配 glob + 超出单次可读上限 + 打不开`。
    `.ssh/id_rsa` 与 `node_modules/pkg/index.js` 从未被枚举，因此既不在
    `denied_files` 里也不在 `skipped_files` 里 —— 计数只在「本来看得到、这次没给」
    的范围内说话。`docs/evidence/lwb-015/summary.md` 里这条由**与真实目录对账**钉住
    （期望值由 `@lwb/policy` 的规则表作用在 `readdir` 的结果上算出），
    顺带钉住了另一件容易漏的事：`ghp_…txt` 按路径规则是**允许**的，
    它被拒是因为**名字本身**命中了 `github-token` —— 归宿相同、判据不同。
37. **搜索不读时钟、不持有状态**（LWB-015）。`clock`（单调读数，管预算）与
    `now`（本地时刻，管票据）都由调用方注入，分页位置全在签名游标里，
    因此进程重启不丢游标、超时不依赖系统时间。代价是两者**刻度必须一致**：
    `tests/windows/files-search.test.ts` 第一版把基准取在**进程**启动时刻，
    并行跑测试文件时 `before` 钩子就吃掉了 3 秒预算，于是 6 条真实护栏用例
    全部返回空结果 —— 而空结果看起来像「搜索坏了」，不像「测试写错了」。
38. **`SearchLimits` 的调用方覆盖入口仍未接线**（LWB-015 登记，LWB-018 更新；接偏离项 28）。
    每一项限额都可以由本地操作者收紧，但**这条通路仍然没有实现到生产入口**：
    LWB-018 补上了「叠加 + 校验」（`resolveLimits` 会读 `SearchLimits` 里的每一项，
    未知键、非正整数、`FIXED_LIMITS` 里的项各有各的拒绝理由；方向校验只对
    `TIGHTEN_ONLY_LIMITS` 里的两个并发键生效，其余可调项按设计允许放宽），
    但**没有任何生产代码调用 `resolveLimits`**（装配根不存在，同偏离项 28）。
    它今天被测试与证据脚本用来构造边界（把字节上限调成 40、把时间预算调成 0），
    **不得**读成「已经生效」。
39. **只读 Git 的内部读取是「窄范围清单」，形状也是清单的一部分**（LWB-016）。
    `GIT_FILE_ALLOW` 只认 `.git/objects/<2 位十六进制>/<38 位十六进制>`
    （一个完整 oid）、`packed-refs`、`shallow`、`info/exclude`、`refs/**`、
    `HEAD`、`index`。**刻意不放行**的：`.git/config`（`HD-GIT-CONFIG`）、
    `.git/hooks/*`（本层不执行 hooks 就没有理由读它）、`.git/logs/HEAD`（reflog
    不在只读状态/差异所需范围内）、以及 **`.git/objects/<ab>` 这类两字符分片目录
    不可列举** —— 开放它等于允许把整个对象库的名字列出来，而「模型能枚举 `.git`
    内部」正是本任务要排除的形态（库找松散对象时 `lstat` 的是具体路径，不需要列举）。
    拼写变体先归一化再判定（`.git/./config` → `.git/config`），顺序反过来就是一条绕过；
    `'..'` 段一律拒绝（它真的能走出工作区），`'.'` 段是无操作（理由见偏离项 45）。
40. **库为「读不到」编造的行必须在结果层再摘一遍**（LWB-016）。
    `statusMatrix` 的遍历是三棵树求并集：一个**被跟踪**的 `.env` 在 HEAD 与 STAGE
    里都是 blob，于是库内部那句 `if ((workdirType === 'tree' || workdirType === 'special') && !isBlob) return`
    不成立，它照样会排出一行 `[1, 0, 3]` —— 读作「工作区里被删了」，**那不是事实，
    是我们没读**。受控 fs 能保证「不去读」，保证不了「不出现在结果里」（前者问库要什么，
    后者问策略让不让说），所以结果层必须按同一份规则表再过一遍。
    「没能比对」与「没有改动」因此是两件不同的事，单列在 `GitStatusExclusion` 里
    （`FILE_TOO_LARGE` / `IDENTITY_UNAVAILABLE` / `LINK_UNSUPPORTED`）。
41. **`ignored` 状态不存在，而这是实测结论不是遗漏**（LWB-016）。
    被忽略的文件要出现在结果里只能靠 `statusMatrix` 的 `ignored: true`，而那个开关
    会**同时**让工作区遍历进入 `.git/` 并返回 `.git/**` 的路径（实测）。也就是说
    「能不能看见被忽略的文件」与「模型能不能枚举 `.git` 内部」是同一个开关。
    契约的 `GitFileStatus` 因此没有 `ignored`，被忽略的文件不进任何计数字段。
42. **Git 差异比较的是原始字节，不套用 Git 的语义**（LWB-016）。
    `core.autocrlf` 与 `.gitattributes` 会改变「什么算差异」，而套用它们要先读
    `.git/config` —— 那条路径被 `HD-GIT-CONFIG` 硬拒绝。**不为「让比较更像 git diff」
    开这个口子**：差异按原始字节算，`note` 里明说这一点，两侧 sha256 都如实给出。
    实测后果：工作区的 CRLF 与对象库里的 LF 是一处**真实差异**，而 `git diff`
    可能什么都不显示；同一条原则的另一个面是「二进制两侧不产出文本差异」。
43. **布局降级只降 Git 能力，不降工作区**（LWB-016）。外置 gitdir（`.git` 是文件）、
    alternates、未支持的对象格式/索引一律 `GIT_LAYOUT_UNSUPPORTED` 并带 `reason`
    （实测 `GITDIR_FILE`）；「这里没有仓库」用另一个码 `NOT_FOUND`（`NO_GIT_DIR`），
    单文件工作区是 `NOT_FOUND`（`FILE_WORKSPACE`）。两个码刻意不同：参数怎么改都不会
    变出一个仓库，因此那不是参数错误；而三种情形下**同一工作区的 `file_read` 照常可用**
    （证据脚本与 `tests/windows/git-reader.test.ts` 各断言一次）。
44. **助手进程死掉时必须失败在「这一次调用」上，而不是带走调用方进程**（LWB-016，
    任务外修复）。`native/winfs/src/helper-client.ts` 原来没有 `stdin` 的 `'error'`
    监听器：助手退出后 `stdin.write()` 触发未处理的 Socket `'error'` 事件，整个进程被
    `ERR_STREAM_WRITE_AFTER_END` 带走 —— 而真正的原因（助手为什么不在）反而看不到。
    现在：`'exit'`/`'error'` 记录首次原因（含 `stderr` 尾巴，有界 4000 字节）、待决调用
    一次性全部以 `NATIVE_GUARD_UNAVAILABLE` 失败（不永远挂着）、已知助手不在时 `call()`
    直接返回而不写已结束的管道。这条与 Git 无关，是采集本任务时一次真实崩溃暴露的，
    但任何一次护栏调用都会碰到，因此在这里一并修掉并登记。
45. **库在遍历根节点上拼出的是 `<根>/.`**（LWB-016）。`GitWalkerFs.stat` 那一句是
    ``fs.lstat(`${dir}/${entry._fullpath}`)``，而遍历根的 `_fullpath` 就是 `'.'` ——
    于是受控 fs 收到 `…	estrepo/.`。把它判为非法，`statusMatrix` 会在遍历第一步就失败
    （诊断时直接调库看到的是库自己的 `ENOENT: … lstat '.'`，经过 `wrapGitFailure`
    之后调用方看到的是 `INTERNAL_ERROR` / `GIT_READ_FAILED`）。**这是一处会 100% 触发的
    缺陷**：任何仓库上 `git_status` 与 `git_diff` 都不可用，而修好之前它在单元测试里
    完全看不出来（桩不拼 `${dir}/.`）。现在 `'.'` 段是无操作、`'..'` 段仍拒绝。
    `tests/windows/git-reader.test.ts` 有专门一例钉住它，反向验证见
    `docs/evidence/lwb-016/summary.md` §4.5。
46. **`policy_hidden_count` 的语义是「你问的这个范围内、且不是 `.git` 内部，有几条被摘掉」**
    （LWB-016）。这个数字在本任务里**算错过两次**，两次都不是实现写错，而是语义没写清楚：
    （a）`_walk` 在 `map` 之前就对每个兄弟节点调过 `readdir`，因此一次 `path=src` 的查询
    的账本里**必然**含范围外的路径（4 条硬拒绝路径全在里面），不筛掉它，「被摘掉几条」
    就与用户问的东西无关了；判据按**路径段边界**而不是裸前缀（`src2/` 不算 `src/` 的子树）。
    （b）`.git/config` 是我们**内部解析**想读、被 `HD-GIT-CONFIG` 拦下的，从来不是用户可见
    的路径 —— 计进去用户会看到一个他自己永远不可能看见的文件被算作「从他视野里摘掉了一条」。
    定义已写进 `packages/contracts/src/git.ts` 的字段注释。
47. **`packages/git-reader/` 不引入 HTTP、不调用 Git CLI、不执行 hooks/textconv/external diff**
    （LWB-016）。`check-fsguard-imports.mjs` 的 `BUSINESS_PREFIXES` 覆盖它，除
    `node:crypto` 外的 Node 内置一律不可用（LWB-016 时为 98 个文件、未发现绕过；LWB-017 后为 113）；`isomorphic-git`
    的用法限制在 `statusMatrix` / `currentBranch` / `resolveRef` / `readBlob` 四个入口，
    且 `refresh:false` + `ignored:false` 写死在调用点。**没有**引入 diff 库 ——
    行级差异是自实现的（`text-diff.ts`），因为它要与「原始字节」这条语义对齐。
48. **失败信封必须先于成功信封判别，而这条顺序不是风格问题**（LWB-017）。
    daemon 的处理器**从不抛异常**：策略拒绝、未授权、超限都是以 `ok:false` 的**正常返回**
    到达适配器的。拿成功 schema 去套它们，每一次业务失败都会被判成「结果不符合输出契约」，
    于是模型看到的是 `INTERNAL_ERROR`，而真实答案一直是「被拒绝了」。
    修法是给失败载荷与失败信封各写一条契约（`BRIDGE_ERROR_PAYLOAD` / `ERROR_ENVELOPE`），
    适配器先认失败信封。**变异验证**：把那一行改成 `if (false && failure.success)`，
    `tests/unit/mcp-adapter.test.ts` 与 `tests/windows/mcp-adapter-e2e.test.ts` 立刻各失败 2 条，
    且恰好是断言「业务失败不被折成内部错误」的那些；改回后全绿。
    另有一条不依赖变异的表述留在证据脚本里（「失败信封确实不符合成功 schema」）——
    它证明的是**这个分支有作用**，而不是「它看起来更稳妥」。
49. **本任务的证据采自门禁开启的装置，生产装配此刻一个工具都不多挂**（LWB-017）。
    ADR-003 §5.1 / `docs/compatibility.md:65` 规定 §3 通过前四个能力开关一律关闭，
    因此生产 `tools/list` 恰好是 `bridge_status` + `workspace_list`，
    且 `bridge_status` 自述四个开关全 `false`（证据脚本里专门有一段对照，且两个状态都打印）。
    「不得进入真实目录开发联调」这条约束没有被绕过：所有正向证据都跑在**生成出来的测试根**上。
50. **`SERVICE_UNAVAILABLE` 是 LWB-017 新加的错误码**（`packages/contracts/src/errors.ts`）。
    它对应 IPC 层的三种失败（`IPC_UNAVAILABLE` / `IPC_INTERRUPTED` / `TIMEOUT`）。
    原来的表里没有「本地服务此刻不可用」这一档，硬套 `INTERNAL_ERROR` 会把
    「daemon 没在跑」说成「本地服务有 bug」—— 而这两件事的排查方向完全不同。
    载荷里另带 `ipc_code` 与 `outcome_unknown`：后者为真时**不得**把这次调用当作失败，
    也不得自动重试（I14）。
51. **`tools.catalog` 是一条控制面操作，返回的是信封而不是裸的 `{tools}`**（LWB-017）。
    它与工具用同一种信封，适配器因此只做形状判别、**不**把失败信封交给调用方：
    `tools/list` 要么挂出一份完整清单，要么什么都不挂（理由见 `surface.ts`：把分叉表现为
    「少了个工具」时，功能上看不出异常，而一个说不清自己有哪些工具的工具面不如一个明确报错的）。
52. **`normalizeToolArguments` 今天跑不到**（LWB-017）。SDK 自己的 `CallToolRequestSchema`
    把 `arguments` 定成 `z.record(...).optional()`，非对象在进入本函数之前就被 SDK 拒了。
    它被**单独导出并直接测**，理由是它约束的是「本进程答应过的事」——
    SDK 的 schema 是否永远这么严，不是本进程能决定的；留在一条覆盖不到的分支里
    等于这条规则从没被验证过。
53. **适配器侧的参数拒绝不进本地审计**（LWB-017）。参数不合法在适配器里就被拒了，
    那时 daemon 根本没有收到这条调用，也就没有对应的审计记录。
    与「每一次拒绝都有本地审计可见」这个目标有差距，记在这里而不是含糊过去。
54. **同一个 audience 的两把凭证之间不可区分**（LWB-017，已知非目标）。
    两条都用 `mcp-adapter` 凭证的连接在本机看来是同一条身份。
    单用户、单适配器进程的前提下这不构成缺口，但它是一条**能力边界**：
    不要在后续任务里把「同一 audience」当作「同一个人」之外的任何东西。
55. **`paused` 现在有来源了，但把来源接上的人还不存在**（LWB-017 登记，LWB-018 更新）。
    守卫的第 1 步会读 `deps.status().paused`，工作区类调用在它为真时直接
    `PAUSED` / `GLOBAL_PAUSE`（单元测试与证据脚本都钉住了这条路径）。
    **装配根已经存在**（`apps/daemon/src/runtime/assembly.ts`，2026-09-26），
    而这条偏离**没有被它消掉**：装配根今天把 `paused` 填成常量 `false`
    （没有 settings 表可读），也没有控制台操作去置它（`workspaces.pause` 是
    **工作区**级，不是全局）。因此生产路径仍然无法把服务置为暂停 ——
    只是原因从「没有装配根」变成了「没有全局暂停的来源」。
    `cancelled` 一仍其旧：没有取消通道进入 `text_search`。
    两个字段在结果里出现，但**不表示**「暂停功能可用」或「这次搜索可以取消」。
56. **空路径仍是明确拒绝 —— 单文件工作区的变更因此表达不出来**（LWB-017 登记，**LWB-019 确认并保留**）。
    LWB-017 时这条是「`change_*` 的 `path` 是 `min(1)`，单文件工作区表达不出变更」。
    LWB-019 把编辑契约做出来之后，这条**没有消失，反而更硬**：任务书 LWB-019 步骤 4 原文
    要求「空路径…明确拒绝」，而单文件工作区的相对路径就是空串 —— 两条要求直接冲突。
    本任务按任务书原文实现（`CHANGE_PATH_INVALID` / `path_reason=EMPTY`），
    并把后果写进代码注释与证据（`docs/evidence/lwb-019/summary.md` 的 `NOTE d3 副作用`），
    **不自行给单文件工作区开一套例外规则**（那会是「同一个概念两套语义」，
    正是偏离项 57 警告过的事）。要修就得先决定：单文件工作区到底能不能被修改。
    今天不构成风险：`change_*` 五条工具仍返回 `NOT_IMPLEMENTED`，没有生产调用方。
57. **`targetPath` 与 `validateRelativePath` 对空串的含义不同**（LWB-017）：
    前者允许空串表示「工作区根」，后者把它当语法错误 `EMPTY`。
    两者不在同一条路径上（前者是契约层的入参形状，后者是护栏的语法判决），
    但共用一个名字，记在这里以防后来者按名字推断语义。
58. **`apps/daemon/src/gates.ts` 落在静态导入检查的两个名单之外**（LWB-017 发现）。
    它既不在 `BUSINESS_PREFIXES` 也不在 `ALLOWED_PREFIXES`，按
    `check-fsguard-imports.mjs` 自己的规则（`isBusiness && !isAllowed`）会被**静默跳过**，
    而检查器照常打印「未发现绕过」。这不是本任务引入的（本任务只是让这个文件第一次存在），
    它今天是纯常量模块、不 import 任何东西；但偏离项 9 说的那个盲区在它身上已经成真了，
    因此记在这里 —— 不要把它读成「已经检查过了」。
59. **本任务给契约新增了 `ERROR_ENVELOPE` 与 `BRIDGE_ERROR_PAYLOAD`，并带来一处可见的形状变化**
    （LWB-017）：失败载荷里现在多一个 `details.request_id`。它是 daemon 那条审计记录的
    主键，**不是凭证、也不携带任何授权含义**；保留它是为了 LWB-018 的第一条验收
    （「可回答某次工具调用读取和返回了哪些文件范围」）—— 两个 ID 对不上时，
    排查者会以为日志缺了，而不会想到 ID 被换过。
60. **工具面的测试装置现在可以换成真实后端与真实探测器**（LWB-017）。
    `tests/tools/harness.ts` 新增 `probe` 选项：`ops` 与 `probe` 一起换成真实护栏时，
    登记时记下的身份、每次调用复核的身份、护栏打开句柄时核对的身份**来自同一个真实来源**。
    两者必须同时为真 —— 只换 `ops` 会让登记记下桩编的身份，而每次调用都拿它去核对真实对象，
    得到的是「根被换掉」，那是装置自己的锅而不是被测代码的。
61. **读取票据绑的是工作区代次与连接 id，没绑连接代次 —— 一条需要决定的边界**（LWB-018）。
    后果实测：连接暂停 → 恢复后，**暂停之前**签发的读取游标仍然可用
    （证据脚本里那条 `NOTE 已知边界：连接暂停→恢复后，暂停前签发的游标仍可用`，
    按 `NOT_RUN` 记，不计为通过）。工作区一侧做对了（暂停或恢复都会递增
    工作区代次，票据与游标随即 `READ_TOKEN_STALE` / `CURSOR_GENERATION_MISMATCH`）。
    **两种读法，本文件不替验收负责人选：**
    - 按任务书 LWB-013 的原文「生成签名读取票据，绑定**连接**、工作区代次、路径、
      文件版本和实际返回范围」——实现与规格一致（连接以 id 参与绑定，代次绑的是工作区），
      这条验收**通过**。
    - 按守卫自己在**调用进行中**采取的口径（`recheck` 一比连接代次就撤回已经算好的
      结果）——同一件事上出现了两种尺度，「恢复后还能接着读」应当**不通过**。
    这条不一致是本次实测暴露出来的，两种读法都写在这里等一次决定。
    - **今天不构成实际缺口，理由有三条**：停用期间的新请求根本到不了处理器
      （`resolveConnection` 止步）；调用**进行中**被暂停/恢复会被守卫第 5 步
      当场命中（`before.connection_generation !== now.connection_generation`
      → `CONNECTION_DISABLED`，已实测）；而「暂停是为了让这条连接停下」这个目的
      在恢复之前一直成立。
    - **如果决定往严的方向走**，修法是给票据加一份连接代次（签发时记、使用与复查时比），
      但那样要同时改票据格式、游标格式与 `assertSearchCursorMatches` 一类共用判定，
      **属 LWB-024（紧急停用）的范围**，本轮不夹带。
    - **顺带修掉两处把话说大了的注释**：`connections.setEnabled` 的文档注释说
      「代次变化使该连接此前签发的票据与批准全部失效」，而它做不到 ——
      注释与实现不一致时，读代码的人会以为撤权已经闭合。两处
      （`packages/persistence/src/repositories.ts` 与
      `apps/daemon/src/control/connections.ts`）已改成实指：代次变化会让
      **这次调用**被复查发现，不会让旧票据失效。
    - 批准路径（`change_*`）尚未实现，因此「代次是否使旧批准失效」这条今天
      无从谈起 —— LWB-024 的验收标准里明写「暂停后重连不重放旧批准」，
      届时必须连票据一起审。
62. **授权拒绝在审计里记成 `outcome: 'error'`，而 `NOT_AUTHORIZED` 的 summary 只描述其中一种成因**
    （LWB-018 发现）。两件事分开说：
    - **审计侧**：守卫按错误码的**类别**分类（`protocol` → `error`，其余 → `deny`，
      见 `guard.ts` 的 `outcomeOf`），而 `NOT_AUTHORIZED` 是 **`protocol` 类**
      （`packages/contracts/src/errors.ts`）。于是「这条连接没有被授予这个能力」
      在审计里长成 `error` —— 记成「调用方或本进程的问题」，而不是「被拒绝」。
      分类的理由（把策略拒绝与 daemon 的 bug 记成同一件事会让拒绝率失去意义）
      仍然成立，但代价落在这一类上：**授权拒绝的拒绝率在审计里读不出来**。
      改它要动契约里 `NOT_AUTHORIZED` 的类别与 `errors.ts` 的映射表，
      属跨包改动，登记在此等一次明确的决定。
    - **模型侧**：今天给模型的那句话是 `PolicyDeniedError` 的 `primary.detail`
      （「该连接凭据未被授予 read 能力。」），**它是准确的**。
      偏差在**回退文本**上：`BRIDGE_ERRORS.NOT_AUTHORIZED.summary`
      （「本地 IPC 凭据无效或 audience 不匹配。」）在 message 不满足出站条件
      （含本机路径、或命中高置信度秘密）时被整句换上 —— 那一刻「缺能力」
      会被说成「凭据坏了」，排查方向被引到重装凭证上去。今天走不到这条路，
      但一个错误码对应多种成因，就是这种结构性的后果。
    - 单元测试里有一条把这个分类**钉住**（`能力不足记成 error 而不是 deny`）：
      它钉的是**现状**，不是正确性 —— 改动发生时应连带改它。
63. **审计补充信息筛查（`screenMetadata`）的覆盖面是「逐点接线」，不是「结构性保证」**（LWB-018）。
    今天的穿过者：工具面（`recordToolCall` 内部调用）与控制面
    （`connections.ts` 显式调用，本轮补上）。
    **不穿过**者：`packages/workspaces/src/registry.ts` 的登记/暂停/移除审计 ——
    它的键是 `kind` / `mode` / `result` / `code`，不在白名单里，因此改成穿过
    会当场抛错。这个决定的取舍是：那些键是**闭集枚举值**（不是自由文本），
    而该包是已交付并经 LWB-009 取证的代码，本轮不做跨包改写。
    风险因此落在「将来有人往那条路径加一个自由文本键」上 —— 白名单的价值
    来自每一处都过，一处例外就是下一处例外的范本（`screen.ts` 的自述即此意）。
64. **审计不记文件的「版本」**（LWB-018，对任务书的一处偏离）。
    LWB-018 步骤 1 写的是「记录…被返回文件及范围、**版本**、字节和结果码」。
    今天记的是范围与字节，**没有**记版本：`audit_file_access` 表没有
    `sha256` 列，而七个工具里只有 `file_read` 的结果带哈希 ——
    `file_list` / `text_search` / `git_status` 根本不产出「某个文件的某个版本」
    这个说法。要补的话，缺的不是一列而是一套口径：版本该在**签发时**记
    （读取决定返回哪一版的那一刻）还是在**写入审计时**记（可能已经变过）。
    登记为偏离，不在本轮自行决定。
65. **出站字节预算只对「正文」记账**（LWB-018 实测）。
    预算在 `packages/egress/src/budget.ts` 里按 connection 记，扣费点只有
    `emitContent`；而 `file_list` 的条目名、`git_status` 的路径名**不经过它**
    —— 它们走 `screenText` 逐条筛查（`list.ts:247`、`status.ts:365`），
    但不计预算。因此审计里 `file_list` 的 `bytes_out=0`：那个 0 的意思是
    「这些字段不计入预算」，**不是**「什么都没出去」（证据脚本里同一行
    `出去了=[…12 个条目名…]` 是实情）。
    后果有界但真实：一个可续的列举可以带走远超每小时字节上限的**名字**。
    秘密筛查仍然生效（名字逐条过 `screenText`），缺的是**数量**上的闸。
66. **`file_access.delivered` 的粒度是「文件范围」，不是「字节」**（LWB-018）。
    `git_diff` 对一个**没有差异**的文件也会记 `delivered=true` + 整文件范围，
    而同一条记录的 `bytes_out=0` —— 因为那次结果里出去的是「无差异」这个结论，
    不是内容。两个字段一个都不能单独读：只看 `file_access` 会把「参与判定的文件」
    读成「内容出去了」，只看 `bytes_out` 又会把 `git_diff` 的整文件行读成没发生。
    这不是 bug（`delivered` 的语义就是范围级的），但它是一处**必须一起读**的口径，
    记在这里以免被单独引用。
67. **控制面的「状态变更先落地、审计后写」是两个事务**（LWB-018）。
    `connections.ts` 的 `setEnabled` 先改状态、再写审计，两步各在自己的事务里，
    因此存在一个窄窗口：状态已变而记录没写成。**刻意不包成一个事务** ——
    控制层拿不到 `SqliteDatabase`（写入口在 `@lwb/persistence`），为这件事在
    控制层开一个事务接口会把事务边界散到两个包里。
    这个窗口的后果**可自证**：`connections.list` 会如实回报 `enabled` 与
    `updated_at`，操作者看得到状态确实变了 —— 这与工具调用路径的差别正是
    那条路径 fail-closed 的理由（那里没有第二处能自证「内容出站过」）。

68. **`ChangeValidationContext.max_editable_file_bytes` 曾经是「声明了却没人用」的死选项**（LWB-019 发现并修复）。
    LWB-019 之前，`packages/changes/src/edit-contract.ts` 的上下文里有这个字段、
    注释写着「覆盖可编辑文件字节上限」，而**没有任何代码读它** —— 一个声明了却不生效的
    选项比没有它更坏：调用方以为调紧了，实际什么都没发生。现在它接上了
    `SIZE_LIMIT_EXCEEDED` / `reason=FILE_TOO_LARGE_FOR_EDIT`，判的是**票据上的 `size`**。
    为什么要在契约层再查一遍（而出站层已经把它写进 `editable_blockers`）：
    **上限是可调的**（`OPERATOR_TUNABLE_LIMITS`，见偏离项 28 的调用链），
    而票据记的是**签发那一刻**的裁定 —— 上限调小之后，一张昨天签发的票据不该
    继续按昨天的限额生效。同类风险在其它「上下文选项」上一样存在，别再声明不读。
69. **`replace_text` 的换行处理是字面的，不是「智能」的**（LWB-019）。
    内容里的 `
` 按原文件的换行风格改写成 CRLF 落盘（与 `edit_text` 统一到
    同一条判据：区域 = 内容 + 该行终止符），但**不额外补末尾换行**，
    也不因为「看着像 Markdown」而加什么。后果：替换一份以换行结尾的文件时，
    如果提案内容不以换行结尾，产物就不以换行结尾 —— 而末尾少一个换行是
    diff 里最容易被忽略的一处改动。这条要在 LWB-020 的差异预览里**如实显示**
    （`ChangeFilePreview` 有 `added_lines` / `removed_lines`），
    不能让用户以为末尾那行还在。
70. **两张互相矛盾的票据里，「truncated 为真」优先**（LWB-019）。
    `replace_text` 要求三件事同时成立：票据 `editable`、`truncated` 为假、
    行范围覆盖全文件。当一张票**自相矛盾**（`truncated:false` 而行范围不是全文件）时，
    实现报的是**范围不全**（`REPLACE_REQUIRES_FULL_READ`）而不是放行；当它
    `truncated:true` 时，报的是截断（`REPLACE_RESULT_TRUNCATED`）。
    正常路径上出站层不会签出这种票，因此这两条是**纵深防御**，不是可达路径。
    留着的理由：将来出站层改了裁定逻辑，「两张互相矛盾的声明里挑一个信」
    正是出错的方式。
71. **夹具桩比真实护栏**宽松**，于是缺陷落在两者之间**（LWB-020 实测发现并修复）。
    `requireCreatable` 把目标路径的父目录算出来探一次，而顶层文件的父目录是空串
    （`lastIndexOf('/') === -1` → `parent = ''`），护栏的 `resolvePath` 对
    「目录根 + 空相对路径」是**故意**拒绝的 —— 于是「在工作区根下新建文件」
    这一完全正常的提案，在真实护栏上**全部**报 `PATH_UNSAFE`。
    单元测试结构上抓不到它：`tests/tools/fixture-ops.ts` 对空相对路径是**宽容**的
    （把 `''` 当根按 `expect` 判类型），而全部 `create_text` 用例走的都是子目录。
    **这不是「桩写错了」，是「桩与真实边界不一致」这件事本身没有判据** ——
    桩照契约提供了字段、也照契约回答了问题，只是答案比真实护栏宽松。
    修法与 `@lwb/files` 的目录列举走同一条路（`list.ts` 的 `resolveBase` 早就
    处理过同一个护栏行为，见偏离项 30）：父目录是目录工作区的根时不再多探一次，
    根的目录性质取自作用域里的 `kind`，根的**身份**由护栏在每一次
    `Open-GuardedChain` 里重新核实（`ROOT_IDENTITY_MISMATCH`）。
    省掉的是一次**重复**的证明，不是一次缺失的证明。
    **唯一真正少掉的是根目录的硬链接计数** —— 依据是 NTFS 的目录不支持硬链接
    （`CreateHardLinkW` 对目录直接失败），目录的别名只能是重解析点，而重解析点
    由护栏逐级判定拒绝；父目录是**子**目录时那条检查仍照常执行。
    这条依据**没有**被本轮证据直接验证（夹具里没有硬链接目录，现实中造不出来），
    因此它是 LWB-020 证据里唯一一处靠先验知识而非实测支撑的取舍。
    顺带补了一条例行回归（`tests/unit/changes-prepare.test.ts` 的「在目录工作区的
    根下新建文件」），并在用例注释里**写明它证明不了那件事**（该例在修复前后都通过），
    真正抓住它的是 `scripts/evidence/lwb-020.ts` 的 `create_text` 段落 ——
    这样桩的这处宽松就有据可查，而不是一处没人知道的差异。
72. **迁移 v4 是加列，不是重建表，但方向上仍然是一次的**（LWB-020）。
    `change_items` 增 `added_lines` / `removed_lines` 两列（`ALTER TABLE … ADD COLUMN …
    NOT NULL DEFAULT 0`），因此与偏离项 10 的 v2 不同：它不需要导出/重建/导入，
    在旧库上原地生效。但**回退代码仍然不等于回退模式** —— `KNOWN_SCHEMA_VERSION`
    由 `MIGRATIONS` 数组末项的 `version` 推出，已升级的库是 4，回退到不认识 4 的
    代码后会被拒绝打开（方向仍是 fail-closed，不会静默出错）。
    两列的默认值只服务于历史行，V1 尚无生产数据；新写入的行一律由 `ChangesRepo`
    显式提供，因此「默认值是 0」不会变成某个真实修改集的增量行数。
    **为什么这两个数字要落库，而不是看的时候现算**：它们既不在条目里也不在任何一个
    blob 里 —— 是**两份字节之间的关系**，且是**按操作语义**算的
    （`edit_text` 把「把第 3 行换成它自己」记成 +1/−1 而不是 0/0）。
    一条通用行差分给不出同样的数字，于是「批准时看到的 +3/−1」与「查询时看到的
    +0/−0」会不一致 —— 而那是同一个修改集的两个界面。同批字段里**风险提示刻意没有
    跟着落库**：风险是**对事实的解释**，解释必须能随事实一起被复核，存一份文案就存在
    文案与事实漂移的可能（`deriveRisks` 每次从落库的行重新推导）。
73. **批准链路上两处真实缺陷，都只有「真的走一遍控制操作处理器」才看得见**（LWB-021 实测发现并修复）。
    (a) `packages/audit/src/screen.ts` 的键名白名单**不含** `recordDecision` 用到的任何一个键
    （只有 `policy_version` 在），而 `screenMetadata` 对不在清单里的键是**抛出**而不是静默丢弃 ——
    于是每一次批准与拒绝都走成「事务已提交 → 写审计 → 抛普通 `Error` → HTTP 500」：
    **操作者看到报错，而修改集其实已经批准并排队了**。这是最坏的一种形态，
    因为它同时说着两件相反的话。(b) 批准决定的审计行没有 `request_id`，
    于是「谁批准了什么」这条记录无法与产生它的那次调用对上 —— 而「这次批准是哪一次点击」
    正是排障时第一个要问的问题。**为什么单元测试抓不到**：A–E 组全部直接调 `@lwb/approvals`
    的包 API（`approveAndQueue` / `rejectChange`），**从不经过控制操作处理器**，
    而白名单只在处理器那一层被过；E 组里唯一走处理器的用例期望的正是**被拒**，
    因此在 `requireLocalConsole` 就返回了，永远走不到审计这一步。
    已补 **F 组 4 例**走处理器而不是走包 API（批准成功 / 拒绝成功 / 只读操作不写任何行 /
    `approvals.list` 如实回报「批准还在、目标已排队」），F1 另外断言 metadata 里
    **不含**完整摘要、也不含 `decision_by`（决定者已经在 `connection_id` 列上，
    再放一份等于同一个事实有两个来源）。这条的教训是**按层测的盲区在接缝处**：
    每一层都测了，而缺陷落在两层之间。
74. **批准门禁里 `DIGEST_MISMATCH` 这一分支由构造不可达**（LWB-021）。
    批准行受不可变触发器保护、修改集内容不可变，因此「批准绑定的摘要 ≠ 重算出的摘要」
    只能通过「批准指着一个别的修改集」出现，而那条路被 `ApprovalsRepo.create` 的
    `INSERT … SELECT … WHERE id = ? AND digest = ?` 与 `approvals_binding_matches_change`
    两条约束一起挡掉了。它在门禁里仍然保留（作为纵深防御），
    但**没有任何一条受支持的路径能构造出它** —— 因此 C 组的按状态一致性循环里
    **刻意不含**这一格，而不是靠临时删掉触发器去把它制造出来。
    与偏离项 70 同类：留着它是因为「将来出站层改了裁定逻辑」正需要这一层，
    但「它现在可达」这句话不成立。
75. **「用户确实看过这份内容」没有被证明**（LWB-021）。
    一次性 nonce 目前仍由控制台**显式申请**，因此它证明的是
    「一次性 + 与内容绑定」，**不**证明「人看过后再点的批准」。
    后者要求 nonce 由渲染审核页的那次读取一并签发 —— 这条边界写在
    `apps/daemon/src/control/session.ts` 的文件头。
    在这一条闭合之前，审批链路**不得**被读成「已经完备」：
    现在的形状挡得住重放与并发点击（LWB-021 验收 3 已实测两种形态），
    挡不住「界面还没渲染完，人已经按了键」这类**时序**上的问题。
76. **「已过期」是读取时投影出来的，只读路径不写库**（LWB-021）。
    `effectiveApprovalState` 按判定时刻把 `ACTIVE` + 已到期投影成 `EXPIRED`，
    而**库里的 `stored_state` 仍然是 `ACTIVE`** —— 也就是说，
    直接查库的人会看到一个「还活着」的行，而门禁已经不放行它了。
    这样取舍是为了让 `approvals.list` 保持**纯读**（它因此不需要一次性 nonce，
    见 `apps/daemon/src/control/approvals.ts` 的分类），代价就是这个中间态可见。
    接口因此同时回报 `state` 与 `stored_state`，让两者的差**可以被看见**
    而不是被抹平 —— 把差异藏起来比差异本身更危险。
77. **`approveAndQueue` 原先走的 `PENDING_APPROVAL → QUEUED` 不在方案 §8.1 的图里**（LWB-022 发现并修复）。
    原实现在同一个事务里把修改集一步推到底。补这条边的代价不是形式问题：
    它让**「绕过批准直接排队」变成一条合法转移**，从此任何调用点都能这么写，
    而状态机再也说不出「`QUEUED` 的唯一前驱是 `APPROVED`」——
    而那正是「没有批准的修改集排不进队」这条保证在状态机里的写法。
    现在改成**两步走**（`PENDING_APPROVAL → APPROVED → QUEUED`），
    两条调用路径（控制台的「批准并应用」与将来的执行器）统一用 `from: ['APPROVED']`。
    **原子性没有变化**：两步在同一个立即事务（`Repositories.transaction`）里，
    外界看不到中间的 `APPROVED`，LWB-021 验收标准 1（「三件事同生同死」）的用例全部照旧通过。
    回归钉子：`tests/unit/change-state-machine.test.ts` 的 D5 断言这条边**不存在**。
    **它是被 LWB-022 新加的表检查抓出来的**（`transitionChange` 让 LWB-021 的三条用例当场变红），
    不是读代码读出来的。
78. **数据库**不**禁止终态回退，挡它的是应用层**（LWB-022 实测登记）。
    方案 §7.2 要求状态流转「使用数据库条件更新」，实现是 `ChangesRepo.transition` 的
    `WHERE state IN (…)` 加 `@lwb/changes` 的转移表，**两层都在应用侧**；
    本库没有「终态不得流转出去」的触发器。这一条是被**量出来的**：
    证据脚本直接发一条 `UPDATE`，把 `APPLIED` 改回 `QUEUED`（**改动 1 行**），
    然后恢复并复核，输出 `NOTE 边界：库层不挡终态回退 …`。
    **它不是「验收标准 2 没达成」**：系统里没有哪条路径能发出那条 SQL
    （`check-fsguard-imports.mjs` 让业务包只能经 `Repositories` 触达库）。
    它是**纵深防御上的一个缺口**，而且位置扎眼：同一个迁移文件里
    `changesets_terminal_tombstone` 已经为**删除**写了这句保证，却没为**更新**写。
    建议照 `approvals_no_reactivate` 的样子加一条 `BEFORE UPDATE ON changesets`
    触发器；本任务不做，因为交付物里没有迁移，且迁移文件是**校验和冻结**的。
79. **`requireIdentifier` 三个拒绝分支里有一个不带 `reason`**（LWB-022 发现并修复）。
    `packages/idempotency/src/ids.ts` 里「不是字符串 / 是空串」那一条与另外两条不同，
    没有 `details.reason`，于是「调用方传错了类型」与「传了一个空值」在回报里
    被合成同一句「参数不对」—— 而这两件事的排障方向完全不同。
    本工程的要求是每条拒绝都说清是哪一种，因此拆成
    `IDENTIFIER_NOT_A_STRING` / `IDENTIFIER_EMPTY` 两个理由名。
    **是证据脚本 4.1 抓到的**（它的断言是「七个不合法形状**各自**报出一个非 `undefined` 的理由」），
    单元测试 A3 同步收紧，把这两个理由名钉住。
80. **品牌类型挡的是隐式赋值，不是显式重新贴标签**（LWB-022 登记，已知边界）。
    `packages/idempotency/src/ids.ts` 的四个解析函数入参是 `unknown`
    （它们必须如此 —— 未受信输入进来时就是一个不知道类型的东西），
    因此 `asChangeId(someOperationId)` **可以**编译通过。
    品牌因此挡得住「手上正好有个 `OperationId`，顺手当 `change_id` 传进去重新排一次队」
    这一类**隐式**错误，挡不住刻意绕。这是有意的取舍：显式那一步把函数名摆在代码里，
    评审时看得见；隐式赋值看不出来。代价是每个边界要多写一行 `asX(...)`。
    同类的另一面：`request_id` 也不该被当成幂等键（服务端生成，调用方重试时复现不了它），
    这条同样只在类型层面成立。
81. **`queryOperation` 的「未知」优先于操作自己的结论**（LWB-022，口径登记）。
    操作状态是 `APPLIED` 但一个逐文件回执都没有时，报 `UNKNOWN` 而**不是**已保存 ——
    「操作说成功」只是一句话，没有回执的成功是**没有证据的成功**；
    而只要有一个条目是 `UNKNOWN`，结论就**升级**为 `NEEDS_RECOVERY`
    （逐文件的事实压过操作自己的结论）。两条都已取证（证据 §1 验收标准 3 的 3.4 / 3.5），
    记在这里是因为它是一处**必须一起读**的口径：单看 `operations.state` 会读成「已完成」。
82. **静态导入检查漏掉了 `.vue`**（LWB-023 发现并修复 —— **是本任务自己踩出来的**）。
   `scripts/check-fsguard-imports.mjs` 有两个列表：`BUSINESS_PREFIXES`（业务包禁止直接碰文件系统）
   与 `ALLOWED_PREFIXES`（允许的例外），而 `apps/console/views/` 与 `apps/console/components/`
   **两边都不在**；同时 `collect()` 只收 `.ts`。两处叠加：在 `<script setup>` 里写
   `import { readFileSync } from 'node:fs'` 会被**静默跳过**，检查器照样报「未发现绕过」——
   正是偏离项 9 / 15 / 20 记过的失败形态。
   修法：`collect()` 收入 `.vue`；业务前缀从 `apps/console/src/` 放宽到 `apps/console/`
   （控制台只能经 `@lwb/ipc` 的 `ControlClient` 访问本机，没有任何一处需要直接碰文件系统）；
   解析时把模板与样式**掩成等长空白**、只把 `<script>` 块送去给 TypeScript ——
   直接切掉会让行号整体前移，报出来的位置对不上源文件。
   按房规配了**反向探针**（证据 §4）：探针文件的 `<script setup>` 里放 `import node:fs`，
   必须报出 `apps/console/views/__probe_lwb023.vue:6` 并以 1 退出；另配**假阳性探针**——
   模板正文里出现 `import` 这个字样不得报错。检查文件数由 138 增至 147。
83. **`ChangeSetView` 没有 `owner_connection_id`**（LWB-023 登记）。
   `changesets.owner_connection_id` 在落库事实里存在，契约视图（`packages/contracts/src/change.ts:177`）
   没有暴露它；控制台也还没有 `connections.list` 的调用路径。本任务的做法是收一个
   **已经解析好的字符串**作属性、查不到时显示「未知」而**不是省略这一行**
   —— 省略会让「查不到」与「本来就没有」在界面上长得一样。
   要不要把这一列加进契约视图，取决于 LWB-025 的 `change_get` 怎么装配，那时再定；本轮不自行加列。
84. **仓库从此有了构建步骤与第二个测试运行器**（LWB-023）。
   「本工程没有构建步骤」此前是写进 `docs/compatibility.md` §2 的**仓库级事实**，
   现在还这么读就错了。逐项的前后对照见本文档「当前仓库事实 › 构建步骤与测试运行器」一节。
   附带一条：`.vue` 不由 `tsc` 解析，因此控制台**有两份 tsconfig**（根那份无 DOM lib，
   `apps/console/tsconfig.json` 有）。根那份的 `exclude` 里因此多了三个目录与一个文件，
   但**刻意不含** `apps/console/src/` —— 那一层被两份配置各检查一次不是重复劳动：
   根那份验的是「这层逻辑不需要浏览器」，而那句话正是它能在 node 运行器里被测到的原因。
85. **控制台页面的数据源尚不存在**（LWB-023 登记 —— 这是当前边界，不是缺陷）。
   没有任何控制操作返回 `ChangeSetView`；`change_get` 属 LWB-025；
   `ChangeDiffPage`（`packages/contracts/src/change.ts:215`）在契约里存在但**没有生产者**，
   所以 `DiffView` 收 `unified` 属性、无值时明说「尚未提供」而**不是退回去显示新文全文**
   —— 退回去会让「差异」悄悄变成「全文」，两者在界面上长得像、含义相反。
   本任务的证据因此是 DOM 断言而不是端到端点击，**不得**被读成页面已可用。
86. **五处既有的字面不可见字符按设计未改**（LWB-023 发现并登记）。
   首次运行时语料扫描命中 6 个文件，逐条查过：**六处全是真阳性**，
   是「本仓库语料里一处都没有」这条**断言**写错了。
   其中一处（`apps/console/tests/diff-view.spec.ts` 注释里的 U+202E / U+E004）是**本次写的**，已按码位改写。
   **同一个错误在本任务的证据文档上又犯了两次**（`docs/evidence/lwb-023/summary.md`）：
   首次定稿后重跑扫描，2.5 当场变红，新命中的正是那份**正在解释这个危害的文档**；
   改写它时初稿又带进三个。根因是 Write 的 `content` 是 JSON 字符串，
   里面写 `\uXXXX` 会被解码成真字符 —— 靠仔细是消不掉的，已改成按码位构造 + 修完重扫。
   两件事因此写进了证据 §4.3：**语料扫描覆盖散文**，以及
   **「PASS 2.5」的有效期只到它被采下来的那一刻**（之后再往仓库里写任何东西都会改变语料成分，
   包括写「证据已经通过了」这份总结本身）。
   其余五处：`packages/contracts/src/path.ts:65-66`（注释在**演示**这两种字符的危害）、
   `packages/git-reader/src/diff.ts:503`（功能性：把 BOM 贴回重建后的文本）、
   `scripts/evidence/lwb-020.ts:1052`、`tests/fixtures/build-fixtures.ts:72`、
   `tests/unit/changes-prepare.test.ts:688`（后三处是 BOM 断言夹具）。
   它们属别的任务的范围，在 LWB-023 里顺手改会让本次提交无法按范围评审，因此如实登记而不改。
   断言侧改成**两向清单**：新命中要失败，**清单里已消失的也要失败**（单向清单会随文件改名悄悄失效）。
87. **保留策略用错了查询，会让待恢复的快照被回收**（LWB-024 发现并修复 —— **真实缺陷**）。
   `planSnapshotRetention` 原本用 `OperationsRepo.listUnfinished()` 取「在途操作」，
   而那个方法问的是**「上一个进程留下了什么」**（`WHERE state IN ('QUEUED','VALIDATING','APPLYING')`，
   为 LWB-030 的启动恢复准备），保留策略问的是**「这些字节还有人在等吗」**。
   两者的差集正是 `RECOVERY_REQUIRED`：一个**已经不在运行、但明确在等恢复**的操作
   在前者的语义里不算「未完成」，于是它连同它的快照一起从保护清单里漏掉 ——
   而那一刻回滚取不到原始字节。
   暴露它的装置是**刻意造出来的分叉**：修改集 `QUEUED`、它的操作 `RECOVERY_REQUIRED`。
   只把两者的状态对齐成同一个值，这条路径一次都不会被走到。
   修法是新增 `OperationsRepo.listByStates(states)`（与 `listUnfinished` 并存，不替换），
   集合由 `OPERATION_TRANSITIONS` **推出**（`OPEN_OPERATION_STATES`）而不是写死一张清单。
   **两个问题共用一个查询，是这一处的根因；「多一个入口」比「让一个方法回答两件事」便宜。**
88. **批准与修改集是两个不同的有效期，不是一个**（LWB-024 发现 —— **是证据脚本自己的错**）。
   批准 10 分钟（`LIMITS.APPROVAL_TTL_MS`）、修改集 24 小时（`LIMITS.CHANGE_TTL_MS`）。
   第一版证据在 `T0 + 22 分钟`清一次就断言「修改集被收成 `EXPIRED`」，
   实跑报「一轮收掉 0 个修改集、1 条批准」—— 那一刻只有批准到点。
   修法不是改期望值，而是**两侧分开取证**：1.6 证「收掉的是批准、修改集原地不动」，
   1.11 越过 `T0 + 24h` 再证「被收掉的是那一行」。
   只做一侧的话，另一侧的实现可以全错而全绿（只认批准的会留下 24 小时后仍 `APPROVED` 的老计划；
   只认修改集的会留下「`EXPIRED` 的修改集挂着 `ACTIVE` 的批准」——正是门禁最想避免的组合）。
89. **门禁拒绝理由的次序不是实现细节**（LWB-024 发现 —— 证据脚本第一版写错了）。
   第一版断言「失效之后报 `CHANGE_STATE_INVALID`」，实跑报 `APPROVAL_REVOKED`。
   `evaluateApplyGate` 的次序是**先问批准、再问修改集状态**，而一份已被撤销的批准是更**具体**
   的答案（它说明这次「停」是从批准那头进来的）。这条次序决定了操作者在界面上看到哪一句话，
   因此按实现改期望是**错的**方向 —— 正确做法是把它写成判据并说明理由（2.5），
   再由 2.6（再签一份批准之后批准那一格无可指摘，此时理由才变成 `CHANGE_STATE_INVALID`）
   补上状态那半边。两条合起来才构成验收标准 2 的「撤销」一侧。
90. **三条库层前提，判据依赖它们，登记在此免得下次重新发现**（LWB-024 登记）。
   (a) `WorkspacesRepo.markRemoved` **同时**把工作区置为不可用，`setEnabled` 与 `markRemoved`
   **都会**前移代次。因此「工作区被移除」一格的理由实际有**三**条
   （`WORKSPACE_REMOVED + WORKSPACE_DISABLED + GENERATION_CHANGED`），
   而「同一代次下被停用」在生产路径上**不可达**。
   (b) `approvals_active_uq` 是一个 `WHERE state = 'ACTIVE'` 的**部分**唯一索引，
   且 `ApprovalsRepo.create` 只重核摘要（`INSERT … SELECT … FROM changesets WHERE id = ? AND digest = ?`）。
   因此**数据库层允许**给一个已失效的修改集再签一份批准（实测：落库状态 `ACTIVE`）。
   挡住复活的必须是**修改集已经不在 `APPROVED`**，不是数据库约束 —— 这条如果记反了，
   下一次「加固」会去改索引，而真正的判据在状态机上。
   (c) `INVALIDATED` 在转移表里是终态、**没有任何出边**。这是刻意的：解除失效等于让一次
   已经作废的批准复活，而它的下一步动作应当是重新读取、重新提议。LWB-024 **只做失效，不做反向**。
91. **一个全局布尔值可以让「清理不删运行中的快照」空洞地成立**（LWB-024 登记 + 修法）。
   `BlobStore.collectGarbage` 原本有一个全局谓词 `isSafeToCollect`：它为假时整轮回收被拒。
   于是「只要有任何在途操作就拒绝整轮」会让验收标准 3 永远为真 —— **因为什么都不删**。
   而它的反面同样是错的：全局为真时，所有 `pending_gc` 一律被删，包括仍在撤销窗口内的。
   「这一批里，运行中的留下、窗口已满的删掉」这句话**一个全局布尔值说不出来**。
   因此 `protect` 是**新增**的第 4 条条件（逐对象、由调用方提供判据、本模块仍不做安全判定），
   `isSafeToCollect` 原样保留，四条**同时**成立才删。证据 3.7 是这条的反向探针：
   撤掉 `protect` 后那 4 个字节**当场被删**，3.4/3.5 里的「留下」因此是判据挣来的。
   证据 3.8 则显式走了一遍「全局为假」那条路并记下它的 `refusal_reason` ——
   **证明一条标准可以被空洞地满足，与证明它被满足，是两件事**。
92. **装配根起来了，但「授权行」仍然没有任何生产路径能创建**（2026-09-26 登记）。
   装配根会保证模型侧那条连接行存在（`ensuresAdapterConnection`），而它**新建时是停用的**
   —— 这是 `CreateConnectionInput` 的既有默认值，装配根不覆盖它。
   问题在后面一步：**没有任何控制面操作注册连接，也没有任何路径创建 `grants` 行**。
   `GrantsRepo` 只有 `put` / `find` / `listByConnection` / `hasCapability`，
   而 `put` 的调用方今天只有测试与证据脚本。后果是一条**诚实的边界**：
   即使操作者把连接启用、把工作区登记好，模型侧调用仍会一律
   `CAPABILITY_NOT_GRANTED` —— 因为授权行是 0 条。
   装配根因此每次启动都打印一行提示（`授权行为 0，模型侧调用一律会被拒绝。这不是故障。`），
   而 `tests/windows/daemon-assembly.test.ts` 把 `facts.grants === 0` 钉成**当前事实**：
   将来补上授权流程时，那条断言会一起失败，从而提醒改它 ——
   一个「反正也不会通过」的断言不该静静地留着。
   缺的那一环属于**控制台的操作面**（登记连接、按工作区授权），
   今天没有任何一份任务书把它的归属写清楚，因此不在这里发明一个操作。
93. **没有配置层，因此限额是冻结初值**（装配根登记）。
   `resolveLimits({})` 从未被生产路径调用；装配根用的是 `@lwb/contracts` 里那份冻结的
   `LIMITS`。差别在「能不能按工作区收窄限额」这件事上：今天不能。
   这与 §9.3 的有效期是同一类问题（那些值也来自冻结初值），
   而两者都要等到有一层「按工作区/按连接覆盖」的配置读入之后才谈得上。
94. **`recovery_required` 曾经恒为 `false`，现在接的是真查询**（装配根登记；LWB-027/028 交付后**仍然**
   恒为 `false`；**LWB-030 交付后改成真查询**）。
   契约里这个开关的含义是「本工作区需要人工恢复，禁止一切写入」，
   而它的真值来源是恢复日志 —— 在 LWB-030 之前没有恢复日志。
   LWB-027 与 LWB-028 让**真实的**「必须进恢复」第一次成为可能
   （`native-adapter.ts` 的 `writeFailure` 会抛 `RECOVERY_REQUIRED` 并带上磁盘现场），
   但那是一次**抛出**、一份留在协调器账上的 `APPLYING`，
   **不是**一份可以被读出来判定的恢复日志。
   LWB-029 交付后逐条目的执行日志已经可读（`readItemEvents`），
   但仍然缺**把那些账目定案**的那一步。
   **LWB-030 把那一步补齐了**，装配根里因此写的是
   `capabilityFlagsWith(BRIDGE_GATES, (workspace) => recovery.requiresRecovery(workspace))`
   —— 一句真查询，不再是 `() => false`。
   **这一处改动是一次行为改变，不是一个重构，所以单列在这里。** 方向是**收紧**
   （原来是「永远不说需要恢复」，现在是「真说」），而且它同时也是一条**回退**：
   把 `recovery_required` 硬改成假，是方案 `docs/recovery-playbook.md` §8 明令不许做的事 ——
   一个「真值查询」被写成一句谎，比这个开关从未存在过更难发现。
   但要如实说清它今天**还没有拦住任何人**：协调器尚未接线（LWB-032），
   没有任何一条从模型出发的写入路径会去读这个开关。
   **不得**把「它接上了真查询」读成「写入已经被它挡住」。
95. **FsGuard 静默漏检了装配根自己**（2026-09-26 发现并修，含反向探针）。
   `scripts/check-fsguard-imports.mjs` 的规则 1 是「业务层 且 不在允许清单里」→ 报错，
   而**两个列表都不在**的路径会被静默跳过 —— 既不「被允许」，也不「被检查」。
   `apps/daemon/src/gates.ts` 与新增的 `apps/daemon/src/runtime/` 恰好落在那个缝隙里，
   于是一个 `node:fs` 导入写进装配根不会触发任何检查。
   修法是把 `apps/daemon/src/` **整体**纳入受检（原先只有 `control/` 与 `tools/` 两个子目录），
   路径同时出现在两个列表里时按「被允许」处理。
   反向探针：手工在 `runtime/` 下加了 `node:fs` 与 `node:child_process` 两个导入，
   两条都以 `[FSGUARD_BYPASS]` 报出，随后删除。
   **一个反直觉之处**：脚本末尾报的「已检查 N 个文件」**与这两条前缀规则无关** ——
   文件是先全量收集、再逐条判定前缀的，所以 `gates.ts` 与 `runtime/` 一直都在那个数里，
   只是谁也报不出来。那个数字看着像覆盖率，其实不是：它今天从 149 变成 156，
   变它的是新增的 7 个文件本身，不是放宽的规则 —— 一条**只**改规则的提交不会让它动一格。
   换句话说，这条缺陷存活期间，那个数字一直在**照着它没覆盖到的东西**报数。
96. **受保护根「加固第二次必然失败」——只在全新临时目录上跑过的测试永远看不到**（2026-09-26 发现并修，含反向探针）。
   `SecureStore.ps1` 的 `Op-Harden` 用 PowerShell 的 `Set-Acl` cmdlet 写 DACL。
   本机实测（`Get-Acl`/`Set-Acl` 各一次、两次，以及只设保护位、只设属主、只加规则等变体）：
   **首次恒成功，第二次起恒失败**，报
   `The process does not possess the 'SeSecurityPrivilege' privilege`。
   换成 `[System.IO.FileSystemAclExtensions]::SetAccessControl` 则两次都成功，
   产物 SDDL 逐字节相同。机制上说得通：该 cmdlet 会连带请求审计段（SACL），
   而 SACL 需要 SeSecurityPrivilege，非提权进程没有，本项目也不申请管理员。
   
   **为什么它值得单独记一条**：daemon **每次**启动都要加固存储根，所以这条缺陷的实际表现是
   「第一次启动成功、此后每一次启动都失败」，而报错把原因说成权限不足 ——
   排查方向会被引到 ACL 上，而 ACL 恰恰是已经正确的那一个。
   它长期没被发现，是因为 `tests/unit/secure-store.test.ts` 里 LWB-007 的用例**全部走替身**
   （`fakeInspector`）：判定层覆盖得很好，机制层一次都没跑过；而每个跑过的临时目录都是新的。
   现在由 `tests/windows/secure-store-acl.test.ts`（真实 pwsh 助手、真实 NTFS）钉住。
   反向探针：把 `SetAccessControl` 换回 `Set-Acl` 后重跑，**恰好**那两条与重启有关的用例失败，
   其余三条仍然通过 —— 断言确实指向这个缺陷，而不是顺带被别的失败掩盖。
   LWB-007 的状态因此不该被读成「机制层已被证据覆盖」：它当时的证据是判定层的。
97. **LWB-025 的交付物路径与任务书草案不一致**（登记，不是缺陷）。
   任务书 `deliverables` 写的是 `apps/mcp-adapter/tools/changes.ts`，
   而实际的接线落在 **daemon 侧**：`apps/daemon/src/tools/{handlers,catalog,guard,access}.ts`
   + `packages/changes/src/query.ts` + `packages/contracts/src/tool-outputs.ts`。
   原因是本仓库的分层**已经比任务书草案更具体**：适配器是**哑管道**
   （名字进、结果按 `outputSchema` 出，不含任何业务判断），工具面的**语义**
   ——可用性、策略动作、说明文案、出站字段—— 全在 daemon。
   把 `change_*` 的实现写进适配器，等于在管道里放一份只有一半的策略，
   而那一半**不在** FsGuard 的受检面、也不在审计提取器的覆盖里。
   任务书自己写的执行步骤（「保证提议工具标注为会改变服务状态」）说的是**标注**，
   与它落在哪一侧无关；因此这里按「实现规格一致、落点不同」登记，而不是改写任务书。
98. **纯 `create_text` 提案的代次核对是同义反复**（LWB-025 登记 —— **买的是可用性，不是安全**）。
   `create_text` 不读任何文件，因此结构上不可能有读取票据；而
   `ACTION_SPECS.change_prepare.requires_ticket` 为 `true`，代次为 `null` 时判定直接拒绝。
   两者相乘的后果是：**「在已存在的父目录里创建新文件」这条 V1 明列的能力整条不可用** ——
   一个功能因为一条安全检查而消失，而那条检查在这个分支上无对象可查。
   现取工作区行上的当前代次（`createOnlyGeneration`），于是这次核对必然成立，
   买到的只有「工作区行确实存在」，而那是 `resolveWorkspaceAccess` 本来就会查的。
   **真正的保护在别处**：`prepareChange` 把代次落库成 `root_generation`，
   写入路径（LWB-027）在写每个文件之前重新核对它。
   这里读工作区行**不构成预言机**：结果只进 `presented`、不进回答，
   而 `resolveWorkspaceAccess` 仍然先查授权行、后查工作区行，两种情形的回答逐字不变；
   行不存在时给 `-1`，那个值在判定里必然与当前代次不等，因此是**失败关闭**而不是放行。
99. **别名缺口：指向被硬拒绝目标的短名与硬链接**（LWB-025 发现，**由 LWB-027 收口**）。
   `assertProposalPathsAllowed` 拦的是「提案点名的路径命中硬拒绝规则」，
   它是 `change_prepare` 唯一能拦的地方 —— 因为判定 `decide()` 的 `fileRuleFailures`
   只看 `action.path` 一条，而 `change_prepare` 是唯一一个一次调用指向**多个**文件的工具
   （被点名的文件在 `items[].path` 里）。只跑判定的话，「提案改 `.env`」是**允许**的。
   这条检查按**路径字符串**判（`items[].path` 与票据的 `canonical_path` 两侧都判，
   `classifyFile` 大小写不敏感，因此大小写差异不会漏判）。**剩下的缺口是 8.3 短名与硬链接**：
   一个指向 `.env` 的短名（`ENV~1`）在两条路径上都不命中 `HD-ENV`。
   **这一条已由 LWB-027 收口**（2026-09-26）：写入路径在写每个文件之前，拿**护栏给出的规范拼写**
   （`GetFinalPathNameByHandleW`，内核认定的那个名字）重新过一遍 `classifyFile` ——
   短名 `ENV~1` 在那里会被还原成 `.env`，因此命中 `HD-ENV`。护栏自己的注释里就写着这个理由
   （`ALPHA~1.TXT` 能打开同一个对象，但它不是它的名字），适配器里那次 `classifyFile(canonical)`
   是写入路径上**唯一**一处拿磁盘实际名字去过策略的地方。覆盖它的是
   `tests/unit/executor-native-adapter.test.ts` 的 **B6**（条目记 `docs/notes.md`、磁盘上那个对象叫 `.env`
   ⇒ `refused`，理由点名 `HD-ENV`，且护栏调用 **0** 次）。
   **硬链接那一半仍未关**：`link_count > 1` 时拒绝的核对在护栏里（打开句柄时一并做），
   但本机无法对**普通用户**按需造出硬链接，因此它在真盘上是 `NOT_RUN`（证据 §7 最后一条）。
   登记在这里而不是静默：一个「按路径判硬拒绝」的实现看起来完备，
   而它挡不住别名，这件事写下来才不会被读成「已经挡住了」。
100. **票据代次的取证一度在「看错的理由」上通过**（LWB-025 发现并修 —— **是证据脚本自己的错**）。
   取证「同一份提案里两张票据来自不同代次」的第一版做法，是把票据尾部改掉几个字符，
   期望走到 `TICKET_GENERATION_DISAGREE`。实际拿到的是 `TICKET_BAD_SIGNATURE`
   —— 票据**先被验签**，代次那一步根本没走到。断言因为只检查「被拒绝了」而**通过了**，
   但通过的理由是错的：它证明的是「签名校验在起作用」，不是「代次不一致被挡住」。
   改法是**真的把代次推上去**（`repos.workspaces.bumpGeneration`，与撤权/重登记同一条路），
   在推进前后各读一个文件拿到两张**各自合法**的票据，再把它们放进同一份提案；
   并补一条对照（只拿旧代次那张票 → `WORKSPACE_GENERATION_CHANGED`）。
   **这类错误的形状值得记住**：一个「被拒绝了」的断言，如果它不检查**理由**，
   就会在实现换了拒绝原因的将来继续通过 —— 而它保护的已经不是原来那件事了。
101. **解除阻断的成功路径在 V1 里走不到**（LWB-026 采集时发现 —— **fail-closed 的方向，不是缺陷**）。
   `RECOVERY_REQUIRED` 刻意**不在** `TERMINAL_CHANGE_STATES` 里
   （`packages/contracts/src/change.ts:318`）：终态的定义是「不可再回到可执行状态」，
   而待恢复的操作恰恰要回到 `APPLIED` 或 `ROLLED_BACK`。
   于是**每一次真实阻断都会留下一个「尚未终结」的前驱**，而 `clearBlockade` 要求前驱已终结 ——
   两条规则各自都对，合起来的效果是：**在 LWB-030 交付之前，没有任何一条真实路径能让一块地被解除阻断。**
   本仓库里它的**成功**分支今天只有单元测试在走（F2 手工把前驱推到 `APPLIED`），
   属于「未被生产路径覆盖的代码」。两个后果写在这里免得被读成「已经能恢复」：
   (a) 成功分支与「清标志不是删行、令牌原地保留」的性质没有生产路径的证据，
   只有 `tests/unit/executor-coordinator.test.ts` 的 F2/F3；
   (b) 运维意义上的「工作区卡死」在 V1 里**可以发生且无法在界面内恢复**。
   方向是对的（字节下落没定案就不许换人写），但它是**等 LWB-030**，不是「已经好了」。
   **LWB-030 交付后，这条的第一半有了出路**：恢复服务在定案成 `APPLIED` / `ROLLED_BACK` 之后
   会解除那块地的写阻断（`#liftBlockade`），而它判「前驱已终结」用的正是**同一个导出常量**
   `TERMINAL_CHANGE_STATES`，不是第二份规则。它今天没有直接调协调器的 `clearBlockade`：
   协调器还没被装配进守护进程（接线属 LWB-032），而「启动时先处理未终结操作，再开放写能力」
   要求解除阻断就发生在**启动扫描这一步**——一个判定成 `APPLIED` 却仍被阻断的工作区，
   会让 `requiresRecovery` 永远为真，于是能力开关从「有事要你处理」变成一块擦不掉的红字。
   这一处替换（`coordinator.clearBlockade` 取代服务里内联的 `write_slots.unblock`）
   明确记在 `service.ts` 的注释里，属 LWB-032。
   **第二半照旧**：模型侧仍然够不到这条路，因此「工作区卡死」在 V1 里依然无法在界面内解除。
   另记一处**实现细节上的诚实说明**：`#liftBlockade` 的 `PREVIOUS_NOT_TERMINAL` 与
   `SLOT_OPERATION_MISSING` 两个分支在生产认领路径（`claim.ts`）上**走不到** ——
   那条路径在阻断写槽**之前**就先把操作标成了 `RECOVERY_REQUIRED`。
   因此 LWB-030 的证据只断言可达的那个结果（`blockade.kind === 'cleared'`），
   另两个分支的可核形式留在 `tests/unit/recovery-plan.test.ts` 里。
   一个没人能走到、却在证据里报 `PASS` 的分支，比没有这一条更糟。
102. **执行器清单漏了一个依赖，而没有任何检查会发现**（LWB-026 发现并修）。
   `packages/executor/src/coordinator.ts` 一直在 import `@lwb/idempotency`，
   而 `packages/executor/package.json` 的 `dependencies` 里没有它 —— 一切照常工作，
   因为 npm workspaces 把全部 `@lwb/*` 提升到了**根** `node_modules`，
   未声明的依赖照样能解析到。因此这条**不是**「运行不了」，而是
   **「清单在说谎而没有人会知道」**：把一个包单独发布、或换一个不做提升的包管理器，
   它才会以「找不到模块」的形式暴露出来。登记在这里的现实意义是它指出了检查面上的一个洞：
   本仓库有 `check-fsguard-imports.mjs` 管**导入前缀**（161 个文件），
   却**没有**任何一处比对「谁 import 了什么」与「清单里声明了什么」。
   已修的是这一处（补上 `"@lwb/idempotency": "*"`），**检查本身仍未加**。

103. **一个会自己松手的「持有」被当成并发证据在用**（LWB-027 发现并修）。
   `native/winfs/WinfsGuard.ps1` 的 `Op-HoldHandle` 起初把持有的句柄留在函数局部变量里。
   .NET 的 `SafeFileHandle` 是**终结器对象**：函数一返回、局部变量一不可达，GC 就可以把句柄关掉。
   实测形态：同一段代码连跑 20 轮，第 20 轮的「外部保存被挡住」只出现了 **19 次** ——
   那一次不是环境抖动，是句柄被回收了。
   **这个缺陷只在「拿它当证据」的时候才是缺陷**：如果没人测它的稳定性，它会一直看起来是对的，
   而实际上交出一条约 5% 失败率的断言 —— 那会在回归里表现为随机失败，
   最容易被归因成「这台机器忙」，然后被重跑掩盖掉。
   修法是把句柄存进 `$script:LwbHeldHandles`（脚本作用域，活到助手进程退出为止），
   同一测量随后**两次独立运行都是 20/20**，`tests/windows/` 全部 214 例在修改后通过。
   登记在这里的第二个理由：**它改的是证据采信的门槛** ——
   `tests/windows/executor-write-path.test.ts` 现在以那条修改为前提，
   谁把引用留存去掉，那里会以「环境抖动」的样子开始偶发失败；测试文件头、证据 §0.2 与 summary §3
   都写明了这层依赖。补一句边界：`holdHandle` 是 spike 专用操作（**刻意不在 `WinfsOps` 里**），
   它承诺的只是「在这个助手进程活着期间持有」，不能当成一把跨进程存活的锁。
   本轮**没有**对 `Op-WriteFileGuarded` 本身做过同样的压力测量 —— 它是**一次请求内的
   开→写→刷→回读→关**，句柄活在同一段同步代码里，不经过「函数返回后仍需存活」这一关。

104. **记录说「可能已经写了」，而事实是一个字节没写**（LWB-027 发现并修）。
   `packages/executor/src/native-adapter.ts` 里 `recordIntent` 原本无条件地跑在阶段 A 之后、
   阶段 C 之前，而**中止只在阶段 C 的循环开头才被看见**。于是一次在阶段 A 之内被取消的执行
   会在账上留下 `APPLYING` —— 而那一格的含义正是「字节可能已经在盘上了」。
   后果是**一次没有对象的人工核验**：记录要求人来定案，磁盘其实一个字没动。
   值得记下来的是**抓到它的方式**：不是靠读代码，是单元测试把中止点用 `Proxy` 精确地落在
   阶段 A 的探针调用上（而不是落在两阶段之间），于是「到底记没记意图」第一次有了可观测的差别。
   修法是在 `recordIntent` 之前补一次 `throwIfAborted`：代价一行，换来的是记录与事实一致。
   证据 §5a 那一格就是它的回归。

105. **两处我自己的错误预期被实跑纠正**（LWB-027，留档以免下次再犯）。
   两处都不是代码的问题，是**我在写断言时对系统行为的猜测**，且都以「断言红而实现是对的」的形式出现：
   (a) **阶段 A 的拒绝返回 `{kind:'refused'}`，不抛。** 我原本写的是期待抛出。
   正确的读法是：只有**写后**失败才抛（那才需要恢复流程）；阶段 A 就定案的拒绝，
   `refused` 的含义是「现在不行，什么都没变」—— 把它升格成「需要人来」，
   会让每一次拒绝都变成一次人工核验。修正进了证据 §5b。
   (b) **记过执行意图的修改集，不能再被同一个写入方重提。** 映射文件那次失败之后，
   我原本预期重提会走到 `applied`，实际拿到 `INTENT_RECORD_FAILED`。
   这是**正确**的 fail-closed 行为：账上已经写着「可能写过」，重来是恢复流程的事（LWB-030），
   不是同一个写入方再试一次。证据 §4 因此从原来的一格改写成了 丙/丁/戊 三格。
   两处都按实际行为改了证据与断言，而不是把实现掰到我的预期上。

106. **「一个对象都没创建出来」与「可能已经写了一部分」在账上是同一句话**（LWB-028 发现 ——
   **有意保留的粗糙**，不是缺陷）。
   创建路径上，`CREATE_NEW` 撞上一个刚被别人占掉的名字是**阶段 C** 的失败
   （适配器已经发过创建调用），于是 `writeFailure` 照规矩抛 `RECOVERY_REQUIRED`、
   `reason` 是 `WRITE_FAILED_MIDWAY` —— 而那一格的账上含义是「字节可能已经在盘上了」。
   事实是**一个对象都没创建出来**：`Op-CreateFileGuarded` 里那次 `CREATE_NEW`
   在**内层 `try` 之外**，因此它失败时不带 `actual_state`，
   `details.object_created=false` 就是这件事的正面证据。
   **为什么不把这一格改成 `conflict`**：状态机的转移表里没有 `APPLYING → CONFLICT` 这条边，
   而阶段 B 已经把账推到了 `APPLYING`。补那条边的代价不是多一行 ——
   它会让「记过执行意图的执行可以报『磁盘上没有这次执行改动的字节』」变成**合法**，
   而那句话在别的情形下（崩溃在写完一半之后）就是**假的**。
   换来的是一次**多出来的人工核验**，因此把真实情况写成两处可读的东西：
   `details.object_created` 明写出来，两条失败文案分开
   （「未创建任何对象：创建调用没有成功」vs「对象已被创建，磁盘实际状态已记录」）。
   证据 §2 丙 与 §5c 是这一对的反面照：同一句 `RECOVERY_REQUIRED`，
   `object_created` 一格 `false`、一格 `true`。
107. **可核对的是映射后的码，不是 Win32 码本身**（LWB-028 实测纠正了我的一个猜测）。
   我先把 `Convert-Win32Error` 的映射表当成了「撞名 ⇒ 183」的依据，
   实跑后本机 `CreateFileW` + `CREATE_NEW` 返回的是 **80**（`ERROR_FILE_EXISTS`）。
   两者在同一张表里都归 `FILE_VERSION_CONFLICT`，因此**契约没有变**：
   适配器与测试断言的是映射后的码，护栏回执里那个 `win32_error` 是**实现细节**
   （它随 Windows 版本与 API 组合而变，本次证据里留下来的就是 80）。
   这类「映射表里的另一个分支也通向同一个结论」的地方，取证时要断言结论、不要断言分支。
108. **采集时我自己的三处构造错误**（LWB-028，留档以免下次再犯）。
   三处都不是实现的问题，但**前两处的形态都是「断言绿着，而它测的东西没发生」**：
   (a) **假盘里抢跑者「追加」而不是「替换」**：构造竞争那一格时，假盘的 `beforeCreate`
   往记录表里**追加**了一条新记录，而查找取的是**第一条**命中的，于是脚本读到的是先前
   那条「这个名字不存在」—— 竞争根本没发生，那一格是**空洞地**成立的。
   改成**替换**记录之后，竞争才真的被构造出来。
   (b) **脱敏那一格拿「已占用的目标」去构造阶段 C 的失败**：撞名的失败发生在**阶段 A**
   （适配器探到名字被占），而阶段 A 的冲突说明是适配器自己用**相对拼写**写的，
   压根没经过脱敏 —— 拿它证明「脱敏有效」永远为真。改法是让失败真的落在阶段 C
   （用抢跑构造），这一对才有对照价值。这个坑写进了 `summary.md` §6。
   (c) **「形态不符」那一格缺了 BOM**：喂进去的字节没带 BOM，而声明写的是 `bom: false`，
   于是声明的形态与实际**恰好一致**，那一格返回 `applied` 而不是 `refused`。
   三处都按实际行为改了证据与断言。
109. **判据写在行为上，换来源时得有人指出来**（LWB-028 回填 LWB-027 §5b）。
   LWB-027 的 §5b 那一格，来源是当时**一律被拒**的 `create_text`；LWB-028 把它实现出来之后，
   「`create_text` 被报成 refused」这句话自然不再成立。这一格要验的从来不是「哪个形态被拒」，
   而是「阶段 A 定案的拒绝不惊动恢复流程、也不碰磁盘」—— 判据写在**行为**上，
   因此换一个拒绝来源（改成「这份计划与它引用的快照对不上」）之后，四条断言**一个字没改**，
   本节的结论也没有变。代价记在这里：**这类判据不会自己提醒你去换来源**，
   是靠人在交付下一个任务时发现「我动了它引用的那个东西」。
   反过来，如果当初把判据写成「`create_text` 会被拒」，LWB-028 交付时它会**红**，
   而那会是一次「测试在正确地报告一件已经不该成立的事」—— 两种写法各有代价，
   这次的取舍是判据跟着**性质**走，并在此登记这条人工检查点。
110. **中文机器文案里，路径后面紧跟的助词会被读成路径的一部分**（LWB-028 修掉一处）。
   创建的冲突说明原本拼的是 `磁盘上的 ${canonical} 已被占用`，
   在带路径那一支会显示成「磁盘上的 src/new.ts已被占用」。这不是错别字问题：
   机器生成的句子要以**任意路径**为输入，而路径里可以有空格、可以没有分隔符，
   读者只能靠「哪里是路径的结尾」来断句。修法是把主语写成完整的句子
   （`磁盘上的 ${canonical} 已经被占用` / `目标位置已经被占用`），让路径**后面永远有一个空格**。
   与偏离项 13（PowerShell 插值的 CJK 陷阱）是同一类：**中文 + 变量拼接 + 无空格**。
111. **护栏的消息里带着本机绝对路径，而三条出口里只有两条设了防**（LWB-029 发现并修 —— **真实缺陷**）。
   护栏的消息是在**它自己的坐标系**里写的：`WinfsGuard.ps1` 的 `Open-Guarded` 把 `$Path` 拼进文案，
   于是「拒绝访问」那句话里站着目标文件的**绝对路径**。这句话从失败分类出来之后走三条路：
   条目级日志（`appendItemEvent` 在落库前脱敏，安全）、报告（出口处还有一道 `sanitize`，安全）、
   以及**抛出去的 `RECOVERY_REQUIRED`** —— 协调器 `#finalize` 接住它，把 `error.message`
   **原样**写进一条**改动级**日志行，而那一行**不经过** `appendItemEvent`。
   于是工作区根会跟着一个异常走进执行日志 —— 而执行日志是要给人看、要留档、要跨会话读的东西。
   修法是在**造出那句话的地方**（`apply.ts` 三处拼装点）脱敏，而不是在第三条出口上补一道：
   出口是**从代码里长出来的**（今天三个，明天接一个新汇报面就是四个），
   修在源头时每多一个出口都自动安全 —— 这条规则本身写在 `apply.ts` 那段注释里。
   **并且验证了修改咬得住**：把 `guardLine` 改回原样后单元 J1/J2 **双双变红**，
   并把泄漏的那一行原样打出来（`…护栏拒绝（PERMISSION_DENIED，Win32 5）：拒绝访问：C:\lwb-027\repo\src\a.ts。…`），
   放回去即恢复绿 —— 没有这一步，无法区分「修好了」与「本来就没漏」。
   脱敏的**范围**如实记在 `summary.md` §6.5：`redactRoot` 只替换工作区根一个字符串，
   这是**恰好够用**（护栏只处理根之下的路径），**不是**「所有路径都脱敏了」。
112. **「护栏没给磁盘现场」被读成「现场未知」，而它常常正是「确切知道没动过」**（LWB-029 修正判据 ——
   **是语义修正，不是改名**；同时**退役偏离项 106**）。
   旧判据问的是「失败回执里有没有 `actual_state`」：没有就当成「字节下落不明」，
   于是**只读目标**、**`CREATE_NEW` 撞名**这两格**总是**付一次人工核验的代价 ——
   而 LWB-028 的旧 NOTE 自己就把那次核验记成「**多余的**」，磁盘上明明什么都没发生。
   新判据问的是护栏回执里的 `touched` 那一行：它的缺席意味着**没有越过破坏性区域**，
   那是**确切知道**而不是不知道；而 `NATIVE_GUARD_UNAVAILABLE` 这一格**不证明任何事**
   （护栏根本没跑起来，「另一侧也没动」这句话没有来源）。
   两条路（改写、创建）在这一点上**同向成立**，因此恢复流程只需要读一个字段：
   `guard_verdict` / `guard_touched` 取代 `crossed_truncate` / `object_created`，
   两格的代价连同它们各自的特例一起消失。
   **「不为这两格改状态机那张图」这条约束没有被放弃**：`APPLYING → CONFLICT` 这条边依然不存在，
   证据里专门断言 `change.state` 仍停在 `APPLYING`。
   偏离项 106 登记的那次「多出来的人工核验」因此**不再存在**：它是有意保留的粗糙，
   现在粗糙本身没了，那条登记随之退役（原文仍保留在上方，免得「它为什么曾经存在」失传）。
113. **折叠函数的排除项才是承重的那一半**（LWB-029 设计边界，非缺陷）。
   `aggregateOf` 的三种好结局各自只允许一组条目终局，其余一律 `unfinished`：
   `{written, untouched}` ⇒ `unfinished`、`{restored, left_changed}` ⇒ `unfinished`、
   账上条目数不等于 `expectedItems` ⇒ `unfinished`（**没日志的条目不能被当成「没被改」**）。
   要把「部分完成绝不当成全成功」变成一次**测量**，光有前一条不够：
   一个**永远返回 `unfinished`** 的实现同样能过它。因此证据 §5 的 ② 必须配上
   ③（单条目全 `written` 时**必须**给 `applied`）与 ④（少一个条目**必须**不放行）才闭合。
   `untouched` 这一格在 LWB-028 里**只能抛**（那条路当时没有可报的终局），现在它有了名字：
   「每个条目都失败、且每一个都能证明没留下字节」落在 `rolled_back` 上 ——
   它满足的定义是「盘上没有本次执行的字节」，**不是**「我们回滚过」。
114. **快照缺失的拒绝发生在阶段 A，不是阶段 A2**（LWB-029 实测纠正我自己写下的标题）。
   证据里那一节原本写作「快照在阶段 A 通过之后、阶段 A2 之前消失」。**实测不是。**
   把已登记的快照对象从盘上删掉，拒绝来自阶段 A 的核查（`vet` 逐个条目取目标快照时就发现对象缺失）。
   这不是缺陷，是**更便宜也更早**的失败点：A 阶段本来就该去取那份快照。
   验收要的「快照持久化失败 ⇒ 零写入」已由七条断言满足，而「恰好停在 A 与 A2 之间」
   那个更窄的构造要再开一个注入点才造得出来，因此归单元 H 组。
   与偏离项 105 / 108 同类：留档，以免下次把「我以为的时序」再写进标题。
115. **拿磁盘字节去比 `git show` 的字节，判的是换行规范化而不是回滚**（LWB-029 的判据错误）。
   验收 3 里「一号文件回到了工作区原先的那一份」这一条，第一版写的是
   「磁盘字节的哈希 == `git show HEAD:src/a.txt` 的哈希」，**红了**。
   红的原因是 Git 在 `add` 时按 `core.autocrlf` 把 CRLF 存成了 LF：
   **仓库里的字节与工作区里的字节本来就不相等**。**是判据错了、不是实现错了。**
   改成三条都不依赖这个等式的判据：磁盘字节与**执行前的基线**逐字节相同、
   批准的那份与基线本就不同（防「什么都没写」蒙混过关）、
   以及 `git hash-object <file>` == `git rev-parse HEAD:<file>`（两边都过 Git 自己的规范化）。
116. **夹具可以撒谎、断言不该跟着撒谎**（LWB-028 §5c 的注入夹具自相矛盾，LWB-029 修）。
   那个夹具注入了 `touched` 之外的一切，却在磁盘上留下一个**真的 45 字节新对象** ——
   也就是说它一边补报一句「我什么都没动」，一边把对象建了出来。
   在旧判据下这句话是「自洽的」（反正只看 `actual_state`），换成 `touched` 之后它立刻自相矛盾。
   修法是给注入补上 `touched: true`（它模拟的本来就是「对象已经建出来了才发现出的问题」）。
   形态上与偏离项 108 的三处同类：**断言绿着，而它测的东西没发生**。
117. **脱敏那一节的夹具把标记放在了工作区根之外**（LWB-029 §6 的构造错误）。
   第一版把注入消息里的路径写成沙箱里的另一个目录，于是断言红在「脱敏没生效」上 ——
   而 `redactRoot` **只替换工作区根一个字符串**，根外的路径本来就不该被这条规则换掉。
   那是**夹具的错，不是脱敏的错**。修法是把标记放进工作区里（并把工作区挪到它自己的子目录），
   前面加一条 ⓪ 先断言「这个标记确实落在工作区根之下」——
   否则本节验的是「根外的路径也没被脱敏」这件本来就该成立的事。
118. **两条已交付的证据各有 5 处 / 6 处断言被重新指向**（LWB-029 回填 LWB-027 / LWB-028）。
   `touched` 那一次语义修正把三格的行为从「抛」翻成了「干净地报」，于是
   LWB-027 的 5 处、LWB-028 的 6 处断言不再成立。**没有一处被改成「放宽」**：
   每一处都换成了**更具体**的判据（从「抛了没有」换成「账上那条终局是哪个阶段」+「磁盘字节对不对」），
   两份 `summary.md` 同步更新，逐条记在 `docs/evidence/lwb-029/summary.md` 的 §8.2。
   登记的理由与偏离项 109 相对：109 说的是「判据写在行为上、换来源时不会自己提醒你」；
   这一条是它的另一半 —— **行为真变了的时候，红的断言是在正确地报告一件已经不该成立的事**，
   而重指它需要有人当场判断「新判据是不是仍然测得住原来那件事」，这次是我。

119. **唯一性冲突的判定按前缀匹配，会把一次 `CHECK` 失败报成「已存在」**（LWB-030 写恢复授权表的
   测试时撞出来的 —— **真实缺陷**）。
   `packages/persistence/src/repositories.ts` 的 `isUniqueViolation` 原本判的是
   `code.startsWith('SQLITE_CONSTRAINT')`。而 SQLite 的约束错误码至少有六类：
   `_UNIQUE` / `_PRIMARYKEY` / `_CHECK` / `_FOREIGNKEY` / `_NOTNULL` / `_TRIGGER`，
   而那个函数的**五个调用点全部**把 `true` 解释成「已存在，去读那一行」。
   撞出来的方式很直接：构造一条**畸形摘要**（不是 64 位十六进制）期待 `CHECK constraint failed`，
   拿到的却是「该操作已存在有效恢复授权」—— 一句与实际原因无关的话，
   而排障的人会照着它去查一个并不存在的问题。
   修法是收窄到 `SQLITE_CONSTRAINT_UNIQUE` 与 `SQLITE_CONSTRAINT_PRIMARYKEY`
   （`INSERT` 撞主键与撞唯一索引对调用方是同一件事，而两者在 SQLite 里的报码并不总是同一个）。
   收窄之后，畸形输入以 `SQLITE_CONSTRAINT_CHECK` 原样上抛 —— 那是**内部不变量被破坏**的信号，
   它不该被任何调用点当成一个正常分支吃掉。
   这条的形态与偏离项 109 / 113 同类：**判据宽一格，失败方向就从「响亮」变成「静默」**。
120. **搜索的 3 秒预算按挂钟走，并行跑测试时会先于搜索本身用尽**（LWB-030 采集时撞出来 ——
   **不是本任务引入的，是本任务把它撞出来的**）。
   `node scripts/run-tests.mjs tests/windows` 在 LWB-030 采集期间**连续三次**红在 241 / 242，
   红的都是 `files-search.test.ts` 的第一条，报的是 `undefined !== 'src/app.ts'` ——
   读起来像搜索坏了。诊断（不是猜）有两条：那一条用例的 `duration_ms` 是 **3603**，
   而预算是 `SEARCH_TIME_BUDGET_MS = 3000`；预算的判法是**挂钟**
   （`deadline = now + 限额`，每个文件之前用 `deps.clock()` 判一次），
   而 `tests/windows` 目录单跑时 14 个文件同时开跑、每个都常驻一个 pwsh 护栏，
   于是「只读 3 个小文件」的一次搜索也会花掉 3.6 秒。
   **与本任务无关这一点是验过的**：把 `tests/windows/recovery-converge.test.ts` 挪开再跑，
   仍然 241 / 242（229 / 230）。
   **产品那一侧是对的**：一次被预算截断的搜索**会说明自己被截断了**
   （`incomplete_reason` 里有那句话，`searchBounds()` 会给出 `DEADLINE`）。
   错的是**测试**：它把「这一次被截断了」读成了「搜索坏了」。
   修法两条，缺一不可：(1) 这个文件显式用 `TEST_BUDGET_MS = 60_000` ——
   预算自己的边界由 `tests/search/` 那几份用**注入的** `clock` 验，那里不依赖挂钟；
   (2) 六条用例各自在断言之前加一条**装置前提** `assertNoDeadline(data)`，
   于是预算将来真的用尽时会红在「装置前提」上并**指名真正的原因**，
   而不是红在一句与原因无关的话上。判据刻意取 `deadline_exceeded` 而**不是**
   `incomplete_reason === null`：后者在「本页命中装满」「命中被抽走」这些**设计内**的情形里也非空，
   拿它当装置前提会把每一次分页都判成装置坏了。
   **反向探针**：把 `TEST_BUDGET_MS` 改成 1，六条**全部**红在那句装置前提上
   （而不是红在搜索行为上）；改回去之后 242 / 242，连续三次。
   登记它的理由：`npm run check` 是交付判据，而它在 LWB-030 采集期间红过 ——
   少了这一条，下次有人单跑 `tests/windows` 会以为是自己弄坏的。
   与偏离项 37 的关系：37 记的是**同一个文件的同一个失败形态**，当时的修法是把基准 `t0`
   从进程启动时刻挪到**每次调用**开始时。这一条是它剩下的那一半 ——
   「一次调用本身」也可能超预算。
121. **`MANUAL` 那一支原本不写逐条目回执**（LWB-030 发现并修 —— **真实缺陷**）。
   发现的方式是测试里 `records().items` 读出空数组：一份**正等着人工处理**的记录，
   在操作者最需要逐条目清单的那一刻，清单里一条都没有。
   而 `ChangeFileState.UNKNOWN` 这个回执状态本来就是为这一格准备的 ——
   它是「**不声称**任何一种回来了」的那个值。
   修法是让 `reconcile` 的 `MANUAL` 分支在**一个短事务**里写回执：
   状态一律 `UNKNOWN`，原因取判定给出的真原因（`THIRD_CONTENT` / `IDENTITY_UNKNOWN` / …）。
   这是**记录**，不是**定案**：它不改状态、不写字节、一条都不声称「回来了」。
   顺带抽出一个纯函数 `receiptReasonOf`，把「判定 → 回执上的 `error_code`」收成一处 ——
   只有「没能给出结论」的两种有码；`ORIGINAL` / `TARGET_REACHED` 是**结论**，
   给它们配一个错误码会把一次核验说成一次出错。
   修复之后全套测试计数 1473 → 1485（+12，正是新增的那个真盘用例），没有任何既有行为改变。
122. **`operation_item_results` 是错的回执来源**（LWB-031 设计阶段识别并拦下 —— **真实缺陷**，没写进代码）。
   「上次应用之后是什么」这个问题看起来有一个现成的答案：那张逐条目回执表。
   而它只在 `@lwb/recovery` 的 `reconcile` 分支里被写 —— **正常执行路径根本不会写它**。
   照它折叠意味着撤销在**普通的、成功应用过的**修改集上拿不到任何回执，
   然后把每一格都判成「回执不完备」—— 一个看起来完全合理的错误，
   而且**没有一条真盘用例会红**（装置里跑的是正常路径，那张表本来就该是空的）。
   真值来源是执行日志（`journal.list(operationId)`，按条目取最后一条）。
   这一条改变的是整个模块的地基，不是一处分支；`revert.ts` 的文件头因此把它写成了正文。
123. **执行日志里有操作级行（`item_id` 是 `NULL`），折叠必须先按条目过滤**（LWB-031 采集时撞出来 ——
   与 LWB-030 的真盘装置有关，**不是缺陷**，是一处此前没被记下来的事实）。
   真操作的日志**不是**只有条目级行：它最后还有一条 `write_applied`，而那条的 `item_id` 是 `NULL`。
   因此「取整条日志的最后一行」会取到一条**不属于任何条目**的行 ——
   在正常路径上它恰好也是 `verified` 之后的收场行，于是一个**不按条目过滤**的实现在今天会碰巧正确，
   而在任何一条收场行形状不同的路径上都会错。
   证据脚本 §5.2b 与真盘用例的 A5 各自把这一条钉住；`itemOutcomes`（LWB-029）本来就按条目折叠，
   这里补上的是**这个事实本身**的见证。
124. **守卫测试在为错误的理由通过**（LWB-031 的**反向探针**撞出来 —— 装置自己的一处修正）。
   把 `revert.ts` 的折叠规则故意改坏（`.lwb-local/probe-g.py`：改坏 → 跑 `tests/windows --grep changes-revert`
   → 原样还原，任何一步不干净就直接抛），四条变异里有一条**没有被咬住** ——
   而它不是「守卫漏了」，是**夹具本身就分不出对错**：第一版 G1 追加 `item_restored`
   **并且**把基线写回盘上，于是第二种防线（`observePath` 当场观测）在正确实现与变异实现下
   都得出 `ALREADY_ORIGINAL`，两种折叠规则给出同一个动作。
   改成围绕 `item_skipped`（盘上停在目标内容）之后才咬住 —— 那是唯一一个两种折叠规则会得出
   **不同动作**的夹具，而且变异那一边的动作是危险的那一个（它会去重写一个我们从没写过的文件）。
   另一条 `failed` 分支的变异也一度报 `MISS`，原因是删掉那个 `case` 会掉进 `default:`，
   而两者**行为等价**（都是 `unaccounted` / `RECEIPT_INCOMPLETE`）、只差文案 ——
   补一句断言让那条分支**可观测**之后才咬住。
   一条「能过、但过不出区别」的守卫测试比没有它更糟：它让规则看起来被守住了。
125. **两处证据断言是过度声称**（LWB-031 采集时发现并改 —— 不在代码里，在**证据**里）。
   §7.8 断言 `UPDATE changesets SET state = …` 会被触发器拒绝 —— **它是允许的**：
   `changesets_content_immutable` 有意**不**守 `state`（状态必须能流转，规则在 `assertChangeTransition` 里）；
   §8.5 断言整条 `git status` 不变 —— **工作区那一行本来就应该消失**，因为撤销**真的重写了文件**。
   两处都不是代码缺陷，而是证据在替系统许下它**没有许**的承诺。
   改法是「拆成准确断言 + 一条说明 + 一条反向探针」：§7.8b/§8.5b 是**说明**（不是缺陷）、
   §7.8c 直接验代码那一侧的守卫真的会拒、§7.8d 是它的反向探针
   （`PENDING_APPROVAL → APPROVED` 是合法的，不该被拒 —— 没有这一句，一个「一律拒绝」的实现也能让 §7.8c 全绿）。
   删掉那两条会连**真正**的保证一起失去见证，所以它们是被改写的，不是被删掉的。
126. **回执折错了表**（LWB-032 接线时发现并修 —— **真实缺陷**）。
   `operation_item_results` 看起来就是「逐文件回执」的现成答案，但它**只有 `@lwb/recovery` 会写**：
   一次干净跑完的 `change_apply` 从来不往它里面插行。只读它的话，一次**成功**的应用会给出
   逐文件 `UNKNOWN` + 两个哈希都是 `null` —— 而本任务的验收标准要的正是「回执包括逐文件哈希」。
   更糟的是它**看起来**像事实：`UNKNOWN` 是一个合法取值，读的人只会以为「这次没记下来」，
   不会想到「回执找错了表」。真正记着「我们写下去、并回读到了什么」的是执行日志
   （每个条目在 `item_verified` 上带着护栏回读得到的 `observed_sha256`）。
   `revert.ts`（LWB-031）已经为**同一个**问题选过这个来源，理由逐字相同 ——
   那次是「拿它当撤销的前提」，这次是「拿它当回执」，折叠规则因此共用（`execution-journal.ts`）。
   证据里两条独立的路钉住它：`change_get` 与 `change_apply` 给出**逐字相同**的逐文件回执（§3.14），
   以及回执逐字等于 `operationReceiptFor` 那一条（§3.17）—— 写入侧没有第二份回执实现。
127. **「执行中重放」掉进了认领，答的是一句关于批准的话**（LWB-032 发现并修 —— **真实缺陷**）。
   判定原本写的是「不是执行中的状态就返回」，于是**执行中**那一格掉进了认领：
   而批准在认领那一刻就被消费掉了，复核门禁因此回一句 `APPROVAL_CONSUMED`。
   调用方问的是「写完了没有」，得到的却是一句批准内部的话 —— 而工具说明承诺的正是
   「返回该修改集唯一那条操作」。判据换成 `canBeginWrite`（**不可认领**）之后，
   「不可认领」与「不可能产生第二次写」变成同一件事（`operations` 表上的 `UNIQUE(change_id)`
   加上 `claimForExecution` 只认 `QUEUED`，两条合起来保证它）。
   这一格在真盘上假不了：证据 §6.7 ~ §6.11 在「写盘被真的卡住」的时刻重放，
   拿到的是「还在执行」而不是一句错误，且护栏写入调用次数**一次都没增加**。
128. **审计范围表对 `change_revert_prepare` 的本机方案路径取不出来**
   （LWB-032 接线时发现并修 —— **真实缺陷**，方向是「记下一件没发生的事」）。
   在契约把路径单列成结构化字段之前，本机方案的路径**只**存在于 `local_action_reason` 与
   `instruction` 两句散文里，而这两句取不出来 —— 于是审计表会把一次
   「模型手上明明拿到了文件名」的调用记成「什么也没读」。一条记不出事实的记录比一条没有记录更糟：
   它会被人当成结论。修法是让路径成为结构化字段（`change.files[].path` 与 `local_actions[].path`），
   审计照取，散文仍含路径（`instruction` 是写给人看的流程说明），但审计不再依赖它。
129. **两条时钟混用会让真盘用例红在一句与它无关的话上**（LWB-032 采集时撞出来 —— 装置自己的一处修正）。
   工具面那口钟是**锚定**的（恒为 `NOW`），而 `createToolHarness` 的协调器工厂如果忘了传 `now`，
   协调器就退回真实当下；批准与修改集的有效期却是工具面那口钟盖的章。
   于是同一个用例里会出现「默认协调器能过、工厂协调器过期」，而失败落在「批准已过期」上，
   与被测的东西毫无关系。修法是把 `now` 做成**必填**：忘传是一处编译错误，而不是一次难查的红。
130. **控制平面测试会因为连接池复用而偶发红**（LWB-032 期间猎到并定位 —— 装置自己的一处修正，
   **不是产品缺陷**）。症状：`tests/unit/control-plane.test.ts` 偶尔红一次，报的是
   `TypeError: fetch failed`（栈落在 undici 里），而不是任何一条断言 ——
   两次观察到的失败点还落在不同的用例上（`步骤 2：会话、CSRF 与一次性 nonce` /
   `验收标准 2：MCP 连接凭证不能调用控制 API`），因此它很容易被当成随机噪声忽略掉。
   根因：Node 的 `fetch`（undici）按 origin 维护**进程级**连接池，而本文件每个用例都起一个自己的
   控制平面服务、用完 `close()`、端口由系统分配 —— 系统把同一个端口再分给下一个用例是常事，
   于是下一个用例的**第一次** `fetch` 会捡起上一条用例留下的死连接，得到 `ECONNRESET`。
   定位方式是把它做成**确定性复现**：同一个端口上连着跑两轮，第 2 轮第 0 次请求必现；
   而每条请求都新建连接则一次都不失败（复现脚本是一次性的、放在被 gitignore 的 `.lwb-local/` 下，**没有随提交留下** —— 上面两句就是它的全部要点，不必去找那个文件）。
   修法是让本文件的 `fetch` 一律带 `connection: close`（`NO_REUSE`）—— 每个用例的服务都是短命的，
   本来就没有连接可复用；并且加了一格**源码级自检**：新加一条不带它的 `fetch` 会让这一格立刻红
   （已用反向探针验过它真的会咬：去掉一处即红，并指出是第几个调用点）。
   **刻意没有做成「失败就重试」**：重试是把症状按下去，而且会让真正的传输层缺陷也变成一次通过。
   修完之后用**同一装置**再猎 20 轮（`npm run test` × 20，每轮看 `^not ok` 的行数），
   结果是 `iter 1..20: notok=0 fail=0`，一次都没红；而改动之前，同一装置在**第 8 轮**撞到过一次。
   **20 轮干净不是「这个类别的缺陷从此不存在」的证明** —— 它是同一个装置上的 20 次观察，
   只是足以说明**这一条确定性复现**被修掉了；真要更强的结论得换装置（比如把端口固定住再跑），
   而那是另一件事。
131. **LWB-032 的交付物路径与任务书不一致**（与偏离项 97 同因，不是缺陷）。
   任务书写的是 `apps/mcp-adapter/tools/apply.ts`。实际落点是
   `packages/executor/src/apply-service.ts`（应用服务）+ `apps/daemon/src/tools/handlers.ts`
   （工具面处理表）。理由是**本仓库的适配器是一层纯传输**：它的 `tools/list` 逐字转发契约里的
   描述与输入 schema（`docs/evidence/lwb-032/summary.md` §1.12 就是这一点的证据：
   契约长度 308 == 适配器长度 308），工具的实现在守护进程的工具面这一侧。
   真按任务书的路径放，就会出现**第二份文案与第二份 schema** —— 而那正是 §1.12 要排除的东西。
   这条偏离只关乎文件放哪，不关乎行为：验收标准查的是工具面实际给出去的描述与回包。

132. **回滚报告里的一句自相矛盾**（LWB-033 发现并修掉，`packages/executor/src/apply.ts`）。
   `rolled_back` 这个折叠结论**允许带着 `untouched` 的条目**，而 `untouched` 最主要的两种成因
   （基线哈希不符、目标对象已经换人）本身就意味着**盘上已经不是执行之前的样子了**。
   原来的措辞一律说「工作区回到执行之前的样子」，于是同一份报告里会同时出现
   「独立回读看到的是……与基线不同」与「工作区回到执行之前的样子」两句话。
   修法是按 `untouchedCount` 分成两句：为 0 时才是原话，大于 0 时说
   「工作区里没有本次执行留下的字节；N 个条目是护栏在动笔之前就拒绝的……」。
   一份自相矛盾的报告比一句含糊的话糟得多：它把「别人改过盘」这件事从报告里说没了，
   而那正是操作者此刻最需要知道的一件事。

133. **把一个未知印成了已知**（LWB-033 发现并修掉，`packages/executor/src/native-adapter.ts`
   + `packages/recovery/src/service.ts`）。护栏进程被杀掉时，调用方拿到的是**客户端合成**的一条失败
   （`ResidentHelper.#onGone`），它一个字节的下落都没说；而原来的判据把它压成两句二选一，
   于是这句话被印成了「已进入破坏性区域」。杀伤面不是措辞难看：恢复流程据此判断
   「这次写入动过盘」，而它可能**根本没到过护栏**。
   修法是三值判据（`guardVerdict` → `TOUCHED` / `NOT_TOUCHED` / `UNKNOWN`）与它的措辞
   （`guardVerdictClause`），第三句写的是「这个回答可能根本没到过护栏，因此它进没进破坏性区域
   没有被报告过」—— 它不描述磁盘，它描述**我们手上有什么证据**。
   三处报告 + 一处恢复日志同时改用同一个函数，因此四处的说法不可能再分叉。

134. **「助手还在不在」的探测器每次把自己数进去**（LWB-033 发现并修掉，
   `tests/fault-injection/fault-rig.ts` 的 `guardHelperPids`）。查询自己也是**这个 node 进程的一个 
   pwsh 子进程**，而它的命令行里就写着 `WinfsGuard.ps1` 那半句过滤器 —— 于是它同时满足两个条件
   （父进程是本进程、命令行里出现 `WinfsGuard.ps1`），**每一次调用都会把自己数进去**。
   杀伤面不止于多一个数：「助手还在不在」正是这一组用例里唯一用来证明**故障真的落地了**的观察，
   而一个每次都比实际多一个的探测器会让「还看得见」与「已经不在」这两句话同时变得不可信。
   缺陷是证据脚本 §7.1（断言进程表里**恰好一个**助手）撞出来的，修法是过滤器加一句 `$_.ProcessId -ne $PID`。

135. **`PauseService.engage()` 用两口钟写下了同一件事的两个时刻**（LWB-034 发现并修掉 —— **真实缺陷**）。
   这一步要同时做两件带时刻的事：把 `paused_at` 落库、并调 `invalidateMany(…, now)` 去废止排队授权 ——
   而后者拿这个 `now` 与 `approvals.expires_at` 比大小，那个时刻是 `Repositories` 的那口钟写下的。
   原实现里 `engage()` 取的是 `new Date()`。两口钟不一致时（测试夹具的锚定钟、任何注入过的钟、
   或只是跨过一次时钟调整的真实进程），一次「操作者按下了停用」会被**记成**「那条批准本来就过期了」。
   杀伤面不是措辞：审计里因此**看不见有人按过这个按钮**，而这条记录的全部意义就是它。
   修法是给 `PauseServiceDeps` 加一口可注入的钟（`now?: () => string`，默认仍是真实当下），
   装配根与测试装置传**同一口**钟。
   它之所以能被撞出来，是因为那条断言查的是**原因**（`details.reason`）而不是错误码 ——
   `APPROVAL_REVOKED` 与「过期」共用 `APPROVAL_EXPIRED` 这个码（与 `packages/policy` 的
   `approvalFailures` 逐条对齐），只看码的话这一格是绿的。

136. **夹具的协调器没有接上停止源**（LWB-034 发现并修掉 —— 装置自己的一处修正，
   `tests/tools/harness.ts`）。`ExecutionCoordinator` 在本任务起接受一个外部停止源
   （`stop?: () => AbortSignal`），装配根接上了、测试夹具没接 —— 于是「按下紧急停用」
   在真盘用例里对**在途写入**是一个空操作：盘上第二个文件照样会被写掉。
   杀伤面正是它的价值：一个**没接上**停止源的装置会让「在途写入在安全边界停下」这半条验收
   在一个**永远不会通过**的断言上暴露出来（本任务的真盘 §1 就是这样撞出来的）——
   但如果那一格恰好没被写下来（比如只断言了「盘上第一个文件变了」），
   整个 §1 会在**停用根本没生效**的情况下全绿。
   修法是在 `defaultCoordinator()` 里接上 `stop: () => pauseService.stopSignal()`，
   并让夹具里的 `PauseService` 与协调器是**同一个**实例（两个实例会造出两个互不知晓的信号，
   于是「按了停用但有一个执行者没停」成为可能）。

137. **LWB-034 的交付物路径与任务书不一致**（与偏离项 97 / 131 同因，不是缺陷）。
   任务书写的是 `packages/executor/pause.ts`、`apps/daemon/control/pause.ts`。
   实际落点是 `packages/executor/src/pause.ts` 与 `apps/daemon/src/control/pause.ts` ——
   本仓库的每个包都用 `src/`，控制操作也一律在 `apps/daemon/src/control/` 下
   （与 `workspaces.ts` / `connections.ts` / `approvals.ts` 同处）。
   这条偏离只关乎文件放哪，不关乎行为。

138. **两条「模式版本」的钉子会随下一次迁移变成假失败**（LWB-034 顺手改掉 —— 不在代码里，在**证据**里）。
   `scripts/evidence/lwb-030.ts` 与 `tests/unit/recovery-persistence.test.ts` 里各有一条断言写的是
   `KNOWN_SCHEMA_VERSION === 7`，而本任务新增迁移 **v8**（`service_pause`）的那一天它们就同时红了 ——
   红的原因与它们要证明的事（「v7 建了那张恢复授权表」）毫无关系。
   判据改成从 `MIGRATIONS` **推导**：「v7 那一版在表里，且名字是 `recovery_authorizations`」
   「表里最后一版等于当前模式版本」。
   一条会随无关改动变红的钉子，最终会被下一次「顺手把数字改大」修掉 ——
   而那正好是它本来的用处被抹掉的那一刻。

140. **`GET /api/status` 不回报机器身份，于是验收标准 1 的「当前哪台机器」在真服务端上永远是「未知」**（LWB-035 发现并修掉 —— **真实缺陷**）。
   这条是**证据脚本自己抓到的**，第一次采集时 `3.2` 是红的：

   ```
   FAIL 3.2 机器身份解析出来了（这是「哪台机器」那一行的来源） — 当前机器：未知（本机服务没有给出机器读数）
   ```

   界面上那一格写的是「当前机器：未知（本机服务没有给出机器读数）」，而它**永远**是这个样子：
   控制台的 `parseMachine` 读 `record['machine']`，而服务端从来没有给过这个字段。这一格最坏的
   地方不是「缺一个字段」，而是它与「这次读取失败了」**长得一模一样** —— 操作者会去重启一个
   没坏的东西，而下一步该做什么完全看不出来。

   界面那一侧无法自救：浏览器知道的是**浏览器所在**的机器（`navigator`），与「本机服务跑在哪台
   机器上」是两个问题 —— 控制台将来可能被从另一台机器上打开。让界面去猜，或者拿浏览器的事实
   冒名顶替，都会得到一个**看起来像结论的错答案**。这与 LWB-035 那一层的全部纪律是同一条：
   「没有读数」与「读到了但值是这样」必须分得开。

   修在服务端：`apps/daemon/src/runtime/assembly.ts` 的状态投影多一格
   `machine: { hostname, os, arch }`（`node:os` 的三件事实，逐字段），并配一条回归测试
   （`tests/windows/daemon-assembly.test.ts`：真兑换 → 真会话 → 真 HTTP GET）。
   回归测试还钉住了**这条事实只走哪一侧**：`Object.hasOwn(runtime.facts, 'machine')` 必须为假 ——
   机器身份走控制平面（本机回环 + 会话 + CSRF），**不进**工具面的状态源。有人把它挪进
   `StartupFacts` 时那条断言会红，而那时该回答的是「模型需不需要知道这台机器叫什么」，
   而不是顺手改断言。

141. **证据脚本把 cookie 的**值**当成了 `Cookie` 头，而服务端按名字找**（LWB-035 发现并修掉 —— **装置缺陷**）。
   `readSessionCookie` 返回的是 cookie 的**值**（它内部已经按名字找过了），把返回值直接塞进
   `Cookie` 请求头，发出去的就是一个**没有名字**的值。服务端的 `readSessionCookie` 在请求里
   找不到 `__Host-lwb_console=`，于是 401 —— 而症状与「会话过期」**一模一样**，
   排查方向会整个跑偏（会去查 TTL、查端口、查 Origin，唯独不会想到是装置少拼了一个名字）。
   修法是用 `CONTROL_COOKIE_NAME` 把名字拼回去，而且用的是 `@lwb/contracts` 里那一份常量，
   不是抄一个字面量 —— 抄一份的代价是两份会各自演化，而服务端与控制台各自写一份字符串常量
   正是 `control.ts` 文件头点名要避免的那件事。

   同一处还有一个更隐蔽的分支：`readSessionCookie` 没找到时返回的是 `undefined`（不是 `null`），
   而第一版写的是 `!== null`，于是 cookie 会被赋成字符串 `"undefined"` —— 同样是 401，
   同样指向错误的方向。

142. **一张会话密钥被当作「名字」打印进了证据**（LWB-035 发现并修掉 —— **装置缺陷**，且这一条是**外发**的）。
   第 141 条修好之后，`2.3` 那一行写的是 `jar.cookie().split('=')[0]` —— 看着像在只回显
   cookie 的**名字**，实际上把整张会话值原样写了出去：值里没有 `=`，所以 `split` 出来的就是全部。
   这一条比上一条严重得多，因为证据会连同它的输出一起提交；而它通过的那道门（`8.1` 的路径遮罩）
   只管本机绝对路径，对凭证形状一无所知。

   修完之后留下的不是一句「下次注意」，而是一道**结构性**防线：末段的自查拿
   `@lwb/contracts` 的 `CONTROL_TOKEN_PATTERN_SOURCE` —— 与 `packages/egress` 筛查模型可见
   内容用的是**同一条规则** —— 对每一行打印出去的字复查一遍。自查规则与真正的出站规则分成两份，
   就会出现「自查说干净、出口漏了」这种最不该出现的组合；这一次它抓到的是真泄漏，
   因此那条自查在代码注释里被明确写成「不是装饰」。

143. **加固顺手设置属主，于是在「只通过组授权」的位置整个失败**（发现并修掉 —— **真实缺陷**，
   与偏离项 96 同一类：判定层的用例全部走替身，机制层一次都没跑过）。
   `SecureStore.ps1` 的 `Op-Harden` 里有一句 `$acl.SetOwner(当前用户)`，
   意图是「顺手确保这个目录属于自己」。它被夹在 `try { } catch { }` 里，
   看上去最多是「这项没设上」。实际不是：**属主是 ACL 的一部分**，
   `SetAccessControl` 会把它和 DACL 一起应用，而**改属主需要目标对象的 WRITE_OWNER**。
   于是当前用户没有 WRITE_OWNER 时，这个调用抛
   `Attempted to perform an unauthorized operation.`，
   而**DACL 那半也一起没写进去**（失败之后回读：DACL 仍是原样）。

   本机实测（Windows 11，非提权，同一份 ACL、同一个探针脚本，只差设不设属主）：

   | 目标                                    | 只写 DACL | 连属主一起写 |
   | ---                                     | ---       | ---          |
   | `D:\...\LocalWebGPT\.lwb-local\...`     | 成功      | **失败：unauthorized operation** |
   | `%TEMP%\lwb-acl-probe-*`                | 成功      | 成功         |
   | `%LOCALAPPDATA%\LocalWorkspaceBridge-*` | 成功      | 成功         |

   差别在授权形状，不在盘：`%TEMP%` 与 `%LOCALAPPDATA%` 的 DACL 里有当前用户自己的
   `FullControl` 规则，而 `D:` 上的项目目录只通过 `Authenticated Users: Modify` 授权 ——
   那条权限里**不含** WRITE_OWNER，而属主只隐含 READ_CONTROL 与 WRITE_DAC、
   **不**隐含 WRITE_OWNER（这正是「属主也改不了属主」的机制）。

   后果不是「少设了一项」：daemon 每次启动都要加固存储根，因此
   `LWB_HOME` / `--home` 指向这样的目录时它**直接起不来**，而报错只说「未经授权的操作」，
   看不出与属主有关 —— 而 `--home` 恰恰是排障时才会用的那个开关。
   它没被早点发现，是因为既有的真机用例都跑在**全新临时目录**上，
   而临时目录恰好是「好客」的那一种形状（与偏离项 96 是同一个盲区）。

   修法有两半。**不设属主**：目录是本程序自己创建的，属主已经是当前用户（回读 `owner_sid` 可核对），
   那次调用本来就多余。而「属主是不是当前用户」这件事本身是**判定**，
   判定留在 Node 侧 —— `packages/secure-store/src/acl.ts` 的 `assessAcl` 新增
   `UNEXPECTED_OWNER` / `UNRESOLVED_OWNER` 两个违规种类：属主对对象有隐含的 WRITE_DAC，
   也就是说他随时能把这份 DACL 改回去、而且改的时候不需要任何权限，
   因此「这份 DACL 只有当前用户能读」对**外人当属主**的对象不成立，必须拒绝启动。
   （`owner_sid` 缺失或解析不出时走的是同一侧的保守拒绝 ——
   缺字段落在「拒绝」上，不是「通过」上。）
   于是这次改动不是「放松了一项检查」，而是把一次做不到的提权尝试
   换成一句能被执行层读懂的判断。

   装置那一侧的补充：新增的真机用例**自己先构造出那个形状**（把目录的 DACL 换成
   只有组的形态），而且**先自检形状真的成立**（断言该目录的 DACL 里
   「属于当前用户的 Allow 规则」为空、属主是当前用户）—— 没有这一步，
   一次静默失败的 `SetAccessControl` 会让这条用例在「和 %TEMP% 一样好客」的目录上照样通过，
   变成一句空话。同时给失败路径的异常补上了**是哪一个目标**失败：
   加固会依次处理根与每个子目录，而原来的异常文本问不出是哪一层。

144. **一条会随时间自己变红的断言：两个字段来自两口钟**（LWB-035 采集时撞出来并改掉 ——
   装置自己的一处修正，与偏离项 129 同因）。
   `tests/unit/changes-prepare.test.ts` 里钉「修改集一出生就带着 24 小时有效期」用的两条断言，
   其中一条是 `Date.parse(created_at) <= Date.parse(expires_at)`。
   这两个字段来自**两口不同的钟**：`expires_at` 由注入的 `now` 算出
   （本文件的锚定值是 2026-09-25T12:00Z），`created_at` 由仓储自己的时钟写下
   （`repositories.ts` 的 `this.clock()`，真机上是真实时间）。
   于是那条断言在 2026-09-26T12:00Z 之前恒真、之后恒假 ——
   LWB-034 那一轮取证时它是绿的，LWB-035 这一轮是它变红，而两轮之间**没有任何代码被改过**。

   要钉的其实是「有效期恰好等于策略里的那一个」：
   `expires_at - NOW === LIMITS.CHANGE_TTL_MS`；而 `created_at` 只要求是可解析的时刻 ——
   它的值属于仓储的时钟，不是这条用例的题目。
   这类钉子的害处不是它红，是它**红在一个与它无关的位置**：
   下一次把数字改大的人会以为自己修好了什么，而断言原本的用处（有效期口径）就此消失。

   **记一条本轮的判断**：这条与偏离项 143 都是「机制层没有被真东西跑过」的不同变体 ——
   143 是**装置够不到**那个形状，144 是**判据依赖了装置外部的一口钟**。
   **顺带记一条本工程此前没有的纪律**：证据脚本会自我检查它打印出去的每一行。
   在 LWB-035 之前，`scripts/evidence/` 里的路径遮罩是逐处手写的（每个脚本各写各的），
   而凭证形状**没有任何一处**被查过。
139. **一个只被断言过 0 的计数器与一个恒为 0 的计数器长得一样**（LWB-034 采集时发现并补上断言 ——
   不在代码里，在**证据**里）。步骤 3 的后半句「记录已返回给 ChatGPT 的内容无法撤回」有它自己的读数
   （`unrecallable_file_rows`），而它在补上之前**只被断言过等于 0**。
   那意味着一个把 `delivered` 读错成常量的实现、甚至一个根本没接上查询的实现，都能让那一格全绿。
   补上的判据是**两行合起来**：先做一次真的把内容交出去的读取（证明这个读数**能不是 0**，
   那里是 5 —— `change_prepare` 的两次读取也算「收不回来」，这个数偏大是对的），
   再断言停用期间**被挡住**的那次读取**没有**被算进去（那次一个字节都没交出去）。
   顺带说明口径：`delivered = 1` 的含义是「已经离开**本进程**」，比「已经到达 ChatGPT」更大 ——
   取大的一侧是刻意的，一个偏小的「收不回来」读数会让人以为漏得没那么多。

145. **一次策略拒绝被报成了「本地服务内部错误」**（LWB-036 采集时发现并修掉 —— 本任务自己的真实缺陷，
   存在于本任务的第一版实现里，因此**没有**进过任何一次提交；记在这里是因为它的失败形态在产品上有后果，
   而这条路径正是本任务新增的）。
   `changes.get?path=…`（LWB-036 新增的控制操作）在第一版里的次序是「取条目 → 读两侧快照 → 算差异 → 判闸门」，
   于是四个开关全关时前两步**照样跑**：`changeDiffPageOf` 的 `blobBytes` 把两份快照**读进进程内存**，
   直到 `mintClearance` 才发现「不允许的动作不能获得出站凭证」—— 而它抛的是**一个裸 `Error`**
   （`packages/egress/src/clearance.ts`），不是 `BridgeError`。两处都不对，而且都不小：

   - **字节已经进过内存**。`changes.ts` 文件头里「硬拒绝在碰快照之前就判一次」那句话对 `hard_deny` 成立，
     但对「判定本身拒绝了」不成立 —— 而后者才是闸门关闭时的实际情形。一次被拒绝的读取不该读任何东西。
   - **错误形状不对**。裸 `Error` 到不了调用方手里那套 `code` / `details` 的契约上，控制平面只能把它兜成
     `INTERNAL_ERROR` / HTTP 500 / 「本地服务内部错误。」—— 于是**工作区被暂停**在界面上显示成**服务器出错了**，
     而这两句话要操作者做的下一步完全不同（一个是去开开关、等暂停解除，一个是去查服务端）。
     500 那条路在别的实现里往往带着未擦洗的异常文本，因此这一句离「把本机绝对路径写进回复」只差一次顺手。

   修法是把判定**提到要内容之前**：`if (path !== undefined && !decision.allow) throw new PolicyDeniedError(decision);`
   紧跟在 `reviewDecision` 之后，并**用策略自己的**错误类型抛出（`PolicyDeniedError` 带 `details.policy_reason`），
   于是这条拒绝与工具面那条**逐字段同形**，界面按 `content_gate.reason` 分档时拿到的是**同一个** slug。
   工具面没有这个问题，因为它在更早的一步就拒了（`resolveWorkspaceAccess()` 的 `requireAllowed` 在处理器被调用
   **之前**抛）；控制台这条路径的判定就发生在同一个处理器内部，因此那句「更早」在这里没有对应的位置 —— 得显式写出来。
   副作用刻意保留：路径根本不在本修改集里、而闸门又关闭时，现在回答的是策略拒绝而不是 `PATH_NOT_IN_CHANGE`
   —— 这是更 fail-closed 的那一侧，而路径清单本来就已经在同一个响应的 `change.files` 里。

   **「一个字节都没读」这条判据在真服务端上量不到**（对象已经在库里，「读没读过」不是一个可观测的输出），
   因此它由单元用例钉住：`tests/unit/control-changes.test.ts` 的 B1b 把对象目录**清空**再问一次 ——
   真读过的实现在那里会拿到 `NOT_FOUND`，而正确实现照旧给策略的那句话
   （与偏离项 143 是同一类手法：把一个不可观测的性质变成一个盘上可观测的差别）。
   证据 §7.1 ~ §7.4 把它当**判据**用，且 §7.4 专门写明「修复之前这里会是什么样」，
   否则这条记录会变成一句只有作者读得懂的注脚 —— 一处修好的缺陷必须留下能被反查的痕迹。

146. **`groupHunks` 的文档注释描述的是一套它没有实现的策略**（LWB-036 采集时发现并改掉 ——
   生产代码的注释，与偏离项 147 同因）。
   `packages/files/src/text-diff.ts` 那句话写的是「输出字节超限时**丢掉装不下的那一条 hunk**，
   而不是把它截成半条 —— 半条 hunk 的行号与行数会对不上」。代码从来不是那么做的：循环**逐行**累加字节，
   越界时停在**行边界**，并把 `old_lines` / `new_lines` 按**实际带上的行**重数，
   只有「一行都放不下」时才连同这一条一起丢。

   两句话给出的是**不同的表头**：注释那句会让读者以为遇到上限时某条 hunk 会整体消失、
   于是它后面那条 hunk 的 `@@` 起点仍然是原来的行号；实际上被截的是**它自己** ——
   表头还在，只是它后面的行少了，而 `@@` 里那两个数**改过了**。
   行为本身是对的（行号仍然是**真的**，被截掉多少由 `truncated` 说出去 —— 那正是 LWB-036 的复核覆盖
   用来判「看全了没有」的读数，`TRUNCATED_DIFF` 让批准入口消失），错的只是这段字；
   但只要有人照着它去读证据里的 `@@`，就会算错，而那个人多半正在核对一次大范围删除。

   改动是**只改注释**（`npx tsc --noEmit` EXIT=0、全部用例照旧），并把「谁在读这个数」写进去。

147. **一条把错误模型写进断言的装置缺陷**（LWB-036 采集时由 `FAIL` 撞出来并改掉）。
   证据 §9.6 的第一版断言是「**紧上限那一份里的每一条差异行，都逐字出现在完整渲染里**」，
   它在 `@@ -1,215 +1,6 @@` 这一行上变红 —— 而**红的是断言**：
   那句话编码的正是偏离项 146 里那个错误模型（以为截断会整条丢 hunk）。真正的性质是两件事，
   改完之后 §9.6 与 §9.6b 分别量它们：

   - 每一条差异行**去掉前缀**之后，都是源文件里真实存在的某一行（截断不会让差异**编造**出行来）；
   - hunk 头里声明的行数**等于**它实际带出来的行数（截断不会让 `@@` 说谎）。

   记下来的理由与偏离项 129 / 144 同：**装置自己错了的时候，绿灯与红灯都不说明被测对象**。
   如果没有 §9.6b，第二件事**没有任何断言覆盖** —— 一个「表头写原计划的行数、内容按实际的给」的实现在旧断言下
   是全绿的，而它会让操作者按错误的行号去核对自己刚批准的东西。

148. **两处会在静默中永远为真的判定**（LWB-036 采集时发现并改掉 —— 装置缺陷）。
   §11 是验收标准 (c) 的递归扫描，其中两条判定各自错在一个「恒真」上：

   - `scanned.filter(async (file) => …)` —— 异步回调返回的是 **Promise**，而 `filter` 只看它**是不是真值**；
     于是「哪些文件命中」这一步**恒返回全部文件**，后面那句「没有命中」自然也就恒真。改成显式的 `for` 循环。
     这类错误的形状很固定：**一个恒真的前置条件会让它后面的每一条断言都失去意义**，而它自己不报错、不告警。
   - 跟踪器形状里的裸词 `sentry`（`/i`）匹配到了 **`SuspiciousEntry`** —— `…ousEntry` 里正好有 `sEntry`。
     改法是按**主机名形状**而不是按词判：`google-analytics\.com|googletagmanager\.com|gtag\s*\(|`
     `doubleclick\.net|hotjar\.com|mixpanel\.com|segment\.(?:io|com)|sentry\.(?:io|com)`。
     同一个扫描里另有一处**判得过严**：`http://127.0.0.1`（不带端口，回环白名单自己就是这么写的）、
     `http://127.0.0.1:<端口>`（给操作者看的模板）与 `http://[::1]`（字符类把 `]` 切掉了）都被当成了「非回环」，
     提取与判定两处都改过（提取时带上完整字符集、判定时按主机边界收尾）。
   - 同一节还有一处**判错了对象**：第一版把「出现了 chatgpt / openai / tunnel 这些词」当成违规，
     而它们在**注释与操作者可见的文案**里本来就该出现（「内容仍会经由隧道发往 ChatGPT —— 只读不等于不出本机。」
     这句话是产物的一部分）。改成判「有没有一个**绝对地址**指向模型侧主机」。

   这三条都**没有被当成「检查通过了」记下来**：它们是装置在证明「界面里没有外部引用」这条结论时**自己先坏掉**，
   而修好之前的绿灯是一句空话。与偏离项 141 / 142 同一条纪律：**证据的每一句话都要先能被证伪**。

## 尚未闭合的门禁

- **2026-09-27 当前网页状态修订：**Chrome 里的现存 ChatGPT 对话显示网页端已读到 workspace-list 元数据；这一项只作部分观察，没有原始 MCP 调用日志，也没有文件内容出站。LWB-002 从早期的 **BLOCKED** 更新为 **PARTIAL**；下方较早的历史证据段若写“账号/隧道缺失”或“LWB-002 BLOCKED”，表示当时的状态，不覆盖本条更新。
- **G0 未通过**（`docs/adr/003-protocol-and-trust.md` §5.2）：路径/写入保护有本机实测，网页工具发现与工作区元数据有部分观察；真实网页文件内容读取、测试目录的批准写入与回读、断连重连及身份边界证明仍未完成/签署，兼容性也未全部锁定。按任务书要求，**G0 通过前不得进入真实目录开发联调**。
- **G1 没有判定记录。** 「越界、错身份和伪批准被拒绝」这条门禁在本仓库的任何一处
  都**没有**写过过没过。P1 的八项任务里七项 DONE，相关证据散在
  `docs/evidence/lwb-009` ~ `lwb-012`，但从未汇总成一次 G1 判定 ——
  与 G0 并列记在这里，免得它随着 P3 开始而没人认领。
- **G2 未通过**（判定见 `docs/evidence/g2-read.md`）：门禁原文是「真实网页读取
  **且**内容出站可追踪」。后一半已由 LWB-018 在真实护栏 + 真实 NTFS 上证得，
  前一半中的 workspace-list 元数据有浏览器观察，但**真实网页读取文件内容及出站审计对照仍是 NOT_RUN**。
  **不得**把这半条通过读成「可以放开一半」。
- **G3 未通过**（判定见 `docs/evidence/g3-proposal.md`）：门禁原文是「批准前工作区
  字节零变化」。它**与 G2 的形状不同** —— 原文里没有「真实网页」四个字，
  因此这一条**已经在本机用真实字节证得**（LWB-020 三条独立证据 + LWB-025 四条，
  含运行期护栏的写方法调用为 0）。判它未通过的是另外三条：任务书对同一件事的
  步骤 3 要求**真实网页测试**（NOT_RUN，LWB-002 BLOCKED）；
  这条门禁**缺少它的对照项**（今天工作区不变是因为**还没有写入方**，
  而不是因为提议路径守住了 —— 「一条零变化断言的强度取决于本来会不会变」）。
  LWB-027 交付后这一条**仍然缺着**，理由又精确了一层：写盘人**已经是真的**了
  （`native-adapter.ts` 在真 NTFS 上通过 `CreateFileW`/`FlushFileBuffers` 写、并独立回读核对），
  但**仍然没有接入工具面** —— `change_apply` 仍是 `IMPLEMENTED_TOOL_NAMES` 之外的名字。
  LWB-028 把创建也交付之后（`vetCreate` + `Op-CreateFileGuarded`，同样在真 NTFS 上取证），
  这一条的措辞**一个字都不用改**，因为缺的东西是同一件：能改字节的两条路
  （改写、创建）**都没有任何从模型出发的入口**。
  LWB-029 把逐条目执行日志与折叠交付之后（`journal.ts` + `apply.ts`，
  四条步骤都在真 NTFS + 真 SQLite 装置上成立），这句措辞**还是一个字都不用改**；
  但要说清楚它让什么变了：今天已经能**逐条目**读出「这次执行在每个文件上停在哪一格」，
  于是这条门禁的对照项**第一次有了可被取证的对象**（`readItemEvents` 的返回值），
  而它仍然没有被构造，因为构造它需要一次真的经由工具面发起的应用。
  因此「批准之后确实会变」这件事**今天具备构造条件的部分又多了一块，却仍没有构造**；
  LWB-030 把恢复交付之后（`packages/recovery/` 判定·折叠·编排 + `docs/recovery-playbook.md`，
  四条步骤与三条验收标准都在真 NTFS + 真 SQLite 上成立），这句措辞**依然一个字都不用改** ——
  它交付的是「执行之后账怎么收场」，与「批准之前工作区会不会变」是两件事。
  要说清楚的只有一处**方向性的变化**：定案成 `APPLIED` / `ROLLED_BACK` 时它会去解除那块地的写阻断，
  于是「一次被阻断的工作区」第一次有了非人工的出路；但触发它的仍然只有本机恢复流程，
  模型侧够不到（`authorize` / `repair` / `records` 都不在工具面里，由
  `tests/unit/recovery-boundary.test.ts` 静态钉住），因此**对照项仍然只等 LWB-032**（接线），不再等 LWB-027 或 LWB-028。
  上游 G0/G1/G2 悬着且无人签署。另一种读法（「原文只谈字节，故本机证得即可判过」）
  被**如实记录**在 `g3-proposal.md` §1.1，没有静默丢掉。
  **LWB-032 把 `change_apply` 接进工具面之后（2026-09-26），这一条第一次需要改措辞**：
  上面那条「缺少对照项」的理由**不再成立**。对照项已经存在，而且是可复算的 ——
  `docs/evidence/lwb-032/summary.md` 的 §2.9 / §3.11 / §8.8 三次从**工具面**发起真实应用，
  每次都在真 NTFS 上量到字节变化，且回执里的两个哈希等于脚本**独立读回**的盘上字节；
  反方向也齐了：没有本地批准时连一个字节都不写（§2.2 ~ §2.5，含「护栏写入调用为 0」）。
  因此「今天工作区不变是因为**还没有写入方**」这半句作废：写入方已经在了，
  而它只在**绑定了修改集摘要的一次性本地批准**存在时才动手。
  G3 仍然**未通过**，但剩下的理由收敛到两条：门禁原文要求的**真实网页**那一步仍是 NOT_RUN
  （依赖 BLOCKED 的 LWB-002），以及上游 G0/G1/G2 悬着且无人签署。
  **不得**把「对照项终于有了」读成「这条门禁快过了」—— 它改的是理由，不是判定。
- **G4 未通过**（判定见 `docs/evidence/g4-write.md`）：门禁原文是「竞争与故障测试通过」。
  它**已经在本机用真实字节证得一部分**：`tests/windows/concurrency/` 17 例（并行保存、同内容换身份、
  目录交换、目标创建竞争，加上分成两格的占用与权限）与 `tests/fault-injection/` 22 例
  （原生辅助进程退出与真短写、真 `SIGKILL` 一个真执行者再跑真启动恢复、数据库忙、
  结构性地证明断网没有故障面）都在真 NTFS + 真护栏 + 真 SQLite 文件库上成立，
  每一格带对照组，且全部取证都在 `os.tmpdir()` 下、真实工作区一个字节都没被碰（`lwb-033/summary.md`）。
  判它未通过的是三条：门禁原文覆盖的 P4 范围是 **026–034**，而 **LWB-034 尚未交付**
  （因此这份证据是**已知会过期**的）；两个故障面（磁盘满、刷盘错误）本机造不出、如实记 `NOT_RUN`；
  上游 G0/G1/G2/G3 悬着且**无人签署**。
  要说清楚它改了什么：`direct_write_enabled` 现在多一个与项 `g4_concurrency_fault_passed`，
  于是「G4 不过则直写永远不对真实目录启用」写在**推导**里而不靠记性（16 格穷举见
  `tests/unit/gate-combinations.test.ts`）。**不得**把「四格已取证」读成「这条门禁快过了」。
- **验收负责人未指定**（`docs/adr/001-scope.md` §6）。G0 与 G1 今天的状态正是
  「没有任何人被指定来判断它们过没过」的后果；G2 的判定因此也只是证据陈述，
  不是一次被授权的签署。
- **操作者于 2026-09-26 口头告知：已有可用的真实 GPT 账号，本机 Chrome 已登录。**
  这**只是前提的变化，不构成任何一条门禁的证据** —— 真实网页验收仍未执行。
- **LWB-002 的隧道侧已按官方说明走完能走的每一步**（登记在 `docs/evidence/platform-capability.md`，
  逐条给出官方命令原文与退出码，**没有一条是猜的**）：官方文档与 release 元数据用 `curl` 取回
  （`WebFetch` 对 `developers.openai.com` / `platform.openai.com` 报域名安全校验失败，
  这是工具侧的限制，不是网络不通）；`tunnel-client` **v0.0.15** 已下载、**按 `SHA256SUMS.txt` 校验通过**
  （`3b53133a…bddc1`）、解压、就地运行；`--version` 回 `0.0.15+a390c168ff1b2d14e73a95991c186c6aba3ff5a0`；
  `help quickstart` / `profiles samples show` / `init` / `profiles list` 均可运行；
  `doctor --explain` 除 `control_plane_api_key` 外**全部 PASS**。
  **仍未做的、且本机做不了的三件事**（必须由操作者在 Platform 上完成）：
  创建 tunnel、创建 runtime key 并授予 **Tunnels Read + Use**、在 ChatGPT 侧开启 developer mode
  并把该 tunnel 关联到工作区。LWB-002 的状态因此仍是 **BLOCKED**，但阻塞点已经从
  「不知道怎么装」收窄成「两个只有账号持有者能创建的凭据」。
  任何凭证**不得**写入证据、日志或诊断输出 —— 配置文件里放的是
  `api_key: "env:CONTROL_PLANE_API_KEY"` 这样的**环境变量引用**，密钥本身不落盘。
- **执行器这一侧的五样东西都已存在，但没有任何一条工具路径能让模型碰它们**
  （LWB-026 / LWB-027 / LWB-028 / LWB-029 / LWB-030 交付，2026-09-26）。
  LWB-026 的三条验收标准（同一工作区不并发应用两个修改集 / 不同连接共享物理约束 /
  旧执行器未退出时不因心跳超时启动新写执行器）在**两个真实 OS 进程 + 真 SQLite 磁盘文件 +
  真进程探针**上成立（`docs/evidence/lwb-026/summary.md`）；LWB-027 的三条
  （冲突不落半个字节 / 写入期间普通竞争保存被共享模式挡住 / 回读哈希等于已批准的新哈希）
  在**真 NTFS + 真 Win32 句柄 + 真护栏助手**上成立（`docs/evidence/lwb-027/summary.md`）；
  LWB-028 的三条（三种占位形态与一次真竞争窗口都不覆盖 / 缺父目录不隐式 `mkdir` /
  ACL 与属性逐项等于普通方式建的同目录文件）在**同一套真 NTFS 装置**上成立
  （`docs/evidence/lwb-028/summary.md`）。
  LWB-029 的四条（全部旧/新快照在任何字节落盘之前就已持久化 / 逐文件记录意图·
  观察身份·已写·已刷盘·已验证 / 普通失败在仍持有安全句柄时有界恢复、
  收不回则进 `RECOVERY_REQUIRED` / 回执逐文件记实际状态且不把部分完成当全成功）
  在**真 NTFS + 真 SQLite + 真多进程**上成立，故障注入覆盖了每个日志边界
  以及第一、中间、最后一个文件（`docs/evidence/lwb-029/summary.md`）。
  LWB-030 的四条步骤（**启动时先处理未终结操作再开放写能力** / 在受控句柄下比较当前身份与
  哈希、分成未变·目标已达·第三种内容·身份不明四格 / **只有可证明安全的状态协调才自动完成**、
  第三种内容保留原样要求人工 / 恢复写入需要**本地恢复授权**，且**禁用连接不妨碍操作者查看
  恢复记录**）在**真 NTFS + 真 SQLite + 真护栏**上成立，三条验收标准逐条对上：
  (a) 写得完、应答丢 ⇒ 收敛为实际已达的状态且不重复修改；
  (b) 用户在崩溃后继续编辑 ⇒ 不被自动恢复覆盖（`repair` 连授权都签不出来）；
  (c) 数据库/快照不完整时默认暂停，**坏掉的库拒绝打开且一个字节都没被改写**
  （`docs/evidence/lwb-030/summary.md`）。
  但要说清楚它们**都不是**「写盘已经可用」：`change_apply` 仍是 `IMPLEMENTED_TOOL_NAMES`
  之外的名字（接线属 LWB-032），**创建也没有入口** —— `create_text` 从「按设计被拒」
  变成了「能建，但同样没有一条从模型出发的路径能走到它」，
  而 LWB-029 交付的日志与折叠、LWB-030 交付的恢复**同样没有出口**：
  「这次执行在每个文件上停在哪一格」已经可查、「上一个进程留下的现场」已经能定案，
  但**没有一条工具路径能读到它们，也没有一条工具路径能触发它们**；
  模型侧够不到这条路径这件事由 `tests/unit/recovery-boundary.test.ts` 静态钉住，
  并在真仓库文件上复算过。四个能力开关照旧全关。
  **LWB-032 交付后（2026-09-26），这一段的措辞第一次需要改**：`change_apply` **不再是**
  `IMPLEMENTED_TOOL_NAMES` 之外的名字 —— 契约里的 12 个工具**全部**有了实现与输出契约。
  于是「没有任何一条工具路径能让模型碰它们」这句话现在**只对一半成立**：
  协调器、原生应用器、逐条目日志、启动恢复都经由 `change_apply` 这一条路被模型够到了
  （工具面调的就是 `applyChange`，而那是协调器的唯一入口），
  但**模型仍然不能自己批准**：唯一的批准来源是 `approvals` 表里那条绑定摘要的一次性记录（I06），
  而模型侧的 `approved` / `user_id` 连输入 schema 都过不去
  （`docs/evidence/lwb-032/summary.md` §2.7，`INPUT_SCHEMA_VIOLATION`）。
  四个能力开关**照旧全关**：门禁没通过，工具面因此仍然一律 `POLICY_DENIED`；
  写入路径另有 `direct_write_enabled` 单独把着，关掉它时**真正的写入被拒**
  而**已经应用过的那条仍答得出回执**（重放按读面判定，§7.2 / §7.5）——
  这两件事是分开的，且读开关一关回执也一起关（§7.11），回执不是绕开开关的口子。
- **被阻断的工作区在 V1 里仍然无法在界面内解除阻断**（LWB-026 采集时发现，见偏离项 101）。
  方向是 fail-closed（字节下落没定案就不许换人写），但它意味着**一次真实的「持有者死在写盘途中」
  会让那块工作区停在那里**。LWB-030 交付后**第一条出路有了**：启动扫描把现场定案成
  `APPLIED` / `ROLLED_BACK` 时会解除那块地的写阻断（见偏离项 101 里追加的那一段）。
  但这**不等于**「已经能在界面里恢复」—— 触发它的仍然只有本机的恢复流程，
  而模型侧够不到，接线属 LWB-032。这不是本轮引入的缺陷，也不该被读成「已经能恢复」。

## 2026-09-27 本轮继续：GitHub push protection 与秘密扫描

- GitHub Push Protection 拒绝了首次 `main` squash push：当前源码中的三个测试/证据样例包含 Slack token 形状字面量。未使用 GitHub 的绕过链接；改为运行时拼装合成 canary，保留 egress 脱敏覆盖但不把完整 token 外形存入源码。
- 本地秘密扫描器新增 Slack API token 形状检测。生成目录 `tests/fixtures/generated` 只有在 Git 明确忽略且其中没有已跟踪文件时才跳过；一旦强制跟踪，扫描器仍检查其中内容。
- 验证：`npm run check:secrets` PASS；秘密扫描与 egress 定向测试 **56/56 PASS**；完整 `npm run check` 主测试 **1762 项 / 1749 PASS / 0 FAIL / 13 SKIP**，控制台 **164/164 PASS**。
- 修复后的源码快照已通过完整本机检查并以 squash 单提交推送至远端 `main`（`0361cad`）。没有使用 GitHub 放行例外；旧功能分支及其中的历史密钥提交均未推送。若该历史凭据仍有效，账号持有人仍应撤销/轮换，且不要直接推送旧分支。
