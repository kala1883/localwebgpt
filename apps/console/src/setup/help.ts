/**
 * 本地启动帮助（LWB-035 步骤 3 的最后一项）。
 *
 * ## 这一层不是「使用说明」，是**故障时的下一步**
 *
 * 一段常驻在页面上的帮助文本会被读过一次，然后被忽略。因此这里的每一条
 * 都绑定一个**可判定的处境**（`HelpSituation`），由 `applicableHelp` 挑出来
 * —— 屏幕上出现的永远是「你现在这一种」。没有会话时讲「怎么重新拿一个地址」，
 * 读数过期时讲「睡眠唤醒之后要做什么」，两者不会同时出现。
 *
 * ## 三条**必须**与命令写在一起的话
 *
 * 1. 控制台地址里的 `#t=…` 是**一次性启动令牌**。用一次即失效，且它等同于
 *    密码 —— 这正是它只出现在 fragment 里、不进请求行的原因
 *    （`auth/bootstrap.ts` 的 strip-then-redeem）。因此帮助文本必须说
 *    「不要贴出去」，否则「把地址发给我看看」是操作者最自然的下一步。
 * 2. 浏览器本身不能把任意目录转换成本机绝对路径（方案 §10.1）：Windows 下由
 *    本机控制面打开系统选择窗口，其它情况仍可粘贴完整路径。
 * 3. 地址**整条**复制，包括 `#` 之后的全部：少了 fragment，页面会打开成一个
 *    没有会话的控制台，而它的表现是「什么都没法点」，不是「令牌错了」。
 *
 * ## 页面打不开时给出可操作的修复步骤
 *
 * `/` 与 `/index.html` 由 `npm run daemon` 的 pre-hook 先构建，再通过
 * daemon 的同源固定资产表托管。证据脚本直接调用 `startDaemon()` 时不注入
 * 静态资产，因此该装配用例里的两个地址仍返回 404；CLI 路径另由 LWB-039
 * 的启动器装配负责加载构建产物。
 *
 * | 路径 | 答什么 |
 * | --- | --- |
 * | `/` | **404** |
 * | `/index.html` | **404** |
 * | `/api/status` | 401（没有会话 —— 这正是它该做的） |
 *
 * 因此页面打不开时，帮助给出的步骤是重新运行仓库根目录的 `npm run console:dev`，
 * 由它重新构建并启动同源控制台；若 API 有响应而页面仍是 404，应检查控制台
 * 构建步骤是否报错，不需要重装或更改门禁。
 */

import type { SessionPresence } from '../changes/approval.ts';
import type { Freshness } from './readings.ts';

export type HelpId =
  | 'start_daemon'
  | 'open_console'
  | 'console_page_missing'
  | 'session_expired'
  | 'wake_and_reverify'
  | 'register_workspace'
  | 'emergency_pause';

export interface HelpEntry {
  readonly id: HelpId;
  readonly title: string;
  /** 一步步做。第一句是「什么时候用这一条」。 */
  readonly steps: readonly string[];
  /** 必须一起看到的一句警告；没有时为 `null`。 */
  readonly warning: string | null;
}

/** 一条都在这里。顺序就是操作者需要的顺序。 */
const ENTRIES: readonly HelpEntry[] = [
  {
    id: 'start_daemon',
    title: '启动本地服务',
    steps: [
      '在 Windows 上运行 `scripts/windows/Start-LocalWebGPT.ps1`；它会启动本地服务并自动打开默认浏览器。',
      '若使用 `npm run daemon`，服务会打印控制台地址，但不会自动启动 ChatGPT 隧道。',
      '它起来之后会打印「受保护存储根」与「控制台地址」两行 —— 这两行都要看一眼：',
      '  存储根是凭证与状态库所在的位置；它如果是「已被覆盖」的那一句，说明这次启动用的是 `LWB_HOME` / `--home` 指定的目录，不是你的受保护目录。',
      '  控制台地址是下一步要用的那一条。',
      '失败时它会说清楚失败在哪一步（身份、ACL、凭证、状态库、护栏），并且**不留下一个能进控制台的地址**。',
    ],
    warning:
      '不要用管理员身份运行。本项目不申请管理员权限：受保护目录的访问控制是给当前用户设的，提权运行会让那些判定失去意义。',
  },
  {
    id: 'open_console',
    title: '打开控制台',
    steps: [
      '运行 `scripts/windows/Start-LocalWebGPT.ps1` 时会自动打开默认浏览器；若使用 `npm run daemon`，把它打印的「控制台地址」整条复制到浏览器地址栏。',
      '它形如 `http://127.0.0.1:<端口>/#t=lwb_boot_…`：端口每次启动都可能不同，`#` 之后的令牌每次启动都不同。',
      '页面打开后地址栏里的 fragment 会被立刻抹掉（读取令牌 → 恢复或建立会话 → 清掉地址栏），这是设计如此，不是出错。',
    ],
    warning:
      '`#t=…` 是一次性接入令牌，等同于密码：**不要**贴到聊天、邮件、工单或截图里，也不要交给模型。要连接另一浏览器，请在已登录控制台点「连接其他浏览器」，并只把新链接交给自己的本地浏览器。',
  },
  {
    id: 'console_page_missing',
    title: '地址打开是 404 / 白页',
    steps: [
      '在仓库根目录运行 `npm run console:dev`。此命令先构建控制台，再从 daemon 的同源控制面提供页面和静态资源。',
      '启动日志出现控制台地址后，复制整条地址（包括 `#t=…`）。如果 `/api/status` 在未登录时返回 401，这是正常的会话保护。',
      '若页面仍为 404，检查控制台构建是否成功；daemon 不会从 URL 路径读取任意磁盘文件。',
    ],
    warning: null,
  },
  {
    id: 'session_expired',
    title: '会话过期了（或换了浏览器窗口）',
    steps: [
      '同一浏览器刷新页面会自动恢复会话；连接新浏览器时，在仍在线的控制台点击「连接其他浏览器」，再打开复制出的链接。',
      '会话期限可在「配置」页调整：空闲期限可关闭，绝对期限可配置为 1 分钟至 30 天。若所有浏览器都过期或已登出，请重新运行本地启动脚本。',
      '接入链接只能兑换一次，5 分钟后失效；需要多个浏览器时分别生成链接。',
      '已经批准过、正在执行的东西不会因为会话过期而回滚；需要停的时候用紧急停用。',
    ],
    warning: null,
  },
  {
    id: 'wake_and_reverify',
    title: '睡眠唤醒、断网之后',
    steps: [
      '先看界面上那一行「读数时刻」：它说的这一刻之后发生过什么，界面**不知道**。',
      '按「重新验证」再取一次读数。',
      '机器没有真的睡过、网络也没有断过时，这一次重新验证是秒回的；它不改变任何状态。',
      '若读数仍然取不到，按「打开控制台」那一条重新拿地址。',
    ],
    warning:
      '睡眠/断网期间界面上的绿色（如果有）只是**旧读数**。验收标准 3 要的正是这一点：停机、睡眠、断网不得显示成正常在线。',
  },
  {
    id: 'register_workspace',
    title: '登记一个目录',
    steps: [
      '在「工作区」页点击「浏览」选择本机目录或文件，或粘贴**完整本机路径**（例如从文件管理器地址栏复制）。',
      '选择「只读」或「读取 + 修改」。随后在该目录的「配置 ChatGPT 工具」里分别授予读取、文件修改或命令执行权限。命令执行需要单独勾选，只支持目录根，以本机用户权限运行；工作目录不是沙箱，不要对不可信请求者开放。',
      '登记本身不改动那个目录里的任何文件，也不代表内容立刻会被读走：只有连接启用且该目录获授对应工具后才会访问。',
    ],
    warning:
      'Windows 下「浏览」会打开系统选择窗口；其他平台或无法弹窗时，请手动填写完整路径。登记整块磁盘（如 `D:\\`）或用户主目录会扩大授权范围，请先阅读工作区页的范围说明。',
  },
  {
    id: 'emergency_pause',
    title: '紧急停用',
    steps: [
      '任何时候觉得不对，按「紧急停用」。它立即阻断读取、命令执行与应用，并停止在途命令、取消排队中的写操作。',
      '按下之后先看那几行事实：正在停的写入、已废止的授权、待恢复的操作、以及**已经交出去收不回来的内容**。',
      '处理完之后按「解除暂停」恢复。恢复不会自动重放被取消的写操作；如仍需修改，请重新提交操作。',
    ],
    warning:
      '暂停**不会**收回已经发出去的内容。它能收回的是回执，不是已经离开本机的字节 —— 所以「暂停」不等于「什么都没出去」。',
  },
];

/** 全部条目（界面上的「全部帮助」用）。返回的是只读快照，调用方改不到里面。 */
export function localStartHelp(): readonly HelpEntry[] {
  return ENTRIES.map((entry) => Object.freeze({ ...entry, steps: Object.freeze([...entry.steps]) }));
}

/** 判定该给操作者看哪几条时用得上的处境。 */
export interface HelpSituation {
  readonly session: SessionPresence | null;
  readonly session_expired?: boolean;
  readonly daemon_freshness: Freshness;
}

/**
 * 按处境挑出**该显示的那几条**。
 *
 * 判据是「他现在卡在哪一步」，而不是「有哪些话题」：
 *
 * | 处境 | 给哪几条 |
 * | --- | --- |
 * | 没有会话 | 启动服务 → 打开控制台 → （可能是 404）|
 * | 会话过期 | 会话过期 → 启动服务 |
 * | 读数是旧的或缺的 | 睡眠唤醒之后 |
 * | 一切正常 | **一条都不给** —— 常驻的帮助文本会被读过一次然后被忽略 |
 *
 * 最后一行是这一层的重点：真正「一切正常」时，屏幕上不该有帮助。
 * 一段永远在那里的说明，会让下面真正重要的那一条也变成背景。
 */
export function applicableHelp(situation: HelpSituation): readonly HelpEntry[] {
  const all = localStartHelp();
  const pick = (...ids: readonly HelpId[]): readonly HelpEntry[] =>
    ids
      .map((id) => all.find((entry) => entry.id === id))
      .filter((entry): entry is HelpEntry => entry !== undefined);

  if (situation.session === null) {
    return situation.session_expired === true
      ? pick('session_expired', 'start_daemon')
      : pick('start_daemon', 'open_console', 'console_page_missing');
  }

  if (situation.daemon_freshness !== 'fresh') {
    return pick('wake_and_reverify');
  }

  return [];
}
