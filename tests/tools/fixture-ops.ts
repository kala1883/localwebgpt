/**
 * 架在**真实文件**上的桩后端（LWB-017）。
 *
 * ## 它为什么存在
 *
 * `tests/search/harness.ts` 的桩把「目录里有什么」写死在代码里，这适合
 * 单个包的边界用例，但不适合工具面：工具面的验收标准之一是
 * 「**工具结果符合 schema**」，而这句话只有在一份**真的返回了内容**的结果上
 * 才检验得到。空目录、只有一个条目的目录，都让结果里的数组恒为空 ——
 * 一个恒为空的字段符合任何 schema。
 *
 * 因此这一份桩的**事实**来自磁盘：真实夹具仓库的字节、真实的目录项、
 * 真实的 `.git`。判定仍然一点也不在桩里 —— 它只回答「这个路径是什么对象」
 * 「这个目录里按序有哪些项」「这个文件的字节是什么」。
 *
 * ## 它不假装自己是护栏
 *
 * 真实护栏（`WinfsGuard.ps1`）做的是句柄级身份复核、重解析点拒绝、
 * 挂载点穿越拒绝 —— 那些**不在**这里，也不该在这里被假装。
 * 这一份桩的价值是让工具层的七条路径都能跑到真实内容；
 * 「接上真实句柄护栏之后仍然成立」由 `tests/windows/` 负责。
 *
 * 身份字段（`volume_id` / `file_id`）由路径派生且稳定：
 * `packages/files` 会在「探测到的身份」与「读取时的身份」之间比对，
 * 两份由同一个函数派生才谈得上一致。
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type {
  WinfsError,
  WinfsListRequest,
  WinfsListResult,
  WinfsOps,
  WinfsPathRef,
  WinfsReadResult,
  WinfsVolumeInfo,
} from '@lwb/winfs';

const VOLUME_ID = 'c6e22015';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 路径 → 稳定的「文件索引」。
 *
 * 导出是必要的：装置里的**桩探测器**必须为同一个根报出**同一个** id，
 * 否则 `authorizeAccess` 会在「每次重新探测根身份」那一步发现
 * 「对象被换掉了」—— 而那是装置自己的锅，不是被测代码的。
 */
export function fileIdOf(absolutePath: string): string {
  // 稳定的 32 位十六进制「文件索引」。按小写规范路径派生，因此
  // `C:\A\b.txt` 与 `c:\a\B.TXT` 得到同一个 id —— 与 Windows 的
  // 大小写不敏感一致（护栏实测也是这个行为）。
  return sha256(Buffer.from(path.resolve(absolutePath).toLowerCase(), 'utf8')).slice(0, 32);
}

function failed(code: WinfsError['code'], win32: number, detail: string): WinfsError {
  return { ok: false, code, message: `夹具桩：${detail}`, win32_error: win32 };
}

function absoluteOf(req: WinfsPathRef): string {
  return req.relative_path === ''
    ? req.root_path
    : path.join(req.root_path, ...req.relative_path.split('/'));
}

export interface FixtureOpsOptions {
  /** 读取时会把内容替换掉的路径（相对工作区根），用于构造「读到一半被换掉」。 */
  readonly mutate?: ReadonlyMap<string, string>;
}

export function makeFixtureOps(options: FixtureOpsOptions = {}): WinfsOps {
  const info = async (absolutePath: string): Promise<WinfsVolumeInfo | WinfsError> => {
    try {
      const s = await stat(absolutePath);
      return {
        ok: true,
        path: absolutePath,
        drive_type: 'fixed',
        file_system: 'NTFS',
        file_system_flags: 0,
        volume_label: null,
        max_component_length: 255,
        volume_id: VOLUME_ID,
        file_id: fileIdOf(absolutePath),
        link_count: 1,
        is_directory: s.isDirectory(),
        is_reparse: false,
        recall_on_open: false,
        recall_on_data_access: false,
        is_cloud_placeholder: false,
        volume_info_available: true,
      };
    } catch {
      return failed('NOT_FOUND', 2, `不存在的路径 ${absolutePath}`);
    }
  };

  return {
    capability: () =>
      Promise.resolve({
        available: true,
        backend: 'powershell-pinvoke',
        resolved_backend_reason: '夹具桩：事实来自真实文件系统，不是真实护栏',
        supports_exclusive_handle: false,
        supports_flush: false,
        supports_create_new: false,
        supports_reparse_detection: false,
        supports_file_identity: true,
        supports_hardlink_count: false,
        crash_atomic_replace: false,
        cross_file_transaction: false,
        verified_on: null,
        notes: ['本桩不主张任何写入能力；工具面的七个工具全部是读取类。'],
      }),
    statVolume: (req) => info(req.path),

    validatePath: (req) =>
      Promise.resolve({
        ok: true as const,
        segments: req.relative_path.split('/').filter((s) => s.length > 0),
        normalized: req.relative_path,
      }),

    resolvePath: async (req) => {
      const absolutePath = absoluteOf(req);
      const facts = await info(absolutePath);
      if (facts.ok === false) return facts;

      const wrongKind =
        (req.expect === 'file' && facts.is_directory) ||
        (req.expect === 'directory' && !facts.is_directory);
      if (wrongKind) {
        return failed(
          'NOT_FOUND',
          2,
          `${req.relative_path} 的实际类型与请求的 ${req.expect} 不符`,
        );
      }

      let size = 0;
      if (!facts.is_directory) {
        try {
          size = (await stat(absolutePath)).size;
        } catch {
          return failed('NOT_FOUND', 2, `读取大小失败 ${req.relative_path}`);
        }
      }

      return {
        ok: true,
        relative_path: req.relative_path,
        canonical_relative_path: req.relative_path,
        identity: { volume_id: facts.volume_id, file_id: facts.file_id, link_count: 1 },
        size,
        sha256: '',
        bytes_base64: '',
        attributes: {
          is_reparse: false,
          is_directory: facts.is_directory,
          names: facts.is_directory ? ['directory'] : ['archive'],
        },
      } satisfies WinfsReadResult;
    },

    readFileGuarded: async (req) => {
      const absolutePath = absoluteOf(req);
      const facts = await info(absolutePath);
      if (facts.ok === false) return facts;
      if (facts.is_directory) return failed('NOT_FOUND', 2, `${req.relative_path} 是目录`);

      const replaced = options.mutate?.get(req.relative_path);
      const bytes =
        replaced === undefined
          ? await readFile(absolutePath)
          : Buffer.from(replaced, 'utf8');

      return {
        ok: true,
        relative_path: req.relative_path,
        canonical_relative_path: req.relative_path,
        identity: { volume_id: facts.volume_id, file_id: facts.file_id, link_count: 1 },
        size: bytes.length,
        sha256: sha256(bytes),
        bytes_base64: bytes.toString('base64'),
        attributes: { is_reparse: false, is_directory: false, names: ['archive'] },
      } satisfies WinfsReadResult;
    },

    writeFileGuarded: () => {
      throw new Error('夹具桩：写操作不在工具面范围内');
    },
    createFileGuarded: () => {
      throw new Error('夹具桩：写操作不在工具面范围内');
    },

    listDirectory: async (req: WinfsListRequest): Promise<WinfsListResult | WinfsError> => {
      const absolutePath = absoluteOf(req);
      let entries;
      try {
        entries = await readdir(absolutePath, { withFileTypes: true });
      } catch {
        return failed('NOT_FOUND', 2, `无法列举 ${req.relative_path || '(根)'}`);
      }

      // 顺序必须与护栏一致（`CompareOrdinal`，即 UTF-16 码元序），
      // 否则游标续读的语义就与真机不同，而那种差异在真机上才暴露。
      const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const after = req.after_name ?? '';
      const rest = sorted.filter((entry) => entry.name > after);
      const max = req.max_entries ?? rest.length;
      const page = rest.slice(0, max);

      const prefix = req.relative_path === '' ? '' : `${req.relative_path}/`;
      return {
        ok: true,
        relative_path: req.relative_path,
        canonical_relative_path: req.relative_path,
        entries: await Promise.all(
          page.map(async (entry) => {
            const childAbs = path.join(absolutePath, entry.name);
            let size: number | null = null;
            if (entry.isFile()) {
              try {
                size = (await stat(childAbs)).size;
              } catch {
                size = null;
              }
            }
            return {
              name: entry.name,
              relative_path: `${prefix}${entry.name}`,
              type: entry.isDirectory() ? ('directory' as const) : ('file' as const),
              size,
              is_reparse: false,
            };
          }),
        ),
        has_more: rest.length > page.length,
      };
    },
  };
}
