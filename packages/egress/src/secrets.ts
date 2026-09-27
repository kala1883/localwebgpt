/**
 * 高置信度秘密检测（LWB-011 步骤 4）。
 *
 * ## 先说清楚这个模块**做不到**什么
 *
 * **它不是「秘密识别器」，是「已知形状的凭证识别器」。** 下面每一条规则都是
 * 「某种已知凭据的已知形状」。因此：
 *
 *  - 没有关键字、没有固定前缀的随机串（例如一把 40 位十六进制的对称密钥）
 *    **检不出来**；
 *  - 运行时拼接出来的凭据（`process.env.A + process.env.B`）**检不出来**；
 *  - 被 base64 或压缩包了一层、或切分到多行的凭据，多半**检不出来**；
 *  - 私有格式、内部系统的自研 token，**检不出来**。
 *
 * 这不是「以后改进」的清单，是本模块的**能力边界**，方案要求明确记录
 * （LWB-011 验收标准 3）。`tests/unit/egress.test.ts` 里有一条用例
 * **断言某类秘密确实检不出来** —— 把边界钉在测试里，而不是只写在注释里：
 * 注释会腐坏，测试会在有人"顺手加一条规则"时提醒他去看边界。
 *
 * 因此出站检查的定位是**纵深防御的一层**，不是唯一的那层。真正拦住秘密的
 * 第一道是硬拒绝规则（`.env` / 私钥 / 凭证目录）与用户自己不给工作区授权。
 * 出站检查负责的是「已经能读到的内容里，别把手边这些明显的东西送出去」。
 *
 * ## 两档处置
 *
 *  - `certain`：形状本身就是凭证（PEM 私钥块、`AKIA…`、`sk_live_…`、`ghp_…`…）。
 *    正常文本里几乎不可能出现，误报率极低。
 *  - `likely`：关键字 + 长值（`password = "…"`、`token: …`、URL 内嵌口令）。
 *    可能是占位符，也可能是真凭据 —— 分不出来，所以**按能脱敏就脱敏**处理。
 *
 * ## 脱敏的铁律
 *
 * **替换文本里不得出现被替换内容的任何前缀或后缀。** 常见的错误做法是
 * `sk_live_****abcd`（保留前 8 位 + 后 4 位）—— 那不是脱敏，那是**部分泄露**，
 * 而且留下的部分往往正好是用于识别账户的部分。这里替换成固定标记
 * `[REDACTED:<规则 id>]`：零个原始字符，且标记本身不会再被任何规则命中
 * （标记里没有 `:` / `=` 跟着长值，见 `redact` 的幂等性用例）。
 */

import { CONTROL_TOKEN_PATTERN_SOURCE } from '@lwb/contracts';

export type SecretTier = 'certain' | 'likely';

interface SecretPattern {
  readonly id: string;
  readonly tier: SecretTier;
  /** 命中**整段**秘密时，替换整段；命中「关键字 + 值」时只替换值。 */
  readonly regex: RegExp;
  /** 只替换捕获组 1；`0` 表示替换整个匹配。 */
  readonly value_group: number;
  readonly note: string;
}

/**
 * 所有正则都是**线性**的：没有嵌套量词、没有回溯爆炸的形状。
 * 出站检查会跑在任意用户文件上，一条会指数回溯的规则等于一个拒绝服务入口。
 */
const PATTERNS: readonly SecretPattern[] = [
  // ---- certain：形状即凭证 ----
  {
    id: 'private-key-block',
    tier: 'certain',
    // **必须连正文一起吃掉**，不能只匹配开头那行标记。
    // 只匹配标记的话，脱敏会把 `-----BEGIN RSA PRIVATE KEY-----` 换成标记，
    // 而**后面那一大段 base64 私钥正文原样留在输出里** —— 那不是脱敏，
    // 是把锁头涂黑、钥匙还挂在门上。
    //
    // 结尾用 `|$` 兜住没有 END 标记的情况（截断的文件、被切片的读取）：
    // 此时一路盖到文本末尾。宁可多盖，因为它盖的是自己的私钥。
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----|$)/gd,
    value_group: 0,
    note: 'PEM 私钥块（含正文）。缺失 END 标记时盖到文本末尾。',
  },
  {
    id: 'putty-private-key',
    tier: 'certain',
    regex: /PuTTY-User-Key-File-\d+:[\s\S]*/gd,
    value_group: 0,
    note: 'PuTTY 私钥文件：头部之后的全部内容都是密钥正文，因此一路盖到末尾。',
  },
  {
    id: 'aws-access-key-id',
    tier: 'certain',
    regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/gd,
    value_group: 0,
    note: 'AWS 访问密钥 id（长期 / 临时 / 各类主体前缀）。',
  },
  {
    id: 'github-token',
    tier: 'certain',
    // ghp_/gho_/ghu_/ghs_/ghr_ + 36 位。旧式 40 位十六进制 token 与随机串无法区分，
    // 刻意不收录 —— 宁可漏，也不要一条天天误报的规则（会被关掉）。
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/gd,
    value_group: 0,
    note: 'GitHub 个人/应用/安装/刷新令牌。',
  },
  {
    id: 'slack-token',
    tier: 'certain',
    regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/gd,
    value_group: 0,
    note: 'Slack 机器人/用户/应用令牌。',
  },
  {
    id: 'stripe-secret-key',
    tier: 'certain',
    regex: /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}\b/gd,
    value_group: 0,
    note: 'Stripe 生产密钥。测试密钥（sk_test_）刻意不收录：它不构成资金风险，收录只会增加噪音。',
  },
  {
    id: 'google-api-key',
    tier: 'certain',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/gd,
    value_group: 0,
    note: 'Google API key 的固定前缀与长度。',
  },
  {
    id: 'npm-token',
    tier: 'certain',
    regex: /\bnpm_[A-Za-z0-9]{36}\b/gd,
    value_group: 0,
    note: 'npm 发布令牌。',
  },
  {
    id: 'jwt',
    tier: 'certain',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gd,
    value_group: 0,
    note: 'JWT（三段式、前两段是 base64url 的 JSON）。',
  },
  {
    id: 'azure-account-key',
    tier: 'certain',
    regex: /AccountKey\s*=\s*[A-Za-z0-9+/=]{80,}/gd,
    value_group: 0,
    note: 'Azure 存储账户密钥（base64，长度固定 88）。',
  },
  {
    id: 'aws-secret-access-key',
    tier: 'certain',
    regex: /aws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}["']?/gd,
    value_group: 0,
    note: 'AWS 秘密访问密钥的**赋值形态**：40 位 base64 字符集，单靠形状会误报，必须带关键字。',
  },
  {
    id: 'control-plane-token',
    tier: 'certain',
    // 形状来自 `@lwb/contracts` 的 `CONTROL_TOKEN_PATTERN_SOURCE`，与本仓库
    // 生成凭证的那一处**同源**：不在这里手抄一份前缀。
    //
    // 这一条的位置值得说明。上面那些规则防的是「用户的秘密别外泄」，
    // 而这一条防的是「**本程序自己的**授权凭证别外泄」—— 后果不在一个量级：
    // 用户的密钥泄露，损失是那把密钥能做的事；控制平面凭证泄露，
    // 损失是**整套授权机制**（拿到它就能自己批准自己的写入）。
    // 所以它不是「多一条规则更保险」，而是 LWB-012 验收标准 3
    // 「工具结果不含控制台登录令牌或带授权效果的 URL」的**实现**：
    // 令牌离开本机的路径只有 `emitContent()` 一条，而它在这里被拦下。
    regex: new RegExp(CONTROL_TOKEN_PATTERN_SOURCE, 'gd'),
    value_group: 0,
    note: '控制平面凭证（启动令牌 / 会话 / CSRF / 一次性 nonce）。带授权效果的 URL 因其含该形状而一并被拦。',
  },

  // ---- likely：关键字 + 值 ----
  {
    id: 'keyword-secret-value',
    tier: 'likely',
    regex:
      /(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential)s?\s*[:=]\s*["']?([^\s"'`,;]{12,})/gdi,
    value_group: 1,
    note: '关键字赋值。只脱敏值，保留 `password = ` 这半截 —— 上下文本身有用。',
  },
  {
    id: 'url-userinfo',
    tier: 'likely',
    regex: /:\/\/([^/\s:@]{1,64}):([^/\s:@]{6,})@/gd,
    value_group: 2,
    note: 'URL 内嵌凭据（`https://user:token@host`）。只脱敏口令段，保留用户名与主机 —— 后者对定位问题有用。',
  },
  {
    id: 'http-auth-header',
    tier: 'likely',
    regex: /\b(?:authorization|proxy-authorization)\s*[:=]\s*["']?(?:bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{16,})/gdi,
    value_group: 1,
    note: '请求头里的 Bearer/Basic 凭据。',
  },
];

/**
 * 模块加载期的自检：每条规则**必须**同时带 `g` 与 `d` 标志。
 *
 * 两条标志各有来历，都不是风格问题：
 *
 *  - `g`：`String.prototype.matchAll` 要求它，否则抛 `TypeError`。
 *    上面这批规则原本**一条都没有** `g` —— 也就是说筛查器在第一次被调用时
 *    就会抛异常，从来没有真正筛查过任何东西。它不算"安静地放行"，但会以
 *    「出站时抛一个与秘密无关的 TypeError」的形式暴露，很容易被当成别的问题。
 *  - `d`：让 `match.indices` 可用，从而拿到捕获组的**精确**下标。
 *    没有它就只能用 `lastIndexOf` 反查，而反查在「捕获组的值恰好也在关键字里
 *    出现」时会定到错误的位置（`password: password123`）—— 错位的脱敏是最危险的
 *    一种：它看起来脱敏了，留下的却正是真正的秘密。
 *
 * 不留「记得加标志」这条约定：在**导入模块时**就把它变成一条清晰的启动期错误，
 * 加规则的人立刻知道少了什么，而不是等到某次出站。
 */
for (const pattern of PATTERNS) {
  if (!pattern.regex.global || !pattern.regex.hasIndices) {
    throw new Error(
      `秘密规则 ${pattern.id} 的正则必须同时带 g 与 d 标志（当前为 /${pattern.regex.flags}）：` +
        '缺 g 会让 matchAll 抛错、筛查完全失效；缺 d 会让命中位置靠反查猜测，可能脱敏错位。',
    );
  }
}

export interface SecretFinding {
  readonly rule_id: string;
  readonly tier: SecretTier;
  /** 在输入中的起始偏移（UTF-16 码元）。 */
  readonly start: number;
  /** 被命中片段的长度。**这是元数据，不是内容。** */
  readonly length: number;
}

export interface ScreenResult {
  readonly findings: readonly SecretFinding[];
  readonly has_certain: boolean;
  readonly has_likely: boolean;
}

/**
 * 占位符与引用：这些**不可能**是秘密，脱敏它们只会让配置文件变得难读。
 *
 * 这是刻意引入的误报抑制，因此也刻意引入了一条（很窄的）漏报路径：
 * 一个真正的秘密如果长得像 `${...}`，就检不出来。这条取舍写在这里，
 * 也写在验收标准 3 的边界记录里 —— 不假装它不存在。
 */
function looksLikeReference(value: string): boolean {
  const v = value.trim();
  if (v.startsWith('${') || v.startsWith('$(') || v.startsWith('{{')) return true;
  if (v.startsWith('<') && v.endsWith('>')) return true;
  if (v.startsWith('%') && v.endsWith('%')) return true;
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return true;
  // 同一个字符重复（`xxxxxxxx`、`********`、`........`）
  if (/^(.)\1+$/.test(v)) return true;
  return false;
}

/** 扫描文本，返回全部命中。**只返回位置与规则，不返回命中的内容。** */
export function screenText(text: string): ScreenResult {
  const findings: SecretFinding[] = [];

  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern.regex)) {
      // 位置一律取自 `match.indices`（`d` 标志），**不**用 `indexOf` 反查。
      //
      // 这里原先是 `match[1]` + `lastIndexOf` 反查，于是有了两个 bug：
      //  1. `value_group` 被声明、被写进注释，却从来没人读 —— 无论填 1 还是 2，
      //     实际取的都是第 1 组。`url-userinfo` 的第 2 组才是口令，结果它把
      //     **用户名**脱敏掉、把口令原样送了出去。看上去脱敏了，秘密还在。
      //  2. 反查在值与关键字同形时会定错位置。
      // 用 indices 之后这两件事都无从发生：取哪一组由 `value_group` 决定，
      // 位置由引擎给出。
      const span = match.indices?.[pattern.value_group];
      if (span === undefined) continue;
      const [start, end] = span;
      if (pattern.value_group > 0 && looksLikeReference(match[pattern.value_group] ?? '')) continue;
      findings.push({ rule_id: pattern.id, tier: pattern.tier, start, length: end - start });
    }
  }

  // 同一段文本常常被两条规则同时命中（例如 `aws_secret_access_key = …`
  // 既命中它自己的规则，也命中通用的「关键字赋值」）。
  //
  // 处置是**取并集**，不是「保留更长的那条然后丢掉另一条」：
  // 两条区间部分重叠时，「丢掉一条」会把另一条多出来的尾巴留在文本里 ——
  // 那正好是脱敏最容易漏掉的一段。并集只会多盖，不会少盖。
  findings.sort((a, b) => a.start - b.start || b.length - a.length);
  const merged: SecretFinding[] = [];
  for (const f of findings) {
    const last = merged[merged.length - 1];
    if (last !== undefined && f.start <= last.start + last.length) {
      const end = Math.max(last.start + last.length, f.start + f.length);
      // 合并区间时**取更严重的那一档**：并集里若含有 certain 命中，
      // 它就是 certain。否则一次「关键字赋值」的合并会把一个私钥降级成 likely，
      // 于是本该阻断的变成只脱敏。标记也随更严重的那条规则走。
      const severe = last.tier === 'certain' ? last : (f.tier === 'certain' ? f : last);
      merged[merged.length - 1] = { ...severe, start: last.start, length: end - last.start };
      continue;
    }
    merged.push(f);
  }

  return {
    findings: merged,
    // 分档**从原始命中算**，不从合并结果算：合并会改变区间的归属，
    // 但「这份文本里有/没有 certain 级命中」是与合并无关的事实。
    has_certain: findings.some((f) => f.tier === 'certain'),
    has_likely: findings.some((f) => f.tier === 'likely'),
  };
}

export interface RedactResult {
  readonly text: string;
  readonly redacted: boolean;
  readonly findings: readonly SecretFinding[];
}

/**
 * 就地脱敏。**从后往前替换**，这样前面的偏移不会被自己的替换结果影响。
 *
 * 替换文本是 `[REDACTED:<规则 id>]`：零个原始字符。
 * 标记本身不含 `:` / `=` 后面跟长值的形状，因此本函数**幂等** ——
 * 对已经脱敏的文本再跑一次，结果不变（有对应测试）。
 */
export function redact(text: string, screen: ScreenResult = screenText(text)): RedactResult {
  if (screen.findings.length === 0) {
    return { text, redacted: false, findings: [] };
  }

  let out = text;
  const ordered = [...screen.findings].sort((a, b) => b.start - a.start);
  for (const f of ordered) {
    const marker = `[REDACTED:${f.rule_id}]`;
    out = out.slice(0, f.start) + marker + out.slice(f.start + f.length);
  }

  return { text: out, redacted: true, findings: screen.findings };
}

/** 规则 id 清单，供证据脚本与文档自检（确保记录下来的清单与代码同源）。 */
export function secretRuleIds(): readonly { readonly id: string; readonly tier: SecretTier; readonly note: string }[] {
  return PATTERNS.map((p) => ({ id: p.id, tier: p.tier, note: p.note }));
}
