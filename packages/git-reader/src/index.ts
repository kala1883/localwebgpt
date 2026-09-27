/**
 * `@lwb/git-reader` —— 只读 Git 能力（LWB-016，方案 §9.1）。
 *
 * 六个文件，六件事：
 *
 *  - `layout.ts`     —— 布局证伪（外置 gitdir / alternates / 过大 pack），
 *                       以及库错误的翻译。**必须排在读任何东西之前**：有些
 *                       "读不懂"在读到一半才暴露，而那时失败的方式不可控。
 *  - `limits.ts`     —— 这两个工具各自需要的限额，取值只有一处。
 *  - `meta-fs.ts`    —— 注入 isomorphic-git 的**只读**虚拟文件系统：
 *                       写通道根本不存在（不是"记得别写"），读取按窄范围
 *                       清单+策略判定，并有账本记录每一次拒绝。
 *  - `preflight.ts`  —— 两个工具共用的起飞前检查（四条）与只读账本断言。
 *  - `status.ts`     —— `git_status`：一次 `statusMatrix`，然后按同一份规则表
 *                       复核库给出的每一行。
 *  - `diff.ts`       —— `git_diff`：HEAD / index / 工作区三种比较，两侧按各自
 *                       合适的机制取字节，原始字节语义，逐个 hunk 过出站闸门。
 *
 * 本包**不直接接触文件系统**（由 `scripts/check-fsguard-imports.mjs` 强制）：
 * 所有磁盘访问都经过注入的 `WinfsOps`（生产上是 `@lwb/winfs` 后端），
 * 而 Git 自己的读取全部经过 `meta-fs.ts` 那一层。**不启动 Git CLI、不提供
 * HTTP 模块、不执行 hooks / textconv / external diff。**
 *
 * 本包也没有自己的出站通道：正文只经 `@lwb/egress` 的 `emitContent` 离开。
 */

export * from './layout.ts';
export * from './limits.ts';
export * from './meta-fs.ts';
export * from './preflight.ts';
export * from './status.ts';
export * from './diff.ts';
