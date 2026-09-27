/**
 * stdio 边界（LWB-017 步骤 3：「stdio 标准输出仅为协议消息」）。
 *
 * ## 为什么需要一个文件专门做这件事
 *
 * MCP 的 stdio 传输把**标准输出**当作协议帧的载体：一行一个 JSON-RPC 消息。
 * 因此任何一个 `console.log` —— 包括依赖里的、调试时顺手加的、
 * 异常处理器里补的 —— 都会往这条流里插入一行不是 JSON 的东西，
 * 后果是客户端解析失败、连接中断。
 *
 * 这类故障的表现方式很恶劣：它**与出故障的代码无关**。加日志的人看到
 * 自己那行正常打印，而失败发生在下一次读工具结果的时候。
 *
 * 因此这里把 `console.log` / `console.info` / `console.debug` 全部改道到
 * **stderr**。这不是「提醒大家别用」，是让「往 stdout 写非协议内容」
 * 在这条路径上**做不到**。
 *
 * `process.stdout.write` 本身仍然可达 —— 它必须可达，传输层要用它。
 * 这个文件的边界由此明确：它保证的是「本进程自己的日志走 stderr」，
 * 不试图拦截传输层。
 *
 * ## 它在 `apps/mcp-adapter/src/stdio/` 下，这是刻意的
 *
 * `scripts/check-fsguard-imports.mjs` 把这一条路径单列进 ALLOWED_PREFIXES：
 * 这是本仓库里少数几个可以碰进程边界的地方。把它放在别处，
 * 它就只是又一个业务文件 —— 而业务文件不该关心 stdout 是什么。
 */

import process from 'node:process';

function write(stream: NodeJS.WriteStream, args: readonly unknown[]): void {
  // 与 `console.log` 一致：非字符串参数用 `util.inspect` 风格的行内表示。
  // 这里用最简单的一版：`String()` + 空格连接。日志的可读性不值得
  // 引入 `util`（它的 `inspect` 在遇到循环引用时还会抛）。
  const line = args
    .map((value) => (typeof value === 'string' ? value : safeString(value)))
    .join(' ');
  stream.write(`${line}\n`);
}

function safeString(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? Object.prototype.toString.call(value);
    } catch {
      // 循环引用、BigInt、getter 抛异常 —— 日志宁可难看，也不能抛。
      return '[unprintable]';
    }
  }
  return String(value);
}

/** 把本进程的日志全部改道到 stderr。**启动第一件事**调用。 */
export function protectStdout(): void {
  console.log = (...args: unknown[]): void => write(process.stderr, args);
  console.info = (...args: unknown[]): void => write(process.stderr, args);
  console.debug = (...args: unknown[]): void => write(process.stderr, args);
  // `console.warn` / `console.error` 本来就写 stderr，不动它们 ——
  // 覆盖一个已经正确的行为，只会让人怀疑它原本是错的。
}
