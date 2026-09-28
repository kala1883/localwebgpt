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
import { computed, ref } from 'vue';
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
    <!-- 页首：哪台机器 + 有没有东西正在出去（验收标准 1 的两半）。 -->
    <header class="ws__head">
      <h2>工作区</h2>
      <p class="ws__machine" data-testid="machine-line">{{ machineLine ?? '当前机器：未知（本机服务没有给出机器读数）' }}</p>
      <p class="ws__exposure" data-testid="exposure-headline" :data-exposed="summary.accessible > 0 ? 'true' : 'false'">
        {{ summary.headline }}
      </p>
      <ul class="ws__exposure-lines" data-testid="exposure-lines">
        <li v-for="(line, index) in summary.lines" :key="index" data-testid="exposure-line">{{ line }}</li>
      </ul>
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
      {{ feedback.message }}
    </p>

    <!-- 表单：目录 / 单文件、只读 / 提议、风险说明。 -->
    <section class="ws__form" aria-label="登记工作区">
      <h3>登记一个目录或单个文件</h3>

      <p class="ws__dim" data-testid="path-hint">
        浏览器不能替你选目录：请粘贴完整本机路径（例如从资源管理器地址栏复制）。可输入 `C:\` / `D:\` 登记整块本机卷；这会让授权工具覆盖该卷全部可访问目录。
      </p>

      <div class="ws__field">
        <label for="ws-alias">别名（给这个根起的名字，只有你自己看到）</label>
        <input
          id="ws-alias"
          :value="draft.alias"
          type="text"
          data-testid="alias-input"
          @input="setAlias"
        />
      </div>
      <div class="ws__field">
        <label for="ws-path">本机路径</label>
        <input
          id="ws-path"
          :value="draft.path"
          type="text"
          spellcheck="false"
          data-testid="path-input"
          @input="setPath"
        />
      </div>
      <p v-if="isWholeVolumeRoot" class="ws__risk" data-testid="whole-volume-warning">
        整卷范围：获授的读取工具可能把该卷上的私人文件内容发送给 ChatGPT；获授“文件修改”后可在该卷内直接创建或编辑文本文件。硬拒绝秘密/插件状态、系统 ACL、冲突检查和审计仍生效。请确认这就是你要授权的磁盘。
      </p>

      <fieldset class="ws__field">
        <legend>范围</legend>
        <label class="ws__choice">
          <input
            type="radio"
            name="ws-kind"
            value="directory"
            :checked="draft.kind === 'directory'"
            data-testid="kind-directory"
            @change="setKind('directory')"
          />
          目录（这个根下面的文件）
        </label>
        <label class="ws__choice">
          <input
            type="radio"
            name="ws-kind"
            value="file"
            :checked="draft.kind === 'file'"
            data-testid="kind-file"
            @change="setKind('file')"
          />
          单个文件
        </label>
      </fieldset>

      <fieldset class="ws__field">
        <legend>模式</legend>
        <div v-for="offer in offers" :key="offer.mode" class="ws__offer">
          <label class="ws__choice">
            <input
              type="radio"
              name="ws-mode"
              :value="offer.mode"
              :checked="draft.mode === offer.mode"
              :data-testid="`mode-${offer.mode}`"
              @change="setMode(offer.mode)"
            />
            <strong>{{ offer.label }}</strong>
          </label>
          <!-- 风险说明紧跟在它自己的选项下面，而不是页面底部的一段小字。 -->
          <p class="ws__risk" :data-mode="offer.mode" data-testid="mode-risk">{{ offer.risk }}</p>
          <label v-if="offer.requires_ack && draft.mode === offer.mode" class="ws__ack">
            <input
              type="checkbox"
              :checked="draft.risk_ack"
              data-testid="risk-ack"
              @change="setAckFromEvent"
            />
            我已读过上面这段说明
          </label>
        </div>
      </fieldset>

      <p v-if="selectedOffer !== null" class="ws__dim" data-testid="selected-risk">
        将登记为「{{ selectedOffer.label }}」。
      </p>

      <div class="ws__actions">
        <button
          type="button"
          class="ws__submit"
          data-testid="register-button"
          :disabled="!canSubmit"
          @click="onSubmit"
        >
          登记
        </button>
        <button type="button" data-testid="reset-button" @click="resetForm">清空</button>
      </div>

      <!-- 不能提交的原因**逐条**列出来。留白会让操作者以为按钮坏了。 -->
      <ul v-if="validation.problems.length > 0" class="ws__problems" data-testid="form-problems">
        <li v-for="(problem, index) in validation.problems" :key="index" data-testid="form-problem">{{ problem }}</li>
      </ul>
      <p v-else-if="session === null" class="ws__dim" data-testid="no-session">
        {{
          sessionExpired
            ? '控制台会话已过期，登记按不动。请重新运行本地启动命令。'
            : '还没有控制台会话，登记按不动。本地启动命令会打印一个带一次性令牌的地址，用它打开控制台。'
        }}
      </p>
      <p class="ws__dim" data-testid="capability-note">
        登记本身**不改动**那个目录里的任何文件，也不代表内容立刻会被读走 ——
        对应工具只有在该根保存 grant 且 ChatGPT 连接启用后才可调用。
      </p>
    </section>

    <!-- 列表。 -->
    <section class="ws__list" aria-label="已登记的工作区">
      <h3>已登记的根（{{ workspaces.length }}）</h3>
      <p v-if="workspaces.length === 0" class="ws__dim" data-testid="empty-state">
        当前没有任何目录被登记，因此没有任何本机内容暴露给模型。
      </p>

      <ul v-else class="ws__rows" data-testid="workspace-list">
        <li
          v-for="row in workspaces"
          :key="row.workspace_id"
          class="ws__row"
          :class="{ 'ws__row--removed': row.removed }"
          :data-workspace-id="row.workspace_id"
          :data-removed="row.removed ? 'true' : 'false'"
          data-testid="workspace-row"
        >
          <div class="ws__row-head">
            <span class="ws__alias" data-testid="ws-alias">{{ row.alias }}</span>
            <span class="ws__state" data-testid="ws-state">{{ describeWorkspace(row).state_label }}</span>
            <span class="ws__mode-label" data-testid="ws-mode">{{ describeWorkspace(row).mode_label }}</span>
          </div>

          <!-- 本机绝对路径：这一页是给**本地操作者**看的，藏起来他就无法
               确认登记的是哪一个目录。它不会流向模型。 -->
          <code class="ws__root" data-testid="ws-root">{{ row.root }}</code>

          <p class="ws__dim" data-testid="ws-ids">
            {{ row.kind === 'directory' ? '目录' : '单个文件' }} ·
            代次 {{ row.generation }} · 策略版本 {{ row.policy_version }}
          </p>

          <section class="ws__access" :aria-label="`${row.alias} 的 ChatGPT 工具授权`" data-testid="workspace-access">
            <p data-testid="access-summary">
              ChatGPT 网页已保存授权：
              <strong>{{ accessFor(row)?.enabled ? ACCESS_OPTIONS.filter((option) => accessFor(row)?.capabilities.includes(option.capability)).map((option) => option.label).join('、') : '未授权访问此目录' }}</strong>
            </p>
            <button
              v-if="!row.removed"
              type="button"
              :disabled="!canAct(row)"
              :data-testid="`configure-access-${row.workspace_id}`"
              @click="openAccess(row)"
            >
              配置 ChatGPT 工具
            </button>
            <div v-if="accessDraft?.workspace_id === row.workspace_id" class="ws__access-editor" :data-testid="`access-editor-${row.workspace_id}`">
              <p class="ws__risk">
                只对上面这个目录生效。勾选“文件修改”代表允许 ChatGPT 在此目录直接创建/删除普通文件并应用修改集，不再逐次等待批准；编辑已有文件还需同时授予“读取文件内容”。取消勾选并保存即可撤销。其他目录不受影响。
              </p>
              <label v-for="option in ACCESS_OPTIONS" :key="option.capability" class="ws__choice ws__access-option">
                <input
                  type="checkbox"
                  :checked="accessDraft.capabilities.includes(option.capability)"
                  :disabled="option.capability === 'propose' && row.mode === 'read_only'"
                  :data-testid="`access-${row.workspace_id}-${option.capability}`"
                  @change="toggleAccess(option.capability, $event)"
                />
                <span><strong>{{ option.label }}</strong> <code>{{ option.tools }}</code></span>
              </label>
              <p v-if="row.mode === 'read_only'" class="ws__dim" data-testid="propose-mode-note">
                此根登记为只读，不能授权文件修改。
              </p>
              <div class="ws__actions">
                <button type="button" :disabled="!canAct(row)" :data-testid="`save-access-${row.workspace_id}`" @click="saveAccess">保存目录授权</button>
                <button type="button" :data-testid="`cancel-access-${row.workspace_id}`" @click="cancelAccess">取消</button>
              </div>
            </div>
          </section>

          <div v-if="!row.removed" class="ws__row-actions">
            <button v-if="row.enabled" type="button" :disabled="!canAct(row)" :data-testid="`pause-${row.workspace_id}`" @click="emit('pause', { workspace_id: row.workspace_id })">
              暂停
            </button>
            <button v-else type="button" :disabled="!canAct(row)" :data-testid="`resume-${row.workspace_id}`" @click="emit('resume', { workspace_id: row.workspace_id })">
              恢复
            </button>
            <button type="button" :disabled="!canAct(row)" :data-testid="`reverify-${row.workspace_id}`" @click="emit('reverify', { workspace_id: row.workspace_id })">
              重新核对身份
            </button>
            <button type="button" :disabled="!canAct(row)" :data-testid="`relocate-${row.workspace_id}`" @click="startRelocate(row.workspace_id, row.root)">
              重新指向
            </button>
            <button type="button" :disabled="!canAct(row)" :data-testid="`remove-${row.workspace_id}`" @click="askRemove(row.workspace_id)">
              移除
            </button>
          </div>

          <!-- 移除要二次确认。它**不删文件**，但它会让模型立刻失去这个根 ——
               一次误点不该产生这个后果。 -->
          <div v-if="confirmingRemove === row.workspace_id" class="ws__confirm" data-testid="remove-confirm">
            <p>
              确认移除这个登记？目录里的文件**不受影响**，但模型立刻失去对它的访问。
            </p>
            <button type="button" :data-testid="`remove-confirm-${row.workspace_id}`" @click="confirmRemove(row.workspace_id)">
              确认移除
            </button>
            <button type="button" data-testid="remove-cancel" @click="cancelRemove">取消</button>
          </div>

          <div v-if="relocating === row.workspace_id" class="ws__confirm" data-testid="relocate-form">
            <label :for="`relocate-path-${row.workspace_id}`">新的完整路径</label>
            <input
              :id="`relocate-path-${row.workspace_id}`"
              :value="relocatePath"
              type="text"
              spellcheck="false"
              data-testid="relocate-input"
              @input="setRelocatePath"
            />
            <p class="ws__dim">它**不改动**用户文件：只是把这条登记指向另一个位置，并重新核对身份。</p>
            <button type="button" :data-testid="`relocate-confirm-${row.workspace_id}`" @click="confirmRelocate(row.workspace_id)">
              确认
            </button>
            <button type="button" data-testid="relocate-cancel" @click="cancelRelocate">取消</button>
          </div>
        </li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
.ws {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 68rem;
}

.ws__machine {
  margin: 4px 0;
  color: var(--lwb-muted, #5a6270);
}

.ws__exposure {
  font-weight: 700;
  margin: 4px 0;
}

.ws__exposure[data-exposed='true'] {
  color: var(--lwb-warn-fg, #7a5200);
}

.ws__feedback {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--lwb-border, #d0d4da);
}

.ws__feedback--ok {
  border-color: var(--lwb-ok-fg, #1c5c2a);
  background: var(--lwb-ok-bg, #dff3e2);
}

.ws__feedback--bad {
  border-color: var(--lwb-danger-fg, #8a1c1c);
  background: var(--lwb-danger-bg, #ffd9d9);
  color: var(--lwb-danger-fg, #8a1c1c);
}

.ws__dim {
  color: var(--lwb-muted, #5a6270);
}

.ws__form {
  border: 1px solid var(--lwb-border, #d0d4da);
  border-radius: 6px;
  padding: 10px 12px;
}

.ws__field {
  margin: 8px 0;
}

.ws__field input[type='text'] {
  display: block;
  width: 100%;
  margin-top: 4px;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
}

.ws__choice {
  display: block;
  margin: 4px 0;
}

.ws__offer {
  margin-bottom: 8px;
}

.ws__risk {
  margin: 2px 0 2px 24px;
  color: var(--lwb-muted, #5a6270);
}

.ws__ack {
  display: block;
  margin-left: 24px;
}

.ws__problems {
  color: var(--lwb-danger-fg, #8a1c1c);
}

.ws__rows {
  list-style: none;
  padding: 0;
  margin: 8px 0;
  display: grid;
  gap: 8px;
}

.ws__row {
  border: 1px solid var(--lwb-border, #d0d4da);
  border-radius: 6px;
  padding: 8px 10px;
}

.ws__row--removed {
  opacity: 0.6;
  border-style: dashed;
}

.ws__row-head {
  display: flex;
  gap: 12px;
  align-items: baseline;
  flex-wrap: wrap;
}

.ws__alias {
  font-weight: 700;
}

.ws__state,
.ws__mode-label {
  color: var(--lwb-muted, #5a6270);
}

.ws__root {
  display: block;
  margin: 4px 0;
  overflow-wrap: anywhere;
}

.ws__row-actions,
.ws__confirm,
.ws__access-editor {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: baseline;
  margin-top: 6px;
}

.ws__access {
  margin: 10px 0;
  padding: 10px;
  border: 1px solid var(--lwb-border, #d0d4da);
  border-radius: 6px;
  background: var(--lwb-panel, #fff);
}

.ws__access > p { margin: 0 0 8px; }
.ws__access-editor { display: grid; gap: 8px; margin-top: 10px; }
.ws__access-option { align-items: flex-start; }
.ws__access-option code { color: var(--lwb-muted, #5a6270); }

.ws__confirm input[type='text'] {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  min-width: 24rem;
}
</style>
