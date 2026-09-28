/**
 * 工具面验收（LWB-017）。
 *
 * 三条验收标准逐条对应：
 *
 *  | 验收标准 | 在哪一组 |
 *  | --- | --- |
 *  | 无控制平面方法出现在 `tools/list` | 「工具清单」 |
 *  | 工具结果符合 schema，未知字段 / 无效枚举被拒绝 | 「入参契约」「结果契约」 |
 *  | 两条配置不同的连接不能读取对方工作区 | 「跨连接隔离」 |
 *
 * ## 两组装置，各有各的用处
 *
 *  - **内存树桩**（`makeToolHarness()` 默认）：跑边界与负向用例。它快，
 *    而且能造出真实磁盘造不出来的状态（处理器抛异常、根被换掉）。
 *  - **真实夹具仓库**（`fixtureHarness()`）：跑正向用例。理由是
 *    「结果符合 schema」这句话只有在一份**真的返回了内容**的结果上才检验得到 ——
 *    空数组符合任何 schema。这一组的事实全部取自 `manifest.json`，
 *    不自己造期望值（`tests/fixtures/index.ts` 的原则）。
 *
 * ## 这一组用例不证明的事
 *
 *  - **不证明真实句柄护栏下的行为**：夹具桩只回答事实，它不做句柄级身份复核、
 *    不拒绝重解析点。那些由 `tests/windows/` 负责。
 *  - **不证明 ChatGPT 网页端能发现并调用这些工具**：那需要真实账号，
 *    当前 BLOCKED（见 `docs/evidence/lwb-017/summary.md`）。
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ACTION_SPECS } from '@lwb/policy';
import {
  BRIDGE_ERRORS,
  BridgeError,
  CONTROL_PLANE_ROUTES,
  IMPLEMENTED_TOOL_NAMES,
  TOOL_CATALOG_OPERATION,
  TOOL_NAMES,
  TOOL_OUTPUT_SCHEMAS,
} from '@lwb/contracts';
import type {
  BridgeStatusData,
  Envelope,
  FileListData,
  FileReadData,
  GitDiffData,
  GitStatusData,
  ImplementedToolName,
  TextSearchData,
  ToolCatalogResult,
  WorkspaceListData,
} from '@lwb/contracts';

import { assertNoControlPlane } from '../../apps/daemon/src/tools/catalog.ts';
import { describeForLocalAudit, isSafeForModel, toModelPayload } from '../../apps/daemon/src/tools/errors.ts';
import {
  NON_WORKSPACE_TOOL_NAMES,
  WORKSPACE_TOOL_NAMES,
} from '../../apps/daemon/src/tools/guard.ts';
import { TOOL_POLICY_ACTIONS } from '../../apps/daemon/src/tools/handlers.ts';
import {
  ensureFixtures,
  findFile,
  loadManifest,
  TESTREPO_DIR,
  type FixtureManifest,
} from '../fixtures/index.ts';
import { fileIdOf, makeFixtureOps } from '../tools/fixture-ops.ts';
import {
  ADAPTER_CONNECTION,
  GATES_OFF,
  GATES_ON,
  OTHER_CONNECTION,
  callTool,
  dataOf,
  errorOf,
  makeToolHarness,
  type ToolHarness,
} from '../tools/harness.ts';

ensureFixtures();

// ---------------------------------------------------------------------------
// 助手
// ---------------------------------------------------------------------------

/**
 * 结果符合输出契约 —— 这一句与适配器里那句是**同一个** schema、同一个方向。
 *
 * 校验的是**整个信封**（含 `ok` / `request_id`），因为适配器交给客户端的就是
 * 整个信封：只校验 `data` 会让「信封多了个字段」这类漂移在这里看不见。
 */
function assertConforms(name: ImplementedToolName, envelope: Envelope<unknown>): void {
  const parsed = TOOL_OUTPUT_SCHEMAS[name].safeParse(envelope);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    assert.fail(
      `${name} 的结果不符合输出契约：${parsed.error.issues.length} 处，` +
        `首处 ${first?.code ?? 'INVALID'} @ ${first?.path.join('.') ?? ''}`,
    );
  }
}

/**
 * 结果里不得出现本机绝对路径。
 *
 * 判据是**形状**（`X:` 后面跟分隔符），不是拿已知根路径去 `includes`：
 * 前者能抓住「另一个盘上的路径」，而后者只抓得住这一个工作区。
 */
function assertNoAbsolutePath(value: unknown, hint: string): void {
  const text = JSON.stringify(value);
  assert.ok(
    !/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(text),
    `${hint}：结果里出现了盘符路径`,
  );
  assert.ok(!text.includes('\\\\'), `${hint}：结果里出现了 UNC 前缀`);
  assert.ok(!text.includes(TESTREPO_DIR), `${hint}：结果里出现了工作区绝对路径`);
}

/**
 * 工具清单。**与工具同一种信封**，因此这里也走 `callTool` + `dataOf`：
 * 一条失败的信封会把错误码带进断言消息，而不是变成 `undefined.tools`。
 */
async function catalogOf(harness: ToolHarness): Promise<ToolCatalogResult> {
  return dataOf<ToolCatalogResult>(
    await callTool(harness, TOOL_CATALOG_OPERATION, {}),
    TOOL_CATALOG_OPERATION,
  );
}

async function fixtureHarness(): Promise<ToolHarness> {
  return await makeToolHarness({
    root: TESTREPO_DIR,
    // 必须与夹具桩为同一个根报出的 id 一致，否则登记表会判定「根被换掉」。
    root_file_id: fileIdOf(TESTREPO_DIR),
    ops: makeFixtureOps(),
    gates: GATES_ON,
  });
}

// ---------------------------------------------------------------------------
// 验收 1：工具清单里没有控制面方法
// ---------------------------------------------------------------------------

describe('工具清单（验收 1：无控制面方法）', () => {
  // `before` 里赋值；`!` 是给 TS 看的 —— node:test 的时序保证不了这一点的静态可见性。
  let h!: ToolHarness;

  before(async () => {
    h = await makeToolHarness({ gates: GATES_ON });
  });
  after(() => {
    h.close();
  });

  it('清单覆盖全部工具名，且一个控制面方法都没有', async () => {
    const catalog = await catalogOf(h);
    const names = catalog.tools.map((entry) => entry.name);

    assert.deepEqual([...names].sort(), [...TOOL_NAMES].sort());

    for (const route of CONTROL_PLANE_ROUTES) {
      assert.ok(
        !names.includes(route as never),
        `控制面方法 ${route} 出现在了工具清单里`,
      );
    }
  });

  it('外部验收状态未签署时，工具仍由逐工作区 grant 控制', async () => {
    const closed = await makeToolHarness({ gates: GATES_OFF });
    try {
      const catalog = await catalogOf(closed);
      const available = catalog.tools.filter((entry) => entry.available).map((entry) => entry.name);

      assert.deepEqual([...available].sort(), [...IMPLEMENTED_TOOL_NAMES].sort());
    } finally {
      closed.close();
    }
  });

  it('工具清单只显示该连接已获授的工作区工具', async () => {
    const restricted = await makeToolHarness({ gates: GATES_OFF });
    try {
      restricted.grant(ADAPTER_CONNECTION, restricted.workspace.id, ['read']);
      const catalog = await catalogOf(restricted);
      const available = catalog.tools.filter((entry) => entry.available).map((entry) => entry.name);
      assert.deepEqual([...available].sort(), [
        'bridge_status', 'change_get', 'change_list', 'file_read', 'workspace_list',
      ]);
      assert.equal(catalog.tools.find((entry) => entry.name === 'file_list')?.reason, 'WORKSPACE_TOOL_NOT_GRANTED');
      assert.equal(catalog.tools.find((entry) => entry.name === 'file_delete')?.reason, 'WORKSPACE_TOOL_NOT_GRANTED');
    } finally {
      restricted.close();
    }
  });

  it('file_edit 只有在同一工作区同时获授读取和文件修改时才出现在工具清单', async () => {
    const restricted = await makeToolHarness({ gates: GATES_OFF });
    try {
      restricted.grant(ADAPTER_CONNECTION, restricted.workspace.id, ['propose']);
      let catalog = await catalogOf(restricted);
      assert.equal(catalog.tools.find((entry) => entry.name === 'file_create')?.available, true);
      assert.equal(catalog.tools.find((entry) => entry.name === 'file_delete')?.available, true);
      assert.equal(catalog.tools.find((entry) => entry.name === 'change_apply')?.available, true);
      assert.equal(catalog.tools.find((entry) => entry.name === 'file_edit')?.available, false);

      restricted.grant(ADAPTER_CONNECTION, restricted.workspace.id, ['read', 'propose']);
      catalog = await catalogOf(restricted);
      assert.equal(catalog.tools.find((entry) => entry.name === 'file_edit')?.available, true);
    } finally {
      restricted.close();
    }
  });

  it('门禁全开时，可用的是全部已实现工具；未实现的理由是「没实现」而不是「开关关了」', async () => {
    const catalog = await catalogOf(h);
    const available = catalog.tools.filter((entry) => entry.available).map((entry) => entry.name);

    assert.deepEqual([...available].sort(), [...IMPLEMENTED_TOOL_NAMES].sort());

    for (const entry of catalog.tools) {
      if (entry.available) continue;
      // 「没实现」与「开关关了」是两件事。把它们说成同一件会让本地排查
      // 去找一个不存在的开关。
      assert.equal(entry.reason, 'NOT_IMPLEMENTED', `${entry.name} 的不可用理由`);
      assert.ok(!IMPLEMENTED_TOOL_NAMES.includes(entry.name as ImplementedToolName));
    }
  });

  it('清单里的每个可用名字都有输出 schema', async () => {
    const catalog = await catalogOf(h);
    for (const entry of catalog.tools) {
      if (!entry.available) continue;
      assert.ok(
        Object.hasOwn(TOOL_OUTPUT_SCHEMAS, entry.name),
        `${entry.name} 被挂成可用，却没有输出契约`,
      );
    }
  });

  it('tools.catalog 不接受任何参数', async () => {
    for (const input of [{ anything: 1 }, [], 'x', 0, [{ a: 1 }]]) {
      const error = errorOf(
        await callTool(h, TOOL_CATALOG_OPERATION, input),
        `tools.catalog ${JSON.stringify(input)}`,
      ).error;
      assert.equal(error.code, 'INVALID_ARGUMENT', JSON.stringify(input));
      assert.equal(error.details?.['reason'], 'INPUT_SCHEMA_VIOLATION');
    }

    // 空参数是**合法的**：JSON 里没有 undefined，而 `{}` 就是「零个参数」本身。
    for (const input of [undefined, null, {}]) {
      const catalog = dataOf<ToolCatalogResult>(
        await callTool(h, TOOL_CATALOG_OPERATION, input),
        `tools.catalog ${String(input)}`,
      );
      assert.equal(catalog.tools.length, TOOL_NAMES.length);
    }
  });

  it('自检不依赖清单的来源：伪造一条控制面方法就会被装配拒绝', () => {
    assert.throws(
      () => assertNoControlPlane([{ name: 'approval.grant' as never, available: true, reason: null }]),
      /控制面方法/,
    );
    assert.throws(
      () => assertNoControlPlane([{ name: 'workspace.snapshot' as never, available: true, reason: null }]),
      /未知名字/,
    );
    // 真实的清单必须通过 —— 否则上面两条只是「这个函数总是抛」。
    assert.doesNotThrow(() =>
      assertNoControlPlane([{ name: 'file_read', available: true, reason: null }]),
    );
  });

  it('停用的连接：工具清单不可得', async () => {
    const disabled = await makeToolHarness({ gates: GATES_ON });
    try {
      disabled.repos.connections.setEnabled(ADAPTER_CONNECTION, false);
      const error = errorOf(
        await callTool(disabled, TOOL_CATALOG_OPERATION, {}),
        '停用连接',
      ).error;
      assert.equal(error.code, 'CONNECTION_DISABLED');
    } finally {
      disabled.close();
    }
  });

  it('登记类型与通道不符的连接：拒绝（而不是按登记类型放宽）', async () => {
    const mismatched = await makeToolHarness({ gates: GATES_ON });
    try {
      mismatched.repos.connections.create({
        id: 'conn-console-on-model-channel',
        // 控制台身份挂在模型通道上 —— 这条配置错误在功能上看不出来，
        // 因此必须在这里被拒绝。
        principal_kind: 'console',
        principal_id: 'principal-console',
        alias: '错挂的控制台身份',
      });
      const error = errorOf(
        await callTool(
          mismatched,
          'bridge_status',
          {},
          mismatched.contextFor('conn-console-on-model-channel'),
        ),
        '错挂身份',
      ).error;
      assert.equal(error.code, 'NOT_AUTHORIZED');
      assert.equal(error.details?.['reason'], 'PRINCIPAL_KIND_MISMATCH');
    } finally {
      mismatched.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 验收 2（前半）：入参契约
// ---------------------------------------------------------------------------

/** 身份字段：一个都不该被任何工具接受。 */
const FORBIDDEN_FIELDS = [
  'user_id',
  'session_id',
  'conversation_label',
  'principal_id',
  'connection_id',
  'approved',
  'force',
  'as_console',
] as const;

const ARGUMENTED_TOOLS: readonly (readonly [string, Record<string, unknown>])[] = [
  ['bridge_status', {}],
  ['workspace_list', {}],
  ['file_list', { workspace_id: 'ws-any' }],
  ['file_read', { workspace_id: 'ws-any', path: 'README.md' }],
  ['text_search', { workspace_id: 'ws-any', query: 'x' }],
  ['git_status', { workspace_id: 'ws-any' }],
  ['git_diff', { workspace_id: 'ws-any', path: 'README.md' }],
  ['file_create', {
    workspace_id: 'ws-any', idempotency_key: 'idem-test-create', summary: 'create',
    path: 'new.txt', content: 'text', newline: 'lf', bom: false,
  }],
  ['file_edit', {
    workspace_id: 'ws-any', idempotency_key: 'idem-test-edit', summary: 'edit', path: 'a.txt',
    base_sha256: 'a'.repeat(64), read_token: 'ticket',
    edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: ['old'], new_lines: ['new'] }],
  }],
  ['file_delete', {
    workspace_id: 'ws-any', idempotency_key: 'idem-test-delete', summary: 'delete', path: 'a.txt',
  }],
];

describe('入参契约（验收 2：未知字段 / 无效枚举）', () => {
  let h!: ToolHarness;

  before(async () => {
    h = await makeToolHarness({ gates: GATES_ON });
  });
  after(() => {
    h.close();
  });

  it('身份字段一律无从传入：加一个就被拒绝', async () => {
    for (const [tool, base] of ARGUMENTED_TOOLS) {
      for (const field of FORBIDDEN_FIELDS) {
        const envelope = await callTool(h, tool, { ...base, [field]: 'x' });
        const error = errorOf(envelope, `${tool} + ${field}`).error;
        assert.equal(error.code, 'INVALID_ARGUMENT', `${tool} 接受了身份字段 ${field}`);
        assert.equal(error.details?.['reason'], 'INPUT_SCHEMA_VIOLATION');
      }
    }
  });

  it('未知字段（不在身份字段清单里的）同样被拒绝', async () => {
    const envelope = await callTool(h, 'file_read', {
      workspace_id: h.workspace.id,
      path: 'README.md',
      verbose: true,
    });
    const error = errorOf(envelope, 'file_read 未知字段').error;
    assert.equal(error.code, 'INVALID_ARGUMENT');
    // 拒绝时必须指出是哪个字段：只说「参数不合法」会让调用方无从修正。
    assert.equal(error.details?.['field'], 'verbose');
  });

  it('无效枚举与越界数字被拒绝', async () => {
    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      ['git_diff', { workspace_id: 'w', path: 'a.ts', comparison: 'HEAD~1' }],
      ['git_diff', { workspace_id: 'w', path: 'a.ts', comparison: 'worktree_vs_index' }],
      ['file_list', { workspace_id: 'w', depth: 9 }],
      ['file_list', { workspace_id: 'w', max_entries: 0 }],
      ['file_read', { workspace_id: 'w', path: 'a.ts', start_line: 0 }],
      ['text_search', { workspace_id: 'w', query: '' }],
    ];
    for (const [tool, input] of cases) {
      const error = errorOf(await callTool(h, tool, input), `${tool} ${JSON.stringify(input)}`).error;
      assert.equal(error.code, 'INVALID_ARGUMENT', `${tool} 接受了 ${JSON.stringify(input)}`);
    }
  });

  it('必填字段缺失被拒绝', async () => {
    const missingPath = errorOf(await callTool(h, 'file_read', { workspace_id: 'w' })).error;
    assert.equal(missingPath.code, 'INVALID_ARGUMENT');
    assert.equal(missingPath.details?.['field'], 'path');

    const missingWorkspace = errorOf(await callTool(h, 'file_list', {})).error;
    assert.equal(missingWorkspace.code, 'INVALID_ARGUMENT');
    assert.equal(missingWorkspace.details?.['field'], 'workspace_id');
  });

  it('需要票据的工具清单精确；change_apply 使用逐目录写授权', () => {
    // 前一条性质（除例外外全部不需要票据）使「读取类调用捎带写入」在结构上
    // 不成立：`resolveWorkspaceAccess` 传的 `presented` 恒为
    // `{generation:null, policy_version:null}`，一个 requires_ticket 的动作
    // 在那条路径上不可能通过判定。
    //
    // 例外不是靠注释成立的：需要票据的工具必须先验签读取票据、
    // 从票据里取代次再交给判定。把例外收成一个具名的集合，是为了让
    // 「将来又多了一个」在这里当场失败 —— 多出来的那一个如果照抄默认路径，
    // 它会在运行时**每次都**被拒，而那看起来像是「功能没做好」，
    // 不像是一条策略约束。
    //
    // file_create / file_delete 不依赖先前的读取；file_edit 与 change_prepare 共用票据策略。
    const ticketed = Object.entries(TOOL_POLICY_ACTIONS)
      .filter(([, action]) => action !== null && ACTION_SPECS[action].requires_ticket)
      .map(([tool]) => tool)
      .sort();
    assert.deepEqual(ticketed, ['change_apply', 'change_prepare', 'change_revert_prepare', 'file_edit']);

    assert.equal(ACTION_SPECS.change_apply.capability, 'propose');
    for (const action of Object.values(ACTION_SPECS)) {
      assert.equal(action.requires_approval, false, '逐次人工批准不是策略层的权限位');
    }
  });

  it('审计守卫的两张工具表恰好把已实现工具分成两半，一个不漏', () => {
    // 这条性质是**在写 LWB-032 的真盘用例时发现缺的**：`change_apply`
    // 与 `change_revert_prepare` 当时不在任何一张表里，于是
    // `isToolOperation()` 对它们回 false —— 后果是三条静默的失效：
    //
    //   1. 全局暂停拦不住 `change_apply`：`leased` 为 false，
    //      `guard.ts` 第 1 步整段跳过。操作者按下「停」之后，
    //      一条已批准的修改集仍然会被写进用户文件；
    //   2. 返回前的复查（`recheck`）不再运行；
    //   3. `rowsOf(operation, envelope.data)` 不再运行，审计里那次调用的
    //      `file_access` 落成 `[]` —— **而 `[]` 断言的是「没碰任何文件」**，
    //      比 `null`（没执行到能提取的程度）更坏：它是一句假话。
    //
    // 三件事都不报错、都不影响用例通过，因此这条性质必须由一句断言钉住，
    // 而不是靠「新增工具时记得加进某张表」。分区（而不是并集）是有意的：
    // 并集能发现「漏了一个」，分区还额外发现「两边都写了」——
    // 后者会让同一个工具同时受两套判定，而没人会去读那两套的交集。
    const workspace = new Set<string>(WORKSPACE_TOOL_NAMES);
    const nonWorkspace = new Set<string>(NON_WORKSPACE_TOOL_NAMES);

    const overlap = [...workspace].filter((name) => nonWorkspace.has(name)).sort();
    assert.deepEqual(overlap, [], '同一张工具名不得同时出现在两张表里');

    const covered = new Set<string>([...workspace, ...nonWorkspace]);
    const missing = [...IMPLEMENTED_TOOL_NAMES].filter((name) => !covered.has(name)).sort();
    assert.deepEqual(
      missing,
      [],
      '这些已实现的工具不在任何一张表里：它们会绕过暂停、绕过返回前复查，审计里也不记文件范围',
    );

    // 反向也要成立：表里不得有**没有实现**的名字 —— 那会让
    // `isToolOperation` 对一个不存在的东西回 true，而守卫会照着它
    // 去读文件范围，读到的是空。
    const unknown = [...covered].filter(
      (name) => !(IMPLEMENTED_TOOL_NAMES as readonly string[]).includes(name),
    ).sort();
    assert.deepEqual(unknown, [], '这两张表里出现了本版本没有实现的工具名');
  });

  it('别名里的本机路径不会进入结果', async () => {
    const leaky = await makeToolHarness({ gates: GATES_ON });
    try {
      leaky.repos.connections.create({
        id: 'conn-leaky-alias',
        principal_kind: 'model_surface',
        principal_id: 'principal-leaky',
        alias: 'D:\\私事\\项目',
        // 新建的连接默认是**停用**的（`ConnectionsRepo.create` 的默认值），
        // 这个用例要验的是别名出站，不是启用状态。
        enabled: true,
      });
      const status = dataOf<BridgeStatusData>(
        await callTool(leaky, 'bridge_status', {}, leaky.contextFor('conn-leaky-alias')),
      );
      assert.equal(status.connection_alias, '(未命名)');
      assertNoAbsolutePath(status, 'bridge_status');
    } finally {
      leaky.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 验收 3：跨连接隔离
// ---------------------------------------------------------------------------

describe('跨连接隔离（验收 3：两条连接不能读对方的工作区）', () => {
  let h!: ToolHarness;

  before(async () => {
    h = await makeToolHarness({ gates: GATES_ON });
  });
  after(() => {
    h.close();
  });

  it('装置本身是交叉缺失的：两条连接各只被授权一个工作区', async () => {
    const adapterList = dataOf<WorkspaceListData>(await callTool(h, 'workspace_list', {}));
    assert.deepEqual(
      adapterList.workspaces.map((w) => w.workspace_id),
      [h.workspace.id],
    );

    const otherList = dataOf<WorkspaceListData>(
      await callTool(h, 'workspace_list', {}, h.contextFor(OTHER_CONNECTION)),
    );
    assert.deepEqual(
      otherList.workspaces.map((w) => w.workspace_id),
      [h.otherWorkspace.id],
    );
  });

  it('读对方的工作区：未授权', async () => {
    const viaFileRead = errorOf(
      await callTool(h, 'file_read', { workspace_id: h.otherWorkspace.id, path: 'README.md' }),
      '适配器读对方工作区',
    ).error;
    assert.equal(viaFileRead.code, 'WORKSPACE_NOT_GRANTED');

    const viaGit = errorOf(
      await callTool(
        h,
        'git_status',
        { workspace_id: h.workspace.id },
        h.contextFor(OTHER_CONNECTION),
      ),
      '另一条连接读适配器工作区',
    ).error;
    assert.equal(viaGit.code, 'WORKSPACE_NOT_GRANTED');
  });

  it('「不存在」与「存在但未授权」的回答逐字相同（没有存在性预言机）', async () => {
    const ungranted = errorOf(
      await callTool(h, 'file_read', { workspace_id: h.otherWorkspace.id, path: 'README.md' }),
    );
    const nonexistent = errorOf(
      await callTool(h, 'file_read', { workspace_id: 'ws-does-not-exist', path: 'README.md' }),
    );

    assert.deepEqual(nonexistent.error, ungranted.error);
    // 关联 ID 仍然回显，且**不随答案变化** —— 它对两个请求是同一个值，
    // 因此也不可能成为「这个 id 存不存在」的旁路。
    assert.equal(nonexistent.request_id, ungranted.request_id);
    assert.ok(ungranted.request_id.length > 0);
  });

  it('撤掉授权行之后立刻拒绝（不依赖任何缓存）', async () => {
    const revocable = await makeToolHarness({ gates: GATES_ON });
    try {
      const allowed = await callTool(revocable, 'file_read', {
        workspace_id: revocable.workspace.id,
        path: 'README.md',
      });
      assert.equal(allowed.ok, true, '撤权前应当能读');

      revocable.repos.grants.put({
        id: 'grant-adapter',
        connection_id: ADAPTER_CONNECTION,
        workspace_id: revocable.workspace.id,
        capabilities: ['read', 'list', 'search', 'git_read', 'propose'],
        enabled: false,
      });

      const after = errorOf(
        await callTool(revocable, 'file_read', {
          workspace_id: revocable.workspace.id,
          path: 'README.md',
        }),
      ).error;
      assert.equal(after.code, 'WORKSPACE_NOT_GRANTED');
    } finally {
      revocable.close();
    }
  });

  it('授权行只收窄不叠加：ws-A 上的能力不能用于 ws-B', async () => {
    const narrowed = await makeToolHarness({ gates: GATES_ON });
    try {
      // A 上给 read，B 上给 git_read —— 并集形态的实现会让 A 也能跑 git_status。
      narrowed.grant(ADAPTER_CONNECTION, narrowed.workspace.id, ['read', 'list']);
      narrowed.grant(ADAPTER_CONNECTION, narrowed.otherWorkspace.id, ['git_read']);

      // 契约上的错误码是 NOT_AUTHORIZED（稳定、粗粒度），
      // 而「缺的是哪一项能力」在机读的 policy_reason 里。
      const viaA = errorOf(
        await callTool(narrowed, 'git_status', { workspace_id: narrowed.workspace.id }),
      ).error;
      assert.equal(viaA.code, 'NOT_AUTHORIZED');
      assert.equal(viaA.details?.['policy_reason'], 'CAPABILITY_NOT_GRANTED');

      const viaB = errorOf(
        await callTool(narrowed, 'file_read', { workspace_id: narrowed.otherWorkspace.id, path: 'a.ts' }),
      ).error;
      assert.equal(viaB.code, 'NOT_AUTHORIZED');
      assert.equal(viaB.details?.['policy_reason'], 'CAPABILITY_NOT_GRANTED');
    } finally {
      narrowed.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 验收 2（后半）：真实夹具仓库上的结果契约
// ---------------------------------------------------------------------------

describe('结果契约（夹具仓库）', () => {
  let h!: ToolHarness;
  let manifest!: FixtureManifest;

  before(async () => {
    manifest = await loadManifest();
    h = await fixtureHarness();
  });
  after(() => {
    h.close();
  });

  it('七个工具的成功结果都符合各自的输出 schema', async () => {
    const calls: readonly (readonly [ImplementedToolName, Record<string, unknown>])[] = [
      ['bridge_status', {}],
      ['workspace_list', {}],
      ['file_list', { workspace_id: h.workspace.id, path: '' }],
      ['file_read', { workspace_id: h.workspace.id, path: 'newline/lf.txt' }],
      ['text_search', { workspace_id: h.workspace.id, query: 'no-trailing-2', path: 'newline' }],
      ['git_status', { workspace_id: h.workspace.id }],
      ['git_diff', { workspace_id: h.workspace.id, path: '文档/设计说明.md' }],
    ];

    for (const [tool, input] of calls) {
      const envelope = await callTool(h, tool, input);
      assert.equal(envelope.ok, true, `${tool} 应当成功：${JSON.stringify(envelope)}`);
      assertConforms(tool, envelope);
      assertNoAbsolutePath(dataOf(envelope), tool);
    }
  });

  it('bridge_status 如实区分运行能力与未完成的外部验收状态', async () => {
    const closed = await makeToolHarness({ gates: GATES_OFF });
    try {
      const status = dataOf<BridgeStatusData>(await callTool(closed, 'bridge_status', {}));
      assert.equal(status.capabilities.read_enabled, true);
      assert.equal(status.capabilities.git_enabled, true);
      assert.equal(status.capabilities.direct_write_enabled, true);
      assert.equal(status.gates.g0_platform_verified, false);
      assert.ok(status.limitations.some((line) => line.includes('只作状态提示')));
      assert.ok(status.limitations.some((line) => line.includes('显式授权的工作区')));
      // 暂停是**函数**，不是字段（LWB-034）：它必须每次现查状态库，
      // 因此这里断言的是「问它一下」，而不是读一个构造时的快照。
      assert.equal(closed.deps.status().paused(), false);
      assert.equal(status.paused, false);
      assert.equal(status.paused_at, null);
      assert.deepEqual(status.pause, {
        stopping_writes: 0,
        unrevoked_change_sets: 0,
        recovery_operations: 0,
      });
    } finally {
      closed.close();
    }
  });

  it('file_list 只给相对路径，且硬拒绝的文件不出现在条目里', async () => {
    const root = dataOf<FileListData>(
      await callTool(h, 'file_list', { workspace_id: h.workspace.id, path: '' }),
    );
    assert.equal(root.path, '');
    assert.equal(root.truncated, false);
    assert.equal(root.consistency, 'per_file');
    assert.ok(root.entries.length >= 5, `根目录应当有多个条目，实际 ${root.entries.length}`);

    const names = root.entries.map((entry) => entry.name);
    assert.ok(names.includes('README.md'));
    assert.ok(names.includes('src'));

    for (const entry of root.entries) {
      assert.ok(!entry.path.startsWith('/') && !entry.path.includes('\\'), `条目路径 ${entry.path}`);
      assert.ok(!entry.path.split('/').includes('..'), `条目路径 ${entry.path}`);
      assert.equal(entry.path, entry.name, '根目录下的条目路径就是名字');
    }

    // 「排除」是**性能**排除（搜索不走这些目录），不是安全拒绝 ——
    // 因此它在结果里如实标出来，而不是让那些目录凭空消失。
    const byName = new Map(root.entries.map((entry) => [entry.name, entry]));
    assert.equal(byName.get('node_modules')?.excluded, true);
    assert.equal(byName.get('.git')?.excluded, true);
    assert.equal(byName.get('src')?.excluded, false);
    assert.ok(root.excluded_entries >= 2);

    // depth 默认 0，因此这次列举**不完整**。不完整必须说出来：一个静默截短的
    // 目录列举会让模型把「这一层没看到子目录里的东西」说成「仓库里没有」。
    assert.equal(root.incomplete, true);
    assert.ok(root.incomplete_reason?.includes('depth'), root.incomplete_reason ?? '(无说明)');

    const secrets = dataOf<FileListData>(
      await callTool(h, 'file_list', { workspace_id: h.workspace.id, path: 'secrets' }),
    );
    const secretNames = secrets.entries.map((entry) => entry.name);
    assert.ok(!secretNames.includes('.env'), '硬拒绝的 .env 不应出现在列举结果里');
    assert.ok(!secretNames.includes('aws.env'));
    assert.ok(!secretNames.includes('id_rsa'));
    // 被摘掉的条目只计数，不列名（理由见 packages/files/src/list.ts）。
    assert.ok(secrets.denied_entries >= 1, '硬拒绝的条目应当被计入 denied_entries');
  });

  it('file_read 的哈希 / 行数 / 编码与夹具清单一致', async () => {
    const entry = findFile(manifest, 'newline/lf.txt');
    const data = dataOf<FileReadData>(
      await callTool(h, 'file_read', { workspace_id: h.workspace.id, path: 'newline/lf.txt' }),
    );

    assert.equal(data.path, 'newline/lf.txt');
    assert.equal(data.source, 'disk');
    assert.equal(data.sha256, entry.sha256);
    assert.equal(data.total_lines, entry.lineCount);
    assert.equal(data.bytes_returned, entry.bytes);
    assert.equal(data.newline, entry.newline);
    assert.equal(data.bom, entry.hasBom);
    assert.equal(data.editable, entry.editable);
    assert.equal(data.redacted, false);
    assert.equal(data.truncated, false);
    assert.ok(data.read_token.length > 0, '完整读取应当签发读取票据');
    assert.equal(data.next_cursor, null);
    assert.equal(data.content, 'lf-line-1\nlf-line-2\nlf-line-3\n');
  });

  it('超过上限的文件：截断，而且拿不到可编辑票据', async () => {
    const entry = findFile(manifest, 'large/big.txt');
    const data = dataOf<FileReadData>(
      await callTool(h, 'file_read', { workspace_id: h.workspace.id, path: 'large/big.txt' }),
    );

    assert.equal(data.truncated, true);
    assert.equal(data.editable, false);
    assert.ok(data.editable_blockers.length >= 1, '截断必须给出可编辑阻断理由');
    assert.ok(data.bytes_returned < entry.bytes, '返回字节数应当小于整个文件');
    // 票据仍然签发（后续分页要用），但**这个文件**的票据不可编辑。
    assert.ok(data.read_token.length > 0);
  });

  it('高置信度秘密：读取被脱敏，且同样拿不到可编辑票据', async () => {
    const data = dataOf<FileReadData>(
      await callTool(h, 'file_read', { workspace_id: h.workspace.id, path: 'secrets/token.txt' }),
    );
    assert.equal(data.redacted, true);
    assert.equal(data.editable, false);
    assert.ok(!data.content.includes('ghp_'), '脱敏后的正文里不应出现 token');
    assert.ok(!data.content.includes('xoxb-'), '脱敏后的正文里不应出现 token');
  });

  it('硬拒绝的文件：读取被策略拒绝，理由是可机读的规则名而不是路径', async () => {
    for (const relPath of ['secrets/.env', 'config/.env.example']) {
      const error = errorOf(
        await callTool(h, 'file_read', { workspace_id: h.workspace.id, path: relPath }),
      ).error;
      assert.equal(error.code, 'POLICY_DENIED', `${relPath} 应当被拒绝`);
      assert.equal(error.details?.['hard_deny_rule'], 'HD-ENV', `${relPath} 的拒绝理由`);
      assertNoAbsolutePath(error, `${relPath} 的错误载荷`);
    }
  });

  it('text_search：只报字面量命中，且不越过硬拒绝边界', async () => {
    const hits = dataOf<TextSearchData>(
      await callTool(h, 'text_search', {
        workspace_id: h.workspace.id,
        query: 'no-trailing-2',
        path: 'newline',
      }),
    );
    assert.equal(hits.matches.length, 1, JSON.stringify(hits.matches));
    assert.equal(hits.matches[0]?.path, 'newline/no-trailing-newline.txt');
    assert.equal(hits.matches[0]?.line_number, 2);
    assert.ok(hits.scope.scanned_files >= 1);

    const secretHits = dataOf<TextSearchData>(
      await callTool(h, 'text_search', {
        workspace_id: h.workspace.id,
        query: 'GITHUB_TOKEN',
        path: 'secrets',
      }),
    );
    for (const match of secretHits.matches) {
      assert.ok(!match.snippet.includes('ghp_'), '搜索片段里出现了 token 原文');
      assert.ok(!match.snippet.includes('xoxb-'), '搜索片段里出现了 token 原文');
    }
    assert.ok(
      secretHits.scope.denied_files + secretHits.scope.secret_files >= 1,
      '秘密文件应当被计为跳过，而不是被静默略过',
    );
  });

  it('git_status：状态与夹具的 porcelain 对得上，被摘掉的路径只计数不列名', async () => {
    const data = dataOf<GitStatusData>(
      await callTool(h, 'git_status', { workspace_id: h.workspace.id }),
    );

    assert.equal(data.limited_to_authorized_paths, true);
    assert.equal(data.head_commit, manifest.head_commit);
    assert.equal(data.truncated, false);

    const byPath = new Map(data.entries.map((entry) => [entry.path, entry]));

    // 夹具清单里的 porcelain 记录，逐条对回契约字段：
    //   " D src/deleted.ts"      索引未变、工作区已删
    //   "A  src/staged.ts"       索引新增、工作区未变
    //   " M 文档/设计说明.md"    索引未变、工作区已改
    //   "?? src/untracked.ts"    未跟踪
    assert.equal(byPath.get('src/deleted.ts')?.worktree, 'deleted');
    assert.equal(byPath.get('src/staged.ts')?.head, 'added');
    assert.equal(byPath.get('文档/设计说明.md')?.worktree, 'modified');
    assert.ok(byPath.has('src/untracked.ts'));
    assert.deepEqual([...manifest.git_status_porcelain].length, 4);

    // 被硬拒绝的路径**只计数、不列名**（理由见 packages/files/src/list.ts）。
    // 逐个点名而不是「整个 secrets/ 都不许出现」：`secrets/token.txt` 的名字
    // 本身不在硬拒绝规则里（它靠内容脱敏），它**应当**以普通条目的样子出现。
    const hidden = ['secrets/.env', 'secrets/aws.env', 'secrets/id_rsa', 'config/.env.example'];
    for (const relPath of hidden) {
      assert.ok(!byPath.has(relPath), `硬拒绝的路径 ${relPath} 不应出现在 git_status 条目里`);
    }
    assert.equal(byPath.get('secrets/token.txt')?.worktree, 'unmodified');
    assert.ok(data.policy_hidden_count >= hidden.length, '被摘掉的路径数应当如实报出');

    // 未跟踪：HEAD 侧是「不存在」，工作区侧是「未跟踪」——两个不同的取值。
    assert.equal(byPath.get('src/untracked.ts')?.head, 'absent');
    assert.equal(byPath.get('src/untracked.ts')?.worktree, 'untracked');
  });

  it('git_diff：按授权路径解析新旧内容，差异是原始字节差异', async () => {
    const data = dataOf<GitDiffData>(
      await callTool(h, 'git_diff', { workspace_id: h.workspace.id, path: '文档/设计说明.md' }),
    );

    assert.equal(data.path, '文档/设计说明.md');
    assert.equal(data.comparison, 'head_vs_worktree');
    assert.equal(data.base_commit, manifest.head_commit);
    // V1 的可比对象永远不是提交（新侧是索引或工作区）。
    assert.equal(data.compare_commit, null);
    assert.equal(data.binary, false);
    assert.equal(data.redacted, false);
    assert.ok(data.hunks.length >= 1, '该文件在基线提交后被追加过，差异不应为空');
    assert.ok(data.hunks.some((hunk) => hunk.lines.some((line) => line.startsWith('+'))));
    assert.ok(data.old_sha256 !== null && data.new_sha256 !== null);
    assert.notEqual(data.old_sha256, data.new_sha256);
    assert.ok(data.note.length > 0, '差异结果必须带上比较对象的说明');
  });

  it('git_diff 同样不越过硬拒绝边界', async () => {
    const error = errorOf(
      await callTool(h, 'git_diff', { workspace_id: h.workspace.id, path: 'secrets/.env' }),
    ).error;
    assert.equal(error.code, 'POLICY_DENIED');
  });

  it('撤销目录 read grant 后，读取在判定层被拒绝', async () => {
    const closed = await makeToolHarness({
      root: TESTREPO_DIR,
      root_file_id: fileIdOf(TESTREPO_DIR),
      ops: makeFixtureOps(),
      gates: GATES_OFF,
    });
    try {
      const grant = closed.repos.grants.find(ADAPTER_CONNECTION, closed.workspace.id);
      assert.ok(grant !== null);
      closed.repos.grants.put({ ...grant, capabilities: grant.capabilities.filter((item) => item !== 'read') });
      const error = errorOf(
        await callTool(closed, 'file_read', { workspace_id: closed.workspace.id, path: 'README.md' }),
      ).error;
      assert.equal(error.code, 'NOT_AUTHORIZED');
      assert.equal(error.details?.['policy_reason'], 'CAPABILITY_NOT_GRANTED');
    } finally {
      closed.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 错误载荷
// ---------------------------------------------------------------------------

describe('错误载荷', () => {
  let h!: ToolHarness;

  before(async () => {
    h = await makeToolHarness({ gates: GATES_ON });
  });
  after(() => {
    h.close();
  });

  it('处理器从不抛异常：注定失败的调用也返回信封', async () => {
    const inputs: readonly (readonly [string, unknown])[] = [
      ['file_read', { workspace_id: 'ws-missing', path: 'a.ts' }],
      ['file_read', { workspace_id: 'ws-missing' }],
      ['file_list', { workspace_id: 'ws-missing', path: '' }],
      ['text_search', { workspace_id: 'ws-missing', query: 'x' }],
      ['git_status', { workspace_id: 'ws-missing' }],
      ['git_diff', { workspace_id: 'ws-missing', path: 'a.ts' }],
      ['bridge_status', { nope: 1 }],
      ['workspace_list', { nope: 1 }],
    ];
    for (const [tool, input] of inputs) {
      // `callTool` 自身断言「返回的是信封」—— 抛出去就会在那里失败。
      const envelope = await callTool(h, tool, input);
      assert.equal(envelope.ok, false, `${tool} ${JSON.stringify(input)}`);
    }
  });

  it('未预期的异常折成 INTERNAL_ERROR，且不带原始 message', () => {
    const payload = toModelPayload(new Error('D:\\本机\\boom.ts 读取失败'));
    assert.equal(payload.code, 'INTERNAL_ERROR');
    assert.equal(payload.message, BRIDGE_ERRORS.INTERNAL_ERROR.summary);
    assert.equal(payload.details?.['reason'], 'UNEXPECTED_ERROR');
    assertNoAbsolutePath(payload, 'INTERNAL_ERROR 载荷');

    // 本地那一份不丢：诊断信息只是不出站。
    assert.equal(
      describeForLocalAudit(new Error('D:\\本机\\boom.ts 读取失败')),
      'Error: D:\\本机\\boom.ts 读取失败',
    );
  });

  it('带本机路径的 BridgeError 消息被整句替换，不就地打码', () => {
    const payload = toModelPayload(new BridgeError('NOT_FOUND', 'D:\\本机\\boom.ts 不存在。'));
    assert.equal(payload.code, 'NOT_FOUND');
    assert.equal(payload.message, BRIDGE_ERRORS.NOT_FOUND.summary);
    assert.equal(isSafeForModel('D:\\本机\\boom.ts 不存在。'), false);

    // 安全的那一份原样通过 —— 否则上面那条只是「这个函数总是替换」。
    const safe = toModelPayload(new BridgeError('NOT_FOUND', '工作区内没有这个路径。'));
    assert.equal(safe.message, '工作区内没有这个路径。');
  });
});
