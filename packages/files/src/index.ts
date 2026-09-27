/**
 * `@lwb/files` —— 读取侧的文件能力（LWB-013 / LWB-014）。
 *
 * 五个文件，五件事：
 *
 *  - `guard-bridge.ts` —— 与护栏之间的**共用边界规则**：工作区根引用怎么拼、
 *                        判决用哪条路径、护栏码怎么映射。读取与列举必须对
 *                        同一条路径给出同一个答案，因此这些只能有一份。
 *  - `decode.ts`       —— 字节事实：编码、BOM、换行、二进制、行索引。
 *                        只**报告**已保存字节是什么，不做「尽力解释」。
 *  - `read-token.ts`   —— 签名读取票据、分页游标与目录列举游标。无状态，
 *                        因此有效期是唯一的失效机制；密钥由 daemon 注入。
 *  - `read.ts`         —— 一致读取：探针 → 预检 → 受控读取 → 身份比对 →
 *                        出站闸门 → 分页 → 票据。
 *  - `list.ts`         —— 分页目录列举：有界、有序、可续；遍历时先过滤后进入，
 *                        被拒绝的对象连名字都不出现在结果里。
 *  - `text-diff.ts`    —— 行级 LCS 差异。**纯算法**，不认识 Git 也不认识
 *                        磁盘；`git_diff` 与 `change_get` 共用它。
 *
 * 本包**不直接接触文件系统**（由 scripts/check-fsguard-imports.mjs 强制）：
 * 所有磁盘访问都经过注入的 `WinfsOps`（生产上是 `@lwb/winfs` 后端）。
 * 本包也没有**出站**通道：正文只经 `@lwb/egress` 的 `emitContent` 离开。
 */

export * from './guard-bridge.ts';
export * from './decode.ts';
export * from './read-token.ts';
export * from './read.ts';
export * from './list.ts';
export * from './text-diff.ts';
