<!--
  ChangesView —— 待批准页面的主视图（LWB-023）。

  对应方案 §10.1 的「待批准」一行：**明确文件清单、完整 diff、风险、
  有效期、拒绝 / 批准并应用**，以及 §10.2 的两条口径：

  > 主按钮是「批准并应用」……
  > 源码 / Markdown / HTML 一律按文本展示；禁止外部图片、远程脚本和
  > 未经转义的 HTML。模型撰写的「安全说明」与系统计算的风险事实**分区展示**。

  ## 页面的四个分区，顺序是设计的一部分

  1. **通栏警告**（有 warning 级风险或有可疑字符时）—— 必须在最上面。
     一个要滚到底才看见的警告，对一个「请核对后批准」的页面来说等于没有。
  2. **系统事实区** —— 文件数、行数增量、字节、逐条风险。全部来自落库事实。
  3. **模型撰写区** —— 摘要单独一块，带固定标签「模型撰写（不受信）」。
     **它与事实区是两个容器**，这是 §10.2 那句「分区展示」在结构上的样子。
  4. **正文区** —— 文件清单 + 差异（DiffView）。

  审批按钮在最后，且只在 `approvalAffordance` 允许时出现。

  ## 这个组件不做判定

  它不自己算风险、不自己读会话、不自己判有效期 —— 三件事分别由
  `src/changes/facts.ts`、`approval.ts` 与 `@lwb/contracts` 的类型负责。
  组件只把它们摆出来，因此「界面显示了什么」与「被断言的是什么」是同一份东西。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ChangeFilePreview, ChangeSetView } from '@lwb/contracts';
import DiffView from '../components/DiffView.vue';
import {
  approvalAffordance,
  approvalIdempotencyKey,
  describeChange,
  expiryOf,
  formatBytes,
  formatLineDelta,
  progressFromTexts,
  reviewCoverageOf,
  type ContentGate,
  type FileText,
  type ReviewCoverage,
  type SessionPresence,
} from '../src/changes/index.ts';
import { findSuspicious } from '../src/changes/suspicious.ts';

const props = withDefaults(
  defineProps<{
    /** 修改集视图。为 `null` 时页面说明「没有待审批的修改集」。 */
    readonly change: ChangeSetView | null;
    /** 控制台会话。`null` 表示未建立（页面不给批准入口）。 */
    readonly session?: SessionPresence | null;
    /** 会话是否已过期（与「未登录」分开，理由见 `approval.ts`）。 */
    readonly sessionExpired?: boolean;
    /** 判定时刻。由调用方传入 —— 组件不读时钟，否则不可测。 */
    readonly now: string;
    /** 逐文件正文，键是规范相对路径。 */
    readonly texts?: Readonly<Record<string, FileText>>;
    /**
     * 提议这个修改集的连接别名。
     *
     * **它必须由调用方解析后传进来**：`ChangeSetView` 里没有这个字段，
     * 落库事实里对应的是 `changesets.owner_connection_id`，而把它换成
     * 别名要查 `connections` 表（控制操作 `connections.list`）。
     * 因此这里收的是一个**已经查好的字符串**，而不是 id ——
     * 让组件去查表会把一次网络调用藏在一个渲染函数里。
     *
     * 查不到时传 `null`，页面显示「未知」而不是省略这一行：
     * 一个空着的位置会让人以为界面漏了，而「未知」是一个事实。
     */
    readonly ownerLabel?: string | null;
    /** 工作区别名。同样由调用方解析。 */
    readonly workspaceLabel?: string | null;
    /** 有请求在途时按钮不可再点。 */
    readonly busy?: boolean;
    /**
     * 服务端对**这个修改集的正文**给出的取舍判定（`ChangeReadContext` → `content_gate`）。
     *
     * 它为什么必须由调用方传，而不是组件写死一个 `null`：写死等于
     * 组件替服务端断言「没有拒绝过任何一次内容读取」——一件它不知道的事。
     * 而拒绝恰恰是最需要说出来的那种情况：「看不到内容」与「还没看内容」
     * 对操作者是两句不同的话，前者再怎么翻也翻不出东西来。
     *
     * 省略即「服务端没有给出拒绝结论」，与 `unified_truncated` 同一条口径。
     */
    readonly contentGate?: ContentGate | null;
  }>(),
  {
    session: null,
    sessionExpired: false,
    texts: () => ({}),
    ownerLabel: null,
    workspaceLabel: null,
    busy: false,
    contentGate: null,
  },
);

const emit = defineEmits<{
  /** 批准并应用。参数就是应当发给 `approvals.approve_and_apply` 的那份内容。 */
  (event: 'approve', payload: { readonly change_id: string; readonly digest: string; readonly idempotency_key: string }): void;
  /** 拒绝。注意**没有**幂等键，理由见 `src/changes/approval.ts`。 */
  (event: 'reject', payload: { readonly change_id: string; readonly digest: string }): void;
  /** 用户在文件清单里选了另一个文件。 */
  (event: 'select-file', payload: { readonly path: string }): void;
  /**
   * 用户要求取回某个文件的下一页差异（LWB-036 按文件分页）。
   *
   * 视图**不自己取**：它不持控制客户端，也不该在一个渲染路径里发请求。
   * 由调用方取回后把新的 `texts[path]` 传回来（页数加一、`unified` 变成
   * 累计后的文本、到末页时 `unified_truncated` 转 `false`）。
   */
  (event: 'next-page', payload: { readonly path: string }): void;
}>();

const selectedPath = ref<string | null>(null);

/**
 * 当前选中的文件。
 *
 * 选中项在修改集变化时**重置**：`change_id` 变了还留着旧的选中路径，
 * 会让新修改集里的同名文件「碰巧」被选中，而操作者以为自己还在看上一份。
 */
const selected = computed<ChangeFilePreview | null>(() => {
  const files = props.change?.files ?? [];
  if (files.length === 0) return null;
  const found = selectedPath.value === null ? undefined : files.find((file) => file.path === selectedPath.value);
  return found ?? files[0] ?? null;
});

watch(
  () => props.change?.change_id ?? null,
  () => {
    selectedPath.value = null;
  },
);

/** 事实与模型的话，两个平级的对象。见 `facts.ts` 的文件头。 */
const described = computed(() => (props.change === null ? null : describeChange(props.change)));

const expiry = computed(() => (props.change === null ? null : expiryOf(props.change.expires_at, props.now)));

/**
 * 逐文件的复核进度（LWB-036），**从已有的数据推出来**。
 *
 * 组件手里的 `texts` 就是两份正文本身，因此「看过没有」在这里不是
 * 一个需要额外记账的状态：两侧都拿到整文件，就是看全了；只有一份
 * 没截断的差异，也是看全了。调用方不需要为这件事多做一件事，
 * 唯一需要它说的是**这一页是不是被截断的**（`unified_truncated`）——
 * 那是它知道而组件不知道的事实。
 */
const progress = computed(() => progressFromTexts(props.texts));

/**
 * 复核覆盖。**它是批准判定的必填输入**（见 `approval.ts` 的 `coverage`），
 * 因此这里没有「不传」这条路径 —— 一个只看过一部分的修改集，
 * 界面不会给出批准入口，而理由里会写明还差哪几个文件。
 */
const coverage = computed<ReviewCoverage>(() =>
  reviewCoverageOf({ change: props.change, progress: progress.value, gate: props.contentGate ?? null }),
);

const affordance = computed(() =>
  approvalAffordance({
    session: props.session ?? null,
    ...(props.sessionExpired ? { session_expired: true } : {}),
    change: props.change,
    coverage: coverage.value,
    now: props.now,
  }),
);

const selectedText = computed<FileText | null>(() => {
  const path = selected.value?.path;
  if (path === undefined) return null;
  return props.texts[path] ?? null;
});

/**
 * 每个文件的可疑字符数。
 *
 * 逐文件算而不是只算当前这个：文件清单上就要能看到「哪几个文件有问题」，
 * 否则操作者必须逐个点开才知道该看哪里 —— 而一个含 RLO 的文件
 * 正是最容易被跳过的那一个。
 */
const suspiciousByPath = computed<Readonly<Record<string, number>>>(() => {
  const out: Record<string, number> = {};
  for (const [path, text] of Object.entries(props.texts)) {
    let count = 0;
    if (text.before !== null) count += findSuspicious(text.before).length;
    if (text.after !== null) count += findSuspicious(text.after).length;
    if (count > 0) out[path] = count;
  }
  return out;
});

const totalSuspicious = computed(() =>
  Object.values(suspiciousByPath.value).reduce((sum, count) => sum + count, 0),
);

/**
 * 某个文件的复核结论。
 *
 * 查 `coverage.files` 而不是自己重算一次：重算就是第二处判据，
 * 而两处判据的分歧会表现为「清单上说已复核、按钮说还没看完」。
 * 找不到时返回 `null`（那个路径不在修改集里），模板据此不画标记 ——
 * 不画比画错好。
 */
function coverageOf(path: string): { readonly covered: boolean; readonly reason: string | null } | null {
  const found = coverage.value.files.find((file) => file.path === path);
  return found === undefined ? null : { covered: found.covered, reason: found.reason };
}

function select(path: string): void {
  selectedPath.value = path;
  emit('select-file', { path });
}

function onApprove(): void {
  const change = props.change;
  if (change === null || !affordance.value.can_approve || props.busy) return;
  emit('approve', {
    change_id: change.change_id,
    digest: change.digest,
    idempotency_key: approvalIdempotencyKey(change),
  });
}

function onNextPage(): void {
  const path = selected.value?.path;
  if (path === undefined) return;
  emit('next-page', { path });
}

function onReject(): void {
  const change = props.change;
  if (change === null || !affordance.value.can_reject || props.busy) return;
  emit('reject', { change_id: change.change_id, digest: change.digest });
}

/** 风险等级的排序权重：warning 在最前，因为它是唯一会触发通栏警告的一档。 */
const RISK_ORDER: Readonly<Record<string, number>> = { warning: 0, notice: 1, info: 2 };

function sortedRisks(): readonly { readonly level: string; readonly code: string; readonly message: string }[] {
  const risks = described.value?.facts.risks ?? [];
  return [...risks].sort((a, b) => (RISK_ORDER[a.level] ?? 9) - (RISK_ORDER[b.level] ?? 9));
}
</script>

<template>
  <section class="changes" data-testid="changes-view">
    <p v-if="change === null" class="changes__empty" data-testid="empty-state">
      当前没有待审批的修改集。
    </p>

    <template v-else-if="described !== null">
      <!--
        分区 1：通栏警告。
        两个来源任一成立就显示 —— 系统算出 warning 级风险，或者正文里有
        可疑字符。它**不读**模型摘要，因此模型写「无害」不会让它消失。
      -->
      <div
        v-if="described.facts.risk_breakdown.has_warning || totalSuspicious > 0"
        class="changes__banner"
        role="alert"
        data-testid="banner"
      >
        <strong>请先看这里。</strong>
        <span v-if="described.facts.risk_breakdown.has_warning" data-testid="banner-risk">
          系统对本修改集给出了 {{ described.facts.risk_breakdown.warnings }} 条高风险提示。
        </span>
        <span v-if="totalSuspicious > 0" data-testid="banner-suspicious">
          正文里有 {{ totalSuspicious }} 个不可见或方向控制字符，可能使显示内容与写入内容不一致。
        </span>
      </div>

      <!-- 分区 2a：抬头（工作区、提议连接、短核对编号、有效期） -->
      <header class="changes__head">
        <h2 class="changes__title">
          待执行修改集
          <code class="changes__short" data-testid="short-code">{{ described.facts.short_code }}</code>
        </h2>
        <dl class="changes__meta">
          <dt>工作区</dt>
          <dd data-testid="workspace">
            {{ workspaceLabel ?? described.facts.workspace_id }}
            <span v-if="workspaceLabel !== null" class="changes__dim">（{{ described.facts.workspace_id }}）</span>
          </dd>
          <dt>提议连接</dt>
          <dd data-testid="owner">{{ ownerLabel ?? '未知' }}</dd>
          <dt>状态</dt>
          <dd data-testid="state">{{ described.facts.state }}</dd>
          <dt>创建时间</dt>
          <dd data-testid="created-at">{{ described.facts.created_at }}</dd>
          <dt>有效期</dt>
          <dd data-testid="expiry" :data-expired="expiry?.expired === true">
            {{ expiry?.text }}
          </dd>
          <dt>摘要</dt>
          <!-- 完整摘要给出来供人工核对；它不是凭证，但它是「哪一份内容」的精确定义 -->
          <dd><code class="changes__digest" data-testid="digest">{{ described.facts.digest }}</code></dd>
        </dl>
      </header>

      <!-- 分区 2b：系统计算的事实。每一个数字都来自落库事实。 -->
      <section class="changes__facts" data-testid="facts-region" aria-label="系统计算的事实">
        <h3>系统计算的事实</h3>
        <ul class="changes__totals">
          <li data-testid="total-files">
            <span class="changes__num">{{ described.facts.totals.file_count }}</span> 个文件
            （改 {{ described.facts.totals.edited_files }} /
            新建 {{ described.facts.totals.created_files }} /
            整文件替换 {{ described.facts.totals.replaced_files }}）
          </li>
          <li data-testid="total-lines">
            <span class="changes__num">{{
              formatLineDelta(described.facts.totals.added_lines, described.facts.totals.removed_lines)
            }}</span> 行
            （净 {{ described.facts.totals.net_lines >= 0 ? '+' : '' }}{{ described.facts.totals.net_lines }}）
          </li>
          <li data-testid="total-bytes">
            <span class="changes__num">{{ formatBytes(described.facts.totals.before_bytes) }}</span>
            →
            <span class="changes__num">{{ formatBytes(described.facts.totals.after_bytes) }}</span>
          </li>
          <li data-testid="total-risks">
            <span class="changes__num">{{ described.facts.risk_breakdown.total }}</span> 条风险
            （高风险 {{ described.facts.risk_breakdown.warnings }} /
            提示 {{ described.facts.risk_breakdown.notices }} /
            信息 {{ described.facts.risk_breakdown.infos }}）
          </li>
        </ul>

        <ul v-if="described.facts.risks.length > 0" class="changes__risks" data-testid="risk-list">
          <li
            v-for="(risk, index) in sortedRisks()"
            :key="`${risk.code}-${index}`"
            :class="`changes__risk changes__risk--${risk.level}`"
            :data-level="risk.level"
            :data-code="risk.code"
          >
            <span class="changes__risk-level">{{ risk.level }}</span>
            {{ risk.message }}
          </li>
        </ul>
        <p v-else class="changes__dim" data-testid="no-risk">系统未给出风险提示（这不等于没有风险）。</p>
      </section>

      <!--
        分区 3：模型撰写。**单独一个块、带固定标签**。
        它出现在事实区**之后**，不是之前 —— 先看到数字再看到说明，
        与先看到说明再看到数字，是两种不同的阅读。
      -->
      <section class="changes__prose" data-testid="prose-region" aria-label="模型撰写的说明">
        <h3>{{ described.model_prose.label }}</h3>
        <p class="changes__notice" data-testid="prose-notice">{{ described.model_prose.untrusted_notice }}</p>
        <blockquote class="changes__summary" data-testid="summary">{{ described.model_prose.summary }}</blockquote>
      </section>

      <!-- 分区 4：正文 -->
      <section class="changes__body" aria-label="文件与差异">
        <h3>文件（{{ described.facts.files.length }}）</h3>
        <ul class="changes__files" data-testid="file-list">
          <li
            v-for="file in described.facts.files"
            :key="file.path"
            :class="['changes__file', { 'changes__file--selected': file.path === selected?.path }]"
            :data-path="file.path"
            data-testid="file-row"
          >
            <button type="button" class="changes__file-button" @click="select(file.path)">
              <span class="changes__file-path">{{ file.path }}</span>
              <span class="changes__file-op">{{ file.op }}</span>
              <span class="changes__file-delta">{{ formatLineDelta(file.added_lines, file.removed_lines) }}</span>
              <span class="changes__file-bytes">
                {{ formatBytes(file.before_size) }} → {{ formatBytes(file.after_size) }}
              </span>
              <span
                v-if="suspiciousByPath[file.path] !== undefined"
                class="changes__file-suspicious"
                data-testid="file-suspicious"
              >⚠ {{ suspiciousByPath[file.path] }} 个可疑字符</span>
              <!--
                LWB-036：**逐个文件**写出「看过了没有」。
                只给一个总数是不够的：操作者据此知道还差几个，却不知道
                差哪几个 —— 而一个从没打开过的文件不会自己跳到屏幕上。
              -->
              <span
                v-if="coverageOf(file.path)?.covered === false"
                class="changes__file-unseen"
                data-testid="file-unseen"
                :data-reason="coverageOf(file.path)?.reason"
              >未复核（{{ coverageOf(file.path)?.reason }}）</span>
              <span v-else class="changes__file-covered" data-testid="file-covered">已复核</span>
              <span class="changes__file-enc">{{ file.encoding }} / {{ file.newline }}<template v-if="file.bom"> / BOM</template></span>
            </button>
          </li>
        </ul>

        <DiffView
          v-if="selected !== null"
          :key="selected.path"
          :path="selected.path"
          :op="selected.op"
          :before-text="selectedText?.before ?? null"
          :after-text="selectedText?.after ?? null"
          :unified="selectedText?.unified ?? null"
          :unified-truncated="selectedText?.unified_truncated === true"
          :page-index="selectedText?.pages ?? null"
          :stats="selected"
          @next-page="onNextPage"
        />
      </section>

      <!--
        分区 5：动作。只在 `approvalAffordance` 允许时出现。
        主按钮是「批准并应用」（方案 §10.2 的原文），拒绝是次要动作。
      -->
      <footer class="changes__actions" data-testid="actions">
        <!--
          复核进度。它出现在**按钮之前**，因为它是按钮那个问题的答案：
          「凭什么可以批准」在 `coverage` 里的答案是「全都看过了」，
          而操作者要能看到这个答案，而不是只看到一个按钮。
        -->
        <p class="changes__coverage" data-testid="review-coverage" :data-status="coverage.status">
          已复核 {{ coverage.covered_count }} / {{ coverage.total_count }} 个文件
          <span v-if="coverage.unseen.length > 0" data-testid="unseen-paths">
            · 未取回差异：{{ coverage.unseen.join('、') }}
          </span>
          <span v-if="coverage.truncated.length > 0" data-testid="truncated-paths">
            · 未读到末尾：{{ coverage.truncated.join('、') }}
          </span>
        </p>
        <p class="changes__gate" data-testid="gate-message">{{ affordance.message }}</p>
        <p v-if="affordance.offer_relogin" class="changes__relogin" data-testid="relogin-hint">
          需要重新建立会话：请在本机运行本地启动命令。
        </p>
        <div class="changes__buttons">
          <button
            v-if="affordance.can_reject"
            type="button"
            class="changes__reject"
            data-testid="reject-button"
            :disabled="busy"
            @click="onReject"
          >
            拒绝
          </button>
          <button
            v-if="affordance.can_approve"
            type="button"
            class="changes__approve"
            data-testid="approve-button"
            :disabled="busy"
            @click="onApprove"
          >
            批准并应用
          </button>
        </div>
        <!--
          按钮不给时的说明。**不留白**：一个空着的按钮位置会让人以为
          界面坏了或自己看漏了，而真实原因（没有会话 / 已过期 / 状态不对）
          正是他下一步该处理的事。
        -->
        <p v-if="!affordance.can_approve && affordance.blocked_reason !== 'NOT_REQUIRED'" class="changes__blocked" data-testid="blocked-reason">
          批准入口不可用（{{ affordance.blocked_reason }}）。
        </p>
        <p v-if="affordance.can_approve" class="changes__hint" data-testid="not-written-hint">
          批准只记录授权并排队，**不会立即写入文件**。
        </p>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.changes {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 68rem;
}

.changes__banner {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 2px solid var(--lwb-danger-fg, #8a1c1c);
  background: var(--lwb-danger-bg, #ffd9d9);
  color: var(--lwb-danger-fg, #8a1c1c);
  border-radius: 6px;
}

.changes__meta {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 12px;
  margin: 8px 0 0;
}

.changes__meta dt {
  color: var(--lwb-muted, #5a6270);
}

.changes__meta dd {
  margin: 0;
}

.changes__dim {
  color: var(--lwb-muted, #5a6270);
}

.changes__digest {
  overflow-wrap: anywhere;
}

.changes__risk-level {
  font-weight: 700;
  margin-right: 6px;
}

.changes__risk--warning {
  color: var(--lwb-danger-fg, #8a1c1c);
}

.changes__prose {
  border-left: 4px solid var(--lwb-border, #d0d4da);
  padding-left: 12px;
}

.changes__notice {
  color: var(--lwb-muted, #5a6270);
  margin: 4px 0;
}

.changes__summary {
  margin: 4px 0 0;
  white-space: pre-wrap;
}

.changes__files {
  list-style: none;
  padding: 0;
  margin: 8px 0;
}

.changes__file-button {
  display: flex;
  gap: 12px;
  width: 100%;
  text-align: left;
  padding: 6px 8px;
  background: none;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
}

.changes__file--selected .changes__file-button {
  border-color: var(--lwb-border, #d0d4da);
  background: var(--lwb-selected-bg, #eef2f7);
}

.changes__file-path {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  flex: 1 1 auto;
}

.changes__file-suspicious {
  color: var(--lwb-danger-fg, #8a1c1c);
  font-weight: 700;
}

.changes__file-unseen {
  color: var(--lwb-danger-fg, #8a1c1c);
  font-weight: 700;
}

.changes__file-covered {
  color: var(--lwb-muted, #5a6270);
}

.changes__coverage {
  margin: 0 0 4px;
  color: var(--lwb-muted, #5a6270);
}

.changes__coverage[data-status='incomplete'] {
  color: var(--lwb-danger-fg, #8a1c1c);
  font-weight: 700;
}

.changes__actions {
  border-top: 1px solid var(--lwb-border, #d0d4da);
  padding-top: 12px;
}

.changes__buttons {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
