/**
 * 单实例（LWB-008 步骤 1、验收标准 1）。
 *
 * > 验收标准：**第二个 daemon 不会并发写同一个状态库/工作区。**
 *
 * ## 互斥量是「绑定命名管道」这个动作本身
 *
 * Windows 命名管道名在一台机器上是**全局命名空间**，同一时刻只能有一个
 * 监听者绑定某个名字。绑定已存在的名字会失败（`EADDRINUSE`），
 * 而「检查名字是否已占用」与「绑定这个名字」在操作系统里是同一个原子操作 ——
 * 不存在检查通过、绑定失败之间的窗口。
 *
 * 锁文件方案没有这个性质：进程崩溃后锁文件仍在，于是必须判断
 * 「持有者是否还活着」，而那需要 PID + 启动时刻之类的启发式，会被 PID 复用骗过。
 * 命名管道由**操作系统**在进程退出（含崩溃、被强杀）时释放，没有过期与复用问题。
 *
 * ## 单实例管道也承载固定停止请求
 *
 * 除互斥外，它只识别 `LOCAL_STOP_COMMAND` 这一条窄命令；其它数据交回调用方
 * 关闭。SID 摘要只负责定位，Windows 命名管道 DACL 才是系统层访问控制。
 * 不接受 PID、进程名或任意控制指令。
 *
 * ## 但绑定成功 ≠ 可以写
 *
 * 这里只负责**互斥**。允许写还要看租约（`lease.ts`）。
 * 两件事分开的理由：管道被占用可能是另一个实例刚启动、还没放弃；
 * 而租约回答的是完全不同的问题 ——「上一个写执行器是否确定已经不在了」。
 */

import { createServer, type Server } from 'node:net';

import { controlPipeName, describePipe } from './pipe-name.ts';

export type SingleInstanceOutcome =
  | {
      readonly kind: 'acquired';
      readonly server: Server;
      readonly pipe_name: string;
      /** Resolves only after the current user's explicit stop command is accepted. */
      readonly stop_requested: Promise<void>;
    }
  | { readonly kind: 'occupied'; readonly reason: string };

/** Narrow control-pipe command; it can stop only this user's LocalWebGPT daemon. */
export const LOCAL_STOP_COMMAND = 'LWB_STOP\n';
export const LOCAL_STOP_ACK = 'STOPPING\n';

export class SingleInstanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SingleInstanceError';
  }
}

/** `EADDRINUSE` 在 Windows 上对应命名管道名已被占用。 */
export function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'EADDRINUSE'
  );
}

/**
 * 绑定控制管道，以此获得单实例互斥。
 *
 * @param onConnection 收到停止命令以外的数据或空闲连接时的处理器。
 */
export async function acquireSingleInstance(options: {
  readonly userSid: string;
  readonly onConnection: (socket: import('node:net').Socket) => void;
}): Promise<SingleInstanceOutcome> {
  const pipeName = controlPipeName(options.userSid);
  let resolveStop!: () => void;
  const stopRequested = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });

  const server = createServer((socket) => {
    let received = Buffer.alloc(0);
    let handled = false;
    const stopBytes = Buffer.from(LOCAL_STOP_COMMAND, 'utf8');
    let idleTimer: NodeJS.Timeout | undefined;

    const rejectConnection = (): void => {
      if (handled) return;
      handled = true;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      options.onConnection(socket);
    };

    idleTimer = setTimeout(rejectConnection, 1_000);
    idleTimer.unref();

    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      received = Buffer.concat([received, chunk]);
      if (
        received.length > stopBytes.length ||
        !stopBytes.subarray(0, received.length).equals(received)
      ) {
        rejectConnection();
        return;
      }
      if (!received.equals(stopBytes)) return;

      handled = true;
      clearTimeout(idleTimer);
      socket.end(LOCAL_STOP_ACK);
      resolveStop();
    });

    socket.once('error', () => rejectConnection());
    socket.once('close', () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (!handled) rejectConnection();
    });
  });

  return await new Promise<SingleInstanceOutcome>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      if (isAddressInUse(error)) {
        // 这里**不**去探测占用者是谁。探测需要能读另一个进程的信息，
        // 而占用者可能是一个正在退出的旧实例 —— 把它的 PID 报给用户
        // 只会让人以为「进程还在就一定是它占着」，从而去强杀一个无关进程。
        resolve({
          kind: 'occupied',
          reason:
            `控制管道 ${describePipe(pipeName)} 已被占用，说明本用户下已有 daemon 在运行。` +
            '同一用户的 daemon 只允许一个实例：拒绝启动第二个，而不是让它与第一个争抢状态库与工作区。',
        });
        return;
      }
      reject(new SingleInstanceError(`绑定控制管道失败：${error.message}`));
    };

    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve({ kind: 'acquired', server, pipe_name: pipeName, stop_requested: stopRequested });
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(pipeName);
  });
}

/**
 * 释放控制管道。
 *
 * 必须显式关闭：进程正常退出时 Node 会关掉句柄，但**测试与热重启**需要
 * 在同进程内重新绑定，而只要旧 Server 对象还活着，名字就仍被占用。
 */
export async function releaseSingleInstance(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
