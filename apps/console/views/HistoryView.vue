<!-- LWB-037 历史页：只显示服务端数据库回报的状态，不在组件内推断终态。 -->
<script setup lang="ts">
import {
  historyStateLabel,
  operationIsTerminal,
  outcomeLabel,
  type HistoryData,
} from '../src/history/index.ts';

withDefaults(
  defineProps<{
    readonly data: HistoryData | null;
    readonly loading?: boolean;
    readonly error?: string | null;
  }>(),
  { loading: false, error: null },
);

const emit = defineEmits<{
  (event: 'refresh'): void;
  (event: 'open-recovery', payload: { readonly operation_id: string }): void;
}>();
</script>

<template>
  <section class="history" data-testid="history-view" aria-label="历史记录">
    <header class="history__header">
      <div>
        <h1>历史</h1>
        <p v-if="data !== null" data-testid="history-observed-at">数据库读取于 {{ data.observed_at }}</p>
        <p v-else data-testid="history-empty">尚未读到历史记录。</p>
      </div>
      <button type="button" data-testid="refresh-history" :disabled="loading" @click="emit('refresh')">
        {{ loading ? '读取中…' : '重新读取历史' }}
      </button>
    </header>

    <p v-if="error" class="history__error" role="alert" data-testid="history-error">{{ error }}</p>

    <template v-if="data !== null">
      <section class="history__section" data-testid="operation-history" aria-label="执行历史">
        <h2>执行历史</h2>
        <p class="history__hint">状态直接来自数据库；终态不会因为页面刷新被重新推断。</p>
        <table v-if="data.operations.length > 0">
          <thead>
            <tr><th>操作</th><th>修改集</th><th>工作区</th><th>操作状态</th><th>修改集状态</th><th>时间</th><th>恢复</th></tr>
          </thead>
          <tbody>
            <tr v-for="operation in data.operations" :key="operation.operation_id" data-testid="operation-row" :data-terminal="operationIsTerminal(operation)">
              <td><code>{{ operation.operation_id }}</code></td>
              <td><code>{{ operation.change_id }}</code></td>
              <td><code>{{ operation.workspace_id }}</code></td>
              <td data-testid="operation-state">{{ historyStateLabel(operation.operation_state) }}</td>
              <td>{{ historyStateLabel(operation.change_state) }}</td>
              <td>{{ operation.finished_at ?? operation.created_at }}</td>
              <td>
                <button
                  v-if="operation.operation_state === 'RECOVERY_REQUIRED'"
                  type="button"
                  data-testid="open-recovery"
                  @click="emit('open-recovery', { operation_id: operation.operation_id })"
                >
                  打开恢复
                </button>
                <span v-else-if="operation.recovered">已由恢复流程定案</span>
                <span v-else>—</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else data-testid="no-operations">暂无执行记录。</p>
      </section>

      <section class="history__section" data-testid="audit-history" aria-label="审计历史">
        <h2>审计记录</h2>
        <table v-if="data.audit.length > 0">
          <thead><tr><th>时间</th><th>对象</th><th>动作</th><th>结果</th><th>错误码</th></tr></thead>
          <tbody>
            <tr v-for="entry in data.audit" :key="entry.id" data-testid="audit-row">
              <td>{{ entry.timestamp }}</td>
              <td><code>{{ entry.subject }}</code></td>
              <td>{{ entry.action }}</td>
              <td>{{ outcomeLabel(entry.outcome) }}</td>
              <td>{{ entry.error_code ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else data-testid="no-audit">暂无审计记录。</p>
      </section>
    </template>
  </section>
</template>

