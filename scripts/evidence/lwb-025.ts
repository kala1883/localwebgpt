/**
 * LWB-025 可复现证据采集：接入修改提议工具并验收审批闭环。
 *
 * 装置：**真实 MCP 客户端** ←内存传输→ 真适配器 → 真 daemon 操作表 →
 * 真授权链 / 真守卫 / 真审计 → 真 SQLite（内存）→ 真护栏（PowerShell +
 * .NET P/Invoke，真实 NTFS 卷序列号与文件索引）→ 夹具仓库的一份**临时副本**。
 *
 * 逐条对应任务书：
 *
 *  步骤 1「实现 change_prepare / change_get / change_list，保证提议工具标注为
 *  会改变服务状态」 —— 第 1 节读的是 `tools/list` 上挂出去的那份注解，不是
 *  源码里的常量：适配器有它的判断，契约有它的声明，两者必须一致。
 *
 *  步骤 2「ChatGPT 提议后返回 PENDING_APPROVAL，不伪称已保存」 —— 第 2 节。
 *  这里**不**用「返回值里写着 PENDING_APPROVAL」当证据：那只证明字段被填了。
 *  证据是三条互相独立的事实同时成立：(a) 状态与 `workspace_modified` 的取值；
 *  (b) 整棵工作区目录树的逐项快照（相对路径 → SHA-256 + 大小 + mtime +
 *  目录项增删）在调用前后**逐项相同**；(c) 运行期护栏的**写方法调用次数为 0**。
 *  (a) 单独成立而 (b)(c) 不成立，正是「报了个好状态、文件却动了」那种缺陷。
 *
 *  验收 1「工具 descriptions 明确先读取、再提议、等待真实批准」 —— 第 1 节
 *  对三段文案逐句断言（子串取自契约里的原文）。断言的是**模型实际读到的
 *  那句英文/中文**，因此改文案会立刻在这里失败。
 *
 *  验收 2「待审批时不会长时间挂起 MCP 调用或无限轮询」 —— 第 3 节。
 *  「不挂起」用**墙钟**取证（每次调用的耗时逐条打印并断言上界）；
 *  「不轮询」不能靠计时证明，改由两条否证：(a) 连续 5 次 `change_get` 之间
 *  状态与批准摘要**一格未动**，说明没有任何东西在后台推进它；(b) 返回里
 *  **没有游标**（`next_cursor` 恒为 `null`），因此不存在「照游标再要一次」
 *  的循环可写。V1 的差异是单页返回，发一个换不来更多内容的游标只会让
 *  调用方去循环。
 *
 *  验收 3「G3 通过时仍可保持直写开关关闭」 —— 第 4 节。门禁三条全开、
 *  `proposal_enabled` 开、而 `direct_write_enabled` **关**：提议可用，
 *  两个写工具不出现在 `tools/list` 里。
 *
 * 第 5 节是负向：硬拒绝路径（含**从未被打开过**这一条）、身份字段、跨连接
 * 查询、未知游标、代次不一致、幂等重放。
 *
 * 用法：node --import tsx scripts/evidence/lwb-025.ts
 * 退出码：全部通过 0；任一项失败 1。
 *
 * 本文件证明不了的事（见末尾「未执行项」）：**真实 ChatGPT 网页端的验收**
 * 需要真实账号与 Secure MCP Tunnel 凭据，当前 BLOCKED（LWB-002）；
 * **批准之后确实会落盘**需要执行协调器，属 LWB-026。MCP Inspector 的一次
 * 成功也不能替代前者。
 */

import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

import { IMPLEMENTED_TOOL_NAMES } from '@lwb/contracts';
import type { BridgeErrorPayload, ChangeGetData, ChangeListData, ChangePrepareData, FileReadData } from '@lwb/contracts';
import { PowerShellWinfsBackend } from '@lwb/winfs';
import type { WinfsOps } from '@lwb/winfs';

import { createAdapterServer } from '../../apps/mcp-adapter/src/server.ts';
import { capabilityFlagsFrom, capabilityFlagsWith } from '../../apps/daemon/src/gates.ts';
import { CANARY_DIR, TESTREPO_DIR, ensureFixtures } from '../../tests/fixtures/index.ts';
import { GATES_ON, OTHER_CONNECTION, makeToolHarness } from '../../tests/tools/harness.ts';
import type { ToolHarness } from '../../tests/tools/harness.ts';

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

let failures = 0;
let passes = 0;
let skips = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes += 1;
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
  skips += 1;
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '?';
}

function bool(value: unknown): string {
  return typeof value === 'boolean' ? String(value) : '?';
}

/** 哈希只留前 12 位：够核对，不足以还原内容。 */
function shortHash(value: unknown): string {
  return typeof value === 'string' ? `${value.slice(0, 12)}…(${value.length})` : '?';
}

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

interface CallOutcome {
  readonly kind: 'ok' | 'error' | 'protocol';
  readonly data: Record<string, unknown>;
  readonly error: BridgeErrorPayload | null;
  readonly ms: number;
}

/**
 * 一次 `tools/call` 的三种结局，外加**墙钟**。
 *
 * 三分类是必要的：业务失败、协议错误与成功在这里是三件不同的事，
 * 混成「成功/失败」会让「未授权被报成了协议错误」这种缺陷看不出来。
 * 计时挂在这里而不是每个用例各写一遍：验收 2 的那条上界要覆盖**每一次**
 * 调用，包括负向的那些。
 */
async function callVia(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallOutcome> {
  const empty = { data: {}, error: null } as const;
  const started = process.hrtime.bigint();
  const elapsed = (): number => Number(process.hrtime.bigint() - started) / 1e6;
  try {
    const raw = (await client.callTool({ name, arguments: args })) as {
      readonly isError?: unknown;
      readonly structuredContent?: unknown;
      readonly content?: readonly { readonly text?: unknown }[];
    };
    if (raw.isError === true) {
      const text = raw.content?.[0]?.text;
      const parsed = typeof text === 'string' ? (JSON.parse(text) as Record<string, unknown>) : {};
      return { kind: 'error', ...empty, error: (parsed['error'] ?? null) as BridgeErrorPayload | null, ms: elapsed() };
    }
    return { kind: 'ok', data: asRecord(asRecord(raw.structuredContent)['data']), error: null, ms: elapsed() };
  } catch (cause) {
    if (cause instanceof McpError) {
      return {
        kind: 'protocol',
        ...empty,
        error: { code: 'PROTOCOL', message: `${cause.code}: ${cause.message}` } as unknown as BridgeErrorPayload,
        ms: elapsed(),
      };
    }
    throw cause;
  }
}

/**
 * 把一次调用的结局压成一行，供**断言失败时**看真实原因。
 *
 * 成功与失败各有一句，措辞不预设这一次该是哪一种：写死「本该被拒绝」
 * 会让正向用例失败时打印出一句相反的话，把排查方向引到反的方向去。
 */
function why(outcome: CallOutcome): string {
  return outcome.kind === 'ok'
    ? `调用成功 data=${JSON.stringify(outcome.data).slice(0, 200)}`
    : `code=${str(outcome.error?.code)} details=${JSON.stringify(outcome.error?.details ?? null)}`;
}

/** daemon 侧的操作表 → 适配器要的窄接口。与生产装配同形（`IpcClient.call`）。 */
function daemonCaller(harness: ToolHarness, requestId: string) {
  return {
    async call(operation: string, input: unknown) {
      const definition = harness.operations.lookup(operation);
      if (definition === undefined) {
        return { ok: false as const, code: 'UNKNOWN_OPERATION', reason: `未注册的操作 ${operation}`, outcome_unknown: false };
      }
      return { ok: true as const, result: await definition.handler(input, harness.adapterContext(requestId)) };
    },
  };
}

interface AdapterUnderTest {
  readonly client: Client;
  readonly logs: string[];
  close(): Promise<void>;
}

async function makeAdapter(caller: ReturnType<typeof daemonCaller>): Promise<AdapterUnderTest> {
  const logs: string[] = [];
  const server = createAdapterServer({
    caller: caller as Parameters<typeof createAdapterServer>[0]['caller'],
    server_version: '0.1.0-evidence',
    log: (line) => logs.push(line),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'lwb-evidence-lwb025', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    logs,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

/**
 * 记录型包装：把护栏**读写方法被调用时的相对路径**记下来。
 *
 * 用 `Proxy` 而不是展开对象：真实后端的方法在原型上，`{...backend}` 会把
 * 它们全部丢掉（那份对象只有数据属性），于是「代理过的后端」变成一台
 * 什么都做不了的空壳 —— 而失败会表现为一堆 `NOT_IMPLEMENTED`，
 * 与被测的逻辑毫无关系。方法取出来必须 `bind(target)`。
 */
interface OpsLedger {
  readonly ops: WinfsOps;
  readonly reads: string[];
  readonly writes: string[];
}

function withLedger(backend: WinfsOps): OpsLedger {
  const reads: string[] = [];
  const writes: string[] = [];
  const READ_METHODS = new Set<string>(['readFileGuarded', 'resolvePath']);
  const WRITE_METHODS = new Set<string>(['writeFileGuarded', 'createFileGuarded']);

  const ops = new Proxy(backend, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (!READ_METHODS.has(String(prop)) && !WRITE_METHODS.has(String(prop))) return value;
      return async (req: unknown): Promise<unknown> => {
        const relative = str(asRecord(req)['relative_path']);
        if (WRITE_METHODS.has(String(prop))) writes.push(`${String(prop)}(${relative})`);
        else reads.push(`${String(prop)}(${relative})`);
        return await (value as (a: unknown) => Promise<unknown>).apply(target, [req]);
      };
    },
  }) as WinfsOps;

  return { ops, reads, writes };
}

// ---------------------------------------------------------------------------
// 工作区快照
// ---------------------------------------------------------------------------

/**
 * 整棵树的逐项快照：相对路径 → 内容 SHA-256 + 大小 + mtime + 类型。
 *
 * 比只比内容哈希多两样东西，而那两样正是「没写成」这种缺陷的藏身处：
 * mtime 能抓到「同样内容被重写一遍」，目录项集合能抓到「多了一个文件又删掉」
 * 之外的净增删。两者都不在内容哈希里。
 */
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const info = await stat(full);
      if (info.isDirectory()) {
        out.set(relative, `dir mtime=${info.mtimeMs}`);
        await walk(full, relative);
        continue;
      }
      const bytes = await readFile(full);
      const digest = createHash('sha256').update(bytes).digest('hex');
      out.set(relative, `file size=${info.size} mtime=${info.mtimeMs} sha256=${digest}`);
    }
  }
  await walk(root, '');
  return out;
}

/** 两份快照的差异，逐条列出（不省略）。 */
function diffTrees(before: Map<string, string>, after: Map<string, string>): string[] {
  const lines: string[] = [];
  for (const [key, value] of before) {
    const other = after.get(key);
    if (other === undefined) lines.push(`- 消失：${key}`);
    else if (other !== value) lines.push(`~ 改变：${key}`);
  }
  for (const key of after.keys()) if (!before.has(key)) lines.push(`+ 新增：${key}`);
  return lines;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

interface Fixture {
  readonly harness: ToolHarness;
  readonly adapter: AdapterUnderTest;
  readonly ledger: OpsLedger;
  readonly workRoot: string;
  readonly tempRoot: string;
  /** 常驻 pwsh 助手。**必须显式 dispose**，否则脚本打印完汇总也不退出。 */
  readonly backend: PowerShellWinfsBackend;
}

async function build(): Promise<Fixture> {
  ensureFixtures();

  const backend = new PowerShellWinfsBackend();
  const capability = await backend.capability();
  check(
    '护栏提供句柄级身份与独占打开',
    capability.supports_file_identity === true && capability.supports_exclusive_handle === true,
    `identity=${bool(capability.supports_file_identity)} exclusive=${bool(capability.supports_exclusive_handle)}`,
  );

  // 夹具的**临时副本**：副本的 file_id 与原树不同，因此票据里的身份天然必须
  // 是「实际将要被读的那个对象」的身份 —— 这一条顺带把「身份取自路径字符串」
  // 这类实现挡在门外。整棵树拷进 temp，退出时删掉。
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb-lwb025-'));
  const workRoot = path.join(tempRoot, 'testrepo');
  await cp(TESTREPO_DIR, workRoot, { recursive: true });

  const rootInfo = await backend.statVolume({ path: workRoot });
  if (rootInfo.ok !== true) throw new Error(`工作区根身份取不到：${rootInfo.code} ${rootInfo.message}`);

  const original = await backend.statVolume({ path: TESTREPO_DIR });
  if (original.ok !== true) throw new Error(`夹具根身份取不到：${original.code} ${original.message}`);
  check(
    '工作区是夹具的副本而不是夹具本身',
    original.file_id !== rootInfo.file_id,
    `夹具 file=${original.file_id} 副本 file=${rootInfo.file_id}；两次 stat 的 volume=${rootInfo.volume_id} 一致`,
  );

  const ledger = withLedger(backend);
  const harness = await makeToolHarness({
    root: workRoot,
    // 第二个工作区也必须是一个**存在**的目录：传了真实探测器之后，登记的
    // 祖先链探测会真的去打开它。用夹具里的金丝雀目录（它在受保护清单之外，
    // 专门用来验证「读到了不该读到的东西」）而不是一个凭空的路径。
    other_root: CANARY_DIR,
    ops: ledger.ops,
    probe: backend,
    gates: GATES_ON,
  });
  const adapter = await makeAdapter(daemonCaller(harness, 'req-lwb025'));
  return { harness, adapter, ledger, workRoot, tempRoot, backend };
}

/** 读一个文件，返回它的 `file_read` 数据（票据与哈希都从这里来）。 */
async function readTarget(fixture: Fixture, relative: string): Promise<FileReadData> {
  const outcome = await callVia(fixture.adapter.client, 'file_read', {
    workspace_id: fixture.harness.workspace.id,
    path: relative,
  });
  if (outcome.kind !== 'ok') throw new Error(`读取 ${relative} 失败：${why(outcome)}`);
  return outcome.data as unknown as FileReadData;
}

/** 一份基于某个已读文件的单编辑提案。 */
function editProposal(read: FileReadData, relative: string, key: string, summary: string): Record<string, unknown> {
  return {
    workspace_id: '',
    idempotency_key: key,
    summary,
    items: [
      {
        op: 'edit_text',
        path: relative,
        base_sha256: read.sha256,
        read_token: read.read_token,
        edits: [
          { start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['lf-line-1-edited'] },
        ],
      },
    ],
  };
}

// ================================================================
// 1. 验收 1 + 步骤 1：工具说明与「会改变服务状态」的标注
// ================================================================

async function descriptionsAndAnnotations(fixture: Fixture): Promise<void> {
  section('验收 1 / 步骤 1：工具说明写清了顺序，提议工具被标为会改变状态');

  const listed = await fixture.adapter.client.listTools();
  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));

  const REQUIRED: Readonly<Record<string, readonly string[]>> = {
    // 「先读取」：没有这一句，模型会直接编一个 sha256 来提案。
    change_prepare: ['必须先 file_read', 'read_token', 'PENDING_APPROVAL', '绝不能', '文件已经保存'],
    // 「等待真实批准、不要重复发起」：断线之后最容易做错的一件事。
    change_get: ['不要', '重新发起', 'APPLIED', 'tests_run'],
    // 「只看自己的」：让模型知道这个清单的边界在哪。
    change_list: ['当前连接', '不返回其它连接'],
  };

  for (const [name, phrases] of Object.entries(REQUIRED)) {
    const tool = byName.get(name);
    if (tool === undefined) {
      check(`${name} 出现在 tools/list 里`, false, '没有挂出去');
      continue;
    }
    const text = `${tool.title ?? ''}\n${tool.description ?? ''}`;
    const missing = phrases.filter((phrase) => !text.includes(phrase));
    check(
      `${name} 的说明包含全部要点（${phrases.length} 条）`,
      missing.length === 0,
      missing.length === 0 ? '' : `缺：${missing.join(' / ')}`,
    );
  }

  // 步骤 1 的那半句「保证提议工具标注为会改变服务状态」。
  // `readOnlyHint` 是**唯一**一个模型能读到的「这个调用会不会改东西」的提示，
  // 标错不会让任何一次调用失败 —— 它只会让模型在没有心理负担的情况下重试。
  const expectReadOnly: Readonly<Record<string, boolean>> = {
    change_prepare: false,
    change_get: true,
    change_list: true,
  };
  for (const [name, expected] of Object.entries(expectReadOnly)) {
    check(
      `${name} 的 readOnlyHint=${String(expected)}`,
      byName.get(name)?.annotations?.readOnlyHint === expected,
      `实际=${bool(byName.get(name)?.annotations?.readOnlyHint)}`,
    );
  }

  // 写工具**不**在这一版里：直写开关关着（第 4 节展开），而「不挂出去」
  // 与「挂出去但每次拒绝」是两种不同的产品行为 —— 前者模型看得见边界，
  // 后者它会一直重试。
  const listedNames = listed.tools.map((tool) => tool.name);
  check(
    '清单里没有 change_apply / change_revert_prepare',
    !listedNames.includes('change_apply') && !listedNames.includes('change_revert_prepare'),
    `清单=${listedNames.join(',')}`,
  );
  check(
    '挂出去的就是 daemon 已实现的那一组',
    [...listedNames].sort().join(',') === [...IMPLEMENTED_TOOL_NAMES].sort().join(','),
    `已实现=${IMPLEMENTED_TOOL_NAMES.length} 条`,
  );
}

// ================================================================
// 2. 步骤 2：提议之后的状态，以及「不伪称已保存」
// ================================================================

async function proposeNeverClaimsSaved(fixture: Fixture): Promise<ChangePrepareData> {
  section('步骤 2：提议返回等待批准，且工作区一个字节都没动');

  const relative = 'newline/lf.txt';
  const before = await snapshotTree(fixture.workRoot);
  note('工作区快照（调用前）', `${before.size} 项，全部逐项记下 sha256/size/mtime`);

  const read = await readTarget(fixture, relative);
  check('目标文件可编辑', read.editable === true, `editable=${bool(read.editable)} blockers=${JSON.stringify(read.editable_blockers)}`);

  const writesBefore = fixture.ledger.writes.length;
  const proposal = editProposal(read, relative, 'lwb025-idem-1', '证据采集：改一行');
  const outcome = await callVia(fixture.adapter.client, 'change_prepare', {
    ...proposal,
    workspace_id: fixture.harness.workspace.id,
  });
  check('change_prepare 成功', outcome.kind === 'ok', why(outcome));
  const prepared = outcome.data as unknown as ChangePrepareData;

  check('状态是 PENDING_APPROVAL', prepared.state === 'PENDING_APPROVAL', `state=${str(prepared.state)}`);
  check('workspace_modified 恒为 false', prepared.workspace_modified === false, `实际=${bool(prepared.workspace_modified)}`);
  check('不是幂等重放', prepared.idempotent_replay === false, `实际=${bool(prepared.idempotent_replay)}`);
  check('摘要非空且是 64 位十六进制', /^[0-9a-f]{64}$/.test(String(prepared.digest)), `digest=${shortHash(prepared.digest)}`);
  // 「不伪称已保存」的**文案**面：模型读到的就是这一句。
  check(
    'next_action 明说尚未写入任何文件',
    typeof prepared.next_action === 'string' && prepared.next_action.includes('尚未写入任何文件'),
    `next_action=${str(prepared.next_action).slice(0, 48)}…`,
  );
  check(
    'next_action 明说批准只能由本地操作者完成',
    typeof prepared.next_action === 'string' && prepared.next_action.includes('模型与 MCP 通道都无法批准'),
  );

  // 状态库里的那一行：批准记录**一条都不该有**。只断言返回值的话，
  // 「返回里没写」与「库里真的没有」是两件事。
  const approvals = fixture.harness.repos.approvals.listForChange(prepared.change_id);
  check('状态库里没有这条修改集的任何批准记录', approvals.length === 0, `实际 ${approvals.length} 行`);

  const after = await snapshotTree(fixture.workRoot);
  const drift = diffTrees(before, after);
  check('整棵工作区目录树逐项相同', drift.length === 0, drift.length === 0 ? `${after.size} 项全部比对通过` : drift.join('；'));
  check(
    '运行期护栏的写方法一次都没被调用',
    fixture.ledger.writes.length === writesBefore,
    `writes=[${fixture.ledger.writes.join(' ')}]`,
  );
  note('本次提案实际打开过的路径', `reads=[${[...new Set(fixture.ledger.reads)].join(' ')}]`);

  return prepared;
}

// ================================================================
// 3. 验收 2：不挂起、不轮询
// ================================================================

async function noHangNoPolling(fixture: Fixture, prepared: ChangePrepareData): Promise<void> {
  section('验收 2：待审批时不挂起、不轮询');

  // 上界的取法：这是一次**本地**调用（内存传输 + 内存库 + 一个三行文件），
  // 正常在毫秒级。15 秒对一个「等批准」的实现来说远远不够 —— 恰恰因此，
  // 越过它就说明有一个等待循环，而不是「慢了」。
  const BOUND_MS = 15_000;
  const timings: { name: string; ms: number }[] = [];

  const listA = await callVia(fixture.adapter.client, 'change_list', { workspace_id: fixture.harness.workspace.id });
  timings.push({ name: 'change_list', ms: listA.ms });
  check('change_list 成功', listA.kind === 'ok', why(listA));

  // 连续 5 次查询：**每一次的答案都必须逐字相同**。
  // 「不轮询」在这里被否证成一条可判定的断言：如果后台有个循环在推进它，
  // 五次之间迟早会有一格变化；而一个「等批准等到超时」的实现根本不会
  // 走到第五次（第一次就撞上上界）。
  const seen: string[] = [];
  let first: ChangeGetData | null = null;
  for (let round = 0; round < 5; round += 1) {
    const got = await callVia(fixture.adapter.client, 'change_get', { change_id: prepared.change_id });
    timings.push({ name: `change_get#${round + 1}`, ms: got.ms });
    if (got.kind !== 'ok') {
      check(`第 ${round + 1} 次 change_get 成功`, false, why(got));
      return;
    }
    const data = got.data as unknown as ChangeGetData;
    first ??= data;
    seen.push(`${data.change.state}|approval=${JSON.stringify(data.approval)}|operation=${data.operation === null ? 'null' : '有'}`);
  }

  check(
    '5 次查询之间状态、批准、回执一格未动',
    new Set(seen).size === 1,
    `唯一答案=${seen[0] ?? '(无)'}`,
  );
  // 「还没被批准」这件事由两个字段各自回答一次：`approval` 是状态库里的
  // 批准记录（`null` = 一条都没有），`operation` 是执行回执（`null` = 还
  // 没进执行阶段）。只查一个的话，「批准了但还没执行」与「什么都没发生」
  // 会给出同一个答案。
  check('查询结果里 approval 为 null（尚无批准记录）', first?.approval === null, `approval=${JSON.stringify(first?.approval ?? null)}`);
  check('查询结果里 operation 为 null（尚无执行）', first?.operation === null, `operation=${first?.operation === null ? 'null' : '有'}`);
  check('查询结果里的状态仍是 PENDING_APPROVAL', first?.change.state === 'PENDING_APPROVAL', `state=${str(first?.change.state)}`);

  // 差异是单页返回：不带游标进去，也不带游标出来。一个换不来更多内容的
  // 游标就是「照游标再要一次」那个循环的**入场券**，因此它不该存在。
  const withDiff = await callVia(fixture.adapter.client, 'change_get', {
    change_id: prepared.change_id,
    path: 'newline/lf.txt',
  });
  timings.push({ name: 'change_get(带差异)', ms: withDiff.ms });
  check('带 path 的 change_get 成功', withDiff.kind === 'ok', why(withDiff));
  const diff = asRecord(withDiff.data['diff']);
  check('差异是单页：next_cursor 为 null', diff['next_cursor'] === null, `实际=${JSON.stringify(diff['next_cursor'])}`);
  check(
    '差异内容是一段 unified diff（行号头 + 两侧标记）',
    typeof diff['unified'] === 'string' && diff['unified'].includes('@@ -1,3 +1,3 @@') && diff['unified'].includes('-lf-line-1') && diff['unified'].includes('+lf-line-1-edited'),
    `unified 前 60 字=${str(diff['unified']).slice(0, 60)}`,
  );

  const worst = timings.reduce((acc, item) => (item.ms > acc.ms ? item : acc), timings[0]!);
  check(
    '每一次调用都在上界之内',
    worst.ms < BOUND_MS,
    `最慢的一次 ${worst.name}=${worst.ms.toFixed(1)}ms，上界 ${BOUND_MS}ms；逐条=${timings
      .map((item) => `${item.name}:${item.ms.toFixed(1)}ms`)
      .join(' ')}`,
  );
}

// ================================================================
// 4. 验收 3：G3 通过时直写仍可关闭
// ================================================================

async function directWriteStaysOff(fixture: Fixture): Promise<void> {
  section('验收 3：提议可用的同时，直写开关保持关闭');

  // 验收 3 的原文是「G3 通过时仍可保持直写开关关闭」。它描述的是**一种
  // 产品配置**，而不是本装置当前的取值：`GATES_ON` 三条都为真时，
  // `direct_write_enabled` 按 `capabilityFlagsFrom` 就是**真**。
  //
  // 因此这一节要构造的是那条配置本身 —— G0 与 §3 过（读取与提议可用）、
  // 原生护栏**未**过（直写关）。它恰好是「G3 通过」这一天的样子，
  // 也是 `capabilityFlagsFrom` 里那个额外的与项存在的理由。
  // **LWB-033 起，门禁多了一项 `g4_concurrency_fault_passed`**（竞争与故障
  // 专项测试，判定在 `docs/evidence/g4-write.md`）。这一节讲的仍然只是
  // 「原生护栏那个与项」，因此这里把 G4 **固定为真**、表仍是 8 格 ——
  // 输出因此与本文件当初交付时**逐字相同**（65 PASS 那一份摘要仍然读得对）。
  // 四格一起穷尽的那张 16 格表在 `tests/unit/gate-combinations.test.ts`。
  const PROPOSAL_READY = { g0_platform_verified: true, native_guard_verified: false, compatibility_section3_passed: true, g4_concurrency_fault_passed: true } as const;

  // 先做一张**穷尽**的开关表：8 种门禁取值逐一看开关。
  // 只测一两格的话，「direct_write 永远为真」或「四个开关永远相同」
  // 这类实现都能过。
  const table: string[] = [];
  let tableOk = true;
  for (const g0 of [false, true]) {
    for (const native of [false, true]) {
      for (const section3 of [false, true]) {
        const flags = capabilityFlagsFrom({ g0_platform_verified: g0, native_guard_verified: native, compatibility_section3_passed: section3, g4_concurrency_fault_passed: true });
        const platformReady = g0 && section3;
        const wantDirect = platformReady && native;
        const ok = flags.read_enabled === platformReady && flags.proposal_enabled === platformReady && flags.direct_write_enabled === wantDirect;
        tableOk &&= ok;
        table.push(`g0=${g0 ? 1 : 0} native=${native ? 1 : 0} §3=${section3 ? 1 : 0} ⇒ read=${flags.read_enabled ? 1 : 0} propose=${flags.proposal_enabled ? 1 : 0} direct=${flags.direct_write_enabled ? 1 : 0}`);
      }
    }
  }
  check('8 种门禁取值下，直写只有在原生护栏也通过时才为真', tableOk, table.join('；'));

  const flags = capabilityFlagsFrom(PROPOSAL_READY);
  note('验收 3 所指的配置（G0 与 §3 过、原生护栏未过）', JSON.stringify(flags));
  check('该配置下读取与提议可用', flags.read_enabled === true && flags.proposal_enabled === true, JSON.stringify(flags));
  check('该配置下直写关闭 —— 这正是那个额外与项的作用', flags.direct_write_enabled === false, `direct_write=${bool(flags.direct_write_enabled)}`);

  // 把那条配置真的装配出来，问工具面：提议三件在不在，写两件在不在。
  // 断言下在**清单**上而不是在开关上：开关是对的而清单挂错了工具，
  // 是这条验收里唯一有产品后果的失败形态。
  const proposalOnly = await makeToolHarness({
    root: fixture.workRoot,
    other_root: CANARY_DIR,
    ops: fixture.harness.ops(),
    probe: fixture.harness.probe,
    gates: PROPOSAL_READY,
  });
  try {
    const adapter = await makeAdapter(daemonCaller(proposalOnly, 'req-lwb025-g3'));
    try {
      const names = (await adapter.client.listTools()).tools.map((tool) => tool.name);
      for (const name of ['change_prepare', 'change_get', 'change_list']) {
        check(`该配置下 ${name} 可用`, names.includes(name), `清单=${names.join(',')}`);
      }
      for (const name of ['change_apply', 'change_revert_prepare']) {
        check(`该配置下 ${name} 不出现（直写关着）`, !names.includes(name), `清单=${names.join(',')}`);
      }
    } finally {
      await adapter.close();
    }
  } finally {
    proposalOnly.close();
  }

  // 而本装置（三条门禁全开）里，两个写工具同样不在清单上 —— 但那是
  // **另一个原因**：它们还没实现（LWB-032 / LWB-031）。两个原因必须分开说，
  // 否则「清单里没有」会被读成「开关挡住了」，而开关根本不是它的原因。
  const allOn = await fixture.adapter.client.listTools();
  const allOnNames = allOn.tools.map((tool) => tool.name);
  check('门禁全开时写工具仍不在清单上（原因是「未实现」，见 IMPLEMENTED_TOOL_NAMES）', !allOnNames.includes('change_apply'));
  check(
    '已实现的那一组就是挂出去的那一组',
    [...allOnNames].sort().join(',') === [...IMPLEMENTED_TOOL_NAMES].sort().join(','),
    `已实现 ${IMPLEMENTED_TOOL_NAMES.length} 条`,
  );
  note('本次采集装置的门禁（三条全开 ⇒ 直写为真）', JSON.stringify(capabilityFlagsWith(GATES_ON, () => false)(fixture.harness.workspace)));
}

// ================================================================
// 5. 负向
// ================================================================

async function negatives(fixture: Fixture, prepared: ChangePrepareData): Promise<void> {
  section('负向：硬拒绝、身份字段、归属、游标、代次、幂等');

  // ---- 5.1 硬拒绝路径进不了提案，而且**基线从未被读过** ----
  //
  // 这一条是本任务最要紧的负向。`prepareChange` 会**重读每个既有目标的
  // 基线字节**并写进快照库，因此「先建立修改集、等批准时再拒绝」这类写法
  // 会让 `.env` 的内容已经进了本进程与快照库。断言于是分两层：
  // 调用被拒绝（可见），以及该路径从未出现在护栏的读取台账里（不可见的那一层）。
  const deniedBefore = fixture.ledger.reads.length;
  for (const deniedPath of ['config/.env', 'config/.env.example']) {
    const readAttempt = await callVia(fixture.adapter.client, 'file_read', {
      workspace_id: fixture.harness.workspace.id,
      path: deniedPath,
    });
    check(
      `读取 ${deniedPath} 被拒绝`,
      readAttempt.kind === 'error',
      why(readAttempt),
    );
    // 它连哈希都拿不到，因此下面那份提案是用**伪造**的哈希与票据提的
    // —— 提案必须先被硬拒绝拦住，而不是先被票据校验拦住。
    const outcome = await callVia(fixture.adapter.client, 'change_prepare', {
      workspace_id: fixture.harness.workspace.id,
      idempotency_key: `lwb025-denied-${deniedPath}`,
      summary: `证据采集：试图改 ${deniedPath}`,
      items: [
        {
          op: 'create_text',
          path: deniedPath,
          content: 'SEED=x\n',
          newline: 'lf',
          bom: false,
        },
      ],
    });
    check(
      `对 ${deniedPath} 的 create_text 提案被拒绝`,
      outcome.kind === 'error' && str(outcome.error?.code) === 'POLICY_DENIED',
      why(outcome),
    );
    check(
      `对 ${deniedPath} 的拒绝发生在 prepare 阶段（不是留到执行时）`,
      asRecord(outcome.error?.details)['blocked_at'] === 'prepare',
      `details=${JSON.stringify(outcome.error?.details ?? null)}`,
    );
  }
  const deniedReads = fixture.ledger.reads.slice(deniedBefore).filter((line) => line.includes('.env'));
  check(
    '硬拒绝路径的内容一次都没有被打开过',
    deniedReads.length === 0,
    deniedReads.length === 0 ? `台账里没有 .env：reads=[${fixture.ledger.reads.slice(deniedBefore).join(' ')}]` : deniedReads.join('；'),
  );

  // ---- 5.2 身份字段：它们**不是**授权凭据，而且连入参都不合法 ----
  //
  // ADR-003 §4 的反模式清单里，这一组字段是第一批。这一版把它们挡在最外层
  // （`strictObject`）：字段根本到不了任何判定，因此不存在「某处不小心读了它」
  // 的可能。下面逐条各来一次，并断言**每一次都是输入违约**。
  for (const field of ['approved', 'user_id', 'session_id', 'conversation_label', 'principal_id']) {
    const outcome = await callVia(fixture.adapter.client, 'change_prepare', {
      workspace_id: fixture.harness.workspace.id,
      idempotency_key: `lwb025-identity-${field}`,
      summary: '身份字段探针',
      items: [],
      [field]: true,
    });
    check(
      `入参里的 ${field} 被拒绝（输入违约，不是「被忽略」）`,
      outcome.kind === 'error' && str(outcome.error?.code) === 'INVALID_ARGUMENT',
      why(outcome),
    );
  }

  // ---- 5.3 归属：不是自己的修改集，回答与「不存在」逐字相同 ----
  //
  // 两条回答**必须逐字相同**：只要码或文案有一处不同，就是一个
  // 「本机是否存在这个 id」的预言机。因此这里比的是整段 JSON，
  // 而不是「码相同」—— 一个多带 `reason` 的实现会在码上通过、
  // 在整段比较上失败，而后者才是这条性质的真实形状。
  const foreign = await makeAdapter({
    async call(operation: string, input: unknown) {
      const definition = fixture.harness.operations.lookup(operation);
      if (definition === undefined) {
        return { ok: false as const, code: 'UNKNOWN_OPERATION', reason: '未注册', outcome_unknown: false };
      }
      // **另一条连接**的上下文：同一份操作表、同一个工作区授权表，
      // 唯一的差别是 `principal_id` 与连接 id。
      return {
        ok: true as const,
        result: await definition.handler(input, fixture.harness.contextFor(OTHER_CONNECTION, 'req-foreign')),
      };
    },
  });
  try {
    const missing = await callVia(foreign.client, 'change_get', { change_id: 'chg_00000000000000000000000000000000' });
    const someoneElses = await callVia(foreign.client, 'change_get', { change_id: prepared.change_id });
    check(
      '别的连接查不存在的 id 与查别人的 id：回答逐字相同',
      JSON.stringify(missing.error) === JSON.stringify(someoneElses.error),
      `不存在=${JSON.stringify(missing.error)} 别人的=${JSON.stringify(someoneElses.error)}`,
    );
    // `details` 里那条 `request_id` 是**每次调用都会带**的审计关联 ID，
    // 两次回答里它必然相同，因此它不是判别信息。要挡的是**判别信息**：
    // 一条 `reason=CHANGE_NOT_FOUND` 或 `reason=NOT_OWNER` 就足以把
    // 「本机有这个 id」与「没有」分开，而那是这条性质的全部意义。
    const detailsOf = (outcome: CallOutcome): Record<string, unknown> => asRecord(outcome.error?.['details'] ?? null);
    check(
      '两种回答的明细逐字相同，且没有任何判别键（只有审计关联 ID）',
      JSON.stringify(detailsOf(missing)) === JSON.stringify(detailsOf(someoneElses)) &&
        Object.keys(detailsOf(missing)).every((key) => key === 'request_id'),
      `details keys=${Object.keys(detailsOf(missing)).join(',')} 两条相同=${String(JSON.stringify(detailsOf(missing)) === JSON.stringify(detailsOf(someoneElses)))}`,
    );
    // 反向对照：**本连接**查同一个 id 必须查得到 —— 否则上一条是恒真的。
    const own = await callVia(fixture.adapter.client, 'change_get', { change_id: prepared.change_id });
    check('对照：本连接查同一条 id 查得到', own.kind === 'ok', why(own));
  } finally {
    await foreign.close();
  }

  // ---- 5.4 change_list 只列本连接 ----
  const mineList = await callVia(fixture.adapter.client, 'change_list', {});
  const data = mineList.data as unknown as ChangeListData;
  check('change_list 里全部是本连接建立的修改集', data.changes.every((entry) => entry.workspace_id === fixture.harness.workspace.id), `${data.changes.length} 条`);
  const zeroWorkspace = await callVia(fixture.adapter.client, 'change_list', { workspace_id: 'ws-别人的' });
  check(
    '列别人的工作区得到空列表而不是拒绝（否则那个 id 变成可穷举的）',
    zeroWorkspace.kind === 'ok' && (zeroWorkspace.data as unknown as ChangeListData).changes.length === 0,
    why(zeroWorkspace),
  );

  // ---- 5.5 未知游标：拒绝，而不是「从头开始」 ----
  const badCursor = await callVia(fixture.adapter.client, 'change_get', { change_id: prepared.change_id, cursor: 'not-a-cursor' });
  check(
    'change_get 不接受游标（单页工具）',
    badCursor.kind === 'error' && asRecord(badCursor.error?.details)['reason'] === 'CURSOR_NOT_SUPPORTED',
    why(badCursor),
  );
  const badListCursor = await callVia(fixture.adapter.client, 'change_list', { cursor: 'bm90LWEtY3Vyc29y' });
  check(
    'change_list 的形状不对的游标被拒绝而不是从头开始',
    badListCursor.kind === 'error' && asRecord(badListCursor.error?.details)['reason'] === 'CURSOR_MALFORMED',
    why(badListCursor),
  );

  // ---- 5.6 幂等重放：同键同内容得到同一条记录 ----
  const read = await readTarget(fixture, 'newline/lf.txt');
  const replay = await callVia(fixture.adapter.client, 'change_prepare', {
    ...editProposal(read, 'newline/lf.txt', 'lwb025-idem-1', '证据采集：改一行'),
    workspace_id: fixture.harness.workspace.id,
  });
  check(
    '同键同内容重放：同一条 change_id、idempotent_replay=true',
    replay.kind === 'ok' && (replay.data as unknown as ChangePrepareData).change_id === prepared.change_id && (replay.data as unknown as ChangePrepareData).idempotent_replay === true,
    why(replay),
  );
  const conflict = await callVia(fixture.adapter.client, 'change_prepare', {
    workspace_id: fixture.harness.workspace.id,
    idempotency_key: 'lwb025-idem-1',
    summary: '同键换了内容',
    items: [
      {
        op: 'create_text',
        path: 'newline/brand-new.txt',
        content: 'new\n',
        newline: 'lf',
        bom: false,
      },
    ],
  });
  check(
    '同键换内容：返回冲突且不动既有修改集',
    conflict.kind === 'error' && str(conflict.error?.code) === 'IDEMPOTENCY_CONFLICT',
    why(conflict),
  );
  check(
    '冲突之后既有修改集仍然是 PENDING_APPROVAL',
    fixture.harness.repos.changes.findById(prepared.change_id)?.state === 'PENDING_APPROVAL',
    `state=${str(fixture.harness.repos.changes.findById(prepared.change_id)?.state)}`,
  );

  // ---- 5.7 读取票据：篡改与跨代次 ----
  //
  // 两件不同的事，分开取证：
  //  (a) **签名**。改掉票据尾巴上的一个字符，签名就不再成立。
  //  (b) **代次**。工作区代次一变（重新登记、撤权、改模式都会推它），
  //      旧票据就作废。这里造的是「同一份提案里两张票据来自不同代次」——
  //      唯一一种**在提案内部**就能发现的不一致，而且它必须当场拒绝：
  //      用低代次的票据配高代次的授权，等于让一次失效之后的读取继续有效。
  //
  //  (b) 不能用「改掉票据」来假装：那样先失败的是签名，代次那条分支
  //      一次都走不到。因此这里真的推一次代次
  //      （`repos.workspaces.bumpGeneration` 就是撤权/重登记走的那条路）。
  const tampered = await readTarget(fixture, '文档/设计说明.md');
  const tamperedOutcome = await callVia(fixture.adapter.client, 'change_prepare', {
    workspace_id: fixture.harness.workspace.id,
    idempotency_key: 'lwb025-tampered-token',
    summary: '篡改票据探针',
    items: [
      {
        op: 'edit_text',
        path: '文档/设计说明.md',
        base_sha256: tampered.sha256,
        read_token: `${tampered.read_token.slice(0, -4)}AAAA`,
        edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: ['a'], new_lines: ['b'] }],
      },
    ],
  });
  check(
    '被篡改的读取票据被拒绝',
    tamperedOutcome.kind === 'error' && str(tamperedOutcome.error?.code) === 'READ_TOKEN_STALE',
    why(tamperedOutcome),
  );

  // 先取一张**旧代次**的票据：读一次，暂不提案。
  const staleRead = await readTarget(fixture, 'newline/lf.txt');
  const generationBefore = fixture.harness.repos.workspaces.findById(fixture.harness.workspace.id)?.generation ?? -1;
  fixture.harness.repos.workspaces.bumpGeneration(fixture.harness.workspace.id);
  const generationAfter = fixture.harness.repos.workspaces.findById(fixture.harness.workspace.id)?.generation ?? -1;
  note('代次推进', `${generationBefore} → ${generationAfter}（bumpGeneration，与撤权/重登记同一条路）`);

  // 再取一张**新代次**的票据。
  const freshRead = await readTarget(fixture, '文档/设计说明.md');

  const crossGeneration = await callVia(fixture.adapter.client, 'change_prepare', {
    workspace_id: fixture.harness.workspace.id,
    idempotency_key: 'lwb025-cross-generation',
    summary: '代次不一致探针',
    items: [
      {
        op: 'edit_text',
        path: 'newline/lf.txt',
        base_sha256: staleRead.sha256,
        read_token: staleRead.read_token,
        edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['x'] }],
      },
      {
        op: 'edit_text',
        path: '文档/设计说明.md',
        base_sha256: freshRead.sha256,
        read_token: freshRead.read_token,
        edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: ['a'], new_lines: ['b'] }],
      },
    ],
  });
  check(
    '同一份提案里两张票据来自不同代次：当场拒绝',
    crossGeneration.kind === 'error' && asRecord(crossGeneration.error?.details)['reason'] === 'TICKET_GENERATION_DISAGREE',
    why(crossGeneration),
  );

  // 反向对照：只拿**旧代次**那张票据单独提案，也应当被拒（理由是代次变了），
  // 否则上一条可能只是因为「两张票据放在一起」这件事本身被拒。
  const staleOnly = await callVia(fixture.adapter.client, 'change_prepare', {
    workspace_id: fixture.harness.workspace.id,
    idempotency_key: 'lwb025-stale-only',
    summary: '旧代次票据探针',
    items: [
      {
        op: 'edit_text',
        path: 'newline/lf.txt',
        base_sha256: staleRead.sha256,
        read_token: staleRead.read_token,
        edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['x'] }],
      },
    ],
  });
  check(
    '对照：只拿旧代次那张票据也拒绝',
    staleOnly.kind === 'error',
    why(staleOnly),
  );
}

// ================================================================
// 主流程
// ================================================================

async function main(): Promise<void> {
  console.log('LWB-025 证据采集：接入修改提议工具并验收审批闭环');
  console.log(`cwd=${process.cwd()} node=${process.version} platform=${process.platform}`);
  note('夹具根', TESTREPO_DIR);
  note('用法', 'node --import tsx scripts/evidence/lwb-025.ts');

  const fixture = await build();
  try {
    await guarded('验收 1', async () => await descriptionsAndAnnotations(fixture));
    const prepared = await (async () => {
      let result: ChangePrepareData | null = null;
      await guarded('步骤 2', async () => {
        result = await proposeNeverClaimsSaved(fixture);
      });
      return result;
    })();
    if (prepared === null) {
      check('后续各节', false, '步骤 2 没有产出修改集，后面的判定失去对象');
    } else {
      await guarded('验收 2', async () => await noHangNoPolling(fixture, prepared));
      await guarded('验收 3', async () => await directWriteStaysOff(fixture));
      await guarded('负向', async () => await negatives(fixture, prepared));
    }
  } finally {
    await fixture.adapter.close();
    fixture.harness.close();
    // 顺序要紧：常驻 pwsh 助手活着的时候**删不掉**工作区（它持有已打开的句柄）。
    // 而且不 dispose 的话，那个子进程的管道会一直把事件循环钉住 —— 脚本会把
    // 汇总打印完，然后永远不退出，于是 `EXIT=$?` 永远等不到。取证脚本必须给出
    // 真实退出码，所以这一步不能省。
    await fixture.backend.dispose().catch(() => undefined);
    await rm(fixture.tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }

  section('未执行项（不得读成通过）');
  skip('真实 ChatGPT 网页端完成一次提议→批准→回读', '需要真实账号与 Secure MCP Tunnel 凭据；LWB-002 BLOCKED');
  skip('批准之后确实落盘并逐文件核验', '执行协调器属 LWB-026，尚未交付；本脚本一次批准都没有产生');
  skip('拒绝之后工作区不变', '拒绝入口在本机控制台（LWB-021 已单独取证）；本脚本从工具面无法产生拒绝');
  skip('修改摘要后旧批准失效', '批准入口在本机控制台（LWB-024 已单独取证）');

  section('汇总');
  console.log(`PASS ${passes} / FAIL ${failures} / NOT_RUN ${skips}`);
  console.log(`LWB-025 RESULT ${failures === 0 ? 'PASS' : 'FAIL'}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
