/**
 * 同一个幂等键上的**进程内单飞**（LWB-022 步骤 4）。
 *
 * ## 为什么必须有
 *
 * 幂等记录的占位（`IdempotencyRepo.begin`）是**原子**的，但它原子地表达的
 * 只是「这个键被占用了」。两个并发的同键请求会看到：
 *
 * ```
 *   A: begin → new     （占位成功）
 *   B: begin → replay，result_ref 仍为 null（A 还没算完）
 * ```
 *
 * 而 `replay + result_ref === null` 的正确含义是「上一次同键调用中途死掉了，
 * 没有留下任何结果，可以安全重来」。B 若照此办理，就会与仍在计算的 A
 * 各建一份结果 —— 一个键对应两份结果，正是幂等要防的事。
 *
 * 因此把「同一个键」串起来：B 等到 A 结束后再判，那时 `result_ref` 已经写上，
 * B 走的是正常重放。跨进程的并发不存在 —— V1 只有本机一个 daemon 持有
 * 这个状态库（sqlite 单写者）。
 *
 * ## 为什么不用数据库锁
 *
 * 计算要读文件、要落快照，是长时间的异步过程；持有一个数据库事务跨越
 * 异步 I/O 会把整个状态库卡住（方案 §9：**等待审批不得长期占用事务或文件锁**）。
 * 这里串的是**同一个键**，不是整个库。
 *
 * ## 为什么它住在本包，而不是 `@lwb/idempotency`
 *
 * 按题材它属于幂等，而 `@lwb/idempotency` 的 `queueOperation` 也要用它 ——
 * 但那个包**依赖本包**（它要 `transitionChange`），反向依赖会成环。
 * 因此在「一个实现 + 清晰的依赖方向」与「按题材归档」之间选了前者：
 * 这段逻辑只有一份，`@lwb/idempotency` 把它再导出一次，
 * 好让那边（LWB-026 的执行器）只需要记住一个导入面。
 *
 * 当年这段逻辑住在 `prepare.ts` 里，LWB-022 把它搬到这里，因为
 * 「同一个键只跑一次」这条不变量必须**只有一个实现**：两处各有一个 `Map`，
 * 两边都自称保证了串行，而它们互不相识 —— 同一个键从两条路径进来时，
 * 两把锁各自放行，谁都没挡住。
 *
 * 键由 `principal_id / tool / key` 三段拼成（与 `idempotency_records` 的
 * 唯一索引同构）：只按 `key` 串会让两个主体用同一个键时互等，
 * 而它们本来是两条独立的事实。
 */

/** 三段拼接的分隔符。用 NUL 是因为它不可能出现在任何一个标识符里。 */
const SEPARATOR = '\u0000';

const keyLocks = new Map<string, Promise<void>>();

export interface IdempotencyLockScope {
  readonly principal_id: string;
  /** 工具或动作名。同一把键在不同工具下是两条独立的事实。 */
  readonly tool: string;
  readonly key: string;
}

/**
 * 把同一个 `(principal, tool, key)` 上的调用串起来。
 *
 * 注意它**不是**「只执行一次」：`fn` 每次都会被调用，只是不并发。
 * 一次性由 `IdempotencyRepo` 的唯一索引与 `result_ref` 表达 ——
 * 这把锁只负责让第二个调用**看到**第一个的结果，而不是替它决定要不要跑。
 * 把「只跑一次」做进锁里，会让进程重启后的重试无法进行（锁没了，
 * 但状态库里的记录还在）。
 */
export async function withIdempotencyLock<T>(
  scope: IdempotencyLockScope,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${scope.principal_id}${SEPARATOR}${scope.tool}${SEPARATOR}${scope.key}`;
  const previous = keyLocks.get(key) ?? Promise.resolve();
  // `.then(fn, fn)`：前一个无论成功还是失败都要放行下一个。
  // 用 `.then(fn)` 的话，一次失败会把这条键上的后续调用全部吊死。
  const current = previous.then(fn, fn);
  const settled: Promise<void> = current.then(
    () => undefined,
    () => undefined,
  );
  keyLocks.set(key, settled);
  try {
    return await current;
  } finally {
    // 只清掉自己那一格：若期间又排了新的等待者，它已经把自己写进去了。
    if (keyLocks.get(key) === settled) keyLocks.delete(key);
  }
}

/** 当前在飞的键数量。**仅供测试与诊断**：它不影响任何判定。 */
export function inFlightKeyCount(): number {
  return keyLocks.size;
}
