/**
 * 命名管道的名字（LWB-008 步骤 1）。
 *
 * ## 名字不是安全边界
 *
 * 把 SID 编进管道名，作用仅仅是**避免不同用户的实例互相撞名**，
 * 以及让误连变得不可能顺手发生。它不是访问控制：
 * 管道名可以在进程列表里看到，任何进程都能尝试连接。
 *
 * **真正的边界是握手**（见 `handshake.ts`）：没有凭证就算连上也算不出证明。
 *
 * ## 为什么不用 `LWB_HOME` 之类的可覆盖值来决定名字
 *
 * 那会让「同一个用户、两个不同的 LWB_HOME」变成两条互不可见的管道，
 * 于是单实例保证（验收标准 1）被一个环境变量绕过。
 * 名字只由 SID 决定。
 */

import { createHash } from 'node:crypto';

/** Windows 命名管道前缀。 */
const PIPE_PREFIX = '\\\\.\\pipe\\';

/** 管道名中前缀之后的部分。 */
const BASE_NAME = 'LocalWorkspaceBridge';

/**
 * 由 SID 派生管道名。
 *
 * SID 先哈希再截断，不是出于保密（SID 不是秘密），而是因为
 * SID 里含 `-` 与数字，直接拼接会让名字很长且不易读；
 * 同时固定长度可以避免任何长度相关的边界问题。
 */
export function pipeNameForSid(userSid: string): string {
  if (!/^S-\d+(-\d+)+$/.test(userSid)) {
    throw new Error(`不是合法的用户 SID，拒绝据此构造管道名：${userSid}`);
  }
  const digest = createHash('sha256').update(userSid, 'utf8').digest('hex').slice(0, 16);
  return `${PIPE_PREFIX}${BASE_NAME}.${digest}`;
}

/**
 * 单实例探测用的管道名。
 *
 * **它与控制管道是同一个名字**，这是有意的：daemon 绑定控制管道时，
 * 如果名字已被占用，`listen` 会失败（Windows 上表现为 `EADDRINUSE`）。
 * 也就是说，**绑定动作本身就是互斥量**，不需要额外的锁文件。
 *
 * 用锁文件做单实例的常见做法有一个无法回避的问题：进程崩溃后锁文件仍在，
 * 而判断「持有者是否还活着」需要 PID + 启动时间之类的启发式，
 * 那些启发式会被 PID 复用骗过。命名管道由**操作系统**在进程退出时释放，
 * 没有过期与复用问题。
 */
export function controlPipeName(userSid: string): string {
  return pipeNameForSid(userSid);
}

/**
 * 数据管道名：适配器与控制台连上来的那一条（LWB-025 装配根）。
 *
 * ## 为什么它与控制管道必须是**两个**名字
 *
 * 控制管道承担的是互斥量：绑定动作本身是原子的，因此「已经有 daemon
 * 在跑」表现为 `EADDRINUSE`。数据管道是长期的请求通道，daemon 退出时
 * 正常关闭。两者同名的话，「第二个实例被拒绝启动」与「旧实例正在关闭、
 * 新实例正要接手」这两种情况在日志里长得一模一样 —— 而它们的处置相反。
 *
 * 名字**共用同一个 SID 摘要**（而不是各算一个），这样从两条名字就能看出
 * 它们属于同一个用户；只差一个 `.data` 后缀，误连不会顺手发生。
 */
export function dataPipeName(userSid: string): string {
  return `${pipeNameForSid(userSid)}.data`;
}

/**
 * 供日志使用：保留可读部分，用户 SID 不上日志。
 *
 * 摘要按**位置**而不是按行尾匹配：`pipeNameForSid` 的输出在加了 `.data`
 * 之后摘要不再位于行尾，一个行尾锚定的正则会让数据管道的名字原样
 * （含摘要）进日志 —— 而这段日志的用途恰恰是「说清楚是哪条管道」。
 */
export function describePipe(pipeName: string): string {
  return pipeName.replace(/[0-9a-f]{16}/, '<sid-hash>');
}
