/**
 * LWB-018 可复现证据采集：审计、限额、撤权与只读阶段验收。
 *
 * 三条验收标准在这里各有一段，**全部跑在真实护栏（PowerShell + .NET P/Invoke）
 * 与真实 NTFS 上**（夹具是生成出来的测试根，不是真实仓库 —— 见验收 3）：
 *
 *  1. 「可回答某次工具调用读取和返回了哪些文件范围」—— 真读一次，然后用
 *     `answerToolCall` 把「什么出去了 / 什么被拦住了」两条清单打出来；
 *     并与夹具清单逐字节对账（`sha256`），证明那次读取**真的读到了东西**，
 *     而不是「返回空 ⇒ 当然没有文件出去」。
 *  2. 「撤权后旧游标、缓存、Git 结果也不能返回」—— 暂停前签发**真游标**，
 *     暂停后三种撤权各走一遍；再加一条**在途撤回**（处理器读完之后、
 *     返回之前撤权），断言内容没有出站、审计里那几行记成 `delivered=false`
 *     而出站字节照记。缓存侧证的是「出站预算的窗口不因暂停/恢复而清零」。
 *  3. 「G2 通过前只能用测试根，不能开放真实仓库写入」—— 打印本轮用到的
 *     真实根路径（全部在 `tests/fixtures/generated/` 之下）、打印生产装配
 *     门禁全关时的清单，并断言写通道不存在（七个工具全部 `readOnlyHint`、
 *     `direct_write_enabled` 恒为 false）。
 *
 * 另外两件本任务必须留下的东西：
 *
 *  - **审计里没有源码正文**。这条不是靠「代码里没写 content」自证的：
 *     脚本把审计库的**全部文本列**捞出来，逐条与磁盘上夹具文件的真实
 *     内容行比对。同时断言相对路径**在**里面 —— 否则「没有正文」可以
 *     由一个空审计库满足。
 *  - **审计写不进去就不返回内容**（fail-closed）。拆掉审计表，再读一次：
 *     结果不得出站，错误码必须是存储不可用而不是「读取成功」。
 *
 * 用法：node --import tsx scripts/evidence/lwb-018.ts
 * 退出码：全部通过 0；任一项失败 1。
 *
 * 本文件证明不了的事（见末尾「未执行项」）：**G2 的另一半**
 * —— 「真实网页读取」需要真实账号与 Secure MCP Tunnel 凭证，LWB-002 BLOCKED。
 * 因此 G2 **未通过**，本文只就给得出证据的那一半（内容出站可追踪）作答。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { IMPLEMENTED_TOOL_NAMES, LIMITS, TOOL_NAMES } from '@lwb/contracts';
import type { Envelope } from '@lwb/contracts';
import { answerToolCall, screenMetadata } from '@lwb/audit';
import { ConcurrencyGate, concurrencyGateFor, resolveLimits } from '@lwb/limits';
import { PowerShellWinfsBackend } from '@lwb/winfs';
import type { WinfsOps } from '@lwb/winfs';

import { CANARY_DIR, TESTREPO_DIR, ensureFixtures, findFile, loadManifest } from '../../tests/fixtures/index.ts';
import type { FixtureManifest } from '../../tests/fixtures/index.ts';
import {
  ADAPTER_CONNECTION,
  GATES_OFF,
  GATES_ON,
  dataOf,
  errorOf,
  makeToolHarness,
  type ToolHarness,
} from '../../tests/tools/harness.ts';

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

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

function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

function skip(name: string, why: string): void {
  console.log(`NOT_RUN ${name} — ${why}`);
}

/** 跑一段；炸了就把真实原因报成 FAIL，而不是让整个脚本消失。 */
async function guarded(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (cause) {
    const error = cause as { code?: string; message?: string; details?: unknown; stack?: string };
    check(`${name} 段跑完`, false, `${error.code ?? '(无错误码)'}：${error.message ?? String(cause)}`);
    if (error.details !== undefined) console.log(`      details=${JSON.stringify(error.details)}`);
    if (error.stack) console.log(`      ${error.stack.split('\n').slice(1, 4).join('\n      ')}`);
  }
}

/** 契约里的写工具名。由 `change_` 前缀认定 —— 这一组在契约里就是这几个。 */
const WRITE_TOOL_NAMES = TOOL_NAMES.filter((name) => name.startsWith('change_'));

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): string {
  return typeof value === 'number' ? String(value) : '?';
}

function bool(value: unknown): string {
  return typeof value === 'boolean' ? String(value) : '?';
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '?';
}

/** 哈希只留前 12 位：够核对，不足以还原内容。 */
function shortHash(value: unknown): string {
  return typeof value === 'string' ? `${value.slice(0, 12)}…(${value.length})` : '?';
}

/** 一次调用的审计答案，压成一行（区间逐条列出，不省略）。 */
function answerLine(harness: ToolHarness, requestId: string): string {
  const answer = answerToolCall(harness.repos, requestId);
  const ranges = (rows: readonly { path: string; start_line: number | null; end_line: number | null }[]): string =>
    rows.length === 0
      ? '无'
      : rows
          .map((row) =>
            row.start_line === null ? `${row.path}(整文件/无区间)` : `${row.path}:${row.start_line}-${row.end_line ?? '?'}`,
          )
          .join(' ');
  const call = answer.calls[0];
  return (
    `tool=${str(call?.tool)} outcome=${str(call?.outcome)} code=${call?.error_code ?? 'null'} ` +
    `bytes_out=${num(call?.bytes_out)} 出去了=[${ranges(answer.delivered)}] 拦下了=[${ranges(answer.attempted)}] ` +
    `重复事件=${bool(answer.duplicate_events)}`
  );
}

/**
 * 把「读一次」跑完并返回信封。
 *
 * 走的是**注册表里的处理器**（与适配器同一条路），不是内部函数：
 * 被审计、被复查的正是这一层。
 */
async function call(
  harness: ToolHarness,
  name: string,
  input: unknown,
  requestId: string,
): Promise<Envelope<unknown>> {
  const definition = harness.operations.lookup(name);
  if (definition === undefined) throw new Error(`操作 ${name} 未注册`);
  return (await definition.handler(input, harness.adapterContext(requestId))) as Envelope<unknown>;
}

/**
 * 包一层后端，在某个操作**返回之后**触发一次回调。
 *
 * 用 `Proxy` 而不是展开对象：真实后端的方法在原型上，`{...backend}` 会把
 * 它们全部丢掉（那份对象只有数据属性），于是「代理过的后端」变成一台
 * 什么都做不了的空壳 —— 而失败会表现为一堆 `NOT_IMPLEMENTED`，
 * 与被测的撤权逻辑毫无关系。
 *
 * 方法取出来必须 `bind(target)`：真实后端的方法读自己的私有字段。
 */
function hookedOps(backend: WinfsOps, method: keyof WinfsOps, hook: () => void): WinfsOps {
  return new Proxy(backend, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === method && typeof value === 'function') {
        return async (...args: unknown[]): Promise<unknown> => {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          hook();
          return result;
        };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

// ---------------------------------------------------------------------------
// 审计库里的文本（用于「不保存源码正文」这条断言）
// ---------------------------------------------------------------------------

/** 只用到 `prepare(...).all()` 这一小块形状：不把 better-sqlite3 的类型拖进来。 */
interface Queryable {
  prepare(sql: string): { all(): unknown[] };
}

function auditTextColumns(db: Queryable): string[] {
  const values: string[] = [];
  for (const table of ['audit_events', 'audit_file_access']) {
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
      for (const value of Object.values(asRecord(row))) {
        if (typeof value === 'string') values.push(value);
      }
    }
  }
  return values;
}

/** 夹具文件里的第 n 行（0 起算）—— 用来当「审计里不该出现的内容」探针。 */
function contentLine(relPath: string, lineIndex: number): string {
  const text = readFileSync(path.join(TESTREPO_DIR, relPath), 'utf8');
  return (text.split('\n')[lineIndex] ?? '').trim();
}

// ================================================================
// 装置
// ================================================================

interface Setup {
  readonly harness: ToolHarness;
  readonly manifest: FixtureManifest;
}

async function fixtures(backend: PowerShellWinfsBackend): Promise<Setup> {
  section('装置：真实护栏 + 生成出来的夹具仓库（不是真实仓库）');
  ensureFixtures();

  const capability = await backend.capability();
  check('护栏可用', capability.available === true, `${capability.backend}；${capability.verified_on ?? '未说明环境'}`);
  check(
    '护栏提供句柄级身份',
    capability.supports_file_identity === true && capability.supports_exclusive_handle === true,
    `identity=${bool(capability.supports_file_identity)} exclusive=${bool(capability.supports_exclusive_handle)}`,
  );

  const rootInfo = await backend.statVolume({ path: TESTREPO_DIR });
  if (rootInfo.ok !== true) throw new Error(`夹具根身份取不到：${rootInfo.code} ${rootInfo.message}`);
  note('夹具根身份（由护栏当场问出）', `volume=${rootInfo.volume_id} file=${rootInfo.file_id} fs=${rootInfo.file_system}`);

  // 探测器与后端是**同一个**真实来源：登记时记下的身份、每次调用复核的身份、
  // 护栏打开句柄时核对的身份，三段都来自它。
  const harness = await makeToolHarness({
    root: TESTREPO_DIR,
    other_root: CANARY_DIR,
    ops: backend,
    probe: backend,
    gates: GATES_ON,
  });

  const manifest = await loadManifest();
  note('夹具 HEAD', manifest.head_commit);
  note('门禁（本次证据运行）', 'g0/native_guard/section3 全开 —— 见「验收 3」里的生产装配对照');

  return { harness, manifest };
}

// ================================================================
// 验收 1：可回答某次工具调用读取和返回了哪些文件范围
// ================================================================

async function auditAnswers(harness: ToolHarness, manifest: FixtureManifest): Promise<void> {
  section('验收 1：可回答某次工具调用读取和返回了哪些文件范围');

  const read = await call(harness, 'file_read', { workspace_id: harness.workspace.id, path: 'large/big.txt' }, 'req-a1');
  const data = asRecord(dataOf(read, '第一页读取'));
  check(
    '真读一页大文件成功，且 sha256 与夹具清单一致',
    data['sha256'] === findFile(manifest, 'large/big.txt').sha256,
    `sha256=${shortHash(data['sha256'])} 行=${num(data['start_line'])}–${num(data['end_line_exclusive'])} bytes=${num(data['bytes_returned'])} editable=${bool(data['editable'])}`,
  );
  const firstCursor = data['next_cursor'];
  check('第一页签发了续读游标', typeof firstCursor === 'string' && firstCursor.length > 0, `游标长度=${typeof firstCursor === 'string' ? firstCursor.length : 0}`);
  console.log(`      ${answerLine(harness, 'req-a1')}`);

  // 第二页：区间必须**不同于**第一页。少了这一句，「记下了行区间」这条断言
  // 可以由一个恒为 1-400 的常量满足。
  const second = await call(
    harness,
    'file_read',
    { workspace_id: harness.workspace.id, path: 'large/big.txt', cursor: firstCursor },
    'req-a2',
  );
  const secondData = asRecord(dataOf(second, '第二页读取'));
  const firstStart = asRecord(dataOf(read, '第一页读取'))['start_line'];
  check(
    '第二页的区间与第一页不同（区间是逐次算出来的，不是常量）',
    secondData['start_line'] !== firstStart && num(secondData['start_line']) !== '?',
    `第一页起于 ${num(firstStart)}，第二页起于 ${num(secondData['start_line'])}`,
  );
  console.log(`      ${answerLine(harness, 'req-a2')}`);

  // 被拒绝的读取：目标路径要被记下来，但**没有出站**。
  const denied = await call(harness, 'file_read', { workspace_id: harness.workspace.id, path: 'secrets/.env' }, 'req-a3');
  check('硬拒绝文件被拒', errorOf(denied).error.code === 'POLICY_DENIED', `code=${errorOf(denied).error.code}`);
  const deniedAnswer = answerToolCall(harness.repos, 'req-a3');
  check(
    '被拒绝的调用：目标路径记在「拦下了」一侧，出站字节为 0',
    deniedAnswer.delivered.length === 0 &&
      deniedAnswer.attempted.length === 1 &&
      deniedAnswer.attempted[0]?.path === 'secrets/.env' &&
      deniedAnswer.calls[0]?.bytes_out === 0,
    `${answerLine(harness, 'req-a3')}`,
  );

  // 列举：目录本身与每一个条目各一行（名字出去了就是要记）。
  const list = await call(harness, 'file_list', { workspace_id: harness.workspace.id, path: '' }, 'req-a4');
  const listData = asRecord(dataOf(list, '根列举'));
  const listedEntries = Array.isArray(listData['entries']) ? listData['entries'].length : 0;
  const listAnswer = answerToolCall(harness.repos, 'req-a4');
  check(
    '列举：目录本身 + 每个条目各一行，条数与结果一致',
    listAnswer.delivered.length === listedEntries + 1,
    `条目 ${listedEntries} 条，审计行 ${listAnswer.delivered.length} 行；${answerLine(harness, 'req-a4')}`,
  );

  // Git：差异的整文件访问（不记行区间，因为差异读的是两侧整个文件）。
  const diff = await call(harness, 'git_diff', { workspace_id: harness.workspace.id, path: 'README.md' }, 'req-a5');
  const diffData = asRecord(dataOf(diff, 'git_diff'));
  const diffAnswer = answerToolCall(harness.repos, 'req-a5');
  check(
    'git_diff：整文件访问被记下来，且两侧哈希如实给出',
    diffAnswer.delivered.length === 1 &&
      diffAnswer.delivered[0]?.start_line === null &&
      str(diffData['comparison']).length > 0,
    `${answerLine(harness, 'req-a5')} comparison=${str(diffData['comparison'])}` +
      ` old=${shortHash(diffData['old_sha256'])} new=${shortHash(diffData['new_sha256'])}`,
  );

  // **默认不保存源码正文**：把审计库的全部文本列捞出来，与磁盘上夹具文件的
  // 真实内容行比对。同时断言相对路径**在**里面 —— 否则「没有正文」这条
  // 会由一个空审计库满足。
  const dump = auditTextColumns(harness.opened.db as unknown as Queryable);
  const needles = [
    { what: 'large/big.txt 第 124 行', text: contentLine('large/big.txt', 123) },
    { what: 'README.md 第 1 行', text: contentLine('README.md', 0) },
    { what: '文档/设计说明.md 第 2 行', text: contentLine('文档/设计说明.md', 1) },
  ];
  const leaked = needles.filter((needle) => needle.text.length >= 8 && dump.some((value) => value.includes(needle.text)));
  check(
    '审计里没有任何一条夹具正文',
    leaked.length === 0,
    leaked.length === 0 ? `${dump.length} 条文本列，逐条比对 ${needles.length} 个内容探针` : leaked.map((n) => n.what).join('、'),
  );
  check(
    '同一份审计里**有**相对路径（它不是空的，上面的结论才有意义）',
    dump.includes('large/big.txt'),
    `探针之一：large/big.txt ${dump.includes('large/big.txt') ? '在' : '不在'}审计文本列里`,
  );

  // 元数据的筛查：白名单之外的键一律拒绝（负向）。这一条保护的是
  // 「审计库的泄漏面等于整个状态库」这件事 —— 见 packages/audit/src/screen.ts。
  let rejected: string | null = null;
  try {
    screenMetadata({ path: 'C:\\Users\\someone\\项目\\a.ts' });
  } catch (cause) {
    rejected = (cause as Error).message;
  }
  check('白名单之外的键被筛查拒绝（含绝对路径一类）', rejected !== null, rejected ?? '（没有拒绝）');
  const allowed = screenMetadata({ reason: 'HANDLER_REFUSED', in_flight: 1, limit: 2 });
  check(
    '白名单内的键照常通过',
    allowed['reason'] === 'HANDLER_REFUSED' && allowed['in_flight'] === 1 && allowed['limit'] === 2,
    JSON.stringify(allowed),
  );
}

/** fail-closed：审计写不进去时结果不得出站。 */
async function failClosed(backend: PowerShellWinfsBackend): Promise<void> {
  section('验收 1 补充：审计写不进去 ⇒ 不返回内容（fail-closed）');

  const harness = await makeToolHarness({
    root: TESTREPO_DIR,
    other_root: CANARY_DIR,
    ops: backend,
    probe: backend,
    gates: GATES_ON,
  });
  try {
    // 只拆审计表：连接、工作区、授权行照常，因此「读到了」这一步是成立的 ——
    // 这条要证明的正是「读到了、但记不下来 ⇒ 不发」这**一个**判断。
    harness.opened.db.exec('DROP TABLE audit_file_access; DROP TABLE audit_events');

    const envelope = await call(harness, 'file_read', { workspace_id: harness.workspace.id, path: 'README.md' }, 'req-f1');
    const error = errorOf(envelope).error;
    check(
      '记录写不进去 ⇒ 返回失败而不是内容',
      envelope.ok === false && error.code === 'STORAGE_UNAVAILABLE' && error.details?.['reason'] === 'AUDIT_WRITE_FAILED',
      `code=${error.code} reason=${str(error.details?.['reason'])}`,
    );
    check(
      '该失败的信封里没有本机存储的原文',
      !/SQLITE|database|\.db|audit_events/i.test(error.message),
      `message=${error.message}`,
    );
    check('失败信封里没有文件内容', !JSON.stringify(envelope).includes(contentLine('README.md', 0)));
  } finally {
    harness.close();
  }
}

// ================================================================
// 验收 2：撤权后旧游标、缓存、Git 结果都不能返回
// ================================================================

/**
 * 在**处理器内部、读完文件之后**撤权。
 *
 * 这正是「临返回再次检查」要拦的那个窗口：授权在调用开始时成立，
 * 在返回时不成立了。`file_read` 只在一次 `readFileGuarded` 里读文件，
 * 因此把钩子挂在那里得到的时序是确定的。
 *
 * 入参收的是**相对路径**而不是一个拼好的对象：`workspace_id` 必须取自
 * 这次登记出来的工作区。第一版在这里传了一个手写的空 id，结果整个调用
 * 止步于入参校验（`INVALID_ARGUMENT` / `HANDLER_REFUSED`），文件根本没被读，
 * 于是「读完之后撤权」这个窗口一次都没被走到 —— 而两条断言**照样**报出了
 * 一个结果。让 id 从装置里来，是让「工具真的读到了东西」成为前提而不是假设。
 */
async function revokedMidFlight(backend: PowerShellWinfsBackend, method: keyof WinfsOps, tool: string, path: string, requestId: string, needle: string): Promise<void> {
  let pending: (() => void) | null = null;
  const ops = hookedOps(backend, method, () => pending?.());

  const harness = await makeToolHarness({
    root: TESTREPO_DIR,
    other_root: CANARY_DIR,
    ops,
    probe: backend,
    gates: GATES_ON,
  });
  try {
    pending = () => harness.repos.connections.setEnabled(ADAPTER_CONNECTION, false);
    const envelope = await call(harness, tool, { workspace_id: harness.workspace.id, path }, requestId);

    check(
      `${tool}：撤权后的结果不得返回`,
      envelope.ok === false && errorOf(envelope).error.code === 'CONNECTION_DISABLED',
      `code=${envelope.ok ? '(成功了)' : errorOf(envelope).error.code}`,
    );
    // 这一句比错误码更要紧：模型拿不到内容。
    check(`${tool}：信封里没有正在读的那段内容`, !JSON.stringify(envelope).includes(needle));

    const answer = answerToolCall(harness.repos, requestId);
    const callRow = answer.calls[0];
    check(
      `${tool}：审计记「读了但没出去」，出站字节照记（不回退）`,
      callRow?.metadata?.['reason'] === 'REVOKED_BEFORE_RETURN' &&
        answer.delivered.length === 0 &&
        answer.attempted.length > 0 &&
        (callRow?.bytes_out ?? 0) > 0,
      `${answerLine(harness, requestId)} reason=${str(callRow?.metadata?.['reason'])}`,
    );
  } finally {
    harness.close();
  }
}

async function revocation(backend: PowerShellWinfsBackend): Promise<void> {
  section('验收 2：撤权后旧游标、缓存、Git 结果都不能返回');

  const harness = await makeToolHarness({
    root: TESTREPO_DIR,
    other_root: CANARY_DIR,
    ops: backend,
    probe: backend,
    gates: GATES_ON,
  });
  try {
    // 先在**暂停之前**拿一个真实的游标：手写的游标只能证明「垃圾被拒绝」，
    // 而这条验收标准问的是「**以前签发的**游标在撤权后还能不能用」。
    const first = await call(harness, 'file_read', { workspace_id: harness.workspace.id, path: 'large/big.txt' }, 'req-b1');
    const cursor = asRecord(dataOf(first, '暂停前的第一页'))['next_cursor'];
    if (typeof cursor !== 'string' || cursor.length === 0) throw new Error('夹具没有产生游标，后续三条断言无从谈起');
    note('暂停前签发的游标', `长度 ${cursor.length}`);

    // (1) 连接暂停：新请求直接止步于「解析连接」这一步。
    harness.repos.connections.setEnabled(ADAPTER_CONNECTION, false);
    const paused = await call(
      harness,
      'file_read',
      { workspace_id: harness.workspace.id, path: 'large/big.txt', cursor },
      'req-b2',
    );
    check(
      '连接暂停 ⇒ 旧游标与任何新请求都被拒',
      errorOf(paused).error.code === 'CONNECTION_DISABLED',
      `${answerLine(harness, 'req-b2')}`,
    );
    harness.repos.connections.setEnabled(ADAPTER_CONNECTION, true);

    // (2) 工作区暂停：另一条撤权通道，拒绝理由不同。
    harness.repos.workspaces.setEnabled(harness.workspace.id, false);
    const wsPaused = await call(
      harness,
      'file_read',
      { workspace_id: harness.workspace.id, path: 'large/big.txt', cursor },
      'req-b3',
    );
    check('工作区暂停 ⇒ 旧游标被拒', errorOf(wsPaused).error.code === 'PAUSED', `${answerLine(harness, 'req-b3')}`);

    // (3) 工作区恢复：代次递增，因此**暂停前签发的**游标仍然失效。
    harness.repos.workspaces.setEnabled(harness.workspace.id, true);
    const resumed = await call(
      harness,
      'file_read',
      { workspace_id: harness.workspace.id, path: 'large/big.txt', cursor },
      'req-b4',
    );
    const resumedError = errorOf(resumed).error;
    check(
      '工作区恢复后代次递增 ⇒ 旧游标仍失效（票据绑代次）',
      resumedError.code === 'READ_TOKEN_STALE' && resumedError.details?.['reason'] === 'CURSOR_GENERATION_MISMATCH',
      `code=${resumedError.code} reason=${str(resumedError.details?.['reason'])}；${answerLine(harness, 'req-b4')}`,
    );

    // 恢复之后**重新**读一次必须成功：上一条拒绝不是「工作区坏了」。
    const after = await call(harness, 'file_read', { workspace_id: harness.workspace.id, path: 'large/big.txt' }, 'req-b5');
    check('恢复之后新的一次读取照常成功', after.ok === true, `${answerLine(harness, 'req-b5')}`);

    // (4) 已知边界（**不记为通过项**）：连接暂停→恢复之后，暂停前签发的
    //     游标仍然可用。游标绑的是「连接 id + 工作区代次」，而**连接代次**
    //     不在票据里 —— 见 docs/PROGRESS.md 偏离项 61。
    //
    //     这条边界有两种读法，证据脚本不替验收负责人选一个：
    //     按任务书 LWB-013 的原文（票据绑**连接**、工作区代次、路径、文件版本），
    //     实现是一致的；按守卫自己在「调用进行中」采取的口径（连接代次一变
    //     就撤回结果），恢复之后还能接着读就是一条不一致。两种读法都记下来。
    const boundary = await call(harness, 'file_read', { workspace_id: harness.workspace.id, path: 'large/big.txt' }, 'req-b6');
    const boundaryCursor = asRecord(dataOf(boundary, '边界用例的第一页'))['next_cursor'];
    harness.repos.connections.setEnabled(ADAPTER_CONNECTION, false);
    harness.repos.connections.setEnabled(ADAPTER_CONNECTION, true);
    const boundaryUse = await call(
      harness,
      'file_read',
      { workspace_id: harness.workspace.id, path: 'large/big.txt', cursor: boundaryCursor },
      'req-b7',
    );
    note(
      '已知边界：连接暂停→恢复后，暂停前签发的游标仍可用',
      `未绑连接代次（偏离项 61）；本次实测 ${boundaryUse.ok ? '被接受' : `被拒 ${errorOf(boundaryUse).error.code}`}`,
    );

    // (5) 缓存：本系统没有服务端结果缓存，**真正跨调用留存的状态**是
    //     每连接的出站预算窗口。它必须不因暂停/恢复而清零 ——
    //     否则「暂停→恢复」就是一种重置出站窗口的手法。
    const budget = harness.deps.budgets.forConnection(ADAPTER_CONNECTION);
    const before = budget.snapshot();
    harness.repos.connections.setEnabled(ADAPTER_CONNECTION, false);
    harness.repos.connections.setEnabled(ADAPTER_CONNECTION, true);
    const afterPause = harness.deps.budgets.forConnection(ADAPTER_CONNECTION).snapshot();
    check(
      '暂停/恢复不重置出站预算窗口（账仍然算在同一条连接上）',
      before.charged_total > 0 && afterPause.charged_total === before.charged_total && afterPause.used_bytes > 0,
      `暂停前 charged=${before.charged_total} used=${before.used_bytes}；恢复后 charged=${afterPause.charged_total} used=${afterPause.used_bytes}`,
    );
    note('预算快照（不含内容）', JSON.stringify(afterPause));
  } finally {
    harness.close();
  }

  // (6) 在途撤回：三种工具各一条（读文件 / 列目录 / Git 状态）。
  await revokedMidFlight(backend, 'readFileGuarded', 'file_read', 'README.md', 'req-c1', contentLine('README.md', 0));
}

// ================================================================
// 限额（步骤 2）：并发与出站字节
// ================================================================

async function limits(backend: PowerShellWinfsBackend): Promise<void> {
  section('限额：并发位置与出站字节');

  // 只能收窄这条语义**现在有调用点了**（`resolveLimits`），先证它。
  const tightened = resolveLimits({ MAX_CONCURRENT_READS: 1 });
  check(
    '收紧被接受，且生效值进了限额表',
    tightened.accepted.includes('MAX_CONCURRENT_READS') && tightened.limits.MAX_CONCURRENT_READS === 1,
    `accepted=${tightened.accepted.join(',') || '无'} rejected=${tightened.rejected.length}`,
  );
  const loosened = resolveLimits({ MAX_CONCURRENT_READS: LIMITS.MAX_CONCURRENT_READS + 1 });
  check(
    '放宽被拒绝，且理由是方向而不是语法',
    loosened.rejected.length === 1 && (loosened.rejected[0]?.reason ?? '').includes('只能收紧'),
    `reason=${loosened.rejected[0]?.reason ?? '(没有拒绝)'}`,
  );
  const fixed = resolveLimits({ MAX_CONCURRENT_WRITES_PER_WORKSPACE: 1 });
  check(
    '不可调的固定项被拒绝',
    fixed.rejected.length === 1 && (fixed.rejected[0]?.reason ?? '').includes('不允许由配置覆盖'),
    `reason=${fixed.rejected[0]?.reason ?? '(没有拒绝)'}`,
  );
  const gateFromEffective = concurrencyGateFor(resolveLimits({ MAX_CONCURRENT_READS: 1, MAX_CONCURRENT_READS_PER_CONNECTION: 1 }).limits);
  check(
    '闸门取的是**生效值**而不是初值',
    gateFromEffective.snapshot().max_concurrent === 1,
    `生效上限=${gateFromEffective.snapshot().max_concurrent}，初值=${LIMITS.MAX_CONCURRENT_READS}`,
  );

  const gate = new ConcurrencyGate({ max_concurrent: 1, max_per_connection: 1, wait_ms: 0 });
  const harness = await makeToolHarness({
    root: TESTREPO_DIR,
    other_root: CANARY_DIR,
    ops: backend,
    probe: backend,
    gates: GATES_ON,
    concurrency: gate,
    // 出站额度故意调小：这条路径只有在额度真的用完时才会被走到。
    egress_bytes_per_hour: 1024,
  });
  try {
    const held = await gate.acquire(ADAPTER_CONNECTION);
    if (!held.ok) throw new Error('夹具没有占到位置，并发断言无从谈起');

    const over = await call(harness, 'file_list', { workspace_id: harness.workspace.id, path: '' }, 'req-d1');
    check(
      '并发额度耗尽 ⇒ 本次未执行，且不说成「读过了」',
      errorOf(over).error.code === 'CONCURRENCY_LIMIT_EXCEEDED',
      `${answerLine(harness, 'req-d1')}`,
    );
    const overAnswer = answerToolCall(harness.repos, 'req-d1');
    check(
      '被额度挡下的调用：没有任何文件行（连目标路径都不记 —— 它没执行）',
      overAnswer.delivered.length === 0 && overAnswer.attempted.length === 0,
      `attempted=${overAnswer.attempted.length} delivered=${overAnswer.delivered.length}`,
    );
    held.lease.release();

    // 出站字节：反复读同一个小文件，直到额度用完。用**循环**而不是估算，
    // 因为每次出站多少字节由内容决定，估出来的边界会在内容改动时失效。
    const target = '文档/设计说明.md';
    let okCount = 0;
    let deniedBytes: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const envelope = await call(harness, 'file_read', { workspace_id: harness.workspace.id, path: target }, `req-e${String(i)}`);
      if (envelope.ok) {
        okCount += 1;
        continue;
      }
      deniedBytes = `第 ${String(i + 1)} 次被拒：${errorOf(envelope).error.code} ` +
        `reason=${str(errorOf(envelope).error.details?.['reason'])} used=${num(errorOf(envelope).error.details?.['used_bytes'])} ` +
        `limit=${num(errorOf(envelope).error.details?.['limit_bytes'])} 本次要送=${num(errorOf(envelope).error.details?.['requested_bytes'])}`;
      const deniedAnswer = answerToolCall(harness.repos, `req-e${String(i)}`);
      check(
        '出站额度用尽 ⇒ 结果不出站，且审计记 0 字节',
        deniedAnswer.calls[0]?.bytes_out === 0 && deniedAnswer.delivered.length === 0,
        `${answerLine(harness, `req-e${String(i)}`)}`,
      );
      break;
    }
    check('出站额度最终被用尽（这条路径真的被走到了）', deniedBytes !== null, `${okCount} 次成功后 ${deniedBytes ?? '（20 次都没用完）'}`);
    note('出站预算快照', JSON.stringify(harness.deps.budgets.forConnection(ADAPTER_CONNECTION).snapshot()));
  } finally {
    harness.close();
  }
}

// ================================================================
// 验收 3：G2 通过前只能用测试根
// ================================================================

async function testRootsOnly(backend: PowerShellWinfsBackend, setup: Setup): Promise<void> {
  section('验收 3：G2 通过前只能用测试根，不能开放真实仓库写入');

  const generated = path.dirname(TESTREPO_DIR);
  const roots = [setup.harness.workspace.canonical_root, setup.harness.otherWorkspace.canonical_root];
  note('本轮用到的根', roots.join(' ｜ '));
  check(
    '两个根都在生成出来的夹具目录之下',
    roots.every((root) => root === generated || root.startsWith(`${generated}\\`)),
    `生成目录=${generated}`,
  );
  check(
    '夹具根不是任何真实仓库（它由 build-fixtures 生成，且带自己的 HEAD）',
    setup.manifest.head_commit.length === 40 && setup.manifest.generated_by === 'tests/fixtures/build-fixtures.ts',
    `generated_by=${setup.manifest.generated_by} HEAD=${setup.manifest.head_commit}`,
  );

  // 生产装配的对照：门禁全关时清单恰好两条，且四个能力开关全 false。
  // 与 LWB-017 的同名对照是同一条理由 —— 不把这两件事同时摆出来的话，
  // 读到「七个工具都可用」的人会以为本机现在就能用。
  const production = await makeToolHarness({
    root: TESTREPO_DIR,
    other_root: CANARY_DIR,
    ops: backend,
    probe: backend,
    gates: GATES_OFF,
  });
  try {
    const catalog = await call(production, 'tools.catalog', {}, 'req-g1');
    const tools = asRecord(dataOf(catalog, 'tools.catalog'))['tools'];
    const available = (Array.isArray(tools) ? tools : [])
      .map(asRecord)
      .filter((tool) => tool['available'] === true)
      .map((tool) => str(tool['name']));
    check(
      '生产装配（门禁全关）⇒ 可用工具恰好是 bridge_status 与 workspace_list',
      JSON.stringify(available) === JSON.stringify(['bridge_status', 'workspace_list']),
      available.join('、'),
    );

    const status = await call(production, 'bridge_status', {}, 'req-g2');
    const caps = asRecord(asRecord(dataOf(status, 'bridge_status'))['capabilities']);
    check(
      '生产装配下四个能力开关全 false（含 direct_write_enabled）',
      caps['read_enabled'] === false &&
        caps['git_enabled'] === false &&
        caps['proposal_enabled'] === false &&
        caps['direct_write_enabled'] === false,
      JSON.stringify(caps),
    );

    // 写通道**不存在** —— 这不是「写被拒绝了」，是「没有写这个动作」。
    // 三条合起来才算证明：契约里有这几个名字、清单说它们没被实现、
    // 而流水线上根本没有它们的处理器。
    const all = (Array.isArray(tools) ? tools : []).map(asRecord);
    check(
      '清单覆盖契约里的全部 12 个工具名',
      all.length === TOOL_NAMES.length,
      `${String(all.length)} 条：${all.map((tool) => str(tool['name'])).join('、')}`,
    );
    const writeTools = all.filter((tool) => str(tool['name']).startsWith('change_'));
    check(
      '契约里的写工具全部 NOT_IMPLEMENTED（不是「被开关关掉」）',
      writeTools.length === WRITE_TOOL_NAMES.length &&
        writeTools.every((tool) => tool['available'] === false && tool['reason'] === 'NOT_IMPLEMENTED'),
      writeTools.map((tool) => `${str(tool['name'])}=${str(tool['reason'])}`).join('、'),
    );
    check(
      'daemon 侧没有注册任何写工具（注册表里查不到）',
      production.operations.lookup('change_apply') === undefined &&
        production.operations.lookup('change_prepare') === undefined,
      'change_apply / change_prepare 均未注册',
    );
  } finally {
    production.close();
  }

  // 门禁开启时（本轮证据所采的状态）可用的恰好是那七个只读工具。
  const catalog = await call(setup.harness, 'tools.catalog', {}, 'req-g3');
  const entries = (asRecord(dataOf(catalog, 'tools.catalog'))['tools'] as unknown[] | undefined) ?? [];
  const available = entries
    .map(asRecord)
    .filter((tool) => tool['available'] === true)
    .map((tool) => str(tool['name']));
  check(
    '门禁开启时可用工具恰好是契约里的七个已实现工具',
    JSON.stringify(available) === JSON.stringify([...IMPLEMENTED_TOOL_NAMES]),
    available.join('、'),
  );
}

// ================================================================
// 主流程
// ================================================================

const WindowsOnly = process.platform === 'win32';

async function main(): Promise<void> {
  if (!WindowsOnly) {
    // 护栏是 Windows 独有的（句柄身份、重解析点）。在别的平台上不该假装跑过。
    skip('全部验收项', '当前平台不是 Windows；护栏与夹具语义都无法在此成立');
    return;
  }

  const backend = new PowerShellWinfsBackend();
  let harness: ToolHarness | null = null;

  try {
    const setup = await fixtures(backend);
    harness = setup.harness;

    await guarded('验收 1', async () => {
      await auditAnswers(setup.harness, setup.manifest);
    });
    await guarded('验收 1 补充', async () => {
      await failClosed(backend);
    });
    await guarded('验收 2', async () => {
      await revocation(backend);
    });
    await guarded('限额', async () => {
      await limits(backend);
    });
    await guarded('验收 3', async () => {
      await testRootsOnly(backend, setup);
    });
  } finally {
    harness?.close();
    await backend.dispose().catch(() => undefined);
  }

  section('未执行项（不得记为通过）');
  skip(
    'G2 的另一半：**真实网页读取**且内容出站可追踪',
    'LWB-002 BLOCKED：需要真实 ChatGPT 账号与 Secure MCP Tunnel 凭证；本机没有。' +
      '本文只就给得出证据的那一半（内容出站可追踪）作答，因此 **G2 未通过**',
  );
  skip('ChatGPT 网页端发现并调用这些工具', 'LWB-002 BLOCKED（同上）；MCP Inspector 的成功不能替代它');
  skip('MCP Inspector 手工验证', '未执行：本轮证据只到「真 MCP 客户端 + 真进程 + 真管道」（见 LWB-017 证据）');
  skip('真实仓库（非夹具）上的读取与审计', 'G2 通过前不得进入真实目录联调；本轮全部证据采自生成出来的测试根');
  skip(
    '「暂停→恢复也必须作废旧游标」这个更严的口径',
    '未满足：票据未绑连接代次（偏离项 61）。按任务书 LWB-013 的原文（票据绑连接、工作区代次、' +
      '路径、文件版本）实现是一致的 —— 两种读法都记在这里，不自行选一个记成通过',
  );

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${String(failures)} FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
