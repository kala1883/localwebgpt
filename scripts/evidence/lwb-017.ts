/**
 * LWB-017 可复现证据采集：工具面（daemon 侧）与 MCP 适配器。
 *
 * 三条验收标准在这里各有一段，**都是在真实护栏（PowerShell + .NET P/Invoke）
 * 与真实 NTFS 上跑出来的**：
 *
 *  1. 「无控制平面方法出现在 tools/list」—— 两次核对：daemon 的清单
 *     （`tools.catalog`）里一条都没有；MCP 的 `tools/list` 里一条都没有，
 *     且逐条打印 12 条控制面路由的名字都没出现。
 *  2. 「工具结果符合 schema，调用未知字段/无效枚举被拒绝」—— 七个工具各
 *     走一遍**真 MCP 客户端**（SDK 会拿挂出去的 `outputSchema` 校验
 *     `structuredContent`，因此裁判是第三方而不是本仓库），再在
 *     daemon 侧用 `TOOL_OUTPUT_SCHEMAS` 复核一遍；负向四类：未知字段、
 *     身份字段（`approved`/`user_id`/`session_id`）、无效枚举、
 *     未授权工作区。
 *  3. 「两条配置不同的连接不能读取对方工作区」—— 两个连接各读自己的工作区
 *     必须成功（否则「读不到」可能只是因为它什么都没读到），互读必须
 *     `WORKSPACE_NOT_GRANTED`，三个工具各验一遍。
 *
 * 另外两件本任务里必须留下的东西：
 *
 *  - **失败信封的判别顺序**。`toCallToolResult` 修好之前，daemon 的每一次
 *    业务失败（策略拒绝、未授权）都会被折成 `INTERNAL_ERROR`。本文件不但
 *    断言失败码是对的，还断言**失败信封确实不符合成功 schema** —— 也就是
 *    说这条判别顺序是**有作用的**，而不是一个恒真的分支。
 *  - **进程级链路**：真 MCP 客户端 ←stdio→ 真适配器进程 ←命名管道→ 真 IPC
 *    服务端 → 真护栏。stdio 上只有协议消息这句话，由「客户端一路解析到最后
 *    一条」来证明。
 *
 * 用法：node --import tsx scripts/evidence/lwb-017.ts
 * 退出码：全部通过 0；任一项失败 1。
 *
 * 本文件证明不了的事（见末尾「未执行项」）：ChatGPT 网页端能发现并调用这些
 * 工具 —— 那需要真实账号与 Secure MCP Tunnel 凭证，当前 BLOCKED。
 * MCP Inspector 的一次成功也不能替代它。
 */

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import process from 'node:process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

import {
  BRIDGE_ERROR_PAYLOAD,
  CONTROL_PLANE_ROUTES,
  IMPLEMENTED_TOOL_NAMES,
  TOOL_NAMES,
  TOOL_OUTPUT_SCHEMAS,
} from '@lwb/contracts';
import type { BridgeErrorPayload, ImplementedToolName } from '@lwb/contracts';
import { attachSocket } from '@lwb/ipc';
import { PowerShellWinfsBackend } from '@lwb/winfs';

import { CONNECTION_ID_ENV, PIPE_NAME_ENV, SECRET_ENV, VERSION_ENV } from '../../apps/mcp-adapter/src/config.ts';
import { createAdapterServer } from '../../apps/mcp-adapter/src/server.ts';
import { CANARY_DIR, TESTREPO_DIR, ensureFixtures, findFile, loadManifest } from '../../tests/fixtures/index.ts';
import type { FixtureManifest } from '../../tests/fixtures/index.ts';
import {
  ADAPTER_CONNECTION,
  GATES_OFF,
  GATES_ON,
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

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const ADAPTER_ENTRY = path.join('apps', 'mcp-adapter', 'src', 'main.ts');
const ADAPTER_SECRET = 'adapter-secret-for-evidence-0123456789';
const CONSOLE_SECRET = 'console-secret-for-evidence-0123456789';

// ---------------------------------------------------------------------------
// 脱敏摘要：证据里只出现形状与计数，不出现文件内容
// ---------------------------------------------------------------------------

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

/**
 * 每个工具结果的**脱敏摘要**。
 *
 * 认不出的字段一律不打印 —— 默认分支只列键名。「把结果整个打出来」在这里
 * 是不行的：工具结果里可能是工作区文件的内容，而证据文件会被提交。
 */
function digestOf(name: string, data: unknown): string {
  const d = asRecord(data);
  switch (name) {
    case 'bridge_status': {
      const caps = asRecord(d['capabilities']);
      const gates = asRecord(d['gates']);
      const limitations = Array.isArray(d['limitations']) ? d['limitations'].length : -1;
      return (
        `read=${bool(caps['read_enabled'])} git=${bool(caps['git_enabled'])} ` +
        `write=${bool(caps['direct_write_enabled'])} gates=${bool(gates['g0_platform_verified'])}/${bool(gates['native_guard_verified'])} ` +
        `limitations=${limitations}`
      );
    }
    case 'workspace_list': {
      const workspaces = Array.isArray(d['workspaces']) ? d['workspaces'] : [];
      const modes = workspaces.map((w) => `${str(asRecord(w)['kind'])}/${str(asRecord(w)['mode'])}`).join(',');
      return `workspaces=${workspaces.length}(${modes}) truncated=${bool(d['truncated'])}`;
    }
    case 'file_list': {
      const entries = Array.isArray(d['entries']) ? d['entries'] : [];
      return (
        `path=${str(d['path'])} entries=${entries.length} next_cursor=${d['next_cursor'] === null ? 'null' : '有'} ` +
        `denied=${num(d['denied_entries'])} excluded=${num(d['excluded_entries'])} incomplete=${bool(d['incomplete'])}`
      );
    }
    case 'text_search': {
      const matches = Array.isArray(d['matches']) ? d['matches'] : [];
      const scope = asRecord(d['scope']);
      const files = new Set(matches.map((m) => str(asRecord(m)['path'])));
      return (
        `matches=${matches.length} files=${files.size} scanned=${num(scope['scanned_files'])} ` +
        `secret_files=${num(scope['secret_files'])} denied=${num(scope['denied_files'])}`
      );
    }
    case 'file_read':
      return (
        `sha256=${shortHash(d['sha256'])} 行=${num(d['start_line'])}–${num(d['end_line_exclusive'])} ` +
        `encoding=${str(d['encoding'])} newline=${str(d['newline'])} bytes=${num(d['bytes_returned'])} ` +
        `redacted=${bool(d['redacted'])} editable=${bool(d['editable'])}`
      );
    case 'git_status': {
      const entries = Array.isArray(d['entries']) ? d['entries'] : [];
      const pairs = new Set(entries.map((e) => `${str(asRecord(e)['head'])}/${str(asRecord(e)['worktree'])}`));
      return (
        `branch=${str(d['branch'])} head=${shortHash(d['head_commit'])} entries=${entries.length} ` +
        `状态组合=${[...pairs].sort().join(' ')} 隐藏=${num(d['policy_hidden_count'])} ` +
        `limited_to_authorized=${bool(d['limited_to_authorized_paths'])}`
      );
    }
    case 'git_diff': {
      const hunks = Array.isArray(d['hunks']) ? d['hunks'] : [];
      const lines = hunks.reduce((sum, h) => sum + (Array.isArray(asRecord(h)['lines']) ? (asRecord(h)['lines'] as unknown[]).length : 0), 0);
      return (
        `comparison=${str(d['comparison'])} base=${shortHash(d['base_commit'])} hunks=${hunks.length} lines=${lines} ` +
        `old=${shortHash(d['old_sha256'])} new=${shortHash(d['new_sha256'])} binary=${bool(d['binary'])} ` +
        `redacted=${bool(d['redacted'])} truncated=${bool(d['truncated'])}`
      );
    }
    default:
      return `keys=${Object.keys(d).sort().join(',')}`;
  }
}

// ---------------------------------------------------------------------------
// MCP 客户端侧：一次调用 + 它的三种结局
// ---------------------------------------------------------------------------

interface CallOutcome {
  readonly kind: 'ok' | 'error' | 'protocol';
  /** 整个成功信封 `{ok,data,request_id}` —— **输出 schema 校验的对象是它**。 */
  readonly structured: unknown;
  /** 信封里的 `data`。摘要与「取到的是什么」都读这一层。 */
  readonly data: unknown;
  readonly error: BridgeErrorPayload | null;
  readonly request_id: string | null;
  readonly rpc_code: number | null;
  readonly rpc_message: string | null;
}

/**
 * 一次 `tools/call` 的全部结局。
 *
 * 三分类是必要的：业务失败（`isError`）、协议错误（JSON-RPC error）与
 * 成功在验收标准里是三件不同的事，混成「成功/失败」会让
 * 「未授权被报成了协议错误」这种缺陷看不出来。
 */
async function callViaClient(client: Client, name: string, args: Record<string, unknown>): Promise<CallOutcome> {
  const empty: CallOutcome = { kind: 'ok', structured: undefined, data: undefined, error: null, request_id: null, rpc_code: null, rpc_message: null };
  try {
    const raw = (await client.callTool({ name, arguments: args })) as {
      readonly isError?: unknown;
      readonly structuredContent?: unknown;
      readonly content?: readonly { readonly text?: unknown }[];
    };
    if (raw.isError === true) {
      const text = raw.content?.[0]?.text;
      const parsed = typeof text === 'string' ? (JSON.parse(text) as Record<string, unknown>) : {};
      const error = (parsed['error'] ?? null) as BridgeErrorPayload | null;
      // 关联 ID 在 `details` 里（`errorPayload` 把 daemon 的审计主键放在那儿）。
      // 它是「模型看到的拒绝」与「本地审计里那一条记录」对上的唯一凭据。
      const details = asRecord(error?.details);
      return {
        ...empty,
        kind: 'error',
        error,
        request_id: typeof details['request_id'] === 'string' ? details['request_id'] : null,
      };
    }
    return { ...empty, structured: raw.structuredContent, data: asRecord(raw.structuredContent)['data'] };
  } catch (cause) {
    if (cause instanceof McpError) {
      return { ...empty, kind: 'protocol', rpc_code: cause.code, rpc_message: cause.message };
    }
    throw cause;
  }
}

/** daemon 侧的操作表 → 适配器要的窄接口。与生产装配同形（`IpcClient.call`）。 */
function daemonCaller(harness: ToolHarness) {
  return {
    async call(operation: string, input: unknown): Promise<{ ok: true; result: unknown } | { ok: false; code: string; reason: string; outcome_unknown: boolean }> {
      const definition = harness.operations.lookup(operation);
      if (definition === undefined) {
        return { ok: false, code: 'UNKNOWN_OPERATION', reason: `未注册的操作 ${operation}`, outcome_unknown: false };
      }
      const result = await definition.handler(input, harness.adapterContext('req-evidence'));
      return { ok: true, result };
    },
  };
}

interface AdapterUnderTest {
  readonly client: Client;
  readonly logs: string[];
  close(): Promise<void>;
}

async function makeAdapter(caller: { call(operation: string, input: unknown): Promise<unknown> }): Promise<AdapterUnderTest> {
  const logs: string[] = [];
  const server = createAdapterServer({
    caller: caller as Parameters<typeof createAdapterServer>[0]['caller'],
    server_version: '0.1.0-evidence',
    log: (line) => logs.push(line),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'lwb-evidence-client', version: '0.0.0' });
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

// ================================================================
// 1. 装置
// ================================================================

async function fixtures(backend: PowerShellWinfsBackend): Promise<{ harness: ToolHarness; manifest: FixtureManifest }> {
  section('装置：真实护栏 + 真实夹具仓库（不是桩）');
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
  note('夹具根身份（由护栏当场问出）', `volume=${rootInfo.volume_id} file=${rootInfo.file_id} fs=${rootInfo.file_system} drive=${rootInfo.drive_type}`);

  // 探测器也换成真后端：登记时记下的身份、每次调用复核的身份、
  // 护栏打开句柄时核对的身份 —— 三段来自同一个真实来源。
  const harness = await makeToolHarness({
    root: TESTREPO_DIR,
    other_root: CANARY_DIR,
    ops: backend,
    probe: backend,
    gates: GATES_ON,
  });

  const manifest = await loadManifest();
  note('夹具 HEAD', manifest.head_commit);
  note('门禁（本次证据运行）', 'g0/native_guard/section3 全开 —— 见下面的「生产装配」对照');

  return { harness, manifest };
}

// ================================================================
// 2. 验收一：无控制平面方法出现在 tools/list
// ================================================================

async function noControlPlane(harness: ToolHarness): Promise<void> {
  section('验收 1：无控制平面方法出现在 tools/list');

  const catalogEnvelope = await harness.operations.lookup('tools.catalog')!.handler({}, harness.adapterContext('req-catalog'));
  const catalog = asRecord(asRecord(catalogEnvelope)['data']);
  const entries = Array.isArray(catalog['tools']) ? catalog['tools'].map(asRecord) : [];
  const available = entries.filter((e) => e['available'] === true).map((e) => str(e['name']));

  check('daemon 清单覆盖全部 12 个工具名', entries.length === TOOL_NAMES.length, `entries=${entries.length}`);
  check('daemon 清单里有 7 个可用', available.length === IMPLEMENTED_TOOL_NAMES.length, available.join('、'));

  const catalogControlPlane = entries.map((e) => str(e['name'])).filter((n) => (CONTROL_PLANE_ROUTES as readonly string[]).includes(n));
  check('daemon 清单里没有控制面方法', catalogControlPlane.length === 0, `命中 ${catalogControlPlane.length} 条`);

  const adapter = await makeAdapter(daemonCaller(harness));
  try {
    const listed = await adapter.client.listTools();
    const names = listed.tools.map((tool) => tool.name);

    check(
      'MCP tools/list 恰好是七个已实现工具，且顺序与契约一致',
      JSON.stringify(names) === JSON.stringify([...IMPLEMENTED_TOOL_NAMES]),
      names.join('、'),
    );

    const hits = names.filter((n) => (CONTROL_PLANE_ROUTES as readonly string[]).includes(n));
    check('MCP tools/list 里没有控制面方法', hits.length === 0, `逐条核对 ${CONTROL_PLANE_ROUTES.length} 条路由，命中 ${hits.length} 条`);

    // 未实现的能力不能被暗示成可用：`change_*` 既不出现，也不在别的工具的
    // 描述里被承诺。这里按**名字出现**这条可机读的判据来验。
    const descriptions = listed.tools.map((tool) => `${tool.title ?? ''} ${tool.description ?? ''}`).join('\n');
    const promised = CONTROL_PLANE_ROUTES.filter((route) => descriptions.includes(route));
    check('工具描述里没有承诺未实现的控制面调用', promised.length === 0, promised.join('、') || '无');

    // 输入契约在工具面上是否**真的**收窄：未知字段被拒这件事，
    // 客户端靠的是这一行；它被写成 true 才谈得上「被拒绝」。
    const openInputs = listed.tools
      .filter((tool) => (tool.inputSchema as { additionalProperties?: unknown }).additionalProperties !== false)
      .map((tool) => tool.name);
    check('七个工具的输入 schema 都声明 additionalProperties:false', openInputs.length === 0, openInputs.join('、') || '全部收窄');

    const missingOutput = listed.tools.filter((tool) => tool.outputSchema === undefined).map((tool) => tool.name);
    check('七个工具都挂出了 outputSchema', missingOutput.length === 0, missingOutput.join('、') || '全部挂出');

    const writable = listed.tools.filter((tool) => (tool.annotations as { readOnlyHint?: unknown } | undefined)?.readOnlyHint !== true).map((t) => t.name);
    check('七个工具都标注 readOnlyHint:true', writable.length === 0, writable.join('、') || '全部只读');

    for (const line of adapter.logs) note('适配器日志', line);
  } finally {
    await adapter.close();
  }
}

/**
 * 生产装配的对照：门禁全关时清单**恰好两条**。
 *
 * 这一段存在的理由：上面的证据是在门禁开启的装置上采的，而**生产装配
 * 此刻门禁全关**（ADR-003 §5.1）。不把这两件事同时摆出来的话，读到
 * 「七个工具都可用」的人会以为本机现在就能用。
 */
async function productionCatalog(backend: PowerShellWinfsBackend): Promise<void> {
  section('生产装配对照：门禁全关时清单恰好两条');
  const harness = await makeToolHarness({
    root: TESTREPO_DIR,
    other_root: CANARY_DIR,
    ops: backend,
    probe: backend,
    gates: GATES_OFF,
  });
  try {
    const adapter = await makeAdapter(daemonCaller(harness));
    try {
      const listed = await adapter.client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      check(
        '门禁全关 ⇒ tools/list 只有 bridge_status 与 workspace_list',
        JSON.stringify(names) === JSON.stringify(['bridge_status', 'workspace_list']),
        names.join('、'),
      );
      check(
        '读取/Git 工具一个都没挂出（能力开关默认全关）',
        !names.some((n) => ['file_list', 'file_read', 'text_search', 'git_status', 'git_diff'].includes(n)),
      );

      // 清单之外还要看**自称**：`bridge_status` 是本机对模型说明自己能力的
      // 那一句，它在生产装配下必须说「写没开、读没开」。
      const status = await callViaClient(adapter.client, 'bridge_status', {});
      const caps = asRecord(asRecord(status.data)['capabilities']);
      check(
        '门禁全关 ⇒ bridge_status 自述四个能力开关全 false',
        caps['read_enabled'] === false &&
          caps['git_enabled'] === false &&
          caps['proposal_enabled'] === false &&
          caps['direct_write_enabled'] === false,
        digestOf('bridge_status', status.data),
      );
    } finally {
      await adapter.close();
    }
  } finally {
    harness.close();
  }
}

// ================================================================
// 3. 验收二：工具结果符合 schema；未知字段 / 无效枚举被拒绝
// ================================================================

interface ToolProbe {
  /** 只可能是**已实现**的工具：`TOOL_OUTPUT_SCHEMAS` 是按这一组键控的。 */
  readonly name: ImplementedToolName;
  readonly args: (h: ToolHarness) => Record<string, unknown>;
}

const TOOL_PROBES: readonly ToolProbe[] = [
  { name: 'bridge_status', args: () => ({}) },
  { name: 'workspace_list', args: () => ({}) },
  { name: 'file_list', args: (h) => ({ workspace_id: h.workspace.id, path: 'newline', depth: 0 }) },
  { name: 'text_search', args: (h) => ({ workspace_id: h.workspace.id, query: 'LWB_ANCHOR_TOKEN' }) },
  { name: 'file_read', args: (h) => ({ workspace_id: h.workspace.id, path: 'newline/lf.txt' }) },
  { name: 'git_status', args: (h) => ({ workspace_id: h.workspace.id }) },
  { name: 'git_diff', args: (h) => ({ workspace_id: h.workspace.id, path: '文档/设计说明.md', comparison: 'head_vs_worktree' }) },
];

async function schemaConformance(harness: ToolHarness, manifest: FixtureManifest): Promise<void> {
  section('验收 2a：七个工具的结果符合 schema（裁判是 MCP 客户端）');
  const adapter = await makeAdapter(daemonCaller(harness));
  try {
    for (const probe of TOOL_PROBES) {
      const outcome = await callViaClient(adapter.client, probe.name, probe.args(harness));
      if (outcome.kind !== 'ok') {
        check(`${probe.name} 返回成功结果`, false, `kind=${outcome.kind} code=${outcome.error?.code ?? outcome.rpc_code} ${outcome.error?.message ?? outcome.rpc_message ?? ''}`);
        continue;
      }
      // 客户端侧的校验已经在 `callTool` 里发生过（不符会抛 InvalidParams）；
      // 这里再用同一份 schema 直接判一次，是为了让「符合」这件事**可打印**。
      const parsed = TOOL_OUTPUT_SCHEMAS[probe.name].safeParse(outcome.structured);
      check(`${probe.name} 结果符合输出 schema`, parsed.success, digestOf(probe.name, outcome.data));
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        console.log(`      ${first?.code ?? 'INVALID'} @ ${first?.path.join('.') ?? ''}`);
      }
    }

    // 「符合 schema」不能只看形状：`file_read` 的哈希必须等于夹具清单里
    // 生成的期望值 —— 否则一个形状正确、内容错误的工具面也能通过上面那段。
    const read = await callViaClient(adapter.client, 'file_read', { workspace_id: harness.workspace.id, path: 'newline/lf.txt' });
    const data = asRecord(read.data);
    check(
      'file_read 的 sha256 等于夹具清单的期望值',
      data['sha256'] === findFile(manifest, 'newline/lf.txt').sha256,
      `${shortHash(data['sha256'])} vs 清单 ${shortHash(findFile(manifest, 'newline/lf.txt').sha256)}`,
    );
  } finally {
    await adapter.close();
  }
}

async function argumentRejection(harness: ToolHarness): Promise<void> {
  section('验收 2b：未知字段、身份字段、无效枚举一律被拒绝');
  const adapter = await makeAdapter(daemonCaller(harness));
  const ws = harness.workspace.id;

  interface Negative {
    readonly hint: string;
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly expect_field: string | null;
  }

  const negatives: readonly Negative[] = [
    {
      hint: '未知字段',
      tool: 'file_read',
      args: { workspace_id: ws, path: 'newline/lf.txt', verbose: true },
      expect_field: 'verbose',
    },
    {
      hint: '未知字段（顶层多一个键）',
      tool: 'git_status',
      args: { workspace_id: ws, recursive: true },
      expect_field: 'recursive',
    },
    {
      hint: '身份字段 approved',
      tool: 'file_read',
      args: { workspace_id: ws, path: 'newline/lf.txt', approved: true },
      expect_field: 'approved',
    },
    {
      hint: '身份字段 user_id / session_id / conversation_label',
      tool: 'file_read',
      args: { workspace_id: ws, path: 'newline/lf.txt', user_id: 'u-1', session_id: 's-1', conversation_label: '某次对话' },
      expect_field: null,
    },
    {
      hint: '无效枚举',
      tool: 'git_diff',
      args: { workspace_id: ws, path: 'README.md', comparison: 'head_vs_head' },
      expect_field: 'comparison',
    },
    {
      hint: '类型不符',
      tool: 'file_read',
      args: { workspace_id: ws, path: 'newline/lf.txt', start_line: '1' },
      expect_field: 'start_line',
    },
    {
      hint: '越界数值',
      tool: 'file_list',
      args: { workspace_id: ws, path: 'newline', depth: 99 },
      expect_field: 'depth',
    },
  ];

  try {
    for (const negative of negatives) {
      const outcome = await callViaClient(adapter.client, negative.tool, negative.args);
      if (outcome.kind !== 'error' || outcome.error === null) {
        check(`${negative.hint} 被拒绝`, false, `kind=${outcome.kind} code=${outcome.error?.code ?? outcome.rpc_code}`);
        continue;
      }
      const details = asRecord(outcome.error.details);
      const fieldOk = negative.expect_field === null || details['field'] === negative.expect_field;
      check(
        `${negative.hint} ⇒ INVALID_ARGUMENT`,
        outcome.error.code === 'INVALID_ARGUMENT' && details['reason'] === 'INPUT_SCHEMA_VIOLATION' && fieldOk,
        `code=${outcome.error.code} reason=${str(details['reason'])} field=${str(details['field'])}`,
      );
    }

    // 上面那些字段**一个都不许**参与授权判断：把 `approved: true` 加进一个
    // 本来会被拒绝的调用，被拒绝的仍然是同一件事（工作区没被授权），
    // 而不是「因为它说 approved 就放行」。
    const forged = await callViaClient(adapter.client, 'file_read', {
      workspace_id: harness.otherWorkspace.id,
      path: 'README.md',
      approved: true,
    });
    check(
      '伪造的身份字段不会改变授权结论',
      forged.kind === 'error' && forged.error?.code === 'INVALID_ARGUMENT',
      `code=${forged.error?.code ?? forged.rpc_code}`,
    );
  } finally {
    await adapter.close();
  }
}

async function failureEnvelope(harness: ToolHarness): Promise<void> {
  section('验收 2c：失败是工具结果，且错误码说实话');
  const adapter = await makeAdapter(daemonCaller(harness));

  interface FailureCase {
    readonly hint: string;
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly expect: string;
    readonly expect_detail?: readonly [string, string];
  }

  const cases: readonly FailureCase[] = [
    {
      hint: '硬拒绝文件（.env）',
      tool: 'file_read',
      args: { workspace_id: harness.workspace.id, path: 'secrets/.env' },
      expect: 'POLICY_DENIED',
      expect_detail: ['hard_deny_rule', 'HD-ENV'],
    },
    {
      hint: '硬拒绝文件（id_rsa）',
      tool: 'file_read',
      args: { workspace_id: harness.workspace.id, path: 'secrets/id_rsa' },
      expect: 'POLICY_DENIED',
    },
    {
      hint: '未授权工作区',
      tool: 'file_read',
      args: { workspace_id: harness.otherWorkspace.id, path: 'canary.txt' },
      expect: 'WORKSPACE_NOT_GRANTED',
    },
    {
      hint: '不存在的相对路径',
      tool: 'file_read',
      args: { workspace_id: harness.workspace.id, path: 'newline/有吗.txt' },
      expect: 'NOT_FOUND',
    },
    {
      hint: '逃逸路径',
      tool: 'file_read',
      args: { workspace_id: harness.workspace.id, path: '../../package.json' },
      expect: 'PATH_UNSAFE',
    },
    {
      hint: '未实现的工具',
      tool: 'change_apply',
      args: {},
      expect: 'UNSUPPORTED_OPERATION',
    },
  ];

  try {
    for (const item of cases) {
      const outcome = await callViaClient(adapter.client, item.tool, item.args);
      if (outcome.kind !== 'error' || outcome.error === null) {
        check(`${item.hint} ⇒ ${item.expect}`, false, `kind=${outcome.kind} code=${outcome.error?.code ?? outcome.rpc_code}`);
        continue;
      }
      const detailOk =
        item.expect_detail === undefined || asRecord(outcome.error.details)[item.expect_detail[0]] === item.expect_detail[1];
      const correlation = outcome.request_id !== null || outcome.error.code === 'UNSUPPORTED_OPERATION';
      check(
        `${item.hint} ⇒ ${item.expect}`,
        outcome.error.code === item.expect && detailOk && correlation,
        `code=${outcome.error.code} request_id=${outcome.request_id ?? '(适配器本地)'} details=${JSON.stringify(outcome.error.details ?? {})}`,
      );
      // 模型看到的失败载荷本身也要符合契约：`code` 是一个已知错误码、
      // `category` / `auto_retry` 是枚举里的取值。自由字符串的错误码会让
      // 模型照着它去决定下一步，而那个字符串没有任何东西保证过。
      const payloadOk = BRIDGE_ERROR_PAYLOAD.safeParse(outcome.error).success;
      check(
        `${item.hint} 的载荷符合失败契约`,
        payloadOk,
        `category=${outcome.error.category} auto_retry=${outcome.error.auto_retry} details=${JSON.stringify(outcome.error.details ?? {})}`,
      );
    }

    // **判别顺序是有作用的**：拿成功 schema 去套同一份失败信封必须失败，
    // 否则 `toCallToolResult` 里「先认失败信封」那一步只是个恒真的分支，
    // 而它实际修掉的缺陷是「每一次业务失败都被折成 INTERNAL_ERROR」。
    const denied = await harness.operations.lookup('file_read')!.handler(
      { workspace_id: harness.workspace.id, path: 'secrets/.env' },
      harness.adapterContext('req-order'),
    );
    const deniedData = asRecord(denied);
    const asSuccess = TOOL_OUTPUT_SCHEMAS.file_read.safeParse(denied);
    check('失败信封确实不符合成功 schema', deniedData['ok'] === false && !asSuccess.success, `ok=${bool(deniedData['ok'])} 成功 schema 判定=${asSuccess.success}`);
    const orderOutcome = await callViaClient(adapter.client, 'file_read', { workspace_id: harness.workspace.id, path: 'secrets/.env' });
    check(
      '同一条失败经适配器后仍然是 POLICY_DENIED（不是 INTERNAL_ERROR）',
      orderOutcome.error?.code === 'POLICY_DENIED',
      `code=${orderOutcome.error?.code}`,
    );
  } finally {
    await adapter.close();
  }
}

async function crossConnectionIsolation(harness: ToolHarness, manifest: FixtureManifest): Promise<void> {
  section('验收 3：两条配置不同的连接不能读取对方工作区');
  const adapter = await makeAdapter(daemonCaller(harness));
  const mine = harness.workspace.id;
  const theirs = harness.otherWorkspace.id;

  try {
    // 正向先跑：只有「自己读得到」成立，「读不到对方的」才说明是隔离而不是空转。
    const ownRead = await callViaClient(adapter.client, 'file_read', { workspace_id: mine, path: 'newline/lf.txt' });
    const ownList = await callViaClient(adapter.client, 'file_list', { workspace_id: mine, path: 'src' });
    check('适配器连接读得到自己工作区的文件', ownRead.kind === 'ok', digestOf('file_read', ownRead.data));
    check('适配器连接列得到自己工作区的目录', ownList.kind === 'ok', digestOf('file_list', ownList.data));

    // 这两句是「下面那些拒绝不是空转」的另一半：读得到、且读到的**就是**
    // 期望的字节（sha256 来自夹具清单）。
    const ownBytes = asRecord(ownRead.data);
    check(
      '读到的内容与夹具清单一致',
      ownBytes['sha256'] === findFile(manifest, 'newline/lf.txt').sha256,
      shortHash(ownBytes['sha256']),
    );

    const otherHarnessRead = await harness.operations.lookup('file_read')!.handler(
      { workspace_id: theirs, path: 'canary.txt' },
      harness.contextFor('conn-other', 'req-other'),
    );
    const otherEnvelope = asRecord(otherHarnessRead);
    check(
      '另一条连接读得到它自己的工作区（因此下面的拒绝不是空转）',
      otherEnvelope['ok'] === true,
      `ok=${bool(otherEnvelope['ok'])}${otherEnvelope['ok'] === true ? '' : ` code=${str(asRecord(otherEnvelope['error'])['code'])}`}`,
    );

    const probes: readonly { tool: string; args: (ws: string) => Record<string, unknown> }[] = [
      { tool: 'file_read', args: (ws) => ({ workspace_id: ws, path: 'canary.txt' }) },
      { tool: 'file_list', args: (ws) => ({ workspace_id: ws, path: '' }) },
      { tool: 'text_search', args: (ws) => ({ workspace_id: ws, query: 'canary' }) },
      { tool: 'git_status', args: (ws) => ({ workspace_id: ws }) },
    ];

    for (const probe of probes) {
      const borrowed = await callViaClient(adapter.client, probe.tool, probe.args(theirs));
      check(
        `${probe.tool}：适配器连接读不到对方工作区`,
        borrowed.kind === 'error' && borrowed.error?.code === 'WORKSPACE_NOT_GRANTED',
        `code=${borrowed.error?.code ?? borrowed.rpc_code}`,
      );
    }

    // 反向：另一条连接读适配器的工作区。这一句必须走 daemon 的**另一条
    // 连接上下文**（适配器进程手上根本没有那把凭证，它也只能以自己
    // 那条连接说话）—— 单向的隔离可能只是「有一条连接恰好没被授权」。
    const reverseEnvelope = asRecord(
      await harness.operations.lookup('file_read')!.handler(
        { workspace_id: mine, path: 'README.md' },
        harness.contextFor('conn-other', 'req-reverse'),
      ),
    );
    const reverseError = asRecord(reverseEnvelope['error']);
    check(
      '反向（另一条连接读适配器工作区）同样被拒',
      reverseEnvelope['ok'] === false && str(reverseError['code']) === 'WORKSPACE_NOT_GRANTED',
      `code=${str(reverseError['code'])}`,
    );

    // 被拒的调用不得返回任何内容。
    const deniedRead = await callViaClient(adapter.client, 'file_read', { workspace_id: theirs, path: 'canary.txt' });
    check('被拒绝的读取不返回任何文件内容', deniedRead.structured === undefined, `structuredContent=${deniedRead.structured === undefined ? '缺席' : '存在'}`);
  } finally {
    await adapter.close();
  }
}

// ================================================================
// 4. 进程级链路：真进程 + 真命名管道 + 真 MCP 客户端
// ================================================================

interface PipeServer {
  readonly pipeName: string;
  readonly events: unknown[];
  close(): Promise<void>;
}

const openServers: Server[] = [];

async function startPipeServer(harness: ToolHarness, pipeName: string): Promise<PipeServer> {
  const events: unknown[] = [];
  const server = createServer((socket) => {
    attachSocket(socket, {
      secrets: { 'mcp-adapter': ADAPTER_SECRET, console: CONSOLE_SECRET },
      operations: harness.operations,
      isRegisteredConnection: (id) => id === ADAPTER_CONNECTION,
      onEvent: (event) => events.push(event),
    });
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(pipeName, () => resolve()));
  return {
    pipeName,
    events,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function processChain(harness: ToolHarness, manifest: FixtureManifest): Promise<void> {
  section('进程级链路：真客户端 ←stdio→ 真适配器进程 ←命名管道→ 真 IPC 服务端 → 真护栏');
  const pipeName = `\\\\.\\pipe\\lwb-evidence-017-${process.pid}-${Date.now()}`;
  const pipe = await startPipeServer(harness, pipeName);
  const stderrChunks: string[] = [];
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;

  try {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', ADAPTER_ENTRY],
      cwd: REPO_ROOT,
      env: {
        [PIPE_NAME_ENV]: pipeName,
        [SECRET_ENV]: ADAPTER_SECRET,
        [CONNECTION_ID_ENV]: ADAPTER_CONNECTION,
        [VERSION_ENV]: '0.1.0-evidence',
      },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString('utf8')));
    client = new Client({ name: 'lwb-evidence-e2e', version: '0.0.0' });
    await client.connect(transport);

    const handshake = pipe.events.some((event) => asRecord(event)['type'] === 'handshake_ok' && asRecord(event)['audience'] === 'mcp-adapter');
    check('适配器与 daemon 完成握手', handshake, `事件数=${pipe.events.length}`);

    const listed = await client.listTools();
    check(
      '跨进程的 tools/list 与进程内一致',
      JSON.stringify(listed.tools.map((t) => t.name)) === JSON.stringify([...IMPLEMENTED_TOOL_NAMES]),
      listed.tools.map((t) => t.name).join('、'),
    );

    const read = await callViaClient(client, 'file_read', { workspace_id: harness.workspace.id, path: 'newline/lf.txt' });
    const readData = asRecord(read.data);
    check(
      '跨进程读取的字节与夹具清单一致',
      read.kind === 'ok' && readData['sha256'] === findFile(manifest, 'newline/lf.txt').sha256,
      digestOf('file_read', read.data),
    );

    const denied = await callViaClient(client, 'file_read', { workspace_id: harness.workspace.id, path: 'secrets/.env' });
    check('跨进程的硬拒绝仍是 POLICY_DENIED', denied.error?.code === 'POLICY_DENIED', `code=${denied.error?.code}`);

    // stdout 上只有协议消息这件事，由「客户端一路解析到最后一条」证明：
    // 进程往 stdout 写过任何别的东西，上面每一次调用就已经解析失败了。
    const alive = await client.ping();
    check('协议流干净（客户端还能解析下一条消息）', JSON.stringify(alive) === '{}');

    const stderr = stderrChunks.join('');
    check('适配器日志不含凭证', !stderr.includes(ADAPTER_SECRET), `${stderr.trim().split('\n').length} 行 stderr`);
    for (const line of stderr.trim().split('\n')) note('适配器 stderr', line.trim());
  } finally {
    await client?.close().catch(() => undefined);
    await pipe.close();
  }
}

/** 注定退出的启动路径：配置缺失与 daemon 不可达都必须非零退出、stdout 不写脏。 */
async function startupFailures(): Promise<void> {
  section('启动失败：说清哪一步失败，且不写脏 stdout');

  interface Case {
    readonly hint: string;
    readonly env: Record<string, string | undefined>;
    readonly expect_code: number;
    readonly expect_text: string;
  }

  const cases: readonly Case[] = [
    {
      hint: '缺 LWB_CONNECTION_ID',
      env: { [PIPE_NAME_ENV]: '\\\\.\\pipe\\lwb-evidence-never', [SECRET_ENV]: ADAPTER_SECRET },
      expect_code: 2,
      expect_text: CONNECTION_ID_ENV,
    },
    {
      hint: 'daemon 不可达',
      env: {
        [PIPE_NAME_ENV]: `\\\\.\\pipe\\lwb-evidence-missing-${process.pid}`,
        [SECRET_ENV]: ADAPTER_SECRET,
        [CONNECTION_ID_ENV]: ADAPTER_CONNECTION,
      },
      expect_code: 1,
      expect_text: '无法连接本地 daemon',
    },
  ];

  for (const item of cases) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if ([PIPE_NAME_ENV, SECRET_ENV, CONNECTION_ID_ENV, VERSION_ENV].includes(key)) continue;
      env[key] = value;
    }
    for (const [key, value] of Object.entries(item.env)) if (value !== undefined) env[key] = value;

    const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', ADAPTER_ENTRY], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

    check(
      `${item.hint} ⇒ 退出码 ${item.expect_code}`,
      outcome.code === item.expect_code,
      `实际 ${outcome.code}；stderr 首行：${outcome.stderr.trim().split('\n')[0] ?? ''}`,
    );
    check(`${item.hint} ⇒ stdout 为空`, outcome.stdout === '', `stdout 长度=${outcome.stdout.length}`);
    check(`${item.hint} ⇒ stderr 指出原因`, outcome.stderr.includes(item.expect_text), item.expect_text);
    check(`${item.hint} ⇒ stderr 不回显凭证`, !outcome.stderr.includes(ADAPTER_SECRET));
  }
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
    const built = await fixtures(backend);
    harness = built.harness;

    await guarded('验收 1', async () => {
      await noControlPlane(built.harness);
    });
    await guarded('生产装配对照', async () => {
      await productionCatalog(backend);
    });
    await guarded('验收 2a', async () => {
      await schemaConformance(built.harness, built.manifest);
    });
    await guarded('验收 2b', async () => {
      await argumentRejection(built.harness);
    });
    await guarded('验收 2c', async () => {
      await failureEnvelope(built.harness);
    });
    await guarded('验收 3', async () => {
      await crossConnectionIsolation(built.harness, built.manifest);
    });
    await guarded('进程级链路', async () => {
      await processChain(built.harness, built.manifest);
    });
    await guarded('启动失败', async () => {
      await startupFailures();
    });
  } finally {
    for (const server of openServers) server.close();
    harness?.close();
    await backend.dispose().catch(() => undefined);
  }

  section('未执行项（不得记为通过）');
  skip(
    'ChatGPT 网页端发现并调用这些工具',
    'LWB-002 BLOCKED：需要真实 ChatGPT 账号与 Secure MCP Tunnel 凭证；本机没有。MCP Inspector 的成功不能替代它',
  );
  skip('MCP Inspector 手工验证（工具选择、失败结果、版本协商、元数据刷新）', '未执行：本轮证据只到「真 MCP 客户端 + 真进程 + 真管道」这一层');
  skip('Secure MCP Tunnel 的端到端链路', 'LWB-002 BLOCKED：无隧道凭证');
  skip('两条**配置不同**的连接在生产装配下的隔离', '生产装配门禁全关，读取类工具一个都不挂出；本轮隔离证据采自门禁开启的装置');

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
