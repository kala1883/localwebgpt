/** Small restart policy for the long-running Secure MCP Tunnel child. */

export interface TunnelProcessResult {
  readonly code: number;
  readonly signal: NodeJS.Signals | null;
}

export interface TunnelSupervisorOptions {
  readonly run: () => Promise<TunnelProcessResult>;
  readonly doctor: () => Promise<TunnelProcessResult>;
  /** Recheck local connection availability immediately before each run. */
  readonly beforeRun?: () => Promise<boolean>;
  /** Recheck local connection availability after an outage and before doctor/restart. */
  readonly beforeRestart?: () => Promise<boolean>;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly shouldStop: () => boolean;
  readonly stopExitCode: () => number;
  readonly log: (message: string) => void;
}

export interface ConnectionEnableWaitOptions {
  readonly isEnabled: () => boolean;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly shouldStop: () => boolean;
  readonly log: (message: string) => void;
}

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;

/** Exponential-ish backoff, capped at one minute so transient outages recover unattended. */
export function tunnelRetryDelay(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError('重连次数必须是正整数。');
  }
  return RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]!;
}

/**
 * Hold tunnel startup until the local operator enables the model connection
 * through the audited console flow. This only changes connection availability;
 * it never creates workspace grants or opens capability gates.
 */
export async function waitForConnectionEnable(options: ConnectionEnableWaitOptions): Promise<boolean> {
  if (options.isEnabled()) return true;

  options.log(
    '本机 ChatGPT 连接当前已停用。请打开上方一次性控制台链接，进入“ChatGPT 连接”页，' +
      '勾选本机确认并启用；完成后此启动命令会自动继续。该操作不授予工作区权限。',
  );
  while (!options.shouldStop()) {
    await options.wait(1_000);
    if (options.shouldStop()) return false;
    if (options.isEnabled()) {
      options.log('已检测到本机启用 ChatGPT 连接；继续检查并启动 Secure MCP Tunnel。');
      return true;
    }
  }
  return false;
}

/**
 * Keep the existing daemon alive while a failed tunnel child is recovered.
 * The daemon (and therefore the single writer) is never restarted here. A
 * failed doctor is treated as a likely credential/configuration problem and
 * stops the launcher instead of spinning forever.
 */
export async function superviseTunnel(options: TunnelSupervisorOptions): Promise<number> {
  let attempt = 0;
  while (!options.shouldStop()) {
    if (options.beforeRun && !(await options.beforeRun())) return options.stopExitCode();
    if (options.shouldStop()) return options.stopExitCode();
    const result = await options.run();
    if (options.shouldStop()) return options.stopExitCode();

    attempt += 1;
    const delay = tunnelRetryDelay(attempt);
    options.log(
      `Secure MCP Tunnel 进程已退出（exit=${result.code}, signal=${result.signal ?? 'none'}）；` +
        `${Math.ceil(delay / 1_000)} 秒后检查并尝试重连。`,
    );
    await options.wait(delay);
    if (options.shouldStop()) return options.stopExitCode();

    // The local operator may have disabled the ChatGPT connection while the
    // tunnel was down (for example during sleep/reconnect). Do not restart
    // the remote-facing child until the audited local enable flow is current.
    if (options.beforeRestart && !(await options.beforeRestart())) {
      return options.stopExitCode();
    }
    if (options.shouldStop()) return options.stopExitCode();

    const diagnosis = await options.doctor();
    if (options.shouldStop()) return options.stopExitCode();
    if (diagnosis.code !== 0 || diagnosis.signal !== null) {
      options.log('tunnel-client doctor 未通过；为避免错误重试，已停止本地服务，请处理诊断后重新启动。');
      return diagnosis.code || 1;
    }

    options.log('tunnel-client doctor 通过；正在重新启动 Secure MCP Tunnel。');
  }
  return options.stopExitCode();
}
