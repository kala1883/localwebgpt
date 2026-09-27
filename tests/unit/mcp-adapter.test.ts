/**
 * MCP 适配器验收（LWB-017 步骤 3、4）。
 *
 * ## 用真的 MCP 客户端说话，不直接调处理函数
 *
 * 这里每一句都是通过 `new Client()` + `InMemoryTransport` 与服务端对话完成的。
 * 理由是「工具结果符合 schema」这句话的裁判是**客户端**：SDK 的
 * `Client.callTool` 会拿 `tools/list` 里那份 `outputSchema`
 * （由 zod 转换成的 JSON Schema）去校验 `structuredContent`。
 * 自己调处理函数就只是自己检查自己。
 *
 * 传输是进程内的，因此**不覆盖** stdio 协议流、命名管道与握手 ——
 * 那些在 `tests/windows/mcp-adapter-e2e.test.ts`。
 *
 * ## 两种 caller
 *
 *  - **真的 daemon 操作表**（`daemonCaller`）：正向用例。结果由被测的
 *    daemon 处理器产生，而不是手写的期望值 —— 手写的那份只能证明
 *    「我写的东西符合我理解的 schema」。
 *  - **脚本化的假 caller**（`ScriptedCaller`）：负向用例。IPC 的每一种失败、
 *    清单被本机拒绝、结果形状不符 —— 这些在真 daemon 上要么造不出来
 *    （处理器不抛异常），要么得改造被测进程。
 *
 * ## 这一组用例不证明的事
 *
 *  - **不证明 stdio 上只有协议消息**：那要真的起进程。
 *  - **不证明 ChatGPT 网页端能发现并调用这些工具**：需要真实账号，当前 BLOCKED。
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import {
  BRIDGE_ERRORS,
  CONTROL_PLANE_ROUTES,
  IMPLEMENTED_TOOL_NAMES,
  TOOLS,
  TOOL_CATALOG_OPERATION,
  TOOL_NAMES,
  isImplementedToolName,
} from '@lwb/contracts';
import type {
  BridgeErrorCode,
  BridgeErrorPayload,
  ChangeGetData,
  ChangeListData,
  ChangePrepareData,
  FileReadData,
  ToolCatalogEntry,
  ToolName,
} from '@lwb/contracts';
import type { IpcOutcome } from '@lwb/ipc';

import {
  AdapterConfigError,
  CONNECTION_ID_ENV,
  PIPE_NAME_ENV,
  SECRET_ENV,
  describeConfig,
  loadConfig,
} from '../../apps/mcp-adapter/src/config.ts';
import { createAdapterServer, normalizeToolArguments } from '../../apps/mcp-adapter/src/server.ts';
import type { ToolCaller } from '../../apps/mcp-adapter/src/server.ts';
import { ensureFixtures, TESTREPO_DIR } from '../fixtures/index.ts';
import { fileIdOf, makeFixtureOps } from '../tools/fixture-ops.ts';
import { ADAPTER_CONNECTION, GATES_ON, makeToolHarness } from '../tools/harness.ts';
import type { ToolHarness } from '../tools/harness.ts';

ensureFixtures();

const ADAPTER_VERSION = '0.1.0-test';
const CATALOG_REQUEST_ID = 'req_catalog';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

/**
 * 脚本化的假 caller：回答由用例给定，调用被逐条记下。
 *
 * 它**不模拟 daemon**（不判断授权、不解析参数）：它只是一个按剧本回答的
 * IPC 对端。用它来跑「IPC 层失败」「清单被拒绝」这类真 daemon 造不出来的场景。
 */
class ScriptedCaller implements ToolCaller {
  readonly calls: Array<{ readonly operation: string; readonly input: unknown }> = [];
  readonly #script: (operation: string, input: unknown) => IpcOutcome;

  constructor(script: (operation: string, input: unknown) => IpcOutcome) {
    this.#script = script;
  }

  async call(operation: string, input: unknown): Promise<IpcOutcome> {
    this.calls.push({ operation, input });
    return this.#script(operation, input);
  }
}

function ipcOk(result: unknown): IpcOutcome {
  return { ok: true, result };
}

function ipcFail(code: string, reason = '本地排障文本', outcomeUnknown = false): IpcOutcome {
  return { ok: false, code, reason, outcome_unknown: outcomeUnknown };
}

/** 成功信封（daemon 的工具结果就是这个形状）。 */
function okEnvelope(data: unknown, requestId = 'req_tool'): unknown {
  return { ok: true, data, request_id: requestId };
}

/** 失败信封。`details` 由处理器填，这里只用于核对它被原样带走。 */
function errEnvelope(
  code: BridgeErrorCode,
  requestId = 'req_tool',
  details?: Record<string, string | number | boolean | null>,
): unknown {
  const spec = BRIDGE_ERRORS[code];
  return {
    ok: false,
    error: {
      code,
      message: spec.summary,
      category: spec.category,
      auto_retry: spec.autoRetry,
      ...(details === undefined ? {} : { details }),
    },
    request_id: requestId,
  };
}

/**
 * 一份完整的工具清单：`TOOL_NAMES` 全在，可用的那一小撮由入参给定。
 *
 * 逐条给全（而不是只给可用的那几个）是因为 daemon 真的这么回答 ——
 * 清单里**每一个**工具都有条目，`available: false` 表示此刻挂不出来。
 * 只造可用项会让适配器「跳过未知名字」这类行为在测试里不存在。
 */
function catalogEnvelope(
  available: readonly ToolName[],
  extra: readonly ToolCatalogEntry[] = [],
): unknown {
  const set = new Set<string>(available);
  const tools: ToolCatalogEntry[] = TOOL_NAMES.map((name) => ({
    name,
    available: set.has(name),
    reason: set.has(name) ? null : 'READ_ENABLED_OFF',
  }));
  return okEnvelope({ tools: [...tools, ...extra] }, CATALOG_REQUEST_ID);
}

/**
 * 真的 daemon 操作表做 caller。
 *
 * 连接身份来自**装配时固定的那一条**（`harness.adapterContext()`），
 * 与真实 IPC 服务端一致：服务端从认证过的通道取 `connection_id`，
 * 不看入参里的任何字段。适配器这一侧也没有别的来源。
 */
function daemonCaller(harness: ToolHarness): ToolCaller {
  return {
    async call(operation, input) {
      const definition = harness.operations.lookup(operation);
      if (definition === undefined) {
        // 与 `packages/ipc/src/server.ts` 的 `#handleRequest` 同形。
        return ipcFail('UNKNOWN_OPERATION', '未知操作。');
      }
      return ipcOk(await definition.handler(input, harness.adapterContext()));
    },
  };
}

interface AdapterHarness {
  readonly client: Client;
  readonly logs: string[];
  close(): Promise<void>;
}

async function makeAdapter(caller: ToolCaller): Promise<AdapterHarness> {
  const logs: string[] = [];
  const server = createAdapterServer({
    caller,
    server_version: ADAPTER_VERSION,
    log: (line) => logs.push(line),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'lwb-adapter-test', version: '0.0.1' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    client,
    logs,
    async close() {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

async function fixtureDaemon(): Promise<ToolHarness> {
  return await makeToolHarness({
    root: TESTREPO_DIR,
    // 必须与夹具桩为同一个根报出的 id 一致，否则登记表会判定「根被换掉」。
    root_file_id: fileIdOf(TESTREPO_DIR),
    ops: makeFixtureOps(),
    gates: GATES_ON,
  });
}

// ---------------------------------------------------------------------------
// 结果读取助手
// ---------------------------------------------------------------------------

/**
 * 客户端返回的形状。
 *
 * 三个字段都写成 `unknown` 不是偷懒：SDK 的 `Client.callTool` 返回的是一个
 * **联合类型**，其中一支是「兼容变体」（只有 `toolResult`、没有 `content`）。
 * 本服务端从不产生那一支，因此这里不是绕过类型，而是**断言**它的缺席 ——
 * 断言写在下面几个助手里，失败信息会说明缺的是哪一段。
 */
interface CallResult {
  /**
   * 索引签名不是可选的：它让「兼容变体」那一支也能传进来（那一支只有
   * 索引签名 + `toolResult`），于是形状检查落在下面的断言里，
   * 而不是落在编译期 —— 一个只覆盖了「我期望的那一支」的类型
   * 会把另一支挡在门外，而运行时它确实可能到达。
   */
  readonly [key: string]: unknown;
  readonly content?: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: unknown;
}

function textOf(result: CallResult): string {
  const content = result.content;
  assert.ok(Array.isArray(content), '结果必须带 content 数组');
  const first = content[0] as { readonly type?: unknown; readonly text?: unknown } | undefined;
  assert.ok(first !== undefined && first.type === 'text', '结果的第一段应当是文本');
  assert.ok(typeof first.text === 'string', '文本段必须带字符串 text');
  return first.text;
}

/**
 * 成功结果：文本与结构化内容是**同一份**。
 *
 * 这一条不是形式要求：纯文本客户端看的是 `content`，结构化客户端看的是
 * `structuredContent`，两者不一致时「模型看到的东西」取决于客户端类型，
 * 而那种分歧在排障时几乎不可能被发现。
 */
function successOf<T>(result: CallResult): { ok: true; data: T; request_id: string } {
  assert.notEqual(result.isError, true, `应当是成功结果，实际：${textOf(result)}`);
  const structured = result.structuredContent;
  assert.ok(typeof structured === 'object' && structured !== null, '成功结果必须带 structuredContent');
  assert.equal(textOf(result), JSON.stringify(structured, null, 2), '文本与结构化内容必须是同一份');
  const envelope = structured as { readonly ok?: unknown; readonly data?: unknown; readonly request_id?: unknown };
  assert.equal(envelope.ok, true, '成功信封的判别式应当是 true');
  assert.equal(typeof envelope.request_id, 'string', '成功信封必须带 request_id');
  return envelope as { ok: true; data: T; request_id: string };
}

function failureOf(result: CallResult): BridgeErrorPayload {
  assert.equal(result.isError, true, '应当是一个失败结果');
  // 失败结果不带 `structuredContent`：输出 schema 描述的是成功那一种结果。
  assert.equal(result.structuredContent, undefined, '失败结果不得带 structuredContent');
  const parsed = JSON.parse(textOf(result)) as { readonly ok?: unknown; readonly error?: unknown };
  assert.equal(parsed.ok, false, '失败载荷的信封判别式应当是 false');
  assert.ok(typeof parsed.error === 'object' && parsed.error !== null, '失败载荷必须带 error');
  return parsed.error as BridgeErrorPayload;
}

/** 结果里不得出现本机绝对路径。判据是形状，不是拿某个已知根去比对。 */
function assertNoAbsolutePath(value: unknown, hint: string): void {
  const text = JSON.stringify(value);
  assert.ok(!/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(text), `${hint}：结果里出现了盘符路径`);
  assert.ok(!text.includes('\\\\'), `${hint}：结果里出现了 UNC 前缀`);
  assert.ok(!text.includes(TESTREPO_DIR), `${hint}：结果里出现了工作区绝对路径`);
}

async function expectProtocolError(
  code: number,
  fn: () => Promise<unknown>,
  hint: string,
): Promise<McpError> {
  try {
    await fn();
  } catch (cause) {
    assert.ok(cause instanceof McpError, `${hint}：应当是 McpError，实际 ${String(cause)}`);
    assert.equal(cause.code, code, `${hint}：JSON-RPC 错误码`);
    return cause;
  }
  assert.fail(`${hint}：应当抛出协议错误，但没有抛`);
}

// ---------------------------------------------------------------------------
// 工具清单
// ---------------------------------------------------------------------------

/**
 * 标成**非只读**的工具，以及一句话理由。
 *
 * 写成映射而不是一张名字数组，是为了让「为什么它不是只读的」有一个必须
 * 被写下来的位置 —— 三者的理由各不相同，而把三种理由压成一张名单之后，
 * 下一个人只能靠猜决定自己那个新工具该不该进去。
 *
 *  - `change_prepare` / `change_revert_prepare`：**不碰任何用户文件**
 *    （`workspace_modified` 是字面量 `false`），但会**创建持久化记录** ——
 *    一条修改集、一批快照字节，而且那条记录会出现在操作者的待批准页面上
 *    等人处理。把「不改文件」当成「只读」会让模型认为可以为试探反复提交提案。
 *  - `change_apply`：真的改用户文件。它是这张表里唯一一个「破坏性」的工具
 *    （契约里另外标了 `destructiveHint`）。
 */
const NOT_READ_ONLY: Readonly<Partial<Record<ToolName, string>>> = {
  change_prepare: '不改文件，但会建立修改集与快照，并占用操作者的待批准列表',
  file_create: '在已授权目录直接创建新文本文件',
  file_edit: '基于最新读取票据在已授权目录直接编辑文本文件',
  change_revert_prepare: '不改文件，但会建立一份新的修改集与快照，同样需要本地批准',
  change_apply: '按本地批准写入用户文件',
};

describe('工具清单（tools/list）', () => {
  it('挂出的工具恰好是 daemon 说可用的那一批，且每个都带输入与输出 schema', async () => {
    const caller = new ScriptedCaller(() => ipcOk(catalogEnvelope(IMPLEMENTED_TOOL_NAMES)));
    const adapter = await makeAdapter(caller);
    try {
      const listed = await adapter.client.listTools();

      assert.deepEqual(
        listed.tools.map((tool) => tool.name),
        [...IMPLEMENTED_TOOL_NAMES],
        '挂出的名字与顺序都应当来自契约',
      );

      for (const tool of listed.tools) {
        // 输入 schema 必须是**严格**对象：模型看到「未知字段会被拒绝」，
        // 而 daemon 侧真的会拒绝。发布一份宽松的 schema 会让两者对不上。
        assert.equal(
          (tool.inputSchema as { additionalProperties?: unknown }).additionalProperties,
          false,
          `${tool.name} 的输入 schema 必须是严格对象`,
        );
        assert.ok(tool.outputSchema !== undefined, `${tool.name} 必须声明 outputSchema`);
        assert.ok(tool.title !== undefined && tool.title.length > 0, `${tool.name} 必须有标题`);
        assert.ok(
          tool.description !== undefined && tool.description.length > 0,
          `${tool.name} 必须有描述`,
        );

        // 只读提示必须与工具**真正做的事**一致 —— 说错方向两个方向都危险：
        // 标成只读的写工具会让模型以为可以随便重试，标成非只读的读工具
        // 会让它以为读一次就在改东西。
        for (const tool of listed.tools) {
          const reason = NOT_READ_ONLY[tool.name as ToolName];
          assert.equal(
            tool.annotations?.readOnlyHint,
            reason === undefined,
            `${tool.name} 的只读提示应当是 ${String(reason === undefined)}` +
              (reason === undefined ? '' : `（非只读的理由：${reason}）`),
          );
        }
      }

      // 覆盖面：契约里标成非只读的工具必须**全部**在 `NOT_READ_ONLY` 里有理由。
      // 少了这一句，一个新增的写工具只要忘了写理由，就会安静地按「只读」比对
      // —— 而那是这个测试里唯一会**误判成通过**的方向。
      assert.deepEqual(
        Object.keys(NOT_READ_ONLY).sort(),
        TOOLS.filter((tool) => tool.annotations.readOnlyHint === false)
          .map((tool) => tool.name)
          .sort(),
        '契约里非只读的工具与这里的理由清单必须逐字对应',
      );

      // 清单只问一次，且问的是**不是工具**的那条操作。
      assert.deepEqual(
        caller.calls.map((call) => call.operation),
        [TOOL_CATALOG_OPERATION],
      );
      assert.deepEqual(caller.calls[0]?.input, {});
    } finally {
      await adapter.close();
    }
  });

  it('只挂出 daemon 说的那几个，并如实写进本地日志', async () => {
    // 这是**脚本化**的清单，不是真实门禁推出来的那一份 —— 「门禁全关时
    // 恰好剩哪几个」由 `tests/unit/daemon-tools.test.ts` 对着真清单断言。
    // 这里问的是另一件事：适配器有没有照单全收，有没有自己加减。
    const available: ToolName[] = ['bridge_status', 'workspace_list'];
    const adapter = await makeAdapter(new ScriptedCaller(() => ipcOk(catalogEnvelope(available))));
    try {
      const listed = await adapter.client.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name),
        available,
      );
      assert.ok(
        adapter.logs.some((line) => line.includes('挂出 2 个工具') && line.includes('bridge_status')),
        `本地日志应当说明挂了几个工具；实际：${adapter.logs.join(' / ')}`,
      );
    } finally {
      await adapter.close();
    }
  });

  it('清单里出现控制面方法：整份清单失败，且名字不进模型可见的错误文本', async () => {
    const forged = {
      name: 'approval.grant',
      available: true,
      reason: null,
    } as unknown as ToolCatalogEntry;
    const adapter = await makeAdapter(
      new ScriptedCaller(() => ipcOk(catalogEnvelope(IMPLEMENTED_TOOL_NAMES, [forged]))),
    );
    try {
      const error = await expectProtocolError(
        ErrorCode.InternalError,
        () => adapter.client.listTools(),
        '控制面方法出现在清单里',
      );
      assert.ok(
        !error.message.includes('approval.grant'),
        `JSON-RPC 的 message 会到达模型，不得带本机细节；实际：${error.message}`,
      );
      assert.ok(
        adapter.logs.some((line) => line.includes('approval.grant')),
        '本地日志应当记下是哪个名字出的问题',
      );
    } finally {
      await adapter.close();
    }
  });

  it('清单声称某个工具可用，但本版本没有它的实现：该分支今天到不了，前提由断言守着', () => {
    // `resolveSurface` 的第三条检查（`!isImplementedToolName(entry.name)` ⇒
    // 整份清单失败）要能触发，需要一个**名字在 `TOOL_NAMES` 里、却不在
    // `IMPLEMENTED_TOOL_NAMES` 里**的工具 —— 也就是「契约里先加了名字，
    // 实现还没跟上」那一格。
    //
    // LWB-032 之后那一格是**空的**：14 个契约工具全部有实现与输出契约。
    // 因此这条用例无法再用真名字构造出来，而它守的那段代码仍然在
    // （将来加第 13 个工具时它会重新有用）。这里不删用例、也不伪造一个
    // 假分支去绕过类型，而是把那句「空集」变成一个**会失败的断言**：
    // 哪天有人往 `TOOL_NAMES` 里加了名字而没加实现，这条先红，
    // 提醒他补回那条真正的用例。
    assert.deepEqual(
      [...TOOL_NAMES].filter((name) => !isImplementedToolName(name)),
      [],
      '契约与实现不再一一对应了：请补回「清单声称可用而本版本没有实现」那条用例',
    );
  });

  it('清单里有根本不认识的名字：整份清单失败', async () => {
    const forged = { name: 'file_transfer', available: true, reason: null } as unknown as ToolCatalogEntry;
    const adapter = await makeAdapter(
      new ScriptedCaller(() => ipcOk(catalogEnvelope(IMPLEMENTED_TOOL_NAMES, [forged]))),
    );
    try {
      await expectProtocolError(
        ErrorCode.InternalError,
        () => adapter.client.listTools(),
        '未知工具名出现在清单里',
      );
    } finally {
      await adapter.close();
    }
  });

  it('IPC 层拿不到清单：整份清单失败，本地日志留下 IPC 码', async () => {
    const adapter = await makeAdapter(new ScriptedCaller(() => ipcFail('IPC_UNAVAILABLE', '管道不存在')));
    try {
      const error = await expectProtocolError(
        ErrorCode.InternalError,
        () => adapter.client.listTools(),
        'daemon 不可达',
      );
      assert.ok(adapter.logs.some((line) => line.includes('IPC_UNAVAILABLE')));
      assert.ok(!error.message.includes('IPC_UNAVAILABLE'), 'IPC 码不进模型可见文本');
      assert.ok(!error.message.includes('管道不存在'), '本机排障文本不进模型可见文本');
    } finally {
      await adapter.close();
    }
  });

  it('清单信封是 ok:false（连接被停用）：整份清单失败，本机错误码只进本地日志', async () => {
    const adapter = await makeAdapter(
      new ScriptedCaller(() => ipcOk(errEnvelope('CONNECTION_DISABLED', CATALOG_REQUEST_ID))),
    );
    try {
      const error = await expectProtocolError(
        ErrorCode.InternalError,
        () => adapter.client.listTools(),
        '连接被停用',
      );
      assert.ok(
        adapter.logs.some((line) => line.includes('工具清单被本机拒绝：CONNECTION_DISABLED')),
        `本地日志应当给出本机错误码；实际：${adapter.logs.join(' / ')}`,
      );
      assert.ok(!error.message.includes('CONNECTION_DISABLED'), '错误码不进模型可见文本');
    } finally {
      await adapter.close();
    }
  });

  it('清单的形状无法识别：整份清单失败', async () => {
    const adapter = await makeAdapter(new ScriptedCaller(() => ipcOk('这不是一个信封')));
    try {
      await expectProtocolError(ErrorCode.InternalError, () => adapter.client.listTools(), '形状不可识别');
      assert.ok(adapter.logs.some((line) => line.includes('形状无法识别')));
    } finally {
      await adapter.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 转发
// ---------------------------------------------------------------------------

describe('tools/call 转发（真 daemon 操作表 + 真客户端）', () => {
  let harness!: ToolHarness;
  let adapter!: AdapterHarness;

  before(async () => {
    harness = await fixtureDaemon();
    adapter = await makeAdapter(daemonCaller(harness));
  });
  after(async () => {
    await adapter.close();
    harness.close();
  });

  it('每个已实现的工具都能真的被调用到：操作名与工具名恒等，结果由客户端按 outputSchema 校验通过', async () => {
    /**
     * 覆盖是**记录出来的**，不是声明出来的。
     *
     * 早先这里是一张静态入参表，末尾拿名字数组与 `IMPLEMENTED_TOOL_NAMES`
     * 对拍。那样一来「覆盖」证明的只是「表里写了这些名字」—— 表可以写全
     * 而一个都不真跑。现在 `covered` 只由**真正调用并成功**的工具名填充，
     * 末尾那句断言因此是在说「这些工具都跑通了、结果都过了 schema」。
     */
    const covered: ToolName[] = [];

    const call = async <T>(name: ToolName, args: Record<string, unknown>): Promise<T> => {
      // 客户端会拿 `tools/list` 里那份 outputSchema 校验 structuredContent，
      // 校验不过就抛 InvalidParams —— 这一步就是「结果符合 schema」的裁判。
      const result = await adapter.client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `${name} 应当成功：${textOf(result)}`);
      const envelope = successOf<T>(result);
      assert.equal(typeof envelope.data, 'object');
      assert.equal(envelope.request_id, 'req_1', `${name} 的信封应当带回 daemon 的 request_id`);
      assertNoAbsolutePath(result.structuredContent, name);
      covered.push(name);
      return envelope.data;
    };

    await call('bridge_status', {});
    await call('workspace_list', {});
    await call('file_list', { workspace_id: harness.workspace.id });
    await call('text_search', { workspace_id: harness.workspace.id, query: 'line' });
    await call('git_status', { workspace_id: harness.workspace.id });
    await call('git_diff', { workspace_id: harness.workspace.id, path: '文档/设计说明.md' });

    // 后四个的入参**只能**从前一步的结果里取：读取票据与 change_id 都不是
    // 可以硬编码的常量。这不是麻烦，而是这一组用例唯一能证明的东西 ——
    // 「名字能对上」在入参正确时才说明工具真的可用。
    //
    // 夹具文件 `newline/lf.txt` 恰好三行（`lf-line-1` / `-2` / `-3`），
    // 因此整文件读取的票据覆盖 1..3，下面这条编辑落在票据范围内。
    const read = await call<FileReadData>('file_read', {
      workspace_id: harness.workspace.id,
      path: 'newline/lf.txt',
    });
    assert.equal(read.editable, true, '整文件读取必须可编辑，否则提不出修改');

    const prepared = await call<ChangePrepareData>('change_prepare', {
      workspace_id: harness.workspace.id,
      idempotency_key: 'idem-adapter-1',
      summary: '适配器验收：改一行',
      items: [
        {
          op: 'edit_text',
          path: 'newline/lf.txt',
          base_sha256: read.sha256,
          read_token: read.read_token,
          edits: [
            { start_line: 1, end_line_exclusive: 2, old_lines: ['lf-line-1'], new_lines: ['lf-line-1-edited'] },
          ],
        },
      ],
    });
    assert.equal(prepared.workspace_modified, false, '提案不得改动工作区');

    // `change_get` 按 change_id 指名，**不带 workspace_id** —— 归属由记录本身
    // 决定。这一句跑通即证明那条「先查记录拿工作区、再按工作区解析授权」的
    // 路径是通的（否则它会以 WORKSPACE_NOT_GRANTED / NOT_FOUND 收场）。
    const got = await call<ChangeGetData>('change_get', { change_id: prepared.change_id });
    assert.equal(got.change.change_id, prepared.change_id);

    const listed = await call<ChangeListData>('change_list', {
      workspace_id: harness.workspace.id,
    });
    assert.ok(
      listed.changes.some((entry) => entry.change_id === prepared.change_id),
      '刚建立的修改集必须出现在本连接的清单里',
    );

    // 覆盖率是**记出来的**，而缺口是**写下来的** —— 两者缺一不可：
    // 只记不算，这一组会随实现增多而悄悄漏掉几个；只声明不记，它又会退回到
    // 「表里写了这些名字」。因此断言写成「跑通的 ∪ 明确排除的 = 全部已实现」，
    // 而排除项必须在这里逐条给出理由。
    //
    // 排除的是直接写入工具：它们的结果只能从真实护栏执行后得到，
    // 而应用要真的写进用户文件 —— 本装置的后端（`makeFixtureOps`）
    // 在写方法上直接抛「写操作不在工具面范围内」，这是刻意的：
    // 真实的句柄级复核、`CREATE_NEW`、刷盘与回读只有真护栏做得到。
    // 因此它们由 `tests/windows/daemon-apply-tool.test.ts` 在**真 NTFS**
    // 上覆盖，而不是在这里被一个桩假装覆盖。
    const NEEDS_REAL_GUARD: Readonly<Partial<Record<ToolName, string>>> = {
      file_create: '单文件创建会直接写入',
      file_edit: '单文件编辑会直接写入',
      change_apply: '要真的写进用户文件',
      change_revert_prepare: '入参只能来自一次已应用且已终结的修改集',
    };
    assert.deepEqual(
      [...covered].sort(),
      [...IMPLEMENTED_TOOL_NAMES]
        .filter((name) => NEEDS_REAL_GUARD[name as ToolName] === undefined)
        .sort(),
      '这一组要覆盖除写入之外的全部已实现工具',
    );
  });

  it('daemon 的失败信封被翻成工具结果，而不是 INTERNAL_ERROR', async () => {
    // 这一条钉的是一个真实存在过的缺陷：失败信封若拿去套**成功** schema，
    // 每一次「策略拒绝 / 未授权」都会折成 INTERNAL_ERROR（本地服务有 bug），
    // 排查方向整个反过来。
    const result = await adapter.client.callTool({
      name: 'file_read',
      arguments: { workspace_id: harness.otherWorkspace.id, path: '文档/设计说明.md' },
    });
    const error = failureOf(result);
    assert.equal(error.code, 'WORKSPACE_NOT_GRANTED', `实际：${JSON.stringify(error)}`);
    assert.equal(error.message, BRIDGE_ERRORS.WORKSPACE_NOT_GRANTED.summary);
    assert.ok(
      (error.details as Record<string, unknown> | undefined)?.['request_id'] === 'req_1',
      '失败结果也要带上 daemon 的审计关联 ID，否则本地审计对不上这一次调用',
    );
  });

  it('缺省参数按空对象转发（不是 undefined）', async () => {
    const caller = new ScriptedCaller(() => ipcOk(okEnvelope({ workspaces: [], truncated: false })));
    const scripted = await makeAdapter(caller);
    try {
      await scripted.client.callTool({ name: 'workspace_list' });
      assert.deepEqual(caller.calls, [{ operation: 'workspace_list', input: {} }]);
    } finally {
      await scripted.close();
    }
  });

  it('参数逐字转发：适配器不解释任何字段，身份字段也不例外', async () => {
    // 适配器**不**剥掉身份字段，也**不**服从它们：它没有判断这一步，
    // 全部原样交给 daemon。这不是宽松，是责任边界 —— 同一个字段
    // 「被忽略」与「被拒绝」在排障时是两件事，而拒绝的理由只有 daemon 知道。
    const payload = {
      workspace_id: 'ws-假设的',
      path: 'README.md',
      connection_id: 'conn-别人的',
      user_id: 'u-别人',
      approved: true,
      verbose: 1,
    };
    const caller = new ScriptedCaller(() => ipcOk(okEnvelope({})));
    const adapter2 = await makeAdapter(caller);
    try {
      await adapter2.client.callTool({ name: 'file_read', arguments: payload });
      assert.deepEqual(caller.calls, [{ operation: 'file_read', input: payload }]);
    } finally {
      await adapter2.close();
    }
  });

  it('身份字段到达 daemon 后被拒绝：结果里是可机读的输入违约，不是内部错误', async () => {
    const result = await adapter.client.callTool({
      name: 'file_read',
      arguments: { workspace_id: harness.workspace.id, path: 'newline/lf.txt', approved: true },
    });
    const error = failureOf(result);
    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.equal((error.details as Record<string, unknown> | undefined)?.['reason'], 'INPUT_SCHEMA_VIOLATION');
  });
});

describe('单文件直接写工具的 MCP 输出契约', () => {
  it('file_create 与 file_edit 都把 APPLIED 逐文件回执通过 MCP outputSchema 返回', async () => {
    const receipt = {
      change_id: 'change-direct-write',
      operation_id: 'operation-direct-write',
      state: 'APPLIED',
      in_progress: false,
      recovered: false,
      files: [{
        path: 'src/example.txt',
        state: 'VERIFIED',
        before_sha256: null,
        after_sha256: 'a'.repeat(64),
        error_code: null,
      }],
      tests_run: false,
      message: '已逐文件核验。',
    };
    const caller = new ScriptedCaller((operation) =>
      operation === TOOL_CATALOG_OPERATION
        ? ipcOk(catalogEnvelope(IMPLEMENTED_TOOL_NAMES))
        : ipcOk(okEnvelope(receipt, 'req_1')),
    );
    const adapter = await makeAdapter(caller);
    try {
      const common = {
        workspace_id: 'workspace-1',
        summary: 'direct-write adapter contract',
        path: 'src/example.txt',
      };
      const created = await adapter.client.callTool({
        name: 'file_create',
        arguments: {
          ...common,
          idempotency_key: 'adapter-create-key',
          content: 'created',
          newline: 'lf',
          bom: false,
        },
      });
      const edited = await adapter.client.callTool({
        name: 'file_edit',
        arguments: {
          ...common,
          idempotency_key: 'adapter-edit-key',
          base_sha256: 'b'.repeat(64),
          read_token: 'fresh-read-token',
          edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: ['old'], new_lines: ['new'] }],
        },
      });
      assert.notEqual(created.isError, true, textOf(created));
      assert.notEqual(edited.isError, true, textOf(edited));
      assert.deepEqual(caller.calls.map((call) => call.operation), ['file_create', 'file_edit']);
      assert.equal((created.structuredContent as { data?: { state?: string } }).data?.state, 'APPLIED');
      assert.equal((edited.structuredContent as { data?: { files?: readonly unknown[] } }).data?.files?.length, 1);
    } finally {
      await adapter.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 协议错误
// ---------------------------------------------------------------------------

describe('协议错误（不是工具结果）', () => {
  it('未知工具名：InvalidParams，且不去打扰 daemon', async () => {
    const caller = new ScriptedCaller(() => ipcOk(okEnvelope({})));
    const adapter = await makeAdapter(caller);
    try {
      const error = await expectProtocolError(
        ErrorCode.InvalidParams,
        () => adapter.client.callTool({ name: 'file_transfer', arguments: {} }),
        '未知工具名',
      );
      assert.ok(error.message.includes('file_transfer'), '无效问题应当说清是哪个名字');
      assert.deepEqual(caller.calls, [], '一个不存在的工具名不该产生任何 IPC 调用');
    } finally {
      await adapter.close();
    }
  });

  it('有效工具名一律转发给 daemon：适配器不自己回答业务问题', async () => {
    // 这条用例原本问的是「契约里有名字、但本版本没实现 ⇒ 适配器转发、
    // daemon 回 `UNKNOWN_OPERATION` ⇒ 翻成 `UNSUPPORTED_OPERATION`」。
    //
    // LWB-032 之后**那个前提没有了**：14 个契约工具全部有实现，
    // 而 daemon 的操作表就是 `IMPLEMENTED_TOOL_NAMES` —— 于是没有任何一个
    // 合法工具名能走到 `UNKNOWN_OPERATION`。那条映射本身仍然被下面
    // 「IPC 失败 → 模型可见载荷」的 `CASES` 表逐条钉着，没有漏。
    //
    // 这里改钉同一层上**今天成立且更要紧**的那条性质：一个名字只要有效，
    // 适配器就转发，并且把 daemon 的**业务**回答原样交出去 ——
    // 它不猜、不拦、也不把「这条修改集不存在」说成自己的问题。
    // 用 `change_apply` 是因为它已经进了操作表，走的必然是真处理器。
    const harness = await fixtureDaemon();
    const adapter = await makeAdapter(daemonCaller(harness));
    try {
      const result = await adapter.client.callTool({
        name: 'change_apply',
        // 幂等键要满足 `MIN_IDEMPOTENCY_KEY_CHARS`：太短的键会在**输入
        // schema** 就被拒，那样这条用例验的就变成了参数校验，而不是转发。
        arguments: { change_id: 'c-不存在', idempotency_key: 'idem-for-routing-test' },
      });
      const error = failureOf(result);
      // 「不是你的」与「不存在」必须给出**逐字相同**的回答（没有存在性预言机），
      // 因此这里断言的正是那条统一回答。
      assert.equal(error.code, 'NOT_FOUND', `未知 change_id 应当得到业务失败；实际 ${error.code}`);
      assert.notEqual(error.code, 'UNSUPPORTED_OPERATION', '本版本已有 change_apply 的实现，不该被当成未实现');
    } finally {
      await adapter.close();
      harness.close();
    }
  });

  it('参数不是对象：InvalidParams（本层的规则，与 SDK 的 schema 无关）', () => {
    // 真实客户端路径上这一段**跑不到**：SDK 自己的 `CallToolRequestSchema`
    // 把 `arguments` 定成 `z.record(...).optional()`，非对象在到达处理器之前
    // 就被 SDK 拒绝了。留着并直接钉住它，是因为这里约束的是
    // 「本进程答应过的事」—— 一句话只有在能被证伪的时候才算数。
    for (const value of [[], null, 'file_read', 42]) {
      assert.throws(
        () => normalizeToolArguments(value),
        (cause: unknown) => cause instanceof McpError && cause.code === ErrorCode.InvalidParams,
        `${JSON.stringify(value)} 应当被拒绝`,
      );
    }
    // 缺省 ⇒ 空对象；对象原样通过（含 `{}`）。
    assert.deepEqual(normalizeToolArguments(undefined), {});
    assert.deepEqual(normalizeToolArguments({}), {});
    assert.deepEqual(normalizeToolArguments({ a: 1 }), { a: 1 });
  });
});

// ---------------------------------------------------------------------------
// IPC 失败 → 模型可见载荷
// ---------------------------------------------------------------------------

describe('IPC 失败 → 模型可见载荷', () => {
  /** 每一种 IPC 失败码对应的载荷。表就是契约，改这里等于改对外行为。 */
  const CASES: ReadonlyArray<{ ipc: string; expected: BridgeErrorCode }> = [
    { ipc: 'UNKNOWN_OPERATION', expected: 'UNSUPPORTED_OPERATION' },
    { ipc: 'CAPABILITY_DENIED', expected: 'NOT_AUTHORIZED' },
    { ipc: 'IPC_UNAVAILABLE', expected: 'SERVICE_UNAVAILABLE' },
    { ipc: 'IPC_INTERRUPTED', expected: 'SERVICE_UNAVAILABLE' },
    { ipc: 'TIMEOUT', expected: 'SERVICE_UNAVAILABLE' },
    { ipc: 'OPERATION_FAILED', expected: 'INTERNAL_ERROR' },
    // 未来新增的 IPC 码：默认落到 INTERNAL_ERROR，而不是把 `reason` 交出去。
    { ipc: '某个还没见过的码', expected: 'INTERNAL_ERROR' },
  ];

  for (const testCase of CASES) {
    it(`${testCase.ipc} → ${testCase.expected}`, async () => {
      // 悄悄话：`reason` 里塞进本机路径与一段高置信度秘密。
      // 它是为本地排障写的，因此必须**一句都不出站**。
      const secret = 'ghp_012345678901234567890123456789012345';
      const adapter = await makeAdapter(
        new ScriptedCaller(() =>
          ipcFail(testCase.ipc, `连接 C:\\Users\\mj\\proj\\a.ts 失败，token=${secret}`, true),
        ),
      );
      try {
        const result = await adapter.client.callTool({ name: 'file_list', arguments: {} });
        const error = failureOf(result);
        const text = textOf(result);

        assert.equal(error.code, testCase.expected);
        assert.equal(error.message, BRIDGE_ERRORS[testCase.expected].summary);
        assert.equal(error.category, BRIDGE_ERRORS[testCase.expected].category);
        assert.equal(error.auto_retry, BRIDGE_ERRORS[testCase.expected].autoRetry);

        const details = error.details as Record<string, unknown> | undefined;
        assert.equal(details?.['ipc_code'], testCase.ipc);
        // `outcome_unknown` 必须如实带出去：契约里写明这类回答不得被当作
        // 失败判断，而模型只能从载荷里知道这一点。
        assert.equal(details?.['outcome_unknown'], true);

        // 一条都不出站。
        assert.ok(!text.includes(secret), 'IPC 的 reason 里可能有凭证');
        assert.ok(!text.includes('C:\\'), 'IPC 的 reason 里可能有本机路径');
        assert.ok(!text.includes('Users'), 'IPC 的 reason 里可能有本机路径');
        assert.ok(!text.includes('proj'), 'IPC 的 reason 里可能有本机路径');
      } finally {
        await adapter.close();
      }
    });
  }

  it('服务不可达的类型说明包含了「是否已执行未知」这句话', async () => {
    // 这句话是给模型看的操作约束，不是免责声明：`isError: true` 是 MCP 唯一
    // 的失败通道，若说明里不说「结果未知」，模型会把它读成「没执行」并重试。
    const adapter = await makeAdapter(new ScriptedCaller(() => ipcFail('TIMEOUT', '超时')));
    try {
      const error = failureOf(await adapter.client.callTool({ name: 'file_read', arguments: {} }));
      assert.ok(error.message.includes('未知'), `实际：${error.message}`);
      assert.ok(error.message.includes('不得据此判断成功或失败'), `实际：${error.message}`);
    } finally {
      await adapter.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 结果契约
// ---------------------------------------------------------------------------

describe('结果契约（不符合输出契约的结果不交给客户端）', () => {
  it('成功信封少了字段：isError + INTERNAL_ERROR，且没有 structuredContent', async () => {
    // 一份「看起来像成功」但不合契约的结果。交给客户端的话，客户端会按
    // `outputSchema` 拒绝它 —— 那时我们本可以先说清楚。
    const adapter = await makeAdapter(
      new ScriptedCaller(() => ipcOk(okEnvelope({ path: 'a.txt' }))),
    );
    try {
      const result = await adapter.client.callTool({ name: 'file_read', arguments: {} });
      const error = failureOf(result);
      assert.equal(error.code, 'INTERNAL_ERROR');
      assert.ok(
        adapter.logs.some((line) => line.includes('结果不符合输出契约')),
        `本地日志应当说明哪一处不符；实际：${adapter.logs.join(' / ')}`,
      );
    } finally {
      await adapter.close();
    }
  });

  it('结果根本不是信封：同样是 INTERNAL_ERROR', async () => {
    const adapter = await makeAdapter(new ScriptedCaller(() => ipcOk({ 随便: '什么' })));
    try {
      const result = await adapter.client.callTool({ name: 'bridge_status', arguments: {} });
      assert.equal(failureOf(result).code, 'INTERNAL_ERROR');
    } finally {
      await adapter.close();
    }
  });

  it('失败载荷本身不合契约（错误码是自由字符串）：不交给客户端', async () => {
    // 这一条钉的是失败路径上的校验：`error.code` 被收窄成已知错误码，
    // 因为它是模型决定下一步的唯一依据，而一个自由字符串的「错误码」
    // 会让模型照着它去规划动作。
    const adapter = await makeAdapter(
      new ScriptedCaller(() =>
        ipcOk({
          ok: false,
          error: { code: '内部标签', message: 'x', category: 'business', auto_retry: 'never' },
          request_id: 'req_tool',
        }),
      ),
    );
    try {
      const result = await adapter.client.callTool({ name: 'file_list', arguments: {} });
      const error = failureOf(result);
      assert.equal(error.code, 'INTERNAL_ERROR');
      assert.ok(!textOf(result).includes('内部标签'), '不合契约的失败载荷一个字都不该出站');
    } finally {
      await adapter.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 启动配置
// ---------------------------------------------------------------------------

describe('启动配置（凭证与身份）', () => {
  const complete = {
    [PIPE_NAME_ENV]: '\\\\.\\pipe\\lwb-test',
    [SECRET_ENV]: 'adapter-secret-0123456789',
    [CONNECTION_ID_ENV]: ADAPTER_CONNECTION,
  };

  it('配置齐全时能启动，且连接身份来自环境而不是任何入参', () => {
    const config = loadConfig(complete);
    assert.equal(config.connection_id, ADAPTER_CONNECTION);
    assert.equal(config.adapter_version, '0.0.0', '版本可缺省');
  });

  it('缺任何一项就拒绝启动，没有默认值', () => {
    for (const name of [PIPE_NAME_ENV, SECRET_ENV, CONNECTION_ID_ENV]) {
      const partial: Record<string, string | undefined> = { ...complete };
      delete partial[name];
      assert.throws(
        () => loadConfig(partial),
        (cause: unknown) => cause instanceof AdapterConfigError && cause.message.includes(name),
        `缺少 ${name} 时应当拒绝启动`,
      );
    }
  });

  it('过短的凭证拒绝启动（阈值与 audience 密钥派生一致）', () => {
    assert.throws(() => loadConfig({ ...complete, [SECRET_ENV]: 'short' }), AdapterConfigError);
  });

  it('配置描述只有长度，没有凭证本身', () => {
    const config = loadConfig(complete);
    const described = describeConfig(config);
    const text = JSON.stringify(described);
    assert.ok(!text.includes(config.secret), '描述里不得出现凭证');
    assert.equal(described['secret_length'], config.secret.length);
  });
});
