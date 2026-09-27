/**
 * 脱敏诊断（LWB-035 步骤 3 的「脱敏诊断」）。
 *
 * ## 这个文件要回答的是一个**否证性**问题
 *
 * 「诊断里不含本机绝对路径、不含任何凭据」这句话没法靠举例证明 ——
 * 举出的例子只能说明那几处是干净的。因此这里不写「我们记得把 root 去掉了」，
 * 而是让**每一行输出都必须经过同一个函数**：
 *
 * | 层 | 做什么 | 防的是什么 |
 * | --- | --- | --- |
 * | 1. 允许清单 | `DiagnosticWorkspaceRow` 里**根本没有** `root` 这个字段 | 顺手把整行对象塞进去 |
 * | 2. 逐字段擦洗 | 每一段文字都过 `scrub()`，命中即替换并记账 | 路径藏在**别名**里（别名是操作者自己起的） |
 * | 3. 终检 | 对**拼好的全文**再扫一遍 | 将来有人加了一个新字段而忘了过第 2 层 |
 *
 * 第 3 层是这套做法的关键：它不信任前两层。前两层是「做法」，
 * 第 3 层是**对做法的检验**，而检验的对象是最终要复制出去的那串字节 ——
 * 与 `packages/files` 用「实际打开的句柄身份」而不是路径字符串判安全
 * （I05）是同一个道理。
 *
 * ## 命中之后**绝不回显命中的内容**
 *
 * 一份「为了告诉你哪里有问题所以把那个东西抄了一遍」的诊断，本身就是泄漏。
 * 因此 `findings` 里只有**模式的名字**，`redactions` 里只有**字段的名字**。
 * 界面上因此看不到被隐去的原文 —— 这也是为什么它叫脱敏，不叫「高亮」。
 *
 * ## 为什么没有凭据能流进来
 *
 * 入参类型里**没有任何**放凭据的地方：没有 session（CSRF 令牌在里面）、
 * 没有隧道 API key、没有控制台地址（它的 fragment 里带着一次性启动令牌）。
 * 这不是「我们小心」，而是**类型上给不出**。`lwb_boot_` 这个前缀仍然留在
 * 终检里，防的是有人在某天把控制台地址当「有用的信息」加进这一份。
 */

import type { PlatformVerdict } from './platform.ts';
import type {
  ConnectionRow,
  PauseStatusReading,
  Reading,
  StatusReading,
  WorkspaceRow,
} from './readings.ts';
import type { WriteGate } from './capabilities.ts';
import { describeFreshness, freshnessOf } from './readings.ts';

/**
 * 片段到哪里为止。
 *
 * 「片段」的边界取换行、引号、尖括号与中文标点 —— **不停在空格上**，
 * 因为 `D:\My Projects\x` 是真实存在的路径，停在空格只擦掉半条。
 */
const STOP = String.raw`[^\r\n"'<>「」『』，。；：、！？（）《》〈〉—－·]`;

/**
 * 终检与擦洗共用的模式表。
 *
 * `id` 会出现在 `findings` 里，因此**必须是中性的词**，不能带上命中的内容。
 *
 * ## 一条规则吃掉**整个片段**，不只吃掉开头那几个字符
 *
 * 最初的写法是「把命中的那几个字符换掉」，于是 `C:\Users\mj\note.txt`
 * 变成 `<已隐去>Users\mj\note.txt` —— **用户名与路径的其余部分原样留下**，
 * 而终检此刻是**通过**的（它只认「现在没有任何片段命中」）。一份说
 * 「本机绝对路径一律不出现」却印出 `Users\mj\note.txt` 的诊断，比不擦洗
 * 更糟：它看起来是干净的。
 *
 * 这是本模块自己的用例发现的（`tests/unit/console-setup.test.ts` 的 E9）。
 * 因此路径与凭据两类规则都写成整段：从可识别的开头一路吃到边界为止。
 *
 * ## 宁可多擦，不可少擦
 *
 * 允许片段里带空格的代价是一句「登记了 `D:\a` 与 `D:\b`」会被整句吃掉。
 * 这个方向是有意的：少说几句话与漏出一段真实路径，代价不成比例。
 * 诊断的用途是排障 —— 它少一行不会误导谁，它多一行路径会。
 *
 * `hex_secret` 与路径规则不同，它不延展：一串十六进制本身就是整个秘密，
 * 后面接的多半是别的东西。它用了一条后行断言把 `op_…` / `chg_…` / `ws_…`
 * 这类**带前缀的本地标识符**排除在外 —— 它们本身就是 32 位十六进制，
 * 若不加这条，终检会在每一份正常的诊断上失败，而一个永远失败的检查
 * 等于没有检查。裸的 64 位十六进制（密钥指纹、摘要）仍然会被抓到。
 */
const PATTERNS: readonly { readonly id: string; readonly pattern: RegExp }[] = [
  { id: 'windows_absolute_path', pattern: new RegExp(String.raw`[A-Za-z]:[\\/]${STOP}*`) },
  { id: 'unc_or_backslash_path', pattern: new RegExp(String.raw`\\\\${STOP}*`) },
  { id: 'unix_home_path', pattern: new RegExp(String.raw`/(?:Users|home)/${STOP}*`) },
  // 令牌本身是 `lwb_boot_` 后面那串，因此这里延展到非空白为止：只擦前缀
  // 会把令牌留在原地，而它是一次性凭据。
  { id: 'bootstrap_token', pattern: /lwb_boot_\S*/ },
  // 「csrf / api_key / authorization / bearer / secret / password」这类词后面
  // 跟的就是它的**值**。只擦这个词、把值留在原地，等于没擦。
  { id: 'credential_word', pattern: /\b(?:csrf|api[_-]?key|authorization|bearer|secret|password)\b[^\r\n]*/i },
  { id: 'hex_secret', pattern: /(?<![A-Za-z0-9_])[0-9a-f]{32,}\b/i },
];

/** 被隐去之后留下的替代文本。它自己**不得**命中任何模式。 */
const REDACTED = '<已隐去>';

export interface ScrubResult {
  readonly text: string;
  /** 命中的模式名（去重、按模式表顺序）。**不含命中的内容。** */
  readonly hits: readonly string[];
}

/** 第 2 层：把一段文字里所有疑似路径/凭据的片段换成 `<已隐去>`。 */
export function scrub(text: string): ScrubResult {
  let out = text;
  const hits: string[] = [];
  for (const { id, pattern } of PATTERNS) {
    // `g` 每次都要新的一份：带 `g` 的正则是有状态的（`lastIndex`），
    // 复用一个会让「第二次调用」从上次停下的位置开始扫。
    const global = new RegExp(pattern.source, `${pattern.flags.includes('i') ? 'i' : ''}g`);
    if (global.test(out)) {
      hits.push(id);
      out = out.replace(global, REDACTED);
    }
  }
  return { text: out, hits };
}

/** 第 3 层：对拼好的全文做终检。返回命中的模式名（不含内容）。 */
export function scanForLeaks(text: string): readonly string[] {
  const hits: string[] = [];
  for (const { id, pattern } of PATTERNS) {
    if (pattern.test(text)) hits.push(id);
  }
  return hits;
}

/**
 * 诊断里允许出现的工作区字段。
 *
 * **没有 `root`**，也没有 `policy_version` 之外的任何路径派生值。
 * `workspace_id` 与 `alias` 保留：读这份诊断的人要能对上「操作者说的是哪一个」，
 * 而这两个值都不是路径（别名是操作者起的名字，且已经过擦洗）。
 */
export interface DiagnosticWorkspaceRow {
  readonly workspace_id: string;
  readonly alias: string;
  readonly kind: string;
  readonly mode: string;
  readonly enabled: boolean;
  readonly removed: boolean;
  /**
   * 这一行的本机路径**已被移除**。
   *
   * 写成一个恒为 `true` 的字段而不是「什么都不写」：读的人因此知道
   * 「这里本来有一项，是这份诊断选择不带的」，而不是以为这个版本没有这项。
   * 一份静默丢字段的诊断会让人在别处找它。
   */
  readonly local_path_omitted: true;
}

/**
 * 转换的结果：行，以及**在这次转换里被擦洗掉的字段名**。
 *
 * 后者不是装饰。第 2 层（`field()`）只记得住**它自己**擦掉了什么，
 * 而别名在这里就已经被擦过一次，于是它再也看不见那次命中 ——
 * 台账会显示「没有」而事实上消掉了一个路径。一份**谎报自己没擦过东西**
 * 的台账比没有台账更坏：它把「看起来干净」当成了「确实干净」，
 * 而这正是本模块存在的理由。
 */
export interface DiagnosticWorkspaceConversion {
  readonly rows: readonly DiagnosticWorkspaceRow[];
  /** 形如 `workspaces[0].alias`。**只有名字，没有值。** */
  readonly redactions: readonly string[];
}

/** 工作区行 → 诊断行。这是**唯一**允许把 `WorkspaceRow` 转出去的通道。 */
export function toDiagnosticWorkspaces(
  rows: readonly WorkspaceRow[],
): DiagnosticWorkspaceConversion {
  const redactions: string[] = [];
  const out = rows.map((row, index) => {
    const id = scrub(row.workspace_id);
    const alias = scrub(row.alias);
    if (id.hits.length > 0) redactions.push(`workspaces[${String(index)}].id`);
    if (alias.hits.length > 0) redactions.push(`workspaces[${String(index)}].alias`);
    return {
      workspace_id: id.text,
      alias: alias.text,
      kind: row.kind,
      mode: row.mode,
      enabled: row.enabled,
      removed: row.removed,
      local_path_omitted: true as const,
    };
  });
  return { rows: out, redactions };
}

export interface DiagnosticInput {
  /** 生成时刻（由调用方传入，这一层不读时钟）。 */
  readonly now: string;
  readonly status: Reading<StatusReading> | null;
  readonly connections: readonly ConnectionRow[];
  readonly workspaces: readonly WorkspaceRow[];
  readonly pause: Reading<PauseStatusReading> | null;
  readonly platform: PlatformVerdict;
  readonly write_gate: WriteGate;
  /** 最近一次读取失败的原因。停机时这是最有价值的一行。 */
  readonly last_error?: { readonly code: string; readonly message: string } | null;
}

export interface RedactedDiagnostic {
  /** 可以整段复制出去的那份文本。 */
  readonly text: string;
  /** 被擦洗过的字段名（去重）。只有名字，没有值。 */
  readonly redactions: readonly string[];
  /** 终检是否通过。**为假时界面不得提供「复制」**，只能展示。 */
  readonly safe: boolean;
  /** 终检命中的模式名。只有名字，没有内容。 */
  readonly findings: readonly string[];
}

/**
 * 生成脱敏诊断。
 *
 * 输出的形状是**行式文本**而不是 JSON，理由有两条：给人读的（工单、聊天窗口），
 * 以及 JSON 会把反斜杠转义成 `\\`，而 `\\` 恰好是终检要抓的形状之一 ——
 * 用 JSON 就得让终检去理解转义，那等于给检查本身开了一个口子。
 */
export function redactedDiagnostic(input: DiagnosticInput): RedactedDiagnostic {
  const redactions = new Set<string>();
  const lines: string[] = [];

  /** 所有落进输出的文字都必须走这里。 */
  const field = (name: string, value: string): void => {
    const result = scrub(value);
    if (result.hits.length > 0) {
      redactions.add(name);
      for (const hit of result.hits) redactions.add(`${name}#${hit}`);
    }
    lines.push(`${name}: ${result.text}`);
  };

  const status = input.status;
  // 新鲜度**只用读数层的那一个判定**：在这里另写一遍「多少秒算过期」，
  // 会让诊断与界面各说一套 —— 而诊断恰恰是拿去对质的那一份。
  const freshness = describeFreshness(freshnessOf(status, input.now));

  lines.push('# Local Workspace Bridge 诊断（已脱敏）');
  lines.push('# 本机绝对路径一律不出现；凡是被隐去的地方都会记在末尾的「已隐去」一节。');
  field('generated_at', input.now);
  field('status_reading_at', status?.observed_at ?? '（没有读数）');
  field('status_reading_freshness', freshness);
  field('daemon_version', status?.value.version ?? '未知');
  field('protocol_version', status?.value.protocol_version ?? '未知');
  field('machine', input.platform.machine === null
    ? '未知'
    : `${input.platform.machine.hostname} · ${input.platform.machine.os} · ${input.platform.machine.arch}`);
  field('platform_callable', input.platform.callable ? 'true' : 'false');

  for (const leg of input.platform.legs) {
    field(`leg.${leg.id}`, `${leg.state}（${leg.state_label}）`);
  }

  const gates = status?.value.gates ?? null;
  field('gate.g0_platform_verified', gates === null ? '无读数' : String(gates.g0_platform_verified));
  field('gate.compatibility_section3_passed', gates === null ? '无读数' : String(gates.compatibility_section3_passed));
  field('gate.native_guard_verified', gates === null ? '无读数' : String(gates.native_guard_verified));
  field('gate.g4_concurrency_fault_passed', gates === null ? '无读数' : String(gates.g4_concurrency_fault_passed));

  const flags = status?.value.capability_flags ?? null;
  field('flag.read_enabled', flags === null ? '无读数' : String(flags.read_enabled));
  field('flag.git_enabled', flags === null ? '无读数' : String(flags.git_enabled));
  field('flag.proposal_enabled', flags === null ? '无读数' : String(flags.proposal_enabled));
  field('flag.direct_write_enabled', flags === null ? '无读数' : String(flags.direct_write_enabled));
  field('flag.recovery_required', flags === null ? '无读数' : String(flags.recovery_required));

  field('write_gate.direct_write', input.write_gate.direct_write ? 'true' : 'false');
  field('write_gate.reasons', input.write_gate.reasons.length === 0
    ? '（无）'
    : input.write_gate.reasons.join(' '));

  lines.push('workspaces.registered: ' + String(input.workspaces.filter((row) => !row.removed).length));
  const conversion = toDiagnosticWorkspaces(input.workspaces);
  // 先记下第 1 层擦掉的那些：第 2 层看不见它们（值已经擦过了）。
  for (const name of conversion.redactions) redactions.add(name);
  for (const [index, row] of conversion.rows.entries()) {
    // 逐字段过一遍 `field`：别名与 id 都在 `toDiagnosticWorkspaces` 里擦过一次，
    // 这里再过一次是**冗余**的，但冗余的这一层才让「新加一个字段」不至于漏掉 ——
    // 而它顺手把命中记进「已隐去」台账。
    field(`workspaces[${String(index)}].id`, row.workspace_id);
    field(`workspaces[${String(index)}].alias`, row.alias);
    field(`workspaces[${String(index)}].kind`, row.kind);
    field(`workspaces[${String(index)}].mode`, row.mode);
    field(`workspaces[${String(index)}].enabled`, String(row.enabled));
    field(`workspaces[${String(index)}].removed`, String(row.removed));
    if (row.local_path_omitted) field(`workspaces[${String(index)}].local_path`, '（本机路径：这份诊断不带）');
  }

  for (const [index, row] of input.connections.entries()) {
    field(`connections[${String(index)}].id`, row.connection_id);
    field(`connections[${String(index)}].alias`, row.alias);
    field(`connections[${String(index)}].principal_kind`, row.principal_kind);
    field(`connections[${String(index)}].enabled`, String(row.enabled));
  }

  const pause = input.pause;
  if (pause === null) {
    field('pause', '没有读数');
  } else {
    field('pause.reading_at', pause.observed_at);
    field('pause.paused', String(pause.value.paused));
    field('pause.paused_at', pause.value.paused_at ?? '（未暂停或未给出）');
    field('pause.stopping', String(pause.value.stopping.length));
    field('pause.unrevoked_change_sets', String(pause.value.unrevoked_change_sets.length));
    field('pause.recovery_operations', String(pause.value.recovery_operations.length));
    field('pause.unrecallable_file_rows', String(pause.value.unrecallable_file_rows));
  }

  if (input.last_error != null) {
    field('last_error.code', input.last_error.code);
    field('last_error.message', input.last_error.message);
  }

  const sortedRedactions = [...redactions].sort();
  // 台账写在**末尾**，且只写名字：读的人知道哪几处被隐去了，
  // 而他手上这份文本不因此多出任何一个字符的原文。
  //
  // 台账**总是**出现（没有命中时写「（没有）」）：一份时有时无的小节
  // 会让人在它缺席时以为「这一版没有这个功能」，而不是「这一次没擦过东西」。
  const ledger = ['', '## 已隐去', sortedRedactions.length === 0 ? '（没有）' : sortedRedactions.join('、')];

  // 终检的对象是**将被复制出去的那串字节**，台账因此在扫描**之前**就拼进去。
  // 反过来的话，终检只看正文，而复制按钮给出的是正文+台账 ——
  // 检查的对象与交付的对象不是同一个东西，那检查就不算数。
  const body = `${lines.join('\n')}\n${ledger.join('\n')}\n`;
  const findings = scanForLeaks(body);

  const text =
    findings.length === 0
      ? body
      : `${body}\n终检：**未通过**（命中 ${findings.join('、')}）—— 这份文本不应被复制出去。\n`;

  return { text, redactions: sortedRedactions, safe: findings.length === 0, findings };
}
