<!-- Local-only control for the model-side MCP connection. -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { ControlClient } from '../src/auth/client.ts';
import { parseConnections, type ConnectionRow } from '../src/setup/index.ts';

const props = defineProps<{
  readonly client: ControlClient;
  readonly sessionActive: boolean;
}>();

const rows = ref<readonly ConnectionRow[]>([]);
const loading = ref(false);
const pendingId = ref('');
const enableConfirmed = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const modelConnections = computed(() => rows.value.filter((row) => row.principal_kind === 'model_surface'));

async function refresh(): Promise<void> {
  if (!props.sessionActive || props.client.session === null) {
    rows.value = [];
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    rows.value = parseConnections(await props.client.call('/api/connections/list'));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取本机连接状态失败。';
  } finally {
    loading.value = false;
  }
}

async function setEnabled(row: ConnectionRow, enabled: boolean): Promise<void> {
  if (pendingId.value !== '' || !props.sessionActive || props.client.session === null) return;
  if (enabled && !enableConfirmed.value) return;

  const endpoint = enabled ? '/api/connections/resume' : '/api/connections/pause';
  pendingId.value = row.connection_id;
  error.value = null;
  notice.value = null;
  try {
    const body = { connection_id: row.connection_id };
    const authorized = await props.client.authorizeMutation(endpoint, row.connection_id, body);
    await props.client.call(endpoint, authorized);
    enableConfirmed.value = false;
    notice.value = enabled
      ? '模型侧连接已由本机启用。工作区授权和 G0/能力门禁未改变。'
      : '模型侧连接已停用。';
    await refresh();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '修改本机连接状态失败。';
  } finally {
    pendingId.value = '';
  }
}

watch(() => props.sessionActive, (active) => {
  if (active) void refresh();
  else rows.value = [];
});

onMounted(() => void refresh());
</script>

<template>
  <section class="connection" data-testid="connection-view">
    <header class="connection__header">
      <div>
        <h2>ChatGPT MCP 连接</h2>
        <p>连接开关只控制模型侧凭据能否调用当前可用工具；不会登记工作区、授予目录权限或更改 G0/读写门禁。</p>
      </div>
      <button type="button" data-testid="refresh-connections" :disabled="loading || !sessionActive" @click="refresh">
        {{ loading ? '读取中…' : '重新读取' }}
      </button>
    </header>

    <p v-if="error" class="connection__message connection__message--error" role="alert">{{ error }}</p>
    <p v-if="notice" class="connection__message" role="status">{{ notice }}</p>

    <p v-if="!loading && modelConnections.length === 0" data-testid="no-model-connection">
      本机尚未登记模型侧连接。请先重启 LocalWebGPT daemon，再重新读取。
    </p>

    <article v-for="row in modelConnections" :key="row.connection_id" class="connection__card" :data-enabled="row.enabled">
      <div class="connection__identity">
        <strong>{{ row.alias }}</strong>
        <code>{{ row.connection_id }}</code>
        <span :class="row.enabled ? 'connection__state connection__state--enabled' : 'connection__state'">
          {{ row.enabled ? '已启用' : '已停用' }}
        </span>
      </div>

      <template v-if="!row.enabled">
        <label class="connection__confirm" data-testid="connection-confirm" :for="`enable-${row.connection_id}`">
          <input :id="`enable-${row.connection_id}`" v-model="enableConfirmed" type="checkbox" :disabled="pendingId !== '' || !sessionActive">
          <span>我确认只把这条连接提供给我信任的 ChatGPT 工作区。此操作不授权任何本地目录。</span>
        </label>
        <button
          type="button"
          class="connection__primary"
          :data-testid="`enable-${row.connection_id}`"
          :disabled="pendingId !== '' || !sessionActive || !enableConfirmed"
          @click="setEnabled(row, true)"
        >
          {{ pendingId === row.connection_id ? '正在启用…' : '在本机启用 ChatGPT 连接' }}
        </button>
      </template>
      <button
        v-else
        type="button"
        :data-testid="`pause-${row.connection_id}`"
        :disabled="pendingId !== '' || !sessionActive"
        @click="setEnabled(row, false)"
      >
        {{ pendingId === row.connection_id ? '正在停用…' : '停用 ChatGPT 连接' }}
      </button>
    </article>

    <p class="connection__safety" data-testid="connection-safety-note">
      新安装默认停用是有意的。当前项目门禁仍关闭、没有工作区授权；启用后最多用于检查 Tunnel 与连接级工具发现，不代表文件读取或写入已获准。
    </p>
  </section>
</template>

<style scoped>
.connection { display: grid; gap: 1rem; }
.connection__header, .connection__identity { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.connection__header h2 { margin: 0; }
.connection__header p, .connection__safety { color: #53647b; }
.connection__header p { margin: .4rem 0 0; }
.connection__card { display: grid; gap: .8rem; border: 1px solid #d3dae4; border-radius: .65rem; background: white; padding: 1rem; }
.connection__identity { justify-content: flex-start; flex-wrap: wrap; }
.connection__identity code { overflow-wrap: anywhere; color: #53647b; }
.connection__state { border-radius: 999px; padding: .25rem .6rem; background: #fff0d9; color: #704600; }
.connection__state--enabled { background: #e4f4eb; color: #145b35; }
.connection__confirm { display: flex; align-items: flex-start; gap: .55rem; }
.connection__confirm input { margin-top: .2rem; }
.connection__primary { justify-self: start; border-color: #245da8; background: #e8f1ff; color: #17477f; }
.connection__message { margin: 0; padding: .8rem 1rem; border-radius: .5rem; background: #e4f4eb; }
.connection__message--error { background: #ffebeb; color: #7c2020; }
.connection__safety { margin: 0; }
@media (max-width: 700px) {
  .connection__header { align-items: flex-start; flex-direction: column; }
  .connection__identity { align-items: flex-start; flex-direction: column; }
}
</style>
