/**
 * LWB-003 证据运行入口。
 *
 * 用法：node --import tsx native/winfs-spike/run.ts [--keep]
 *
 * 产出：
 *   docs/evidence/lwb-003/winfs-handle-evidence.json   （机读原始观察）
 *   docs/evidence/lwb-003/summary.md                   （人读摘要）
 *
 * 本脚本**不做任何判断性结论**：它只记录真实观察值。
 * 结论与残余风险写在 docs/adr/002-writer-semantics.md。
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runExperiments, type EvidenceReport } from './experiments.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const evidenceDir = path.join(repoRoot, 'docs', 'evidence', 'lwb-003');

const keep = process.argv.includes('--keep');

function renderSummary(report: EvidenceReport): string {
  const lines: string[] = [];
  lines.push('# LWB-003 证据摘要：Windows 文件句柄与写入语义');
  lines.push('');
  lines.push('> 本文件由 `native/winfs-spike/run.ts` 自动生成。所有数值均为本机真实执行结果。');
  lines.push('> 未构造成功的场景标注为 skipped，**没有**被写成通过。');
  lines.push('');
  lines.push('## 运行环境');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 生成时间 | ${report.generated_at} |`);
  lines.push(`| 平台 | ${report.host.platform} |`);
  lines.push(`| 系统 | ${report.host.os_release} |`);
  lines.push(`| Node | ${report.host.node} |`);
  lines.push(`| PowerShell | ${report.host.powershell ?? '未取到'} |`);
  lines.push(`| 文件系统 | ${report.host.filesystem ?? '未取到'} |`);
  lines.push('');
  lines.push('## 结论速览');
  lines.push('');
  lines.push('| 编号 | 主题 | 状态 |');
  lines.push('| --- | --- | --- |');
  for (const exp of report.experiments) {
    const badge = exp.status === 'observed' ? '已观察' : exp.status === 'skipped' ? '未构造' : '未证实';
    lines.push(`| ${exp.id} | ${exp.title} | ${badge} |`);
  }
  lines.push('');

  for (const exp of report.experiments) {
    lines.push(`## ${exp.id} ${exp.title}`);
    lines.push('');
    lines.push(`**状态**：${exp.status === 'observed' ? '已观察' : exp.status === 'skipped' ? '未构造' : '未证实'}`);
    lines.push('');
    lines.push(`**对应不变量**：${exp.invariants.join('、')}`);
    lines.push('');
    if (exp.commands.length > 0) {
      lines.push('**实际执行的命令**：');
      lines.push('');
      for (const cmd of exp.commands) lines.push(`- \`${cmd}\``);
      lines.push('');
    }
    lines.push('**真实观察值**：');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(exp.observations, null, 2));
    lines.push('```');
    lines.push('');
    lines.push(`**结论**：${exp.conclusion}`);
    lines.push('');
  }

  lines.push('## 延迟测量（决定 PowerShell 助手能否作为过渡后端）');
  lines.push('');
  lines.push('| 模式 | 样本 | P50 | P95 | 最小 | 最大 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  const c = report.latency.cold_spawn_ms;
  const r = report.latency.resident_call_ms;
  lines.push(`| 冷启动（每次新起 pwsh 进程） | ${c.samples} | ${c.p50} ms | ${c.p95} ms | ${c.min} ms | ${c.max} ms |`);
  lines.push(`| 常驻（单进程 + JSON 行协议） | ${r.samples} | ${r.p50} ms | ${r.p95} ms | ${r.min} ms | ${r.max} ms |`);
  lines.push('');
  lines.push(`方案 §13 对小型文本文件读取的目标是 P95 ≤ ${report.latency.target_p95_ms} ms。`);
  lines.push(
    `按本次实测，满足该目标的模式是：**${
      report.latency.meets_target_with === 'resident'
        ? '常驻助手'
        : report.latency.meets_target_with === 'cold'
          ? '冷启动'
          : report.latency.meets_target_with === 'neither'
            ? '两者都不满足'
            : '未知（样本不足）'
    }**。`,
  );
  lines.push('');
  lines.push('注意：以上仅为**文件系统调用本身**的延迟，不含 daemon 内其它处理。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  console.log('开始 LWB-003 实验（真实文件系统操作，位于 %TEMP%）…\n');

  const report = await runExperiments();

  await mkdir(evidenceDir, { recursive: true });
  const jsonPath = path.join(evidenceDir, 'winfs-handle-evidence.json');
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const summaryPath = path.join(evidenceDir, 'summary.md');
  await writeFile(summaryPath, renderSummary(report), 'utf8');

  console.log(`证据已写入：${path.relative(repoRoot, jsonPath)}`);
  console.log(`摘要已写入：${path.relative(repoRoot, summaryPath)}\n`);

  for (const exp of report.experiments) {
    const badge = exp.status === 'observed' ? '✓' : exp.status === 'skipped' ? '-' : '✗';
    console.log(`${badge} ${exp.id} ${exp.title}`);
  }
  console.log('');
  console.log(
    `延迟：冷启动 P50=${report.latency.cold_spawn_ms.p50}ms P95=${report.latency.cold_spawn_ms.p95}ms；` +
      `常驻 P50=${report.latency.resident_call_ms.p50}ms P95=${report.latency.resident_call_ms.p95}ms`,
  );
  console.log(`满足 P95≤${report.latency.target_p95_ms}ms 目标：${report.latency.meets_target_with}`);

  if (!keep) {
    await rm(report.host.temp_root, { recursive: true, force: true });
    console.log(`\n已清理临时目录：${report.host.temp_root}`);
  } else {
    console.log(`\n保留临时目录：${report.host.temp_root}`);
  }
}

await main();
