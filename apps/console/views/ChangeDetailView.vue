<!--
  ChangeDetailView —— 单个修改集的复核页（LWB-036）。

  与 `ChangesView`（LWB-023 的待批准页）的关系不是「详细版」，而是
  两个不同的问题：

  | | `ChangesView` | 本视图 |
  | --- | --- | --- |
  | 回答的问题 | 「现在有什么要批准的」 | 「这一份到底是什么」 |
  | 内容来源 | 修改集视图（事实） | `changes.get` 的完整响应（事实 + 闸门 + 差异页） |
  | 主交互 | 看清单，批准 | 逐个文件翻差异，看完了再批准 |

  任务书步骤 1 列了六件事，逐条落在结构里：

  | 要求 | 落点 |
  | --- | --- |
  | 按文件分页 | `DiffView` 的 `next-page` + 这里的 `onNextPage` |
  | 完整内容查看 | 原文/新文两种模式 + `diff-complete` 的肯定说法 |
  | 风险汇总 | `detail-region` 里的 `risk-summary`（按等级计数，与逐条清单分开） |
  | 变更统计 | `diff-stats`（逐文件，来自落库事实）与 `total-*`（整份） |
  | 明确批准按钮 | `approve-button`，只在 `approvalAffordance` 允许时出现 |
  | 键盘可访问性 | `onKeydown` + `REVIEW_KEYMAP`（**同一张表**既驱动行为又渲染帮助） |

  ## 键盘那一处的取舍

  `REVIEW_KEYMAP` 同时是**行为的来源**与**帮助文本的来源**。一个把
  帮助文本手写一遍的实现，会在有人加了快捷键之后显示一张过时的表 ——
  而「按键提示与实际行为不一致」比没有提示更坏：操作者会按下去，
  然后以为自己按错了。

  批准**没有**快捷键。理由写在 `paging.ts` 的文件头（一个能被单键触发的
  写入，等于一个能被误触的写入），这里再落到结构上：`onKeydown` 里
  没有任何一条分支能走到 `emit('approve')`。

  ## 这个组件不发请求、不读时钟、不做判定

  与 `ChangesView` 同一条（LWB-023 的文件头写了理由）：它把 props 摆出来，
  把用户意图变成事件。刷新节奏由 `refresh.ts` 判、覆盖由 `review.ts` 判、
  批准资格由 `approval.ts` 判 —— 三份判定都在能跑 node 测试的那一层，
  而这里只是它们的屏幕。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import DiffView from '../components/DiffView.vue';
import {
  actionFor,
  approvalAffordance,
  approvalIdempotencyKey,
  clampIndex,
  describeChange,
  expiryOf,
  formatBytes,
  formatLineDelta,
  positionLabel,
  progressFromTexts,
  reviewCoverageOf,
  REVIEW_KEYMAP,
  stepFile,
  type ChangeDetail,
  type FileText,
  type KeyboardAction,
  type RefreshDecision,
  type SessionPresence,
} from '../src/changes/index.ts';
import { findSuspicious } from '../src/changes/suspicious.ts';

const props = withDefaults(
  defineProps<{
    /** `changes.get` 的响应，已由 `parseChangeDetail` 解析。`null` = 还没读到。 */
    readonly detail: ChangeDetail | null;
    readonly session?: SessionPresence | null;
    readonly sessionExpired?: boolean;
    /** 判定时刻，由调用方传入（组件不读时钟，否则不可测）。 */
    readonly now: string;
    /** 逐文件正文（累计页 + 原文/新文）。 */
    readonly texts?: Readonly<Record<string, FileText>>;
    /** 提议连接的别名。**由调用方查好传进来**，理由见 `ChangesView` 同名 prop。 */
    readonly ownerLabel?: string | null;
    /** 刷新决策（`refreshDecisionOf` 的结果）。`null` = 这一页不做自动刷新。 */
    readonly refresh?: RefreshDecision | null;
    /** 有请求在途时按钮不可再点。 */
    readonly busy?: boolean;
    /** 显示模式，受控。省略时由组件自己管（键盘与按钮都改它）。 */
    readonly initialMode?: 'unified' | 'before' | 'after';
  }>(),
  {
    session: null,
    sessionExpired: false,
    texts: () => ({}),
    ownerLabel: null,
    refresh: null,
    busy: false,
    initialMode: 'unified',
  },
);

const emit = defineEmits<{
  (event: 'approve', payload: { readonly change_id: string; readonly digest: string; readonly idempotency_key: string }): void;
  (event: 'reject', payload: { readonly change_id: string; readonly digest: string }): void;
  /** 用户在文件清单里选了另一个文件（键盘与点击都走这里）。 */
  (event: 'select-file', payload: { readonly path: string }): void;
  /** 要求取回当前文件的下一页差异。 */
  (event: 'next-page', payload: { readonly path: string }): void;
}>();

const selectedPath = ref<string | null>(null);
const mode = ref<'unified' | 'before' | 'after'>(props.initialMode);

const change = computed(() => props.detail?.change ?? null);
const files = computed(() => change.value?.files ?? []);

const selectedIndex = computed(() => {
  const path = selectedPath.value;
  if (path === null) return 0;
  const found = files.value.findIndex((file) => file.path === path);
  return found < 0 ? 0 : found;
});

const selected = computed(() => files.value[selectedIndex.value] ?? null);

/**
 * 修改集一变就把选中项与模式都收回初始值。
 *
 * 只重置选中项是不够的：停在「原文」模式上换了一份修改集，操作者会
 * 以为屏幕上那段文字是差异。两件事一起重置，屏幕回到一个已知状态。
 */
watch(
  () => change.value?.change_id ?? null,
  () => {
    selectedPath.value = null;
    mode.value = props.initialMode;
  },
);

const described = computed(() => (change.value === null ? null : describeChange(change.value)));
const expiry = computed(() => (change.value === null ? null : expiryOf(change.value.expires_at, props.now)));

const progress = computed(() => progressFromTexts(props.texts));

/**
 * 复核覆盖。**闸门来自响应本身**（`detail.content_gate`），不是组件写死的
 * `null` —— 「服务端愿不愿意给内容」是服务端的事实，组件无权替它回答。
 */
const coverage = computed(() =>
  reviewCoverageOf({ change: change.value, progress: progress.value, gate: props.detail?.content_gate ?? null }),
);

const affordance = computed(() =>
  approvalAffordance({
    session: props.session ?? null,
    ...(props.sessionExpired ? { session_expired: true } : {}),
    change: change.value,
    coverage: coverage.value,
    now: props.now,
  }),
);

const selectedText = computed<FileText | null>(() => {
  const path = selected.value?.path;
  if (path === undefined) return null;
  return props.texts[path] ?? null;
});

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

const totalSuspicious = computed(() => Object.values(suspiciousByPath.value).reduce((sum, n) => sum + n, 0));

function coverageOf(path: string): { readonly covered: boolean; readonly reason: string | null } | null {
  const found = coverage.value.files.find((file) => file.path === path);
  return found === undefined ? null : { covered: found.covered, reason: found.reason };
}

/** 分页位置那句人话。见 `paging.ts` 的 `positionLabel`。 */
const position = computed(() => {
  const text = selectedText.value;
  const pages = text?.pages ?? (text?.unified === null || text?.unified === undefined ? 0 : 1);
  return positionLabel(
    selectedIndex.value,
    files.value.length,
    pages,
    // `null` 是「还没问过服务端」，`false` 是「它说了还有」。两者不能合成一个
    // 假值 —— 混起来会让「尚未载入」显示成「还有更多」。
    text === null ? null : text.unified_truncated !== true,
  );
});

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

/**
 * 选中第 `index` 个文件（越界会被夹回来）。
 *
 * 按钮与键盘**都走这里**：`paging.ts` 的文件头写了理由 —— 方向有两处
 * 就会有两条路，而两条路迟早不一样。
 */
function goTo(index: number): void {
  const clamped = clampIndex(index, files.value.length);
  const file = files.value[clamped];
  if (file === undefined) return;
  // 已经在选中的那一格上就**不发事件**。`stepFile` 到边界是停住（不绕回），
  // 于是在最后一个文件上一直按 `j` 会落到这里 —— 而一个「每次都发」的
  // 实现会让调用方在同一个文件上反复做同一件工作（最坏的情况是重复取
  // 差异页）。「停住」在屏幕上是一个动作都没有，那就该一个事件都没有。
  if (selectedPath.value === file.path) return;
  selectedPath.value = file.path;
  emit('select-file', { path: file.path });
}

/**
 * 相对移动一格。**用 `stepFile` 而不是 `index ± 1`**：边界行为
 * （停住而不是绕回）定义在那一处，这里再写一遍就是第二份定义。
 */
function stepBy(delta: -1 | 1): void {
  goTo(stepFile(selectedIndex.value, files.value.length, delta));
}

function onNextPage(): void {
  const path = selected.value?.path;
  if (path === undefined) return;
  emit('next-page', { path });
}

function onApprove(): void {
  const current = change.value;
  if (current === null || !affordance.value.can_approve || props.busy) return;
  emit('approve', {
    change_id: current.change_id,
    digest: current.digest,
    idempotency_key: approvalIdempotencyKey(current),
  });
}

function onReject(): void {
  const current = change.value;
  if (current === null || !affordance.value.can_reject || props.busy) return;
  emit('reject', { change_id: current.change_id, digest: current.digest });
}

/**
 * 键盘。**动作由 `actionFor` 决定，与快捷键帮助表是同一张表。**
 *
 * 认不出的键直接返回（不 `preventDefault`）：这一页不能把浏览器自己的
 * 快捷键吃掉，理由写在 `paging.ts`。
 *
 * 注意这里**没有 approve / reject 分支**，而且不是「暂时没写」——
 * `KeyboardAction` 这个类型里就没有那两项。想加一个单键批准，
 * 得先改那个类型，而那一步会把 `paging.ts` 文件头里的理由摆到改的人面前。
 */
function onKeydown(event: KeyboardEvent): void {
  const action: KeyboardAction | null = actionFor(event.key);
  if (action === null) return;
  event.preventDefault();

  switch (action) {
    case 'next-file':
      stepBy(1);
      break;
    case 'prev-file':
      stepBy(-1);
      break;
    case 'first-file':
      goTo(0);
      break;
    case 'last-file':
      goTo(files.value.length - 1);
      break;
    case 'mode-unified':
      mode.value = 'unified';
      break;
    case 'mode-before':
      mode.value = 'before';
      break;
    case 'mode-after':
      mode.value = 'after';
      break;
    case 'next-page':
      onNextPage();
      break;
  }
}

/**
 * 按动作去重的帮助文本。
 *
 * 一个动作有两个键（`j` 与 `ArrowDown`）时，表里有两行而帮助里该是一行：
 * 操作者要知道的是「怎么走下一个文件」，不是「这个界面里有几条绑定」。
 */
const keyHelp = computed(() => {
  const byAction = new Map<string, string[]>();
  for (const binding of REVIEW_KEYMAP) {
    const keys = byAction.get(binding.action) ?? [];
    keys.push(binding.key);
    byAction.set(binding.action, keys);
  }
  return [...byAction].map(([action, keys]) => ({
    action,
    keys: keys.join(' / '),
    label: REVIEW_KEYMAP.find((binding) => binding.action === action)?.label ?? action,
  }));
});

/** 风险按等级计数（「风险汇总」这一格）。逐条清单在下面另一处。 */
const riskCounts = computed(() => {
  const risks = described.value?.facts.risks ?? [];
  const counts = { warning: 0, notice: 0, info: 0 };
  for (const risk of risks) {
    if (risk.level === 'warning') counts.warning += 1;
    else if (risk.level === 'notice') counts.notice += 1;
    else counts.info += 1;
  }
  return counts;
});

const RISK_ORDER: Readonly<Record<string, number>> = { warning: 0, notice: 1, info: 2 };

function sortedRisks(): readonly { readonly level: string; readonly code: string; readonly message: string }[] {
  const risks = described.value?.facts.risks ?? [];
  return [...risks].sort((a, b) => (RISK_ORDER[a.level] ?? 9) - (RISK_ORDER[b.level] ?? 9));
}
</script>

<template>
  <!--
    `tabindex="-1"` + `@keydown`：整页接键盘，而不是要求操作者先点进
    某个容器。焦点落在这个 section 上时按键才生效，因此它有一个可见的
    焦点圈（见样式）—— 一个「按了没反应但其实是焦点不在」的界面，
    与一个坏掉的界面在操作者那里是同一件事。
  -->
  <section
    class="detail"
    data-testid="change-detail"
    tabindex="-1"
    aria-label="修改集复核"
    @keydown="onKeydown"
  >
    <p v-if="detail === null" class="detail__empty" data-testid="detail-empty">
      尚未读到这个修改集。
    </p>

    <template v-else-if="described !== null">
      <!-- 分区 1：通栏警告。判据与 `ChangesView` 一致，不读模型摘要。 -->
      <div
        v-if="described.facts.risk_breakdown.has_warning || totalSuspicious > 0"
        class="detail__banner"
        role="alert"
        data-testid="banner"
      >
        <strong>请先看这里。</strong>
        <span v-if="described.facts.risk_breakdown.has_warning" data-testid="banner-risk">
          系统对本修改集给出了 {{ described.facts.risk_breakdown.warnings }} 条高风险提示。
        </span>
        <span v-if="totalSuspicious > 0" data-testid="banner-suspicious">
          正文里有 {{ totalSuspicious }} 个不可见或方向控制字符。
        </span>
      </div>

      <!-- 分区 2：风险汇总与变更统计。数字全部来自落库事实。 -->
      <section class="detail__region" data-testid="detail-region" aria-label="风险汇总与变更统计">
        <h2 class="detail__title">
          <code data-testid="short-code">{{ described.facts.short_code }}</code>
          <span class="detail__state" data-testid="state">{{ described.facts.state }}</span>
        </h2>

        <!--
          风险汇总：**先给计数，再给逐条**。计数回答「要不要认真看」，
          逐条回答「看什么」。只有逐条时，操作者要读完才知道有几条。
        -->
        <ul class="detail__counts" data-testid="risk-summary">
          <li data-testid="risk-count-warning" :data-count="riskCounts.warning">
            高风险 {{ riskCounts.warning }}
          </li>
          <li data-testid="risk-count-notice" :data-count="riskCounts.notice">
            提示 {{ riskCounts.notice }}
          </li>
          <li data-testid="risk-count-info" :data-count="riskCounts.info">
            信息 {{ riskCounts.info }}
          </li>
        </ul>

        <ul class="detail__totals" data-testid="change-stats">
          <li data-testid="total-files">
            <span class="detail__num">{{ described.facts.totals.file_count }}</span> 个文件
          </li>
          <li data-testid="total-lines">
            <span class="detail__num">{{
              formatLineDelta(described.facts.totals.added_lines, described.facts.totals.removed_lines)
            }}</span> 行（净 {{ described.facts.totals.net_lines >= 0 ? '+' : '' }}{{ described.facts.totals.net_lines }}）
          </li>
          <li data-testid="total-bytes">
            <span class="detail__num">{{ formatBytes(described.facts.totals.before_bytes) }}</span> →
            <span class="detail__num">{{ formatBytes(described.facts.totals.after_bytes) }}</span>
          </li>
        </ul>

        <dl class="detail__meta">
          <dt>工作区</dt>
          <dd data-testid="workspace">{{ detail.workspace?.alias ?? described.facts.workspace_id }}</dd>
          <dt>提议连接</dt>
          <dd data-testid="owner">{{ ownerLabel ?? (detail.owner_connection_id || '未知') }}</dd>
          <dt>有效期</dt>
          <dd data-testid="expiry" :data-expired="expiry?.expired === true">{{ expiry?.text }}</dd>
          <dt>摘要</dt>
          <dd><code class="detail__digest" data-testid="digest">{{ described.facts.digest }}</code></dd>
          <dt v-if="detail.approval !== null">批准</dt>
          <dd v-if="detail.approval !== null" data-testid="approval-state">
            {{ detail.approval.state }}
            <span class="detail__dim">（{{ detail.approval.expires_at }} 前有效）</span>
          </dd>
          <dt>读取时刻</dt>
          <dd data-testid="observed-at">{{ detail.observed_at }}</dd>
        </dl>

        <ul v-if="described.facts.risks.length > 0" class="detail__risks" data-testid="risk-list">
          <li
            v-for="(risk, index) in sortedRisks()"
            :key="`${risk.code}-${index}`"
            :data-level="risk.level"
            :data-code="risk.code"
          >
            <span class="detail__risk-level">{{ risk.level }}</span>{{ risk.message }}
          </li>
        </ul>
        <p v-else class="detail__dim" data-testid="no-risk">系统未给出风险提示（这不等于没有风险）。</p>
      </section>

      <!-- 分区 3：模型撰写。单独一块、固定标签、在事实之后。 -->
      <section class="detail__prose" data-testid="prose-region" aria-label="模型撰写的说明">
        <h3>{{ described.model_prose.label }}</h3>
        <p class="detail__dim" data-testid="prose-notice">{{ described.model_prose.untrusted_notice }}</p>
        <blockquote class="detail__summary" data-testid="summary">{{ described.model_prose.summary }}</blockquote>
      </section>

      <!--
        分区 4：正文与分页。
        `next-page` 由 DiffView 发出、这里转给调用方 —— 视图不发请求。
      -->
      <section class="detail__body" aria-label="文件与差异">
        <div class="detail__pager">
          <button type="button" data-testid="prev-file" :disabled="selectedIndex <= 0" @click="stepBy(-1)">
            上一个文件
          </button>
          <span class="detail__position" data-testid="position" aria-live="polite">{{ position }}</span>
          <button
            type="button"
            data-testid="next-file"
            :disabled="selectedIndex >= files.length - 1"
            @click="stepBy(1)"
          >
            下一个文件
          </button>
        </div>

        <ul class="detail__files" data-testid="file-list">
          <li
            v-for="(file, index) in files"
            :key="file.path"
            :class="['detail__file', { 'detail__file--selected': index === selectedIndex }]"
            :data-path="file.path"
            :aria-current="index === selectedIndex ? 'true' : undefined"
            data-testid="file-row"
          >
            <button type="button" class="detail__file-button" @click="goTo(index)">
              <span class="detail__file-path">{{ file.path }}</span>
              <span class="detail__file-delta">{{ formatLineDelta(file.added_lines, file.removed_lines) }}</span>
              <span
                v-if="suspiciousByPath[file.path] !== undefined"
                class="detail__file-suspicious"
                data-testid="file-suspicious"
              >⚠ {{ suspiciousByPath[file.path] }} 个可疑字符</span>
              <span
                v-if="coverageOf(file.path)?.covered === false"
                class="detail__file-unseen"
                data-testid="file-unseen"
                :data-reason="coverageOf(file.path)?.reason"
              >未复核（{{ coverageOf(file.path)?.reason }}）</span>
              <span v-else class="detail__file-covered" data-testid="file-covered">已复核</span>
            </button>
          </li>
        </ul>

        <!--
          `key` 里带上 `mode`：`DiffView` 的 `initialMode` 是**初值**，
          它在挂载时读一次、之后归自己管（那是它的 `mode` ref 的注释说
          清楚的）。因此「从外面改模式」唯一的办法是给它一个新的实例 ——
          也就是让实例身份 = (文件, 模式)。少了这一截，键盘按 `2` 会改到
          一个没有任何东西在读的变量上：快捷键帮助里写着「原文」，
          而屏幕纹丝不动。
        -->
        <DiffView
          v-if="selected !== null"
          :key="`${selected.path}:${mode}`"
          :path="selected.path"
          :op="selected.op"
          :before-text="selectedText?.before ?? null"
          :after-text="selectedText?.after ?? null"
          :unified="selectedText?.unified ?? null"
          :unified-truncated="selectedText?.unified_truncated === true"
          :page-index="selectedText?.pages ?? null"
          :stats="selected"
          :initial-mode="mode"
          @next-page="onNextPage"
          @update:mode="mode = $event"
        />
      </section>

      <!-- 分区 5：刷新状态。**它是键盘帮助的邻居**，因为两者都是「这一页怎么用」。 -->
      <section class="detail__ops" aria-label="刷新与键盘">
        <p v-if="refresh !== null" data-testid="refresh-state" :data-poll="refresh.poll" :data-stop="refresh.stop">
          {{ refresh.message }}
        </p>

        <details class="detail__keys" data-testid="keyboard">
          <summary>键盘</summary>
          <ul data-testid="keymap">
            <li v-for="entry in keyHelp" :key="entry.action" :data-action="entry.action">
              <kbd>{{ entry.keys }}</kbd> {{ entry.label }}
            </li>
          </ul>
          <p class="detail__dim">键盘快捷键只用于浏览差异，不触发写入；写入权限由当前 workspace 的工具 grant 决定。</p>
        </details>
      </section>

      <!-- 分区 6：动作。 -->
      <footer class="detail__actions" data-testid="actions">
        <p class="detail__coverage" data-testid="review-coverage" :data-status="coverage.status">
          已复核 {{ coverage.covered_count }} / {{ coverage.total_count }} 个文件
          <span v-if="coverage.unseen.length > 0" data-testid="unseen-paths">
            · 未取回差异：{{ coverage.unseen.join('、') }}
          </span>
          <span v-if="coverage.truncated.length > 0" data-testid="truncated-paths">
            · 未读到末尾：{{ coverage.truncated.join('、') }}
          </span>
        </p>
        <p data-testid="gate-message">{{ affordance.message }}</p>
        <p v-if="affordance.offer_relogin" data-testid="relogin-hint">
          需要重新建立会话：请在本机运行本地启动命令。
        </p>
        <div class="detail__buttons">
          <button
            v-if="affordance.can_reject"
            type="button"
            data-testid="reject-button"
            :disabled="busy"
            @click="onReject"
          >
            拒绝
          </button>
          <button
            v-if="affordance.can_approve"
            type="button"
            data-testid="approve-button"
            :disabled="busy"
            @click="onApprove"
          >
            批准并应用
          </button>
        </div>
        <p v-if="affordance.blocked_reason === 'NOT_REQUIRED'" data-testid="grant-write-hint">
          无需逐次本地批准；调用 change_apply 时会重新核验当前 workspace 的“文件修改” grant。
        </p>
        <p v-else-if="affordance.can_approve" data-testid="not-written-hint">
          批准只记录授权并排队，**不会立即写入文件**。
        </p>
        <p v-else data-testid="blocked-reason">
          批准入口不可用（{{ affordance.blocked_reason }}）。
        </p>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 68rem;
}

.detail:focus-visible {
  outline: 2px solid var(--lwb-focus, #1a5fb4);
  outline-offset: 4px;
}

.detail__banner {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 2px solid var(--lwb-danger-fg, #8a1c1c);
  background: var(--lwb-danger-bg, #ffd9d9);
  color: var(--lwb-danger-fg, #8a1c1c);
  border-radius: 6px;
}

.detail__counts,
.detail__totals {
  display: flex;
  gap: 16px;
  list-style: none;
  padding: 0;
  margin: 8px 0;
}

.detail__counts [data-count='0'] {
  color: var(--lwb-muted, #5a6270);
}

.detail__meta {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 12px;
  margin: 8px 0;
}

.detail__meta dt {
  color: var(--lwb-muted, #5a6270);
}

.detail__meta dd {
  margin: 0;
}

.detail__dim {
  color: var(--lwb-muted, #5a6270);
}

.detail__digest {
  overflow-wrap: anywhere;
}

.detail__prose {
  border-left: 4px solid var(--lwb-border, #d0d4da);
  padding-left: 12px;
}

.detail__summary {
  margin: 4px 0 0;
  white-space: pre-wrap;
}

.detail__pager {
  display: flex;
  gap: 12px;
  align-items: center;
}

.detail__position {
  flex: 1 1 auto;
  text-align: center;
  color: var(--lwb-muted, #5a6270);
}

.detail__files {
  list-style: none;
  padding: 0;
  margin: 8px 0;
}

.detail__file-button {
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

.detail__file--selected .detail__file-button {
  border-color: var(--lwb-border, #d0d4da);
  background: var(--lwb-selected-bg, #eef2f7);
}

.detail__file-path {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  flex: 1 1 auto;
}

.detail__file-suspicious,
.detail__file-unseen {
  color: var(--lwb-danger-fg, #8a1c1c);
  font-weight: 700;
}

.detail__file-covered {
  color: var(--lwb-muted, #5a6270);
}

.detail__coverage[data-status='incomplete'],
.detail__coverage[data-status='unavailable'] {
  color: var(--lwb-danger-fg, #8a1c1c);
  font-weight: 700;
}

.detail__actions {
  border-top: 1px solid var(--lwb-border, #d0d4da);
  padding-top: 12px;
}

.detail__buttons {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
