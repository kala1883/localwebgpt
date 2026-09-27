/**
 * 启动选项（装配根）。
 *
 * ## 未知参数一律拒绝启动，而不是忽略
 *
 * 这一条与「配置读不到就用默认值」的常见做法相反，理由是**这个进程的
 * 参数里有安全含义**。操作者写下 `--control-port=0 --allow-write` 时，
 * 如果 `--allow-write` 不是一个被认识的开关，忽略它的表现是「服务正常启动」——
 * 于是操作者以为自己打开了一个开关，而实际上什么都没有发生；
 * 反过来，将来某个开关**被移除**时，忽略未知参数会让旧的启动脚本
 * 继续工作，只是少了一项保护。两种情况下静默都指向同一个方向：**保护变少**。
 *
 * ## 为什么 `LWB_HOME` 与 `--home` 同时存在
 *
 * `LWB_HOME` 是 `@lwb/secure-store` 已有的覆盖方式（测试必须能用临时目录，
 * 否则测试会去动真实的用户凭证目录）。`--home` 是它的命令行形态，
 * 供开机启动项与手工排障使用。两者都会被 `resolveStoreLayout` 标记为
 * 「根已被覆盖」，本模块把那个标记带回给调用方，由启动日志**大声**说出来 ——
 * 受保护根被覆盖意味着「凭证在 Windows 保护之下」这句话不再自动成立。
 */

/** 默认控制平面端口。0 = 由系统分配（不与他人争端口）。 */
export const DEFAULT_CONTROL_PORT = 0;

export interface StartupOptions {
  /**
   * 受保护存储根的覆盖值。`undefined` 表示用 `LWB_HOME` 或 `%LOCALAPPDATA%`。
   * 显式参数优先于环境变量。
   */
  readonly home_override: string | undefined;
  /** 控制平面端口。 */
  readonly control_port: number;
}

export class StartupOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupOptionError';
  }
}

const HOME_FLAG = '--home=';
const PORT_FLAG = '--control-port=';

/**
 * 解析命令行与必要的环境变量。
 *
 * `env` 是显式入参（不是直接读 `process.env`）：这样「`LWB_HOME` 生效时
 * 会怎样」可以被测试钉住，而不是只能靠改本机环境变量去观察。
 */
export function parseStartupOptions(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): StartupOptions {
  let home: string | undefined;
  let port = DEFAULT_CONTROL_PORT;

  for (const arg of argv) {
    if (arg.startsWith(HOME_FLAG)) {
      const value = arg.slice(HOME_FLAG.length).trim();
      if (value.length === 0) {
        throw new StartupOptionError(`${HOME_FLAG} 后面需要一个路径。`);
      }
      home = value;
      continue;
    }
    if (arg.startsWith(PORT_FLAG)) {
      const raw = arg.slice(PORT_FLAG.length).trim();
      // 只接受十进制整数：`Number('0x10')` 是 16，而写 `0x10` 的人
      // 想要的多半不是 16 号端口。用正则先钉住形状，再判断范围。
      if (!/^\d{1,5}$/.test(raw)) {
        throw new StartupOptionError(`${PORT_FLAG} 后面需要一个十进制端口号，实际收到「${raw}」。`);
      }
      const parsed = Number(raw);
      if (parsed > 65535) {
        throw new StartupOptionError(`端口 ${raw} 超出范围（0 ~ 65535）。`);
      }
      port = parsed;
      continue;
    }
    throw new StartupOptionError(
      `无法识别的启动参数「${arg}」。未知参数一律拒绝启动，而不是忽略：` +
        '被忽略的那一个如果是安全开关，操作者会以为自己打开了它。',
    );
  }

  const fromEnv = env['LWB_HOME']?.trim();
  return {
    home_override: home ?? (fromEnv && fromEnv.length > 0 ? fromEnv : undefined),
    control_port: port,
  };
}
