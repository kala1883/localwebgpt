/**
 * 不可见与方向控制字符的检测（LWB-023 验收标准 2）。
 *
 * ## 为什么这件事归渲染方，而不归风险推导
 *
 * `@lwb/changes` 的 `deriveRisks` 只用路径与落库的统计量判风险，它**刻意不读内容**
 * —— 那一段的注释里把这件事指到了这里（`packages/changes/src/prepare.ts` 的
 * 「这一层刻意**不**读内容」）。理由站得住：内容层面的特征要到**渲染**时才
 * 需要，而那时正文已经在屏幕上，不必为了显示它再读一遍快照。于是
 * 「哪些字符可疑」这份判据只能落在渲染方。
 *
 * ## 这不是排版洁癖，是一次有名有姓的攻击
 *
 * 双向控制字符能让**渲染出来的行**与**磁盘上的字节**不是同一串东西。
 * 最出名的一例是 Trojan Source（CVE-2021-42574，Boucher & Anderson 2021）：
 * 在注释里放一个 U+202E（RLO，从右到左覆盖），它之后整段文本的**显示顺序**
 * 就被翻转，代码在编辑器里读起来是一回事、编译出来是另一回事。
 *
 * 放到本系统的场景里，这件事的要害不在「代码被改坏」，而在
 * **批准这个动作本身**：操作者看着屏幕上的一段文本按下「批准并应用」，
 * 而批准绑定的是那份**字节**的摘要。如果屏幕显示的内容与摘要覆盖的字节
 * 不是同一个东西，那这个批准就不是他以为自己给出的那个批准 ——
 * 整条「批准绑定摘要」的链条（LWB-020 建立、LWB-021 兑现）会在这里绕过去，
 * 而且不留痕迹：没有报错，没有异常，只有人看到的东西和落盘的东西不一致。
 *
 * 因此本模块的产物有两个用途，缺一不可：
 *
 *  1. **检出**（`findSuspicious`）：把位置、码位、类别报出来，供计数与提示。
 *  2. **替换成可见占位**（`segmentText`）：不可见字符按原样渲染出来是
 *     **看不到**的，所以「显示了」等于「没显示」。渲染方用它把每一个
 *     可疑字符换成一个写着码位的可见块，于是屏幕上出现的东西是
 *     **字节的忠实表示**：渲染结果与字节一一对应，双向控制不再生效。
 *
 * ## 这里**不**做的事
 *
 * **不做同形字（homoglyph / confusable）检测。** 那是另一个问题：
 * 它需要一份 Unicode 混淆表（`confusables.txt`，几千行）与一套骨架算法，
 * 而它的判据是「字形像」——一份**猜测**。本模块的每一条判据都是
 * 「这个码位在 Unicode 里的类别就是这样」，是可断言的。把两者混在一起，
 * 会让一个确定性的提示系统里混进一批会误报的条目，而误报会让人
 * 学会忽略这个提示 —— 那比没有提示更坏。
 * 同形字**确实**是本系统关心的（`l`/`1`、`rn`/`m`），但它的位置在
 * 文件路径与工具名上，不在正文渲染里，属另行处理。
 */

/**
 * 可疑字符的类别。
 *
 * 每一类都有各自不同的**后果**，因此不合并成一个 `suspicious` 布尔值：
 * 「这个字符会让显示顺序翻转」与「这个字符是隐形的」对操作者的意义不同，
 * 前者意味着他看到的可能**不是**他批准的东西，后者只意味着有东西藏在这里。
 */
export type SuspiciousCategory =
  | 'bidi_override'
  | 'bidi_embedding'
  | 'bidi_isolate'
  | 'bidi_mark'
  | 'zero_width'
  | 'invisible'
  | 'tag_character'
  | 'variation_selector';

export interface SuspiciousEntry {
  readonly category: SuspiciousCategory;
  /** 单个码位。可能是代理对，因此用 `number` 而不是 `char`。 */
  readonly codepoint: number;
  /** 人眼可读的名字，进提示用。 */
  readonly label: string;
  /** 这类字符**具体会造成什么**。用来决定提示的措辞，不是装饰。 */
  readonly note: string;
}

/**
 * 逐码位的判定。这是本模块**唯一**的判据来源，`findSuspicious` 与
 * `segmentText` 都经它，因此「检出什么」与「替换什么」不可能不一致 ——
 * 两处各写一份判据的后果是「提示了但没替换」（或反过来），
 * 而两者都会让屏幕与字节对不上，正是本模块要防的事。
 *
 * 判据逐条写明理由，而不是笼统写「Unicode 控制字符」—— 一张说不清自己
 * 在拦什么的清单，加到第 30 条时没人敢删任何一条。
 *
 * 用**区间**处理成组的码位（标签字符、变体选择符），而不是逐个列进一张
 * `Set`：`U+E0000–U+E007F` 有 128 个码位，全写出来既难读又容易漏。
 */
function classify(cp: number): SuspiciousEntry | null {
  // ---- 显式方向控制：覆盖与嵌入 ----------------------------------------
  if (cp === 0x202d) {
    return {
      category: 'bidi_override',
      codepoint: cp,
      label: 'U+202D 从左到右覆盖（LRO）',
      note: '它之后的文本显示方向被强制为从左到右，与字节顺序可能不符。',
    };
  }
  if (cp === 0x202e) {
    return {
      category: 'bidi_override',
      codepoint: cp,
      label: 'U+202E 从右到左覆盖（RLO）',
      note:
        '它之后的文本按从右到左显示，屏幕上的顺序与字节顺序**相反**。' +
        'Trojan Source（CVE-2021-42574）用的就是这个字符。',
    };
  }
  if (cp === 0x202a) {
    return {
      category: 'bidi_embedding',
      codepoint: cp,
      label: 'U+202A 从左到右嵌入（LRE）',
      note: '开辟一段从左到右的显示区间，需 U+202C 收尾。',
    };
  }
  if (cp === 0x202b) {
    return {
      category: 'bidi_embedding',
      codepoint: cp,
      label: 'U+202B 从右到左嵌入（RLE）',
      note: '开辟一段从右到左的显示区间，需 U+202C 收尾。',
    };
  }
  if (cp === 0x202c) {
    return {
      category: 'bidi_embedding',
      codepoint: cp,
      label: 'U+202C 结束方向格式化（PDF）',
      note: '结束一段嵌入或覆盖。它出现的位置本身就能说明前面藏着方向控制。',
    };
  }

  // ---- 隔离：与嵌入同类但传播行为不同 ----------------------------------
  if (cp >= 0x2066 && cp <= 0x2069) {
    const names: Readonly<Record<number, string>> = {
      0x2066: 'U+2066 从左到右隔离（LRI）',
      0x2067: 'U+2067 从右到左隔离（RLI）',
      0x2068: 'U+2068 首强隔离（FSI）',
      0x2069: 'U+2069 结束隔离（PDI）',
    };
    return {
      category: 'bidi_isolate',
      codepoint: cp,
      label: names[cp] ?? `U+${cp.toString(16).toUpperCase()}`,
      note: '隔离一段文本的方向，使其不影响外侧显示顺序。',
    };
  }

  // ---- 隐式方向标记：不可见，但会影响整行的方向推断 --------------------
  if (cp === 0x200e || cp === 0x200f || cp === 0x061c) {
    const names: Readonly<Record<number, string>> = {
      0x200e: 'U+200E 从左到右标记（LRM）',
      0x200f: 'U+200F 从右到左标记（RLM）',
      0x061c: 'U+061C 阿拉伯字母标记（ALM）',
    };
    return {
      category: 'bidi_mark',
      codepoint: cp,
      label: names[cp] ?? `U+${cp.toString(16).toUpperCase()}`,
      note: '不可见，但参与整行的方向推断，可能改变相邻文本的显示顺序。',
    };
  }

  // ---- 零宽：占了位置却什么都不显示 ------------------------------------
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || cp === 0xfeff) {
    const names: Readonly<Record<number, string>> = {
      0x200b: 'U+200B 零宽空格（ZWSP）',
      0x200c: 'U+200C 零宽不连字（ZWNJ）',
      0x200d: 'U+200D 零宽连字（ZWJ）',
      0x2060: 'U+2060 单词连接符（WJ）',
      0xfeff: 'U+FEFF 零宽不换行空格（BOM 同码位）',
    };
    return {
      category: 'zero_width',
      codepoint: cp,
      label: names[cp] ?? `U+${cp.toString(16).toUpperCase()}`,
      note: '宽度为零：两个看起来一样的标识符可以因此不同，比较与查找结果会出乎意料。',
    };
  }

  // ---- 其它不可见字符 ---------------------------------------------------
  if (
    cp === 0x00ad || // 软连字符：平常不显示，换行时才现身
    cp === 0x034f || // 组合字素连接符（CGJ）
    cp === 0x180e || // 蒙古文元音分隔符
    cp === 0x3164 || // 谚文填充符：看起来像空白，实际不是空格
    cp === 0xffa0 || // 半角谚文填充符
    cp === 0x2800 // 盲文空白：视觉上是空白
  ) {
    const names: Readonly<Record<number, string>> = {
      0x00ad: 'U+00AD 软连字符（SHY）',
      0x034f: 'U+034F 组合字素连接符（CGJ）',
      0x180e: 'U+180E 蒙古文元音分隔符',
      0x3164: 'U+3164 谚文填充符',
      0xffa0: 'U+FFA0 半角谚文填充符',
      0x2800: 'U+2800 盲文空白',
    };
    return {
      category: 'invisible',
      codepoint: cp,
      label: names[cp] ?? `U+${cp.toString(16).toUpperCase()}`,
      note: '视觉上不可见或近似空白，但确实占一个码位。',
    };
  }

  // ---- 标签字符：整整一段可用于夹带数据的不可见区 ----------------------
  if (cp >= 0xe0000 && cp <= 0xe007f) {
    return {
      category: 'tag_character',
      codepoint: cp,
      label: `U+${cp.toString(16).toUpperCase()} 标签字符`,
      note: 'Unicode 已弃用的不可见区段，可用来在一段正常文本里夹带任意内容。',
    };
  }

  // ---- 变体选择符：附着在前一个字符上，肉眼不可见 ----------------------
  if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) {
    return {
      category: 'variation_selector',
      codepoint: cp,
      label: `U+${cp.toString(16).toUpperCase()} 变体选择符`,
      note: '修饰前一个字符的呈现方式，本身不可见；同一段文字可用它承载额外的字节。',
    };
  }

  return null;
}

/** 一个检出结果。`start` 是 UTF-16 码元下标（与 `String.prototype.slice` 同刻度）。 */
export interface SuspiciousRange {
  readonly start: number;
  readonly length: number;
  readonly codepoint: number;
  readonly category: SuspiciousCategory;
  readonly label: string;
  readonly note: string;
}

/**
 * 检出文本里所有可疑字符。
 *
 * 按**码位**遍历而不是按下标 `charCodeAt`：`U+E0000` 以上的字符占两个码元，
 * 按码元走会把它读成两个无意义的高低位代理，于是整类标签字符永远检不出来
 * —— 而它恰恰是最适合夹带数据的一类。
 */
export function findSuspicious(text: string): readonly SuspiciousRange[] {
  const out: SuspiciousRange[] = [];
  let index = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) {
      const entry = classify(cp);
      if (entry !== null) {
        out.push({ start: index, length: ch.length, ...entry });
      }
    }
    index += ch.length;
  }
  return Object.freeze(out);
}

export function hasSuspicious(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && classify(cp) !== null) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 渲染分段
// ---------------------------------------------------------------------------

export interface TextSegment {
  readonly kind: 'text';
  readonly text: string;
}

export interface SuspiciousSegment {
  readonly kind: 'suspicious';
  /** 原始字符。**渲染方不得直接显示它** —— 它本来就是不可见的。 */
  readonly text: string;
  readonly codepoint: number;
  readonly category: SuspiciousCategory;
  readonly label: string;
  readonly note: string;
}

export type Segment = TextSegment | SuspiciousSegment;

/**
 * 把一段文本切成「正常片段」与「可疑字符」交替的序列，供渲染方逐段处理。
 *
 * 为什么不直接给一个 `highlight()` 返回 HTML 字符串：那要求渲染方用
 * 未经转义的 HTML 插值，而本任务的步骤 3 明写「内容按文本转义渲染，
 * 不执行仓库 Markdown/HTML」。一个返回 HTML 的辅助函数会把这条要求
 * 变成一个「用的时候小心点」的约定；返回分段则让渲染方只能用文本插值，
 * 于是转义是**结构上**的，不是纪律上的。
 *
 * 相邻的正常字符合并成一个片段（否则每遇到一个普通字符就要产生一个节点，
 * 一个大文件会因此产生几十万个文本节点）。
 */
export function segmentText(text: string): readonly Segment[] {
  const out: Segment[] = [];
  let plain = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const entry = cp === undefined ? null : classify(cp);
    if (entry === null) {
      plain += ch;
    } else {
      if (plain !== '') {
        out.push({ kind: 'text', text: plain });
        plain = '';
      }
      out.push({
        kind: 'suspicious',
        text: ch,
        codepoint: entry.codepoint,
        category: entry.category,
        label: entry.label,
        note: entry.note,
      });
    }
  }
  if (plain !== '') out.push({ kind: 'text', text: plain });
  return Object.freeze(out);
}

/**
 * 把一段文本摊成**只有可见字符**的等价表示：每个可疑字符换成一个写着码位的占位。
 *
 * 这是给「不适合逐段渲染」的场合用的（例如把差异文本整个塞进一个
 * `<pre>`、或写进日志与证据）：它保证输出的每一个字符都是可见的，
 * 且与输入字节一一对应。
 *
 * 占位用 `⟦U+202E⟧` 这种形状：中括号在正文里几乎不会自然出现，
 * 因此「这段文本里有可疑字符」与「这段文本里恰好写了这几个字」不会混淆。
 */
export function visualizeSuspicious(text: string): string {
  const parts: string[] = [];
  for (const segment of segmentText(text)) {
    if (segment.kind === 'text') parts.push(segment.text);
    else parts.push(`⟦U+${segment.codepoint.toString(16).toUpperCase().padStart(4, '0')}⟧`);
  }
  return parts.join('');
}

/** 供提示与证据用：按类别计数。 */
export function countByCategory(ranges: readonly SuspiciousRange[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const range of ranges) {
    counts[range.category] = (counts[range.category] ?? 0) + 1;
  }
  return Object.freeze(counts);
}
