/**
 * 装配根用到的常量（装配根）。
 *
 * 分三类：**退出码**（进程与外部脚本之间的契约）、**版本号**（要回报给
 * 状态页的事实）、**那条模型侧连接的标识**（daemon、启动器、适配器
 * 三方必须写出同一个值）。
 */

/**
 * 进程退出码。
 *
 * 三个码分开，是因为它们的**处置不同**，而操作者（以及将来的启动器与
 * 开机启动项）只能从这个数字判断该做什么：
 *
 * | 码 | 含义 | 操作者该做什么 |
 * | --- | --- | --- |
 * | 0 | 正常退出 | 无 |
 * | 1 | 启动失败（存储、凭证、护栏、绑定数据管道……） | 读报错，修配置 |
 * | 2 | 本用户下已有 daemon 在运行 | **不要**强杀；先确认那个是不是自己 |
 *
 * 2 单独一个码的理由最实在：把它归进 1，「已有实例」与「启动失败」
 * 在启动脚本看来完全一样，而脚本最自然的反应是重试 —— 重试不是问题，
 * 但如果它重试的是「先杀掉占用者」，那就变成了一次强杀一个正在服务的
 * daemon。一个不同的数字足以让脚本作者停下来看一眼。
 */
export const EXIT_OK = 0;
export const EXIT_STARTUP_FAILED = 1;
export const EXIT_ALREADY_RUNNING = 2;

/**
 * daemon 的版本号，回报在 `bridge_status.server_version` 里。
 *
 * **它是手写的，因此必须与根 `package.json` 的 `version` 一致。**
 * 真值在根上：`apps/daemon` 没有自己的清单（`apps/console` 与
 * `native/winfs` 有），整个产品共用一个版本号。
 *
 * 不在这里读那个文件：业务层不得直接碰文件系统（`scripts/check-fsguard-imports.mjs`），
 * 而为了一个版本号破例会让「业务层不碰磁盘」这条规则出现第一个缺口。
 * 一致性由 `tests/windows/daemon-assembly.test.ts` 里的一条断言钉住 ——
 * 一个只有注释的约定会在第一次改版本号时失效。
 */
export const DAEMON_VERSION = '0.1.0';

/**
 * 模型侧那条连接的标识。
 *
 * daemon（建这条连接行）、启动器（把它写进 `LWB_CONNECTION_ID`）、
 * 适配器（拿它去握手）三方必须写出**同一个**值。它**不是**凭证：
 * 凭证是 audience 派生密钥（`packages/ipc/src/audience.ts`），
 * 而这个标识只回答「你是谁」，并且在握手里被 `isRegistered` 用来
 * 挡掉「算得对但没登记过的名字」。
 *
 * 名字里带 `chatgpt-web` 而不是泛泛的 `model`：V1 只有一条模型侧通道，
 * 而它服务的确实是网页版会话。将来若出现第二条，两条连接各有各的
 * 授权行 —— 那时候「换个名字」是一次显式的迁移，不是顺手改一个字面量。
 */
export const ADAPTER_CONNECTION_ID = 'conn-chatgpt-web';

/** 上面那条连接在控制台里的显示名。别名是给人看的，不参与任何判定。 */
export const ADAPTER_CONNECTION_ALIAS = 'ChatGPT 网页（MCP 隧道）';

/**
 * 上面那条连接的 `principal_id`。
 *
 * `principal_id` 在 ADR-003 §4 里是**授权主体**的标识，而它必须来自
 * 已鉴权的通道身份，不能来自工具参数。这里写的是一个本地登记的常量：
 * 它描述「这条连接代表哪一类主体」，与任何一次调用的入参无关。
 * 绝不从工具参数里取同名字段 —— 那条反模式在 ADR-003 §4 里被点名。
 */
export const ADAPTER_PRINCIPAL_ID = 'chatgpt-web';
