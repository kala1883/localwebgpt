/**
 * 复核覆盖：**批准之前，修改集里的每一个文件都必须被完整展示过**
 * （LWB-036 验收标准 1）。
 *
 * ## 这条验收标准在防什么
 *
 * > 批准内容与摘要一一对应，不会批准未展示的隐含文件。
 *
 * 批准绑定的是**整份修改集的摘要** —— 那个摘要覆盖了 `items` 里的全部字节，
 * 而界面上显示出来的只是其中一部分。两者之间的差就是那个漏洞的形状：
 * 操作者看过 `src/app.ts` 的差异，按下「批准并应用」，而摘要里还绑着
 * 一个他从没见过的 `.git/hooks/pre-commit`。写入会照常执行，因为服务端
 * 从来不知道他看过什么 —— 它只知道有人在摘要上签了字。
 *
 * 因此本模块不判读内容，只回答一个问题：**这一份修改集里，还有没有
 * 操作者没看过的东西。** 答案是「有」的时候，批准入口不给出来。
 *
 * ## 把话说清楚：这是**界面层**的控制，不是安全边界
 *
 * 服务端**无法**知道操作者看过什么。一次被绕开界面的请求（手写
 * `POST /api/approvals/approve_and_apply`，带着合法的会话、CSRF 与
 * 一次性 nonce）会照常被接受并排队 —— 它没有任何「已复核」字段，
 * 因为那种字段正是 ADR-003 §4 点名的反模式：**调用方能填的东西
 * 不能作为授权证据**。一个盖上「操作者已看」印章的请求，与一个
 * 参数里写着 `approved: true` 的请求，是同一件东西。
 *
 * 所以本模块提供的是：**正常使用这个界面时，不可能批准没看过的东西。**
 * 它防的是「忘记看」与「以为看全了」，不防「有人绕开界面」。
 * 后者由别的机制回答（摘要与内容精确绑定、一次性批准、
 * 执行前重算摘要），而那些机制本来就与「看过没有」无关。
 * 这条边界与 LWB-035 的「界面的判定不是安全边界」是同一类诚实：
 * 不要把一个流程约束说成一个安全保证。
 *
 * ## 什么叫「完整看过」——三个来源，任一成立即可
 *
 * | 来源 | 判据 | 它对应界面上的什么 |
 * | --- | --- | --- |
 * | 差异读到末尾 | 服务端不再说 `truncated` | 逐页翻到「已到末页」 |
 * | 原文 + 新文都在 | 两侧都完整取回 | 「原文 / 新文」对照查看 |
 * | —— | —— | —— |
 *
 * 两个来源是**或**的关系，因为它们是同一件事的两种看法；而两者之外
 * 没有第三个来源：一段被截断的差异**不算**看过（那正是「折叠策略掩盖
 * 大范围删除」能钻进来的缝，见下面 `TRUNCATED` 那一段）。
 *
 * ## 「全都看过」与「没有东西可看」不是一回事
 *
 * `files.length === 0` 时，上面的规则会**平凡地**成立（一个都没漏），
 * 于是空修改集拿到批准入口。那是错的：没有东西可看不等于看全了。
 * 因此 `complete` 额外要求 `total_count > 0`。这一条不是防御性编程
 * ——「为每个文件都取了差异」与「这份修改集里有文件」是两个不同的事实，
 * 把它们合并成一个布尔值，就是在让第二个事实由第一个事实**默认**推出。
 */

import type { ChangeOp, ChangeSetView } from '@lwb/contracts';

/**
 * 一个文件没有被完整看过的原因。
 *
 * 三个值分别对应一句不同的下一步。用具名的枚举而不是一句话：
 * 渲染方要按原因决定给哪个入口（`TRUNCATED` 给「继续翻页」，
 * `NOT_DISPLAYED` 给「打开这个文件」，`GATE_DENIED` 两个都不给 ——
 * 那种情况下按什么按钮都没用）。
 */
export type FileUncoveredReason =
  /** 这一份文件的差异从未被取回（清单上有，但没打开过）。 */
  | 'NOT_DISPLAYED'
  /** 取回过，但服务端说后面还有内容（分页截断）。 */
  | 'TRUNCATED'
  /** 服务端拒绝交出任何内容（工作区暂停 / 待恢复 / 读取能力关闭）。 */
  | 'GATE_DENIED';

export interface FileCoverageEntry {
  readonly path: string;
  readonly op: ChangeOp;
  /** 已经取回的差异页数。`0` 表示从未取过。 */
  readonly pages: number;
  readonly covered: boolean;
  /** `covered` 为真时是 `null`。 */
  readonly reason: FileUncoveredReason | null;
}

/** 整份修改集的复核状态。三个值分别有各自的一句人话。 */
export type ReviewStatus =
  /** 每一个文件都被完整看到过，且确实有文件。 */
  | 'complete'
  /** 有文件没看全。`unseen` / `truncated` 说明差在哪。 */
  | 'incomplete'
  /** 服务端不给内容：**看不到，因此批不了**。 */
  | 'unavailable';

export interface ReviewCoverage {
  readonly status: ReviewStatus;
  readonly files: readonly FileCoverageEntry[];
  readonly covered_count: number;
  readonly total_count: number;
  /**
   * 从未取回差异的路径，按修改集清单里的顺序。
   *
   * 它同时是 `approvalAffordance` 用来在 `UNSEEN_FILES` 与
   * `TRUNCATED_DIFF` 之间二选一的那个字段，因此 `status` 为
   * `unavailable` 时它是空的：「取不到」不是这两类中的任何一类。
   */
  readonly unseen: readonly string[];
  /** 差异没读到末尾的路径，按修改集清单里的顺序。同上，`unavailable` 时为空。 */
  readonly truncated: readonly string[];
  /** 内容闸门拒绝时的稳定原因 slug（服务端 `content_gate.reason`）。 */
  readonly gate_reason: string | null;
  /** 给操作者看的一句话。永远非空。 */
  readonly message: string;
}

/**
 * 界面在**一份文件上**取回差异的进度。
 *
 * 由视图在每次 `changes.get` 返回后记录，`pages` 是**累计**值而不是
 * 「这一页的序号」：本模块判的是「读完了没有」，而一个只记着最后一页
 * 序号的实现，在跳页之后会把「从第 3 页开始看」读成「看过 3 页」。
 */
export interface DiffProgress {
  readonly path: string;
  /** 已取回的页数（从第一页起连续）。`0` 表示还没取过。 */
  readonly pages: number;
  /** 服务端不再说 `truncated`：这一份差异已经读到末尾。 */
  readonly reached_end: boolean;
  /**
   * 原文与新文**双双**完整取回。
   *
   * 与 `reached_end` 是或的关系：两者都能让一个文件算作「看过」。
   * 它出现在类型里是因为**控制台有两种展示方式**（差异视图与原文/新文
   * 对照），而判据必须认得这两种；只认一种会让另一种展示下的批准
   * 永远被拒，而操作者看到的信息是「这个文件没看过」—— 一句假话。
   */
  readonly full_texts: boolean;
}

/**
 * 服务端 `changes.get` 的 `content_gate` 那一格。
 *
 * 与 `apps/daemon/src/control/changes.ts` 的 `ContentGateView` 是同一个形状，
 * 但**不复用那个类型**：这里是控制台的本地声明，两边各自演化是安全的
 * —— 服务端多一个字段不会让控制台的解析出错（本模块只读这三个）。
 */
export interface ContentGate {
  readonly allows_read: boolean;
  readonly reason: string | null;
  readonly message: string | null;
}

export interface ReviewCoverageInput {
  readonly change: ChangeSetView | null;
  readonly progress: readonly DiffProgress[];
  /** 还没问过服务端时为 `null`（那既不是允许也不是拒绝）。 */
  readonly gate: ContentGate | null;
}

/** 消息里最多列几个路径。多出来的折成「等 N 个」。 */
const MAX_LISTED_PATHS = 5;

function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).join('、');
  return paths.length > MAX_LISTED_PATHS ? `${shown} 等 ${paths.length} 个` : shown;
}

function entryOf(
  path: string,
  op: ChangeOp,
  progress: DiffProgress | undefined,
  gateDenied: boolean,
): FileCoverageEntry {
  const pages = progress?.pages ?? 0;
  const covered = !gateDenied && (progress?.full_texts === true || (pages >= 1 && progress?.reached_end === true));
  const reason: FileUncoveredReason | null = covered
    ? null
    : gateDenied
      ? 'GATE_DENIED'
      : pages === 0
        ? 'NOT_DISPLAYED'
        : 'TRUNCATED';
  return Object.freeze({ path, op, pages, covered, reason });
}

/**
 * 修改集 + 界面进度 → 复核覆盖。
 *
 * 判定顺序：**闸门 → 有没有修改集 → 逐文件**。闸门排在最前是因为它
 * 改变的是其余每一格的答案：服务端不给内容时，一个「已取回 3 页」的
 * 进度记录描述的是**上一次**还看得到的时候，而不是现在。按覆盖算
 * 会让界面显示「看全了，可以批准」—— 而此刻操作者连内容都打不开。
 */
export function reviewCoverageOf(input: ReviewCoverageInput): ReviewCoverage {
  const change = input.change;
  const gateDenied = input.gate !== null && input.gate.allows_read === false;

  if (gateDenied) {
    const gate = input.gate as ContentGate;
    const reason = gate.reason ?? 'UNKNOWN';
    const detail = gate.message ?? '本地策略拒绝读取该修改集的内容。';
    const files: readonly FileCoverageEntry[] = (change?.files ?? []).map((file) =>
      entryOf(file.path, file.op, undefined, true),
    );
    return Object.freeze({
      status: 'unavailable' as const,
      files,
      covered_count: 0,
      total_count: files.length,
      // `unseen` 与 `truncated` 在这里**都是空的**，尽管每个文件的
      // `reason` 都是 `GATE_DENIED`。两个字段装的是「差在哪一类」，而
      // 「取不到」不是这两类中的任何一类：把它们塞进 `unseen`（本模块
      // 第一版就是这么写的）会让渲染方得到一句**假话**——
      // 「还有 2 个文件的差异从未取回」在服务端拒绝交内容时，
      // 是在让操作者去翻一个翻不出东西的地方。
      //
      // 这一点还有个更硬的理由：`approvalAffordance` 用
      // `unseen.length > 0` 来区分 `UNSEEN_FILES` 与 `TRUNCATED_DIFF`。
      // 那个字段的**用途**就是那个二选一；往里面塞第三类路径，
      // 会让它不再表示它被用来表示的东西 —— 今天那个分支走不到，
      // 明天多一个调用方就未必。
      //
      // 要列出「哪些文件取不到」的调用方读 `files`（每条都带
      // `reason: 'GATE_DENIED'`），那个字段的语义没有被借用。
      unseen: Object.freeze([]),
      truncated: Object.freeze([]),
      gate_reason: reason,
      // 这一句要说清「不是你没看，是现在看不了」——操作者对着一个
      // 空白的差异看了半天再被告知「还有文件没看过」，会去翻文件清单，
      // 而那里什么都不会变。
      message: `服务端拒绝交出内容（${reason}）：${detail}。看不到内容的修改集不能批准。`,
    });
  }

  if (change === null) {
    return Object.freeze({
      status: 'incomplete' as const,
      files: Object.freeze([]),
      covered_count: 0,
      total_count: 0,
      unseen: Object.freeze([]),
      truncated: Object.freeze([]),
      gate_reason: null,
      message: '还没有加载修改集。',
    });
  }

  const byPath = new Map<string, DiffProgress>();
  for (const item of input.progress) byPath.set(item.path, item);

  const files: readonly FileCoverageEntry[] = change.files.map((file) =>
    entryOf(file.path, file.op, byPath.get(file.path), false),
  );
  const unseen = files.filter((file) => file.reason === 'NOT_DISPLAYED').map((file) => file.path);
  const truncated = files.filter((file) => file.reason === 'TRUNCATED').map((file) => file.path);
  const coveredCount = files.filter((file) => file.covered).length;

  // 「全都看过」还要求**确实有文件**。见文件头最后一段。
  const complete = files.length > 0 && coveredCount === files.length;

  const parts: string[] = [];
  if (unseen.length > 0) {
    parts.push(`还有 ${unseen.length} 个文件的差异从未取回：${listPaths(unseen)}。`);
  }
  if (truncated.length > 0) {
    parts.push(`还有 ${truncated.length} 个文件的差异没读到末尾：${listPaths(truncated)}。`);
  }

  const message = complete
    ? `已完整看过全部 ${files.length} 个文件的差异。`
    : files.length === 0
      ? '这份修改集里没有任何文件，没有可批准的内容。'
      : `${parts.join('')}批准绑定的是整份修改集，没看过的文件同样会被写入。`;

  return Object.freeze({
    status: complete ? ('complete' as const) : ('incomplete' as const),
    files,
    covered_count: coveredCount,
    total_count: files.length,
    unseen: Object.freeze(unseen),
    truncated: Object.freeze(truncated),
    gate_reason: null,
    message,
  });
}

/**
 * 一份差异页 → 更新后的逐文件进度。
 *
 * ## 为什么由本模块算，而不是让视图自己累加
 *
 * 「页数」与「读到末尾了没有」是两个必须一起更新的量：分开写就会有人
 * 只更新其中一个，而两种写错的后果都是**方向危险的那个** ——
 * 页数加了但忘了标记末页（多翻一页就能批准，看起来只是麻烦），
 * 或者标记了末页但页数没加（一个 `pages: 0, reached_end: true` 的
 * 记录会被 `entryOf` 判成 `NOT_DISPLAYED`，反倒安全）。
 * 一处算完就不会有第二种写法。
 *
 * `truncated: false` 的那一次**同时**意味着「这一页就是末尾」：
 * 服务端说没有更多了，于是不需要另外一次调用去问。
 */
export function recordPage(
  progress: readonly DiffProgress[],
  page: { readonly path: string; readonly truncated: boolean; readonly full_texts?: boolean },
): readonly DiffProgress[] {
  const out = new Map<string, DiffProgress>();
  for (const item of progress) out.set(item.path, item);
  const previous = out.get(page.path);
  out.set(page.path, {
    path: page.path,
    pages: (previous?.pages ?? 0) + 1,
    reached_end: page.truncated === false,
    full_texts: page.full_texts ?? previous?.full_texts ?? false,
  });
  return Object.freeze([...out.values()]);
}

/**
 * 原文与新文双双到手时的进度。
 *
 * 与 `recordPage` 分开写，因为两者更新的是**不同的来源**：一个是
 * 差异页，一个是整文件对照。合成一个「更新函数」会需要一串布尔参数，
 * 而那串参数读起来正好等于「调用方得自己想清楚这次更新的是哪一个」——
 * 那不如让两个函数各自把名字说清楚。
 */
export function recordFullTexts(
  progress: readonly DiffProgress[],
  path: string,
): readonly DiffProgress[] {
  const out = new Map<string, DiffProgress>();
  for (const item of progress) out.set(item.path, item);
  const previous = out.get(path);
  out.set(path, {
    path,
    pages: previous?.pages ?? 0,
    reached_end: previous?.reached_end ?? false,
    full_texts: true,
  });
  return Object.freeze([...out.values()]);
}
