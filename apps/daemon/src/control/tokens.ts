/**
 * 控制平面凭证的生成、持有与比较（LWB-012 步骤 2）。
 *
 * ## 三条规则，每条都有一个具体的、曾经出过事的理由
 *
 * 1. **只存摘要，不存原值。** 会话表里放的是 `sha256(令牌)`。原值只在两处
 *    短暂存在：生成它的那一刻（交给调用方），和校验它的那一刻（从请求里读到）。
 *    这样即使有人拿到了进程的内存转储、或者某天有人顺手把会话表打进了日志，
 *    他得到的是一串摘要 —— 摘要不能当 cookie 用。
 *
 * 2. **比较一律走常数时间。** `===` 会在第一个不同的字节处返回，
 *    比较耗时因此泄露「前几个字节猜对了」。对一张 256 位随机令牌来说，
 *    这条路走不通（要猜的太多了），但代价只是把 `===` 换成一段标准库调用，
 *    而「顺手写 `===`」是会传染的 —— 下一个人会照着抄到别的地方去。
 *
 * 3. **生成后立刻自检形状。** 见 `newControlToken`：如果生成的令牌不匹配
 *    `@lwb/contracts` 里那个被 `@lwb/egress` 用作筛查规则的形状，
 *    那就意味着「令牌不会被出站筛查拦住」。这是一个**静默的**、
 *    只在这两个常量漂移时出现的失效，因此宁可在生成时报错。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CONTROL_TOKEN_BODY_LENGTH,
  CONTROL_TOKEN_PREFIX,
  type ControlTokenKind,
} from '@lwb/contracts';

/** 32 字节 = 256 位。见 `CONTROL_TOKEN_BODY_LENGTH` 的注释。 */
const TOKEN_BYTES = 32;

/**
 * 生成一张控制平面凭证。
 *
 * 前缀 + base64url(32 字节)。base64url 而不是 hex：同样 256 位，
 * hex 是 64 个字符、base64url 是 43 个 —— 短一些的 URL 更容易被人工核对。
 * 代价是字母表里多出 `-` 与 `_`，不影响任何使用方式。
 */
export function newControlToken(kind: ControlTokenKind): string {
  const token = `${CONTROL_TOKEN_PREFIX[kind]}${randomBytes(TOKEN_BYTES).toString('base64url')}`;

  // 自检：形状必须与出站筛查规则认得的那一个**逐字一致**。
  // 这两处一旦漂移，后果是「凭证照常签发，而筛查认不出它」——
  // 一个不会自己暴露的失效。所以让它在生成时就炸。
  const body = token.slice(CONTROL_TOKEN_PREFIX[kind].length);
  if (body.length !== CONTROL_TOKEN_BODY_LENGTH) {
    throw new Error(
      `控制平面凭证的随机段长度为 ${body.length}，与 contracts 声明的 ` +
        `${CONTROL_TOKEN_BODY_LENGTH} 不一致；出站筛查规则会漏检这类令牌。`,
    );
  }
  return token;
}

/** 令牌的存储形式。**会话表与 nonce 表里只放这个。** */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * 常数时间比较。长度不同直接返回 false —— 长度本身不是秘密
 * （令牌长度是公开的固定值），为它做常数时间没有意义。
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
