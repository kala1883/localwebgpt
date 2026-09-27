/**
 * LWB-014 可复现证据采集。
 *
 * 三条验收标准全部走**真实磁盘**与**真实护栏**（PowerShell + .NET P/Invoke）：
 *
 *  1. 「大量文件时输出有界，目录变化可以返回游标失效或明确不完整状态」——
 *     两个方向都采集：**有界**（1050 条的目录：一次调用只问护栏一次、只返回
 *     一页）与**不完整/失效**（深度、预算、子树消失、游标绑定被改）。
 *  2. 「不能枚举未授权文件根的兄弟文件」—— 用一个真实的 **junction** 指向
 *     工作区之外的目录（不需要管理员权限），验证遍历不顺着它走出去；
 *     再把每条返回的条目路径拿回护栏**逐个回验**（护栏自己会拒绝越界路径），
 *     证明结果里的每一条都真的是工作区根之下的对象。
 *  3. 「隐藏/拒绝对象不在列表和错误中泄露详细信息」—— 真实 `.env`、真实
 *     `.ssh`（内含私钥）、文件名本身就是令牌的文件：三者都不得出现在
 *     `JSON.stringify(结果)` 里，也不得让护栏**枚举**它们所在的目录。
 *
 * 另有三项实测：
 *   - **护栏硬上限**：把页面上限抬到 1200（> 护栏的 1000）时，是否靠
 *     `after_name` 续窗把 1050 条一条不少地取回来。
 *   - **顺序一致**：同一棵树用两种页大小各翻一遍，序列必须逐条相同。
 *   - **起点判决路径**：把工作区根登记成一个真实的 `.lwb` 目录 —— 这是唯一
 *     能证明「根的判决路径不是空串」的形态（空串不命中任何规则）。
 *
 * 用法：node --import tsx scripts/evidence/lwb-014.ts
 * 退出码：全部通过 0；任一项失败 1。
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { LIMITS } from '@lwb/contracts';
import type { PolicyAction } from '@lwb/policy';
import { decide } from '@lwb/policy';
import { EgressBudget } from '@lwb/egress';
import {
  createReadTicketAuthority,
  listDirectory,
  type ListDeps,
  type ListLimits,
  type ReadScope,
} from '@lwb/files';
import { PowerShellWinfsBackend, isWinfsError, type WinfsOps, type WinfsPathRef } from '@lwb/winfs';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function note(name: string, detail: string): void {
  console.log(`NOTE ${name} — ${detail}`);
}

function skip(name: string, why: string): void {
  console.log(`NOT_RUN ${name} — ${why}`);
}

function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const CONNECTION = 'conn-evidence';
const KEY = 'lwb-evidence-014-key-0123456789abcdef0123456789';
const POLICY_VERSION = 1;
const BIG_COUNT = 1050;

/** 按需覆盖若干方法的装饰器（**不能**用 `{...backend}`：类的方法在原型上）。 */
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

/** 计数装饰器：本证据里大量结论是「有几件事**没有**发生」。 */
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

function scopeOf(rootPath: string, volumeId: string, fileId: string, kind: 'directory' | 'file' = 'directory'): ReadScope {
  return {
    workspace_id: 'ws-1',
    kind,
    mode: 'read_propose_apply_with_local_approval',
    generation: 1,
    root_path: rootPath,
    root_volume_id: volumeId,
    root_file_id: fileId,
  };
}

/**
 * 判定走**真的** `decide()`，不是手搓一个 `{allow:true}` 对象。
 *
 * 路径留空是**故意**的：实路径会被 `classifyFile` 拒（`.env` 等），而这里要验的
 * 是策略层**之后**的那几层。
 */
function allowedDecision(action: PolicyAction = 'list') {
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
      current_policy_version: POLICY_VERSION,
      root_volume_id: '00000000',
      root_file_id: '0000000000000000',
      paused: false,
    },
    presented: { generation: null, policy_version: null },
    action: { action, path: '', approval: null },
    now: NOW,
  });
  if (!decision.allow) {
    throw new Error(`装置前提不成立：${action} 被策略层拒绝（${String(decision.primary?.reason ?? '?')}）`);
  }
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

interface ListOutcome {
  readonly ok: boolean;
  readonly code?: string;
  readonly details?: Record<string, unknown>;
  readonly value?: Awaited<ReturnType<typeof listDirectory>>;
}

async function attemptList(
  args: Parameters<typeof listDirectory>[0],
  deps: ListDeps,
): Promise<ListOutcome> {
  try {
    return { ok: true, value: await listDirectory(args, deps) };
  } catch (cause) {
    const error = cause as { code?: string; details?: Record<string, unknown> };
    return { ok: false, code: error.code ?? 'NO_CODE', details: error.details };
  }
}

async function main(): Promise<void> {
  console.log('== 环境 ==');
  console.log(`平台: ${process.platform} ${process.arch}`);
  console.log(`系统: ${os.type()} ${os.release()}`);
  console.log(`Node: ${process.version}`);
  console.log(`PID: ${process.pid}`);

  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-evidence-014-'));
  let backend = new PowerShellWinfsBackend();
  const capability = await backend.capability();
  console.log(`护栏后端: ${capability.backend}（可用=${capability.available}）`);
  console.log(`护栏验证环境: ${capability.verified_on}`);
  console.log(`沙箱: ${sandbox}`);
  console.log(`契约页面上限 MAX_DIRECTORY_ENTRIES=${String(LIMITS.MAX_DIRECTORY_ENTRIES)}`);

  const info = await backend.statVolume({ path: sandbox });
  if (isWinfsError(info)) throw new Error(`statVolume 失败：${info.code} ${info.message}`);
  const scope = scopeOf(sandbox, info.volume_id, info.file_id);
  console.log(`工作区根身份: ${info.volume_id}/${info.file_id}`);

  async function write(rel: string, body: string): Promise<void> {
    const full = path.join(sandbox, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, 'utf8');
  }

  // --- 夹具 ---------------------------------------------------------------
  await write('small/a.txt', 'a\n');
  await write('small/b.txt', 'b\n');
  await write('small/nested/deep.txt', 'deep\n');
  await write('.ssh/id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n');
  await write('.env', 'APP_SECRET=not-a-real-secret\n');
  await write('ghp_012345678901234567890123456789012345.txt', 'token-shaped name\n');
  await write('node_modules/pkg/index.js', 'module.exports = 1\n');
  await write('mid/ok.txt', 'ok\n');
  await write('mid/sub/keep.txt', 'keep\n');
  await write('van/gone/inside.txt', 'inside\n');
  await write('van/ok.txt', 'ok\n');
  await write('hid/.env/secret.txt', 'x\n');
  await write('hid/.lwb/state.json', '{"plugin":"state"}\n');
  await write('plain.txt', 'plain\n');

  const big = path.join(sandbox, 'big');
  await mkdir(big, { recursive: true });
  const names = Array.from({ length: BIG_COUNT }, (_, i) => `f${String(i).padStart(4, '0')}.txt`);
  for (let at = 0; at < names.length; at += 200) {
    await Promise.all(names.slice(at, at + 200).map((n) => writeFile(path.join(big, n), `${n}\n`, 'utf8')));
  }

  const outside = await mkdtemp(path.join(os.tmpdir(), 'lwb-014-outside-'));
  await writeFile(path.join(outside, 'outside-only.txt'), 'outside\n', 'utf8');
  const junction = spawnSync('cmd', ['/c', 'mklink', '/J', path.join(sandbox, 'junction'), outside], {
    encoding: 'utf8',
  });
  if (junction.status !== 0) {
    throw new Error(`建立 junction 失败：${junction.stdout}${junction.stderr}`);
  }
  console.log(`夹具: ${String(BIG_COUNT)} 条的大目录 + 真实 junction → ${outside}`);

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

  /** 逐页翻完，返回拼接序列。每次新建 deps：游标必须自己站得住。 */
  async function listAll(
    ops: WinfsOps,
    options: { path?: string; max_entries?: number; depth?: number; limits?: Partial<ListLimits> } = {},
  ): Promise<{ paths: string[]; pages: number; incomplete: boolean }> {
    const paths: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let incomplete = false;
    do {
      const page = await listDirectory(
        args({ ...options, ...(cursor === null ? {} : { cursor }) }),
        depsFor(ops, options.limits ?? {}),
      );
      paths.push(...page.entries.map((e) => e.path));
      cursor = page.next_cursor;
      incomplete = page.incomplete;
      pages += 1;
      if (pages > 400) throw new Error('翻页没有推进（页数超过 400）');
    } while (cursor !== null);
    return { paths, pages, incomplete };
  }

  // =========================================================================
  section('验收标准 1 · 大量文件时输出有界');
  // =========================================================================

  {
    const { ops, calls } = counting(backend);
    const result = await listDirectory(args({ path: 'big' }), depsFor(ops));
    check(
      '1050 条的目录：一次调用只返回一页，且只向护栏问一次',
      result.entries.length === LIMITS.MAX_DIRECTORY_ENTRIES && calls.list === 1,
      `返回 ${String(result.entries.length)} 条 / 目录询问 ${String(calls.list)} 次 / 询问路径=${JSON.stringify(calls.paths)}`,
    );
    check(
      '页满时给出可续读的游标，并明确标为不完整',
      result.next_cursor !== null && result.truncated && result.incomplete,
      `truncated=${String(result.truncated)} incomplete=${String(result.incomplete)} 理由=${String(result.incomplete_reason)}`,
    );
  }

  {
    const { ops, calls } = counting(backend);
    const result = await listDirectory(args(), depsFor(ops));
    // 根这一层有 10 个条目，因此这一条不是「页满」挡住的，而是为了说明
    // 「有界」在**条目多**与**层级深**两个方向上都成立。
    check(
      '整棵树在默认限额下不会被一次调用走完（根这一层的目录询问只有 1 次）',
      calls.list === 1 && result.incomplete,
      `目录询问 ${String(calls.list)} 次 / 本次返回 ${String(result.entries.length)} 条 / ${String(result.incomplete_reason)}`,
    );
  }

  {
    const { ops, calls } = counting(backend);
    const result = await listDirectory(args({ path: 'big' }), depsFor(ops, { max_directory_entries: 1200 }));
    check(
      '页面上限抬到 1200（> 护栏硬上限 1000）时按窗口续取：1050 条一条不少',
      result.entries.length === BIG_COUNT && calls.list === 2 && result.next_cursor === null,
      `返回 ${String(result.entries.length)} 条 / 目录询问 ${String(calls.list)} 次（第一次被护栏夹到 1000）`,
    );
    check(
      '条目的 ordinal 顺序连续到末条（窗口之间不重不漏）',
      result.entries[0]?.name === 'f0000.txt' &&
        result.entries.at(-1)?.name === `f${String(BIG_COUNT - 1).padStart(4, '0')}.txt` &&
        new Set(result.entries.map((e) => e.name)).size === BIG_COUNT,
      `首=${String(result.entries[0]?.name)} 末=${String(result.entries.at(-1)?.name)} 去重后=${String(new Set(result.entries.map((e) => e.name)).size)}`,
    );
  }

  {
    const coarse = await listAll(backend, { depth: 4, max_entries: 200 });
    const fine = await listAll(backend, { depth: 4, max_entries: 50 });
    check(
      '同一棵树用两种页大小各翻一遍：序列逐条相同（分页边界不改变顺序与完整性）',
      coarse.paths.length === fine.paths.length && coarse.paths.every((p, i) => p === fine.paths[i]),
      `粗页 ${String(coarse.pages)} 页 / 细页 ${String(fine.pages)} 页 / 共 ${String(coarse.paths.length)} 条`,
    );
    check(
      '翻页结果无重复条目，且覆盖了 1050 条的大目录与深层条目',
      new Set(coarse.paths).size === coarse.paths.length &&
        coarse.paths.length >= BIG_COUNT &&
        coarse.paths.includes('small/nested/deep.txt'),
      `唯一路径 ${String(new Set(coarse.paths).size)} 条 / 含 small/nested/deep.txt=${String(coarse.paths.includes('small/nested/deep.txt'))}`,
    );
  }

  // =========================================================================
  section('验收标准 1（后半）· 目录变化 ⇒ 游标失效或明确不完整');
  // =========================================================================

  {
    const result = await listDirectory(args(), depsFor(backend));
    const prunable = result.entries.filter((e) => e.type === 'directory' && !e.excluded).length;
    check(
      '深度上限：明确标为不完整，并说出有几个目录没进入（数字与结果自洽）',
      result.incomplete && (result.incomplete_reason ?? '').includes(`有 ${String(prunable)} 个目录未进入`),
      `${String(result.incomplete_reason)}（可由结果算出的可进入目录数=${String(prunable)}）`,
    );
  }

  {
    const { ops, calls } = counting(backend);
    const first = await listDirectory(args({ path: 'small', depth: 4 }), depsFor(ops, { max_directory_listings: 1 }));
    const rest = await listDirectory(
      args({ path: 'small', depth: 4, cursor: first.next_cursor ?? undefined }),
      depsFor(backend),
    );
    const oneShot = await listDirectory(args({ path: 'small', depth: 4 }), depsFor(backend));
    const joined = [...first.entries.map((e) => e.path), ...rest.entries.map((e) => e.path)];
    check(
      '目录询问预算用尽：提前结束、标为不完整、并给出可续读的锚点',
      calls.list === 1 && first.incomplete && first.next_cursor !== null,
      `询问 ${String(calls.list)} 次 / ${String(first.incomplete_reason)}`,
    );
    check(
      '用该锚点续读：拼接结果与一次列完逐条相同（不重不漏）',
      joined.length === oneShot.entries.length && joined.every((p, i) => p === oneShot.entries[i]?.path),
      `拼接 ${String(joined.length)} 条 = 一次列完 ${String(oneShot.entries.length)} 条`,
    );
  }

  {
    const vanishing = decorate(backend, {
      listDirectory: async (req) => {
        if (req.relative_path === 'van/gone') {
          await rm(path.join(sandbox, 'van', 'gone'), { recursive: true, force: true });
        }
        return backend.listDirectory(req);
      },
    });
    const result = await listDirectory(args({ path: 'van', depth: 2 }), depsFor(vanishing));
    check(
      '子树在遍历途中消失：跳过它、把路径与护栏码写进不完整原因、其余条目照常返回',
      result.incomplete &&
        (result.incomplete_reason ?? '').includes('子目录 van/gone 未能枚举（护栏码 NOT_FOUND）') &&
        result.entries.some((e) => e.path === 'van/ok.txt'),
      `${String(result.incomplete_reason)}；仍返回 ${JSON.stringify(result.entries.map((e) => e.path))}`,
    );
    await write('van/gone/inside.txt', 'inside\n');
  }

  {
    // 续读前把锚点文件删掉：必须从它的位置继续，而不是重来或跳过。
    await write('anchor/x1.txt', 'x1\n');
    await write('anchor/x2.txt', 'x2\n');
    await write('anchor/x3.txt', 'x3\n');
    const first = await listDirectory(args({ path: 'anchor', max_entries: 2 }), depsFor(backend));
    await rm(path.join(sandbox, 'anchor', 'x2.txt'), { force: true });
    const second = await listDirectory(
      args({ path: 'anchor', max_entries: 2, cursor: first.next_cursor ?? undefined }),
      depsFor(backend),
    );
    check(
      '锚点在续读前被删除：从它的位置继续（既不重来，也不跳过后续条目）',
      second.entries.length === 1 && second.entries[0]?.name === 'x3.txt',
      `第一页=${JSON.stringify(first.entries.map((e) => e.name))} 删掉锚点 x2.txt 后续读=${JSON.stringify(second.entries.map((e) => e.name))}`,
    );
  }

  {
    // 游标绑定「起点是哪一个对象」用的是**磁盘上的身份**：这里拿另一条真实
    // 目录（mid）的文件身份去铸一个声称起点是 small 的游标，两者都是真实值。
    const authority = createReadTicketAuthority({ key: KEY });
    const smallInfo = await backend.resolvePath({ root_path: sandbox, root_volume_id: scope.root_volume_id, root_file_id: scope.root_file_id, relative_path: 'small', expect: 'directory' });
    const midInfo = await backend.resolvePath({ root_path: sandbox, root_volume_id: scope.root_volume_id, root_file_id: scope.root_file_id, relative_path: 'mid', expect: 'directory' });
    if (isWinfsError(smallInfo) || isWinfsError(midInfo) || !('identity' in smallInfo) || !('identity' in midInfo)) {
      check('起点对象身份：探针', false, '装置前提失败');
    } else {
      const forged = authority.mintListCursor(
        {
          connection_id: CONNECTION,
          workspace_id: 'ws-1',
          generation: 1,
          base_path: 'small',
          base_volume_id: midInfo.identity.volume_id,
          base_file_id: midInfo.identity.file_id,
          anchor_path: 'small/a.txt',
          depth: 0,
        },
        { now: NOW, ttl_ms: 60_000 },
      );
      const outcome = await attemptList(args({ path: 'small', cursor: forged }), depsFor(backend));
      check(
        '游标声称的起点对象与磁盘上的身份不符时被拒绝（身份取自真实 NTFS，不是字符串）',
        !outcome.ok && outcome.code === 'READ_TOKEN_STALE' && outcome.details?.['reason'] === 'CURSOR_BASE_CHANGED',
        `small=${smallInfo.identity.file_id} mid=${midInfo.identity.file_id} ⇒ ${String(outcome.code)}/${String(outcome.details?.['reason'] ?? '')}`,
      );
    }
  }

  {
    const first = await listDirectory(args({ path: 'small', max_entries: 1, depth: 2 }), depsFor(backend));
    const depthMismatch = await attemptList(
      args({ path: 'small', max_entries: 1, depth: 1, cursor: first.next_cursor ?? undefined }),
      depsFor(backend),
    );
    const pathMismatch = await attemptList(
      args({ path: 'mid', cursor: first.next_cursor ?? undefined }),
      depsFor(backend),
    );
    check(
      '游标与请求的深度不符时拒绝，而不是取较小值继续',
      !depthMismatch.ok && depthMismatch.details?.['reason'] === 'CURSOR_DEPTH_MISMATCH',
      `${String(depthMismatch.code)}/${String(depthMismatch.details?.['reason'] ?? '')}`,
    );
    check(
      '游标被用到另一个目录上时拒绝（起点路径不同）',
      !pathMismatch.ok && pathMismatch.details?.['reason'] === 'CURSOR_BASE_MISMATCH',
      `${String(pathMismatch.code)}/${String(pathMismatch.details?.['reason'] ?? '')}`,
    );
    const forgedToken = await attemptList(args({ path: 'small', cursor: 'lwblc_forged' }), depsFor(backend));
    check(
      '伪造的游标被拒绝（签名，不是可读的坐标）',
      !forgedToken.ok && forgedToken.code === 'READ_TOKEN_STALE',
      `${String(forgedToken.code)}/${String(forgedToken.details?.['reason'] ?? '')}`,
    );
  }

  {
    // 起点目录被同名新目录替换：这是「路径字符串相同、对象不同」的真实形态。
    //
    // 两个文件是**必须**的：只有一个条目时页面装得下、也就没有见证条目，
    // 于是根本不会有游标 —— 那样这条用例会退化成一次全新的列举，
    // 而它看起来仍然"通过"。这正是「装置前提必须被验，而不只是被假设」。
    await mkdir(path.join(sandbox, 'wasdir'), { recursive: true });
    await writeFile(path.join(sandbox, 'wasdir', 'y.txt'), 'y\n', 'utf8');
    await writeFile(path.join(sandbox, 'wasdir', 'z.txt'), 'z\n', 'utf8');
    const first = await listDirectory(args({ path: 'wasdir', max_entries: 1 }), depsFor(backend));
    if (first.next_cursor === null) {
      check('起点目录被同名新目录替换后，游标失效', false, '装置前提不成立：第一页没有发出游标');
    }
    const before = await backend.statVolume({ path: path.join(sandbox, 'wasdir') });
    await rm(path.join(sandbox, 'wasdir'), { recursive: true, force: true });
    await mkdir(path.join(sandbox, 'wasdir'), { recursive: true });
    const after = await backend.statVolume({ path: path.join(sandbox, 'wasdir') });
    if (first.next_cursor !== null && !isWinfsError(before) && !isWinfsError(after)) {
      note(
        '同名目录删除后重建的物理身份',
        `before=${before.file_id} after=${after.file_id}（${before.file_id === after.file_id ? 'NTFS 复用了这个文件索引 ⇒ 身份判定在此形态下无区分力' : '不同 ⇒ 身份判定有区分力'}）`,
      );
      const outcome = await attemptList(
        args({ path: 'wasdir', cursor: first.next_cursor ?? undefined }),
        depsFor(backend),
      );
      if (before.file_id !== after.file_id) {
        check(
          '起点目录被同名新目录替换后，游标失效（真实 file_id 变化）',
          !outcome.ok && outcome.details?.['reason'] === 'CURSOR_BASE_CHANGED',
          `${String(outcome.code)}/${String(outcome.details?.['reason'] ?? '')}`,
        );
      } else {
        skip(
          '起点目录被同名新目录替换后游标失效',
          '真实 NTFS 在这个形态下复用了同一个文件索引，因此在真实磁盘上无法构造「同名不同对象」；该分支由 tests/unit/files-list.test.ts 的 CURSOR_BASE_CHANGED 用例覆盖',
        );
      }
    }
  }

  // =========================================================================
  section('验收标准 2 · 不能枚举未授权文件根的兄弟文件');
  // =========================================================================

  {
    const { ops, calls } = counting(backend);
    const result = await listDirectory(args(), depsFor(ops));
    const serialized = JSON.stringify(result);
    const junctionEntry = result.entries.find((e) => e.path === 'junction');
    check(
      '真实 junction 指向工作区之外的目录：条目返回但不进入、不带长度、目标内容一条都不出现',
      junctionEntry?.excluded === true &&
        junctionEntry?.size === null &&
        !calls.paths.includes('junction') &&
        !serialized.includes('outside-only'),
      `excluded=${String(junctionEntry?.excluded)} size=${String(junctionEntry?.size)} 是否进入=${String(calls.paths.includes('junction'))} 含 outside-only=${String(serialized.includes('outside-only'))}`,
    );
  }

  {
    // 把每个返回的条目路径拿回护栏**逐个回验**：护栏自己会拒绝越界路径，
    // 因此这一步证明的是「结果里的每一条都真的是工作区根之下的对象」。
    const ua = await listAll(backend, { path: 'small', depth: 4 });
    const uv = await listAll(backend, { path: 'van', depth: 2 });
    const all = [...ua.paths, ...uv.paths];
    let verified = 0;
    let escaped: string[] = [];
    for (const p of all) {
      const probe = await backend.resolvePath({
        root_path: sandbox,
        root_volume_id: scope.root_volume_id,
        root_file_id: scope.root_file_id,
        relative_path: p,
        expect: 'any',
      });
      if (isWinfsError(probe)) {
        escaped.push(p);
        continue;
      }
      if ('canonical_relative_path' in probe && probe.canonical_relative_path === p) verified += 1;
      else escaped.push(p);
    }
    check(
      '结果里的每一条路径都能被护栏按同一拼写重新解析（逐条回验，越界会被护栏拒绝）',
      escaped.length === 0 && verified === all.length,
      `回验 ${String(verified)}/${String(all.length)} 条；被拒=${JSON.stringify(escaped)}`,
    );
    check(
      '条目路径不含穿越段，也不是绝对路径',
      all.every((p) => !p.split('/').includes('..') && !path.isAbsolute(p)),
      `样本=${JSON.stringify(all.slice(0, 3))}`,
    );
  }

  {
    const { ops, calls } = counting(backend);
    const outcome = await attemptList(args({ path: '../outside' }), depsFor(ops));
    check(
      '穿越路径在探针阶段被拒绝，且一次目录询问都不发生',
      !outcome.ok && outcome.code === 'PATH_UNSAFE' && calls.list === 0,
      `${String(outcome.code)} / 目录询问 ${String(calls.list)} 次（护栏码 ${String(outcome.details?.['winfs_code'] ?? '')}）`,
    );
  }

  // =========================================================================
  section('验收标准 3 · 隐藏/拒绝对象不在列表和错误中泄露详细信息');
  // =========================================================================

  {
    const { ops, calls } = counting(backend);
    const result = await listDirectory(args(), depsFor(ops));
    const serialized = JSON.stringify(result);
    const leaked = ['.env', '.ssh', 'id_rsa', 'ghp_', 'PRIVATE KEY'].filter((needle) => serialized.includes(needle));
    check(
      '真实 .env / .ssh（含私钥）/ 令牌名文件：名字与内容都不出现在结果里',
      result.denied_entries === 3 && leaked.length === 0,
      `denied_entries=${String(result.denied_entries)} 泄露片段=${JSON.stringify(leaked)}`,
    );
    check(
      '被拒绝的目录从未被枚举（一次目录询问都没有落到它们身上）',
      !calls.paths.some((p) => p.includes('.ssh') || p.includes('.env')),
      `询问过的路径=${JSON.stringify(calls.paths)}`,
    );
    check(
      '被拒绝的条目计进 scanned_entries，但仍不进 entries（数过什么就对得上什么）',
      result.scanned_entries === result.entries.length + result.denied_entries,
      `scanned=${String(result.scanned_entries)} entries=${String(result.entries.length)} denied=${String(result.denied_entries)}`,
    );
  }

  {
    const { ops, calls } = counting(backend);
    await listDirectory(args({ depth: 1 }), depsFor(ops));
    check(
      '遍历只进入允许的目录：被拒绝的 (.env/.ssh) 与被排除的 (node_modules/junction) 都不进入',
      ['', 'big'].every((p) => calls.paths.includes(p)) &&
        ['.ssh', '.env', 'node_modules', 'junction'].every((p) => !calls.paths.includes(p)),
      `询问过的路径=${JSON.stringify(calls.paths)}`,
    );
  }

  {
    const result = await listDirectory(args(), depsFor(backend));
    const excluded = result.entries.find((e) => e.path === 'node_modules');
    const explicit = await listDirectory(args({ path: 'node_modules' }), depsFor(backend));
    check(
      '搜索排除目录：返回并带 excluded 标记、不进入；但显式列举它仍然拿得到内容（「不扫」不是「不许读」）',
      excluded?.excluded === true &&
        !result.entries.some((e) => e.path.startsWith('node_modules/')) &&
        explicit.entries.length === 1 &&
        explicit.entries[0]?.path === 'node_modules/pkg',
      `标记=${String(excluded?.excluded)} 显式列举=${JSON.stringify(explicit.entries.map((e) => e.path))}`,
    );
  }

  {
    const { ops, calls } = counting(backend);
    const outcome = await attemptList(args({ path: 'hid/.env' }), depsFor(ops));
    check(
      '起点是一个真实的 .env 目录：整次列举被拒，且一次目录询问都不发生',
      !outcome.ok &&
        outcome.code === 'POLICY_DENIED' &&
        outcome.details?.['hard_deny_rule'] === 'HD-ENV' &&
        calls.list === 0,
      `${String(outcome.code)}/${String(outcome.details?.['hard_deny_rule'] ?? '')} / 目录询问 ${String(calls.list)} 次`,
    );
  }

  {
    // 唯一能证明「工作区根的判决路径不是空串」的形态：根自己就是敏感名字。
    // 空串不命中任何按名字匹配的规则，因此这一条一旦通过，就说明根的名字
    // 确实来自注册的绝对路径。
    const lwbRoot = path.join(sandbox, 'hid', '.lwb');
    const lwbInfo = await backend.statVolume({ path: lwbRoot });
    if (isWinfsError(lwbInfo)) {
      check('工作区根自己敏感时被拒', false, `装置前提失败：${lwbInfo.code}`);
    } else {
      const { ops, calls } = counting(backend);
      const outcome = await attemptList(
        args({ scope: scopeOf(lwbRoot, lwbInfo.volume_id, lwbInfo.file_id) }),
        depsFor(ops),
      );
      check(
        '工作区根自己就是 .lwb 目录时，整次列举被拒（根的判决路径不是空串，否则这条会通过）',
        !outcome.ok &&
          outcome.code === 'POLICY_DENIED' &&
          outcome.details?.['hard_deny_rule'] === 'HD-PLUGIN-STATE' &&
          calls.list === 0,
        `${String(outcome.code)}/${String(outcome.details?.['hard_deny_rule'] ?? '')} / 目录询问 ${String(calls.list)} 次`,
      );
    }
  }

  {
    const { ops, calls } = counting(backend);
    const outcome = await attemptList(args({ path: 'plain.txt' }), depsFor(ops));
    check(
      '起点不是目录时拒绝并指路 file_read（护栏的 expect 不执行这条判断，因此这一判必须在调用方）',
      !outcome.ok && outcome.code === 'INVALID_ARGUMENT' && outcome.details?.['reason'] === 'NOT_A_DIRECTORY' && calls.list === 0,
      `${String(outcome.code)}/${String(outcome.details?.['reason'] ?? '')} / 目录询问 ${String(calls.list)} 次`,
    );
  }

  {
    const plainInfo = await backend.statVolume({ path: path.join(sandbox, 'plain.txt') });
    if (isWinfsError(plainInfo)) {
      check('单文件工作区的列举', false, `装置前提失败：${plainInfo.code}`);
    } else {
      const fileScope = scopeOf(path.join(sandbox, 'plain.txt'), plainInfo.volume_id, plainInfo.file_id, 'file');
      const result = await listDirectory(args({ scope: fileScope }), depsFor(backend));
      check(
        '单文件工作区：回执路径是空串、条目一条、且明确是完整的',
        result.path === '' &&
          result.entries.length === 1 &&
          result.entries[0]?.path === '' &&
          result.entries[0]?.name === 'plain.txt' &&
          result.incomplete === false,
        `path="${result.path}" 条目=${JSON.stringify(result.entries.map((e) => ({ p: e.path, n: e.name, s: e.size })))} incomplete=${String(result.incomplete)}`,
      );
    }
  }

  // =========================================================================
  section('未执行项（不得记为通过）');
  // =========================================================================

  skip(
    '真实 ChatGPT Web 端到端目录列举验收',
    '需要真实账号与 Secure MCP Tunnel 凭据；LWB-002 仍为 BLOCKED',
  );
  skip(
    '目录内容的**并发**变更（两次列举之间目录被大量改写）',
    '本证据覆盖的是「锚点消失」「子树消失」「起点被换」三种；把整棵目录换掉的并发压力测试属多实例/负载场景，V1 为单用户单 daemon',
  );
  skip(
    'NTFS 之外的卷上的目录列举（ReFS / 网络盘 / 云占位文件）',
    '本机只有 NTFS；护栏的卷形态判定覆盖了拒绝路径，但未在真实 ReFS 上采集',
  );
  skip(
    'ACL 拒绝导致的子树枚举失败',
    '本证据造的是「子树消失」（NOT_FOUND）；ACL 拒绝需要改真实权限位，且 V1 明确不使用管理员权限',
  );

  await backend.dispose();
  await rm(sandbox, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? '全部通过。' : `有 ${failures} 项未通过。`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
