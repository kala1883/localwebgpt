/**
 * 「这次调用返回了哪些文件、哪些范围」（LWB-018 第一条验收标准）。
 *
 * ## 为什么是逐工具的显式开关，而不是一个通用的字段遍历器
 *
 * 通用遍历器（「找结果里所有叫 `path` 的字段」）看起来更省事，而且将来
 * 新增工具时**不需要改任何代码**。那正是它的问题：新增一个工具时，
 * 没有人会被要求回答「这个工具返回的东西算不算文件访问」——
 * 它默认算，或者默认不算，而两种默认都是没人做过的决定。
 *
 * 显式表把那个决定变成一次编译错误：`Record<ImplementedToolName, …>`
 * 少一个键，`tsc` 就失败，报错里带着缺少的那个工具名。
 *
 * ## 「返回了什么」与「读取了什么」的边界（不夸大这张表）
 *
 * 这里记的是**响应里带了什么**，不是「进程碰过什么」。
 * 具体差别：
 *
 *  - `text_search` 扫过的文件远多于命中的文件，这里只记**命中的**；
 *  - 被策略拒绝、被秘密筛查拦下的文件如果出现在结果里（例如 `git_status`
 *    的 `excluded`），会被记下来，因为**路径确实出站了**；
 *  - `command_exec` 只记授权工作区根（初始 cwd）；shell 可能触碰其它路径，
 *    本表不声称知道命令进程实际读写过的完整文件集合；
 *  - daemon 内部读过又没送出去的字节，这张表不声称知道。
 *
 * 最后一条尤其重要：一张自称「本进程碰过的全部文件」的表会在**每一次**
 * 内部重构后变成谎言，而调查者会照着它下结论。宁可它回答得少一点，
 * 但每一行都成立。
 *
 * ## 返回的字段必须存在，缺了就抛
 *
 * 每个提取器读的都是刚被 `TOOL_OUTPUT_SCHEMAS` 描述过的形状，因此
 * 「字段不在」只可能是契约与实现脱节。此时**抛出**（由调用方折成
 * `INTERNAL_ERROR`）而不是返回空数组：空数组在这里的含义是
 * 「这次调用没有碰任何文件」—— 一个与「我不知道」完全不同的断言，
 * 而它会被写进审计并长期留存。
 */

import type { ImplementedToolName } from '@lwb/contracts';
import { validateRelativePath } from '@lwb/contracts';
import type { AuditFileAccessInput } from '@lwb/persistence';

/** 审计里的一行文件访问。`path` 是工作区内相对路径（根为单文件时是空串）。 */
export interface FileAccessRow extends AuditFileAccessInput {
  readonly path: string;
}

// ---------------------------------------------------------------------------
// 取值助手：形状不对就抛
// ---------------------------------------------------------------------------

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`审计提取：${what} 不是对象。`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`审计提取：${what} 不是数组。`);
  return value;
}

function asRelativePath(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new TypeError(`审计提取：${what} 不是字符串。`);
  // 空串是合法的：单文件工作区的根相对路径按定义就是空串。
  if (value === '') return '';
  const checked = validateRelativePath(value);
  if (!checked.ok) {
    // 走到这里说明某个结果的 `path` 不是工作区内相对路径 —— 那不只是
    // 「记不下来」，而是「一个不该出现在结果里的形状出现在了结果里」。
    throw new TypeError(`审计提取：${what} 不是合法的相对路径（${checked.reason}）。`);
  }
  return checked.normalized;
}

/**
 * 行号必须是 1 起算的整数。**缺失也算形状不符**。
 *
 * `null` 与「键不在」在这里都不接受：两个来源（`file_read.start_line`、
 * `text_search.matches[].line_number`）在各自的输出 schema 里都是**必填的
 * 正整数**，因此缺字段只可能是契约与实现脱节 —— 而那时返回一个
 * 「没有行区间」的行，会把一次**形状漂移**记成一次「整文件访问」。
 * 那两条记录在审计里长得一模一样。
 */
function asLine(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`审计提取：${what} 不是 1 起算的整数行号。`);
  }
  return value;
}

/** 无行区间的访问行（目录、状态条目、差异整文件）。 */
function fileRow(path: string): FileAccessRow {
  return { path, start_line: null, end_line: null, delivered: true };
}

// ---------------------------------------------------------------------------
// 逐工具提取
// ---------------------------------------------------------------------------

export type FileAccessExtractor = (data: unknown) => readonly FileAccessRow[];

const NO_FILES: FileAccessExtractor = () => [];

export const FILE_ACCESS_EXTRACTORS = {
  // 两者回的都是**本机与连接**的状态：没有工作区内的文件被返回。
  // `workspace_list` 里的 `single_file_path` 是一个路径字段，但它不返回
  // 任何文件内容，也不是任何被拒绝调用的目标 —— 按 `delivered` 的定义
  // （见迁移 v3）它不属于这张表，把它记进来会稀释「读到了什么」这个答案。
  bridge_status: NO_FILES,
  workspace_list: NO_FILES,

  file_list: (data) => {
    const record = asRecord(data, 'file_list 结果');
    const rows: FileAccessRow[] = [fileRow(asRelativePath(record['path'], 'file_list.path'))];
    // 逐条目也记：列出一个目录等于把最多 200 个**名字**交给模型，
    // 而「哪些名字出去了」正是这条审计要回答的问题。只记目录本身的话，
    // 回答退化成「某个目录被列举了」，而它没有说清泄漏了什么。
    //
    // 上界由 `MAX_DIRECTORY_ENTRIES` 保证：它约束的是同一个响应里的条目数，
    // 因此这里不会出现「一次调用写进几千行」。
    for (const entry of asArray(record['entries'], 'file_list.entries')) {
      const item = asRecord(entry, 'file_list.entries[]');
      rows.push(fileRow(asRelativePath(item['path'], 'file_list.entries[].path')));
    }
    return rows;
  },

  file_read: (data) => {
    const record = asRecord(data, 'file_read 结果');
    const path = asRelativePath(record['path'], 'file_read.path');
    const start = asLine(record['start_line'], 'file_read.start_line');
    const endExclusive = asLine(record['end_line_exclusive'], 'file_read.end_line_exclusive');
    // `end_line_exclusive` 是**开区间**，而审计里的区间按闭区间记 ——
    // 读者问的是「看到了哪几行」，不是「切到第几行之前」。
    //
    // 空区间（空文件、或游标落在文件末尾）记成**整行都不给**，而不是
    // 「从第 1 行开始、没有结束」：后者读起来像「读了第 1 行」，
    // 而那时并没有任何一行被返回。区间两侧要么都成立，要么都不记。
    return endExclusive > start
      ? [{ path, start_line: start, end_line: endExclusive - 1, delivered: true }]
      : [{ path, start_line: null, end_line: null, delivered: true }];
  },

  text_search: (data) => {
    const record = asRecord(data, 'text_search 结果');
    const seen = new Set<string>();
    const rows: FileAccessRow[] = [];
    for (const match of asArray(record['matches'], 'text_search.matches')) {
      const item = asRecord(match, 'text_search.matches[]');
      const path = asRelativePath(item['path'], 'text_search.matches[].path');
      const line = asLine(item['line_number'], 'text_search.matches[].line_number');
      // 同一行有多处命中时只记一行：这张表是**范围集合**，
      // 而同一个 (文件, 行) 出现两次不表达任何额外事实。
      const key = `${path}\u0000${String(line)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ path, start_line: line, end_line: line, delivered: true });
    }
    return rows;
  },

  git_status: (data) => {
    const record = asRecord(data, 'git_status 结果');
    const rows: FileAccessRow[] = [];
    const seen = new Set<string>();
    const push = (path: string): void => {
      if (seen.has(path)) return;
      seen.add(path);
      rows.push(fileRow(path));
    };
    for (const entry of asArray(record['entries'], 'git_status.entries')) {
      push(asRelativePath(asRecord(entry, 'git_status.entries[]')['path'], 'git_status.entries[].path'));
    }
    for (const excluded of asArray(record['excluded'], 'git_status.excluded')) {
      // 被排除的文件**也记**：它的路径确实随结果出站了（还带上了排除原因），
      // 而「为什么这个文件没被比对」常常比「哪些被比对了」更值得追问。
      push(
        asRelativePath(
          asRecord(excluded, 'git_status.excluded[]')['path'],
          'git_status.excluded[].path',
        ),
      );
    }
    return rows;
  },

  git_diff: (data) => {
    const record = asRecord(data, 'git_diff 结果');
    // 不记行区间：差异的两侧行号各自成区间，而这张表的一行只有一个区间。
    // 硬要挑一侧（例如新侧）会让这一行读起来像「只访问了那几行」——
    // 而 `git_diff` 读的是**两侧的整个文件**。空区间在这里是实话。
    return [fileRow(asRelativePath(record['path'], 'git_diff.path'))];
  },

  /**
   * `change_prepare` 的结果里**没有文件内容**，但有路径、前后哈希、尺寸与
   * 增减行数。按 `delivered` 的定义（迁移 v3：内容**或条目**确实随结果出站）
   * 这些行都是 `delivered: true` —— 文件名与哈希一样是出站内容，
   * `file_list` 记条目时用的也是同一个判据。
   *
   * 行区间一律为空：预览里的 `added_lines` / `removed_lines` 是**计数**，
   * 不是行号区间。把计数写进 `start_line` 那种字段是编造。
   */
  change_prepare: (data) => changeFilePathsOf(data, 'change_prepare'),
  file_create: (data) => changeFilePathsOf(data, 'file_create'),
  file_edit: (data) => changeFilePathsOf(data, 'file_edit'),
  file_delete: (data) => changeFilePathsOf(data, 'file_delete'),

  /**
   * `change_get` 的结果里，路径**与（请求了 `path` 时）该文件的完整差异**
   * 一起出站。差异的行号两侧各自成区间，因此与 `git_diff` 同一处理：
   * 记文件、不记区间。
   *
   * 逐文件去重：同一个路径出现在 `change.files` 与 `diff.path` 上时只记一行，
   * 这张表是范围**集合**，重复不表达额外事实（与 `text_search` 同）。
   */
  change_get: (data) => changeFilePathsOf(data, 'change_get'),

  // 清单条目的形状里**没有路径字段**（`ChangeListEntry` 只有 change_id、
  // 状态、摘要与 file_count）。因此这条调用确实没有让任何工作区内的
  // 路径或内容出站 —— 空数组在这里是事实，不是省略。
  change_list: NO_FILES,

  // 应用的回执里逐文件给出 `path` 与前后哈希。落盘**之后**才回到这里，
  // 因此它记的是「这次调用告诉模型哪几个文件已经被改了」—— 与别的行同样
  // 属于「结果里带了什么」，不是「进程碰过什么」（文件当然被碰过，
  // 但那是 `file_write` 那一类事实，由执行日志回答，不由这张表回答）。
  change_apply: (data) => changeFilePathsOf(data, 'change_apply'),

  // 撤销提议：路径有**两个来源**，`local_actions` 那一个不能漏 ——
  // 见 `revertPreparePathsOf` 的说明。
  change_revert_prepare: (data) => revertPreparePathsOf(data),
  // A shell may touch arbitrary files, so the precise set is unknowable from
  // its response. Record only the authorized root as the initial execution scope.
  command_exec: () => [fileRow('')],
} satisfies Readonly<Record<ImplementedToolName, FileAccessExtractor>>;

/**
 * `change_prepare` / `file_create` / `file_edit` / `file_delete` / `change_get` / `change_apply` 共用的路径提取。
 *
 * 三者回的都是「一份修改集的逐文件清单」，其中两处是 `ChangeSetView`
 * （`change_get` 把它套在 `change` 下），`change_apply` 是操作回执
 * （`OperationFileResult`）—— 字段名一样是 `files[].path`，取法逐字相同。
 * 写三份的话，将来给预览加一个「重命名前的路径」字段时，只会有一处被想起来。
 */
function changeFilePathsOf(data: unknown, what: string): readonly FileAccessRow[] {
  const record = asRecord(data, `${what} 结果`);
  // `change_get` 多一层 `change`。嵌套由 `files` 在哪一层决定，
  // 而不是由调用方传一个布尔开关 —— 传开关就等于把「哪个工具的结果长什么样」
  // 变成一次可以传错的判断。
  //
  // `change_apply` 与 `change_prepare` 走上面那一支：它们的 `files` 就在顶层。
  // 这正是「按形状判断」的价值 —— 加一个顶层 `files` 的工具不需要在这里
  // 被想起一次。
  const inner = record['change'] === undefined ? record : asRecord(record['change'], `${what}.change`);
  const rows: FileAccessRow[] = [];
  const seen = new Set<string>();
  for (const file of asArray(inner['files'], `${what}.files`)) {
    const path = asRelativePath(asRecord(file, `${what}.files[]`)['path'], `${what}.files[].path`);
    if (seen.has(path)) continue;
    seen.add(path);
    rows.push(fileRow(path));
  }
  return rows;
}

/**
 * `change_revert_prepare` 的路径提取。**两个来源，都必须取。**
 *
 *  - `change.files[].path`：新撤销修改集的逐文件预览（可自动撤销的那些）；
 *  - `local_actions[].path`：本机人工方案里的路径（V1 只会是「删除本插件
 *    新建的文件」）。
 *
 * ## 第二个来源是接线时补上的（LWB-032），它补的是一处静默盲区
 *
 * 在契约把路径单列成字段之前，本机方案的路径**只**存在于
 * `local_action_reason` 与 `instruction` 两句散文里，而这两句取不出来 ——
 * 于是这张表会把一次「模型手上明明拿到了文件名」的调用记成「什么也没读」。
 * 一条记不出事实的记录比一条没有记录更糟：它会被人当成结论。
 * 现在路径是结构化字段，这里照取；散文仍含路径（`instruction` 是写给人看的
 * 流程说明），但审计不再依赖它。
 *
 * `change` 为 `null` 是**合法的成功结果**（源修改集里全是新建文件，
 * 本版本没有能力执行删除），不是异常：那时 `local_actions` 恰恰是这次调用
 * 唯一出站的东西，也正是最需要被记下来的那一次。
 */
function revertPreparePathsOf(data: unknown): readonly FileAccessRow[] {
  const record = asRecord(data, 'change_revert_prepare 结果');
  const rows: FileAccessRow[] = [];
  const seen = new Set<string>();
  const push = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    rows.push(fileRow(path));
  };

  const inner = record['change'];
  // 只有 `null` 是预期的「没有」；`undefined` 会落到下面那句 `asArray` 上
  // 报出来 —— 形状缺字段时**抛**，与文件头那条纪律一致。
  if (inner !== null && inner !== undefined) {
    const change = asRecord(inner, 'change_revert_prepare.change');
    for (const file of asArray(change['files'], 'change_revert_prepare.change.files')) {
      const item = asRecord(file, 'change_revert_prepare.change.files[]');
      push(asRelativePath(item['path'], 'change_revert_prepare.change.files[].path'));
    }
  }

  for (const action of asArray(record['local_actions'], 'change_revert_prepare.local_actions')) {
    const item = asRecord(action, 'change_revert_prepare.local_actions[]');
    push(asRelativePath(item['path'], 'change_revert_prepare.local_actions[].path'));
  }

  return rows;
}

/** 提取一次成功调用的文件访问行。`tool` 的名字集合与输出 schema 表相同。 */
export function extractFileAccess(tool: ImplementedToolName, data: unknown): readonly FileAccessRow[] {
  return FILE_ACCESS_EXTRACTORS[tool](data);
}

// ---------------------------------------------------------------------------
// 被拒绝 / 失败的调用：目标路径
// ---------------------------------------------------------------------------

/**
 * 入参里那个「这次调用本来要碰的文件」。
 *
 * 只对**语法合法**的相对路径返回行：调用方发来的 `path` 在判定之前
 * 只过了 schema 校验，而在被拒绝的那条路径上，它完全可能是一个绝对路径
 * （例如 `C:\Windows\System32\drivers\etc\hosts`）。把那种字符串写进审计
 * 就等于让**调用方**决定审计里出现什么本机路径 —— 而审计的读者会把它
 * 当成一个已发生的事实。校验不过就不记这一行。
 *
 * `workspace_id` 为空的工具（`bridge_status` / `workspace_list`）没有目标文件。
 *
 * ## `change_prepare` 的目标在 `items[]` 里，不在顶层 `path` 上
 *
 * 它是唯一一个**一次调用指向多个文件**的工具，而那些路径挂在
 * `items[].path`。只看顶层 `path` 的话，一次被拒绝的 `change_prepare`
 * 在审计里会记成「没有碰任何文件」—— 而那次调用确实点了名，
 * 只是没被允许。这正是这张表要区分的两件事之一。
 *
 * `change_get` / `change_list` **不在这里**：前者的入参 `path` 是可选的，
 * 不给就是不返回差异（`hasPathField` 的默认分支按「没碰文件」处理），
 * 后者的入参里根本没有 `path`。给它们编一个目标出来会让审计多出一行
 * 从未被指向的文件。
 */
export function targetFileAccess(tool: ImplementedToolName, input: unknown): readonly FileAccessRow[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  if (tool === 'command_exec') return [{ path: '', start_line: null, end_line: null, delivered: false }];
  if (tool === 'change_prepare') return claimedItemPaths(record['items']);
  const raw = record['path'];
  // `undefined` = 该工具的 path 是可选的且没给（默认工作区根）；
  // 其余非字符串值交给「不记」处理，不在这里抛 —— 这条路径上已经在
  // 处理一个失败，再抛一个只会把它盖掉。
  if (raw === undefined) {
    return hasPathField(tool) ? [{ path: '', start_line: null, end_line: null, delivered: false }] : [];
  }
  if (typeof raw !== 'string') return [];
  if (raw === '') return [{ path: '', start_line: null, end_line: null, delivered: false }];
  const checked = validateRelativePath(raw);
  if (!checked.ok) return [];
  return [{ path: checked.normalized, start_line: null, end_line: null, delivered: false }];
}

/** 该工具的入参里是否有 `path` 字段（决定「没给 path」是否等价于「工作区根」）。 */
function hasPathField(tool: ImplementedToolName): boolean {
  return tool === 'file_list' || tool === 'text_search' || tool === 'git_status' || tool === 'command_exec';
}

/**
 * 一次 `change_prepare` 入参里点名的全部路径。
 *
 * 与顶层 `path` 那条一样：**只记语法合法的相对路径**，认不出的直接丢掉。
 * 不抛异常 —— 这条路径上已经在处理一次失败，再抛一个只会把它盖掉。
 *
 * 逐路径去重（大小写不敏感）：同一份提案里对同一个文件的两次操作会被
 * `@lwb/changes` 拒绝，但在**被拒绝之前**审计就已经在记了，
 * 而那时它确实点了两次同一个文件 —— 记成一行是这一层的取舍：
 * 这张表是范围集合，而「点了两次」这件事由拒绝原因回答。
 */
function claimedItemPaths(items: unknown): readonly FileAccessRow[] {
  if (!Array.isArray(items)) return [];
  const rows: FileAccessRow[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const raw = (item as Record<string, unknown>)['path'];
    if (typeof raw !== 'string' || raw === '') continue;
    const checked = validateRelativePath(raw);
    if (!checked.ok) continue;
    const key = checked.normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ path: checked.normalized, start_line: null, end_line: null, delivered: false });
  }
  return rows;
}
