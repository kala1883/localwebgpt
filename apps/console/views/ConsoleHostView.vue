<!--
  Local recovery/history host.

  The host is served by the daemon itself. Its origin therefore matches the
  authenticated control API; the page never needs CORS or a second API origin.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
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
import ConfigurationView from './ConfigurationView.vue';

interface ConsoleConfiguration {
  readonly schema_version: number;
  readonly session: { readonly idle_timeout_ms: number; readonly absolute_timeout_ms: number | null };
  readonly workspaces: readonly Record<string, unknown>[];
}

function parseConsoleConfiguration(result: unknown): ConsoleConfiguration | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  const session = record['session'];
  if (
    typeof record['schema_version'] !== 'number' ||
    typeof session !== 'object' || session === null || Array.isArray(session) ||
    typeof (session as Record<string, unknown>)['idle_timeout_ms'] !== 'number' ||
    ((session as Record<string, unknown>)['absolute_timeout_ms'] !== null &&
      typeof (session as Record<string, unknown>)['absolute_timeout_ms'] !== 'number') ||
    !Array.isArray(record['workspaces'])
  ) return null;
  if (record['workspaces'].some((workspace) => typeof workspace !== 'object' || workspace === null || Array.isArray(workspace))) {
    return null;
  }
  return result as ConsoleConfiguration;
}

const props = defineProps<{
  readonly client: ControlClient;
  readonly startupMessage: string | null;
}>();

const page = ref<'recovery' | 'history' | 'connection' | 'workspaces' | 'configuration'>('workspaces');
const pageMeta = computed(() => {
  switch (page.value) {
    case 'workspaces':
      return { title: '工作区', subtitle: '登记本地目录或文件，让 ChatGPT 在授权范围内读取与修改', icon: 'folder' };
    case 'recovery':
      return { title: '恢复与冲突', subtitle: '查看待处理的文件变更，并安全地恢复本地内容', icon: 'history' };
    case 'history':
      return { title: '历史记录', subtitle: '查看本地工作区的操作记录与审计信息', icon: 'clock' };
    case 'connection':
      return { title: 'ChatGPT 连接', subtitle: '管理本机与 ChatGPT 之间的安全连接', icon: 'link' };
    case 'configuration':
      return { title: '配置', subtitle: '设置会话期限，并查看工作区和工具授权 JSON', icon: 'settings' };
  }
});
const recoveryRows = ref<readonly RecoveryRecord[]>([]);
const selectedOperationId = ref('');
const recoveryRecord = ref<RecoveryRecord | null>(null);
const historyData = ref<HistoryData | null>(null);
const workspaces = ref<readonly WorkspaceRow[]>([]);
const workspaceAccess = ref<readonly WorkspaceAccessRow[]>([]);
const connectionEnabled = ref<boolean | null>(null);
const statusReading = ref<StatusReading | null>(null);
const configuration = ref<ConsoleConfiguration | null>(null);
const now = ref(new Date().toISOString());
const busy = ref(false);
const savingConfiguration = ref(false);
const error = ref<string | null>(props.startupMessage);
const notice = ref<string | null>(null);
const browserInvitationUrl = ref<string | null>(null);
const invitingBrowser = ref(false);
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
    error.value = '本地会话已过期。请从仍在线的控制台生成新浏览器链接；如果没有在线控制台，请重新运行本地启动脚本。';
    recoveryRecord.value = null;
    historyData.value = null;
    authenticated.value = false;
    workspaceAccess.value = [];
    connectionEnabled.value = null;
    configuration.value = null;
    return;
  }
  error.value = cause instanceof Error ? cause.message : '本机请求失败。';
}

async function connectAnotherBrowser(): Promise<void> {
  if (props.client.session === null) return;
  invitingBrowser.value = true;
  browserInvitationUrl.value = null;
  error.value = null;
  notice.value = null;
  try {
    const payload = await props.client.call('/api/session/invitations');
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error('浏览器接入链接响应格式未知。');
    }
    const url = (payload as Record<string, unknown>)['url'];
    if (typeof url !== 'string') throw new Error('本地服务没有返回浏览器接入链接。');
    const parsed = new URL(url);
    if (parsed.origin !== window.location.origin || parsed.pathname !== '/' || !parsed.hash.startsWith('#t=lwb_boot_')) {
      throw new Error('浏览器接入链接不是本机控制台地址，已拒绝显示。');
    }
    browserInvitationUrl.value = url;
    await copyBrowserInvitation();
  } catch (cause) {
    setFailure(cause);
  } finally {
    invitingBrowser.value = false;
  }
}

async function copyBrowserInvitation(): Promise<void> {
  const url = browserInvitationUrl.value;
  if (url === null) return;
  try {
    await navigator.clipboard.writeText(url);
    notice.value = '浏览器接入链接已复制；5 分钟内可在另一浏览器兑换一次。请只在自己的设备间使用。';
  } catch {
    notice.value = '链接已生成。请选中下方地址并复制；5 分钟内可兑换一次。';
  }
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
  const [workspacePayload, accessPayload, connectionPayload, statusPayload, configurationPayload] = await Promise.all([
    props.client.call('/api/workspaces/list'),
    props.client.call('/api/workspaces/access/list'),
    props.client.call('/api/connections/list'),
    props.client.get('/api/status'),
    props.client.get('/api/config'),
  ]);
  const parsedAccess = parseWorkspaceAccess(accessPayload);
  if (parsedAccess === null) throw new Error('目录授权响应格式未知；为避免误显示权限，已拒绝渲染。');
  workspaces.value = parseWorkspaces(workspacePayload);
  workspaceAccess.value = parsedAccess;
  connectionEnabled.value = parseConnections(connectionPayload)
    .find((row) => row.principal_kind === 'model_surface')?.enabled ?? null;
  statusReading.value = parseStatusReading(statusPayload);
  const parsedConfiguration = parseConsoleConfiguration(configurationPayload);
  if (parsedConfiguration === null) throw new Error('本机 JSON 配置响应格式未知。');
  configuration.value = parsedConfiguration;
  scheduleSessionCheck();
}

async function loadConfiguration(): Promise<void> {
  const result = await props.client.get('/api/config');
  const parsed = parseConsoleConfiguration(result);
  if (parsed === null) throw new Error('本机 JSON 配置响应格式未知。');
  configuration.value = parsed;
  scheduleSessionCheck();
}

async function pickWorkspacePath(kind: WorkspaceKind): Promise<string | null> {
  const result = await props.client.call('/api/workspaces/pick', { kind });
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('本机选择窗口响应格式未知。');
  }
  const path = (result as Record<string, unknown>)['path'];
  if (path === null) return null;
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('本机选择窗口没有返回有效路径。');
  }
  return path;
}

async function refresh(): Promise<void> {
  if (props.client.session === null) return;
  busy.value = true;
  error.value = null;
  try {
    if (page.value === 'recovery') await loadRecoveryList();
    else if (page.value === 'history') await loadHistory();
    else if (page.value === 'workspaces') await loadWorkspaceData();
    else if (page.value === 'configuration') await loadConfiguration();
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

async function selectPage(next: 'recovery' | 'history' | 'connection' | 'workspaces' | 'configuration'): Promise<void> {
  page.value = next;
  if (next !== 'connection') await refresh();
}

async function saveSessionConfiguration(settings: {
  readonly idle_timeout_ms: number;
  readonly absolute_timeout_ms: number | null;
}): Promise<void> {
  if (props.client.session === null) return;
  savingConfiguration.value = true;
  error.value = null;
  notice.value = null;
  try {
    const body = {
      idle_timeout_ms: settings.idle_timeout_ms,
      absolute_timeout_ms: settings.absolute_timeout_ms,
    };
    const authorized = await props.client.authorizeMutation('/api/config/session', 'session-timeouts', body);
    const result = await props.client.call('/api/config/session', authorized);
    const parsed = parseConsoleConfiguration(result);
    if (parsed === null) throw new Error('保存后的 JSON 配置响应格式未知。');
    configuration.value = parsed;
    scheduleSessionCheck();
    notice.value = '会话期限已保存并立即生效。';
  } catch (cause) {
    setFailure(cause);
  } finally {
    savingConfiguration.value = false;
  }
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
  configuration.value = null;
  error.value = '已登出。要重新进入，请使用另一个在线控制台生成浏览器链接；如果没有在线控制台，请重新运行本地启动脚本。';
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

let sessionCheckTimer: number | null = null;
function sessionCheckDelay(): number {
  const idleTtlMs = configuration.value?.session.idle_timeout_ms ?? 0;
  if (idleTtlMs === 0) return 5 * 60 * 1000;
  return Math.max(15 * 1000, Math.min(5 * 60 * 1000, Math.floor(idleTtlMs / 2)));
}
function scheduleSessionCheck(): void {
  if (sessionCheckTimer !== null) window.clearInterval(sessionCheckTimer);
  sessionCheckTimer = window.setInterval(checkSessionAlive, sessionCheckDelay());
}
function checkSessionAlive(): void {
  if (props.client.session === null) return;
  void props.client.get('/api/session').catch(setFailure);
}
function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') checkSessionAlive();
}

onMounted(() => {
  void refresh();
  scheduleSessionCheck();
  document.addEventListener('visibilitychange', onVisibilityChange);
});

onUnmounted(() => {
  if (sessionCheckTimer !== null) window.clearInterval(sessionCheckTimer);
  document.removeEventListener('visibilitychange', onVisibilityChange);
});
</script>

<template>
  <main class="app-shell">
    <aside class="sidebar" aria-label="LocalWebGPT 主导航">
      <div class="brand">
        <span class="brand__mark" aria-hidden="true">
          <svg viewBox="0 0 34 34" fill="none"><rect x="4" y="4" width="26" height="19" rx="2.5" stroke="currentColor" stroke-width="2.5" /><path d="M12 29h10M17 23v6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" /></svg>
        </span>
        <div><strong>LocalWebGPT</strong><small>本地私有数据的智能助手</small></div>
      </div>

      <nav class="sidebar__nav" aria-label="控制台页面">
        <button type="button" class="sidebar__item sidebar__item--workspace" :class="{ 'is-active': page === 'workspaces' }" :aria-current="page === 'workspaces' ? 'page' : undefined" @click="selectPage('workspaces')">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m4 11 8-7 8 7v8.5A1.5 1.5 0 0 1 18.5 21h-13A1.5 1.5 0 0 1 4 19.5V11Z" fill="currentColor" /><path d="M9 21v-6h6v6" fill="white" /></svg><span class="sidebar__label sidebar__label--workspace">工作区与工具授权</span>
        </button>
        <button type="button" class="sidebar__item" :class="{ 'is-active': page === 'recovery' }" :aria-current="page === 'recovery' ? 'page' : undefined" @click="selectPage('recovery')">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 11a8 8 0 1 1 2.3 5.65" stroke="currentColor" stroke-width="2" stroke-linecap="round" /><path d="M4 5v6h6M12 8v5l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg><span class="sidebar__label">恢复与冲突</span>
        </button>
        <button type="button" class="sidebar__item" :class="{ 'is-active': page === 'history' }" :aria-current="page === 'history' ? 'page' : undefined" @click="selectPage('history')">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2" /><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg><span class="sidebar__label">历史记录</span>
        </button>
        <button type="button" class="sidebar__item" :class="{ 'is-active': page === 'connection' }" :aria-current="page === 'connection' ? 'page' : undefined" @click="selectPage('connection')">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9.5 14.5 14.5 9.5M7 17l-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0M17 7l1-1a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg><span class="sidebar__label">ChatGPT 连接</span>
        </button>
        <button type="button" class="sidebar__item" @click="selectPage('workspaces')">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14.5 4.5 2-2 5 5-2 2M13 6l5 5M4 20l3.2-.8L19.6 6.8l-2.4-2.4L4.8 16.8 4 20Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg><span class="sidebar__label">工具授权</span>
        </button>
        <button type="button" class="sidebar__item" :class="{ 'is-active': page === 'configuration' }" :aria-current="page === 'configuration' ? 'page' : undefined" @click="selectPage('configuration')">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 3 1.4 2.4 2.7.6.6 2.7L19 10l-1.7 2 1.7 2-2.3 1.3-.6 2.7-2.7.6L12 21l-1.4-2.4-2.7-.6-.6-2.7L5 14l1.7-2L5 10l2.3-1.3.6-2.7 2.7-.6L12 3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /><circle cx="12" cy="12" r="2.5" stroke="currentColor" stroke-width="1.8" /></svg><span class="sidebar__label">配置</span>
        </button>
      </nav>

      <div class="sidebar__bottom">
        <div class="session-card" :data-authenticated="clientSession !== null">
          <span class="session-card__dot" aria-hidden="true"></span>
          <strong>{{ clientSession ? '本地会话已建立' : '等待本地会话' }}</strong>
          <small>{{ machineLine(statusReading?.machine ?? null) }}</small>
          <small>win32 · x64</small>
        </div>
        <span class="sidebar__version">v1.0.0</span>
      </div>
    </aside>

    <div class="app-main">
      <header class="app-header">
        <div class="app-header__title">
          <span class="app-header__icon" aria-hidden="true">
            <svg v-if="pageMeta.icon === 'folder'" viewBox="0 0 32 32" fill="none"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h7l3 3h9A2.5 2.5 0 0 1 28 11.5v12a2.5 2.5 0 0 1-2.5 2.5h-19A2.5 2.5 0 0 1 4 23.5v-15Z" fill="currentColor" /></svg>
            <svg v-else-if="pageMeta.icon === 'history'" viewBox="0 0 32 32" fill="none"><path d="M6 14a10 10 0 1 1 2.8 7M6 6v8h8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" /><path d="M16 10v7l4 2" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" /></svg>
            <svg v-else-if="pageMeta.icon === 'clock'" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="11" stroke="currentColor" stroke-width="2.5" /><path d="M16 10v7l4 2" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" /></svg>
            <svg v-else-if="pageMeta.icon === 'settings'" viewBox="0 0 32 32" fill="none"><path d="m16 4 2 3.4 4 .9.9 4L26 14l-2.8 3.1.8 4-4 1.2L18 26l-4-2-3.1 2.8-2.8-3 1-4-3.4-2 2-3.5-.8-4 4-.9L13 6l3 2 3-2Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" /><circle cx="16" cy="16" r="3.5" stroke="currentColor" stroke-width="2" /></svg>
            <svg v-else viewBox="0 0 32 32" fill="none"><path d="M12.5 19.5 19.5 12.5M9 23l-1.5 1.5a5 5 0 0 1-7-7l4-4a5 5 0 0 1 7 0M23 9l1.5-1.5a5 5 0 0 1 7 7l-4 4a5 5 0 0 1-7 0" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" /></svg>
          </span>
          <div><h1>{{ pageMeta.title }}</h1><p>{{ pageMeta.subtitle }}</p></div>
        </div>
        <div class="app-header__actions">
          <div class="connection-pill" :data-authenticated="clientSession !== null"><span aria-hidden="true"></span>{{ clientSession ? '已连接' : '未连接' }}</div>
          <button type="button" class="header-refresh" :disabled="clientSession === null || page === 'connection'" @click="refresh"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11a8 8 0 1 0 1 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" /><path d="M20 5v6h-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>刷新状态</button>
          <button v-if="clientSession !== null" type="button" class="header-refresh" :disabled="invitingBrowser" @click="connectAnotherBrowser">{{ invitingBrowser ? '正在生成…' : '连接其他浏览器' }}</button>
          <button type="button" class="header-icon-button" aria-label="帮助" title="帮助">?</button>
          <button type="button" class="header-icon-button header-icon-button--user" aria-label="退出控制台" title="退出控制台" :disabled="clientSession === null" @click="logout"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8" r="3.2" fill="currentColor" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" fill="currentColor" /></svg></button>
        </div>
      </header>

      <div class="host__surface">
        <p v-if="error" class="host__message host__message--error" role="alert">{{ error }}</p>
        <p v-if="notice" class="host__message" role="status">{{ notice }}</p>
        <section v-if="browserInvitationUrl" class="invite-card" aria-label="浏览器接入链接">
          <strong>在另一浏览器打开此链接</strong>
          <div class="invite-card__row">
            <input :value="browserInvitationUrl" readonly aria-label="一次性浏览器接入链接" />
            <button type="button" @click="copyBrowserInvitation">复制链接</button>
            <button type="button" aria-label="关闭链接" @click="browserInvitationUrl = null">关闭</button>
          </div>
          <small>链接 5 分钟后过期，并且只能兑换一次。将它只复制到你自己的另一台本地浏览器。</small>
        </section>

        <section v-if="page === 'recovery'" class="host__content">
          <label v-if="recoveryRows.length > 1" class="host__selector">
            待处理恢复操作
            <select :value="selectedOperationId" @change="selectOperation">
              <option v-for="row in recoveryRows" :key="row.operation_id" :value="row.operation_id">{{ row.operation_id }} · {{ row.change_id }}</option>
            </select>
          </label>
          <RecoveryView :record="recoveryRecord" :session="clientSession" :busy="busy" :export-client="clientSession ? client : null" @refresh="refresh" @keep-current="keepCurrent" @re-propose="rePropose" @authorize-recovery="authorizeRecovery" @repair-recovery="repairRecovery" />
        </section>
        <HistoryView v-else-if="page === 'history'" :data="historyData" :loading="busy" :error="error" @refresh="refresh" @open-recovery="({ operation_id }) => openRecovery(operation_id)" />
        <ConnectionView v-else-if="page === 'connection'" :client="client" :session-active="authenticated" />
        <ConfigurationView v-else-if="page === 'configuration'" :configuration="configuration" :loading="busy" :saving="savingConfiguration" @save="saveSessionConfiguration" @refresh="refresh" />
        <WorkspacesView v-else-if="page === 'workspaces'" :now="now" :session="workspaceSession" :workspaces="workspaces" :workspace-access="workspaceAccess" :connection-enabled="connectionEnabled" :flags="statusReading?.capability_flags ?? null" :machine-line="machineLine(statusReading?.machine ?? null)" :busy="busy" :feedback="notice === null ? null : { ok: true, message: notice }" :pick-path="pickWorkspacePath" @register="registerWorkspace" @pause="changeWorkspace('pause', $event)" @resume="changeWorkspace('resume', $event)" @remove="changeWorkspace('remove', $event)" @reverify="changeWorkspace('reverify', $event)" @relocate="relocateWorkspace" @set-access="setWorkspaceAccess" @navigate="selectPage" @refresh="refresh" />
      </div>
    </div>
  </main>
</template>

<style>
:root {
  color-scheme: light;
  font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
  background: #f3f7fc;
  color: #172b53;
  --app-blue: #176cf0;
  --app-navy: #152961;
  --app-muted: #7789a7;
  --app-line: #e3ebf5;
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: #f3f7fc; }
button, input, select { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .55; }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 3px solid rgba(42, 123, 241, .35); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

.app-shell { display: grid; grid-template-columns: 230px minmax(0, 1fr); min-height: 100vh; background: radial-gradient(circle at 78% -10%, #fff 0, #f5f9fe 36%, #f1f6fc 100%); }
.sidebar { display: flex; flex-direction: column; min-height: 100vh; padding: 18px 14px 17px; border-right: 1px solid #e0e8f2; background: rgba(250, 252, 255, .83); }
.brand { display: flex; align-items: center; gap: 10px; padding: 0 7px; }
.brand__mark { display: grid; place-items: center; flex: 0 0 31px; width: 31px; height: 31px; color: var(--app-blue); }
.brand__mark svg { width: 31px; height: 31px; }
.brand strong { display: block; color: #102353; font-size: 19px; letter-spacing: -.04em; }
.brand small { display: block; margin-top: 3px; color: #8798b3; font-size: 10px; white-space: nowrap; }
.sidebar__nav { display: grid; gap: 7px; margin-top: 30px; }
.sidebar__item { display: flex; align-items: center; gap: 14px; width: 100%; padding: 11px 10px; border: 0; border-radius: 8px; background: transparent; color: #4e6388; text-align: left; font-size: 14px; transition: background .15s ease, color .15s ease; }
.sidebar__item svg { flex: 0 0 22px; width: 22px; height: 22px; }
.sidebar__item:hover { background: #f0f6ff; color: var(--app-blue); }
.sidebar__item.is-active { background: #e6f0ff; color: var(--app-blue); font-weight: 700; }
.sidebar__item--muted { color: #607594; }
.sidebar__item--workspace .sidebar__label { font-size: 0; }
.sidebar__item--workspace .sidebar__label::after { content: "工作区"; font-size: 14px; }
.sidebar__bottom { display: grid; gap: 17px; margin-top: auto; }
.session-card { padding: 12px 13px 11px; border: 1px solid #e7eef7; border-radius: 8px; background: rgba(255,255,255,.93); box-shadow: 0 6px 18px rgba(51, 91, 143, .05); }
.session-card__dot { display: inline-block; width: 10px; height: 10px; margin-right: 7px; border-radius: 50%; background: #1daf61; vertical-align: 1px; }
.session-card[data-authenticated="false"] .session-card__dot { background: #e2a32e; }
.session-card strong { color: #26945d; font-size: 11px; }
.session-card[data-authenticated="false"] strong { color: #a7761c; }
.session-card small { display: block; margin-top: 6px; padding-left: 17px; overflow: hidden; color: #9aabc1; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.sidebar__version { padding-left: 12px; color: #8fa0ba; font-size: 11px; }

.app-main { min-width: 0; min-height: 100vh; }
.app-header { display: flex; align-items: center; justify-content: space-between; gap: 18px; min-height: 93px; padding: 17px 33px 15px; border-bottom: 1px solid rgba(222, 232, 244, .74); }
.app-header__title { display: flex; align-items: center; gap: 13px; min-width: 0; }
.app-header__icon { display: grid; place-items: center; flex: 0 0 36px; width: 36px; height: 36px; color: var(--app-blue); }
.app-header__icon svg { width: 36px; height: 36px; }
.app-header__title h1 { margin: 0; color: var(--app-navy); font-size: 26px; line-height: 1.05; letter-spacing: -.04em; }
.app-header__title p { margin: 5px 0 0; overflow: hidden; color: #7286a7; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.app-header__actions { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
.connection-pill { display: inline-flex; align-items: center; gap: 8px; padding: 8px 13px; border-radius: 9px; background: #eaf9f0; color: #1b9959; font-size: 12px; font-weight: 700; }
.connection-pill > span { width: 11px; height: 11px; border-radius: 50%; background: #18a45a; box-shadow: 0 0 0 3px rgba(24, 164, 90, .1); }
.connection-pill[data-authenticated="false"] { background: #fff6e5; color: #a6741e; }
.connection-pill[data-authenticated="false"] > span { background: #dd9e2c; box-shadow: none; }
.header-refresh { display: inline-flex; align-items: center; gap: 8px; padding: 9px 16px; border: 1px solid var(--app-blue); border-radius: 8px; background: linear-gradient(135deg, #1d7af5, #1564e6); color: #fff; box-shadow: 0 6px 14px rgba(26, 104, 226, .2); font-size: 12px; font-weight: 700; }
.header-refresh svg { width: 17px; height: 17px; }
.header-icon-button { display: grid; place-items: center; width: 38px; height: 38px; border: 1px solid #e2e9f3; border-radius: 50%; background: rgba(255,255,255,.7); color: #5d7294; font-size: 18px; font-weight: 700; }
.header-icon-button--user svg { width: 19px; height: 19px; }
.host__surface { width: 100%; max-width: 1480px; margin: 0 auto; padding: 15px 20px 19px; }
.host__content, .history, .recovery { display: grid; gap: 1rem; }
.host__message { margin: 0 0 14px; padding: 10px 13px; border: 1px solid #b8e7cf; border-radius: 8px; background: #effbf4; color: #197b4b; font-size: 13px; }
.host__message--error { border-color: #f0c3c3; background: #fff3f3; color: #9e3333; }
.invite-card { display: grid; gap: 8px; margin: 0 0 14px; padding: 13px; border: 1px solid #c9dcf6; border-radius: 9px; background: #f7fbff; color: #253c67; font-size: 13px; }
.invite-card__row { display: flex; flex-wrap: wrap; gap: 8px; }
.invite-card__row input { flex: 1 1 320px; min-width: 0; padding: 9px; border: 1px solid #d5e1ef; border-radius: 6px; background: #fff; color: #344b70; }
.invite-card__row button { padding: 8px 12px; border: 1px solid #d5e1ef; border-radius: 6px; background: #fff; color: #23538f; font-size: 12px; font-weight: 700; }
.invite-card small { color: #7185a3; }
.host__selector { display: flex; gap: .75rem; align-items: center; padding: 11px 13px; border: 1px solid var(--app-line); border-radius: 8px; background: #fff; color: #5e7395; font-size: 13px; }
.host__selector select { min-width: 24rem; padding: .5rem; border: 1px solid var(--app-line); border-radius: 6px; color: #253c67; }
.recovery > *, .history > *, .detail__region, .detail__prose, .history__section, .recovery__versions, .recovery__repair, .recovery__ledger { border: 1px solid var(--app-line); border-radius: 10px; background: #fff; padding: 1rem; }
.recovery__header, .history__header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.recovery__item { border-top: 1px solid #e8edf4; padding: 1rem 0; }
.recovery__item-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .75rem; }
.recovery__versions-grid { display: grid; grid-template-columns: 9rem minmax(0, 1fr); gap: .45rem .75rem; }
.recovery__versions-grid dd { margin: 0; overflow-wrap: anywhere; }
.recovery__confirm { display: flex; gap: .55rem; align-items: flex-start; padding: .65rem 0; }
.recovery__hint, .history__hint { color: #667a99; }
.recovery__notice { padding: .75rem; background: #fff7e5; border-radius: .5rem; }
.history table { width: 100%; border-collapse: collapse; }
.history th, .history td { text-align: left; vertical-align: top; padding: .55rem; border-bottom: 1px solid #e2e8f1; }

@media (max-width: 900px) {
  .app-shell { grid-template-columns: 78px minmax(0, 1fr); }
  .sidebar { padding-inline: 10px; }
  .brand { justify-content: center; padding-inline: 0; }
  .brand > div, .sidebar__label, .session-card, .sidebar__version { display: none; }
  .sidebar__nav { margin-top: 28px; }
  .sidebar__item { justify-content: center; padding-inline: 8px; }
  .sidebar__item--workspace .sidebar__label::after { content: ""; }
  .sidebar__item--workspace .sidebar__label { display: none; }
  .app-header { padding-inline: 20px; }
}
@media (max-width: 700px) {
  .app-header { align-items: flex-start; flex-direction: column; padding-block: 15px; }
  .app-header__actions { width: 100%; }
  .connection-pill { margin-left: auto; }
  .host__surface { padding: 12px; }
  .recovery__versions-grid { grid-template-columns: 1fr; }
  .recovery__header, .history__header { align-items: flex-start; flex-direction: column; }
  .host__selector { align-items: flex-start; flex-direction: column; }
  .host__selector select { min-width: 0; width: 100%; }
  .history { overflow-x: auto; }
}
</style>
