/**
 * 确定的文件次序（LWB-026 步骤 1 后半句：「确定的文件加锁顺序」）。
 *
 * ## 为什么不能就用 `seq`
 *
 * `change_items.seq` 是模型列出的次序，它当然是确定的 —— 但它**只在一份
 * 修改集内部**确定。两份额外的修改集若覆盖同一批文件而排列不同，
 * 它们各自按自己的 `seq` 去依次加锁，就是一个经典的死锁环：
 *
 * ```text
 *   修改集 A：先 a.txt 再 b.txt      修改集 B：先 b.txt 再 a.txt
 *   A 拿到 a、B 拿到 b，各自等对方那一个 —— 谁也不放手。
 * ```
 *
 * 而两份额外的修改集**可以**同时存在且互不相识：一块地盘对应一份工作区记录，
 * 但工作区可以是目录，也可以是目录里的某一个文件（`kind: 'file'`，
 * 迁移 v2 起支持）。这两条记录的物理身份不同，因此占的是**两块不同的地**，
 * 于是一个操作改 `<root>/src/a.ts`、另一个操作改 `<root>` 里的 `src/a.ts`，
 * 互斥槽拦不住。次序若再不一致，剩下的拦阻就只剩运气。
 *
 * 按**路径**排序把这件事变回确定的：无论哪一份修改集，先动文件的路径次序
 * 总是同一条，因此不存在环。
 *
 * ## 比较的是 `canonical_path_key`，不是 `canonical_path`
 *
 * 键是**已经规范化并对大小写折叠过**的那一列（迁移 v1 的
 * `change_items_path_uq` 用的就是它）。理由是 Windows 上 `A.ts` 与 `a.ts`
 * 是同一个文件：按原串排序会把它们排到两个相距很远的位置，
 * 于是「同一个文件」在两次排序里拿到两个不同的名次。
 *
 * 比较用**码元序**（`<` / `>`），不用 `localeCompare`：
 * 后者随运行环境的区域设置变化，而「次序」这条性质必须是**跨机器同一个答案** ——
 * 它要防的是死锁，死锁不会因为换了一台机器就变成别的性质。
 * 代价是非 ASCII 路径的排序不「好看」，但这里没有人看它，只有加锁顺序用它。
 *
 * ## 为什么把它单独放一个文件
 *
 * 它是本包里**唯一**一处「顺序」的定义。LWB-027 的写入、LWB-029 的日志
 * 都要按同一个次序做，而三处各写一遍 `sort` 是本项目反复记录过的那种错误
 * （两处名字不同、行为微妙地不同，而它们互不相识）。
 */

import type { ChangeItemRecord } from '@lwb/persistence';

/**
 * 把条目排成**加锁次序**，返回新数组，不改动入参。
 *
 * 次序键是 `(canonical_path_key, seq)`。第二个键只为**确定性**：
 * 同一个修改集里同一个键不可能出现两次（`change_items_path_uq`），
 * 因此理论上到不了这一层 —— 但排序函数不该依赖另一张表上的唯一索引
 * 才能给出稳定结果，那是把两个模块的正确性绑在一起。
 */
export function orderedForLocking(items: readonly ChangeItemRecord[]): readonly ChangeItemRecord[] {
  return [...items].sort((left, right) => {
    if (left.canonical_path_key !== right.canonical_path_key) {
      return left.canonical_path_key < right.canonical_path_key ? -1 : 1;
    }
    return left.seq - right.seq;
  });
}

/**
 * 次序是否已经排好。供测试与断言使用 ——
 * 「排过了」与「碰巧有序」在结果上一样，在意图上不一样：
 * 一个依赖 `prepare` 恰好按路径插入条目的实现，会在插入次序改变的那天
 * 悄悄退化，而没有任何断言会失败。
 */
export function isOrderedForLocking(items: readonly ChangeItemRecord[]): boolean {
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1] as ChangeItemRecord;
    const current = items[index] as ChangeItemRecord;
    if (previous.canonical_path_key > current.canonical_path_key) return false;
    if (
      previous.canonical_path_key === current.canonical_path_key &&
      previous.seq > current.seq
    ) {
      return false;
    }
  }
  return true;
}
