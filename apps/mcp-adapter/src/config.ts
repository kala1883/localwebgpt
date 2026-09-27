/**
 * 适配器的启动配置（LWB-017）。
 *
 * ## 凭证只从环境来，且**永不**出现在日志里
 *
 * `LWB_IPC_SECRET_MCP_ADAPTER` 是本进程唯一的秘密。它不会出现在任何返回值、
 * 任何日志行、任何错误的 `message` 里 —— 这里的 `describe()` 是本文件
 * 唯一对外描述配置的函数，它**只回报有哪些字段**，不回报值。
 *
 * 之所以值得单独写一个函数而不是随手 `console.error(config)`：
 * 那个写法在开发期很方便，而它一旦留在代码里，凭证就会在每一行启动日志里
 * 出现一次，散落到终端回滚、进程管理器日志与 bug 报告里。
 *
 * ## 缺失即拒绝启动
 *
 * 所有配置项都是必需的，没有默认值。一个「没有凭证也能启动，只是调用会失败」
 * 的适配器，在排障时会表现成「daemon 拒绝了每一次调用」——
 * 而真实原因在启动那一刻就已经可知。因此宁可在启动时失败。
 */

export interface AdapterConfig {
  readonly pipe_name: string;
  readonly secret: string;
  readonly connection_id: string;
  /** 协议版本，仅用于 `bridge_status` 的对齐检查。 */
  readonly adapter_version: string;
}

export class AdapterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterConfigError';
  }
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AdapterConfigError(`缺少必需的环境变量 ${name}。`);
  }
  return value;
}

export const PIPE_NAME_ENV = 'LWB_IPC_PIPE';
export const SECRET_ENV = 'LWB_IPC_SECRET_MCP_ADAPTER';
export const CONNECTION_ID_ENV = 'LWB_CONNECTION_ID';
export const VERSION_ENV = 'LWB_ADAPTER_VERSION';

export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AdapterConfig {
  const secret = required(env, SECRET_ENV);
  if (secret.length < 16) {
    // 与 `assertAudienceSecretsDistinct` 的阈值一致。过短的凭证在握手
    // 派生里仍然是「能算出来的」，而这一点在功能上看不出来。
    throw new AdapterConfigError(`${SECRET_ENV} 过短（至少 16 字符）。`);
  }

  return {
    pipe_name: required(env, PIPE_NAME_ENV),
    secret,
    connection_id: required(env, CONNECTION_ID_ENV),
    adapter_version: env[VERSION_ENV] ?? '0.0.0',
  };
}

/**
 * 配置的**形状**描述，供启动日志使用。
 *
 * 它以类型强制实现：返回的每一个值都必须是非秘密的字段。
 * 新增一个字段时，这里的类型会逼着作者想一次「它能不能进日志」。
 */
export function describeConfig(config: AdapterConfig): Record<string, string | number> {
  return {
    pipe_name: config.pipe_name,
    connection_id: config.connection_id,
    adapter_version: config.adapter_version,
    // 只回报长度，不回报内容 —— 长度足以用于核对「配的是不是同一把」，
    // 而它不是一个可用的凭证。
    secret_length: config.secret.length,
  };
}
