/**
 * LWB-032 可复现证据采集：**已批准修改集的应用**（`change_apply`）。
 *
 * 装置与 LWB-025~031 同一套，但这一份走的是**整条工具面**：
 *
 * ```text
 *   真 NTFS 文件
 *     → 真 PowerShellWinfsBackend（句柄级身份复核）
 *     → 真 MCP 适配器 server + 真 Client（tools/list 与 tools/call 都是真的）
 *     → 真工具面（catalog / handlers / guard）
 *     → 真票据权威 → 真 prepareChange
 *     → 真本地批准（approvals 表）
 *     → 真 ExecutionCoordinator + 真 createNativeApplier
 *     → **盘上真的变了字节**
 * ```
 *
 * ## 为什么这一份必须走适配器，而 LWB-031 不必
 *
 * LWB-031 证的是「撤销提议怎么算出来」，那条路在库里就能验完。
 * LWB-032 证的是「模型点一下会发生什么」，而**缺陷恰好藏在工具面那一层**：
 * 本轮修掉的两处（回执找错了表、重复调用撞在门禁上）在库层面全都看不见 ——
 * 直接调 `applyChange` 时它们都是绿的。走 `tools/call` 才复现。
 *
 * ## 逐条对应任务书
 *
 *  步骤 1「只处理已批准修改集，返回稳定 operation_id；控制台批准并应用走
 *  相同服务」—— §2（未批准 ⇒ 拒绝且零写入）、§3（已批准 ⇒ 回执）、
 *  §5（控制台与工具面**同一条操作**）。
 *  步骤 2「快速完成返回实际回执；未完成返回 RUNNING，后续用 change_get 查询」
 *  —— §6。
 *  步骤 3「重复调用无论是否使用同一幂等键，均返回该修改集唯一操作」—— §4。
 *  步骤 4「工具说明禁止模型在未取得终态回执时宣称文件已保存」—— §1。
 *
 *  验收 1「网页批准/本地批准的差异有清晰提示，本地批准不可省略」—— §2。
 *  验收 2「断网、超时、重复点击和重复工具调用不产生第二次写」—— §4 + §6。
 *  验收 3「回执包括逐文件哈希和 tests_run:false」—— §3。
 *
 * ## 本文件里哪些断言是「真的」
 *
 * 每条关键结论都落在**字节**、**表行**或**护栏调用次数**上，不落在措辞上：
 *
 *  - 「没写」用文件指纹（大小 + 修改时刻 + 内容哈希）证 —— 只比内容会
 *    放过「把同样的字节又写了一遍」；
 *  - 「只写了一次」用**护栏的写入方法被调用了几次**证（`withLedger`），
 *    这是比表行与指纹都更靠下的一层事实；
 *  - 「回执没在编」用**独立回读**证：`files[].after_sha256` 必须等于
 *    本脚本自己从磁盘上读回来的字节的哈希。
 *
 * 用法：node --import tsx scripts/evidence/lwb-032.ts
 * 退出码：全部通过 0；任一项失败 1。
 *
 * 本文件证明不了的事逐条列在 §9 并标 `NOT_RUN`。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

import { approveAndQueue, approveChange } from '@lwb/approvals';
import { isExecutionChangeState, operationReceiptFor } from '@lwb/changes';
import { TOOL_INPUT_SCHEMAS, TOOLS_BY_NAME } from '@lwb/contracts';
import type { BridgeErrorPayload, ChangeApplyData, ChangeGetData, ChangePrepareData, FileReadData } from '@lwb/contracts';
import { applyChange, createNativeApplier, ExecutionCoordinator } from '@lwb/executor';
import type { ApplyReport, ExecutionApplier, ExecutionPlan } from '@lwb/executor';
import { createProcessProbe } from '@lwb/ipc';
import { PowerShellWinfsBackend } from '@lwb/winfs';
import type { WinfsOps } from '@lwb/winfs';
import type { WorkspaceEnvironment } from '@lwb/workspaces';

import { createAdapterServer } from '../../apps/mcp-adapter/src/server.ts';
import { TOOL_POLICY_ACTIONS } from '../../apps/daemon/src/tools/index.ts';
import {
  ADAPTER_CONNECTION,
  GATES_OFF,
  GATES_ON,
  makeToolHarness,
} from '../../tests/tools/harness.ts';
import type { CoordinatorParts, ToolHarness } from '../../tests/tools/harness.ts';

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

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** 脱敏判据：证据里不得出现本机绝对路径。 */
const leaksLocalPaths = (text: string): boolean => /[A-Za-z]:\\|\/tmp\/|\/home\/|\/Users\//.test(text);

function leakSample(text: string): string {
  const match = /[A-Za-z]:\\[^\s"'）)，。]*/.exec(text);
  return match === null ? '(没找到路径片段)' : match[0].slice(0, 60);
}

function checkRedacted(name: string, text: string): void {
  const leaked = leaksLocalPaths(text);
  check(name, !leaked, leaked ? `泄漏片段：${leakSample(text)}` : '');
}

/** 哈希只留前 12 位：够核对，不足以还原内容。 */
function shortHash(value: unknown): string {
  return typeof value === 'string' ? `${value.slice(0, 12)}…(${value.length})` : '?';
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

/**
 * 幂等键。**长度是契约要求**（`LIMITS.MIN_IDEMPOTENCY_KEY_CHARS`，今天 8）。
 * 手写短键会让失败信息指向 zod schema，而不指向「键太短」这件事。
 */
const idem = (tag: string): string => `lwb032-evidence-${tag}`;

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

interface CallOutcome {
  readonly kind: 'ok' | 'error' | 'protocol';
  readonly data: Record<string, unknown>;
  readonly error: BridgeErrorPayload | null;
}

/**
 * 一次 `tools/call` 的三种结局。
 *
 * 三分类是必要的：业务失败、协议错误与成功在这里是三件不同的事。
 * 「未授权被报成了协议错误」这种缺陷在二分类里看不出来。
 */
async function callVia(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallOutcome> {
  const empty = { data: {}, error: null } as const;
  try {
    const raw = (await client.callTool({ name, arguments: args })) as {
      readonly isError?: unknown;
      readonly structuredContent?: unknown;
      readonly content?: readonly { readonly text?: unknown }[];
    };
    if (raw.isError === true) {
      const text = raw.content?.[0]?.text;
      const parsed = typeof text === 'string' ? (JSON.parse(text) as Record<string, unknown>) : {};
      return { kind: 'error', ...empty, error: (parsed['error'] ?? null) as BridgeErrorPayload | null };
    }
    return { kind: 'ok', data: asRecord(asRecord(raw.structuredContent)['data']), error: null };
  } catch (cause) {
    if (cause instanceof McpError) {
      return {
        kind: 'protocol',
        ...empty,
        error: { code: 'PROTOCOL', message: `${cause.code}: ${cause.message}` } as unknown as BridgeErrorPayload,
      };
    }
    throw cause;
  }
}

/**
 * 把一次调用的结局压成一行，供**断言失败时**看真实原因。
 *
 * 措辞不预设这一次该是哪一种：写死「本该被拒绝」会让正向用例失败时
 * 打印出一句相反的话，把排查方向引到反的方向去。
 */
function why(outcome: CallOutcome): string {
  return outcome.kind === 'ok'
    ? `调用成功 data=${JSON.stringify(outcome.data).slice(0, 240)}`
    : `code=${str(outcome.error?.code)} details=${JSON.stringify(outcome.error?.details ?? null)}`;
}

/** daemon 侧的操作表 → 适配器要的窄接口。与生产装配同形（`IpcClient.call`）。 */
function daemonCaller(harness: ToolHarness, requestId: string) {
  return {
    async call(operation: string, input: unknown) {
      const definition = harness.operations.lookup(operation);
      if (definition === undefined) {
        return {
          ok: false as const,
          code: 'UNKNOWN_OPERATION',
          reason: `未注册的操作 ${operation}`,
          outcome_unknown: false,
        };
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
  const client = new Client({ name: 'lwb-evidence-lwb032', version: '0.0.0' });
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
 * 记录型包装：把护栏**写入方法被调用了几次**记下来。
 *
 * 用 `Proxy` 而不是展开对象：真实后端的方法在原型上，`{...backend}` 会把
 * 它们全部丢掉（那份对象只有数据属性），于是「代理过的后端」变成一台
 * 什么都做不了的空壳 —— 而失败会表现为一堆 `NOT_IMPLEMENTED`，
 * 与被测的逻辑毫无关系。方法取出来必须 `apply(target, …)`。
 *
 * 这一层是「只写了一次」的**最靠下**的证词：表行数可以由一次没写盘的
 * 执行产生，指纹可以由「写成了同样的字节」蒙混，而调用次数不能。
 */
interface OpsLedger {
  readonly ops: WinfsOps;
  readonly writes: string[];
  readonly creates: string[];
}

const WRITE_METHODS = new Set<string>(['writeFileGuarded']);
const CREATE_METHODS = new Set<string>(['createFileGuarded']);

function withLedger(backend: WinfsOps): OpsLedger {
  const writes: string[] = [];
  const creates: string[] = [];
  const ops = new Proxy(backend, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const name = String(prop);
      if (!WRITE_METHODS.has(name) && !CREATE_METHODS.has(name)) {
        // **必须 bind**。真实后端用的是**私有字段**（`this.#capability`），
        // 而私有字段只在声明它的那个类上可读：把方法从代理上取出来直接调用，
        // 接收者是代理而不是那个实例，于是每一处 `this.#x` 都抛
        // `TypeError: Cannot read private member` —— 一个与护栏逻辑
        // 毫无关系的异常，而它会以 `INTERNAL_ERROR / UNEXPECTED_ERROR`
        // 的面目出现（工具层刻意不把非 BridgeError 的消息出站）。
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return async (req: unknown): Promise<unknown> => {
        const record = asRecord(req);
        // `relative_path` 是**工作区内相对路径**，不是本机绝对路径，
        // 因此记进证据里不违反脱敏要求。
        const relative = str(record['relative_path']);
        (WRITE_METHODS.has(name) ? writes : creates).push(`${name}(${relative})`);
        return await (value as (a: unknown) => Promise<unknown>).apply(target, [req]);
      };
    },
  }) as WinfsOps;
  return { ops, writes, creates };
}

/** 文件指纹：大小 + 修改时刻 + 内容哈希。 */
function fingerprint(file: string): string {
  const info = statSync(file);
  return `size=${info.size} mtime=${info.mtimeMs} sha256=${sha256(readFileSync(file))}`;
}

/** 落盘字节的哈希（与 `fingerprint` 分开：这里只问内容）。 */
function diskHash(file: string): string {
  return sha256(readFileSync(file));
}

function operationRows(harness: ToolHarness, changeId: string): number {
  return harness.repos.operations.findByChangeId(changeId) === null ? 0 : 1;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

interface Rig {
  readonly harness: ToolHarness;
  readonly adapter: AdapterUnderTest;
  readonly ledger: OpsLedger;
  readonly dir: string;
}

let sandbox = '';
let envRoot = '';
/**
 * 护栏后端。`!` 是**确定赋值断言**：`main()` 的第一件事就是建它，
 * 而所有用它的人都在 `main()` 里面（或它之后的收尾段）。写成
 * `| undefined` 会逼着下面每一处都写一次非空断言，而那不是更安全 ——
 * 只是把同一句话抄了很多遍。
 */
let backend!: PowerShellWinfsBackend;
let environment: WorkspaceEnvironment;
const rigs: Rig[] = [];

async function makeRig(
  seed: string,
  options: {
    readonly files?: Readonly<Record<string, string>>;
    readonly gates?: typeof GATES_ON | (() => typeof GATES_ON);
    readonly paused?: boolean | (() => boolean);
    readonly apply_options?: ToolHarness['deps']['apply_options'];
    readonly coordinator?: (parts: CoordinatorParts) => ExecutionCoordinator;
  } = {},
): Promise<Rig> {
  const dir = path.join(sandbox, seed);
  mkdirSync(dir, { recursive: true });
  for (const [relative, content] of Object.entries(options.files ?? {})) {
    const target = path.join(dir, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  const other = path.join(sandbox, `${seed}-other`);
  mkdirSync(other, { recursive: true });

  const ledger = withLedger(backend);
  const harness = await makeToolHarness({
    root: dir,
    other_root: other,
    ops: ledger.ops,
    probe: backend,
    environment,
    gates: options.gates ?? GATES_ON,
    ...(options.paused === undefined ? {} : { paused: options.paused }),
    ...(options.apply_options === undefined ? {} : { apply_options: options.apply_options }),
    ...(options.coordinator === undefined ? {} : { coordinator: options.coordinator }),
  });
  const adapter = await makeAdapter(daemonCaller(harness, `req-${seed}`));
  const rig: Rig = { harness, adapter, ledger, dir };
  rigs.push(rig);
  return rig;
}

const absOf = (rig: Rig, relative: string): string =>
  path.join(rig.dir, ...relative.split('/'));

/** 读一个文件，返回 `file_read` 的数据（票据与哈希都从这里来）。 */
async function readTarget(rig: Rig, relative: string): Promise<FileReadData> {
  const outcome = await callVia(rig.adapter.client, 'file_read', {
    workspace_id: rig.harness.workspace.id,
    path: relative,
  });
  if (outcome.kind !== 'ok') throw new Error(`读取 ${relative} 失败：${why(outcome)}`);
  return outcome.data as unknown as FileReadData;
}

/** 一份「把某一行换成另一行」的单编辑提案（工具参数形状）。 */
function editArgs(
  rig: Rig,
  read: FileReadData,
  relative: string,
  edit: { readonly line: number; readonly at: string; readonly to: string },
  key: string,
): Record<string, unknown> {
  return {
    workspace_id: rig.harness.workspace.id,
    idempotency_key: key,
    summary: `取证：${relative} 第 ${edit.line} 行`,
    items: [
      {
        op: 'edit_text',
        path: relative,
        base_sha256: read.sha256,
        read_token: read.read_token,
        edits: [
          {
            start_line: edit.line,
            end_line_exclusive: edit.line + 1,
            old_lines: [edit.at],
            new_lines: [edit.to],
          },
        ],
      },
    ],
  };
}

/** 提案 → 工作区内的相对路径、摘要、以及它声明的目标哈希。 */
async function propose(
  rig: Rig,
  relative: string,
  edit: { readonly line: number; readonly at: string; readonly to: string },
  tag: string,
): Promise<ChangePrepareData> {
  const read = await readTarget(rig, relative);
  const outcome = await callVia(
    rig.adapter.client,
    'change_prepare',
    editArgs(rig, read, relative, edit, idem(tag)),
  );
  if (outcome.kind !== 'ok') throw new Error(`提案 ${tag} 失败：${why(outcome)}`);
  return outcome.data as unknown as ChangePrepareData;
}

/** 本地批准。**唯一的批准来源**（approvals 表），工具面读不到也写不了它。 */
function approve(rig: Rig, prepared: ChangePrepareData, tag: string): void {
  approveChange({
    repos: rig.harness.repos,
    change_id: prepared.change_id,
    digest: prepared.digest,
    actor: `console:${tag}`,
    now: new Date(rig.harness.now()).toISOString(),
  });
}

async function applyVia(rig: Rig, changeId: string, key: string): Promise<CallOutcome> {
  return await callVia(rig.adapter.client, 'change_apply', {
    change_id: changeId,
    idempotency_key: key,
  });
}

function applyData(outcome: CallOutcome): ChangeApplyData {
  return outcome.data as unknown as ChangeApplyData;
}

function firstFile(apply: ChangeApplyData): Record<string, unknown> {
  return asRecord((apply.files as unknown as readonly unknown[])[0]);
}

/** 一个只放行一次的闸门：把写盘卡在半路。 */
function latch(): { readonly promise: Promise<void>; release(): void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
}

async function main(): Promise<void> {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'lwb-032-ev-'));
  envRoot = mkdtempSync(path.join(os.tmpdir(), 'lwb-032-env-'));
  backend = new PowerShellWinfsBackend();
  environment = {
    store_root: path.join(envRoot, 'store'),
    home_directory: path.join(envRoot, 'home'),
    extra_broad_probes: [],
    protected_refs: [],
    policy_version: 7,
  };
  mkdirSync(environment.store_root, { recursive: true });
  mkdirSync(environment.home_directory, { recursive: true });

  // -------------------------------------------------------------------------
  section('§0 装置自检：这一轮的证据是在什么上面采的');
  // -------------------------------------------------------------------------

  await guarded('§0', async () => {
    const capability = await backend.capability();
    check(
      '§0.1 原生护栏后端可用（真 CreateFileW / WriteFile / FlushFileBuffers）',
      capability.available === true,
      `backend=${capability.backend} exclusive_handle=${bool(capability.supports_exclusive_handle)} flush=${bool(capability.supports_flush)} 身份=${bool(capability.supports_file_identity)}${capability.available ? '' : ` reason=${capability.resolved_backend_reason}`}`,
    );
    check(
      '§0.2 跨文件事务为假（I11：一次执行的原子性不覆盖用户文件）',
      capability.cross_file_transaction === false,
      `crash_atomic_replace=${bool(capability.crash_atomic_replace)}`,
    );
    note('§0.3 平台', `${process.platform} ${process.arch} / Node ${process.version}`);
    note('§0.4 工作区根', '真 NTFS 临时目录（绝对路径不入库，见下）');

    const rig = await makeRig('selfcheck', { files: { 'note.txt': 'one\ntwo\n' } });
    const root = rig.harness.workspace.canonical_root;
    const volume = await backend.statVolume({ path: root });
    const volumeShown =
      'ok' in volume && volume.ok === true
        ? `volume_id=${shortHash(volume.volume_id)} file_id=${shortHash(volume.file_id)}`
        : JSON.stringify(volume);
    check(
      '§0.5 工作区根真的是一个 NTFS 目录，且身份由**当场探测**得到',
      'ok' in volume && volume.ok === true && volume.is_directory === true,
      volumeShown,
    );

    const listed = await rig.adapter.client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    check('§0.6 适配器列出的工具里有 change_apply', names.includes('change_apply'), `共 ${names.length} 个工具`);
    check('§0.7 适配器列出的工具里有 change_get（未完成时的查询出口）', names.includes('change_get'));
  });

  // -------------------------------------------------------------------------
  section('§1 接线与文案：模型看到的那个工具长什么样（步骤 4）');
  // -------------------------------------------------------------------------

  await guarded('§1', async () => {
    const listed = await (async () => {
      const rig = await makeRig('listing', { files: { 'note.txt': 'x\n' } });
      return await rig.adapter.client.listTools();
    })();
    const definition = listed.tools.find((tool) => tool.name === 'change_apply');
    check('§1.1 change_apply 出现在 tools/list 里', definition !== undefined);
    if (definition === undefined) return;

    const description = definition.description ?? '';
    const required: readonly (readonly [string, string])[] = [
      ['只有 APPLIED 才算落盘', '只有 state=APPLIED 才代表已落盘'],
      ['in_progress 时不许说已保存', '绝不能'],
      ['未完成时改查 change_get', 'change_get'],
      ['重复调用安全', '不会产生第二次写入'],
    ];
    for (const [label, phrase] of required) {
      check(`§1.2 工具说明里有「${label}」`, description.includes(phrase), `找「${phrase}」`);
    }
    for (const forbidden of ['文件已保存', '已写入成功', '可以告诉用户已完成']) {
      check(`§1.3 工具说明里没有正向承诺「${forbidden}」`, !description.includes(forbidden));
    }
    check(
      '§1.4 工具说明点明本工具**不产生批准**',
      description.includes('不能') && description.includes('批准'),
    );
    check('§1.5 工具说明点名 approved 这类参数不被接受', description.includes('approved'));
    checkRedacted('§1.6 工具说明里不含本机绝对路径', description);

    // 输入 schema：两个字段，都是**非身份**字段。
    const schema = definition.inputSchema as unknown as {
      readonly properties?: Record<string, unknown>;
      readonly required?: readonly string[];
      readonly additionalProperties?: unknown;
    };
    const fields = Object.keys(schema.properties ?? {}).sort();
    check(
      '§1.7 change_apply 的输入只有 change_id 与 idempotency_key',
      fields.join(',') === 'change_id,idempotency_key',
      `实际：${fields.join(',')}`,
    );
    check('§1.8 输入 schema 是严格的（additionalProperties=false）', schema.additionalProperties === false);

    // 策略表：唯一一个**要求批准**的动作。
    const action = TOOL_POLICY_ACTIONS.change_apply;
    check('§1.9 change_apply 在策略表里有自己的一行', action !== null, `action=${String(action)}`);
    note('§1.10 策略动作', `change_apply → ${String(action)}；change_get → ${String(TOOL_POLICY_ACTIONS.change_get)}`);

    // 契约里的那句话必须在，因为它是「模型该怎么做」的**唯一出处** ——
    // 适配器列出来的描述是从这里来的，不是另写的一版文案。
    const declared = TOOLS_BY_NAME.get('change_apply');
    check('§1.11 契约里有 change_apply 的定义', declared !== undefined);
    check(
      '§1.12 适配器列出的描述**逐字**来自契约（没有第二份文案）',
      declared?.description === description,
      `契约长度=${declared?.description.length ?? -1} 适配器长度=${description.length}`,
    );
    check(
      '§1.13 适配器列出的输入 schema 与契约里的字段集合一致',
      fields.join(',') === Object.keys(TOOL_INPUT_SCHEMAS.change_apply.shape).sort().join(','),
      `适配器=${fields.join(',')} 契约=${Object.keys(TOOL_INPUT_SCHEMAS.change_apply.shape).sort().join(',')}`,
    );
  });

  // -------------------------------------------------------------------------
  section('§2 未批准：一条修改集不能靠「点一下」自己变成已批准（验收 1）');
  // -------------------------------------------------------------------------

  await guarded('§2', async () => {
    const rig = await makeRig('no-approval', { files: { 'note.txt': 'one\ntwo\n' } });
    const file = absOf(rig, 'note.txt');

    const prepared = await propose(rig, 'note.txt', { line: 1, at: 'one', to: 'ONE' }, 's2');
    check('§2.1 提案停在 PENDING_APPROVAL（本地批准不可省略）', prepared.state === 'PENDING_APPROVAL', `state=${prepared.state}`);

    const untouched = fingerprint(file);
    const refused = await applyVia(rig, prepared.change_id, idem('s2-apply'));
    check(
      '§2.2 没有本地批准时 change_apply 被拒绝，错误码是 APPROVAL_REQUIRED',
      refused.kind === 'error' && refused.error?.code === 'APPROVAL_REQUIRED',
      why(refused),
    );
    check('§2.3 被拒绝的应用**一个字节都没写**', fingerprint(file) === untouched);
    check('§2.4 被拒绝的应用**不建立操作行**', operationRows(rig.harness, prepared.change_id) === 0);
    check('§2.5 被拒绝的应用不产生护栏写入调用', rig.ledger.writes.length === 0, `writes=${JSON.stringify(rig.ledger.writes)}`);
    checkRedacted('§2.6 拒绝文案里不含本机绝对路径', refused.error?.message ?? '');

    // 「批准」不是一个可以夹带进来的参数 —— 它连 schema 都过不去。
    const smuggled = await callVia(rig.adapter.client, 'change_apply', {
      change_id: prepared.change_id,
      idempotency_key: idem('s2-smuggle'),
      approved: true,
      user_id: 'someone',
    });
    check(
      '§2.7 approved / user_id 这类字段**连输入 schema 都过不去**（不是「传了但不生效」）',
      smuggled.kind === 'error' && smuggled.error?.code === 'INVALID_ARGUMENT',
      why(smuggled),
    );
    check('§2.8 夹带身份字段的那次调用同样零写入', fingerprint(file) === untouched);

    // 批准之后同一条修改集才落地 —— 否则上面那句「拒绝」可能只是「这台装置永远拒绝」。
    approve(rig, prepared, 's2');
    const applied = await applyVia(rig, prepared.change_id, idem('s2-apply2'));
    check('§2.9 补上本地批准之后同一条修改集正常落地', applied.kind === 'ok' && applyData(applied).state === 'APPLIED', why(applied));
    check('§2.10 落地时真的写了盘（护栏写入调用恰好一次）', rig.ledger.writes.length === 1, `writes=${JSON.stringify(rig.ledger.writes)}`);
  });

  // -------------------------------------------------------------------------
  section('§3 已批准：回执是逐文件哈希，不是一句「成功」（步骤 1、验收 3）');
  // -------------------------------------------------------------------------

  await guarded('§3', async () => {
    const rig = await makeRig('receipt', { files: { 'note.txt': 'one\ntwo\n' } });
    const file = absOf(rig, 'note.txt');
    const before = readFileSync(file);

    const prepared = await propose(rig, 'note.txt', { line: 2, at: 'two', to: 'TWO' }, 's3');
    approve(rig, prepared, 's3');
    const outcome = await applyVia(rig, prepared.change_id, idem('s3-apply'));
    check('§3.1 已批准的修改集应用成功', outcome.kind === 'ok', why(outcome));
    if (outcome.kind !== 'ok') return;

    const apply = applyData(outcome);
    check('§3.2 终局状态是 APPLIED', apply.state === 'APPLIED', `state=${apply.state}`);
    check('§3.3 回执里 in_progress 为假', apply.in_progress === false);
    check('§3.4 回执带一个稳定的 operation_id', typeof apply.operation_id === 'string' && apply.operation_id.length > 0, `operation_id=${shortHash(apply.operation_id)}`);

    const entry = firstFile(apply);
    check('§3.5 逐文件状态的取值是一个合法值', typeof entry['state'] === 'string', `state=${str(entry['state'])}`);
    check('§3.6 成功的逐文件结果只能是 VERIFIED', entry['state'] === 'VERIFIED', `state=${str(entry['state'])}`);
    check(
      '§3.7 before_sha256 等于**本脚本独立读回的**修改前字节',
      entry['before_sha256'] === sha256(before),
      `回执=${shortHash(entry['before_sha256'])} 盘上（改前）=${shortHash(sha256(before))}`,
    );
    check(
      '§3.8 after_sha256 等于**本脚本独立读回的**修改后字节',
      entry['after_sha256'] === diskHash(file),
      `回执=${shortHash(entry['after_sha256'])} 盘上（改后）=${shortHash(diskHash(file))}`,
    );
    check(
      '§3.9 提案声明的目标与盘上的结果一致（回执不是自说自话）',
      prepared.files[0]?.after_sha256 === diskHash(file),
    );
    check('§3.10 tests_run 恒为 false —— 落盘不等于通过测试', apply.tests_run === false, `tests_run=${bool(apply.tests_run)}`);
    check('§3.11 盘上真的变了字节', readFileSync(file, 'utf8') === 'one\nTWO\n');

    // 同一个操作在 change_get 里必须给出**逐字同一份**回执。
    const viaGet = await callVia(rig.adapter.client, 'change_get', { change_id: prepared.change_id });
    check('§3.12 change_get 查得到同一条操作', viaGet.kind === 'ok', why(viaGet));
    if (viaGet.kind === 'ok') {
      const data = viaGet.data as unknown as ChangeGetData;
      const operation = asRecord((data as unknown as Record<string, unknown>)['operation']);
      check(
        '§3.13 change_get 的 operation_id 与 change_apply 的同一条',
        operation['operation_id'] === apply.operation_id,
      );
      const getFiles = (operation['files'] ?? []) as readonly unknown[];
      check(
        '§3.14 **两个工具给出逐字相同的逐文件回执**（回执只有一个来源）',
        JSON.stringify(getFiles) === JSON.stringify(apply.files),
        `change_get=${JSON.stringify(getFiles).slice(0, 160)}`,
      );
    }

    check('§3.15 operations 表上只有一行', operationRows(rig.harness, prepared.change_id) === 1);
    check('§3.16 护栏写入调用恰好一次', rig.ledger.writes.length === 1, `writes=${JSON.stringify(rig.ledger.writes)}`);

    // 回执与库里的那条记录一致（不是 handler 拼出来的）。
    const stored = operationReceiptFor(prepared.change_id, rig.harness.repos);
    check(
      '§3.17 回执逐字等于 `operationReceiptFor` 那条（写入侧没有第二份回执实现）',
      stored !== null &&
        stored.operation_id === apply.operation_id &&
        JSON.stringify(stored.files) === JSON.stringify(apply.files),
    );
    checkRedacted('§3.18 回执里不含本机绝对路径', JSON.stringify(apply));
    check(
      '§3.19 回执里的路径是工作区内相对路径',
      entry['path'] === 'note.txt',
      `path=${str(entry['path'])}`,
    );
  });

  // -------------------------------------------------------------------------
  section('§4 重复调用：换不换幂等键都是同一条操作（步骤 3、验收 2）');
  // -------------------------------------------------------------------------

  await guarded('§4', async () => {
    const rig = await makeRig('repeat', { files: { 'note.txt': 'one\ntwo\n' } });
    const file = absOf(rig, 'note.txt');

    const prepared = await propose(rig, 'note.txt', { line: 1, at: 'one', to: 'ONE' }, 's4');
    approve(rig, prepared, 's4');

    const first = await applyVia(rig, prepared.change_id, idem('s4-a'));
    check('§4.1 第一次应用成功', first.kind === 'ok' && applyData(first).state === 'APPLIED', why(first));
    if (first.kind !== 'ok') return;
    const firstData = applyData(first);
    const settled = fingerprint(file);
    const writesAfterFirst = rig.ledger.writes.length;

    // 同键重试：这是「模型没收到回答又发了一遍」的形状。
    const sameKey = await applyVia(rig, prepared.change_id, idem('s4-a'));
    // 换键重试：这是「模型换了个键再发一遍」的形状 —— 也正是
    // 「幂等只靠键」的实现会写第二次的那一格。
    const otherKey = await applyVia(rig, prepared.change_id, idem('s4-b'));

    check('§4.2 同键重试成功返回', sameKey.kind === 'ok', why(sameKey));
    check('§4.3 换键重试成功返回', otherKey.kind === 'ok', why(otherKey));
    check(
      '§4.4 同键重试返回**同一条** operation_id',
      sameKey.kind === 'ok' && applyData(sameKey).operation_id === firstData.operation_id,
      `第一次=${shortHash(firstData.operation_id)} 重试=${shortHash(sameKey.kind === 'ok' ? applyData(sameKey).operation_id : '?')}`,
    );
    check(
      '§4.5 换键重试返回**同一条** operation_id',
      otherKey.kind === 'ok' && applyData(otherKey).operation_id === firstData.operation_id,
    );
    check(
      '§4.6 重试的回执与第一次逐字相同（不是一份「看起来一样」的对象）',
      otherKey.kind === 'ok' && JSON.stringify(applyData(otherKey)) === JSON.stringify(firstData),
    );
    check(
      '§4.7 重复调用**一个字节都没再写**（指纹含修改时刻）',
      fingerprint(file) === settled,
      `第一次后=${settled.slice(0, 40)} 重试后=${fingerprint(file).slice(0, 40)}`,
    );
    check(
      '§4.8 重复调用**没有产生第二次护栏写入**',
      rig.ledger.writes.length === writesAfterFirst,
      `第一次之后=${writesAfterFirst} 现在=${rig.ledger.writes.length}`,
    );
    check('§4.9 operations 表上仍然只有一行', operationRows(rig.harness, prepared.change_id) === 1);
    check('§4.10 重试的 tests_run 仍然是 false', otherKey.kind === 'ok' && applyData(otherKey).tests_run === false);

    // 并发：两次调用同时落下，仍然只写一次。
    const rig2 = await makeRig('concurrent', { files: { 'note.txt': 'alpha\nbeta\n' } });
    const file2 = absOf(rig2, 'note.txt');
    const prepared2 = await propose(rig2, 'note.txt', { line: 1, at: 'alpha', to: 'ALPHA' }, 's4c');
    approve(rig2, prepared2, 's4c');
    const [a, b] = await Promise.all([
      applyVia(rig2, prepared2.change_id, idem('s4c-1')),
      applyVia(rig2, prepared2.change_id, idem('s4c-2')),
    ]);
    const ids = [a, b].filter((o) => o.kind === 'ok').map((o) => applyData(o).operation_id);
    check(
      '§4.11 并发两次调用：成功的那几次给的是同一条 operation_id',
      ids.length >= 1 && new Set(ids).size === 1,
      `结局=${[a, b].map((o) => (o.kind === 'ok' ? `ok:${shortHash(applyData(o).operation_id)}` : why(o))).join(' | ')}`,
    );
    check('§4.12 并发之后 operations 表仍然只有一行', operationRows(rig2.harness, prepared2.change_id) === 1);
    check('§4.13 并发之后护栏写入调用恰好一次', rig2.ledger.writes.length === 1, `writes=${JSON.stringify(rig2.ledger.writes)}`);
    check('§4.14 并发之后内容正确且只写了一次', readFileSync(file2, 'utf8') === 'ALPHA\nbeta\n');
  });

  // -------------------------------------------------------------------------
  section('§5 两个入口、一件事：控制台与工具面落到同一条操作（步骤 1）');
  // -------------------------------------------------------------------------

  await guarded('§5', async () => {
    const rig = await makeRig('console', { files: { 'shared.txt': 'left\nright\n' } });
    const file = absOf(rig, 'shared.txt');

    const prepared = await propose(rig, 'shared.txt', { line: 2, at: 'right', to: 'RIGHT' }, 's5');

    // 方案 §10.2 的主按钮：批准与排队在**一个事务**里。
    const queued = approveAndQueue({
      repos: rig.harness.repos,
      change_id: prepared.change_id,
      digest: prepared.digest,
      actor: 'console:lwb-032-取证',
      now: new Date(rig.harness.now()).toISOString(),
      idempotency_key: idem('s5-console'),
    });
    check(
      '§5.1 控制台「批准并应用」把修改集推到排队，并建立唯一那条操作',
      queued.change.state === 'QUEUED' && queued.operation_existed === false,
      `state=${queued.change.state} operation=${shortHash(queued.operation.id)}`,
    );

    // 控制台随后执行它 —— 走的是**应用服务**（`@lwb/executor` 的 applyChange），
    // 也就是工具面那条路用的同一个函数。
    const consoleResult = await applyChange(
      { change_id: prepared.change_id, connection_id: ADAPTER_CONNECTION },
      { repos: rig.harness.repos, coordinator: rig.harness.coordinator },
    );
    check('§5.2 控制台路径应用成功', consoleResult.state === 'APPLIED', `state=${consoleResult.state}`);
    check(
      '§5.3 控制台路径的回执同样带真哈希',
      consoleResult.files[0]?.after_sha256 === diskHash(file),
    );

    // 模型随后再来点一次（换一个键）：必须拿到**同一条操作**。
    const viaTool = await applyVia(rig, prepared.change_id, idem('s5-tool'));
    check('§5.4 工具面在控制台之后调用仍然成功', viaTool.kind === 'ok', why(viaTool));
    if (viaTool.kind === 'ok') {
      const data = applyData(viaTool);
      check(
        '§5.5 **两个入口落到同一条 operation_id**',
        data.operation_id === consoleResult.operation_id,
        `控制台=${shortHash(consoleResult.operation_id)} 工具面=${shortHash(data.operation_id)}`,
      );
      check('§5.6 工具面拿到的状态也是 APPLIED', data.state === 'APPLIED');
      check(
        '§5.7 工具面拿到的逐文件回执与控制台逐字相同',
        JSON.stringify(data.files) === JSON.stringify(consoleResult.files),
      );
    }
    check('§5.8 operations 表上只有一行', operationRows(rig.harness, prepared.change_id) === 1);
    check('§5.9 护栏写入调用恰好一次', rig.ledger.writes.length === 1, `writes=${JSON.stringify(rig.ledger.writes)}`);
  });

  // -------------------------------------------------------------------------
  section('§6 没等到结论：如实回答 in_progress，而不是宣称已保存（步骤 2、验收 2）');
  // -------------------------------------------------------------------------

  await guarded('§6', async () => {
    // 把写盘**卡住**：`wait_ms: 0` 的语义是「本次不等」，而一个已经跑完的
    // 写盘会让这一格退化成 §3。因此这里注入一个真协调器 —— 它用的仍是
    // 生产那个 `createNativeApplier`，只是在它前面加一道闸。
    const gate = latch();
    let entered = false;

    const rig = await makeRig('inflight', {
      files: { 'slow.txt': 'before\n' },
      apply_options: { wait_ms: 0 },
      coordinator: (parts: CoordinatorParts): ExecutionCoordinator => {
        const real: ExecutionApplier = createNativeApplier({
          repos: parts.repos,
          ops: parts.ops,
          blobs: parts.blobs,
        });
        const gated: ExecutionApplier = async (
          plan: ExecutionPlan,
          signal: AbortSignal,
        ): Promise<ApplyReport> => {
          entered = true;
          await gate.promise;
          return await real(plan, signal);
        };
        return new ExecutionCoordinator({
          repos: parts.repos,
          probe: createProcessProbe(),
          apply: gated,
          holder: { pid: process.pid, started_at: new Date(parts.now() - 60_000).toISOString() },
          now: parts.now,
        });
      },
    });
    const file = absOf(rig, 'slow.txt');

    const prepared = await propose(rig, 'slow.txt', { line: 1, at: 'before', to: 'after' }, 's6');
    approve(rig, prepared, 's6');
    const untouched = fingerprint(file);

    const outcome = await applyVia(rig, prepared.change_id, idem('s6-apply'));
    check('§6.1 等待预算到点时**仍然成功返回**（不是超时错误）', outcome.kind === 'ok', why(outcome));
    if (outcome.kind !== 'ok') return;
    const answer = applyData(outcome);
    check('§6.2 回执里 in_progress 为真', answer.in_progress === true, `in_progress=${bool(answer.in_progress)}`);
    check(
      '§6.3 状态是执行中的那三个之一（不是终局）',
      isExecutionChangeState(answer.state),
      `state=${answer.state}`,
    );
    check('§6.4 未完成时 tests_run 仍然是 false', answer.tests_run === false);
    check(
      '§6.5 「没等到结论」不是「已保存」：此刻盘上还是原样',
      fingerprint(file) === untouched,
    );
    check('§6.6 此刻已经有一条操作行了（但一次真正的写入还没发生）', operationRows(rig.harness, prepared.change_id) === 1);

    // 执行还在跑 —— 再点一次不得起第二次写。
    const retry = await applyVia(rig, prepared.change_id, idem('s6-retry'));
    check('§6.7 执行中重放**成功返回**（不是一句关于批准的错误）', retry.kind === 'ok', why(retry));
    if (retry.kind === 'ok') {
      const data = applyData(retry);
      check('§6.8 执行中重放只能得到「还在执行」', data.in_progress === true, `state=${data.state}`);
      check('§6.9 仍然只能有那一条操作', data.operation_id === answer.operation_id);
    }
    check('§6.10 重放不得产生第二条操作', operationRows(rig.harness, prepared.change_id) === 1);
    check('§6.11 重放不得产生护栏写入调用', rig.ledger.writes.length === 0, `writes=${JSON.stringify(rig.ledger.writes)}`);

    // 放行，然后等那次被放弃的等待**自己**跑完 —— 它继续跑，且真的落了盘。
    check('§6.12 装置自检：写盘必须真的被卡住过，否则本段什么都没验到', entered);
    gate.release();

    let receipt: ReturnType<typeof operationReceiptFor> = null;
    for (let i = 0; i < 200; i += 1) {
      receipt = operationReceiptFor(prepared.change_id, rig.harness.repos);
      if (receipt !== null && !isExecutionChangeState(receipt.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    check('§6.13 被放弃的等待也必须有终局', receipt?.state === 'APPLIED', `state=${receipt?.state ?? '(无回执)'}`);
    check(
      '§6.14 放行之后的回执里带的是真哈希',
      receipt?.files[0]?.after_sha256 === diskHash(file),
      `回执=${shortHash(receipt?.files[0]?.after_sha256)} 盘上=${shortHash(diskHash(file))}`,
    );
    check('§6.15 放行之后盘上真的写了一次', readFileSync(file, 'utf8') === 'after\n');
    check('§6.16 护栏写入调用恰好一次', rig.ledger.writes.length === 1, `writes=${JSON.stringify(rig.ledger.writes)}`);

    // 收场之后 `change_get` 能查到它 —— 这正是回执里那句「改用 change_get」。
    const later = await applyVia(rig, prepared.change_id, idem('s6-later'));
    check('§6.17 事后再调用 change_apply 能拿到终局回执', later.kind === 'ok', why(later));
    if (later.kind === 'ok') {
      const data = applyData(later);
      check('§6.18 事后拿到的是 APPLIED 且 in_progress 为假', data.state === 'APPLIED' && data.in_progress === false);
      check('§6.19 事后拿到的仍然是同一条操作', data.operation_id === answer.operation_id);
    }
    const viaGet = await callVia(rig.adapter.client, 'change_get', { change_id: prepared.change_id });
    check('§6.20 回执里那句「改用 change_get 查询」是可执行的', viaGet.kind === 'ok', why(viaGet));
    check('§6.21 放行之后仍然只写过一次', rig.ledger.writes.length === 1);
  });

  // -------------------------------------------------------------------------
  section('§7 重放走的是回执面：直写关掉之后仍答得出结论（本轮的修复点）');
  // -------------------------------------------------------------------------

  await guarded('§7', async () => {
    let gates: typeof GATES_ON = GATES_ON;
    const rig = await makeRig('replay-surface', {
      files: { 'note.txt': 'r\n' },
      gates: () => gates,
    });
    const file = absOf(rig, 'note.txt');

    const done = await propose(rig, 'note.txt', { line: 1, at: 'r', to: 'R' }, 's7');
    approve(rig, done, 's7');
    const first = await applyVia(rig, done.change_id, idem('s7-apply'));
    check('§7.1 第一次应用成功', first.kind === 'ok' && applyData(first).state === 'APPLIED', why(first));
    if (first.kind !== 'ok') return;
    const firstData = applyData(first);
    const settled = fingerprint(file);

    // G0 与 §3 仍算通过，只有原生护栏那一条翻掉 —— 于是
    // `direct_write_enabled` 关而 `read_enabled` 开。
    gates = { ...GATES_ON, native_guard_verified: false };

    const pending = await propose(rig, 'note.txt', { line: 1, at: 'R', to: 'RR' }, 's7b');
    approve(rig, pending, 's7b');
    const refused = await applyVia(rig, pending.change_id, idem('s7b-apply'));
    check(
      '§7.2 直写关掉之后，**一次真正的写入**被拒绝',
      refused.kind === 'error' && refused.error?.code === 'POLICY_DENIED',
      why(refused),
    );
    check(
      '§7.3 拒绝的理由是那条开关本身（CAPABILITY_FLAG_DISABLED）',
      refused.error?.details?.['policy_reason'] === 'CAPABILITY_FLAG_DISABLED',
      `policy_reason=${str(refused.error?.details?.['policy_reason'])}`,
    );
    check('§7.4 被拒的写入不建立操作行', operationRows(rig.harness, pending.change_id) === 0);

    // 已经应用过的那一条：同一次调用、同一组门禁，答的是**回执**。
    const replayed = await applyVia(rig, done.change_id, idem('s7-again'));
    check(
      '§7.5 **已经应用过的那条仍然答得出回执**（重放按读面判定）',
      replayed.kind === 'ok',
      why(replayed),
    );
    if (replayed.kind === 'ok') {
      const data = applyData(replayed);
      check('§7.6 重放给出的仍然是那条操作', data.operation_id === firstData.operation_id);
      check('§7.7 重放给出的状态是 APPLIED', data.state === 'APPLIED');
      check(
        '§7.8 重放给出的逐文件哈希仍然等于盘上的字节',
        firstFile(data)['after_sha256'] === diskHash(file),
      );
    }
    check('§7.9 重放不得再写一次', fingerprint(file) === settled);
    check('§7.10 重放之后护栏写入调用仍然只有一次', rig.ledger.writes.length === 1, `writes=${JSON.stringify(rig.ledger.writes)}`);

    // 关掉**读取**之后这条路径也要关上：回执是内容出站
    // （`change_receipt` 在 `EGRESS_SURFACES` 里），不能因为
    // 「反正这次没写」就变成绕开读取开关的口子。
    gates = GATES_OFF;
    const blinded = await applyVia(rig, done.change_id, idem('s7-blind'));
    check(
      '§7.11 读取能力关掉之后，重放同样被拒绝（回执不是绕开开关的口子）',
      blinded.kind === 'error' && blinded.error?.code === 'POLICY_DENIED',
      why(blinded),
    );
  });

  // -------------------------------------------------------------------------
  section('§8 门禁与暂停：不可用时不许「看起来能用」（回退约束）');
  // -------------------------------------------------------------------------

  await guarded('§8', async () => {
    // 顺序是这一格的全部：**先开着门禁**把修改集与本地批准准备好，
    // **再**关门，然后点应用。这样测到的才是「能力开关能拦住一次本来
    // 会成功的写入」，而不是「门禁关着的时候提案建不出来」。
    let gates: typeof GATES_ON = GATES_ON;
    const rig = await makeRig('gates-off', { files: { 'note.txt': 'g\n' }, gates: () => gates });
    const file = absOf(rig, 'note.txt');

    const prepared = await propose(rig, 'note.txt', { line: 1, at: 'g', to: 'G' }, 's8');
    approve(rig, prepared, 's8');
    const before = fingerprint(file);

    gates = GATES_OFF;
    const refused = await applyVia(rig, prepared.change_id, idem('s8-apply'));
    check(
      '§8.1 门禁关掉之后，已批准的修改集也写不进去',
      refused.kind === 'error' && refused.error?.code === 'POLICY_DENIED',
      why(refused),
    );
    check('§8.2 门禁关着时不得写盘', fingerprint(file) === before);
    check('§8.3 门禁关着时不得建立操作行', operationRows(rig.harness, prepared.change_id) === 0);
    check('§8.4 门禁关着时不产生护栏写入调用', rig.ledger.writes.length === 0);

    // 「关闭相关能力开关」不等于「把已经写下去的东西收回来」——
    // 回退约束的三句话里的前两句：**保留执行日志与未决恢复数据**。
    // 这一组必须夹在「关掉」与「重开」之间：重开之后文件就被写了，
    // 那时再比指纹，比的已经不是这件事。
    const stillThere = rig.harness.repos.changes.findById(prepared.change_id);
    check(
      '§8.5 门禁关掉之后，那条**未决**修改集仍然在（没有借机关掉数据）',
      stillThere !== null,
      `state=${stillThere?.state ?? '(没了)'}`,
    );
    check(
      '§8.6 它的条目与批准都还在（未决数据被保留，不是被清理）',
      rig.harness.repos.changes.items(prepared.change_id).length === 1 &&
        rig.harness.repos.approvals.listForChange(prepared.change_id).length >= 1,
      `items=${rig.harness.repos.changes.items(prepared.change_id).length} approvals=${rig.harness.repos.approvals.listForChange(prepared.change_id).length}`,
    );
    check(
      '§8.7 关掉开关这件事本身**没有碰过用户文件**（回滚不能靠覆盖用户文件实现）',
      fingerprint(file) === before,
    );

    gates = GATES_ON;
    const applied = await applyVia(rig, prepared.change_id, idem('s8-apply2'));
    check(
      '§8.8 门禁重新打开之后，**同一份批准**仍然有效（上面那次拒绝确实是门禁造成的）',
      applied.kind === 'ok' && applyData(applied).state === 'APPLIED',
      why(applied),
    );

    // 全局暂停：同样是**可变**的读数，提案与批准必须在它之前发生。
    let paused = false;
    const rig2 = await makeRig('paused', { files: { 'note.txt': 'p\n' }, paused: () => paused });
    const file2 = absOf(rig2, 'note.txt');
    const prepared2 = await propose(rig2, 'note.txt', { line: 1, at: 'p', to: 'P' }, 's8p');
    approve(rig2, prepared2, 's8p');
    const before2 = fingerprint(file2);

    paused = true;
    const refused2 = await applyVia(rig2, prepared2.change_id, idem('s8p-apply'));
    check(
      '§8.9 全局暂停时 change_apply 被拒绝，错误码是 PAUSED',
      refused2.kind === 'error' && refused2.error?.code === 'PAUSED',
      why(refused2),
    );
    check('§8.10 暂停期间不得写盘', fingerprint(file2) === before2);
    check('§8.11 暂停期间不得建立操作行', operationRows(rig2.harness, prepared2.change_id) === 0);
    check(
      '§8.12 暂停不改变修改集状态（只是拦住这次执行）',
      rig2.harness.repos.changes.findById(prepared2.change_id)?.state === 'APPROVED',
      `state=${rig2.harness.repos.changes.findById(prepared2.change_id)?.state ?? '?'}`,
    );

    // 暂停解除之后同一条批准仍然落地 —— 否则上面那句「拦住」可能只是
    // 「这台装置根本不写盘」。
    paused = false;
    const afterResume = await applyVia(rig2, prepared2.change_id, idem('s8p-apply2'));
    check(
      '§8.13 暂停解除之后，同一份批准仍然能落地（上面那次拦住是暂停造成的）',
      afterResume.kind === 'ok' && applyData(afterResume).state === 'APPLIED',
      why(afterResume),
    );
  });

  // -------------------------------------------------------------------------
  section('§9 交付物、未执行项与计数');
  // -------------------------------------------------------------------------

  await guarded('§9', async () => {
    const deliverables: readonly (readonly [string, string])[] = [
      ['packages/executor/src/apply-service.ts', '应用服务：控制台与工具面共用的那一个'],
      ['apps/daemon/src/tools/handlers.ts', 'changeApply 与 replayApplied'],
      ['packages/changes/src/execution-journal.ts', '日志折叠的共享词汇'],
      ['packages/changes/src/query.ts', 'operationReceiptOf 折日志'],
      ['tests/windows/daemon-apply-tool.test.ts', '真 NTFS 验收用例'],
      ['tests/unit/change-receipt.test.ts', '回执折叠的穷举用例'],
    ];
    for (const [file, what] of deliverables) {
      check(`§9.1 交付物存在：${file}`, existsRel(file), what);
    }
  });

  note('§9.2 未执行项', '逐条列在 docs/evidence/lwb-032/summary.md 的「未执行项」一节');
  skip('真实 ChatGPT 网页端批准一次应用', 'G0 未通过；LWB-002 BLOCKED（无真实账号与隧道凭据）');
  skip('网页批准与本地批准的差异在**界面上**的呈现', 'W4 控制台界面尚未实现；本任务只到服务层（方案 §10.2）');
  skip('断网（传输中断）之后的重放', '需要真实隧道；本轮构造的是**超时**（§6）与**重复调用**（§4），不是断网');
  skip('进程被杀 / 断电之后的重放', '属 LWB-033 的崩溃专项；启动恢复本身已在 LWB-030 取证');
  skip('两个进程同时应用同一条修改集', '属 LWB-033 的竞争专项；本轮的并发是**同进程内**两次调用（§4.11）');
  skip('Git 暂存区不受影响', '本任务不碰 Git；LWB-031 §8 已就 `change_revert_prepare` 取证过');
}

/** 相对仓库根的存在性检查（脚本收尾用）。 */
function existsRel(relative: string): boolean {
  return existsSync(path.join(process.cwd(), ...relative.split('/')));
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

await main();

for (const rig of rigs) {
  await rig.adapter.close().catch(() => undefined);
  rig.harness.close();
}
await backend.dispose().catch(() => undefined);
rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
rmSync(envRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

console.log(`\n== 计数 ==`);
console.log(`PASS ${passes} / FAIL ${failures} / NOT_RUN ${skips}`);
process.exitCode = failures === 0 ? 0 : 1;
