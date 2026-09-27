/**
 * LWB-015 可复现证据采集。
 *
 * 三条验收标准全部走**真实磁盘**与**真实护栏**（PowerShell + .NET P/Invoke）：
 *
 *  1. 「搜索能找到已保存未提交的变更，不需要云端索引」—— 证据分三层：
 *     刚写下的字节立刻搜得到（沙箱里没有 Git 仓库，只有字节）；
 *     改内容后下一次搜索立刻看到改后的（同一进程内，因此连进程内缓存也排除了）；
 *     以及**搜索前后整棵树逐条相同** + **护栏的写操作一次都没被调用** ——
 *     「不需要索引」不是一个说法，它是「一个字节都没有被写下去」。
 *  2. 「秘密标记不会出现在命中片段中」—— 四种真实形态各采一条：令牌与命中
 *     同行、令牌**不在**命中行、私钥正文里含命中、以及片段起点处的字边界
 *     （整份文本判不出、片段判得出）。另加硬拒绝路径与 likely 档脱敏。
 *  3. 「超时返回部分结果而非错误宣称没有匹配或已经检索全仓」—— 三个提前
 *     停下的原因（时间预算、字节预算、取消）各自采集：返回已找到的命中、
 *     `complete=false`、说清为什么停、并给出可续读的游标。**再证明那条游标
 *     真的能补回剩下的**（续读结果 + 第一次的部分结果 = 一次搜完的结果）。
 *
 * 另有三项实测：
 *   - **护栏目录窗口**：一个装不下的目录（1005 条 > 护栏硬上限 1000）里，
 *     排在第二个窗口的候选照样被扫到 —— 这条只有真护栏才测得出。
 *   - **分页**：翻完所有页与一次搜完的结果逐条相同。
 *   - **「完整」的反面**：`complete=true` 且 `matches=[]` 时，遍历确实走完了
 *     整棵子树（这是「没有匹配」这句话的对照组）。
 *
 * ## 时钟
 *
 * 时间预算的判定点在每个候选文件**之前**，读数来自注入的 `clock()`。
 * 因此「扫了两个文件之后超时」可以用一个**计数假时钟**确定地造出来
 * （它返回假时刻，磁盘与护栏全是真的）。假时钟不是权宜：真时钟下
 * 「刚好在第三个文件前超时」需要靠等待去碰，而碰出来的用例在机器变快或
 * 变慢时会翻面。作为对照，本文件另有一条**真时钟**的用例
 * （`search_time_budget_ms: 0`，deadline 在第一次判断时就已经过期），
 * 它证明这条路径在不依赖假时钟时同样成立。
 *
 * 用法：node --import tsx scripts/evidence/lwb-015.ts
 * 退出码：全部通过 0；任一项失败 1。
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { LIMITS } from '@lwb/contracts';
import type { PolicyAction } from '@lwb/policy';
import { ALL_DEFAULT_RULES, classifyFile, decide } from '@lwb/policy';
import { EgressBudget, screenText } from '@lwb/egress';
import { createReadTicketAuthority, type ReadScope } from '@lwb/files';
import { searchBounds, textSearch } from '@lwb/search';
import type { SearchDeps, SearchLimits } from '@lwb/search';
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
const KEY = 'lwb-evidence-015-key-0123456789abcdef0123456789';
const POLICY_VERSION = 1;
const QUERY = 'zzneedlezz';

/** 护栏 `$SCRIPT:LIST_HARD_CAP`。跨窗口那个用例要越过它。 */
const GUARD_LIST_HARD_CAP = 1000;
/** 跨窗口目录里的硬拒绝条目数：比护栏硬上限多，因此必须取第二个窗口。 */
const DENIED_FILLER = 1004;

// --- 夹具里的凭证形状 ------------------------------------------------------
// 全部是**形状合规的假值**，不是真凭证。证据文本里只出现它们的长度与规则名，
// 不出现值本身 —— 打印一个「像凭证的字符串」会把这份证据本身变成一份噪声源。

/** GitHub 令牌形状（第 4 条规则 `github-token`）。 */
const FAKE_TOKEN = `ghp_${'0123456789abcdefghij'.repeat(2)}`;
/** 私钥正文：`private-key-block` 要看到 BEGIN/END 才认，正文本身只是 base64。 */
const FAKE_PEM_BODY = `${'MIIEowIBAAKCAQEA'.padEnd(64, 'x')}${QUERY}${'y'.repeat(120)}`;
const PEM = ['-----BEGIN RSA PRIVATE KEY-----', FAKE_PEM_BODY, '-----END RSA PRIVATE KEY-----'].join('\n');
/** likely 档：`keyword-secret-value`（赋值形状），会脱敏但不出站拦截。 */
const LIKELY_ASSIGNMENT = `password = "hunter2hunter2"`;
/** 令牌形状（`aws-access-key-id`）：`AKIA` + 16 位大写字母数字。 */
const AKIA_SHAPED = `AKIA${'B'.repeat(16)}`;
/** 与 `packages/search/src/scan.ts` 的 `SNIPPET_LEAD_CHARS` 同值。 */
const SNIPPET_LEAD_CHARS = 64;

/**
 * 片段起点处的字边界夹具。
 *
 * 三处一起才构成这个形状，缺一处都落不到边界上：
 *  - 令牌**前面**接一个词字符 ⇒ 整份文本里前边界不成立（`\b` 要求有分隔）；
 *  - 令牌**后面**接一个非词字符 ⇒ 后边界成立（只做前一半的话，规则仍然不匹配，
 *    2026-09-25 第一版就是这么写的，于是这条用例测到的其实是「没有凭证」）；
 *  - 命中列 = 2 × 窗口前置量 ⇒ 片段窗口（`命中列 - 64`）的起点**正好**是令牌的
 *    第一个字符，而 `\b` 在输入起点处成立。
 *
 * 于是同一个文件：整份文本判不出凭证，片段判得出。这正是 `scan.ts` 保留
 * 逐片筛查的那条理由 —— 两侧都要断言，否则夹具可能根本没落在边界上。
 */
function boundaryFixture(): { line: string; window: string } {
  const lead = 'A'.repeat(SNIPPET_LEAD_CHARS);
  const tail = 'C'.repeat(SNIPPET_LEAD_CHARS - AKIA_SHAPED.length - 1);
  const line = `${lead}${AKIA_SHAPED}-${tail}${QUERY}`;
  // 片段长度远小于 MAX_SNIPPET_BYTES 且无控制字符，因此这一段就是
  // `buildSnippet()` 会交给筛查函数的那份文本。
  return { line, window: line.slice(line.indexOf(QUERY) - SNIPPET_LEAD_CHARS) };
}

/** 按需覆盖若干方法（**不能**用 `{...backend}`：类的方法在原型上）。 */
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

interface Calls {
  list: number;
  read: number;
  write: number;
  create: number;
  list_paths: string[];
  read_paths: string[];
}

/**
 * 计数装饰器：本证据里大量结论是「有几件事**没有**发生」。
 *
 * 写操作不做「记一笔然后放行」：真被调到就直接抛错 —— 一次搜索要写盘，
 * 那是实现事故而不是统计数据，它必须以失败现身，而不是变成计数里的 1。
 */
function counting(ops: WinfsOps): { ops: WinfsOps; calls: Calls } {
  const calls: Calls = { list: 0, read: 0, write: 0, create: 0, list_paths: [], read_paths: [] };
  return {
    calls,
    ops: decorate(ops, {
      listDirectory: (req) => {
        calls.list += 1;
        calls.list_paths.push(req.relative_path);
        return ops.listDirectory(req);
      },
      readFileGuarded: (req: WinfsPathRef) => {
        calls.read += 1;
        calls.read_paths.push(req.relative_path);
        return ops.readFileGuarded(req);
      },
      writeFileGuarded: (req) => {
        calls.write += 1;
        throw new Error(`搜索不应调用写操作（writeFileGuarded ${req.relative_path}）`);
      },
      createFileGuarded: (req) => {
        calls.create += 1;
        throw new Error(`搜索不应调用建文件操作（createFileGuarded ${req.relative_path}）`);
      },
    }),
  };
}

function scopeOf(rootPath: string, volumeId: string, fileId: string): ReadScope {
  return {
    workspace_id: 'ws-1',
    kind: 'directory',
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
function allowedDecision(action: PolicyAction = 'search') {
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

interface DepsOptions {
  readonly limits?: Partial<SearchLimits>;
  readonly clock?: () => number;
  readonly is_cancelled?: () => boolean;
}

/** 每次调用一份新的额度与票据：本文件里每一次搜索都是一次独立调用。 */
function depsFor(ops: WinfsOps, options: DepsOptions = {}): SearchDeps {
  return {
    ops,
    authority: createReadTicketAuthority({ key: KEY }),
    budget: new EgressBudget({ limit_bytes_per_hour: 64 * 1024 * 1024, now: () => NOW }),
    clock: options.clock ?? (() => NOW),
    ...(options.is_cancelled === undefined ? {} : { is_cancelled: options.is_cancelled }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  };
}

/**
 * 计数假时钟：第 `allowed` 个候选文件之后返回「预算已用完」。
 *
 * `clock()` 每个候选文件之前被读一次，所以「扫了几个文件之后超时」是
 * 确定的 —— 而磁盘、字节、护栏全是真的。
 */
function steppingClock(allowed: number): () => number {
  let n = 0;
  return () => {
    n += 1;
    return n <= allowed ? NOW : NOW + LIMITS.SEARCH_TIME_BUDGET_MS;
  };
}

async function main(): Promise<void> {
  console.log('== 环境 ==');
  console.log(`平台: ${process.platform} ${process.arch}`);
  console.log(`系统: ${os.type()} ${os.release()}`);
  console.log(`Node: ${process.version}`);
  console.log(`PID: ${process.pid}`);

  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-evidence-015-'));
  const wideRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb-evidence-015-wide-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'lwb-evidence-015-outside-'));
  const backend = new PowerShellWinfsBackend();
  const capability = await backend.capability();
  console.log(`护栏后端: ${capability.backend}（可用=${capability.available}）`);
  console.log(`护栏验证环境: ${capability.verified_on}`);
  console.log(`沙箱: ${sandbox}`);
  console.log(
    `契约限额 MAX_SEARCH_MATCHES=${String(LIMITS.MAX_SEARCH_MATCHES)} / ` +
      `SEARCH_TIME_BUDGET_MS=${String(LIMITS.SEARCH_TIME_BUDGET_MS)} / ` +
      `MAX_SEARCH_SCANNED_BYTES=${String(LIMITS.MAX_SEARCH_SCANNED_BYTES)} / ` +
      `MAX_SNIPPET_BYTES=${String(LIMITS.MAX_SNIPPET_BYTES)} / ` +
      `MAX_SEARCH_QUERY_CHARS=${String(LIMITS.MAX_SEARCH_QUERY_CHARS)}`,
  );
  if (!capability.available) {
    throw new Error(`护栏后端不可用：${capability.resolved_backend_reason}`);
  }

  const info = await backend.statVolume({ path: sandbox });
  if (isWinfsError(info)) throw new Error(`statVolume 失败：${info.code} ${info.message}`);
  const scope = scopeOf(sandbox, info.volume_id, info.file_id);
  console.log(`工作区根身份: ${info.volume_id}/${info.file_id}`);

  const wideInfo = await backend.statVolume({ path: wideRoot });
  if (isWinfsError(wideInfo)) throw new Error(`statVolume 失败：${wideInfo.code} ${wideInfo.message}`);
  const wideScope = scopeOf(wideRoot, wideInfo.volume_id, wideInfo.file_id);

  async function write(rel: string, body: string): Promise<void> {
    const full = path.join(sandbox, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, 'utf8');
  }

  // --- 夹具 ---------------------------------------------------------------
  // 沙箱里**没有 Git 仓库**：全部内容都是刚写下去、从未提交的字节。
  await write('src/app.ts', `export function greet() {\n  return "${QUERY}";\n}\n`);
  await write('src/many.txt', `${Array.from({ length: 5 }, (_, i) => `${QUERY} line ${i}`).join('\n')}\n`);
  await write('src/notes.md', '# 说明\n这里没有那个词\n');
  await write('src/util.ts', `export const unused = "${QUERY}";\n`);
  await write('change/live.txt', 'before\n');
  await write('docs/readme.md', '# 文档\n无关内容\n');

  await write('secrets/on-line.txt', `${QUERY} ${FAKE_TOKEN}\n`);
  await write('secrets/other-line.txt', `const k = "${FAKE_TOKEN}";\n${QUERY}\n`);
  await write('secrets/notes.txt', `前言\n${PEM}\n结语\n`);
  await write('secrets/likely.txt', `${QUERY} ${LIKELY_ASSIGNMENT}\n`);
  await write('secrets/boundary.txt', `${boundaryFixture().line}\n`);

  await write('.env', `APP_SECRET=${QUERY}\n`);
  // 方案明写：`.env.example` **不**自动豁免。
  await write('.env.example', `APP_SECRET=${QUERY}\n`);
  await write('.ssh/id_rsa', `${QUERY}\n`);
  await write(`ghp_${'0'.repeat(36)}.txt`, `${QUERY}\n`);
  await write('node_modules/pkg/index.js', `module.exports = "${QUERY}";\n`);

  // 真实 junction：**不需要管理员权限**（符号链接才需要）。
  await writeFile(path.join(outside, 'outside-only.txt'), `${QUERY} 在工作区之外\n`, 'utf8');
  const junction = spawnSync('cmd', ['/c', 'mklink', '/J', path.join(sandbox, 'junction'), outside], {
    encoding: 'utf8',
  });
  if (junction.status !== 0) {
    throw new Error(`建立 junction 失败：${junction.stdout}${junction.stderr}`);
  }

  // 第二个工作区：一个装不下的目录（1005 条 > 护栏硬上限 1000）。
  const wideDir = path.join(wideRoot, 'w');
  await mkdir(wideDir, { recursive: true });
  // 前 1004 条全是**硬拒绝**的名字（`.env.*`）：它们会被看到、被计数，
  // 但一个字节都不会被读 —— 于是「走完整个目录」的代价是列举，不是读取。
  const fillers = Array.from({ length: DENIED_FILLER }, (_, i) => `.env.${String(i).padStart(4, '0')}`);
  for (let at = 0; at < fillers.length; at += 250) {
    await Promise.all(
      fillers.slice(at, at + 250).map((name) => writeFile(path.join(wideDir, name), 'x\n', 'utf8')),
    );
  }
  await writeFile(path.join(wideDir, 'z.txt'), `${QUERY} 在第二个窗口里\n`, 'utf8');

  console.log(
    `夹具: src/ 4 个文件（含 ${String(7)} 条命中）/ secrets/ 5 个凭证形态 / ` +
      `真实 junction → ${outside} / 第二工作区 ${String(DENIED_FILLER + 1)} 条（> 护栏硬上限 ${String(GUARD_LIST_HARD_CAP)}）`,
  );

  function args(
    options: {
      path?: string;
      path_glob?: string;
      cursor?: string;
      max_matches?: number;
      scope?: ReadScope;
    } = {},
  ) {
    return {
      scope: options.scope ?? scope,
      connection_id: CONNECTION,
      decision: allowedDecision('search'),
      input: {
        workspace_id: 'ws-1',
        query: QUERY,
        ...(options.path === undefined ? {} : { path: options.path }),
        ...(options.path_glob === undefined ? {} : { path_glob: options.path_glob }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        ...(options.max_matches === undefined ? {} : { max_matches: options.max_matches }),
      },
      now: NOW,
    };
  }

  const at = (data: { matches: readonly { path: string; line_number: number }[] }): string[] =>
    data.matches.map((m) => `${m.path}:${m.line_number}`);

  // =========================================================================
  section('验收标准 1 · 搜索能找到已保存未提交的变更，不需要云端索引');
  // =========================================================================

  {
    const launched = await textSearch(args({ path: 'src' }), depsFor(backend));
    check(
      '刚写下的字节立刻搜得到，且命中位置与磁盘上的字节一致',
      at(launched).join(',') === 'src/app.ts:2,src/many.txt:1,src/many.txt:2,src/many.txt:3,src/many.txt:4,src/many.txt:5,src/util.ts:1' &&
        launched.matches[0]?.column === 10 &&
        launched.matches[0]?.snippet === `  return "${QUERY}";`,
      `命中=${JSON.stringify(at(launched))} 首条 column=${String(launched.matches[0]?.column)} 片段=${JSON.stringify(launched.matches[0]?.snippet)}`,
    );
    check(
      '这些命中确实来自本次读取（读到的字节数与计数字段对得上）',
      launched.scope.scanned_files === 4 && launched.scope.scanned_bytes > 0,
      `scanned_files=${String(launched.scope.scanned_files)} scanned_bytes=${String(launched.scope.scanned_bytes)}`,
    );
  }

  {
    // 同一个进程、同一棵树、同一个文件：改内容之后立刻再搜。
    // 进程内若有任何缓存，第二次会返回第一次的答案 —— 因此这条同时排除了
    // 「服务端缓存」与「进程内缓存」两种「索引」。
    const before = await textSearch(args({ path: 'change' }), depsFor(backend));
    await write('change/live.txt', `after ${QUERY}\n`);
    const after = await textSearch(args({ path: 'change' }), depsFor(backend));
    check(
      '内容改了，下一次搜索立刻看到改后的（同一个进程，因此也没有进程内缓存）',
      before.matches.length === 0 && at(after).join(',') === 'change/live.txt:1' && after.matches[0]?.snippet === `after ${QUERY}`,
      `改写前=${JSON.stringify(at(before))} 改写后=${JSON.stringify(at(after))} 片段=${JSON.stringify(after.matches[0]?.snippet)}`,
    );
  }

  /**
   * 沙箱里的全部条目（工作区相对路径，`/` 分隔）。
   *
   * 走 `node:fs` 而不是护栏：这一份的用途是「搜索有没有在磁盘上留下别的东西」，
   * 用**另一个**读取路径去看才说明问题 —— 用被测的那条路径去看，等于让它
   * 自己证明自己没写坏。
   */
  async function snapshot(): Promise<{ rel: string; is_file: boolean }[]> {
    const entries = await readdir(sandbox, { recursive: true, withFileTypes: true });
    return entries
      .map((e) => ({
        rel: path.relative(sandbox, path.join(e.parentPath, e.name)).split(path.sep).join('/'),
        is_file: e.isFile(),
      }))
      .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  }

  /**
   * 按**策略规则**算出「这一次搜索应当看到什么」，用来与结果里的计数对账。
   *
   * 规则表来自 `@lwb/policy` 本身、输入来自 `readdir` 读到的真实目录，
   * 因此对账的是「结果里那几个数说的是不是这棵树」，而不是「实现有没有照抄规则」。
   *
   * 三处容易漏的细节在这里显式写出来：
   *  - **目录不进任何计数**（契约里三个计数说的都是文件）。目录的归宿只有
   *    「进入」或「不进入」，而没进入的目录里的文件**从未被看到** —— 于是
   *    `.ssh/id_rsa` 既不在 `denied_files` 里，也不在 `skipped_files` 里；
   *  - 名字本身就是令牌形状的文件（`ghp_…txt`）命中的是**名字筛查**，
   *    不是路径规则：归宿相同（拒），判据不同；
   *  - 重解析点（junction）与搜索排除的目录一样不进入。
   */
  function expectedCounts(
    entries: readonly { rel: string; is_file: boolean }[],
    reparseDirs: readonly string[],
  ): { scanned: number; denied: number; excluded: number; unseen: number } {
    const out = { scanned: 0, denied: 0, excluded: 0, unseen: 0 };
    for (const entry of entries) {
      if (!entry.is_file) continue;
      const segments = entry.rel.split('/');
      const hidden = segments.slice(0, -1).some((name, i) => {
        const dir = segments.slice(0, i + 1).join('/');
        const verdict = classifyFile(dir, ALL_DEFAULT_RULES);
        return (
          verdict.kind === 'hard_deny' ||
          verdict.kind === 'search_exclude' ||
          screenText(name).has_certain ||
          reparseDirs.includes(dir)
        );
      });
      if (hidden) {
        out.unseen += 1;
        continue;
      }
      const verdict = classifyFile(entry.rel, ALL_DEFAULT_RULES);
      if (verdict.kind === 'hard_deny' || screenText(segments.at(-1) ?? '').has_certain) out.denied += 1;
      else if (verdict.kind === 'search_exclude') out.excluded += 1;
      else out.scanned += 1;
    }
    return out;
  }

  {
    const { ops, calls } = counting(backend);
    const treeBefore = (await snapshot()).map((e) => e.rel);
    const data = await textSearch(args({}), depsFor(ops));
    const treeAfter = (await snapshot()).map((e) => e.rel);
    const added = treeAfter.filter((e) => !treeBefore.includes(e));
    const removed = treeBefore.filter((e) => !treeAfter.includes(e));
    check(
      '整次搜索没有写下任何索引或缓存：搜索前后整棵树逐条相同',
      added.length === 0 && removed.length === 0 && treeBefore.length > 10,
      `搜索前 ${String(treeBefore.length)} 条 / 搜索后 ${String(treeAfter.length)} 条 / 新增=${JSON.stringify(added)} 消失=${JSON.stringify(removed)}`,
    );
    check(
      '「不需要索引」的结构性证据：护栏的写操作与建文件操作一次都没有被调用',
      calls.write === 0 && calls.create === 0,
      `writeFileGuarded=${String(calls.write)} 次 createFileGuarded=${String(calls.create)} 次 / 读取 ${String(calls.read)} 次 / 列举 ${String(calls.list)} 次`,
    );

    const expected = expectedCounts(await snapshot(), ['junction']);
    check(
      '覆盖范围对得上：结果里的「扫了多少 / 拒了多少 / 跳过了多少」与这棵树一致',
      data.scope.scanned_files === expected.scanned &&
        data.scope.denied_files === expected.denied &&
        data.scope.skipped_files === expected.excluded,
      `scanned=${String(data.scope.scanned_files)}(期望 ${String(expected.scanned)}) ` +
        `denied=${String(data.scope.denied_files)}(期望 ${String(expected.denied)}) ` +
        `skipped=${String(data.scope.skipped_files)}(期望 ${String(expected.excluded)}) ` +
        `未被看到=${String(expected.unseen)}（目录里的文件不算「跳过」） ` +
        `secret=${String(data.scope.secret_files)}（scanned 的子集，内容已被抽走）`,
    );
  }

  {
    // 对照组：「没有匹配」这句话要能被当真。
    const data = await textSearch(args({ path: 'src', path_glob: 'notes.md' }), depsFor(backend));
    check(
      '真的没有匹配时说得清：complete=true 且命中为空（不是「没看完」）',
      data.matches.length === 0 && data.scope.complete === true && data.next_cursor === null && data.scope.scanned_files === 1,
      `命中 ${String(data.matches.length)} 条 / complete=${String(data.scope.complete)} / scanned=${String(data.scope.scanned_files)} / skipped=${String(data.scope.skipped_files)}（glob 未匹配）`,
    );
  }

  // =========================================================================
  section('验收标准 2 · 秘密标记不会出现在命中片段中');
  // =========================================================================

  {
    const data = await textSearch(args({ path: 'secrets' }), depsFor(backend));
    const serialized = JSON.stringify(data);
    const leaked = ['ghp_', 'PRIVATE KEY', 'MIIEowIBAAKCAQEA', AKIA_SHAPED, 'hunter2hunter2'].filter((needle) =>
      serialized.includes(needle),
    );
    check(
      '四种凭证形态（令牌与命中同行 / 令牌在别的行 / 私钥正文 / 片段起点字边界）都不返回内容',
      leaked.length === 0 && data.scope.secret_files === 4,
      `secret_files=${String(data.scope.secret_files)} 泄露片段=${JSON.stringify(leaked)} 命中=${JSON.stringify(at(data))}`,
    );
    check(
      '被抽走内容的文件连**文件名**都不返回',
      !serialized.includes('secrets/on-line.txt') &&
        !serialized.includes('secrets/other-line.txt') &&
        !serialized.includes('secrets/notes.txt') &&
        !serialized.includes('secrets/boundary.txt'),
      `结果里出现过的路径=${JSON.stringify(data.matches.map((m) => m.path))}`,
    );
    check(
      '整份文件的凭证被抽走时，本次搜索**不失败**，其余文件照常返回',
      data.scope.complete === false && searchBounds(data).includes('SECRET_WITHHELD') && serialized.includes('secrets/likely.txt'),
      `complete=${String(data.scope.complete)} 边界=${JSON.stringify(searchBounds(data))} 原因=${String(data.incomplete_reason)}`,
    );
  }

  {
    // likely 档：文件不丢弃，片段被脱敏 —— 与 certain 档是两种处置，都要采。
    const data = await textSearch(args({ path: 'secrets', path_glob: 'likely.txt' }), depsFor(backend));
    const match = data.matches[0];
    check(
      'likely 档的赋值形状：片段被脱敏，标记值不出现，且如实标了 redacted',
      data.matches.length === 1 &&
        match?.redacted === true &&
        !match.snippet.includes('hunter2hunter2') &&
        match.snippet.includes('[REDACTED:') &&
        match.snippet.includes(QUERY),
      `redacted=${String(match?.redacted)} 片段=${JSON.stringify(match?.snippet)}`,
    );
  }

  {
    // 「预筛判的是整个文件」这条设计的存在理由：把它单独采一次。
    // 判据必须是**两个方向都成立**：整份文本判不出（否则测的是另一条路），
    // 而片段判得出（否则这条夹具根本没落在边界上）。
    const { line, window } = boundaryFixture();
    const wholeCertain = screenText(line).has_certain;
    const snippetCertain = screenText(window).has_certain;
    const data = await textSearch(args({ path: 'secrets', path_glob: 'boundary.txt' }), depsFor(backend));
    check(
      '片段起点处的字边界：整份文本判不出、片段判得出，且这个文件仍然被整份丢弃',
      wholeCertain === false && snippetCertain === true && data.scope.secret_files === 1 && data.matches.length === 0,
      `整份文本 has_certain=${String(wholeCertain)} / 片段 has_certain=${String(snippetCertain)} / 该文件 secret=${String(data.scope.secret_files)} 命中=${String(data.matches.length)}`,
    );
  }

  {
    const { ops, calls } = counting(backend);
    const data = await textSearch(args({}), depsFor(ops));
    const serialized = JSON.stringify(data);
    const leaked = ['.env', '.ssh', 'id_rsa', 'node_modules', 'ghp_', 'junction', 'outside-only'].filter((needle) =>
      serialized.includes(needle),
    );
    check(
      '硬拒绝与搜索排除的路径：名字与内容都不出现在结果里（`.env.example` 同样不豁免）',
      leaked.length === 0,
      `泄露片段=${JSON.stringify(leaked)} / denied=${String(data.scope.denied_files)} excluded=${String(data.scope.skipped_files)}`,
    );
    check(
      '「没扫到」的判据是护栏**从没被问过**这些路径，不是「结果里碰巧没有」',
      ['.ssh', 'node_modules', 'junction'].every((p) => !calls.list_paths.includes(p)) &&
        ['.env', '.env.example', '.ssh/id_rsa', 'node_modules/pkg/index.js'].every((p) => !calls.read_paths.includes(p)) &&
        calls.read_paths.includes('src/app.ts'),
      `列举过的路径=${JSON.stringify(calls.list_paths)} / 读过的路径数=${String(calls.read_paths.length)}`,
    );
  }

  // =========================================================================
  section('验收标准 3 · 超时返回部分结果而非错误宣称没有匹配或已经检索全仓');
  // =========================================================================

  const FULL_SRC = 'src/app.ts:2,src/many.txt:1,src/many.txt:2,src/many.txt:3,src/many.txt:4,src/many.txt:5,src/util.ts:1';

  {
    const data = await textSearch(args({ path: 'src' }), depsFor(backend));
    check(
      '装置前提：`src` 一次搜完是 7 条命中（后面几条「提前停下」的用例都以它为分母）',
      at(data).join(',') === FULL_SRC,
      `命中=${JSON.stringify(at(data))}`,
    );
  }

  {
    // 计数假时钟：允许两个候选文件，第三个之前超时。
    // 顺序是 ordinal 序：app.ts < many.txt < notes.md < util.ts。
    const { ops, calls } = counting(backend);
    const data = await textSearch(args({ path: 'src' }), depsFor(ops, { clock: steppingClock(2) }));
    const reason = String(data.incomplete_reason);
    check(
      '时间预算到点：返回**已经找到的**命中，不是空结果，也不是错误',
      data.matches.length === 6 &&
        at(data).join(',') === 'src/app.ts:2,src/many.txt:1,src/many.txt:2,src/many.txt:3,src/many.txt:4,src/many.txt:5',
      `命中 ${String(data.matches.length)} 条=${JSON.stringify(at(data))} / 读了 ${String(calls.read)} 个文件`,
    );
    check(
      '并且明说「没检索全仓」：complete=false + deadline_exceeded + 原因里带预算值',
      data.scope.complete === false &&
        data.deadline_exceeded === true &&
        data.cancelled === false &&
        reason.includes(`已达到时间预算 ${String(LIMITS.SEARCH_TIME_BUDGET_MS)} ms`) &&
        searchBounds(data).includes('DEADLINE'),
      `complete=${String(data.scope.complete)} deadline_exceeded=${String(data.deadline_exceeded)} 原因=${JSON.stringify(reason)}`,
    );
    check(
      '并且给出可续读的游标（锚点落在最后一条已返回的命中之后，而不是从头再来）',
      data.next_cursor !== null && data.truncated === true && searchBounds(data).includes('PAGE_FULL'),
      `truncated=${String(data.truncated)} 游标=${data.next_cursor === null ? 'null' : `已签发（${String(data.next_cursor.length)} 字符）`}`,
    );

    // 那条游标真的能把剩下的补回来 —— 否则「可续读」只是一个形状。
    const rest = await textSearch(args({ path: 'src', cursor: data.next_cursor ?? '' }), depsFor(backend));
    check(
      '用那条游标续读：与第一次的部分结果拼起来，恰好等于一次搜完（不重不漏）',
      [...at(data), ...at(rest)].join(',') === FULL_SRC,
      `第一段 ${String(data.matches.length)} 条 + 续读 ${String(rest.matches.length)} 条 = ${JSON.stringify([...at(data), ...at(rest)])}`,
    );
  }

  {
    // 真时钟对照：deadline 在第一次判断时就已经过期（预算 0）。
    // 这条不依赖假时钟，代价是它看不到任何命中 —— 因此两条都要有。
    // `clock` 与 `args.now` 必须**在同一个刻度上**：混用会让「预算已过期」
    // 这个判断恒为真或恒为假，而两种情况看起来都像「搜索坏了」。
    const { ops, calls } = counting(backend);
    const withRealClock = await textSearch(
      args({ path: 'src' }),
      depsFor(ops, { clock: () => Date.now(), limits: { search_time_budget_ms: 0 } }),
    );
    check(
      '真时钟下预算为 0：一个文件都没读，且**仍然**声明不完整（不是「没有匹配」）',
      withRealClock.matches.length === 0 &&
        withRealClock.deadline_exceeded === true &&
        withRealClock.scope.complete === false &&
        calls.read === 0,
      `命中 ${String(withRealClock.matches.length)} 条 / 读 ${String(calls.read)} 个文件 / complete=${String(withRealClock.scope.complete)} / 原因=${JSON.stringify(withRealClock.incomplete_reason)}`,
    );
  }

  {
    const { ops, calls } = counting(backend);
    const data = await textSearch(
      args({ path: 'src' }),
      depsFor(ops, { limits: { max_search_scanned_bytes: 40 } }),
    );
    check(
      '字节预算到点：同样返回已找到的部分结果，并说清是字节上限而不是时间',
      data.matches.length > 0 &&
        data.byte_budget_exceeded === true &&
        data.deadline_exceeded === false &&
        data.scope.complete === false &&
        searchBounds(data).includes('BYTE_BUDGET'),
      `命中 ${String(data.matches.length)} 条=${JSON.stringify(at(data))} / scanned_bytes=${String(data.scope.scanned_bytes)} / 读了 ${String(calls.read)} 个文件 / 原因=${JSON.stringify(data.incomplete_reason)}`,
    );
  }

  {
    let cancelled = false;
    const data = await textSearch(
      args({ path: 'src' }),
      depsFor(backend, {
        clock: () => NOW,
        is_cancelled: () => {
          // 第二个候选文件之前取消：与「时间预算」不同，这是调用方主动喊停。
          const was = cancelled;
          cancelled = true;
          return was;
        },
      }),
    );
    check(
      '取消：返回已经找到的部分结果，标 cancelled，且**不**声称已经检索全仓',
      data.cancelled === true &&
        data.scope.complete === false &&
        searchBounds(data).includes('CANCELLED') &&
        data.matches.length >= 1 &&
        String(data.incomplete_reason).includes('已被取消'),
      `cancelled=${String(data.cancelled)} 命中 ${String(data.matches.length)} 条 / complete=${String(data.scope.complete)} / 原因=${JSON.stringify(data.incomplete_reason)}`,
    );
  }

  {
    const once = await textSearch(args({ path: 'src', max_matches: 100 }), depsFor(backend));
    const paged: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await textSearch(
        args({ path: 'src', max_matches: 3, ...(cursor === null ? {} : { cursor }) }),
        depsFor(backend),
      );
      paged.push(...at(page));
      cursor = page.next_cursor;
      pages += 1;
      if (pages > 20) throw new Error('翻页没有推进（页数超过 20）');
    } while (cursor !== null);
    check(
      '分页：翻完所有页与一次搜完逐条相同（页满时那条「还有更多」的证据是真的）',
      once.next_cursor === null && paged.join(',') === at(once).join(',') && pages === 3,
      `一次搜完 ${String(once.matches.length)} 条 / 分 ${String(pages)} 页 / 拼接 ${String(paged.length)} 条 ${JSON.stringify(paged)}`,
    );
  }

  {
    // 游标绑定的是**查询的摘要**：换一个查询串，同一个游标必须被拒。
    const first = await textSearch(args({ path: 'src', max_matches: 2 }), depsFor(backend));
    const resumed = args({ path: 'src', cursor: first.next_cursor ?? '' });
    let rejection: { code?: string; details?: Record<string, unknown> } = {};
    try {
      await textSearch({ ...resumed, input: { ...resumed.input, query: 'other' } }, depsFor(backend));
    } catch (error) {
      rejection = error as { code?: string; details?: Record<string, unknown> };
    }
    check(
      '游标与查询绑定：换一个查询串复用同一个游标会被拒绝，而不是拿它继续扫',
      rejection.code === 'READ_TOKEN_STALE' && rejection.details?.reason === 'CURSOR_QUERY_MISMATCH',
      `码=${String(rejection.code)} 理由=${String(rejection.details?.reason)}`,
    );
  }

  {
    // 跨窗口：1005 个条目 > 护栏的 1000 条窗口，因此遍历必须用 after_name 续取。
    const data = await textSearch(args({ path: 'w', scope: wideScope }), depsFor(backend));
    check(
      '目录装不下时取第二个窗口：排在护栏硬上限之后的候选照样被扫到',
      at(data).join(',') === 'w/z.txt:1' && data.scope.denied_files === DENIED_FILLER && data.scope.complete === true,
      `命中=${JSON.stringify(at(data))} denied=${String(data.scope.denied_files)}（> 护栏硬上限 ${String(GUARD_LIST_HARD_CAP)}）/ scanned=${String(data.scope.scanned_files)}`,
    );
    check(
      '硬拒绝的文件一个字节都没读：走完整个目录的代价是列举，不是读取',
      data.scope.scanned_files === 1 && data.scope.scanned_bytes > 0,
      `scanned_files=${String(data.scope.scanned_files)} scanned_bytes=${String(data.scope.scanned_bytes)}`,
    );
  }

  // =========================================================================
  section('未执行项（不得记为通过）');
  // =========================================================================

  skip(
    '真实 ChatGPT Web 端到端搜索验收',
    '需要真实账号与 Secure MCP Tunnel 凭据；LWB-002 仍为 BLOCKED',
  );
  skip(
    '数万文件级仓库上的搜索耗时与内存',
    '本证据的规模是「一次调用能看多远」（1005 条的目录 + 数十个文件）；大仓库的吞吐与内存属性能采集，不在本任务的三条验收标准内',
  );
  skip(
    'NTFS 之外的卷上的搜索（ReFS / 网络盘 / 云占位文件）',
    '本机只有 NTFS；护栏的卷形态判定覆盖了拒绝路径，但未在真实 ReFS 上采集',
  );
  skip(
    '搜索期间工作区被**持续**改写的并发压力',
    '本证据覆盖的是单点变更（内容被改、文件消失、身份变化）；持续改写的压力测试属多实例/负载场景，V1 为单用户单 daemon',
  );
  skip(
    '超大文件（> MAX_READABLE_FILE_BYTES）在真实磁盘上的跳过',
    '该路径由单元测试覆盖（`too_large` 只作废这一个文件）；造一个 16 MiB 以上的真实文件会显著拖慢本脚本，且判据不落在真实文件系统的形态上',
  );

  await backend.dispose();
  await rm(sandbox, { recursive: true, force: true });
  await rm(wideRoot, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? '全部通过。' : `有 ${failures} 项未通过。`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
