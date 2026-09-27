/**
 * @lwb/contracts —— LWB 冻结契约层。
 *
 * 本包是纯契约：类型、常量、纯函数校验。它**不得**访问文件系统、
 * 不得持有任何状态、不得 import 可写 fs 或 child_process。
 * 这一约束由 scripts/check-fsguard-imports.mjs 静态检查保证。
 */

export * as ids from './ids.ts';
export * from './ids.ts';
export * from './errors.ts';
export * from './envelope.ts';
export * from './limits.ts';
export * from './path.ts';
export * from './glob.ts';
export * from './hash.ts';
export * from './version.ts';
export * from './capabilities.ts';
export * from './control.ts';
export * from './status.ts';
export * from './read.ts';
export * from './list.ts';
export * from './search.ts';
export * from './git.ts';
export * from './change.ts';
export * from './tools.ts';
export * from './tool-outputs.ts';
export * from './tool-catalog.ts';

/** 契约版本。任何破坏性契约变更都必须递增，并与 docs/adr 记录同步。 */
export const CONTRACT_VERSION = '0.1.0';

/** 方案文档版本，便于把运行结果与设计基线对应起来。 */
export const DESIGN_BASELINE = 'design-v1.0';
