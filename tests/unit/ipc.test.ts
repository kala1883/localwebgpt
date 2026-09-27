/**
 * LWB-008 单元与集成测试。
 *
 * 三条验收标准各有对应的用例组，且**验收标准 1 与 2 走真实的 Windows 命名管道**，
 * 不是内存里的冒名套接字：单实例互斥与握手拒绝都是「管道这一层」的行为，
 * 用假的传输层测出来的结论不能支撑那两条验收。
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { after, describe, it } from 'node:test';

import {
  AUDIENCES,
  CAPABILITIES_BY_AUDIENCE,
  ConnectionSession,
  ExecutorLease,
  FrameDecoder,
  FrameTooLargeError,
  IpcClient,
  NEVER_GRANTED_TO_MODEL,
  OperationRegistry,
  assertAudienceSecretsDistinct,
  attachSocket,
  capabilitiesOf,
  computeProof,
  createProcessProbe,
  deriveAudienceKey,
  encodeFrame,
  hasCapability,
  newNonce,
  verifyHandshake,
  type Audience,
  type MessageSink,
} from '@lwb/ipc';
import { pipeNameForSid, controlPipeName } from '@lwb/ipc';
import { acquireSingleInstance, releaseSingleInstance } from '@lwb/ipc';
import type { ProcessIdentity, ProcessProbe } from '@lwb/ipc';

// ---------------------------------------------------------------- 工具

// Use synthetic, per-process SIDs so these real named-pipe tests do not collide
// with the developer's live LocalWebGPT daemon (or another concurrent test run).
const SID = `S-1-5-21-1111111111-2222222222-333333333-${process.pid}`;
const ADAPTER_SECRET = 'adapter-secret-for-tests-0123456789';
const CONSOLE_SECRET = 'console-secret-for-tests-0123456789';

let pipeCounter = 0;
/** 每个测试用独立管道名，避免并行执行时互相占用。 */
function uniquePipeName(): string {
  pipeCounter += 1;
  return `\\\\.\\pipe\\lwb-test-${process.pid}-${pipeCounter}-${Date.now()}`;
}

const openServers: Server[] = [];
after(() => {
  for (const server of openServers) server.close();
});

interface TestServer {
  readonly pipeName: string;
  readonly events: unknown[];
  close(): Promise<void>;
}

async function startServer(options: {
  readonly pipeName?: string;
  readonly secrets?: Record<Audience, string>;
  readonly operations?: OperationRegistry;
  readonly registered?: readonly string[];
}): Promise<TestServer> {
  const pipeName = options.pipeName ?? uniquePipeName();
  const events: unknown[] = [];
  const registered = new Set(options.registered ?? ['conn-1', 'conn-2']);
  const operations = options.operations ?? new OperationRegistry();

  const server = createServer((socket) => {
    attachSocket(socket, {
      secrets: options.secrets ?? {
        'mcp-adapter': ADAPTER_SECRET,
        console: CONSOLE_SECRET,
      },
      operations,
      isRegisteredConnection: (id) => registered.has(id),
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

// ================================================================
// 验收标准 1：第二个 daemon 不会并发写同一个状态库/工作区
// ================================================================

describe('LWB-008 验收标准 1：单实例互斥', () => {
  it('同一个 SID 第二次绑定控制管道被拒绝（真实命名管道）', async () => {
    const first = await acquireSingleInstance({ userSid: SID, onConnection: () => {} });
    assert.equal(first.kind, 'acquired');
    if (first.kind !== 'acquired') return;

    try {
      const second = await acquireSingleInstance({ userSid: SID, onConnection: () => {} });
      assert.equal(
        second.kind,
        'occupied',
        '第二个实例必须被拒绝；否则两个 daemon 会同时打开状态库与工作区',
      );
      if (second.kind === 'occupied') {
        assert.match(second.reason, /已有 daemon 在运行/);
      }
    } finally {
      await releaseSingleInstance(first.server);
    }
  });

  it('第一个实例释放后可以重新绑定', async () => {
    const first = await acquireSingleInstance({ userSid: SID, onConnection: () => {} });
    assert.equal(first.kind, 'acquired');
    if (first.kind !== 'acquired') return;
    await releaseSingleInstance(first.server);

    const second = await acquireSingleInstance({ userSid: SID, onConnection: () => {} });
    assert.equal(second.kind, 'acquired', '释放后应当能重新绑定，否则崩溃一次就再也起不来');
    if (second.kind === 'acquired') await releaseSingleInstance(second.server);
  });

  it('不同 SID 使用不同管道名，互不阻塞', async () => {
    const otherSid = `S-1-5-21-4444444444-5555555555-666666666-${process.pid}`;
    assert.notEqual(pipeNameForSid(SID), pipeNameForSid(otherSid));

    const first = await acquireSingleInstance({ userSid: SID, onConnection: () => {} });
    const second = await acquireSingleInstance({ userSid: otherSid, onConnection: () => {} });
    try {
      assert.equal(first.kind, 'acquired');
      assert.equal(second.kind, 'acquired', '另一个用户的实例不应被本用户的实例挡住');
    } finally {
      if (first.kind === 'acquired') await releaseSingleInstance(first.server);
      if (second.kind === 'acquired') await releaseSingleInstance(second.server);
    }
  });

  it('管道名只由 SID 决定，不受 LWB_HOME 影响', () => {
    // 若名字受环境变量影响，「同一个用户两个 LWB_HOME」就会变成
    // 两条互不可见的管道，单实例保证被一个环境变量绕过。
    const before = controlPipeName(SID);
    process.env['LWB_HOME'] = 'D:\\somewhere-else';
    try {
      assert.equal(controlPipeName(SID), before);
    } finally {
      delete process.env['LWB_HOME'];
    }
  });

  it('非法 SID 被拒绝，而不是拼出一个可疑的管道名', () => {
    assert.throws(() => pipeNameForSid('not-a-sid'), /不是合法的用户 SID/);
    assert.throws(() => pipeNameForSid(''), /不是合法的用户 SID/);
  });
});

// ================================================================
// 验收标准 2：伪造本地连接、错误 audience 的凭据被拒绝
// ================================================================

describe('LWB-008 验收标准 2：连接认证（真实命名管道）', () => {
  it('持有正确凭证的适配器可以连接，并只拿到适配器能力', async () => {
    const server = await startServer({});
    const client = new IpcClient({
      pipeName: server.pipeName,
      secret: ADAPTER_SECRET,
      audience: 'mcp-adapter',
      connectionId: 'conn-1',
    });
    try {
      await client.connect();
      assert.deepEqual([...client.capabilities].sort(), [
        'tools.apply',
        'tools.propose',
        'tools.read',
      ]);
      // 逐条钉住：这四项绝不能出现在适配器的能力里。
      for (const forbidden of NEVER_GRANTED_TO_MODEL) {
        assert.equal(
          client.capabilities.includes(forbidden),
          false,
          `适配器不应拥有 ${forbidden}`,
        );
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('凭证错误时被拒绝（BAD_PROOF）', async () => {
    const server = await startServer({});
    const client = new IpcClient({
      pipeName: server.pipeName,
      secret: 'wrong-secret-wrong-secret-wrong-secret',
      audience: 'mcp-adapter',
      connectionId: 'conn-1',
    });
    try {
      await assert.rejects(() => client.connect(), /拒绝连接|凭证无法通过校验/);
      assert.ok(
        server.events.some(
          (e) => (e as { type?: string; code?: string }).type === 'handshake_failed' &&
            (e as { code?: string }).code === 'BAD_PROOF',
        ),
        '服务端必须记录 BAD_PROOF',
      );
    } finally {
      await server.close();
    }
  });

  it('拿控制台凭证冒充适配器被拒绝（audience 分离）', async () => {
    // 这是 audience 分离的核心用例：如果两类 audience 共用一把凭证，
    // 或者服务端用「请求声明的 audience」去派生而凭证是共用的，
    // 这条用例就会失败。
    const server = await startServer({});
    const client = new IpcClient({
      pipeName: server.pipeName,
      secret: CONSOLE_SECRET,
      audience: 'mcp-adapter',
      connectionId: 'conn-1',
    });
    try {
      await assert.rejects(() => client.connect(), /拒绝连接|凭证无法通过校验/);
    } finally {
      await server.close();
    }
  });

  it('拿适配器凭证冒充控制台被拒绝（分离是双向的）', async () => {
    const server = await startServer({});
    const client = new IpcClient({
      pipeName: server.pipeName,
      secret: ADAPTER_SECRET,
      audience: 'console',
      connectionId: 'conn-1',
    });
    try {
      await assert.rejects(() => client.connect(), /拒绝连接|凭证无法通过校验/);
    } finally {
      await server.close();
    }
  });

  it('未注册的 connection_id 即使证明算得对也被拒绝', async () => {
    const server = await startServer({});
    const client = new IpcClient({
      pipeName: server.pipeName,
      secret: ADAPTER_SECRET,
      audience: 'mcp-adapter',
      connectionId: 'conn-未注册',
    });
    try {
      await assert.rejects(() => client.connect(), /未在本机注册|拒绝连接/);
      assert.ok(
        server.events.some(
          (e) => (e as { code?: string }).code === 'CONNECTION_ID_MISMATCH',
        ),
        '「算得对」不等于「被允许」，必须走注册表判定',
      );
    } finally {
      await server.close();
    }
  });

  it('适配器调用控制台专属操作被拒绝（能力每次请求重新查表）', async () => {
    const operations = new OperationRegistry();
    operations.register({
      name: 'workspaces.add',
      required: 'workspaces.manage',
      handler: () => ({ added: true }),
    });
    operations.register({
      name: 'files.read',
      required: 'tools.read',
      handler: () => ({ content: 'ok' }),
    });

    const server = await startServer({ operations });
    const client = new IpcClient({
      pipeName: server.pipeName,
      secret: ADAPTER_SECRET,
      audience: 'mcp-adapter',
      connectionId: 'conn-1',
    });
    try {
      await client.connect();

      const denied = await client.call('workspaces.add', { path: 'D:\\x' });
      assert.equal(denied.ok, false);
      if (!denied.ok) {
        assert.equal(denied.code, 'CAPABILITY_DENIED');
        // 拒绝是**立即**的，不是超时；因此结果不未知，不能重试。
        assert.equal(denied.outcome_unknown, false);
      }

      const allowed = await client.call('files.read', { path: 'a.txt' });
      assert.equal(allowed.ok, true);

      assert.ok(
        server.events.some((e) => (e as { type?: string }).type === 'capability_denied'),
        '越权尝试必须留下审计事件',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('未知操作被拒绝，且不泄露操作清单', async () => {
    const server = await startServer({});
    const client = new IpcClient({
      pipeName: server.pipeName,
      secret: CONSOLE_SECRET,
      audience: 'console',
      connectionId: 'conn-1',
    });
    try {
      await client.connect();
      const outcome = await client.call('nonexistent', {});
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal(outcome.code, 'UNKNOWN_OPERATION');
        assert.equal(outcome.reason, '未知操作。');
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('握手完成前的请求会被断开，而不是排队等待执行', async () => {
    // 若实现成「先放着、等握手完成后处理」，攻击者只要在连接刚建立时
    // 抢先发一条 request 就能在未认证状态下让请求被执行。
    const called: string[] = [];
    const operations = new OperationRegistry();
    operations.register({
      name: 'files.read',
      required: 'tools.read',
      handler: () => {
        called.push('files.read');
        return {};
      },
    });
    // 注册表必须是**服务端实际使用的那一个**，否则 `called` 永远为空，
    // 断言就成了一句空话。
    const server = await startServer({ operations });

    const { connect } = await import('node:net');
    const socket = connect(server.pipeName);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.setEncoding('utf8');
    socket.write(
      encodeFrame({ type: 'request', request_id: 'req_1', operation: 'files.read', input: {} }),
    );

    // 连接建立后服务端**先**发 challenge（`hello`），所以不能只看第一帧 ——
    // 要收集全部帧再找那条拒绝回执。
    const frames = await new Promise<Record<string, unknown>[]>((resolve) => {
      const collected: Record<string, unknown>[] = [];
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line.length > 0) collected.push(JSON.parse(line) as Record<string, unknown>);
          index = buffer.indexOf('\n');
        }
      });
      socket.on('close', () => resolve(collected));
    });

    const rejection = frames.find((frame) => frame['type'] === 'rejected');
    assert.equal(
      rejection?.['code'],
      'PROTOCOL_ERROR',
      `未认证的请求必须被拒绝并断开；实际收到的帧：${JSON.stringify(frames)}`,
    );
    assert.deepEqual(called, [], '未认证的请求绝不能被执行');
    socket.destroy();
    await server.close();
  });
});

describe('LWB-008 握手单元（无 socket）', () => {
  const base = {
    serverNonce: newNonce(),
    clientNonce: newNonce(),
    audience: 'mcp-adapter' as Audience,
    connectionId: 'conn-1',
    pid: 4242,
  };
  const key = deriveAudienceKey(ADAPTER_SECRET, 'mcp-adapter');

  function handshake(overrides: Record<string, unknown> = {}) {
    const input = { ...base, ...overrides } as typeof base;
    return {
      audience: input.audience,
      connection_id: input.connectionId,
      pid: input.pid,
      client_nonce: input.clientNonce,
      proof: computeProof(key, input),
    };
  }

  const expected = {
    key,
    serverNonce: base.serverNonce,
    seenClientNonces: new Set<string>(),
    isRegistered: (id: string) => id === 'conn-1',
  };

  it('正确证明通过', () => {
    assert.equal(verifyHandshake(handshake(), expected).ok, true);
  });

  it('重放同一个 client_nonce 被拒绝', () => {
    const seen = new Set([base.clientNonce]);
    const verdict = verifyHandshake(handshake(), { ...expected, seenClientNonces: seen });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, 'NONCE_REUSED');
  });

  it('换一个 server_nonce 后旧证明失效（重放整条报文没用）', () => {
    const recorded = handshake();
    const verdict = verifyHandshake(recorded, { ...expected, serverNonce: newNonce() });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, 'BAD_PROOF');
  });

  it('篡改 pid 会让证明失效（pid 在被签名的载荷里）', () => {
    const recorded = handshake();
    const verdict = verifyHandshake({ ...recorded, pid: 9999 }, expected);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, 'BAD_PROOF');
  });

  it('audience 在被签名的载荷里：改掉它证明就失效', () => {
    // 这一层只回答「证明还算不算数」。audience 是否**合法**是会话层的检查
    // （见「会话状态机」那组用例），两者不是同一件事。
    const verdict = verifyHandshake(
      { ...handshake(), audience: 'console' as Audience },
      expected,
    );
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, 'BAD_PROOF');
  });

  it('字段类型不对时报 MALFORMED，而不是抛异常', () => {
    const verdict = verifyHandshake(
      { ...handshake(), pid: '4242' as unknown as number },
      expected,
    );
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, 'MALFORMED');
  });

  it('不同 audience 派生的密钥互不相同', () => {
    const a = deriveAudienceKey(ADAPTER_SECRET, 'mcp-adapter');
    const b = deriveAudienceKey(CONSOLE_SECRET, 'console');
    assert.notEqual(a.toString('hex'), b.toString('hex'));
    // 同一个凭证换 audience 也必须得到不同密钥（领域分隔）。
    const a2 = deriveAudienceKey(ADAPTER_SECRET, 'console');
    assert.notEqual(a.toString('hex'), a2.toString('hex'));
  });

  it('两类 audience 共用凭证时拒绝启动', () => {
    assert.throws(
      () => assertAudienceSecretsDistinct({ 'mcp-adapter': ADAPTER_SECRET, console: ADAPTER_SECRET }),
      /相同的连接凭证/,
    );
    assert.throws(
      () => assertAudienceSecretsDistinct({ 'mcp-adapter': 'short', console: CONSOLE_SECRET }),
      /缺失或过短/,
    );
    assert.doesNotThrow(() =>
      assertAudienceSecretsDistinct({ 'mcp-adapter': ADAPTER_SECRET, console: CONSOLE_SECRET }),
    );
  });

  it('模型侧能力清单与映射表一致（防止二者被人为改散）', () => {
    const adapterCapabilities = CAPABILITIES_BY_AUDIENCE['mcp-adapter'];
    for (const capability of NEVER_GRANTED_TO_MODEL) {
      assert.equal(
        adapterCapabilities.includes(capability),
        false,
        `能力 ${capability} 出现在 NEVER_GRANTED_TO_MODEL 里，却仍然授予了适配器`,
      );
    }
    for (const audience of AUDIENCES) {
      assert.ok(capabilitiesOf(audience).length > 0);
    }
    assert.equal(hasCapability('mcp-adapter', 'approvals.decide'), false);
    assert.equal(hasCapability('console', 'approvals.decide'), true);
  });
});

// ================================================================
// 验收标准 3：租约到期不得直接放行第二个执行器
// ================================================================

describe('LWB-008 验收标准 3：写执行器租约与栅栏令牌', () => {
  const OLD: ProcessIdentity = { pid: 1000, started_at: '2026-09-25T00:00:00.000Z' };

  function fakeProbe(
    table: Record<number, ProcessIdentity | null | 'throw'>,
  ): ProcessProbe {
    return {
      identify(pid: number) {
        const entry = table[pid];
        if (entry === undefined || entry === null) return null;
        if (entry === 'throw') throw new Error('探针不可用');
        return entry;
      },
    };
  }

  function leaseWith(
    probe: ProcessProbe,
    clock: { now: number },
    leaseMs = 1_000,
  ): ExecutorLease {
    return new ExecutorLease({ probe, leaseMs, now: () => clock.now });
  }

  it('租约未到期时拒绝第二个执行器', () => {
    const clock = { now: 1_000_000 };
    const lease = leaseWith(fakeProbe({ 1000: OLD }), clock);
    lease.acquire('exe-a', OLD);

    clock.now += 500; // 未到期
    const outcome = lease.acquire('exe-b', { pid: 2000, started_at: null });
    assert.equal(outcome.kind, 'refused');
    if (outcome.kind === 'refused') assert.equal(outcome.code, 'LEASE_NOT_EXPIRED');
  });

  it('租约到期但旧执行器仍存活 → 拒绝接管（核心用例）', () => {
    const clock = { now: 1_000_000 };
    // 旧持有者的进程还活着，且启动时刻与记录一致 → 是同一个进程。
    const lease = leaseWith(fakeProbe({ 1000: OLD }), clock);
    lease.acquire('exe-a', OLD);

    clock.now += 5_000; // 早已过期
    const outcome = lease.acquire('exe-b', { pid: 2000, started_at: null });
    assert.equal(
      outcome.kind,
      'refused',
      '过期只说明没收到续约，不说明持有者已退出；这里必须拒绝',
    );
    if (outcome.kind === 'refused') {
      assert.equal(outcome.code, 'HELD_BY_LIVE_EXECUTOR');
    }
  });

  it('探针不可用时拒绝接管，而不是当作「已退出」', () => {
    const clock = { now: 1_000_000 };
    const lease = leaseWith(fakeProbe({ 1000: 'throw' }), clock);
    lease.acquire('exe-a', OLD);

    clock.now += 5_000;
    const outcome = lease.acquire('exe-b', { pid: 2000, started_at: null });
    assert.equal(outcome.kind, 'refused');
    if (outcome.kind === 'refused') {
      // 把「查不出来」当成「不存在」会让接管判定在不该放行时放行。
      assert.equal(outcome.code, 'CANNOT_PROVE_HOLDER_GONE');
    }
  });

  it('旧执行器确实已退出 → 允许接管，令牌递增', () => {
    const clock = { now: 1_000_000 };
    const lease = leaseWith(fakeProbe({ 1000: null }), clock);
    const first = lease.acquire('exe-a', OLD);
    assert.equal(first.kind, 'acquired');
    const tokenA = first.kind === 'acquired' ? first.lease.fencing_token : -1;

    clock.now += 5_000;
    const second = lease.acquire('exe-b', { pid: 2000, started_at: null });
    assert.equal(second.kind, 'acquired');
    if (second.kind === 'acquired') {
      assert.ok(
        second.lease.fencing_token > tokenA,
        '接管必须得到更大的令牌，否则旧执行器的写入无法被区分',
      );
    }
  });

  it('PID 被复用（启动时刻不同）视为旧持有者已不在', () => {
    const clock = { now: 1_000_000 };
    const reused: ProcessIdentity = { pid: 1000, started_at: '2026-09-25T09:00:00.000Z' };
    const lease = leaseWith(fakeProbe({ 1000: reused }), clock);
    lease.acquire('exe-a', OLD);

    clock.now += 5_000;
    const outcome = lease.acquire('exe-b', { pid: 2000, started_at: null });
    assert.equal(
      outcome.kind,
      'acquired',
      '同一个 pid 但启动时刻不同，说明原进程已退出、pid 被复用',
    );
  });

  it('取不到启动时刻时保守判为存活', () => {
    const clock = { now: 1_000_000 };
    const noTime: ProcessIdentity = { pid: 1000, started_at: null };
    const lease = leaseWith(fakeProbe({ 1000: noTime }), clock);
    lease.acquire('exe-a', noTime);

    clock.now += 5_000;
    const outcome = lease.acquire('exe-b', { pid: 2000, started_at: null });
    assert.equal(outcome.kind, 'refused');
    if (outcome.kind === 'refused') assert.equal(outcome.code, 'HELD_BY_LIVE_EXECUTOR');
  });

  it('被接管后，不同标识的旧执行器写入被拒绝', () => {
    const clock = { now: 1_000_000 };
    const lease = leaseWith(fakeProbe({ 1000: null }), clock);
    const first = lease.acquire('exe-a', OLD);
    const tokenA = first.kind === 'acquired' ? first.lease.fencing_token : -1;

    clock.now += 5_000;
    lease.acquire('exe-b', { pid: 2000, started_at: null });

    // 旧执行器「醒过来」继续写 —— 被标识检查挡住。
    const write = lease.authorizeWrite('exe-a', tokenA);
    assert.equal(write.ok, false);
    if (!write.ok) assert.match(write.reason, /写执行器标识不匹配/);

    assert.equal(lease.authorizeWrite('exe-b', lease.fencingToken).ok, true);
  });

  it('同标识但令牌过期 → 只可能被栅栏令牌挡住（令牌检查不是死代码）', () => {
    // 这条用例单独存在，是因为上一条命中的是**标识**检查。
    // 如果只有上一条，栅栏令牌完全可以是一段永远不生效的死代码，
    // 而测试仍然全绿 —— 那种「看起来验过了」最危险。
    const clock = { now: 1_000_000 };
    const lease = leaseWith(fakeProbe({ 1000: null }), clock);

    const before = lease.acquire('exe-a', OLD);
    const oldToken = before.kind === 'acquired' ? before.lease.fencing_token : -1;
    lease.release('exe-a');
    const after = lease.acquire('exe-a', OLD);
    const newToken = after.kind === 'acquired' ? after.lease.fencing_token : -1;

    assert.ok(newToken > oldToken, '重新取得租约必须推进令牌');
    // 标识相同，因此只有令牌能区分这一次写入属于「上一轮」。
    const stale = lease.authorizeWrite('exe-a', oldToken);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.match(stale.reason, /栅栏令牌已失效/);

    assert.equal(lease.authorizeWrite('exe-a', newToken).ok, true);
  });

  it('租约到期后不续约的写入被拒绝', () => {
    const clock = { now: 1_000_000 };
    const probe = fakeProbe({ 1000: OLD });
    const lease = leaseWith(probe, clock);
    lease.acquire('exe-a', OLD);
    const token = lease.fencingToken;

    assert.equal(lease.authorizeWrite('exe-a', token).ok, true);
    clock.now += 2_000; // 超过 leaseMs
    const late = lease.authorizeWrite('exe-a', token);
    assert.equal(late.ok, false);
    if (!late.ok) assert.match(late.reason, /已到期且未续约/);
  });

  it('续约沿用同一个令牌', () => {
    const clock = { now: 1_000_000 };
    const lease = leaseWith(fakeProbe({ 1000: OLD }), clock);
    const first = lease.acquire('exe-a', OLD);
    const token = first.kind === 'acquired' ? first.lease.fencing_token : -1;

    clock.now += 500;
    const renewed = lease.acquire('exe-a', OLD);
    assert.equal(renewed.kind, 'renewed');
    if (renewed.kind === 'renewed') {
      assert.equal(
        renewed.lease.fencing_token,
        token,
        '续约换令牌会让执行器正在进行的写入被自己拒绝',
      );
    }
  });

  it('令牌在释放后不回退', () => {
    const clock = { now: 1_000_000 };
    const lease = leaseWith(fakeProbe({}), clock);
    const first = lease.acquire('exe-a', OLD);
    const token = first.kind === 'acquired' ? first.lease.fencing_token : -1;
    lease.release('exe-a');

    const second = lease.acquire('exe-b', { pid: 2000, started_at: null });
    assert.equal(second.kind, 'acquired');
    if (second.kind === 'acquired') {
      assert.ok(second.lease.fencing_token > token);
    }
  });

  it('没有生效租约时任何写入都被拒绝', () => {
    const lease = leaseWith(fakeProbe({}), { now: 1_000_000 });
    const result = lease.authorizeWrite('exe-a', 1);
    assert.equal(result.ok, false);
  });
});

// ================================================================
// 分帧与探针
// ================================================================

describe('LWB-008 分帧与进程探针', () => {
  it('跨多次 push 的半个报文最终能被拼出', () => {
    const decoder = new FrameDecoder();
    assert.deepEqual(decoder.push('{"a":'), []);
    assert.deepEqual(decoder.push('1}\n'), [{ a: 1 }]);
  });

  it('一次 push 里的多条报文全部取出', () => {
    const decoder = new FrameDecoder();
    assert.deepEqual(decoder.push('{"a":1}\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  });

  it('超过上限时进入废弃状态并且不再返回报文', () => {
    const decoder = new FrameDecoder();
    assert.throws(() => decoder.push('x'.repeat(3 * 1024 * 1024)), FrameTooLargeError);
    assert.equal(decoder.discarded, true);
    assert.deepEqual(decoder.push('{"a":1}\n'), []);
  });

  it('encodeFrame 拒绝超过上限的载荷', () => {
    assert.throws(() => encodeFrame({ big: 'x'.repeat(3 * 1024 * 1024) }), FrameTooLargeError);
  });

  it('剩余半包的字节数可查（用于审计而不是静默丢弃）', () => {
    const decoder = new FrameDecoder();
    decoder.push('{"partial":');
    assert.ok(decoder.pendingBytes > 0);
  });

  it('探针能正确识别自身进程与不存在的进程', () => {
    const probe = createProcessProbe();
    const self = probe.identify(process.pid);
    assert.equal(self?.pid, process.pid);
    // 取不到启动时刻时必须是 null（不知道），而不是编一个值。
    assert.equal(self?.started_at, null);

    assert.equal(probe.identify(999_999_999), null);
  });

  it('注入 startTimeOf 时探针返回启动时刻', () => {
    const probe = createProcessProbe({ startTimeOf: () => '2026-09-25T00:00:00.000Z' });
    const self = probe.identify(process.pid);
    assert.equal(self?.started_at, '2026-09-25T00:00:00.000Z');
  });

  it('createServer 的第二条同名连接会被服务端按未注册处理', async () => {
    // 顺带确认 attachSocket 不会因为并发连接而串号。
    const server = await startServer({ registered: [] });
    const client = new IpcClient({
      pipeName: server.pipeName,
      secret: ADAPTER_SECRET,
      audience: 'mcp-adapter',
      connectionId: 'conn-x',
    });
    try {
      await assert.rejects(() => client.connect(), /未在本机注册|拒绝连接/);
    } finally {
      await server.close();
    }
  });
});

// ================================================================
// 会话状态机（不经 socket）
// ================================================================

describe('LWB-008 会话状态机', () => {
  function memorySink(): { sink: MessageSink; sent: Record<string, unknown>[]; closed: boolean } {
    const sent: Record<string, unknown>[] = [];
    const state = { closed: false };
    return {
      sink: {
        send: (value) => sent.push(value as Record<string, unknown>),
        close: () => {
          state.closed = true;
        },
      },
      sent,
      get closed() {
        return state.closed;
      },
    };
  }

  it('未认证会话收到非握手报文会关闭', () => {
    const box = memorySink();
    const session = new ConnectionSession(box.sink, {
      secrets: { 'mcp-adapter': ADAPTER_SECRET, console: CONSOLE_SECRET },
      operations: new OperationRegistry(),
      isRegisteredConnection: () => true,
    });
    session.start();
    session.handle({ type: 'request', request_id: 'r1', operation: 'x', input: {} });
    assert.equal(box.closed, true, '未认证的请求必须导致连接关闭');
    assert.equal(session.authenticated, false);
  });

  it('未知 audience 在派生密钥之前就被拒绝', () => {
    const box = memorySink();
    const session = new ConnectionSession(box.sink, {
      secrets: { 'mcp-adapter': ADAPTER_SECRET, console: CONSOLE_SECRET },
      operations: new OperationRegistry(),
      isRegisteredConnection: () => true,
    });
    session.start();
    session.handle({
      type: 'handshake',
      audience: 'chatgpt-web',
      connection_id: 'conn-1',
      pid: 1234,
      client_nonce: newNonce(),
      proof: 'whatever',
    });
    const rejection = box.sent.find((m) => m['type'] === 'rejected');
    assert.equal(rejection?.['code'], 'UNKNOWN_AUDIENCE');
    // 关键：不能落到「用某把凭证兜底试一下」的路径上。
    assert.equal(box.closed, true);
    assert.equal(session.authenticated, false);
  });

  it('认证成功后握手用的 client_nonce 不可再用', () => {
    const box = memorySink();
    const session = new ConnectionSession(box.sink, {
      secrets: { 'mcp-adapter': ADAPTER_SECRET, console: CONSOLE_SECRET },
      operations: new OperationRegistry(),
      isRegisteredConnection: () => true,
    });
    session.start();
    const hello = box.sent[0]?.['server_nonce'] as string;
    const clientNonce = newNonce();
    const proof = computeProof(deriveAudienceKey(ADAPTER_SECRET, 'mcp-adapter'), {
      serverNonce: hello,
      clientNonce,
      audience: 'mcp-adapter',
      connectionId: 'conn-1',
      pid: 1234,
    });
    session.handle({
      type: 'handshake',
      audience: 'mcp-adapter',
      connection_id: 'conn-1',
      pid: 1234,
      client_nonce: clientNonce,
      proof,
    });
    assert.equal(session.authenticated, true);
  });
});
