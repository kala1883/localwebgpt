/**
 * 审计、限额与撤权（LWB-018）。
 *
 * | 验收标准 | 在哪一组 |
 * | --- | --- |
 * | 可回答某次工具调用读取和返回了哪些文件范围 | 「文件范围」「每次调用都有记录」 |
 * | 撤权后旧游标、缓存、Git 结果也不能返回 | 「撤权」 |
 * | G2 通过前只能用测试根，不能开放真实仓库写入 | **不在本文件**：它是一条阶段门禁，证据在 `docs/evidence/g2-read.md` |
 *
 * ## 这一组用例刻意不做的事
 *
 * 不用「记录条数」当断言。`assert.equal(rows.length, 3)` 这类断言在
 * 提取规则变化时会红，但红的原因往往是**规则本来该变**，于是它会被
 * 顺手改成新数字 —— 那一次修改里没有人需要回答「新数字对不对」。
 * 因此这里断的是**具体内容**：哪条路径、哪个行区间、哪一侧是 `delivered`。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LIMITS } from '@lwb/contracts';
import {
  AUDIT_METADATA_KEYS,
  answerToolCall,
  extractFileAccess,
  recordToolCall,
  screenMetadata,
  targetFileAccess,
} from '@lwb/audit';
import type { PauseStatus } from '@lwb/executor';
import { ConcurrencyGate, concurrencyGateFor, resolveLimits } from '@lwb/limits';
import type { WinfsError, WinfsOps, WinfsPathRef, WinfsReadResult } from '@lwb/winfs';

import { makeOps, treeOf, fileOf } from '../search/harness.ts';
import {
  ADAPTER_CONNECTION,
  GATES_ON,
  OTHER_CONNECTION,
  callTool,
  dataOf,
  errorOf,
  makeToolHarness,
} from '../tools/harness.ts';

// ---------------------------------------------------------------------------
// 文件范围提取
// ---------------------------------------------------------------------------

describe('LWB-018 · 文件范围提取', () => {
  it('file_read 的闭区间由开区间推出来；空区间只记路径', () => {
    assert.deepEqual(extractFileAccess('file_read', { path: 'a/b.txt', start_line: 10, end_line_exclusive: 15 }), [
      { path: 'a/b.txt', start_line: 10, end_line: 14, delivered: true },
    ]);
    // 空区间（空文件 / 游标落在末尾）**两侧都不记**：记成「从第 1 行开始、
    // 没有结束」会读作「读了第 1 行」，而那时一行都没返回。
    assert.deepEqual(extractFileAccess('file_read', { path: 'a/b.txt', start_line: 1, end_line_exclusive: 1 }), [
      { path: 'a/b.txt', start_line: null, end_line: null, delivered: true },
    ]);
  });

  it('file_list 记目录本身与每一个条目（名字出去了就是要记）', () => {
    const rows = extractFileAccess('file_list', {
      path: 'src',
      entries: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
    });
    assert.deepEqual(
      rows.map((row) => row.path),
      ['src', 'src/a.ts', 'src/b.ts'],
    );
  });

  it('text_search 按 (路径, 行号) 去重，不重复记同一行', () => {
    const rows = extractFileAccess('text_search', {
      matches: [
        { path: 'a.ts', line_number: 3 },
        { path: 'a.ts', line_number: 3 },
        { path: 'a.ts', line_number: 9 },
      ],
    });
    assert.deepEqual(rows, [
      { path: 'a.ts', start_line: 3, end_line: 3, delivered: true },
      { path: 'a.ts', start_line: 9, end_line: 9, delivered: true },
    ]);
  });

  it('git_status 记 entries 与 excluded 两侧', () => {
    const rows = extractFileAccess('git_status', {
      entries: [{ path: 'modified.txt' }],
      excluded: [{ path: '.env', reason: 'SECRET_RULE' }],
    });
    // 被排除的文件**也要记**：它的路径确实出站了（还带着排除原因）。
    assert.deepEqual(
      rows.map((row) => row.path),
      ['modified.txt', '.env'],
    );
  });

  it('git_diff 不记行区间：它读的是两侧的整个文件', () => {
    assert.deepEqual(extractFileAccess('git_diff', { path: 'x.txt' }), [
      { path: 'x.txt', start_line: null, end_line: null, delivered: true },
    ]);
  });

  it('不碰工作区的两个工具记零行', () => {
    assert.deepEqual(extractFileAccess('bridge_status', { paused: false }), []);
    assert.deepEqual(extractFileAccess('workspace_list', { workspaces: [] }), []);
  });

  it('形状不符时**抛**，不返回空数组', () => {
    // 空数组的含义是「这次调用没有碰任何文件」——一个与「我不知道」
    // 完全不同的断言，而它会被写进审计并长期留存。
    assert.throws(() => extractFileAccess('file_read', { path: 'a.txt' }), /start_line/);
    assert.throws(() => extractFileAccess('file_list', { path: 'src' }), /entries/);
    // `file_read` 的行号在输出契约里是**必填正整数**，因此缺字段是契约漂移，
    // 不是「整文件访问」—— 两者在审计里长得一模一样，必须在这里分开。
    assert.throws(() => extractFileAccess('file_read', { path: 'a.txt', start_line: 1 }), /end_line_exclusive/);
    assert.throws(
      () => extractFileAccess('text_search', { matches: [{ path: 'a.ts' }] }),
      /line_number/,
    );
  });

  it('失败的调用记入参里的目标路径，且**拒绝**记绝对路径', () => {
    assert.deepEqual(targetFileAccess('file_read', { path: 'a/b.txt' }), [
      { path: 'a/b.txt', start_line: null, end_line: null, delivered: false },
    ]);
    // 被拒绝的路径上，调用方发来的 path 完全可能是绝对路径。
    // 把它写进审计等于让**调用方**决定审计里出现什么本机路径。
    assert.deepEqual(targetFileAccess('file_read', { path: 'C:\\Windows\\System32\\hosts' }), []);
    assert.deepEqual(targetFileAccess('file_read', { path: '../escape.txt' }), []);
    // 可选 path 的工具没给 path ⇒ 目标是工作区根。
    assert.deepEqual(targetFileAccess('file_list', {}), [
      { path: '', start_line: null, end_line: null, delivered: false },
    ]);
    assert.deepEqual(targetFileAccess('file_read', {}), []);
  });
});

// ---------------------------------------------------------------------------
// 补充信息筛查
// ---------------------------------------------------------------------------

describe('LWB-018 · 审计补充信息筛查', () => {
  it('白名单里没有任何一个「顺手把手上有的东西塞进去」的键', () => {
    // 这三行是这层筛查存在的理由；把它们写进断言，是为了让「有人加了
    // 一个叫 path 的键」在**这里**就红，而不是在泄漏之后。
    for (const forbidden of ['path', 'content', 'query', 'snippet', 'body', 'text']) {
      assert.ok(!AUDIT_METADATA_KEYS.includes(forbidden), `${forbidden} 不该出现在白名单里`);
    }
  });

  it('清单之外的键被拒绝，不静默丢弃', () => {
    assert.throws(() => screenMetadata({ unexpected_key: 1 }), /不在允许清单内/);
    assert.throws(() => screenMetadata({ Path: 'a.txt' }), /键名不合规/);
  });

  it('长值、控制字符、绝对路径都被拒绝', () => {
    assert.throws(() => screenMetadata({ reason: 'x'.repeat(201) }), /超过 200 字符/);
    assert.throws(() => screenMetadata({ reason: 'a\nb' }), /控制字符/);
    assert.throws(() => screenMetadata({ reason: 'C:\\Users\\me\\x' }), /绝对路径/);
    assert.throws(() => screenMetadata({ reason: '/etc/passwd' }), /绝对路径/);
    assert.throws(() => screenMetadata({ reason: '\\\\server\\share' }), /绝对路径/);
    // 非标量（对象/数组）同样拒绝：它们能装下任意内容。
    assert.throws(() => screenMetadata({ reason: { nested: 1 } as unknown as string }), /不是标量/);
  });

  it('合法的键值原样通过', () => {
    assert.deepEqual(screenMetadata({ generation: 3, reason: 'REVOKED_BEFORE_RETURN' }), {
      generation: 3,
      reason: 'REVOKED_BEFORE_RETURN',
    });
    // 只有 `/` 分隔的相对路径不是绝对路径：不误伤。
    assert.deepEqual(screenMetadata({ alias: 'src/lib' }), { alias: 'src/lib' });
  });
});

// ---------------------------------------------------------------------------
// 限额解析
// ---------------------------------------------------------------------------

describe('LWB-018 · 限额叠加与方向', () => {
  it('收紧被接受', () => {
    const result = resolveLimits({ MAX_CONCURRENT_READS: 1 });
    assert.deepEqual(result.accepted, ['MAX_CONCURRENT_READS']);
    assert.deepEqual(result.rejected, []);
    assert.equal(result.limits.MAX_CONCURRENT_READS, 1);
    // 未提及的项保持初值。
    assert.equal(result.limits.MAX_READ_LINES, LIMITS.MAX_READ_LINES);
  });

  it('放宽被拒绝，且理由是方向而不是语法', () => {
    const result = resolveLimits({ MAX_CONCURRENT_READS: LIMITS.MAX_CONCURRENT_READS + 1 });
    assert.deepEqual(result.accepted, []);
    assert.equal(result.limits.MAX_CONCURRENT_READS, LIMITS.MAX_CONCURRENT_READS);
    assert.match(result.rejected[0]?.reason ?? '', /只能收紧/);
  });

  it('方向拿**上一层的结果**比，不是拿初值比', () => {
    // 若拿初值比，第二层看到的会是一个已经放宽后的基准，于是
    // 「第一层放宽、第二层声明没放宽」就是一条可行路径。
    // 这里第一层收紧到 2，第二层想回到 4：4 ≤ 初值(4)，但对上一层是放宽。
    const first = resolveLimits({ MAX_CONCURRENT_READS: 2 });
    assert.deepEqual(first.accepted, ['MAX_CONCURRENT_READS']);
    const second = resolveLimits({ MAX_CONCURRENT_READS: LIMITS.MAX_CONCURRENT_READS }, first.limits);
    assert.deepEqual(second.accepted, []);
    assert.equal(second.limits.MAX_CONCURRENT_READS, 2, '上一层的收紧必须保持生效');
  });

  it('固定项与不可调项被拒绝，且认得出是哪一种', () => {
    const fixed = resolveLimits({ MAX_CONCURRENT_WRITES_PER_WORKSPACE: 1 });
    assert.match(fixed.rejected[0]?.reason ?? '', /不允许由配置覆盖/);
    const unknown = resolveLimits({ NOT_A_LIMIT: 1 });
    assert.match(unknown.rejected[0]?.reason ?? '', /未知限额键/);
  });

  it('写错的配置不让 daemon 起不来，但必须有去处', () => {
    const result = resolveLimits({ MAX_READ_LINES: 0, MAX_CONCURRENT_READS: 'x' });
    // 两项都被拒绝而不是抛错：本地操作者不该为了把 daemon 拉起来
    // 而把整份配置删掉，连合法的收紧一起丢掉。
    assert.equal(result.rejected.length, 2);
    // 被拒绝的值只按**类型/长度**回报，不把值原样带出去。
    assert.equal(result.rejected.find((r) => r.key === 'MAX_CONCURRENT_READS')?.value, '<string:1>');
  });

  it('返回的表是冻结的：调用方不能就地改生效限额', () => {
    const result = resolveLimits({});
    assert.ok(Object.isFrozen(result.limits));
    assert.throws(() => {
      (result.limits as unknown as Record<string, number>)['MAX_READ_LINES'] = 1e9;
    }, TypeError);
  });

  it('concurrencyGateFor 取的是**生效值**而不是初值', () => {
    const gate = concurrencyGateFor({ ...LIMITS, MAX_CONCURRENT_READS: 1 });
    assert.equal(gate.limits.max_concurrent, 1);
  });
});

// ---------------------------------------------------------------------------
// 并发闸门
// ---------------------------------------------------------------------------

describe('LWB-018 · 并发闸门', () => {
  /** 不真的等待的闸门。`sleep` 注入后 `waited_ms` 仍由注入的时钟决定。 */
  function gateOf(options: ConstructorParameters<typeof ConcurrencyGate>[0] = {}): ConcurrencyGate {
    let clock = 0;
    return new ConcurrencyGate({
      wait_ms: 0,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      ...options,
    });
  }

  it('满额时立即拒绝（wait_ms=0），并说明本次未执行', async () => {
    const gate = gateOf({ max_concurrent: 1, max_per_connection: 1 });
    const first = await gate.acquire('c1');
    assert.ok(first.ok);
    const second = await gate.acquire('c1');
    assert.ok(!second.ok);
    assert.equal(second.reason, 'CONNECTION_LIMIT_EXCEEDED');
    assert.equal(second.in_flight, 1);
    assert.equal(second.limit, 1);
  });

  it('每连接上限满与全局上限满分得清（两者对操作者的含义不同）', async () => {
    const gate = gateOf({ max_concurrent: 4, max_per_connection: 1 });
    const held = await gate.acquire('c1');
    assert.ok(held.ok);
    // c1 自己占满：报「这条连接太贪」。
    const sameConnection = await gate.acquire('c1');
    assert.ok(!sameConnection.ok);
    assert.equal(sameConnection.reason, 'CONNECTION_LIMIT_EXCEEDED');
    // 另一条连接在每连接上限上没满，因此它**应该**拿得到位置 ——
    // 这正是二级限流存在的理由。
    const other = await gate.acquire('c2');
    assert.ok(other.ok);
    other.lease.release();
  });

  it('全局上限满时报 GLOBAL_LIMIT_EXCEEDED', async () => {
    const gate = gateOf({ max_concurrent: 2, max_per_connection: 2 });
    const a = await gate.acquire('c1');
    const b = await gate.acquire('c2');
    assert.ok(a.ok && b.ok);
    const third = await gate.acquire('c3');
    assert.ok(!third.ok);
    assert.equal(third.reason, 'GLOBAL_LIMIT_EXCEEDED');
    assert.equal(third.limit, 2);
  });

  it('释放后位置回来；重复释放抛（记账错误不得静默吞掉）', async () => {
    const gate = gateOf({ max_concurrent: 1, max_per_connection: 1 });
    const first = await gate.acquire('c1');
    assert.ok(first.ok);
    first.lease.release();
    assert.deepEqual(gate.snapshot().connections, {});
    assert.throws(() => first.lease.release(), /重复释放/);
    const again = await gate.acquire('c1');
    assert.ok(again.ok);
    again.lease.release();
  });

  it('等待有上界：等到 wait_ms 就拒绝，而不是无限排队', async () => {
    const gate = gateOf({ max_concurrent: 1, max_per_connection: 1, wait_ms: 100, poll_ms: 25 });
    const held = await gate.acquire('c1');
    assert.ok(held.ok);
    // 注入的 sleep 只推进时钟，因此这一次调用在真实时间里是瞬时的，
    // 而它经历的**逻辑等待**恰好是上界。
    const waited = await gate.acquire('c1');
    assert.ok(!waited.ok);
    assert.equal(waited.waited_ms, 100);
    held.lease.release();
  });

  it('等到了位置就不再拒绝（另一个调用在等待期间释放）', async () => {
    let clock = 0;
    let releaseHeld: (() => void) | null = null;
    const gate = new ConcurrencyGate({
      max_concurrent: 1,
      max_per_connection: 1,
      wait_ms: 100,
      poll_ms: 25,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        // 第一次睡眠时释放，模拟「本机刚好空出来」。
        if (clock === 25) releaseHeld?.();
      },
    });
    const held = await gate.acquire('c1');
    assert.ok(held.ok);
    releaseHeld = () => held.lease.release();

    const waited = await gate.acquire('c1');
    assert.ok(waited.ok, '等待期间位置空出来了，就该拿到');
    waited.lease.release();
  });

  it('上限配错就拒绝构造，不退化成默认值', () => {
    assert.throws(() => new ConcurrencyGate({ max_concurrent: 0 }), /至少为 1/);
    assert.throws(() => new ConcurrencyGate({ max_concurrent: -1 }), /非负整数/);
    assert.throws(() => new ConcurrencyGate({ wait_ms: 1.5 }), /非负整数/);
  });
});

// ---------------------------------------------------------------------------
// 每次调用都有记录
// ---------------------------------------------------------------------------

/**
 * 默认门禁是**全关**的（`GATES_OFF`），因此凡是要真的读到内容的用例
 * 都得显式打开它。这个默认本身就是一条断言：没有门禁就不该有内容出站，
 * 所以「忘了打开门禁」表现为一次 POLICY_DENIED，而不是一次静默的放行。
 */
const READ_ON = { gates: GATES_ON } as const;

/**
 * 一份「什么也没停」的暂停报告，给注入的桩暂停服务用。
 *
 * 它**不是**手写的假数据：类型来自 `@lwb/executor`，夹具改了形状这里
 * 会编译不过。而它的四个数组是真的空 —— 用它的那些用例测的都不是暂停，
 * 因此「报告里只有真的空」才是对装置的要求。
 */
function emptyPauseStatus(): PauseStatus {
  return {
    paused: false,
    paused_at: null,
    updated_at: null,
    stopping: [],
    unrevoked_change_sets: [],
    recovery_operations: [],
    unrecallable_file_rows: 0,
  };
}

describe('LWB-018 · 每次调用都有记录', () => {
  it('成功读取：审计能逐行回答「读了这个文件的这几行」', async () => {
    const harness = await makeToolHarness({
      ...READ_ON,
      tree: { 'a.txt': fileOf('one\ntwo\nthree\n') },
    });
    try {
      const envelope = await callTool(harness, 'file_read', { workspace_id: harness.workspace.id, path: 'a.txt' }, harness.adapterContext('req_a1'));
      const data = dataOf(envelope) as { end_line_exclusive: number };
      const answer = answerToolCall(harness.repos, 'req_a1');

      assert.equal(answer.calls.length, 1);
      const call = answer.calls[0];
      assert.equal(call?.tool, 'file_read');
      assert.equal(call?.subject, ADAPTER_CONNECTION, '工具调用的行为主体是**调用方**');
      assert.equal(call?.workspace_id, harness.workspace.id);
      assert.equal(call?.outcome, 'allow');
      assert.equal(call?.error_code, null);
      assert.ok((call?.bytes_out ?? 0) > 0, '出站字节必须被记下来');
      assert.deepEqual(answer.delivered, [
        { path: 'a.txt', start_line: 1, end_line: data.end_line_exclusive - 1 },
      ]);
      assert.deepEqual(answer.attempted, []);
      // 事件与它的文件行在**同一个事务**里：不可能出现「有事件没有行」。
      assert.equal(harness.repos.audit.fileAccessForEvent(call?.id ?? -1).length, 1);
    } finally {
      harness.close();
    }
  });

  it('被拒绝的调用：记下目标路径，但标记为**没有出站**', async () => {
    const harness = await makeToolHarness({ ...READ_ON, tree: { 'a.txt': fileOf('x') } });
    try {
      // 暂停工作区制造一次策略拒绝：`PAUSED` 是 business 类，
      // 因此在审计里记成 `deny`（被拒绝）而不是 `error`（本进程有 bug）。
      harness.repos.workspaces.setEnabled(harness.workspace.id, false);
      const envelope = await callTool(harness, 'file_read', { workspace_id: harness.workspace.id, path: 'a.txt' }, harness.adapterContext('req_a2'));
      assert.equal(errorOf(envelope).error.code, 'PAUSED');

      const answer = answerToolCall(harness.repos, 'req_a2');
      assert.equal(answer.calls[0]?.outcome, 'deny');
      assert.equal(answer.calls[0]?.error_code, 'PAUSED');
      assert.equal(answer.calls[0]?.bytes_out, 0);
      assert.deepEqual(answer.delivered, [], '什么都没出去');
      assert.deepEqual(answer.attempted, [{ path: 'a.txt', start_line: null, end_line: null }]);
    } finally {
      harness.close();
    }
  });

  it('能力不足记成 `error` 而不是 `deny` —— 因为它的错误码是 protocol 类', async () => {
    const harness = await makeToolHarness({ ...READ_ON, tree: { 'a.txt': fileOf('x') } });
    try {
      // 授权行里去掉 `read`：这是一次**授权**拒绝，但它走的是
      // `CAPABILITY_NOT_GRANTED` → `NOT_AUTHORIZED`（契约里归 protocol 类），
      // 于是 `outcomeOf` 把它记成 `error`。钉住它是因为这条分类直接决定
      // 审计里「拒绝率」这个数字的含义（见 docs/PROGRESS.md 偏离项 62）。
      harness.grant(ADAPTER_CONNECTION, harness.workspace.id, ['list']);
      const envelope = await callTool(harness, 'file_read', { workspace_id: harness.workspace.id, path: 'a.txt' }, harness.adapterContext('req_a2b'));
      assert.equal(errorOf(envelope).error.code, 'NOT_AUTHORIZED');
      assert.equal(errorOf(envelope).error.category, 'protocol');
      assert.equal(answerToolCall(harness.repos, 'req_a2b').calls[0]?.outcome, 'error');
    } finally {
      harness.close();
    }
  });

  it('没执行到能提取结果的程度：`file_rows` 记 not_extracted 而不是 0', async () => {
    const harness = await makeToolHarness({ paused: true, tree: { 'a.txt': fileOf('x') } });
    try {
      const envelope = await callTool(harness, 'file_read', { workspace_id: harness.workspace.id, path: 'a.txt' }, harness.adapterContext('req_a3'));
      assert.equal(errorOf(envelope).error.code, 'PAUSED');

      const answer = answerToolCall(harness.repos, 'req_a3');
      const metadata = answer.calls[0]?.metadata;
      assert.equal(metadata?.['file_rows'], 'not_extracted');
      assert.equal(metadata?.['reason'], 'GLOBAL_PAUSE');
      assert.deepEqual(answer.delivered, []);
      assert.deepEqual(answer.attempted, []);
    } finally {
      harness.close();
    }
  });

  it('工具清单本身也留痕（问过哪些能力与调过 file_read 是同一类事实）', async () => {
    const harness = await makeToolHarness();
    try {
      await callTool(harness, 'tools.catalog', {}, harness.adapterContext('req_cat'));
      const answer = answerToolCall(harness.repos, 'req_cat');
      assert.equal(answer.calls[0]?.tool, 'tools.catalog');
      assert.equal(answer.calls[0]?.workspace_id, null);
      assert.deepEqual(answer.delivered, []);
    } finally {
      harness.close();
    }
  });

  it('两条连接的记录互不混淆', async () => {
    const harness = await makeToolHarness({ tree: { 'a.txt': fileOf('x') } });
    try {
      await callTool(harness, 'workspace_list', {}, harness.adapterContext('req_b1'));
      await callTool(harness, 'workspace_list', {}, harness.contextFor(OTHER_CONNECTION, 'req_b2'));

      const mine = answerToolCall(harness.repos, 'req_b1');
      const theirs = answerToolCall(harness.repos, 'req_b2');
      assert.equal(mine.calls[0]?.connection_id, ADAPTER_CONNECTION);
      assert.equal(theirs.calls[0]?.connection_id, OTHER_CONNECTION);
      // 反查是按 request_id 的，照不到别人的记录。
      assert.ok(!mine.calls.some((call) => call.request_id === 'req_b2'));
    } finally {
      harness.close();
    }
  });

  it('request_id 进审计的就是回给模型的那个（同一关联 ID）', async () => {
    const harness = await makeToolHarness();
    try {
      const envelope = await callTool(harness, 'bridge_status', {}, harness.adapterContext('req_same'));
      assert.equal(dataOf(envelope, 'bridge_status') === undefined, false);
      assert.equal(answerToolCall(harness.repos, 'req_same').calls[0]?.request_id, 'req_same');
    } finally {
      harness.close();
    }
  });

  it('审计写不进去时**不返回内容**（fail-closed）', async () => {
    const harness = await makeToolHarness({ ...READ_ON, tree: { 'a.txt': fileOf('secret') } });
    // 只拆掉审计表，其余（连接、工作区、授权行）照常：这条用例要证明的
    // 是「读到了、但记不下来 ⇒ 不发」这**一个**判断，因此读取链必须完好。
    // 整库关掉做不到这一点 —— 那时连授权都读不出来，先说话的是别的东西。
    harness.opened.db.exec('DROP TABLE audit_file_access; DROP TABLE audit_events;');

    const envelope = await callTool(harness, 'file_read', {
      workspace_id: harness.workspace.id,
      path: 'a.txt',
    }, harness.adapterContext('req_gone'));
    assert.ok(!envelope.ok, '记录写不进去时结果不得返回');
    assert.equal(errorOf(envelope).error.code, 'STORAGE_UNAVAILABLE');
    assert.equal(errorOf(envelope).error.details?.['reason'], 'AUDIT_WRITE_FAILED');
    // 回给模型的文本里不得含底层存储错误的原文（可能含本机路径）。
    assert.ok(!/SQLITE|database|\.db|audit_events/i.test(errorOf(envelope).error.message));
  });

  it('状态库整个不可读时：先报「暂停状态读不出来」，回失败信封而不是把异常漏到 IPC 兜底路径', async () => {
    const harness = await makeToolHarness({ ...READ_ON, tree: { 'a.txt': fileOf('secret') } });
    // 把库关掉：守卫**自己**的第一步（LWB-034 之后是读暂停状态）就会失败。
    // 若这里没有兜住，异常会穿到 IPC 的兜底路径 —— 那条路径把本地排障
    // 文本原样送给模型，而「这一层的异常文本里恰好人没有路径」
    // 不是可以依赖的性质。
    harness.close();

    const envelope = await callTool(harness, 'file_read', {
      workspace_id: harness.workspace.id,
      path: 'a.txt',
    }, harness.adapterContext('req_down'));
    assert.ok(!envelope.ok, '读不出授权就不得放行');
    assert.equal(errorOf(envelope).error.code, 'STORAGE_UNAVAILABLE');
    // **不是** `PAUSED`：读不出暂停状态不等于服务停着，而按「停着」报出去
    // 会让操作者去看一个并没有停的服务（`pauseGate` 的注释）。
    assert.equal(errorOf(envelope).error.details?.['reason'], 'PAUSE_STATE_UNREADABLE');
    assert.ok(!/SQLITE|database|not open|\.db/i.test(errorOf(envelope).error.message));
  });

  it('暂停状态读得出来、而前像读不出来时：仍报 GUARD_FAILED', async () => {
    // 这一格必须能被单独构造，而 LWB-034 之后「把库关掉」不再能构造它 ——
    // 那时最先失败的是暂停那一格。装置因此允许注入一个**不碰库**的
    // 暂停服务（`ToolHarnessOptions.pause`）：它让用例能把失败点
    // 精确地放在读前像那一步上，而不是靠「先失败的那个」。
    const harness = await makeToolHarness({
      ...READ_ON,
      tree: { 'a.txt': fileOf('secret') },
      pause_source: { isPaused: () => false, status: () => emptyPauseStatus() },
    });

    const envelope = await callTool(harness, 'file_read', {
      workspace_id: harness.workspace.id,
      path: 'a.txt',
    }, harness.adapterContext('req_ok'));
    assert.ok(envelope.ok, '这一格先确认装置本身是通的');

    harness.close();

    const down = await callTool(harness, 'file_read', {
      workspace_id: harness.workspace.id,
      path: 'a.txt',
    }, harness.adapterContext('req_down2'));
    assert.ok(!down.ok, '读不出授权就不得放行');
    assert.equal(errorOf(down).error.code, 'STORAGE_UNAVAILABLE');
    assert.equal(errorOf(down).error.details?.['reason'], 'GUARD_FAILED');
  });
});

// ---------------------------------------------------------------------------
// 撤权
// ---------------------------------------------------------------------------

describe('LWB-018 · 撤权后旧结果与旧游标都不能返回', () => {
  /** 一个够长、能产生分页游标的文件。 */
  const longFile = fileOf(
    Array.from({ length: LIMITS.MAX_READ_LINES + 50 }, (_, i) => `line ${String(i + 1)}`).join('\n'),
  );

  /**
   * 先在**暂停之前**读一页，拿到一个真实的游标。
   *
   * 用真游标而不是手写的字符串：手写的游标只能证明「垃圾被拒绝」，
   * 而这条验收标准问的是「**以前签发的**游标在撤权后还能不能用」。
   */
  async function cursorBefore(
    harness: Awaited<ReturnType<typeof makeToolHarness>>,
    requestId: string,
  ): Promise<string> {
    const first = await callTool(
      harness,
      'file_read',
      { workspace_id: harness.workspace.id, path: 'big.txt' },
      harness.adapterContext(requestId),
    );
    const cursor = (dataOf(first) as { next_cursor: string | null }).next_cursor;
    assert.ok(cursor !== null && cursor.length > 0, '夹具必须产生分页游标');
    return cursor;
  }

  it('连接被暂停后，旧游标用不了（连接级撤权）', async () => {
    const harness = await makeToolHarness({ ...READ_ON, tree: { 'big.txt': longFile } });
    try {
      const cursor = await cursorBefore(harness, 'req_c1');
      harness.repos.connections.setEnabled(ADAPTER_CONNECTION, false);

      const envelope = await callTool(
        harness,
        'file_read',
        { workspace_id: harness.workspace.id, path: 'big.txt', cursor },
        harness.adapterContext('req_c2'),
      );
      assert.equal(errorOf(envelope).error.code, 'CONNECTION_DISABLED');
      // 拒绝发生在**解析连接**这一步，因此这条路径连游标都没看：
      // 记的是「目标路径」而不是「读了哪几行」。
      const answer = answerToolCall(harness.repos, 'req_c2');
      assert.deepEqual(answer.delivered, []);
      assert.deepEqual(answer.attempted, [{ path: 'big.txt', start_line: null, end_line: null }]);
    } finally {
      harness.close();
    }
  });

  it('工作区被暂停后，旧游标用不了（工作区级撤权）', async () => {
    const harness = await makeToolHarness({ ...READ_ON, tree: { 'big.txt': longFile } });
    try {
      const cursor = await cursorBefore(harness, 'req_c3');
      harness.repos.workspaces.setEnabled(harness.workspace.id, false);

      const envelope = await callTool(
        harness,
        'file_read',
        { workspace_id: harness.workspace.id, path: 'big.txt', cursor },
        harness.adapterContext('req_c4'),
      );
      assert.equal(errorOf(envelope).error.code, 'PAUSED');
    } finally {
      harness.close();
    }
  });

  it('工作区恢复后代次递增 ⇒ 旧游标仍然失效（票据绑代次）', async () => {
    const harness = await makeToolHarness({ ...READ_ON, tree: { 'big.txt': longFile } });
    try {
      const cursor = await cursorBefore(harness, 'req_c5');
      harness.repos.workspaces.setEnabled(harness.workspace.id, false);
      harness.repos.workspaces.setEnabled(harness.workspace.id, true);

      const envelope = await callTool(
        harness,
        'file_read',
        { workspace_id: harness.workspace.id, path: 'big.txt', cursor },
        harness.adapterContext('req_c6'),
      );
      assert.equal(errorOf(envelope).error.code, 'READ_TOKEN_STALE');
      assert.equal(errorOf(envelope).error.details?.['reason'], 'CURSOR_GENERATION_MISMATCH');
    } finally {
      harness.close();
    }
  });

  /**
   * 这一条**钉住当前的边界**，而不是钉住一个安全属性。
   *
   * 连接暂停期间旧游标不可用（上一条），但**暂停→恢复**之后它可以继续用：
   * 游标绑定的是「连接 id + **工作区**代次」，而 `connections.setEnabled`
   * 递增的是**连接**代次。按 LWB-013 的任务文本，票据绑定的就是「连接、
   * 工作区代次、路径、文件版本」—— 实现与规格一致。
   *
   * （`ConnectionsRepo.setEnabled` 与本包 `connections.ts` 里那两句
   * 「此前签发的票据与批准全部失效」曾经把话说大了，已在 LWB-018 改成实指。）
   *
   * 写在这里是因为：知道这条边界的人必须能一眼看到它。将来若把连接代次
   * 也绑进票据，这条用例会**红**，而那正是需要有人来改它、并且回答
   * 「为什么现在可以了」的时刻。工程上的记录见 `docs/PROGRESS.md` 偏离项 61。
   */
  it('已知边界：连接暂停→恢复后，暂停前签发的游标仍可用（未绑连接代次）', async () => {
    const harness = await makeToolHarness({ ...READ_ON, tree: { 'big.txt': longFile } });
    try {
      const cursor = await cursorBefore(harness, 'req_c7');
      harness.repos.connections.setEnabled(ADAPTER_CONNECTION, false);
      harness.repos.connections.setEnabled(ADAPTER_CONNECTION, true);

      const envelope = await callTool(
        harness,
        'file_read',
        { workspace_id: harness.workspace.id, path: 'big.txt', cursor },
        harness.adapterContext('req_c8'),
      );
      assert.ok(envelope.ok, '当前实现接受它 —— 本条用例记录的就是这件事');
    } finally {
      harness.close();
    }
  });

  it('返回前撤权：已经读到的内容被撤回，审计记 delivered=false 但字节照记', async () => {
    const { ops } = makeOps(treeOf({ 'a.txt': fileOf('top secret') }));
    let pending: (() => void) | null = null;
    // 在**处理器内部**、读完文件之后撤权：这正是「临返回再次检查」
    // 要拦的那个窗口 —— 授权在调用开始时成立，在返回时不成立了。
    const hooked: WinfsOps = {
      ...ops,
      readFileGuarded: async (req: WinfsPathRef): Promise<WinfsReadResult | WinfsError> => {
        const result = await ops.readFileGuarded(req);
        pending?.();
        return result;
      },
    };

    const harness = await makeToolHarness({
      ...READ_ON,
      ops: hooked,
      tree: { 'a.txt': fileOf('top secret') },
    });
    try {
      pending = () => harness.repos.connections.setEnabled(ADAPTER_CONNECTION, false);
      const envelope = await callTool(
        harness,
        'file_read',
        { workspace_id: harness.workspace.id, path: 'a.txt' },
        harness.adapterContext('req_r1'),
      );

      assert.ok(!envelope.ok, '撤权后的结果不得返回');
      assert.equal(errorOf(envelope).error.code, 'CONNECTION_DISABLED');
      // 模型拿不到内容 —— 这一句断言比错误码更要紧。
      assert.ok(!JSON.stringify(envelope).includes('top secret'));

      const answer = answerToolCall(harness.repos, 'req_r1');
      const call = answer.calls[0];
      assert.equal(call?.outcome, 'deny');
      assert.equal(call?.metadata?.['reason'], 'REVOKED_BEFORE_RETURN');
      // 内容没有出去，但**读了**：记成「没读」是另一种谎。
      assert.deepEqual(answer.delivered, []);
      assert.deepEqual(answer.attempted, [{ path: 'a.txt', start_line: 1, end_line: 1 }]);
      // 出站字节照记，且刻意不回退：回退会让「反复触发撤回」变成
      // 一种重置出站窗口的手段。
      assert.ok((call?.bytes_out ?? 0) > 0);
    } finally {
      harness.close();
    }
  });

  it('全局暂停挡住工作区类工具，但放行诊断入口', async () => {
    const harness = await makeToolHarness({ paused: true });
    try {
      // `bridge_status` 必须能回答「为什么我什么都做不了」——
      // 一个被暂停的服务如果连这条都拒绝，操作者就只能靠日志了。
      const status = await callTool(harness, 'bridge_status', {}, harness.adapterContext('req_p1'));
      assert.ok(status.ok);
      assert.equal((dataOf(status) as { paused: boolean }).paused, true);

      const list = await callTool(harness, 'file_list', { workspace_id: harness.workspace.id }, harness.adapterContext('req_p2'));
      assert.equal(errorOf(list).error.code, 'PAUSED');
    } finally {
      harness.close();
    }
  });

  it('并发额度耗尽：本次未执行，且不说成「读过了」', async () => {
    // 用真实的闸门把额度占满，而不是 mock 一个拒绝：这里要验的是
    // 「满了之后工具面怎么回答」，而不是「一个假函数返回了什么」。
    const gate = new ConcurrencyGate({ max_concurrent: 1, max_per_connection: 1, wait_ms: 0 });
    const harness = await makeToolHarness({ ...READ_ON, concurrency: gate });
    try {
      const held = await gate.acquire(ADAPTER_CONNECTION);
      assert.ok(held.ok);

      const envelope = await callTool(harness, 'file_list', { workspace_id: harness.workspace.id }, harness.adapterContext('req_q1'));
      assert.equal(errorOf(envelope).error.code, 'CONCURRENCY_LIMIT_EXCEEDED');

      const call = answerToolCall(harness.repos, 'req_q1').calls[0];
      assert.equal(call?.outcome, 'deny');
      assert.equal(call?.metadata?.['reason'], 'CONNECTION_LIMIT_EXCEEDED');
      assert.equal(call?.bytes_out, 0);
      assert.deepEqual(answerToolCall(harness.repos, 'req_q1').attempted, []);

      held.lease.release();
      // 位置回来之后同一个调用应该能过 —— 证明刚才拒绝的是额度而不是别的。
      const after = await callTool(harness, 'file_list', { workspace_id: harness.workspace.id }, harness.adapterContext('req_q2'));
      assert.ok(after.ok);
    } finally {
      harness.close();
    }
  });

  it('非工作区工具不占用并发位置（诊断入口不该被额度挡住）', async () => {
    const gate = new ConcurrencyGate({ max_concurrent: 1, max_per_connection: 1, wait_ms: 0 });
    const harness = await makeToolHarness({ concurrency: gate });
    try {
      const held = await gate.acquire(ADAPTER_CONNECTION);
      assert.ok(held.ok);
      const status = await callTool(harness, 'bridge_status', {}, harness.adapterContext('req_q3'));
      assert.ok(status.ok);
      const catalog = await callTool(harness, 'tools.catalog', {}, harness.adapterContext('req_q4'));
      assert.ok(catalog.ok);
      held.lease.release();
    } finally {
      harness.close();
    }
  });

  it('额度用满也不会留下未释放的位置（异常路径同样释放）', async () => {
    const gate = new ConcurrencyGate({ max_concurrent: 2, max_per_connection: 2, wait_ms: 0 });
    const harness = await makeToolHarness({ ...READ_ON, concurrency: gate });
    try {
      for (let i = 0; i < 5; i += 1) {
        await callTool(harness, 'file_list', { workspace_id: harness.workspace.id }, harness.adapterContext(`req_l${String(i)}`));
      }
      assert.equal(gate.snapshot().in_flight, 0, '每次都必须在 finally 里释放');
      assert.deepEqual(gate.snapshot().connections, {});
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 记录与检索的一致性
// ---------------------------------------------------------------------------

describe('LWB-018 · 审计写入与反查', () => {
  it('事件与文件行同事务：写失败不会留下半条记录', async () => {
    const harness = await makeToolHarness();
    try {
      // 故意让筛查失败（白名单之外的键）——写入必须整体回滚，
      // 而不是留下一条没有文件行的事件。
      assert.throws(
        () =>
          recordToolCall(harness.repos, {
            tool: 'file_read',
            request_id: 'req_half',
            connection_id: ADAPTER_CONNECTION,
            outcome: 'allow',
            bytes_out: 0,
            file_access: [{ path: 'a.txt', start_line: 1, end_line: 1, delivered: true }],
            metadata: { not_allowed_key: 1 },
          }),
        /不在允许清单内/,
      );
      assert.deepEqual(harness.repos.audit.findByRequestId('req_half'), []);
    } finally {
      harness.close();
    }
  });

  it('反查返回**全部**同 ID 事件，并如实报告重复', async () => {
    const harness = await makeToolHarness();
    try {
      for (const tool of ['bridge_status', 'workspace_list'] as const) {
        recordToolCall(harness.repos, {
          tool,
          request_id: 'req_dup',
          connection_id: ADAPTER_CONNECTION,
          outcome: 'allow',
          bytes_out: 0,
          file_access: [],
        });
      }
      const answer = answerToolCall(harness.repos, 'req_dup');
      // 唯一索引会**静默丢掉**其中一条，而丢掉的可能是需要被看到的那条。
      assert.equal(answer.calls.length, 2);
      assert.equal(answer.duplicate_events, true);
    } finally {
      harness.close();
    }
  });

  it('按路径反查能给出「哪些调用碰过这个文件」', async () => {
    const harness = await makeToolHarness({ ...READ_ON, tree: { 'a.txt': fileOf('x') } });
    try {
      await callTool(harness, 'file_read', { workspace_id: harness.workspace.id, path: 'a.txt' }, harness.adapterContext('req_t1'));
      await callTool(harness, 'file_read', { workspace_id: harness.workspace.id, path: 'a.txt' }, harness.adapterContext('req_t2'));

      const ids = ['req_t1', 'req_t2']
        .map((requestId) => answerToolCall(harness.repos, requestId).calls[0]?.id)
        .filter((id): id is number => id !== undefined);
      assert.equal(ids.length, 2, '两次调用都该有事件');
      const events = harness.repos.audit.eventsTouchingPath('a.txt', { limit: 10 });
      for (const id of ids) assert.ok(events.includes(id), `事件 ${id} 没被按路径反查到`);
      // 大小写不敏感的路径键：NTFS 上两个拼写是同一个文件。
      assert.deepEqual(harness.repos.audit.eventsTouchingPath('A.TXT', { limit: 10 }), events);
    } finally {
      harness.close();
    }
  });
});
