/**
 * 分页目录列举（LWB-014）。
 *
 * ## 这个文件用**桩护栏**，判据是「调用了什么」而不只是「返回了什么」
 *
 * 目录列举的三条验收标准里有两条是关于**没发生的事**：「大量文件时有界」
 * 说的是没有走完整棵树，「不泄露拒绝对象」说的是名字没有出现在任何地方。
 * 这两件事都无法由返回值的形状证明，只能由调用计数与全文断言证明：
 *
 *  - `calls.list` 证明遍历在哪里停下（例如 500 个文件的目录只问了一次）；
 *  - `JSON.stringify(result).includes('.env') === false` 证明名字没有从
 *    `entries` 之外的某个字段漏出去（`incomplete_reason`、错误消息、游标）。
 *
 * 桩护栏**只回答事实**：它按 ordinal 排序、按 `after_name` 过滤、按
 * `max_entries` 截断并给出 `has_more`，与 `native/winfs/WinfsGuard.ps1` 的
 * `Op-ListDirectory` 同一套语义。判定（哪个条目不返回、要不要递归）全部属于
 * 被测模块，桩里一点都不能有 —— 否则测到的只是桩自己。
 *
 * 真实 NTFS + 真实护栏下的同一批断言在 `tests/windows/files-list.test.ts`。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BridgeError } from '@lwb/contracts';
import type { PolicyAction, PolicyDecision } from '@lwb/policy';
import { decide } from '@lwb/policy';
import { EgressBudget } from '@lwb/egress';
import {
  DEFAULT_LIST_LIMITS,
  assertListCursorMatches,
  createReadTicketAuthority,
  listDirectory,
  type ListDeps,
  type ListLimits,
  type ReadScope,
} from '@lwb/files';
import type { WinfsDirEntry, WinfsError, WinfsListRequest, WinfsListResult, WinfsOps, WinfsPathRef, WinfsReadResult } from '@lwb/winfs';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const VOLUME = 'c6e22015';
const CONNECTION = 'conn-1';
const KEY = 'lwb-test-key-0123456789abcdef0123456789abcdef';
/** 护栏 `$SCRIPT:LIST_HARD_CAP` 的镜像值：桩按它夹取 `max_entries`。 */
const GUARD_CAP = 1000;

interface NodeSpec {
  readonly kind: 'file' | 'directory';
  readonly size?: number;
  readonly is_reparse?: boolean;
  readonly file_id?: string;
  /** 列举这个目录时返回 NOT_FOUND（模拟遍历途中目录被删）。 */
  readonly vanishing?: boolean;
}

function fileOf(size: number, extra: Omit<NodeSpec, 'kind' | 'size'> = {}): NodeSpec {
  return { kind: 'file', size, ...extra };
}

function dirOf(extra: Omit<NodeSpec, 'kind'> = {}): NodeSpec {
  return { kind: 'directory', ...extra };
}

/** 把「路径 → 节点」的扁平表补齐成树；中间目录自动补成普通目录。 */
function treeOf(entries: Readonly<Record<string, NodeSpec>>): Map<string, NodeSpec> {
  const tree = new Map<string, NodeSpec>();
  tree.set('', dirOf({ file_id: 'root-0001' }));
  for (const [path, node] of Object.entries(entries)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join('/');
      if (!tree.has(dir)) tree.set(dir, dirOf({ file_id: `dir:${dir}` }));
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
    out.push({ name: rest, path, node });
  }
  // `sort()` 默认按 UTF-16 码元比较，与护栏的 CompareOrdinal 是同一套顺序。
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

interface OpsCalls {
  resolve: number;
  list: number;
  /** 每次目录询问的 (路径, after_name, max_entries)，用于证明「问了几次、问了谁」。 */
  readonly listed: { path: string; after: string; max: number | undefined }[];
}

function makeOps(tree: Map<string, NodeSpec>): { ops: WinfsOps; calls: OpsCalls } {
  const calls: OpsCalls = { resolve: 0, list: 0, listed: [] };

  const notFound = (path: string): WinfsError => ({
    ok: false,
    code: 'NOT_FOUND',
    message: `不存在：${path}`,
    win32_error: 2,
  });

  const resolveResult = (path: string, node: NodeSpec): WinfsReadResult => ({
    ok: true,
    relative_path: path,
    canonical_relative_path: path,
    identity: { volume_id: VOLUME, file_id: node.file_id ?? `id:${path}`, link_count: 1 },
    size: node.size ?? 0,
    sha256: '',
    bytes_base64: '',
    attributes: {
      is_reparse: node.is_reparse === true,
      is_directory: node.kind === 'directory',
      names: node.kind === 'directory' ? ['directory'] : ['archive'],
    },
  });

  const ops: WinfsOps = {
    capability: () => {
      throw new Error('桩：本测试不使用 capability');
    },
    statVolume: () => {
      throw new Error('桩：本测试不使用 statVolume');
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
      return Promise.resolve(node === undefined ? notFound(req.relative_path) : resolveResult(req.relative_path, node));
    },
    readFileGuarded: () => {
      throw new Error('桩：本测试不使用读取');
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
      if (node === undefined || node.vanishing === true || node.kind !== 'directory') {
        return Promise.resolve(notFound(req.relative_path));
      }

      const after = req.after_name ?? '';
      const rest = childrenOf(tree, req.relative_path).filter((c) => c.name > after);
      const max = Math.min(req.max_entries ?? GUARD_CAP, GUARD_CAP);
      const page = rest.slice(0, max);

      const entries: WinfsDirEntry[] = page.map((c) => ({
        name: c.name,
        relative_path: c.path,
        type: c.node.kind,
        size: c.node.kind === 'directory' || c.node.is_reparse === true ? null : (c.node.size ?? 0),
        is_reparse: c.node.is_reparse === true,
      }));

      return Promise.resolve({
        ok: true,
        relative_path: req.relative_path,
        canonical_relative_path: req.relative_path,
        entries,
        has_more: rest.length > max,
      });
    },
  };

  return { ops, calls };
}

function scopeOf(overrides: Partial<ReadScope> = {}): ReadScope {
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

/**
 * 铸造一份**允许**的判定结果。
 *
 * `path` 默认空串，理由与读取侧相同：本文件多数用例要验的是「上层给了允许，
 * 闸门/过滤仍然自己拦下」；用真实敏感路径去 `decide()` 会先在策略层被拒，
 * 那样测到的就不是这一层了。
 */
function allowedDecision(action: PolicyAction = 'list', path = ''): PolicyDecision {
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
    action: { action, path, approval: null },
    now: NOW,
  });
  assert.equal(decision.allow, true, `装置前提：${action} 应被允许，实际 ${decision.primary?.reason ?? '(none)'}`);
  return decision;
}

function depsFor(ops: WinfsOps, limits: Partial<ListLimits> = {}): ListDeps {
  return {
    ops,
    authority: createReadTicketAuthority({ key: KEY }),
    budget: new EgressBudget({ limit_bytes_per_hour: 64 * 1024 * 1024, now: () => NOW }),
    limits,
  };
}

interface ListOptions {
  readonly path?: string;
  readonly cursor?: string;
  readonly max_entries?: number;
  readonly depth?: number;
  readonly scope?: Partial<ReadScope>;
  readonly decision?: PolicyDecision;
}

function listArgs(options: ListOptions = {}) {
  return {
    scope: scopeOf(options.scope),
    connection_id: CONNECTION,
    decision: options.decision ?? allowedDecision('list'),
    input: {
      workspace_id: 'ws-1',
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.max_entries === undefined ? {} : { max_entries: options.max_entries }),
      ...(options.depth === undefined ? {} : { depth: options.depth }),
    },
    now: NOW,
  };
}

async function expectListError(code: string, fn: () => Promise<unknown>, hint: string): Promise<BridgeError> {
  try {
    await fn();
  } catch (cause) {
    assert.ok(cause instanceof BridgeError, `${hint}：期望 BridgeError，实际 ${String(cause)}`);
    assert.equal(cause.code, code, `${hint} 的错误码（消息：${cause.message}）`);
    return cause;
  }
  assert.fail(`${hint}：应当抛出 ${code}`);
}

/**
 * 一份跨多条验收标准的固定树。
 *
 * 三种目录刻意各放一个：**硬拒绝**（`.ssh`，HD-CREDENTIAL-STORE）、
 * **搜索排除**（`node_modules`）、**重解析点**（`link`）。它们在遍历里的
 * 处置各不相同，且都不是「跳过」两个字能概括的：
 *
 *  - `.ssh` 连名字都不返回，也不进入；
 *  - `node_modules` 返回、带 excluded 标记、但不进入（显式列举仍然可读）；
 *  - `link` 返回、带 excluded 标记、不进入，且**不去 stat**（size 保持 null）。
 */
function standardTree(): Map<string, NodeSpec> {
  return treeOf({
    'a.txt': fileOf(10),
    'B.txt': fileOf(20),
    'Zebra.txt': fileOf(30),
    '.env': fileOf(50),
    '.ssh/known_hosts': fileOf(60),
    'docs/readme.md': fileOf(80),
    'ghp_012345678901234567890123456789012345.txt': fileOf(70),
    'link': dirOf({ is_reparse: true }),
    'node_modules/pkg/index.js': fileOf(400),
    'src/main.ts': fileOf(100),
    'src/lib/util.ts': fileOf(200),
    'src/lib/deep/x.ts': fileOf(300),
  });
}

// ---------------------------------------------------------------------------
// 1. 有界、有序、可续（验收标准 1）
// ---------------------------------------------------------------------------

describe('LWB-014 有界：攒满一页就停止遍历，而不是走完再截断', () => {
  it('500 个文件的目录只问护栏一次，返回一页与一个游标', async () => {
    const big: Record<string, NodeSpec> = {};
    for (let i = 0; i < 500; i += 1) big[`f${String(i).padStart(4, '0')}.txt`] = fileOf(i);
    const { ops, calls } = makeOps(treeOf(big));

    const result = await listDirectory(listArgs(), depsFor(ops));

    assert.equal(result.entries.length, DEFAULT_LIST_LIMITS.max_directory_entries);
    assert.equal(result.entries[0]?.name, 'f0000.txt');
    assert.equal(result.entries.at(-1)?.name, 'f0199.txt');
    assert.notEqual(result.next_cursor, null);
    assert.equal(result.truncated, true);
    assert.equal(result.incomplete, true);
    // 页满了就不该再有第二次询问 —— 这一条才是「有界」。
    assert.equal(calls.list, 1, `目录询问次数：${String(calls.list)}`);
    // 多要的那一条不是浪费，它是「还有下一页」的证据。
    assert.equal(calls.listed[0]?.max, 201);
  });

  it('护栏硬上限小于页面上限时，同一个目录会按窗口续取（不静默少列）', async () => {
    const big: Record<string, NodeSpec> = {};
    for (let i = 0; i < 1500; i += 1) big[`f${String(i).padStart(4, '0')}.txt`] = fileOf(i);
    const { ops, calls } = makeOps(treeOf(big));

    const result = await listDirectory(listArgs(), depsFor(ops, { max_directory_entries: 1500 }));

    assert.equal(result.entries.length, 1500);
    assert.equal(result.entries.at(-1)?.name, 'f1499.txt');
    assert.equal(result.next_cursor, null, '列完了就不该还有游标');
    assert.equal(result.truncated, false);
    assert.equal(calls.list, 2, `两次窗口：第一次要 1501 被夹到 1000，第二次接着取`);
    assert.equal(calls.listed[0]?.max, 1000);
    assert.equal(calls.listed[1]?.max, 501);
    assert.equal(calls.listed[1]?.after, 'f0999.txt');
  });

  it('条目按 UTF-16 码元序返回，且与护栏的顺序一致', async () => {
    const { ops } = makeOps(treeOf({ 'b.txt': fileOf(1), 'B.txt': fileOf(2), 'a.txt': fileOf(3), 'Z.txt': fileOf(4), '0.txt': fileOf(5) }));
    const result = await listDirectory(listArgs(), depsFor(ops));
    assert.deepEqual(
      result.entries.map((e) => e.name),
      ['0.txt', 'B.txt', 'Z.txt', 'a.txt', 'b.txt'],
    );
  });

  it('翻页拼接与一次列完完全一致（不重不漏）', async () => {
    const { ops } = makeOps(standardTree());
    const all = await listDirectory(listArgs(), depsFor(ops));
    assert.equal(all.next_cursor, null);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await listDirectory(
        listArgs({ max_entries: 3, ...(cursor === null ? {} : { cursor }) }),
        depsFor(ops),
      );
      seen.push(...page.entries.map((e) => e.path));
      cursor = page.next_cursor;
      pages += 1;
      assert.ok(pages < 20, '页数异常，可能没有推进');
    } while (cursor !== null);

    assert.deepEqual(seen, all.entries.map((e) => e.path));
    assert.equal(all.entries.length, 7);
  });

  it('max_entries 只能收紧，不能被请求放大', async () => {
    const { ops } = makeOps(standardTree());
    const result = await listDirectory(listArgs({ max_entries: 100000 }), depsFor(ops));
    assert.ok(result.entries.length <= DEFAULT_LIST_LIMITS.max_directory_entries);
  });
});

// ---------------------------------------------------------------------------
// 2. 先过滤后进入（验收标准 2、3）
// ---------------------------------------------------------------------------

describe('LWB-014 过滤：拒绝的对象连名字都不出现', () => {
  it('命中硬拒绝规则的条目既不返回，也不出现在任何字段或错误文本里', async () => {
    const { ops, calls } = makeOps(standardTree());
    const result = await listDirectory(listArgs(), depsFor(ops));

    assert.equal(result.denied_entries, 3, '.env、.ssh 与名字像令牌的文件');
    const serialized = JSON.stringify(result);
    for (const denied of ['.env', '.ssh', 'ghp_']) {
      assert.equal(serialized.includes(denied), false, `结果里出现了被拒绝的名字 ${denied}：${serialized}`);
    }
    // 被拒绝的目录也不该被进入：一次目录询问都没有落到它们身上。
    assert.equal(calls.listed.some((c) => c.path.includes('.env') || c.path.includes('.ssh')), false);
  });

  it('文件名本身命中 certain 级秘密时不返回；likely 档不参与（避免吞掉合法文件名）', async () => {
    const { ops } = makeOps(
      treeOf({
        'AKIAIOSFODNN7EXAMPLE.txt': fileOf(1),
        'TOKEN=0123456789abcdef0123456789abcdef.txt': fileOf(2),
        'normal.txt': fileOf(3),
      }),
    );
    const result = await listDirectory(listArgs(), depsFor(ops));

    assert.deepEqual(
      result.entries.map((e) => e.name),
      ['TOKEN=0123456789abcdef0123456789abcdef.txt', 'normal.txt'],
    );
    assert.equal(result.denied_entries, 1);
  });

  it('搜索排除目录会返回并标记 excluded，但不进入它', async () => {
    const { ops, calls } = makeOps(standardTree());
    const result = await listDirectory(listArgs({ depth: 3 }), depsFor(ops));

    const deps = result.entries.find((e) => e.path === 'node_modules');
    assert.ok(deps, '被排除的目录本身应当出现在列表里');
    assert.equal(deps.excluded, true);
    assert.equal(result.entries.some((e) => e.path.startsWith('node_modules/')), false);
    assert.equal(calls.listed.some((c) => c.path === 'node_modules'), false);
  });

  it('显式列举被排除的目录仍然拿得到内容（「不扫」不是「不许读」）', async () => {
    const { ops } = makeOps(standardTree());
    const result = await listDirectory(listArgs({ path: 'node_modules' }), depsFor(ops));

    assert.deepEqual(
      result.entries.map((e) => e.path),
      ['node_modules/pkg'],
    );
    assert.equal(result.entries[0]?.excluded, true, '它自身仍带排除标记');
  });

  it('重解析点不进入、不去 stat（长度保持在 null）', async () => {
    const { ops, calls } = makeOps(standardTree());
    const result = await listDirectory(listArgs({ depth: 3 }), depsFor(ops));

    const link = result.entries.find((e) => e.path === 'link');
    assert.ok(link);
    assert.equal(link.excluded, true);
    assert.equal(link.size, null);
    assert.equal(calls.listed.some((c) => c.path === 'link'), false);
  });

  it('起点目录命中硬拒绝时，一次目录询问都不发生', async () => {
    const { ops, calls } = makeOps(treeOf({ '.lwb/state.json': fileOf(1), 'ok.txt': fileOf(2) }));
    await expectListError('POLICY_DENIED', () => listDirectory(listArgs({ path: '.lwb' }), depsFor(ops)), '列举插件状态目录');
    assert.equal(calls.list, 0);
  });

  it('起点不是目录时拒绝，并指路 file_read（护栏的 expect 不执行这条判断，所以必须由本层判）', async () => {
    const { ops, calls } = makeOps(standardTree());
    const error = await expectListError(
      'INVALID_ARGUMENT',
      () => listDirectory(listArgs({ path: 'a.txt' }), depsFor(ops)),
      '列举一个文件',
    );
    assert.equal(error.details?.['reason'], 'NOT_A_DIRECTORY');
    assert.equal(calls.list, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. 深度、不完整状态与失败
// ---------------------------------------------------------------------------

describe('LWB-014 深度与不完整状态', () => {
  it('depth 省略时只列当前层，并说明下面还有目录没进', async () => {
    const { ops, calls } = makeOps(standardTree());
    const result = await listDirectory(listArgs(), depsFor(ops));

    assert.deepEqual(
      result.entries.map((e) => e.path),
      ['B.txt', 'Zebra.txt', 'a.txt', 'docs', 'link', 'node_modules', 'src'],
    );
    assert.equal(result.scanned_entries, 10, '枚举过 10 条（含被拒绝的三条）');
    assert.equal(result.excluded_entries, 2, 'link 与 node_modules');
    assert.equal(result.incomplete, true);
    assert.match(result.incomplete_reason ?? '', /深度上限 depth=0/);
    // 只有「本来可以进入」的目录才算被深度挡下：被排除的不算，被拒绝的更不算。
    assert.match(result.incomplete_reason ?? '', /2 个目录未进入/);
    assert.equal(calls.listed.some((c) => c.path !== ''), false, '不该有第二次询问');
  });

  it('depth=1 会进入第一层，但停在第二层并如实报告', async () => {
    const { ops } = makeOps(standardTree());
    const result = await listDirectory(listArgs({ depth: 1 }), depsFor(ops));

    assert.deepEqual(
      result.entries.map((e) => e.path),
      ['B.txt', 'Zebra.txt', 'a.txt', 'docs', 'docs/readme.md', 'link', 'node_modules', 'src', 'src/lib', 'src/main.ts'],
    );
    assert.equal(result.scanned_entries, 13);
    assert.equal(result.incomplete, true, 'src/lib 之下还有内容没看到');
    assert.match(result.incomplete_reason ?? '', /深度上限 depth=1，有 1 个目录未进入/);
  });

  it('depth=3 覆盖全树时 incomplete 为 false（这是一份完整结果）', async () => {
    const { ops } = makeOps(standardTree());
    const result = await listDirectory(listArgs({ depth: 3 }), depsFor(ops));

    assert.equal(result.incomplete, false);
    assert.equal(result.incomplete_reason, null);
    assert.equal(result.truncated, false);
    assert.equal(result.next_cursor, null);
    assert.ok(result.entries.some((e) => e.path === 'src/lib/deep/x.ts'));
  });

  it('子树枚举失败时跳过该子树，并把路径与护栏码写进不完整原因', async () => {
    const tree = treeOf({ 'gone/inside.txt': fileOf(1, { file_id: 'gone-1' }), 'ok.txt': fileOf(2) });
    tree.set('gone', dirOf({ vanishing: true, file_id: 'gone-1' }));
    const { ops } = makeOps(tree);

    const result = await listDirectory(listArgs({ depth: 1 }), depsFor(ops));

    assert.deepEqual(
      result.entries.map((e) => e.path),
      ['gone', 'ok.txt'],
    );
    assert.equal(result.incomplete, true);
    assert.match(result.incomplete_reason ?? '', /子目录 gone 未能枚举（护栏码 NOT_FOUND）/);
  });

  it('目录询问次数用尽时结束遍历，有锚点就仍可续读', async () => {
    const many: Record<string, NodeSpec> = {};
    for (let i = 0; i < 5; i += 1) many[`d${String(i)}/x.txt`] = fileOf(i);
    const { ops, calls } = makeOps(treeOf(many));

    const result = await listDirectory(listArgs({ depth: 3 }), depsFor(ops, { max_directory_listings: 2 }));

    assert.equal(calls.list, 2);
    assert.equal(result.incomplete, true);
    assert.match(result.incomplete_reason ?? '', /目录询问次数已达到上限 2/);
    assert.notEqual(result.next_cursor, null, '已返回的条目就是有效的锚点');
    assert.equal(result.truncated, true);

    // 用这个游标接着读，能拿到剩下的条目。
    const rest = await listDirectory(listArgs({ depth: 3, cursor: result.next_cursor ?? undefined }), depsFor(ops, { max_directory_listings: 5 }));
    const joined = [...result.entries.map((e) => e.path), ...rest.entries.map((e) => e.path)];
    assert.deepEqual(joined, ['d0', 'd0/x.txt', 'd1', 'd1/x.txt', 'd2', 'd2/x.txt', 'd3', 'd3/x.txt', 'd4', 'd4/x.txt']);
  });

  it('预算为 0（本地把列举整个关掉）时一次询问都不发生，也没有锚点可续', async () => {
    const { ops, calls } = makeOps(standardTree());

    const result = await listDirectory(listArgs(), depsFor(ops, { max_directory_listings: 0 }));

    assert.equal(calls.list, 0);
    assert.deepEqual(result.entries, []);
    assert.equal(result.next_cursor, null, '没有任何已返回条目 ⇒ 没有锚点 ⇒ 不发游标');
    assert.equal(result.truncated, false);
    assert.equal(result.incomplete, true);
    assert.match(result.incomplete_reason ?? '', /上限 0/);
    assert.match(result.incomplete_reason ?? '', /没有可续读的锚点/);
  });
});

// ---------------------------------------------------------------------------
// 4. 游标绑定与失效（验收标准 1 的后半句）
// ---------------------------------------------------------------------------

describe('LWB-014 游标：绑定查询与工作区代次，失效就说失效', () => {
  function mintCursor(
    authority: ListDeps['authority'],
    overrides: Partial<Parameters<ListDeps['authority']['mintListCursor']>[0]> = {},
  ): string {
    return authority.mintListCursor(
      {
        connection_id: CONNECTION,
        workspace_id: 'ws-1',
        generation: 1,
        base_path: '',
        base_volume_id: VOLUME,
        base_file_id: 'root-0001',
        anchor_path: 'a.txt',
        depth: 0,
        ...overrides,
      },
      { now: NOW, ttl_ms: 60_000 },
    );
  }

  it('跨连接使用游标被拒绝', async () => {
    const { ops } = makeOps(standardTree());
    const deps = depsFor(ops);
    const cursor = mintCursor(deps.authority, { connection_id: 'conn-2' });

    const error = await expectListError(
      'READ_TOKEN_STALE',
      () => listDirectory(listArgs({ cursor }), deps),
      '跨连接游标',
    );
    assert.equal(error.details?.['reason'], 'CURSOR_CROSS_CONNECTION');
  });

  it('工作区代次变化后游标失效', async () => {
    const { ops } = makeOps(standardTree());
    const deps = depsFor(ops);
    const cursor = mintCursor(deps.authority, { generation: 2 });

    const error = await expectListError(
      'READ_TOKEN_STALE',
      () => listDirectory(listArgs({ cursor }), deps),
      '旧代次游标',
    );
    assert.equal(error.details?.['reason'], 'CURSOR_GENERATION_MISMATCH');
  });

  it('深度与游标不符时拒绝，而不是取较小值继续', async () => {
    const { ops } = makeOps(standardTree());
    const deps = depsFor(ops);
    const cursor = mintCursor(deps.authority, { depth: 2 });

    const error = await expectListError(
      'READ_TOKEN_STALE',
      () => listDirectory(listArgs({ cursor, depth: 1 }), deps),
      '深度不符的游标',
    );
    assert.equal(error.details?.['reason'], 'CURSOR_DEPTH_MISMATCH');

    // 省略 depth 时用游标里的那个，不报错。
    const ok = await listDirectory(listArgs({ cursor }), deps);
    assert.ok(ok.entries.length > 0);
  });

  it('起点目录被换成另一个对象后游标失效（身份而非字符串判定）', async () => {
    const { ops } = makeOps(standardTree());
    const deps = depsFor(ops);
    const cursor = mintCursor(deps.authority, { base_file_id: 'root-9999' });

    const error = await expectListError(
      'READ_TOKEN_STALE',
      () => listDirectory(listArgs({ cursor }), deps),
      '起点被换掉的游标',
    );
    assert.equal(error.details?.['reason'], 'CURSOR_BASE_CHANGED');
  });

  it('读取游标不能当目录列举游标用（前缀与 kind 两道）', async () => {
    const { ops } = makeOps(standardTree());
    const deps = depsFor(ops);
    const readCursor = deps.authority.mintCursor(
      {
        connection_id: CONNECTION,
        workspace_id: 'ws-1',
        generation: 1,
        canonical_path: 'a.txt',
        volume_id: VOLUME,
        file_id: 'id:a.txt',
        raw_bytes_sha256: 'x',
        next_start_line: 2,
      },
      { now: NOW, ttl_ms: 60_000 },
    );

    await expectListError(
      'READ_TOKEN_STALE',
      () => listDirectory(listArgs({ cursor: readCursor }), deps),
      '读取游标冒充列举游标',
    );
    await expectListError(
      'READ_TOKEN_STALE',
      () => listDirectory(listArgs({ cursor: 'lwblc_not-a-real-token' }), deps),
      '伪造的列举游标',
    );
  });

  it('锚点在续读前被删除时，从它的位置继续，不重复也不丢后续', async () => {
    const tree = treeOf({ 'a.txt': fileOf(1), 'b.txt': fileOf(2), 'c.txt': fileOf(3) });
    const { ops } = makeOps(tree);

    const first = await listDirectory(listArgs({ max_entries: 2 }), depsFor(ops));
    assert.deepEqual(
      first.entries.map((e) => e.name),
      ['a.txt', 'b.txt'],
    );
    assert.notEqual(first.next_cursor, null);

    tree.delete('b.txt');
    const second = await listDirectory(listArgs({ max_entries: 2, cursor: first.next_cursor ?? undefined }), depsFor(ops));
    assert.deepEqual(
      second.entries.map((e) => e.name),
      ['c.txt'],
    );
  });

  it('锚点是目录时，续读进入它内部而不是跳过它', async () => {
    const { ops } = makeOps(
      treeOf({ 'd/one.txt': fileOf(1), 'd/two.txt': fileOf(2), 'z.txt': fileOf(3) }),
    );

    const first = await listDirectory(listArgs({ max_entries: 1, depth: 1 }), depsFor(ops));
    assert.deepEqual(
      first.entries.map((e) => e.path),
      ['d'],
    );

    const seen = [...first.entries.map((e) => e.path)];
    let cursor = first.next_cursor;
    while (cursor !== null) {
      const page = await listDirectory(listArgs({ max_entries: 1, cursor }), depsFor(ops));
      seen.push(...page.entries.map((e) => e.path));
      cursor = page.next_cursor;
    }

    // 深度优先先序：d → 它的子项 → 再轮到 z.txt。
    assert.deepEqual(seen, ['d', 'd/one.txt', 'd/two.txt', 'z.txt']);
  });
});

// ---------------------------------------------------------------------------
// 5. 单文件工作区与参数形态
// ---------------------------------------------------------------------------

describe('LWB-014 单文件工作区与参数形态', () => {
  it('单文件工作区返回一条条目，路径是空串（与 file_read 的约定一致）', async () => {
    const tree = new Map<string, NodeSpec>([['', fileOf(1234, { file_id: 'root-0001' })]]);
    const { ops, calls } = makeOps(tree);

    const result = await listDirectory(
      listArgs({ scope: { kind: 'file', root_path: 'C:\\work\\notes\\README.md' } }),
      depsFor(ops),
    );

    assert.deepEqual(result.entries, [{ path: '', name: 'README.md', type: 'file', size: 1234, excluded: false }]);
    assert.equal(result.path, '');
    assert.equal(result.incomplete, false);
    assert.equal(result.next_cursor, null);
    assert.equal(calls.list, 0, '单文件工作区不需要列举任何目录');
  });

  it('单文件工作区命中硬拒绝规则时拒绝整次列举', async () => {
    const tree = new Map<string, NodeSpec>([['', fileOf(10, { file_id: 'root-0001' })]]);
    const { ops } = makeOps(tree);

    await expectListError(
      'POLICY_DENIED',
      () => listDirectory(listArgs({ scope: { kind: 'file', root_path: 'C:\\work\\proj\\.env' } }), depsFor(ops)),
      '把 .env 登记成单文件工作区',
    );
  });

  it('单文件工作区给出子路径时拒绝', async () => {
    const tree = new Map<string, NodeSpec>([['', fileOf(10, { file_id: 'root-0001' })]]);
    const { ops } = makeOps(tree);

    await expectListError(
      'INVALID_ARGUMENT',
      () => listDirectory(listArgs({ path: 'sub', scope: { kind: 'file' } }), depsFor(ops)),
      '单文件工作区下的子路径',
    );
  });

  it('参数形态不合法时一次探针都不发生', async () => {
    const { ops, calls } = makeOps(standardTree());

    for (const bad of [0, -1, 1.5]) {
      await expectListError('INVALID_ARGUMENT', () => listDirectory(listArgs({ max_entries: bad }), depsFor(ops)), `max_entries=${String(bad)}`);
    }
    for (const bad of [-1, 1.5]) {
      await expectListError('INVALID_ARGUMENT', () => listDirectory(listArgs({ depth: bad }), depsFor(ops)), `depth=${String(bad)}`);
    }
    assert.equal(calls.resolve, 0, '参数不合法时不该打开任何路径');
    assert.equal(calls.list, 0);
  });
});

// ---------------------------------------------------------------------------
// 6. 取用校验（导出函数单独测：调用方可能自己比对）
// ---------------------------------------------------------------------------

describe('LWB-014 assertListCursorMatches 的逐项检查', () => {
  const cursor = {
    kind: 'list' as const,
    v: 1,
    connection_id: CONNECTION,
    workspace_id: 'ws-1',
    generation: 1,
    base_path: 'src',
    base_volume_id: VOLUME,
    base_file_id: 'dir:src',
    anchor_path: 'src/a.txt',
    depth: 1,
    issued_at: NOW,
    expires_at: NOW + 1000,
  };

  const expect = {
    connection_id: CONNECTION,
    workspace_id: 'ws-1',
    generation: 1,
    base_path: 'src',
    base_volume_id: VOLUME,
    base_file_id: 'dir:src',
    depth: 1,
  };

  it('完全一致时通过', () => {
    assert.doesNotThrow(() => { assertListCursorMatches(cursor, expect); });
  });

  it('起点路径按大小写不敏感比较（NTFS 语义），身份逐字节比较', () => {
    assert.doesNotThrow(() => { assertListCursorMatches(cursor, { ...expect, base_path: 'SRC' }); });
    // 身份比对大小写不敏感就成了「换了个对象也算同一个」，因此这里逐字节比。
    assert.throws(
      () => { assertListCursorMatches(cursor, { ...expect, base_file_id: 'dir:SRC' }); },
      (cause: unknown) => cause instanceof BridgeError && cause.details?.['reason'] === 'CURSOR_BASE_CHANGED',
    );
  });

  it('锚点本身不参与比对：它是位置，不是约束', () => {
    assert.doesNotThrow(() => {
      assertListCursorMatches({ ...cursor, anchor_path: 'src/zzz.txt' }, expect);
    });
  });
});
