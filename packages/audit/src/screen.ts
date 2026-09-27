/**
 * 审计补充信息的筛查（LWB-018）。
 *
 * ## 这一段在防什么
 *
 * 审计库与状态库是**同一个文件**，而它的 `metadata` 列是 JSON 文本，
 * 因此它的泄漏面等于整个状态库。风险不在「有人故意写进去一段源码」，
 * 而在「顺手把手上有的东西塞进去」：
 *
 *   metadata: { path: absolutePath, content: snippet, query: queryText }
 *
 * 三行里有两行是内容，而写它的那一刻它看起来只是在「记多一点上下文」。
 *
 * ## 为什么是拒绝，而不是**过滤掉**
 *
 * 静默丢弃是这里最坏的选择：审计会少一个字段，而**没有任何人知道**
 * 少了一个字段 —— 调查者会把「这条记录没有 path」读成「这次调用没有
 * 指定路径」。拒绝（抛出）让违约变成一个当场可见的装配/调用错误。
 *
 * 调用方（`guard.ts`）填的是一张**固定的键表**，因此拒绝在实践中
 * 只会由「有人新加了一个字段」触发 —— 那正是需要有人看一眼的时刻。
 *
 * ## 键名白名单为什么不是「任意键 + 值筛查」
 *
 * 值筛查拦得住绝对路径与换行，拦不住 `{ secret_note: "..." }`。
 * 键名可枚举意味着「审计里有哪些事实」是一份**可评审的清单**，
 * 而不是「谁写谁算」。新增一个键必须改这里，也就必须有人回答
 * 「这个字段会不会带出内容」。
 */

const ALLOWED_METADATA_KEYS: readonly string[] = [
  'workspace_generation',
  'policy_version',
  'read_token_version',
  'result_truncated',
  'next_cursor',
  'entries',
  'matches',
  'scanned_entries',
  'denied_entries',
  'excluded_entries',
  'scanned_files',
  'denied_files',
  'secret_files',
  'incomplete',
  'redacted',
  'editable',
  'file_rows',
  'delivered_rows',
  'denied_rows',
  'cursor_rejected',
  'reason',
  'alias',
  'connection_alias',
  'idle_connections',
  'enabled',
  'generation',
  // 并发额度耗尽时的现场：为什么被拒、当时有几个在飞、上限是多少。
  // 三个都是**数字**（见下面的 `isScalar`），一个数字写不下一段源码 ——
  // 这正是「先问它会带出内容吗，再决定收不收」这一步的答案。
  'in_flight',
  'limit',
  // 被暂停/恢复的是**哪一类**主体（`model_surface` / `local_console`）。
  // 它是一个闭集的枚举值，不是调用方给的自由文本。
  'principal_kind',
  // 工作区 MCP 授权仅记录一组闭集能力名；不包含目录路径或文件内容。
  'capabilities',
  // --- LWB-021：批准决定的事实 -------------------------------------------
  //
  // 这一组回答的都是「谁在什么时候对**哪一个**修改集做了什么」，逐条过一遍
  // 「它会带出内容吗」：
  //
  //  - `short_code`：摘要的前 8 位十六进制（`XXXX-XXXX`）。它是**指纹**，
  //    不是内容 —— 换不回一个字节，而它是审计行与控制台界面上那一行之间的
  //    唯一连接点。完整摘要仍然不收：它是「哪一份内容」的精确标识，
  //    而审计要回答的是「哪一次决定」。
  //  - `change_state`：闭集枚举（`PENDING_APPROVAL` / `QUEUED` / `REJECTED`…）。
  //    刻意不叫 `state`：这个名字太泛，与别处的「状态」混在一起读不出是
  //    谁的状态。
  //  - `approval_id` / `operation_id`：不透明标识（`apr_…` / `op_…`），
  //    是通往 `approvals` / `operations` 两张表的连接键。它们不表达内容，
  //    也不表达身份 —— 身份在 `connection_id` 列上。
  //  - `operation_existed`：布尔。记录「本次是新建了操作还是命中既有的那一个」，
  //    这是重复点击收敛路径上唯一可观测的事实。
  'short_code',
  'change_state',
  'approval_id',
  'operation_id',
  'operation_existed',
  // 恢复快照导出版本枚举。**字节本身不进入审计**，只记录操作者选择了
  // 原版本还是提议版本；真正的导出数据仅回到已经认证的本机控制台。
  'snapshot_version',
  // --- LWB-034：紧急停用的四个计数 ---------------------------------------
  //
  // 这四个回答的是「那一次停用到底做成了什么样」。全是**数字**，
  // 因此按上面那条规则（「先问它会带出内容吗」）逐条过一遍是个短答案：
  // 一个计数写不下一段源码，也写不下一个路径。
  //
  //  - `revoked_changes`：这次被作废掉的排队授权有几条。
  //  - `skipped_changes`：扫描时还在、动手时已经走掉的修改集有几条。
  //    它**不是错误**（见 `invalidateMany`），但它必须留痕：一个
  //    「本来该废 5 条、结果只废了 3 条」报告，缺了它就读不出为什么。
  //  - `unrevoked_changes`：动作做完之后，仍然处于待执行状态的修改集
  //    还有几条。非零意味着废止那一步没做完 —— 这个数字**不存标志位**，
  //    是当场从 `changes` 表数出来的。
  //  - `stopping_writes`：按下按钮那一刻还握着写盘权的写入有几件。
  //    非零表示停用**不是瞬间完成的**，而这句话只能由当时的现场回答。
  //
  // 失败的原因**不进这里**：错误消息里可能是本机绝对路径
  // （SQLite 的 `unable to open database file` 后面就跟着一个），
  // 而它过不了下面那道绝对路径筛查 —— 那道筛查抛错，则整条审计写不成，
  // 于是「有人按过紧急停用」这件事反而没了记录。失败因此记成
  // `reason` 里的闭集枚举（`PERSIST_FAILED` / `REVOKE_FAILED`），
  // 原文进 daemon 日志（`PauseNotice`）。
  'revoked_changes',
  'skipped_changes',
  'unrevoked_changes',
  'stopping_writes',
];

/** 单个字符串值的长度上限。够写下别名与枚举值，写不下一段源码。 */
const MAX_VALUE_CHARS = 200;

/**
 * 绝对路径的三种写法：`C:\…` / `C:…`、`\\server\share`、`/etc/passwd`。
 * 相对路径用的是 `/` 分隔但**不以 `/` 开头**，因此不会误伤。
 */
const ABSOLUTE_PATH_PATTERNS: readonly RegExp[] = [
  /[A-Za-z]:[\\/]/,
  /^[A-Za-z]:/,
  /^\\\\/,
  /^\//,
];

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const KEY_SHAPE = /^[a-z][a-z0-9_]{0,40}$/;

/**
 * 把任意的补充信息收敛成可入库的形状；违约即抛。
 *
 * 抛的是普通 `Error` 而不是 `BridgeError`：这一层的失败是**本进程的
 * 装配/逻辑错误**（写审计的代码出了错），不是调用方能修正的输入问题。
 * 它的归类由调用方决定 —— `guard.ts` 把它折成 `INTERNAL_ERROR`。
 */
export function screenMetadata(
  input: Readonly<Record<string, unknown>>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!KEY_SHAPE.test(key)) {
      throw new Error(`审计补充信息的键名不合规：${JSON.stringify(key)}。`);
    }
    if (!ALLOWED_METADATA_KEYS.includes(key)) {
      throw new Error(
        `审计补充信息的键 ${key} 不在允许清单内。新增键必须同时回答「它会带出内容吗」。`,
      );
    }
    if (!isScalar(value)) {
      throw new Error(`审计补充信息 ${key} 的值不是标量（字符串/数字/布尔/null）。`);
    }
    if (typeof value === 'string') {
      if (value.length > MAX_VALUE_CHARS) {
        throw new Error(`审计补充信息 ${key} 的值超过 ${MAX_VALUE_CHARS} 字符，判定为内容而非事实。`);
      }
      if (CONTROL_CHARS.test(value)) {
        throw new Error(`审计补充信息 ${key} 的值含控制字符或换行，判定为内容而非事实。`);
      }
      if (ABSOLUTE_PATH_PATTERNS.some((pattern) => pattern.test(value))) {
        throw new Error(`审计补充信息 ${key} 的值看起来是本机绝对路径，拒绝写入审计。`);
      }
    }
    out[key] = value;
  }
  return out;
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** 允许的键名清单，供测试逐条钉住（含「不得包含 path/content/query」这类）。 */
export const AUDIT_METADATA_KEYS = ALLOWED_METADATA_KEYS;
