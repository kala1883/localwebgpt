/**
 * LWB-031 真 NTFS 验收：安全撤销提议。
 *
 * ## 这条链子上「真的」是哪几节
 *
 * 从磁盘到撤销，全程没有一节是桩：
 *
 *  真 NTFS 文件 → 真 `PowerShellWinfsBackend`（句柄级身份复核）→ 真票据权威 →
 *  真 `prepareChange`（重读、切片、落快照）→ 真本地批准 → 真
 *  `ExecutionCoordinator` + 真 `WriteFileGuarded` → **盘上真的变了一个文件** →
 *  真 `planRevert` / `prepareRevert`。
 *
 * 因此每一条断言打的是**字节**，不是措辞：
 *
 *  - 验收 1（后续人工修改不会被回滚覆盖）：人改过之后撤销**连修改集都建不出来**，
 *    而且用文件指纹（大小 + 修改时刻 + 内容哈希）证明**一个字节都没被碰**；
 *  - 验收 2（旧回执不可被篡改成「未发生」）：把源修改集、它的条目、它的操作、
 *    它的逐条目回执**四张表整行**取出来做指纹，撤销前后必须逐字相同；
 *  - 验收 3（不改变 Git 暂存区、不执行 `reset --hard`）：真的 `git init` 一个仓库、
 *    真的制造一个脏工作区与**已暂存的改动**，撤销前后比 `.git/index` 的字节、
 *    `git status --porcelain` 的输出与 HEAD。
 *
 * ## 反过来说，哪些话本文件**不**说
 *
 * 「撤销之后的字节回到基线」在本文件里是**端到端**证的：逆提案经真批准、真
 * 执行器写下去，再与执行之前的快照逐字节比。因此它不依赖「引擎算出来的
 * 哈希等于基线哈希」这一句中间推理 —— 那一句在 `revert.ts` 里是**闸门**
 * （算不对就拒绝），在这里是被**复核**的对象。
 *
 * 「进程被杀」没有构造（属 LWB-033）；「并发两个撤销」也没有构造。
 * 这两条在 `docs/evidence/lwb-031/summary.md` 里标 `NOT_RUN`，不与 PASS 合并。
 *
 * ## 装置自检
 *
 * 有三处「如果装置没生效，断言就在证明一件没发生的事」：
 *
 *  1. 「身份被换掉」那一格靠**删除重建**造出来，靠的是 NTFS 文件索引会变。
 *     若索引没变，用例报的是「装置不可用」，不是通过；
 *  2. 「人改过」那一格必须先确认人写下去的字节**真的与执行结果不同**，
 *     否则撤销那边返回的「无事可做」会被误读成「不肯覆盖」；
 *  3. Git 那一格必须先确认工作区**真的是脏的**且暂存区**真的有内容**。
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { approveAndQueue } from '@lwb/approvals';
import { BlobStore } from '@lwb/blob-store';
import { planRevert, prepareChange, prepareRevert, REVERT_JOURNAL_STAGES } from '@lwb/changes';
import type { PrepareChangeArgs, PrepareChangeDeps, RevertPlan, RevertPrepareArgs } from '@lwb/changes';
import { BridgeError, CONTRACT_VERSION, LIMITS } from '@lwb/contracts';
import type { ChangeItem, ChangeRevertPrepareData } from '@lwb/contracts';
import { ALL_ITEM_STAGES, createNativeApplier, ExecutionCoordinator, ITEM_STAGE } from '@lwb/executor';
import { createReadTicketAuthority, inspectBytes } from '@lwb/files';
import type { ReadScope, ReadTicketAuthority, ReadTicketFacts } from '@lwb/files';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { OpenDatabaseResult } from '@lwb/persistence';
import { isWinfsError, PowerShellWinfsBackend } from '@lwb/winfs';
import type { WinfsOps } from '@lwb/winfs';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;

const CONNECTION = 'conn_rev';
const OTHER_CONNECTION = 'conn_rev_other';
const WORKSPACE = 'ws_rev';
const OTHER_WORKSPACE = 'ws_rev_other';
const PRINCIPAL = 'principal_rev';
const POLICY_VERSION = 1;
const MODE = 'read_propose_apply_with_local_approval';
const KEY = 'lwb-revert-test-key-0123456789abcdef0123';
const CONTRACT = CONTRACT_VERSION;

const authority: ReadTicketAuthority = createReadTicketAuthority({ key: KEY });

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'LWB',
  GIT_AUTHOR_EMAIL: 'lwb@example.invalid',
  GIT_COMMITTER_NAME: 'LWB',
  GIT_COMMITTER_EMAIL: 'lwb@example.invalid',
};

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** 一条修改：把某个文件的某一行改成另一个字符串。 */
interface EditSpec {
  readonly path: string;
  readonly before: Buffer;
  /** 1 起数。 */
  readonly line: number;
  /** 那一行**此刻**是什么。用来给装置自检：声明与字节必须对得上。 */
  readonly at: string;
  readonly to: string;
}

interface CreateSpec {
  readonly path: string;
  readonly content: string;
  readonly newline: 'lf' | 'crlf';
  readonly bom: boolean;
}

const lf = (text: string): Buffer => Buffer.from(text, 'utf8');
const bomCrlf = (text: string): Buffer =>
  Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text.split('\n').join('\r\n'), 'utf8')]);

describeWindows('LWB-031 真 NTFS：安全撤销提议', () => {
  let sandbox = '';
  let backend: PowerShellWinfsBackend;
  let opened: OpenDatabaseResult | undefined;
  let repos: Repositories;
  let seq = 0;

  const nextId = (prefix: string): string => `${prefix}_${(seq += 1).toString().padStart(4, '0')}`;

  before(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-revert-'));
    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(capability.available, true, `护栏后端不可用：${capability.resolved_backend_reason}`);
  });

  after(async () => {
    if (opened !== undefined) closeDatabase(opened.db);
    await backend?.dispose();
    await rm(sandbox, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 装置
  // -------------------------------------------------------------------------

  interface Rig {
    readonly dir: string;
    readonly change_id: string;
    readonly scope: ReadScope;
    readonly deps: PrepareChangeDeps;
    readonly abs: (relative: string) => string;
    readonly onDisk: (relative: string) => Promise<Buffer>;
    /** 大小 + 修改时刻 + 内容哈希。**只比内容会放过「把同样的字节再写一遍」**。 */
    readonly fp: (relative: string) => Promise<string>;
    readonly observed: (relative: string) => Promise<string>;
    readonly planRevert: (over?: Partial<RevertPrepareArgs>) => Promise<RevertPlan>;
    readonly prepareRevert: (key: string, over?: Partial<RevertPrepareArgs>) => Promise<ChangeRevertPrepareData>;
    /** 四张源表整行的指纹。**任何一列变了都会变。** */
    readonly sourceFingerprint: () => string;
    readonly changeRow: () => { state: string; digest: string; expires_at: string };
    /** 夹具那条操作的 id —— G 组要往它的执行日志里追加真行。 */
    readonly operationId: () => string;
    readonly sourceItems: () => {
      id: string;
      seq: number;
      canonical_path: string;
      base_sha256: string | null;
      target_sha256: string;
    }[];
    readonly journal: () => { seq: number; item_id: string | null; stage: string; target_sha256: string | null }[];
    /** 走完整条路：批准 → 执行器 → 落盘。 */
    readonly runRevertProposal: (data: ChangeRevertPrepareData) => Promise<void>;
  }

  async function rig(
    seed: string,
    spec: { readonly edits?: readonly EditSpec[]; readonly creates?: readonly CreateSpec[]; readonly git?: boolean },
  ): Promise<Rig> {
    if (opened !== undefined) closeDatabase(opened.db);
    const dir = path.join(sandbox, seed);
    await mkdir(dir, { recursive: true });

    for (const edit of spec.edits ?? []) {
      const target = path.join(dir, ...edit.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, edit.before);
    }

    if (spec.git === true) {
      const git = (args: readonly string[]): string =>
        execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
      git(['init', '--quiet', '--initial-branch=main']);
      git(['config', 'core.autocrlf', 'false']);
      git(['add', '-A']);
      git(['commit', '--quiet', '-m', '基线提交']);
    }

    opened = openDatabase({ path: ':memory:' });
    repos = new Repositories(opened.db);
    const objectsRoot = path.join(sandbox, `${seed}-objects`);
    const blobs = new BlobStore({ objectsRoot, registry: repos.blobs, newId: () => nextId('blob') });

    const volume = await backend.statVolume({ path: dir });
    assert.equal(volume.ok, true, `statVolume 失败：${JSON.stringify(volume)}`);
    if (isWinfsError(volume)) throw new Error('上面一行已经断言过');

    repos.connections.create({
      id: CONNECTION,
      principal_kind: 'model_surface',
      principal_id: PRINCIPAL,
      alias: '撤销测试连接',
      enabled: true,
    });
    repos.connections.create({
      id: OTHER_CONNECTION,
      principal_kind: 'model_surface',
      principal_id: 'principal_rev_other',
      alias: '别的连接',
      enabled: true,
    });
    repos.workspaces.create({
      id: WORKSPACE,
      alias: '撤销测试工作区',
      kind: 'directory',
      canonical_root: dir,
      volume_id: volume.volume_id,
      root_file_id: volume.file_id,
      policy_version: POLICY_VERSION,
      mode: MODE,
    });
    // 别的工作区要有**自己的根**：`(volume_id, root_file_id)` 在库里是唯一的，
    // 两个工作区挂同一个目录本来就该被拒绝。
    const otherDir = path.join(sandbox, `${seed}-other`);
    await mkdir(otherDir, { recursive: true });
    const otherVolume = await backend.statVolume({ path: otherDir });
    assert.equal(otherVolume.ok, true, `statVolume(别的根) 失败：${JSON.stringify(otherVolume)}`);
    if (isWinfsError(otherVolume)) throw new Error('上面一行已经断言过');
    repos.workspaces.create({
      id: OTHER_WORKSPACE,
      alias: '别的工作区',
      kind: 'directory',
      canonical_root: otherDir,
      volume_id: otherVolume.volume_id,
      root_file_id: otherVolume.file_id,
      policy_version: POLICY_VERSION,
      mode: MODE,
    });
    const generation = repos.workspaces.requireById(WORKSPACE).generation;

    const scope: ReadScope = {
      workspace_id: WORKSPACE,
      kind: 'directory',
      mode: MODE,
      generation,
      root_path: dir,
      root_volume_id: volume.volume_id,
      root_file_id: volume.file_id,
    };

    const deps: PrepareChangeDeps = { ops: backend, authority, blobs, repos, newId: () => nextId('id') };

    // ---- 建条目：票据与基线哈希全部来自**真实读取** ----------------------
    const items: ChangeItem[] = [];
    for (const edit of spec.edits ?? []) {
      const read = await backend.readFileGuarded({
        root_path: dir,
        root_volume_id: volume.volume_id,
        root_file_id: volume.file_id,
        relative_path: edit.path,
      });
      assert.equal(read.ok, true, `读取基线失败：${JSON.stringify(read)}`);
      if (isWinfsError(read)) throw new Error('上面一行已经断言过');

      const decoded = inspectBytes(edit.before);
      assert.equal(decoded.kind, 'text', `夹具 ${edit.path} 必须是文本`);
      if (decoded.kind !== 'text') throw new Error('上面一行已经断言过');

      // `LineIndex` 的 starts/ends 是**解码后字符串**的下标，不是字节偏移
      // （中文一个字三个字节，两者不重合）。行体里不带终止符 —— 换行由
      // 目标文件决定，因此 `LineEdit` 的世界里一律用 `\n` 表达。
      const start = decoded.lines.starts[edit.line - 1];
      const end = decoded.lines.ends[edit.line - 1];
      assert.ok(start !== undefined && end !== undefined, `夹具 ${edit.path} 没有第 ${edit.line} 行`);
      const oldText = decoded.text.slice(start, end);
      // 装置自检：从字节里切出来的那一行必须与夹具声明的字面量相等。
      // 少了这一句，夹具与引擎用的是同一套约定，两边一起错也测不出来。
      assert.equal(oldText, edit.at, `装置自检：夹具 ${edit.path} 第 ${edit.line} 行的内容与声明不符`);
      const oldLines: string[] = [oldText];

      const facts: ReadTicketFacts = {
        connection_id: CONNECTION,
        workspace_id: WORKSPACE,
        generation,
        canonical_path: edit.path,
        volume_id: volume.volume_id,
        file_id: read.identity.file_id,
        raw_bytes_sha256: read.sha256,
        size: read.size,
        total_lines: decoded.lines.total_lines,
        range_start: 1,
        range_end_exclusive: decoded.lines.total_lines + 1,
        truncated: false,
        truncated_lines: [],
        editable: true,
        editable_blockers: [],
        redacted: false,
      };

      items.push({
        op: 'edit_text',
        path: edit.path,
        base_sha256: read.sha256,
        read_token: authority.mintReadTicket(facts, { now: Date.now(), ttl_ms: LIMITS.READ_TOKEN_TTL_MS }),
        edits: [{ start_line: edit.line, end_line_exclusive: edit.line + 1, old_lines: oldLines, new_lines: [edit.to] }],
      });
    }
    for (const create of spec.creates ?? []) {
      items.push({ op: 'create_text', path: create.path, content: create.content, newline: create.newline, bom: create.bom });
    }
    assert.ok(items.length > 0, '夹具至少要有内容');

    const input = { workspace_id: WORKSPACE, idempotency_key: `seed-${seed}`, summary: `夹具 ${seed}`, items };
    const prepareArgs: PrepareChangeArgs = {
      principal_id: PRINCIPAL,
      connection_id: CONNECTION,
      workspace_id: WORKSPACE,
      generation,
      policy_version: POLICY_VERSION,
      scope,
      now: Date.now(),
      input,
    };
    const created = await prepareChange(prepareArgs, deps);

    approveAndQueue({
      repos,
      change_id: created.change_id,
      digest: created.digest,
      actor: 'console:撤销真盘测试',
      now: new Date().toISOString(),
      idempotency_key: `approve-${seed}`,
    });

    const coordinator = new ExecutionCoordinator({
      repos,
      probe: {
        identify: () => {
          throw new Error('本用例不该问进程探针：认领时这块地是空的');
        },
      },
      apply: createNativeApplier({ repos, ops: backend, blobs }),
      executor_id: `exe_${seed}`,
      holder: { pid: process.pid, started_at: new Date(Date.now() - 60_000).toISOString() },
      lease_ms: 30_000,
      now: () => Date.now(),
    });
    const outcome = await coordinator.runOnce();
    assert.equal(outcome.kind, 'finished', `执行没有走到终局：${JSON.stringify(outcome)}`);
    if (outcome.kind !== 'finished') throw new Error('上面一行已经断言过');
    assert.equal(outcome.state, 'APPLIED', `夹具的执行没有成功：${outcome.detail}`);
    assert.equal(repos.changes.requireById(created.change_id).state, 'APPLIED');

    const rows = (sql: string, ...params: unknown[]): unknown =>
      opened?.db.prepare(sql).all(...(params as never[])) ?? null;

    const revertArgs = (key: string, over: Partial<RevertPrepareArgs> = {}): RevertPrepareArgs => ({
      principal_id: PRINCIPAL,
      connection_id: CONNECTION,
      workspace_id: WORKSPACE,
      generation,
      policy_version: POLICY_VERSION,
      scope,
      now: Date.now(),
      input: { change_id: created.change_id, idempotency_key: key },
      ...over,
    });

    return {
      dir,
      change_id: created.change_id,
      scope,
      deps,
      abs: (relative) => path.join(dir, ...relative.split('/')),
      onDisk: (relative) => readFile(path.join(dir, ...relative.split('/'))),
      fp: async (relative) => {
        const abs = path.join(dir, ...relative.split('/'));
        const info = await stat(abs);
        return `${info.size}:${info.mtimeMs}:${sha256(await readFile(abs))}`;
      },
      /** 只回观测值的指纹：撤销**不该**改变盘上任何东西，包括时刻。 */
      observed: async (relative) => sha256(await readFile(path.join(dir, ...relative.split('/')))),
      planRevert: (over) => planRevert(revertArgs('rev-key-1', over), deps),
      prepareRevert: (key, over) => prepareRevert(revertArgs(key, over), deps),
      sourceFingerprint: () =>
        JSON.stringify({
          changeset: rows('SELECT * FROM changesets WHERE id = ?', created.change_id),
          items: rows('SELECT * FROM change_items WHERE change_id = ? ORDER BY seq ASC', created.change_id),
          operations: rows('SELECT * FROM operations WHERE change_id = ?', created.change_id),
          results: rows(
            'SELECT r.* FROM operation_item_results r JOIN operations o ON o.id = r.operation_id WHERE o.change_id = ? ORDER BY r.item_id ASC',
            created.change_id,
          ),
        }),
      changeRow: () => {
        const row = repos.changes.requireById(created.change_id);
        return { state: row.state, digest: row.digest, expires_at: row.expires_at };
      },
      /** 夹具那条操作 —— G 组要往它的**执行日志**里追加行。 */
      operationId: () => {
        const op = rows('SELECT id FROM operations WHERE change_id = ?', created.change_id) as { id: string }[];
        assert.equal(op.length, 1, '装置自检：夹具应当恰好有一条操作');
        return op[0]!.id;
      },
      sourceItems: () =>
        rows(
          'SELECT id, seq, canonical_path, base_sha256, target_sha256 FROM change_items WHERE change_id = ? ORDER BY seq ASC',
          created.change_id,
        ) as { id: string; seq: number; canonical_path: string; base_sha256: string | null; target_sha256: string }[],
      journal: () => {
        const op = rows('SELECT id FROM operations WHERE change_id = ?', created.change_id) as { id: string }[];
        return rows(
          'SELECT seq, item_id, stage, target_sha256 FROM journal_entries WHERE operation_id = ? ORDER BY seq ASC',
          op[0]!.id,
        ) as { seq: number; item_id: string | null; stage: string; target_sha256: string | null }[];
      },
      /** 把一份撤销提案**真的执行掉** —— 用同一条批准 + 执行器路径。 */
      runRevertProposal: async (data) => {
        assert.ok(data.change !== null, '本方法只在有提案时调用');
        const change = data.change;
        if (change === null) return;
        assert.equal(repos.changes.requireById(change.change_id).state, 'PENDING_APPROVAL', '撤销提案必须先等人批准');
        approveAndQueue({
          repos,
          change_id: change.change_id,
          digest: change.digest,
          actor: 'console:撤销真盘测试',
          now: new Date().toISOString(),
          idempotency_key: `approve-revert-${change.change_id}`,
        });
        const second = new ExecutionCoordinator({
          repos,
          probe: {
            identify: () => {
              throw new Error('本用例不该问进程探针');
            },
          },
          apply: createNativeApplier({ repos, ops: backend, blobs }),
          executor_id: `exe_rev_${change.change_id}`,
          holder: { pid: process.pid, started_at: new Date(Date.now() - 60_000).toISOString() },
          lease_ms: 30_000,
          now: () => Date.now(),
        });
        const result = await second.runOnce();
        assert.equal(result.kind, 'finished', `撤销的执行没有走到终局：${JSON.stringify(result)}`);
        if (result.kind !== 'finished') throw new Error('上面一行已经断言过');
        assert.equal(result.state, 'APPLIED', `撤销的执行没有成功：${result.detail}`);
      },
    };
  }

  /** 断言一次调用以指定的码与理由失败，且**没有**新建修改集。 */
  async function expectRevertError(
    r: Rig,
    promise: Promise<unknown>,
    code: string,
    reason: string | null,
  ): Promise<BridgeError> {
    const before = repos.changes.list({ limit: 500 }).length;
    let caught: unknown;
    try {
      await promise;
    } catch (cause) {
      caught = cause;
    }
    assert.ok(caught instanceof BridgeError, `期望 BridgeError（${code}/${reason}），实际得到 ${String(caught)}`);
    assert.equal(caught.code, code, `错误码不符：${caught.message}`);
    if (reason !== null) {
      assert.equal(caught.details?.['reason'], reason, `错误理由不符：${JSON.stringify(caught.details)}`);
    }
    assert.equal(repos.changes.list({ limit: 500 }).length, before, '失败的撤销不得留下修改集');
    return caught;
  }

  const EDITS: readonly EditSpec[] = [
    { path: 'src/a.txt', before: lf('第一行\n第二行\n第三行\n'), line: 2, at: '第二行', to: '改过的第二行' },
  ];

  const CRLF_EDIT: readonly EditSpec[] = [
    { path: 'docs/b.txt', before: bomCrlf('甲\n乙\n丙\n'), line: 2, at: '乙', to: '乙改' },
  ];

  // -------------------------------------------------------------------------
  // A 组 —— 产物本身
  // -------------------------------------------------------------------------

  it('A1：一条无人碰过的改写 ⇒ REVERTIBLE，逆提案是整文件 replace_text，基线是**当前**盘上那一份', async () => {
    const r = await rig('a1', { edits: EDITS });
    const onDisk = await r.onDisk('src/a.txt');

    const plan = await r.planRevert();

    assert.equal(plan.source_change_id, r.change_id);
    assert.equal(plan.items.length, 1);
    const entry = plan.items[0]!;
    assert.equal(entry.verdict, 'REVERTIBLE', `理由 ${entry.reason}：${entry.detail}`);
    assert.equal(entry.reason, null);
    assert.equal(entry.op, 'edit_text', '来源条目是行编辑');
    assert.equal(entry.observed_path, 'src/a.txt');
    assert.equal(entry.observed_sha256, sha256(onDisk), '观测值必须就是盘上那一份');
    assert.equal(entry.expected_sha256, sha256(onDisk), '比对标的是执行回执里**观测到**的哈希');

    assert.equal(plan.proposal.length, 1);
    const item = plan.proposal[0]!;
    assert.equal(item.op, 'replace_text', '行编辑的逆操作是整文件替换 —— 逐行逆推做不到逐字节还原');
    if (item.op !== 'replace_text') throw new Error('上面一行已经断言过');
    assert.equal(item.path, 'src/a.txt');
    assert.equal(item.base_sha256, sha256(onDisk), '票据绑定的基线是「此刻盘上的字节」');
    assert.equal(item.content, '第一行\n第二行\n第三行\n', 'content 一律用 \\n 表达，风格由目标文件决定');
    assert.deepEqual(plan.local_actions, []);
  });

  it('A2：CRLF + BOM 的文件也能逐字节倒推（引擎重算出来必须等于基线）', async () => {
    const r = await rig('a2', { edits: CRLF_EDIT });
    const before = CRLF_EDIT[0]!.before;
    const onDisk = await r.onDisk('docs/b.txt');
    assert.notEqual(sha256(onDisk), sha256(before), '装置自检：执行必须真的改过这个文件');

    const plan = await r.planRevert();
    assert.equal(plan.items[0]!.verdict, 'REVERTIBLE');
    // CR 不进 content：它由目标文件的风格决定。
    const inverse = plan.proposal[0]!;
    assert.equal(inverse.op, 'replace_text');
    if (inverse.op !== 'replace_text') throw new Error('上面一行已经断言过');
    assert.equal(inverse.content, '甲\n乙\n丙\n');

    // 端到端：批准 + 执行，然后与**执行之前**的字节逐字节比。
    const data = await r.prepareRevert('a2-key');
    await r.runRevertProposal(data);

    const restored = await r.onDisk('docs/b.txt');
    assert.equal(sha256(restored), sha256(before), '撤销之后的字节必须与执行之前逐字节相同');
    assert.equal(Buffer.compare(restored, before), 0, '不止哈希相等，字节也逐位相等');
  });

  it('A3：撤销是**新的**修改集 —— 新的 id、新的摘要、仍需独立批准', async () => {
    const r = await rig('a3', { edits: EDITS });
    const sourceBefore = r.changeRow();

    const data = await r.prepareRevert('a3-key');
    assert.ok(data.change !== null, '有可撤销的条目时应当给出提案');
    const proposal = data.change;
    if (proposal === null) return;

    assert.notEqual(proposal.change_id, r.change_id, '撤销建的是新的修改集');
    assert.notEqual(proposal.digest, sourceBefore.digest, '摘要必须不同：它绑定的字节不同');
    assert.equal(proposal.state, 'PENDING_APPROVAL', '**不直接恢复**：它要靠自己的本地批准');
    assert.equal(proposal.approval_required, true);
    assert.equal(proposal.workspace_modified, false, '提议阶段工作区一个字节都没变');
    assert.equal(data.local_action_required, false);
    assert.equal(data.local_action_reason, null);
    // 逆提案的预览：从当前内容回到基线。
    assert.equal(proposal.files[0]?.before_sha256, sha256(await r.onDisk('src/a.txt')));
    assert.equal(proposal.files[0]?.op, 'replace_text');

    // 源修改集原样不动。
    assert.deepEqual(r.changeRow(), sourceBefore);
  });

  it('A4：同一个幂等键重放 ⇒ 同一份提案；换个键 ⇒ 另一份', async () => {
    const r = await rig('a4', { edits: EDITS });

    const first = await r.prepareRevert('same-key');
    const replay = await r.prepareRevert('same-key');
    assert.equal(replay.change?.change_id, first.change?.change_id, '重放必须回同一份，而不是再建一份');
    assert.equal(replay.change?.digest, first.change?.digest, '重放要自报是重放');

    const other = await r.prepareRevert('other-key');
    assert.notEqual(other.change?.change_id, first.change?.change_id, '换一个键就是另一次撤销提议');
    assert.equal(repos.changes.list({ limit: 500 }).length, 3, '两个键 + 源修改集');
  });

  it('A5：撤销抄的那份执行日志阶段名，与执行器权威定义**逐键**相同', () => {
    // `@lwb/changes` 不能 import `@lwb/executor`（会成环），所以那几个阶段名
    // 是抄来的字面量。抄写没有测试兜着迟早会漂，而漂的方向很坏：
    // 认不出的阶段一律落进 `unaccounted`，撤销会**静默停摆**。
    const mine = REVERT_JOURNAL_STAGES as Record<string, string>;
    const theirs = ITEM_STAGE as Record<string, string>;
    const authority = new Set<string>(ALL_ITEM_STAGES);

    // 一、逐键相等。**这一条不能省。** 只比两个集合是否相等的话，
    //     把 `verified` 与 `failed` 对调仍然"相等"，而语义正好相反 ——
    //     一边说"写好了、回读核过"，另一边说"失败了"，撤销会把失败的当成成功。
    for (const key of Object.keys(mine)) {
      assert.equal(mine[key], theirs[key], `阶段名 ${key} 与执行器不一致：撤销抄的是 ${mine[key]}，执行器是 ${theirs[key]}`);
    }

    // 二、覆盖。执行器能写出的阶段，撤销必须**每一个都有意见** ——
    //     没有意见就会掉进 `default`，那是安全的，但那是"不知道"，
    //     而这里要保证的是"知道"。执行器将来加了新阶段，这条会红，
    //     逼人做一次显式决定，而不是让撤销悄悄少认一格。
    for (const key of Object.keys(theirs)) {
      assert.ok(key in mine, `执行器有阶段 ${key}（${theirs[key]}），撤销不认识它 —— 请显式决定它归哪一格`);
    }
    assert.equal(Object.keys(mine).length, Object.keys(theirs).length, '两份清单的键数必须相同（防单边新增）');

    // 三、值域。抄来的字面量必须是执行器真的会写进日志的那些。
    for (const value of Object.values(mine)) {
      assert.ok(authority.has(value), `撤销认的阶段名 ${value} 不在执行器的阶段词表里 —— 抄错了`);
    }
    assert.equal(new Set(Object.values(mine)).size, Object.keys(mine).length, '阶段名不得重复（两份键指向同一个阶段会让折叠出歧义）');
  });

  // -------------------------------------------------------------------------
  // B 组 —— 验收 1：后续人工修改不会被回滚覆盖
  // -------------------------------------------------------------------------

  it('B1：应用之后人又改了 ⇒ 冲突、**不建修改集**，而且人的字节一个都没被碰', async () => {
    const r = await rig('b1', { edits: EDITS });
    const mine = lf('第一行\n我自己改的第二行\n第三行\n');
    await writeFile(r.abs('src/a.txt'), mine);

    const applied = await r.observed('src/a.txt');
    assert.notEqual(applied, sha256(EDITS[0]!.before), '装置自检：人的改动必须真的与基线不同');
    const fpBefore = await r.fp('src/a.txt');
    const sourceBefore = r.sourceFingerprint();

    const plan = await r.planRevert();
    assert.equal(plan.items[0]!.verdict, 'CONFLICT');
    assert.equal(plan.items[0]!.reason, 'THIRD_CONTENT');
    assert.deepEqual(plan.proposal, [], '有冲突时不产出任何条目');

    await expectRevertError(r, r.prepareRevert('b1-key'), 'FILE_VERSION_CONFLICT', 'THIRD_CONTENT');

    assert.equal(await r.fp('src/a.txt'), fpBefore, '文件指纹（大小 + 时刻 + 内容）一个字都没变');
    assert.equal(r.sourceFingerprint(), sourceBefore, '源回执同样一个字都没变');
  });

  it('B2：人手工把文件改回基线 ⇒ ALREADY_ORIGINAL，不建修改集，也不动文件', async () => {
    const r = await rig('b2', { edits: EDITS });
    const original = EDITS[0]!.before;
    await writeFile(r.abs('src/a.txt'), original);
    const fpBefore = await r.fp('src/a.txt');

    const plan = await r.planRevert();
    assert.equal(plan.items[0]!.verdict, 'ALREADY_ORIGINAL');
    assert.equal(plan.items[0]!.reason, null);
    assert.deepEqual(plan.proposal, []);

    await expectRevertError(r, r.prepareRevert('b2-key'), 'CHANGE_STATE_INVALID', 'NOTHING_TO_REVERT');
    assert.equal(await r.fp('src/a.txt'), fpBefore);
  });

  it('B3：应用之后目标被删掉 ⇒ OBJECT_MISSING（「不在」不等于「回到原状」）', async () => {
    const r = await rig('b3', { edits: EDITS });
    await rm(r.abs('src/a.txt'));

    const plan = await r.planRevert();
    assert.equal(plan.items[0]!.verdict, 'CONFLICT');
    assert.equal(plan.items[0]!.reason, 'OBJECT_MISSING');
    await expectRevertError(r, r.prepareRevert('b3-key'), 'FILE_VERSION_CONFLICT', 'OBJECT_MISSING');
  });

  it('B4：删除重建（内容一模一样）⇒ REPLACED_OBJECT —— 内容对得上也不写', async () => {
    const r = await rig('b4', { edits: EDITS });
    const same = await r.onDisk('src/a.txt');
    await rm(r.abs('src/a.txt'));
    await writeFile(r.abs('src/a.txt'), same);
    assert.equal(sha256(await r.onDisk('src/a.txt')), sha256(same), '装置自检：内容必须完全一样');

    const plan = await r.planRevert();
    assert.equal(plan.items[0]!.verdict, 'CONFLICT');
    assert.equal(
      plan.items[0]!.reason,
      'REPLACED_OBJECT',
      '内容一致但对象换了：写回去会写到批准范围之外的那个对象上',
    );
    assert.ok(
      plan.items[0]!.detail.includes('另一个对象'),
      `说明里必须点出「对象换了」而不是「内容变了」：${plan.items[0]!.detail}`,
    );
    await expectRevertError(r, r.prepareRevert('b4-key'), 'FILE_VERSION_CONFLICT', 'REPLACED_OBJECT');
  });

  it('B5：一条冲突挡住**整件事** —— 能撤的那一个也不建（不做部分撤销）', async () => {
    const r = await rig('b5', {
      edits: [
        { path: 'src/a.txt', before: lf('甲\n乙\n'), line: 2, at: '乙', to: '乙改' },
        { path: 'src/c.txt', before: lf('丙\n丁\n'), line: 2, at: '丁', to: '丁改' },
      ],
    });
    await writeFile(r.abs('src/c.txt'), lf('丙\n别人改的\n'));

    const plan = await r.planRevert();
    assert.deepEqual(
      plan.items.map((entry) => entry.verdict),
      ['REVERTIBLE', 'CONFLICT'],
      '计划要**逐条说全**，而不是只报挡路的那一条',
    );

    const error = await expectRevertError(r, r.prepareRevert('b5-key'), 'FILE_VERSION_CONFLICT', 'THIRD_CONTENT');
    assert.ok(error.message.includes('src/c.txt'), `挡路的文件必须被指名：${error.message}`);
    assert.equal(repos.changes.list({ limit: 500 }).length, 1, '只有源修改集，一份新提案都没有');
  });

  // -------------------------------------------------------------------------
  // C 组 —— 验收 2：旧回执不可被篡改成「未发生」
  // -------------------------------------------------------------------------

  it('C1：撤销前后，源修改集/条目/操作/逐条目回执**四张表整行**逐字相同', async () => {
    const r = await rig('c1', { edits: EDITS });
    const before = r.sourceFingerprint();
    const rowBefore = r.changeRow();

    const plan = await r.planRevert();
    assert.equal(plan.items[0]!.verdict, 'REVERTIBLE');
    assert.equal(r.sourceFingerprint(), before, '只读规划不得改动源记录的任何一列');

    const data = await r.prepareRevert('c1-key');
    assert.ok(data.change !== null);
    assert.equal(r.sourceFingerprint(), before, '建立撤销集同样不得改动源记录的任何一列');
    assert.deepEqual(r.changeRow(), rowBefore, '源修改集仍然是 APPLIED，摘要与期限一个字都没变');

    // 真执行一次 —— 撤销**仍然**不许碰旧账。
    await r.runRevertProposal(data);
    assert.equal(r.sourceFingerprint(), before, '撤销执行完了，旧回执依然逐字未动');
    assert.deepEqual(r.changeRow(), rowBefore);
  });

  it('C2：源修改集的状态**只**能由它自己的流转改变 —— 撤销只加行，不改行', async () => {
    const r = await rig('c2', { edits: EDITS });
    const before = repos.changes.list({ limit: 500 }).map((row) => `${row.id}:${row.state}:${row.digest}`).sort();

    await r.prepareRevert('c2-key');
    const after = repos.changes
      .list({ limit: 500 })
      .filter((row) => row.id === r.change_id)
      .map((row) => `${row.id}:${row.state}:${row.digest}`)
      .sort();

    assert.deepEqual(after, before, '源那一行原样在册');
    assert.equal(repos.changes.list({ limit: 500 }).length, 2, '撤销是**新增一行**，不是把旧的改掉');
  });

  // -------------------------------------------------------------------------
  // D 组 —— 验收 3：不改变 Git 暂存区、不执行 reset --hard
  // -------------------------------------------------------------------------

  it('D1：真 git 仓库 —— 撤销前后 .git/index 的字节、git status 与 HEAD 都不变', async () => {
    const r = await rig('d1', { edits: EDITS, git: true });
    const git = (args: readonly string[]): string =>
      execFileSync('git', args, { cwd: r.dir, env: GIT_ENV, encoding: 'utf8' });

    // 制造一个**脏工作区 + 已暂存改动**：这正是 `reset --hard` 会吃掉的东西。
    await writeFile(path.join(r.dir, 'staged.txt'), '已暂存的内容\n');
    git(['add', '--', 'staged.txt']);
    assert.equal(git(['stash', 'list']).trim(), '', '装置自检：开始时没有 stash');

    const statusBefore = git(['status', '--porcelain', '-uall']);
    const headBefore = git(['rev-parse', 'HEAD']).trim();
    const indexBefore = sha256(await readFile(path.join(r.dir, '.git', 'index')));
    assert.ok(statusBefore.includes('staged.txt'), `装置自检：暂存区必须有内容 —— ${JSON.stringify(statusBefore)}`);
    assert.ok(statusBefore.includes('src/a.txt'), `装置自检：工作区必须是脏的 —— ${JSON.stringify(statusBefore)}`);

    const plan = await r.planRevert();
    assert.equal(plan.items[0]!.verdict, 'REVERTIBLE');
    const data = await r.prepareRevert('d1-key');
    assert.ok(data.change !== null, '本用例只关心**提议阶段**不碰 Git');

    assert.equal(sha256(await readFile(path.join(r.dir, '.git', 'index'))), indexBefore, '.git/index 的字节必须逐位不变');
    assert.equal(git(['status', '--porcelain', '-uall']), statusBefore, 'git status 必须逐字不变');
    assert.equal(git(['rev-parse', 'HEAD']).trim(), headBefore, 'HEAD 不许动');
    assert.equal(git(['stash', 'list']).trim(), '', '不许出现 stash');
    assert.equal(git(['diff', '--cached', '--name-only']).trim(), 'staged.txt', '暂存区内容不变');
  });

  it('D2：静态边界 —— 撤销模块够不到写盘、也够不到 git', async () => {
    const raw = await readFile(path.join('packages', 'changes', 'src', 'revert.ts'), 'utf8');
    // 先剥注释再判：这几个名字在文件头的散文里本来就出现过（那几段正是在
    // 解释「那条路为什么不在这里」）。拿注释判「代码会不会调用」是判文章，
    // 不是判行为。
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // `revert.ts` 只该出现这两种护栏调用。
    assert.ok(!source.includes('writeFileGuarded'), '撤销不得调用写文件');
    assert.ok(!source.includes('createFileGuarded'), '撤销不得调用建文件');
    for (const forbidden of ['child_process', 'node:module', 'reset --hard', 'git clean', 'git checkout', 'git stash']) {
      assert.ok(!source.includes(forbidden), `撤销不得出现 ${forbidden}`);
    }
    // 反向探针：同一个文件里**确实**出现了允许的那两种，否则上面四句是空的。
    assert.ok(source.includes('readFileGuarded'), '撤销必须读盘 —— 否则上面的检查在证明一件没发生的事');
    assert.ok(source.includes('resolveTarget'), '撤销必须探路径 —— 否则「探不到就说探不到」这件事没有发生');
    assert.ok(source.includes('refOf'), '撤销必须用工作区作用域读，而不是裸路径');

    const manifest = JSON.parse(await readFile(path.join('packages', 'changes', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(manifest.dependencies ?? {});
    assert.ok(!deps.includes('@lwb/git-reader'), '撤销所在包不得依赖 git 读取器');
    assert.ok(!deps.includes('@lwb/executor'), '撤销不得依赖执行器（依赖方向也不允许：会成环）');
  });

  // -------------------------------------------------------------------------
  // E 组 —— 新建文件：V1 不删除，输出本地方案
  // -------------------------------------------------------------------------

  it('E1：撤销一个只含新建的修改集 ⇒ 没有提案，但有一条明确的本地方案', async () => {
    const r = await rig('e1', { creates: [{ path: '新文件.txt', content: '甲\n乙\n', newline: 'lf', bom: false }] });
    const created = await r.onDisk('新文件.txt');
    assert.equal(created.toString('utf8'), '甲\n乙\n', '装置自检：创建真的落盘了');

    const plan = await r.planRevert();
    assert.equal(plan.items[0]!.verdict, 'LOCAL_DELETE_REQUIRED');
    assert.equal(plan.proposal.length, 0, 'V1 不做删除，因此没有可执行的条目');
    assert.equal(plan.local_actions.length, 1);

    const action = plan.local_actions[0]!;
    assert.equal(action.action, 'DELETE_CREATED_FILE');
    assert.equal(action.path, '新文件.txt');
    assert.equal(action.created_sha256, sha256(created), '方案里给的是**创建时回读到的**哈希');
    assert.equal(action.observed_sha256, sha256(created));
    assert.equal(action.matches_creation, true);
    // 方案必须说清三件事：谁来做、为什么不是自动的、以及**不声称归属**。
    assert.ok(action.instruction.includes('新文件.txt'), action.instruction);
    assert.ok(action.instruction.includes('自行删除'), action.instruction);
    assert.ok(action.instruction.includes('不声称'), action.instruction);

    const data = await r.prepareRevert('e1-key');
    assert.equal(data.change, null, '只有新建时没有可建的新修改集');
    assert.equal(data.local_action_required, true);

    // 路径走的是**结构化字段**，不是散文（LWB-032 修掉的静默盲区）。
    // 审计的文件访问表按结构化字段提取路径，从散文里取不出来 ——
    // 而「模型拿到了文件名、审计里却写着什么也没读」正是一条会被当成
    // 结论的错记录。因此这两句要**一起**成立：路径在 `local_actions` 里，
    // 而不在 `local_action_reason` 里。
    assert.equal(data.local_actions.length, 1);
    assert.equal(data.local_actions[0]?.path, '新文件.txt');
    assert.equal(data.local_actions[0]?.action, 'DELETE_CREATED_FILE');
    assert.ok(
      !data.local_action_reason?.includes('新文件.txt'),
      `总述刻意不含路径（逐条在 local_actions 里）；实际 ${String(data.local_action_reason)}`,
    );
    assert.ok(
      data.local_action_reason?.includes('1 个文件'),
      `总述要说清有几条；实际 ${String(data.local_action_reason)}`,
    );

    // 文件**还在**：V1 绝不自动删。
    assert.equal(sha256(await r.onDisk('新文件.txt')), sha256(created), 'V1 不得删除文件');
    assert.equal(repos.changes.list({ limit: 500 }).length, 1, '没有新建修改集');
  });

  it('E2：新建的文件**不阻断**可撤销的条目（已知做不到 ≠ 不知道）', async () => {
    const r = await rig('e2', {
      edits: EDITS,
      creates: [{ path: '新文件.txt', content: '甲\n', newline: 'lf', bom: false }],
    });
    const createdBytes = await r.onDisk('新文件.txt');

    const data = await r.prepareRevert('e2-key');
    assert.ok(data.change !== null, '能撤的那一条照常变成提案');
    assert.equal(data.change.files.length, 1, '提案里只有改写那一条');
    assert.equal(data.local_action_required, true, '新建那一条另附本地方案');
    assert.equal(await r.observed('新文件.txt'), sha256(createdBytes), '文件还在，一个字节都没动');

    // 真执行撤销：改写被还原，新建的文件**仍然在**。
    await r.runRevertProposal(data);
    assert.equal(sha256(await r.onDisk('src/a.txt')), sha256(EDITS[0]!.before), '改写的那个真的回到了基线');
    assert.equal(sha256(await r.onDisk('新文件.txt')), sha256(createdBytes), '新建的那个还在原地');
  });

  it('E3：新建之后人又改了它 ⇒ THIRD_CONTENT，挡住整件事（不猜归属，也不删）', async () => {
    const r = await rig('e3', { creates: [{ path: '新文件.txt', content: '甲\n', newline: 'lf', bom: false }] });
    const mine = Buffer.from('甲\n我加了东西\n', 'utf8');
    await writeFile(r.abs('新文件.txt'), mine);

    const plan = await r.planRevert();
    assert.equal(plan.items[0]!.verdict, 'CONFLICT');
    assert.equal(plan.items[0]!.reason, 'THIRD_CONTENT');
    await expectRevertError(r, r.prepareRevert('e3-key'), 'FILE_VERSION_CONFLICT', 'THIRD_CONTENT');
    assert.equal(sha256(await r.onDisk('新文件.txt')), sha256(mine), '人的内容一个字都没被碰');
  });

  it('E4：新建之后人又删了它 ⇒ ALREADY_ORIGINAL，无事可做', async () => {
    const r = await rig('e4', { creates: [{ path: '新文件.txt', content: '甲\n', newline: 'lf', bom: false }] });
    await rm(r.abs('新文件.txt'));

    const plan = await r.planRevert();
    assert.equal(plan.items[0]!.verdict, 'ALREADY_ORIGINAL');
    assert.deepEqual(plan.local_actions, []);
    await expectRevertError(r, r.prepareRevert('e4-key'), 'CHANGE_STATE_INVALID', 'NOTHING_TO_REVERT');
  });

  // -------------------------------------------------------------------------
  // F 组 —— 准入
  // -------------------------------------------------------------------------

  it('F1：源修改集不是 APPLIED ⇒ 拒绝（现场还没定案就不生成提议）', async () => {
    const r = await rig('f1', { edits: EDITS });
    // 直接把它推回一个「未定案」的状态是做不到的（终态只有墓碑），
    // 因此换一条路：另建一份**从未执行**的修改集。
    const pending = await prepareChange(
      {
        principal_id: PRINCIPAL,
        connection_id: CONNECTION,
        workspace_id: WORKSPACE,
        generation: r.scope.generation,
        policy_version: POLICY_VERSION,
        scope: r.scope,
        now: Date.now(),
        input: {
          workspace_id: WORKSPACE,
          idempotency_key: 'f1-pending',
          summary: '从未执行的一份',
          items: [
            {
              op: 'create_text',
              path: '从未创建.txt',
              content: '甲\n',
              newline: 'lf',
              bom: false,
            },
          ],
        },
      },
      r.deps,
    );
    assert.equal(pending.state, 'PENDING_APPROVAL');

    await expectRevertError(
      r,
      prepareRevert(
        {
          principal_id: PRINCIPAL,
          connection_id: CONNECTION,
          workspace_id: WORKSPACE,
          generation: r.scope.generation,
          policy_version: POLICY_VERSION,
          scope: r.scope,
          now: Date.now(),
          input: { change_id: pending.change_id, idempotency_key: 'f1-key' },
        },
        r.deps,
      ),
      'CHANGE_STATE_INVALID',
      'CHANGE_STATE_INVALID',
    );
    // 上面那一份是真的没在执行器里跑过，因此它仍然是 PENDING_APPROVAL。
    assert.equal(repos.changes.requireById(pending.change_id).state, 'PENDING_APPROVAL');
  });

  it('F2：别人的修改集 ⇒ NOT_FOUND，且**不带任何细节**（「不存在」与「不是你的」必须无法区分）', async () => {
    const r = await rig('f2', { edits: EDITS });

    const error = await expectRevertError(
      r,
      r.prepareRevert('f2a', { connection_id: OTHER_CONNECTION }),
      'NOT_FOUND',
      null,
    );
    assert.equal(error.details, undefined, 'NOT_FOUND 不许带细节 —— 带了就能把两种情况区分开');

    // 反向探针：一个**根本不存在**的 id 给出逐字一样的回答。
    const missing = await expectRevertError(
      r,
      r.prepareRevert('f2b', { input: { change_id: 'chg_never_existed', idempotency_key: 'f2b' } }),
      'NOT_FOUND',
      null,
    );
    assert.equal(missing.message, error.message, '两条路径的消息必须逐字相同');
    assert.equal(missing.details, error.details);
  });

  it('F3：跨工作区 ⇒ 拒绝（撤销集的归属跟着**本次**连接与工作区）', async () => {
    const r = await rig('f3', { edits: EDITS });
    await expectRevertError(
      r,
      r.prepareRevert('f3', { workspace_id: OTHER_WORKSPACE }),
      'INVALID_ARGUMENT',
      'CHANGE_WORKSPACE_MISMATCH',
    );
  });

  it('F4：工作区被停用 / 被移除 / 代次变了 ⇒ 各自 fail-closed', async () => {
    const a = await rig('f4a', { edits: EDITS });
    repos.workspaces.setEnabled(WORKSPACE, false);
    await expectRevertError(a, a.prepareRevert('f4a'), 'PAUSED', 'WORKSPACE_DISABLED');

    const b = await rig('f4b', { edits: EDITS });
    repos.workspaces.markRemoved(WORKSPACE);
    await expectRevertError(b, b.prepareRevert('f4b'), 'WORKSPACE_NOT_GRANTED', 'WORKSPACE_REMOVED');

    const c = await rig('f4c', { edits: EDITS });
    repos.workspaces.bumpGeneration(WORKSPACE, POLICY_VERSION + 1);
    // 码与原因**不是**同一个词表：`executionBindingErrorCode` 把三种"版本对不上"
    // 都收敛到 `WORKSPACE_GENERATION_CHANGED` 这一个码，而原因保留细分。
    await expectRevertError(c, c.prepareRevert('f4c'), 'WORKSPACE_GENERATION_CHANGED', 'GENERATION_CHANGED');
  });

  it('F5：修改集「过期」**不**妨碍撤销 —— 因为 APPLIED 到不了 EXPIRED', async () => {
    const r = await rig('f5', { edits: EDITS });
    const { CHANGE_TRANSITIONS, EXPIRABLE_STATES } = await import('@lwb/changes');

    // 把这条推理的依据本身钉成断言：`APPLIED` 是墓碑态，且不在可过期集合里。
    assert.deepEqual(CHANGE_TRANSITIONS.APPLIED, [], 'APPLIED 没有出边');
    assert.ok(!EXPIRABLE_STATES.includes('APPLIED'), 'APPLIED 不在 EXPIRABLE_STATES 里');
    assert.ok(EXPIRABLE_STATES.includes('PENDING_APPROVAL'), '反向探针：那个集合确实非空');

    // 现在真的把它标成三个月前过期 —— 那一列在库里是可以改的
    // （`changesets_content_immutable` 刻意不管 `expires_at`）。
    const past = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    opened?.db.prepare('UPDATE changesets SET expires_at = ? WHERE id = ?').run(past, r.change_id);
    assert.equal(r.changeRow().expires_at, past, '装置自检：那一行确实说的是三个月前');

    const plan = await r.planRevert();
    assert.equal(plan.items[0]!.verdict, 'REVERTIBLE', '盘上没被动过，就还能撤销 —— 与时钟无关');
    const data = await r.prepareRevert('f5-key');
    assert.ok(data.change !== null);
    // 而且新修改集拿的是**从此刻起算**的新窗口。
    assert.ok(data.change.expires_at > new Date().toISOString(), '撤销集有自己的新窗口');
    assert.notEqual(data.change.expires_at, past);
  });

  // -------------------------------------------------------------------------
  // G 组 —— 执行日志的折叠规则本身
  //
  // 上面几组的日志都是执行器**真跑**出来的，因此清一色以 `item_verified` 收尾。
  // 折叠规则里唯一有风险的那一条 —— 「**最后一条**说了算」—— 于是没被任何
  // 用例碰到过。这一组直接往那条真操作的日志里追加真行（日志表是追加写的，
  // 没有删除触发器之外的形状约束），把余下的几格逐个走一遍。
  //
  // G2/G3/G4 用 `FILE_VERSION_CONFLICT` 而**不是** `CHANGE_STATE_INVALID`：
  // 那三种都是**逐条目的冲突**（「这一条我不知道它留下了什么」），不是
  // 「这条修改集现在不该被撤销」。前者是「重新读一次再来」，后者是「不行」。
  // 把它们塞进同一个码里，排障的人会去查策略，而问题在盘上。
  // -------------------------------------------------------------------------

  /** 往夹具那条操作的日志里追加一行。序号由 `MAX(seq)+1` 取，因此一定排在最后。 */
  function appendJournal(
    r: Rig,
    stage: string,
    itemId: string | null,
    extra: {
      target_sha256?: string | null;
      observed_file_id?: string | null;
      observed_sha256?: string | null;
      error_code?: string | null;
    } = {},
  ): void {
    repos.journal.append({
      operation_id: r.operationId(),
      item_id: itemId,
      stage,
      observed_file_id: extra.observed_file_id ?? null,
      observed_sha256: extra.observed_sha256 ?? null,
      target_sha256: extra.target_sha256 ?? null,
      error_code: extra.error_code ?? null,
      detail: '装置追加：G 组夹具',
    });
  }

  it('G1：折叠取**最后一条** —— verified 之后又 skipped，就不能再撤销', async () => {
    // 这条用例的夹具有讲究，第一次写时写错了：把 restored 追加在后面、
    // 同时**盘上也真的写回基线**，那么即使折叠规则坏成「只认第一条 verified」，
    // 后面那一层「当场观测盘上」也会得出同一个结论 —— 用例照样绿，
    // 于是它守着的那条规则其实没被守着。反向探针把这件事戳了出来。
    //
    // 要**单独**逼出折叠规则，磁盘的现状必须让两种规则给出不同的动作。
    // `skipped` 正好是那一格：它说的是「执行到我这儿时，这个文件**已经是**
    // 目标内容，所以我没动它」。此时盘上是目标内容 —— 与 skipped 自洽，
    // 且与 verified 的观测值**完全一样**。两种折叠规则于是分道扬镳：
    //   最后一条说了算 → skipped  → 「不是我们的效果」→ 冲突，不撤
    //   只认第一条 verified → written → 「可以还原」→ 生成提案
    // 后者会去改写一个**我们从来没写过**的文件。
    const r = await rig('g1', { edits: EDITS });
    const item = r.sourceItems()[0]!;
    assert.equal(sha256(await r.onDisk('src/a.txt')), item.target_sha256, '装置自检：执行真的写成了目标内容');

    const tail = r.journal().filter((e) => e.item_id === item.id).at(-1)!;
    assert.equal(tail.stage, 'item_verified', '装置自检：真执行的日志确实以核验收尾');

    appendJournal(r, 'item_skipped', item.id, { target_sha256: item.target_sha256 });

    const plan = await r.planRevert();
    assert.equal(
      plan.items[0]!.verdict,
      'CONFLICT',
      '日志最后一条是 skipped：盘上这份内容不是本次执行留下的，撤销没有资格去改它',
    );
    assert.equal(plan.items[0]!.reason, 'EXECUTION_SKIPPED');
    await expectRevertError(r, r.prepareRevert('g1-key'), 'FILE_VERSION_CONFLICT', 'EXECUTION_SKIPPED');
  });

  it('G1b：最后一条是 restored ⇒ 一票认定「没留下字节」，连提案都不建', async () => {
    const r = await rig('g1b', { edits: EDITS });
    const item = r.sourceItems()[0]!;
    const before = EDITS[0]!.before;

    appendJournal(r, 'item_restored', item.id, { observed_sha256: item.base_sha256 });
    await writeFile(r.abs('src/a.txt'), before);
    assert.equal(sha256(await r.onDisk('src/a.txt')), item.base_sha256, '装置自检：盘上确实回到了基线');

    const plan = await r.planRevert();
    assert.equal(plan.items[0]!.verdict, 'ALREADY_ORIGINAL', '执行日志可证明本次执行没留下字节');
    assert.equal(plan.proposal.length, 0, '没有可还原的条目，就不该有提案');
    assert.ok(plan.items[0]!.detail.includes('执行日志可证明'), '理由要说出依据是日志，而不是「恰好看了一眼觉得没事」');
  });

  it('G1c：日志说 restored、盘上却还是目标内容 ⇒ 信日志，不动盘（也不假装撤过）', async () => {
    // 日志与磁盘打架。本模块的选择是**信日志**：`restored` 是一条明确的
    // 「我把它放回去了」，而盘上那份内容是谁的已经无从考证 —— 可能是用户
    // 自己又写了同样的内容。这时候唯一安全的动作是**什么都不做**，
    // 而不是"既然盘上是目标内容，那就再写一遍基线"。后者会把一次本地
    // 编辑当成我们的残留覆盖掉，正是验收标准一禁止的事。
    const r = await rig('g1c', { edits: EDITS });
    const item = r.sourceItems()[0]!;
    const targetOnDisk = sha256(await r.onDisk('src/a.txt'));

    appendJournal(r, 'item_restored', item.id, { observed_sha256: item.base_sha256 });

    const plan = await r.planRevert();
    assert.equal(plan.items[0]!.verdict, 'ALREADY_ORIGINAL');
    assert.equal(plan.proposal.length, 0);
    assert.equal(sha256(await r.onDisk('src/a.txt')), targetOnDisk, '提案阶段当然一个字节都不写 —— 而且这里也不该有任何写入的理由');
  });

  it('G2：最后一条是 failed ⇒ 认不出终局，冲突（不猜它写了什么）', async () => {
    const r = await rig('g2', { edits: EDITS });
    const item = r.sourceItems()[0]!;
    appendJournal(r, 'item_failed', item.id, { error_code: 'WINFS_IO_ERROR' });

    await expectRevertError(r, r.prepareRevert('g2-key'), 'FILE_VERSION_CONFLICT', 'RECEIPT_INCOMPLETE');
    // 这一格与 `default` 那一格的**动作**相同（都不撤），差别只在给人看的那句话。
    // 不钉住那句话，`failed` 这个分支就是一段永远走不到的代码 —— 反向探针
    // 发现把它删掉用例照样全绿。
    const plan = await r.planRevert();
    assert.ok(
      plan.items[0]!.detail.includes('失败或放弃收回'),
      `理由要说清是失败留下的字节，而不是「不认识这个阶段」：${plan.items[0]!.detail}`,
    );
  });

  it('G3：最后一条是**本版本不认识的**阶段名 ⇒ 冲突（未知就是未知）', async () => {
    const r = await rig('g3', { edits: EDITS });
    const item = r.sourceItems()[0]!;
    appendJournal(r, 'item_reticulated', item.id);

    const err = await expectRevertError(r, r.prepareRevert('g3-key'), 'FILE_VERSION_CONFLICT', 'RECEIPT_INCOMPLETE');
    assert.ok(
      JSON.stringify(err.details).includes('item_reticulated') === false,
      '错误细节里不该原样带上那个阶段名之外的现场信息',
    );
    // 但**计划**里要说清楚是哪个阶段 —— 排障的人需要知道。
    const plan = await r.planRevert();
    assert.ok(plan.items[0]!.detail.includes('item_reticulated'), '计划里必须点出那个不认识的阶段名');
  });

  it('G4：日志自相矛盾（记录的目标哈希不是批准的那一份）⇒ 冲突', async () => {
    const r = await rig('g4', { edits: EDITS });
    const item = r.sourceItems()[0]!;
    // 追加一条 verified，但它记的目标是**另一个**哈希。
    appendJournal(r, 'item_verified', item.id, {
      observed_file_id: 'other-file-id',
      observed_sha256: item.target_sha256,
      target_sha256: 'f'.repeat(64),
    });

    const err = await expectRevertError(r, r.prepareRevert('g4-key'), 'FILE_VERSION_CONFLICT', 'RECEIPT_INCOMPLETE');
    assert.ok(err.message.includes('冲突') || err.message.includes('src/a.txt'), '错误要指向出问题的路径');
  });

  it('G5：执行器将来多一个阶段 ⇒ A5 的那条覆盖断言会先红，而不是撤销静默少认一格', async () => {
    // 这条不测产品，测的是**守卫本身有牙**：往一份抄来的清单里塞一个执行器
    // 还没有的键，A5 的第二、三组断言必须能发现它。这里用同一套判据在内存里
    // 复算一遍 —— 真去改源文件再跑测试属于装置自杀，不做。
    const mine: Record<string, string> = { ...REVERT_JOURNAL_STAGES };
    const theirs: Record<string, string> = { ...ITEM_STAGE };
    const authority = new Set<string>(ALL_ITEM_STAGES);

    const check = (m: Record<string, string>): string[] => {
      const bad: string[] = [];
      for (const key of Object.keys(m)) {
        if (m[key] !== theirs[key]) bad.push(`键 ${key} 与执行器不一致`);
        else if (!authority.has(m[key]!)) bad.push(`值 ${m[key]} 不在阶段词表里`);
      }
      for (const key of Object.keys(theirs)) if (!(key in m)) bad.push(`执行器有阶段 ${key}，撤销不认识`);
      if (Object.keys(m).length !== Object.keys(theirs).length) bad.push('键数不同');
      if (new Set(Object.values(m)).size !== Object.keys(m).length) bad.push('阶段名重复');
      return bad;
    };

    assert.deepEqual(check(mine), [], '反向探针的前提：原样的一份必须判为干净');

    // (a) 少认一格
    const missing = { ...mine };
    delete missing['restored'];
    assert.ok(check(missing).length > 0, '少认一个阶段必须被发现');

    // (b) 对调两个语义相反的格子 —— 集合仍然相等，只有逐键比对能发现
    const swapped = { ...mine, verified: mine['failed']!, failed: mine['verified']! };
    assert.deepEqual(
      [...new Set(Object.values(swapped))].sort(),
      [...new Set(Object.values(mine))].sort(),
      '前提：对调之后**值的集合仍然相同**',
    );
    assert.ok(check(swapped).some((m) => m.includes('verified')), 'verified 与 failed 对调必须被发现');

    // (c) 拼错一个值
    const typo = { ...mine, verified: 'item_verifed' };
    assert.ok(check(typo).length > 0, '拼错必须被发现');
  });
});
