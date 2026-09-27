/**
 * 文件规则：**硬拒绝**与**搜索排除**是两件事，必须分开存储（方案 §4.3）。
 *
 * 为什么不能在同一个列表里加个 `severity` 字段了事：
 *
 *   - 搜索排除（`node_modules`、`dist`、媒体、大型数据）是**性能**取舍。
 *     它随项目而变，本地操作者随手就能改，改错了最坏是搜得慢或搜到了该搜的东西。
 *   - 硬拒绝（`.env`、私钥、凭证、插件自身状态目录）是**安全**边界。
 *     它不能由模型取消，也不该因为"某个项目想搜一下 node_modules"而被顺带放宽。
 *
 * 两者若共用一个列表，就会出现「为了让搜索跑得快一点，把某个规则调成排除」
 * 这种看起来无害、实则把安全边界降级成性能开关的操作。分开存储之后，
 * 放宽搜索排除在**语法上**根本碰不到硬拒绝集合。
 *
 * 模型侧无法修改本文件的任何内容（I02）：规则全部来自进程内的常量与
 * 本地操作者的配置文件，工具参数里没有任何字段能触及它们。
 */

export type FileRuleKind = 'hard_deny' | 'search_exclude';

export interface FileRule {
  /** 稳定标识，出现在审计与拒绝理由里。 */
  readonly id: string;
  readonly kind: FileRuleKind;
  /** 相对路径**逐段**匹配时使用的模式。 */
  readonly patterns: readonly string[];
  /**
   * 本规则**不适用**的确切名字（只能是不含 `*` 的字面量）。
   *
   * 这是操作者开洞的唯一形态，而且孔开在规则**自己身上** ——
   * 读这条规则的人不可能看漏它。见 `operator-overrides.ts`：
   * 豁免只能收窄一条既有规则，不能新增或删除规则。
   */
  readonly except?: readonly string[];
  /** 为什么有这条规则。写清楚，否则下一个人只会把它删掉。 */
  readonly rationale: string;
}

/**
 * 名字匹配：大小写不敏感（Windows 文件系统如此），`*` 只匹配段内字符。
 *
 * 刻意**不**做「子串包含」匹配：`.env` 若用子串匹配会连
 * `docs/env-notes.md` 一起拒掉，而拒得过多会促使人们去关规则 ——
 * 一条会被关掉的安全规则等于没有。
 */
function matchesSegment(pattern: string, segment: string): boolean {
  const p = pattern.toLowerCase();
  const s = segment.toLowerCase();
  if (!p.includes('*')) return p === s;
  const parts = p.split('*');
  if (parts.length !== 2) return false;
  const [head, tail] = parts as [string, string];
  return s.length >= head.length + tail.length && s.startsWith(head) && s.endsWith(tail);
}

/**
 * 单个路径段是否命中规则。`except` 先判且**优先于**命中：
 * 一个被豁免的名字即使同时被模式命中，也算没命中。
 */
export function ruleMatchesSegment(rule: FileRule, segment: string): boolean {
  if (rule.except?.some((e) => matchesSegment(e, segment))) return false;
  return rule.patterns.some((p) => matchesSegment(p, segment));
}

/** 规则是否命中该相对路径的**任意一段**（`/` 分隔，段内匹配）。 */
export function ruleMatchesPath(rule: FileRule, relativePath: string): boolean {
  const segments = relativePath.split('/').filter((s) => s.length > 0);
  return segments.some((segment) => ruleMatchesSegment(rule, segment));
}

/**
 * 硬拒绝规则。**这不是一份可以随手扩充的清单，而是一份保守的下限。**
 *
 * 逐条给出理由，因为每条规则都会挡住真实用户的真实文件：
 * 一个说不出理由的拒绝，最终会被当成 bug 关掉。
 */
export const HARD_DENY_RULES: readonly FileRule[] = [
  {
    id: 'HD-ENV',
    kind: 'hard_deny',
    patterns: ['.env', '.env.*', '*.env'],
    rationale:
      '.env 是密钥最常见的落点。**包括 `.env.example`** —— 方案 §4.3 明确要求不做自动豁免：' +
      '「示例文件」里放真实密钥是最常见的意外，而「哪些 .env.* 是安全的」无法由文件名判定。' +
      '操作者仍可在本地策略里为确定的样例单独开洞。',
  },
  {
    id: 'HD-PRIVATE-KEY',
    kind: 'hard_deny',
    patterns: ['*.pem', '*.key', '*.pfx', '*.p12', '*.jks', '*.keystore', '*.ppk'],
    rationale: '私钥与密钥库文件。内容本身就是凭证，且往往无法轮换。',
  },
  {
    id: 'HD-SSH-KEY',
    kind: 'hard_deny',
    patterns: ['id_rsa', 'id_rsa.*', 'id_ed25519', 'id_ed25519.*', 'id_ecdsa', 'id_ecdsa.*', 'id_dsa*', 'authorized_keys'],
    rationale: 'SSH 私钥与授权公钥；后者泄露会暴露可登录的主机与账户名。',
  },
  {
    id: 'HD-CREDENTIAL-STORE',
    kind: 'hard_deny',
    patterns: [
      '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config/gcloud',
      '.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials', '.htpasswd',
      'credentials', 'credentials.json', 'service-account*.json',
    ],
    rationale: '各类工具的凭证目录与文件。注意 `.config/gcloud` 是**两段**，'
      + '因此用 `/` 分隔的整串模式匹配；匹配是对路径的每一段做的，两种写法都覆盖。',
  },
  {
    id: 'HD-BROWSER-CREDENTIAL',
    kind: 'hard_deny',
    patterns: ['Login Data', 'Login Data-*', 'Cookies', 'Cookies-journal', 'logins.json', 'key4.db', 'key3.db', 'signons.sqlite', 'Local State'],
    rationale:
      '浏览器保存的密码与 Cookie。工作区里一般不会有这些，'
      + '但「用户把整个用户目录当工作区」这条路径必须被挡住 —— 那是本工程最该防的误配置。',
  },
  {
    id: 'HD-GIT-CONFIG',
    kind: 'hard_deny',
    patterns: ['config'],
    rationale:
      '**仅适用于 `.git` 目录内**（见 classifyFile 的前缀判定，不在本表里做全局匹配）。'
      + '.git/config 与 .git/credentials 常含 `https://user:token@host` 形式的远端 URL，'
      + '是凭证泄露的经典位置。',
  },
  {
    id: 'HD-PLUGIN-STATE',
    kind: 'hard_deny',
    patterns: ['.lwb', '.lwb-state', '.lwb-plugin', 'lwb-state'],
    rationale:
      'I13：本插件自身的状态目录（密钥、审批状态库、恢复快照）对模型**永远**不可挂载，'
      + '也不可从工作区内读到。这里做兜底 —— 真正的第一道是 LWB-009 拒绝把这类根登记为工作区。',
  },
];

/**
 * 搜索排除规则。**可本地调整**，且调整它不会影响任何硬拒绝。
 *
 * 注意措辞：这是「不扫」，不是「不许读」。被排除的文件仍可被显式读取
 * （只要能通过硬拒绝检查）—— 把它当成安全边界来用是错的。
 */
export const SEARCH_EXCLUDE_RULES: readonly FileRule[] = [
  {
    id: 'SE-DEPS',
    kind: 'search_exclude',
    patterns: ['node_modules', 'bower_components', 'vendor', '.venv', 'venv', '__pycache__', 'site-packages'],
    rationale: '依赖目录：内容不由本项目维护，量大且几乎不会有本项目的命中。',
  },
  {
    id: 'SE-BUILD',
    kind: 'search_exclude',
    patterns: ['dist', 'build', 'out', 'target', '.next', '.nuxt', '.output', 'coverage', '.nyc_output', '.turbo', '.parcel-cache', '.cache'],
    rationale: '编译产物与缓存：与源码重复，且 README 里没有但文件里全是。',
  },
  {
    id: 'SE-VCS',
    kind: 'search_exclude',
    // `.git` 目录内的对象与索引是压缩/二进制内容，字面量检索没有意义，
    // 且真按字节搜会导致大量无意义的"命中"。Git 内容走 git_diff 那条路。
    patterns: ['.git', '.hg', '.svn'],
    rationale: '版本库内部对象：字面量检索无意义（多为压缩/二进制），Git 内容另有专门的读取路径。',
  },
  {
    id: 'SE-MEDIA',
    kind: 'search_exclude',
    patterns: ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.ico', '*.bmp', '*.svgz', '*.mp3', '*.mp4', '*.mov', '*.avi', '*.zip', '*.gz', '*.7z', '*.rar', '*.pdf', '*.woff', '*.woff2', '*.ttf', '*.otf', '*.exe', '*.dll', '*.so', '*.dylib', '*.node', '*.wasm'],
    rationale: '二进制媒体与产物：字面量检索命中不了什么，却会吃掉全部字节预算。',
  },
  {
    id: 'SE-LARGE-DATA',
    kind: 'search_exclude',
    patterns: ['*.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '*.min.js', '*.min.css', '*.map', '*.snap'],
    rationale: '机器生成的巨型文本：字节预算会被单个文件吃光。',
  },
];

export const ALL_DEFAULT_RULES: readonly FileRule[] = [...HARD_DENY_RULES, ...SEARCH_EXCLUDE_RULES];

/** 一条规则在**不涉及 `.git`** 时的匹配结果。 */
export type RuleVerdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'hard_deny'; readonly rule_id: string; readonly rationale: string }
  | { readonly kind: 'search_exclude'; readonly rule_id: string; readonly rationale: string };

/**
 * 判定一个相对路径。
 *
 * 硬拒绝**先判**，且一旦命中就返回它 —— 一个路径不可能同时是
 * 「可以搜但不让读」。若反过来先判排除，被排除目录里的 `.env`
 * 在读取路径上就永远轮不到硬拒绝那一句。
 *
 * 注意本函数**只看路径**：它不知道文件内容、大小、实际身份。
 * 那些由护栏与出站检查各自负责，不能在这一层假装知道。
 */
export function classifyFile(
  relativePath: string,
  rules: readonly FileRule[] = ALL_DEFAULT_RULES,
): RuleVerdict {
  const segments = relativePath.split('/').filter((s) => s.length > 0);
  const dotGitAt = segments.findIndex((s) => s.toLowerCase() === '.git');

  for (const rule of rules) {
    if (rule.kind !== 'hard_deny') continue;

    if (rule.id === 'HD-GIT-CONFIG') {
      // `.git/config` 这类只在 `.git` 之内成立；不把它做成全局的 `config` 匹配，
      // 否则项目自己的 `config/` 目录会被整片拒掉。
      if (dotGitAt >= 0 && segments.length > dotGitAt + 1) {
        const after = segments.slice(dotGitAt + 1);
        if (after.some((s) => ruleMatchesSegment(rule, s))) {
          return { kind: 'hard_deny', rule_id: rule.id, rationale: rule.rationale };
        }
      }
      continue;
    }

    if (ruleMatchesPath(rule, relativePath)) {
      return { kind: 'hard_deny', rule_id: rule.id, rationale: rule.rationale };
    }
  }

  for (const rule of rules) {
    if (rule.kind !== 'search_exclude') continue;
    if (ruleMatchesPath(rule, relativePath)) {
      return { kind: 'search_exclude', rule_id: rule.id, rationale: rule.rationale };
    }
  }

  return { kind: 'allow' };
}

/**
 * 本地操作者可以**新增**规则，但有一条硬约束：不能削弱既有的硬拒绝。
 *
 * 「新增」与「删除」的区别在这里是安全属性，不是接口洁癖：
 * 一份允许操作者删除硬拒绝规则的 API，迟早会被某个「就是想读一下 .env」
 * 的脚本用上。要开洞就必须在 `packages/policy/src/operator-overrides.ts`
 * 里写一条**具名、可审计**的豁免，而不是在运行时删规则。
 */
export function validateRuleAddition(rule: FileRule): string | null {
  if (rule.id.trim().length === 0) return '规则必须有稳定 id';
  if (rule.patterns.length === 0) return '规则必须至少有一个模式';
  if (rule.rationale.trim().length < 8) return '规则必须写清理由（至少 8 个字），否则下一个人只会删掉它';
  if (rule.kind === 'hard_deny' && rule.patterns.some((p) => p === '*' || p === '**')) {
    return '硬拒绝规则不允许使用通配一切的模式';
  }
  const badExcept = (rule.except ?? []).find((e) => e.includes('*') || e.trim().length === 0);
  if (badExcept !== undefined) {
    return `豁免项必须是不含通配符的确切名字：${JSON.stringify(badExcept)}`;
  }
  return null;
}
