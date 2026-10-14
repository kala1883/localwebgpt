# 会话执行档案与本地会话管理

## 本轮交付边界

主项目接线与前后端源码已准备为 source-only 修改。不会停止、重启或重新装载正在运行的 daemon，不会打开或升级生产数据库，不覆盖当前控制台 dist 资源。只有用户随后正常重启，运行实例才会加载此功能。测试与真实 ChatGPT 链路验收在重启后进行；静态检查不等于这些验收通过。

代码契约版本：0.3.0；会话管理功能版本：1.0.0；新增迁移 v10、v11（已有 v1–v9 语义保持不变）。v10 保存执行归档；v11 保存会话管理元数据、保留设置、管理审计和工具调用的工作区关联。生产启动使用现有 backupDatabaseBeforeMigration → openDatabase 迁移顺序。

## 主项目模块

- packages/contracts/src/conversation-archive.ts：从客户端 `_meta["openai/session"]` 读取关联提示，并校验内部调用封套。
- packages/persistence/src/conversation-archive.ts：会话、请求、任务、输出和不可变事件仓储。
- packages/persistence/src/conversation-management.ts：筛选、分页、详情、重命名、标签、备注、置顶、收起、内容清理、导出、保留设置。
- apps/daemon/src/tools/conversation-archive.ts：自动包装原有工具处理器；不改变原工具鉴权；异步上下文隔离不同调用。
- apps/daemon/src/control/conversation-management.ts：仅本地控制台可达的固定 HTTP 路由，模型工具目录不暴露这些接口。
- apps/console/src/conversations/client.ts 与 apps/console/views/ConversationsView.vue：类型化前端请求和实际管理页面，已接入主导航。

## 页面能力

会话列表可按名称、编号、备注、工具名、精确标签、连接、工作区、任务状态、置顶和是否收起来筛选，使用有界分页。工作区字段来自工具请求和任务记录，仅用于归档关联，绝不当作授权依据。会话详情包含工具调用、命令任务、状态/输出时间线、本地管理记录。

可以修改本地标题、标签和备注，置顶会话，以及从默认列表收起/恢复。收起不停止记录新调用，不释放命令名额。元数据写操作带 revision 并发检查，另一个操作先更新后会拒绝旧版本覆盖。

任务页支持请求取消运行中的命令，仍由现有任务管理器执行；CANCELLING 不是终止证明，未知任务引导到恢复页面。没有新增按 PID 强杀或清空计数接口。

输出/请求内容以转义后的纯文本显示，不作为 HTML 或指令执行。隐藏、脱敏、截断和未采集状态保留。页面注销后清空内容，迟到网络响应不能恢复已清除的页面。可选 10 秒刷新，不覆盖尚未保存的编辑。

JSONL 导出为“启动时的会话头 + 此时事件高水位之前的不可变事件”，不声称可变元数据或任务摘要跨页冻结。导出按页读取，30 分钟签名游标绑定本次运行实例；内容被清理时中止导出。浏览器最多累计 32 MiB，超过则失败而非下载不完整文件；更大数据可用只读 CLI 在单个 SQLite 读快照下导出。

## 清理和保留

默认保留天数为 30，自动清理默认关闭，由本地操作者明确开启。自动清理在启动及后续工具请求中最多每小时尝试一个有界批次。每批最多 50 个会话，包含下一批提示。

清理仅删除 lwb_archive_events 内容，保留会话标识、元数据、调用摘要、任务关联和独立管理审计。原执行任务、幂等记录、业务文件、隔离名额均不受影响。置顶、未返回/被中断调用、运行中、终止未知或未来未知任务状态阻止清理。预览摘要绑定最新事件、元数据修订及状态，操作期间有变化会拒绝清理。手动单会话清理需要复选确认、完整会话编号、CSRF 和一次性 nonce。保留策略的批量清理也要求预览和确认。

内容容量和行数分别有界，清理内容不会释放调用/会话元数据行数。达到归档容量后，新写入工具可能被拒绝；诊断、读取及取消保留可用性，并明确归档不完整。当前没有无限原始日志存储承诺。

旧 CLI 的整组 prune 已停用，避免绕过管理页面的置顶与保留语义；CLI 现在只读/导出。历史内容不能反向还原原网页会话。

## API（均要求本地认证会话；POST 均按现有服务器要求校验 CSRF）

GET /api/conversations/status

POST /api/conversations/list、get、items、clear-preview、retention-preview、export-start、export-page

POST /api/conversations/update、settings、clear、retention-apply、cancel-job：另外标记为 mutating，强制现有一次性 nonce 与目标 subject 绑定。

所有 SQL 表/列是固定集合，用户值使用绑定参数；分页与导出游标使用每实例签名，不能当作鉴权凭证。配置中的关联密钥、原始外部会话 ID 和凭证不返回前端。会话名称是本地标签，不修改 ChatGPT 网页标题。

## 用户重启后的验收

1. 用户正常停止并启动 LocalWebGPT；使用现有启动流程创建迁移前数据库备份并升级到 schema 11。若迁移失败，不应跳过校验或删除状态库。生产数据库备份恢复不能用源码回退代替。
2. bridge_status 应显示 contract_version=0.3.0，并包含 conversation_archive 的功能版本和 schema_version=11；刷新控制台后出现“会话档案”入口。本轮静态构建输出不替换线上 dist，正常启动仍走原来的控制台构建流程。
3. 运行 `node scripts/verify-conversation-management.mjs --after-user-restart`。它不停止服务，不打开生产数据库；单元/集成测试在测试数据库和夹具中执行。现有 workspace-picker 的导入边界违规必须单独确认，不能被当作通过。
4. 两个真实网页聊天交替调用同一已授权文件读取工具；在页面查看是否形成两个 client_meta 会话、同一聊天后续请求是否仍归原会话。重连后再次验证。模拟会话单元测试不替代此验收。
5. 发起一条无业务副作用的短命令，核对请求、命令、受限输出和状态事件；验证同键重试不重跑、不重新归属。核对本地名称/标签、分页、导出、撤销会话状态和过期鉴权。
6. 清理仅针对专门的测试会话，核对拒绝清理活跃/未知任务、陈旧 revision/预览摘要失败、不触碰执行和幂等记录。

静态检查单独运行：`node scripts/verify-conversation-management.mjs --static`。仅根/前端类型检查和输出到独立临时目录的 UI 构建，不执行数据库迁移或运行测试。

官方字段依据：OpenAI Plugins Reference，Client-provided _meta，https://developers.openai.com/plugins/reference（2026-10-14 核查）。实际 tunnel 是否提供此字段仍须实测；缺失保持未归属，不用连接 ID 冒充聊天 ID。普通 MCP 调用不是聊天全文订阅。
