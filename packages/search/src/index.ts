/**
 * `@lwb/search` —— 本地字面量搜索（LWB-015，契约 `text_search`）。
 *
 * 四个文件，四件事：
 *
 *  - `query.ts`  —— 查询串的形态与**匹配**：一个字面量加一个大小写开关，
 *                   没有正则、没有模式编译。「不开放任意正则」在这里是
 *                   接口的形状，不是一条约定。
 *  - `walk.ts`   —— 候选文件的发现：有界、有序、可续、先过滤后进入。
 *                   重解析点不进、搜索排除的不进、硬拒绝的连名字都不留。
 *  - `scan.ts`   —— 单个文件的扫描：探针 → 受控读取 → 身份比对 → 片段预筛
 *                   → 逐片出站。秘密片段在这里被整文件丢弃。
 *  - `search.ts` —— 入口：预算、取消、分页、「还有更多」的证据，
 *                   以及 `complete` / `incomplete_reason` 的组装。
 *
 * 本包**不直接接触文件系统**（由 `scripts/check-fsguard-imports.mjs` 强制）：
 * 所有磁盘访问都经过注入的 `WinfsOps`。本包也没有**出站**通道：片段只经
 * `@lwb/egress` 的 `emitContent` 离开，而那是唯一的出口。
 *
 * 本包**不读时钟**（`clock` 与 `now` 都由调用方注入），也**不持有状态**：
 * 分页的位置全在签名的游标里，进程重启不丢，也不需要服务端会话。
 */

export * from './query.ts';
export * from './walk.ts';
export * from './scan.ts';
export * from './search.ts';
