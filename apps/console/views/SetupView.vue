<!--
  SetupView —— 首次配置与连接状态页（LWB-035）。

  对应方案 §10.1 的「首次配置 / 连接状态」两行与 LWB-035 的执行步骤 2、3：

  > 2. 显示 daemon、MCP adapter、tunnel-client 与账号验收状态，**不把进程运行
  >    等同于平台可调用**。
  > 3. 提供脱敏诊断、一键暂停、重新验证和本地启动帮助。

  ## 页面的分区，顺序是设计的一部分

  1. **通栏结论**（`platform.callable`）—— 一句话回答「网页端现在能不能调用
     本机工具」。它在最上面，因为下面每一条都是它的理由。
  2. **读数时刻** —— 「重新验证」按钮就在这一行上。验收标准 3 要的时间维度
     只有在这一行可读时才成立：读者必须能看见这份结论出自什么时候。
  3. **四条腿** —— daemon / 适配器 / 隧道 / 账号验收，每格都带一句
     「这份读数**不能**证明什么」。
  4. **直写门禁** —— 四个门禁格与能力开关逐格列值，并给出关着的理由。
     这一区是验收标准 2 在界面上的样子。
  5. **紧急停用** —— 按下去之后**五件事**逐条说出来，以及上一次按键的结果。
  6. **脱敏诊断** —— 可复制的文本，附带「已隐去」台账与终检结论。
  7. **本地启动帮助** —— 只在有处境时出现。

  ## 这个组件不做判定

  它不算平台可调用性、不与自己与门禁、不挑帮助条目 —— 三件事分别由
  `src/setup/{platform,capabilities,help}.ts` 负责，而它们全是纯函数。
  组件只把它们摆出来，因此「界面上显示了什么」与「被断言的是什么」
  是同一份东西。**组件也不读时钟**：`now` 是必填的 prop。
-->

<script setup lang="ts">
import { computed } from 'vue';
import type { CapabilityFlags } from '@lwb/contracts';
import type { SessionPresence } from '../src/changes/approval.ts';
import {
  applicableHelp,
  describeFreshness,
  freshnessOf,
  localStartHelp,
  pauseOutcomeReport,
  pauseView,
  platformVerdict,
  redactedDiagnostic,
  writeGate,
  type ConnectionRow,
  type Gates,
  type PauseOutcomeReading,
  type PauseStatusReading,
  type Reading,
  type StatusReading,
  type TunnelReading,
  type WorkspaceRow,
} from '../src/setup/index.ts';

const props = withDefaults(
  defineProps<{
    /** 控制台会话。`null` 表示未建立（暂停与重新验证都不给入口）。 */
    readonly session?: SessionPresence | null;
    /** 会话是否已过期（与「未登录」分开，理由见 `src/changes/approval.ts`）。 */
    readonly sessionExpired?: boolean;
    /** 判定时刻。**必填** —— 组件不读时钟，否则不可测。 */
    readonly now: string;
    /** `/api/status` 的读数。 */
    readonly status?: Reading<StatusReading> | null;
    /** `connections.list` 的读数。 */
    readonly connections?: Reading<readonly ConnectionRow[]> | null;
    /** 隧道读数。今天没有生产者，因此默认 `null`（见 `platform.ts`）。 */
    readonly tunnel?: Reading<TunnelReading> | null;
    /** `service.pause_status` 的读数。 */
    readonly pause?: Reading<PauseStatusReading> | null;
    /** 上一次暂停/恢复按键的结果。与上面那份读数**分开**，理由见 `readings.ts`。 */
    readonly pauseOutcome?: PauseOutcomeReading | null;
    /** 工作区登记行。**只用于脱敏诊断**，页面上不列它们（那是 WorkspacesView）。 */
    readonly workspaces?: readonly WorkspaceRow[];
    /** 最近一次读取失败的原因。停机时这是最有价值的一行。 */
    readonly lastError?: { readonly code: string; readonly message: string } | null;
    /** `navigator.onLine`。为 `false` 时平台一定不可调用。 */
    readonly browserOnline?: boolean;
    /** 有请求在途时按钮不可再点。 */
    readonly busy?: boolean;
    /** 过期阈值，宿主页面按自己的轮询节奏传。 */
    readonly staleAfterMs?: number;
  }>(),
  {
    session: null,
    sessionExpired: false,
    status: null,
    connections: null,
    tunnel: null,
    pause: null,
    pauseOutcome: null,
    workspaces: () => [],
    lastError: null,
    browserOnline: true,
    busy: false,
  },
);

const emit = defineEmits<{
  /** 重新验证：重新取一次全部读数。**不改变任何服务端状态。** */
  (event: 'reverify'): void;
  (event: 'pause'): void;
  (event: 'resume'): void;
  /**
   * 复制脱敏诊断。**只在 `diagnostic.safe` 为真时发出** ——
   * 终检未通过时界面不提供复制，见 `diagnostic.ts`。
   */
  (event: 'copy-diagnostic', payload: { readonly text: string }): void;
}>();

// ---------------------------------------------------------------------------
// 判定（全部来自 src/setup/，本组件不自己算）
// ---------------------------------------------------------------------------

const verdict = computed(() =>
  platformVerdict({
    status: props.status,
    connections: props.connections,
    tunnel: props.tunnel,
    now: props.now,
    browser_online: props.browserOnline,
    last_error: props.lastError,
    ...(props.staleAfterMs === undefined ? {} : { stale_after_ms: props.staleAfterMs }),
  }),
);

const daemonFreshness = computed(() =>
  freshnessOf(props.status, props.now, props.staleAfterMs),
);

const gate = computed(() =>
  writeGate({
    gates: props.status?.value.gates ?? null,
    flags: props.status?.value.capability_flags ?? null,
  }),
);

const pause = computed(() =>
  pauseView({
    session: props.session,
    ...(props.sessionExpired ? { session_expired: true } : {}),
    reading: props.pause,
    now: props.now,
    ...(props.staleAfterMs === undefined ? {} : { stale_after_ms: props.staleAfterMs }),
  }),
);

const outcome = computed(() =>
  props.pauseOutcome === null ? null : pauseOutcomeReport(props.pauseOutcome),
);

const diagnostic = computed(() =>
  redactedDiagnostic({
    now: props.now,
    status: props.status,
    connections: props.connections?.value ?? [],
    workspaces: props.workspaces,
    pause: props.pause,
    platform: verdict.value,
    write_gate: gate.value,
    last_error: props.lastError,
  }),
);

const help = computed(() =>
  applicableHelp({
    session: props.session,
    ...(props.sessionExpired ? { session_expired: true } : {}),
    daemon_freshness: verdict.value.daemon_freshness,
  }),
);

const allHelp = computed(() => localStartHelp());

/** 重新验证要一个会话来读 `/api/status`（没有会话时它答 401）。 */
const canReverify = computed(() => props.session !== null && !props.busy);

// ---------------------------------------------------------------------------
// 逐格列值
// ---------------------------------------------------------------------------

/** 三态。**`无读数` 必须能与 `未通过` 分开**，理由见 `readings.ts` 的文件头。 */
function triState(value: boolean | null): { readonly key: 'yes' | 'no' | 'unknown'; readonly label: string } {
  if (value === null) return { key: 'unknown', label: '无读数' };
  return value ? { key: 'yes', label: '通过' } : { key: 'no', label: '未通过' };
}

function flagState(value: boolean | null): { readonly key: 'yes' | 'no' | 'unknown'; readonly label: string } {
  if (value === null) return { key: 'unknown', label: '无读数' };
  return value ? { key: 'yes', label: '打开' } : { key: 'no', label: '关闭' };
}

const GATE_LABELS: Readonly<Record<keyof Gates, string>> = {
  g0_platform_verified: 'G0 · 真实网页账号验收',
  compatibility_section3_passed: '平台兼容性（§3）',
  native_guard_verified: '原生句柄护栏',
  g4_concurrency_fault_passed: 'G4 · 竞争与故障专项',
};

const FLAG_LABELS: Readonly<Record<keyof CapabilityFlags, string>> = {
  read_enabled: '读取',
  git_enabled: '只读 Git',
  proposal_enabled: '提议（修改集）',
  direct_write_enabled: '直写（不经批准直接改文件）',
  recovery_required: '需要恢复协调',
};

function gateRows(): readonly { readonly key: string; readonly label: string; readonly state: ReturnType<typeof triState> }[] {
  const gates = props.status?.value.gates ?? null;
  return (Object.keys(GATE_LABELS) as readonly (keyof Gates)[]).map((key) => ({
    key,
    label: GATE_LABELS[key],
    state: triState(gates === null ? null : gates[key]),
  }));
}

function flagRows(): readonly { readonly key: string; readonly label: string; readonly state: ReturnType<typeof flagState> }[] {
  const flags = props.status?.value.capability_flags ?? null;
  return (Object.keys(FLAG_LABELS) as readonly (keyof CapabilityFlags)[]).map((key) => ({
    key,
    label: FLAG_LABELS[key],
    state: flagState(flags === null ? null : flags[key]),
  }));
}

function onReverify(): void {
  if (!canReverify.value) return;
  emit('reverify');
}

function onPause(): void {
  if (!pause.value.can_pause || props.busy) return;
  emit('pause');
}

function onResume(): void {
  if (!pause.value.can_resume || props.busy) return;
  emit('resume');
}

function onCopy(): void {
  // 第二道闸：即使某天有人把按钮的 `v-if` 改坏，这里也不会把
  // 未通过终检的文本发出去。
  if (!diagnostic.value.safe) return;
  emit('copy-diagnostic', { text: diagnostic.value.text });
}
</script>

<template>
  <section class="setup" data-testid="setup-view">
    <!-- 分区 1：通栏结论。`callable` 为假时**不许**出现「在线」「正常」。 -->
    <div
      class="setup__banner"
      :class="verdict.callable ? 'setup__banner--ok' : 'setup__banner--no'"
      :data-callable="verdict.callable ? 'true' : 'false'"
      role="status"
      data-testid="banner"
    >
      <strong data-testid="verdict-headline">{{ verdict.headline }}</strong>
      <span class="setup__machine" data-testid="machine-line">{{ verdict.machine_line }}</span>
    </div>

    <!-- 分区 2：读数时刻与「重新验证」。 -->
    <section class="setup__reading" aria-label="读数时刻">
      <p data-testid="reading-at">
        <span class="setup__dim">读数时刻：</span>
        <span data-testid="reading-freshness">{{ describeFreshness(daemonFreshness) }}</span>
        <span v-if="status !== null" class="setup__dim">（{{ status.observed_at }}）</span>
        <span v-else class="setup__dim">（本页还没有成功读到过本机服务）</span>
      </p>
      <button
        type="button"
        class="setup__reverify"
        data-testid="reverify-button"
        :disabled="!canReverify"
        @click="onReverify"
      >
        重新验证
      </button>
      <p v-if="!canReverify" class="setup__dim" data-testid="reverify-blocked">
        {{
          busy
            ? '上一次请求还在途中。'
            : '重新验证需要一个控制台会话（没有会话时本机服务对状态接口答 401）。'
        }}
      </p>
    </section>

    <!-- 分区 3：四条腿。 -->
    <section class="setup__legs" aria-label="平台可调用性">
      <h3>平台链路（四格）</h3>
      <p class="setup__dim">
        下面四格**互不蕴含**：本机服务在跑不等于平台可调用。每一格都写了这份读数能证明什么、不能证明什么。
      </p>
      <ul class="setup__leg-list" data-testid="leg-list">
        <li
          v-for="leg in verdict.legs"
          :key="leg.id"
          class="setup__leg"
          :class="`setup__leg--${leg.state}`"
          :data-leg="leg.id"
          :data-state="leg.state"
          data-testid="leg"
        >
          <div class="setup__leg-head">
            <span class="setup__leg-name">{{ leg.name }}</span>
            <span class="setup__leg-state" data-testid="leg-state">{{ leg.state_label }}</span>
          </div>
          <p class="setup__leg-headline" data-testid="leg-headline">{{ leg.headline }}</p>
          <p class="setup__leg-detail" data-testid="leg-detail">{{ leg.detail }}</p>
        </li>
      </ul>

      <ul v-if="verdict.reasons.length > 0" class="setup__reasons" data-testid="reason-list">
        <li v-for="(reason, index) in verdict.reasons" :key="index" data-testid="reason">{{ reason }}</li>
      </ul>
    </section>

    <!-- 分区 4：直写门禁（验收标准 2）。 -->
    <section class="setup__gate" aria-label="直写门禁">
      <h3>直写门禁</h3>
      <p
        class="setup__gate-summary"
        :data-direct-write="gate.direct_write ? 'true' : 'false'"
        data-testid="write-gate-summary"
      >
        {{ gate.summary }}
      </p>
      <ul v-if="gate.reasons.length > 0" class="setup__gate-reasons" data-testid="write-gate-reasons">
        <li v-for="(reason, index) in gate.reasons" :key="index" data-testid="write-gate-reason">{{ reason }}</li>
      </ul>
      <p class="setup__dim" data-testid="write-gate-note">
        控制台把门禁与能力开关**自己也与一遍**：只有两边都开着，这里才说「已打开」。
        任何一侧说了假话，结果都只会更保守。
      </p>
      <details class="setup__gate-guide" data-testid="gate-guide">
        <summary>G0、G2、G3 分别在验什么？</summary>
        <ul>
          <li><strong>G0 · 平台接入：</strong>真实 ChatGPT 网页经 Tunnel 发现并调用测试工具，同时核对连接身份与平台兼容性。</li>
          <li><strong>G2 · 只读：</strong>真实网页读取测试工作区，并核对本机审计能追踪哪些内容实际出站；本地模拟不能代替网页读取。</li>
          <li><strong>G3 · 提议与审批：</strong>验证提议/审批流程，尤其是本机批准前工作区字节不变、拒绝操作不写入；计划要求的网页验收也要完成。</li>
        </ul>
        <p class="setup__dim" data-testid="gate-guide-runtime-note">
          G2/G3 是阶段验收结论，不是可点击的权限开关。启动服务或启用 ChatGPT 连接不会登记目录、授予工作区权限或让门禁自动通过；运行时能力开关及直写的额外条件见下方读数。
        </p>
      </details>

      <dl class="setup__grid" data-testid="gate-list">
        <template v-for="row in gateRows()" :key="row.key">
          <dt>{{ row.label }}</dt>
          <dd :data-gate="row.key" :data-state="row.state.key" data-testid="gate-row">{{ row.state.label }}</dd>
        </template>
      </dl>

      <dl class="setup__grid" data-testid="flag-list">
        <template v-for="row in flagRows()" :key="row.key">
          <dt>{{ row.label }}</dt>
          <dd :data-flag="row.key" :data-state="row.state.key" data-testid="flag-row">{{ row.state.label }}</dd>
        </template>
      </dl>
      <p class="setup__dim" data-testid="limitations">
        服务端声明的限制：{{ status?.value.limitations.length ? status.value.limitations.join('；') : '（没有给出）' }}
      </p>
    </section>

    <!-- 分区 5：紧急停用（执行步骤 3 的「一键暂停」）。 -->
    <section class="setup__pause" aria-label="紧急停用">
      <h3>紧急停用</h3>
      <p
        class="setup__pause-headline"
        :data-paused="pause.paused === null ? 'unknown' : String(pause.paused)"
        data-testid="pause-headline"
      >
        {{ pause.headline }}
      </p>

      <ul class="setup__facts" data-testid="pause-facts">
        <li v-for="(fact, index) in pause.facts" :key="index" data-testid="pause-fact">{{ fact }}</li>
      </ul>

      <div class="setup__buttons">
        <button
          v-if="pause.can_pause"
          type="button"
          class="setup__pause-button"
          data-testid="pause-button"
          :disabled="busy"
          @click="onPause"
        >
          紧急停用
        </button>
        <button
          v-if="pause.can_resume"
          type="button"
          class="setup__resume-button"
          data-testid="resume-button"
          :disabled="busy"
          @click="onResume"
        >
          解除暂停
        </button>
      </div>

      <p v-if="pause.resume_blocked_reason !== null" class="setup__dim" data-testid="resume-blocked">
        解除暂停不可用（{{ pause.resume_blocked_reason }}）。
      </p>
      <p v-if="pause.offer_relogin" class="setup__dim" data-testid="pause-relogin">
        需要重新建立会话：请在本机重新运行本地启动命令，见下面的「本地启动帮助」。
      </p>

      <!-- 上一次按键的结果。它与上面那份读数**分开显示**：
           刷新不会把它盖掉，而「废止失败了」正是最需要留在屏幕上的那句。 -->
      <div
        v-if="outcome !== null"
        class="setup__outcome"
        :class="`setup__outcome--${outcome.severity}`"
        :data-severity="outcome.severity"
        role="alert"
        data-testid="pause-outcome"
      >
        <strong data-testid="outcome-headline">{{ outcome.headline }}</strong>
        <ul>
          <li v-for="(line, index) in outcome.lines" :key="index" data-testid="outcome-line">{{ line }}</li>
        </ul>
      </div>
    </section>

    <!-- 分区 6：脱敏诊断（执行步骤 3 的「脱敏诊断」）。 -->
    <section class="setup__diagnostic" aria-label="脱敏诊断">
      <h3>脱敏诊断</h3>
      <p class="setup__dim" data-testid="diagnostic-note">
        这一段可以整段复制出去（贴到工单或聊天里）。本机绝对路径一律不出现；凡是被隐去的地方都记在末尾的「已隐去」一节。
      </p>

      <pre class="setup__diagnostic-text" data-testid="diagnostic-text">{{ diagnostic.text }}</pre>

      <p
        class="setup__dim"
        :data-redactions="diagnostic.redactions.length"
        data-testid="diagnostic-redactions"
      >
        已隐去的字段（{{ diagnostic.redactions.length }}）：{{
          diagnostic.redactions.length === 0 ? '（没有）' : diagnostic.redactions.join('、')
        }}
      </p>

      <div class="setup__diagnostic-actions">
        <button
          v-if="diagnostic.safe"
          type="button"
          class="setup__copy"
          data-testid="copy-diagnostic"
          @click="onCopy"
        >
          复制诊断
        </button>
        <p v-else class="setup__danger" data-testid="diagnostic-unsafe">
          终检**未通过**（命中 {{ diagnostic.findings.join('、') }}）—— 因此这里不提供复制。
          请只把上面的模式名报出来，不要把正文贴出去。
        </p>
      </div>
    </section>

    <!-- 分区 7：本地启动帮助。**没有处境时一条都不显示。** -->
    <section v-if="help.length > 0" class="setup__help" aria-label="本地启动帮助">
      <h3>本地启动帮助</h3>
      <article v-for="entry in help" :key="entry.id" :data-help="entry.id" data-testid="help-entry">
        <h4>{{ entry.title }}</h4>
        <ol>
          <li v-for="(step, index) in entry.steps" :key="index" data-testid="help-step">{{ step }}</li>
        </ol>
        <p v-if="entry.warning !== null" class="setup__danger" data-testid="help-warning">{{ entry.warning }}</p>
      </article>
    </section>

    <!-- 全部帮助：按需展开。它的存在是为了让上面那份「按处境挑选」
         不至于让操作者找不到某一条 —— 但默认是收起的。 -->
    <details class="setup__all-help" data-testid="all-help">
      <summary>全部帮助（{{ allHelp.length }} 条）</summary>
      <article v-for="entry in allHelp" :key="entry.id" :data-help="entry.id" data-testid="all-help-entry">
        <h4>{{ entry.title }}</h4>
        <ol>
          <li v-for="(step, index) in entry.steps" :key="index">{{ step }}</li>
        </ol>
        <p v-if="entry.warning !== null" class="setup__danger">{{ entry.warning }}</p>
      </article>
    </details>
  </section>
</template>

<style scoped>
.setup {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 68rem;
}

.setup__banner {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 6px;
  border: 2px solid var(--lwb-border, #d0d4da);
}

.setup__banner--ok {
  border-color: var(--lwb-ok-fg, #1c5c2a);
  background: var(--lwb-ok-bg, #dff3e2);
  color: var(--lwb-ok-fg, #1c5c2a);
}

.setup__banner--no {
  border-color: var(--lwb-warn-fg, #7a5200);
  background: var(--lwb-warn-bg, #fff3d6);
  color: var(--lwb-warn-fg, #7a5200);
}

.setup__reading {
  display: flex;
  gap: 12px;
  align-items: baseline;
  flex-wrap: wrap;
}

.setup__dim {
  color: var(--lwb-muted, #5a6270);
}

.setup__leg-list {
  list-style: none;
  padding: 0;
  margin: 8px 0;
  display: grid;
  gap: 8px;
}

.setup__leg {
  border: 1px solid var(--lwb-border, #d0d4da);
  border-left-width: 4px;
  border-radius: 6px;
  padding: 8px 10px;
}

.setup__leg--ok {
  border-left-color: var(--lwb-ok-fg, #1c5c2a);
}

.setup__leg--off {
  border-left-color: var(--lwb-danger-fg, #8a1c1c);
}

.setup__leg--degraded {
  border-left-color: var(--lwb-warn-fg, #7a5200);
}

/* 「不知道」有它自己的样子：既不是绿也不是红 —— 一个把无读数涂成红色的
   界面会让人去修一个可能没坏的东西，涂成绿色则相反。 */
.setup__leg--unknown {
  border-left-color: var(--lwb-unknown-fg, #6b6b6b);
  border-left-style: dashed;
}

.setup__leg-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.setup__leg-name {
  font-weight: 700;
}

.setup__leg-headline {
  margin: 4px 0;
}

.setup__leg-detail {
  margin: 0;
  color: var(--lwb-muted, #5a6270);
}

.setup__grid {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 12px;
  margin: 8px 0;
}

.setup__grid dd {
  margin: 0;
}

.setup__gate-summary {
  font-weight: 700;
}

.setup__gate-guide {
  margin: 8px 0;
  padding: 8px 10px;
  border: 1px solid var(--lwb-border, #d0d4da);
  border-radius: 6px;
}

.setup__gate-guide summary {
  cursor: pointer;
  font-weight: 700;
}

.setup__gate-guide ul {
  padding-left: 20px;
  margin: 8px 0;
}

.setup__gate-guide li + li {
  margin-top: 6px;
}

.setup__pause-headline {
  font-weight: 700;
}

.setup__danger {
  color: var(--lwb-danger-fg, #8a1c1c);
}

.setup__outcome {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--lwb-border, #d0d4da);
}

.setup__outcome--critical {
  border-color: var(--lwb-danger-fg, #8a1c1c);
  background: var(--lwb-danger-bg, #ffd9d9);
  color: var(--lwb-danger-fg, #8a1c1c);
}

.setup__outcome--attention {
  border-color: var(--lwb-warn-fg, #7a5200);
  background: var(--lwb-warn-bg, #fff3d6);
}

.setup__diagnostic-text {
  max-height: 24rem;
  overflow: auto;
  padding: 8px 10px;
  border: 1px solid var(--lwb-border, #d0d4da);
  border-radius: 6px;
  background: var(--lwb-code-bg, #f6f7f9);
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 0.9em;
  white-space: pre-wrap;
}

.setup__buttons {
  display: flex;
  gap: 8px;
}

.setup__pause-button {
  font-weight: 700;
}
</style>
