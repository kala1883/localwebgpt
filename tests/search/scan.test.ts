/**
 * 单个文件的扫描（LWB-015 步骤 2）。
 *
 * 这个文件守着一条验收标准：
 *
 * > **秘密标记不会出现在命中片段中。**
 *
 * 判据不能只是「返回值里没有秘密」—— 那只能证明这一次没漏。要证明的是
 * **没有别的出口**：片段只能经 `emitContent()` 离开，而扫描层在它之前
 * 已经整个文件判过一次。因此这里除了断言返回值，还断言：
 *
 *  - 那些本该被抽走的命中**一条都没出站**（`budget.chargedTotal` 为 0）；
 *  - 整个返回值序列化之后不含秘密的任何一个字符。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BridgeError, LIMITS } from '@lwb/contracts';
import { EgressBudget, mintClearance } from '@lwb/egress';
import type { Clearance } from '@lwb/egress';
import { scanFile, compileQuery, DEFAULT_SEARCH_LIMITS } from '@lwb/search';
import type { ScanContext, SearchQuery } from '@lwb/search';
import type { WinfsOps } from '@lwb/winfs';

import { allowedDecision, CONNECTION, fileOf, makeOps, scopeOf, treeOf, NOW } from './harness.ts';

/** 一条确定会被判为 certain 的凭证：GitHub 令牌的形状。 */
const GITHUB_TOKEN = 'ghp_012345678901234567890123456789012345';
/** 一条确定只判为 likely 的赋值：关键字 + 值。 */
const LIKELY_ASSIGNMENT = 'password = "hunter2hunter2"';

function contextFor(ops: WinfsOps, query: string, overrides: Partial<ScanContext> = {}): ScanContext {
  const clearance: Clearance = mintClearance(allowedDecision('search'), {
    connection_id: CONNECTION,
    generation: 1,
  });
  return {
    ops,
    scope: scopeOf(),
    query: compileQuery(query, undefined) as SearchQuery,
    clearance,
    budget: new EgressBudget({ limit_bytes_per_hour: 1024 * 1024, now: () => NOW }),
    remaining_matches: LIMITS.MAX_SEARCH_MATCHES,
    skip_matches: 0,
    max_readable_file_bytes: DEFAULT_SEARCH_LIMITS.max_readable_file_bytes,
    max_snippet_bytes: LIMITS.MAX_SNIPPET_BYTES,
    max_line_bytes: LIMITS.MAX_LINE_BYTES,
    ...overrides,
  };
}

/** 装置前提：搜索片段的出站义务必须是「阻断」。 */
describe('LWB-015 装置前提', () => {
  it('search_snippet 面的秘密处置是 block（否则「不返回」这件事无从谈起）', () => {
    const decision = allowedDecision('search');
    assert.equal(decision.context.surface, 'search_snippet');
    assert.equal(decision.obligations.secret_mode, 'block');
  });
});

describe('LWB-015 秘密标记不出现在命中片段中', () => {
  it('命中行里出现高置信度凭证 ⇒ 整文件丢弃，一片都不出站', async () => {
    const { ops } = makeOps(
      treeOf({
        'config.ts': fileOf(`const a = "needle";\nconst token = "${GITHUB_TOKEN}"; // needle\n`),
      }),
    );
    const ctx = contextFor(ops, 'needle');

    const outcome = await scanFile('config.ts', ctx);

    assert.equal(outcome.kind, 'secret');
    // 一个字节都没出站 —— 这是「整份丢弃」与「丢一半」的分界。
    assert.equal(ctx.budget.chargedTotal, 0);
    // 返回值里不含秘密的任何一段，也不含文件名（文件名本身可能就是提示）。
    const serialized = JSON.stringify(outcome);
    assert.equal(serialized.includes('ghp_'), false);
    assert.equal(serialized.includes('config.ts'), false);
  });

  it('凭证落在**没有命中**的那一行，整个文件照样丢弃（判的是文件，不是片段）', async () => {
    const { ops } = makeOps(
      treeOf({
        'a.ts': fileOf(`needle one\nneedle two\n${GITHUB_TOKEN}\nneedle three\n`),
      }),
    );
    const ctx = contextFor(ops, 'needle');
    const outcome = await scanFile('a.ts', ctx);

    // 这三行的片段里一个凭证字符都没有 —— 逐片筛查会全部放行。
    // 判据是「这个文件含 certain 档凭证」，见 scan.ts 文件头。
    assert.equal(outcome.kind, 'secret');
    assert.equal(ctx.budget.chargedTotal, 0);
  });

  it('命中落在私钥**正文中间** ⇒ 仍然丢弃（这是「判整个文件」的存在理由）', async () => {
    // 逐片筛查在这里认不出来：规则的形状是 `-----BEGIN … PRIVATE KEY-----`
    // 一直到 END，而片段窗口（命中前 64 码元起）里只有一段孤立的 base64。
    // 因此这一条是整份文本判定的**唯一**证据 —— 去掉它，第一层就白设了。
    const body = `${'MIIEowIBAAKCAQEA'.padEnd(64, 'x')}needle${'y'.repeat(200)}`;
    const pem = [
      'const a = 1;',
      '-----BEGIN RSA PRIVATE KEY-----',
      body,
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    // 文件名刻意平凡：像 `id_rsa` / `*.pem` 那样**按名字**就能拦下的路径，
    // 会被硬拒绝规则在打开之前拦住，那样测到的就不是内容判定了。
    const { ops } = makeOps(treeOf({ 'notes/scratch.txt': fileOf(pem) }));
    const ctx = contextFor(ops, 'needle');

    const outcome = await scanFile('notes/scratch.txt', ctx);

    assert.equal(outcome.kind, 'secret');
    assert.equal(ctx.budget.chargedTotal, 0);
    assert.equal(JSON.stringify(outcome).includes('MIIEowIBAAKCAQEA'), false);
  });

  it('另一个文件里的干净命中照常返回（丢弃只针对这一个文件）', async () => {
    const tree = treeOf({
      'dirty.ts': fileOf(GITHUB_TOKEN),
      'clean.ts': fileOf('the needle is here\n'),
    });
    const { ops } = makeOps(tree);

    const dirty = await scanFile('dirty.ts', contextFor(ops, 'needle'));
    const clean = await scanFile('clean.ts', contextFor(ops, 'needle'));

    assert.equal(dirty.kind, 'secret');
    assert.equal(clean.kind, 'found');
  });

  it('likely 档的秘密走**脱敏**而不是阻断，并如实标注 redacted', async () => {
    const { ops } = makeOps(treeOf({ 'app.py': fileOf(`needle\n${LIKELY_ASSIGNMENT}\n`) }));
    const ctx = contextFor(ops, 'needle');
    const outcome = await scanFile('app.py', ctx);

    assert.equal(outcome.kind, 'found');
    if (outcome.kind !== 'found') return;
    // 命中的是第 1 行（干净），第 2 行不产生命中，因此这里返回的片段是干净的。
    assert.equal(outcome.matches.length, 1);
    assert.equal(outcome.matches[0]?.snippet.includes('needle'), true);
  });

  it('命中行本身含 likely 秘密 ⇒ 片段被脱敏，redacted 为 true', async () => {
    const { ops } = makeOps(treeOf({ 'app.py': fileOf(`needle ${LIKELY_ASSIGNMENT}\n`) }));
    const ctx = contextFor(ops, 'needle');
    const outcome = await scanFile('app.py', ctx);

    assert.equal(outcome.kind, 'found');
    if (outcome.kind !== 'found') return;
    const match = outcome.matches[0];
    assert.ok(match !== undefined);
    assert.equal(match.redacted, true);
    assert.equal(match.snippet.includes('hunter2hunter2'), false);
    assert.equal(match.snippet.includes('needle'), true); // 上下文仍在
  });
});

describe('LWB-015 命中与片段', () => {
  it('短行的片段就是整行，包含命中', async () => {
    const { ops } = makeOps(treeOf({ 'a.txt': fileOf('one\nthe needle here\nthree\n') }));
    const outcome = await scanFile('a.txt', contextFor(ops, 'needle'));

    assert.equal(outcome.kind, 'found');
    if (outcome.kind !== 'found') return;
    assert.equal(outcome.matches.length, 1);
    assert.deepEqual(
      { line: outcome.matches[0]?.line_number, col: outcome.matches[0]?.column, off: outcome.matches[0]?.snippet_offset },
      { line: 2, col: 4, off: 0 },
    );
    assert.equal(outcome.matches[0]?.snippet, 'the needle here');
  });

  it('同一行里的每一次出现都算一条命中，列号各不相同', async () => {
    const { ops } = makeOps(treeOf({ 'a.txt': fileOf('needle and needle\n') }));
    const outcome = await scanFile('a.txt', contextFor(ops, 'needle'));

    assert.equal(outcome.kind, 'found');
    if (outcome.kind !== 'found') return;
    assert.deepEqual(
      outcome.matches.map((m) => m.column),
      [0, 11],
    );
    assert.equal(outcome.matches[0]?.line_number, 1);
  });

  it('不重叠：`aa` 在 `aaaa` 里是两次，不是三次', async () => {
    const { ops } = makeOps(treeOf({ 'a.txt': fileOf('aaaa\n') }));
    const outcome = await scanFile('a.txt', contextFor(ops, 'aa'));

    assert.equal(outcome.kind, 'found');
    if (outcome.kind !== 'found') return;
    assert.deepEqual(
      outcome.matches.map((m) => m.column),
      [0, 2],
    );
  });

  it('超长行：片段从命中**之前** 64 码元开窗，`column - snippet_offset` 指向片段内的命中', async () => {
    const prefix = 'x'.repeat(5000);
    const { ops } = makeOps(treeOf({ 'a.txt': fileOf(`${prefix}needle${'y'.repeat(100)}\n`) }));
    const outcome = await scanFile('a.txt', contextFor(ops, 'needle'));

    assert.equal(outcome.kind, 'found');
    if (outcome.kind !== 'found') return;
    const match = outcome.matches[0];
    assert.ok(match !== undefined);

    // 两个坐标在同一个坐标系里（都相对**整行**），因此这个差就是「片段里的第几个字符」。
    // 留上下文而不是把片段切在命中处：`const x = ` 这半边才是判断「这是什么」的依据。
    assert.equal(match.snippet_offset, 5000 - 64);
    assert.equal(match.snippet.length, 64 + 'needle'.length + 100);
    assert.equal(match.snippet.slice(match.column - match.snippet_offset).startsWith('needle'), true);
    assert.equal(match.line_truncated, false); // 5000 + 100 字节 < 8 KiB
  });

  it('超过 MAX_LINE_BYTES 的行标 line_truncated', async () => {
    const long = `${'x'.repeat(LIMITS.MAX_LINE_BYTES + 10)}needle`;
    const { ops } = makeOps(treeOf({ 'a.txt': fileOf(`${long}\n`) }));
    const outcome = await scanFile('a.txt', contextFor(ops, 'needle'));

    assert.equal(outcome.kind, 'found');
    if (outcome.kind !== 'found') return;
    assert.equal(outcome.matches[0]?.line_truncated, true);
  });

  it('片段不超字节上限，且不切开码位', async () => {
    const line = `${'中'.repeat(400)}needle`;
    const { ops } = makeOps(treeOf({ 'a.txt': fileOf(`${line}\n`) }));
    const outcome = await scanFile('a.txt', contextFor(ops, 'needle'));

    assert.equal(outcome.kind, 'found');
    if (outcome.kind !== 'found') return;
    const snippet = outcome.matches[0]?.snippet ?? '';
    assert.ok(Buffer.byteLength(snippet, 'utf8') <= LIMITS.MAX_SNIPPET_BYTES);
    // 替换符（U+FFFD）出现即意味着切开了码位。
    assert.equal(snippet.includes('�'), false);
  });

  it('控制字符转义成单行：单独的 CR 不会让「第 N 行」指向两个位置', async () => {
    const { ops } = makeOps(treeOf({ 'a.txt': fileOf('one\ntab\there needle\rrest\ntwo\n') }));
    const outcome = await scanFile('a.txt', contextFor(ops, 'needle'));

    assert.equal(outcome.kind, 'found');
    if (outcome.kind !== 'found') return;
    const snippet = outcome.matches[0]?.snippet ?? '';
    assert.equal(snippet.includes('\r'), false);
    assert.equal(snippet.includes('\n'), false);
    assert.equal(snippet.includes('\\r'), true);
    assert.equal(snippet.includes('\\t'), true); // 制表符保留为可见的 `\t`
  });

  it('CRLF 文件的行号按 LF 计，行内容不含 CR', async () => {
    const { ops } = makeOps(treeOf({ 'a.txt': fileOf('one\r\ntwo needle\r\nthree\r\n') }));
    const outcome = await scanFile('a.txt', contextFor(ops, 'needle'));

    assert.equal(outcome.kind, 'found');
    if (outcome.kind !== 'found') return;
    assert.equal(outcome.matches[0]?.line_number, 2);
    assert.equal(outcome.matches[0]?.snippet, 'two needle');
  });
});

describe('LWB-015 分页取自本文件的命中序', () => {
  it('`skip_matches` 跳过前 N 个命中，`hits_in_file` 报的是总数', async () => {
    const { ops } = makeOps(treeOf({ 'a.txt': fileOf('n1 needle\nn2 needle\nn3 needle\n') }));
    const outcome = await scanFile('a.txt', contextFor(ops, 'needle', { skip_matches: 2 }));

    assert.equal(outcome.kind, 'found');
    if (outcome.kind !== 'found') return;
    assert.equal(outcome.hits_in_file, 3);
    assert.deepEqual(
      outcome.matches.map((m) => m.line_number),
      [3],
    );
  });

  it('`remaining_matches = 0` 时算得出命中数，但一条都不出站', async () => {
    const { ops } = makeOps(treeOf({ 'a.txt': fileOf('needle here\nneedle again\n') }));
    const ctx = contextFor(ops, 'needle', { remaining_matches: 0 });
    const outcome = await scanFile('a.txt', ctx);

    assert.equal(outcome.kind, 'found');
    if (outcome.kind !== 'found') return;
    // 这条能力是「找证据不花出站额度」的依据，见 search.ts 的文件头。
    assert.equal(outcome.hits_in_file, 2);
    assert.equal(outcome.matches.length, 0);
    assert.equal(ctx.budget.chargedTotal, 0);
  });

  it('页内取满即止，剩下的计入 hits_in_file 而不是丢失', async () => {
    const { ops } = makeOps(treeOf({ 'a.txt': fileOf('needle\nneedle\nneedle\nneedle\n') }));
    const outcome = await scanFile('a.txt', contextFor(ops, 'needle', { remaining_matches: 2 }));

    assert.equal(outcome.kind, 'found');
    if (outcome.kind !== 'found') return;
    assert.equal(outcome.matches.length, 2);
    assert.equal(outcome.hits_in_file, 4);
  });
});

describe('LWB-015 一个文件的问题只作废这一个文件', () => {
  it('超出单次可读上限：一个字节都没读', async () => {
    const tree = treeOf({ 'big.log': fileOf('needle', { size_override: LIMITS.MAX_READABLE_FILE_BYTES + 1 }) });
    const { ops, calls } = makeOps(tree);
    const outcome = await scanFile('big.log', contextFor(ops, 'needle'));

    assert.deepEqual(outcome, { kind: 'too_large' });
    assert.equal(calls.read, 0);
  });

  it('探针与读取之间对象被换掉 ⇒ unstable（这份内容不可信）', async () => {
    const tree = treeOf({ 'a.txt': fileOf('needle', { file_id_override: 'id:somewhere-else' }) });
    const { ops } = makeOps(tree);
    const outcome = await scanFile('a.txt', contextFor(ops, 'needle'));

    assert.equal(outcome.kind, 'unstable');
  });

  it('读到之前被删掉 ⇒ unreadable，不抛错', async () => {
    const tree = treeOf({ 'a.txt': fileOf('needle', { vanish_on_read: true }) });
    const { ops } = makeOps(tree);
    const outcome = await scanFile('a.txt', contextFor(ops, 'needle'));

    assert.deepEqual(outcome, { kind: 'unreadable', winfs_code: 'NOT_FOUND' });
  });

  it('被别的进程独占 ⇒ unreadable', async () => {
    const tree = treeOf({ 'a.txt': fileOf('needle', { busy_on_read: true }) });
    const { ops } = makeOps(tree);
    const outcome = await scanFile('a.txt', contextFor(ops, 'needle'));

    assert.deepEqual(outcome, { kind: 'unreadable', winfs_code: 'FILE_BUSY' });
  });

  it('权限不足 ⇒ unreadable（而不是把整次搜索变成一条错误）', async () => {
    const tree = treeOf({ 'a.txt': fileOf('needle', { denied_on_read: true }) });
    const { ops } = makeOps(tree);
    const outcome = await scanFile('a.txt', contextFor(ops, 'needle'));

    assert.deepEqual(outcome, { kind: 'unreadable', winfs_code: 'PERMISSION_DENIED' });
  });

  it('二进制文件：读到了字节，里面没有可检索的文本', async () => {
    const { ops } = makeOps(treeOf({ 'a.bin': fileOf(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe])) }));
    const outcome = await scanFile('a.bin', contextFor(ops, 'needle'));

    assert.equal(outcome.kind, 'no_text');
    if (outcome.kind !== 'no_text') return;
    assert.equal(outcome.reason, 'NOT_TEXT');
    assert.equal(outcome.bytes, 5);
  });

  it('无法解码的字节：同样是 no_text，但理由是 UNDECODABLE', async () => {
    // 合法的 UTF-8 前缀 + 一个孤立的续字节 —— 不是 UTF-16，也不是有效 UTF-8。
    const { ops } = makeOps(treeOf({ 'a.txt': fileOf(Buffer.from([0x41, 0x42, 0x80])) }));
    const outcome = await scanFile('a.txt', contextFor(ops, 'needle'));

    assert.equal(outcome.kind, 'no_text');
    if (outcome.kind !== 'no_text') return;
    assert.equal(outcome.reason, 'UNDECODABLE');
  });
});

describe('LWB-015 闸门仍然是唯一的出口', () => {
  it('硬拒绝路径上连预检都不放行（本层不做豁免，也不降级）', async () => {
    const { ops } = makeOps(treeOf({ '.env': fileOf('needle') }));
    const ctx = contextFor(ops, 'needle');
    // 调用方（遍历层）本该先拦下它。这里模拟「它漏了过来」，判据是闸门自己拦。
    await assert.rejects(
      () => scanFile('.env', ctx),
      (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.equal((error as BridgeError).code, 'POLICY_DENIED');
        return true;
      },
    );
  });

  it('出站预算耗尽 ⇒ 抛错，而不是悄悄少返回几条', async () => {
    const { ops } = makeOps(treeOf({ 'a.txt': fileOf(`${'needle\n'.repeat(20)}`) }));
    const ctx = contextFor(ops, 'needle');
    (ctx as { budget: EgressBudget }).budget = new EgressBudget({
      limit_bytes_per_hour: 16,
      now: () => NOW,
    });

    await assert.rejects(
      () => scanFile('a.txt', ctx),
      (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.equal((error as BridgeError).code, 'EGRESS_BUDGET_EXCEEDED');
        return true;
      },
    );
  });
});
