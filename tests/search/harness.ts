/**
 * 搜索测试的公用装置（LWB-015）。
 *
 * 桩护栏**只回答事实**：目录里有什么、按什么顺序、某个对象现在是什么身份、
 * 某个文件的字节是什么。判定（谁不进、谁的命中不返回、什么时候停）全部属于
 * 被测模块 —— 桩里一点都不能有，否则测到的只是桩自己。
 *
 * 与 `tests/unit/files-list.test.ts` 的桩是同一套语义（ordinal 排序、
 * `after_name` 过滤、`max_entries` 截断与 `has_more`），因为两者背后是
 * 同一个护栏（`native/winfs/WinfsGuard.ps1` 的 `Op-ListDirectory`）。
 *
 * ## 桩必须交付**真实字节**
 *
 * 搜索的每一层判据都落在字节上：是不是文本、有没有秘密、片段是哪一段。
 * 因此 `readFileGuarded` 返回的是真正的 base64 内容，而不是一个长度 ——
 * 一个只报长度的桩会把「内容里有什么」这件事整个测掉。
 */

import assert from 'node:assert/strict';

import type { WinfsError, WinfsListRequest, WinfsListResult, WinfsOps, WinfsPathRef, WinfsReadResult } from '@lwb/winfs';
import type { PolicyAction, PolicyDecision } from '@lwb/policy';
import { decide } from '@lwb/policy';
import { EgressBudget } from '@lwb/egress';
import { createReadTicketAuthority, type ReadScope } from '@lwb/files';
import type { SearchDeps, SearchLimits } from '@lwb/search';

export const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
export const VOLUME = 'c6e22015';
export const CONNECTION = 'conn-1';
export const KEY = 'lwb-test-key-0123456789abcdef0123456789abcdef';
/** 护栏 `$SCRIPT:LIST_HARD_CAP` 的镜像值：桩按它夹取 `max_entries`。 */
export const GUARD_CAP = 1000;

export interface FileSpec {
  /** 文件内容。字符串按 UTF-8 编码；也可以直接给字节。 */
  readonly content: string | Buffer;
  readonly is_reparse?: boolean;
  /** 探针报出来的大小与真实字节不同 —— 用来构造「读到一半被换掉」。 */
  readonly size_override?: number;
  /** 读取时返回 NOT_FOUND（读到之前被删了）。 */
  readonly vanish_on_read?: boolean;
  /** 读取时返回 FILE_BUSY（被别的进程独占）。 */
  readonly busy_on_read?: boolean;
  /** 读取时返回 PERMISSION_DENIED。 */
  readonly denied_on_read?: boolean;
  /**
   * **读取**时报告的对象身份与探针不同 —— 构造「两次打开之间对象被换掉」。
   *
   * 只影响读取那一次：两次都报同一个值的话，身份比对永远相等，
   * `unstable` 这条路就测不出来。
   */
  readonly file_id_override?: string;
  /**
   * 还能被 `resolvePath` 找到，但**不再出现在目录列举里**。
   *
   * 构造「探针与列举之间被删掉」这个竞态：搜索是长操作，这两次调用之间
   * 隔着一段时间，而文件真的可能在那段时间里消失。
   */
  readonly hidden_from_listing?: boolean;
}

export interface DirSpec {
  readonly is_reparse?: boolean;
  /** 列举它时返回 NOT_FOUND（遍历途中被删）。 */
  readonly vanishing?: boolean;
}

export type NodeSpec = FileSpec | DirSpec;

export function fileOf(content: string | Buffer, extra: Omit<FileSpec, 'content'> = {}): FileSpec {
  return { content, ...extra };
}

export function dirOf(extra: DirSpec = {}): DirSpec {
  return { ...extra };
}

function isFile(spec: NodeSpec): spec is FileSpec {
  return 'content' in spec;
}

export function bytesOf(spec: FileSpec): Buffer {
  return typeof spec.content === 'string' ? Buffer.from(spec.content, 'utf8') : spec.content;
}

/** 把「路径 → 节点」的扁平表补齐成树；中间目录自动补成普通目录。 */
export function treeOf(entries: Readonly<Record<string, NodeSpec>>): Map<string, NodeSpec> {
  const tree = new Map<string, NodeSpec>();
  tree.set('', dirOf());
  for (const [path, node] of Object.entries(entries)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join('/');
      if (!tree.has(dir)) tree.set(dir, dirOf());
    }
    tree.set(path, node);
  }
  return tree;
}

function childrenOf(tree: Map<string, NodeSpec>, dir: string): { name: string; path: string; node: NodeSpec }[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const out: { name: string; path: string; node: NodeSpec }[] = [];
  for (const [path, node] of tree) {
    if (path === '' || !path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest.includes('/')) continue;
    if (isFile(node) && node.hidden_from_listing === true) continue;
    out.push({ name: rest, path, node });
  }
  // `sort()` 默认按 UTF-16 码元比较，与护栏的 CompareOrdinal 是同一套顺序。
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

export interface OpsCalls {
  resolve: number;
  list: number;
  read: number;
  /** 每次目录询问的 (路径, after_name, max_entries)。 */
  readonly listed: { path: string; after: string; max: number | undefined }[];
  /** 每次受控读取的路径。**用于证明「哪些文件一个字节都没读」。** */
  readonly read_paths: string[];
}

export interface StubOps {
  readonly ops: WinfsOps;
  readonly calls: OpsCalls;
}

export function makeOps(tree: Map<string, NodeSpec>): StubOps {
  const calls: OpsCalls = { resolve: 0, list: 0, read: 0, listed: [], read_paths: [] };

  const failed = (code: WinfsError['code'], path: string, win32: number): WinfsError => ({
    ok: false,
    code,
    message: `桩：${path} → ${code}`,
    win32_error: win32,
  });

  /** 对象身份。`file_id_override` 只在 `read` 这一次生效，见 `FileSpec` 的注释。 */
  const identityOf = (
    path: string,
    node: NodeSpec,
    phase: 'probe' | 'read',
  ): { volume_id: string; file_id: string; link_count: number } => ({
    volume_id: VOLUME,
    file_id:
      phase === 'read' && isFile(node) && node.file_id_override !== undefined
        ? node.file_id_override
        : `id:${path}`,
    link_count: 1,
  });

  const resolveResult = (path: string, node: NodeSpec): WinfsReadResult => ({
    ok: true,
    relative_path: path,
    canonical_relative_path: path,
    identity: identityOf(path, node, 'probe'),
    size: isFile(node) ? (node.size_override ?? bytesOf(node).length) : 0,
    sha256: '',
    bytes_base64: '',
    attributes: {
      is_reparse: node.is_reparse === true,
      is_directory: !isFile(node),
      names: isFile(node) ? ['archive'] : ['directory'],
    },
  });

  const ops: WinfsOps = {
    capability: () => {
      throw new Error('桩：搜索不使用 capability');
    },
    statVolume: () => {
      throw new Error('桩：搜索不使用 statVolume');
    },
    validatePath: (req: { relative_path: string }) =>
      Promise.resolve({
        ok: true as const,
        segments: req.relative_path.split('/').filter((s) => s.length > 0),
        normalized: req.relative_path,
      }),
    resolvePath: (req: WinfsPathRef & { expect: 'file' | 'directory' | 'any' }) => {
      calls.resolve += 1;
      const node = tree.get(req.relative_path);
      return Promise.resolve(node === undefined ? failed('NOT_FOUND', req.relative_path, 2) : resolveResult(req.relative_path, node));
    },
    readFileGuarded: (req: WinfsPathRef): Promise<WinfsReadResult | WinfsError> => {
      calls.read += 1;
      calls.read_paths.push(req.relative_path);
      const node = tree.get(req.relative_path);
      if (node === undefined || !isFile(node)) return Promise.resolve(failed('NOT_FOUND', req.relative_path, 2));
      if (node.vanish_on_read === true) return Promise.resolve(failed('NOT_FOUND', req.relative_path, 2));
      if (node.busy_on_read === true) return Promise.resolve(failed('FILE_BUSY', req.relative_path, 32));
      if (node.denied_on_read === true) return Promise.resolve(failed('PERMISSION_DENIED', req.relative_path, 5));
      const bytes = bytesOf(node);
      return Promise.resolve({
        ok: true,
        relative_path: req.relative_path,
        canonical_relative_path: req.relative_path,
        identity: identityOf(req.relative_path, node, 'read'),
        size: bytes.length,
        sha256: '',
        bytes_base64: bytes.toString('base64'),
        attributes: { is_reparse: node.is_reparse === true, is_directory: false, names: ['archive'] },
      });
    },
    writeFileGuarded: () => {
      throw new Error('桩：写操作不在本测试范围');
    },
    createFileGuarded: () => {
      throw new Error('桩：写操作不在本测试范围');
    },
    listDirectory: (req: WinfsListRequest): Promise<WinfsListResult | WinfsError> => {
      calls.list += 1;
      calls.listed.push({ path: req.relative_path, after: req.after_name ?? '', max: req.max_entries });

      const node = tree.get(req.relative_path);
      if (node === undefined || isFile(node) || node.vanishing === true) {
        return Promise.resolve(failed('NOT_FOUND', req.relative_path, 2));
      }

      const after = req.after_name ?? '';
      const rest = childrenOf(tree, req.relative_path).filter((c) => c.name > after);
      const max = Math.min(req.max_entries ?? GUARD_CAP, GUARD_CAP);
      const page = rest.slice(0, max);

      return Promise.resolve({
        ok: true,
        relative_path: req.relative_path,
        canonical_relative_path: req.relative_path,
        entries: page.map((c) => ({
          name: c.name,
          relative_path: c.path,
          type: isFile(c.node) ? 'file' : 'directory',
          size: isFile(c.node) ? (c.node.size_override ?? bytesOf(c.node).length) : null,
          is_reparse: c.node.is_reparse === true,
        })),
        has_more: rest.length > max,
      });
    },
  };

  return { ops, calls };
}

export function scopeOf(overrides: Partial<ReadScope> = {}): ReadScope {
  return {
    workspace_id: 'ws-1',
    kind: 'directory',
    mode: 'read_propose_apply_with_local_approval',
    generation: 1,
    root_path: 'C:\\work\\proj',
    root_volume_id: VOLUME,
    root_file_id: 'root-0001',
    ...overrides,
  };
}

/** 单文件工作区：整个工作区就是根的那一个文件。 */
export function fileScopeOf(overrides: Partial<ReadScope> = {}): ReadScope {
  return scopeOf({ kind: 'file', root_path: 'C:\\work\\notes\\todo.md', ...overrides });
}

/**
 * 铸造一份**允许**的判定结果。
 *
 * `path` 默认空串，理由与读取/列举侧相同：本文件多数用例要验的是
 * 「上层给了允许，闸门与遍历仍然自己拦下」；用真实敏感路径去 `decide()`
 * 会先在策略层被拒，那样测到的就不是这一层了。
 */
export function allowedDecision(action: PolicyAction = 'search', path = ''): PolicyDecision {
  const decision = decide({
    connection: {
      connection_id: CONNECTION,
      enabled: true,
      granted_capabilities: ['read', 'search', 'list', 'git_read', 'propose'],
      audience: 'mcp_adapter',
      granted_workspace_ids: ['ws-1'],
    },
    workspace: {
      workspace_id: 'ws-1',
      kind: 'directory',
      mode: 'read_propose_apply_with_local_approval',
      capabilities: {
        read_enabled: true,
        git_enabled: true,
        proposal_enabled: true,
        direct_write_enabled: true,
        recovery_required: false,
      },
      current_generation: 1,
      current_policy_version: 1,
      root_volume_id: VOLUME,
      root_file_id: 'root-0001',
      paused: false,
    },
    presented: { generation: null, policy_version: null },
    action: { action: action as PolicyAction, path, approval: null },
    now: NOW,
  });
  assert.equal(decision.allow, true, `装置前提：${action} 应被允许，实际 ${decision.primary?.reason ?? '(none)'}`);
  return decision;
}

export interface SearchDepsOptions {
  readonly limits?: Partial<SearchLimits>;
  readonly clock?: () => number;
  readonly is_cancelled?: () => boolean;
  readonly budget_limit?: number;
}

export function depsFor(ops: WinfsOps, options: SearchDepsOptions = {}): SearchDeps {
  return {
    ops,
    authority: createReadTicketAuthority({ key: KEY }),
    budget: new EgressBudget({ limit_bytes_per_hour: options.budget_limit ?? 64 * 1024 * 1024, now: () => NOW }),
    clock: options.clock ?? (() => NOW),
    ...(options.is_cancelled === undefined ? {} : { is_cancelled: options.is_cancelled }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  };
}

export interface SearchOptions {
  readonly query: string;
  readonly path?: string;
  readonly path_glob?: string;
  readonly case_sensitive?: boolean;
  readonly cursor?: string;
  readonly max_matches?: number;
  readonly scope?: Partial<ReadScope>;
  readonly decision?: PolicyDecision;
}

export function searchArgs(options: SearchOptions) {
  const base = options.scope?.kind === 'file' ? fileScopeOf() : scopeOf();
  return {
    scope: options.scope === undefined ? base : { ...base, ...options.scope },
    connection_id: CONNECTION,
    decision: options.decision ?? allowedDecision(),
    input: {
      workspace_id: 'ws-1',
      query: options.query,
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.path_glob === undefined ? {} : { path_glob: options.path_glob }),
      ...(options.case_sensitive === undefined ? {} : { case_sensitive: options.case_sensitive }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.max_matches === undefined ? {} : { max_matches: options.max_matches }),
    },
    now: NOW,
  };
}
