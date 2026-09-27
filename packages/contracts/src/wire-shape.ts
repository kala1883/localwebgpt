/**
 * 契约接口 ↔ 手写 zod schema 的**结构核对**（LWB-017）。
 *
 * ## 为什么需要它
 *
 * `tool-outputs.ts`（结果）与 `tools.ts`（入参）里的 schema 是契约接口的
 * **手写镜像**。镜像会漂移，而两个方向都有代价：
 *
 *  - schema 比契约**窄**（漏字段、数字范围写小、枚举漏一个取值）——
 *    一个本来合法的调用/结果被拒。这还算好的：它会被立刻用出来。
 *  - schema 比契约**宽**——校验被静默放宽，而放宽发生在**真实调用/结果**
 *    那一刻。这一侧不能靠自觉。
 *
 * ## 为什么不能只用「双向可赋值」
 *
 * 因为它**看不见多出来的字段**：`{a: string; b?: boolean}` 可以赋给
 * `{a: string}`，反向也成立（多出的属性只在「对象字面量直接赋给某类型」
 * 时才触发多余属性检查，而这里两侧都是具名类型）。实测过：给
 * `file_list` 的 schema 加一个 `.optional()` 字段，双向可赋值全过 ——
 * 也就是说「schema 多一个字段」这个**最想拦的方向**两向都拦不住。
 *
 * 所以核对分两层：
 *
 *  1. **键集合**：`keyof` 必须逐层相等，多一个少一个都报错**并带上字段名**；
 *  2. **同名键的类型**：递归比较（数组比元素、对象比键、其余比互相可赋值）。
 *
 * 双向可赋值仍然保留，但只用在**联合类型**那一支：联合成员的精确比较在
 * 类型系统里做不到（`keyof (A|B)` 取的是交集），此时退回到可赋值性 ——
 * 这一支的已知代价是「联合成员里多一个可选字段」抓不到，见文末。
 *
 * ## 报错名的写法
 *
 * 每个名字都是**关于失败方向上的一句事实**，而不是「谁更宽」：宽窄判断在
 * 类型不符（schema 把 `branch` 写成 `z.number()`）时两个方向同时不成立，
 * 那时任何「更宽/更窄」的说法都是错的。方向本身则永远是事实。
 *
 * 这里以前把两个标签写反过 —— 第一次真正跑负向验证时才看出来，
 * 而当时文件里已经写着「已各做一次反向验证」。
 */

import type { z } from 'zod';

import type { BrandedString } from './ids.ts';

/**
 * 契约接口的「线上形态」。
 *
 * 品牌字符串（`string & {brand}`）在 JSON 上不存在，只有 `string`；
 * 数组的 `readonly` 与 schema 推断结果无关（比较时按元素比，见下），
 * 因此不必在这里剥掉。
 */
export type Wire<T> = T extends BrandedString
  ? string
  : T extends readonly (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { readonly [K in keyof T]: Wire<T[K]> }
      : T;

/** 联合类型检测。非联合为 `false`，联合为 `true`。 */
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/** 联合类型那一支的退路：互相可赋值即视为相等。 */
type Mutual<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : { schema_accepts_types_contract_does_not: true }
  : { schema_does_not_accept_contract_type: true };

/**
 * 结构相等。
 *
 * 每个分支都写成 `[A] extends [...]` 而不是 `A extends [...]`：
 * 裸类型参数会**分发**到联合的每个成员上，于是 `'lf'|'crlf'` 这种字面量
 * 联合会被逐个成员拿去和整个联合比，正确的相等反而报错。包一层元组即
 * 关掉分发。
 */
type Identical<A, B> = [A] extends [readonly unknown[]]
  ? [B] extends [readonly unknown[]]
    ? Identical<A[number], B[number]>
    : { schema_expects_array: true }
  : [A] extends [object]
    ? [B] extends [object]
      ? ObjectShape<A, B>
      : { schema_expects_object: true }
    : Mutual<A, B>;

type ObjectShape<A, B> = IsUnion<A> extends true ? Mutual<A, B> : IsUnion<B> extends true ? Mutual<A, B> : Keys<A, B>;

type Keys<A, B> = Exclude<keyof A, keyof B> extends never
  ? Exclude<keyof B, keyof A> extends never
    ? AllTrue<{
        readonly [K in keyof A]: K extends keyof B ? Identical<A[K], B[K]> : { schema_is_missing_keys: K };
      }>
    : { schema_has_extra_keys: Exclude<keyof B, keyof A> }
  : { schema_is_missing_keys: Exclude<keyof A, keyof B> };

/**
 * 逐字段结果全为 `true` 才收成 `true`；否则把那份**按字段名索引**的明细
 * 带出去 —— 报错时能看到是哪个字段，而不只是「这个工具不对」。
 *
 * `Exclude<…, undefined>` 是必要的：契约里的可选字段（`path?: string`）
 * 在映射类型里保持可选，于是 `M[keyof M]` 会带上 `undefined`，
 * 一个**全对**的映射就会因为多了个 `undefined` 被判成失败。
 */
type AllTrue<M> = [Exclude<M[keyof M], undefined>] extends [never]
  ? true
  : [Exclude<M[keyof M], undefined>] extends [true]
    ? true
    : { field_mismatch: M };

/**
 * 一个契约接口与一个 schema 的核对结果。恰好是 `true` 才算过。
 */
export type ShapeCheck<T, S extends z.ZodType> = Identical<Wire<T>, Wire<z.infer<S>>>;

/** 让核对真的被求值：`true` 之外的值都不能赋给这个参数。 */
export function checkShape<T, S extends z.ZodType>(_value: ShapeCheck<T, S>): void {
  void _value;
}

/*
 * 已知覆盖边界（写下来是为了让它是一条**边界**，而不是一个错觉）：
 *
 *  - 联合类型的**成员内部**多一个可选字段抓不到（联合那一支只剩互相可赋值）；
 *  - 联合成员之间的**一一对应**不做检查：`A|B` 与 `A|B|C` 在做对象联合时
 *    走的是互相可赋值，多一个成员会因为可赋值而通过。工具入参 schema 里
 *    的联合（`changeItem`）由运行时用例覆盖「未知枚举被拒绝」。
 */
