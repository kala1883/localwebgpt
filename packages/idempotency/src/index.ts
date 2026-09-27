/**
 * `@lwb/idempotency` —— 幂等、并发收敛，与「未知不是失败」（LWB-022）。
 *
 * ## 这个包为什么存在
 *
 * 幂等在本工程里不是「加个缓存」，它是**四件不同的事**，而它们的失效方式
 * 各不相同。四件事混在一起写，通常的结果是其中一件被忘掉：
 *
 *  1. **标识符不能混用**（`ids.ts`）。四种 id 在实现里都是字符串，
 *     传错地方编译器不会吭声 —— 而拿 `request_id` 当幂等键的后果是
 *     「每次重试都变成一次新请求」。用品牌类型让它们不可互赋。
 *  2. **同一个键不能并发跑两次**（复用 `@lwb/changes` 的
 *     `withIdempotencyLock`）。幂等记录的占位是原子的，但它原子地表达的
 *     只是「这个键被占用了」，不是「上一次已经算完了」。
 *  3. **同一个修改集不能被执行两次**（`operations.ts` 的 `queueOperation`）。
 *     这与第 2 条是**两件事**：方案 §7 的原话是「相同 change_id 无论几个
 *     apply 键，只关联一个 operation」。换键重试是合法的，换键换来第二个
 *     操作不是。
 *  4. **未知不是失败**（`outcome.ts`）。把一个「不知道」读成「成功」会让
 *     用户以为文件改了；读成「失败」会让调用方重发一次写任务 ——
 *     而重发在「可能写了一半」的场景下是第二次破坏。
 *
 * ## 依赖方向
 *
 * 本包依赖 `@lwb/changes`，不反向。`withIdempotencyLock` 因此**住**在
 * `@lwb/changes`（一个实现），由本包再导出一次（一个导入面）——
 * 理由写在那个文件的头注释里，不在这里重复一遍。
 *
 * 本包**不接触文件系统**（由 `scripts/check-fsguard-imports.mjs` 强制）：
 * 它管的是状态库里的事实，写盘是 `@lwb/executor` 的事。
 */

export {
  IDENTIFIER_ROLES,
  asChangeId,
  asIdempotencyKey,
  asOperationId,
  asRequestId,
  type ChangeId,
  type IdempotencyKey,
  type OperationId,
  type RequestId,
} from './ids.ts';

export {
  OUTCOME_POLICY,
  classifyOperation,
  type FileEffect,
  type ItemResultLike,
  type OperationOutcome,
  type OperationOutcomeKind,
  type OperationOutcomePolicy,
} from './outcome.ts';

export {
  queryOperation,
  queueOperation,
  requireOperationId,
  type JournalEntry,
  type OperationQueryResult,
  type QueueOperationInput,
  type QueuedOperation,
} from './operations.ts';

/**
 * 单飞锁的**再导出**：它真的住在 `@lwb/changes/src/single-flight.ts`。
 * 在这里再导一次，是为了让执行器（LWB-026）只需要记住一个导入面 ——
 * 「幂等需要的东西从 `@lwb/idempotency` 拿」。
 */
export { inFlightKeyCount, withIdempotencyLock, type IdempotencyLockScope } from '@lwb/changes';
