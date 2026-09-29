<!--
  WorkspacesView —— 工作区（哪些目录正在暴露）页（LWB-035 执行步骤 1）。

  对应方案 §10.1 与 LWB-035 的两条要求：

  > 1. 提供**目录 / 单文件**授权、**只读模式**、**写入模式**与**风险说明**。

  以及验收标准 1：

  > 非技术用户能知道**当前哪台机器、哪些目录正在暴露**。

  ## 这一页的第一句话不是「已登记 N 个」，而是「有没有东西正在出去」

  「登记了几个目录」与「有几个目录正在被暴露」是两个问题，而它们的答案
  在能力关闭时正好相反（登记 3 个、暴露 0 个）。因此页面顶部那一句由
  `exposureSummary` 给出**两句**：登记数与暴露状态，外加一行能力开关的
  现状。一个只报登记数的页面会让非技术用户以为内容已经在外面了。

  ## 风险说明是**选项的一部分**，不是页面底部的一段小字

  两种模式各自的 `risk` 紧跟在它的单选框下面（`modeOffers`）。这有两条
  理由：一是它在操作者做选择的那一刻才可能被读到；二是「只读不等于不出
  本机」这句话必须出现在**选只读的时候** —— 一个认为只读就是安全的用户
  不会去读页面底部的说明。

  ## 这个组件不做判定

  它不自己校验表单（`validateRegister`）、不自己拼请求体（`registerRequest`）、
  不自己算暴露摘要（`exposureSummary`）。因此「点了登记之后发出去的那几个
  字段」与「被断言的那几个字段」是同一份东西。
-->

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { CapabilityFlags } from '@lwb/contracts';
import type { SessionPresence } from '../src/changes/approval.ts';
import {
  describeWorkspace,
  exposureSummary,
  modeOffers,
  registerRequest,
  validateRegister,
  writeGate,
  type RegisterDraft,
  type WorkspaceKind,
  type WorkspaceMode,
  type WorkspaceRow,
  type WorkspaceAccessRow,
  type ModelWorkspaceCapability,
} from '../src/setup/index.ts';

const ACCESS_OPTIONS: readonly {
  readonly capability: ModelWorkspaceCapability;
  readonly label: string;
  readonly tools: string;
}[] = [
  { capability: 'list', label: '列出目录/文件名', tools: 'file_list' },
  { capability: 'read', label: '读取文件内容', tools: 'file_read、文件快照/错误详情' },
  { capability: 'search', label: '搜索文本', tools: 'text_search' },
  { capability: 'git_read', label: '读取 Git 状态与差异', tools: 'git_status、git_diff' },
  { capability: 'propose', label: '文件修改（直接写入）', tools: 'file_create、file_delete、change_prepare、change_apply、change_revert_prepare；file_edit 还需读取授权' },
  { capability: 'command_exec', label: '命令执行（高风险）', tools: 'command_exec：cmd、PowerShell、Bash' },
];

const props = withDefaults(
  defineProps<{
    /** 控制台会话。`null` 表示未建立（登记表单不给提交入口）。 */
    readonly session?: SessionPresence | null;
    readonly sessionExpired?: boolean;
    /** 判定时刻。**必填** —— 组件不读时钟。 */
    readonly now: string;
    readonly workspaces?: readonly WorkspaceRow[];
    /** ChatGPT 网页 MCP 连接的逐目录能力授权。 */
    readonly workspaceAccess?: readonly WorkspaceAccessRow[];
    /** ChatGPT 模型侧连接的本机启停状态；无读数时不宣称可用。 */
    readonly connectionEnabled?: boolean | null;
    /** 能力开关的读数。`null` 表示没读到，**不当作关闭**（理由见 `readings.ts`）。 */
    readonly flags?: CapabilityFlags | null;
    /** 当前机器那一行。由调用方用 `machineLine()` 算好传进来。 */
    readonly machineLine?: string | null;
    /** 有请求在途时按钮不可再点。 */
    readonly busy?: boolean;
    /** 上一次操作的结果。与列表**分开**，刷新不会把它盖掉。 */
    readonly feedback?: { readonly ok: boolean; readonly message: string } | null;
  }>(),
  {
    session: null,
    sessionExpired: false,
    workspaces: () => [],
    workspaceAccess: () => [],
    connectionEnabled: null,
    flags: null,
    machineLine: null,
    busy: false,
    feedback: null,
  },
);

const emit = defineEmits<{
  /**
   * 登记。参数**恰好四个字段**（`registerRequest` 的返回类型）——
   * `workspace_id` 由服务端生成，`origin` 由服务端从通道身份推出来，
   * 因此两者都不能出现在这里。
   */
  (
    event: 'register',
    payload: {
      readonly alias: string;
      readonly kind: WorkspaceKind;
      readonly mode: WorkspaceMode;
      readonly path: string;
    },
  ): void;
  (event: 'pause', payload: { readonly workspace_id: string }): void;
  (event: 'resume', payload: { readonly workspace_id: string }): void;
  (event: 'remove', payload: { readonly workspace_id: string }): void;
  /** 重新核对身份：目录被换掉/移动过之后，重新确认它还是原来那一个。 */
  (event: 'reverify', payload: { readonly workspace_id: string }): void;
  /** 重新指向：同一个登记换个路径。**不改动用户文件**。 */
  (event: 'relocate', payload: { readonly workspace_id: string; readonly path: string }): void;
  (event: 'set-access', payload: { readonly workspace_id: string; readonly capabilities: readonly ModelWorkspaceCapability[] }): void;
  (event: 'navigate', payload: 'recovery' | 'history' | 'connection' | 'workspaces'): void;
  (event: 'refresh'): void;
}>();

// ---------------------------------------------------------------------------
// 登记表单
// ---------------------------------------------------------------------------

const draft = ref<RegisterDraft>({
  alias: '',
  kind: 'directory',
  mode: 'read_only',
  path: '',
  risk_ack: false,
});

const write = computed(() =>
  writeGate({
    flags: props.flags,
  }),
);

const offers = computed(() => modeOffers(write.value));

const validation = computed(() => validateRegister(draft.value));
const isWholeVolumeRoot = computed(() => /^[A-Za-z]:\\$/.test(draft.value.path.trim().replaceAll('/', '\\')));

/**
 * 能不能提交。
 *
 * 两条：表单自己过得了自检，以及**有一个控制台会话**。后者是这一页唯一
 * 与验收标准 3 相关的地方：登记是一个控制操作，模型侧连不上它
 * （`workspaces.manage` 只映射给 `console` audience），但界面同样不应该
 * 在**没有本地会话**时给出入口 —— 那样操作者会以为按了就能成。
 */
const canSubmit = computed(() => validation.value.can_submit && props.session !== null && !props.busy);

/**
 * 选中的模式那一份风险说明。
 *
 * 单独取出来放在提交按钮**上面**，而不是只在单选框下面：操作者按下按钮
 * 之前最后一次看到的应该是它。
 */
const selectedOffer = computed(() => offers.value.find((offer) => offer.mode === draft.value.mode) ?? null);

/** 路径输入仍然由操作者粘贴；这个状态只负责还原参考图里的分段控件。 */
const pathMode = ref<'select' | 'manual'>('select');
const pathInput = ref<HTMLInputElement | null>(null);

function setPathMode(mode: 'select' | 'manual'): void {
  pathMode.value = mode;
  pathInput.value?.focus();
}

function focusPathInput(): void {
  pathInput.value?.focus();
}

function onSubmit(): void {
  if (!canSubmit.value) return;
  // 走 `registerRequest`：它做的正是「恰好四个字段」这件事。
  emit('register', registerRequest(draft.value));
}

function resetForm(): void {
  draft.value = { alias: '', kind: 'directory', mode: 'read_only', path: '', risk_ack: false };
}

/** 输入框的取值都走这三个函数，而不是模板里的内联箭头函数：
 *  内联写法里 `$event.target` 是 `EventTarget | null`，每次都要就地断言一次，
 *  而断言写错时 `vue-tsc` 未必报错（`as HTMLInputElement` 是万能的）。 */
function inputValue(event: Event): string {
  const target = event.target;
  return target instanceof HTMLInputElement ? target.value : '';
}

function setAlias(event: Event): void {
  draft.value = { ...draft.value, alias: inputValue(event) };
}

function setPath(event: Event): void {
  draft.value = { ...draft.value, path: inputValue(event) };
}

function setRelocatePath(event: Event): void {
  relocatePath.value = inputValue(event);
}

function setKind(kind: WorkspaceKind): void {
  draft.value = { ...draft.value, kind };
}

function setMode(mode: WorkspaceMode): void {
  // 换模式时把那个勾清掉：一个「已确认风险」的勾跟着模式走，
  // 会让操作者在没读过新说明的情况下带着旧勾提交。
  draft.value = { ...draft.value, mode, risk_ack: false };
}

function setAck(value: boolean): void {
  draft.value = { ...draft.value, risk_ack: value };
}

function setAckFromEvent(event: Event): void {
  setAck(event.target instanceof HTMLInputElement && event.target.checked);
}

// ---------------------------------------------------------------------------
// 列表与逐行动作
// ---------------------------------------------------------------------------

const summary = computed(() =>
  exposureSummary(props.workspaces, props.flags, props.workspaceAccess, props.connectionEnabled ?? null),
);

// ---------------------------------------------------------------------------
// 已登记目录列表：搜索 + 分页只影响展示，不改变原始授权数据。
// ---------------------------------------------------------------------------

const PAGE_SIZE = 5;
const searchQuery = ref('');
const currentPage = ref(1);

const filteredWorkspaces = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase();
  if (query.length === 0) return [...props.workspaces];
  return props.workspaces.filter((row) =>
    `${row.alias} ${row.root}`.toLocaleLowerCase().includes(query),
  );
});

const totalPages = computed(() => Math.max(1, Math.ceil(filteredWorkspaces.value.length / PAGE_SIZE)));
const pageItems = computed(() => {
  const total = totalPages.value;
  if (total <= 5) return Array.from({ length: total }, (_, index) => index + 1);
  const start = Math.max(1, Math.min(currentPage.value - 2, total - 4));
  return Array.from({ length: 5 }, (_, index) => start + index);
});
const pagedWorkspaces = computed(() => {
  const safePage = Math.min(currentPage.value, totalPages.value);
  const start = (safePage - 1) * PAGE_SIZE;
  return filteredWorkspaces.value.slice(start, start + PAGE_SIZE);
});
const pageStart = computed(() =>
  filteredWorkspaces.value.length === 0 ? 0 : (currentPage.value - 1) * PAGE_SIZE + 1,
);
const pageEnd = computed(() => Math.min(currentPage.value * PAGE_SIZE, filteredWorkspaces.value.length));

watch(searchQuery, () => {
  currentPage.value = 1;
});

watch(totalPages, (pageCount) => {
  if (currentPage.value > pageCount) currentPage.value = pageCount;
});

function goToPage(page: number): void {
  currentPage.value = Math.max(1, Math.min(page, totalPages.value));
}

/** 正在等待二次确认的「移除」。**一次只允许一行。** */
const confirmingRemove = ref<string | null>(null);
/** 正在改路径的那一行，以及输入框里的值。 */
const relocating = ref<string | null>(null);
const relocatePath = ref('');

function askRemove(workspaceId: string): void {
  confirmingRemove.value = workspaceId;
  relocating.value = null;
}

function cancelRemove(): void {
  confirmingRemove.value = null;
}

function confirmRemove(workspaceId: string): void {
  confirmingRemove.value = null;
  emit('remove', { workspace_id: workspaceId });
}

function startRelocate(workspaceId: string, currentRoot: string): void {
  confirmingRemove.value = null;
  relocating.value = workspaceId;
  relocatePath.value = currentRoot;
}

function cancelRelocate(): void {
  relocating.value = null;
  relocatePath.value = '';
}

function confirmRelocate(workspaceId: string): void {
  const path = relocatePath.value.trim();
  if (path.length === 0) return;
  relocating.value = null;
  emit('relocate', { workspace_id: workspaceId, path });
}

/** 动作能不能按：要会话、不忙、并且这一行还在生效中（未移除）。 */
function canAct(row: WorkspaceRow): boolean {
  return props.session !== null && !props.busy && !row.removed;
}

/** 当前登记的 ChatGPT 授权；没有记录代表完全没有目录访问权。 */
function accessFor(row: WorkspaceRow): WorkspaceAccessRow | null {
  return props.workspaceAccess.find((item) => item.workspace_id === row.workspace_id) ?? null;
}

const accessDraft = ref<{ readonly workspace_id: string; readonly capabilities: readonly ModelWorkspaceCapability[] } | null>(null);

function openAccess(row: WorkspaceRow): void {
  accessDraft.value = {
    workspace_id: row.workspace_id,
    capabilities: [...(accessFor(row)?.capabilities ?? [])],
  };
  confirmingRemove.value = null;
  relocating.value = null;
}

function toggleAccess(capability: ModelWorkspaceCapability, event: Event): void {
  const draft = accessDraft.value;
  if (draft === null) return;
  const checked = event.target instanceof HTMLInputElement && event.target.checked;
  const next = new Set(draft.capabilities);
  if (checked) next.add(capability);
  else next.delete(capability);
  accessDraft.value = {
    workspace_id: draft.workspace_id,
    capabilities: ACCESS_OPTIONS.map((option) => option.capability).filter((item) => next.has(item)),
  };
}

function saveAccess(): void {
  const draft = accessDraft.value;
  const row = props.workspaces.find((item) => item.workspace_id === draft?.workspace_id);
  if (draft === null || row === undefined || !canAct(row)) return;
  emit('set-access', { workspace_id: draft.workspace_id, capabilities: [...draft.capabilities] });
  accessDraft.value = null;
}

function cancelAccess(): void {
  accessDraft.value = null;
}
</script>

<template>
  <section class="ws" data-testid="workspaces-view">
    <!-- 顶部安全概览：把“当前是否会出站”与“已登记多少”分开表达。 -->
    <header class="ws__head">
      <div class="ws__head-copy">
        <span class="ws__head-icon" aria-hidden="true">
          <svg viewBox="0 0 48 48" fill="none">
            <path d="M24 4 39 10v11c0 10-6.4 18.7-15 22-8.6-3.3-15-12-15-22V10L24 4Z" stroke="currentColor" stroke-width="2.8" stroke-linejoin="round" />
            <path d="m16.5 24 5 5 10-11" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
        <div>
          <p class="ws__overline">本机工作区安全概览</p>
          <h2>安全、可控、本地优先</h2>
          <p class="ws__head-description">所有操作仅在你授权的目录范围内进行，支持只读或读写模式，随时可撤销授权。</p>
          <ul class="ws__trust-list" aria-label="安全能力">
            <li><span class="ws__check" aria-hidden="true">✓</span>本地文件系统访问</li>
            <li><span class="ws__check" aria-hidden="true">✓</span>细粒度权限控制</li>
            <li><span class="ws__check" aria-hidden="true">✓</span>完整操作记录</li>
            <li><span class="ws__check" aria-hidden="true">✓</span>可随时撤销</li>
          </ul>
        </div>
      </div>
      <div class="ws__head-divider" aria-hidden="true"></div>
      <div class="ws__head-callout">
        <strong>让 AI 安全地访问你的本地数据</strong>
        <p>在保护隐私的前提下，释放生产力</p>
        <p class="ws__machine" data-testid="machine-line">{{ machineLine ?? '当前机器：未知（本机服务没有给出机器读数）' }}</p>
      </div>
    </header>

    <!-- 上一次操作的结果。成功与失败都留在这里，不被下一次刷新盖掉。 -->
    <p
      v-if="feedback !== null"
      class="ws__feedback"
      :class="feedback.ok ? 'ws__feedback--ok' : 'ws__feedback--bad'"
      :data-ok="feedback.ok ? 'true' : 'false'"
      role="status"
      data-testid="feedback"
    >
      <span class="ws__feedback-dot" aria-hidden="true">✓</span>{{ feedback.message }}
    </p>

    <div class="ws__workspace-grid">
      <!-- 登记表单。 -->
      <section class="ws__form-card" aria-label="登记工作区">
        <div class="ws__card-heading">
          <span class="ws__card-icon" aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none">
              <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h7l3 3h9A2.5 2.5 0 0 1 28 11.5v12a2.5 2.5 0 0 1-2.5 2.5h-19A2.5 2.5 0 0 1 4 23.5v-15Z" fill="currentColor" />
              <path d="M23 17v7M19.5 20.5h7" stroke="white" stroke-width="2" stroke-linecap="round" />
            </svg>
          </span>
          <div>
            <h3>登记目录或单个文件</h3>
            <p>选择本地目录或手动填写路径，登记后将出现在右侧的已登记列表中</p>
          </div>
        </div>

        <div class="ws__path-tabs" role="tablist" aria-label="路径输入方式">
          <button type="button" :class="{ 'is-active': pathMode === 'select' }" role="tab" :aria-selected="pathMode === 'select'" @click="setPathMode('select')">选择路径</button>
          <button type="button" :class="{ 'is-active': pathMode === 'manual' }" role="tab" :aria-selected="pathMode === 'manual'" @click="setPathMode('manual')">手动输入路径</button>
        </div>

        <div class="ws__path-control">
          <label class="sr-only" for="ws-path">本机路径</label>
          <div class="ws__input-wrap">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6.5h6l2 2h8v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-11Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" /></svg>
            <input
              id="ws-path"
              ref="pathInput"
              :value="draft.path"
              type="text"
              spellcheck="false"
              :placeholder="pathMode === 'select' ? '点击选择本地目录或文件...' : '粘贴完整本机路径...'"
              data-testid="path-input"
              @input="setPath"
            />
          </div>
          <button type="button" class="ws__browse" aria-label="浏览本地目录" @click="focusPathInput">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.5 7.5h6l2 2H20a1 1 0 0 1 1 1v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /><path d="M3.5 9.5h17" stroke="currentColor" stroke-width="1.8" /></svg>
            浏览
          </button>
        </div>
        <p class="ws__path-hint" data-testid="path-hint">浏览器不能替你选目录：请粘贴完整本机路径（例如从资源管理器地址栏复制）。可输入 `C:\` / `D:\` 登记整块本机卷；这会让授权工具覆盖该卷全部可访问目录。</p>

        <div class="ws__field">
          <label for="ws-alias">别名 <span>（可选）</span></label>
          <input id="ws-alias" :value="draft.alias" type="text" placeholder="例如：项目代码、文档资料" data-testid="alias-input" @input="setAlias" />
        </div>

        <p v-if="isWholeVolumeRoot" class="ws__risk ws__risk--volume" data-testid="whole-volume-warning">
          整卷范围：获授的读取工具可能把该卷上的私人文件内容发送给 ChatGPT；获授“文件修改”后可在该卷内直接创建或编辑文本文件。硬拒绝秘密/插件状态、系统 ACL、冲突检查和审计仍生效。请确认这就是你要授权的磁盘。
        </p>

        <div class="ws__split-fields">
          <fieldset class="ws__choice-card">
            <legend>访问范围</legend>
            <label class="ws__radio-line">
              <input type="radio" name="ws-kind" value="directory" :checked="draft.kind === 'directory'" data-testid="kind-directory" @change="setKind('directory')" />
              <span><strong>目录</strong><small>包含下面的所有文件</small></span>
            </label>
            <label class="ws__radio-line">
              <input type="radio" name="ws-kind" value="file" :checked="draft.kind === 'file'" data-testid="kind-file" @change="setKind('file')" />
              <span><strong>单个文件</strong><small>仅授权所选文件</small></span>
            </label>
          </fieldset>

          <fieldset class="ws__choice-card">
            <legend>访问模式</legend>
            <div v-for="offer in offers" :key="offer.mode" class="ws__offer">
              <label class="ws__radio-line">
                <input type="radio" name="ws-mode" :value="offer.mode" :checked="draft.mode === offer.mode" :data-testid="`mode-${offer.mode}`" @change="setMode(offer.mode)" />
                <span><strong>{{ offer.label }}<em v-if="offer.mode === 'read_only'">（推荐）</em></strong><small>{{ offer.mode === 'read_only' ? '仅允许读取文件内容，不会修改任何文件' : '允许创建、修改、删除文件（有风险）' }}</small></span>
              </label>
              <!-- 风险说明紧跟在它自己的选项下面；展开后阅读完整内容。 -->
              <details class="ws__risk-details">
                <summary>{{ offer.mode === 'read_only' ? '只读不等于不出本机' : '文件修改与命令执行需要谨慎' }} <span>查看说明</span></summary>
                <p class="ws__risk" :data-mode="offer.mode" data-testid="mode-risk">{{ offer.risk }}</p>
              </details>
              <label v-if="offer.requires_ack && draft.mode === offer.mode" class="ws__ack">
                <input type="checkbox" :checked="draft.risk_ack" data-testid="risk-ack" @change="setAckFromEvent" />
                我已读过上面这段说明
              </label>
            </div>
          </fieldset>
        </div>

        <details class="ws__advanced">
          <summary><span aria-hidden="true">⚙</span> 高级选项 <small>（可选）</small><span class="ws__chevron" aria-hidden="true">⌄</span></summary>
          <p>{{ write.summary }}</p>
        </details>

        <p v-if="selectedOffer !== null" class="ws__selected-risk" data-testid="selected-risk">将登记为「{{ selectedOffer.label }}」。</p>

        <div class="ws__actions ws__form-actions">
          <button type="button" class="ws__reset" data-testid="reset-button" @click="resetForm"><span aria-hidden="true">♙</span>清空</button>
          <button type="button" class="ws__submit" data-testid="register-button" :disabled="!canSubmit" @click="onSubmit"><span aria-hidden="true">＋</span>登记到工作区</button>
        </div>

        <!-- 不能提交的原因逐条列出来。 -->
        <ul v-if="validation.problems.length > 0" class="ws__problems" data-testid="form-problems">
          <li v-for="(problem, index) in validation.problems" :key="index" data-testid="form-problem">{{ problem }}</li>
        </ul>
        <p v-else-if="session === null" class="ws__dim" data-testid="no-session">
          {{ sessionExpired ? '控制台会话已过期，登记按不动。请重新运行本地启动命令。' : '还没有控制台会话，登记按不动。本地启动命令会打印一个带一次性令牌的地址，用它打开控制台。' }}
        </p>
        <p class="ws__dim ws__capability-note" data-testid="capability-note">登记本身**不改动**那个目录里的任何文件，也不代表内容立刻会被读走 —— 对应工具只有在该根保存 grant 且 ChatGPT 连接启用后才可调用。</p>
      </section>

      <!-- 已登记列表：表头 + 搜索 + 分页。 -->
      <section class="ws__list-card" aria-label="已登记的工作区">
        <header class="ws__list-head">
          <div class="ws__card-heading ws__card-heading--list">
            <span class="ws__card-icon" aria-hidden="true">
              <svg viewBox="0 0 32 32" fill="none"><path d="M4 8h10l3 3h11v13H4V8Z" fill="currentColor" /><path d="M8 4h7l3 3H8a2 2 0 0 0-2 2v12" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
            </span>
            <div>
              <h3>
                <span>已登记的根目录 / 文件（{{ workspaces.length }}）</span>
                <span class="sr-only">已登记的根（{{ workspaces.length }}）</span>
              </h3>
              <p>已授权的路径列表。ChatGPT 仅可在这些路径范围内进行操作</p>
            </div>
          </div>
          <div class="ws__list-tools">
            <label class="ws__search">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.2" stroke="currentColor" stroke-width="1.8" /><path d="m16 16 4.2 4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
              <span class="sr-only">搜索路径或别名</span>
              <input v-model="searchQuery" type="search" placeholder="搜索路径或别名..." data-testid="workspace-search" />
            </label>
            <button type="button" class="ws__refresh-list" :disabled="busy" data-testid="workspace-search-reset" aria-label="刷新已登记目录" @click="emit('refresh')">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11a8 8 0 1 0 1 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" /><path d="M20 5v6h-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
              刷新
            </button>
          </div>
        </header>

        <div v-if="workspaces.length === 0" class="ws__empty" data-testid="empty-state">
          <span class="ws__empty-icon" aria-hidden="true">＋</span>
          <strong>还没有登记任何目录或文件</strong>
          <p>登记后，授权路径会显示在这里；未授权的目录不会暴露给模型。</p>
        </div>

        <template v-else>
          <div class="ws__table-head" aria-hidden="true">
            <span>路径 / 别名</span><span>状态</span><span>访问模式</span><span>可用能力</span><span>操作</span>
          </div>
          <p v-if="filteredWorkspaces.length === 0" class="ws__no-results" data-testid="workspace-no-results">没有找到匹配的路径或别名。</p>
          <ul v-else class="ws__rows" data-testid="workspace-list">
            <li v-for="row in pagedWorkspaces" :key="row.workspace_id" class="ws__row" :class="{ 'ws__row--removed': row.removed }" :data-workspace-id="row.workspace_id" :data-removed="row.removed ? 'true' : 'false'" data-testid="workspace-row">
              <div class="ws__row-main">
                <div class="ws__row-title">
                  <span class="ws__row-folder" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2H19.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11Z" fill="currentColor" /></svg></span>
                  <div>
                    <div class="ws__row-head"><span class="ws__alias" data-testid="ws-alias">{{ row.alias }}</span><span class="ws__inline-state" :class="row.removed ? 'is-removed' : row.enabled ? 'is-enabled' : 'is-paused'">{{ describeWorkspace(row).state_label }}</span></div>
                    <!-- 本机绝对路径不会流向模型；必须让操作者能核对登记对象。 -->
                    <code class="ws__root" data-testid="ws-root">{{ row.root }}</code>
                    <p class="ws__dim ws__ids" data-testid="ws-ids">{{ row.kind === 'directory' ? '目录' : '单个文件' }} · 代次 {{ row.generation }} · 策略版本 {{ row.policy_version }}</p>
                  </div>
                </div>
              </div>
              <div class="ws__row-state"><span class="ws__state-pill" :class="row.removed ? 'is-removed' : row.enabled ? 'is-enabled' : 'is-paused'" data-testid="ws-state">{{ describeWorkspace(row).state_label }}</span></div>
              <div class="ws__row-mode"><span class="ws__mode-label" data-testid="ws-mode">{{ describeWorkspace(row).mode_label }}</span></div>
              <div class="ws__row-capability">
                <section class="ws__access" :aria-label="`${row.alias} 的 ChatGPT 工具授权`" data-testid="workspace-access">
                  <p data-testid="access-summary"><span>已授权范围内操作：</span><span class="sr-only">ChatGPT 网页已保存授权：</span><strong>{{ accessFor(row)?.enabled ? ACCESS_OPTIONS.filter((option) => accessFor(row)?.capabilities.includes(option.capability)).map((option) => option.label).join('、') : '未授权访问此目录' }}</strong></p>
                  <button v-if="!row.removed" type="button" class="ws__access-button" :disabled="!canAct(row)" :data-testid="`configure-access-${row.workspace_id}`" @click="openAccess(row)">配置工具授权</button>
                </section>
              </div>
              <div class="ws__row-actions">
                <details v-if="!row.removed" class="ws__action-menu">
                  <summary aria-label="更多操作" data-testid="more-actions"><span aria-hidden="true">⋮</span></summary>
                  <div class="ws__action-popover">
                    <button v-if="row.enabled" type="button" :disabled="!canAct(row)" :data-testid="`pause-${row.workspace_id}`" @click="emit('pause', { workspace_id: row.workspace_id })">暂停</button>
                    <button v-else type="button" :disabled="!canAct(row)" :data-testid="`resume-${row.workspace_id}`" @click="emit('resume', { workspace_id: row.workspace_id })">恢复</button>
                    <button type="button" :disabled="!canAct(row)" :data-testid="`reverify-${row.workspace_id}`" @click="emit('reverify', { workspace_id: row.workspace_id })">重新核对身份</button>
                    <button type="button" :disabled="!canAct(row)" :data-testid="`relocate-${row.workspace_id}`" @click="startRelocate(row.workspace_id, row.root)">重新指向</button>
                    <button type="button" :disabled="!canAct(row)" :data-testid="`remove-${row.workspace_id}`" @click="askRemove(row.workspace_id)">移除</button>
                  </div>
                </details>
              </div>

              <div v-if="accessDraft?.workspace_id === row.workspace_id" class="ws__access-editor" :data-testid="`access-editor-${row.workspace_id}`">
                <p class="ws__risk">只对上面这个目录生效。勾选“文件修改”代表允许 ChatGPT 在此目录直接创建/删除普通文件并应用修改集，不再逐次等待批准；编辑已有文件还需同时授予“读取文件内容”。“命令执行”会以运行 LocalWebGPT 的本机用户身份运行任意所选 shell；目录只是起始工作目录，命令仍可访问该用户有权访问的其他路径并可联网，不是沙箱。命令可能修改/删除文件且不会由受保护文件执行器回滚。只对可信连接与可信目录授予。取消勾选并保存即可撤销。其他目录不受影响。</p>
                <label v-for="option in ACCESS_OPTIONS" :key="option.capability" class="ws__choice ws__access-option">
                  <input type="checkbox" :checked="accessDraft.capabilities.includes(option.capability)" :disabled="((option.capability === 'propose' || option.capability === 'command_exec') && row.mode === 'read_only') || (option.capability === 'command_exec' && row.kind !== 'directory')" :data-testid="`access-${row.workspace_id}-${option.capability}`" @change="toggleAccess(option.capability, $event)" />
                  <span><strong>{{ option.label }}</strong> <code>{{ option.tools }}</code></span>
                </label>
                <p v-if="row.mode === 'read_only'" class="ws__dim" data-testid="propose-mode-note">此根登记为只读，不能授权文件修改或命令执行。</p>
                <p v-if="row.kind !== 'directory'" class="ws__dim" data-testid="command-mode-note">命令执行仅支持目录工作区。</p>
                <div class="ws__actions"><button type="button" :disabled="!canAct(row)" :data-testid="`save-access-${row.workspace_id}`" @click="saveAccess">保存目录授权</button><button type="button" :data-testid="`cancel-access-${row.workspace_id}`" @click="cancelAccess">取消</button></div>
              </div>

              <!-- 移除要二次确认。它不删文件，但会让模型立刻失去这个根。 -->
              <div v-if="confirmingRemove === row.workspace_id" class="ws__confirm" data-testid="remove-confirm">
                <p>确认移除这个登记？目录里的文件**不受影响**，但模型立刻失去对它的访问。</p>
                <button type="button" :data-testid="`remove-confirm-${row.workspace_id}`" @click="confirmRemove(row.workspace_id)">确认移除</button>
                <button type="button" data-testid="remove-cancel" @click="cancelRemove">取消</button>
              </div>

              <div v-if="relocating === row.workspace_id" class="ws__confirm" data-testid="relocate-form">
                <label :for="`relocate-path-${row.workspace_id}`">新的完整路径</label>
                <input :id="`relocate-path-${row.workspace_id}`" :value="relocatePath" type="text" spellcheck="false" data-testid="relocate-input" @input="setRelocatePath" />
                <p class="ws__dim">它**不改动**用户文件：只是把这条登记指向另一个位置，并重新核对身份。</p>
                <button type="button" :data-testid="`relocate-confirm-${row.workspace_id}`" @click="confirmRelocate(row.workspace_id)">确认</button>
                <button type="button" data-testid="relocate-cancel" @click="cancelRelocate">取消</button>
              </div>
            </li>
          </ul>

          <nav class="ws__pagination" aria-label="已登记目录分页" data-testid="workspace-pagination">
            <span>显示 {{ pageStart }}–{{ pageEnd }} / 共 {{ filteredWorkspaces.length }} 个</span>
            <div class="ws__page-buttons">
              <button type="button" :disabled="currentPage === 1" data-testid="workspace-page-first" aria-label="第一页" @click="goToPage(1)">«</button>
              <button type="button" :disabled="currentPage === 1" data-testid="workspace-page-prev" aria-label="上一页" @click="goToPage(currentPage - 1)">‹</button>
              <button v-for="page in pageItems" :key="page" type="button" :class="{ 'is-current': currentPage === page }" :aria-current="currentPage === page ? 'page' : undefined" :data-testid="`workspace-page-${page}`" @click="goToPage(page)">{{ page }}</button>
              <button type="button" :disabled="currentPage === totalPages" data-testid="workspace-page-next" aria-label="下一页" @click="goToPage(currentPage + 1)">›</button>
              <button type="button" :disabled="currentPage === totalPages" data-testid="workspace-page-last" aria-label="最后一页" @click="goToPage(totalPages)">»</button>
            </div>
          </nav>
        </template>
      </section>
    </div>

    <div class="ws__lower-grid">
      <section class="ws__quick-card" aria-label="快速操作">
        <header><h3><span aria-hidden="true">ϟ</span>快速操作</h3></header>
        <div class="ws__quick-grid">
          <button type="button" class="ws__quick-item" @click="emit('navigate', 'recovery')"><span class="ws__quick-icon">↶</span><span><strong>恢复与冲突</strong><small>查看变更与恢复文件</small></span></button>
          <button type="button" class="ws__quick-item" @click="emit('navigate', 'history')"><span class="ws__quick-icon">◷</span><span><strong>历史记录</strong><small>查看所有操作记录</small></span></button>
          <button type="button" class="ws__quick-item" @click="emit('navigate', 'connection')"><span class="ws__quick-icon">↗</span><span><strong>ChatGPT 连接</strong><small>管理连接状态</small></span></button>
          <button type="button" class="ws__quick-item" @click="emit('navigate', 'workspaces')"><span class="ws__quick-icon">⌁</span><span><strong>工具授权</strong><small>查看与管理授权</small></span></button>
        </div>
      </section>

      <section class="ws__help-card" aria-label="使用说明">
        <header><h3><span aria-hidden="true">▮</span>使用说明</h3><span class="ws__help-link">查看文档 →</span></header>
        <div class="ws__help-grid">
          <div><span>1</span><p><strong>登记本地目录或文件</strong><small>选择要授权的路径，设置访问模式</small></p></div>
          <div><span>3</span><p><strong>查看与管理</strong><small>随时查看历史记录，必要时撤销授权</small></p></div>
          <div><span>2</span><p><strong>在 ChatGPT 中使用</strong><small>连接后即可在授权范围内调用工具</small></p></div>
          <div><span>4</span><p><strong>保持安全</strong><small>建议使用只读模式，避免不必要的写入权限</small></p></div>
        </div>
      </section>
    </div>

    <footer class="ws__statusbar" :data-exposed="summary.accessible > 0 ? 'true' : 'false'">
      <div class="ws__status-main"><span class="ws__status-icon" aria-hidden="true">✓</span><strong>当前状态</strong><span data-testid="exposure-headline" :data-exposed="summary.accessible > 0 ? 'true' : 'false'">{{ summary.headline }}</span></div>
      <div class="ws__status-lines"><span v-for="(line, index) in summary.lines" :key="index" data-testid="exposure-line">{{ line }}</span></div>
      <span class="ws__status-source">状态来自本机服务</span>
    </footer>
  </section>
</template>

<style scoped>
.ws {
  --ws-blue: #176cf0;
  --ws-blue-dark: #11245c;
  --ws-muted: #7184a4;
  --ws-border: #e1e9f4;
  --ws-panel: #fff;
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.ws__head,
.ws__form-card,
.ws__list-card,
.ws__quick-card,
.ws__help-card {
  background: rgba(255, 255, 255, .94);
  border: 1px solid var(--ws-border);
  border-radius: 12px;
  box-shadow: 0 7px 22px rgba(47, 92, 151, .055);
}

.ws__head {
  min-height: 130px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 1px minmax(290px, .65fr);
  align-items: center;
  gap: 24px;
  padding: 18px 24px;
  background: linear-gradient(110deg, #fbfdff 0%, #f7fbff 64%, #f5f9ff 100%);
}

.ws__head-copy { display: flex; align-items: center; gap: 18px; min-width: 0; }
.ws__head-icon {
  flex: 0 0 58px;
  width: 58px;
  height: 58px;
  display: grid;
  place-items: center;
  color: var(--ws-blue);
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 7px 18px rgba(35, 103, 205, .15);
}
.ws__head-icon svg { width: 34px; height: 34px; }
.ws__overline { margin: 0 0 3px; color: var(--ws-blue); font-size: 12px; font-weight: 700; letter-spacing: .05em; }
.ws__head h2 { margin: 0; color: var(--ws-blue-dark); font-size: 21px; letter-spacing: -.02em; }
.ws__head-description { margin: 4px 0 10px; color: #597092; font-size: 13px; }
.ws__trust-list { display: flex; flex-wrap: wrap; gap: 10px 27px; padding: 0; margin: 0; list-style: none; color: #607698; font-size: 12px; }
.ws__trust-list li { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
.ws__check,
.ws__feedback-dot { display: inline-grid; place-items: center; flex: 0 0 19px; width: 19px; height: 19px; border-radius: 50%; background: #1fb466; color: #fff; font-size: 12px; font-weight: 800; }
.ws__head-divider { width: 1px; height: 74px; background: #dce6f3; }
.ws__head-callout { min-width: 0; padding-left: 14px; color: #334c78; }
.ws__head-callout strong { display: block; color: #223d78; font-size: 15px; }
.ws__head-callout p { margin: 7px 0 0; color: #91a3bf; font-size: 13px; }
.ws__head-callout .ws__machine { margin-top: 10px; font-size: 11px; overflow-wrap: anywhere; }

.ws__feedback { display: flex; align-items: center; gap: 9px; margin: 0; padding: 10px 14px; border: 1px solid #b8e7cf; border-radius: 9px; background: #effbf4; color: #197b4b; font-size: 13px; }
.ws__feedback--bad { border-color: #f0c3c3; background: #fff3f3; color: #a13434; }

.ws__workspace-grid { display: grid; grid-template-columns: minmax(390px, .94fr) minmax(520px, 1.46fr); gap: 18px; align-items: start; }
.ws__form-card, .ws__list-card { min-width: 0; overflow: hidden; }
.ws__form-card { padding: 18px; }
.ws__list-card { padding-bottom: 12px; }
.ws__card-heading { display: flex; align-items: flex-start; gap: 12px; }
.ws__card-heading--list { padding: 18px 18px 15px; }
.ws__card-icon { display: grid; place-items: center; flex: 0 0 31px; width: 31px; height: 31px; color: var(--ws-blue); }
.ws__card-icon svg { width: 29px; height: 29px; }
.ws__card-heading h3, .ws__list-head h3 { margin: 0; color: var(--ws-blue-dark); font-size: 17px; letter-spacing: -.02em; }
.ws__card-heading p, .ws__list-head p { margin: 5px 0 0; color: #8495af; font-size: 12px; line-height: 1.45; }

.ws__path-tabs { display: flex; gap: 0; margin-top: 16px; border-bottom: 1px solid #e3eaf4; }
.ws__path-tabs button { padding: 8px 16px; border: 1px solid transparent; border-radius: 8px 8px 0 0; background: transparent; color: #71839f; font-size: 12px; cursor: pointer; }
.ws__path-tabs button.is-active { border-color: #dce7f4; border-bottom-color: #fff; margin-bottom: -1px; background: #fff; color: var(--ws-blue); font-weight: 700; box-shadow: 0 -2px 8px rgba(27, 106, 228, .05); }
.ws__path-control { display: flex; gap: 8px; margin-top: 10px; }
.ws__input-wrap, .ws__search { display: flex; align-items: center; min-width: 0; border: 1px solid #dce6f2; border-radius: 8px; background: #fff; }
.ws__input-wrap { flex: 1; padding: 0 10px; }
.ws__input-wrap svg { width: 18px; height: 18px; flex: 0 0 auto; color: #91a5c2; }
.ws__input-wrap input, .ws__search input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: #23375e; font: inherit; }
.ws__input-wrap input { padding: 10px 8px; font-size: 12px; }
.ws__input-wrap input::placeholder, .ws__search input::placeholder { color: #a1afc4; }
.ws__browse { display: inline-flex; align-items: center; gap: 6px; padding: 0 14px; border: 1px solid #dce6f2; border-radius: 8px; background: #f8fbff; color: #4f6587; font-size: 12px; cursor: pointer; }
.ws__browse svg { width: 17px; height: 17px; }
.ws__path-hint { margin: 7px 0 0; color: #8c9cb4; font-size: 11px; line-height: 1.45; }

.ws__field { margin-top: 13px; }
.ws__field label, .ws__choice-card legend { display: block; color: #273d66; font-size: 12px; font-weight: 700; }
.ws__field label span, .ws__choice-card legend small { color: #91a0b7; font-weight: 400; }
.ws__field input[type='text'] { display: block; width: 100%; margin-top: 6px; padding: 9px 11px; border: 1px solid #dce6f2; border-radius: 8px; outline: 0; color: #263b62; font: inherit; font-size: 12px; }
.ws__field input[type='text']:focus, .ws__input-wrap:focus-within, .ws__search:focus-within { border-color: #76aaf4; box-shadow: 0 0 0 3px rgba(45, 119, 240, .1); }
.ws__field input::placeholder { color: #a4b1c4; }
.ws__risk { margin: 6px 0 0; color: #7385a1; font-size: 11px; line-height: 1.5; }
.ws__risk--volume { padding: 8px 10px; border: 1px solid #f1d7a5; border-radius: 7px; background: #fff9ea; color: #806321; }
.ws__split-fields { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 10px; margin-top: 14px; }
.ws__choice-card { min-width: 0; margin: 0; padding: 10px; border: 1px solid #e1e8f2; border-radius: 8px; }
.ws__choice-card legend { padding: 0 3px; }
.ws__radio-line { display: flex; align-items: flex-start; gap: 8px; margin-top: 9px; color: #344d76; font-size: 12px; cursor: pointer; }
.ws__radio-line input { width: 17px; height: 17px; margin: 0; accent-color: var(--ws-blue); }
.ws__radio-line span { min-width: 0; }
.ws__radio-line strong { display: block; font-size: 12px; }
.ws__radio-line em { color: #1aa75f; font-style: normal; font-weight: 700; }
.ws__radio-line small { display: block; margin-top: 3px; color: #91a1b9; font-size: 10px; line-height: 1.35; }
.ws__offer + .ws__offer { margin-top: 2px; }
.ws__risk-details { margin: 6px 0 0 25px; }
.ws__risk-details summary { color: #8091aa; font-size: 10px; cursor: pointer; list-style: none; }
.ws__risk-details summary::-webkit-details-marker { display: none; }
.ws__risk-details summary span { margin-left: 5px; color: #4a83d5; }
.ws__risk-details .ws__risk { margin: 4px 0 0; }
.ws__ack { display: flex; align-items: center; gap: 6px; margin: 7px 0 0 25px; color: #5d7194; font-size: 11px; }
.ws__ack input { accent-color: var(--ws-blue); }
.ws__advanced { margin-top: 12px; border: 1px solid #e2e9f3; border-radius: 8px; background: #f8faff; }
.ws__advanced summary { display: flex; align-items: center; gap: 6px; padding: 8px 11px; color: #52698e; font-size: 12px; font-weight: 700; cursor: pointer; list-style: none; }
.ws__advanced summary::-webkit-details-marker { display: none; }
.ws__advanced summary small { color: #94a3ba; font-weight: 400; }
.ws__chevron { margin-left: auto; color: #7890b5; font-size: 16px; }
.ws__advanced[open] .ws__chevron { transform: rotate(180deg); }
.ws__advanced p { margin: 0; padding: 0 11px 10px; color: #7185a4; font-size: 11px; line-height: 1.45; }
.ws__selected-risk { margin: 10px 0 0; color: #7c8da5; font-size: 11px; }
.ws__actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.ws__form-actions { justify-content: space-between; margin-top: 12px; }
.ws__actions button, .ws__reset, .ws__submit { border: 1px solid #dce6f2; border-radius: 8px; background: #fff; color: #526a8e; padding: 9px 13px; font: inherit; font-size: 12px; cursor: pointer; }
.ws__reset { min-width: 106px; }
.ws__submit { min-width: 200px; border-color: var(--ws-blue); background: linear-gradient(135deg, #1672f5, #1c64e5); color: #fff; box-shadow: 0 7px 15px rgba(26, 105, 231, .18); font-weight: 700; }
.ws__submit span { margin-right: 5px; font-size: 18px; line-height: 0; vertical-align: -1px; }
.ws__reset span { margin-right: 7px; }
.ws__submit:disabled, .ws__actions button:disabled, .ws__browse:disabled { cursor: not-allowed; opacity: .5; }
.ws__problems { margin: 10px 0 0; padding: 8px 10px 8px 27px; border-radius: 7px; background: #fff4f4; color: #ac3a3a; font-size: 11px; }
.ws__problems li + li { margin-top: 3px; }
.ws__dim { color: var(--ws-muted); }
.ws__capability-note { margin: 10px 0 0; font-size: 10px; line-height: 1.5; }

.ws__list-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 15px; padding-right: 13px; }
.ws__list-tools { display: flex; gap: 8px; align-items: center; margin-top: 13px; }
.ws__search { width: 224px; padding: 0 9px; }
.ws__search svg { width: 18px; height: 18px; flex: 0 0 auto; color: #6f84a5; }
.ws__search input { padding: 9px 7px; font-size: 11px; }
.ws__refresh-list { display: inline-flex; align-items: center; gap: 5px; height: 36px; padding: 0 12px; border: 1px solid #dce6f2; border-radius: 8px; background: #f8fbff; color: var(--ws-blue); font: inherit; font-size: 11px; cursor: pointer; }
.ws__refresh-list svg { width: 16px; height: 16px; }
.ws__refresh-list:disabled { opacity: .72; }
.ws__empty { display: grid; place-items: center; padding: 55px 20px; color: #7184a3; text-align: center; }
.ws__empty-icon { display: grid; place-items: center; width: 38px; height: 38px; margin-bottom: 10px; border-radius: 50%; background: #eef5ff; color: var(--ws-blue); font-size: 22px; }
.ws__empty strong { color: #405a83; font-size: 13px; }
.ws__empty p, .ws__no-results { margin: 6px 0 0; color: #91a0b7; font-size: 11px; }
.ws__no-results { padding: 32px 18px; text-align: center; }
.ws__table-head, .ws__row { display: grid; grid-template-columns: minmax(220px, 2.05fr) 74px 112px minmax(170px, 1.45fr) 42px; column-gap: 0; }
.ws__table-head { align-items: center; min-height: 37px; padding: 0 15px; border-top: 1px solid #edf1f7; border-bottom: 1px solid #e7edf5; background: #fbfcfe; color: #546a8d; font-size: 11px; font-weight: 700; }
.ws__table-head span + span { padding-left: 10px; border-left: 1px solid #e3eaf3; }
.ws__rows { list-style: none; padding: 0; margin: 0; }
.ws__row { position: relative; align-items: center; min-height: 109px; padding: 12px 15px; border-bottom: 1px solid #edf1f7; }
.ws__row:last-child { border-bottom: 0; }
.ws__row--removed { opacity: .58; }
.ws__row-main { min-width: 0; padding-right: 10px; }
.ws__row-title { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.ws__row-folder { display: grid; place-items: center; flex: 0 0 27px; width: 27px; height: 27px; color: var(--ws-blue); }
.ws__row-folder svg { width: 25px; height: 25px; }
.ws__row-head { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; min-width: 0; }
.ws__alias { color: #20365f; font-size: 13px; font-weight: 700; }
.ws__inline-state { padding: 3px 7px; border-radius: 5px; font-size: 10px; font-weight: 700; }
.ws__inline-state.is-enabled { background: #e5f8ed; color: #1a9b5a; }
.ws__inline-state.is-paused { background: #fff4dc; color: #a27519; }
.ws__inline-state.is-removed { background: #f0f2f5; color: #7c8799; }
.ws__root { display: block; max-width: 100%; margin-top: 5px; overflow-wrap: anywhere; color: #7187aa; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 10px; line-height: 1.45; }
.ws__ids { margin: 4px 0 0; font-size: 10px; }
.ws__row-state, .ws__row-mode, .ws__row-capability { min-width: 0; padding-left: 10px; }
.ws__state-pill, .ws__mode-label { display: inline-block; border-radius: 7px; padding: 5px 9px; font-size: 11px; font-weight: 700; white-space: nowrap; }
.ws__state-pill.is-enabled { border: 1px solid #d5f0df; background: #f0fbf4; color: #1c9f5c; }
.ws__state-pill.is-paused { border: 1px solid #f2e1b6; background: #fff9e7; color: #9c751e; }
.ws__state-pill.is-removed { border: 1px solid #e0e3e8; background: #f7f8fa; color: #7e8999; }
.ws__mode-label { border: 1px solid #e1e6ff; background: #f5f5ff; color: #765fe2; }
.ws__access { min-width: 0; }
.ws__access p { margin: 0; color: #7c8ca5; font-size: 10px; line-height: 1.45; }
.ws__access p strong { display: block; margin-top: 3px; color: #617697; font-weight: 600; }
.ws__access-button { margin-top: 6px; padding: 5px 8px; border: 1px solid #dce6f2; border-radius: 6px; background: #fff; color: #4a6590; font: inherit; font-size: 10px; cursor: pointer; }
.ws__access-button:disabled { cursor: not-allowed; opacity: .5; }
.ws__row-actions { display: flex; justify-content: flex-end; align-self: stretch; align-items: center; padding-left: 7px; }
.ws__action-menu { position: relative; }
.ws__action-menu summary { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid #dce6f2; border-radius: 7px; background: #fff; color: #5a7096; font-size: 20px; line-height: 1; cursor: pointer; list-style: none; }
.ws__action-menu summary::-webkit-details-marker { display: none; }
.ws__action-menu[open] summary { border-color: #a8c9f8; background: #f3f8ff; color: var(--ws-blue); }
.ws__action-popover { position: absolute; z-index: 4; top: 34px; right: 0; display: grid; min-width: 126px; padding: 5px; border: 1px solid #dce6f2; border-radius: 8px; background: #fff; box-shadow: 0 10px 25px rgba(37, 69, 119, .16); }
.ws__action-popover button { padding: 7px 9px; border: 0; border-radius: 5px; background: transparent; color: #526887; text-align: left; font: inherit; font-size: 11px; cursor: pointer; }
.ws__action-popover button:hover { background: #f1f6ff; color: var(--ws-blue); }
.ws__action-popover button:disabled { cursor: not-allowed; opacity: .45; }
.ws__access-editor, .ws__confirm { grid-column: 1 / -1; margin: 9px 0 0 37px; padding: 12px; border: 1px solid #cfe0f6; border-radius: 8px; background: #f7fbff; }
.ws__access-editor { display: grid; gap: 8px; }
.ws__access-editor .ws__risk { margin: 0; }
.ws__access-option { display: flex; align-items: flex-start; gap: 8px; color: #536b90; font-size: 11px; }
.ws__access-option input { margin-top: 2px; accent-color: var(--ws-blue); }
.ws__access-option code { color: #8b9ab0; font-size: 10px; }
.ws__confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: #657a9b; font-size: 11px; }
.ws__confirm p { flex: 1 1 100%; margin: 0; }
.ws__confirm input[type='text'] { flex: 1 1 280px; min-width: 0; padding: 8px 9px; border: 1px solid #d8e3f1; border-radius: 6px; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 11px; }
.ws__confirm button, .ws__access-editor .ws__actions button { padding: 7px 10px; border: 1px solid #d5e1ef; border-radius: 6px; background: #fff; color: #4d668c; font: inherit; font-size: 11px; cursor: pointer; }

.ws__pagination { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 15px 0; color: #8a9ab3; font-size: 10px; }
.ws__page-buttons { display: flex; gap: 4px; }
.ws__page-buttons button { min-width: 27px; height: 27px; padding: 0 6px; border: 1px solid #dce6f2; border-radius: 6px; background: #fff; color: #667c9f; font: inherit; font-size: 11px; cursor: pointer; }
.ws__page-buttons button.is-current { border-color: var(--ws-blue); background: var(--ws-blue); color: #fff; font-weight: 700; }
.ws__page-buttons button:disabled { cursor: not-allowed; opacity: .4; }

.ws__lower-grid { display: grid; grid-template-columns: minmax(390px, .94fr) minmax(520px, 1.46fr); gap: 18px; }
.ws__quick-card, .ws__help-card { padding: 14px 16px; }
.ws__quick-card header, .ws__help-card header { display: flex; align-items: center; justify-content: space-between; }
.ws__quick-card h3, .ws__help-card h3 { margin: 0; color: var(--ws-blue-dark); font-size: 15px; }
.ws__quick-card h3 span, .ws__help-card h3 span { margin-right: 8px; color: var(--ws-blue); font-size: 22px; vertical-align: -2px; }
.ws__quick-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; margin-top: 12px; }
.ws__quick-item { display: flex; align-items: center; gap: 9px; min-width: 0; padding: 10px; border: 1px solid #e1e9f3; border-radius: 8px; background: #fff; color: #385274; text-align: left; cursor: pointer; }
.ws__quick-item:hover { border-color: #bcd4f6; background: #f9fcff; }
.ws__quick-icon { display: grid; place-items: center; flex: 0 0 26px; width: 26px; height: 26px; color: var(--ws-blue); font-size: 23px; }
.ws__quick-item strong, .ws__quick-item small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws__quick-item strong { color: #314b74; font-size: 11px; }
.ws__quick-item small { margin-top: 4px; color: #91a0b7; font-size: 9px; }
.ws__help-link { color: var(--ws-blue); font-size: 11px; font-weight: 700; }
.ws__help-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 26px; margin-top: 11px; }
.ws__help-grid > div { display: flex; gap: 8px; align-items: center; min-width: 0; }
.ws__help-grid > div > span { display: grid; place-items: center; flex: 0 0 30px; width: 30px; height: 30px; border-radius: 50%; background: #edf5ff; color: var(--ws-blue); font-size: 14px; font-weight: 800; }
.ws__help-grid p { min-width: 0; margin: 0; }
.ws__help-grid strong, .ws__help-grid small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws__help-grid strong { color: #405a81; font-size: 11px; }
.ws__help-grid small { margin-top: 3px; color: #94a3b9; font-size: 9px; }

.ws__statusbar { display: flex; align-items: center; gap: 14px; min-height: 43px; padding: 7px 16px; border: 1px solid #a7e0bf; border-radius: 9px; background: #effbf3; color: #4d8b68; font-size: 10px; }
.ws__status-main { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; color: #1b8950; }
.ws__status-main > span:not(.ws__status-icon) { max-width: min(410px, 42vw); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws__status-icon { display: grid; place-items: center; width: 23px; height: 23px; border-radius: 50%; background: #1faf61; color: #fff; font-size: 14px; font-weight: 800; }
.ws__status-lines { display: flex; gap: 12px; min-width: 0; flex: 1; }
.ws__status-lines span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws__status-source { flex: 0 0 auto; color: #7aa58b; }
.ws__statusbar[data-exposed='true'] { border-color: #a7e0bf; }

@media (max-width: 1100px) {
  .ws__workspace-grid, .ws__lower-grid { grid-template-columns: 1fr; }
  .ws__head { grid-template-columns: minmax(0, 1fr) 1px minmax(230px, .55fr); }
}

@media (max-width: 760px) {
  .ws__head { grid-template-columns: 1fr; gap: 14px; padding: 16px; }
  .ws__head-divider { width: 100%; height: 1px; }
  .ws__head-callout { padding-left: 0; }
  .ws__trust-list { gap: 8px 14px; }
  .ws__split-fields, .ws__help-grid { grid-template-columns: 1fr; }
  .ws__list-head { flex-direction: column; padding-right: 18px; }
  .ws__list-tools { width: 100%; margin-top: 0; }
  .ws__search { flex: 1; width: auto; }
  .ws__table-head { display: none; }
  .ws__row { grid-template-columns: 1fr auto; gap: 10px; padding: 14px; }
  .ws__row-main { grid-column: 1 / -1; }
  .ws__row-capability { grid-column: 1 / -1; padding-left: 0; }
  .ws__row-state, .ws__row-mode { padding-left: 0; }
  .ws__row-actions { grid-column: 2; grid-row: 2; align-self: center; }
  .ws__pagination { align-items: flex-start; flex-direction: column; }
  .ws__statusbar { align-items: flex-start; flex-direction: column; gap: 7px; }
  .ws__status-lines { display: grid; gap: 3px; }
  .ws__status-source { align-self: flex-end; }
}
</style>
