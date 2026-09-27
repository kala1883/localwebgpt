/**
 * 装配根的集成测试。
 *
 * ## 它证的是什么
 *
 * `apps/daemon/src/runtime/` 里没有安全判定 —— 判定在 `@lwb/policy`、
 * `packages/ipc` 与 `tools/` 里。装配根负责的是**顺序**与**失败处置**，
 * 因此这里断言的不是「某条规则算得对」，而是：
 *
 *  - 顺序：单实例判定发生在创建任何状态之前；第二个实例不该动到自己的存储根。
 *  - 边界：四个能力开关**全部关闭**启动，且事实里如实回报。
 *  - 不泄漏：引导令牌与 SID 摘要都不出现在任何一行日志里。
 *  - 可重启：同一个存储根上关掉再启动会成功，且凭证被**复用**而不是重签。
 *  - 关干净：退出后存储根可删（句柄没关的话这一步会 EBUSY）。
 *
 * ## 会占用本用户的单实例管道
 *
 * 控制管道按当前用户 SID 命名，因此**同一时刻本用户只能有一个 daemon**。
 * 如果操作者自己的 daemon 正在跑，这里的启动会拿到 `already_running` ——
 * 那不是缺陷，是这条不变量在生效。那种情况下整组**跳过并说明原因**，
 * 而不是失败：把「你的 daemon 开着」报成测试失败，会训练人忽略红色。
 *
 * 测试永远不会去碰操作者那个 daemon：控制管道被占时装配根在创建任何状态
 * 之前就退出，连状态库都不会打开。
 *
 * ## 凭证不进断言消息
 *
 * 断言失败时 node:test 会把实际值打进输出。因此凡是与凭证有关的比较，
 * 断言的都是**布尔结论**（「日志里有这一串吗」）而不是那一串本身。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';

import {
  CONTRACT_VERSION,
  CONTROL_COOKIE_NAME,
  IMPLEMENTED_TOOL_NAMES,
  TOOL_CATALOG_OPERATION,
} from '@lwb/contracts';
import { dataPipeName } from '@lwb/ipc';
import { SecureStoreHelper, resolveStoreLayout } from '@lwb/secure-store';

import {
  ADAPTER_CONNECTION_ID,
  DAEMON_VERSION,
  EXIT_ALREADY_RUNNING,
  EXIT_OK,
  EXIT_STARTUP_FAILED,
  StartupFailed,
  startDaemon,
  type DaemonRuntime,
} from '../../apps/daemon/src/runtime/index.ts';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;

/**
 * 工具名。取自契约而不是在这里再抄一份。
 *
 * 原先这里是手写的七个名字。抄一份的代价不是「多打几个字」，而是
 * **两份清单会各自演化**：契约里加一个工具，这里忘了加，于是
 * `operations.length === TOOL_NAMES.length + 1 + CONTROL_NAMES.length`
 * 这条**总数**断言会失败，而它报出来的是「操作表里有重名」那套邻居断言
 * 旁边的数字不符 —— 排查方向会被引到装配根，而真实原因是这份抄件过期了。
 *
 * 换成常量之后，这条断言问的正是它该问的问题：**daemon 注册的操作表
 * 恰好等于契约里已实现的那些工具**（外加清单操作与控制面）。
 * 「注册了一个不属于契约的名字」由 `assertRegisterable` 在装配期拒绝。
 */
const TOOL_NAMES: readonly string[] = IMPLEMENTED_TOOL_NAMES;

/**
 * 控制面操作。它们不由模型调用，因此不属于「工具面」。
 *
 * `tools.catalog` **不在这里**：它虽然也不由模型发起，但它由工具面注册
 * （`registerToolOperations`），因此计入 `tool_operations`。
 * 第一版把它列在这边，于是总数算成 23 而实际是 22 —— 一次纯粹由
 * 「这张表按什么分的」引起的失败，值得写下来。
 */
const CONTROL_NAMES = [
  'approvals.approve_and_apply',
  'approvals.list',
  'approvals.reject',
  // LWB-036 的复核读取。这两条**不在工具面上**，因此也不在
  // `IMPLEMENTED_TOOL_NAMES` 里：模型读修改集走的是 `change_get`
  // （按 `owner_connection_id` 收窄到它自己提议的那些），而控制台读的
  // 是**本机上的**全部修改集。两件事的判据不同，因此是两个名字。
  'changes.get',
  'changes.list',
  'history.list',
  'connections.list',
  'connections.pause',
  'connections.resume',
  // LWB-034 的紧急停用。这一份清单是**手抄的**（与 `TOOL_NAMES` 不同，
  // 后者取自契约），因此新增控制操作时它必须被一起改 —— 而漏改的表现
  // 就是下面那条总数断言失败。它不是「多打三个名字」：这条断言问的是
  // 「daemon 真的把这三条注册进操作表了吗」，而手抄的那一份一旦与
  // 真实注册脱节，问的就不再是这件事了。
  'service.pause',
  'service.pause_status',
  'service.resume',
  'recovery.authorize',
  'recovery.export_snapshot',
  'recovery.get',
  'recovery.keep_current',
  'recovery.list',
  'recovery.repair',
  'recovery.repropose',
  'workspaces.describe',
  'workspaces.access.list',
  'workspaces.access.set',
  'workspaces.list',
  'workspaces.pause',
  'workspaces.register',
  'workspaces.relocate',
  'workspaces.remove',
  'workspaces.resume',
  'workspaces.reverify',
] as const;

describeWindows('装配根', () => {
  const homes: string[] = [];
  const running: DaemonRuntime[] = [];
  const helper = new SecureStoreHelper();

  /**
   * 本用户下是否已经有别的 daemon 占着单实例管道。
   *
   * 在 `before` 里探一次，而不是让每个用例各自撞上 —— 那样会得到
   * 11 条彼此重复的失败，而原因只有一个。
   */
  let blockedByExistingDaemon = false;

  before(async () => {
    await helper.start();
    const probeHome = await freshHome();
    const { lines, sink } = collector();
    try {
      const probe = await startDaemon({ argv: [`--home=${probeHome}`], env: {}, log: sink });
      await probe.shutdown();
    } catch (error) {
      if (error instanceof StartupFailed && error.kind === 'already_running') {
        blockedByExistingDaemon = true;
        return;
      }
      throw error;
    }

    // 清理失败是**只能通过日志看到**的：撤销栈刻意不因为一步失败而中断
    // 其余的步骤（见 `UndoStack.unwind`），因此「关干净了没有」这句话
    // 只能由日志回答。上一版探针把日志丢进 noop，于是关闭失败会静默，
    // 后面每一个用例再各自报出一个**误导性**的原因。
    const cleanupFailures = lines.filter((line) => line.includes('清理') && line.includes('失败'));
    assert.deepEqual(cleanupFailures, [], '启动-关闭的清理路径报了失败。');
    assert.equal(
      lines.some((line) => line.includes('被拦截')),
      false,
      '有启动日志行被凭证筛查拦下。',
    );
  });

  after(async () => {
    await stopAll();
    for (const home of homes.splice(0)) {
      await rm(home, { recursive: true, force: true });
    }
    helper.stop();
  });

  function noop(): void {
    // 探针只关心「能不能启动」，不需要日志。
  }

  async function freshHome(): Promise<string> {
    const home = await mkdtemp(path.join(os.tmpdir(), 'lwb-assembly-'));
    homes.push(home);
    return home;
  }

  /** 跳过的统一出口：说清楚为什么，而不是静默返回。 */
  function skipIfBlocked(context: { skip: (reason: string) => void }): boolean {
    if (!blockedByExistingDaemon) return false;
    context.skip('本用户下已有 daemon 在运行，控制管道被占用；本组需要独占单实例。');
    return true;
  }

  /**
   * 启动一个 daemon，并**登记本用例结束时必须停掉它**。
   *
   * `context.after` 而不是在用例末尾手动 `stopAll()`：手动那种写法在断言
   * 失败时会被跳过，于是那个 daemon 会一直占着单实例管道，后面**每一个**
   * 用例都会报「已有 daemon 在运行」—— 一个与它们真正在测的东西无关的
   * 原因。第一版就是这样：一处 deepEqual 失败造成了十处误导性红色。
   *
   * 单实例管道是本组唯一不可并行的资源，而它恰好也是最容易被这种
   * 级联掩盖的资源。
   */
  async function start(
    context: TestContext,
    home: string,
    log: (line: string) => void,
  ): Promise<DaemonRuntime> {
    context.after(stopAll);
    const runtime = await startDaemon({ argv: [`--home=${home}`], env: {}, log });
    running.push(runtime);
    return runtime;
  }

  /** 收集启动日志；断言拿到的永远是结论，不是原始行。 */
  function collector(): { lines: string[]; sink: (line: string) => void } {
    const lines: string[] = [];
    return { lines, sink: (line: string) => lines.push(line) };
  }

  async function stopAll(): Promise<void> {
    for (const runtime of running.splice(0)) {
      await runtime.shutdown();
    }
  }

  it('启动成功，全局能力可用；外部验收状态单独如实回报', async (context) => {
    if (skipIfBlocked(context)) return;
    const home = await freshHome();
    const { lines, sink } = collector();
    const runtime = await start(context, home, sink);

    assert.deepEqual(runtime.facts.capability_flags, {
      read_enabled: true,
      git_enabled: true,
      proposal_enabled: true,
      direct_write_enabled: true,
      recovery_required: false,
    });
    assert.equal(runtime.facts.gates.g0_platform_verified, false, '网页账号验收仍是单独的未验证事实');
    assert.equal(runtime.facts.store_root_overridden, true, '临时根必须自述为「被覆盖」。');
    assert.equal(runtime.facts.guard.backend.length > 0, true);
    assert.equal(runtime.facts.version, DAEMON_VERSION);
    assert.equal(runtime.facts.withheld_log_lines, 0);
    assert.equal(lines.length > 0, true, '启动日志一行都没有。');

    await stopAll();
  });

  it('模型侧连接已登记但**停用**，principal_kind 是 model_surface', async (context) => {
    if (skipIfBlocked(context)) return;
    const runtime = await start(context, await freshHome(), collector().sink);

    const connection = runtime.repos.connections.findById(ADAPTER_CONNECTION_ID);
    assert.notEqual(connection, null);
    assert.equal(connection?.principal_kind, 'model_surface');
    assert.equal(connection?.enabled, false, '新建连接默认必须是停用的。');
    assert.equal(runtime.facts.connections, 1);
    // 记录的是**当前事实**：今天没有任何生产路径创建 grant，
    // 因此启用了连接也仍然调不通工具（已记录在案的偏差）。
    assert.equal(runtime.facts.grants, 0);

    await stopAll();
  });

  it('本地 tunnel 子进程只拿到 MCP audience 凭证，不拿控制台凭证或令牌', async (context) => {
    if (skipIfBlocked(context)) return;
    const runtime = await start(context, await freshHome(), collector().sink);

    const childEnv = runtime.mcpAdapterEnvironment();
    assert.deepEqual(Object.keys(childEnv).sort(), [
      'LWB_ADAPTER_VERSION',
      'LWB_CONNECTION_ID',
      'LWB_IPC_PIPE',
      'LWB_IPC_SECRET_MCP_ADAPTER',
    ]);
    assert.equal(childEnv['LWB_IPC_PIPE'], runtime.pipe.pipe_name);
    assert.equal(childEnv['LWB_CONNECTION_ID'], ADAPTER_CONNECTION_ID);
    assert.equal(childEnv['LWB_ADAPTER_VERSION'], DAEMON_VERSION);
    assert.equal((childEnv['LWB_IPC_SECRET_MCP_ADAPTER']?.length ?? 0) >= 16, true);
    assert.equal(Object.values(childEnv).includes(runtime.bootstrap_url), false);

    await stopAll();
  });

  it('引导地址带着真实端口，且端口等于控制面实际监听的端口', async (context) => {
    if (skipIfBlocked(context)) return;
    const runtime = await start(context, await freshHome(), collector().sink);

    const match = /^http:\/\/127\.0\.0\.1:(\d+)\/#t=(lwb_boot_[A-Za-z0-9_-]+)$/.exec(
      runtime.bootstrap_url,
    );
    assert.notEqual(match, null, '引导地址的形状不对（这行不含令牌本身）。');

    const port = Number(match?.[1]);
    assert.equal(Number.isInteger(port) && port > 0 && port <= 65535, true);
    // 回归：曾经打印的是默认端口（0）而不是系统分配的那一个。
    assert.equal(port, runtime.control.port);

    await stopAll();
  });

  it('`/api/status` 带着「当前是哪台机器」，且这一条只走控制平面', async (context) => {
    if (skipIfBlocked(context)) return;
    const runtime = await start(context, await freshHome(), collector().sink);

    // 真实的兑换 → 真实的会话 → 真实的 HTTP 请求。
    // 不走内部对象：LWB-035 的验收标准 1（「非技术用户能知道当前哪台机器」）
    // 落在**响应体**上，而响应体只有这条路能验到。
    const token =
      /^http:\/\/127\.0\.0\.1:\d+\/#t=(lwb_boot_[A-Za-z0-9_-]+)$/.exec(runtime.bootstrap_url)?.[1] ??
      '';
    const issued = runtime.sessions.redeem(token);
    assert.notEqual(issued, null, '兑换失败，下面的断言就无从谈起。');

    const response = await fetch(`http://127.0.0.1:${String(runtime.control.port)}/api/status`, {
      headers: { Cookie: `${CONTROL_COOKIE_NAME}=${issued?.cookie_value ?? ''}` },
      redirect: 'error',
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      readonly result?: { readonly machine?: Record<string, unknown> };
    };
    const machine = payload.result?.machine;

    // 回归：这一格曾经**永远**是空的 —— 控制台会一直显示「当前机器：未知」，
    // 而它与「这次读取失败了」长得一模一样，操作者会去重启一个没坏的东西。
    // 界面那一侧无法自救：浏览器知道的是浏览器所在的机器，不是 daemon 的。
    assert.notEqual(machine, undefined, '/api/status 没有回报机器身份，控制台那一格就永远是「未知」。');
    assert.equal(machine?.['hostname'], os.hostname());
    assert.equal(machine?.['os'], process.platform);
    assert.equal(machine?.['arch'], process.arch);

    // 另一半：这条事实**不给模型**。断言比的是字段**不在**工具面的状态源里 ——
    // 有人把它挪进 `StartupFacts` 时，这里会红，而那时该回答的是
    // 「模型需不需要知道这台机器叫什么」，而不是顺手改断言。
    assert.equal(
      Object.hasOwn(runtime.facts, 'machine'),
      false,
      '机器身份进了工具面的状态源；模型可见的 `bridge_status` 不该带上它。',
    );

    await stopAll();
  });

  it('引导令牌只在交付那一行出现一次，且不落进任何持久状态', async (context) => {
    if (skipIfBlocked(context)) return;
    const home = await freshHome();
    const { lines, sink } = collector();
    const runtime = await start(context, home, sink);

    const token = runtime.bootstrap_url.slice(runtime.bootstrap_url.indexOf('#t=') + 3);
    assert.equal(token.length > 0, true);

    // 令牌**必须**出现在操作者的终端上 —— 那是它唯一的交付渠道，
    // 不出现操作者就打不开控制台。要钉的是「只在那里出现」：
    const carrying = lines.filter((line) => line.includes(token));
    assert.equal(carrying.length, 1, '引导令牌出现了不止一次（或一次都没有）。');

    // 而它不得进入任何**结构化**事实：那些会被状态页、诊断包与证据带走。
    assert.equal(
      JSON.stringify(runtime.facts).includes(token),
      false,
      '引导令牌进了启动事实（会被状态页与诊断带走）。',
    );
    assert.equal(
      runtime.facts.withheld_log_lines,
      0,
      '有日志行被筛查拦下，说明有路径试图写出凭证。',
    );

    // 状态库是审计与幂等记录的落点，令牌不得出现在其中任何字节里。
    // 直接查字节而不是查表：新加一张表不会让这条断言变瞎。
    await stopAll();
    const database = await readFile(path.join(home, 'db', 'bridge.sqlite'));
    assert.equal(
      database.includes(Buffer.from(token, 'utf8')),
      false,
      '引导令牌出现在状态库的字节里。',
    );
  });

  it('管道名对外只给屏蔽过的形式，摘要不进日志，且与启动器算得出同一个名字', async (context) => {
    if (skipIfBlocked(context)) return;
    const { lines, sink } = collector();
    const runtime = await start(context, await freshHome(), sink);

    assert.equal(runtime.pipe.pipe_name.endsWith('.data'), true);
    assert.equal(runtime.facts.pipe_name.includes('<sid-hash>'), true);
    assert.equal(runtime.facts.pipe_name.includes(runtime.pipe.pipe_name), false);
    assert.equal(
      lines.some((line) => line.includes(runtime.pipe.pipe_name)),
      false,
      '有一行启动日志写出了未屏蔽的管道名。',
    );

    // 启动器**自己算**这个管道名（它不读日志）。两边算不出同一个名字，
    // 适配器就连不上 —— 而那会表现成「隧道的问题」。
    const identity = await helper.whoami();
    assert.equal(identity.ok, true, 'whoami 失败，无法独立算出管道名。');
    if (identity.ok) {
      assert.equal(dataPipeName(identity.data.user_sid), runtime.pipe.pipe_name);
    }

    await stopAll();
  });

  it('操作表里工具面与控制面都在，且两边没有重名', async (context) => {
    if (skipIfBlocked(context)) return;
    const runtime = await start(context, await freshHome(), collector().sink);

    assert.equal(runtime.facts.tool_operations, TOOL_NAMES.length + 1);
    assert.deepEqual(
      TOOL_NAMES.filter((name) => !runtime.facts.operations.includes(name)),
      [],
    );
    assert.deepEqual(
      CONTROL_NAMES.filter((name) => !runtime.facts.operations.includes(name)),
      [],
    );
    assert.equal(runtime.facts.operations.includes(TOOL_CATALOG_OPERATION), true);
    assert.equal(
      new Set(runtime.facts.operations).size,
      runtime.facts.operations.length,
      '操作表里有重名。',
    );
    assert.equal(
      runtime.facts.operations.length,
      TOOL_NAMES.length + 1 + CONTROL_NAMES.length,
    );

    await stopAll();
  });

  it('同一用户下的第二个实例被拒，且**没有**建出自己的存储根', async (context) => {
    if (skipIfBlocked(context)) return;
    const first = await freshHome();
    const second = await freshHome();
    await start(context, first, noop);

    await assert.rejects(
      () => startDaemon({ argv: [`--home=${second}`], env: {}, log: noop }),
      (error: unknown) => {
        assert.equal(error instanceof StartupFailed, true);
        assert.equal((error as StartupFailed).kind, 'already_running');
        return true;
      },
    );

    // 关键：第二个实例必须在**创建任何状态之前**退出。
    // 否则那段时间里它已经动过自己的库了 —— 报错说「已在运行」，
    // 磁盘上却多出半个存储根。
    const blocked = resolveStoreLayout(second);
    await assert.rejects(
      () => readFile(blocked.layout.databaseFile, 'utf8'),
      '第二个实例把自己的状态库建出来了。',
    );

    await stopAll();
  });

  it('不认识的参数被拒绝，且报的是 startup_failed', async (context) => {
    if (skipIfBlocked(context)) return;
    const home = await freshHome();
    await assert.rejects(
      () =>
        startDaemon({
          argv: [`--home=${home}`, '--allow-write'],
          env: {},
          log: noop,
        }),
      (error: unknown) => {
        assert.equal(error instanceof StartupFailed, true);
        assert.equal((error as StartupFailed).kind, 'startup_failed');
        assert.equal((error as Error).message.includes('无法识别'), true);
        return true;
      },
    );
  });

  it('关掉之后再启动会成功，且凭证是复用而不是重签', async (context) => {
    if (skipIfBlocked(context)) return;
    const home = await freshHome();

    const first = await start(context, home, noop);
    assert.deepEqual(first.facts.credentials, { runtime_created: true, ipc_created: true });
    await stopAll();

    const second = await start(context, home, noop);
    assert.deepEqual(
      second.facts.credentials,
      { runtime_created: false, ipc_created: false },
      '第二次启动重新签发了凭证：上一把密钥没被读回来。',
    );

    await stopAll();
  });

  it('启动清理确实跑过：过期的修改集与批准在重启时被收掉', async (context) => {
    if (skipIfBlocked(context)) return;
    const home = await freshHome();

    const first = await start(context, home, noop);
    seedExpired(first);
    assert.equal(first.repos.changes.requireById('chg_test').state, 'PENDING_APPROVAL');
    await stopAll();

    const second = await start(context, home, noop);
    assert.equal(second.repos.changes.requireById('chg_test').state, 'EXPIRED');
    assert.equal(second.repos.approvals.requireById('apr_test').state, 'EXPIRED');
    assert.equal(second.facts.sweep.expired_changes, 1);

    await stopAll();
  });

  it('退出之后存储根可以被删掉（库句柄确实关干净了）', async (context) => {
    if (skipIfBlocked(context)) return;
    const home = await freshHome();
    await start(context, home, noop);
    await stopAll();

    // 反证「关闭只是把对象忘了」：句柄还开着的话这一步会是 EBUSY。
    await rm(home, { recursive: true, force: true });
    homes.splice(homes.indexOf(home), 1);
  });

  it('退出码只有三个，且各自对应一种处置', () => {
    assert.equal(EXIT_OK, 0);
    assert.equal(EXIT_STARTUP_FAILED, 1);
    assert.equal(EXIT_ALREADY_RUNNING, 2);
  });

  it('版本号与产品版本一致', async () => {
    // 读的是**根** package.json：`apps/daemon` 没有自己的清单
    // （`apps/console` 与 `native/winfs` 有，这两个在 lockfile 里；
    // `apps/daemon` 与 `apps/mcp-adapter` 没有）。整个产品同一个版本号，
    // 因此真值在根上，而不在一个不存在的文件里。
    const manifest = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
    assert.equal((JSON.parse(manifest) as { version: string }).version, DAEMON_VERSION);
  });
});

/**
 * 种一个「已过期」的修改集与挂在它上面的批准。
 *
 * 走仓库层而不是直接写 SQL：直接写会绕过模式约束，
 * 于是「清理能收掉一个**真实存在**的过期对象」这句话就变得可疑。
 */
function seedExpired(runtime: DaemonRuntime): void {
  const past = new Date(Date.now() - 60_000).toISOString();

  runtime.repos.workspaces.create({
    id: 'ws_test',
    alias: '测试',
    kind: 'directory',
    canonical_root: 'C:\\LWBTEST\\ws',
    volume_id: 'c6e22015',
    root_file_id: 'ffffffffffffffff',
    policy_version: 1,
    mode: 'read_only',
  });
  runtime.repos.blobs.ensure({
    id: 'blb_test_old',
    sha256: 'b'.repeat(64),
    size: 3,
    storage_ref: 'sha256/bb/bbbb',
  });
  runtime.repos.blobs.ensure({
    id: 'blb_test_new',
    sha256: 'c'.repeat(64),
    size: 4,
    storage_ref: 'sha256/cc/cccc',
  });

  const change = runtime.repos.changes.create({
    id: 'chg_test',
    owner_connection_id: ADAPTER_CONNECTION_ID,
    workspace_id: 'ws_test',
    root_generation: 1,
    policy_version: 1,
    contract_version: CONTRACT_VERSION,
    digest: 'a'.repeat(64),
    summary: '测试用过期修改集',
    expires_at: past,
    items: [
      {
        id: 'itm_test',
        path: 'a.txt',
        op: 'edit_text',
        base_file_id: 'fffffffffffffffe',
        base_sha256: 'd'.repeat(64),
        target_sha256: 'e'.repeat(64),
        old_blob_id: 'blb_test_old',
        new_blob_id: 'blb_test_new',
        encoding: 'utf-8',
        bom: false,
        newline: 'lf',
        added_lines: 1,
        removed_lines: 0,
      },
    ],
  });
  runtime.repos.approvals.create({
    id: 'apr_test',
    change_id: change.id,
    digest: change.digest,
    actor: 'console:s1-test',
    expires_at: past,
  });
}
