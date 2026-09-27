/**
 * LWB-008 可复现证据采集。
 *
 * 三条验收标准各有一段，全部走**真实命名管道**与**真实进程**：
 * 单实例互斥与连接认证都是管道这一层的行为，用假传输层测出来的结论
 * 支撑不了这两条验收。
 *
 * 用法：node --import tsx scripts/evidence/lwb-008.ts
 * 退出码：全部通过 0；任一项失败 1。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import process from 'node:process';

import {
  ExecutorLease,
  IpcClient,
  OperationRegistry,
  acquireSingleInstance,
  attachSocket,
  createProcessProbe,
  releaseSingleInstance,
  type ProcessIdentity,
} from '@lwb/ipc';

const SID = 'S-1-5-21-4247710454-1492826582-129756499-1001';
const ADAPTER_SECRET = 'evidence-adapter-secret-0123456789';
const CONSOLE_SECRET = 'evidence-console-secret-0123456789';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function uniquePipeName(): string {
  return `\\\\.\\pipe\\lwb-evidence-${process.pid}-${Date.now()}`;
}

async function main(): Promise<void> {
  console.log('== 环境 ==');
  console.log(`平台: ${process.platform} ${process.arch}`);
  console.log(`Node: ${process.version}`);
  console.log(`PID: ${process.pid}`);
  console.log('');

  // ---------------------------------------------------------------
  console.log('== 验收标准 1：第二个 daemon 不会并发写同一个状态库/工作区 ==');
  const first = await acquireSingleInstance({ userSid: SID, onConnection: () => {} });
  check('首个实例取得控制管道', first.kind === 'acquired');

  const second = await acquireSingleInstance({ userSid: SID, onConnection: () => {} });
  check('第二个实例被拒绝', second.kind === 'occupied');
  if (second.kind === 'occupied') {
    console.log(`     拒绝理由: ${second.reason}`);
  }

  if (first.kind === 'acquired') {
    await releaseSingleInstance(first.server);
    const third = await acquireSingleInstance({ userSid: SID, onConnection: () => {} });
    check('释放后可重新绑定（崩溃一次不会永久占死）', third.kind === 'acquired');
    if (third.kind === 'acquired') await releaseSingleInstance(third.server);
  }
  console.log('');

  // ---------------------------------------------------------------
  console.log('== 验收标准 2：伪造本地连接、错误 audience 的凭据被拒绝 ==');
  const operations = new OperationRegistry();
  operations.register({
    name: 'workspaces.add',
    required: 'workspaces.manage',
    handler: () => ({ added: true }),
  });
  operations.register({
    name: 'files.read',
    required: 'tools.read',
    handler: () => ({ content: 'example' }),
  });

  const pipeName = uniquePipeName();
  const events: { type?: string; code?: string; audience?: string }[] = [];
  const server = createServer((socket) => {
    attachSocket(socket, {
      secrets: { 'mcp-adapter': ADAPTER_SECRET, console: CONSOLE_SECRET },
      operations,
      isRegisteredConnection: (id) => id === 'conn-1',
      onEvent: (event) => events.push(event as { type?: string }),
    });
  });
  await new Promise<void>((resolve) => server.listen(pipeName, () => resolve()));

  type AttemptResult =
    | { readonly connected: true; readonly client: IpcClient }
    | { readonly connected: false; readonly reason: string };

  async function attempt(
    label: string,
    secret: string,
    audience: 'mcp-adapter' | 'console',
    connectionId = 'conn-1',
  ): Promise<AttemptResult> {
    void label;
    const client = new IpcClient({ pipeName, secret, audience, connectionId });
    try {
      await client.connect();
      return { connected: true, client };
    } catch (error) {
      return { connected: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  const legit = await attempt('合法适配器', ADAPTER_SECRET, 'mcp-adapter');
  check('正确凭证可以连接', legit.connected);
  if (legit.connected) {
    console.log(`     授予能力: ${JSON.stringify(legit.client.capabilities)}`);
    const denied = await legit.client.call('workspaces.add', { path: 'D:\\x' });
    check(
      '适配器调用控制台专属操作被拒绝',
      denied.ok === false && denied.code === 'CAPABILITY_DENIED',
      denied.ok === false ? denied.code : '未被拒绝',
    );
    const allowed = await legit.client.call('files.read', { path: 'a.txt' });
    check('适配器调用自身能力内的操作成功', allowed.ok === true);
    await legit.client.close();
  }

  const forged = await attempt('伪造凭证', 'forged-secret-forged-secret-forged', 'mcp-adapter');
  check('伪造凭证被拒绝', !forged.connected, forged.connected ? '' : forged.reason ?? '');

  const swapA = await attempt('控制台凭证冒充适配器', CONSOLE_SECRET, 'mcp-adapter');
  check('控制台凭证冒充适配器被拒绝', !swapA.connected, swapA.connected ? '' : swapA.reason ?? '');

  const swapB = await attempt('适配器凭证冒充控制台', ADAPTER_SECRET, 'console');
  check('适配器凭证冒充控制台被拒绝（分离是双向的）', !swapB.connected, swapB.connected ? '' : swapB.reason ?? '');

  const unregistered = await attempt('未注册连接标识', ADAPTER_SECRET, 'mcp-adapter', 'conn-未注册');
  check('未注册的连接标识被拒绝', !unregistered.connected, unregistered.connected ? '' : unregistered.reason ?? '');

  console.log(`     服务端审计事件: ${JSON.stringify(events.map((e) => e.type ?? e.code))}`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log('');

  // ---------------------------------------------------------------
  console.log('== 验收标准 3：租约到期不得直接放行第二个执行器 ==');
  let clock = 1_000_000;
  const OLD: ProcessIdentity = { pid: 1000, started_at: '2026-09-25T00:00:00.000Z' };

  function leaseWith(probe: { identify(pid: number): ProcessIdentity | null }) {
    return new ExecutorLease({ probe, leaseMs: 1_000, now: () => clock });
  }

  const liveProbe = { identify: (pid: number) => (pid === 1000 ? OLD : null) };
  const leaseA = leaseWith(liveProbe);
  const firstLease = leaseA.acquire('exe-a', OLD);
  check('执行器 A 取得租约', firstLease.kind === 'acquired');
  const tokenA = firstLease.kind === 'acquired' ? firstLease.lease.fencing_token : -1;
  console.log(`     执行器 A 栅栏令牌: ${tokenA}`);

  clock += 5_000; // 早已过期
  const takeoverLive = leaseA.acquire('exe-b', { pid: 2000, started_at: null });
  check(
    '过期但旧执行器仍存活 → 拒绝接管',
    takeoverLive.kind === 'refused' && takeoverLive.code === 'HELD_BY_LIVE_EXECUTOR',
    takeoverLive.kind === 'refused' ? takeoverLive.code : takeoverLive.kind,
  );

  clock = 1_000_000;
  const throwingProbe = {
    identify: () => {
      throw new Error('探针不可用');
    },
  };
  const leaseB = leaseWith(throwingProbe);
  leaseB.acquire('exe-a', OLD);
  clock += 5_000;
  const takeoverUnknown = leaseB.acquire('exe-b', { pid: 2000, started_at: null });
  check(
    '探针不可用 → 拒绝接管（不当作「已退出」）',
    takeoverUnknown.kind === 'refused' && takeoverUnknown.code === 'CANNOT_PROVE_HOLDER_GONE',
    takeoverUnknown.kind === 'refused' ? takeoverUnknown.code : takeoverUnknown.kind,
  );

  clock = 1_000_000;
  const deadProbe = { identify: () => null };
  const leaseC = leaseWith(deadProbe);
  leaseC.acquire('exe-a', OLD);
  clock += 5_000;
  const takeoverDead = leaseC.acquire('exe-b', { pid: 2000, started_at: null });
  check('旧执行器确实已退出 → 允许接管', takeoverDead.kind === 'acquired');
  if (takeoverDead.kind === 'acquired') {
    console.log(`     执行器 B 栅栏令牌: ${takeoverDead.lease.fencing_token}（必须大于 A 的）`);
    check('接管后令牌递增', takeoverDead.lease.fencing_token > tokenA);
  }
  // 跨执行器：先命中的是「标识不匹配」。这**不能**证明栅栏令牌有效 ——
  // 两条检查都要单独证明，否则令牌这条可能是死代码。
  const crossExecutor = leaseC.authorizeWrite('exe-a', tokenA);
  check(
    '被接管后旧执行器（不同标识）的写入被拒绝',
    !crossExecutor.ok,
    crossExecutor.ok ? '' : crossExecutor.reason,
  );

  // 同一个执行器标识、令牌已推进：这条**只**能靠令牌检查挡住。
  clock = 1_000_000;
  const leaseD = leaseWith(deadProbe);
  const beforeRelease = leaseD.acquire('exe-a', OLD);
  const oldToken = beforeRelease.kind === 'acquired' ? beforeRelease.lease.fencing_token : -1;
  leaseD.release('exe-a');
  const afterReacquire = leaseD.acquire('exe-a', OLD);
  const newToken = afterReacquire.kind === 'acquired' ? afterReacquire.lease.fencing_token : -1;
  check('同标识重新取得租约会推进令牌', newToken > oldToken, `${oldToken} → ${newToken}`);

  const staleSameId = leaseD.authorizeWrite('exe-a', oldToken);
  check(
    '同标识但令牌过期 → 写入被拒绝（栅栏令牌本身有效）',
    !staleSameId.ok && /栅栏令牌已失效/.test(staleSameId.ok ? '' : staleSameId.reason),
    staleSameId.ok ? '未被拒绝' : staleSameId.reason,
  );
  console.log('');

  // ---------------------------------------------------------------
  console.log('== 子进程与探针（步骤 3）==');
  const { StartTimeCache, isProcessAlive, ProcessRegistry } = await import(
    '../../apps/daemon/src/lifecycle/index.ts'
  );

  const probe = createProcessProbe();
  check('探针能识别自身进程', probe.identify(process.pid) !== null);
  check('探针能识别不存在的进程', probe.identify(999_999_999) === null);

  const cache = new StartTimeCache();
  const filled = await cache.refresh(process.pid);
  if (filled.ok) {
    const startedAt = cache.get(process.pid);
    check('PowerShell 取到自身启动时刻', startedAt !== null, `启动时刻: ${startedAt}`);
  } else {
    check('PowerShell 取到自身启动时刻', false, filled.reason);
  }

  const registry = new ProcessRegistry();
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' });
  await new Promise<void>((resolve) => setTimeout(resolve, 200));
  registry.track('sleeper', sleeper);
  const terminated = await registry.terminateAll(5_000);
  check(
    'daemon 退出时终止已登记子进程',
    terminated.terminated.includes('sleeper') && terminated.stubborn.length === 0,
    `已终止 ${JSON.stringify(terminated.terminated)}，顽抗 ${JSON.stringify(terminated.stubborn)}`,
  );
  check('终止后用操作系统事实确认进程已不在', !isProcessAlive(sleeper.pid ?? -1));
  console.log('');

  console.log(failures === 0 ? '全部观测项通过。' : `${failures} 项未通过。`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
