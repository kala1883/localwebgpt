/**
 * 查询串的形态与匹配（LWB-015 步骤 1）。
 *
 * > 首版提供字面量、大小写开关和受限路径 glob，**不开放任意正则/命令**。
 *
 * 这一条不能用「我们没写正则」来证明 —— 要证明的是**接口的形状**：
 * 无论查询串长什么样，它都只按字面量比。因此这里的用例刻意喂进一堆
 * 正则元字符，判据是「它们没有产生任何模式语义」。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BridgeError, LIMITS } from '@lwb/contracts';
import { compileQuery, findInLine, queryDigest } from '@lwb/search';

function expectInvalid(reason: string, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof BridgeError, `期望 BridgeError，实际 ${String(error)}`);
    assert.equal((error as BridgeError).code, 'INVALID_ARGUMENT');
    assert.equal((error as BridgeError).details?.reason, reason);
    return true;
  });
}

describe('LWB-015 查询串只有字面量语义', () => {
  it('正则元字符按字面量处理：`a.c` 不匹配 `abc`，只匹配 `a.c`', () => {
    const query = compileQuery('a.c', undefined);
    assert.equal(findInLine(query, 'a.c is here', 0), 0);
    assert.equal(findInLine(query, 'abc is here', 0), -1);
  });

  it('`.*` 不会匹配任意内容', () => {
    const query = compileQuery('.*', undefined);
    assert.equal(findInLine(query, 'anything at all', 0), -1);
    assert.equal(findInLine(query, 'x = .* y', 0), 4);
  });

  it('`\\d` 与 `[a-z]` 同样只是字面量', () => {
    assert.equal(findInLine(compileQuery('\\d', undefined), 'abc123', 0), -1);
    assert.equal(findInLine(compileQuery('[a-z]', undefined), 'ABC', 0), -1);
    assert.equal(findInLine(compileQuery('[a-z]', undefined), 'x [a-z] y', 0), 2);
  });
});

describe('LWB-015 大小写开关', () => {
  it('默认不敏感：`readme` 找得到 `README`', () => {
    const query = compileQuery('readme', undefined);
    assert.equal(query.case_sensitive, false);
    assert.equal(findInLine(query, 'See README.md', 0), 4);
  });

  it('显式不敏感与省略等价', () => {
    assert.equal(compileQuery('readme', false).needle, compileQuery('readme', undefined).needle);
  });

  it('`case_sensitive: true` 是**收窄**：`readme` 找不到 `README`', () => {
    const query = compileQuery('readme', true);
    assert.equal(query.case_sensitive, true);
    assert.equal(findInLine(query, 'See README.md', 0), -1);
    assert.equal(findInLine(query, 'see readme.md', 0), 4);
  });

  it('小写化是语言无关的：土耳其语的 I 不会变成 ı', () => {
    // `toLocaleLowerCase('tr')` 会把 `I` 映射成 `ı`，于是同一个查询在两台
    // 机器上给出不同结果。判据是「无论区域设置如何，`I` 只映射到 `i`」。
    assert.equal(compileQuery('I', undefined).needle, 'i');
    assert.equal(findInLine(compileQuery('i', undefined), 'INDEX', 0), 0);
  });
});

describe('LWB-015 拒绝的四种查询', () => {
  it('不是字符串', () => {
    expectInvalid('QUERY_NOT_A_STRING', () => compileQuery(42, undefined));
  });

  it('空串 —— 空查询会命中每一个位置，结果没有意义', () => {
    expectInvalid('QUERY_EMPTY', () => compileQuery('', undefined));
  });

  it('超过上限 —— 上限的唯一理由是这一段文本会被复述回模型', () => {
    expectInvalid('QUERY_TOO_LONG', () => compileQuery('x'.repeat(LIMITS.MAX_SEARCH_QUERY_CHARS + 1), undefined));
  });

  it('恰好等于上限是合法的（边界不算越界）', () => {
    const query = compileQuery('x'.repeat(LIMITS.MAX_SEARCH_QUERY_CHARS), undefined);
    assert.equal(query.text.length, LIMITS.MAX_SEARCH_QUERY_CHARS);
  });

  it('大小写开关不是布尔值', () => {
    expectInvalid('CASE_SENSITIVE_NOT_A_BOOLEAN', () => compileQuery('a', 'yes'));
  });
});

describe('LWB-015 命中位置按 UTF-16 码元计', () => {
  it('行内第二次出现的列号是相对整行算的', () => {
    const query = compileQuery('ab', undefined);
    assert.equal(findInLine(query, 'ab..ab', 0), 0);
    // 从第 1 个命中之后继续找：`from` 用的是码元偏移。
    assert.equal(findInLine(query, 'ab..ab', 2), 4);
  });

  it('emoji 占两个码元 —— 列号因此可能小于「第几个字符」', () => {
    const query = compileQuery('x', undefined);
    // `😀` 是一个码位、两个码元，因此 `x` 的码元列是 2 而不是 1。
    assert.equal(findInLine(query, '😀x', 0), 2);
  });

  it('不敏感匹配用的是小写化后的串，列号仍落在原串上', () => {
    const query = compileQuery('abc', undefined);
    assert.equal(findInLine(query, 'XXABC', 0), 2);
  });
});

describe('LWB-015 查询指纹绑进游标', () => {
  const q = compileQuery('alpha', undefined);

  it('同一组输入给出同一个摘要', () => {
    assert.equal(queryDigest(q, null), queryDigest(compileQuery('alpha', undefined), null));
  });

  it('查询串不同 ⇒ 摘要不同', () => {
    assert.notEqual(queryDigest(q, null), queryDigest(compileQuery('beta', undefined), null));
  });

  it('大小写开关不同 ⇒ 摘要不同（它是另一次搜索）', () => {
    assert.notEqual(queryDigest(q, null), queryDigest(compileQuery('alpha', true), null));
  });

  it('glob 不同 ⇒ 摘要不同', () => {
    assert.notEqual(queryDigest(q, null), queryDigest(q, '*.ts'));
    assert.notEqual(queryDigest(q, '*.ts'), queryDigest(q, '*.md'));
  });

  it('摘要是定长十六进制，不含查询原文', () => {
    const digest = queryDigest(compileQuery('super-secret-query-text', undefined), null);
    assert.match(digest, /^[0-9a-f]{16}$/);
    assert.equal(digest.includes('secret'), false);
  });
});
