# LocalWebGPT V1 验收记录

状态：**PARTIAL — 可供受控的本机私有开发测试；真实 ChatGPT 网页端已完成部分工具验收，但删除清理、搜索覆盖、错误矩阵、非实现者安全审查与公开分发准备仍未完成。**

日期：2026-09-28。此记录只汇总已采集证据，不把 TODO、模拟状态或本地自动化测试说成网页登录 PASS。

## 当前授权模型

- ChatGPT 连接启用后只发现 MCP 工具；它不会自动获得文件系统权限。
- 用户在本机 Console 对一个明确登记的工作区逐项授予读取、搜索、Git 只读、文件修改能力。
- 本地操作者可以把固定 NTFS 卷根（如 `C:\`）登记为一个工作区；这是显式整卷授权，覆盖该卷内窄根 grant，不会在安装/启动时自动发生。
- 授予文件修改后，单文件 `file_create` / `file_edit` / `file_delete` 一次工具调用内直接执行；删除在本机同次调用中读取并保存快照（16 MiB 上限）。多文件使用 `change_prepare` → `change_apply`。不要求每次操作再本地点击批准。
- 必要边界仍然有效：未授权卷、被策略拒绝的秘密文件与 `LocalWorkspaceBridge` 私有状态树、Shell、Git commit/push 不会通过 MCP 暴露；改写/创建/删除都受路径、身份与版本检查、快照、审计、回读及暂停恢复约束。

因此，这次简化的是重复的全局/逐文件批准流程，不是把 ChatGPT 变成不受范围限制的本地账户。每个工作区 grant 仍是清楚、可撤销的授权。

## 证据矩阵

| 验收面 | 状态 | 证据/缺口 |
| --- | --- | --- |
| 类型、Console、单元、安全和 Windows 自动化 | PASS | 最新 `npm run check`：根测试 1,839 项 / **1,824 PASS、15 SKIP、0 FAIL**；Console **168/168 PASS**；根/Console 类型检查、219 文件 FsGuard 导入扫描与 secret scan 全通过。opt-in LWB-044 单机基准另行 **1/1 PASS**；小时级 soak、睡眠唤醒等长时环境项仍未验收。 |
| Tunnel 本机健康/就绪 | PASS（本机采样） | 本机 `127.0.0.1:8080/healthz` 与 `/readyz` 返回 HTTP 200。只能证明运行中的 tunnel-client 就绪，不等于 ChatGPT 调用成功。 |
| LocalWebGPT 控制面会话保护 | PASS（本机采样） | 无会话访问 `/api/status` 返回 401，符合需本机 Console 会话的保护行为。 |
| LWB-043 受控目标场景 | PASS（受控副本） | 最新 `npm run acceptance:lwb043`：真实 NTFS + handler；单文件编辑/创建直接 `APPLIED`，随后 MCP `file_read` 回读哈希与回执一致；外部 canary、Git index、HEAD 与源副本不变。仅四个样例文件复制到临时仓库。详见 [`../evidence/user-journeys.md`](../evidence/user-journeys.md)。 |
| 单文件删除与恢复 | PASS（真 NTFS） | `file_delete` 无需先 `file_read`，文本/二进制路径均直接删除并返回核验回执；二进制差异只回 metadata。删除日志前崩溃会按缺失目标收敛，混合态可经本地恢复授权从快照 `CREATE_NEW` 还原；对可精确重建的已删除 UTF-8 文本，`change_revert_prepare` 会生成 `create_text` 逆提案并经真 NTFS 验证 BOM/CRLF 字节恢复。删除二进制、混合换行及超 2 MiB 文本暂不自动逆向重建。 |
| LWB-037 本地快照导出 | PARTIAL | 控制面与恢复页已接通受保护 BlobStore → 本机目录选择器 → 长度/SHA-256 校验 → 浏览器端随机新文件名。自动化覆盖 original/proposed 版本、已有同名 canary 保持不变、命名碰撞与创建竞争、取消及哈希错误；不再使用会清空已选既有文件的 `showSaveFilePicker`。真实浏览器目录选择和磁盘回读尚未运行；使用 `npm run acceptance:lwb037-export`，需先确保单用户 daemon IPC 可用。 |
| ChatGPT 网页 MCP discovery、读取、写入、搜索与命令 | PARTIAL | Manage 页 `Refresh tools` 后，Temporary Chat 中真实调用 `workspace_list`、`file_create` → 磁盘 `file_read` → `file_edit` → 再次 `file_read`；写入均 `APPLIED`、`VERIFIED`，哈希与回读一致。26 秒 PowerShell `command_exec` smoke 实测 28,601 ms、exit 0、`timed_out=false`，详见 [`../evidence/lwb-command-no-hard-timeout.md`](../evidence/lwb-command-no-hard-timeout.md)。专用验收文件仍等待用户确认删除。最新源码服务重启后，全根搜索按 3 秒预算返回 `deadline_exceeded=true`、`scope.complete=false` 的部分结果，而非 IPC 超时或伪称无命中；精确文件 glob 搜索找到了唯一标记，但 scope 仍不完整。冲突、拒绝、断连/重连、删除/恢复等真实网页场景仍未验收。详见 [`../evidence/platform-capability.md`](../evidence/platform-capability.md) §§12–13 与 [`../evidence/lwb-015-search-deadline.md`](../evidence/lwb-015-search-deadline.md)。 |
| 独立安全审查 | PARTIAL | 2026-09-29 已有非实现者只读源码复核并记录五项发现；文件导出截断与 `file:///` 输出泄露已修复，校验 sidecar 信任、卸载 reparse 竞态、named-pipe DACL/peer PID 与多文件回滚仍待解决/复核。无安全签署或发布授权；详见 [`../evidence/security-review.md`](../evidence/security-review.md)。 |
| LWB-038 长时间配额/磁盘压力、LWB-039 睡眠唤醒、LWB-044 soak/冷缓存 | PARTIAL | 已有有界配额、模拟/定向 Windows 与基准证据；小时级 soak、睡眠唤醒和真冷缓存未跑。 |
| 锁定依赖漏洞审计 | PASS（本次审计） | 2026-09-29 对当前锁文件运行 `npm audit --omit=dev --registry=https://registry.npmjs.org --audit-level=high` 与全依赖 `npm audit --registry=https://registry.npmjs.org --audit-level=high`，均为 **0 vulnerabilities**。默认 npmmirror 的 audit endpoint 返回 404 / `NOT_IMPLEMENTED`，故显式使用 npm 官方 registry；该结果只代表审计时 advisory 数据库中的依赖公告，不替代源码审查或独立安全审查。 |
| Windows 安装、自动升级/卸载、代码签名 | PARTIAL | 已在本机从干净提交 `4888420` 构建 Windows x64 runtime，生成 303 包 SPDX 与 9,894-file payload 指纹；`.env` 未打包。没有签名安装器、自动升级/卸载器或独立供应链签署；完整生成信息见 [`build-record.md`](build-record.md)。 |
| 公开插件分发 | OUT OF SCOPE | Secure MCP Tunnel 支持私有开发连接；公开插件需要稳定公网 HTTPS MCP endpoint 与单独提审，Tunnel 不满足公开分发要求。 |

## 操作入口

- 本机配置、安装/升级/卸载：[`../install-and-upgrade.md`](../install-and-upgrade.md)
- 构建、启动、Tunnel/App 设置、目录 grant、网页验收、424 排查、停止与恢复：[`../operator-runbook.md`](../operator-runbook.md)
- 中英文项目简介：[`../../README.md`](../../README.md) 与 [`../../README.en.md`](../../README.en.md)
- 实现者安全审查证据：[`../evidence/security-review.md`](../evidence/security-review.md)
- 性能与配额证据：[`../evidence/performance.md`](../evidence/performance.md)、[`../evidence/lwb-038-quota.md`](../evidence/lwb-038-quota.md)

## 发布判断

可以按操作手册在专用测试工作区进行个人/私有 Developer mode 测试；工作区授权范围内的写入是直接写入。当前真实网页证据只覆盖已列明的单文件场景，不代表完整网页验收、独立安全认证、签名安装或公开发布。剩余验收及外部审查结果补齐后，再更新本记录和 LWB-046 状态。
