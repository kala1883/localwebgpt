<!--
  LWB-037 恢复与冲突页面。

  这个组件没有「完成恢复」的本地状态。所有按钮都只发出操作者意图，
  由父层调用受保护的控制面；父层重新取回记录后，页面才会显示数据库
  的新状态。这样「把红色提示改成绿色」永远不能清除恢复任务。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  recoveryControlsOf,
  fetchRecoverySnapshot,
  recoveryStateLabel,
  suggestedRecoverySnapshotName,
  versionText,
  type RecoveryExportClient,
  type RecoveryRecord,
  type RecoverySession,
} from '../src/recovery/index.ts';

const props = withDefaults(
  defineProps<{
    readonly record: RecoveryRecord | null;
    readonly session?: RecoverySession | null;
    readonly busy?: boolean;
    /** 已鉴权的本地控制面客户端。提供后，快照按钮会直接完成授权读取与本机保存。 */
    readonly exportClient?: RecoveryExportClient | null;
  }>(),
  { session: null, busy: false, exportClient: null },
);

const emit = defineEmits<{
  (event: 'keep-current', payload: { readonly operation_id: string; readonly item_id: string }): void;
  (event: 'export-snapshot', payload: {
    readonly operation_id: string;
    readonly item_id: string;
    readonly snapshot: 'original' | 'proposed';
    readonly confirmed: true;
  }): void;
  (event: 'export-complete', payload: {
    readonly operation_id: string;
    readonly item_id: string;
    readonly snapshot: 'original' | 'proposed';
    readonly file_name: string;
    readonly sha256: string;
    readonly size: number;
  }): void;
  (event: 're-propose', payload: { readonly operation_id: string; readonly item_id: string }): void;
  (event: 'authorize-recovery', payload: { readonly operation_id: string; readonly plan_digest: string; readonly confirmed: true }): void;
  (event: 'repair-recovery', payload: {
    readonly operation_id: string;
    readonly authorization_id: string;
    readonly plan_digest: string;
    readonly confirmed: true;
  }): void;
  (event: 'refresh'): void;
}>();

const confirmed = ref(false);
const exportConfirmed = ref(false);
const exporting = ref(false);
const exportMessage = ref<string | null>(null);

watch(
  () => props.record?.operation_id ?? null,
  () => {
    confirmed.value = false;
    exportConfirmed.value = false;
  },
);

const controls = computed(() =>
  recoveryControlsOf({ record: props.record, session: props.session, confirmed: confirmed.value }),
);

const planDigest = computed(() => {
  const record = props.record;
  if (record === null) return null;
  if (record.plan_digest !== null) return record.plan_digest;
  return record.plan?.kind === 'ok' ? record.plan.digest : null;
});

function keepCurrent(itemId: string): void {
  if (!props.record || !controls.value.can_keep_current || props.busy) return;
  emit('keep-current', { operation_id: props.record.operation_id, item_id: itemId });
}

interface SaveWritable {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

interface SaveFileHandle {
  readonly name: string;
  getFile(): Promise<{ readonly size: number }>;
  createWritable(options: { readonly keepExistingData: false; readonly mode: 'exclusive' }): Promise<SaveWritable>;
}

interface SaveDirectoryHandle {
  readonly name: string;
  getFileHandle(name: string, options?: { readonly create?: boolean }): Promise<SaveFileHandle>;
}

interface DirectoryPickerOptions {
  readonly id: string;
  readonly mode: 'readwrite';
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options: DirectoryPickerOptions) => Promise<SaveDirectoryHandle>;
};

function errorName(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('name' in error)) return null;
  return typeof error.name === 'string' ? error.name : null;
}

async function chooseDestinationDirectory(): Promise<SaveDirectoryHandle> {
  const pickerWindow = window as DirectoryPickerWindow;
  if (typeof pickerWindow.showDirectoryPicker !== 'function') {
    throw new Error('当前浏览器不支持安全的文件夹选择器。请使用最新版 Chrome 或 Edge。');
  }
  // 选择目录不会打开或截断其中的任何文件；权限和文件句柄留在本机浏览器。
  return pickerWindow.showDirectoryPicker({ id: 'lwb-recovery-export', mode: 'readwrite' });
}

function uniqueSnapshotFileName(suggestedName: string): string {
  const suffix = globalThis.crypto.randomUUID();
  const extension = '.snapshot';
  const stem = suggestedName.endsWith(extension)
    ? suggestedName.slice(0, -extension.length)
    : suggestedName;
  return `${stem}-${suffix}${extension}`;
}

async function createNewDestination(
  directory: SaveDirectoryHandle,
  suggestedName: string,
): Promise<SaveFileHandle> {
  // A new unpredictable name avoids presenting an existing file to a save picker.
  // Check for collisions without opening the existing file, then create only after
  // the protected snapshot bytes have been fetched and verified.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const fileName = uniqueSnapshotFileName(suggestedName);
    try {
      await directory.getFileHandle(fileName);
      continue;
    } catch (error) {
      if (errorName(error) !== 'NotFoundError') throw error;
    }

    const handle = await directory.getFileHandle(fileName, { create: true });
    if ((await handle.getFile()).size === 0) return handle;
  }
  throw new Error('无法在所选目录中保留一个新的快照文件名；没有写入快照。');
}

async function writeSnapshotToDestination(
  handle: SaveFileHandle,
  file: Awaited<ReturnType<typeof fetchRecoverySnapshot>>,
): Promise<void> {
  if ((await handle.getFile()).size !== 0) {
    throw new Error('新快照文件在写入前已发生变化；为保护现有内容，本次导出已取消。');
  }
  const writable = await handle.createWritable({ keepExistingData: false, mode: 'exclusive' });
  try {
    // The selected directory contains an unpredictable, newly created filename;
    // also fail closed if another writer changed it before our first write.
    if ((await handle.getFile()).size !== 0) {
      throw new Error('新快照文件在写入前已发生变化；为保护现有内容，本次导出已取消。');
    }
    await writable.write(file.bytes);
    await writable.close();
  } catch (error) {
    await writable.abort?.().catch(() => undefined);
    throw error;
  }
}

async function exportSnapshot(itemId: string, snapshot: 'original' | 'proposed'): Promise<void> {
  if (!props.record || !controls.value.can_export || !exportConfirmed.value || props.busy) return;
  const operationId = props.record.operation_id;
  if (props.exportClient === null) {
    // 兼容尚未装配控制台宿主的调用方；宿主收到该意图后可连接同一导出器。
    emit('export-snapshot', { operation_id: operationId, item_id: itemId, snapshot, confirmed: true });
    exportConfirmed.value = false;
    return;
  }
  exporting.value = true;
  exportMessage.value = '请选择一个保存文件夹；导出会生成带随机后缀的新文件名，不会让文件选择器打开已有文件。';
  try {
    const selectedItem = props.record.items.find((item) => item.item_id === itemId);
    if (selectedItem === undefined) throw new Error('恢复记录里找不到所选文件。');
    // The directory picker must be opened directly from the click, before API awaits.
    const directory = await chooseDestinationDirectory();
    const file = await fetchRecoverySnapshot({
      client: props.exportClient,
      operation_id: operationId,
      item_id: itemId,
      snapshot,
    });
    const handle = await createNewDestination(
      directory,
      suggestedRecoverySnapshotName(selectedItem.path, snapshot),
    );
    await writeSnapshotToDestination(handle, file);
    exportMessage.value = `已保存到 ${directory.name}/${handle.name}（${file.size} 字节；SHA-256 ${file.sha256}）。`;
    emit('export-complete', {
      operation_id: operationId,
      item_id: itemId,
      snapshot,
      file_name: handle.name,
      sha256: file.sha256,
      size: file.size,
    });
  } catch (error) {
    exportMessage.value = errorName(error) === 'AbortError'
      ? '已取消导出，没有读取或写出快照。'
      : error instanceof Error ? error.message : '导出失败；受保护快照未修改，若已创建输出文件，可能是空文件。';
  } finally {
    exporting.value = false;
    // 每次导出都重新确认，防止一次确认无意授权后续多个文件。
    exportConfirmed.value = false;
  }
}

function rePropose(itemId: string): void {
  if (!props.record || !controls.value.can_repropose || props.busy) return;
  emit('re-propose', { operation_id: props.record.operation_id, item_id: itemId });
}

function authorize(): void {
  if (!props.record || !controls.value.can_authorize || planDigest.value === null || props.busy) return;
  emit('authorize-recovery', {
    operation_id: props.record.operation_id,
    plan_digest: planDigest.value,
    confirmed: true,
  });
}

function repair(): void {
  if (
    !props.record ||
    !controls.value.can_repair ||
    controls.value.active_authorization_id === null ||
    planDigest.value === null ||
    props.busy
  ) return;
  emit('repair-recovery', {
    operation_id: props.record.operation_id,
    authorization_id: controls.value.active_authorization_id,
    plan_digest: planDigest.value,
    confirmed: true,
  });
}
</script>

<template>
  <section class="recovery" data-testid="recovery-view" aria-label="冲突与恢复">
    <header class="recovery__header">
      <div>
        <h1>冲突与恢复</h1>
        <p v-if="record === null" data-testid="recovery-empty">尚未读到恢复记录。</p>
        <p v-else data-testid="recovery-summary">
          操作 <code>{{ record.operation_id }}</code> · {{ recoveryStateLabel(record.operation_state) }} ·
          数据库读取于 {{ record.observed_at }}
        </p>
      </div>
      <button type="button" data-testid="refresh-recovery" :disabled="busy || exporting" @click="emit('refresh')">
        重新读取状态
      </button>
    </header>

    <template v-if="record !== null">
      <p class="recovery__notice" :data-state="record.operation_state" data-testid="recovery-notice">
        {{ controls.reason }}
      </p>

      <section class="recovery__versions" data-testid="versions" aria-label="原版本、提议版本和当前版本">
        <h2>三方版本对照</h2>
        <p class="recovery__hint">
          当前版本来自服务端最近一次受控观测；“第三方后续修改”不会被页面自动覆盖。
        </p>
        <div v-for="item in record.items" :key="item.item_id" class="recovery__item" data-testid="recovery-item">
          <h3><code>{{ item.path }}</code><span>{{ item.op }}</span></h3>
          <dl class="recovery__versions-grid">
            <dt>原版本</dt>
            <dd data-testid="original-version">{{ versionText(item.original_sha256) }}</dd>
            <dt>提议版本</dt>
            <dd data-testid="proposed-version">{{ versionText(item.proposed_sha256) }}</dd>
            <dt>当前版本</dt>
            <dd :data-current-state="item.current_state" data-testid="current-version">
              <strong>{{ recoveryStateLabel(item.current_state) }}</strong>
              <code>{{ versionText(item.current_sha256) }}</code>
              <span v-if="item.reason">（{{ item.reason }}）</span>
              <span v-if="item.error_code">错误码：{{ item.error_code }}</span>
            </dd>
          </dl>
          <div class="recovery__item-actions" data-testid="item-actions">
            <button type="button" :disabled="busy || exporting || !controls.can_keep_current" @click="keepCurrent(item.item_id)">
              保留当前文件
            </button>
            <button
              type="button"
              data-testid="export-original"
              :disabled="busy || exporting || !controls.can_export || !exportConfirmed || item.original_sha256 === null"
              @click="exportSnapshot(item.item_id, 'original')"
            >
              导出原版本快照
            </button>
            <button
              type="button"
              data-testid="export-proposed"
              :disabled="busy || exporting || !controls.can_export || !exportConfirmed"
              @click="exportSnapshot(item.item_id, 'proposed')"
            >
              导出提议版本快照
            </button>
            <button type="button" :disabled="busy || exporting || !controls.can_repropose" @click="rePropose(item.item_id)">
              重新提议
            </button>
          </div>
        </div>
        <label class="recovery__confirm" data-testid="export-confirm">
          <input v-model="exportConfirmed" type="checkbox" />
          我确认将受保护快照写入我选择的文件夹；每次都会生成带随机后缀的新文件名
        </label>
        <p v-if="exportMessage" role="status" aria-live="polite" data-testid="export-status">{{ exportMessage }}</p>
      </section>

      <section class="recovery__repair" data-testid="repair-panel" aria-label="本地批准恢复">
        <h2>本地批准恢复</h2>
        <p v-if="record.plan?.kind === 'refused'" data-testid="repair-refused">
          {{ record.plan.detail }}
        </p>
        <p v-else-if="record.plan === null" data-testid="repair-unavailable">
          服务端没有返回可核对的恢复计划，恢复入口保持关闭。
        </p>
        <template v-else>
          <p data-testid="repair-warning">
            这一步只允许受保护执行器把可证明属于本次执行的目标条目写回原版本；不会强制覆盖第三方内容。
          </p>
          <label class="recovery__confirm" data-testid="repair-confirm">
            <input v-model="confirmed" type="checkbox" />
            我已核对三方版本，并明确批准本地恢复写入
          </label>
          <button
            v-if="controls.active_authorization_id === null"
            type="button"
            data-testid="authorize-recovery"
            :disabled="busy || !controls.can_authorize"
            @click="authorize"
          >
            签发一次性恢复授权
          </button>
          <button
            v-else
            type="button"
            data-testid="repair-recovery"
            :disabled="busy || !controls.can_repair"
            @click="repair"
          >
            执行已批准的恢复
          </button>
          <p class="recovery__hint">恢复授权绑定服务端重算的计划摘要：{{ planDigest ?? '未知' }}</p>
        </template>
      </section>

      <section class="recovery__ledger" data-testid="recovery-ledger" aria-label="恢复授权与审计记录">
        <h2>恢复账本</h2>
        <p>恢复记录和审计由数据库决定；本页面不会因为按钮点击而自行清除它们。</p>
        <ul>
          <li v-for="entry in record.authorizations" :key="entry.id" data-testid="authorization-row">
            {{ entry.state }} · {{ entry.decision }} · {{ entry.created_at }}
          </li>
          <li v-if="record.authorizations.length === 0">尚无恢复授权。</li>
        </ul>
        <ol>
          <li v-for="entry in record.journal" :key="entry.seq" data-testid="journal-row">
            #{{ entry.seq }} {{ entry.stage }}<span v-if="entry.error_code"> · {{ entry.error_code }}</span>
          </li>
        </ol>
      </section>
    </template>
  </section>
</template>
