/**
 * daemon 的进程入口（`npm run daemon`）。
 *
 * 这一层刻意只有三件事：**取参数与信号**、**调装配根**、**把结果翻成退出码**。
 * 判定、装配顺序、清理栈全部在 `runtime/` 里 —— 放在这里的每一行都会
 * 变成「只有真跑起来才能测到」的代码，而装配根本身是可以被测试直接调用的。
 *
 * ## 退出码只有三个，见 `runtime/constants.ts`
 *
 * 它们分开的理由不是分类学，是**处置不同**：`2` 说的是「本用户下已经有一个
 * daemon 在跑」，而启动脚本对它的正确反应（不要强杀，先确认）与对 `1`
 * 的反应（读报错、修配置）不一样。
 *
 * ## Ctrl+C 之后进程会**等**清理走完
 *
 * 装上 `SIGINT` 处理器就意味着 Node 不再自动退出，于是「收到信号即退出」
 * 与「清理完再退出」的区别在这里变成一行代码。选择后者：数据管道的关闭、
 * 状态库的连接、两个常驻 PowerShell 助手的停止都需要一点时间，
 * 而一个已经断掉控制台、却还占着状态库的僵尸进程比多等半秒更糟。
 */

import process from 'node:process';

import { loadConsoleAssets } from './lifecycle/console-assets.ts';
import { EXIT_ALREADY_RUNNING, EXIT_OK, EXIT_STARTUP_FAILED } from './runtime/constants.ts';
import { StartupFailed, startDaemon } from './runtime/index.ts';

async function main(): Promise<number> {
  let runtime;
  try {
    const static_assets = await loadConsoleAssets();
    runtime = await startDaemon({ argv: process.argv.slice(2), env: process.env, static_assets });
  } catch (error) {
    if (error instanceof StartupFailed) {
      // 启动失败的报错**已经**是给人看的一句话（装配根逐条写的），
      // 因此不再加一层前缀把它埋起来。
      process.stderr.write(`${error.message}\n`);
      return error.kind === 'already_running' ? EXIT_ALREADY_RUNNING : EXIT_STARTUP_FAILED;
    }
    process.stderr.write(`启动失败：${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_STARTUP_FAILED;
  }

  const reason = await Promise.race([
    waitForShutdownSignal(),
    runtime.stop_requested.then(() => 'LOCAL_STOP_COMMAND'),
  ]);
  process.stdout.write(`收到 ${reason}，正在退出（先断连接、再关状态库）。\n`);
  await runtime.shutdown();
  process.stdout.write('已退出。\n');
  return EXIT_OK;
}

/** 等一个终止信号。两个信号分开列出，而不是 `once('exit')` —— 后者不会触发。 */
function waitForShutdownSignal(): Promise<string> {
  return new Promise((resolve) => {
    for (const name of ['SIGINT', 'SIGTERM'] as const) {
      process.once(name, () => resolve(name));
    }
  });
}

// 未捕获的异常与未处理的拒绝：一个守护进程**不该**带着未知的坏状态继续服务。
// 这里只报出来并退出，不做「尝试恢复」—— 恢复要判断哪些不变量还成立，
// 而那正是崩溃之后最不可靠的信息。
process.on('uncaughtException', (error: Error) => {
  process.stderr.write(`未捕获的异常，进程即将退出：${error.message}\n`);
  process.exitCode = EXIT_STARTUP_FAILED;
});
process.on('unhandledRejection', (reason: unknown) => {
  process.stderr.write(
    `未处理的承诺拒绝，进程即将退出：${reason instanceof Error ? reason.message : String(reason)}\n`,
  );
  process.exitCode = EXIT_STARTUP_FAILED;
});

void main().then((code) => {
  process.exitCode = code;
});
