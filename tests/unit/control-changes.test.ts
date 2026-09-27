/**
 * LWB-036 单元测试：修改集的**复核读取**（`changes.list` / `changes.get`）。
 *
 * ## 这一层为什么必须另开一条读取路径
 *
 * 工具面的读取有两条与「复核」不相容的性质，而它们各自都是**对的**：
 *
 * | | 工具面（`change_get` / `change_list`） | 控制台（`changes.get` / `changes.list`） |
 * | --- | --- | --- |
 * | 归属判据 | `owner_connection_id === 本连接` | **本机**（不加 owner 条件） |
 * | 身份 | 已注册的连接行 | 一次已鉴权的本机会话 |
 *
 * 「批准方看得到提议方的东西」不是一次放宽，它就是审批这件事的定义：
 * 一个只能看到自己提出的修改集的批准方，批准不了任何东西。
 *
 * 因此 A 组把**两侧的结论放在一起断言**：同一条修改集，模型侧读不到、
 * 控制台读得到。只断言其中一侧会漏掉「有人把 `requireOwned` 顺手拿掉了」
 * 那种改法 —— 那时两侧都读得到，而每条单独的断言都还是绿的。
 *
 * ## 装置：真仓储、真快照、真判定
 *
 * 用内存 SQLite 与**真 `BlobStore`**（临时目录、`putAndRegister` 落盘并回读校验），
 * 理由与 `tests/unit/changes-invalidation.test.ts` 相同：本文件要断的东西里
 * 有一条是**字节相等**（B3），而两段空内容是逐字节相同的 —— 桩在那里会让
 * 那条断言空洞地成立。
 *
 * 判定**不是桩**。B 组要问「闸门关掉时控制台拿得到什么」，而闸门就是
 * `@lwb/policy` 的 `decide()`：造一个假的 `PolicyDecision` 只能证明我写了
 * 一个会读 `allow` 的 if。工具面那一侧（B3 的对照）同样走真 `decide()`，
 * 只是连接视图与 audience 换成模型侧的。
 *
 * ## 与 `control-plane.test.ts` 的分工
 *
 * 那边测的是**传输层的门**（来源、CSRF、nonce、能力表），两个操作在那里是桩，
 * 文件里写明了「复核读取的语义（范围、闸门、归属）的装置在本文件」。
 * 两边不重测对方的那一半。
 *
 * ## 本文件**不**对应某一条验收标准
 *
 * LWB-036 的三条验收标准各自的装置是：标准 1 在
 * `apps/console/tests/change-detail-view.spec.ts`（批准入口与复核覆盖），
 * 标准 2 在 `tests/windows/daemon-apply-tool.test.ts` §5b（本地点击与工具调用
 * 抢同一条修改集），标准 3 在那份组件测试的头部说明里（它是一条关于
 * **没有任何代码能把外部资源渲染出来**的结构性事实，不是一条可以用夹具断言的
 * 属性）。本文件服务的是**步骤 1 的前半句**：「按文件分页、完整内容查看」
 * 需要一份控制台读得到、且与工具面逐字节相同的内容 —— 没有这条读取路径，
 * 界面上的一切都无从谈起。
 *
 * ## 一处刻意构造的、生产上不会自然出现的状态
 *
 * B5 把 `workspaces` 行删掉，以触达 `WORKSPACE_MISSING`。真库里
 * `changesets.workspace_id` 是 `ON DELETE RESTRICT`，因此这条路径在生产上
 * 不可达（工作区是软删除）。构造它是因为那段代码问的问题正是「万一真发生了
 * 会怎样」，而它的答案必须是拒绝 —— 一个按「能读」处理的兜底会把
 * 「没有工作区行、无从而知」变成一个「允许」。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { BlobStore } from '@lwb/blob-store';
import { canonicalChangeDigest, changeGetDataOf, changeListDataOf, ownedChangeOf } from '@lwb/changes';
import { BridgeError, CONTRACT_VERSION, LIMITS } from '@lwb/contracts';
import type { CapabilityFlags, ChangeDiffPage, ChangeSetView } from '@lwb/contracts';
import { EgressBudgetStore } from '@lwb/egress';
import { OperationRegistry } from '@lwb/ipc';
import type { RequestContext } from '@lwb/ipc';
import { decide } from '@lwb/policy';
import type { PolicyDecision } from '@lwb/policy';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { ChangeItemInput, OpenDatabaseResult, WorkspaceRecord } from '@lwb/persistence';

import {
  CHANGE_OPERATION_NAMES,
  CHANGES_READ_CAPABILITY,
  registerChangeOperations,
} from '../../apps/daemon/src/control/changes.ts';
import { workspaceViewOf } from '../../apps/daemon/src/tools/access.ts';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const CONNECTION = 'conn_review_owner';
const OTHER_CONNECTION = 'conn_review_other';
const WORKSPACE = 'ws_review';
/** 专供 B5：它会被真的删掉，不能是别处也在用的那一个。 */
const WORKSPACE_B5 = 'ws_review_b5';
const PRINCIPAL = 'principal_review';
const GENERATION = 4;
const POLICY_VERSION = 2;
const MODE = 'read_propose_apply_with_local_approval';
/** 控制台会话标识由控制平面写成 `console:<session_id>`。 */
const CONSOLE = 'console:lwb-036-review';
const T0_MS = Date.parse('2026-09-25T10:00:00.000Z');
const T0 = new Date(T0_MS).toISOString();
/** 出站预算：本文件不测预算，给一个够大的数免得它成为失败原因。 */
const BUDGET_BYTES_PER_HOUR = 1_000_000;

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

let opened: OpenDatabaseResult;
let repos: Repositories;
let blobs: BlobStore;
let root = '';
/** id 序号。每次 `resetDb` 归零，因此失败信息里的 id 是稳定的。 */
let seq = 0;
/** 快照目录序号。**不**归零：两个库共用一个 objects 目录没有意义。 */
let gen = 0;

const nextId = (prefix: string): string => `${prefix}_${(seq += 1).toString().padStart(4, '0')}`;

/**
 * 门禁。
 *
 * **默认全开**，只有 B1 去关它。全开是刻意的默认值：其余各组要答的是别的
 * 问题，而一个默认关着的装置会让每一条用例都被 `content_gate` 挡在内容之外
 * —— 那时它们的断言会因为一个与本组无关的理由失败。
 */
let gates: CapabilityFlags = {
  read_enabled: true,
  git_enabled: true,
  proposal_enabled: true,
  direct_write_enabled: true,
  // 第五项是**逐工作区**的事实（待恢复），在生产里由工作区状态叠加出来，
  // 与门禁的四项不同源。夹具里没有待恢复的工作区，因此恒为 false。
  recovery_required: false,
};

/**
 * 能力开关的来源。与生产装配同一个形状：**按工作区问**，而不是一个全局常量。
 *
 * 本文件里它的返回值与工作区无关，但签名保留成生产的样子 —— 收窄成一个
 * `CapabilityFlags` 会让下面每一处都是「测试专用的形状」，而那种形状迟早
 * 会与生产分开，那时被测的就是测试自己了。
 */
function flagsFor(_workspace: WorkspaceRecord): CapabilityFlags {
  return gates;
}

const budgets = new EgressBudgetStore({
  limit_bytes_per_hour: BUDGET_BYTES_PER_HOUR,
  now: () => T0_MS,
});

const NOW = (): number => T0_MS;

function consoleContext(requestId: string): RequestContext {
  return { audience: 'console', connection_id: CONSOLE, pid: process.pid, request_id: requestId };
}

function modelContext(requestId: string): RequestContext {
  return {
    audience: 'mcp-adapter',
    connection_id: CONNECTION,
    pid: process.pid,
    request_id: requestId,
  };
}

function registryFor(): OperationRegistry {
  const registry = new OperationRegistry();
  registerChangeOperations(registry, {
    repos,
    blobs,
    budgets,
    capability_flags: flagsFor,
    now: NOW,
  });
  return registry;
}

/**
 * 调一个已注册的处理器。
 *
 * 每个操作名都先断言**已注册**：否则失败会指向 `undefined.handler`，
 * 而那个报错读起来像装置坏了，不像「这个操作没被注册」。
 */
async function call(
  name: string,
  input: unknown,
  context: RequestContext,
): Promise<Record<string, unknown>> {
  const definition = registryFor().lookup(name);
  assert.ok(definition !== undefined, `${name} 应当已注册`);
  return (await definition.handler(input, context)) as Record<string, unknown>;
}

/**
 * 取回错误，报出**码**与**稳定理由**两样。
 *
 * 只比码会分不清是哪一种拒绝：`POLICY_DENIED` 同时覆盖「动作需要的能力没被
 * 授予」与「文件规则硬拒绝」，而这两件事要给操作者看的话完全不同。
 */
function refusalOf(error: unknown): { readonly code: string; readonly reason: string } {
  assert.ok(error instanceof BridgeError, `期望 BridgeError，实际是 ${String(error)}`);
  const details = error.details ?? {};
  const reason = details['reason'] ?? details['policy_reason'];
  return { code: error.code, reason: typeof reason === 'string' ? reason : error.code };
}

async function caught(
  run: () => Promise<unknown> | unknown,
): Promise<{ readonly code: string; readonly reason: string }> {
  try {
    await run();
  } catch (error) {
    return refusalOf(error);
  }
  assert.fail('这一步应当被拒绝');
}

function resetDb(): void {
  if (opened !== undefined) closeDatabase(opened.db);
  seq = 0;
  opened = openDatabase({ path: ':memory:' });
  repos = new Repositories(opened.db, () => T0);
  blobs = new BlobStore({
    objectsRoot: path.join(root, `objects-${(gen += 1).toString().padStart(3, '0')}`),
    registry: repos.blobs,
    newId: () => nextId('blob'),
  });
  gates = {
    read_enabled: true,
    git_enabled: true,
    proposal_enabled: true,
    direct_write_enabled: true,
    recovery_required: false,
  };

  for (const id of [CONNECTION, OTHER_CONNECTION]) {
    repos.connections.create({
      id,
      principal_kind: 'model_surface',
      principal_id: PRINCIPAL,
      alias: `测试连接 ${id}`,
      enabled: true,
    });
  }
  for (const id of [WORKSPACE, WORKSPACE_B5]) {
    repos.workspaces.create({
      id,
      alias: `夹具 ${id}`,
      kind: 'directory',
      canonical_root: `C:\\lwb-036-review\\${id}`,
      volume_id: `vol-${id}`,
      root_file_id: `root-${id}`,
      policy_version: POLICY_VERSION,
      mode: MODE,
    });
    // 建出来是第 1 代，而夹具声明的代次不是 1。把它推到第 4 代，而不是把
    // 夹具改成 1：两边都是 1 的时候，「代次比对」这条断言在做错事时也会通过。
    while (repos.workspaces.requireById(id).generation < GENERATION) {
      repos.workspaces.bumpGeneration(id, POLICY_VERSION);
    }
  }
}

interface Fixture {
  readonly change_id: string;
  readonly digest: string;
  readonly path: string;
}

/**
 * 建一条**内容真实**的修改集：字节经 `putAndRegister` 落盘并回读校验，
 * 摘要用 `canonicalChangeDigest` 真算一遍。
 *
 * 两者都不是可有可无的：B3 要比对两侧渲染出来的差异，而那两份差异来自
 * 快照库里**真的读得回来的字节**；摘要则是「批准绑定到哪一份内容」的凭据。
 */
async function makeChange(
  seed: string,
  options: {
    readonly owner?: string;
    readonly path?: string;
    readonly workspace_id?: string;
  } = {},
): Promise<Fixture> {
  const owner = options.owner ?? CONNECTION;
  const workspaceId = options.workspace_id ?? WORKSPACE;
  const relPath = options.path ?? `src/${seed}.ts`;
  const beforeText = `// ${seed}\nconst x = 1;\n`;
  const afterText = `// ${seed}\nconst x = 2;\n`;

  const before = await blobs.putAndRegister(Buffer.from(beforeText, 'utf8'), { id: nextId('blob') });
  const after = await blobs.putAndRegister(Buffer.from(afterText, 'utf8'), { id: nextId('blob') });

  const digest = canonicalChangeDigest({
    contract_version: CONTRACT_VERSION,
    policy_version: POLICY_VERSION,
    root_generation: GENERATION,
    workspace_id: workspaceId,
    files: [
      {
        path: relPath,
        op: 'edit_text',
        before_sha256: before.put.sha256,
        before_size: before.put.size,
        after_sha256: after.put.sha256,
        after_size: after.put.size,
        encoding: 'utf-8',
        newline: 'lf',
        bom: false,
      },
    ],
  });

  const items: ChangeItemInput[] = [
    {
      id: nextId('ci'),
      path: relPath,
      op: 'edit_text',
      base_file_id: `file-${seed}`,
      base_sha256: before.put.sha256,
      target_sha256: after.put.sha256,
      old_blob_id: before.id,
      new_blob_id: after.id,
      encoding: 'utf-8',
      bom: false,
      newline: 'lf',
      added_lines: 1,
      removed_lines: 1,
    },
  ];

  const change = repos.changes.create({
    id: nextId('chg'),
    owner_connection_id: owner,
    workspace_id: workspaceId,
    root_generation: GENERATION,
    policy_version: POLICY_VERSION,
    contract_version: CONTRACT_VERSION,
    digest,
    summary: `夹具 ${seed}`,
    expires_at: new Date(T0_MS + LIMITS.CHANGE_TTL_MS).toISOString(),
    items,
  });

  return { change_id: change.id, digest, path: relPath };
}

/**
 * 一次**工具面**的读取上下文。
 *
 * 判定走真 `decide()`，只是连接视图换成模型侧的（audience `mcp_adapter`、
 * 只授予 `read`）。这样 B3 比的是「两条真实的读取路径」，而不是
 * 「我造的判定对象」。
 */
function toolSideContext(
  connectionId: string,
  workspace: WorkspaceRecord,
): {
  readonly connection_id: string;
  readonly scope: { readonly generation: number };
  readonly decision: PolicyDecision;
  readonly budget: ReturnType<EgressBudgetStore['forConnection']>;
} {
  const decision = decide({
    connection: {
      connection_id: connectionId,
      enabled: true,
      granted_capabilities: ['read'],
      audience: 'mcp_adapter',
      granted_workspace_ids: [workspace.id],
    },
    workspace: workspaceViewOf(workspace, { capability_flags: flagsFor }),
    presented: { generation: null, policy_version: null },
    action: { action: 'snapshot_read', path: '', approval: null },
    now: NOW(),
  });
  assert.equal(decision.allow, true, '前提：工具侧这一份判定必须放行，否则比的是两条拒绝');
  return {
    connection_id: connectionId,
    scope: { generation: workspace.generation },
    decision,
    budget: budgets.forConnection(connectionId),
  };
}

/**
 * 详情响应的那几个格子。
 *
 * 写成本地接口而不是 `as` 到一大坨匿名类型：缺字段时读的人知道缺的是哪一个，
 * 而 `any` 会让「这个字段改名了」变成一次静默的 `undefined` 比较。
 */
interface Detail {
  readonly change: ChangeSetView;
  readonly workspace: Record<string, unknown> | null;
  readonly owner_connection_id: string;
  readonly operation: { readonly operation_id: string; readonly state: string } | null;
  readonly approval: { readonly state: string; readonly expires_at: string | null } | null;
  readonly content_gate: {
    readonly allows_read: boolean;
    readonly reason: string | null;
    readonly message: string | null;
  };
  readonly diff: ChangeDiffPage | null;
  readonly observed_at: string;
}

async function detailOf(changeId: string, pathArg?: string): Promise<Detail> {
  const raw = await call(
    'changes.get',
    pathArg === undefined ? { change_id: changeId } : { change_id: changeId, path: pathArg },
    consoleContext(`req_detail_${changeId}`),
  );
  return raw as unknown as Detail;
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'lwb036-review-'));
});

after(async () => {
  closeDatabase(opened.db);
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A 组：范围 —— 谁读得到什么
// ---------------------------------------------------------------------------

describe('LWB-036 A 组：复核读取的范围是本机，而不是「我的」', () => {
  before(resetDb);

  it('A1 两个操作都已注册，要求的是只属于控制台的那一项能力', () => {
    const registry = registryFor();
    assert.deepEqual([...CHANGE_OPERATION_NAMES], ['changes.list', 'changes.get']);
    for (const name of CHANGE_OPERATION_NAMES) {
      const definition = registry.lookup(name);
      assert.ok(definition !== undefined, `${name} 应当已注册`);
      assert.equal(definition.required, CHANGES_READ_CAPABILITY);
    }
  });

  it('A2 不是本地控制台：两个操作都拒绝，且说得出是哪一种拒绝', async () => {
    const change = await makeChange('a2');
    const cases: readonly (readonly [string, unknown])[] = [
      ['changes.list', {}],
      ['changes.get', { change_id: change.change_id }],
      ['changes.get', { change_id: change.change_id, path: change.path }],
    ];
    for (const [name, input] of cases) {
      const refusal = await caught(() => call(name, input, modelContext('req_a2')));
      assert.equal(refusal.code, 'NOT_AUTHORIZED', `${name} 应当拒绝模型侧`);
      assert.equal(refusal.reason, 'ORIGIN_NOT_LOCAL');
    }
  });

  it('A3 别人提议的修改集：模型侧读不到，控制台读得到', async () => {
    const theirs = await makeChange('a3', { owner: OTHER_CONNECTION });

    // 模型侧：`ownedChangeOf` 把归属与查找合成一步，回答与「不存在」逐字相同。
    const modelRefusal = await caught(() =>
      ownedChangeOf({ change_id: theirs.change_id }, CONNECTION, repos),
    );
    assert.equal(modelRefusal.code, 'NOT_FOUND', '模型侧对「不是你的」与「不存在」回答同一个');

    // 控制台：**同一个 change_id**，读得到，而且看得出提议方是谁。
    const detail = await detailOf(theirs.change_id);
    assert.equal(detail.change.change_id, theirs.change_id);
    assert.equal(detail.owner_connection_id, OTHER_CONNECTION);

    // 这两条断言必须**成对**出现。只断言控制台读得到，会放过
    // 「有人把 requireOwned 拿掉了」—— 那时模型侧也读得到，
    // 而两边各自的断言都还是绿的。
  });

  it('A4 同一批行，两个读者看到的集合不同，差别恰是 owner_connection_id', async () => {
    const mine = await makeChange('a4-mine');
    const theirs = await makeChange('a4-theirs', { owner: OTHER_CONNECTION });

    const viaModel = changeListDataOf(
      { connection_id: CONNECTION, input: { max_items: 50 } },
      { repos, blobs },
    );
    const viaConsole = (await call('changes.list', { limit: 50 }, consoleContext('req_a4'))) as {
      readonly changes: readonly Record<string, unknown>[];
      readonly truncated: boolean;
      readonly observed_at: string;
    };

    const modelIds = viaModel.changes.map((row) => row.change_id);
    const consoleIds = viaConsole.changes.map((row) => row['change_id']);

    assert.ok(modelIds.includes(mine.change_id), '模型侧要看到自己的');
    assert.ok(!modelIds.includes(theirs.change_id), '模型侧**不该**看到别人的');
    assert.ok(consoleIds.includes(mine.change_id), '控制台要看到全部');
    assert.ok(consoleIds.includes(theirs.change_id), '控制台看不到别人的话，就没有任何东西可批准');

    // 控制台那一行带着提议方 —— 复核方要核对的东西之一就是「这是谁提的」。
    const row = viaConsole.changes.find((entry) => entry['change_id'] === theirs.change_id);
    assert.equal(row?.['owner_connection_id'], OTHER_CONNECTION);
    assert.equal(
      row?.['file_count'],
      repos.changes.items(theirs.change_id).length,
      '条数与逐条 items 来自同一次读',
    );
    assert.equal(row?.['state'], 'PENDING_APPROVAL');

    assert.equal(viaConsole.truncated, false);
    assert.equal(viaConsole.observed_at, T0, '时刻来自注入的 now，不是真实当下');
  });

  it('A5 工作区是收窄条件而不是权限：给一个不存在的工作区得到空列表，不是拒绝', async () => {
    await makeChange('a5');
    const filtered = (await call(
      'changes.list',
      { workspace_id: 'ws-不存在' },
      consoleContext('req_a5'),
    )) as { readonly changes: readonly unknown[] };
    assert.deepEqual([...filtered.changes], [], '拒绝会把这个 id 是否存在变成可以穷举的答案');

    const everywhere = (await call('changes.list', {}, consoleContext('req_a5b'))) as {
      readonly changes: readonly unknown[];
    };
    assert.ok(everywhere.changes.length > 0, '不带收窄条件时应当有内容 —— 否则上一条断言是空洞的');
  });

  it('A6 找不到就是找不到：这里没有「存在但不是你的」这一格可以泄露', async () => {
    const refusal = await caught(() =>
      call('changes.get', { change_id: 'chg_不存在' }, consoleContext('req_a6')),
    );
    assert.equal(refusal.code, 'NOT_FOUND');
  });

  it('A7 入参不合法时说得出是哪个字段', async () => {
    const noId = await caught(() => call('changes.get', {}, consoleContext('req_a7a')));
    assert.equal(noId.code, 'INVALID_ARGUMENT');
    const badLimit = await caught(() => call('changes.list', { limit: 1.5 }, consoleContext('req_a7b')));
    assert.equal(badLimit.code, 'INVALID_ARGUMENT');
    const emptyPath = await caught(() =>
      call('changes.get', { change_id: 'chg_不存在', path: '' }, consoleContext('req_a7c')),
    );
    assert.equal(emptyPath.code, 'INVALID_ARGUMENT', '空路径是入参错误，不是「本修改集不含该路径」');
  });
});

// ---------------------------------------------------------------------------
// B 组：内容闸门 —— 看不到内容时必须有理由，且不能先读了再说
// ---------------------------------------------------------------------------

describe('LWB-036 B 组：内容闸门', () => {
  before(resetDb);

  it('B1 读取能力关闭：视图仍给，内容拒绝，且拒得干净', async () => {
    const change = await makeChange('b1');
    const wasOpen = gates;
    // 本组共用一个库，而 `gates` 是模块级的：关掉之后必须**恢复**，
    // 否则后面每一条用例都会因为一个与本组无关的理由失败（第一版就是这样，
    // 而现场是 B2~B5 报「闸门拒绝」，看着像被测代码坏了）。
    gates = { ...gates, read_enabled: false };

    try {
      const detail = await detailOf(change.change_id);
      assert.equal(detail.content_gate.allows_read, false);
      assert.match(detail.content_gate.reason ?? '', /^[A-Z][A-Z_]+$/, '原因必须是一个稳定 slug');
      assert.ok((detail.content_gate.message ?? '').length > 0, '还要给一句给操作者看的话');

      // 视图那一格**不过**闸门，与工具面同一口径：路径、大小、哈希、风险在
      // 修改集建立时就已经交给了模型（`change_prepare` 返回的就是这一份视图），
      // 因此它不构成新的出站。一起挡掉会让界面连「这是哪一条修改集」都说不出来。
      assert.equal(detail.change.change_id, change.change_id);

      // 内容那一次：拒。而且**拒得干净** —— 一个 `BridgeError`，带着稳定理由，
      // 与 `content_gate` 给出的必须是**同一次判定**的同一个答案。
      //
      // 这一条曾经失败，而且失败的方式正是它要防的那件事：被抛出来的是
      // `mintClearance` 的裸 `Error`（「不允许的操作不能获得出站凭证」），
      // 而那一步排在 `blobBytes` **之后** —— 快照字节已经读过一遍了。
      const refusal = await caught(() =>
        call('changes.get', { change_id: change.change_id, path: change.path }, consoleContext('req_b1b')),
      );
      assert.notEqual(refusal.code, 'INTERNAL_ERROR', '闸门拒绝不是内部错误');
      assert.equal(refusal.reason, detail.content_gate.reason, '两次拒绝必须来自同一次判定');
    } finally {
      gates = wasOpen;
    }
  });

  it('B1b 闸门关闭时**一个快照字节都不读**', async () => {
    const change = await makeChange('b1b');
    // 把快照换成一个**空目录**：真去读的话，`getVerified` 会抛一个
    // BlobMissingError。于是「拒绝的形状」就成了一次读取与否的探针 ——
    // 库还在（`registry: repos.blobs`），字节不在。
    const realBlobs = blobs;
    blobs = new BlobStore({
      objectsRoot: path.join(root, 'objects-empty-for-b1b'),
      registry: repos.blobs,
      newId: () => nextId('blob'),
    });
    const wasOpen = gates;
    gates = { ...gates, read_enabled: false };
    try {
      const refusal = await caught(() =>
        call('changes.get', { change_id: change.change_id, path: change.path }, consoleContext('req_b1b')),
      );
      assert.equal(refusal.reason, 'CAPABILITY_FLAG_DISABLED', '拒绝的理由必须是策略，不是「快照缺失」');
    } finally {
      gates = wasOpen;
      blobs = realBlobs;
    }
  });

  it('B2 闸门放行时两个格子一致：`allows_read` 为真 ⇔ 带 path 拿得到差异', async () => {
    const change = await makeChange('b2');
    const detail = await detailOf(change.change_id, change.path);
    assert.equal(detail.content_gate.allows_read, true);
    assert.equal(detail.content_gate.reason, null);
    assert.notEqual(detail.diff, null, '闸门说允许，那一次就必须真的给出差异');
    assert.equal(detail.diff?.path, change.path);
    assert.equal(detail.diff?.unified.includes('const x = 2;'), true);
    assert.equal(detail.diff?.next_cursor, null, 'V1 是单页：不发一个换不来更多内容的游标');
  });

  it('B3 控制台看到的差异与工具面**逐字节相同**', async () => {
    const change = await makeChange('b3');
    const workspace = repos.workspaces.requireById(WORKSPACE);

    const viaTool = await changeGetDataOf(
      {
        context: toolSideContext(CONNECTION, workspace),
        input: { change_id: change.change_id, path: change.path },
      },
      { repos, blobs },
    );
    const viaConsole = await detailOf(change.change_id, change.path);

    assert.notEqual(viaTool.diff, null);
    assert.equal(
      viaConsole.diff?.unified,
      viaTool.diff?.unified,
      '两侧必须渲染同一份差异：两份渲染之间的差正是「操作者批准了 A、落地的是 B」那条缝',
    );
    assert.equal(viaConsole.diff?.truncated, viaTool.diff?.truncated);
  });

  it('B4 硬拒绝的路径在控制台上同样是硬拒绝', async () => {
    const change = await makeChange('b4', { path: '.env' });
    const refusal = await caught(() =>
      call('changes.get', { change_id: change.change_id, path: '.env' }, consoleContext('req_b4')),
    );
    assert.equal(refusal.code, 'POLICY_DENIED');
    // 两次回答相同：这条判定不依赖任何一次读取，因此它在**碰快照之前**。
    const again = await caught(() =>
      call('changes.get', { change_id: change.change_id, path: '.env' }, consoleContext('req_b4b')),
    );
    assert.deepEqual(again, refusal);
  });

  it('B5 工作区行不见了就拒绝复核，绝不按「能读」处理', async () => {
    const change = await makeChange('b5', { workspace_id: WORKSPACE_B5 });

    // 前提：此刻读得到。
    assert.equal((await detailOf(change.change_id)).content_gate.allows_read, true);

    // `changesets.workspace_id` 是 `ON DELETE RESTRICT`，因此真库里删不掉
    // （工作区是软删除）。构造它，是因为被测代码要回答的正是「万一真发生了」。
    opened.db.pragma('foreign_keys = OFF');
    try {
      opened.db.prepare('DELETE FROM workspaces WHERE id = ?').run(WORKSPACE_B5);
    } finally {
      opened.db.pragma('foreign_keys = ON');
    }
    assert.equal(
      repos.workspaces.findById(WORKSPACE_B5),
      null,
      '前提：工作区行真的没了（否则本用例在测别的东西）',
    );

    const refusal = await caught(() =>
      call('changes.get', { change_id: change.change_id }, consoleContext('req_b5')),
    );
    assert.equal(refusal.code, 'INTERNAL_ERROR');
    assert.equal(refusal.reason, 'WORKSPACE_MISSING');

    // 列表与详情在这里**不同**，而这个不同是刻意的：列表只报事实
    // （那些事实来自修改集自己的行），它不需要工作区行，因此那一条仍在。
    const listed = (await call('changes.list', {}, consoleContext('req_b5b'))) as {
      readonly changes: readonly Record<string, unknown>[];
    };
    assert.notEqual(
      listed.changes.find((entry) => entry['change_id'] === change.change_id),
      undefined,
      '列表不读工作区行，因此这一条仍在',
    );
  });
});

// ---------------------------------------------------------------------------
// C 组：回报字段 —— 给什么、不给什么
// ---------------------------------------------------------------------------

describe('LWB-036 C 组：回报字段', () => {
  before(resetDb);

  it('C1 工作区那一格没有 canonical_root，整份响应里也不出现工作区根', async () => {
    const change = await makeChange('c1');
    const raw = await call('changes.get', { change_id: change.change_id }, consoleContext('req_c1'));
    const workspace = raw['workspace'] as Record<string, unknown> | null;

    assert.notEqual(workspace, null);
    assert.equal(Object.hasOwn(workspace ?? {}, 'canonical_root'), false);
    assert.ok(
      !JSON.stringify(raw).includes('lwb-036-review'),
      '响应里不得出现工作区根路径 —— 它会经过日志与诊断包，而复核界面不需要它',
    );
    assert.equal(workspace?.['alias'], `夹具 ${WORKSPACE}`);
    assert.equal(workspace?.['workspace_id'], WORKSPACE);
    assert.equal(workspace?.['generation'], GENERATION);
    assert.equal(workspace?.['mode'], MODE);
  });

  it('C2 没批准过就不编一条出来；没要 path 就不带差异', async () => {
    const change = await makeChange('c2');
    const detail = await detailOf(change.change_id);
    assert.equal(detail.approval, null);
    assert.equal(detail.diff, null);
    assert.equal(detail.operation, null, '还没进执行阶段：没有操作行');
    assert.equal(detail.observed_at, T0);
  });

  it('C3 有批准时只给状态与有效期 —— 批准人去 `approvals.list` 问', async () => {
    const change = await makeChange('c3');
    repos.approvals.create({
      id: nextId('apr'),
      change_id: change.change_id,
      digest: change.digest,
      actor: CONSOLE,
      expires_at: new Date(T0_MS + LIMITS.APPROVAL_TTL_MS).toISOString(),
    });

    const detail = await detailOf(change.change_id);
    assert.equal(detail.approval?.state, 'ACTIVE');
    assert.equal(typeof detail.approval?.expires_at, 'string');
    // 批准人**不**在这一格里：那个信息有一条权威的来路（`approvals.list` 的
    // 每一行都带 `actor`），两个来源就有两种不一致，而这里的那个是顺手
    // 带出来的、没有任何界面契约保证的副本。
    assert.equal(Object.hasOwn(detail.approval ?? {}, 'actor'), false);
  });

  it('C4 修改集视图与工具面同一份：`next_action` 随状态而变', async () => {
    const change = await makeChange('c4');
    const detail = await detailOf(change.change_id);

    assert.equal(detail.change.workspace_modified, false, 'prepare 永远不修改用户工作区');
    assert.equal(detail.change.digest, change.digest);
    assert.equal(detail.change.state, 'PENDING_APPROVAL');
    assert.equal(detail.change.files[0]?.path, change.path);
    assert.equal(detail.change.approval_required, true);

    // 只比一次「它有话可说」是不够的：`changeSetViewOf` 那句写死的
    // 「等待本地操作者批准」在 PENDING_APPROVAL 下与 `nextActionFor` 的
    // 回答并不冲突，因此任何只测这一个状态的断言都分不出两者。
    const pending = detail.change.next_action;
    repos.changes.transition(change.change_id, ['PENDING_APPROVAL'], 'REJECTED');
    const after = await detailOf(change.change_id);
    assert.equal(after.change.state, 'REJECTED');
    assert.notEqual(after.change.next_action, pending, '状态变了，下一步的指示必须跟着变');

    const viaTool = await changeGetDataOf(
      {
        context: toolSideContext(CONNECTION, repos.workspaces.requireById(WORKSPACE)),
        input: { change_id: change.change_id },
      },
      { repos, blobs },
    );
    assert.equal(after.change.next_action, viaTool.change.next_action, '两侧对同一个状态必须说同一句话');
  });

  it('C5 视图里不含正文：路径、大小、哈希、行数是事实，内容不是', async () => {
    const change = await makeChange('c5');
    const detail = await detailOf(change.change_id);
    const serialized = JSON.stringify(detail.change);
    assert.ok(!serialized.includes('const x = 2;'), '没要 path 时视图里不该出现正文');

    const file = detail.change.files[0];
    assert.equal(file?.added_lines, 1);
    assert.equal(file?.removed_lines, 1);
    assert.equal(file?.encoding, 'utf-8');
    assert.equal(file?.newline, 'lf');
    assert.equal(typeof file?.after_sha256, 'string');
  });
});
