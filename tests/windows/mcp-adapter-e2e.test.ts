/**
 * 适配器进程的端到端测试（LWB-017 步骤 3、4）。
 *
 * ## 这条链路每一环都是真的
 *
 * ```
 * 真 MCP 客户端 ──stdio──▶ 真适配器进程 ──真命名管道──▶ 真 IPC 服务端 ──▶ 真工具处理器
 * ```
 *
 * 进程是 `node --import tsx` 拉起来的；传输是 MCP 的 stdio（因此「stdout 上
 * 只有协议消息」这句话在这里被一个真客户端**解析过** —— 多写一行就会解析失败）；
 * 管道是 Windows 命名管道，握手与能力表由 `attachSocket` 完成；
 * 工具处理器跑在夹具仓库上。
 *
 * `tests/unit/mcp-adapter.test.ts` 用内存传输测同一批判断的**逻辑**，
 * 这里测的是它们**接起来之后**仍然成立。
 *
 * ## 这一组用例仍然不证明的事
 *
 * ChatGPT 网页端能发现并调用这些工具 —— 那需要真实账号与 Secure MCP Tunnel
 * 凭证，当前 BLOCKED。MCP Inspector 的成功也不能替代它。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { IMPLEMENTED_TOOL_NAMES } from '@lwb/contracts';
import type { BridgeErrorPayload } from '@lwb/contracts';
import { attachSocket, type OperationRegistry } from '@lwb/ipc';

import { CONNECTION_ID_ENV, SECRET_ENV, PIPE_NAME_ENV, VERSION_ENV } from '../../apps/mcp-adapter/src/config.ts';
import { ensureFixtures, findFile, loadManifest, TESTREPO_DIR, type FixtureManifest } from '../fixtures/index.ts';
import { fileIdOf, makeFixtureOps } from '../tools/fixture-ops.ts';
import { ADAPTER_CONNECTION, GATES_ON, makeToolHarness, type ToolHarness } from '../tools/harness.ts';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;

ensureFixtures();

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const ADAPTER_ENTRY = path.join('apps', 'mcp-adapter', 'src', 'main.ts');

/** 与测试里用的一致：两个 audience 各一把，且**互不相同**（`assertAudienceSecretsDistinct`）。 */
const ADAPTER_SECRET = 'adapter-secret-for-e2e-0123456789';
const CONSOLE_SECRET = 'console-secret-for-e2e-0123456789';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

let pipeCounter = 0;
/** 每个用例一条独立管道名：并行执行时互相占用的失败长得像被测代码的问题。 */
function uniquePipeName(): string {
  pipeCounter += 1;
  return `\\\\.\\pipe\\lwb-adapter-e2e-${process.pid}-${pipeCounter}-${Date.now()}`;
}

/**
 * 适配器进程的环境变量。
 *
 * 先**清掉**继承来的四个变量再叠加：从上一层的 shell 里漏进来一个
 * `LWB_IPC_PIPE`，会让「配置缺失」这类用例静默变成另一个用例 ——
 * 而那种失败看起来像被测代码没报错。
 */
function adapterEnv(overrides: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if ([PIPE_NAME_ENV, SECRET_ENV, CONNECTION_ID_ENV, VERSION_ENV].includes(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface ProcessOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** 起一个适配器进程，等它自己退出。只用于**注定退出**的用例。 */
async function runAdapterToExit(overrides: Record<string, string | undefined>): Promise<ProcessOutcome> {
  return await new Promise<ProcessOutcome>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ADAPTER_ENTRY], {
      cwd: REPO_ROOT,
      env: adapterEnv(overrides),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

interface PipeServer {
  readonly pipeName: string;
  readonly events: unknown[];
  close(): Promise<void>;
}

const openServers: Server[] = [];
after(() => {
  for (const server of openServers) server.close();
});

/** 真的命名管道 + 真的握手 + 工具面的操作表。 */
async function startPipeServer(operations: OperationRegistry): Promise<PipeServer> {
  const pipeName = uniquePipeName();
  const events: unknown[] = [];

  const server = createServer((socket) => {
    attachSocket(socket, {
      secrets: { 'mcp-adapter': ADAPTER_SECRET, console: CONSOLE_SECRET },
      operations,
      // 只有这一条连接被登记过；别的一律在握手阶段被拒。
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

/** 从工具结果里取出失败载荷；顺带钉住「失败结果不带 structuredContent」。 */
function failureOf(result: unknown): BridgeErrorPayload {
  const envelope = result as {
    readonly isError?: unknown;
    readonly structuredContent?: unknown;
    readonly content?: readonly { readonly type?: unknown; readonly text?: unknown }[];
  };
  assert.equal(envelope.isError, true, '应当是一个失败结果');
  assert.equal(envelope.structuredContent, undefined, '失败结果不得带 structuredContent');
  const first = envelope.content?.[0];
  assert.ok(first !== undefined && first.type === 'text' && typeof first.text === 'string');
  const parsed = JSON.parse(first.text) as { readonly ok?: unknown; readonly error?: BridgeErrorPayload };
  assert.equal(parsed.ok, false);
  assert.ok(parsed.error !== undefined);
  return parsed.error;
}

function structuredOf<T>(result: unknown): { readonly ok: true; readonly data: T; readonly request_id: string } {
  const envelope = result as {
    readonly isError?: unknown;
    readonly structuredContent?: { readonly ok: true; readonly data: T; readonly request_id: string };
  };
  assert.notEqual(envelope.isError, true, '应当是一个成功结果');
  assert.ok(envelope.structuredContent !== undefined, '成功结果必须带 structuredContent');
  return envelope.structuredContent;
}

// ================================================================
// 启动失败：说清楚是哪一步失败，且不写脏 stdout
// ================================================================

describeWindows('适配器进程启动失败（不接触 daemon）', () => {
  it('配置缺失：退出码 2，stdout 为空，stderr 只说缺哪个变量', async () => {
    const outcome = await runAdapterToExit({
      [PIPE_NAME_ENV]: '\\\\.\\pipe\\lwb-never-used',
      // 刻意不给 CONNECTION_ID_ENV。
      [SECRET_ENV]: ADAPTER_SECRET,
    });

    assert.equal(outcome.code, 2, `实际 stderr：${outcome.stderr}`);
    // stdout 是协议流：启动失败**一个字节都不能写**，否则客户端读到的
    // 是「协议损坏」而不是「适配器没起来」。
    assert.equal(outcome.stdout, '', '启动失败时 stdout 必须是空的');
    assert.ok(outcome.stderr.includes(CONNECTION_ID_ENV), 'stderr 应当指出缺的是哪个变量');
    assert.ok(!outcome.stderr.includes(ADAPTER_SECRET), 'stderr 不得回显凭证');
  });

  it('daemon 不可达：退出码 1（不是挂在那里把失败摊薄到每次调用）', async () => {
    const outcome = await runAdapterToExit({
      [PIPE_NAME_ENV]: uniquePipeName(),
      [SECRET_ENV]: ADAPTER_SECRET,
      [CONNECTION_ID_ENV]: ADAPTER_CONNECTION,
    });

    assert.equal(outcome.code, 1, `实际 stderr：${outcome.stderr}`);
    assert.equal(outcome.stdout, '', '启动失败时 stdout 必须是空的');
    assert.ok(outcome.stderr.includes('无法连接本地 daemon'), `实际 stderr：${outcome.stderr}`);
    // 连接失败的诊断里给形状（含长度），不给凭证本身。
    assert.ok(!outcome.stderr.includes(ADAPTER_SECRET), 'stderr 不得回显凭证');
    assert.ok(outcome.stderr.includes(`"secret_length":${ADAPTER_SECRET.length}`), '应当只说长度');
  });

  it('连接未登记：握手被拒，仍然是非零退出', async () => {
    const harness = await makeToolHarness({ ops: makeFixtureOps(), root: TESTREPO_DIR, root_file_id: fileIdOf(TESTREPO_DIR), gates: GATES_ON });
    const pipe = await startPipeServer(harness.operations);
    try {
      const outcome = await runAdapterToExit({
        [PIPE_NAME_ENV]: pipe.pipeName,
        [SECRET_ENV]: ADAPTER_SECRET,
        [CONNECTION_ID_ENV]: 'conn-从未登记',
      });
      assert.equal(outcome.code, 1, `实际 stderr：${outcome.stderr}`);
      assert.ok(outcome.stderr.includes('IpcHandshakeError'), `实际 stderr：${outcome.stderr}`);
      assert.ok(
        pipe.events.some((event) => (event as { type?: unknown }).type === 'handshake_failed'),
        '服务端应当记下一次握手失败',
      );
    } finally {
      await pipe.close();
      harness.close();
    }
  });
});

// ================================================================
// 端到端：真客户端 ←stdio→ 真适配器 ←命名管道→ 真 daemon 操作表
// ================================================================

describeWindows('端到端（真进程 + 真命名管道 + 夹具仓库）', () => {
  let harness!: ToolHarness;
  let pipe!: PipeServer;
  let manifest!: FixtureManifest;
  let client!: Client;
  let transport!: StdioClientTransport;
  const stderrChunks: string[] = [];

  before(async () => {
    harness = await makeToolHarness({
      root: TESTREPO_DIR,
      root_file_id: fileIdOf(TESTREPO_DIR),
      ops: makeFixtureOps(),
      gates: GATES_ON,
    });
    manifest = await loadManifest();
    pipe = await startPipeServer(harness.operations);

    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', ADAPTER_ENTRY],
      cwd: REPO_ROOT,
      env: {
        [PIPE_NAME_ENV]: pipe.pipeName,
        [SECRET_ENV]: ADAPTER_SECRET,
        [CONNECTION_ID_ENV]: ADAPTER_CONNECTION,
        [VERSION_ENV]: '0.1.0-e2e',
      },
      // 本地日志（stderr）要能在断言里看，因此接管而不是继承。
      stderr: 'pipe',
    });
    const stderr = transport.stderr;
    stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString('utf8')));

    client = new Client({ name: 'lwb-e2e-client', version: '0.0.1' });
    await client.connect(transport);
  });

  after(async () => {
    await client.close().catch(() => undefined);
    await pipe.close();
    harness.close();
  });

  it('握手成功，且适配器日志说明它连上了哪条管道（不含凭证）', async () => {
    assert.ok(
      pipe.events.some(
        (event) =>
          (event as { type?: unknown; audience?: unknown }).type === 'handshake_ok' &&
          (event as { audience?: unknown }).audience === 'mcp-adapter',
      ),
      '服务端应当记下 mcp-adapter 的握手成功',
    );

    const stderr = stderrChunks.join('');
    assert.ok(stderr.includes('适配器已就绪'), `实际 stderr：${stderr}`);
    assert.ok(!stderr.includes(ADAPTER_SECRET), 'stderr 不得出现凭证');
  });

  it('tools/list：七个工具，一个控制面方法都没有', async () => {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      [...IMPLEMENTED_TOOL_NAMES],
    );
  });

  it('file_read：跨进程读到的字节与夹具清单一致', async () => {
    const expected = findFile(manifest, 'newline/lf.txt');
    const result = await client.callTool({
      name: 'file_read',
      arguments: { workspace_id: harness.workspace.id, path: 'newline/lf.txt' },
    });
    const envelope = structuredOf<{ sha256: string; content: string; editable: boolean; path: string }>(result);

    assert.equal(envelope.data.path, 'newline/lf.txt');
    assert.equal(envelope.data.sha256, expected.sha256, '整个文件的哈希必须与清单一致');
    assert.equal(envelope.data.editable, expected.editable);
    assert.ok(envelope.data.content.length > 0);
  });

  it('硬拒绝文件：跨进程读 .env 也是 POLICY_DENIED，理由是可机读的规则名', async () => {
    const result = await client.callTool({
      name: 'file_read',
      arguments: { workspace_id: harness.workspace.id, path: 'secrets/.env' },
    });
    const error = failureOf(result);
    assert.equal(error.code, 'POLICY_DENIED');
    assert.equal((error.details as Record<string, unknown> | undefined)?.['hard_deny_rule'], 'HD-ENV');
  });

  it('两条配置不同的连接仍然读不到对方的工作区（这一条跨了进程）', async () => {
    const result = await client.callTool({
      name: 'file_read',
      arguments: { workspace_id: harness.otherWorkspace.id, path: 'README.md' },
    });
    const error = failureOf(result);
    assert.equal(error.code, 'WORKSPACE_NOT_GRANTED');
  });

  it('未知工具名：协议错误，不是工具结果', async () => {
    await assert.rejects(
      () => client.callTool({ name: 'file_transfer', arguments: {} }),
      (cause: unknown) => cause instanceof McpError && cause.code === ErrorCode.InvalidParams,
    );
  });

  it('协议流上只有协议消息：客户端能一直解析到最后一条', async () => {
    // 这条断言的强度来自它**已经发生**：`connect` 时的 initialize、
    // 上面每一次 listTools / callTool 都是 stdout 上的帧。若进程往 stdout
    // 写过任何别的东西，SDK 的解析器会在那一次就报错。
    const stillAlive = await client.ping();
    assert.deepEqual(stillAlive, {});
  });
});
