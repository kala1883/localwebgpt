/**
 * 分页目录列举在**真实护栏 + 真实 NTFS** 上的集成测试（LWB-014）。
 *
 * `tests/unit/files-list.test.ts` 验的是遍历逻辑，用的是桩；本文件验的是
 * 「这套遍历接上真实句柄护栏之后仍然成立」—— 特别是那些**只有真实文件系统
 * 才有的形态**：
 *
 *  - 一次列举装不下的真实目录（护栏的 `LIST_HARD_CAP` 在真实内存里生效）；
 *  - 真正的重解析点（junction）：护栏不跟随它，因此它的 `size` 是 null，
 *    而它**指向工作区之外**的内容一条都不会出现；
 *  - 真实的 `.env` / `.ssh` / 名字像令牌的文件：连名字都不能出现在结果里；
 *  - 真实的深度优先顺序与游标锚点：翻页拼接必须与一次列完逐条相同。
 *
 * 只在 Windows 上运行；其它平台整体跳过，而不是伪装通过。
 *
 * ## 两条从真实运行中学到的、写进夹具的事
 *
 * 1. **页面上限是真的会挡路的**。`LIMITS.MAX_DIRECTORY_ENTRIES` 是 200，
 *    而沙箱里有一个 1050 个文件的目录：于是一次列举**不可能**覆盖整棵树。
 *    因此下面凡是要「列全」的用例，都必须走到一个足够小的子树，或者逐页翻完
 *    —— 而不是假设一次调用就能看完。这不是测试的权宜，是被测行为本身。
 * 2. **排序决定了谁会先被处理完**。目录按 ordinal 顺序遍历，`big` 排在
 *    `.env`/`.ssh` 之后、`ghp_*` 之前：所以在根这一层做分页时，遍历会先
 *    处理掉两个被拒绝的条目，然后在 `big` 里填满页面并停下。要断言「所有被
 *    拒绝的条目都没出现」，就得用一个不会在它们之前把页填满的深度。
 *
 * ## 沙箱在 `mkdtemp` 里
 *
 * 与 `files-read.test.ts` 同一条理由：夹具仓库是只读的验收对象，本文件要造出
 * 大目录、junction、被删掉的子树这些形态，因此必须有自己的根。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { LIMITS } from '@lwb/contracts';
import type { PolicyAction, PolicyDecision } from '@lwb/policy';
import { decide } from '@lwb/policy';
import { EgressBudget } from '@lwb/egress';
import {
  createReadTicketAuthority,
  listDirectory,
  type ListDeps,
  type ListLimits,
  type ReadScope,
} from '@lwb/files';
import type { WinfsError, WinfsListResult, WinfsOps, WinfsPathRef } from '@lwb/winfs';
import { PowerShellWinfsBackend, isWinfsError } from '@lwb/winfs';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const CONNECTION = 'conn-1';
const KEY = 'lwb-test-key-0123456789abcdef0123456789abcdef';
const VOLUME = '00000000';

/** 护栏 `$SCRIPT:LIST_HARD_CAP` 的值。写在这里是为了让「被护栏夹取」这件事可断言。 */
const GUARD_LIST_HARD_CAP = 1000;
/** 大目录的条目数：比护栏硬上限多，因此必然要跨窗口。 */
const BIG_COUNT = 1050;

/** 与 `files-read.test.ts` 同一手法：类的方法在原型上，展开实例会丢方法。 */
function decorate(ops: WinfsOps, overrides: Partial<WinfsOps>): WinfsOps {
  return {
    capability: () => ops.capability(),
    statVolume: (req) => ops.statVolume(req),
    validatePath: (req) => ops.validatePath(req),
    resolvePath: (req) => ops.resolvePath(req),
    readFileGuarded: (req) => ops.readFileGuarded(req),
    writeFileGuarded: (req) => ops.writeFileGuarded(req),
    createFileGuarded: (req) => ops.createFileGuarded(req),
    listDirectory: (req) => ops.listDirectory(req),
    ...overrides,
  };
}

function allowedDecision(action: PolicyAction = 'list'): PolicyDecision {
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
      root_file_id: '0000000000000000',
      paused: false,
    },
    presented: { generation: null, policy_version: null },
    // 路径留空：真实敏感路径会在策略层被拒，而本文件要验的是它**后面**那几层。
    action: { action, path: '', approval: null },
    now: NOW,
  });
  assert.equal(decision.allow, true, `装置前提：${action} 应被允许`);
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

async function expectListError(
  code: string,
  fn: () => Promise<unknown>,
  hint: string,
): Promise<{ code?: string; message?: string; details?: Record<string, unknown> }> {
  try {
    await fn();
  } catch (cause) {
    const err = cause as { code?: string; message?: string; details?: Record<string, unknown> };
    assert.equal(err.code, code, `${hint} 的错误码（消息：${err.message}）`);
    return err;
  }
  assert.fail(`${hint}：应当抛出 ${code}`);
}

/** 计数装饰器：证明「有多少事没有发生」。 */
function counting(ops: WinfsOps): { ops: WinfsOps; calls: { list: number; resolve: number; paths: string[] } } {
  const calls = { list: 0, resolve: 0, paths: [] as string[] };
  return {
    calls,
    ops: decorate(ops, {
      resolvePath: (req: WinfsPathRef & { expect: 'file' | 'directory' | 'any' }) => {
        calls.resolve += 1;
        return ops.resolvePath(req);
      },
      listDirectory: (req) => {
        calls.list += 1;
        calls.paths.push(req.relative_path);
        return ops.listDirectory(req);
      },
    }),
  };
}

describeWindows('LWB-014 分页目录列举（真实护栏 / 真实 NTFS）', () => {
  let backend: PowerShellWinfsBackend;
  let root: string;
  let scope: ReadScope;

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'lwb-files-list-'));
    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(capability.available, true, `护栏后端不可用：${capability.resolved_backend_reason}`);

    const info = await backend.statVolume({ path: root });
    if (isWinfsError(info)) throw new Error(`statVolume 失败：${info.code} ${info.message}`);
    scope = {
      workspace_id: 'ws-1',
      kind: 'directory',
      mode: 'read_propose_apply_with_local_approval',
      generation: 1,
      root_path: root,
      root_volume_id: info.volume_id,
      root_file_id: info.file_id,
    };

    const write = async (rel: string, body: string): Promise<void> => {
      const full = path.join(root, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, body, 'utf8');
    };

    // --- 小块子树：可以一次列全 ---------------------------------------------
    await write('small/a.txt', 'a\n');
    await write('small/b.txt', 'b\n');
    await write('small/nested/deep.txt', 'deep\n');

    // --- 三种特殊目录：硬拒绝、搜索排除、重解析点（junction 在下面建） --------
    await write('.ssh/id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n');
    await write('.env', 'APP_SECRET=not-a-real-secret\n');
    // 名字本身就是秘密：文件名命中 certain 档，因此连名字都不能回。
    await write('ghp_012345678901234567890123456789012345.txt', 'token-shaped name\n');
    await write('node_modules/pkg/index.js', 'module.exports = 1\n');

    // --- 计数用的混合子树：含被拒绝的条目，且没有目录会被深度挡下 ------------
    await write('mixed/ok.txt', 'ok\n');
    await write('mixed/.env', 'NESTED_SECRET=1\n');
    await write('mixed/sub/.env', 'DEEPER_SECRET=1\n');
    await write('mixed/sub/keep.txt', 'keep\n');

    // --- 途中会被删掉的子树（单独一层，避免被大目录的页上限截断） ------------
    await write('van/gone/inside.txt', 'inside\n');
    await write('van/ok.txt', 'ok\n');

    // --- 敏感名字的**目录**：起点侧（验收标准 3）与根判决路径 ---------------
    await write('hid/.env/secret.txt', 'x\n');
    await write('hid/.lwb/state.json', '{"plugin":"state"}\n');

    await write('plain.txt', 'plain\n');

    // --- 真实 junction：**不需要管理员权限**（符号链接才需要） --------------
    const outside = await mkdtemp(path.join(os.tmpdir(), 'lwb-outside-'));
    await writeFile(path.join(outside, 'outside-only.txt'), 'outside\n', 'utf8');
    const junction = spawnSync('cmd', ['/c', 'mklink', '/J', path.join(root, 'junction'), outside], {
      encoding: 'utf8',
    });
    assert.equal(junction.status, 0, `建立 junction 失败：${junction.stdout}${junction.stderr}`);

    // --- 大目录：一次列举装不下 ---------------------------------------------
    const big = path.join(root, 'big');
    await mkdir(big, { recursive: true });
    const names = Array.from({ length: BIG_COUNT }, (_, i) => `f${String(i).padStart(4, '0')}.txt`);
    for (let at = 0; at < names.length; at += 200) {
      await Promise.all(names.slice(at, at + 200).map((name) => writeFile(path.join(big, name), `${name}\n`, 'utf8')));
    }
  });

  after(async () => {
    await backend?.dispose();
    await rm(root, { recursive: true, force: true });
  });

  function args(
    options: { path?: string; cursor?: string; max_entries?: number; depth?: number; scope?: ReadScope } = {},
  ) {
    return {
      scope: options.scope ?? scope,
      connection_id: CONNECTION,
      decision: allowedDecision('list'),
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

  /** 逐页翻完，返回拼接后的路径序列。**每次都新建 deps**，游标必须自己站得住。 */
  async function listAll(
    ops: WinfsOps,
    options: { path?: string; max_entries?: number; depth?: number; limits?: Partial<ListLimits> } = {},
  ): Promise<{ paths: string[]; pages: number }> {
    const paths: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await listDirectory(
        args({ ...options, ...(cursor === null ? {} : { cursor }) }),
        depsFor(ops, options.limits ?? {}),
      );
      paths.push(...page.entries.map((e) => e.path));
      cursor = page.next_cursor;
      pages += 1;
      assert.ok(pages < 400, '页数异常，可能没有推进');
    } while (cursor !== null);
    return { paths, pages };
  }

  // -------------------------------------------------------------------------
  // 有界
  // -------------------------------------------------------------------------

  it('真实大目录在默认限额下只返回一页，且只向护栏问了一次', async () => {
    const { ops, calls } = counting(backend);

    const result = await listDirectory(args({ path: 'big' }), depsFor(ops));

    // 断言的默认值取自契约，不在这里抄一个数字：抄来的数字会在契约改动时
    // 变成一条「测试通过但行为已变」的用例。
    assert.equal(result.entries.length, LIMITS.MAX_DIRECTORY_ENTRIES);
    assert.notEqual(result.next_cursor, null);
    assert.equal(result.truncated, true);
    assert.equal(result.incomplete, true);
    // 目录里有 1050 条，但这次调用只问了护栏一次 —— 这才是「有界」。
    assert.equal(calls.list, 1, `目录询问次数：${String(calls.list)}`);
    assert.deepEqual(calls.paths, ['big']);
    assert.equal(result.entries[0]?.name, 'f0000.txt');
    assert.equal(
      result.entries.at(-1)?.name,
      `f${String(LIMITS.MAX_DIRECTORY_ENTRIES - 1).padStart(4, '0')}.txt`,
    );
  });

  it('页面上限超过护栏硬上限时按窗口续取：1050 条不静默少列', async () => {
    const { ops, calls } = counting(backend);

    // 操作者把上限调到 1200（> 护栏的 1000）时，单次询问仍然只能拿到 1000 条；
    // 剩下的必须靠 after_name 续窗取回，否则这里会少 50 条。
    const result = await listDirectory(args({ path: 'big' }), depsFor(ops, { max_directory_entries: 1200 }));

    assert.equal(result.entries.length, BIG_COUNT);
    assert.equal(result.entries.at(-1)?.name, `f${String(BIG_COUNT - 1).padStart(4, '0')}.txt`);
    assert.equal(result.next_cursor, null, '列完了就没有下一页');
    assert.equal(result.truncated, false);
    assert.equal(calls.list, 2, '两次窗口：第一次被护栏夹到 1000，第二次取余下的');
    assert.ok(result.entries.length > GUARD_LIST_HARD_CAP, '确实超过了护栏单次上限');
  });

  it('小路子树的翻页拼接与一次列完逐条相同，且数过的条数对得上', async () => {
    const oneShot = await listDirectory(args({ path: 'small', depth: 4 }), depsFor(backend));
    // 单条一页：把「深度优先先序」压到最细的粒度上验。
    const { paths, pages } = await listAll(backend, { path: 'small', depth: 4, max_entries: 1 });

    assert.equal(pages, 4);
    assert.deepEqual(paths, ['small/a.txt', 'small/b.txt', 'small/nested', 'small/nested/deep.txt']);
    assert.deepEqual(paths, oneShot.entries.map((e) => e.path));
    assert.equal(oneShot.incomplete, false, '深度 4 覆盖这棵子树');
    // 数过多少条 = 返回的 + 被拒绝的（被排除的目录本身会返回，因此已在 entries 里）。
    assert.equal(oneShot.scanned_entries, oneShot.entries.length + oneShot.denied_entries);
  });

  it('真实混合子树的计数对得上：被拒绝的条目计进 scanned，但不计进 entries', async () => {
    const result = await listDirectory(args({ path: 'mixed', depth: 2 }), depsFor(backend));

    assert.deepEqual(
      result.entries.map((e) => e.path),
      ['mixed/ok.txt', 'mixed/sub', 'mixed/sub/keep.txt'],
      '两个 .env 都不在结果里',
    );
    assert.equal(result.denied_entries, 2);
    assert.equal(result.scanned_entries, 5);
    assert.equal(result.scanned_entries, result.entries.length + result.denied_entries);
    assert.equal(result.incomplete, false, '没有目录被深度挡下，也没有失败的子树');
    assert.equal(JSON.stringify(result).includes('.env'), false);
  });

  it('整棵树用两种页大小翻完，得到逐条相同的序列（不重不漏）', async () => {
    // 一次调用不可能覆盖整棵树（big 有 1050 条 > 页面上限 200），因此这里
    // 用**两种页大小的两次独立翻页**互相印证：分页边界不改变顺序与完整性。
    const coarse = await listAll(backend, { depth: 4, max_entries: 200 });
    const fine = await listAll(backend, { depth: 4, max_entries: 50 });

    assert.deepEqual(fine.paths, coarse.paths);
    assert.ok(fine.pages > coarse.pages, '页更小就该翻更多页');
    assert.equal(new Set(coarse.paths).size, coarse.paths.length, '不得出现重复条目');
    assert.ok(coarse.paths.length >= BIG_COUNT, `整棵树应含大目录的 ${String(BIG_COUNT)} 条`);
    assert.ok(coarse.paths.includes('small/nested/deep.txt'), '深层条目也要出现');
  });

  // -------------------------------------------------------------------------
  // 不泄露（验收标准 2、3）
  // -------------------------------------------------------------------------

  it('真实的 .env / .ssh / 令牌名文件：名字不出现在结果里', async () => {
    // 只在当前层判：这一层不会被大目录填满页面，因此三条被拒绝的条目都会被处理到。
    const { ops, calls } = counting(backend);

    const result = await listDirectory(args(), depsFor(ops));

    assert.equal(result.denied_entries, 3, '.env、.ssh 与名字像令牌的那个文件');
    const serialized = JSON.stringify(result);
    for (const denied of ['.env', '.ssh', 'id_rsa', 'ghp_']) {
      assert.equal(serialized.includes(denied), false, `结果里出现了被拒绝的名字 ${denied}`);
    }
    assert.equal(serialized.includes('PRIVATE KEY'), false);
    assert.deepEqual(calls.paths, [''], '只问了根这一层');
  });

  it('真实遍历只进入允许的目录：被拒绝与被排除的目录一次都没被枚举', async () => {
    const { ops, calls } = counting(backend);

    await listDirectory(args({ depth: 1 }), depsFor(ops));

    assert.equal(calls.paths.includes('.ssh'), false);
    assert.equal(calls.paths.includes('.env'), false);
    assert.equal(calls.paths.includes('node_modules'), false, '搜索排除目录不进入');
    assert.equal(calls.paths.includes('junction'), false, '重解析点不进入');
    assert.ok(calls.paths.includes('big'), '允许的目录要进入');
  });

  it('真实重解析点：不进入、不带长度、指向工作区之外的内容一条都不出现', async () => {
    const { ops, calls } = counting(backend);

    const result = await listDirectory(args(), depsFor(ops));

    const junction = result.entries.find((e) => e.path === 'junction');
    assert.ok(junction, 'junction 本身应当出现在列表里（它确实存在于这个目录）');
    assert.equal(junction.type, 'directory');
    assert.equal(junction.excluded, true, '重解析点按排除处置');
    assert.equal(junction.size, null, '不得 stat 链接目标');
    assert.equal(calls.paths.includes('junction'), false, '不得进入 junction');
    assert.equal(JSON.stringify(result).includes('outside-only'), false, '工作区之外的内容不得出现');
  });

  it('搜索排除目录返回但带标记，显式列举它仍然拿得到内容', async () => {
    const result = await listDirectory(args(), depsFor(backend));

    const deps = result.entries.find((e) => e.path === 'node_modules');
    assert.ok(deps);
    assert.equal(deps.excluded, true);
    assert.equal(result.entries.some((e) => e.path.startsWith('node_modules/')), false);

    const explicit = await listDirectory(args({ path: 'node_modules' }), depsFor(backend));
    assert.deepEqual(
      explicit.entries.map((e) => e.path),
      ['node_modules/pkg'],
    );
  });

  // -------------------------------------------------------------------------
  // 深度与不完整
  // -------------------------------------------------------------------------

  it('真实深度上限：depth=0 只列当前层并说明；覆盖整棵子树后 incomplete 为 false', async () => {
    const shallow = await listDirectory(args(), depsFor(backend));
    assert.equal(shallow.incomplete, true);
    assert.match(shallow.incomplete_reason ?? '', /深度上限 depth=0/);
    assert.equal(shallow.entries.some((e) => e.path.includes('/')), false, '不该有第二层');
    // 数字不写死：它必须等于结果里**本来可以进入**的目录数（被排除的不算、
    // 被拒绝的更不算）。写死一个数字等于把夹具的形状抄进断言，夹具一变就撒谎。
    const prunable = shallow.entries.filter((e) => e.type === 'directory' && !e.excluded).length;
    assert.ok(prunable > 0);
    assert.match(shallow.incomplete_reason ?? '', new RegExp(`有 ${String(prunable)} 个目录未进入`));

    const deep = await listDirectory(args({ path: 'small', depth: 4 }), depsFor(backend));
    assert.equal(deep.incomplete, false);
    assert.equal(deep.incomplete_reason, null);
    assert.ok(deep.entries.some((e) => e.path === 'small/nested/deep.txt'));
  });

  it('真实子树在遍历途中消失：跳过它并如实报告，不影响其余的条目', async () => {
    const vanishing = decorate(backend, {
      listDirectory: async (req): Promise<WinfsListResult | WinfsError> => {
        if (req.relative_path === 'van/gone') {
          await rm(path.join(root, 'van', 'gone'), { recursive: true, force: true });
        }
        return backend.listDirectory(req);
      },
    });

    const result = await listDirectory(args({ path: 'van', depth: 2 }), depsFor(vanishing));

    assert.deepEqual(
      result.entries.map((e) => e.path),
      ['van/gone', 'van/ok.txt'],
      '消失前它已经被返回',
    );
    assert.equal(result.incomplete, true);
    assert.match(result.incomplete_reason ?? '', /子目录 van\/gone 未能枚举（护栏码 NOT_FOUND）/);
    assert.equal(result.next_cursor, null, '遍历已经结束，没有下一页');
  });

  it('真实目录询问预算用尽时提前结束，并给出可续读的锚点', async () => {
    const { ops, calls } = counting(backend);

    // small 有 a.txt、b.txt、nested 三条；只给一次询问，因此进入 nested 时预算就用完了。
    const result = await listDirectory(args({ path: 'small', depth: 4 }), depsFor(ops, { max_directory_listings: 1 }));

    assert.equal(calls.list, 1);
    assert.equal(result.incomplete, true);
    assert.match(result.incomplete_reason ?? '', /目录询问次数已达到上限 1/);
    assert.notEqual(result.next_cursor, null, '已返回的条目就是有效的锚点');

    const rest = await listDirectory(
      args({ path: 'small', depth: 4, cursor: result.next_cursor ?? undefined }),
      depsFor(backend),
    );
    const oneShot = await listDirectory(args({ path: 'small', depth: 4 }), depsFor(backend));
    const joined = [...result.entries.map((e) => e.path), ...rest.entries.map((e) => e.path)];
    assert.deepEqual(joined, oneShot.entries.map((e) => e.path), '续读必须接着上次的位置，不重不漏');
  });

  // -------------------------------------------------------------------------
  // 游标
  // -------------------------------------------------------------------------

  it('真实续读：锚点文件被删掉之后，从它的位置继续且不重复', async () => {
    await mkdir(path.join(root, 'anchor'), { recursive: true });
    for (const name of ['x1.txt', 'x2.txt', 'x3.txt']) {
      await writeFile(path.join(root, 'anchor', name), `${name}\n`, 'utf8');
    }

    const first = await listDirectory(args({ path: 'anchor', max_entries: 2 }), depsFor(backend));
    assert.deepEqual(
      first.entries.map((e) => e.name),
      ['x1.txt', 'x2.txt'],
    );
    assert.notEqual(first.next_cursor, null);

    // 锚点（x2.txt）在续读前被删掉。
    await rm(path.join(root, 'anchor', 'x2.txt'), { force: true });

    const second = await listDirectory(
      args({ path: 'anchor', max_entries: 2, cursor: first.next_cursor ?? undefined }),
      depsFor(backend),
    );
    assert.deepEqual(
      second.entries.map((e) => e.name),
      ['x3.txt'],
    );
  });

  it('真实游标与深度不符时拒绝，而不是取较小值继续', async () => {
    const first = await listDirectory(args({ path: 'small', max_entries: 1, depth: 2 }), depsFor(backend));
    assert.notEqual(first.next_cursor, null);

    const error = await expectListError(
      'READ_TOKEN_STALE',
      () =>
        listDirectory(
          args({ path: 'small', max_entries: 1, depth: 1, cursor: first.next_cursor ?? undefined }),
          depsFor(backend),
        ),
      '深度不符的游标',
    );
    assert.equal(error.details?.['reason'], 'CURSOR_DEPTH_MISMATCH');
  });

  it('把游标用到另一个目录上会被拒绝（起点路径不同）', async () => {
    const first = await listDirectory(args({ path: 'small', max_entries: 1 }), depsFor(backend));
    assert.notEqual(first.next_cursor, null);

    const error = await expectListError(
      'READ_TOKEN_STALE',
      () => listDirectory(args({ path: 'node_modules', cursor: first.next_cursor ?? undefined }), depsFor(backend)),
      '换目录用游标',
    );
    // 路径不同 ⇒ BASE_MISMATCH；路径相同而对象被换掉 ⇒ BASE_CHANGED（见单元测试）。
    assert.equal(error.details?.['reason'], 'CURSOR_BASE_MISMATCH');
  });

  // -------------------------------------------------------------------------
  // 形态与起点
  // -------------------------------------------------------------------------

  it('回执路径是磁盘规范拼写：请求 small 的另一种大小写，回执仍是磁盘上的名字', async () => {
    const result = await listDirectory(args({ path: 'SMALL' }), depsFor(backend));
    assert.equal(result.path, 'small', '回执必须来自句柄的规范路径，不是请求字符串');
    assert.deepEqual(
      result.entries.map((e) => e.path),
      ['small/a.txt', 'small/b.txt', 'small/nested'],
    );
  });

  it('列举一个真实文件被拒绝，且一次目录询问都不发生', async () => {
    const { ops, calls } = counting(backend);
    const error = await expectListError(
      'INVALID_ARGUMENT',
      () => listDirectory(args({ path: 'plain.txt' }), depsFor(ops)),
      '列举文件',
    );
    assert.equal(error.details?.['reason'], 'NOT_A_DIRECTORY');
    assert.equal(calls.list, 0);
  });

  it('真实的 .env 目录被拒绝：一次目录询问都不发生（验收标准 3 的起点侧）', async () => {
    const { ops, calls } = counting(backend);
    const error = await expectListError(
      'POLICY_DENIED',
      () => listDirectory(args({ path: 'hid/.env' }), depsFor(ops)),
      '列举 .env 目录',
    );
    assert.equal(error.details?.['hard_deny_rule'], 'HD-ENV');
    assert.equal(calls.list, 0, '判决必须在付出枚举代价之前');
  });

  it('工作区根自己就是敏感目录时，根也会被判（判决路径不是空串）', async () => {
    // 把工作区登记在 `hid/.lwb` 上：这是唯一能证明「根的判决路径不是空串」的形态
    // —— 空串不命中任何规则，于是根的名字必须来自注册的绝对路径。
    const target = path.join(root, 'hid', '.lwb');
    const info = await backend.statVolume({ path: target });
    if (isWinfsError(info)) throw new Error(`statVolume 失败：${info.code} ${info.message}`);
    const lwbScope: ReadScope = { ...scope, root_path: target, root_volume_id: info.volume_id, root_file_id: info.file_id };

    const { ops, calls } = counting(backend);
    const error = await expectListError(
      'POLICY_DENIED',
      () => listDirectory(args({ scope: lwbScope }), depsFor(ops)),
      '列举 .lwb 工作区根',
    );
    assert.equal(error.details?.['hard_deny_rule'], 'HD-PLUGIN-STATE');
    assert.equal(calls.list, 0);
  });

  it('真实单文件工作区：回执路径是空串，条目一条', async () => {
    const target = path.join(root, 'plain.txt');
    const info = await backend.statVolume({ path: target });
    if (isWinfsError(info)) throw new Error(`statVolume 失败：${info.code} ${info.message}`);
    const fileScope: ReadScope = {
      ...scope,
      kind: 'file',
      root_path: target,
      root_volume_id: info.volume_id,
      root_file_id: info.file_id,
    };

    const result = await listDirectory(args({ scope: fileScope }), depsFor(backend));

    assert.equal(result.path, '');
    assert.deepEqual(
      result.entries.map((e) => ({ path: e.path, name: e.name, type: e.type })),
      [{ path: '', name: 'plain.txt', type: 'file' }],
    );
    assert.equal(result.incomplete, false, '一个文件工作区的列举是完整的');
    assert.equal(result.entries[0]?.size, 6, 'plain\\n');
  });

  it('真实穿越路径在探针阶段被拒绝，遍历不会开始', async () => {
    const { ops, calls } = counting(backend);
    const error = await expectListError(
      'PATH_UNSAFE',
      () => listDirectory(args({ path: '../outside' }), depsFor(ops)),
      '穿越路径',
    );
    assert.equal(error.details?.['winfs_code'], 'PATH_UNSAFE');
    assert.equal(calls.list, 0);
  });
});
