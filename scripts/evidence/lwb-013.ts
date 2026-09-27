/**
 * LWB-013 可复现证据采集。
 *
 * 三条验收标准全部走**真实磁盘**与**真实护栏**（PowerShell + .NET P/Invoke）：
 *
 *  1. 「中文、emoji、BOM、CRLF、无末尾换行读取正确」—— 逐个读**夹具仓库**里
 *     的真实文件，把结果与 `manifest.json` 逐项比对。夹具清单是一份**独立实现**
 *     的产物（`tests/fixtures/build-fixtures.ts` 自己算行数与换行），因此它不只是
 *     "把实现写的东西再断言一遍"。它当初真的抓到过一个差一（见 §4.1）。
 *  2. 「截断结果不会冒充完整文件」—— 三种冒充方式各验一遍：长行截断、
 *     分页、以及"整份读回但字节数其实被上限切过"。判据是 `truncated` /
 *     `truncated_lines` / `has_more`，而不是"看起来读完了"。
 *  3. 「伪造或跨工作区重放读取票据被拒绝」—— 用**真的**签发出来的票据做底，
 *     逐项改一个绑定项（连接、工作区、代次、路径、基线、有效期、密钥），
 *     每一项都必须被拒**且给出对应的理由标签**。
 *
 * 另有三项实测：
 *   - **写冲突**：让护栏自己在目标上持一个排他写句柄，然后在同一文件上发起读取。
 *     这不是模拟 —— 冲突来自真实的 Win32 共享模式语义。读完之后重启后端，
 *     证明"读不了"确实是那个句柄造成的（否则它也读不了，这条就没有说服力）。
 *   - **硬拒绝在读字节之前**：`.env` 的读取必须发生**零次**真实文件打开。
 *   - **上限是硬的**：把 `MAX_READABLE_FILE_BYTES` / `MAX_LINE_BYTES` /
 *     `MAX_EDITABLE_FILE_BYTES` 逐个顶到边界上，看结论是否如契约所写。
 *
 * 用法：node --import tsx scripts/evidence/lwb-013.ts
 * 退出码：全部通过 0；任一项失败 1。
 */

import { createHash, createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { LIMITS } from '@lwb/contracts';
import type { PolicyAction } from '@lwb/policy';
import { decide } from '@lwb/policy';
import { EgressBudget } from '@lwb/egress';
import {
  assertReadTokenMatches,
  createReadTicketAuthority,
  readFile as readViaGuardedHandles,
  statFile,
  type ReadDeps,
  type ReadScope,
} from '@lwb/files';
import { PowerShellWinfsBackend, ResidentHelper, isWinfsError, type WinfsOps, type WinfsPathRef } from '@lwb/winfs';

import { TESTREPO_DIR, loadManifest } from '../../tests/fixtures/index.ts';

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
const KEY = 'lwb-evidence-013-key-0123456789abcdef0123456789';
const POLICY_VERSION = 1;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

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

function scopeOf(rootPath: string, volumeId: string, fileId: string, workspaceId: string): ReadScope {
  return {
    workspace_id: workspaceId,
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
 * 手搓的话，本证据里"读取"这件事就绕过了策略层，而被绕过的恰好是将来最可能
 * 出错的那一层。路径留空是**故意**的：实路径会被 `classifyFile` 拒（`.env` 等），
 * 而这里要验的是策略层**之后**的几层。
 */
function allowedDecision(action: PolicyAction, workspaceId: string) {
  const decision = decide({
    connection: {
      connection_id: CONNECTION,
      enabled: true,
      granted_capabilities: ['read', 'search', 'list', 'git_read', 'propose'],
      audience: 'mcp_adapter',
      granted_workspace_ids: [workspaceId],
    },
    workspace: {
      workspace_id: workspaceId,
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

function depsFor(ops: WinfsOps): ReadDeps {
  return {
    ops,
    authority: createReadTicketAuthority({ key: KEY }),
    budget: new EgressBudget({ limit_bytes_per_hour: 64 * 1024 * 1024, now: () => NOW }),
  };
}

interface ReadOutcome {
  readonly ok: boolean;
  readonly code?: string;
  readonly details?: Record<string, unknown>;
  readonly value?: Awaited<ReturnType<typeof readViaGuardedHandles>>;
}

async function attemptRead(
  args: Parameters<typeof readViaGuardedHandles>[0],
  deps: ReadDeps,
): Promise<ReadOutcome> {
  try {
    return { ok: true, value: await readViaGuardedHandles(args, deps) };
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

  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-evidence-013-'));
  let backend = new PowerShellWinfsBackend();
  const capability = await backend.capability();
  console.log(`护栏后端: ${capability.backend}（可用=${capability.available}）`);
  console.log(`护栏验证环境: ${capability.verified_on}`);
  console.log(`临时目录: ${sandbox}`);
  note('夹具仓库', TESTREPO_DIR);

  check(
    '护栏可用（不可用时本证据的其余部分都无意义）',
    capability.available,
    capability.resolved_backend_reason,
  );
  if (!capability.available) {
    console.log('\n护栏不可用，后续各项无法采集。');
    process.exitCode = 1;
    return;
  }

  const ws = path.join(sandbox, 'ws');
  await mkdir(ws, { recursive: true });
  const wsInfo = await backend.statVolume({ path: ws });
  if (isWinfsError(wsInfo)) throw new Error(`statVolume 失败：${wsInfo.message}`);
  const wsScope = scopeOf(ws, wsInfo.volume_id, wsInfo.file_id, 'ws-evidence');

  const repoInfo = await backend.statVolume({ path: TESTREPO_DIR });
  if (isWinfsError(repoInfo)) throw new Error(`statVolume 失败：${repoInfo.message}`);
  const repoScope = scopeOf(TESTREPO_DIR, repoInfo.volume_id, repoInfo.file_id, 'ws-fixtures');

  const wsDeps = depsFor(backend);
  const repoDeps = depsFor(backend);

  const readArgs = (scope: ReadScope, relPath: string, extra: Record<string, unknown> = {}) => ({
    scope,
    connection_id: CONNECTION,
    decision: allowedDecision('read', scope.workspace_id),
    input: { workspace_id: scope.workspace_id, path: relPath, ...extra },
    now: NOW,
  });

  /** 每次都用当前的身份重新取根引用。 */
  const wsRef: WinfsPathRef = {
    root_path: wsScope.root_path,
    root_volume_id: wsScope.root_volume_id,
    root_file_id: wsScope.root_file_id,
    relative_path: '',
  };

  // =========================================================================
  section('验收标准 1：中文、emoji、BOM、CRLF、无末尾换行读取正确');
  // =========================================================================

  const manifest = await loadManifest();
  note('夹具清单', `${manifest.files.length} 项，由 ${manifest.generated_by} 生成`);

  // 只挑**整份**能被一页读完、且**没有任何一行**超过单行上限的文件做逐字节比对。
  //
  // 最后那个条件不能省：`edge/long-line.txt` 只有 9001 字节、1 行，
  // 尺寸与行数都远在上限之内，但它的那一行本身超限 —— 读出来必然是被截断的正文。
  // 本文件第一次采集时就把它算进了"整份可读"，于是这条断言在**产品行为正确**的情况下
  // 报了 FAIL（见 summary §4.1）。判据必须写成"这次读回来的就是磁盘上的全部字节"，
  // 而不是"这个文件看起来够小"。
  const oversizedLine: string[] = [];
  const wholeFileReadable = [];
  for (const entry of manifest.files) {
    if (entry.contentKind !== 'text') continue;
    // `secrets/` 与 `config/` 是**故意**排除的：前者按脱敏出站（正文必然与磁盘不同），
    // 后者是硬拒绝路径（读不到）。它们各自在下面单独验，混在这里只会让这条断言
    // 变成一句"除了有问题的那些，其它都没问题"。
    if (entry.relPath.startsWith('secrets/') || entry.relPath.startsWith('config/')) continue;
    if ((entry.lineCount ?? 0) > LIMITS.MAX_READ_LINES) continue;
    if (entry.bytes > LIMITS.MAX_READABLE_FILE_BYTES) continue;

    const bytes = await readFile(path.join(TESTREPO_DIR, entry.relPath));
    const longest = bytes
      .toString('utf8')
      .split('\n')
      .reduce((max, line) => Math.max(max, Buffer.byteLength(line, 'utf8')), 0);
    if (longest > LIMITS.MAX_LINE_BYTES) {
      oversizedLine.push(`${entry.relPath}（单行 ${String(longest)} 字节）`);
      continue;
    }
    wholeFileReadable.push(entry);
  }
  if (oversizedLine.length > 0) {
    note('因单行超限而单独验的夹具', oversizedLine.join(' | '));
  }
  note(
    '整份可读的夹具',
    `${wholeFileReadable.length} 项：${wholeFileReadable.map((f) => f.relPath).join(' | ')}`,
  );

  let mismatches = 0;
  const mismatchDetail: string[] = [];
  for (const entry of wholeFileReadable) {
    const outcome = await attemptRead(readArgs(repoScope, entry.relPath), repoDeps);
    const mismatch = (why: string): void => {
      mismatches += 1;
      mismatchDetail.push(`${entry.relPath}: ${why}`);
    };
    if (!outcome.ok || outcome.value === undefined) {
      mismatch(`读取失败 ${outcome.code}`);
      continue;
    }
    const data = outcome.value;
    // 逐字节比对：`content` 必须与磁盘上的字节**完全相同**（BOM 之外的改写
    // 一律视为不一致）。BOM 会被剥离并单独用 `bom` 说明，因此比对时补回去。
    const onDisk = await readFile(path.join(TESTREPO_DIR, entry.relPath));
    const expectedText = entry.hasBom ? onDisk.subarray(3).toString('utf8') : onDisk.toString('utf8');
    if (data.content !== expectedText) mismatch('正文与磁盘字节不同');
    if (data.sha256 !== entry.sha256) mismatch(`sha256 不符（回执 ${data.sha256.slice(0, 12)}…）`);
    if (data.sha256 !== sha256(onDisk)) mismatch('回执哈希与本地算出的哈希不符');
    if (data.total_lines !== entry.lineCount) mismatch(`行数 ${data.total_lines} ≠ 清单 ${String(entry.lineCount)}`);
    if (data.newline !== entry.newline) mismatch(`换行 ${data.newline} ≠ 清单 ${entry.newline}`);
    if (data.bom !== entry.hasBom) mismatch(`BOM ${String(data.bom)} ≠ 清单 ${String(entry.hasBom)}`);
    if (data.truncated) mismatch('整份可读的文件被标成了截断');
    if (data.path !== entry.relPath) mismatch(`回执路径 ${data.path} ≠ 清单 ${entry.relPath}`);
  }
  check(
    '逐个夹具：正文逐字节相同、哈希/行数/换行/BOM 与独立的清单一致',
    mismatches === 0,
    mismatches === 0 ? `${wholeFileReadable.length} 项全部一致` : mismatchDetail.slice(0, 5).join(' | '),
  );

  // ---- 逐个形态点名，避免上面那条"全都对"掩盖某一类没覆盖 ----
  const byPath = new Map(manifest.files.map((f) => [f.relPath, f]));
  const forms: readonly { label: string; relPath: string; note: string }[] = [
    { label: '中文路径与正文', relPath: '文档/设计说明.md', note: '' },
    { label: 'emoji 路径', relPath: '资料/2026年方案/📄笔记.txt', note: '' },
    { label: 'UTF-8 BOM', relPath: 'bom/with-bom.txt', note: '' },
    { label: 'CRLF', relPath: 'newline/crlf.txt', note: '' },
    { label: '无末尾换行', relPath: 'newline/no-trailing-newline.txt', note: '' },
    { label: '混合换行', relPath: 'newline/mixed.txt', note: '' },
    { label: '空文件', relPath: 'edge/empty.txt', note: '' },
    { label: '仅 BOM', relPath: 'edge/bom-only.txt', note: '' },
  ];
  for (const form of forms) {
    const entry = byPath.get(form.relPath);
    if (entry === undefined) {
      check(`形态：${form.label}`, false, `夹具清单里没有 ${form.relPath}；形态未被覆盖`);
      continue;
    }
    const outcome = await attemptRead(readArgs(repoScope, form.relPath), repoDeps);
    const data = outcome.value;
    const ok =
      outcome.ok &&
      data !== undefined &&
      data.total_lines === entry.lineCount &&
      data.newline === entry.newline &&
      data.bom === entry.hasBom &&
      data.sha256 === entry.sha256;
    check(
      `形态：${form.label}`,
      ok,
      ok
        ? `${form.relPath} → ${String(entry.lineCount)} 行 / ${entry.newline} / BOM=${String(entry.hasBom)}` +
            (data ? ` / editable=${String(data.editable)}` : '')
        : `${form.relPath} → ${outcome.code ?? '?'} 或与清单不符`,
    );
  }

  const emoji = await attemptRead(readArgs(repoScope, '资料/2026年方案/📄笔记.txt'), repoDeps);
  check(
    'emoji 出现在**路径**里时，回执路径仍是磁盘拼写（句柄取回，不是请求字符串的转写）',
    emoji.value?.path === '资料/2026年方案/📄笔记.txt',
    `回执 path=${JSON.stringify(emoji.value?.path ?? null)}`,
  );
  const mixed = await attemptRead(readArgs(repoScope, 'newline/mixed.txt'), repoDeps);
  check(
    '混合换行的文件可读，但**不给**可编辑票据（写回会静默改掉其它行）',
    mixed.ok && mixed.value?.editable === false && mixed.value.content.includes('\r'),
    mixed.value ? `editable=${String(mixed.value.editable)}；理由：${mixed.value.editable_blockers.join('；')}` : String(mixed.code),
  );

  // =========================================================================
  section('验收标准 2：截断结果不会冒充完整文件');
  // =========================================================================

  const longLine = byPath.get('edge/long-line.txt');
  const longLineRead = await attemptRead(readArgs(repoScope, 'edge/long-line.txt'), repoDeps);
  check(
    '超长行：按 MAX_LINE_BYTES 截断并标注行号，且整份结果标为 truncated',
    longLineRead.ok &&
      longLineRead.value?.truncated === true &&
      longLineRead.value.truncated_lines.length === 1 &&
      longLineRead.value.truncated_lines[0] === 1 &&
      longLineRead.value.content === 'x'.repeat(LIMITS.MAX_LINE_BYTES),
    longLineRead.value
      ? `truncated_lines=${JSON.stringify(longLineRead.value.truncated_lines)}、正文 ${longLineRead.value.content.length} 字节` +
        `（磁盘上 ${String(longLine?.bytes ?? '?')} 字节）`
      : String(longLineRead.code),
  );
  check(
    '超长行被截断的文件不得给出可编辑票据（截断后的正文不是原文）',
    longLineRead.value?.editable === false,
    longLineRead.value?.editable_blockers.join('；') ?? '—',
  );

  const bigEntry = byPath.get('large/big.txt');
  const bigFirst = await attemptRead(readArgs(repoScope, 'large/big.txt'), repoDeps);
  check(
    '大文件首页：标出总行数、给出下一页游标，且明确 truncated',
    bigFirst.ok &&
      bigFirst.value?.truncated === true &&
      bigFirst.value.next_cursor !== null &&
      bigFirst.value.total_lines === bigEntry?.lineCount &&
      bigFirst.value.end_line_exclusive < (bigEntry?.lineCount ?? 0),
    bigFirst.value
      ? `${String(bigFirst.value.total_lines)} 行中的第 ${bigFirst.value.start_line}..${bigFirst.value.end_line_exclusive} 行；` +
        `游标=${bigFirst.value.next_cursor === null ? '无' : '有'}`
      : String(bigFirst.code),
  );

  // ---- 分页拼接：造一个多页文件，逐页读完，与磁盘字节比对 ----
  const pagedPath = path.join(ws, 'paged.txt');
  const pagedLines = Array.from({ length: 1200 }, (_, i) => `第 ${String(i)} 行 content-${'y'.repeat(i % 7)}`);
  const pagedText = `${pagedLines.join('\r\n')}\r\n`;
  await writeFile(pagedPath, pagedText, 'utf8');

  let cursor: string | null = null;
  let assembled = '';
  let pages = 0;
  let coveredLines = 0;
  for (;;) {
    const outcome = await attemptRead(
      readArgs(wsScope, 'paged.txt', cursor === null ? { max_lines: 250 } : { cursor, max_lines: 250 }),
      wsDeps,
    );
    if (!outcome.ok || outcome.value === undefined) {
      check('分页拼接', false, `第 ${pages + 1} 页失败：${outcome.code}`);
      break;
    }
    pages += 1;
    assembled += outcome.value.content;
    coveredLines += outcome.value.end_line_exclusive - outcome.value.start_line;
    cursor = outcome.value.next_cursor;
    if (cursor === null) break;
    if (pages > 20) {
      check('分页拼接', false, '页数超过 20，游标没有推进');
      break;
    }
  }
  check(
    '逐页读完 1200 行：拼接结果与磁盘字节逐字相同（分页不丢行、不重复、不空转）',
    assembled === pagedText && coveredLines === 1200 && pages === 5,
    `${pages} 页、覆盖 ${coveredLines} 行、拼接 ${Buffer.byteLength(assembled, 'utf8')} 字节` +
      `（磁盘 ${Buffer.byteLength(pagedText, 'utf8')} 字节）`,
  );

  const firstPage = await attemptRead(readArgs(wsScope, 'paged.txt', { max_lines: 3 }), wsDeps);
  check(
    '只读前 3 行时会说清楚"这不是整个文件"（truncated 为真，且总行数照给）',
    firstPage.value?.truncated === true &&
      firstPage.value.total_lines === 1200 &&
      firstPage.value.end_line_exclusive === 4,
    firstPage.value
      ? `返回第 ${firstPage.value.start_line}..${firstPage.value.end_line_exclusive} 行、共 ${String(firstPage.value.total_lines)} 行、truncated=${String(firstPage.value.truncated)}`
      : String(firstPage.code),
  );

  // ---- 上限本身 ----
  const tooBigPath = path.join(ws, 'too-big.txt');
  await writeFile(tooBigPath, 'a'.repeat(LIMITS.MAX_READABLE_FILE_BYTES + 1), 'utf8');
  let bigOpens = 0;
  const countedBig = decorate(backend, {
    readFileGuarded: (req: WinfsPathRef) => {
      bigOpens += 1;
      return backend.readFileGuarded(req);
    },
  });
  const tooBig = await attemptRead(readArgs(wsScope, 'too-big.txt'), depsFor(countedBig));
  check(
    `超过 MAX_READABLE_FILE_BYTES（${String(LIMITS.MAX_READABLE_FILE_BYTES)}）的文件按上限拒绝，且**一个字节都没读**`,
    tooBig.ok === false && tooBig.code === 'SIZE_LIMIT_EXCEEDED' && bigOpens === 0,
    `${String(tooBig.code)}，真实读取次数 ${String(bigOpens)}`,
  );
  await rm(tooBigPath, { force: true });

  note(
    '三个上限',
    `可读 ${String(LIMITS.MAX_READABLE_FILE_BYTES)} 字节 / 可编辑 ${String(LIMITS.MAX_EDITABLE_FILE_BYTES)} 字节 / ` +
      `单行 ${String(LIMITS.MAX_LINE_BYTES)} 字节 / 单页 ${String(LIMITS.MAX_READ_LINES)} 行`,
  );

  // =========================================================================
  section('验收标准 3：伪造或跨工作区重放读取票据被拒绝');
  // =========================================================================

  const ticketTarget = path.join(ws, 'ticket.txt');
  await writeFile(ticketTarget, 'line-1\nline-2\nline-3\n', 'utf8');
  const realRead = await attemptRead(readArgs(wsScope, 'ticket.txt'), wsDeps);
  if (!realRead.ok || realRead.value === undefined) {
    check('装置前提：真实读取成功并签发票据', false, String(realRead.code));
    process.exitCode = 1;
    return;
  }
  const realToken = realRead.value.read_token;
  /** 真的由本服务签发的游标（页面在验收标准 2 里产生）。 */
  const realCursor = firstPage.value?.next_cursor ?? null;
  note('真实票据', `${String(realToken).slice(0, 24)}…（长度 ${String(realToken).length}）`);
  note('密钥指纹', wsDeps.authority.key_fingerprint);

  const authority = wsDeps.authority;
  const verify = (token: unknown, now = NOW): { ok: boolean; reason?: string } => {
    try {
      authority.verifyReadTicket(token, { now });
      return { ok: true };
    } catch (cause) {
      return { ok: false, reason: String((cause as { details?: { reason?: string } }).details?.reason ?? '?') };
    }
  };
  const expectStale = (label: string, token: unknown, reason: string, now = NOW): void => {
    const outcome = verify(token, now);
    check(
      `拒绝：${label}`,
      outcome.ok === false && outcome.reason === reason,
      outcome.ok ? '竟然通过了' : `理由 ${String(outcome.reason)}`,
    );
  };

  // 改一个字符（签名覆盖的是**传输中的那串字节**，不是重新序列化的结果）
  const forged = `${String(realToken).slice(0, -1)}${String(realToken).endsWith('A') ? 'B' : 'A'}`;
  expectStale('改掉票据的最后一个字符', forged, 'TICKET_BAD_SIGNATURE');

  // 换一把密钥重新签一份**内容完全相同**的载荷
  const otherKey = createReadTicketAuthority({ key: 'another-evidence-key-fedcba9876543210fedcba98' });
  const payloadB64 = String(realToken).slice('lwbrt_'.length).split('.')[0] ?? '';
  const resignedWithOtherKey = `lwbrt_${payloadB64}.${createHmac('sha256', 'another-evidence-key-fedcba9876543210fedcba98')
    .update(payloadB64, 'ascii')
    .digest('base64url')}`;
  expectStale('用另一把密钥对同一份载荷重新签名', resignedWithOtherKey, 'TICKET_BAD_SIGNATURE');
  note(
    '另一把密钥的指纹',
    `${otherKey.key_fingerprint}（与本服务不同；指纹可进日志，密钥不可）`,
  );

  expectStale('把别的字符串当票据', 'not-a-ticket', 'TICKET_WRONG_PREFIX');
  // 用**真的**由本服务签发的游标，而不是手搓一个像游标的串：手搓的会先撞上
  // 前缀判定，于是这条用例证明的就成了"前缀不对会拒"，而不是"真游标不能当票据用"。
  expectStale(
    '把分页游标当读取票据用（同一个权威签发，只是 kind 不同）',
    realCursor ?? 'lwbc_x.y',
    'TICKET_WRONG_PREFIX',
  );
  expectStale(
    '票据过期（有效期是唯一失效机制，因此必须真的生效）',
    realToken,
    'TICKET_EXPIRED',
    NOW + LIMITS.READ_TOKEN_TTL_MS + 1,
  );

  // ---- 绑定项逐项篡改 ----
  const matched = (): string => {
    assertReadTokenMatches(authority.verifyReadTicket(realToken, { now: NOW }), {
      connection_id: CONNECTION,
      workspace_id: wsScope.workspace_id,
      generation: wsScope.generation,
      path: 'ticket.txt',
    });
    return 'ok';
  };
  const expectMatchFailure = (label: string, expect: Parameters<typeof assertReadTokenMatches>[1], reason: string): void => {
    try {
      assertReadTokenMatches(authority.verifyReadTicket(realToken, { now: NOW }), expect);
      check(`拒绝：${label}`, false, '竟然通过了');
    } catch (cause) {
      const actual = String((cause as { details?: { reason?: string } }).details?.reason ?? '?');
      check(`拒绝：${label}`, actual === reason, `理由 ${actual}`);
    }
  };

  check('对照：绑定项全部一致时，票据被接受（上面的拒绝不是"谁来都拒"）', matched() === 'ok');
  expectMatchFailure(
    '跨连接重放（换一条 connection_id）',
    { connection_id: 'conn-other', workspace_id: wsScope.workspace_id, generation: 1, path: 'ticket.txt' },
    'TICKET_CROSS_CONNECTION',
  );
  expectMatchFailure(
    '跨工作区重放（换一个 workspace_id）',
    { connection_id: CONNECTION, workspace_id: 'ws-other', generation: 1, path: 'ticket.txt' },
    'TICKET_CROSS_WORKSPACE',
  );
  expectMatchFailure(
    '代次失效（工作区被移除后重建）',
    { connection_id: CONNECTION, workspace_id: wsScope.workspace_id, generation: 2, path: 'ticket.txt' },
    'TICKET_GENERATION_MISMATCH',
  );
  expectMatchFailure(
    '拿这张票据去改另一个文件',
    { connection_id: CONNECTION, workspace_id: wsScope.workspace_id, generation: 1, path: 'paged.txt' },
    'TICKET_PATH_MISMATCH',
  );
  // 反方向的一条：大小写不同的拼写指向**同一个**对象，因此必须放行。
  // 少了这一条，"路径必须完全一致"这种过严实现也会让上面五条全绿 ——
  // 而过严的代价是 NTFS 上每一次大小写不一致的正常提案都被判成跨文件重放。
  let caseAliasAccepted = false;
  try {
    assertReadTokenMatches(authority.verifyReadTicket(realToken, { now: NOW }), {
      connection_id: CONNECTION,
      workspace_id: wsScope.workspace_id,
      generation: 1,
      path: 'TICKET.TXT',
      base_sha256: realRead.value.sha256,
    });
    caseAliasAccepted = true;
  } catch (cause) {
    caseAliasAccepted = false;
    note('大小写别名的拒绝理由', String((cause as { message?: string }).message ?? ''));
  }
  check(
    '对照：大小写不同但指向同一对象的路径**被接受**（真正的身份判据是 volume/file/hash 三项）',
    caseAliasAccepted,
    caseAliasAccepted ? 'TICKET.TXT 与磁盘上的 ticket.txt 视为同一文件' : '被拒了',
  );

  // ---- 基线：文件变了，票据不能再用 ----
  try {
    assertReadTokenMatches(authority.verifyReadTicket(realToken, { now: NOW }), {
      connection_id: CONNECTION,
      workspace_id: wsScope.workspace_id,
      generation: 1,
      path: 'ticket.txt',
      base_sha256: sha256(Buffer.from('another version\n', 'utf8')),
    });
    check('拒绝：提案声明的基线与票据记录的版本不一致', false, '竟然通过了');
  } catch (cause) {
    const actual = String((cause as { details?: { reason?: string } }).details?.reason ?? '?');
    check(
      '拒绝：提案声明的基线与票据记录的版本不一致',
      actual === 'TICKET_BASE_MISMATCH',
      `理由 ${actual}`,
    );
  }

  // ---- 票据里到底有什么（逐项列出，用于确认它不夹带正文） ----
  const verified = authority.verifyReadTicket(realToken, { now: NOW });
  const fields = Object.keys(verified).sort();
  check(
    '票据绑定项齐全，且**不含正文**（只有哈希、身份与范围）',
    ['connection_id', 'workspace_id', 'generation', 'canonical_path', 'volume_id', 'file_id', 'raw_bytes_sha256', 'size', 'total_lines', 'range_start', 'range_end_exclusive', 'truncated', 'truncated_lines', 'editable', 'editable_blockers', 'redacted', 'issued_at', 'expires_at'].every(
      (field) => fields.includes(field),
    ) && JSON.stringify(verified).includes('line-1') === false,
    `${fields.length} 个字段：${fields.join(', ')}`,
  );
  const targetInfo = await backend.resolvePath({ ...wsRef, relative_path: 'ticket.txt', expect: 'file' });
  const targetIdentity =
    isWinfsError(targetInfo) || !('identity' in targetInfo) ? null : targetInfo.identity;
  check(
    '票据里的卷/文件身份与**护栏当场取回的身份**一致，范围与实际返回一致',
    targetIdentity !== null &&
      verified.volume_id === targetIdentity.volume_id &&
      verified.file_id === targetIdentity.file_id &&
      verified.raw_bytes_sha256 === realRead.value.sha256 &&
      verified.range_start === realRead.value.start_line &&
      verified.range_end_exclusive === realRead.value.end_line_exclusive &&
      verified.size === Buffer.byteLength('line-1\nline-2\nline-3\n', 'utf8'),
    `file_id=${verified.file_id.slice(0, 8)}… sha256=${verified.raw_bytes_sha256.slice(0, 12)}… ` +
      `范围 ${String(verified.range_start)}..${String(verified.range_end_exclusive)}`,
  );

  // =========================================================================
  section('实测：读取过程中有写冲突则失败');
  // =========================================================================

  const busyPath = path.join(ws, 'busy.txt');
  const busyContent = 'held by another handle\n';
  await writeFile(busyPath, busyContent, 'utf8');

  // 持有者必须是**另一个进程**：`holdHandle` 的语义就是「故意不释放句柄」，
  // 而句柄只随进程退出被内核回收（WinfsGuard.ps1 里写明了这一点）。
  // 因此"释放"这件事只能由进程退出完成 —— 这恰好也让下面那条对照成立。
  const holder = new ResidentHelper();
  const holderReady = await holder.start();
  let heldOk = false;
  let heldDetail = `助手启动失败：${JSON.stringify(holderReady).slice(0, 200)}`;
  if (holderReady.ok === true) {
    const held = await holder.call({
      op: 'holdHandle',
      ...wsRef,
      relative_path: 'busy.txt',
      access: 'write',
      share_mode: 'none',
    });
    heldOk = held.ok === true;
    heldDetail = heldOk
      ? `另一进程持有 busy.txt 的写句柄（access=write, share_mode=none），身份 ${String((held as { identity?: { file_id?: string } }).identity?.file_id ?? '').slice(0, 8)}…`
      : `无法持有：${JSON.stringify(held).slice(0, 200)}`;
  }
  check('装置前提：另一个进程在目标上持有一个排他写句柄', heldOk, heldDetail);

  if (heldOk) {
    const blocked = await attemptRead(readArgs(wsScope, 'busy.txt'), wsDeps);
    check(
      '文件被另一个进程独占时读取失败，且失败原因是**共享冲突**而不是"文件不存在"',
      blocked.ok === false && blocked.code === 'FILE_BUSY' && blocked.details?.['winfs_code'] === 'FILE_BUSY',
      `${String(blocked.code)}（护栏码 ${String(blocked.details?.['winfs_code'])}、Win32 ${String(blocked.details?.['win32_error'])}）`,
    );
    const busyStat = await statFile(
      {
        scope: wsScope,
        connection_id: CONNECTION,
        decision: allowedDecision('stat', wsScope.workspace_id),
        path: 'busy.txt',
        now: NOW,
      },
      wsDeps,
    ).then(
      () => ({ ok: true as const, code: '' }),
      (cause: { code?: string }) => ({ ok: false as const, code: String(cause.code) }),
    );
    check(
      '元数据预检同样失败（它也要打开句柄取哈希，没有"轻量到不受影响"这回事）',
      busyStat.ok === false && busyStat.code === 'FILE_BUSY',
      busyStat.ok ? '竟然成功了' : busyStat.code,
    );

    // ---- 对照：持有者消失后，同一个文件必须能读 ----
    // 没有这一步，「读不了」也可能只是因为这个文件本来就打不开。
    await holder.stop();
    const afterRelease = await attemptRead(readArgs(wsScope, 'busy.txt'), wsDeps);
    check(
      '对照：持有者进程退出后同一文件可以正常读取（因此上面那条确实是那个句柄造成的）',
      afterRelease.ok === true && afterRelease.value?.content === busyContent,
      afterRelease.ok ? `读回 ${String(afterRelease.value?.bytes_returned)} 字节` : String(afterRelease.code),
    );
  } else {
    skip('文件被独占时的读取失败与元数据失败', '无法让另一个进程持有句柄，用例前提不成立');
    await holder.stop();
  }
  const wsDeps2 = wsDeps;

  // =========================================================================
  section('实测：硬拒绝在读字节之前生效');
  // =========================================================================

  await writeFile(path.join(ws, '.env'), 'APP_SECRET=not-a-real-secret\n', 'utf8');
  await writeFile(path.join(ws, '.env.example'), 'APP_SECRET=\n', 'utf8');
  await writeFile(path.join(ws, 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n', 'utf8');

  for (const denied of ['.env', '.env.example', 'id_rsa']) {
    let opens = 0;
    const counted = decorate(backend, {
      readFileGuarded: (req: WinfsPathRef) => {
        opens += 1;
        return backend.readFileGuarded(req);
      },
    });
    const outcome = await attemptRead(readArgs(wsScope, denied), depsFor(counted));
    check(
      `硬拒绝：${denied}（真实读取次数必须为 0）`,
      outcome.ok === false && outcome.code === 'POLICY_DENIED' && opens === 0,
      `${String(outcome.code)}，规则 ${String(outcome.details?.['hard_deny_rule'])}，真实读取次数 ${String(opens)}`,
    );
  }

  // ---- 脱敏：真实读取，但正文里的令牌不出站 ----
  const tokenEntry = byPath.get('secrets/token.txt');
  const tokenRead = await attemptRead(readArgs(repoScope, 'secrets/token.txt'), repoDeps);
  check(
    'certain 级命中的令牌被脱敏后再出站，其余正文仍可读',
    tokenRead.ok === true &&
      tokenRead.value?.redacted === true &&
      !tokenRead.value.content.includes('ghp_') &&
      !tokenRead.value.content.includes('xoxb-') &&
      tokenRead.value.content.includes('[REDACTED:github-token]'),
    tokenRead.value ? JSON.stringify(tokenRead.value.content) : String(tokenRead.code),
  );
  check(
    '脱敏过的读取拿不到可编辑票据（否则改写会落在一段被替换过的正文上）',
    tokenRead.value?.editable === false &&
      tokenRead.value.read_token !== undefined &&
      authority.verifyReadTicket(tokenRead.value.read_token, { now: NOW }).editable === false,
    tokenRead.value?.editable_blockers.join('；') ?? '—',
  );
  const tokenOnDisk = await readFile(path.join(TESTREPO_DIR, 'secrets', 'token.txt'));
  check(
    '读取不改动被读的对象：夹具文件哈希与清单一致',
    sha256(tokenOnDisk) === tokenEntry?.sha256,
    `${sha256(tokenOnDisk).slice(0, 12)}…`,
  );

  // =========================================================================
  section('实测：元数据预检不构成可编辑授权');
  // =========================================================================

  const statArgs = {
    scope: wsScope,
    connection_id: CONNECTION,
    decision: allowedDecision('stat', wsScope.workspace_id),
    path: 'busy.txt',
    now: NOW,
  };
  const stat = await statFile(statArgs, wsDeps2);
  check(
    'file_stat 给出哈希与尺寸，但不含正文、不含票据、且永远不可编辑',
    stat.sha256 === sha256(Buffer.from('held by another handle\n', 'utf8')) &&
      stat.size === Buffer.byteLength('held by another handle\n', 'utf8') &&
      stat.editable === false &&
      'read_token' in stat === false,
    `sha256=${stat.sha256.slice(0, 12)}… size=${String(stat.size)} editable=${String(stat.editable)}`,
  );
  let statDenied = '';
  try {
    await statFile({ ...statArgs, path: '.env' }, wsDeps2);
  } catch (cause) {
    statDenied = String((cause as { code?: string }).code);
  }
  check(
    '硬拒绝路径连元数据都不给（否则 file_stat 就成了存在性/大小/哈希探针）',
    statDenied === 'POLICY_DENIED',
    statDenied === '' ? '竟然通过了' : statDenied,
  );

  // =========================================================================
  section('未执行项（不得记为通过）');
  // =========================================================================

  skip('真实 ChatGPT Web 端到端读取验收', '需要真实账号与 Secure MCP Tunnel 凭据；LWB-002 仍为 BLOCKED');
  skip(
    '两个 daemon 实例之间的并发读写仲裁',
    '本证据证明的是**句柄层面**的跨进程冲突（持有者与读取者各是一个 PowerShell 进程）；' +
      'daemon 级仲裁属多实例场景，V1 是单用户单 daemon，不提供也不声称提供',
  );
  skip('超大文件（> 16 MiB）的分页读取', 'V1 按契约直接拒绝；分页只覆盖 MAX_READABLE_FILE_BYTES 以内的文件');
  skip('NTFS 之外的卷（ReFS / 网络盘 / 云占位文件）', '本机只有 NTFS；LWB-009 的卷形态判定覆盖了拒绝路径，但未在真实 ReFS 上采集');

  await backend.dispose();
  await rm(sandbox, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? '全部通过。' : `有 ${failures} 项未通过。`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
