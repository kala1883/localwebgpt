/**
 * LWB-008 步骤 3/4：子进程归属、退出，以及启动时刻探针。
 *
 * 这些用例**真的起进程**，因为要验证的正是「进程会不会退出」——
 * 用假的 ChildProcess 测这件事没有意义。
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { ProcessRegistry } from '../../apps/daemon/src/lifecycle/index.ts';
import {
  StartTimeCache,
  isProcessAlive,
  queryProcessStartTime,
} from '../../apps/daemon/src/lifecycle/index.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 起一个会活一会儿的 node 子进程。 */
function spawnSleeper(ms: number) {
  return spawn(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function hasPwsh(): boolean {
  const probe = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], {
    windowsHide: true,
    timeout: 10_000,
  });
  return probe.status === 0;
}

const PWSH = hasPwsh();

describe('LWB-008 子进程归属与退出', () => {
  it('terminateAll 会真正终止已登记的子进程', async () => {
    const registry = new ProcessRegistry();
    const a = spawnSleeper(30_000);
    const b = spawnSleeper(30_000);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    registry.track('sleeper-a', a);
    registry.track('sleeper-b', b);
    assert.equal(registry.size, 2);

    const result = await registry.terminateAll(5_000);
    assert.deepEqual([...result.terminated].sort(), ['sleeper-a', 'sleeper-b']);
    assert.deepEqual(result.stubborn, [], '正常退出的子进程不应被判为顽抗');
    assert.equal(registry.size, 0);

    // 用操作系统的事实确认，而不是相信 kill() 的返回值。
    assert.equal(isProcessAlive(a.pid ?? -1), false);
    assert.equal(isProcessAlive(b.pid ?? -1), false);
  });

  it('已退出的子进程不会被算作顽抗', async () => {
    const registry = new ProcessRegistry();
    const child = spawnSleeper(1);
    registry.track('short-lived', child);
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));

    const result = await registry.terminateAll(500);
    assert.deepEqual(result.stubborn, []);
  });

  it('退出流程开始后拒绝登记新子进程，并直接杀掉它', async () => {
    const registry = new ProcessRegistry();
    await registry.terminateAll(10);
    const late = spawnSleeper(30_000);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    assert.throws(() => registry.track('late', late), /正在退出/);
    // 未被登记的子进程会活过 daemon，所以必须就地终止。
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    assert.equal(isProcessAlive(late.pid ?? -1), false);
  });

  it('没有 pid 的子进程被拒绝登记', () => {
    const registry = new ProcessRegistry();
    assert.throws(
      () => registry.track('no-pid', { pid: undefined } as never),
      /没有 pid/,
    );
  });
});

describe('LWB-008 原生助手不会成为孤儿', () => {
  it(
    '父进程关闭 stdin 后助手自行退出',
    { skip: !PWSH ? 'pwsh 不可用' : false },
    async () => {
      // 这条用例对应 `SecureStore.ps1` 的 `ReadLine() == $null → break`。
      // 它是 daemon 被强杀（来不及执行 terminateAll）时唯一的缓解手段，
      // 因此必须实测，而不是引用源码行号了事。
      const helper = spawn(
        'pwsh',
        ['-NoProfile', '-NonInteractive', '-File', path.join(repoRoot, 'packages', 'secure-store', 'SecureStore.ps1')],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );

      const exited = new Promise<number | null>((resolve) => {
        helper.once('exit', (code) => resolve(code));
      });

      // 先确认它真的起来了（不然「退出」可能只是启动失败）。
      let stdout = '';
      helper.stdout.setEncoding('utf8');
      helper.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      helper.stdin.write(`${JSON.stringify({ id: 'p1', op: 'whoami' })}\n`);

      const gotResponse = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 20_000);
        const check = (): void => {
          if (stdout.includes('\n')) {
            clearTimeout(timer);
            resolve(true);
          }
        };
        helper.stdout.on('data', check);
        check();
      });
      assert.equal(gotResponse, true, '助手必须先能响应，否则这条用例证明不了任何事');

      // 现在模拟父进程消失：只关掉管道，不发任何终止信号。
      helper.stdin.end();
      const code = await Promise.race([
        exited,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
      ]);

      assert.notEqual(code, 'timeout', 'stdin 关闭后助手必须自行退出，否则它会成为孤儿');
      assert.equal(isProcessAlive(helper.pid ?? -1), false);
    },
  );
});

describe('LWB-008 启动时刻探针', () => {
  it('查询自身进程的启动时刻', { skip: !PWSH ? 'pwsh 不可用' : false }, async () => {
    const startedAt = await queryProcessStartTime(process.pid);
    const parsed = Date.parse(startedAt);
    assert.equal(Number.isNaN(parsed), false);
    // 本进程一定是在过去启动的，且不早于 2020 年（挡住「返回了 1970」这类解析错误）。
    assert.ok(parsed <= Date.now() + 5_000);
    assert.ok(parsed > Date.parse('2020-01-01T00:00:00Z'));
  });

  it('查询不存在的进程会失败（而不是返回一个时刻）', { skip: !PWSH ? 'pwsh 不可用' : false }, async () => {
    await assert.rejects(
      () => queryProcessStartTime(999_999_999),
      /未得到有效结果|启动时刻失败/,
    );
  });

  it('StartTimeCache 同步读、异步填充', { skip: !PWSH ? 'pwsh 不可用' : false }, async () => {
    const cache = new StartTimeCache();
    // 填充之前是 null（= 不知道），不是编造的值。
    assert.equal(cache.get(process.pid), null);

    const filled = await cache.refresh(process.pid);
    assert.equal(filled.ok, true);
    const startedAt = cache.get(process.pid);
    assert.notEqual(startedAt, null);

    const probe = cache.toProbe();
    assert.deepEqual(probe.identify(process.pid), { pid: process.pid, started_at: startedAt });
    // 不存在的进程返回 null（进程层面的「不存在」）。
    assert.equal(probe.identify(999_999_999), null);
  });

  it('refresh 对不存在的进程清掉旧记录并如实回报', { skip: !PWSH ? 'pwsh 不可用' : false }, async () => {
    const cache = new StartTimeCache();
    const result = await cache.refresh(999_999_999);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /不存在/);
    assert.equal(cache.get(999_999_999), null);
  });

  it('isProcessAlive 对自身为真、对不存在的 pid 为假', () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(999_999_999), false);
  });
});
