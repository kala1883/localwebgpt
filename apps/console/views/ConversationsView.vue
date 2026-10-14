<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref,watch} from 'vue';
import type {ControlClient} from '../src/auth/client.ts';
import {ControlApiFailure} from '../src/auth/client.ts';
import {ConversationClient,attributionLabel,stateLabel,eventLabel,type RetentionPreview} from '../src/conversations/client.ts';
import type {ArchiveStatus,SessionSummary,SessionItemsInput,ClearPreview} from '../../../packages/contracts/src/conversation-management.ts';

const props=withDefaults(defineProps<{client:ControlClient;sessionActive:boolean;refreshKey?:number}>(),{refreshKey:0});
const emit=defineEmits<{(event:'session-expired',error:unknown):void;(event:'open-recovery'):void}>();
const api=new ConversationClient(props.client);
const status=ref<ArchiveStatus|null>(null),sessions=ref<SessionSummary[]>([]),selected=ref<SessionSummary|null>(null);
const listCursor=ref<string|null>(null),itemCursor=ref<string|null>(null),items=ref<Record<string,unknown>[]>([]);
const loading=ref(false),detailLoading=ref(false),mutating=ref(false),error=ref(''),notice=ref(''),autoRefresh=ref(false);
const query=ref(''),tag=ref(''),connection=ref(''),workspace=ref(''),filter=ref<'all'|'running'|'unknown'|'closed'>('all');
const archiveFilter=ref<'active'|'archived'|'all'>('active'),onlyPinned=ref(false),attribution=ref<''|SessionSummary['attribution']>('');
const tab=ref<SessionItemsInput['kind']>('events'),itemQuery=ref(''),callFilter=ref(''),jobFilter=ref('');
const title=ref(''),tags=ref(''),notes=ref(''),pinned=ref(false),archived=ref(false),formRevision=ref(0);
const showEdit=ref(false),showSettings=ref(false),retentionDays=ref(30),automaticRetention=ref(false);
const clearPreview=ref<ClearPreview|null>(null),confirmation=ref(''),clearConfirmed=ref(false);
const retentionPreview=ref<RetentionPreview|null>(null),retentionConfirmed=ref(false);
const exporting=ref(false),exportCount=ref(0);let exportCancelled=false;
let epoch=0,listSequence=0,detailSequence=0,timer:ReturnType<typeof setInterval>|undefined,disposed=false;
const active=()=>!disposed&&props.sessionActive&&props.client.session!==null;
const alive=(e:number)=>active()&&e===epoch;
const tagValues=()=>tags.value.split(/[,，]/).map(v=>v.trim()).filter(Boolean);
const dirty=computed(()=>selected.value!==null&&(title.value!==selected.value.local_title||notes.value!==selected.value.notes||pinned.value!==selected.value.pinned||archived.value!==selected.value.archived||JSON.stringify(tagValues())!==JSON.stringify(selected.value.tags)));
const byteLabel=(n:number)=>n>=1048576?(n/1048576).toFixed(1)+' MiB':n>=1024?(n/1024).toFixed(1)+' KiB':n+' B';
const dateLabel=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString():String(v??'—');
const pretty=(v:unknown)=>JSON.stringify(v,null,2)??'null';
const val=(r:Record<string,unknown>,key:string)=>String(r[key]??'');
const workspaceLabel=(id:unknown)=>status.value?.workspaces.find(w=>w.id===id)?.label??String(id??'—');
const connectionLabel=(id:string)=>status.value?.connections.find(c=>c.id===id)?.label??id;
function resetSensitive():void {
  ++epoch;++listSequence;++detailSequence;exportCancelled=true;
  sessions.value=[];selected.value=null;status.value=null;items.value=[];listCursor.value=null;itemCursor.value=null;
  title.value='';tags.value='';notes.value='';clearPreview.value=null;retentionPreview.value=null;
  confirmation.value='';clearConfirmed.value=false;retentionConfirmed.value=false;showEdit.value=false;
  loading.value=false;detailLoading.value=false;mutating.value=false;exporting.value=false;notice.value='';error.value='';
}
function failure(cause:unknown):void {
  if(cause instanceof ControlApiFailure&&cause.detail.session_expired){resetSensitive();emit('session-expired',cause);error.value='本地会话已过期，已清除页面中的归档内容。';return;}
  error.value=cause instanceof Error?cause.message:'会话管理请求失败。';
}
function fillForm(s:SessionSummary):void {
  title.value=s.local_title;tags.value=s.tags.join(', ');notes.value=s.notes;pinned.value=s.pinned;archived.value=s.archived;formRevision.value=s.revision;
}
async function loadStatus():Promise<void>{
  if(!active())return;const e=epoch;const result=await api.status();
  if(!alive(e))return;status.value=result;retentionDays.value=result.settings.retention_days;automaticRetention.value=result.settings.automatic_retention;
}
async function loadList(more=false):Promise<void> {
  if(!active())return;const e=epoch,s=++listSequence;loading.value=true;error.value='';
  try {
    // Missing-attribution groups are intentionally not merged into a fabricated conversation.
    const result=await api.list({query:query.value,tag:tag.value,connection_id:connection.value,workspace_id:workspace.value,
      state:filter.value,archived:archiveFilter.value,...(onlyPinned.value?{pinned:true}:{}),
      ...(attribution.value?{attribution:attribution.value}:{}),max_items:30,...(more&&listCursor.value?{after:listCursor.value}:{})});
    if(!alive(e)||s!==listSequence)return;
    sessions.value=more?[...sessions.value,...result.items]:result.items;listCursor.value=result.next_cursor;
  }catch(cause){if(alive(e)&&s===listSequence)failure(cause);}finally{if(alive(e)&&s===listSequence)loading.value=false;}
}
async function loadItems(more=false):Promise<void>{
  const id=selected.value?.id;if(!id||!active())return;const e=epoch,s=++detailSequence;detailLoading.value=true;
  try {
    const result=await api.items({conversation_id:id,kind:tab.value,query:itemQuery.value,max_items:30,
      ...(callFilter.value?{call_id:callFilter.value}:{}),...(jobFilter.value?{job_id:jobFilter.value}:{}),
      ...(more&&itemCursor.value?{after:itemCursor.value}:{})});
    if(!alive(e)||s!==detailSequence||selected.value?.id!==id)return;
    items.value=more?[...items.value,...result.items]:result.items;itemCursor.value=result.next_cursor;
  }catch(cause){if(alive(e)&&s===detailSequence)failure(cause);}finally{if(alive(e)&&s===detailSequence)detailLoading.value=false;}
}
async function choose(id:string):Promise<void>{
  if(mutating.value||!active())return;
  if(dirty.value&&!window.confirm('当前会话有未保存的修改，放弃修改并切换吗？'))return;
  const e=epoch,s=++detailSequence;detailLoading.value=true;clearPreview.value=null;clearConfirmed.value=false;confirmation.value='';showEdit.value=false;error.value='';
  try {
    const result=await api.get(id);if(!alive(e)||s!==detailSequence)return;
    selected.value=result;fillForm(result);tab.value='events';callFilter.value='';jobFilter.value='';itemQuery.value='';items.value=[];itemCursor.value=null;
    await loadItems();
  }catch(cause){if(alive(e)&&s===detailSequence)failure(cause);}finally{if(alive(e)&&s===detailSequence)detailLoading.value=false;}
}
async function changeTab(next:SessionItemsInput['kind']):Promise<void>{tab.value=next;callFilter.value='';jobFilter.value='';itemQuery.value='';items.value=[];itemCursor.value=null;await loadItems();}
async function inspectEvents(kind:'call'|'job',id:string):Promise<void>{tab.value='events';callFilter.value=kind==='call'?id:'';jobFilter.value=kind==='job'?id:'';itemQuery.value='';items.value=[];itemCursor.value=null;await loadItems();}
async function refresh():Promise<void>{
  if(!active()||mutating.value||exporting.value)return;const e=epoch;
  try{await loadStatus();if(!alive(e))return;await loadList();
    const id=selected.value?.id;if(id&&!dirty.value){const s=await api.get(id);if(!alive(e)||selected.value?.id!==id)return;selected.value=s;fillForm(s);await loadItems();}
  }catch(cause){if(alive(e))failure(cause);}
}
async function save():Promise<void>{
  const s=selected.value;if(!s||!active()||mutating.value)return;const e=epoch;mutating.value=true;error.value='';notice.value='';
  try{const updated=await api.update({conversation_id:s.id,expected_revision:formRevision.value,local_title:title.value,tags:tagValues(),notes:notes.value,pinned:pinned.value,archived:archived.value});
    if(!alive(e))return;selected.value=updated;fillForm(updated);clearPreview.value=null;showEdit.value=false;notice.value='会话信息已保存。名称是本地标签，不修改 ChatGPT 网页标题。';await loadList();
  }catch(cause){if(alive(e))failure(cause);}finally{if(alive(e))mutating.value=false;}
}
async function saveSettings():Promise<void>{
  if(!active()||!status.value||mutating.value)return;const e=epoch;mutating.value=true;error.value='';
  try{const updated=await api.settings({expected_revision:status.value.settings.revision,retention_days:retentionDays.value,automatic_retention:automaticRetention.value});
    if(!alive(e))return;status.value={...status.value!,settings:updated};retentionPreview.value=null;notice.value='保留设置已保存；自动清理只处理已结束且未置顶会话的内容。';
  }catch(cause){if(alive(e))failure(cause);}finally{if(alive(e))mutating.value=false;}
}
async function previewClear():Promise<void>{
  if(!active()||!selected.value)return;const e=epoch,id=selected.value.id;
  try{const p=await api.clearPreview(id);if(alive(e)&&selected.value?.id===id){clearPreview.value=p;confirmation.value='';clearConfirmed.value=false;}}
  catch(cause){if(alive(e))failure(cause);}
}
async function clearContents():Promise<void>{
  const p=clearPreview.value;if(!p||!p.allowed||!clearConfirmed.value||confirmation.value!==p.conversation_id||!active()||mutating.value)return;
  const e=epoch;mutating.value=true;error.value='';
  try{const r=await api.clear(p.conversation_id,p.digest,confirmation.value);if(!alive(e))return;
    clearPreview.value=null;notice.value=`已清理 ${r.events} 条内容事件（${byteLabel(r.bytes)}）。会话身份、调用摘要、命令任务和幂等记录均保留。`;
    const s=await api.get(p.conversation_id);if(alive(e)){selected.value=s;fillForm(s);await loadItems();await loadList();await loadStatus();}
  }catch(cause){if(alive(e))failure(cause);}finally{if(alive(e))mutating.value=false;}
}
async function previewRetention():Promise<void>{const e=epoch;if(!active())return;try{const p=await api.retentionPreview();if(alive(e)){retentionPreview.value=p;retentionConfirmed.value=false;}}catch(cause){if(alive(e))failure(cause);}}
async function applyRetention():Promise<void>{
  const p=retentionPreview.value;if(!p||!retentionConfirmed.value||!active()||mutating.value)return;const e=epoch;mutating.value=true;
  try{const r=await api.prune(p.digest);if(!alive(e))return;retentionPreview.value=null;notice.value=`已清理 ${r.sessions} 个会话的内容，共 ${r.events} 条事件。${r.has_more?'仍有符合条件的会话，请再次预览。':''}`;
    await loadStatus();await loadList();if(selected.value&&!dirty.value){const v=await api.get(selected.value.id);if(alive(e)){selected.value=v;fillForm(v);await loadItems();}}
  }catch(cause){if(alive(e))failure(cause);}finally{if(alive(e))mutating.value=false;}
}
async function cancelJob(id:string):Promise<void>{
  const s=selected.value;if(!s||!active()||mutating.value||!window.confirm(`请求停止任务 ${id}？已经发生的文件修改不会自动回滚。`))return;
  const e=epoch;mutating.value=true;
  try{const result=await api.cancelJob(s.id,id);if(alive(e)){notice.value=`取消请求已处理，当前状态：${stateLabel(result.job.state)}。请刷新确认，不代表已经停止。`;await loadItems();}}
  catch(cause){if(alive(e))failure(cause);}finally{if(alive(e))mutating.value=false;}
}
async function exportSession():Promise<void>{
  const id=selected.value?.id;if(!id||!active()||exporting.value)return;const e=epoch;exporting.value=true;exportCancelled=false;exportCount.value=0;error.value='';
  try {
    const parts:string[]=[];let page=await api.exportStart(id),bytes=0;
    while(true){if(!alive(e)||exportCancelled)return;
      for(const line of page.lines){const text=line+'\n';bytes+=new TextEncoder().encode(text).length;if(bytes>32*1024*1024)throw new Error('归档超过浏览器 32 MiB 导出上限，请使用本地命令行导出；没有生成不完整文件。');parts.push(text);}
      exportCount.value=parts.length;if(!page.next_cursor)break;page=await api.exportPage(page.next_cursor);
    }
    if(!alive(e)||exportCancelled)return;
    const url=URL.createObjectURL(new Blob(parts,{type:'application/x-ndjson;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download=page.filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    notice.value=`已生成 ${parts.length} 行 JSONL。导出的是本地归档证据，不包含完整聊天记录或未采集的原始输出。`;
  }catch(cause){if(alive(e))failure(cause);}finally{if(alive(e))exporting.value=false;}
}
watch(()=>[props.sessionActive,props.client.session?.session_id],()=>{resetSensitive();if(active())void refresh();});
watch(()=>props.refreshKey,()=>{void refresh();});
onMounted(()=>{void refresh();timer=setInterval(()=>{if(autoRefresh.value&&document.visibilityState==='visible'&&!dirty.value&&!loading.value&&!detailLoading.value)void refresh();},10_000);});
onUnmounted(()=>{disposed=true;resetSensitive();if(timer)clearInterval(timer);});
</script>

<template>
  <section class="conversations" data-testid="conversations-view" aria-label="会话执行档案">
    <div class="cv-toolbar">
      <div><h2>会话执行档案</h2><p>从请求到执行结果，按会话查看本地证据。</p></div>
      <div class="cv-actions"><label><input v-model="autoRefresh" type="checkbox" />每 10 秒刷新</label><button :disabled="!sessionActive || loading" @click="refresh">刷新</button><button @click="showSettings=!showSettings">保留与容量</button></div>
    </div>
    <p v-if="!sessionActive" class="cv-notice" role="status">请先建立本地控制台会话，档案内容不会在未认证时显示。</p>
    <p v-if="error" class="cv-error" role="alert">{{ error }}</p><p v-if="notice" class="cv-notice" role="status">{{ notice }}</p>
    <template v-if="sessionActive">
      <div v-if="status" class="cv-metrics">
        <div><span>会话档案</span><strong>{{ status.statistics.conversations }}</strong></div><div><span>工具调用</span><strong>{{ status.statistics.calls }}</strong></div>
        <div><span>命令任务</span><strong>{{ status.statistics.jobs }}</strong></div><div><span>归档事件</span><strong>{{ status.statistics.events }}</strong></div><div><span>内容容量</span><strong>{{ byteLabel(status.statistics.bytes) }}</strong></div>
      </div>
      <p v-if="status?.archive_health.runtime_fault" class="cv-error" role="alert">归档曾发生写入缺失。已有记录不能当作完整历史；请核查容量与本地日志。</p>
      <details class="cv-boundary"><summary>归档范围与会话识别</summary><p>只记录实际到达本地的工具请求、受限且脱敏后的命令和结果，以及任务状态变化。不会自动取得网页标题和聊天全文。未取得会话标识的请求保持未归属，不合并成虚构的聊天。处理器已返回不代表 ChatGPT 已确认收到；进程退出码也不代替业务校验。</p></details>
      <section v-if="showSettings && status" class="cv-settings" aria-label="归档保留设置">
        <h3>保留与容量</h3><p>清理只移除内容事件，保留会话身份、调用摘要、任务关联和独立的执行账本。置顶会话和未结束任务不会被清理。</p>
        <div class="cv-actions"><label>保留天数 <input v-model.number="retentionDays" type="number" min="1" max="3650" /></label><label><input v-model="automaticRetention" type="checkbox" />启用自动清理过期内容</label><button :disabled="mutating" @click="saveSettings">保存设置</button><button :disabled="mutating" @click="previewRetention">预览过期内容</button></div>
        <p>内容容量上限：{{ byteLabel(Number((status.archive_health.limits as Record<string, unknown>)?.event_bytes ?? 0)) }}；记录数量另有限额，内容清理不会伪造空闲命令名额。</p>
        <div v-if="retentionPreview" class="cv-confirm"><p>截止 {{ dateLabel(retentionPreview.cutoff) }}，本批可清理 {{ retentionPreview.items.length }} 个会话。{{ retentionPreview.has_more?'还有下一批。':'' }}</p>
          <label><input v-model="retentionConfirmed" type="checkbox" />我确认清理这些已结束会话的归档内容</label><button :disabled="mutating || !retentionConfirmed || !retentionPreview.items.length" class="danger" @click="applyRetention">执行本批清理</button>
        </div>
      </section>
      <form class="cv-filters" @submit.prevent="loadList()">
        <input v-model="query" aria-label="搜索会话" placeholder="搜索本地名称、备注、会话编号、工具名" maxlength="160" />
        <input v-model="tag" aria-label="标签筛选" placeholder="精确标签" maxlength="48" />
        <select v-model="connection" aria-label="连接筛选"><option value="">全部连接</option><option v-for="c in status?.connections" :key="c.id" :value="c.id">{{ c.label }}</option></select>
        <select v-model="workspace" aria-label="工作区筛选"><option value="">全部工作区</option><option v-for="w in status?.workspaces" :key="w.id" :value="w.id">{{ w.label }}</option></select>
        <select v-model="filter" aria-label="任务状态筛选"><option value="all">全部任务状态</option><option value="running">运行中</option><option value="unknown">结果或终止未知</option><option value="closed">已结束</option></select>
        <select v-model="archiveFilter" aria-label="归档筛选"><option value="active">未收起</option><option value="archived">已收起归档</option><option value="all">全部</option></select>
        <label><input v-model="onlyPinned" type="checkbox" />只看置顶</label><select v-model="attribution" aria-label="会话归属筛选"><option value="">全部归属方式</option><option value="client_meta">客户端会话标识</option><option value="unassigned_missing">未提供标识</option><option value="unassigned_invalid">标识无效</option><option value="unassigned_legacy">历史任务未归属</option></select><button type="submit" :disabled="loading">筛选</button>
      </form>
      <div class="cv-layout">
        <aside class="cv-list" aria-label="会话列表" :aria-busy="loading">
          <p v-if="loading && !sessions.length">正在读取会话档案…</p><p v-else-if="!sessions.length" class="cv-empty">没有符合条件的会话。新版本启用后的调用才会自动生成档案，历史聊天不会自动补录。</p>
          <button v-for="s in sessions" :key="s.id" class="cv-session" :class="{selected:selected?.id===s.id}" :aria-pressed="selected?.id===s.id" :disabled="mutating" @click="choose(s.id)">
            <span class="cv-session-title">{{ s.pinned?'★ ':'' }}{{ s.local_title }}</span><span class="cv-badge" :class="{warning:s.attribution!=='client_meta'}">{{ attributionLabel(s.attribution) }}</span>
            <small>{{ connectionLabel(s.connection_id) }} · {{ dateLabel(s.last_activity_at) }}</small>
            <span>{{ s.call_count }} 次调用 · {{ s.job_count }} 条命令<span v-if="s.running_jobs"> · {{ s.running_jobs }} 运行</span><span v-if="s.unknown_jobs"> · {{ s.unknown_jobs }} 未知</span></span>
            <span v-if="s.tags.length" class="cv-tags"><em v-for="t in s.tags" :key="t">{{ t }}</em></span>
          </button>
          <button v-if="listCursor" class="cv-more" :disabled="loading" @click="loadList(true)">加载更多会话</button>
        </aside>
        <main class="cv-detail" :aria-busy="detailLoading" aria-label="会话详情">
          <p v-if="!selected" class="cv-empty">选择一个会话，查看请求、命令和状态时间线。</p>
          <template v-else>
            <header class="cv-detail-header"><div><h3>{{ selected.local_title }}</h3><code>{{ selected.id }}</code><p>{{ attributionLabel(selected.attribution) }} · {{ connectionLabel(selected.connection_id) }}</p></div>
              <div class="cv-actions"><button @click="showEdit=!showEdit">编辑会话</button><button :disabled="exporting || mutating" @click="exportSession">导出 JSONL</button><button :disabled="mutating || dirty" @click="previewClear">清理内容</button></div>
            </header>
            <p v-if="selected.payloads_cleared_at" class="cv-notice">部分历史内容已于 {{ dateLabel(selected.payloads_cleared_at) }} 被清理；摘要和任务关联仍保留。</p>
            <p v-if="exporting" role="status">正在整理导出，已读取 {{ exportCount }} 行。<button @click="exportCancelled=true">取消导出</button></p>
            <form v-if="showEdit" class="cv-edit" @submit.prevent="save">
              <label>本地会话名称<input v-model="title" maxlength="160" required data-testid="session-title-input" /></label><label>标签（逗号分隔，最多 12 个）<input v-model="tags" maxlength="420" /></label>
              <label>备注<textarea v-model="notes" rows="3" maxlength="4000" /></label><div class="cv-actions"><label><input v-model="pinned" type="checkbox" />置顶并保留内容</label><label><input v-model="archived" type="checkbox" />从默认列表收起</label><button type="submit" :disabled="mutating || !dirty" data-testid="save-session">保存会话</button><button type="button" @click="fillForm(selected);showEdit=false">放弃修改</button></div>
            </form>
            <div v-if="clearPreview" class="cv-confirm"><p>准备清理 {{ clearPreview.events }} 条内容事件，{{ byteLabel(clearPreview.bytes) }}。不会删除本地业务文件、命令任务或幂等记录。</p>
              <p v-for="reason in clearPreview.blockers" :key="reason" class="cv-error">{{ reason }}</p>
              <template v-if="clearPreview.allowed"><label><input v-model="clearConfirmed" type="checkbox" />我确认清理内容，且已按需导出</label><input v-model="confirmation" :placeholder="selected.id" aria-label="输入会话编号确认清理" /><button class="danger" :disabled="mutating || !clearConfirmed || confirmation!==selected.id" @click="clearContents">确认清理</button></template><button @click="clearPreview=null">取消</button>
            </div>
            <div class="cv-detail-counts"><span>工具调用 <b>{{ selected.call_count }}</b></span><span>命令任务 <b>{{ selected.job_count }}</b></span><span>内容事件 <b>{{ selected.event_count }}</b></span><span>创建 {{ dateLabel(selected.created_at) }}</span></div>
            <nav class="cv-tabs" aria-label="详情分类"><button v-for="t in (['events','calls','jobs','management'] as const)" :key="t" :class="{active:tab===t}" @click="changeTab(t)">{{ {events:'状态与输出时间线',calls:'工具请求',jobs:'命令任务',management:'本地管理记录'}[t] }}</button></nav>
            <form class="cv-event-search" @submit.prevent="loadItems()"><input v-model="itemQuery" :disabled="tab==='jobs'||tab==='management'" placeholder="搜索当前会话已保留的内容／工具名" maxlength="160" /><button :disabled="detailLoading">查询</button><button v-if="callFilter||jobFilter" type="button" @click="changeTab('events')">清除任务／调用筛选</button></form>
            <p v-if="callFilter||jobFilter" class="cv-hint">当前筛选：{{ callFilter||jobFilter }}</p>
            <p v-if="detailLoading && !items.length">正在加载记录…</p><p v-else-if="!items.length" class="cv-empty">当前筛选没有已保留的记录。未采集、已清理与调用失败并不等于执行成功。</p>
            <div v-if="tab==='events'||tab==='management'" class="cv-timeline">
              <article v-for="r in items" :key="String(r.seq)" class="cv-event"><div class="cv-event-top"><strong>{{ eventLabel(val(r,'kind')||val(r,'action')) }}</strong><time>{{ dateLabel(r.observed_at) }}</time><small>#{{ r.seq }}</small></div>
                <div class="cv-hint"><code v-if="r.job_id">{{ r.job_id }}</code><code v-if="r.call_id">{{ r.call_id }}</code><span v-if="r.redacted" class="cv-badge warning">已脱敏</span><span v-if="r.truncated" class="cv-badge warning">已截断</span></div>
                <details><summary>展开记录内容</summary><pre>{{ pretty(r.payload) }}</pre></details>
              </article>
            </div>
            <div v-else class="cv-table-wrap"><table><thead><tr><th>{{ tab==='calls'?'工具／请求编号':'任务／工作区' }}</th><th>状态</th><th>时间</th><th>操作</th></tr></thead><tbody>
              <tr v-for="r in items" :key="String(r.id)"><td><strong>{{ tab==='calls'?r.tool:workspaceLabel(r.workspace_id) }}</strong><code>{{ r.id }}</code><small v-if="tab==='calls'">{{ r.request_id }}</small></td>
                <td><span class="cv-badge" :class="{warning:(r.state==='TERMINATION_UNKNOWN'||r.phase==='interrupted')}">{{ stateLabel(val(r,'state')||val(r,'phase')) }}</span><small v-if="tab==='jobs'">{{ r.output_capture==='captured'?'已有受限输出记录':'输出尚未归档' }}</small><small v-if="r.result_kind==='tool_error'">工具返回错误</small></td>
                <td>{{ dateLabel(r.received_at??r.updated_at) }}</td><td><button @click="inspectEvents(tab==='calls'?'call':'job',val(r,'id'))">查看证据</button><button v-if="tab==='jobs'&&['STARTING','RUNNING','CANCELLING'].includes(val(r,'state'))" :disabled="mutating" @click="cancelJob(val(r,'id'))">请求取消</button><button v-if="r.state==='TERMINATION_UNKNOWN'" @click="emit('open-recovery')">到恢复页面</button></td></tr>
            </tbody></table></div>
            <button v-if="itemCursor" class="cv-more" :disabled="detailLoading" @click="loadItems(true)">加载更多记录</button>
          </template>
        </main>
      </div>
    </template>
  </section>
</template>

<style scoped>
.conversations{display:grid;gap:16px;color:#243b61;font-size:14px}.cv-toolbar,.cv-actions,.cv-event-top,.cv-detail-header{display:flex;align-items:center;justify-content:space-between;gap:12px}.cv-toolbar h2{margin:0;font-size:23px;color:#152961}.cv-toolbar p,.cv-detail-header p{margin:6px 0 0;color:#647897}.cv-actions{justify-content:flex-start;flex-wrap:wrap}.conversations button{padding:8px 12px;background:white;border:1px solid #ccd9ed;border-radius:7px;color:#214c88}.conversations button:hover:not(:disabled){background:#edf4ff;border-color:#8bb6ef}.conversations button:disabled{opacity:.5}.conversations label{display:inline-flex;align-items:center;gap:7px}.conversations input:not([type=checkbox]),.conversations select,.conversations textarea{padding:9px 10px;border:1px solid #ccd9ed;border-radius:7px;min-width:0;color:#253f66;background:white;max-width:100%;font:inherit}.conversations input[type=number]{width:90px}.cv-metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}.cv-metrics>div{padding:16px;background:white;border:1px solid #e1e9f4;border-radius:9px;display:grid;gap:6px}.cv-metrics span{color:#6b7e9a;font-size:12px}.cv-metrics strong{font-size:24px;font-weight:650}.cv-boundary,.cv-settings{border:1px solid #dae5f4;background:#f7faff;border-radius:9px;padding:12px 16px}.cv-boundary summary{cursor:pointer;color:#567394}.cv-boundary p,.cv-settings p{line-height:1.7}.cv-settings h3{margin:0 0 10px}.cv-filters{display:flex;flex-wrap:wrap;gap:9px;align-items:center}.cv-filters input:first-child{flex:1 1 290px}.cv-filters input:nth-child(2){width:125px}.cv-filters label{font-size:12px}.cv-layout{display:grid;grid-template-columns:minmax(265px,330px) minmax(0,1fr);gap:16px;align-items:start}.cv-list,.cv-detail{background:#fff;border:1px solid #dfe8f4;border-radius:10px;min-width:0}.cv-list{max-height:74vh;overflow:auto;padding:9px;display:grid;gap:8px}.conversations .cv-session{display:grid;text-align:left;gap:9px;padding:14px;border-color:#e5edf8;color:#31496f}.conversations .cv-session.selected{border-color:#337bdd;background:#f1f6ff;box-shadow:inset 3px 0 #176cf0}.cv-session-title{font-weight:650;color:#183661;overflow-wrap:anywhere}.cv-session small{color:#7286a3;font-size:11px}.cv-badge{display:inline-block;width:fit-content;background:#eef4ff;color:#39689e;border-radius:5px;padding:3px 7px;font-size:11px}.cv-badge.warning{background:#fff2d9;color:#916019}.cv-tags{display:flex;flex-wrap:wrap;gap:5px}.cv-tags em{font-size:11px;font-style:normal;color:#586f92;border:1px solid #dae4f1;border-radius:4px;padding:2px 5px}.cv-detail{padding:20px}.cv-detail-header{align-items:flex-start}.cv-detail-header h3{margin:0 0 8px;color:#19385f;font-size:19px}.cv-detail code{font-size:11px;overflow-wrap:anywhere;display:block;color:#68809f}.cv-detail-counts{display:flex;flex-wrap:wrap;gap:18px;padding:16px 0;font-size:12px;color:#7485a0}.cv-detail-counts b{color:#274b7e;margin-left:4px}.cv-edit{padding:16px;background:#f7faff;border:1px solid #d8e6f6;border-radius:8px;display:grid;gap:12px;margin:15px 0}.cv-edit>label{display:grid;gap:6px}.cv-tabs{display:flex;border-bottom:1px solid #dce5f2;gap:7px;flex-wrap:wrap}.conversations .cv-tabs button{border:0;border-radius:0;color:#617a9b;background:transparent;padding:11px 9px}.conversations .cv-tabs button.active{color:#176cf0;border-bottom:2px solid #176cf0;font-weight:bold}.cv-event-search{display:flex;gap:8px;flex-wrap:wrap;padding:14px 0}.cv-event-search input{flex:1 1 200px}.cv-timeline{display:grid;gap:12px}.cv-event{border:1px solid #e0e9f6;border-left:3px solid #8aaedd;padding:13px;border-radius:6px;min-width:0}.cv-event-top{justify-content:flex-start;flex-wrap:wrap;font-size:12px}.cv-event-top time{margin-left:auto;color:#7083a0}.cv-event-top small{color:#8b9cb4}.cv-event .cv-hint{display:flex;flex-wrap:wrap;gap:6px;padding:7px 0}.cv-event details summary{cursor:pointer;color:#37659c;font-size:12px;padding-top:5px}.cv-event pre{max-height:360px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:#f5f7fc;border-radius:6px;line-height:1.6;font-size:12px;color:#334b68}.cv-empty{padding:24px 12px;line-height:1.8;color:#788ba6;text-align:center}.cv-more{width:100%;margin-top:10px}.cv-table-wrap{overflow:auto}.cv-table-wrap table{width:100%;border-collapse:collapse}.cv-table-wrap th,.cv-table-wrap td{padding:12px 8px;border-bottom:1px solid #e3ebf5;text-align:left;vertical-align:top;font-size:12px}.cv-table-wrap td small{display:block;color:#7b8da6;margin-top:5px}.cv-table-wrap button{margin:2px;font-size:11px}.cv-error{padding:11px 14px;border:1px solid #f0c4c4;background:#fff4f4;border-radius:7px;color:#9c3d3d;line-height:1.6}.cv-notice{padding:11px 14px;border:1px solid #c8dcef;background:#f1f7fe;border-radius:7px;color:#35658c;line-height:1.6}.cv-confirm{display:grid;gap:10px;padding:15px;border:1px solid #efc9a9;background:#fff9f0;border-radius:8px;margin:12px 0}.cv-confirm p{margin:0;line-height:1.7}.cv-confirm input:not([type=checkbox]){width:100%}.conversations button.danger{color:#a54e29;border-color:#ddb796}.cv-hint{font-size:12px;color:#7a8da9}@media(max-width:1200px){.cv-layout{grid-template-columns:260px minmax(0,1fr)}.cv-detail-header{flex-direction:column}.cv-metrics strong{font-size:21px}}@media(max-width:900px){.cv-layout{grid-template-columns:1fr}.cv-list{max-height:320px}.cv-metrics{grid-template-columns:repeat(3,1fr)}.cv-toolbar{align-items:flex-start;flex-direction:column}.cv-detail{padding:14px}}@media(max-width:520px){.cv-metrics{grid-template-columns:repeat(2,1fr)}.cv-filters>*{flex:1 1 100%}}
</style>
