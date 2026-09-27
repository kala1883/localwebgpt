/**
 * 规范化修改集摘要与请求指纹（LWB-020）。
 *
 * ## 摘要是什么、不是什么
 *
 * 摘要是**一个修改集全部可写效果的规范化指纹**。批准在数据库里绑定的是它
 * （`approvals.digest`，见迁移 v1），因此「人批准的是哪一份修改」这个问题
 * 的答案最终落在这一串十六进制上。两件事随此而来：
 *
 *  1. **它必须覆盖一切会落到用户磁盘上的东西。** 路径、操作、基线哈希、
 *     结果哈希、结果尺寸、编码、换行、BOM —— 少覆盖任何一项，就存在两个
 *     **不同效果**拥有同一摘要的可能，而那时一次批准会同时授权两者。
 *  2. **它必须能被重算。** 批准发生在 prepare 之后、执行发生在批准之后，
 *     中间隔着一次数据库往返。执行前必须能从**落库的事实**重算出同一个
 *     摘要并比对；算不出来（或只能靠内存里的对象）就意味着「批准绑定」
 *     这句话在跨进程、跨重启时不成立。
 *
 * ## 覆盖的是**效果**，不是提案文本
 *
 * 这是本模块最重要的一条取舍。摘要里**没有**：
 *
 *  - `summary` —— 模型撰写的不受信文案（契约明文规定它只能展示）。把它算进
 *    摘要，等于让一段不受信的散文参与「人批准了什么」的判定，而且两次效果
 *    完全相同、措辞不同的提议会得到两个摘要。
 *  - `read_token` —— 服务端签发的授权凭证，带 `issued_at` / `expires_at`。
 *    它证明的是「这次修改凭哪一次读取获准」，不是「要写什么」；同一个提案
 *    在不同时刻重放必然带不同的令牌，把它算进去会让「同一请求」在时间轴上
 *    不是一个常量。
 *  - `added_lines` / `removed_lines` —— 由两份字节推导出的展示统计。它们是
 *    **事实的函数**，而不是新的事实：覆盖了 `before_sha256` / `after_sha256`
 *    就已经覆盖了它们赖以成立的全部输入。
 *  - `idempotency_key` —— 它是**查询键**（「这个键上次算出了什么」），
 *    不是内容。两个不同的键带着同样的内容，得到的应当是同样的摘要。
 *
 * 换来的是：**摘要可以完全由 `changesets` + `change_items` + `blobs.size`
 * 重建**，而且它精确地等于「预览里除增量行数以外的每一个字段」。
 *
 * ## 序列化：长度前缀，不是分隔符拼接
 *
 * 字段之间用 `\n` 分隔，但每个字段写成 `<长度>:<原文>`。理由不是洁癖：
 * 请求指纹里装的是**行文本与文件内容本身**（`old_lines` / `new_lines` /
 * `content`），那是任意文本 —— 含着制表符、冒号、换行都是正常的。
 * 用 `\t` 或 `\n` 直接分隔字段，在遇到一段含该字符的内容时会把两个不同的
 * 请求序列化成同一串字节：那不是碰撞概率问题，是构造出来的确定性碰撞。
 * 长度前缀让解析无歧义 —— 长度是数字，数字后紧跟 `:`，其余按长度取。
 *
 * （修改集摘要那一侧的字段都受过 `validateRelativePath` 与哈希约束，
 * 形态本就受限；两侧仍用同一套编码，因为「这一处安全所以不必小心」
 * 正是编码规范开始腐化的方式。）
 *
 * `null` 写成 `~`：`<长度>:` 形式必然以数字开头，因此 `~` 不可能与任何
 * 字段值混淆。`bom` 写 `1` / `0` 而不是布尔字面量，避免依赖运行时
 * `String(true)` 的实现细节。
 *
 * 长度按 **UTF-16 码元**计（JS 的 `String#length`）。这是刻意的：本工程内
 * 所有重算都走同一个函数，跨实现的可移植性不是需求 —— 需求是**同一实现
 * 在任何时刻对同一事实给出同一串字节**。
 */

import { createHash } from 'node:crypto';

import type { ChangeOp, FileEncoding, NewlineStyle } from '@lwb/contracts';

/**
 * 域分隔串。
 *
 * 版本号写在串里而不是只写在代码注释里：摘要落库后长期存在，而将来若
 * 规范化的方式需要变（例如多出必须覆盖的字段），旧摘要必须能被识别为
 * 「另一种规范」而不是与新摘要混在同一个值域里比较。改这个串等于宣布
 * 「此前所有摘要作废」，这会是一次显式的、有代价的决定。
 */
export const CHANGE_DIGEST_DOMAIN = 'lwb.change.digest.v1';

/** 请求指纹的域分隔串。与摘要分开，两者不可互相冒充。 */
export const CHANGE_REQUEST_DOMAIN = 'lwb.change.request.v1';

/**
 * 摘要覆盖的单个文件。**是 `ChangeFilePreview` 的结构子集**，
 * 因此预览对象可以直接传进来 —— 覆盖的字段与界面显示的字段因此
 * 不可能各写一份而悄悄漂移。
 */
export interface ChangeDigestFile {
  readonly path: string;
  readonly op: ChangeOp;
  /** 修改前整个文件原始字节哈希；`create_text` 为 null。 */
  readonly before_sha256: string | null;
  readonly before_size: number;
  readonly after_sha256: string;
  readonly after_size: number;
  readonly encoding: FileEncoding;
  readonly newline: NewlineStyle;
  readonly bom: boolean;
}

export interface ChangeDigestInput {
  /**
   * 契约版本。摘要的形状由契约决定，因此契约变了，旧摘要不应再被当作
   * 可比的量。
   */
  readonly contract_version: string;
  /**
   * 策略版本。同一次修改在不同的策略下可能有不同的裁定
   * （例如上限被调小），批准绑定的正是「哪个策略版本下算出的这份修改」。
   */
  readonly policy_version: number;
  /** 修改集建立时工作区根的代次。重定位 / 重新授权之后代次递增。 */
  readonly root_generation: number;
  readonly workspace_id: string;
  readonly files: readonly ChangeDigestFile[];
}

/** 把任意字段编成无歧义的一段。`null` 是 `~`，其余是 `<长度>:<原文>`。 */
function field(value: string | number | boolean | null): string {
  if (value === null) return '~';
  const text = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
  return `${text.length}:${text}`;
}

/**
 * 规范化序列化。导出是为了让「摘要到底覆盖了什么」可以被直接检验 ——
 * 一条断言「改了 X 之后摘要变了」的测试，比一条断言「摘要不等于某个常量」
 * 的测试更能说明问题，而前者需要一个可读的中间产物。
 *
 * **不得**把这个串本身当作安全凭证或对外输出：它是内部规范化形式，
 * 其中的字段值（路径、哈希）与摘要同权，但没有任何结构保证它不会
 * 在将来为了可读性而改名。凭证是 `canonicalChangeDigest` 的返回值。
 */
export function canonicalizeChangeDigest(input: ChangeDigestInput): string {
  const lines: string[] = [CHANGE_DIGEST_DOMAIN];

  lines.push(`contract_version ${field(input.contract_version)}`);
  lines.push(`policy_version ${field(input.policy_version)}`);
  lines.push(`root_generation ${field(input.root_generation)}`);
  lines.push(`workspace_id ${field(input.workspace_id)}`);
  lines.push(`file_count ${field(input.files.length)}`);

  // 顺序按调用方给定的次序（即 `seq`），不排序。排序会让「条的次序变了」
  // 这件事在摘要里消失，而次序不是无关紧要的展示细节：它是逐文件结果的
  // 回执次序，也是人工核对时读下来的次序。
  for (const file of input.files) {
    lines.push(`file ${field(file.op)}`);
    lines.push(`path ${field(file.path)}`);
    lines.push(`before_sha256 ${field(file.before_sha256)}`);
    lines.push(`before_size ${field(file.before_size)}`);
    lines.push(`after_sha256 ${field(file.after_sha256)}`);
    lines.push(`after_size ${field(file.after_size)}`);
    lines.push(`encoding ${field(file.encoding)}`);
    lines.push(`newline ${field(file.newline)}`);
    lines.push(`bom ${field(file.bom)}`);
  }

  // 末尾补一个空行，让最后一项也有终止符：否则「文件数」与「最后一个字段」
  // 之间不存在边界，`files: [x]` 与「把 x 的内容并进下一次序列化」不可区分。
  return `${lines.join('\n')}\n`;
}

/** sha256 十六进制。批准绑定的是这个值。 */
export function canonicalChangeDigest(input: ChangeDigestInput): string {
  return createHash('sha256').update(canonicalizeChangeDigest(input), 'utf8').digest('hex');
}

/**
 * 供人眼比对的短核对编号。
 *
 * **不是安全凭证**，也不得用于任何判定：它只有 32 位可见字符，
 * 且刻意只取摘要前缀（因此同一摘要永远给出同一个编号，人比的是
 * 「屏幕上这两处是不是同一个东西」）。任何「本地界面提交短编号、
 * 服务端据它放行」的做法都等于把摘要截短成 32 位再当凭证用。
 * 放行必须重新加载修改集并比对**完整摘要**。
 *
 * 用 `-` 分组而不是纯 8 位：人眼比对时 4+4 的分组比一串 8 位更容易
 * 逐段确认，而这正是它唯一的功能。
 */
export function shortCodeOf(digest: string): string {
  const head = digest.slice(0, 8).toUpperCase();
  return `${head.slice(0, 4)}-${head.slice(4)}`;
}

// ---------------------------------------------------------------------------
// 请求指纹
// ---------------------------------------------------------------------------

/** 一次 `edit_text` 项的请求指纹输入。字段与契约里的同名项一一对应。 */
export interface RequestEditTextItem {
  readonly op: 'edit_text';
  readonly path: string;
  readonly base_sha256: string;
  readonly edits: readonly {
    readonly start_line: number;
    readonly end_line_exclusive: number;
    readonly old_lines: readonly string[];
    readonly new_lines: readonly string[];
  }[];
}

export interface RequestCreateTextItem {
  readonly op: 'create_text';
  readonly path: string;
  readonly content: string;
  readonly newline: string;
  readonly bom: boolean;
}

export interface RequestReplaceTextItem {
  readonly op: 'replace_text';
  readonly path: string;
  readonly base_sha256: string;
  readonly content: string;
}

export type RequestItem = RequestEditTextItem | RequestCreateTextItem | RequestReplaceTextItem;

export interface ChangeRequestFingerprintInput {
  readonly tool: string;
  readonly workspace_id: string;
  readonly connection_id: string;
  readonly summary: string;
  readonly items: readonly RequestItem[];
}

/**
 * 请求指纹：回答「同一个幂等键的两次调用，是不是同一个请求」。
 *
 * ## 覆盖了什么
 *
 * `tool` / `workspace_id` / `connection_id` / `summary` 与每个条目的
 * 全部**调用方撰写**字段（路径、基线哈希、行区间与行文本、新内容、
 * 换行、BOM）。
 *
 * `connection_id` 在其中值得单说一句：幂等记录是按 `principal_id` 查的，
 * 而一个主体可以有多条连接。若不把连接算进来，A 连接用某个键建立修改集后，
 * B 连接用同一个键提交**内容相同**的请求会命中「重放」，于是 B 拿到的
 * 是一个 `owner_connection_id` 属于 A 的修改集 —— 而修改集的归属连接
 * 参与后续的授权判定。把连接算进指纹，这种复用就变成一次显式冲突。
 *
 * ## 不覆盖什么（以及为什么）
 *
 *  - `read_token`：见文件头。令牌带签发与过期时刻，是服务端产物；
 *    算进去会让「同一请求」在时间轴上不是常量。
 *  - `idempotency_key`：它是查询键本身，不是内容。
 *  - 任何服务端派生量（摘要、blob id、尺寸）。
 *
 * 取舍的代价写在明处：两次调用若只有**令牌**不同，指纹相同，第二次会拿到
 * 第一次的修改集。这不是漏洞 —— 令牌的全部作用（路径、基线、范围、
 * 可编辑性、连接、代次）都已经由**内容字段**与建立时的校验覆盖，
 * 而第一次的修改集是在那些校验**通过之后**才建立起来的。
 */
export function changeRequestFingerprint(input: ChangeRequestFingerprintInput): string {
  const lines: string[] = [CHANGE_REQUEST_DOMAIN];
  lines.push(`tool ${field(input.tool)}`);
  lines.push(`workspace_id ${field(input.workspace_id)}`);
  lines.push(`connection_id ${field(input.connection_id)}`);
  lines.push(`summary ${field(input.summary)}`);
  lines.push(`item_count ${field(input.items.length)}`);

  for (const item of input.items) {
    lines.push(`item ${field(item.op)}`);
    lines.push(`path ${field(item.path)}`);

    if (item.op === 'create_text') {
      lines.push(`content ${field(item.content)}`);
      lines.push(`newline ${field(item.newline)}`);
      lines.push(`bom ${field(item.bom)}`);
      continue;
    }

    lines.push(`base_sha256 ${field(item.base_sha256)}`);
    if (item.op === 'replace_text') {
      lines.push(`content ${field(item.content)}`);
      continue;
    }

    lines.push(`edit_count ${field(item.edits.length)}`);
    for (const edit of item.edits) {
      lines.push(`start_line ${field(edit.start_line)}`);
      lines.push(`end_line_exclusive ${field(edit.end_line_exclusive)}`);
      lines.push(`old_line_count ${field(edit.old_lines.length)}`);
      for (const line of edit.old_lines) lines.push(`old_line ${field(line)}`);
      lines.push(`new_line_count ${field(edit.new_lines.length)}`);
      for (const line of edit.new_lines) lines.push(`new_line ${field(line)}`);
    }
  }

  return createHash('sha256').update(`${lines.join('\n')}\n`, 'utf8').digest('hex');
}
