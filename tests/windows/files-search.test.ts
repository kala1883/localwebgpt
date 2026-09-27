/**
 * 文本搜索在**真实护栏 + 真实 NTFS** 上的集成测试（LWB-015）。
 *
 * `tests/search/` 那几份验的是判定（谁能进、谁的命中不返回、什么时候停），
 * 用的是桩。本文件验的是「这套判定接上真实句柄护栏之后仍然成立」，以及那些
 * **只有真实文件系统才有的形态**：
 *
 *  - 真实的重解析点（junction）指向工作区之外：它指向的内容一条都不能出现
 *    —— 桩造不出「跟过去真的能读到别的文件」这件事；
 *  - 真实的 `.env` / `.ssh` / 名字像令牌的文件：连名字都不能出现，
 *    而且判据不只是「结果里没有」，还有「护栏从没被问过它」；
 *  - 真实的 PEM 私钥正文：整份文件的命中被抽走，密钥材料一个字符都不返回；
 *  - 真实的护栏目录窗口（`LIST_HARD_CAP = 1000`）：一个装不下的目录里，
 *    排在第二个窗口的候选**必须**被扫到 —— 这条只有真护栏才测得出，
 *    桩里 `has_more` 从来没有为真过。
 *
 * 只在 Windows 上运行；其它平台整体跳过，而不是伪装通过。
 *
 * ## 时钟
 *
 * `now` 与 `clock` 必须**在同一个刻度上**：deadline 是 `now + 预算`，而
 * 预算靠 `clock()` 判。这里刻意不写 `Date.now()` —— 它与夹具里的 `NOW`
 * 不是同一个刻度，混用会让 deadline 在第一次判断时就已经过期，
 * 于是每个用例都返回空结果而**看上去像是搜索坏了**。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { PolicyDecision } from '@lwb/policy';
import { decide } from '@lwb/policy';
import { EgressBudget } from '@lwb/egress';
import { createReadTicketAuthority, type ReadScope } from '@lwb/files';
import { searchBounds, textSearch } from '@lwb/search';
import type { SearchDeps, SearchLimits } from '@lwb/search';
import type { WinfsOps } from '@lwb/winfs';
import { PowerShellWinfsBackend, isWinfsError } from '@lwb/winfs';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const CONNECTION = 'conn-1';
const KEY = 'lwb-test-key-0123456789abcdef0123456789abcdef';
const VOLUME = '00000000';
const QUERY = 'zzneedlezz';

/** 护栏 `$SCRIPT:LIST_HARD_CAP`。跨窗口那个用例要越过它。 */
const GUARD_LIST_HARD_CAP = 1000;
/** 跨窗口目录里的硬拒绝条目数：比护栏硬上限多，因此必须取第二个窗口。 */
const DENIED_FILLER = 1004;

/** 一段**形状合规**的私钥正文（不是真密钥）。 */
const FAKE_PEM_BODY = `${'MIIEowIBAAKCAQEA'.padEnd(64, 'x')}${QUERY}${'y'.repeat(120)}`;
const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  FAKE_PEM_BODY,
  '-----END RSA PRIVATE KEY-----',
].join('\n');

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

/** 计数装饰器：证明「有多少事没有发生」。**这是本文件最要紧的证据形式。** */
function counting(ops: WinfsOps): {
  ops: WinfsOps;
  calls: { listed: string[]; read: string[] };
} {
  const calls = { listed: [] as string[], read: [] as string[] };
  return {
    calls,
    ops: decorate(ops, {
      listDirectory: (req) => {
        calls.listed.push(req.relative_path);
        return ops.listDirectory(req);
      },
      readFileGuarded: (req) => {
        calls.read.push(req.relative_path);
        return ops.readFileGuarded(req);
      },
    }),
  };
}

function decisionFor(): PolicyDecision {
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
    action: { action: 'search', path: '', approval: null },
    now: NOW,
  });
  assert.equal(decision.allow, true, '装置前提：search 应被允许');
  return decision;
}

/**
 * 本文件里每次搜索的**挂钟**预算。
 *
 * `SEARCH_TIME_BUDGET_MS` 是 3 秒，而它管的是**一次搜索**：
 * `deadline = now + 限额`，每个文件之前用 `clock()` 判一次，超了就停下并
 * 把 `truncated_by` 记成 `DEADLINE`。这是**产品的**设计取舍 —— 一次搜索
 * 不该无限期地占着护栏，而提前结束这件事**在响应里说明了**
 * （`incomplete_reason` / `searchBounds()` 的 `DEADLINE`）。
 *
 * 本文件要验的**不是**那个预算，是「这套判定接上真实句柄护栏之后仍然成立」。
 * 这里跑起来是 14 个测试文件同时开跑、每个都常驻一个 pwsh 护栏，
 * 于是同一台机器上「一次只读 3 个小文件的搜索」也曾经花掉 3.6 秒 ——
 * 预算按**挂钟**走，于是它先于搜索本身用尽，拿到空结果。
 * 空结果看起来像「搜索坏了」，而实际上只是**这台机器当时很忙**。
 *
 * 因此：预算给足余量（它自己的边界由 `tests/search/` 那几份用注入的
 * `clock` 专门验，那里不依赖挂钟），并且每一处「应当扫完」的断言前面
 * 都加一条**装置前提**（见 `assertComplete`）——
 * 这样预算真的用尽时会红在「装置没跑起来」上，而不是红在一句
 * 与真实原因无关的话上。
 */
const TEST_BUDGET_MS = 60_000;

function depsFor(ops: WinfsOps, limits: Partial<SearchLimits> = {}): SearchDeps {
  // 基准取在**这次调用**开始时，而不是进程启动时：`SEARCH_TIME_BUDGET_MS`
  // 说的是「一次搜索最多花多久」，不是「这个进程还能活多久」。用进程启动
  // 时刻当基准的话，夹具与其它测试文件（并行跑，各自都在抢那个常驻护栏）
  // 花掉的时间会先一步把预算吃光，于是每个用例都拿到空结果 ——
  // 而空结果看起来像「搜索坏了」，不像「测试写错了」。
  const t0 = performance.now();
  return {
    ops,
    authority: createReadTicketAuthority({ key: KEY }),
    budget: new EgressBudget({ limit_bytes_per_hour: 64 * 1024 * 1024, now: () => NOW }),
    clock: () => NOW + Math.round(performance.now() - t0),
    limits: { search_time_budget_ms: TEST_BUDGET_MS, ...limits },
  };
}

/**
 * 装置前提：这一次搜索**没有因为时间预算提前结束**。
 *
 * 与「真实 junction」那一条里 `matches.length > 0` 是同一个道理：一条断言
 * 的强度取决于**装置有没有真的跑到那一步**。少了这一条，一次「机器太忙、
 * 预算用尽、返回空结果」会表现为 `undefined !== 'src/app.ts'` ——
 * 读起来像搜索坏了，而真正的原因（`DEADLINE`）就写在被丢掉的那份响应里。
 *
 * 判据用 `deadline_exceeded` 而**不是** `incomplete_reason === null`：
 * 后者在「本页命中装满了」「命中被抽走」这些**设计内**的情形里也非空，
 * 拿它当装置前提会把每一次分页都判成装置坏了。
 */
function assertNoDeadline<T extends { readonly deadline_exceeded: boolean }>(data: T): void {
  assert.equal(
    data.deadline_exceeded,
    false,
    '装置前提：这一次搜索没有因为时间预算提前结束（那是机器负载，不是搜索坏了）',
  );
}

describeWindows('LWB-015 文本搜索（真实护栏 / 真实 NTFS）', () => {
  let backend: PowerShellWinfsBackend;
  let root: string;
  let wideRoot: string;
  let scope: ReadScope;
  /** 第二个工作区：只放那个装不下的目录，免得它拖慢别的用例。 */
  let wideScope: ReadScope;
  let decision: PolicyDecision;

  const scopeOf = async (dir: string): Promise<ReadScope> => {
    const info = await backend.statVolume({ path: dir });
    if (isWinfsError(info)) throw new Error(`statVolume 失败：${info.code} ${info.message}`);
    return {
      workspace_id: 'ws-1',
      kind: 'directory',
      mode: 'read_propose_apply_with_local_approval',
      generation: 1,
      root_path: dir,
      root_volume_id: info.volume_id,
      root_file_id: info.file_id,
    };
  };

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'lwb-files-search-'));
    wideRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb-search-wide-'));
    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(capability.available, true, `护栏后端不可用：${capability.resolved_backend_reason}`);

    decision = decisionFor();

    const write = async (rel: string, body: string): Promise<void> => {
      const full = path.join(root, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, body, 'utf8');
    };

    // --- 普通内容：刚保存、没提交（这里根本没有仓库，只有字节） --------------
    await write('src/app.ts', `export function greet() {\n  return "${QUERY}";\n}\n`);
    await write('src/util.ts', `export const unused = "${QUERY}";\n`);
    await write('src/many.txt', `${Array.from({ length: 5 }, (_, i) => `${QUERY} line ${i}`).join('\n')}\n`);
    await write('docs/readme.md', '# 说明\n这里没有那个词\n');

    // --- 连名字都不该出现的几类 -------------------------------------------------
    await write('.env', `APP_SECRET=${QUERY}\n`);
    // 方案明写：`.env.example` **不**自动豁免。
    await write('.env.example', `APP_SECRET=${QUERY}\n`);
    await write('.ssh/id_rsa', `${QUERY}\n`);
    await write('ghp_012345678901234567890123456789012345.txt', `${QUERY}\n`);
    await write('node_modules/pkg/index.js', `module.exports = "${QUERY}";\n`);

    // --- 真的 PEM 私钥正文，命中落在正文中间 -----------------------------------
    // 文件名刻意平凡：`id_rsa` / `*.pem` 这类路径在打开之前就被按名字拦下了。
    await write('notes/scratch.txt', `前言\n${PEM}\n结语\n`);

    // --- 真实 junction：**不需要管理员权限**（符号链接才需要） ------------------
    const outside = await mkdtemp(path.join(os.tmpdir(), 'lwb-search-outside-'));
    await writeFile(path.join(outside, 'outside-only.txt'), `${QUERY} 在工作区之外\n`, 'utf8');
    const junction = spawnSync('cmd', ['/c', 'mklink', '/J', path.join(root, 'junction'), outside], {
      encoding: 'utf8',
    });
    assert.equal(junction.status, 0, `建立 junction 失败：${junction.stdout}${junction.stderr}`);

    scope = await scopeOf(root);

    // --- 第二个工作区：一个装不下的目录 ----------------------------------------
    const wideDir = path.join(wideRoot, 'w');
    await mkdir(wideDir, { recursive: true });
    // 前 1004 条全是**硬拒绝**的名字（`.env.*`）：它们会被看到、被计数，
    // 但一个字节都不会被读 —— 于是「走完了整个目录」的代价是列举，不是读取。
    const fillers = Array.from({ length: DENIED_FILLER }, (_, i) => `.env.${String(i).padStart(4, '0')}`);
    for (let at = 0; at < fillers.length; at += 250) {
      await Promise.all(
        fillers.slice(at, at + 250).map((name) => writeFile(path.join(wideDir, name), 'x\n', 'utf8')),
      );
    }
    // 排在最后一个窗口里的那个文件才是候选。
    await writeFile(path.join(wideDir, 'z.txt'), `${QUERY} 在第二个窗口里\n`, 'utf8');
    wideScope = await scopeOf(wideRoot);

    assert.ok(
      DENIED_FILLER + 1 > GUARD_LIST_HARD_CAP,
      '装置前提：这个目录必须装不下，否则「取第二个窗口」根本不会发生',
    );
  });

  after(async () => {
    await backend?.dispose();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    if (wideRoot !== undefined) await rm(wideRoot, { recursive: true, force: true });
  });

  function args(options: { path?: string; cursor?: string; max_matches?: number; scope?: ReadScope }) {
    return {
      scope: options.scope ?? scope,
      connection_id: CONNECTION,
      decision,
      input: {
        workspace_id: 'ws-1',
        query: QUERY,
        ...(options.path === undefined ? {} : { path: options.path }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        ...(options.max_matches === undefined ? {} : { max_matches: options.max_matches }),
      },
      now: NOW,
    };
  }

  const at = (matches: readonly { path: string; line_number: number }[]): string[] =>
    matches.map((m) => `${m.path}:${m.line_number}`);

  it('刚保存的字节立刻搜得到（没有索引，也没有缓存）', async () => {
    const data = await textSearch(args({ path: 'src', max_matches: 1 }), depsFor(backend));

    assertNoDeadline(data);
    assert.equal(data.matches[0]?.path, 'src/app.ts');
    assert.equal(data.matches[0]?.line_number, 2);
    assert.match(data.matches[0]?.snippet ?? '', new RegExp(QUERY));
  });

  it('硬拒绝与搜索排除的路径：结果里没有，而且护栏从没被问过', async () => {
    const { ops, calls } = counting(backend);
    const data = await textSearch(args({}), depsFor(ops));

    assertNoDeadline(data);
    const serialized = JSON.stringify(data);
    for (const forbidden of ['.env', '.ssh', 'node_modules', 'ghp_', 'junction', 'outside-only']) {
      assert.equal(serialized.includes(forbidden), false, `结果里不该出现 ${forbidden}`);
    }
    // 反证：断言不是凭空成立的。
    assert.equal(serialized.includes('src/app.ts'), true);

    // 「没进入」的判据是护栏**从没被问过它**，不是「结果里碰巧没有」。
    for (const neverListed of ['.ssh', 'node_modules', 'junction']) {
      assert.equal(calls.listed.includes(neverListed), false, `${neverListed} 不该被列举`);
    }
    // 被硬拒绝的文件连读都没读 —— 打开一个本不该读的文件本身就是代价。
    assert.equal(calls.read.includes('.env'), false);
    assert.equal(calls.read.includes('.env.example'), false);
    assert.equal(calls.read.includes('.ssh/id_rsa'), false);
    assert.equal(calls.read.includes('node_modules/pkg/index.js'), false);

    // `.env`、`.env.example`、`ghp_*.txt` 三个**文件**命中硬拒绝；
    // `.ssh` 与 `node_modules` 是目录，不进入、也不计入文件数。
    assert.equal(data.scope.denied_files, 3);
  });

  it('真实 junction 不被跟随：它指向的内容不出现', async () => {
    const data = await textSearch(args({}), depsFor(backend));

    assertNoDeadline(data);
    // 先证明**确实搜到了东西**：不然「命中里没有 junction」在零命中的结果上
    // 也成立，这条用例就成了永远为真的空断言（真跑过：机器忙的时候它就这么过了）。
    assert.ok(
      data.matches.length > 0,
      `装置前提：这一次搜索应当有命中，实际 ${data.matches.length} 条（${data.incomplete_reason ?? '无原因'}）`,
    );
    assert.equal(
      data.matches.some((m) => m.path.startsWith('junction')),
      false,
      `命中里不该有穿过 junction 的路径：${at(data.matches).join(', ')}`,
    );
    assert.equal(JSON.stringify(data).includes('outside-only'), false);
  });

  it('真实私钥正文里的命中：整份文件丢弃，密钥材料不出现', async () => {
    const data = await textSearch(args({}), depsFor(backend));

    assertNoDeadline(data);
    assert.equal(data.scope.secret_files, 1);
    assert.equal(data.scope.complete, false);
    assert.ok(searchBounds(data).includes('SECRET_WITHHELD'));

    const serialized = JSON.stringify(data);
    assert.equal(serialized.includes('notes/scratch.txt'), false, '被丢弃的文件不返回名字');
    assert.equal(serialized.includes('MIIEowIBAAKCAQEA'), false, '密钥正文不得出现');
    assert.equal(data.matches.some((m) => m.path === 'notes/scratch.txt'), false);
  });

  it('分页：翻完所有页与一次搜完的结果逐条相同', async () => {
    const once = await textSearch(args({ path: 'src', max_matches: 100 }), depsFor(backend));
    assertNoDeadline(once);
    assert.ok(once.matches.length >= 6, `装置前提：src 下应有至少 6 条命中，实际 ${String(once.matches.length)}`);
    assert.equal(once.next_cursor, null);

    const paged: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await textSearch(
        args({ path: 'src', max_matches: 3, ...(cursor === null ? {} : { cursor }) }),
        depsFor(backend),
      );
      paged.push(...at(page.matches));
      cursor = page.next_cursor;
      pages += 1;
      assert.ok(pages < 50, '页数异常，可能没有推进');
    } while (cursor !== null);

    assert.deepEqual(paged, at(once.matches));
    assert.ok(pages > 1, '装置前提：这个查询应当需要不止一页');
  });

  it('目录装不下时取第二个窗口：排在护栏硬上限之后的候选照样被扫到', async () => {
    // 1005 个条目 > 护栏的 1000 条窗口，因此遍历必须用 after_name 续取。
    // 判据有两条，缺一不可：
    //  1. `z.txt` 被找到（它在第二个窗口里）；
    //  2. `denied_files === 1004` —— 只取第一个窗口的遍历最多只能看到 1000 条。
    const data = await textSearch(args({ path: 'w', scope: wideScope }), depsFor(backend));

    assertNoDeadline(data);
    assert.deepEqual(at(data.matches), ['w/z.txt:1']);
    assert.equal(data.scope.denied_files, DENIED_FILLER);
    // 硬拒绝的文件一个字节都没读，因此「走完整个目录」的代价是列举，不是读取。
    assert.equal(data.scope.scanned_files, 1);
    assert.equal(data.scope.complete, true);
  });
});
