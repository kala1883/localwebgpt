<!--
  DiffView —— 单个文件的差异显示（LWB-023 步骤 2「完整差异、原文/新文切换」）。

  ## 三条硬约束，都写在结构里而不是写在注释里

  1. **不执行仓库内容。** 整个文件里没有 `v-html`、没有 `innerHTML`、
     没有动态 `import()`。正文一律走 `{{ }}` 文本插值，于是 Vue 自己转义。
     步骤 3 要求「内容按文本转义渲染，不执行仓库 Markdown/HTML」——
     这条只有用**结构**保证才成立：一个「用的时候记得转义」的约定，
     在第一百次改动时会被忘掉。

  2. **不加载外部资源。** 没有 `<img>`、没有 `<link>`、没有远程字体或脚本。
     方案 §10.2：「禁止外部图片、远程脚本和未经转义的 HTML」。
     一张来自仓库内容的远程图片是一个**出站请求**，它会把
     「本机正在看这份差异」这件事告诉那个地址 —— 而这是一个本地工具。
     渲染 `src` 属性的能力在这里干脆不存在。

  3. **显示顺序必须与字节顺序一致。** 见下面 `bidi-isolate` 那两处样式
     与 `segmentText` 的用法。

  ## 可疑字符：替换成可见占位，而不是原样显示

  不可见字符按原样渲染出来是**看不到**的，所以「显示了」等于「没显示」。
  这里把每一个可疑字符换成一个写着码位的 `<mark>`：屏幕上出现的东西
  因此是**字节的忠实表示**，一一对应。这一点直接决定 LWB-023 验收标准 2
  是不是真的成立 —— 只给一句「本文件含可疑字符」的提示是不够的，
  操作者仍然不知道它藏在哪一行、是哪一个。

  ## 第四条硬约束（LWB-036 步骤 3）：**不折叠**

  > 禁止 diff 折叠策略掩盖大范围删除。

  折叠（`@@ … @@` 中间的省略、大段删除收成一行、`+0 −400` 只给个数字）
  是 diff 显示器的常规做法，而在这里每一次折叠都恰好掩盖一件事：
  **被删掉的东西**。操作者看到一个「省略了 300 行」的标记，按下批准，
  而摘要绑的是那 300 行的删除。删除是不可逆的（V1 没有回滚用户文件），
  因此这一层不提供任何折叠策略：**给进来多少行就渲染多少行**。

  这条约束不是靠「记得别折叠」维持的，而是靠**这里根本没有折叠的代码**：
  本组件没有任何一处按内容过滤行、没有 `slice`、没有「相邻 N 行未变则
  省略」。`lines` 只做一件事 —— 把拿到的文本按 `\n` 切开。

  分页（`pageIndex` / `unifiedTruncated`）**不是**折叠：服务端按行范围
  分页，页内的每一行都渲染，而「这一页不是全部」这件事在界面上是**说出来**
  的（见模板里的 `diff-incomplete`），不是藏起来的。两者必须分清楚 ——
  一个把分页做成静默截断的实现会在这里失败。
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { formatBytes, formatLineDelta } from '../src/changes/facts.ts';
import { segmentText } from '../src/changes/suspicious.ts';

/** 显示模式：整段差异、只看原文、只看新文。 */
export type DiffMode = 'unified' | 'before' | 'after';

/**
 * 单个文件的变更统计（LWB-036 步骤 1）。
 *
 * 每个数字都来自落库事实（`ChangeFilePreview`），**不由本组件从正文里
 * 数出来**：数一遍会得到第二个判据，而屏幕上那一行与批准绑定的摘要
 * 是否一致，正是这个页面要保证的事。组件只负责摆出来。
 */
export interface DiffFileStats {
  readonly added_lines: number;
  readonly removed_lines: number;
  readonly before_size: number;
  readonly after_size: number;
}

const props = withDefaults(
  defineProps<{
    /** 文件在工作区里的规范相对路径。 */
    readonly path: string;
    /** 操作种类，用来解释为什么某一侧没有内容。 */
    readonly op: 'edit_text' | 'create_text' | 'replace_text' | 'delete_file';
    /** 修改前正文。新建文件为 `null`。 */
    readonly beforeText: string | null;
    /** 修改后正文。 */
    readonly afterText: string | null;
    /** 由服务端渲染的统一差异文本。尚未接线时为 `null`。 */
    readonly unified?: string | null;
    readonly initialMode?: DiffMode;
    /**
     * 这份统一差异**是不是被截断的一页**（服务端 `ChangeDiffPage.truncated`）。
     *
     * 省略即「不是」。与 `ChangesView` 的 `FileText.unified_truncated`
     * 是同一个事实，两个字面量同一个含义 —— 刻意不在这里换一个名字，
     * 因为同一个事实有两个名字时，接线处就会接错一个。
     */
    readonly unifiedTruncated?: boolean;
    /** 已经取回几页差异（1 起）。调用方没做分页时给 `null`。 */
    readonly pageIndex?: number | null;
    /** 本文件的变更统计。调用方拿不到落库事实时给 `null`。 */
    readonly stats?: DiffFileStats | null;
  }>(),
  { unified: null, initialMode: 'unified', unifiedTruncated: false, pageIndex: null, stats: null },
);

const emit = defineEmits<{
  /**
   * 用户要求取回这个文件的下一页差异。
   *
   * 组件**不自己取**（它不持控制客户端、也不知道游标）：它只说
   * 「有人要看下一页」。取哪一页、游标是什么，是调用方与
   * `src/changes/refresh.ts` 的事。
   */
  (event: 'next-page', payload: { readonly path: string }): void;
  /**
   * 显示模式变了（用户在下面那三个按钮里点了一个）。
   *
   * ## 为什么它不是 `next-page` 那样的「通知」，而是必须有的
   *
   * `initialMode` 是**初值**：本组件在挂载时读一次，之后归自己管
   * （见 `mode` 那行）。于是调用方持有的模式与这里真实的模式是**两份**，
   * 而两份状态的分叉方式是具体的：操作者点「原文」→ 这里变成 `before`
   * → 调用方若不知道，下一次因为别的原因重挂（换文件、刷新）时会用
   * 它自己那份旧的初值把屏幕变回「完整差异」——**操作者的选择被静默撤销**。
   *
   * `ChangeDetailView` 把模式用 `key` 绑在组件身份上（见那边），因此
   * 这条事件是那份绑定的输入。少了它，两边会各说各话。
   */
  (event: 'update:mode', mode: DiffMode): void;
}>();


/** 当前模式。初始值由调用方给，之后归用户点。 */
const mode = ref<DiffMode>(props.initialMode);

/**
 * 切换模式。按钮与（调用方转发的）键盘都走这里。
 *
 * 先改自己的状态再通知：本组件在**被控制之前**就已经是对的，
 * 因此一个还没接 `update:mode` 的调用方拿到的仍然是一个能用的组件，
 * 而不是一个「点了没反应、要等我回话」的组件。
 */
function setMode(next: DiffMode): void {
  mode.value = next;
  emit('update:mode', next);
}

/**
 * 当前要显示的正文。
 *
 * 三种模式的取值规则：
 *  - `unified`：服务端渲染好的统一差异文本。**没有就显示一句话**，
 *    而不是退回显示新文全文 —— 两者看起来都是「一段代码」，而
 *    操作者会以为自己在看差异。少显示不如说清楚没得显示。
 *  - `before`：新建文件没有「原文」，此时返回 `null` 由模板说明。
 *  - `after`：与 `before` 对称。
 */
const shown = computed<{ readonly kind: 'text'; readonly text: string } | { readonly kind: 'absent'; readonly why: string }>(() => {
  if (mode.value === 'unified') {
    if (props.unified === null || props.unified === '') {
      return { kind: 'absent', why: '服务端尚未提供统一差异；请用「原文 / 新文」对照查看。' };
    }
    return { kind: 'text', text: props.unified };
  }
  if (mode.value === 'before') {
    if (props.beforeText === null) {
      return { kind: 'absent', why: props.op === 'create_text' ? '这是新建文件，没有原文。' : '原文尚未载入。' };
    }
    return { kind: 'text', text: props.beforeText };
  }
  if (props.afterText === null) {
    return { kind: 'absent', why: props.op === 'delete_file' ? '文件已删除，没有新文。' : '新文尚未载入。' };
  }
  return { kind: 'text', text: props.afterText };
});

/**
 * 逐行切分。
 *
 * 只按 `\n` 切、`\r` 留在行里，与 `@lwb/git-reader` 的 `splitLines`
 * 同一条约定：**屏幕上要显示的是磁盘上那份字节**，顺手归一化换行会让
 * 「看到的」与「批准绑定的」差一个字符。末尾那个空串是「文件以换行结尾」
 * 的表现，不是一个空行 —— 不摘掉它，每个文件都会多出一行空的。
 */
const lines = computed<readonly { readonly number: number; readonly segments: ReturnType<typeof segmentText> }[]>(() => {
  if (shown.value.kind !== 'text') return [];
  const text = shown.value.text;
  if (text === '') return [];
  const raw = text.split('\n');
  if (raw.at(-1) === '') raw.pop();
  return raw.map((line, index) => ({ number: index + 1, segments: segmentText(line) }));
});

/** 本文件里是否有可疑字符。有则整个视图配一条通栏提示（见模板）。 */
const suspiciousCount = computed(() =>
  lines.value.reduce(
    (sum, line) => sum + line.segments.filter((segment) => segment.kind === 'suspicious').length,
    0,
  ),
);

/**
 * 当前显示的这段正文**是不是完整的**。
 *
 * 三种模式的答案来源不同，而这件事本身就是为什么要问它：
 *  - `unified`：只有服务端知道，因此由 `unifiedTruncated` 说 —— 调用方
 *    把这个 prop 交出来时声称的就是「这是一整份差异」。
 *  - `before` / `after`：正文是整文件取回来的，按契约就是完整的。
 *    （一段被截断的**全文**不叫全文，那样调用方就违反了 prop 的含义。）
 *
 * 没内容可显示时（`absent`）返回 `true`：那种情况下要说的是「为什么没有」，
 * 而不是在这句话旁边再加一句「而且它还不完整」。
 */
const truncatedNow = computed(() => mode.value === 'unified' && props.unifiedTruncated === true);

const modes: readonly { readonly value: DiffMode; readonly label: string }[] = [
  { value: 'unified', label: '完整差异' },
  { value: 'before', label: '原文' },
  { value: 'after', label: '新文' },
];

/**
 * 可疑字符的显示文本。
 *
 * 写成 `⟦U+202E⟧` 这种形状，理由与 `visualizeSuspicious` 相同：中括号
 * 在正文里几乎不会自然出现，因此「这里有一个可疑字符」与「这里恰好
 * 写了这几个字」不会混淆。
 */
function placeholderOf(codepoint: number): string {
  return `⟦U+${codepoint.toString(16).toUpperCase().padStart(4, '0')}⟧`;
}
</script>

<template>
  <section class="diff-view" data-testid="diff-view">
    <header class="diff-view__head">
      <span class="diff-view__path" data-testid="diff-path">{{ path }}</span>
      <span class="diff-view__op" data-testid="diff-op">{{ op }}</span>
      <nav class="diff-view__modes" aria-label="显示模式">
        <button
          v-for="entry in modes"
          :key="entry.value"
          type="button"
          :class="['diff-view__mode', { 'diff-view__mode--active': mode === entry.value }]"
          :aria-pressed="mode === entry.value"
          :data-testid="`mode-${entry.value}`"
          @click="setMode(entry.value)"
        >
          {{ entry.label }}
        </button>
      </nav>
    </header>

    <!--
      变更统计（LWB-036 步骤 1）。全部来自落库事实，不由正文数出来 ——
      见 `DiffFileStats` 的注释。它在抬头下面、正文上面：操作者读差异之前
      先看到「这个文件动了多少」，读完之后可以回头核对这一行是否对得上。
    -->
    <p v-if="stats !== null" class="diff-view__stats" data-testid="diff-stats">
      <span data-testid="diff-stats-lines">{{ formatLineDelta(stats.added_lines, stats.removed_lines) }} 行</span>
      <span class="diff-view__dim">·</span>
      <span data-testid="diff-stats-bytes">
        {{ formatBytes(stats.before_size) }} → {{ formatBytes(stats.after_size) }}
      </span>
    </p>

    <!--
      完整性 + 分页进度（LWB-036 步骤 1 的「按文件分页」与「完整内容查看」）。

      这一行**同时**给出肯定与否定两种说法，因为它们各自要解决的问题不同：
      只有「不是全部」这一半时，「没有提示」与「提示没渲染出来」在屏幕上
      一样；只有「完整」这一半时，一段被服务端截断的差异会安安静静地
      看起来像全部。

      `aria-live="polite"` 挂在**这一行**上而不是正文上：翻页会换掉正文，
      而屏幕阅读器需要被告知的是「现在是第几页、是不是到底了」，
      不是把整段差异再念一遍。
    -->
    <p v-if="shown.kind === 'text'" class="diff-view__progress" data-testid="diff-progress">
      <span v-if="!truncatedNow" class="diff-view__complete" data-testid="diff-complete">
        这一份是完整差异，全部行都在下面。
      </span>
      <template v-else>
        <span class="diff-view__incomplete" data-testid="diff-page" aria-live="polite" role="status">
          <template v-if="pageIndex !== null">差异第 {{ pageIndex }} 页 · </template>**这不是全部内容**，后面还有。
        </span>
        <button
          type="button"
          class="diff-view__next"
          data-testid="next-page"
          @click="emit('next-page', { path })"
        >
          载入下一页差异
        </button>
      </template>
    </p>

    <!--
      可疑字符的通栏提示。它出现在**正文之前**，而不是正文之后或某个角落：
      一个只在滚动到底部才能看到的警告，对一个「请核对后批准」的页面来说
      等于没有。数量写出来，操作者据此知道该往下找几处。
    -->
    <p v-if="suspiciousCount > 0" class="diff-view__alert" role="alert" data-testid="suspicious-alert">
      本文件含有 {{ suspiciousCount }} 个不可见或方向控制字符（下图中以
      <code>⟦U+XXXX⟧</code> 标出）。这类字符可以让**屏幕上显示的顺序**
      与**磁盘上的字节顺序**不一致，请逐个核对后再决定是否批准。
    </p>

    <p v-if="shown.kind === 'absent'" class="diff-view__absent" data-testid="diff-absent">
      {{ shown.why }}
    </p>

    <!--
      正文容器。`tabindex="0"` + `role="region"`（LWB-036 步骤 1 的键盘可访问性）：
      这个盒子是可以横向滚动的（长行超出宽度），而**可滚动区域若不能获得焦点，
      键盘用户就滚不动它** —— 他们只能看到每行的前几十个字符，而后面的内容
      在实际操作中等于不存在。一个「请核对后批准」的页面不能有这种角落。

      `aria-label` 里带上路径：屏幕阅读器在区域之间跳转时，光念
      「区域」不够，要说得出这是哪一个文件的正文。
    -->
    <div
      v-else
      class="diff-view__body"
      data-testid="diff-body"
      role="region"
      tabindex="0"
      :aria-label="`${path} 的正文（可滚动）`"
    >
      <div v-for="line in lines" :key="line.number" class="diff-view__line" data-testid="diff-line">
        <!--
          行号单独一个元素并且 `unicode-bidi: isolate`（见样式）：
          正文里的一段从右到左文字会参与双向算法，若行号与正文在同一个
          行盒里，行号的位置可能被正文的方向性拉走。隔离之后，
          「行号在左、正文在右」是布局事实，不再随内容变化。
        -->
        <span class="diff-view__lineno" aria-hidden="true" data-testid="diff-lineno">{{ line.number }}</span>
        <span class="diff-view__text"><template
          v-for="(segment, index) in line.segments"
          :key="index"
        ><span v-if="segment.kind === 'text'">{{ segment.text }}</span><mark
          v-else
          class="diff-view__suspicious"
          :data-testid="'suspicious-char'"
          :data-codepoint="segment.codepoint.toString(16).toUpperCase()"
          :title="`${segment.label} —— ${segment.note}`"
        >{{ placeholderOf(segment.codepoint) }}</mark></template></span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.diff-view {
  border: 1px solid var(--lwb-border, #d0d4da);
  border-radius: 6px;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 13px;
}

.diff-view__head {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--lwb-border, #d0d4da);
}

.diff-view__path {
  font-weight: 600;
}

.diff-view__op {
  color: var(--lwb-muted, #5a6270);
}

.diff-view__modes {
  margin-left: auto;
  display: flex;
  gap: 4px;
}

.diff-view__mode--active {
  font-weight: 700;
}

.diff-view__alert {
  margin: 0;
  padding: 8px 12px;
  background: var(--lwb-warning-bg, #fff4d6);
  border-bottom: 1px solid var(--lwb-border, #d0d4da);
}

.diff-view__stats {
  display: flex;
  gap: 6px;
  margin: 0;
  padding: 6px 12px;
  color: var(--lwb-muted, #5a6270);
  border-bottom: 1px solid var(--lwb-border, #d0d4da);
}

.diff-view__dim {
  color: var(--lwb-border, #d0d4da);
}

.diff-view__progress {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--lwb-border, #d0d4da);
}

.diff-view__complete {
  color: var(--lwb-muted, #5a6270);
}

/*
  「这不是全部内容」的样式与通栏警告同一档：它是**否定性的事实**，
  而分页截断最容易造成的事故就是「以为看完了」。一个淡淡的灰字
  在被快速扫过时与不存在没有区别。
*/
.diff-view__incomplete {
  color: var(--lwb-danger-fg, #8a1c1c);
  font-weight: 700;
}

.diff-view__absent {
  margin: 0;
  padding: 12px;
  color: var(--lwb-muted, #5a6270);
}

/*
  正文容器。两条声明各防一件事：

  - `direction: ltr` —— 页面的基准方向固定为从左到右，不随系统语言变化。
  - `unicode-bidi: isolate` —— 把这段正文的双向行为**关在自己的盒子里**，
    不让它影响外面的行号与按钮。仓库内容里的一段希伯来文或阿拉伯文
    是合法的，它**应当**按自己的方向显示；但它不该把旁边的行号一起拉走。

  注意这两条**不是**用来对付 RLO 的：RLO 已经在 `segmentText` 里被换成
  可见占位了，因此它根本到不了浏览器。样式这一层防的是**残余的、
  合法的**双向文本，以及某个将来新增的、忘记过 `segmentText` 的渲染路径。
*/
.diff-view__body {
  direction: ltr;
  unicode-bidi: isolate;
  overflow-x: auto;
  padding: 8px 0;
}

/*
  可聚焦的滚动区域必须有可见的焦点圈：浏览器默认的 `outline` 在某些
  主题下几乎看不见，而「焦点在哪」是键盘用户唯一的导航信息 ——
  看不到它就等于表格里没有光标。用 `:focus-visible` 而不是 `:focus`，
  这样鼠标点进来时不会多出一个框。
*/
.diff-view__body:focus-visible {
  outline: 2px solid var(--lwb-focus, #1a5fb4);
  outline-offset: -2px;
}

.diff-view__line {
  display: flex;
  white-space: pre;
  min-height: 1.4em;
}

.diff-view__lineno {
  flex: 0 0 4em;
  padding: 0 8px;
  text-align: right;
  color: var(--lwb-muted, #5a6270);
  user-select: none;
  unicode-bidi: isolate;
}

.diff-view__text {
  flex: 1 1 auto;
  unicode-bidi: isolate;
}

.diff-view__suspicious {
  background: var(--lwb-danger-bg, #ffd9d9);
  color: var(--lwb-danger-fg, #8a1c1c);
  border: 1px solid currentColor;
  border-radius: 3px;
  padding: 0 2px;
}
</style>
