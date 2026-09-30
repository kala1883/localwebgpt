<script setup lang="ts">
import { computed, ref, watch } from 'vue';

interface SessionSettings {
  readonly idle_timeout_ms: number;
  readonly absolute_timeout_ms: number | null;
}

interface ConfigurationDocument {
  readonly schema_version: number;
  readonly session: SessionSettings;
  readonly workspaces: readonly Record<string, unknown>[];
}

const props = defineProps<{
  readonly configuration: ConfigurationDocument | null;
  readonly loading: boolean;
  readonly saving: boolean;
}>();

const emit = defineEmits<{
  (event: 'save', settings: SessionSettings): void;
  (event: 'refresh'): void;
}>();

const idleMinutes = ref(0);
const absoluteMinutes = ref(120);
const absoluteMode = ref<'finite' | 'infinite'>('finite');
const localError = ref<string | null>(null);

watch(() => props.configuration, (configuration) => {
  if (configuration === null) return;
  idleMinutes.value = Math.floor(configuration.session.idle_timeout_ms / 60_000);
  if (configuration.session.absolute_timeout_ms === null) {
    absoluteMode.value = 'infinite';
  } else {
    absoluteMode.value = 'finite';
    absoluteMinutes.value = Math.floor(configuration.session.absolute_timeout_ms / 60_000);
  }
  localError.value = null;
}, { immediate: true });

const jsonPreview = computed(() => props.configuration === null
  ? ''
  : JSON.stringify(props.configuration, null, 2));

function save(): void {
  localError.value = null;
  if (!Number.isInteger(idleMinutes.value) || idleMinutes.value < 0 || idleMinutes.value > 43_200) {
    localError.value = '空闲期限请输入 0 到 43200 分钟；0 表示不因空闲过期。';
    return;
  }
  if (absoluteMode.value === 'finite' && (!Number.isInteger(absoluteMinutes.value) || absoluteMinutes.value < 1 || absoluteMinutes.value > 43_200)) {
    localError.value = '绝对期限请输入 1 到 43200 分钟。';
    return;
  }
  if (absoluteMode.value === 'finite' && idleMinutes.value > 0 && idleMinutes.value > absoluteMinutes.value) {
    localError.value = '空闲期限不能大于绝对期限。';
    return;
  }
  emit('save', {
    idle_timeout_ms: idleMinutes.value * 60_000,
    absolute_timeout_ms: absoluteMode.value === 'infinite' ? null : absoluteMinutes.value * 60_000,
  });
}
</script>

<template>
  <div class="configuration-page">
    <section class="configuration-card">
      <div class="configuration-card__heading">
        <div>
          <h2>控制台会话期限</h2>
          <p>保存到本机受保护的 JSON 配置。新的设置立即应用到当前及后续会话。</p>
        </div>
        <button type="button" class="configuration-refresh" :disabled="loading" @click="emit('refresh')">
          {{ loading ? '正在读取…' : '重新读取' }}
        </button>
      </div>

      <p v-if="localError" class="configuration-error" role="alert">{{ localError }}</p>

      <div class="configuration-fields">
        <label>
          空闲期限（分钟）
          <input v-model.number="idleMinutes" type="number" min="0" max="43200" step="1" :disabled="configuration === null || saving" />
          <small>填 0 表示关闭空闲过期；有限的绝对期限仍会生效。</small>
        </label>
        <label>
          绝对期限
          <select v-model="absoluteMode" :disabled="configuration === null || saving" aria-label="绝对期限范围">
            <option value="finite">有限期限</option>
            <option value="infinite">无限</option>
          </select>
          <input v-if="absoluteMode === 'finite'" v-model.number="absoluteMinutes" type="number" min="1" max="43200" step="1" aria-label="绝对期限（分钟）" :disabled="configuration === null || saving" />
          <small v-if="absoluteMode === 'infinite'">不按登录时间过期；空闲期限仍会生效。若空闲期限也关闭，会话仅在注销或本机服务重启时结束。</small>
          <small v-else>从登录开始计算，活动请求不会延长。</small>
        </label>
      </div>

      <div class="configuration-card__footer">
        <span v-if="configuration === null" class="configuration-muted">暂无有效配置读数。</span>
        <span v-else class="configuration-muted">配置保存后立即生效。</span>
        <button type="button" class="configuration-save" :disabled="configuration === null || loading || saving" @click="save">
          {{ saving ? '正在保存…' : '保存会话期限' }}
        </button>
      </div>
    </section>

    <section class="configuration-card">
      <div class="configuration-card__heading">
        <div>
          <h2>本机 JSON 配置</h2>
          <p>工作区和其授权工具也保存在这里；请通过“工作区”页执行安全校验后修改。</p>
        </div>
      </div>
      <pre v-if="configuration !== null" class="configuration-json"><code>{{ jsonPreview }}</code></pre>
      <p v-else class="configuration-muted">读取 JSON 配置失败，请检查本地服务状态。</p>
    </section>
  </div>
</template>

<style scoped>
.configuration-page { display: grid; gap: 16px; }
.configuration-card { display: grid; gap: 16px; padding: 20px; border: 1px solid #e3ebf5; border-radius: 12px; background: #fff; }
.configuration-card__heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.configuration-card h2 { margin: 0; color: #152961; font-size: 16px; }
.configuration-card p { margin: 7px 0 0; color: #7183a0; font-size: 12px; line-height: 1.6; }
.configuration-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.configuration-fields label { display: grid; gap: 8px; color: #30466b; font-size: 12px; font-weight: 700; }
.configuration-fields input, .configuration-fields select { width: 100%; padding: 10px 12px; border: 1px solid #d7e1ee; border-radius: 7px; color: #1a2d51; font: inherit; }
.configuration-fields small, .configuration-muted { color: #7a8ba5; font-size: 11px; font-weight: 400; }
.configuration-card__footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.configuration-save, .configuration-refresh { padding: 9px 14px; border: 1px solid #176cf0; border-radius: 7px; background: #176cf0; color: #fff; font-size: 12px; font-weight: 700; }
.configuration-refresh { border-color: #d6e1ef; background: #fff; color: #425a7f; }
.configuration-save:disabled, .configuration-refresh:disabled { opacity: .55; cursor: not-allowed; }
.configuration-json { max-height: 560px; overflow: auto; margin: 0; padding: 14px; border: 1px solid #e2eaf4; border-radius: 8px; background: #f7f9fc; color: #263c60; font: 11px/1.55 Consolas, monospace; white-space: pre; }
.configuration-error { margin: 0; padding: 10px 12px; border: 1px solid #f0c3c3; border-radius: 7px; background: #fff3f3; color: #9e3333; }
@media (max-width: 700px) {
  .configuration-card__heading, .configuration-card__footer { align-items: stretch; flex-direction: column; }
  .configuration-fields { grid-template-columns: 1fr; }
  .configuration-save, .configuration-refresh { width: 100%; }
}
</style>
