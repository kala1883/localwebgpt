/**
 * 适配器进程入口（LWB-017）。
 *
 * ## 启动顺序：先保护 stdout，再读配置
 *
 * `protectStdout()` 必须在任何可能产生输出的事情**之前**跑。配置加载
 * 失败时会写一句 stderr，而如果那时 `console.log` 还没有改道，
 * 这句错误就会写进协议流 —— 一个「启动失败」被客户端读成「协议损坏」。
 *
 * ## 连不上 daemon 就退出，而且是非零退出
 *
 * 一个连不上 daemon 的适配器，能回答的每一件事都是
 * `SERVICE_UNAVAILABLE`。让它继续挂着，会把「本地服务没在跑」这件事
 * 摊薄成「每一次工具调用都失败」—— 后者看起来像工具本身有问题。
 *
 * 进程退出是这里最清楚的信号：客户端（隧道 / Inspector）会立刻看到
 * 传输断开，而 stderr 上是那句话。**这不是降级**，是把一个已经确定的
 * 事实尽早说出来。
 *
 * ## 这里不打印配置值
 *
 * 只打印 `describeConfig()` 的返回 —— 它含管道名、连接 id 与**长度**，
 * 不含凭证。见 `config.ts`。
 */

import process from 'node:process';

import { IpcClient } from '@lwb/ipc';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { AdapterConfigError, describeConfig, loadConfig } from './config.ts';
import { createAdapterServer } from './server.ts';
import { protectStdout } from './stdio/guard.ts';

function logToStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function main(): Promise<void> {
  protectStdout();

  let config;
  try {
    config = loadConfig();
  } catch (cause) {
    // 配置错误只说「哪个环境变量缺了」，不回显值。
    const detail = cause instanceof AdapterConfigError ? cause.message : '配置无效。';
    logToStderr(`适配器启动失败：${detail}`);
    process.exitCode = 2;
    return;
  }

  const client = new IpcClient({
    pipeName: config.pipe_name,
    secret: config.secret,
    // 适配器**只**持有自己这条 audience 的凭证。控制台那条它没有，
    // 也算不出（密钥按 audience 派生，见 @lwb/ipc 的 audience.ts）。
    audience: 'mcp-adapter',
    connectionId: config.connection_id,
  });

  try {
    await client.connect();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.name : '未知原因';
    logToStderr(
      `适配器无法连接本地 daemon（${detail}）；` +
        `配置：${JSON.stringify(describeConfig(config))}。请确认 daemon 正在运行。`,
    );
    process.exitCode = 1;
    return;
  }

  const server = createAdapterServer({
    caller: client,
    server_version: config.adapter_version,
    log: logToStderr,
  });

  // 传输层启动之后才打印这一行：在那之前写 stderr 是安全的，
  // 而这之后 stderr 仍然是安全的（协议只占用 stdout）。
  logToStderr(`适配器已就绪：${JSON.stringify(describeConfig(config))}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async (signal: string): Promise<void> => {
    logToStderr(`收到 ${signal}，正在关闭。`);
    await server.close().catch(() => undefined);
    await client.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 未捕获异常时协议流的状态未知（可能只写了一半的帧），
  // 因此不尝试继续服务：记录到 stderr 后以非零码退出，
  // 让客户端重连而不是读到一个半截的会话。
  process.on('uncaughtException', (error) => {
    logToStderr(`适配器未捕获异常：${error.name}: ${error.message}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logToStderr(`适配器未处理的 Promise 拒绝：${reason instanceof Error ? reason.name : typeof reason}`);
    process.exit(1);
  });
}

await main();
