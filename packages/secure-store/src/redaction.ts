/**
 * 脱敏（LWB-007 步骤 3 验收：日志、进程参数、导出的诊断包没有明文凭证）。
 *
 * 两条互补的做法，缺一不可：
 *
 *  1. **主动替换**：已知的机密值注册进来，任何输出前替换掉。
 *     这是唯一可靠的做法 —— 只有知道自己持有什么机密，才能保证不泄露它。
 *  2. **特征匹配**：对常见凭证形状做兜底替换。
 *     它**不可靠**（无法覆盖所有格式），只能作为第二道网，不能当成保证。
 *
 * 另有一条硬约束：本模块只接收字符串，不接收密钥对象本身，
 * 避免把「脱敏器」变成「机密的集中存储点」。
 */

export interface RedactionTarget {
  /** 用于替换后的标注，例如 `runtime-credential`。**不得**包含机密本身。 */
  readonly label: string;
  readonly value: string;
}

const PLACEHOLDER_PREFIX = '«redacted:';
const PLACEHOLDER_SUFFIX = '»';

function placeholder(label: string): string {
  return `${PLACEHOLDER_PREFIX}${label}${PLACEHOLDER_SUFFIX}`;
}

/**
 * 兜底特征表。
 *
 * 明确的局限：这些是**已知形状**，不是完整集合。新增的凭证格式除非更新本表，
 * 否则不会被自动识别 —— 这正是为什么第 1 条（主动注册）是主要手段。
 */
const SECRET_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  // 私钥块：整段替换，否则只换掉 BEGIN 行毫无意义。
  {
    label: 'private-key-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { label: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { label: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi },
  // 常见前缀：OpenAI / Anthropic / GitHub / Slack / Tailscale 风格。
  // 分隔符必须同时接受 `-` 与 `_`：GitHub 用 `ghp_`，OpenAI 用 `sk-`，
  // 只写其中一个就会把另一家的凭证整类漏掉（本条的 `_` 分支正是被测试逼出来的）。
  { label: 'prefixed-token', pattern: /\b(?:sk|rk|pk|ghp|gho|ghs|ghu|xox[baprs]|tskey)[-_][A-Za-z0-9_-]{16,}\b/g },
  {
    label: 'assignment',
    pattern: /\b(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret)\b\s*[=:]\s*["']?([^\s"',;]{8,})["']?/gi,
  },
];

/**
 * 脱敏一段文本。
 *
 * 顺序很重要：先替换已注册的机密（精确、可靠），再用特征兜底。
 * 反过来会让特征表先把已注册机密的**部分**替换掉，导致精确匹配失败。
 */
export function redact(text: string, targets: readonly RedactionTarget[] = []): string {
  let output = text;

  for (const target of targets) {
    if (target.value.length === 0) continue;
    output = output.split(target.value).join(placeholder(target.label));
  }

  for (const { label, pattern } of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, group?: string) => {
      // 带捕获组的规则（赋值形式）只替换值，保留键名，便于排障时看出
      // 「这里本该是一个 token」。
      if (typeof group === 'string' && group.length > 0) {
        return match.replace(group, placeholder(label));
      }
      return placeholder(label);
    });
  }

  return output;
}

/**
 * 断言文本中**不含**任何已注册机密。
 *
 * 用于导出诊断包之前的最后一道闸：特征匹配可能漏，这个不会漏
 * （因为它比对的是我们确实持有的值）。发现泄漏时抛错并拒绝导出，
 * 而不是「导出但打了码」—— 打码失败与没打码的后果相同。
 */
export function assertNoRegisteredSecret(text: string, targets: readonly RedactionTarget[]): void {
  for (const target of targets) {
    if (target.value.length === 0) continue;
    if (text.includes(target.value)) {
      throw new Error(`诊断产物中检出未脱敏的机密（${target.label}），已拒绝导出。`);
    }
  }
}

/**
 * 脱敏进程参数。
 *
 * 设计前提：**凭证本来就不应该出现在命令行里**（命令行对同账户的任何进程可读）。
 * 本函数是补救而不是许可 —— 它拦得住日志，拦不住 `Get-CimInstance Win32_Process`。
 */
export function redactArgv(argv: readonly string[], targets: readonly RedactionTarget[] = []): string[] {
  return argv.map((arg) => redact(arg, targets));
}

/** 给日志用的安全事件：只记录「做过脱敏」这个事实与命中的标签，不记录原文。 */
export function describeRedaction(candidates: readonly RedactionTarget[]): {
  readonly labels: readonly string[];
  readonly count: number;
} {
  return { labels: candidates.map((c) => c.label), count: candidates.length };
}

/** 从对象里剔除已知的敏感字段名（用于结构化日志）。 */
const SENSITIVE_FIELD_NAMES = new Set([
  'credential',
  'credentials',
  'secret',
  'token',
  'password',
  'passwd',
  'api_key',
  'apikey',
  'authorization',
  'auth',
  'private_key',
  'client_secret',
  'ciphertext',
  'plaintext',
]);

export function redactFields(
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 8) return '«redacted:depth-limit»';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactFields(item, depth + 1));

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) {
      out[key] = placeholder('field');
    } else {
      out[key] = redactFields(source[key], depth + 1);
    }
  }
  return out;
}
