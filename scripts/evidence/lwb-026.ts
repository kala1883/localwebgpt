/**
 * LWB-026 可复现证据采集：写执行协调器。
 *
 * 装置：**两个真实操作系统进程** ←各自独立连接→ 真 SQLite（**磁盘文件**、
 * WAL、`synchronous=FULL`）→ 真仓储 / 真 `BEGIN IMMEDIATE` / 真槽表 →
 * 真批准与真操作行 → 真进程探针（`nodeProcessProbe`，`process.kill(pid, 0)`）。
 * 唯一的假件是**写盘人**，而它是故意假的（真写入是 LWB-027）：
 * 本任务交付的是「谁先写、写完之后是什么状态」，不是「怎么写」。
 *
 * ## 为什么必须跨进程，而不是同一进程里开两个连接
 *
 * 三条验收标准的主语都是**执行器**，而执行器的身份由 `(pid, started_at)`
 * 决定（`packages/ipc/src/lease.ts`）。同一个进程里的两个连接共享同一个
 * pid —— 那样测出来的「互斥」在探针那一格上是空的：验收 3 要证明的是
 * 「进程还活着 ⇒ 不许接管」，而这一点只有在持有者真的是**另一个进程**、
 * 并且它真的被 `kill` 掉时才成立。因此本脚本 spawn 自己，用
 * `--worker <角色>` 分成主进程与写手进程。
 *
 * 单元测试（`tests/unit/executor-coordinator.test.ts`）用的是假探针，
 * 因为它要穷尽构造「PID 被复用」「探针抛异常」这类在真机上不可按需制造的
 * 情形。两者是**互补**的：那一边穷尽分支，这一边证明分支真的接在 OS 上。
 *
 * ## 逐条对应任务书
 *
 * ## 为什么第 1 节是「写盘期间状态库仍可写」
 *
 * 因为它是唯一一节**必须没有别的排队项**的：写手进程走的是真协调器的
 * `runOnce()`，而它取的是**全库最老的那个 QUEUED**。后面几节每造一个
 * 排队中的修改集，都会把队首挪到别处去。其余的节不挑剔起点，只有这一节挑，
 * 所以它排在最先。
 *
 *  步骤 1「实现工作区写执行槽与租约心跳」 —— 第 2 节：槽行按
 *  `(volume_id, root_file_id)` 落库，心跳真的把 `expires_at` 往后推
 *  （读两次行比对，而不是相信 `heartbeat()` 的返回值）。
 *
 *  步骤 2「用短事务认领，不得在事务中做文件写入或外部等待」 —— 第 1 节与
 *  第 2 节各证一半。第 1 节更强：写盘人**正在写**的那 2.5 秒里，
 *  父进程照样写库成功 —— 认领与收尾是短事务，等待发生在事务之外。
 *  第 2 节则是「持有者占着地的时候父进程仍能在**1 秒内**写库」
 *  （`busy_timeout` 是 5 秒，因此一个被攥住的长事务会表现为 5 秒卡顿或
 *  `SQLITE_BUSY`）。
 *
 *  步骤 3「心跳超时不得直接接管」 —— 第 3 节，也是验收 3 的正面。
 *  同一块地、同一个请求，**唯一变量是持有者进程在不在**：在 → `refused`
 *  （什么都没变）；不在 → `blocked`（需要人来）。把这两次并排放，
 *  是因为只证一半的话，「一律拒绝」和「一律阻断」都能通过。
 *
 *  验收 1「同一工作区不会并发应用两个修改集」 —— 第 2 节。
 *  第二个人拿到的拒绝必须是 `SLOT_REFUSED` / `LEASE_VALID`，且它
 *  **一格都没动**：状态、批准、槽三者逐项比对（只断状态会让
 *  「状态没变但批准被吃掉」通过）。
 *
 *  验收 2「不同连接的任务也共享物理工作区执行约束」 —— 第 2 节。
 *  两个修改集属于**两个连接**，而它们碰到的是同一块地。另外断言
 *  另一块物理身份上**没有**槽行 —— 一把全局锁也能让验收 1 通过，
 *  却会让验收 2 变成「所有工作区串行」。
 *
 *  验收 3「旧执行器未退出时不会因心跳超时启动新写执行器」 —— 第 3 节。
 *  「不会启动」的判据不是返回值好看，而是三件事同时成立：新写手被拒绝、
 *  地没被阻断、上一个操作**没有**被标成待恢复。
 *
 * 第 4 节是负向回归，第 5 节标明未执行项；全仓回归的命令、退出码与计数
 * 记在 `docs/evidence/lwb-026/summary.md`，不在这里重跑一遍。
 *
 * 用法：node --import tsx scripts/evidence/lwb-026.ts
 * 退出码：全部通过 0；任一项失败 1。
 *
 * 本文件证明不了的事（见第 5 节）：**真实 ChatGPT 网页端的验收**需要真实
 * 账号与 Secure MCP Tunnel 凭据，当前 BLOCKED（LWB-002）；
 * **字节真的落到用户文件上**属 LWB-027；**恢复流程**属 LWB-030；
 * `change_apply` 工具接入属 LWB-032。MCP Inspector 的一次成功也不能替代
 * 第一项。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { approveAndQueue, approveChange } from '@lwb/approvals';
import { canonicalChangeDigest } from '@lwb/changes';
import { CONTRACT_VERSION, LIMITS } from '@lwb/contracts';
import { ExecutionCoordinator, claimForExecution } from '@lwb/executor';
import type { ApplyReport, ExecutionPlan } from '@lwb/executor';
import { currentProcessIdentity, nodeProcessProbe } from '@lwb/ipc';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { ChangeItemInput, OpenDatabaseResult } from '@lwb/persistence';

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

const FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(FILE), '..', '..');
const WORKER_PREFIX = 'WORKER ';

let failures = 0;
let passes = 0;
let skips = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes += 1;
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function note(name: string, detail: string): void {
  console.log(`NOTE ${name} — ${detail}`);
}

function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

function skip(name: string, why: string): void {
  skips += 1;
  console.log(`NOT_RUN ${name} — ${why}`);
}

/** 跑一段；炸了就把真实原因报成 FAIL，而不是让整个脚本消失。 */
async function guarded(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (cause) {
    const error = cause as { code?: string; message?: string; details?: unknown; stack?: string };
    check(`${name} 段跑完`, false, `${error.code ?? '(无错误码)'}：${error.message ?? String(cause)}`);
    if (error.details !== undefined) console.log(`      details=${JSON.stringify(error.details)}`);
    if (error.stack) console.log(`      ${error.stack.split('\n').slice(1, 4).join('\n      ')}`);
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '?';
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const iso = (ms: number): string => new Date(ms).toISOString();

/** 写手进程报上来的**全部**事实，原样留存，末尾做脱敏检查。 */
const workerLines: string[] = [];

/** 造一个 sha256 形状的十六进制串。**不是**真哈希：本脚本不读文件内容。 */
const fakeSha = (seed: string): string => seed.repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'a');

// ---------------------------------------------------------------------------
// 写手进程
// ---------------------------------------------------------------------------

/**
 * 一个被 spawn 出来的写手。
 *
 * `line()` 收的是那**一行** JSON —— 子进程的 stdout 只用来传事实，
 * 格式固定成一行前缀 + JSON，主进程不必解析任何人类可读的文案。
 */
interface Writer {
  readonly pid: number;
  readonly child: ChildProcess;
  /** 等下一行事实。超时视为 FAIL，而不是无限挂住整个取证。 */
  line(timeoutMs?: number): Promise<Record<string, unknown>>;
  /** 等进程退出，返回退出码。 */
  exited(): Promise<number>;
  /** 杀掉它，并**确认探针看到它消失了**（否则验收 3 的「不在」是假的）。 */
  killAndConfirm(): Promise<boolean>;
}

function spawnWriter(role: string, args: readonly string[]): Writer {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', FILE, '--worker', role, ...args],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );

  let buffer = '';
  let stderr = '';
  const waiting: ((value: Record<string, unknown>) => void)[] = [];
  const queued: Record<string, unknown>[] = [];

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith(WORKER_PREFIX)) {
        // 原样留存一份，末尾的脱敏检查要拿它当证据。
        workerLines.push(line.slice(WORKER_PREFIX.length));
        const parsed = JSON.parse(line.slice(WORKER_PREFIX.length)) as Record<string, unknown>;
        const resolve = waiting.shift();
        if (resolve !== undefined) resolve(parsed);
        else queued.push(parsed);
      }
      index = buffer.indexOf('\n');
    }
  });

  const exitCode = new Promise<number>((resolve) => {
    child.on('exit', (code) => resolve(code ?? -1));
  });

  const pid = child.pid;
  if (pid === undefined) throw new Error('写手进程没有 pid，无法继续取证。');

  return {
    pid,
    child,
    line(timeoutMs = 30_000): Promise<Record<string, unknown>> {
      const ready = queued.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`写手 ${role}(${pid}) 在 ${timeoutMs}ms 内没有报告任何事实。stderr=${stderr.slice(0, 400)}`));
        }, timeoutMs);
        waiting.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    },
    exited: () => exitCode,
    async killAndConfirm(): Promise<boolean> {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exitCode;
      // 杀完之后**问探针**，不信自己刚才发过信号。探针是 OS 的事实，
      // 信号只是我们的意图 —— 两者之间隔着一次真实的进程回收。
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (nodeProcessProbe.identify(pid) === null) return true;
        await delay(50);
      }
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// 写手模式
// ---------------------------------------------------------------------------

/**
 * 写手进程的入口。
 *
 * 它只做一件事：连上**同一个库文件**，按角色动作，然后把结果说成一行 JSON。
 * 它不生成夹具 —— 夹具由主进程造好，写手只认 id。这条分工让「两个执行器
 * 看到的是同一份事实」不依赖任何共享内存。
 */
async function runWorker(role: string, args: readonly string[]): Promise<void> {
  const [dbPath, changeId, ...rest] = args;
  if (dbPath === undefined || changeId === undefined) {
    throw new Error(`写手 ${role} 缺少参数。`);
  }
  const options = new Map<string, string>();
  for (const entry of rest) {
    const at = entry.indexOf('=');
    if (at > 0) options.set(entry.slice(0, at), entry.slice(at + 1));
  }
  const leaseMs = Number(options.get('lease_ms') ?? '5000');
  const heartbeatMs = Number(options.get('heartbeat_ms') ?? '0');
  const writeMs = Number(options.get('write_ms') ?? '0');

  const opened = openDatabase({ path: dbPath });
  const repos = new Repositories(opened.db, () => new Date().toISOString());
  const holder = currentProcessIdentity();
  const probe = nodeProcessProbe;
  const say = (payload: Record<string, unknown>): void => {
    console.log(`${WORKER_PREFIX}${JSON.stringify(payload)}`);
  };

  const executorId = `exe_${role}_${process.pid}`;
  const deps = { repos, executor_id: executorId, holder, probe, lease_ms: leaseMs, now: () => Date.now() };

  if (role === 'writing') {
    // 走**真协调器**：认领 → 写盘（这里由假写盘人代替）→ 收尾，
    // 三段各自的边界正是步骤 2 要证的东西。
    const coordinator = new ExecutionCoordinator({
      repos,
      probe,
      executor_id: executorId,
      holder,
      lease_ms: leaseMs,
      apply_timeout_ms: 60_000,
      heartbeat_ms: heartbeatMs > 0 ? heartbeatMs : 1_000,
      apply: async (plan: ExecutionPlan, signal: AbortSignal): Promise<ApplyReport> => {
        // §8.2 步骤 5：写盘的人在动字节之前记下执行意图。
        repos.changes.transition(plan.change.id, ['VALIDATING'], 'APPLYING');
        repos.operations.transition(plan.operation_id, ['VALIDATING'], 'APPLYING');
        say({
          role,
          stage: 'writing',
          pid: process.pid,
          operation_id: plan.operation_id,
          change_id: plan.change.id,
          fencing_token: plan.fencing_token,
          // 报的是 `canonical_path`（相对路径），不是本机绝对路径 ——
          // 写手进程的这行事实会被主进程收进证据。
          items: plan.items.map((item) => item.canonical_path),
        });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, writeMs);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('写盘过程中被中止。'));
          }, { once: true });
        });
        return { kind: 'applied' };
      },
    });
    const outcome = await coordinator.runOnce();
    say({ role, stage: 'finished', pid: process.pid, outcome });
    closeDatabase(opened.db);
    return;
  }

  const claimed = claimForExecution(deps, changeId);
  if (claimed.kind === 'claimed') {
    say({
      role,
      stage: 'claimed',
      pid: process.pid,
      executor_id: executorId,
      operation_id: claimed.plan.operation_id,
      fencing_token: claimed.plan.fencing_token,
      slot_expires_at: claimed.plan.slot_expires_at,
    });
  } else {
    say({ role, stage: 'not_claimed', pid: process.pid, outcome: claimed });
    closeDatabase(opened.db);
    return;
  }

  // 认领之后保持进程存活。`hold` 会续约（证明心跳真的在推 expires_at），
  // `stall` 故意不续约（构造「租约过期但进程还在」—— 验收 3 的那个场景）。
  const plan = claimed.plan;
  if (role === 'hold' && heartbeatMs > 0) {
    setInterval(() => {
      try {
        repos.write_slots.heartbeat({
          operation_id: plan.operation_id,
          executor_id: executorId,
          fencing_token: plan.fencing_token,
          expires_at: new Date(Date.now() + leaseMs).toISOString(),
        });
      } catch (cause) {
        say({ role, stage: 'heartbeat_failed', pid: process.pid, message: String(cause) });
      }
    }, heartbeatMs).unref?.();
  }
  // 让进程活着等主进程来杀。定时器不 unref 的那一个才是保命的——
  // 这里两个都留着，因为写手进程的存活本身就是被观测的事实。
  setInterval(() => { /* 保持存活 */ }, 1_000);
}

// ---------------------------------------------------------------------------
// 夹具（只有主进程建）
// ---------------------------------------------------------------------------

const CONNECTION_A = 'conn_ev_a';
const CONNECTION_B = 'conn_ev_b';
const PRINCIPAL = 'principal_ev';
const POLICY_VERSION = 3;
const GENERATION = 9;
const MODE = 'read_propose_apply_with_local_approval';
const ACTOR = 'console:evidence-026';
const CONTRACT = CONTRACT_VERSION;

interface Terrain {
  readonly workspace_id: string;
  readonly volume_id: string;
  readonly root_file_id: string;
  readonly path: string;
}

let repos: Repositories;
let seq = 0;

const nextId = (prefix: string): string => `${prefix}_${(seq += 1).toString().padStart(4, '0')}`;

function seedConnectionsAndWorkspaces(terrain: readonly Terrain[]): void {
  for (const id of [CONNECTION_A, CONNECTION_B]) {
    repos.connections.create({
      id,
      principal_kind: 'model_surface',
      principal_id: PRINCIPAL,
      alias: `取证连接 ${id}`,
      enabled: true,
    });
  }
  for (const entry of terrain) {
    repos.workspaces.create({
      id: entry.workspace_id,
      alias: `取证 ${entry.workspace_id}`,
      kind: 'directory',
      canonical_root: entry.path,
      volume_id: entry.volume_id,
      root_file_id: entry.root_file_id,
      policy_version: POLICY_VERSION,
      mode: MODE,
    });
    // 建出来是第 1 代，而夹具声明的不是 1 —— 两边都是 1 的时候，
    // 「代次比对」这条断言在做错事时也会通过。
    while (repos.workspaces.requireById(entry.workspace_id).generation < GENERATION) {
      repos.workspaces.bumpGeneration(entry.workspace_id, POLICY_VERSION);
    }
  }
}

interface Fixture {
  readonly change_id: string;
  readonly operation_id: string;
  readonly approval_id: string;
  readonly digest: string;
}

/**
 * 造一个**已批准、已排队**的修改集：真仓储 + 真批准 + 真操作。
 *
 * 走 `approveAndQueue` —— 生产里控制台「批准并应用」走的就是它。
 * 自己拼一遍也能得到同样的行，但那会让取证的起点变成「我拼出来的起点」。
 */
function queuedChange(
  seed: string,
  workspaceId: string,
  connectionId: string,
  paths: readonly string[],
): Fixture {
  const files = paths.map((entry, index) => {
    const beforeText = `before-${seed}-${index}`;
    const afterText = `after-${seed}-${index}`;
    const beforeSha = fakeSha(`1${seed}${index}`);
    const afterSha = fakeSha(`2${seed}${index}`);
    const before = repos.blobs.ensure({
      id: nextId('blob'),
      sha256: beforeSha,
      size: beforeText.length,
      storage_ref: `objects/${beforeSha}`,
    }).blob;
    const after = repos.blobs.ensure({
      id: nextId('blob'),
      sha256: afterSha,
      size: afterText.length,
      storage_ref: `objects/${afterSha}`,
    }).blob;
    const item: ChangeItemInput = {
      id: nextId('ci'),
      path: entry,
      op: 'edit_text',
      base_file_id: `file-id-${seed}-${index}`,
      base_sha256: beforeSha,
      target_sha256: afterSha,
      old_blob_id: before.id,
      new_blob_id: after.id,
      encoding: 'utf-8',
      bom: false,
      newline: 'lf',
      added_lines: 1,
      removed_lines: 1,
    };
    return {
      item,
      digestFile: {
        path: entry,
        op: 'edit_text' as const,
        before_sha256: beforeSha,
        before_size: beforeText.length,
        after_sha256: afterSha,
        after_size: afterText.length,
        encoding: 'utf-8' as const,
        newline: 'lf' as const,
        bom: false,
      },
    };
  });

  const digest = canonicalChangeDigest({
    contract_version: CONTRACT,
    policy_version: POLICY_VERSION,
    root_generation: GENERATION,
    workspace_id: workspaceId,
    files: files.map((entry) => entry.digestFile),
  });

  const change = repos.changes.create({
    id: nextId('chg'),
    owner_connection_id: connectionId,
    workspace_id: workspaceId,
    root_generation: GENERATION,
    policy_version: POLICY_VERSION,
    contract_version: CONTRACT,
    digest,
    summary: `取证摘要 ${seed}`,
    expires_at: iso(Date.now() + LIMITS.CHANGE_TTL_MS),
    items: files.map((entry) => entry.item),
  });

  const queued = approveAndQueue({
    repos,
    change_id: change.id,
    digest,
    actor: ACTOR,
    now: new Date().toISOString(),
    idempotency_key: `key-${seed}`,
  });

  return {
    change_id: change.id,
    operation_id: queued.operation.id,
    approval_id: queued.approval.id,
    digest,
  };
}

/** 一个只批准、不排队的修改集。第 4 节要用它证明「未确认的提议不会被执行」。 */
function pendingChange(seed: string, workspaceId: string, connectionId: string): string {
  const fixture = queuedChangeBuiltOnly(seed, workspaceId, connectionId);
  approveChange({
    repos,
    change_id: fixture.change_id,
    digest: fixture.digest,
    actor: ACTOR,
    now: new Date().toISOString(),
  });
  return fixture.change_id;
}

/** 建出 `PENDING_APPROVAL` 的修改集，返回 id 与重算摘要。 */
function queuedChangeBuiltOnly(seed: string, workspaceId: string, connectionId: string): { change_id: string; digest: string } {
  const beforeSha = fakeSha(`9${seed}0`);
  const afterSha = fakeSha(`8${seed}0`);
  const before = repos.blobs.ensure({
    id: nextId('blob'), sha256: beforeSha, size: 16, storage_ref: `objects/${beforeSha}`,
  }).blob;
  const after = repos.blobs.ensure({
    id: nextId('blob'), sha256: afterSha, size: 15, storage_ref: `objects/${afterSha}`,
  }).blob;
  const entry = `src/${seed}.ts`;
  const digest = canonicalChangeDigest({
    contract_version: CONTRACT,
    policy_version: POLICY_VERSION,
    root_generation: GENERATION,
    workspace_id: workspaceId,
    files: [{
      path: entry, op: 'edit_text' as const,
      before_sha256: beforeSha, before_size: 16,
      after_sha256: afterSha, after_size: 15,
      encoding: 'utf-8' as const, newline: 'lf' as const, bom: false,
    }],
  });
  const change = repos.changes.create({
    id: nextId('chg'),
    owner_connection_id: connectionId,
    workspace_id: workspaceId,
    root_generation: GENERATION,
    policy_version: POLICY_VERSION,
    contract_version: CONTRACT,
    digest,
    summary: `取证摘要 ${seed}`,
    expires_at: iso(Date.now() + LIMITS.CHANGE_TTL_MS),
    items: [{
      id: nextId('ci'),
      path: entry,
      op: 'edit_text',
      base_file_id: `file-id-${seed}-0`,
      base_sha256: beforeSha,
      target_sha256: afterSha,
      old_blob_id: before.id,
      new_blob_id: after.id,
      encoding: 'utf-8',
      bom: false,
      newline: 'lf',
      added_lines: 1,
      removed_lines: 1,
    }],
  });
  return { change_id: change.id, digest };
}

// ---------------------------------------------------------------------------
// 断言辅助
// ---------------------------------------------------------------------------

/** 一次「什么都没变」的完整比对：状态、批准、槽三者一起看。 */
interface Snapshot {
  readonly change_state: string;
  readonly operation_state: string;
  readonly approval_state: string;
  readonly slot_blocked_at: string | null;
  readonly slot_operation_id: string | null;
  readonly slot_executor_id: string | null;
  readonly slot_holder_pid: number | null;
  readonly slot_fencing_token: number | null;
  readonly slot_expires_at: string | null;
}

function snapshot(changeId: string, terrain: Terrain): Snapshot {
  const change = repos.changes.requireById(changeId);
  const operation = repos.operations.findByChangeId(changeId);
  // 用 `findActive` 而不是「读那条批准再看它的状态」：前者问的正是
  // 「这张许可还能用吗」，而后者要调用方自己把 `expires_at` 折进去。
  // 一次拒绝之后许可必须**原样可用**，那是「什么都没变」里最要紧的一格。
  const approval = repos.approvals.findActive(changeId);
  const slot = repos.write_slots.find(terrain.volume_id, terrain.root_file_id);
  return {
    change_state: change.state,
    operation_state: operation?.state ?? '(无操作行)',
    approval_state: approval === null ? '(无可用批准)' : approval.state,
    slot_blocked_at: slot?.blocked_at ?? null,
    slot_operation_id: slot?.operation_id ?? null,
    slot_executor_id: slot?.executor_id ?? null,
    slot_holder_pid: slot?.holder_pid ?? null,
    slot_fencing_token: slot?.fencing_token ?? null,
    slot_expires_at: slot?.expires_at ?? null,
  };
}

function sameSnapshot(before: Snapshot, after: Snapshot): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

/** 等到槽的租约过期（读真行，不猜时间）。 */
async function waitForLeaseExpiry(terrain: Terrain, slackMs = 250): Promise<number> {
  const slot = repos.write_slots.find(terrain.volume_id, terrain.root_file_id);
  if (slot === null) throw new Error('槽行不存在，无法等待租约到期。');
  const target = Date.parse(slot.expires_at) + slackMs;
  const wait = target - Date.now();
  if (wait > 0) await delay(wait);
  return Date.parse(slot.expires_at);
}

/** 脱敏：证据里不得出现本机绝对路径。 */
function leaksLocalPaths(text: string): boolean {
  return /[A-Za-z]:\\\\|[A-Za-z]:\\|\/tmp\/|\/home\/|\/Users\//.test(text);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--worker') {
    await runWorker(str(argv[1]), argv.slice(2));
    return;
  }

  console.log(`LWB-026 证据采集 @ ${new Date().toISOString()}`);
  console.log(`node ${process.version} / ${process.platform} ${process.arch}`);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'lwb-026-'));
  const dbPath = path.join(dir, 'bridge.sqlite');

  const T1: Terrain = {
    workspace_id: 'ws_ev_main',
    volume_id: 'vol_ev_main',
    root_file_id: 'root_ev_main',
    path: 'C:\\LWB\\evidence\\main',
  };
  const T2: Terrain = {
    workspace_id: 'ws_ev_sibling',
    volume_id: 'vol_ev_sibling',
    root_file_id: 'root_ev_sibling',
    path: 'C:\\LWB\\evidence\\sibling',
  };
  const T3: Terrain = {
    workspace_id: 'ws_ev_third',
    volume_id: 'vol_ev_third',
    root_file_id: 'root_ev_third',
    path: 'C:\\LWB\\evidence\\third',
  };

  let opened: OpenDatabaseResult | undefined;
  const writers: Writer[] = [];

  try {
    // -----------------------------------------------------------------------
    section('第 0 节 装置：真库文件、真探针');

    opened = openDatabase({ path: dbPath });
    repos = new Repositories(opened.db, () => new Date().toISOString());
    seedConnectionsAndWorkspaces([T1, T2, T3]);

    const info = await stat(dbPath);
    check('状态库是磁盘文件（跨进程的必要条件）', info.isFile() && info.size > 0, `${info.size} 字节`);
    check(
      'SQLite 模式为 WAL 且忙等有界',
      String(opened.pragmas.journal_mode).toLowerCase() === 'wal' && opened.pragmas.busy_timeout === 5000,
      `journal_mode=${String(opened.pragmas.journal_mode)} busy_timeout=${String(opened.pragmas.busy_timeout)}`,
    );
    // 探针必须先被证明在**两个方向**上都诚实，否则第 3 节里那句
    // 「写手 B 仍然活着」可能只是探针恒返回非 null 的副作用。
    const probeAlive = nodeProcessProbe.identify(process.pid) !== null;
    const canary = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    const canaryPid = canary.pid ?? 0;
    await new Promise<void>((resolve) => canary.on('exit', () => resolve()));
    await delay(150);
    const probeDead = nodeProcessProbe.identify(canaryPid) === null;
    check(
      '探针双向诚实：活着的进程报存在，刚退出的进程报不存在',
      probeAlive && probeDead,
      `identify(${process.pid})=存在 identify(${canaryPid})=${probeDead ? '不存在' : '**仍然存在**'}`,
    );

    // -----------------------------------------------------------------------
    section('第 1 节 写盘期间状态库仍可写（步骤 2 的后半）');

    const c5 = queuedChange('ev5', T3.workspace_id, CONNECTION_A, ['src/five.ts']);
    const writeMsBudget = 2_500;
    const w6 = spawnWriter('writing', [dbPath, c5.change_id, 'lease_ms=6000', 'write_ms=' + String(writeMsBudget)]);
    writers.push(w6);
    const writing = await w6.line();
    check(
      '真协调器认领并进入写盘阶段（写盘人由假件代替，真写入属 LWB-027）',
      writing.stage === 'writing' && num(writing.fencing_token) === 1,
      `operation=${str(writing.operation_id)} token=${String(writing.fencing_token)}`,
    );

    const midChange = repos.changes.requireById(c5.change_id);
    const midOperation = repos.operations.requireById(c5.operation_id);
    check(
      '外界能看见「正在写」这个中间态（不是等到收尾才一次性可见）',
      midChange.state === 'APPLYING' && midOperation.state === 'APPLYING',
      `change=${midChange.state} operation=${midOperation.state}`,
    );

    const duringStart = Date.now();
    queuedChangeBuiltOnly('during', T3.workspace_id, CONNECTION_B);
    repos.operations.listByStates(['QUEUED']);
    const duringMs = Date.now() - duringStart;
    check(
      '写盘人正在工作的那几秒里，父进程写库仍然成功且不卡（事务没有跨过等待）',
      duringMs < 1_000,
      `耗时 ${duringMs}ms（写盘人还要持续 ${String(writeMsBudget)}ms）`,
    );
    check(
      '父进程写库时写盘人仍在运行 —— 两件事真的重叠，不是先后发生',
      w6.child.exitCode === null && w6.child.signalCode === null,
      '写手进程尚未退出',
    );

    // 同一个修改集不能被认领两次。挡在最前面的是**一次性许可**（I06），
    // 而不是槽 —— 闸门跑在槽判定之前，因此这一次连「地问不问得到」都还没到。
    // 两层都要有：只靠许可的话，一条被重复用的许可就绕过了互斥；
    // 只靠槽的话，同一块地上的两次执行会共享一份批准。
    const duplicate = spawnWriter('try', [dbPath, c5.change_id, 'lease_ms=6000']);
    writers.push(duplicate);
    const dupLine = await duplicate.line();
    const dupOutcome = rec(dupLine.outcome);
    check(
      '负向：已消费的批准不能再启动第二次执行（一次性许可挡在槽判定之前）',
      dupOutcome.kind === 'refused' &&
        dupOutcome.reason === 'GATE_REFUSED' &&
        rec(dupOutcome.details).gate_reason === 'APPROVAL_CONSUMED',
      `reason=${str(dupOutcome.reason)} gate_reason=${str(rec(dupOutcome.details).gate_reason)}`,
    );

    const finished = await w6.line(30_000);
    const finalOutcome = rec(finished.outcome);
    check(
      '写盘结束后收尾落到 APPLIED（认领 → 写盘 → 收尾三段各自成事务）',
      finalOutcome.kind === 'finished' && finalOutcome.state === 'APPLIED',
      `kind=${str(finalOutcome.kind)} state=${str(finalOutcome.state)}`,
    );
    await w6.exited();
    check(
      '收尾之后修改集与操作都停在 APPLIED，finished_at 非空',
      repos.changes.requireById(c5.change_id).state === 'APPLIED' &&
        repos.operations.requireById(c5.operation_id).state === 'APPLIED' &&
        repos.operations.requireById(c5.operation_id).finished_at !== null,
      `change=${repos.changes.requireById(c5.change_id).state} finished_at=${String(repos.operations.requireById(c5.operation_id).finished_at)}`,
    );

    // -----------------------------------------------------------------------
    section('第 2 节 跨进程互斥（验收 1、验收 2、步骤 1、步骤 2）');

    const c1 = queuedChange('ev1', T1.workspace_id, CONNECTION_A, ['src/one.ts']);
    const c2 = queuedChange('ev2', T1.workspace_id, CONNECTION_B, ['src/two.ts']);
    check(
      '两个修改集属于两个**不同连接**、同一块物理工作区',
      repos.changes.requireById(c1.change_id).owner_connection_id === CONNECTION_A &&
        repos.changes.requireById(c2.change_id).owner_connection_id === CONNECTION_B,
      `${CONNECTION_A} / ${CONNECTION_B}`,
    );

    const w1 = spawnWriter('hold', [dbPath, c1.change_id, 'lease_ms=6000', 'heartbeat_ms=1200']);
    writers.push(w1);
    const claim1 = await w1.line();
    check(
      '写手 A 占住了工作区（状态机走到 VALIDATING、拿到栅栏令牌 1）',
      claim1.stage === 'claimed' && num(claim1.fencing_token) === 1,
      `fencing_token=${String(claim1.fencing_token)}`,
    );

    const slot1 = repos.write_slots.find(T1.volume_id, T1.root_file_id);
    check(
      '槽按物理身份落库，持有者 pid 是**另一个真实进程**',
      slot1 !== null && slot1.holder_pid === w1.pid && slot1.holder_pid !== process.pid,
      `slot.holder_pid=${String(slot1?.holder_pid)} 写手 pid=${w1.pid} 父进程 pid=${process.pid}`,
    );
    check(
      '槽上记着持有者的执行器标识，与写手自报的一致',
      slot1?.executor_id === claim1.executor_id,
      `slot.executor_id=${str(slot1?.executor_id)}`,
    );

    // 心跳真的在推 expires_at：读两次真行比对，不信 heartbeat() 的返回值。
    const beforeHeartbeat = str(slot1?.expires_at);
    await delay(1_600);
    const afterHeartbeat = str(repos.write_slots.find(T1.volume_id, T1.root_file_id)?.expires_at);
    check(
      '心跳把 expires_at 往后推了（租约在续，不是在倒计时等着被接管）',
      afterHeartbeat !== beforeHeartbeat && Date.parse(afterHeartbeat) > Date.parse(beforeHeartbeat),
      `${beforeHeartbeat} → ${afterHeartbeat}`,
    );

    // 步骤 2 的前半：持有者占着地的时候，父进程仍能写库。
    const writeStart = Date.now();
    const noise = queuedChangeBuiltOnly('noise', T2.workspace_id, CONNECTION_A);
    const writeMs = Date.now() - writeStart;
    check(
      '持有者执行期间，父进程仍能在 1 秒内写入状态库（认领是短事务）',
      writeMs < 1_000 && noise.change_id.length > 0,
      `耗时 ${writeMs}ms；busy_timeout=5000ms，被攥住的长事务会表现为卡顿或 SQLITE_BUSY`,
    );

    const snapshot2Before = snapshot(c2.change_id, T1);
    const w2 = spawnWriter('try', [dbPath, c2.change_id, 'lease_ms=6000']);
    writers.push(w2);
    const try2 = await w2.line();
    const outcome2 = rec(try2.outcome);
    check(
      '验收 1：第二个修改集被拒绝，而不是排队等待',
      outcome2.kind === 'refused' && outcome2.reason === 'SLOT_REFUSED',
      `kind=${str(outcome2.kind)} reason=${str(outcome2.reason)}`,
    );
    check(
      '拒绝的原因是「租约有效」—— 不是「查不清」也不是「持有者已死」',
      rec(outcome2.details).slot_reason === 'LEASE_VALID',
      `slot_reason=${str(rec(outcome2.details).slot_reason)}`,
    );
    check(
      '拒绝里带着物理身份，供排障的人核对是哪一块地',
      rec(outcome2.details).volume_id === T1.volume_id && rec(outcome2.details).root_file_id === T1.root_file_id,
      `${str(rec(outcome2.details).volume_id)} / ${str(rec(outcome2.details).root_file_id)}`,
    );
    const snapshot2After = snapshot(c2.change_id, T1);
    check(
      '一次拒绝**一寸都没动**：状态、批准、槽逐项相同',
      sameSnapshot(snapshot2Before, snapshot2After),
      snapshot2After.change_state === snapshot2After.operation_state ? '' : '（状态被改过）',
    );
    check(
      '被拒绝的那个修改集的批准仍未被消费',
      snapshot2After.approval_state === 'ACTIVE',
      `approval.state=${snapshot2After.approval_state}`,
    );
    check(
      '槽仍指着写手 A 的操作，栅栏令牌没有增加',
      snapshot2After.slot_operation_id === c1.operation_id &&
        snapshot2After.slot_fencing_token === 1 &&
        snapshot2After.slot_executor_id === str(claim1.executor_id),
      `operation=${String(snapshot2After.slot_operation_id)} token=${String(snapshot2After.slot_fencing_token)}`,
    );
    // 验收 2 的**正面**证明：另一块地上真的还能开工。
    //
    // 只断「另一块地没有槽行」是不够的 —— 那证明的是「还没有人用过它」，
    // 而不是「互斥没有把整台机器锁住」。因此这里造一个新修改集，让第三个
    // 写手进程去认领另一块地：它必须**拿到许可**。
    //
    // 它同时证了第二条性质：那块地上残留着第 1 节留下的槽行（上一次执行
    // 已经 APPLIED），而认领拿到的令牌是 **2** 而不是 1 —— 终态残留是被
    // **覆盖**的，不是被删掉重来。删掉再占会把令牌重置成 1，
    // 于是「令牌只增不减」这条性质就没了，而它正是接管判定的依据。
    const cOther = queuedChange('ev2b', T3.workspace_id, CONNECTION_B, ['src/other.ts']);
    const wOther = spawnWriter('try', [dbPath, cOther.change_id, 'lease_ms=6000']);
    writers.push(wOther);
    // 认领成功时写手报的是**顶层**的 `stage: 'claimed'`（它此刻就是事实
    // 本身），失败时才把 `outcome` 包进去。读错一层会让断言永远为假 ——
    // 而「永远为假」在 FAIL 一栏里和「真的没认领上」长得一样。
    const otherLine = await wOther.line();
    check(
      '验收 2：T1 被占着的时候，**另一块物理身份上仍能开工**（不是一把全局锁）',
      otherLine.stage === 'claimed' && otherLine.operation_id === cOther.operation_id,
      `stage=${str(otherLine.stage)} operation=${str(otherLine.operation_id)}`,
    );
    check(
      '另一块地上的残留槽行是被覆盖的：令牌 1 → 2，只增不减',
      num(otherLine.fencing_token) === 2,
      `fencing_token=${String(num(otherLine.fencing_token))}`,
    );
    check(
      '占地的是另一个执行器，而不是把写手 A 的槽改了个名',
      repos.write_slots.find(T3.volume_id, T3.root_file_id)?.executor_id !== str(claim1.executor_id) &&
        repos.write_slots.find(T1.volume_id, T1.root_file_id)?.operation_id === c1.operation_id,
      `T3.executor=${str(repos.write_slots.find(T3.volume_id, T3.root_file_id)?.executor_id)}`,
    );

    // 脱敏：拒绝详情里不得出现本机路径。
    const refusalText = JSON.stringify(outcome2.details);
    check('脱敏：拒绝详情里没有本机绝对路径', !leaksLocalPaths(refusalText), refusalText.slice(0, 160));

    check('写手 A 被真的杀掉，且探针确认它已消失', await w1.killAndConfirm(), `pid=${w1.pid}`);
    check(
      '被杀的写手在探针那里确实是 null（这是第 3 节「不在」那一半的地基）',
      nodeProcessProbe.identify(w1.pid) === null,
      `identify(${w1.pid}) = null`,
    );

    // -----------------------------------------------------------------------
    section('第 3 节 租约到期不得直接接管（验收 3、步骤 3）');

    const c3 = queuedChange('ev3', T2.workspace_id, CONNECTION_A, ['src/three.ts']);
    const c4 = queuedChange('ev4', T2.workspace_id, CONNECTION_B, ['src/four.ts']);

    // 写手 B 认领之后**故意不续约**，但进程活着 —— 这正是「休眠 / 断点 /
    // CPU 饥饿」在生产里的样子。
    const w3 = spawnWriter('stall', [dbPath, c3.change_id, 'lease_ms=2500']);
    writers.push(w3);
    const claim3 = await w3.line();
    check('写手 B 占住了第二块地', claim3.stage === 'claimed', `pid=${w3.pid}`);

    const expiredAt = await waitForLeaseExpiry(T2);
    const slot2 = repos.write_slots.find(T2.volume_id, T2.root_file_id);
    check(
      '写手 B 的租约确实过期了（时钟已越过 expires_at）',
      Date.now() >= expiredAt,
      `expires_at=${str(slot2?.expires_at)} 现在=${iso(Date.now())}`,
    );
    check(
      '写手 B **仍然活着** —— 这是本节的唯一变量',
      nodeProcessProbe.identify(w3.pid) !== null,
      `identify(${w3.pid}) ≠ null（真进程，真的还在）`,
    );

    const snapshot4Before = snapshot(c4.change_id, T2);
    const w4 = spawnWriter('try', [dbPath, c4.change_id, 'lease_ms=2500']);
    writers.push(w4);
    const try4 = await w4.line();
    const outcome4 = rec(try4.outcome);
    check(
      '验收 3：租约过期 + 持有者活着 ⇒ **拒绝**，不是接管',
      outcome4.kind === 'refused' &&
        outcome4.reason === 'SLOT_REFUSED' &&
        rec(outcome4.details).slot_reason === 'HELD_BY_LIVE_EXECUTOR',
      `kind=${str(outcome4.kind)} slot_reason=${str(rec(outcome4.details).slot_reason)}`,
    );
    const snapshot4After = snapshot(c4.change_id, T2);
    check(
      '拒绝的同时**没有**阻断这块地（阻断意味着要人来，而这里只需要等）',
      snapshot4After.slot_blocked_at === null,
      `blocked_at=${String(snapshot4After.slot_blocked_at)}`,
    );
    // 读的是 **c3** 的行，不是 c4 的 —— 要证明的是「上一个执行器的工作
    // 没有被这次拒绝顺手判死」。读 c4 会永远得到 `QUEUED`，而那条断言
    // 无论实现怎么做都会通过。
    const previousOperation = repos.operations.requireById(c3.operation_id);
    const previousChange = repos.changes.requireById(c3.change_id);
    check(
      '上一个操作**没有**被标成待恢复（字节下落未被写成「不确定」）',
      previousOperation.state === 'VALIDATING' && previousChange.state === 'VALIDATING',
      `前一操作=${previousOperation.state} 前一修改集=${previousChange.state}`,
    );
    check(
      '这一次拒绝同样一寸未动（状态、批准、槽逐项相同）',
      sameSnapshot(snapshot4Before, snapshot4After),
    );

    // 唯一变量对照：把「持有者活着」换成「持有者真的退出了」。
    check('写手 B 被真的杀掉', await w3.killAndConfirm(), `pid=${w3.pid}`);
    await waitForLeaseExpiry(T2);
    const w5 = spawnWriter('try', [dbPath, c4.change_id, 'lease_ms=2500']);
    writers.push(w5);
    const try5 = await w5.line();
    const outcome5 = rec(try5.outcome);
    check(
      '对照：同一个请求、同一块地，只把持有者换成「真的退出了」⇒ 变成**阻断**',
      outcome5.kind === 'blocked' && outcome5.reason === 'PREVIOUS_WRITE_OUTCOME_UNKNOWN',
      `kind=${str(outcome5.kind)} reason=${str(outcome5.reason)}`,
    );
    check(
      '阻断时把上一个操作标成待恢复，并如实报告标了谁',
      outcome5.recovered_previous === true && outcome5.previous_operation_id === c3.operation_id,
      `previous_operation_id=${str(outcome5.previous_operation_id)}`,
    );
    check(
      '上一个操作与它的修改集都停在待恢复（不是「已应用」也不是「失败」）',
      repos.operations.requireById(c3.operation_id).state === 'RECOVERY_REQUIRED' &&
        repos.changes.requireById(c3.change_id).state === 'RECOVERY_REQUIRED',
      `op=${repos.operations.requireById(c3.operation_id).state} change=${repos.changes.requireById(c3.change_id).state}`,
    );
    const slot2Blocked = repos.write_slots.find(T2.volume_id, T2.root_file_id);
    check(
      '地被阻断，但**栅栏令牌没有增加**（阻断不是一次接管）',
      slot2Blocked?.blocked_at !== null && slot2Blocked?.fencing_token === 1,
      `blocked_at=${String(slot2Blocked?.blocked_at)} token=${String(slot2Blocked?.fencing_token)}`,
    );
    check(
      '被阻断的修改集 c4 仍是 QUEUED，退回队列而不是被吃掉',
      repos.operations.requireById(c4.operation_id).state === 'QUEUED',
      `c4.operation=${repos.operations.requireById(c4.operation_id).state}`,
    );

    // -----------------------------------------------------------------------
    section('第 4 节 负向回归');

    // 4a 被阻断的地不会被重试解开。
    const blockedBefore = repos.write_slots.find(T2.volume_id, T2.root_file_id);
    const w7 = spawnWriter('try', [dbPath, c4.change_id, 'lease_ms=2500']);
    writers.push(w7);
    const retry = await w7.line();
    const retryOutcome = rec(retry.outcome);
    check(
      '负向：被阻断的工作区再试一次仍是阻断，不会被重试解开',
      retryOutcome.kind === 'already_blocked' || retryOutcome.kind === 'blocked',
      `kind=${str(retryOutcome.kind)}`,
    );
    const blockedAfter = repos.write_slots.find(T2.volume_id, T2.root_file_id);
    check(
      '负向：重试**没有**覆盖首次的阻断原因与时间',
      blockedAfter?.blocked_at === blockedBefore?.blocked_at &&
        blockedAfter?.blocked_reason === blockedBefore?.blocked_reason,
      `reason=${String(blockedAfter?.blocked_reason)}`,
    );

    // 4b 未阻断的地不能被「解除阻断」。
    const coordinator = new ExecutionCoordinator({
      repos,
      probe: nodeProcessProbe,
      apply: async (): Promise<ApplyReport> => ({ kind: 'applied' }),
      executor_id: 'exe_ev_main',
    });
    let notBlockedRefusal = '';
    try {
      coordinator.clearBlockade(T3.volume_id, T3.root_file_id);
      notBlockedRefusal = '(没有拒绝)';
    } catch (cause) {
      notBlockedRefusal = String(rec(rec(cause).details).reason ?? (cause as { message?: string }).message);
    }
    check(
      '负向：对未被阻断的地调用解除阻断会被拒绝',
      notBlockedRefusal === 'NOT_BLOCKED',
      `reason=${notBlockedRefusal}`,
    );

    // 4c 补排队只搬运**已批准**的决定，一格都不多搬。
    // 两个候选并排：一个已由本地批准（APPROVED、无操作行），一个从未批准
    // （PENDING_APPROVAL）。补排队应当只搬前者 —— 只验证「搬了一个」会让
    // 「两个都搬」通过，只验证「留下一个」会让「一个都不搬」通过。
    const approvedNoOp = pendingChange('ev6', T3.workspace_id, CONNECTION_A);
    const neverApproved = queuedChangeBuiltOnly('ev7', T3.workspace_id, CONNECTION_A).change_id;
    const moved = coordinator.enqueueApproved();
    check(
      '负向：补排队搬运已批准的那个（崩溃后补上「批准与排队是原子的」这半句）',
      moved === 1 &&
        repos.changes.requireById(approvedNoOp).state === 'QUEUED' &&
        repos.operations.findByChangeId(approvedNoOp) !== null,
      `搬运数=${moved} state=${repos.changes.requireById(approvedNoOp).state}`,
    );
    check(
      '负向：从未批准的那个**一格未动** —— 补排队不产生决定',
      repos.changes.requireById(neverApproved).state === 'PENDING_APPROVAL' &&
        repos.operations.findByChangeId(neverApproved) === null &&
        repos.approvals.listForChange(neverApproved).length === 0,
      `state=${repos.changes.requireById(neverApproved).state} 操作行=${String(repos.operations.findByChangeId(neverApproved))} 批准行数=${repos.approvals.listForChange(neverApproved).length}`,
    );

    // 4d 恢复流程是解除阻断的唯一入口 —— 而它此刻**必须拒绝**。
    //
    // `RECOVERY_REQUIRED` 刻意**不在** `TERMINAL_CHANGE_STATES` 里。终态的定义
    // 是「不可再回到可执行状态」，而待恢复的操作恰恰要回到 `APPLIED` 或
    // `ROLLED_BACK`（`OPERATION_TRANSITIONS.RECOVERY_REQUIRED` 的两条边）。
    // 于是「字节下落还没定案」这件事在解除阻断这一格是硬拦的：
    // 想解除，先走恢复流程（LWB-030）把上一笔定案。
    //
    // 这条负向比它看上去重要：如果解除阻断放行了 PREVIOUS_NOT_TERMINAL，
    // 那么一块被「写了一半」占着的地就能被清干净交给下一个写手，
    // 而那个写手会在一块内容不明的文件上按旧计划继续写。
    let recoveryRefusal = '(没有拒绝)';
    try {
      coordinator.clearBlockade(T2.volume_id, T2.root_file_id);
    } catch (cause) {
      recoveryRefusal = String(rec(rec(cause).details).reason ?? '(没有 reason)');
    }
    check(
      '负向：字节下落未定案时不许解除阻断（解除的前提是前驱操作已终结）',
      recoveryRefusal === 'PREVIOUS_NOT_TERMINAL',
      `reason=${recoveryRefusal}`,
    );
    const slot2StillBlocked = repos.write_slots.find(T2.volume_id, T2.root_file_id);
    check(
      '负向：被拒绝之后那块地仍然是阻断的（拒绝不改变任何东西）',
      slot2StillBlocked?.blocked_at !== null && slot2StillBlocked?.fencing_token === 1,
      `blocked_at=${String(slot2StillBlocked?.blocked_at)} token=${String(slot2StillBlocked?.fencing_token)}`,
    );
    note(
      '解除阻断的**成功**路径',
      'V1 里走不到：任何一次阻断都会把前驱操作标成 RECOVERY_REQUIRED，'
        + '而它要等恢复流程（LWB-030）才能终结。在此之前 clearBlockade 一律拒绝 —— '
        + '这是 fail-closed 的方向，不是缺陷。成功路径与「清标志不是删行、令牌原地保留」'
        + '由 tests/unit/executor-coordinator.test.ts 的 F2/F3 覆盖。',
    );

    // 4e 脱敏。判据取两条**可以失败**的性质：
    //  (a) 写手报上来的每一行里都没有文件系统路径 —— 拒绝与阻断的详情
    //      要能给模型看，因此它只能带 `(volume_id, root_file_id)` 这类标识，
    //      不能带用户机器上的目录名；
    //  (b) 没有任何一行里出现临时库文件的名字 —— 那是本机路径的一部分。
    const leakedPaths = workerLines.filter((line) => leaksLocalPaths(line));
    const leakedTemp = workerLines.filter((line) => line.includes('lwb-026-'));
    check(
      '脱敏：写手报告的事实里不含本机路径，只有物理身份标识',
      workerLines.length > 0 && leakedPaths.length === 0 && leakedTemp.length === 0,
      `${workerLines.length} 行；命中路径的行数=${leakedPaths.length}；命中临时目录的行数=${leakedTemp.length}`,
    );

    // -----------------------------------------------------------------------
    section('第 5 节 未执行项');
    skip(
      'HOLDER_STATUS_UNKNOWN（探针自身失败）',
      '在真机上无法按需让 process.kill(pid,0) 抛非 ESRCH 的异常；由单元测试 B3 覆盖',
    );
    skip(
      'PID 复用（同 pid、不同启动时刻）',
      '无法按需制造；由单元测试 B4 覆盖。生产可用 apps/daemon/src/lifecycle/ 的 startTimeOf 加固',
    );
    skip(
      '写入超时 / 心跳丢失 / 写盘人抛异常',
      '由单元测试 D1–D3 覆盖：这三条要么等 10 分钟，要么得让子进程真的卡死，取证性价比为负',
    );
    skip(
      '真实 ChatGPT 网页端验收（LWB-002）',
      '需要真实账号、Tunnel 与工作区管理权限，当前 BLOCKED；MCP Inspector 成功不能替代',
    );
    skip('字节真的落到用户文件上', '属 LWB-027；本任务的写盘人是**故意**的假件');
    skip('恢复流程真正把字节定案', '属 LWB-030；本任务只到「标成待恢复」为止');
    skip('change_apply 工具对模型可见', '属 LWB-032；协调器尚未接入工具面，这是有意的');
  } finally {
    for (const writer of writers) {
      if (writer.child.exitCode === null && writer.child.signalCode === null) writer.child.kill('SIGKILL');
    }
    if (opened !== undefined) closeDatabase(opened.db);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(`\n小计：PASS=${passes} FAIL=${failures} NOT_RUN=${skips}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
