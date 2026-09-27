/**
 * 查询串的形态判定与字面量匹配（LWB-015 步骤 1）。
 *
 * > 首版提供字面量、大小写开关和受限路径 glob，**不开放任意正则/命令**。
 *
 * 「不开放任意正则」在这里不是一条约定，是**接口的形状**：本模块没有任何
 * 接受 `RegExp` 或模式字符串的函数，`SearchQuery` 只装一个已经确定下来的
 * 字面量。要搜 `.` 就去搜一个点号，它不会匹配任意字符 —— 因为匹配用的是
 * `String.prototype.indexOf`，而不是把查询串编译成模式。
 *
 * ## 为什么大小写**不敏感**是默认值
 *
 * 契约里 `case_sensitive?: boolean`，省略即不敏感。两个理由：
 *
 *  1. 与平台语义一致 —— 工作区在 NTFS 上，路径本来就大小写不敏感，
 *     而用户搜文件名里的词（`readme` → `README.md`）的预期是能找到；
 *  2. 方向安全 —— 搜得**更宽**只会多返回命中，而漏掉一个命中的代价
 *     （模型断言「不存在」）比多一个命中的代价大得多。
 *
 * 反过来，`case_sensitive: true` 是一个**收窄**，它不需要任何额外授权。
 */

import { createHash } from 'node:crypto';
import { BridgeError } from '@lwb/contracts';
import { LIMITS } from '@lwb/contracts';

/** 已经确定下来的查询：一个字面量，加一个大小写开关。 */
export interface SearchQuery {
  /** 模型给的原串，原样回显在结果里（I14：回执不重新解释调用方的输入）。 */
  readonly text: string;
  readonly case_sensitive: boolean;
  /**
   * 实际用于比较的针。不敏感时是 `text.toLowerCase()`。
   *
   * 预处理一次而不是每一行都小写化查询串：一份两万行的文件会做两万次
   * 同样的小写化，而它每次都得出的同一个结果。
   */
  readonly needle: string;
}

/**
 * 校验并编译查询串。
 *
 * 三个拒绝理由各自对应一种「不拒绝就会得到一个说不清的结果」的情形：
 *
 *  - 不是字符串 ⇒ 契约违规，且 `indexOf` 会把数字当字符串比，搜出些莫名其妙的东西；
 *  - 空串 ⇒ **每一个位置**都命中。一次空查询会返回前 100 个文件的第一行，
 *    而那既不是用户想要的，也不是模型能解释的；
 *  - 超过 `MAX_SEARCH_QUERY_CHARS` ⇒ 这个串会被复述回模型、写进游标摘要、
 *    可能进日志。上限的作用是让一次搜索的往返开销有界。
 *
 * `toLowerCase()` 是**语言无关**的小写化（不是 `toLocaleLowerCase`）：
 * 后者在土耳其语环境下把 `I` 映射成 `ı`，于是同一个查询在两台机器上
 * 给出不同的结果 —— 一个只在特定区域设置下复现的搜索缺陷。
 */
export function compileQuery(raw: unknown, caseSensitive: unknown): SearchQuery {
  if (typeof raw !== 'string') {
    throw new BridgeError('INVALID_ARGUMENT', 'query 必须是字符串。', { reason: 'QUERY_NOT_A_STRING' });
  }
  if (raw.length === 0) {
    throw new BridgeError('INVALID_ARGUMENT', 'query 不能是空串：空查询会命中每一个位置，结果没有意义。', {
      reason: 'QUERY_EMPTY',
    });
  }
  if (raw.length > LIMITS.MAX_SEARCH_QUERY_CHARS) {
    throw new BridgeError(
      'INVALID_ARGUMENT',
      `query 超过 ${LIMITS.MAX_SEARCH_QUERY_CHARS} 字符上限（当前 ${raw.length}）。`,
      { reason: 'QUERY_TOO_LONG', limit: 'MAX_SEARCH_QUERY_CHARS' },
    );
  }
  if (caseSensitive !== undefined && typeof caseSensitive !== 'boolean') {
    throw new BridgeError('INVALID_ARGUMENT', 'case_sensitive 必须是布尔值。', {
      reason: 'CASE_SENSITIVE_NOT_A_BOOLEAN',
    });
  }

  const sensitive = caseSensitive === true;
  return Object.freeze({
    text: raw,
    case_sensitive: sensitive,
    needle: sensitive ? raw : raw.toLowerCase(),
  });
}

/**
 * 在一行里找出下一个命中位置。
 *
 * `from` 是行内的 UTF-16 码元偏移。返回值同样是**码元**偏移 ——
 * 契约的 `column` 也是码元，三者同一套坐标。（码元不是「字符」：一个 emoji
 * 占两个码元。这一点写在这里，是因为它决定了 `column` 与编辑器里看到的
 * 列号在含 emoji 的行上可能差几列，而那是契约已经选定的语义。）
 */
export function findInLine(query: SearchQuery, line: string, from: number): number {
  const haystack = query.case_sensitive ? line : line.toLowerCase();
  return haystack.indexOf(query.needle, from);
}

/**
 * 查询的指纹：绑进分页游标，用来抓「拿另一次查询的游标续读」。
 *
 * 用 SHA-256 而不是一个短的非密码学哈希：这条绑定决定的是「续读出来的
 * 结果属于哪次查询」。一个能被构造出碰撞的摘要，等于让一段针对 A 的
 * 续读以 B 的名义返回 —— 结果看起来是完整的、行号也对得上，只是它回答的
 * 不是调用方问的问题。代价只有一个哈希，没有理由省它。
 *
 * **摘要而不是原文**：游标是签名过的明文载荷，会出现在模型的消息里。查询串
 * 本身再出现一次没有害处（模型本来就知道它），但压成定长摘要能让
 * 「游标里都有什么」一眼看完。它只用于比对，不参与任何授权判定。
 */
export function queryDigest(query: SearchQuery, pathGlob: string | null): string {
  const material = JSON.stringify([query.text, query.case_sensitive, pathGlob]);
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16);
}
