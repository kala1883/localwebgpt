/**
 * @lwb/egress —— 出站闸门：内容离开本机的唯一通道。
 *
 * 三个文件，三件事：
 *
 *  - `clearance.ts` —— 凭证与闸门。所有出站面共用它；
 *    路径在这里被**重新判定**，秘密在这里被筛查，预算在这里记账。
 *  - `secrets.ts` —— 两档秘密检测与脱敏。**它的能力边界写在自己的文件头里**，
 *    不要把它读成"能识别秘密"。
 *  - `budget.ts` —— 每连接每小时的滑动窗口字节预算。
 *
 * 本包不读磁盘、不写状态，但**可以**用 `node:crypto`（算内容摘要）。
 * 它同样在 `scripts/check-fsguard-imports.mjs` 的业务前缀清单内。
 */

export * from './secrets.ts';
export * from './budget.ts';
export * from './clearance.ts';
