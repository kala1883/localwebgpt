<!--
  Local recovery/history host.

  The host is served by the daemon itself. Its origin therefore matches the
  authenticated control API; the page never needs CORS or a second API origin.
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ControlApiFailure, ControlClient } from '../src/auth/client.ts';
import { parseHistoryResponse, type HistoryData } from '../src/history/index.ts';
import { parseRecoveryResponse, type RecoveryRecord, type RecoverySession } from '../src/recovery/index.ts';
import {
  machineLine,
  parseStatusReading,
  parseWorkspaceAccess,
  parseConnections,
  parseWorkspaces,
  type ModelWorkspaceCapability,
  type StatusReading,
  type WorkspaceAccessRow,
  type WorkspaceKind,
  type WorkspaceMode,
  type WorkspaceRow,
} from '../src/setup/index.ts';
import type { SessionPresence } from '../src/changes/approval.ts';
import ConnectionView from './ConnectionView.vue';
import HistoryView from './HistoryView.vue';
import RecoveryView from './RecoveryView.vue';
import WorkspacesView from './WorkspacesView.vue';

const props = defineProps<{
  readonly client: ControlClient;
  readonly startupMessage: string | null;
}>();

const page = ref<'recovery' | 'history' | 'connection' | 'workspaces'>('recovery');
const recoveryRows = ref<readonly RecoveryRecord[]>([]);
const selectedOperationId = ref('');
const recoveryRecord = ref<RecoveryRecord | null>(null);
const historyData = ref<HistoryData | null>(null);
const workspaces = ref<readonly WorkspaceRow[]>([]);
const workspaceAccess = ref<readonly WorkspaceAccessRow[]>([]);
const connectionEnabled = ref<boolean | null>(null);
const statusReading = ref<StatusReading | null>(null);
const now = ref(new Date().toISOString());
const busy = ref(false);
const error = ref<string | null>(props.startupMessage);
const notice = ref<string | null>(null);
const authenticated = ref(props.client.session !== null);
const clientSession = computed<RecoverySession | null>(() => authenticated.value ? { authenticated: true } : null);
const workspaceSession = computed<SessionPresence | null>(() =>
  authenticated.value ? { session_id: props.client.session?.session_id ?? 'active' } : null,
);

function recordRows(payload: unknown): readonly RecoveryRecord[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return [];
  const envelope = payload as Record<string, unknown>;
  if (!Array.isArray(envelope['records'])) return [];
  const observedAt = typeof envelope['observed_at'] === 'string' ? envelope['observed_at'] : '';
  return envelope['records']
    .map((record) => parseRecoveryResponse({ record, observed_at: observedAt }))
    .filter((record): record is RecoveryRecord => record !== null);
}

function setFailure(cause: unknown): void {
  if (cause instanceof ControlApiFailure && cause.detail.session_expired) {
    error.value = '控制台会话已过期。请重新运行本地启动命令，再打开新打印的链接。';
    recoveryRecord.value = null;
    historyData.value = null;
    authenticated.value = false;
    workspaceAccess.value = [];
    connectionEnabled.value = null;
    return;
  }
  error.value = cause instanceof Error ? cause.message : '本机请求失败。';
}

async function loadRecoveryList(preferredId = selectedOperationId.value): Promise<void> {
  if (props.client.session === null) return;
  const payload = await props.client.call('/api/recovery/list');
  recoveryRows.value = recordRows(payload);
  const nextId = recoveryRows.value.some((row) => row.operation_id === preferredId)
    ? preferredId
    : recoveryRows.value[0]?.operation_id ?? '';
  selectedOperationId.value = nextId;
  if (nextId.length === 0) {
    recoveryRecord.value = null;
    return;
  }
  await loadRecovery(nextId);
}

async function loadRecovery(operationId: string): Promise<void> {
  if (props.client.session === null || operationId.length === 0) return;
  const payload = await props.client.call('/api/recovery/get', { operation_id: operationId });
  recoveryRecord.value = parseRecoveryResponse(payload);
  if (recoveryRecord.value === null) throw new Error('恢复记录响应无法解析，已拒绝显示不完整内容。');
}

async function loadHistory(): Promise<void> {
  if (props.client.session === null) return;
  const payload = await props.client.call('/api/history/list', { limit: 100 });
  historyData.value = parseHistoryResponse(payload);
  if (historyData.value === null) throw new Error('历史响应无法解析，已拒绝显示不完整记录。');
}

async function loadWorkspaceData(): Promise<void> {
  if (props.client.session === null) return;
  now.value = new Date().toISOString();
  const [workspacePayload, accessPayload, connectionPayload, statusPayload] = await Promise.all([
    props.client.call('/api/workspaces/list'),
    props.client.call('/api/workspaces/access/list'),
    props.client.call('/api/connections/list'),
    props.client.get('/api/status'),
  ]);
  const parsedAccess = parseWorkspaceAccess(accessPayload);
  if (parsedAccess === null) throw new Error('目录授权响应格式未知；为避免误显示权限，已拒绝渲染。');
  workspaces.value = parseWorkspaces(workspacePayload);
  workspaceAccess.value = parsedAccess;
  connectionEnabled.value = parseConnections(connectionPayload)
    .find((row) => row.principal_kind === 'model_surface')?.enabled ?? null;
  statusReading.value = parseStatusReading(statusPayload);
}

async function refresh(): Promise<void> {
  if (props.client.session === null) return;
  busy.value = true;
  error.value = null;
  try {
    if (page.value === 'recovery') await loadRecoveryList();
    else if (page.value === 'history') await loadHistory();
    else if (page.value === 'workspaces') await loadWorkspaceData();
  } catch (cause) {
    setFailure(cause);
  } finally {
    busy.value = false;
  }
}

async function mutate(
  path: string,
  subject: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (props.client.session === null) throw new Error('本地控制台会话不可用。');
  const authorized = await props.client.authorizeMutation(path, subject, body);
  return props.client.call(path, authorized);
}

async function performMutation(
  path: string,
  subject: string,
  body: Record<string, unknown>,
  successMessage: string,
): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    await mutate(path, subject, body);
    notice.value = successMessage;
    await loadRecoveryList(selectedOperationId.value);
    if (page.value === 'history') await loadHistory();
  } catch (cause) {
    setFailure(cause);
  } finally {
    busy.value = false;
  }
}

async function performWorkspaceMutation(
  path: string,
  subject: string,
  body: Record<string, unknown>,
  successMessage: string,
): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    await mutate(path, subject, body);
    notice.value = successMessage;
    await loadWorkspaceData();
  } catch (cause) {
    setFailure(cause);
  } finally {
    busy.value = false;
  }
}

function registerWorkspace(payload: {
  readonly alias: string;
  readonly kind: WorkspaceKind;
  readonly mode: WorkspaceMode;
  readonly path: string;
}): void {
  void performWorkspaceMutation(
    '/api/workspaces/register',
    `register:${payload.alias}`,
    payload,
    '目录已登记；默认没有授予 ChatGPT 访问权限，请在该目录行中单独配置工具。',
  );
}

function changeWorkspace(
  operation: 'pause' | 'resume' | 'remove' | 'reverify',
  payload: { readonly workspace_id: string },
): void {
  const messages = {
    pause: '工作区已暂停，ChatGPT 不能继续访问。',
    resume: '工作区已恢复；已有目录授权仍按原能力生效。',
    remove: '工作区登记已移除，ChatGPT 失去对此根的访问。',
    reverify: '工作区身份已重新核对。',
  } as const;
  void performWorkspaceMutation(
    `/api/workspaces/${operation}`,
    payload.workspace_id,
    payload,
    messages[operation],
  );
}

function relocateWorkspace(payload: { readonly workspace_id: string; readonly path: string }): void {
  void performWorkspaceMutation(
    '/api/workspaces/relocate',
    payload.workspace_id,
    payload,
    '工作区路径已更新；旧目录授权随工作区保留并绑定到新核验的根。',
  );
}

function setWorkspaceAccess(payload: {
  readonly workspace_id: string;
  readonly capabilities: readonly ModelWorkspaceCapability[];
}): void {
  void performWorkspaceMutation(
    '/api/workspaces/access/set',
    payload.workspace_id,
    { workspace_id: payload.workspace_id, capabilities: payload.capabilities },
    payload.capabilities.length === 0
      ? '已撤销 ChatGPT 对此目录的全部访问。'
      : '此目录的 ChatGPT 工具授权已保存。',
  );
}

function keepCurrent(payload: { readonly operation_id: string; readonly item_id: string }): void {
  void performMutation(
    '/api/recovery/keep_current',
    `${payload.operation_id}:${payload.item_id}`,
    payload,
    '已记录保留当前文件的决定；恢复状态仍由数据库保留。',
  );
}

function rePropose(payload: { readonly operation_id: string; readonly item_id: string }): void {
  void performMutation(
    '/api/recovery/repropose',
    `${payload.operation_id}:${payload.item_id}`,
    payload,
    '已记录重新提议请求。请以当前文件为基线创建新修改集。',
  );
}

function authorizeRecovery(payload: {
  readonly operation_id: string;
  readonly plan_digest: string;
  readonly confirmed: true;
}): void {
  void performMutation(
    '/api/recovery/authorize',
    payload.operation_id,
    { operation_id: payload.operation_id, confirmed: true },
    '已签发一次性恢复授权。',
  );
}

function repairRecovery(payload: {
  readonly operation_id: string;
  readonly authorization_id: string;
  readonly plan_digest: string;
  readonly confirmed: true;
}): void {
  void performMutation(
    '/api/recovery/repair',
    payload.operation_id,
    {
      operation_id: payload.operation_id,
      authorization_id: payload.authorization_id,
      confirmed: true,
    },
    '恢复请求已完成；下面的状态来自数据库重新读取。',
  );
}

async function selectPage(next: 'recovery' | 'history' | 'connection' | 'workspaces'): Promise<void> {
  page.value = next;
  if (next !== 'connection') await refresh();
}

async function logout(): Promise<void> {
  await props.client.logout();
  authenticated.value = false;
  recoveryRecord.value = null;
  historyData.value = null;
  workspaces.value = [];
  workspaceAccess.value = [];
  connectionEnabled.value = null;
  statusReading.value = null;
  error.value = '已登出。重新载入本页需要重新运行本地启动命令。';
}

async function openRecovery(operationId: string): Promise<void> {
  selectedOperationId.value = operationId;
  await selectPage('recovery');
}

async function selectOperation(event: Event): Promise<void> {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  selectedOperationId.value = target.value;
  await refresh();
}

onMounted(() => {
  void refresh();
});
</script>

<template>
  <main class="host">
    <header class="host__top">
      <div>
        <p class="host__eyebrow">Local Workspace Bridge</p>
        <h1>本机恢复控制台</h1>
      </div>
      <div class="host__session" :data-authenticated="clientSession !== null">
        {{ clientSession ? '本地会话已建立' : '等待本地会话' }}
      </div>
    </header>

    <nav class="host__nav" aria-label="控制台页面">
      <button type="button" :aria-current="page === 'recovery' ? 'page' : undefined" @click="selectPage('recovery')">
        恢复与冲突
      </button>
      <button type="button" :aria-current="page === 'history' ? 'page' : undefined" @click="selectPage('history')">
        历史
      </button>
      <button type="button" :aria-current="page === 'connection' ? 'page' : undefined" @click="selectPage('connection')">
        ChatGPT 连接
      </button>
      <button type="button" :aria-current="page === 'workspaces' ? 'page' : undefined" @click="selectPage('workspaces')">
        工作区与工具授权
      </button>
      <button v-if="page !== 'connection'" type="button" :disabled="clientSession === null" @click="refresh">重新读取</button>
      <button type="button" :disabled="clientSession === null" @click="logout">
        登出
      </button>
    </nav>

    <p v-if="error" class="host__message host__message--error" role="alert">{{ error }}</p>
    <p v-if="notice" class="host__message" role="status">{{ notice }}</p>

    <section v-if="page === 'recovery'" class="host__content">
      <label v-if="recoveryRows.length > 1" class="host__selector">
        待处理恢复操作
        <select :value="selectedOperationId" @change="selectOperation">
          <option v-for="row in recoveryRows" :key="row.operation_id" :value="row.operation_id">
            {{ row.operation_id }} · {{ row.change_id }}
          </option>
        </select>
      </label>
      <RecoveryView
        :record="recoveryRecord"
        :session="clientSession"
        :busy="busy"
        :export-client="clientSession ? client : null"
        @refresh="refresh"
        @keep-current="keepCurrent"
        @re-propose="rePropose"
        @authorize-recovery="authorizeRecovery"
        @repair-recovery="repairRecovery"
      />
    </section>
    <HistoryView
      v-else-if="page === 'history'"
      :data="historyData"
      :loading="busy"
      :error="error"
      @refresh="refresh"
      @open-recovery="({ operation_id }) => openRecovery(operation_id)"
    />
    <ConnectionView v-else-if="page === 'connection'" :client="client" :session-active="authenticated" />
    <WorkspacesView
      v-else
      :now="now"
      :session="workspaceSession"
      :workspaces="workspaces"
      :workspace-access="workspaceAccess"
      :connection-enabled="connectionEnabled"
      :flags="statusReading?.capability_flags ?? null"
      :machine-line="machineLine(statusReading?.machine ?? null)"
      :busy="busy"
      :feedback="notice === null ? null : { ok: true, message: notice }"
      @register="registerWorkspace"
      @pause="changeWorkspace('pause', $event)"
      @resume="changeWorkspace('resume', $event)"
      @remove="changeWorkspace('remove', $event)"
      @reverify="changeWorkspace('reverify', $event)"
      @relocate="relocateWorkspace"
      @set-access="setWorkspaceAccess"
    />
  </main>
</template>

<style>
:root { color-scheme: light; font-family: "Segoe UI", system-ui, sans-serif; background: #f3f5f8; color: #16202d; }
* { box-sizing: border-box; }
body { margin: 0; }
button, select { font: inherit; }
button { border: 1px solid #748399; border-radius: .45rem; background: white; color: #16202d; padding: .55rem .9rem; cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .55; }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 3px solid #3478d4; outline-offset: 2px; }
.host { max-width: 1120px; margin: 0 auto; padding: 1.5rem; }
.host__top, .host__nav { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.host__top { padding-bottom: 1rem; border-bottom: 1px solid #d3dae4; }
.host__eyebrow { margin: 0; color: #53647b; font-size: .82rem; letter-spacing: .04em; text-transform: uppercase; }
.host__top h1 { margin: .25rem 0 0; font-size: 1.5rem; }
.host__session { border-radius: 999px; padding: .35rem .7rem; background: #e4f4eb; color: #145b35; }
.host__session[data-authenticated="false"] { background: #fff0d9; color: #704600; }
.host__nav { justify-content: flex-start; padding: 1rem 0; flex-wrap: wrap; }
.host__nav [aria-current="page"] { border-color: #245da8; background: #e8f1ff; color: #17477f; }
.host__content, .history, .recovery { display: grid; gap: 1rem; }
.host__message { margin: .5rem 0; padding: .8rem 1rem; border-radius: .5rem; background: #e4f4eb; }
.host__message--error { background: #ffebeb; color: #7c2020; }
.host__selector { display: flex; gap: .75rem; align-items: center; }
.host__selector select { min-width: 24rem; padding: .5rem; }
.recovery > *, .history > *, .detail__region, .detail__prose, .history__section, .recovery__versions, .recovery__repair, .recovery__ledger { border: 1px solid #d3dae4; border-radius: .65rem; background: white; padding: 1rem; }
.recovery__header, .history__header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.recovery__item { border-top: 1px solid #e2e7ee; padding: 1rem 0; }
.recovery__item-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .75rem; }
.recovery__versions-grid { display: grid; grid-template-columns: 9rem minmax(0, 1fr); gap: .45rem .75rem; }
.recovery__versions-grid dd { margin: 0; overflow-wrap: anywhere; }
.recovery__confirm { display: flex; gap: .55rem; align-items: flex-start; padding: .65rem 0; }
.recovery__hint, .history__hint { color: #53647b; }
.recovery__notice { padding: .75rem; background: #fff0d9; border-radius: .5rem; }
.history table { width: 100%; border-collapse: collapse; }
.history th, .history td { text-align: left; vertical-align: top; padding: .55rem; border-bottom: 1px solid #e2e7ee; }
@media (max-width: 700px) {
  .host { padding: .8rem; }
  .recovery__versions-grid { grid-template-columns: 1fr; }
  .recovery__header, .history__header { align-items: flex-start; flex-direction: column; }
  .host__selector { align-items: flex-start; flex-direction: column; }
  .host__selector select { min-width: 0; width: 100%; }
  .history { overflow-x: auto; }
}
</style>
