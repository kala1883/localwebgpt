# LocalWebGPT V1 验收记录

状态：**PARTIAL — 可供受控的本机私有开发测试；未完成真实 ChatGPT 网页端到端验收、非实现者安全审查或公开分发准备。**

日期：2026-09-28。此记录只汇总已采集证据，不把 TODO、模拟状态或本地自动化测试说成网页登录 PASS。

## 当前授权模型

- ChatGPT 连接启用后只发现 MCP 工具；它不会自动获得文件系统权限。
- 用户在本机 Console 对一个明确登记的工作区逐项授予读取、搜索、Git 只读、文件修改能力。
- 授予文件修改后，单文件 `file_create` / `file_edit` 一次工具调用内直接写入；多文件使用 `change_prepare` → `change_apply`。不要求每次操作再本地点击批准。
- 必要边界仍然有效：工作区外路径、被策略拒绝的秘密文件、Shell、删除、Git commit/push 不会通过 MCP 暴露；写入有冲突检查、快照、审计、回读与暂停恢复。

因此，这次简化的是重复的全局/逐文件批准流程，不是把 ChatGPT 变成不受范围限制的本地账户。每个工作区 grant 仍是清楚、可撤销的授权。

## 证据矩阵

| 验收面 | 状态 | 证据/缺口 |
| --- | --- | --- |
| 类型、Console、单元、安全和 Windows 自动化 | PASS | `npm run check`：根测试 1,787 项 / **1,774 PASS、13 SKIP、0 FAIL**；Console **159/159 PASS**；根/Console 类型、216 文件 FsGuard 导入扫描与 secret scan 全通过。性能 soak/睡眠唤醒等长时环境项不包含在这项 PASS 中。 |
| Tunnel 本机健康/就绪 | PASS（本机采样） | 本机 `127.0.0.1:8080/healthz` 与 `/readyz` 返回 HTTP 200。只能证明运行中的 tunnel-client 就绪，不等于 ChatGPT 调用成功。 |
| LocalWebGPT 控制面会话保护 | PASS（本机采样） | 无会话访问 `/api/status` 返回 401，符合需本机 Console 会话的保护行为。 |
| LWB-043 受控目标场景 | PASS（受控副本） | `npm run acceptance:lwb043`：真实 NTFS + handler；单文件编辑/创建直接 `APPLIED`，随后 MCP `file_read` 回读 SHA-256 与独立磁盘哈希一致；外部 canary、Git index、HEAD 与源副本不变。详见 [`../evidence/user-journeys.md`](../evidence/user-journeys.md)。 |
| ChatGPT 网页 MCP discovery、读取和写入回读 | NOT_RUN | 当前没有从真实 ChatGPT 会话采集完整工具序列、回执与回读证据。请依照 [`../operator-runbook.md`](../operator-runbook.md) §6 执行。 |
| 独立安全审查 | NOT_RUN | `docs/evidence/security-review.md` 是实现者自查与自动回归，不是非实现者签署。 |
| LWB-038 长时间配额/磁盘压力、LWB-039 睡眠唤醒、LWB-044 soak/冷缓存 | PARTIAL | 已有有界配额、模拟/定向 Windows 与基准证据；小时级 soak、睡眠唤醒和真冷缓存未跑。 |
| Windows 安装、自动升级/卸载、代码签名 | PARTIAL | 可构建固定路径 runtime；迁移前快照和手工保留状态卸载已记录；没有签名安装器或自动卸载器。 |
| 公开插件分发 | OUT OF SCOPE | Secure MCP Tunnel 支持私有开发连接；公开插件需要稳定公网 HTTPS MCP endpoint 与单独提审，Tunnel 不满足公开分发要求。 |

## 操作入口

- 本机配置、安装/升级/卸载：[`../install-and-upgrade.md`](../install-and-upgrade.md)
- 构建、启动、Tunnel/App 设置、目录 grant、网页验收、424 排查、停止与恢复：[`../operator-runbook.md`](../operator-runbook.md)
- 中英文项目简介：[`../../README.md`](../../README.md) 与 [`../../README.en.md`](../../README.en.md)
- 实现者安全审查证据：[`../evidence/security-review.md`](../evidence/security-review.md)
- 性能与配额证据：[`../evidence/performance.md`](../evidence/performance.md)、[`../evidence/lwb-038-quota.md`](../evidence/lwb-038-quota.md)

## 发布判断

可以按操作手册在专用测试工作区进行个人/私有 Developer mode 测试；工作区授权范围内的写入是直接写入。不要把该判断解释成已经完成网页端验收、独立安全认证、签名安装或公开发布。真实网页验收与外部审查结果补齐后，再更新本记录和 LWB-046 状态。
