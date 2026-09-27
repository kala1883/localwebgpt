/**
 * 相对路径校验的**共享用例语料**（LWB-010 步骤 1）。
 *
 * ## 这份数据解决什么问题
 *
 * 路径语法规则有两份实现，且**必须**有两份：
 *   - `packages/contracts/src/path.ts` —— 调用方（daemon）侧，用于快速失败；
 *   - `native/winfs/path_guard/RelativePath.ps1` —— 护栏侧，因为护栏是独立
 *     进程，它的边界是它自己打开的那个句柄，不能假定调用方检查过什么。
 *
 * 两份实现会漂移。处置方式不是「小心一点」，而是让**同一份数据**分别喂给
 * 两侧，逐例断言结论与理由完全一致（见
 * `tests/windows/path-escape/relative-path-parity.test.ts`）。
 * 任何一侧被改松或改紧，那个测试立刻变红。
 *
 * 因此本文件是**唯一事实来源**：改规则必须改这里，只改一侧实现是过不了测试的。
 *
 * ## 为什么每条都写了 `why`
 *
 * 「拒绝了一个怪字符串」这件事本身没有价值 —— 有价值的是知道**它在防什么**。
 * 没有 `why` 的用例会变成不可删除的化石：没人敢动，也没人知道动了会怎样。
 *
 * ## 语料里的路径分隔符写法是刻意的
 *
 * 用例同时包含 `/` 与 `\` 两种写法。模型很可能给出 Windows 风格的反斜杠，
 * 而两份实现都是「先统一分隔符再判断」，因此反斜杠形式必须与斜杠形式
 * 得出**同一个理由**，而不是「反正都拒了」。
 */

import type { PathRejectReason } from '@lwb/contracts';

export interface CorpusCase {
  /** 用例名。失败时直接显示，必须自解释。 */
  readonly name: string;
  /**
   * 喂给两份实现的输入。
   *
   * 故意声明为 `unknown`：非字符串输入（`null`、数字、数组）也是验收面的一部分，
   * 而类型的意图正是「调用方什么都可能给」。
   */
  readonly input: unknown;
  /** 期望结论：`null` 表示应当被接受；否则是期望的拒绝理由。 */
  readonly reason: PathRejectReason | null;
  /** 被接受时的期望规范化路径（统一 `/` 分隔）。拒绝时忽略。 */
  readonly normalized?: string;
  /** 被接受时的期望分段结果。 */
  readonly segments?: readonly string[];
  /** 这个用例在防什么。没写清楚就说明还没想清楚。 */
  readonly why: string;
}

const A64 = 'a'.repeat(64);
const SEG255 = 'a'.repeat(255);
const SEG256 = 'a'.repeat(256);

/** 16 段 × 64 字符 + 15 个分隔符 = 1039 字符，越过 1024 上限。 */
const TOO_LONG_PATH = Array.from({ length: 16 }, () => A64).join('/');
/** 15 段 × 64 字符 + 14 个分隔符 = 974 字符，在上限之内。 */
const LONG_BUT_OK_PATH = Array.from({ length: 15 }, () => A64).join('/');
/** 65 段 = 129 字符，长度没问题，深度有问题。 */
const TOO_DEEP_PATH = Array.from({ length: 65 }, () => 'a').join('/');
/** 64 段 = 127 字符，正好在深度上限上。 */
const DEPTH_LIMIT_PATH = Array.from({ length: 64 }, () => 'a').join('/');

export const PATH_CORPUS: readonly CorpusCase[] = [
  // ---------------------------------------------------------------------
  // 非字符串：调用方可能给任何东西
  // ---------------------------------------------------------------------
  {
    name: 'null',
    input: null,
    reason: 'NOT_A_STRING',
    why: 'JSON 里字段缺失会变成 null；null 不能被当成空路径，否则「省略路径」会静默变成「工作区根」。',
  },
  {
    name: 'undefined',
    input: undefined,
    reason: 'NOT_A_STRING',
    why: '同上，TypeScript 里省略可选字段。序列化后与 null 等价，两侧理由必须一致。',
  },
  {
    name: '数字 42',
    input: 42,
    reason: 'NOT_A_STRING',
    why: '「文件 42」与「文件 \"42\"」是两个不同的名字，隐式转换会让我们打开的不是调用方说的那个。',
  },
  {
    name: '数组 ["a.txt"]',
    input: ['a.txt'],
    reason: 'NOT_A_STRING',
    why: '数组会被 JS 的字符串拼接静默变成 "a.txt" —— 正是「调用方给的和我们用的不是同一个东西」。',
  },
  {
    name: '对象 {a:1}',
    input: { a: 1 },
    reason: 'NOT_A_STRING',
    why: '对象拼接会得到 "[object Object]"，一个既合法又荒诞的文件名。',
  },

  // ---------------------------------------------------------------------
  // 不可见字符：比控制字符更隐蔽的同类问题
  // ---------------------------------------------------------------------
  {
    name: 'U+FEFF（BOM / 零宽不换行空格）单独出现',
    input: '\uFEFF',
    reason: 'INVISIBLE_CHAR',
    why:
      '两侧实现曾在这里给出**不同**答案：JS 的 trim() 把 U+FEFF 当空白，得到 EMPTY；' +
      '.NET 的 char.IsWhiteSpace 不当空白，于是放行。本条把它钉成同一个理由。',
  },
  {
    name: 'a\\u200Bb（零宽空格）',
    input: 'a\u200Bb',
    reason: 'INVISIBLE_CHAR',
    why: '显示为 "ab"，磁盘上是 "a\\u200Bb" —— 两个不同文件在日志、证据、批准界面里长得一模一样。',
  },
  {
    name: 'a\\u202Eb.txt（RTL 覆盖）',
    input: 'a\u202Eb.txt',
    reason: 'INVISIBLE_CHAR',
    why: '经典伪装：RTL 覆盖让 "a\\u202Eb.txt" 显示成 "atxt.b"，用户批准看到的与打开的不是同一个名字。',
  },
  {
    name: 'a\\u00ADb（软连字符）',
    input: 'a\u00ADb',
    reason: 'INVISIBLE_CHAR',
    why: '软连字符在多数界面上不显示，但确实是文件名的一部分。',
  },
  {
    name: 'a\\u2028b（行分隔符）',
    input: 'a\u2028b',
    reason: 'INVISIBLE_CHAR',
    why: 'JS trim() 把它当行终止符、.NET 当空白，两侧的「空路径」判断会分叉；同时它能让一条路径在日志里断成两行。',
  },
  {
    name: 'a\\u2066b（双向隔离符）',
    input: 'a\u2066b',
    reason: 'INVISIBLE_CHAR',
    why: '与 RTL 覆盖同类，用于操纵显示顺序。',
  },

  // ---------------------------------------------------------------------
  // 空
  // ---------------------------------------------------------------------
  {
    name: '空字符串',
    input: '',
    reason: 'EMPTY',
    why: '空相对路径对不同调用点含义不同（有的当「根本身」）；不接受，要求显式表达意图。',
  },
  {
    name: '三个空格',
    input: '   ',
    reason: 'EMPTY',
    why: 'Win32 会剥掉段尾空格，所以「全是空格」和空字符串在磁盘上是同一个东西。',
  },
  {
    name: '制表符',
    input: '\t',
    reason: 'EMPTY',
    why: '控制字符与空白的交叉：剥掉空白后为空。顺序上先判空，理由才是准确的 EMPTY 而非 CONTROL_CHAR。',
  },
  {
    name: 'U+00A0（不换行空格）',
    input: '\u00A0',
    reason: 'EMPTY',
    why: 'JS 与 .NET 都把 NBSP 当空白 —— 这条用来确认两侧的 trim 语义在非 ASCII 空白上仍然一致。',
  },

  // ---------------------------------------------------------------------
  // 长度与深度
  // ---------------------------------------------------------------------
  {
    name: '1025 个 a（超过 1024 字符上限）',
    input: 'a'.repeat(1025),
    reason: 'TOO_LONG',
    why: '长度检查排在分段检查之前，所以这里必须是 TOO_LONG 而不是 SEGMENT_TOO_LONG。',
  },
  {
    name: '1039 字符的合法分段路径',
    input: TOO_LONG_PATH,
    reason: 'TOO_LONG',
    why: '每一段都合法（64 字符）、深度也合法（16 级），只有总长超标 —— 单独验证长度这一条规则。',
  },
  {
    name: '974 字符的 15 级路径（合法）',
    input: LONG_BUT_OK_PATH,
    reason: null,
    normalized: LONG_BUT_OK_PATH,
    segments: Array.from({ length: 15 }, () => A64),
    why: '长路径的另一侧边界：接近上限但没越过，必须仍然被接受，否则规则就不是「上限 1024」而是别的。',
  },
  {
    name: '256 个 a 的单段',
    input: SEG256,
    reason: 'SEGMENT_TOO_LONG',
    why: '单段上限 255（NTFS 组件上限），与总长上限是两个独立的限制。',
  },
  {
    name: '255 个 a 的单段（合法）',
    input: SEG255,
    reason: null,
    normalized: SEG255,
    segments: [SEG255],
    why: '段长上限的边界另一侧。',
  },
  {
    name: '65 级 a/a/.../a',
    input: TOO_DEEP_PATH,
    reason: 'TOO_DEEP',
    why: '深度上限。超出后 Win32 的长路径支持会拒绝，与其在更深的地方炸，不如在这里说清楚。',
  },
  {
    name: '64 级 a/a/.../a（合法）',
    input: DEPTH_LIMIT_PATH,
    reason: null,
    normalized: DEPTH_LIMIT_PATH,
    segments: Array.from({ length: 64 }, () => 'a'),
    why: '深度上限的边界另一侧。',
  },

  // ---------------------------------------------------------------------
  // 控制字符
  // ---------------------------------------------------------------------
  {
    name: 'a\\u0000b（NUL）',
    input: 'a\u0000b',
    reason: 'CONTROL_CHAR',
    why: 'C 字符串语义下截断成 "a"，于是「检查的名字」与「打开的名字」不是同一个 —— 最经典的路径混淆。',
  },
  {
    name: 'a\\u007Fb（DEL）',
    input: 'a\u007fb',
    reason: 'CONTROL_CHAR',
    why: '不可打印但既不是 C0 也不是空白的字符，单独列出来确认 0x7F 也在范围内。',
  },
  {
    name: 'a\\nb（换行）',
    input: 'a\nb',
    reason: 'CONTROL_CHAR',
    why: '能让一条路径在按行传输/记录的协议里断成两条。',
  },
  {
    name: 'a\\tb（制表符在中间）',
    input: 'a\tb',
    reason: 'CONTROL_CHAR',
    why: '与单独的制表符区分：那个剥掉空白后为空（EMPTY），这个不是。',
  },

  // ---------------------------------------------------------------------
  // 设备命名空间 / UNC / 绝对路径 / 盘符
  // ---------------------------------------------------------------------
  {
    name: '\\\\?\\D:\\x',
    input: '\\\\?\\D:\\x',
    reason: 'DEVICE_NAMESPACE',
    why:
      '设备命名空间绕过 Win32 的全部路径规范化 —— 段尾的点与空格不再被剥、' +
      '".." 不再被解析。必须优先于 UNC 判断，否则会被误报成 UNC（也以 \\\\ 开头）。',
  },
  {
    name: '\\\\.\\PhysicalDrive0',
    input: '\\\\.\\PhysicalDrive0',
    reason: 'DEVICE_NAMESPACE',
    why: 'Win32 设备命名空间可以打开物理设备本身，不只是文件。',
  },
  {
    name: '\\??\\C:\\x',
    input: '\\??\\C:\\x',
    reason: 'DEVICE_NAMESPACE',
    why: 'NT 对象管理器前缀，是 \\\\?\\ 的底层形式，同样绕过规范化。',
  },
  {
    name: '\\\\?\\UNC\\server\\share',
    input: '\\\\?\\UNC\\server\\share',
    reason: 'DEVICE_NAMESPACE',
    why: '设备命名空间形式的 UNC。若判断顺序反过来，这条会得到 UNC 而不是 DEVICE_NAMESPACE —— 两条都拒，但理由必须稳定。',
  },
  {
    name: '//?/D:/x（正斜杠形式的设备命名空间）',
    input: '//?/D:/x',
    reason: 'UNC',
    why: '正斜杠形式落进 UNC 分支而不是 DEVICE_NAMESPACE。仍然被拒；本条把「落在哪个理由上」钉住，避免以后有人「顺手统一」时改了行为却没人发现。',
  },
  {
    name: '\\\\server\\share\\f.txt',
    input: '\\\\server\\share\\f.txt',
    reason: 'UNC',
    why: 'UNC 指向另一台机器：那条路径上的对象不受本机策略与卷身份约束。',
  },
  {
    name: '//server/share/f.txt',
    input: '//server/share/f.txt',
    reason: 'UNC',
    why: '正斜杠形式的 UNC，确认分隔符统一之前就已拦住。',
  },
  {
    name: '\\Windows\\System32',
    input: '\\Windows\\System32',
    reason: 'ABSOLUTE',
    why: '单反斜杠开头是「当前盘符的绝对路径」，不是相对路径。',
  },
  {
    name: '/etc/passwd',
    input: '/etc/passwd',
    reason: 'ABSOLUTE',
    why: '正斜杠开头同样按绝对路径处理 —— 不允许存在「看起来像相对路径」的歧义形式。',
  },
  {
    name: 'C:\\Windows',
    input: 'C:\\Windows',
    reason: 'DRIVE_LETTER',
    why: '盘符绝对路径。',
  },
  {
    name: 'C:x（盘符相对）',
    input: 'C:x',
    reason: 'DRIVE_LETTER',
    why: '"C:x" 是「C 盘的当前目录下的 x」—— 当前目录不属于任何工作区，无法用工作区根证明其安全性。',
  },
  {
    name: 'c:/x',
    input: 'c:/x',
    reason: 'DRIVE_LETTER',
    why: '小写 + 正斜杠的盘符形式，确认大小写与分隔符都不影响判断。',
  },

  // ---------------------------------------------------------------------
  // ADS 与非法字符
  // ---------------------------------------------------------------------
  {
    name: 'a.txt:secret（ADS）',
    input: 'a.txt:secret',
    reason: 'ADS_COLON',
    why:
      '备用数据流的内容与主文件不是同一个东西，但基于路径字符串的策略比对会认为它们是。' +
      '允许它就等于允许「读过基线、写进另一个流」。',
  },
  {
    name: 'dir\\a.txt:$DATA',
    input: 'dir\\a.txt:$DATA',
    reason: 'ADS_COLON',
    why: 'ADS 的显式 $DATA 形式。',
  },
  {
    name: 'a:b（单字母段 + 冒号）',
    input: 'a:b',
    reason: 'DRIVE_LETTER',
    why: '盘符判断在统一分隔符与冒号判断之前，因此这条落在 DRIVE_LETTER 而不是 ADS_COLON。两条都拒；本条固定理由归属。',
  },
  {
    name: 'a<b.txt',
    input: 'a<b.txt',
    reason: 'INVALID_CHAR',
    why: 'Windows 文件名非法字符。',
  },
  {
    name: 'a>b.txt',
    input: 'a>b.txt',
    reason: 'INVALID_CHAR',
    why: '同上，单独列出以确认字符集每一项都在。',
  },
  {
    name: 'a"b.txt',
    input: 'a"b.txt',
    reason: 'INVALID_CHAR',
    why: '同上。双引号还会与「JSON 里再包一层」的调用方式互相纠缠。',
  },
  {
    name: 'a|b.txt',
    input: 'a|b.txt',
    reason: 'INVALID_CHAR',
    why: '同上。竖线在 shell 语境里还有管道含义。',
  },
  {
    name: 'a?b.txt',
    input: 'a?b.txt',
    reason: 'INVALID_CHAR',
    why: '通配符：如果路径被继续传给任何做模式匹配的层，含义就不再是字面路径。',
  },
  {
    name: 'a*b.txt',
    input: 'a*b.txt',
    reason: 'INVALID_CHAR',
    why: '同上。',
  },
  {
    name: 'a<b/c.txt（非法字符在中间段）',
    input: 'a<b/c.txt',
    reason: 'INVALID_CHAR',
    why: '非法字符检查在**整串**上做，不在分段之后 —— 因此不依赖「它在第几段」。',
  },

  // ---------------------------------------------------------------------
  // 尾分隔符 / 空段 / 点段
  // ---------------------------------------------------------------------
  {
    name: 'dir/',
    input: 'dir/',
    reason: 'TRAILING_SEPARATOR',
    why: '尾部分隔符让「同一个对象」有两种写法，段解析也会多出一个空段。',
  },
  {
    name: 'dir\\',
    input: 'dir\\',
    reason: 'TRAILING_SEPARATOR',
    why: '反斜杠形式：统一之后再判断，因此与上一例同一个理由。',
  },
  {
    name: 'a//b',
    input: 'a//b',
    reason: 'EMPTY_SEGMENT',
    why: '连续分隔符。若被静默折叠，"a//b" 与 "a/b" 会是两个不同的输入指向同一个对象。',
  },
  {
    name: 'a/\\b',
    input: 'a/\\b',
    reason: 'EMPTY_SEGMENT',
    why: '两种分隔符混用产生的空段 —— 只有先统一才能看出来。',
  },
  {
    name: '.',
    input: '.',
    reason: 'DOT_SEGMENT',
    why: '"." 是「当前目录」，它不是一个工作区内的名字。',
  },
  {
    name: './a',
    input: './a',
    reason: 'DOT_SEGMENT',
    why: '前缀 "." 只是写法噪音，不接受。',
  },
  {
    name: 'a/./b',
    input: 'a/./b',
    reason: 'DOT_SEGMENT',
    why: '中间段也一样。',
  },

  // ---------------------------------------------------------------------
  // 上跳
  // ---------------------------------------------------------------------
  {
    name: '..',
    input: '..',
    reason: 'PARENT_REF',
    why: '上跳是工作区逃逸的基本形态。这是整个规则集里最不能放过的一条。',
  },
  {
    name: '../a',
    input: '../a',
    reason: 'PARENT_REF',
    why: '前导上跳。',
  },
  {
    name: 'a/../b',
    input: 'a/../b',
    reason: 'PARENT_REF',
    why:
      '中间上跳。注意：即使 "a/.." 化简后回到根、看起来「无害」，也一律拒绝 —— ' +
      '接受化简就等于要求每一层都做同样的化简，而每一层都做对才是那个做不到的假设。',
  },
  {
    name: 'a\\..\\b',
    input: 'a\\..\\b',
    reason: 'PARENT_REF',
    why: '反斜杠形式的上跳。仅靠"以 .. 开头"的检查会漏掉它。',
  },
  {
    name: '...（三个点）',
    input: '...',
    reason: 'TRAILING_DOT_OR_SPACE',
    why: '它不是 ".."（因此不是 PARENT_REF），但以点结尾会被 Win32 剥成 ".." —— 于是看起来无害的输入变成了上跳。理由归属必须是 TRAILING_DOT_OR_SPACE。',
  },
  {
    name: 'a/../（上跳 + 尾分隔符）',
    input: 'a/../',
    reason: 'TRAILING_SEPARATOR',
    why: '尾分隔符检查在分段之前，因此这条先命中 TRAILING_SEPARATOR。两条都拒；本条固定顺序。',
  },

  // ---------------------------------------------------------------------
  // 段尾的点与空格 —— Win32 会静默剥掉它们
  // ---------------------------------------------------------------------
  {
    name: 'a. ',
    input: 'a. ',
    reason: 'TRAILING_DOT_OR_SPACE',
    why: 'Win32 打开时会剥掉段尾的点和空格，"a. " 与 "a" 是同一个对象 —— 检查的字符串与实际打开的对象不是同一个。',
  },
  {
    name: 'a.',
    input: 'a.',
    reason: 'TRAILING_DOT_OR_SPACE',
    why: '同上，只有点。',
  },
  {
    name: 'a （尾空格）',
    input: 'a ',
    reason: 'TRAILING_DOT_OR_SPACE',
    why: '同上，只有空格。注意它不是 EMPTY —— 整串 trim 之后还剩 "a"。',
  },
  {
    name: 'dir /a（中间段尾空格）',
    input: 'dir /a',
    reason: 'TRAILING_DOT_OR_SPACE',
    why: '中间段的尾空格同样被剥，"dir " 与 "dir" 指向同一目录。只检查最后一段的写法会漏掉这条。',
  },
  {
    name: 'dir./a（中间段尾点）',
    input: 'dir./a',
    reason: 'TRAILING_DOT_OR_SPACE',
    why: '中间段的尾点。',
  },

  // ---------------------------------------------------------------------
  // 保留设备名
  // ---------------------------------------------------------------------
  {
    name: 'CON',
    input: 'CON',
    reason: 'RESERVED_NAME',
    why: '保留名：其含义取决于 Win32 的设备名解析，而不取决于磁盘上有什么。',
  },
  {
    name: 'con.txt',
    input: 'con.txt',
    reason: 'RESERVED_NAME',
    why: '按「第一个点之前」取基名再比较，所以带扩展名也拦得住。',
  },
  {
    name: 'dir/NUL',
    input: 'dir/NUL',
    reason: 'RESERVED_NAME',
    why:
      '实测（Windows 11 26200）：CreateFileW("C:\\\\<dir>\\\\NUL", GENERIC_WRITE, CREATE_ALWAYS) ' +
      '返回**有效句柄且 err=0**，WriteFile 报告写入 33 字节且成功，而磁盘上**什么都没有创建**。' +
      '放行这一条就等于让"已保存"的回执建立在一个被静默丢弃的写入上（违反 I14）。',
  },
  {
    name: 'COM1.log',
    input: 'COM1.log',
    reason: 'RESERVED_NAME',
    why: '设备名列表里带序号的成员。',
  },
  {
    name: 'LPT9',
    input: 'LPT9',
    reason: 'RESERVED_NAME',
    why: '同上，打印机端口。',
  },
  {
    name: 'CLOCK$',
    input: 'CLOCK$',
    reason: 'RESERVED_NAME',
    why: '保留名列表里的非 COM/LPT 成员，确认列表不是只由循环生成的。',
  },
  {
    name: 'CONIN$',
    input: 'CONIN$',
    reason: 'RESERVED_NAME',
    why: '控制台输入设备。',
  },
  {
    name: 'nul（小写）',
    input: 'nul',
    reason: 'RESERVED_NAME',
    why: 'NTFS 大小写不敏感，设备名解析也是 —— 比较必须大写归一。',
  },
  {
    name: 'COM10（不在保留名列表中）',
    input: 'COM10',
    reason: null,
    normalized: 'COM10',
    segments: ['COM10'],
    why:
      '上界的另一侧：保留名只有 COM1..COM9。这条同时记录一个**已知边界**：' +
      'COM0/LPT0 也不在列表里（实测它们在本机既不是设备、也能像普通文件一样创建），' +
      '因此列表是「历史上被设备解析器认过的名字」的保守集合，而不是「当前系统上仍然是设备的名字」。',
  },

  // ---------------------------------------------------------------------
  // 合法路径
  // ---------------------------------------------------------------------
  {
    name: 'a.txt',
    input: 'a.txt',
    reason: null,
    normalized: 'a.txt',
    segments: ['a.txt'],
    why: '最小合法用例。整个规则集存在的意义是让这一条继续通过。',
  },
  {
    name: 'dir/sub/file.txt',
    input: 'dir/sub/file.txt',
    reason: null,
    normalized: 'dir/sub/file.txt',
    segments: ['dir', 'sub', 'file.txt'],
    why: '多层正斜杠。',
  },
  {
    name: 'dir\\sub\\file.txt（反斜杠）',
    input: 'dir\\sub\\file.txt',
    reason: null,
    normalized: 'dir/sub/file.txt',
    segments: ['dir', 'sub', 'file.txt'],
    why: '反斜杠输入必须**规范化**成正斜杠，而不是原样保留 —— 下游的分段与身份判定都以规范形式为准。',
  },
  {
    name: '文档/设计说明.md',
    input: '文档/设计说明.md',
    reason: null,
    normalized: '文档/设计说明.md',
    segments: ['文档', '设计说明.md'],
    why: '非 ASCII 路径必须原样通过：规则针对的是混淆字符，不是非英文。这也是管道 UTF-8 编码的一次实测。',
  },
  {
    name: 'a b.txt（中间空格）',
    input: 'a b.txt',
    reason: null,
    normalized: 'a b.txt',
    segments: ['a b.txt'],
    why: '段**中间**的空格是合法文件名字符，只有段尾的才会被 Win32 剥掉。规则不能宽到把这一条也拒了。',
  },
  {
    name: '.gitignore',
    input: '.gitignore',
    reason: null,
    normalized: '.gitignore',
    segments: ['.gitignore'],
    why: '基名（第一个点之前）是空字符串，不能因此被当成保留名或点段。',
  },
  {
    name: 'a.b.c.txt',
    input: 'a.b.c.txt',
    reason: null,
    normalized: 'a.b.c.txt',
    segments: ['a.b.c.txt'],
    why: '多个点的普通文件。',
  },
  {
    name: 'sub/.env.example',
    input: 'sub/.env.example',
    reason: null,
    normalized: 'sub/.env.example',
    segments: ['sub', '.env.example'],
    why:
      '语法层必须放行它。.env.example 应不应该被读是**策略**问题（并且按方案它不被自动豁免），' +
      '不是语法问题 —— 把策略塞进语法层会让两条规则互相掩盖。',
  },
];

/** 被接受的用例（供只想跑正向用例的测试使用）。 */
export const ACCEPTED_CASES: readonly CorpusCase[] = PATH_CORPUS.filter((c) => c.reason === null);

/** 被拒绝的用例（供只想跑负向用例的测试使用）。 */
export const REJECTED_CASES: readonly CorpusCase[] = PATH_CORPUS.filter((c) => c.reason !== null);
