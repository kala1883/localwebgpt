/**
 * `text_search` 的端到端行为（LWB-015）。
 *
 * 三条验收标准各自在这里有落点：
 *
 *  1. **搜索能找到已保存未提交的变更，不需要云端索引。**
 *     判据不是「搜到了」，而是「改了字节之后立刻看到改后的」——见
 *     「磁盘上的字节」那一组：同一个树对象、同一套依赖，改内容再搜，
 *     结果跟着变。任何索引或缓存都会让这条失败。
 *  2. **秘密标记不会出现在命中片段中。** `scan.test.ts` 证明单文件那一层；
 *     这里证明它**经整次调用之后**仍然成立：整份结果的序列化里不含凭证。
 *  3. **超时返回部分结果而非错误宣称没有匹配或已经检索全仓。**
 *     超时/字节预算/取消各有用例，判据一律是三条同时成立：
 *     有结果、`complete === false`、`incomplete_reason` 说清楚了为什么。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BridgeError } from '@lwb/contracts';
import type { SearchMatch, TextSearchData } from '@lwb/contracts';
import { searchBounds, textSearch } from '@lwb/search';

import type { NodeSpec, OpsCalls, SearchDepsOptions, SearchOptions } from './harness.ts';
import { depsFor, fileOf, makeOps, NOW, searchArgs, treeOf } from './harness.ts';

const GITHUB_TOKEN = 'ghp_012345678901234567890123456789012345';

interface Run {
  readonly data: TextSearchData;
  readonly calls: OpsCalls;
}

async function run(
  tree: Map<string, NodeSpec>,
  options: SearchOptions,
  depsOptions: SearchDepsOptions = {},
): Promise<Run> {
  const { ops, calls } = makeOps(tree);
  const data = await textSearch(searchArgs(options), depsFor(ops, depsOptions));
  return { data, calls };
}

/** 命中的稳定标识：路径 + 行号。用来比较两页之间有没有重复或缺口。 */
function at(matches: readonly SearchMatch[]): string[] {
  return matches.map((m) => `${m.path}:${m.line_number}`);
}

describe('LWB-015 检索的是磁盘上的字节', () => {
  it('读得到文件内容，覆盖信息如实', async () => {
    const { data, calls } = await run(
      treeOf({
        'src/app.ts': fileOf('export function greet() {\n  return "hello needle";\n}\n'),
        'README.md': fileOf('# 项目说明\n这里没有那个词\n'),
      }),
      { query: 'needle' },
    );

    assert.equal(data.matches.length, 1);
    assert.equal(data.matches[0]?.path, 'src/app.ts');
    assert.equal(data.matches[0]?.line_number, 2);
    assert.equal(data.matches[0]?.snippet, '  return "hello needle";');

    // 字节数按装置里的内容算，不写死一个字面量：写死的那个数字会随
    // 夹具改动而失效，而它失效的方式是「测试还绿着但断言已经不对了」。
    const expectedBytes =
      Buffer.byteLength('export function greet() {\n  return "hello needle";\n}\n', 'utf8') +
      Buffer.byteLength('# 项目说明\n这里没有那个词\n', 'utf8');
    assert.deepEqual(data.scope, {
      scanned_files: 2,
      skipped_files: 0,
      denied_files: 0,
      secret_files: 0,
      scanned_bytes: expectedBytes,
      complete: true,
    });
    assert.equal(data.next_cursor, null);
    assert.equal(data.truncated, false);
    assert.equal(data.incomplete_reason, null);
    // 内容来自受控读取，不是来自任何索引。
    assert.deepEqual(calls.read_paths.sort(), ['README.md', 'src/app.ts']);
  });

  it('内容改了，下一次搜索立刻看到改后的（没有索引，也没有缓存）', async () => {
    const tree = treeOf({ 'src/app.ts': fileOf('const a = 1;\n') });
    const { ops } = makeOps(tree);
    const deps = depsFor(ops);

    const before = await textSearch(searchArgs({ query: 'needle' }), deps);
    assert.equal(before.matches.length, 0);

    // 同一个树、同一套依赖：只是「用户保存了文件」。
    tree.set('src/app.ts', fileOf('const a = 1; // just saved: needle\n'));

    const after = await textSearch(searchArgs({ query: 'needle' }), deps);
    assert.equal(after.matches.length, 1);
    assert.equal(after.matches[0]?.line_number, 1);
  });
});

describe('LWB-015 分页：不缺、不重、走完就说得清', () => {
  const tree = treeOf({
    'a.txt': fileOf('needle a1\nneedle a2\nneedle a3\n'),
    'b.txt': fileOf('needle b1\nneedle b2\n'),
    'c.txt': fileOf('needle c1\n'),
  });

  it('一页装满就说「后面还有」，并给出能接着读的游标', async () => {
    const { data } = await run(tree, { query: 'needle', max_matches: 3 });

    assert.deepEqual(at(data.matches), ['a.txt:1', 'a.txt:2', 'a.txt:3']);
    assert.equal(data.truncated, true);
    assert.notEqual(data.next_cursor, null);
    assert.equal(data.scope.complete, false);
    assert.match(data.incomplete_reason ?? '', /上限 3 条/);
  });

  it('用游标接着读：两页合起来正好是全部命中，没有重复也没有缺口', async () => {
    const first = await run(tree, { query: 'needle', max_matches: 3 });
    const second = await run(tree, { query: 'needle', max_matches: 3, cursor: first.data.next_cursor ?? '' });

    assert.deepEqual(at(second.data.matches), ['b.txt:1', 'b.txt:2', 'c.txt:1']);
    // 页满那一页之后再无命中 ⇒ 不发游标，并且**可以**说 complete。
    assert.equal(second.data.next_cursor, null);
    assert.equal(second.data.truncated, false);
    assert.equal(second.data.scope.complete, true);
    assert.equal(second.data.incomplete_reason, null);

    const all = [...at(first.data.matches), ...at(second.data.matches)];
    assert.deepEqual([...all].sort(), ['a.txt:1', 'a.txt:2', 'a.txt:3', 'b.txt:1', 'b.txt:2', 'c.txt:1']);
    assert.equal(new Set(all).size, all.length, '两页之间不该有重复');
  });

  it('页满时若本文件里还有命中，续读落在**这个文件内部**而不是下一个文件', async () => {
    const { data } = await run(tree, { query: 'needle', max_matches: 1 });
    assert.deepEqual(at(data.matches), ['a.txt:1']);

    const next = await run(tree, { query: 'needle', max_matches: 1, cursor: data.next_cursor ?? '' });
    assert.deepEqual(at(next.data.matches), ['a.txt:2']);
  });

  it('恰好只剩这些 ⇒ 不发游标（「装满一页」与「刚好读完」必须分得开）', async () => {
    const exact = await run(treeOf({ 'a.txt': fileOf('needle\n'), 'b.txt': fileOf('needle\n') }), {
      query: 'needle',
      max_matches: 2,
    });
    assert.equal(exact.data.matches.length, 2);
    assert.equal(exact.data.next_cursor, null);
    assert.equal(exact.data.scope.complete, true);

    // 对照：同样装满一页，但后面**还有**一条 ⇒ 必须发游标。
    const more = await run(
      treeOf({ 'a.txt': fileOf('needle\n'), 'b.txt': fileOf('needle\n'), 'c.txt': fileOf('needle\n') }),
      { query: 'needle', max_matches: 2 },
    );
    assert.equal(more.data.matches.length, 2);
    assert.notEqual(more.data.next_cursor, null);
    assert.equal(more.data.scope.complete, false);
  });

  it('游标属于另一次查询 ⇒ 拒绝，而不是拿它继续读', async () => {
    const first = await run(tree, { query: 'needle', max_matches: 3 });
    const cursor = first.data.next_cursor ?? '';

    await assert.rejects(
      () => run(tree, { query: 'other', max_matches: 3, cursor }),
      (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.equal((error as BridgeError).code, 'READ_TOKEN_STALE');
        assert.equal((error as BridgeError).details?.reason, 'CURSOR_QUERY_MISMATCH');
        return true;
      },
    );

    // glob 也是同一次搜索的一部分：换了它同样是另一次查询。
    await assert.rejects(
      () => run(tree, { query: 'needle', max_matches: 3, cursor, path_glob: '*.txt' }),
      (error: unknown) => {
        assert.equal((error as BridgeError).details?.reason, 'CURSOR_QUERY_MISMATCH');
        return true;
      },
    );
  });

  /**
   * 续读锚点必须落在 `a.txt` **内部**（游标记的是「从 a.txt 的第 3 个命中起」）。
   *
   * 因此 a.txt 的命中数要**超过**页上限：页满之后遍历还要继续找一条证据，
   * 而它就在同一个文件里。若 a.txt 恰好只有 3 条，锚点会落到 `b.txt` 上，
   * 下面两个用例就变成了在测 b.txt —— 看起来一样，实际什么都没证。
   */
  const resumable = (): Map<string, NodeSpec> =>
    treeOf({
      'a.txt': fileOf('needle a1\nneedle a2\nneedle a3\nneedle a4\nneedle a5\n'),
      'b.txt': fileOf('needle b1\n'),
    });

  it('装置前提：续读确实从 a.txt 的**第 3 个命中之后**开始', async () => {
    const { data } = await run(resumable(), { query: 'needle', max_matches: 3 });
    assert.deepEqual(at(data.matches), ['a.txt:1', 'a.txt:2', 'a.txt:3']);

    // 没动任何东西时，第二页就是「a.txt 里剩下的两条 + b.txt 那一条」。
    // 这一条断言同时钉住了两件事：锚点落在 a.txt **内部**（不是文件之间），
    // 以及下面两个用例动到的正是这个锚点。
    const next = await run(resumable(), { query: 'needle', max_matches: 3, cursor: data.next_cursor ?? '' });
    assert.deepEqual(at(next.data.matches), ['a.txt:4', 'a.txt:5', 'b.txt:1']);
  });

  it('续读位置已经不存在 ⇒ 那个目录里的其余候选照常扫描', async () => {
    const mutable = resumable();
    const { data } = await run(mutable, { query: 'needle', max_matches: 3 });
    const cursor = data.next_cursor ?? '';

    // 用户在这期间删掉了 a.txt：它剩下的两个命中跟着一起没有了。
    mutable.delete('a.txt');

    const next = await run(mutable, { query: 'needle', max_matches: 3, cursor });
    // 关键在 `b.txt` 还在：游标锚点消失**不能**让排在它之后的条目被整段跳过。
    assert.deepEqual(at(next.data.matches), ['b.txt:1']);
  });

  it('续读位置在探针与列举之间消失 ⇒ 同样不跳过排在它之后的候选', async () => {
    const mutable = resumable();
    const { data } = await run(mutable, { query: 'needle', max_matches: 3 });
    const cursor = data.next_cursor ?? '';

    // 比「被删掉」更刁钻的一种：`resolvePath` 还找得到它（探针说「在」），
    // 而目录列举里已经没有它了。列举是从头开始跳过它之前的条目的，
    // 若因此认定「列完了也没见到锚点 ⇒ 这一层就这样了」，b.txt 就永远看不到
    // —— 而结果看起来是完整的。
    const anchor = mutable.get('a.txt');
    assert.ok(anchor !== undefined);
    (anchor as { hidden_from_listing?: boolean }).hidden_from_listing = true;

    const next = await run(mutable, { query: 'needle', max_matches: 3, cursor });
    assert.deepEqual(at(next.data.matches), ['b.txt:1']);
  });
});

describe('LWB-015 提前停下时说清楚看到了多少', () => {
  const three = (): Map<string, NodeSpec> =>
    treeOf({
      'a.txt': fileOf('needle a\n'),
      'b.txt': fileOf('needle b\n'),
      'c.txt': fileOf('needle c\n'),
    });

  it('超时：返回已经找到的，并说明只覆盖了已扫描的部分', async () => {
    // `clock` 与 `args.now` 是**两个不同的东西**（见 `SearchDeps` 的注释）：
    // 时间预算是「过了多久」，因此读数与 `now` 同一个刻度，只是第二次调用时
    // 已经走过了预算。
    let calls = 0;
    const { data } = await run(three(), { query: 'needle' }, {
      // 检查点：起始、目录批次返回、首条目、文件扫描前、文件扫描后；
      // 第 6 次（第二条目之前）越过预算，证明已找到的首条仍会返回。
      clock: () => (calls++ < 5 ? NOW : NOW + 5000),
      limits: { search_time_budget_ms: 1000 },
    });

    // 「返回部分结果」的核心：**不是零条**，也不是错误。
    assert.deepEqual(at(data.matches), ['a.txt:1']);
    assert.equal(data.deadline_exceeded, true);
    assert.equal(data.scope.complete, false);
    assert.match(data.incomplete_reason ?? '', /时间预算 1000 ms/);
    assert.deepEqual(searchBounds(data), ['PAGE_FULL', 'DEADLINE']);
    // 还能接着读：最后一条已返回的命中就是锚点。
    assert.notEqual(data.next_cursor, null);
  });

  it('目录枚举本身耗尽时间预算时也返回不完整结果，而不是拖到 IPC 超时', async () => {
    let calls = 0;
    const { data, calls: opsCalls } = await run(three(), { query: 'needle' }, {
      clock: () => (calls++ < 2 ? NOW : NOW + 5000),
      limits: { search_time_budget_ms: 1000 },
    });

    assert.deepEqual(data.matches, []);
    assert.equal(data.deadline_exceeded, true);
    assert.equal(data.scope.complete, false);
    assert.match(data.incomplete_reason ?? '', /时间预算 1000 ms/);
    assert.equal(opsCalls.read_paths.length, 0, '预算在首个目录批次后用尽，不应再打开候选文件');
  });

  it('字节预算：同样返回部分结果，同样不谎称完整', async () => {
    const { data } = await run(three(), { query: 'needle' }, { limits: { max_search_scanned_bytes: 10 } });

    assert.deepEqual(at(data.matches), ['a.txt:1', 'b.txt:1']);
    assert.equal(data.byte_budget_exceeded, true);
    assert.equal(data.scope.complete, false);
    assert.match(data.incomplete_reason ?? '', /字节上限 10 字节/);
    assert.ok(searchBounds(data).includes('BYTE_BUDGET'));
  });

  it('一开始就被取消：零条命中，但这**不是**「没有匹配」', async () => {
    const { data } = await run(three(), { query: 'needle' }, { is_cancelled: () => true });

    assert.equal(data.matches.length, 0);
    assert.equal(data.cancelled, true);
    // 这三项同时成立，才让「没找到」不会被读成「不存在」。
    assert.equal(data.scope.complete, false);
    assert.match(data.incomplete_reason ?? '', /已被取消/);
    assert.deepEqual(searchBounds(data), ['CANCELLED']);
  });

  it('中途被取消：返回已经找到的那部分', async () => {
    let checks = 0;
    const { data } = await run(three(), { query: 'needle' }, {
      // 时间/取消检查点：列表前、列表后、首条目、文件扫描前、扫描后；
      // 第 6 次检查在第二条目之前取消，保留第一条命中。
      is_cancelled: () => checks++ >= 5,
    });

    assert.deepEqual(at(data.matches), ['a.txt:1']);
    assert.equal(data.cancelled, true);
    assert.equal(data.scope.complete, false);
  });
});

describe('LWB-015 查询的收窄方式', () => {
  it('`path` 把范围限定在一棵子树里', async () => {
    const tree = treeOf({
      'src/a.ts': fileOf('needle\n'),
      'docs/b.md': fileOf('needle\n'),
    });

    const { data } = await run(tree, { query: 'needle', path: 'src' });
    assert.deepEqual(at(data.matches), ['src/a.ts:1']);
  });

  it('glob 只筛文件，**不剪目录**：`*.ts` 不该让 `src/` 整个被跳过', async () => {
    const tree = treeOf({
      'a.ts': fileOf('needle\n'),
      'b.md': fileOf('needle\n'),
      'src/c.ts': fileOf('needle\n'),
    });

    const { data, calls } = await run(tree, { query: 'needle', path_glob: '*.ts' });
    assert.deepEqual(at(data.matches), ['a.ts:1']);
    // `*` 不跨 `/`，因此 `src/c.ts` 不匹配 —— 但 `src` 这一层是被**走过**的，
    // 只是走到里面发现文件不匹配。剪枝与过滤的区别就在这里。
    assert.ok(calls.listed.some((l) => l.path === 'src'));
    // 不匹配 glob 是**调用方自己划的范围**，不是覆盖缺口。
    assert.equal(data.scope.skipped_files, 2);
    assert.equal(data.scope.complete, true);
    assert.equal(data.incomplete_reason, null);

    const recursive = await run(tree, { query: 'needle', path_glob: '**/*.ts' });
    assert.deepEqual(at(recursive.data.matches), ['a.ts:1', 'src/c.ts:1']);
  });

  it('大小写：默认不敏感，显式打开后是收窄', async () => {
    const tree = treeOf({ 'a.txt': fileOf('Needle\nneedle\n') });

    assert.equal((await run(tree, { query: 'needle' })).data.matches.length, 2);
    assert.equal((await run(tree, { query: 'needle', case_sensitive: true })).data.matches.length, 1);
  });

  it('单文件工作区：整个工作区就是那一个文件', async () => {
    const tree = new Map<string, NodeSpec>([['', fileOf('needle here\n')]]);
    const { data } = await run(tree, { query: 'needle', scope: { kind: 'file' } });

    assert.deepEqual(at(data.matches), [':1']);
    assert.equal(data.scope.complete, true);
  });

  it('单文件工作区不接受子路径', async () => {
    const tree = new Map<string, NodeSpec>([['', fileOf('needle here\n')]]);
    await assert.rejects(
      () => run(tree, { query: 'needle', path: 'sub', scope: { kind: 'file' } }),
      (error: unknown) => {
        assert.equal((error as BridgeError).details?.reason, 'SUBPATH_IN_FILE_WORKSPACE');
        return true;
      },
    );
  });
});

describe('LWB-015 不该出现的东西一个字符都不出现', () => {
  it('硬拒绝与搜索排除的路径不出现在结果的任何地方', async () => {
    const { data } = await run(
      treeOf({
        'a.txt': fileOf('zzneedlezz\n'),
        '.env': fileOf('zzneedlezz\n'),
        // 方案明写：`.env.example` **不**自动豁免。
        '.env.example': fileOf('zzneedlezz\n'),
        '.ssh/config': fileOf('zzneedlezz\n'),
        'node_modules/pkg/index.js': fileOf('zzneedlezz\n'),
      }),
      { query: 'zzneedlezz' },
    );

    assert.deepEqual(at(data.matches), ['a.txt:1']);
    const serialized = JSON.stringify(data);
    for (const forbidden of ['.env', '.ssh', 'node_modules']) {
      assert.equal(serialized.includes(forbidden), false, `结果里不该出现 ${forbidden}`);
    }
    // 反证：断言不是凭空成立的（上面那几个字符串确实来自这个装置）。
    assert.equal(serialized.includes('a.txt'), true);
    // 文件级计数只数**文件**：`.env` 与 `.env.example` 命中硬拒绝，
    // `.ssh` 是目录（不进入，因此不计入文件数）。
    assert.equal(data.scope.denied_files, 2);
    assert.equal(data.matches.length, 1);
  });

  it('含高置信度凭证的文件：命中缺席，但覆盖范围如实承认', async () => {
    const { data } = await run(
      treeOf({
        'a.txt': fileOf('needle ok\n'),
        'b.txt': fileOf(`needle ${GITHUB_TOKEN}\n`),
      }),
      { query: 'needle' },
    );

    assert.deepEqual(at(data.matches), ['a.txt:1']);
    // 被读进来了（因此计入 scanned_files），但内容不返回。
    assert.equal(data.scope.scanned_files, 2);
    assert.equal(data.scope.secret_files, 1);
    assert.equal(data.scope.complete, false);
    assert.ok(searchBounds(data).includes('SECRET_WITHHELD'));

    const serialized = JSON.stringify(data);
    assert.equal(serialized.includes('ghp_'), false);
    assert.equal(serialized.includes('b.txt'), false);
  });
});
