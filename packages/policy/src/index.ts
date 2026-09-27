/**
 * @lwb/policy —— 策略判定。
 *
 * 本包是**纯逻辑**：不读磁盘、不读时钟、不写状态、不 import `fs`。
 * 这一约束由 `scripts/check-fsguard-imports.mjs` 静态检查保证
 * （`packages/policy/` 在业务前缀清单内）。
 *
 * 它只做两件事：
 *  1. 「这个动作允不允许」——连接、工作区、代次与文件规则四项检查（`decide.ts`）。
 *  2. 「哪些路径禁止、哪些只是不搜」——硬拒绝与搜索排除**分开存储**（`rules.ts`）。
 *
 * 它**不**做的事，同样重要：
 *  - 不看文件内容。秘密筛查需要字节，属于出站层（`@lwb/egress`）。
 *  - 不判断路径安全。别名、重解析点、大小写、8.3 短名属于护栏（`@lwb/winfs`）。
 *  - 不碰审批或执行状态库。写入权限来自本地控制台配置的工作区 grant。
 *
 * 每次把一件事推给别的层，都是在让判断发生在**拥有判断所需信息的那一层**。
 */

export * from './rules.ts';
export * from './operator-overrides.ts';
export * from './decide.ts';
