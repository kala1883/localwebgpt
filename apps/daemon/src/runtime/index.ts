/**
 * 装配根（`apps/daemon/src/runtime/`）。
 *
 * ## 本目录做什么
 *
 * 把已经实现好的各层**按正确顺序接起来**，并让每一步的失败都是
 * **拒绝启动**而不是降级。它自己不判定任何安全规则 —— 判定在
 * `@lwb/policy`、`@lwb/workspaces`、`packages/ipc` 与 `tools/` 里，
 * 这里只负责「谁在什么时候被建出来」以及「失败时谁被撤掉」。
 *
 * ## 本目录**不**做什么
 *
 *  - 不读配置文件：今天没有任何配置层，限额用冻结初值（记录在案的偏差）。
 *  - 不写日志文件：日志只走 stdout / stderr。落盘日志属于生命周期层
 *    （LWB-039），而那一层要处理轮转、配额与脱敏三件本目录不该顺手做的事。
 *  - 不做常驻管理：睡眠唤醒、隧道重连、开机启动都是 LWB-039 的交付物。
 *  - 不碰文件系统：本目录在 `scripts/check-fsguard-imports.mjs` 里是
 *    **业务层**（`apps/daemon/src/`），只允许经由 `@lwb/secure-store`、
 *    `@lwb/persistence`、`@lwb/winfs`、`@lwb/ipc` 这些受控接口访问本机。
 */

export {
  ADAPTER_CONNECTION_ALIAS,
  ADAPTER_CONNECTION_ID,
  ADAPTER_PRINCIPAL_ID,
  DAEMON_VERSION,
  EXIT_ALREADY_RUNNING,
  EXIT_OK,
  EXIT_STARTUP_FAILED,
} from './constants.ts';

export { DEFAULT_CONTROL_PORT, StartupOptionError, parseStartupOptions } from './options.ts';
export type { StartupOptions } from './options.ts';

export { loadIpcSecrets, loadRuntimeKeys } from './credentials.ts';
export type { CredentialProvision, IpcCredentialProvision, RuntimeKeys } from './credentials.ts';

export { DataPipeError, startDataPipe } from './ipc-server.ts';
export type { DataPipe, DataPipeOptions } from './ipc-server.ts';

export { StartupFailed, startDaemon } from './assembly.ts';
export type { DaemonRuntime, LogSink, StartDaemonOptions, StartupFacts } from './assembly.ts';
