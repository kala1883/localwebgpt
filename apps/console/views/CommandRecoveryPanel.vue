<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ControlClient } from '../src/auth/client.ts';
interface Job {
  job_id: string; state: string; updated_at: string; created_at: string;
  connection_alias: string; workspace_name: string; slot_held: boolean;
  resolution?: { source: string; basis: string; resolved_at: string };
}
const props = defineProps<{ client: ControlClient; sessionActive: boolean }>();
const jobs = ref<Job[]>([]);
const selectedId = ref('');
const confirmationId = ref('');
const verified = ref(false);
const basis = ref<'process_tree_checked' | 'os_reboot_verified'>('process_tree_checked');
const busy = ref(false);
const message = ref('');
const error = ref('');
const truncated = ref(false);
const selected = computed(() => jobs.value.find((job) => job.job_id === selectedId.value));
const canRecover = computed(() => props.sessionActive && !busy.value && selected.value?.state === 'TERMINATION_UNKNOWN' &&
  verified.value && confirmationId.value === selectedId.value);
watch(selectedId, () => { verified.value = false; confirmationId.value = ''; message.value = ''; });
async function load(): Promise<void> {
  const value = await props.client.get('/api/commands/jobs') as { jobs?: Job[]; truncated?: boolean };
  if (!Array.isArray(value.jobs)) throw new Error('任务列表响应格式不正确。');
  jobs.value = value.jobs;
  truncated.value = value.truncated === true;
  if (!jobs.value.some((job) => job.job_id === selectedId.value)) selectedId.value = jobs.value[0]?.job_id ?? '';
}
async function refresh(): Promise<void> {
  if (!props.sessionActive || busy.value) return;
  busy.value = true; error.value = '';
  try { await load(); }
  catch { error.value = '读取失败。请确认已登录本地控制台，并已启动包含命令恢复功能的新版本。'; }
  finally { busy.value = false; }
}
watch(() => props.sessionActive, (active) => {
  if (active) void refresh();
  else { jobs.value = []; selectedId.value = ''; verified.value = false; }
}, { immediate: true });
async function recover(): Promise<void> {
  const job = selected.value;
  if (!canRecover.value || job === undefined) return;
  busy.value = true; error.value = ''; message.value = '';
  try {
    const body = {
      job_id: job.job_id, expected_updated_at: job.updated_at,
      confirmation_job_id: confirmationId.value,
      verified_all_processes_stopped: true, basis: basis.value,
    };
    const authorized = await props.client.authorizeMutation('/api/commands/recover', job.job_id, body);
    await props.client.call('/api/commands/recover', authorized);
    await load();
    const updated = jobs.value.find((item) => item.job_id === job.job_id);
    if (updated?.state !== 'RECOVERED_UNKNOWN' || updated.slot_held) throw new Error('恢复结果未确认。');
    message.value = '恢复记录已保存，名额已释放；原任务的业务结果仍未知，未重跑命令。';
  } catch {
    error.value = '恢复未得到确认：可能是状态冲突、会话失效、存储失败或网络中断。请刷新核对，不要重复提交或重跑原命令。';
  } finally { busy.value = false; verified.value = false; confirmationId.value = ''; }
}
</script>

<template>
  <section class="command-recovery" aria-label="命令任务恢复">
    <header><h2>命令任务恢复</h2><button type="button" :disabled="!sessionActive || busy" @click="refresh">刷新命令任务</button></header>
    <p>此入口使用本地控制台会话，不占命令执行名额，也不依赖 ChatGPT 是否发现任务管理工具。</p>
    <p class="warning">TERMINATION_UNKNOWN 不证明进程已经结束。仅重启 LocalWebGPT、等待超时、父进程消失，都不足以确认所有相关进程已停止。无法核验时请保留隔离。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="!sessionActive">请先建立本地控制台会话。</p>
    <p v-else-if="jobs.length === 0 && !error">没有查到待处理或已恢复的隔离任务。</p>
    <p v-if="truncated">当前仅显示前 100 条，优先显示尚未恢复的任务；不是完整历史。</p>
    <template v-if="jobs.length">
      <label>任务<select v-model="selectedId" :disabled="busy"><option v-for="job in jobs" :key="job.job_id" :value="job.job_id">{{ job.job_id }} · {{ job.state }}</option></select></label>
      <dl v-if="selected">
        <dt>工作区 / 连接</dt><dd>{{ selected.workspace_name }} / {{ selected.connection_alias }}</dd>
        <dt>创建时间</dt><dd>{{ selected.created_at }}</dd>
        <dt>占用名额</dt><dd>{{ selected.slot_held ? '仍占用' : '已释放，业务结果仍未知' }}</dd>
        <dt v-if="selected.resolution">恢复依据</dt><dd v-if="selected.resolution">{{ selected.resolution.source }} / {{ selected.resolution.basis }} / {{ selected.resolution.resolved_at }}</dd>
      </dl>
      <fieldset v-if="selected?.state === 'TERMINATION_UNKNOWN'" :disabled="busy || !sessionActive">
        <legend>逐任务核验后恢复</legend>
        <label>核验依据<select v-model="basis"><option value="process_tree_checked">已在本机核验该任务及相关子进程全部停止</option><option value="os_reboot_verified">已核验完整 Windows 重启发生在任务执行之后</option></select></label>
        <label><input v-model="verified" type="checkbox" />我已实际完成以上核验；知道这不是业务执行成功证明，也不会自动回滚或重跑。</label>
        <label>手动输入完整任务号<input v-model="confirmationId" autocomplete="off" spellcheck="false" /></label>
        <button type="button" :disabled="!canRecover" @click="recover">记录核验并释放该任务名额</button>
      </fieldset>
    </template>
  </section>
</template>

<style scoped>
.command-recovery { display:grid; gap:.75rem; padding:1rem; border:1px solid var(--app-line, #ddd); border-radius:10px; background:white; }
header { display:flex; align-items:center; justify-content:space-between; gap:1rem; }
h2,p { margin:0; }
label { display:flex; align-items:center; flex-wrap:wrap; gap:.6rem; }
select,input:not([type=checkbox]) { min-width:0; flex:1; padding:.5rem; }
fieldset { display:grid; gap:.8rem; border:1px solid var(--app-line, #ddd); }
button { padding:.55rem .8rem; }
dl { display:grid; grid-template-columns:auto 1fr; gap:.5rem 1rem; margin:0; }
dd { margin:0; overflow-wrap:anywhere; }
.warning { padding:.75rem; background:#fff7e5; }
[role=alert] { color:#9e3333; }
</style>
