/**
 * LWB-033 · 真 NTFS 用例的**公共装置**（竞争那一组与故障注入那一组共用）。
 *
 * ## 这一套装置要回答的问题，以及它为什么必须是真盘
 *
 * 「并发」这个词很容易被验成一句空话：在假护栏上写「第 N 次调用返回 FILE_BUSY」，
 * 断言调用方把 FILE_BUSY 报成了冲突 —— 那条用例证明的是**测试自己写的那个
 * 假护栏**与调用方对得上，而在真实世界里，能挡住一次写入的是**内核的共享
 * 模式**、**文件身份**与**硬链接计数**，不是我们声明的那几个字符串。
 *
 * 因此这里的一切都是真的：
 *
 *  - 真的 NTFS 目录、真的 `PowerShellWinfsBackend`、真的 `WinfsGuard.ps1`；
 *  - 第三方的动作也是**真的第三方动作** —— 走 Node 的普通文件 API
 *    （`rename` / `rm` / `writeFile`，也就是编辑器与 `git checkout` 走的那条路）
 *    或者护栏自己的 `holdHandle`（真的 `CreateFileW` + 真的共享模式）；
 *  - 判据是**磁盘上的字节**与**文件身份**，不是报告里的措辞。
 *
 * ## 竞争窗口打在哪里，为什么是那里
 *
 * 写入路径上真正危险的那一段，是阶段 A（核对）与阶段 C（写入）**之间**：
 * 阶段 A 刚刚证明过「盘上这一份就是被批准的那一个」，而字节还没落下去。
 * 在那一刻换掉对象、占住它、或者改掉它的权限，是这台机器上唯一能造成
 * 「批准的不是写下去的那一个」的方式。
 *
 * `withRace` 拦在 `WinfsOps` 的**外面**，在委托给真护栏之前动手。这一点
 * 是刻意的：它让竞争恰好落在「调用方已经决定要写、内核还没开始写」的那一格，
 * 而**不是**落在阶段 A —— 落在阶段 A 的话，冲突会在更早、更便宜的一步被
 * 报成 `conflict`，那条路 `tests/windows/executor-write-path.test.ts` 已经验过。
 *
 * 于是这里验的是**后一道防线**：护栏在同一个句柄内先比对象身份、再比内容
 * （`WinfsGuard.ps1` 的 `Op-WriteFileGuarded` 步骤 0 与步骤 1）。它在阶段 A
 * 之后仍然成立，因为那些比较发生在**句柄里**，而句柄是这一瞬间才打开的。
 *
 * ## 授权外文件（「不许碰的东西」）是这一套装置的**固定构件**
 *
 * 每一次运行都带两个看门文件：工作区里一个修改集**从未提起过**的兄弟文件，
 * 与工作区**外面**的一个文件。两者都在每次运行前后取指纹（大小 + mtime + 哈希），
 * 逐字节比对。理由很直白：一次竞争注入如果「成功」地让写入跑到了别处，
 * 最可能的受害者就是这两个 —— 而报告、日志与回执**都不会**提到它们。
 * 只有磁盘会。因此这一条不是某个用例的断言，而是这套装置自带的纪律。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe } from 'node:test';

import { approveAndQueue } from '@lwb/approvals';
import { BlobStore } from '@lwb/blob-store';
import { canonicalChangeDigest } from '@lwb/changes';
import { CONTRACT_VERSION, LIMITS } from '@lwb/contracts';
import type { ChangeOp, FileEncoding, NewlineStyle } from '@lwb/contracts';
import {
  aggregateOf,
  createNativeApplier,
  ExecutionCoordinator,
  ITEM_STAGE,
  itemOutcomes,
  readItemEvents,
} from '@lwb/executor';
import type {
  ApplyReport,
  ExecutionApplier,
  ExecutionPlan,
  ItemEvent,
  ItemStage,
  RunOutcome,
} from '@lwb/executor';
import type { ProcessProbe } from '@lwb/ipc';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { ChangeItemInput } from '@lwb/persistence';
import { isWinfsError, PowerShellWinfsBackend } from '@lwb/winfs';
import type { WinfsError, WinfsOps } from '@lwb/winfs';

export const isWindows = process.platform === 'win32';

/** 非 Windows 上整体跳过。跳过 ≠ 通过：报告里会显示 skipped。 */
export const describeWindows = isWindows ? describe : describe.skip;

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * 一个文件的正文：带 BOM 与 CRLF。
 *
 * 刻意不是「一行纯 ASCII」—— 「字节回去了」这句话要能证伪，盘上那一份
 * 就得有不止一种可能的形态（与 `executor-journal-boundary.test.ts` 同一条理由）。
 */
export const bodyOf = (seed: string, which: string): Buffer =>
  Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(`${which}-${seed}\r\n第二行\r\n`, 'utf8'),
  ]);

/** 第三方写进去的东西。与 `bodyOf` 同形，好让「这一份是谁的」在字节层面可分。 */
export const theirsOf = (seed: string, which: string): Buffer =>
  Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(`theirs-${which}-${seed}\r\n别人的第二行\r\n`, 'utf8'),
  ]);

// ---------------------------------------------------------------------------
// 指纹：授权外文件「一个字节都没变」的判据
// ---------------------------------------------------------------------------

export interface Fingerprint {
  readonly sha256: string;
  readonly size: number;
  readonly mtime_ms: number;
}

/**
 * 一个文件的指纹。
 *
 * 三项都要，因为它们的**证伪能力不同**：
 *
 * | 项 | 能发现 | 发现不了 |
 * | --- | --- | --- |
 * | `sha256` | 任何内容变化 | 「内容碰巧相同」的改写 |
 * | `size` | 截断、追加 | 等长改写 |
 * | `mtime_ms` | 等长改写、原地重写 | 时间戳被刻意还原 |
 *
 * 合成一条断言之后，**任一项变化都会失败**。反过来说：三项全同**不能**
 * 证明这个文件绝对没被碰过（一次「写回原样并还原时间戳」的组合它看不出来），
 * 因此本装置不拿它当「不可能被碰过」的证明，只用它当**看门** ——
 * 而看门要的是「碰过就一定发现」，这一条它满足。
 */
export async function fingerprint(abs: string): Promise<Fingerprint> {
  const info = await stat(abs);
  const bytes = await readFile(abs);
  return { sha256: sha256(bytes), size: info.size, mtime_ms: info.mtimeMs };
}

/** 两项指纹必须**逐项**相同。失败时把三项都印出来，好让人一眼看出是哪一项。 */
export function expectSameFingerprint(
  before: Fingerprint,
  after: Fingerprint,
  label: string,
): void {
  assert.deepEqual(
    after,
    before,
    `${label} 被改动了：\n  之前 ${before.sha256.slice(0, 12)} / ${before.size} 字节 / mtime ${before.mtime_ms}\n` +
      `  之后 ${after.sha256.slice(0, 12)} / ${after.size} 字节 / mtime ${after.mtime_ms}`,
  );
}

// ---------------------------------------------------------------------------
// 第三方的动作：真的文件操作
// ---------------------------------------------------------------------------

export interface RaceContext {
  /** 工作区根的绝对路径。**只给装置用**，被测代码一律拿不到它。 */
  readonly dir: string;
  /** 工作区**外面**的目录（授权外文件的所在）。 */
  readonly outside_dir: string;
  /** 相对路径 → 绝对路径。 */
  readonly abs: (relative: string) => string;
}

/** 一次竞争注入。`act` 里做的是**真的**第三方动作。 */
export interface RaceRule {
  /**
   * 在哪一个护栏操作**之前**动手。
   *
   * `readFileGuarded` 是给故障注入那一组用的：阶段 A 的核对读发生在
   * 阶段 B 的记账**之前**，因此拦在这一读上，落点正好是「核对过了、
   * 账还没记」的那一瞬间 —— 而那正是「状态库这时写不进去」要问的问题
   * （见 `tests/fault-injection/persistence-boundaries.test.ts`）。
   */
  readonly before: 'writeFileGuarded' | 'createFileGuarded' | 'readFileGuarded';
  /** 只在这一次调用的 `relative_path` 等于它时触发；省略即任意路径。 */
  readonly path?: string;
  /** 第几次触发（1 起数）。省略即 1。 */
  readonly nth?: number;
  /**
   * 真正动手的那一句。**走的是 Node 的普通文件 API 或护栏自己的持有操作。**
   *
   * 第二个参数是**这一次护栏调用的请求**（`root_*` + `relative_path` +
   * `content_base64`）。只有故障注入那一组用它：让护栏自己在写入中途
   * 崩掉，需要的就是这一次调用本来要写下去的那份 payload。
   */
  readonly act: (ctx: RaceContext, req: Readonly<Record<string, unknown>>) => Promise<unknown>;
}

/**
 * 在真护栏**外面**再包一层：命中的那一次调用之前，先让第三方动一次手。
 *
 * 转发必须显式写出每一个方法：`PowerShellWinfsBackend` 用私有字段
 * （`#helper`），私有字段的品牌检查会挡住 `Object.create` 那种转发。
 * 这与 `executor-journal-boundary.test.ts` 的 `withRefusals` 是同一条理由。
 */
export function withRace(rules: readonly RaceRule[], inner: WinfsOps, ctx: RaceContext): WinfsOps {
  const seen = new Map<string, number>();

  const before = async (
    op: RaceRule['before'],
    relative: string,
    req: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    const key = `${op}\u0000${relative}`;
    const nth = (seen.get(key) ?? 0) + 1;
    seen.set(key, nth);
    for (const rule of rules) {
      if (rule.before !== op) continue;
      if (rule.path !== undefined && rule.path !== relative) continue;
      if ((rule.nth ?? 1) !== nth) continue;
      await rule.act(ctx, req);
    }
  };

  return {
    capability: () => inner.capability(),
    statVolume: (req) => inner.statVolume(req),
    validatePath: (req) => inner.validatePath(req),
    resolvePath: (req) => inner.resolvePath(req),
    readFileGuarded: async (req) => {
      await before('readFileGuarded', req.relative_path, { ...req });
      return inner.readFileGuarded(req);
    },
    listDirectory: (req) => inner.listDirectory(req),
    writeFileGuarded: async (req) => {
      await before('writeFileGuarded', req.relative_path, { ...req });
      return inner.writeFileGuarded(req);
    },
    createFileGuarded: async (req) => {
      await before('createFileGuarded', req.relative_path, { ...req });
      return inner.createFileGuarded(req);
    },
  };
}

/** 换掉一个文件的内容 —— 走的是编辑器保存那条路（`writeFile` 就地覆盖）。 */
export const thirdPartySaves = (abs: string, bytes: Buffer): Promise<void> => writeFile(abs, bytes);

/**
 * 用一个**内容相同、身份不同**的对象顶上：删掉再重建。
 *
 * 这正是「编辑器另存为」「`git checkout` 覆盖」「解压覆盖」在小文件上的形态
 * —— 名字没变、字节没变、而**对象换了**。一个只比内容哈希的护栏放它过去，
 * 然后这一次写入就落在了一个从未被批准的对象上。
 */
export async function thirdPartyReplacesWithSameBytes(abs: string): Promise<void> {
  const bytes = await readFile(abs);
  await rm(abs);
  await writeFile(abs, bytes);
}

/** 把一个目录换成另一个同名目录（原来那个连同内容被挪走）。 */
export async function thirdPartySwapsDirectory(
  dir: string,
  relative_dir: string,
  keep_as: string,
): Promise<void> {
  const target = path.join(dir, ...relative_dir.split('/'));
  const parked = path.join(dir, ...keep_as.split('/'));
  await rename(target, parked);
  await mkdir(target, { recursive: true });
}

/** 把一个文件撤到一边，并让原来的位置**空着**（用于「对象消失」这一格）。 */
export async function thirdPartyMovesAway(abs: string, to: string): Promise<void> {
  await rename(abs, to);
}

// ---------------------------------------------------------------------------
// 夹具：真工作区 + 真修改集 + 真批准 + 真协调器
// ---------------------------------------------------------------------------

export interface CanarySnapshot {
  readonly inside_path: string;
  readonly outside_path: string;
  readonly inside: Fingerprint;
  readonly outside: Fingerprint;
}

export interface ConcurrencyRig {
  readonly seed: string;
  readonly dir: string;
  readonly outside_dir: string;
  readonly change_id: string;
  /** 修改集里的条目相对路径（默认 `src/draft.txt`）。 */
  readonly rel: string;
  readonly baseline: Buffer;
  readonly target: Buffer;
  readonly ctx: RaceContext;
  readonly abs: (relative?: string) => string;
  readonly onDisk: (relative?: string) => Promise<Buffer>;
  /** 工作区内一个**修改集从未提起过**的兄弟文件。 */
  readonly inside_canary: string;
  /** 工作区**外面**的一个文件。 */
  readonly outside_canary: string;
  readonly canaries: () => Promise<CanarySnapshot>;
  readonly expectCanariesIntact: (before: CanarySnapshot) => Promise<void>;
  /** 用给定的护栏跑一次执行。返回协调器的结论。 */
  readonly runWith: (ops: WinfsOps) => Promise<RunOutcome>;
  /** 上一次 `runWith` 里**写盘的人**交回的报告（没跑过则为 null）。 */
  readonly lastReport: () => ApplyReport | null;
  readonly operationId: () => string | null;
  readonly stateOf: () => string;
  readonly stagesOf: (relative?: string) => string[];
  readonly ledger: () => { readonly events: readonly ItemEvent[]; readonly aggregate: string };
  readonly backend: PowerShellWinfsBackend;
  /**
   * 这套夹具的状态库。**只给装置用**：故障注入那一组要问的是状态库自己的
   * 问题（一个被认领却从未收尾的操作、一条一条都没有的条目日志），
   * 而那些问题在 `stateOf()` / `ledger()` 这两个收窄过的读数里看不到。
   */
  readonly repos: Repositories;
  /** 关掉这个 rig 的状态库。**每个 rig 都要关**，漏一个就是一次句柄泄漏。 */
  readonly close: () => void;
}

/** 认领时不该被问到：每个用例的地都是空的。 */
export const deadProbe: ProcessProbe = {
  identify: () => {
    throw new Error('本用例不该问进程探针：认领时这块地是空的');
  },
};

export interface RigOptions {
  /** 目标相对路径。默认 `src/draft.txt` —— 带一层子目录，好让「目录交换」有地方发生。 */
  readonly rel?: string;
  /** `create_text` 而不是 `edit_text`。**目标是**一个还不存在的文件。 */
  readonly create?: boolean;
  /** 目标在磁盘上是什么样；省略即「基线内容」。用来构造「第三种状态」的起点。 */
  readonly before?: Buffer;
  /**
   * 正文里用的那个种子。默认就是 `seed`。
   *
   * 存在的理由是**受控对照**：两个不同的 rig（不同的目录、不同的 id）
   * 需要装着**逐字节相同**的文件，才好在「唯一的差别是那一个注入」这句话下
   * 比较它们的结果。`seed` 决定目录与标识，`content_seed` 只决定字节。
   */
  readonly content_seed?: string;
  /**
   * 状态库落到**文件**上（而不是 `:memory:`）。
   *
   * 存在的理由只有一条：`SQLITE_BUSY` 需要一个**第二个连接**去占住写锁，
   * 而内存库没有第二个连接可言。LWB-033 的「数据库忙」那一格因此必须
   * 用真文件库 —— 在内存库上「模拟」忙，验的是测试自己写的那句话。
   */
  readonly db_file?: string;
  /** 忙等上界。给一个**远小于默认 5 s** 的值，好让锁的窗口可控。 */
  readonly busy_timeout_ms?: number;
}

/**
 * 搭一套真的工作区 + 修改集 + 批准，然后把协调器交给调用方。
 *
 * 与 `executor-journal-boundary.test.ts` 的 `rig` 的区别只有一处，而它是
 * 本任务的核心：这里**不**手工 `claimForExecution`，而是走**真协调器**
 * （`ExecutionCoordinator.runChange`）。理由是本任务要断言的终局之一是
 * **「没有错误的 APPLIED」** —— 而 APPLIED 这个字只在协调器收尾时才被写下来。
 * 手工认领的装置看不到那一格。
 */
export async function openRig(
  sandbox: string,
  backend: PowerShellWinfsBackend,
  seed: string,
  options: RigOptions = {},
): Promise<ConcurrencyRig> {
  const rel = options.rel ?? 'src/draft.txt';
  const contentSeed = options.content_seed ?? seed;
  const dir = path.join(sandbox, seed);
  const outside_dir = path.join(sandbox, `${seed}-outside`);
  await mkdir(dir, { recursive: true });
  await mkdir(outside_dir, { recursive: true });

  // 授权外的两个看门文件。**在建立修改集之前**就写好，因此它们的存在
  // 早于本次执行的全部上下文 —— 一个「顺手建的」文件是造不出来的。
  const inside_canary = 'unrelated.txt';
  const outside_canary = path.join(outside_dir, 'secret.txt');
  await writeFile(path.join(dir, inside_canary), bodyOf(contentSeed, 'canary-inside'));
  await writeFile(outside_canary, bodyOf(contentSeed, 'canary-outside'));

  let seq = 0;
  const nextId = (prefix: string): string => `${prefix}_${(seq += 1).toString().padStart(4, '0')}`;

  const opened = openDatabase({
    path: options.db_file ?? ':memory:',
    ...(options.busy_timeout_ms === undefined ? {} : { busyTimeoutMs: options.busy_timeout_ms }),
  });
  const repos = new Repositories(opened.db);
  const blobs = new BlobStore({
    objectsRoot: path.join(sandbox, `${seed}-objects`),
    registry: repos.blobs,
    newId: () => nextId('blob'),
  });

  const volume = await backend.statVolume({ path: dir });
  assert.equal(volume.ok, true, `statVolume 失败：${JSON.stringify(volume)}`);
  if (isWinfsError(volume)) throw new Error('上面一行已经断言过');

  repos.connections.create({
    id: CONNECTION,
    principal_kind: 'model_surface',
    principal_id: PRINCIPAL,
    alias: '真盘并发连接',
    enabled: true,
  });
  repos.workspaces.create({
    id: WORKSPACE,
    alias: '真盘并发工作区',
    kind: 'directory',
    canonical_root: dir,
    volume_id: volume.volume_id,
    root_file_id: volume.file_id,
    policy_version: POLICY_VERSION,
    mode: MODE,
  });
  const generation = repos.workspaces.requireById(WORKSPACE).generation;

  const baseline = options.before ?? bodyOf(contentSeed, 'before');
  const target = bodyOf(contentSeed, 'after');
  const targetAbs = path.join(dir, ...rel.split('/'));
  await mkdir(path.dirname(targetAbs), { recursive: true });
  if (options.create !== true) await writeFile(targetAbs, baseline);

  const ref = { root_path: dir, root_volume_id: volume.volume_id, root_file_id: volume.file_id };

  // 基线身份与哈希由**护栏自己**给出：本文件不另算一份，否则验的是测试
  // 写的第二个实现，而不是交付物。
  let baseFileId: string | null = null;
  let baseSha: string | null = null;
  if (options.create !== true) {
    const read = await backend.readFileGuarded({ ...ref, relative_path: rel });
    assert.equal(read.ok, true, `读取基线失败：${JSON.stringify(read)}`);
    if (isWinfsError(read)) throw new Error('上面一行已经断言过');
    baseFileId = read.identity.file_id;
    baseSha = read.sha256;
  }

  const beforeBlob = await blobs.putAndRegister(baseline, { id: nextId('blob') });
  const afterBlob = await blobs.putAndRegister(target, { id: nextId('blob') });

  const op: ChangeOp = options.create === true ? 'create_text' : 'edit_text';
  const items: ChangeItemInput[] = [
    {
      id: nextId('ci'),
      path: rel,
      op,
      base_file_id: baseFileId,
      base_sha256: baseSha,
      target_sha256: afterBlob.put.sha256,
      old_blob_id: options.create === true ? null : beforeBlob.id,
      new_blob_id: afterBlob.id,
      encoding: 'utf-8-bom',
      bom: true,
      newline: 'crlf',
      added_lines: 2,
      removed_lines: options.create === true ? 0 : 2,
    },
  ];

  const encoding: FileEncoding = 'utf-8-bom';
  const newline: NewlineStyle = 'crlf';
  const digest = canonicalChangeDigest({
    contract_version: CONTRACT,
    policy_version: POLICY_VERSION,
    root_generation: generation,
    workspace_id: WORKSPACE,
    files: [
      {
        path: rel,
        op,
        before_sha256: options.create === true ? null : baseSha,
        before_size: options.create === true ? 0 : beforeBlob.put.size,
        after_sha256: afterBlob.put.sha256,
        after_size: afterBlob.put.size,
        encoding,
        newline,
        bom: true,
      },
    ],
  });

  const nowMs = Date.now();
  const change = repos.changes.create({
    id: nextId('chg'),
    owner_connection_id: CONNECTION,
    workspace_id: WORKSPACE,
    root_generation: generation,
    policy_version: POLICY_VERSION,
    contract_version: CONTRACT,
    digest,
    summary: `真盘并发摘要 ${seed}`,
    expires_at: new Date(nowMs + LIMITS.CHANGE_TTL_MS).toISOString(),
    items,
  });
  approveAndQueue({
    repos,
    change_id: change.id,
    digest,
    actor: 'console:真盘并发测试',
    now: new Date(nowMs).toISOString(),
    idempotency_key: `key-${seed}`,
  });

  const recorded = repos.changes.items(change.id);
  const idByPath = new Map(recorded.map((item) => [item.canonical_path, item.id]));

  const ctx: RaceContext = {
    dir,
    outside_dir,
    abs: (relative) => path.join(dir, ...relative.split('/')),
  };

  let lastReport: ApplyReport | null = null;
  let operationId: string | null = null;

  const canaries = async (): Promise<CanarySnapshot> => ({
    inside_path: path.join(dir, inside_canary),
    outside_path: outside_canary,
    inside: await fingerprint(path.join(dir, inside_canary)),
    outside: await fingerprint(outside_canary),
  });

  const rig: ConcurrencyRig = {
    seed,
    dir,
    outside_dir,
    change_id: change.id,
    rel,
    baseline,
    target,
    ctx,
    backend,
    repos,
    abs: (relative = rel) => path.join(dir, ...relative.split('/')),
    onDisk: (relative = rel) => readFile(path.join(dir, ...relative.split('/'))),
    inside_canary,
    outside_canary,
    canaries,
    expectCanariesIntact: async (before) => {
      const after = await canaries();
      expectSameFingerprint(before.inside, after.inside, `工作区内的授权外文件 ${inside_canary}`);
      expectSameFingerprint(before.outside, after.outside, `工作区外的授权外文件 ${outside_canary}`);
    },
    runWith: async (ops: WinfsOps): Promise<RunOutcome> => {
      lastReport = null;
      // 写盘的人仍然是**生产那一个**（`createNativeApplier`）；被换掉的
      // 只有它下面那一层护栏。这个区分很重要：把 applier 也换成假的，
      // 验的就是假 applier 的纪律，而纪律不是本任务要验的东西。
      const apply: ExecutionApplier = (plan: ExecutionPlan, signal: AbortSignal) => {
        operationId = plan.operation_id;
        return createNativeApplier({ repos, ops, blobs })(plan, signal).then((report) => {
          lastReport = report;
          return report;
        });
      };
      const coordinator = new ExecutionCoordinator({
        repos,
        probe: deadProbe,
        apply,
        executor_id: EXECUTOR_ID,
        // 持证人与时钟是**同一口钟**：`HOLDER.started_at` 取自 `Date.now()`，
        // 而协调器不注入 `now`，于是探活比对的是同一个当下。
        holder: { pid: process.pid, started_at: new Date(Date.now() - 60_000).toISOString() },
      });
      return await coordinator.runChange(change.id);
    },
    lastReport: () => lastReport,
    operationId: () => operationId,
    stateOf: () => repos.changes.requireById(change.id).state,
    stagesOf: (relative = rel) => {
      if (operationId === null) return [];
      const id = idByPath.get(relative);
      assert.ok(id !== undefined, `夹具里没有 ${relative} 这个条目`);
      return readItemEvents(repos, operationId)
        .filter((event) => event.item_id === id)
        .map((event) => event.stage);
    },
    ledger: () => {
      if (operationId === null) return { events: [], aggregate: 'unfinished' };
      const events = readItemEvents(repos, operationId);
      return { events, aggregate: aggregateOf(itemOutcomes(events), recorded.length) };
    },
    close: () => closeDatabase(opened.db),
  };

  return rig;
}

const CONNECTION = 'conn_conc';
const WORKSPACE = 'ws_conc';
const PRINCIPAL = 'principal_conc';
const POLICY_VERSION = 1;
const MODE = 'read_propose_apply_with_local_approval';
const EXECUTOR_ID = 'exe_conc';
const CONTRACT = CONTRACT_VERSION;

export { ITEM_STAGE };
export type { ItemEvent, ItemStage, WinfsError, WinfsOps, ApplyReport };
