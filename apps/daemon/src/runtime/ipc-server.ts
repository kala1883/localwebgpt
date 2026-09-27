/**
 * 数据管道（装配根）。
 *
 * ## 为什么是**两条**管道，而不是一条
 *
 * `@lwb/ipc` 里有两个名字，它们共用同一个 SID 摘要、只差一个 `.data` 后缀：
 *
 * | 名字 | 谁绑 | 作用 |
 * | --- | --- | --- |
 * | `controlPipeName(sid)` | `acquireSingleInstance` | 互斥量与固定本机停止命令 |
 * | `dataPipeName(sid)` | 本模块 | 真正跑协议：适配器与控制台在这里握手、发请求 |
 *
 * 合成一条会让两件相反的事在日志里长得一样：「第二个实例被拒绝启动」
 * 与「旧实例正在关闭、新实例正要接手」都表现为「管道名已被占用」，
 * 而它们的处置正好相反（一个该退出，一个该重试）。
 *
 * 分开之后还有第二个好处：单实例判定在**创建任何状态之前**完成。
 * 第二个实例因此不会先打开状态库、写完启动日志、再发现自己该退出 ——
 * 那段时间里它已经动过用户的库了。
 *
 * ## 控制管道与数据管道分开维护
 *
 * 固定停止请求由 `single-instance.ts` 识别；这里仅服务 MCP/控制台数据协议，
 * 并在关闭时先拒绝新操作、等待已进入的处理器完成，再断开 socket。
 *
 * ## 数据管道绑不上就拒绝启动
 *
 * 与「第二个实例」的处置不同：控制管道被占用是**预期的**（已有 daemon），
 * 而数据管道被占用意味着**有别的进程占着适配器要去连的那个名字**。
 * 那种情况下继续启动，得到的是一个看起来正常、但适配器永远连不上的 daemon
 * —— 而调用方会把失败读成「隧道的问题」。因此这里失败即退出。
 */

import { createServer, type Server, type Socket } from 'node:net';

import type { AudienceSecrets, OperationRegistry, SessionEvent } from '@lwb/ipc';
import { attachSocket, dataPipeName, describePipe } from '@lwb/ipc';

export interface DataPipeOptions {
  readonly userSid: string;
  /** 两个 audience 的**专属**凭证，见 `deriveAudienceKey`。 */
  readonly secrets: AudienceSecrets;
  readonly operations: OperationRegistry;
  /**
   * 「这个连接标识是否已在本机注册」。
   *
   * 由装配根传状态库的查询（`repos.connections.findById(...) !== null`），
   * 而不是在这里再实现一遍 —— 握手层问的是「认不认识这个名字」，
   * 「这条连接是否启用、principal_kind 是否与通道相符」是**每一次请求**
   * 都要重新走的另一条链（`tools/access.ts`）。两者分开，是因为它们
   * 回答不同的问题，而把后者折进前者会让一次握手就锁死整条连接的权限。
   */
  readonly isRegisteredConnection: (connectionId: string) => boolean;
  readonly onEvent?: (event: SessionEvent) => void;
}

export interface DataPipe {
  /** 真实的管道名。启动器要连的就是它（它可以由 `dataPipeName(sid)` 自己算出来）。 */
  readonly pipe_name: string;
  /**
   * 给人看的管道名：SID 摘要被换成 `<sid-hash>`。
   *
   * 摘要不是凭证，但它是一个**稳定的用户标识**，而日志会流向终端回滚、
   * 进程管理器与 bug 报告三处。因此凡是写给人看的地方（启动日志、
   * `bridge_status`、控制台状态页）都用这一份 —— 而「哪些地方该用哪一份」
   * 由接口上的两个字段名回答，不靠调用方记得去调 `describePipe`。
   */
  readonly described_name: string;
  /** 当前活着的连接数。供启动日志与退出时核对「连接确实不可调用了」。 */
  readonly open_connections: number;
  close(): Promise<void>;
}

export class DataPipeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataPipeError';
  }
}

/**
 * 绑定数据管道并开始服务。
 *
 * 会话本身（握手、能力查表、超时）全在 `attachSocket` 里，本函数只管
 * 生命周期：绑定、记账（哪些 socket 活着）、关闭。
 */
export async function startDataPipe(options: DataPipeOptions): Promise<DataPipe> {
  const pipeName = dataPipeName(options.userSid);
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    attachSocket(socket, {
      secrets: options.secrets,
      operations: options.operations,
      isRegisteredConnection: options.isRegisteredConnection,
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });
  });

  // 绑定失败**不**退化成「只跑控制平面」：那会得到一个能启动、能打印
  // 启动地址、却永远收不到工具调用的 daemon。宁可在这里失败。
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(
        new DataPipeError(
          `绑定数据管道 ${describePipe(pipeName)} 失败：${error.message}。` +
            '这条管道名被别的进程占着时，适配器会连到一个不属于本进程的监听者上；已拒绝启动。',
        ),
      );
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(pipeName);
  });

  return {
    pipe_name: pipeName,
    described_name: describePipe(pipeName),
    get open_connections() {
      return sockets.size;
    },
    async close() {
      // 先关监听并拒绝新操作，再等已进入的 IPC/控制面 handler 全部结束；
      // 否则下面关闭 SQLite / 原生助手时，change_apply 可能仍在运行。
      const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      options.operations.beginDrain();
      await options.operations.waitForIdle();

      // 活跃请求都已落到明确结果后才断开闲置 socket。server.close 还要等
      // 这些 socket 关完才 resolve，因此保留它的 Promise 到这里再 await。
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await serverClosed;
    },
  };
}
