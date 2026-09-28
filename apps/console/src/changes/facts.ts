/**
 * 「系统算出来的事实」与「模型写的话」的分区（LWB-023 验收标准 1）。
 *
 * ## 这一条要防的是什么
 *
 * 验收标准 1 的原文是「模型摘要写『无害』但实际大量删改时，界面仍显示
 * 全部事实和风险」。方案 §10.2 给了同一件事的设计口径：
 *
 * > 模型撰写的「安全说明」与系统计算的风险事实**分区展示**。
 *
 * 也就是说这不是「界面要诚实」这种态度问题，而是一条**结构**要求：
 * 模型写的那段话与系统算出来的那批数字必须落在两个不同的容器里，
 * 且系统那一侧的每一个字段都**只**从落库事实推导。
 *
 * 「无害」这两个字本身是拦不住的 —— 它可以写成「安全」「低风险」
 * 「仅格式调整」「no functional change」，也可以写成任何语言。任何
 * 「从摘要里读出它在说无害」的做法都是在做一次**猜测**，而猜测的
 * 失败方向恰恰是最坏的那个：它把「这次没看出问题」显示成「这次没问题」。
 *
 * 所以本模块不判读摘要，而是让摘要**没有机会**影响事实区：
 * 事实区的输入是 `ChangeSetView` 里的 `files` 与 `risks`，
 * 而 `summary` 从头到尾**不参与**任何一次计算。下面 `ChangeFacts`
 * 的每一个字段都能指到 `view.files` 或 `view.risks` 里的某一处，
 * 没有一个是「读摘要得出的」。
 *
 * 这条不是靠约定，它有形状：`describeChange` 返回两个**平级的**字段
 * （`facts` 与 `model_prose`），渲染方要显示摘要就必须显式写
 * `model_prose.summary` —— 一个把两者拼在同一个字符串里的实现，
 * 会先在这行代码上看起来很别扭。
 */

import type { ChangeFilePreview, ChangeRisk, ChangeSetView } from '@lwb/contracts';

/** 系统计算的修改量。全部来自 `files`，没有一项来自摘要。 */
export interface ChangeTotals {
  readonly file_count: number;
  readonly added_lines: number;
  readonly removed_lines: number;
  /** 净行数变化，可为负。正数是净增。 */
  readonly net_lines: number;
  readonly created_files: number;
  readonly deleted_files: number;
  readonly replaced_files: number;
  readonly edited_files: number;
  /** 修改前/后的总字节。新建文件的修改前字节记为 0（与契约一致）。 */
  readonly before_bytes: number;
  readonly after_bytes: number;
}

export interface RiskBreakdown {
  readonly total: number;
  readonly warnings: number;
  readonly notices: number;
  readonly infos: number;
  /**
   * 是否**存在** warning 级风险。
   *
   * 它单独列出来，是因为界面要用它决定「是否显示一条压过一切的通栏提示」，
   * 而这件事不该由渲染方自己 `risks.some(r => r.level === 'warning')` ——
   * 那样每一处渲染都要重写一次「什么算严重」，几处写法迟早不一致，
   * 而不一致的方向是某处忘记升级提示。
   */
  readonly has_warning: boolean;
}

/**
 * 一条**只由落库事实推导**的修改集描述。
 *
 * 注意这里没有 `summary`、没有 `next_action`、没有 `risks[].message`
 * 之外的任何模型产出的文本（`risks` 由 `@lwb/changes` 的 `deriveRisks`
 * 从路径与统计量算出，模型碰不到它）。
 */
export interface ChangeFacts {
  readonly change_id: string;
  readonly workspace_id: string;
  readonly state: string;
  readonly digest: string;
  readonly short_code: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly totals: ChangeTotals;
  readonly risks: readonly ChangeRisk[];
  readonly risk_breakdown: RiskBreakdown;
  /** 逐文件的事实（路径、操作、哈希、增量行数）。渲染方直接展开这一列。 */
  readonly files: readonly ChangeFilePreview[];
}

/** 模型撰写的文本。**不受信**，且与事实分区展示。 */
export interface ModelProse {
  readonly summary: string;
  /** 界面上的标签，写死在这里以免各处措辞不一。 */
  readonly label: string;
  readonly untrusted_notice: string;
}

export interface ChangeDescription {
  readonly facts: ChangeFacts;
  readonly model_prose: ModelProse;
}

/**
 * 分区的标签与说明。
 *
 * 它们是**固定文案**，与 `@lwb/changes` 的 `NEXT_ACTION_PENDING_APPROVAL`
 * 同一个理由：描述「这段文本不参与判定」这件事，不能由被描述的那一方
 * 来措辞。模型可以写任何它想写的摘要，但不能改写这块标签。
 */
const PROSE_LABEL = '模型撰写（不受信）';
const PROSE_NOTICE =
  '以下文字由模型生成，**不是**系统判定依据，也不参与批准绑定。' +
  '系统事实与风险见上方分区。';

function totalsOf(files: readonly ChangeFilePreview[]): ChangeTotals {
  let added = 0;
  let removed = 0;
  let created = 0;
  let deleted = 0;
  let replaced = 0;
  let edited = 0;
  let beforeBytes = 0;
  let afterBytes = 0;

  for (const file of files) {
    added += file.added_lines;
    removed += file.removed_lines;
    beforeBytes += file.before_size;
    afterBytes += file.after_size;
    if (file.op === 'create_text') created += 1;
    else if (file.op === 'delete_file') deleted += 1;
    else if (file.op === 'replace_text') replaced += 1;
    else edited += 1;
  }

  return Object.freeze({
    file_count: files.length,
    added_lines: added,
    removed_lines: removed,
    net_lines: added - removed,
    created_files: created,
    deleted_files: deleted,
    replaced_files: replaced,
    edited_files: edited,
    before_bytes: beforeBytes,
    after_bytes: afterBytes,
  });
}

export function breakdownOf(risks: readonly ChangeRisk[]): RiskBreakdown {
  let warnings = 0;
  let notices = 0;
  let infos = 0;
  for (const risk of risks) {
    if (risk.level === 'warning') warnings += 1;
    else if (risk.level === 'notice') notices += 1;
    else infos += 1;
  }
  return Object.freeze({
    total: risks.length,
    warnings,
    notices,
    infos,
    has_warning: warnings > 0,
  });
}

/**
 * 修改集视图 → 「事实 + 模型的话」两个分区。
 *
 * **`view.summary` 只被搬进 `model_prose`，不参与 `facts` 的任何一次计算。**
 * 这句话是本模块存在的全部理由，因此写在函数的正上方而不是文件头：
 * 改动这个函数的人会先看到它。
 */
export function describeChange(view: ChangeSetView): ChangeDescription {
  const totals = totalsOf(view.files);
  const risks = Object.freeze([...view.risks]);

  const facts: ChangeFacts = Object.freeze({
    change_id: view.change_id,
    workspace_id: view.workspace_id,
    state: view.state,
    digest: view.digest,
    short_code: view.short_code,
    created_at: view.created_at,
    expires_at: view.expires_at,
    totals,
    risks,
    risk_breakdown: breakdownOf(risks),
    files: Object.freeze([...view.files]),
  });

  const model_prose: ModelProse = Object.freeze({
    summary: view.summary,
    label: PROSE_LABEL,
    untrusted_notice: PROSE_NOTICE,
  });

  return Object.freeze({ facts, model_prose });
}

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

/**
 * 行数增量的可读形式，例如 `+3 −1`。
 *
 * 用 U+2212（数学减号）而不是 ASCII 连字符：在 `+3 -1` 里那个 `-`
 * 与连字符、与 diff 里的删除标记都长得一样，而这个数字旁边通常**就**是
 * 差异正文。两种含义共用一个字形，是在给自己造阅读事故。
 */
export function formatLineDelta(added: number, removed: number): string {
  const plus = `+${added}`;
  return removed === 0 ? `${plus} −0` : `${plus} −${removed}`;
}

/** 字节数。只到 KiB/MiB 一位小数，够用来判断量级。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export interface ExpiryCountdown {
  readonly expires_at: string;
  readonly remaining_ms: number;
  readonly expired: boolean;
  readonly text: string;
}

/**
 * 批准有效期的倒计时。
 *
 * `now` 由调用方传入而不是在这里读时钟 —— 与 `@lwb/search` 同一条约定
 * （偏离项 37）：读了时钟的函数就没法被确定性地测，而「还剩 8 分 12 秒」
 * 这种话一旦不可测，就只能在肉眼里验证。
 *
 * 用**绝对时刻** `Date.parse` 两边相减，而不是累计的定时器：控制台页面
 * 闲置或休眠之后，定时器累计出来的剩余时间会偏，而批准到底还有没有效
 * 是由服务端按**自己的**时钟判定的（`effectiveApprovalState`）——
 * 界面上这个数字因此只是提示，真正的裁定在那边。
 */
export function expiryOf(expiresAt: string, now: string): ExpiryCountdown {
  const end = Date.parse(expiresAt);
  const at = Date.parse(now);
  if (Number.isNaN(end) || Number.isNaN(at)) {
    // 解析不出来就说解析不出来，不折成「已过期」也不折成「无限期」：
    // 前者会让人以为批准坏了，后者会让人以为可以一直等。
    return Object.freeze({
      expires_at: expiresAt,
      remaining_ms: 0,
      expired: false,
      text: '有效期无法解析',
    });
  }
  const remaining = end - at;
  if (remaining <= 0) {
    return Object.freeze({ expires_at: expiresAt, remaining_ms: remaining, expired: true, text: '已过期' });
  }
  const totalSeconds = Math.floor(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return Object.freeze({
    expires_at: expiresAt,
    remaining_ms: remaining,
    expired: false,
    text: `剩余 ${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`,
  });
}
