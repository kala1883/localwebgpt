/**
 * 受保护存储的目录布局（方案 §10.3、LWB-007）。
 *
 * ```text
 * %LOCALAPPDATA%\LocalWorkspaceBridge\
 *   bin\  config\  db\  objects\  logs\  diagnostics\
 * ```
 *
 * 这些目录**不得**放进被编辑的工作区（方案 §10.3），也不得被注册为工作区（I13）。
 * 路径解析集中在这里，是为了让「受保护根」只有一个定义：
 * 分散定义会让某处漏掉一个目录，而漏掉的那一个就是可读的。
 */

import os from 'node:os';
import path from 'node:path';

/** 目录名。测试通过 `LWB_HOME` 覆盖根，而不是改这里的常量。 */
export const STORE_DIR_NAME = 'LocalWorkspaceBridge';

/** 需要在受保护根下建立的子目录。顺序即创建顺序。 */
export const STORE_SUBDIRECTORIES = [
  'bin',
  'config',
  'config\\credentials',
  'db',
  'objects',
  'logs',
  'diagnostics',
] as const;

export type StoreSubdirectory = (typeof STORE_SUBDIRECTORIES)[number];

export interface StoreLayout {
  readonly root: string;
  readonly bin: string;
  readonly config: string;
  readonly credentials: string;
  readonly db: string;
  /** SQLite 状态库文件（方案 §10.3）。 */
  readonly databaseFile: string;
  readonly objects: string;
  readonly logs: string;
  readonly diagnostics: string;
}

export class StoreLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreLayoutError';
  }
}

/**
 * 解析受保护存储的根。
 *
 * 覆盖顺序：显式参数 → `LWB_HOME` 环境变量 → `%LOCALAPPDATA%\LocalWorkspaceBridge`。
 *
 * `LWB_HOME` 存在的理由：测试**必须**能使用临时目录，否则测试会去动真实的
 * 用户凭证目录。但它也是部署时的一个风险点（环境变量可被同账户进程设置），
 * 因此当 `LWB_HOME` 生效时，`resolveStoreLayout` 会在返回值里标记出来，
 * 由调用方决定是否接受。
 */
export function resolveStoreRoot(override?: string): string {
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }
  const fromEnv = process.env['LWB_HOME'];
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv);
  }

  const localAppData = process.env['LOCALAPPDATA'];
  if (!localAppData || localAppData.trim().length === 0) {
    // 不使用 os.homedir() 兜底：那会把凭证放进一个**未被 ACL 加固**的位置，
    // 而调用方难以察觉。宁可失败。
    throw new StoreLayoutError('无法确定受保护存储位置：环境变量 LOCALAPPDATA 未设置。');
  }
  return path.join(path.resolve(localAppData), STORE_DIR_NAME);
}

export interface ResolvedLayout {
  readonly layout: StoreLayout;
  /** 根是否来自 `LWB_HOME` 或显式覆盖（即不是真实的用户受保护目录）。 */
  readonly overridden: boolean;
}

export function resolveStoreLayout(override?: string): ResolvedLayout {
  const overridden = Boolean(
    (override && override.trim().length > 0) ||
      (process.env['LWB_HOME'] && process.env['LWB_HOME'].trim().length > 0),
  );
  const root = resolveStoreRoot(override);
  const sub = (name: string): string => path.join(root, ...name.split('\\'));
  return {
    overridden,
    layout: {
      root,
      bin: sub('bin'),
      config: sub('config'),
      credentials: sub('config\\credentials'),
      db: sub('db'),
      databaseFile: path.join(root, 'db', 'bridge.sqlite'),
      objects: sub('objects'),
      logs: sub('logs'),
      diagnostics: sub('diagnostics'),
    },
  };
}

/**
 * 判断某个绝对路径是否位于受保护根之内。
 *
 * **这是预过滤，不是安全边界。** 它比较的是字符串，而字符串无法识别
 * Junction、8.3 短名、大小写别名。真正的判定必须比对文件身份
 * （volume_id + file_id），见 `protected-paths.ts` 的 `findProtectedIdentityMatch`。
 * 本函数的作用只是把明显的情况在早期挡掉，减少后续要走原生层的次数。
 */
export function isInsideStore(absolutePath: string, storeRoot: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const target = normalize(absolutePath);
  const root = normalize(storeRoot);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/** 供日志与诊断使用：只暴露根，不暴露其下的具体文件。 */
export function describeStoreRoot(storeRoot: string): string {
  return storeRoot;
}

/** 当前用户主目录；仅用于「广泛目录」判定，不用于存放凭证。 */
export function userHomeDirectory(): string {
  return os.homedir();
}
