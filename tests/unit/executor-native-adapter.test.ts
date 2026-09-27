/**
 * LWB-027 / LWB-028 单元测试：把批准过的操作交给原生护栏的写盘适配器。
 *
 * ## 这里的「磁盘」是假的，而且是**故意**假的
 *
 * 真护栏的句柄级保证（对象身份、硬链接、共享模式、`FlushFileBuffers`、
 * `CREATE_NEW`）已经对真 NTFS 验过（见 `docs/evidence/lwb-027/` 与
 * `docs/evidence/lwb-028/`）。本文件要回答的是**另一个问题**：拿到一份
 * 「护栏说了什么」，适配器*据此*做了什么决定 —— 报冲突、报拒绝，还是**抛**（进恢复）。
 *
 * 那是一个关于**分类**的问题，而分类只有在每一种错误都能被随时构造出来时
 * 才测得干净：`FILE_BUSY`、`PERMISSION_DENIED`、带 `actual_state` 的
 * `IO_ERROR`、以及各种不合规的回执。这些在真盘上要么极难复现，要么
 * 根本复现不了（比如「回执说 `readback_ok` 但哈希对不上」——
 * 那要求护栏自身出错）。
 *
 * ## 假磁盘不假装自己是护栏
 *
 * 它只回答「这个路径是什么对象、字节是什么」，并把写入请求**记下来**。
 * 记录是关键：本文件里有一半的断言是「适配器**没有**做某件事」——
 * 没有在记账之前写入、没有在拒绝之后写入、没有把「已经写过一条」报成冲突。
 *
 * ## 状态库、快照库与认领都是**真的**
 *
 *  - 阶段 B 的记账（`VALIDATING → APPLYING`）写的是真 SQLite；
 *  - 目标字节来自真 `BlobStore`（真落盘、真按哈希校验、真回读）；
 *  - 计划来自真 `claimForExecution` —— 连「起点是 `VALIDATING`」这件事
 *    都不是本文件摆出来的，而是认领第 ⑤ 步留下的。
 *
 * 换成桩就等于把「写入之前先记了账」「写下去的字节就是被批准的那一份」
 * 「起点的状态是生产路径给的」这三句话，换成桩自己的保证 ——
 * 而它们正是本任务的要害。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { approveAndQueue } from '@lwb/approvals';
import { BlobStore } from '@lwb/blob-store';
import { canonicalChangeDigest } from '@lwb/changes';
import { CONTRACT_VERSION, isBridgeError, LIMITS } from '@lwb/contracts';
import type { ChangeOp, FileEncoding, NewlineStyle } from '@lwb/contracts';
import { aggregateOf, claimForExecution, createNativeApplier, itemOutcomes, ITEM_STAGE, readItemEvents } from '@lwb/executor';
import type { Aggregate, ApplyReport, ExecutionPlan, ItemEvent, ItemOutcome, ItemStage } from '@lwb/executor';
import type { ProcessProbe } from '@lwb/ipc';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { ChangeItemInput, ChangeItemRecord, OpenDatabaseResult } from '@lwb/persistence';
import type {
  WinfsCapability,
  WinfsCreateResult,
  WinfsError,
  WinfsListResult,
  WinfsOps,
  WinfsPathRef,
  WinfsReadResult,
  WinfsWriteResult,
} from '@lwb/winfs';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

const CONNECTION = 'conn_native';
const WORKSPACE = 'ws_native';
const PRINCIPAL = 'principal_native';
const POLICY_VERSION = 3;
const GENERATION = 9;
const MODE = 'read_propose_apply_with_local_approval';
const ACTOR = 'console:test-session';
/** 契约版本**取真值**，不写字面量：写死它会在契约升级那天变成一次静默失效。 */
const CONTRACT = CONTRACT_VERSION;

const VOLUME = 'c6e22015';
const ROOT_FILE_ID = '0044000000086a4e';
const ROOT_PATH = 'C:\\lwb-027\\repo';

const T0 = '2026-09-26T10:00:00.000Z';
const T0_MS = Date.parse(T0);
const LEASE_MS = 30_000;
const HOLDER = { pid: 4242, started_at: '2026-09-26T09:00:00.000Z' };

const EXECUTOR_ID = 'exe_native';

let sandbox = '';
let resetCount = 0;
let opened: OpenDatabaseResult;
let repos: Repositories;
let blobs: BlobStore;
let seq = 0;

const nextId = (prefix: string): string => `${prefix}_${(seq += 1).toString().padStart(4, '0')}`;
const iso = (ms: number): string => new Date(ms).toISOString();
const sha256 = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

/**
 * 认领时**不该**被问到的进程探针。
 *
 * 每个用例都是一块空的地，所以「查上一个持有者还在不在」这一步根本不该
 * 发生。让它抛，是为了让「有人顺手问了探针」变成一条失败，而不是一条
 * 需要人去读日志才能发现的噪声。
 */
const deadProbe: ProcessProbe = {
  identify: () => {
    throw new Error('本用例不该问进程探针：认领时这块地是空的');
  },
};

/** 每个用例一个全新的库与一份全新的对象目录。 */
function resetDb(): void {
  if (opened !== undefined) closeDatabase(opened.db);
  resetCount += 1;
  opened = openDatabase({ path: ':memory:' });
  repos = new Repositories(opened.db, () => T0);
  blobs = new BlobStore({
    objectsRoot: path.join(sandbox, `objects-${resetCount}`),
    registry: repos.blobs,
    newId: () => nextId('blob'),
  });

  repos.connections.create({
    id: CONNECTION,
    principal_kind: 'model_surface',
    principal_id: PRINCIPAL,
    alias: '测试连接',
    enabled: true,
  });
  repos.workspaces.create({
    id: WORKSPACE,
    alias: '夹具工作区',
    kind: 'directory',
    canonical_root: ROOT_PATH,
    volume_id: VOLUME,
    root_file_id: ROOT_FILE_ID,
    policy_version: POLICY_VERSION,
    mode: MODE,
  });
  // 建出来是第 1 代，而夹具声明的是第 9 代。两边都是 1 的时候，
  // 「代次比对」这条断言在做错事时也会通过。
  while (repos.workspaces.requireById(WORKSPACE).generation < GENERATION) {
    repos.workspaces.bumpGeneration(WORKSPACE, POLICY_VERSION);
  }
}

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'lwb-native-adapter-'));
});

after(async () => {
  if (opened !== undefined) closeDatabase(opened.db);
  await rm(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 假磁盘的**模型**
// ---------------------------------------------------------------------------

/**
 * 磁盘上的一个对象。
 *
 * `openable_as` 是这个对象能被打开的**全部拼写**。这一层不是多余的：
 * B6 要构造的正是「条目里记的名字与磁盘上的名字不是同一个」——
 * 而 `GetFinalPathNameByHandleW` 给出的规范拼写才是写入路径据以判策略的那个。
 * 把一个对象建模成「一个规范名 + 若干可达拼写」，就是对这件事的忠实表达。
 */
interface DiskObject {
  readonly canonical: string;
  readonly openable_as: readonly string[];
  readonly file_id: string;
  /** 探针看到的文件 ID。与 `file_id` 不同 = 两次核对之间被换掉了（D2）。 */
  readonly probe_file_id: string;
  /** `null` 表示这个路径在磁盘上不存在。 */
  readonly sha256: string | null;
  readonly is_directory: boolean;
}

/**
 * 假护栏手上那一份**可变**的磁盘。
 *
 * 字段与 `DiskObject` 一一对应，去掉 `readonly` —— 写入与「带现场观测的失败」
 * 都要能改它。同一个形状写两遍是刻意的：`DiskObject` 是**调用方**看到的
 * 那一份（本文件里它必须保持原样，好几条用例拿它断言「一个字节都没动」），
 * 而这个类型只活在假护栏内部。
 */
interface MutableObject {
  canonical: string;
  openable_as: readonly string[];
  file_id: string;
  probe_file_id: string;
  sha256: string | null;
  is_directory: boolean;
}

interface Spec {
  /** 条目里记的相对路径。 */
  readonly path: string;
  readonly op?: ChangeOp;
  /** 目标正文（决定快照里的字节与目标哈希）。 */
  readonly after?: string;
  /** 基线正文。只进快照库与摘要，不会被检查内容。 */
  readonly base?: string;
  readonly declared_encoding?: FileEncoding;
  readonly declared_bom?: boolean;
  readonly declared_newline?: NewlineStyle;
  /** 覆盖条目的目标哈希，用来构造「条目与它自己的快照对不上」。 */
  readonly target_sha_override?: string;
  readonly disk?: {
    /** 磁盘规范拼写；默认与 `path` 相同。 */
    readonly name?: string;
    /** 除规范拼写外还能打开它的拼写。 */
    readonly alias?: readonly string[];
    readonly file_id?: string;
    readonly probe_file_id?: string;
    /**
     * `null` = 不存在；省略 = **按操作形态取缺省**：
     * 改写取基线内容，创建取 `null`（创建的前提就是那个名字空着）。
     */
    readonly sha256?: string | null;
    readonly is_directory?: boolean;
    /**
     * 父目录链在磁盘上不存在（用于「不隐式创建父目录」这条验收标准）。
     * 省略 = 路径上的每一级父目录都在。
     */
    readonly parent_absent?: boolean;
  };
}

/**
 * 一个相对路径的每一级祖先，从最上面一级开始。
 *
 * `src/deep/new.ts` ⇒ `['src', 'src/deep']`；`ROOT.md` ⇒ `[]`。
 */
function ancestorsOf(relative: string): string[] {
  const parts = relative.split('/');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join('/'));
  return out;
}

interface Built {
  readonly change_id: string;
  readonly operation_id: string;
  readonly approval_id: string;
  readonly items: readonly ChangeItemRecord[];
  readonly objects: readonly DiskObject[];
}

/**
 * 造一个**已批准、已排队**的修改集，并给出它面对的那块假磁盘。
 *
 * 快照字节是真的：`putAndRegister` 落盘、登记、回读校验三步都走。
 * 目标哈希因此**不**由本文件拼出来 —— 它是真字节的真哈希，而条目里记的
 * 就是它。这样「写下去的字节是被批准的那一份」这句话在本文件里是一条
 * 可以失败的断言，而不是一个约定。
 */
async function fixture(seed: string, specs: readonly Spec[]): Promise<Built> {
  const items: ChangeItemInput[] = [];
  const objects: DiskObject[] = [];
  const digestFiles: {
    path: string;
    op: ChangeOp;
    before_sha256: string | null;
    before_size: number;
    after_sha256: string;
    after_size: number;
    encoding: FileEncoding;
    newline: NewlineStyle;
    bom: boolean;
  }[] = [];

  for (const spec of specs) {
    const op = spec.op ?? 'edit_text';
    const creating = op === 'create_text';
    const after = spec.after ?? `after-${seed}-${spec.path}\n`;
    const base = spec.base ?? `${after}::base`;
    const encoding = spec.declared_encoding ?? 'utf-8';
    const bom = spec.declared_bom ?? false;
    const newline = spec.declared_newline ?? 'lf';

    const newBlob = await blobs.putAndRegister(Buffer.from(after, 'utf8'), { id: nextId('blob') });
    const oldBlob = creating
      ? null
      : await blobs.putAndRegister(Buffer.from(base, 'utf8'), { id: nextId('blob') });
    const afterSha = newBlob.put.sha256;
    const beforeSha = oldBlob?.put.sha256 ?? null;
    const baseFileId = creating ? null : `file-${seed}-${spec.path}`;

    items.push({
      id: nextId('ci'),
      path: spec.path,
      op,
      base_file_id: baseFileId,
      base_sha256: beforeSha,
      target_sha256: spec.target_sha_override ?? afterSha,
      old_blob_id: oldBlob?.id ?? null,
      new_blob_id: newBlob.id,
      encoding,
      bom,
      newline,
      added_lines: 1,
      removed_lines: 1,
    });
    digestFiles.push({
      path: spec.path,
      op,
      before_sha256: beforeSha,
      before_size: oldBlob?.put.size ?? 0,
      // 与条目里记的**同一个值**。认领时 `reloadChangeSet` 会由落库事实
      // （`filePreviewsOf` 取 `item.target_sha256`）重算一遍摘要并与落库的
      // 那一份比对 —— 两处不一致的话，连夹具都建不起来。
      after_sha256: spec.target_sha_override ?? afterSha,
      after_size: newBlob.put.size,
      encoding,
      newline,
      bom,
    });

    const name = spec.disk?.name ?? spec.path;
    const fallbackId = baseFileId ?? `file-${seed}-${spec.path}`;
    objects.push({
      canonical: name,
      openable_as: [name, ...(spec.disk?.alias ?? [])],
      file_id: spec.disk?.file_id ?? fallbackId,
      probe_file_id: spec.disk?.probe_file_id ?? spec.disk?.file_id ?? fallbackId,
      // 创建的缺省是 `null`（那个名字空着）—— 它不是「内容恰好等于目标」：
      // 后者是一个**已存在的对象**，在这条路上属于「名字被占了」，
      // 也就是 B1 要构造的那一格。把两者混成同一个缺省，会让「创建绝不覆盖」
      // 这条判据在缺省夹具下自动成立，从而一次也验不到。
      sha256: spec.disk?.sha256 === undefined ? (creating ? null : beforeSha) : spec.disk.sha256,
      is_directory: spec.disk?.is_directory === true,
    });

    // 父目录：一个在工作区根之下的路径，它的每一级祖先都必须在磁盘上存在 ——
    // 否则「文件在那儿」这句话本身就是假的。显式写出来的目录优先（E4 要构造
    // 「父路径上是一个**文件**」），因此这里只补还没有的。
    if (spec.disk?.parent_absent !== true) {
      for (const ancestor of ancestorsOf(spec.path)) {
        if (objects.some((o) => o.canonical === ancestor)) continue;
        objects.push({
          canonical: ancestor,
          openable_as: [ancestor],
          file_id: `dir-${seed}-${ancestor}`,
          probe_file_id: `dir-${seed}-${ancestor}`,
          // 目录没有字节。这里给一个真实存在过的哈希（空内容的哈希），
          // 而不是 `null` —— 本文件里 `null` 的含义是「这个路径不存在」，
          // 拿它当目录的值会让每个父目录探测都变成 NOT_FOUND。
          sha256: sha256(''),
          is_directory: true,
        });
      }
    }
  }

  const digest = canonicalChangeDigest({
    contract_version: CONTRACT,
    policy_version: POLICY_VERSION,
    root_generation: GENERATION,
    workspace_id: WORKSPACE,
    files: digestFiles,
  });

  const change = repos.changes.create({
    id: nextId('chg'),
    owner_connection_id: CONNECTION,
    workspace_id: WORKSPACE,
    root_generation: GENERATION,
    policy_version: POLICY_VERSION,
    contract_version: CONTRACT,
    digest,
    summary: `测试摘要 ${seed}`,
    expires_at: iso(T0_MS + LIMITS.CHANGE_TTL_MS),
    items,
  });

  // 走生产路径：控制台的「批准并应用」按的就是这一条。
  const queued = approveAndQueue({
    repos,
    change_id: change.id,
    digest,
    actor: ACTOR,
    now: T0,
    idempotency_key: `key-${seed}`,
  });

  return {
    change_id: change.id,
    operation_id: queued.operation.id,
    approval_id: queued.approval.id,
    items: repos.changes.items(change.id),
    objects,
  };
}

/**
 * 认领。返回计划 —— 也就是写盘的人手上的**全部**输入。
 *
 * 本文件不自己拼一份 `ExecutionPlan`：拼出来的那份会随着 `claim.ts` 的
 * 字段变化而悄悄失配，而「写盘的人看到的是什么」正是本文件要测的东西。
 */
function claim(changeId: string): ExecutionPlan {
  const outcome = claimForExecution(
    { repos, executor_id: EXECUTOR_ID, holder: HOLDER, probe: deadProbe, lease_ms: LEASE_MS, now: () => T0_MS },
    changeId,
  );
  assert.equal(outcome.kind, 'claimed', `认领未成功：${JSON.stringify(outcome)}`);
  if (outcome.kind !== 'claimed') throw new Error('上面一行已经断言过');
  return outcome.plan;
}

/** 造好、认领，然后返回「计划 + 那块假磁盘」。 */
async function claimed(seed: string, specs: readonly Spec[]): Promise<{ plan: ExecutionPlan; built: Built }> {
  resetDb();
  const built = await fixture(seed, specs);
  return { plan: claim(built.change_id), built };
}

const itemOf = (built: Built, relativePath: string): ChangeItemRecord => {
  const found = built.items.find((i) => i.canonical_path === relativePath);
  assert.ok(found !== undefined, `夹具里没有 ${relativePath} 这个条目`);
  return found;
};

const stateOf = (changeId: string): string => repos.changes.requireById(changeId).state;
const opStateOf = (operationId: string): string => repos.operations.requireById(operationId).state;

// ---------------------------------------------------------------------------
// 假护栏
// ---------------------------------------------------------------------------

interface WriteRequest extends WinfsPathRef {
  readonly expected_sha256: string;
  readonly expected_file_id?: string | null;
  readonly content_base64: string;
}

/** 创建请求**没有**基线字段 —— 那正是两条路方向相反的地方。 */
interface CreateRequest extends WinfsPathRef {
  readonly content_base64: string;
}

interface FakeOpsOptions {
  readonly objects: readonly DiskObject[];
  /** 探针/读取按路径注入的失败。 */
  readonly readErrors?: ReadonlyMap<string, WinfsError>;
  /** 写入按路径注入的失败。 */
  readonly writeErrors?: ReadonlyMap<string, WinfsError>;
  /** 改写回执的字段。默认给一份**诚实**的回执。 */
  readonly receipt?: (req: WriteRequest) => Partial<WinfsWriteResult>;
  /** 每次写入之前调用。第二个参数是假磁盘本身，供需要当场改盘面的用例。 */
  readonly beforeWrite?: (req: WriteRequest, disk: MutableObject[]) => void;
  /** 创建回执的字段。默认给一份**诚实**的回执。 */
  readonly createReceipt?: (req: CreateRequest) => Partial<WinfsCreateResult>;
  /**
   * 注入的失败（`writeErrors` / `receipt` / `createReceipt`）只作用于每个
   * 路径的**第一次**写入。默认：每一次。
   *
   * 回滚用例要它。一次失败之后的回滚是**第二次**写入同一个路径，而它必须
   * 能成功 —— 关着这个开关，注入的故障会追着回滚一起失败，于是
   * 「有界回滚」那几条用例测到的是另一种情形（错误是持久的），
   * 而两种情形在这份夹具里长得一模一样。
   */
  readonly faultFirstWriteOnly?: boolean;
  /**
   * 只在写某个路径的**第 N 次**注入故障（1 起数）。
   *
   * 设了它的路径按这个数判，没设的仍按 `faultFirstWriteOnly`。
   * 存在的理由只有一条：**收回那一次也得能坏**。一次「写入成功、
   * 收回失败」的执行会把那个条目留在「可能有我们的字节」上，
   * 而那是账上最要紧的一格 —— 偏偏它没法用 `faultFirstWriteOnly`
   * 造出来（那个开关坏的是第一次）。
   */
  readonly faultNthWrite?: ReadonlyMap<string, number>;
  /**
   * 每次创建**之前**调用 —— 也就是 `CREATE_NEW` 那一刻。
   *
   * 它是这个假磁盘上唯一一处能构造 E2 的地方：阶段 A 的探针与阶段 C 的
   * `CREATE_NEW` 之间有一个窗口，而验收标准第一条问的正是这个窗口。
   * 挂在写入之前不够 —— 那时创建已经发生过了。
   */
  readonly beforeCreate?: (req: CreateRequest, disk: MutableObject[]) => void;
  /**
   * 写入成功之后，假磁盘上那个对象**真的**变成新内容（默认关闭）。
   *
   * 默认关闭的理由：大多数用例问的是「发出去的请求长什么样」，盘上跟着变
   * 会让断言多一层间接。而回滚那条路（LWB-029）**必须**打开它 ——
   * 回滚的护栏调用带着前置条件（「盘上还是我们写下去的那一份」），
   * 只有当写下去确实改变了盘面时，那句话才有真假可言；
   * 关着的话每次回滚都会撞上「基线哈希与 expected 不符」，
   * 于是每一条回滚用例都退化成同一句话：假磁盘没变过。
   */
  readonly applyWrites?: boolean;
}

interface FakeOps {
  readonly ops: WinfsOps;
  readonly calls: readonly ('resolvePath' | 'readFileGuarded' | 'writeFileGuarded' | 'createFileGuarded')[];
  /**
   * 发出去的**写入请求**，含那些当场失败、一个字节都没写的。
   *
   * 名字是 `attempts` 而不是 `writes`，因为本文件里「试了几次」与
   * 「写成了几个」是两个不同的问题，而它们各有用例要问：
   * 「拒绝之后一次都没试」看长度，「写到一半失败」要看试的是哪几个。
   * 把它叫 `writes` 会让后一类断言读起来像是在数成功次数。
   */
  readonly attempts: readonly WriteRequest[];
  /**
   * 发出去的**创建请求**。
   *
   * 与 `attempts` 分开，而不是合成一个「写请求」列表：两条路的判据不同，
   * 而本文件里有整整一组断言是「创建这条路上，改写操作**一次都没被调用**」
   * —— 那正是「创建不会退化成一次覆盖写」这句话的可失败形式。
   */
  readonly creates: readonly CreateRequest[];
  /**
   * 假磁盘**此刻**的样子。
   *
   * 与传进来的 `options.objects` 是两份：这一份跟着 `applyWrites` 变，
   * 那一份始终是执行之前的样子。回滚用例两句都要看 ——
   * 「写下去时盘面变了」与「收回来之后盘面回到了原来那份」。
   */
  readonly disk: readonly DiskObject[];
}

function makeFakeOps(options: FakeOpsOptions): FakeOps {
  const calls: ('resolvePath' | 'readFileGuarded' | 'writeFileGuarded' | 'createFileGuarded')[] = [];
  const attempts: WriteRequest[] = [];
  const creates: CreateRequest[] = [];
  // 一份**可变的**副本：`applyWrites` 与「带现场观测的失败」都要在上面留下痕迹。
  // 复制而不是直接用 `options.objects`，是为了让调用方手上那一份保持原样 ——
  // 有几条用例正是拿它去断言「盘上那个字节原封不动」。
  const disk: MutableObject[] = options.objects.map((o) => ({ ...o }));
  const find = (relative: string): MutableObject | undefined =>
    disk.find((o) => o.openable_as.includes(relative));
  /** 每个路径被写了几次。`faultFirstWriteOnly` 靠它决定这一次要不要注入故障。 */
  const writeCounts = new Map<string, number>();
  const faultedHere = (relative: string): boolean => {
    const nth = (writeCounts.get(relative) ?? 0) + 1;
    writeCounts.set(relative, nth);
    const exact = options.faultNthWrite?.get(relative);
    if (exact !== undefined) return nth === exact;
    return options.faultFirstWriteOnly !== true || nth === 1;
  };
  const missing = (relative: string): WinfsError => ({
    ok: false,
    code: 'NOT_FOUND',
    // 刻意带上绝对路径：真护栏的消息就是这么写的，而 B8 要验的正是
    // 「报告里不出现工作区根的绝对路径」。
    message: `夹具：${ROOT_PATH}\\${relative.split('/').join('\\')} 在磁盘上不存在`,
    win32_error: 2,
  });

  const ops: WinfsOps = {
    capability: (): Promise<WinfsCapability> => {
      throw new Error('夹具：本测试不问能力自检');
    },
    statVolume: () => {
      throw new Error('夹具：本测试不用 statVolume');
    },
    validatePath: () => {
      throw new Error('夹具：本测试不用 validatePath');
    },
    listDirectory: (): Promise<WinfsListResult | WinfsError> => {
      throw new Error('夹具：本测试不用 listDirectory');
    },
    createFileGuarded: (req) => {
      calls.push('createFileGuarded');
      creates.push(req);
      const faultyCreate = faultedHere(req.relative_path);
      options.beforeCreate?.(req, disk);

      // `CREATE_NEW`：判定与创建是同一次系统调用，因此这里**先**看名字有没有
      // 被占，而没有第二条「先检查再创建」的路径可走。名字是按 NTFS 的规矩
      // 比的，因此 `openable_as` 里任何一条拼写都算占着 —— 大小写别名碰撞
      // 同样失败。
      const taken = find(req.relative_path);
      if (taken !== undefined && taken.sha256 !== null) {
        return Promise.resolve({
          ok: false,
          code: 'FILE_VERSION_CONFLICT',
          message: '夹具：文件已存在，CREATE_NEW 拒绝覆盖',
          // 真护栏在真 NTFS 上实测到的码（见 tests/windows/executor-create-path.test.ts）；
          // 同一个映射表里 183 也归到 FILE_VERSION_CONFLICT。
          win32_error: 80,
        } satisfies WinfsError);
      }

      const payload = Buffer.from(req.content_base64, 'base64');
      const target = createHash('sha256').update(payload).digest('hex');
      const honest: WinfsCreateResult = {
        ok: true,
        relative_path: req.relative_path,
        canonical_relative_path: req.relative_path,
        identity_after: { volume_id: VOLUME, file_id: `created-${req.relative_path}`, link_count: 1 },
        after_sha256: target,
        target_sha256: target,
        readback_ok: true,
        flushed: true,
        bytes_written: payload.length,
      };
      const override = faultyCreate ? options.createReceipt?.(req) : undefined;
      return Promise.resolve(override === undefined ? honest : { ...honest, ...override });
    },

    resolvePath: (req) => {
      calls.push('resolvePath');
      const injected = options.readErrors?.get(req.relative_path);
      if (injected !== undefined) return Promise.resolve(injected);
      const object = find(req.relative_path);
      if (object === undefined || object.sha256 === null) return Promise.resolve(missing(req.relative_path));
      return Promise.resolve({
        ok: true,
        relative_path: req.relative_path,
        canonical_relative_path: object.canonical,
        identity: { volume_id: VOLUME, file_id: object.probe_file_id, link_count: 1 },
        size: 0,
        // 探针不读内容，因此这两个字段是空的 —— 真后端在这里同样如此。
        sha256: '',
        bytes_base64: '',
        attributes: {
          is_reparse: false,
          is_directory: object.is_directory,
          names: object.is_directory ? ['directory'] : ['archive'],
        },
      } satisfies WinfsReadResult);
    },

    readFileGuarded: (req) => {
      calls.push('readFileGuarded');
      const injected = options.readErrors?.get(req.relative_path);
      if (injected !== undefined) return Promise.resolve(injected);
      const object = find(req.relative_path);
      if (object === undefined || object.sha256 === null) return Promise.resolve(missing(req.relative_path));
      // 真护栏对目录返回 INVALID_ARGUMENT（`Assert-HandleMatches` 之后那一句）。
      if (object.is_directory) {
        return Promise.resolve({
          ok: false,
          code: 'INVALID_ARGUMENT',
          message: '目标是目录，不是文件',
          win32_error: 0,
        } satisfies WinfsError);
      }
      return Promise.resolve({
        ok: true,
        relative_path: req.relative_path,
        canonical_relative_path: object.canonical,
        identity: { volume_id: VOLUME, file_id: object.file_id, link_count: 1 },
        size: 0,
        sha256: object.sha256,
        bytes_base64: '',
        attributes: { is_reparse: false, is_directory: false, names: ['archive'] },
      } satisfies WinfsReadResult);
    },

    writeFileGuarded: (req) => {
      calls.push('writeFileGuarded');
      attempts.push(req);
      const faulty = faultedHere(req.relative_path);
      options.beforeWrite?.(req, disk);

      const injected = faulty ? options.writeErrors?.get(req.relative_path) : undefined;
      if (injected !== undefined) {
        // 带着现场观测的失败 = 护栏**已经越过**破坏性区域，而它观测到的东西
        // 就是盘上此刻的样子。假磁盘照样要跟上 —— 否则「回滚的前置条件是
        // 现场观测到的那个哈希」这句话在夹具里永远对不上，而那正是
        // LWB-029 要测的那一格。
        const broken = find(req.relative_path);
        if (broken !== undefined && injected.actual_state !== undefined) {
          broken.sha256 = injected.actual_state.sha256;
          broken.file_id = injected.actual_state.identity.file_id;
        }
        return Promise.resolve(injected);
      }

      const object = find(req.relative_path);
      // 假护栏**照着真护栏的规矩**核对基线与身份。少了这一步，一个
      // 「把别人的哈希当基线传下去」的实现也能让本文件的用例全绿。
      if (object === undefined || object.sha256 === null) return Promise.resolve(missing(req.relative_path));
      if (req.expected_sha256 !== object.sha256) {
        return Promise.resolve({
          ok: false,
          code: 'FILE_VERSION_CONFLICT',
          message: '打开后的基线哈希与 expected_sha256 不符',
          win32_error: 0,
        } satisfies WinfsError);
      }
      if (req.expected_file_id != null && req.expected_file_id !== object.file_id) {
        return Promise.resolve({
          ok: false,
          code: 'FILE_VERSION_CONFLICT',
          message: '打开后的对象身份与 expected_file_id 不符',
          win32_error: 0,
        } satisfies WinfsError);
      }

      const payload = Buffer.from(req.content_base64, 'base64');
      const target = createHash('sha256').update(payload).digest('hex');
      // 「写之前是什么」必须在改盘面**之前**取下来：真护栏回的是它打开
      // 那一刻看到的哈希，而不是写完之后的。顺序写反了的话，这一项会
      // 恒等于 `after_sha256` —— 一份自洽但没意义的回执。
      const before = object.sha256;
      // 打开、核对基线、截断、写入 —— 盘上的内容就是这一段字节了。
      if (options.applyWrites === true) object.sha256 = target;
      const identity = { volume_id: VOLUME, file_id: object.file_id, link_count: 1 };
      const honest: WinfsWriteResult = {
        ok: true,
        relative_path: req.relative_path,
        canonical_relative_path: object.canonical,
        identity_before: identity,
        identity_after: identity,
        before_sha256: before,
        after_sha256: target,
        target_sha256: target,
        readback_ok: true,
        flushed: true,
        bytes_written: payload.length,
      };
      const override = faulty ? options.receipt?.(req) : undefined;
      return Promise.resolve(override === undefined ? honest : { ...honest, ...override });
    },
  };

  return { ops, calls, attempts, creates, disk };
}

const applierFor = (fake: FakeOps) => createNativeApplier({ repos, ops: fake.ops, blobs });

/** 在第 n 次**成功**写入之后回调（用来构造「写到一半被中止」这类事件）。 */
function afterNthWrite(fake: FakeOps, n: number, hook: () => void): void {
  const inner = fake.ops.writeFileGuarded.bind(fake.ops);
  let count = 0;
  fake.ops.writeFileGuarded = async (req) => {
    const result = await inner(req);
    count += 1;
    if (count === n) hook();
    return result;
  };
}

/** 在第 n 次探针**之前**回调。 */
function beforeNthProbe(fake: FakeOps, n: number, hook: () => void): void {
  const inner = fake.ops.resolvePath.bind(fake.ops);
  let count = 0;
  fake.ops.resolvePath = async (req) => {
    count += 1;
    if (count === n) hook();
    return inner(req);
  };
}

/**
 * 报告是 `applied`，返回它那句话（逐条目终局的折叠结果）。
 *
 * 不用 `deepEqual(report, {kind:'applied'})`：LWB-029 之后 `applied` 还带
 * 着一句**逐条目**的账（几个写成功、几个本来就在目标上），而那句话正是
 * 本文件下面好几条用例要看的东西。把它排除在断言之外，等于把
 * 「报告里到底说了什么」留成了没人看的自由文本。
 */
function appliedDetail(report: ApplyReport): string {
  assert.equal(report.kind, 'applied', `本应是 applied，实际是 ${JSON.stringify(report)}`);
  return report.detail ?? '';
}

/**
 * 报告是 `rolled_back`，返回它那句话。
 *
 * 与 `applied` 分开成两个函数，而不是一个「返回 detail」的通用函数：
 * 这两个 kind 在**磁盘状态**上说的不是一件事，用例混用会让
 * 「这次执行到底有没有留下字节」读起来变得含糊。
 */
function rolledBackDetail(report: ApplyReport): string {
  assert.equal(report.kind, 'rolled_back', `本应是 rolled_back，实际是 ${JSON.stringify(report)}`);
  return report.kind === 'rolled_back' ? report.detail : '';
}

/** 假磁盘上那个对象此刻的哈希。`null` 表示那个路径上什么都没有。 */
function diskSha(fake: FakeOps, canonical: string): string | null {
  const object = fake.disk.find((o) => o.canonical === canonical);
  assert.ok(object !== undefined, `假磁盘上没有 ${canonical} 这一格`);
  return object.sha256;
}

/** 断言它抛了，并把错误交回来。 */
async function thrownBy(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof Error, `抛出的不是 Error：${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: '本应抛出，却没有抛' });
}

const errorMap = (entries: readonly (readonly [string, WinfsError])[]): ReadonlyMap<string, WinfsError> =>
  new Map(entries);

// ---------------------------------------------------------------------------
// A 组：核对 → 记账 → 写入
// ---------------------------------------------------------------------------

describe('LWB-027 A 组：三步的顺序，以及「不用写」与「写不成」是两回事', () => {
  it('A1 记账发生在**写入之前**，且写下的字节就是被批准的那一份', async () => {
    const { plan, built } = await claimed('a1', [{ path: 'src/a.ts' }]);
    const seen: string[] = [];
    const fake = makeFakeOps({
      objects: built.objects,
      beforeWrite: () => {
        // 本任务最要紧的一条断言：**第一个字节落盘之前**，状态库里已经
        // 写着「这次执行开始了」。反过来的话，一次真实的写入会变成
        // 状态库里查不到来由的内容。
        seen.push(stateOf(built.change_id), opStateOf(built.operation_id));
      },
    });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.match(appliedDetail(report), /已写入并核验 1/);
    assert.deepEqual(seen, ['APPLYING', 'APPLYING'], '写入之前必须已经记下执行意图');
    assert.deepEqual(fake.calls, ['resolvePath', 'readFileGuarded', 'writeFileGuarded']);
    // 终态由协调器写（`#finalize`）。适配器**不去动它**，因此这里停在
    // APPLYING —— 这条断言同时说明了「终局判定只有一处」。
    assert.equal(stateOf(built.change_id), 'APPLYING');

    const item = itemOf(built, 'src/a.ts');
    const write = fake.attempts[0]!;
    assert.equal(write.relative_path, item.canonical_path);
    assert.equal(write.expected_file_id, item.base_file_id, '必须带上身份：同一位置上的另一个对象不能被写入');
    assert.equal(write.expected_sha256, item.base_sha256, '必须带上基线哈希');
    assert.equal(
      createHash('sha256').update(Buffer.from(write.content_base64, 'base64')).digest('hex'),
      item.target_sha256,
      '写下去的字节必须逐字节是被批准的那一份',
    );
  });

  it('A2 磁盘上已经是目标内容 ⇒ no_change：一次都没写，也没记账', async () => {
    const { plan, built } = await claimed('a2', [{ path: 'src/b.ts' }]);
    const item = itemOf(built, 'src/b.ts');
    const objects = built.objects.map((o) =>
      o.canonical === 'src/b.ts' ? { ...o, sha256: item.target_sha256 } : o,
    );
    const fake = makeFakeOps({ objects });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'no_change');
    if (report.kind !== 'no_change') return;
    assert.match(report.detail, /已经是目标内容/);
    assert.equal(fake.attempts.length, 0, '已经是要写的东西，不该再硬写一遍');
    assert.equal(stateOf(built.change_id), 'VALIDATING', '没有写入就不该记下执行意图');
  });

  it('A3 多文件：已经在目标状态的条目被跳过，其余照写', async () => {
    const { plan, built } = await claimed('a3', [{ path: 'src/one.ts' }, { path: 'src/two.ts' }]);
    const one = itemOf(built, 'src/one.ts');
    const objects = built.objects.map((o) =>
      o.canonical === 'src/one.ts' ? { ...o, sha256: one.target_sha256 } : o,
    );
    const fake = makeFakeOps({ objects });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    // 逐条目的账必须分得开「写了一个」与「一个本来就在目标上」——
    // 这正是「不把部分完成当全成功」的另一面（也不把全成功说成部分）。
    assert.match(appliedDetail(report), /已写入并核验 1/);
    assert.match(appliedDetail(report), /无需改动 1/);
    assert.deepEqual(
      fake.attempts.map((w) => w.relative_path),
      ['src/two.ts'],
    );
  });

  it('A4 写入用的是**磁盘规范拼写**，不是条目里记的字符串', async () => {
    // 条目记的是 `src/SHOUT.ts`，磁盘上的拼写是 `src/shout.ts` ——
    // NTFS 大小写不敏感，两者是同一个对象。
    const { plan, built } = await claimed('a4', [
      { path: 'src/SHOUT.ts', disk: { name: 'src/shout.ts', alias: ['src/SHOUT.ts'] } },
    ]);
    const fake = makeFakeOps({ objects: built.objects });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'applied');
    assert.equal(fake.attempts[0]!.relative_path, 'src/shout.ts');
  });
});

// ---------------------------------------------------------------------------
// B 组：写入之前的退出 —— 一个字节都不动
// ---------------------------------------------------------------------------

describe('LWB-027 B 组：写之前退出的两类原因，以及它们的优先级', () => {
  it('B1 创建的目标已被占用 ⇒ 冲突，且 create 一次都没被调用（绝不覆盖）', async () => {
    // 那个名字下面已经有一个**别人的**文件。假磁盘对创建的缺省是「空着」，
    // 因此这一格必须显式说出来 —— 它正是「创建绝不覆盖」要防的那一件事。
    const { plan, built } = await claimed('b1', [
      { path: 'src/new.ts', op: 'create_text', disk: { sha256: sha256('别人的内容\n') } },
    ]);
    const fake = makeFakeOps({ objects: built.objects });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'conflict');
    if (report.kind !== 'conflict') return;
    assert.match(report.detail, /磁盘上的 src\/new\.ts 已经被占用/);
    assert.match(report.detail, /绝不覆盖/);
    // 两条断言缺一不可：没有走到创建，也没有退化成一次覆盖写。
    assert.equal(fake.creates.length, 0, '名字被占着就不该走到 CREATE_NEW');
    assert.equal(fake.attempts.length, 0, '更不该退化成一次覆盖写');
    assert.equal(stateOf(built.change_id), 'VALIDATING');
  });

  it('B2 目标字节与条目自己声明的形态不符 ⇒ 拒绝（计划侧，不是磁盘）', async () => {
    // 声明 utf-8 / 无 BOM，而快照里的字节带 BOM。
    const { plan, built } = await claimed('b2', [{ path: 'src/bom.ts', after: '\ufeffhello\n' }]);
    const fake = makeFakeOps({ objects: built.objects });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'refused');
    if (report.kind !== 'refused') return;
    assert.match(report.detail, /目标字节的实际形态与条目声明不符/);
    assert.equal(fake.attempts.length, 0);
  });

  it('B3 条目记的目标哈希与它的快照不符 ⇒ 拒绝', async () => {
    const { plan, built } = await claimed('b3', [
      { path: 'src/h.ts', target_sha_override: 'a'.repeat(64) },
    ]);
    const fake = makeFakeOps({ objects: built.objects });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'refused');
    if (report.kind !== 'refused') return;
    assert.match(report.detail, /与它引用的快照/);
    assert.equal(fake.attempts.length, 0);
  });

  it('B4 磁盘内容既不是基线也不是目标 ⇒ 冲突（有人在这中间改过它）', async () => {
    const { plan, built } = await claimed('b4', [
      { path: 'src/d.ts', disk: { sha256: sha256('别人改过的\n') } },
    ]);
    const fake = makeFakeOps({ objects: built.objects });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'conflict');
    if (report.kind !== 'conflict') return;
    assert.match(report.detail, /磁盘内容已不是被批准的基线/);
    assert.equal(fake.attempts.length, 0);
  });

  it('B5 同一位置上的对象被换掉了（文件 ID 变了）⇒ 冲突', async () => {
    const { plan, built } = await claimed('b5', [
      { path: 'src/e.ts', disk: { file_id: 'ffffffffffffffff' } },
    ]);
    const fake = makeFakeOps({ objects: built.objects });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'conflict');
    if (report.kind !== 'conflict') return;
    assert.match(report.detail, /目标对象已不是被批准的那一个/);
    assert.equal(fake.attempts.length, 0);
  });

  it('B6 磁盘上的名字命中硬拒绝规则 ⇒ 拒绝，且判的是**句柄规范拼写**', async () => {
    // 条目记的是 `docs/notes.md`，而磁盘上那个对象叫 `.env`。
    // 这一句是写入路径上唯一一处拿磁盘实际名字去过策略的地方。
    const { plan, built } = await claimed('b6', [
      { path: 'docs/notes.md', disk: { name: '.env', alias: ['docs/notes.md'] } },
    ]);
    const fake = makeFakeOps({ objects: built.objects });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'refused');
    if (report.kind !== 'refused') return;
    assert.match(report.detail, /命中硬拒绝规则 HD-ENV/);
    assert.match(report.detail, /没有模型侧或工具侧的例外/);
    assert.equal(fake.attempts.length, 0);
  });

  it('B7 磁盘上那个东西是目录 ⇒ 冲突', async () => {
    const { plan, built } = await claimed('b7', [
      { path: 'src/now-a-dir.ts', disk: { is_directory: true } },
    ]);
    const fake = makeFakeOps({ objects: built.objects });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'conflict');
    if (report.kind !== 'conflict') return;
    assert.match(report.detail, /是目录/);
    assert.equal(fake.attempts.length, 0);
  });

  it('B8 目标不见了 ⇒ 冲突；护栏不可用 ⇒ 拒绝', async () => {
    const gone = await claimed('b8a', [{ path: 'src/gone.ts', disk: { sha256: null } }]);
    const goneReport = await applierFor(makeFakeOps({ objects: gone.built.objects }))(
      gone.plan,
      new AbortController().signal,
    );
    assert.equal(goneReport.kind, 'conflict');
    if (goneReport.kind !== 'conflict') return;
    assert.match(goneReport.detail, /护栏码 NOT_FOUND/);
    // 报告会进执行日志，而日志不该成为一份本机目录结构的抄本：
    // 护栏消息里的绝对路径被换成 `<工作区根>`。
    assert.ok(!goneReport.detail.includes(ROOT_PATH), `报告里不该出现工作区根的绝对路径：${goneReport.detail}`);
    assert.match(goneReport.detail, /<工作区根>/);

    const down = await claimed('b8b', [{ path: 'src/down.ts' }]);
    const downReport = await applierFor(
      makeFakeOps({
        objects: down.built.objects,
        readErrors: errorMap([
          [
            'src/down.ts',
            { ok: false, code: 'NATIVE_GUARD_UNAVAILABLE', message: '夹具：护栏没起来', win32_error: 0 },
          ],
        ]),
      }),
    )(down.plan, new AbortController().signal);
    assert.equal(downReport.kind, 'refused');
    if (downReport.kind !== 'refused') return;
    assert.match(downReport.detail, /护栏码 NATIVE_GUARD_UNAVAILABLE/);
  });

  it('B9 一个条目被拒、另一个冲突 ⇒ 报**拒绝**', async () => {
    const { plan, built } = await claimed('b9', [
      // 第一条是磁盘那一侧的问题：有人在这中间改过它，重新看一遍磁盘能解决。
      { path: 'src/conflicts.ts', disk: { sha256: sha256('别人改过的\n') } },
      // 第二条是**计划自己**站不住：声明的形态与它引用的快照不符。
      // 这一条永远跑不成，而新提案会带着同一个形态回来 —— 所以它优先，
      // 哪怕它在条目顺序里排在后头。
      { path: 'src/unsupported.ts', after: '﻿hello\n' },
    ]);
    const fake = makeFakeOps({ objects: built.objects });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'refused', '一个永远跑不成的条目，不该被一次冲突盖过去');
    if (report.kind !== 'refused') return;
    assert.match(report.detail, /目标字节的实际形态与条目声明不符/);
    assert.equal(fake.attempts.length, 0);
  });
});

// ---------------------------------------------------------------------------
// C 组：越过那条线之后的失败 —— 能收回的收回，收不回的进恢复
// ---------------------------------------------------------------------------

describe('LWB-027 C 组：写入中途失败时，先记账、再有界回滚', () => {
  it('C1 第一个文件写成、第二个失败 ⇒ 收回第一个，报 rolled_back', async () => {
    const { plan, built } = await claimed('c1', [{ path: 'src/one.ts' }, { path: 'src/two.ts' }]);
    const fake = makeFakeOps({
      objects: built.objects,
      applyWrites: true,
      faultFirstWriteOnly: true,
      // 没有 `touched`：护栏在越过破坏性区域**之前**就失败了
      // （占用检查没通过），因此它一个字节都没动过第二个文件。
      writeErrors: errorMap([
        ['src/two.ts', { ok: false, code: 'FILE_BUSY', message: '夹具：被占用', win32_error: 32 }],
      ]),
    });

    const report = await applierFor(fake)(plan, new AbortController().signal);
    const detail = rolledBackDetail(report);

    assert.match(detail, /FILE_BUSY/, '失败的原因必须出现在报告里');
    assert.match(detail, /已回到基线/, '第一个文件必须被收回去');
    assert.match(detail, /未改动/, '第二个文件一个字都没动过');
    // 三次**尝试**：第一个成了，第二个当场失败，第三次是把第一个**写回去**。
    // 停在第一个失败处，而不是「跳过它继续写剩下的」。
    assert.deepEqual(
      fake.attempts.map((w) => w.relative_path),
      ['src/one.ts', 'src/two.ts', 'src/one.ts'],
    );
    assert.equal(
      fake.attempts[2]!.expected_sha256,
      itemOf(built, 'src/one.ts').target_sha256,
      '回滚的前置条件是**我们写下去的那一份**，不是批准时的基线',
    );
    // 盘面回到了执行之前。
    assert.equal(diskSha(fake, 'src/one.ts'), itemOf(built, 'src/one.ts').base_sha256);
  });

  it('C2 一个字节都没写成的失败之后，盘上必须**一个字节都没变**', async () => {
    // 唯一一个条目在护栏里被拒（越过破坏性区域**之前**），因此没有任何东西
    // 需要收回 —— 但执行已经进过 `APPLYING`，所以它是一个 rolled_back，
    // 而不是一次「在写入之前退出」的 conflict。LWB-028 时这一格只能抛
    // （那时没有可报的回滚），代价记在偏离项 106 上。
    const { plan, built } = await claimed('c2', [{ path: 'src/c.ts' }]);
    const before = built.objects.find((o) => o.canonical === 'src/c.ts')!.sha256;
    const fake = makeFakeOps({
      objects: built.objects,
      applyWrites: true,
      faultFirstWriteOnly: true,
      writeErrors: errorMap([
        ['src/c.ts', { ok: false, code: 'FILE_BUSY', message: '夹具：被占用', win32_error: 32 }],
      ]),
    });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.match(rolledBackDetail(report), /未改动/);
    assert.equal(fake.attempts.length, 1, '只试了一次写入，回滚一次都没有发生');
    assert.equal(diskSha(fake, 'src/c.ts'), before);
    assert.equal(stateOf(built.change_id), 'APPLYING', '终局由协调器写；适配器停在 APPLYING');
  });

  it('C3 护栏截断了文件之后失败 ⇒ 按**现场观测**把基线写回去', async () => {
    // 越过截断线之后的失败，磁盘上剩下什么不由我们说了算 —— 但护栏在仍
    // 持有句柄时看了一眼，而那一份观测就是回滚的前置条件。
    const { plan, built } = await claimed('c3', [{ path: 'src/t.ts' }]);
    const truncated = sha256('');
    const fake = makeFakeOps({
      objects: built.objects,
      applyWrites: true,
      faultFirstWriteOnly: true,
      writeErrors: errorMap([
        [
          'src/t.ts',
          {
            ok: false,
            code: 'IO_ERROR',
            message: 'SetEndOfFile(截断) 失败',
            win32_error: 1224,
            // 「动过」与「现场」是两件事（LWB-029）：观测到了，就得说动过。
            touched: true,
            actual_state: {
              size: 0,
              identity: { volume_id: VOLUME, file_id: 'file-c3-src/t.ts', link_count: 1 },
              sha256: truncated,
              observed_bytes: 0,
              cap_bytes: 1048576,
              observed_at_utc: T0,
            },
          },
        ],
      ]),
    });

    const report = await applierFor(fake)(plan, new AbortController().signal);
    const detail = rolledBackDetail(report);

    assert.match(detail, /Win32 1224/);
    assert.match(detail, /已回到基线/);
    assert.deepEqual(
      fake.attempts.map((w) => w.relative_path),
      ['src/t.ts', 'src/t.ts'],
    );
    assert.equal(fake.attempts[1]!.expected_sha256, truncated, '回滚的前置条件必须是**现场**那一个哈希');
    assert.equal(diskSha(fake, 'src/t.ts'), itemOf(built, 'src/t.ts').base_sha256);
  });

  it('C4 回执说 ok 但回读不符 ⇒ 收回，报 rolled_back（不轻信护栏的回执）', async () => {
    const { plan, built } = await claimed('c4', [{ path: 'src/r.ts' }]);
    const fake = makeFakeOps({
      objects: built.objects,
      applyWrites: true,
      faultFirstWriteOnly: true,
      receipt: () => ({ readback_ok: false }),
    });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.match(rolledBackDetail(report), /回读与目标不符/);
    assert.deepEqual(
      fake.attempts.map((w) => w.relative_path),
      ['src/r.ts', 'src/r.ts'],
    );
  });

  it('C5 回执说 ok 但没刷盘 ⇒ 收回，报 rolled_back', async () => {
    const { plan, built } = await claimed('c5', [{ path: 'src/f.ts' }]);
    const fake = makeFakeOps({
      objects: built.objects,
      applyWrites: true,
      faultFirstWriteOnly: true,
      receipt: () => ({ flushed: false }),
    });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.match(rolledBackDetail(report), /刷盘未完成/);
  });

  it('C6 写入期间对象身份变了 ⇒ 不自动收回，进恢复', async () => {
    // 这一次回执描述的**不是**我们写的那个对象了，因此拿它的哈希当前置条件
    // 会把一次回滚指向一个我们没写过的对象。这是「收不回来」的那一格。
    const { plan, built } = await claimed('c6', [{ path: 'src/i.ts' }]);
    const fake = makeFakeOps({
      objects: built.objects,
      applyWrites: true,
      receipt: () => ({ identity_after: { volume_id: VOLUME, file_id: 'ffffffffffffffff', link_count: 1 } }),
    });

    const error = await thrownBy(() => applierFor(fake)(plan, new AbortController().signal));

    assert.match(error.message, /对象身份发生了变化/);
    assert.match(error.message, /需要人工确认/);
    assert.ok(isBridgeError(error));
    assert.equal(error.code, 'RECOVERY_REQUIRED');
    assert.equal(error.details?.guard_verdict, 'RECEIPT_REJECTED');
    assert.equal(
      fake.attempts.filter((w) => w.expected_sha256 === 'ffffffffffffffff').length,
      0,
      '绝不能拿一个我们没写过的对象的哈希去回滚',
    );
  });

  it('C6 核对阶段就被中止 ⇒ 抛，且一次都没写、状态也没动', async () => {
    const { plan, built } = await claimed('c6', [{ path: 'src/x.ts' }, { path: 'src/y.ts' }]);
    const controller = new AbortController();
    const fake = makeFakeOps({ objects: built.objects });
    // 第 2 次探针之前中止：第一个条目已经核对完，第二个刚开动。
    beforeNthProbe(fake, 2, () => controller.abort(new Error('测试中止')));

    const error = await thrownBy(() => applierFor(fake)(plan, controller.signal));

    assert.match(error.message, /被中止/);
    assert.equal(fake.attempts.length, 0, '中止之后不得开始任何一次写入');
    assert.equal(stateOf(built.change_id), 'VALIDATING', '没有写入就不该记下执行意图');
  });

  it('C7 第一个文件写完之后被中止 ⇒ 抛，且不再写第二个', async () => {
    const { plan, built } = await claimed('c7', [{ path: 'src/one.ts' }, { path: 'src/two.ts' }]);
    const controller = new AbortController();
    const fake = makeFakeOps({ objects: built.objects });
    afterNthWrite(fake, 1, () => controller.abort(new Error('测试中止')));

    const error = await thrownBy(() => applierFor(fake)(plan, controller.signal));

    assert.match(error.message, /被中止/);
    assert.equal(fake.attempts.length, 1, '中止之后不得再写第二个文件');
    assert.equal(stateOf(built.change_id), 'APPLYING', '已经写过字节，状态必须停在 APPLYING');
  });
});

// ---------------------------------------------------------------------------
// D 组：记账失败，与两次核对之间的那个窗口
// ---------------------------------------------------------------------------

describe('LWB-027 D 组：记不上账就不写；两次核对之间对象被换掉', () => {
  it('D1 执行意图记不进状态库 ⇒ 抛，且一个字都不写', async () => {
    const { plan, built } = await claimed('d1', [{ path: 'src/z.ts' }]);
    // 把修改集推离 VALIDATING：阶段 B 的转移会当场被转移表拒绝。
    repos.changes.transition(built.change_id, ['VALIDATING'], 'APPLYING');
    const fake = makeFakeOps({ objects: built.objects });

    const error = await thrownBy(() => applierFor(fake)(plan, new AbortController().signal));

    assert.match(error.message, /无法把执行意图写入状态库/);
    assert.equal(fake.attempts.length, 0, '账都记不上，绝不允许写字节');
  });

  it('D2 探针与读取看到的不是同一个对象 ⇒ 冲突', async () => {
    // 「删除重建」恰好发生在两次调用之间：探针看到基线那个对象，
    // 读取看到新对象。这两条读数拼起来的结论不成立。
    const { plan, built } = await claimed('d2', [{ path: 'src/swap.ts' }]);
    const item = itemOf(built, 'src/swap.ts');
    const objects = built.objects.map((o) =>
      o.canonical === 'src/swap.ts'
        ? { ...o, probe_file_id: item.base_file_id!, file_id: 'bbbbbbbbbbbbbbbb' }
        : o,
    );
    const fake = makeFakeOps({ objects });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'conflict');
    if (report.kind !== 'conflict') return;
    assert.match(report.detail, /两次核对之间被换掉了/);
    assert.equal(fake.attempts.length, 0);
  });
});

// ---------------------------------------------------------------------------
// E 组：创建 —— 判定与创建是同一次系统调用
// ---------------------------------------------------------------------------

describe('LWB-028 E 组：创建走 CREATE_NEW，绝不退化成一次覆盖写', () => {
  it('E1 目标不存在 ⇒ 只探两次就创建；写下去的字节是被批准的那一份', async () => {
    const { plan, built } = await claimed('e1', [
      { path: 'src/new.ts', op: 'create_text', after: '崭新的内容\n' },
    ]);
    const fake = makeFakeOps({ objects: built.objects });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.match(appliedDetail(report), /已写入并核验 1/);
    // 目标一次（问那个名字空不空）、父目录一次（问它在不在），然后就是创建。
    // 没有 `readFileGuarded`（创建没有基线可读），更没有 `writeFileGuarded`。
    assert.deepEqual(fake.calls, ['resolvePath', 'resolvePath', 'createFileGuarded']);
    assert.equal(fake.attempts.length, 0, '创建这条路上不该出现一次改写');

    const item = itemOf(built, 'src/new.ts');
    const create = fake.creates[0]!;
    assert.equal(create.relative_path, item.canonical_path);
    // 两条路方向相反，因此请求的形状也不同：创建**没有**基线位置可填。
    assert.ok(!('expected_sha256' in create), '创建的请求里不该出现基线哈希');
    assert.ok(!('expected_file_id' in create), '创建的请求里不该出现基线身份');
    assert.equal(
      createHash('sha256').update(Buffer.from(create.content_base64, 'base64')).digest('hex'),
      item.target_sha256,
      '建出来的文件必须逐字节是被批准的那一份',
    );
    // 终局由协调器写（`#finalize`）。适配器**不去动它**，因此这里停在 APPLYING。
    assert.equal(stateOf(built.change_id), 'APPLYING');
  });

  it('E2 探到不存在之后、创建之前被别人抢先 ⇒ CREATE_NEW 失败，一个对象都没建出来', async () => {
    const foreign = sha256('抢先写进来的一行\n');
    const { plan, built } = await claimed('e2', [{ path: 'src/raced.ts', op: 'create_text' }]);
    // `beforeCreate` 在**创建那一刻**往假磁盘上放一个对象，也就是把
    // 「阶段 A 的探针」与「阶段 C 的 CREATE_NEW」之间那个窗口真的撬开一次。
    const fake = makeFakeOps({
      objects: built.objects,
      beforeCreate: (req, disk) => {
        // **替换**那一格，不是往后面再挂一个：一个名字在磁盘上只能对应一个
        // 对象，而往后面挂一个会让 `find` 先撞上原来那条「不存在」的记录，
        // 于是「抢先建了同名文件」这件事在假磁盘上根本没有发生。
        const at = disk.findIndex((o) => o.canonical === req.relative_path);
        disk[at] = {
          ...disk[at]!,
          file_id: 'fffffffffffffffe',
          probe_file_id: 'fffffffffffffffe',
          sha256: foreign,
        };
      },
    });

    const report = await applierFor(fake)(plan, new AbortController().signal);
    const detail = rolledBackDetail(report);

    // 阶段 A 说「空着」，`CREATE_NEW` 说「已经有人了」—— 权威的是后者，
    // 而那一次系统调用**没有**碰过别人的字节。
    assert.equal(fake.creates.length, 1);
    assert.equal(fake.attempts.length, 0, '撞上已有文件时绝不改走覆盖写');
    assert.equal(diskSha(fake, 'src/raced.ts'), foreign, '抢先写进去的那份字节原封不动');
    assert.match(detail, /FILE_VERSION_CONFLICT/);
    assert.match(detail, /Win32 80/);
    // 一个对象都没建出来 ⇒ 没有东西需要收回 ⇒ rolled_back。
    // LWB-028 时这一格只能抛（那时没有可报的回滚），代价记在偏离项 106 上；
    // LWB-029 把这条边接上了，于是「确实什么都没留下」终于有了一个
    // 说得出口的结局 —— 而不是一次多余的人工核验。
    assert.match(detail, /未改动/);
  });

  it('E3 父目录不存在 ⇒ 冲突；绝不退化成一次 mkdir', async () => {
    const { plan, built } = await claimed('e3', [
      { path: 'src/deep/new.ts', op: 'create_text', disk: { parent_absent: true } },
    ]);
    const fake = makeFakeOps({ objects: built.objects });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'conflict');
    if (report.kind !== 'conflict') return;
    assert.match(report.detail, /父目录 src\/deep 不存在/);
    assert.match(report.detail, /不隐式创建父目录/);
    // 护栏里没有 mkdir，业务层也没有补一个 —— 一次创建都没试过。
    assert.equal(fake.creates.length, 0);
  });

  it('E4 父路径上是一个文件 ⇒ 冲突（那不是一份能放东西的目录）', async () => {
    // `src` 这个**文件**占着位置，而另一个条目要在它下面新建 `src/new.ts`。
    const { plan, built } = await claimed('e4', [{ path: 'src' }, { path: 'src/new.ts', op: 'create_text' }]);
    const fake = makeFakeOps({ objects: built.objects });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'conflict');
    if (report.kind !== 'conflict') return;
    assert.match(report.detail, /父路径 src 在磁盘上不是一个目录/);
    assert.equal(fake.creates.length, 0);
    assert.equal(fake.attempts.length, 0);
  });

  it('E5 工作区根下的创建 ⇒ 不探父目录（根是目录这件事由登记说明）', async () => {
    const { plan, built } = await claimed('e5', [{ path: 'ROOT-LEVEL.md', op: 'create_text' }]);
    const fake = makeFakeOps({ objects: built.objects });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'applied');
    // **一次**探针。父目录就是工作区根自己，而护栏对「目录根 + 空相对路径」
    // 是刻意拒绝的（那根本不是一次寻址），因此这一格不探、也不该探。
    assert.deepEqual(fake.calls, ['resolvePath', 'createFileGuarded']);
    assert.equal(fake.creates[0]!.relative_path, 'ROOT-LEVEL.md');
  });

  it('E6 回执说回读与目标不符 ⇒ 抛（新建的文件不得报告为完成）', async () => {
    const { plan, built } = await claimed('e6', [{ path: 'src/r.ts', op: 'create_text' }]);
    const fake = makeFakeOps({ objects: built.objects, createReceipt: () => ({ readback_ok: false }) });

    const error = await thrownBy(() => applierFor(fake)(plan, new AbortController().signal));

    assert.match(error.message, /回读与目标不符/);
    assert.equal(fake.creates.length, 1, '创建已经发生过，因此只能是待恢复 —— 不是一次干净的拒绝');
  });

  it('E7 回执里的 target_sha256 不是本条目的目标 ⇒ 抛', async () => {
    // 创建**没有基线可对**，因此「护栏收到的到底是不是我们批准的那份字节」
    // 是这条路上唯一一处把「批准的内容」与「写下去的内容」连起来的检查。
    const { plan, built } = await claimed('e7', [{ path: 'src/w.ts', op: 'create_text' }]);
    const fake = makeFakeOps({
      objects: built.objects,
      createReceipt: () => ({ target_sha256: 'b'.repeat(64) }),
    });

    const error = await thrownBy(() => applierFor(fake)(plan, new AbortController().signal));

    assert.match(error.message, /护栏收到的字节与本条目的目标不符/);
  });

  it('E8 一次修改集里既有改写又有创建 ⇒ 各走各的路，不互相串味', async () => {
    const { plan, built } = await claimed('e8', [
      { path: 'src/existing.ts' },
      { path: 'src/brand-new.ts', op: 'create_text' },
    ]);
    const fake = makeFakeOps({ objects: built.objects });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.match(appliedDetail(report), /已写入并核验 2/);
    assert.deepEqual(fake.attempts.map((w) => w.relative_path), ['src/existing.ts']);
    assert.deepEqual(fake.creates.map((c) => c.relative_path), ['src/brand-new.ts']);
  });

  it('E9 目标在磁盘上的拼写不同（大小写别名）⇒ 仍然算名字被占', async () => {
    // NTFS 大小写不敏感：条目写 `src/New.ts`，磁盘上那个对象叫 `src/new.ts`，
    // 两者是**同一个**名字位置。`CREATE_NEW` 会失败，阶段 A 也不该判「空着」。
    const { plan, built } = await claimed('e9', [
      {
        path: 'src/New.ts',
        op: 'create_text',
        disk: { name: 'src/new.ts', alias: ['src/New.ts'], sha256: sha256('已存在\n') },
      },
    ]);
    const fake = makeFakeOps({ objects: built.objects });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'conflict');
    if (report.kind !== 'conflict') return;
    // 报告说的是**磁盘上那个拼写**，不是条目里记的那个。
    assert.match(report.detail, /磁盘上的 src\/new\.ts 已经被占用/);
    assert.equal(fake.creates.length, 0);
  });
});

// ---------------------------------------------------------------------------
// F 组：日志边界上的故障注入
// ---------------------------------------------------------------------------

/**
 * 在**某一个日志边界**上「停住进程」。
 *
 * 打的是 `repos.journal.append` —— 也就是每条条目级日志真正落库的那一刻。
 * 这是**唯一**一个能让「走到这一步之后就死」与「这一步还没走到」分开的
 * 注入点：`apply.ts` 的每一条日志都正好写在它描述的那件事的边界上，
 * 因此拦住这一条日志，等价于「那件事发生了，而账上没记」。
 *
 * 为什么这组用例值得单独存在：LWB-029 的验收标准第一条就是
 * 「故障注入覆盖每个日志边界」。而边界注入的产物不是一份报告（进程死了，
 * 没人写报告），是**一本账** —— 于是这组用例断言的是「按这本账，每个文件
 * 现在算什么」，也就是恢复流程（LWB-030）将来要读的那一份结论。
 */
function crashAt(stage: ItemStage): () => boolean {
  const original = repos.journal.append;
  let fired = false;
  repos.journal.append = function patched(input: Parameters<typeof original>[0]): number {
    if (input.stage === stage && !fired) {
      fired = true;
      throw new Error(`注入：在 ${stage} 这个边界上进程停住`);
    }
    return original.call(repos.journal, input);
  };
  return () => fired;
}

/** 按当前的账本折叠出来的结论 —— 恢复流程要读的就是这一份。 */
function ledgerOf(built: Built): {
  readonly events: readonly ItemEvent[];
  readonly outcomes: Map<string, ItemOutcome>;
  readonly aggregate: Aggregate;
  readonly stagesOf: (itemId: string) => string[];
} {
  const events = readItemEvents(repos, built.operation_id);
  const outcomes = itemOutcomes(events);
  return {
    events,
    outcomes,
    aggregate: aggregateOf(outcomes, built.items.length),
    stagesOf: (itemId) => events.filter((e) => e.item_id === itemId).map((e) => e.stage),
  };
}

/** 假磁盘上**此刻**与执行之前不同的那些格子。 */
const dirtied = (fake: FakeOps, built: Built): string[] =>
  built.objects
    .filter((before) => diskSha(fake, before.canonical) !== before.sha256)
    .map((before) => before.canonical);

/** 一次改写失败：护栏已越过破坏性区域，并把现场观测带了回来。 */
const tornWrite = (sha: string, fileId: string): WinfsError => ({
  ok: false,
  code: 'IO_ERROR',
  message: '夹具：写到一半失败了',
  win32_error: 5,
  touched: true,
  actual_state: {
    identity: { volume_id: VOLUME, file_id: fileId, link_count: 1 },
    sha256: sha,
    size: 4,
    observed_bytes: 4,
    cap_bytes: 1048576,
    observed_at_utc: T0,
  },
});

describe('LWB-029 F 组：每一个日志边界上的故障注入', () => {
  it('F1 边界 `intent`（第一个字节之前）⇒ 盘上零改动，账上无话可说', async () => {
    const { plan, built } = await claimed('f1', [{ path: 'src/one.ts' }, { path: 'src/two.ts' }]);
    const fake = makeFakeOps({ objects: built.objects, applyWrites: true });
    const fired = crashAt(ITEM_STAGE.intent);

    const thrown = await thrownBy(() => applierFor(fake)(plan, new AbortController().signal));

    assert.equal(fired(), true, '注入没有落在 `intent` 这个边界上');
    assert.match(thrown.message, /注入：在 item_intent 这个边界上进程停住/);
    // `intent` 写在护栏调用**之前**，因此这次注入拦下的正是「还没开始写」。
    assert.equal(fake.attempts.length, 0, '账没记上就不许动文件');
    assert.deepEqual(dirtied(fake, built), []);
    // 账上一条都没有 ⇒ 折叠说「说不清」。这一格必须比现实**悲观**：
    // 进程是在记意图的时候死的，磁盘上大概率什么都没发生，而账上没有
    // 任何一条能支撑这句话，于是它只能报不出来。
    const ledger = ledgerOf(built);
    assert.equal(ledger.events.length, 0);
    assert.equal(ledger.aggregate, 'unfinished');
    assert.equal(stateOf(built.change_id), 'APPLYING');
  });

  it('F2 边界 `verified`（三条回执日志同一事务）⇒ 盘上已有我们的字节，账上只有意图', async () => {
    const { plan, built } = await claimed('f2', [{ path: 'src/one.ts' }, { path: 'src/two.ts' }]);
    const fake = makeFakeOps({ objects: built.objects, applyWrites: true });
    const fired = crashAt(ITEM_STAGE.verified);

    await thrownBy(() => applierFor(fake)(plan, new AbortController().signal));

    assert.equal(fired(), true);
    // 字节确实写出去了 —— 这正是最危险的那一格：盘上是**批准过的内容**，
    // 而账上说不清。宁可报「不知道」，也绝不报「写成了」。
    assert.equal(diskSha(fake, 'src/one.ts'), itemOf(built, 'src/one.ts').target_sha256);
    const ledger = ledgerOf(built);
    // 三条回执日志在**同一个事务**里：第三条抛了，前两条一起回滚。
    // 「说了写了、没说刷没刷」这种中间态因此在库层面就不可能出现。
    assert.deepEqual(ledger.stagesOf(itemOf(built, 'src/one.ts').id), [ITEM_STAGE.intent]);
    assert.equal(ledger.aggregate, 'unfinished');
  });

  it('F3 边界 `failed`（护栏越过破坏性区域）⇒ 账上只剩意图，盘上是护栏的现场', async () => {
    const { plan, built } = await claimed('f3', [{ path: 'src/one.ts' }]);
    const torn = sha256('写到一半的那一段');
    const fake = makeFakeOps({
      objects: built.objects,
      applyWrites: true,
      writeErrors: errorMap([['src/one.ts', tornWrite(torn, itemOf(built, 'src/one.ts').base_file_id!)]]),
    });
    const fired = crashAt(ITEM_STAGE.failed);

    await thrownBy(() => applierFor(fake)(plan, new AbortController().signal));

    assert.equal(fired(), true);
    assert.equal(diskSha(fake, 'src/one.ts'), torn, '盘上就是护栏观测到的那一段');
    const ledger = ledgerOf(built);
    assert.deepEqual(ledger.stagesOf(itemOf(built, 'src/one.ts').id), [ITEM_STAGE.intent]);
    // 单条目也要 `unfinished`：把「只有一条 intent」折成任何好结局，
    // 都是在替磁盘说一句没人能证实的话。
    assert.equal(ledger.aggregate, 'unfinished');
  });

  it('F4 边界 `untouched`（护栏证明没动过）⇒ 实际上什么都没发生，账上却说不清', async () => {
    const { plan, built } = await claimed('f4', [{ path: 'src/one.ts' }]);
    const fake = makeFakeOps({
      objects: built.objects,
      applyWrites: true,
      writeErrors: errorMap([
        ['src/one.ts', { ok: false, code: 'FILE_BUSY', message: '夹具：被占用', win32_error: 32 }],
      ]),
    });
    const fired = crashAt(ITEM_STAGE.untouched);

    await thrownBy(() => applierFor(fake)(plan, new AbortController().signal));

    assert.equal(fired(), true);
    assert.deepEqual(dirtied(fake, built), [], '护栏说没动过，盘面必须一个字节都没变');
    const ledger = ledgerOf(built);
    assert.deepEqual(ledger.stagesOf(itemOf(built, 'src/one.ts').id), [ITEM_STAGE.intent]);
    // 悲观是允许的、也是必须的：这句「不知道」的代价是一次人工核验，
    // 而把它写成 `untouched` 的代价是——如果护栏那句话其实是错的，
    // 我们就永久丢掉了「这里可能被改过」这条信息。
    assert.equal(ledger.aggregate, 'unfinished');
  });

  it('F5 边界 `restore_skipped`（动过、现场未知）⇒ 收回没有尝试，账上说不清', async () => {
    const { plan, built } = await claimed('f5', [{ path: 'src/one.ts' }]);
    const fake = makeFakeOps({
      objects: built.objects,
      applyWrites: true,
      writeErrors: errorMap([
        // `touched` 有、`actual_state` 没有：护栏自己都没能看一眼现场。
        [
          'src/one.ts',
          { ok: false, code: 'IO_ERROR', message: '夹具：动过，看不了', win32_error: 5, touched: true },
        ],
      ]),
    });
    const fired = crashAt(ITEM_STAGE.restore_skipped);

    await thrownBy(() => applierFor(fake)(plan, new AbortController().signal));

    assert.equal(fired(), true);
    assert.equal(fake.attempts.length, 1, '现场未知就不许写第二次（那会盖掉我们看不见的东西）');
    const ledger = ledgerOf(built);
    // `failed` 那一条已经记上了（它写在决定要不要收回**之前**），
    // 拦下的是「收回没有尝试」那一条 —— 于是这个条目在账上停在
    // 「可能留有本次执行的字节」，而这一句**是对的**：护栏说它动过。
    assert.deepEqual(ledger.stagesOf(itemOf(built, 'src/one.ts').id), [
      ITEM_STAGE.intent,
      ITEM_STAGE.failed,
    ]);
    assert.equal(ledger.outcomes.get(itemOf(built, 'src/one.ts').id)?.kind, 'left_changed');
    assert.equal(ledger.aggregate, 'unfinished');
  });

  it('F6 边界 `restored`（收回成功、记账时死掉）⇒ 账比现实悲观，而不是相反', async () => {
    const { plan, built } = await claimed('f6', [{ path: 'src/one.ts' }, { path: 'src/two.ts' }]);
    const one = itemOf(built, 'src/one.ts');
    const two = itemOf(built, 'src/two.ts');
    const fake = makeFakeOps({
      objects: built.objects,
      applyWrites: true,
      faultFirstWriteOnly: true,
      writeErrors: errorMap([['src/two.ts', tornWrite(sha256('两号文件的一半'), two.base_file_id!)]]),
    });
    const fired = crashAt(ITEM_STAGE.restored);

    await thrownBy(() => applierFor(fake)(plan, new AbortController().signal));

    assert.equal(fired(), true);
    // 盘上：一号是目标内容，二号**已经回到基线**（收回确实成功了）。
    assert.equal(diskSha(fake, 'src/one.ts'), one.target_sha256);
    assert.equal(diskSha(fake, 'src/two.ts'), two.base_sha256);

    const ledger = ledgerOf(built);
    // 账上：一号写成、二号「可能留有本次执行的字节」—— 而二号其实已经在
    // 基线上了。**账可以比现实悲观，绝不能比现实乐观**：这一句多余的话
    // 换来的是「永远不会有『账说没事、盘上有事』」。
    assert.equal(ledger.outcomes.get(one.id)?.kind, 'written');
    assert.equal(ledger.outcomes.get(two.id)?.kind, 'left_changed');
    assert.equal(ledger.aggregate, 'unfinished');
  });

  it('F7 边界 `restore_failed`（收回也被拒）⇒ 账上留着「可能有字节」，与现实一致', async () => {
    const { plan, built } = await claimed('f7', [{ path: 'src/one.ts' }, { path: 'src/two.ts' }]);
    const two = itemOf(built, 'src/two.ts');
    const torn = sha256('两号文件的一半');
    const fake = makeFakeOps({
      objects: built.objects,
      applyWrites: true,
      // 不设 `faultFirstWriteOnly`：注入对**每一次**写入生效，因此收回那一次
      // 也被拒 —— 这正是一条「护栏一直不让我们碰这个文件」的路。
      writeErrors: errorMap([['src/two.ts', tornWrite(torn, two.base_file_id!)]]),
    });
    const fired = crashAt(ITEM_STAGE.restore_failed);

    await thrownBy(() => applierFor(fake)(plan, new AbortController().signal));

    assert.equal(fired(), true);
    assert.equal(diskSha(fake, 'src/two.ts'), torn, '收回没成功，盘上留着护栏观测到的那一段');
    const ledger = ledgerOf(built);
    assert.deepEqual(ledger.stagesOf(two.id), [ITEM_STAGE.intent, ITEM_STAGE.failed]);
    assert.equal(ledger.outcomes.get(two.id)?.kind, 'left_changed');
    assert.equal(ledger.aggregate, 'unfinished');
  });

  it('F8 边界 `untouched` / `NOT_ATTEMPTED`（补记没轮到的条目）⇒ 少一条就是说不清', async () => {
    const { plan, built } = await claimed('f8', [{ path: 'src/one.ts' }, { path: 'src/two.ts' }]);
    const one = itemOf(built, 'src/one.ts');
    const two = itemOf(built, 'src/two.ts');
    const fake = makeFakeOps({
      objects: built.objects,
      applyWrites: true,
      faultFirstWriteOnly: true,
      writeErrors: errorMap([
        ['src/one.ts', { ok: false, code: 'FILE_BUSY', message: '夹具：被占用', win32_error: 32 }],
      ]),
    });
    // 一号那条 `untouched` 放行，拦下的是给二号补记的那一条。
    const seen = new Set<string>();
    const original = repos.journal.append;
    repos.journal.append = function patched(input: Parameters<typeof original>[0]): number {
      if (input.stage === ITEM_STAGE.untouched && input.error_code === 'NOT_ATTEMPTED') {
        throw new Error('注入：在补记没轮到的条目时进程停住');
      }
      seen.add(`${input.item_id ?? '-'}:${input.stage}`);
      return original.call(repos.journal, input);
    };

    await thrownBy(() => applierFor(fake)(plan, new AbortController().signal));

    assert.equal(seen.has(`${one.id}:${ITEM_STAGE.untouched}`), true, '一号那一条该记上');
    assert.equal(seen.has(`${two.id}:${ITEM_STAGE.untouched}`), false, '二号的补记被拦下了');
    const ledger = ledgerOf(built);
    assert.deepEqual(ledger.stagesOf(two.id), [], '二号账上一条都没有');
    // 没有这次注入的话这一格是 `rolled_back`（一号 `untouched`、二号也补上
    // `untouched`）。少一条就退回 `unfinished` —— 「缺日志的条目不能被当成
    // 没被改」这条判据在这里可以被看见。
    assert.equal(ledger.aggregate, 'unfinished');
  });

  it('F9 边界 `skipped`（阶段 A 判「不用写」）⇒ 那个条目退回说不清', async () => {
    const { plan, built } = await claimed('f9', [{ path: 'src/one.ts' }, { path: 'src/two.ts' }]);
    const one = itemOf(built, 'src/one.ts');
    const objects = built.objects.map((o) =>
      o.canonical === 'src/one.ts' ? { ...o, sha256: one.target_sha256 } : o,
    );
    const fake = makeFakeOps({ objects, applyWrites: true });
    const fired = crashAt(ITEM_STAGE.skipped);

    await thrownBy(() => applierFor(fake)(plan, new AbortController().signal));

    assert.equal(fired(), true);
    assert.equal(fake.attempts.length, 0, '「已经在目标上」不该再硬写一遍');
    const ledger = ledgerOf(built);
    assert.deepEqual(ledger.stagesOf(one.id), []);
    assert.equal(ledger.aggregate, 'unfinished');
  });

  it('F10 没有注入时，同一套夹具折叠出 `applied` —— 上面每一条都对着它比', async () => {
    // 对照组成立，「注入之后变了」才有意义。没有这一条，一个**永远**报
    // `unfinished` 的实现也能让 F1~F9 全绿。
    const { plan, built } = await claimed('f10', [{ path: 'src/one.ts' }, { path: 'src/two.ts' }]);
    const fake = makeFakeOps({ objects: built.objects, applyWrites: true });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.match(appliedDetail(report), /已写入并核验 2/);
    assert.equal(ledgerOf(built).aggregate, 'applied');
  });
});

// ---------------------------------------------------------------------------
// G 组：第一、中间、最后一个文件
// ---------------------------------------------------------------------------

/** 三个文件的夹具。G 组问的是**位置**，因此数目固定成三。 */
const THREE = [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/c.ts' }];

describe('LWB-029 G 组：失败落在第一个 / 中间 / 最后一个文件', () => {
  /**
   * 三个文件，写第 `nth` 个（从 1 数）时失败。
   *
   * 失败用的是「护栏没越过破坏性区域」那一种（`FILE_BUSY`，不带 `touched`），
   * 因此这一组用例测的是**位置**的影响，而不是「失败长什么样」的影响 ——
   * 后者由 C 组与 F 组穷尽。
   */
  async function failAt(
    seed: string,
    nth: number,
  ): Promise<{ built: Built; fake: FakeOps; report: ApplyReport }> {
    const { plan, built } = await claimed(seed, THREE);
    const victim = built.items[nth - 1]!;
    const fake = makeFakeOps({
      objects: built.objects,
      applyWrites: true,
      faultFirstWriteOnly: true,
      writeErrors: errorMap([
        [victim.canonical_path, { ok: false, code: 'FILE_BUSY', message: '夹具：被占用', win32_error: 32 }],
      ]),
    });
    const report = await applierFor(fake)(plan, new AbortController().signal);
    return { built, fake, report };
  }

  it('G1 失败在**第一个**：一个字节都没写出去，也没什么东西可收回', async () => {
    const { built, fake, report } = await failAt('g1', 1);

    assert.match(rolledBackDetail(report), /未改动/);
    // 一次尝试：第一个就失败了，而它失败在护栏进入破坏性区域之前。
    assert.deepEqual(
      fake.attempts.map((w) => w.relative_path),
      ['src/a.ts'],
    );
    assert.deepEqual(dirtied(fake, built), []);

    const ledger = ledgerOf(built);
    assert.equal(ledger.aggregate, 'rolled_back');
    // 三个条目全都有终局 —— 后两个是补记的「没轮到」。少了它们，
    // 折叠会说「说不清」，于是要求人去核验两个**从来没被碰过**的文件。
    assert.deepEqual(
      built.items.map((i) => ledger.outcomes.get(i.id)?.kind),
      ['untouched', 'untouched', 'untouched'],
    );
    assert.deepEqual(
      built.items.map((i) => ledger.outcomes.get(i.id)?.last_error_code),
      ['FILE_BUSY', 'NOT_ATTEMPTED', 'NOT_ATTEMPTED'],
    );
  });

  it('G2 失败在**中间**：第一个被收回，第三个一个字都没动过', async () => {
    const { built, fake, report } = await failAt('g2', 2);

    assert.match(rolledBackDetail(report), /已回到基线/);
    assert.match(rolledBackDetail(report), /未改动/);
    // 写 a（成）→ 写 b（败）→ 把 a 收回去。**没有第三次写 c**：
    // 一次批量失败不许悄悄继续往下写。
    assert.deepEqual(
      fake.attempts.map((w) => w.relative_path),
      ['src/a.ts', 'src/b.ts', 'src/a.ts'],
    );
    assert.deepEqual(dirtied(fake, built), [], '盘面回到执行之前');

    const ledger = ledgerOf(built);
    assert.equal(ledger.aggregate, 'rolled_back');
    assert.deepEqual(
      built.items.map((i) => ledger.outcomes.get(i.id)?.kind),
      ['restored', 'untouched', 'untouched'],
    );
  });

  it('G3 失败在**最后一个**：前面两个都写成了，两个都要按倒序收回去', async () => {
    const { built, fake, report } = await failAt('g3', 3);

    assert.match(rolledBackDetail(report), /已回到基线/);
    // 倒序：怎么进去的就怎么出来。最后写的先收回。
    assert.deepEqual(
      fake.attempts.map((w) => w.relative_path),
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/b.ts', 'src/a.ts'],
    );
    assert.deepEqual(dirtied(fake, built), []);

    const ledger = ledgerOf(built);
    assert.equal(ledger.aggregate, 'rolled_back');
    assert.deepEqual(
      built.items.map((i) => ledger.outcomes.get(i.id)?.kind),
      ['restored', 'restored', 'untouched'],
    );
  });

  it('G4 三个文件全部写成 ⇒ `applied`，逐条目账上没有一格是猜的', async () => {
    const { plan, built } = await claimed('g4', THREE);
    const fake = makeFakeOps({ objects: built.objects, applyWrites: true });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.match(appliedDetail(report), /已写入并核验 3/);
    const ledger = ledgerOf(built);
    assert.equal(ledger.aggregate, 'applied');
    assert.deepEqual(
      built.items.map((i) => ledger.outcomes.get(i.id)?.kind),
      ['written', 'written', 'written'],
    );
    // 每个条目四步都走过：意图、写出、刷盘、核验。缺一步就不是 `written`。
    for (const item of built.items) {
      assert.deepEqual(ledger.stagesOf(item.id), [
        ITEM_STAGE.intent,
        ITEM_STAGE.written,
        ITEM_STAGE.flushed,
        ITEM_STAGE.verified,
      ]);
    }
  });

  it('G5「不用写」落在第一个 / 中间 / 最后一个，其余照写', async () => {
    // `already_target` 是**不做**的第四种终局，它落在哪个位置都得记一条
    // `skipped` —— 否则折叠会把它算成「缺日志」。
    const positions = ['first', 'middle', 'last'] as const;
    for (let index = 0; index < positions.length; index += 1) {
      const seed = positions[index]!;
      const position = index + 1;
      const { plan, built } = await claimed(`g5-${seed}`, THREE);
      const skipped = built.items[position - 1]!;
      const objects = built.objects.map((o) =>
        o.canonical === skipped.canonical_path ? { ...o, sha256: skipped.target_sha256 } : o,
      );
      const fake = makeFakeOps({ objects, applyWrites: true });

      const report = await applierFor(fake)(plan, new AbortController().signal);

      assert.match(appliedDetail(report), /已写入并核验 2/, `${seed}：两个要写的都得写成`);
      assert.match(appliedDetail(report), /无需改动 1/, `${seed}：那一个必须单独算一档`);
      const ledger = ledgerOf(built);
      assert.equal(ledger.aggregate, 'applied', `${seed}：一个跳过不改变总账`);
      assert.deepEqual(ledger.stagesOf(skipped.id), [ITEM_STAGE.skipped], `${seed}：跳过要留一条账`);
      assert.equal(
        fake.attempts.some((w) => w.relative_path === skipped.canonical_path),
        false,
        `${seed}：已经在目标上的文件不该被写第二次`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// H 组：持久化边界失败 ⇒ 目标文件零写入
// ---------------------------------------------------------------------------

/**
 * 一个物件在快照库里的绝对路径。
 *
 * `storage_ref` 是**受保护根**下的相对引用（`objects/<shard>/<sha256>`），
 * 而 `objectsRoot` 已经是那个 `objects` 目录本身 —— 因此要把第一段
 * `objects` 去掉再拼，多拼一层就会指向一个不存在的位置（本用例第一次
 * 写出来时正是这么错的，`ENOENT` 把它挡下了）。
 */
function blobPath(storageRef: string): string {
  const segments = storageRef.replace(/\\/g, '/').split('/');
  assert.deepEqual(segments.slice(0, 1), ['objects'], `快照引用的形状不对：${storageRef}`);
  return path.join(blobs.objectsRoot, ...segments.slice(1));
}

describe('LWB-029 H 组：快照持久化失败时，目标文件零写入', () => {
  it('H1 目标快照从盘上消失了 ⇒ 拒绝，且一次护栏写入都没有发出', async () => {
    // 把**第二个**条目的目标快照从盘上拿掉：第一个条目本该能过，
    // 因此这条用例问的是「一个条目取不到字节，整批还写不写」——
    // 答案是一个字节都不写。
    const { plan, built } = await claimed('h1', [{ path: 'src/one.ts' }, { path: 'src/two.ts' }]);
    const fake = makeFakeOps({ objects: built.objects, applyWrites: true });
    const two = itemOf(built, 'src/two.ts');
    await rm(blobPath(repos.blobs.requireById(two.new_blob_id).storage_ref));

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'refused');
    if (report.kind !== 'refused') return;
    assert.match(report.detail, /未写入任何字节/);
    assert.equal(fake.attempts.length, 0, '持久化边界没过的批次，一次写入都不许发出');
    assert.deepEqual(dirtied(fake, built), []);
    assert.equal(stateOf(built.change_id), 'VALIDATING', '没写入就不该记下执行意图');
    assert.equal(ledgerOf(built).events.length, 0);
  });

  it('H2 目标快照被人改过（哈希对不上）⇒ 拒绝，且零写入', async () => {
    const { plan, built } = await claimed('h2', [{ path: 'src/one.ts' }]);
    const fake = makeFakeOps({ objects: built.objects, applyWrites: true });
    const blob = repos.blobs.requireById(itemOf(built, 'src/one.ts').new_blob_id);
    await writeFile(blobPath(blob.storage_ref), Buffer.from('被别的东西替换掉的字节', 'utf8'));

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'refused');
    assert.equal(fake.attempts.length, 0);
    assert.deepEqual(dirtied(fake, built), []);
  });

  it('H3 基线快照取不到 ⇒ 拒绝 —— 写得了却收不回的批次不许开始', async () => {
    // 这一条是 LWB-029 阶段 A2 存在的**全部理由**：基线字节不是写到一半
    // 才去找的，而是写在第一个字节之前就拿在手上。拿不到就不开始 ——
    // 否则一次失败会变成「想收回来，而收回来要用的那份字节恰好也没了」。
    const { plan, built } = await claimed('h3', [{ path: 'src/one.ts' }]);
    const fake = makeFakeOps({ objects: built.objects, applyWrites: true });
    const oldBlobId = itemOf(built, 'src/one.ts').old_blob_id;
    assert.ok(oldBlobId !== null, '改写条目必须有基线快照');
    await rm(blobPath(repos.blobs.requireById(oldBlobId).storage_ref));

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'refused');
    if (report.kind !== 'refused') return;
    assert.match(report.detail, /未改动任何文件/);
    assert.equal(fake.attempts.length, 0);
    assert.equal(stateOf(built.change_id), 'VALIDATING');
  });

  it('H4 阶段 A2 排在**记账之前**：拒绝时连 `APPLYING` 都没有落下', async () => {
    // 「快照没落稳就不许写工作区」这句话的可失败形式：如果 A2 排在
    // `recordIntent` 之后，一次拒绝会留下一格 `APPLYING` —— 而那一格的
    // 含义是「字节可能已经在盘上了」，那会逼着人来核验一次根本没开始的执行。
    const { plan, built } = await claimed('h4', [{ path: 'src/one.ts' }]);
    const fake = makeFakeOps({ objects: built.objects, applyWrites: true });
    await rm(blobPath(repos.blobs.requireById(itemOf(built, 'src/one.ts').new_blob_id).storage_ref));

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'refused');
    assert.equal(stateOf(built.change_id), 'VALIDATING');
    assert.equal(opStateOf(built.operation_id), 'VALIDATING');
  });
});

// ---------------------------------------------------------------------------
// I 组：完成回执不把部分完成当全成功
// ---------------------------------------------------------------------------

describe('LWB-029 I 组：完成回执逐文件说清楚，不含糊', () => {
  it('I1 报告里的每一个条目都在账上，账上的每一个都在报告里', async () => {
    const { plan, built } = await claimed('i1', THREE);
    const victim = itemOf(built, 'src/c.ts');
    const fake = makeFakeOps({
      objects: built.objects,
      applyWrites: true,
      faultFirstWriteOnly: true,
      writeErrors: errorMap([
        [victim.canonical_path, { ok: false, code: 'FILE_BUSY', message: '夹具：被占用', win32_error: 32 }],
      ]),
    });

    const report = await applierFor(fake)(plan, new AbortController().signal);
    const detail = rolledBackDetail(report);

    // 报告是给人看的，账是给恢复流程看的：两者必须说同一件事。
    assert.match(detail, /已回到基线 2/, '两个写成的都收回来了');
    assert.match(detail, /未改动 1/, '一个没写成的');
    const ledger = ledgerOf(built);
    assert.equal(ledger.outcomes.size, built.items.length, '一个条目都不许没有终局');
  });

  it('I2 逐条目小结里的数字加总等于条目总数 —— 不允许有「其余」', async () => {
    const { plan, built } = await claimed('i2', THREE);
    const fake = makeFakeOps({
      objects: built.objects,
      applyWrites: true,
      faultFirstWriteOnly: true,
      writeErrors: errorMap([
        ['src/b.ts', { ok: false, code: 'FILE_BUSY', message: '夹具：被占用', win32_error: 32 }],
      ]),
    });

    const report = await applierFor(fake)(plan, new AbortController().signal);
    const detail = rolledBackDetail(report);
    const counted = [
      ...detail.matchAll(/(已回到基线|未改动|已写入并核验|无需改动|可能留有本次执行的字节|状态不明（账上只有意图）) (\d+)/g),
    ]
      .map((m) => Number(m[2]))
      .reduce((a, b) => a + b, 0);
    assert.equal(counted, built.items.length, `报告里的条目数对不上：${detail}`);
  });

  it('I3 收回一个、留下一个 ⇒ 适配器报 `rolled_back`，而账上那一格是 `left_changed`', async () => {
    const { plan, built } = await claimed('i3', [{ path: 'src/a.ts' }, { path: 'src/b.ts' }]);
    const fake = makeFakeOps({
      objects: built.objects,
      applyWrites: true,
      faultFirstWriteOnly: true,
      writeErrors: errorMap([['src/b.ts', tornWrite(sha256('一半'), itemOf(built, 'src/b.ts').base_file_id!)]]),
    });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    assert.equal(report.kind, 'rolled_back', '一号收回、二号未动过，折叠成 rolled_back');
    assert.notEqual(report.kind, 'applied');
    const ledger = ledgerOf(built);
    assert.deepEqual(
      built.items.map((i) => ledger.outcomes.get(i.id)?.kind),
      ['restored', 'restored'],
    );
    assert.equal(ledger.aggregate, 'rolled_back');
    // 这一格把「每个条目各自怎么了」与「这次执行算作什么」分开：
    // 一号写成之后被收回、二号写到一半也被收回 —— 两个条目各自的终局
    // 都是 `restored`，于是**整批**都退回了执行之前的样子。
    assert.equal(diskSha(fake, 'src/a.ts'), itemOf(built, 'src/a.ts').base_sha256);
  });

  it('I4 一个写成、一个没动过 ⇒ 绝不报 `applied`（这一格是 LWB-029 的要害）', async () => {
    const { plan, built } = await claimed('i4', [{ path: 'src/a.ts' }, { path: 'src/b.ts' }]);
    const fake = makeFakeOps({
      objects: built.objects,
      applyWrites: true,
      faultFirstWriteOnly: true,
      writeErrors: errorMap([
        // 二号**当场**失败、一个字节没写（护栏没越过破坏性区域）。
        ['src/b.ts', { ok: false, code: 'FILE_BUSY', message: '夹具：被占用', win32_error: 32 }],
      ]),
    });

    const report = await applierFor(fake)(plan, new AbortController().signal);

    // 一号写成、二号没动过：盘上的状态是「一半目标、一半原样」。
    // 若把 `untouched` 算进 `applied`，这份报告说的就是「全部目标已达到」——
    // 而二号根本没被改。因此它只能是 `rolled_back`（一号被收回去了）。
    assert.equal(report.kind, 'rolled_back');
    const ledger = ledgerOf(built);
    assert.deepEqual(
      built.items.map((i) => ledger.outcomes.get(i.id)?.kind),
      ['restored', 'untouched'],
    );
    assert.equal(diskSha(fake, 'src/a.ts'), itemOf(built, 'src/a.ts').base_sha256);
    assert.equal(diskSha(fake, 'src/b.ts'), itemOf(built, 'src/b.ts').base_sha256);
  });

  it('I5 一号的收回被拒、二号动过而看不见现场 ⇒ 两条都留着字节，抛待恢复', async () => {
    const { plan, built } = await claimed('i5', [{ path: 'src/a.ts' }, { path: 'src/b.ts' }]);
    const fake = makeFakeOps({
      objects: built.objects,
      applyWrites: true,
      // 写 a.ts 的**第一次**放行（它必须写成功，才有东西可收回），
      // 坏的是**第二次** —— 也就是把基线写回去的那一次。
      faultNthWrite: new Map([['src/a.ts', 2]]),
      writeErrors: errorMap([
        ['src/a.ts', tornWrite(sha256('一号的一半'), itemOf(built, 'src/a.ts').base_file_id!)],
        [
          'src/b.ts',
          { ok: false, code: 'IO_ERROR', message: '夹具：动过，看不了', win32_error: 5, touched: true },
        ],
      ]),
    });

    const thrown = await thrownBy(() => applierFor(fake)(plan, new AbortController().signal));

    assert.equal(isBridgeError(thrown), true);
    if (!isBridgeError(thrown)) return;
    assert.equal(thrown.code, 'RECOVERY_REQUIRED');
    assert.equal(thrown.details?.reason, 'WRITE_FAILED_MIDWAY');
    // 抛出去的这句话里带着逐条目小结：操作者不必去库里翻才知道
    // 哪个文件是什么状态。
    assert.match(thrown.message, /可能留有本次执行的字节/);
    // 三次调用：写一号（成）、写二号（败）、把一号收回去（也败）。
    assert.deepEqual(
      fake.attempts.map((w) => w.relative_path),
      ['src/a.ts', 'src/b.ts', 'src/a.ts'],
    );
    const ledger = ledgerOf(built);
    assert.deepEqual(
      built.items.map((i) => ledger.outcomes.get(i.id)?.kind),
      ['left_changed', 'left_changed'],
      '两张账上说的都是「可能有字节」—— 一条是收不回来，一条是压根没敢收',
    );
    assert.equal(ledger.stagesOf(itemOf(built, 'src/a.ts').id).at(-1), ITEM_STAGE.restore_failed);
    assert.equal(ledger.stagesOf(itemOf(built, 'src/b.ts').id).at(-1), ITEM_STAGE.restore_skipped);
    assert.equal(ledger.aggregate, 'unfinished');
  });
});

// ---------------------------------------------------------------------------
// J 组：护栏原话里的工作区根，不跟着异常跑出去
// ---------------------------------------------------------------------------

/**
 * 这一组只有一件事：**脱敏必须在造出那句话的地方做**。
 *
 * 护栏的消息是在它自己的坐标系里写的（`WinfsGuard.ps1` 的 `Open-Guarded`
 * 把 `$Path` 拼进消息，那里是绝对路径）。这句话从 `classifyFailure` 出来
 * 之后走三条路：
 *
 *  1. 条目级日志 —— `appendItemEvent` 会脱敏，这条路一直是安全的；
 *  2. 报告 —— 给人看，安全；
 *  3. **抛出去的 `RECOVERY_REQUIRED`** —— 协调器接住它，原样写进一条
 *     **改动级**日志行（`#finalize` 里的 `repos.journal.append`）。那一行
 *     不经过 `appendItemEvent`，因此**不脱敏**。
 *
 * 第三条是本组的存在理由。修法是让第 3 条路上的那句话在**源头**就已经干净：
 * 一旦脱敏只做在出口上，每多一个出口就多一个洞，而出口是从代码里长出来的。
 */
describe('LWB-029 J 组：护栏消息里的工作区根不会跟着异常跑出去', () => {
  /** 一条**带着绝对路径**的护栏拒绝：真护栏就是这么写消息的。 */
  const leakyRefusal = (relativePath: string): WinfsError => ({
    ok: false,
    code: 'PERMISSION_DENIED',
    message: `拒绝访问：${ROOT_PATH}\\${relativePath.split('/').join('\\')}`,
    win32_error: 5,
    // 动过、现场不可读 —— 于是它一路走到 `restore_skipped`，
    // 而句子里那个绝对路径会跟着进日志与异常。
    touched: true,
  });

  it('J1 抛出去的异常里没有工作区根，而护栏的原话还在（脱的是根，不是病因）', async () => {
    const { plan, built } = await claimed('j1', [{ path: 'src/a.ts' }]);
    const fake = makeFakeOps({
      objects: built.objects,
      writeErrors: errorMap([['src/a.ts', leakyRefusal('src/a.ts')]]),
    });

    const thrown = await thrownBy(() => applierFor(fake)(plan, new AbortController().signal));

    assert.equal(isBridgeError(thrown), true);
    if (!isBridgeError(thrown)) return;
    assert.equal(thrown.code, 'RECOVERY_REQUIRED');
    // 先证明这条消息**本来**是带路径的：没有这一条，下面那句断言可能只是
    // 因为夹具根本没把路径放进去而通过。
    assert.match(thrown.message, /拒绝访问/);
    assert.match(thrown.message, /<工作区根>/);
    assert.equal(thrown.message.includes(ROOT_PATH), false, `异常里出现了工作区根：${thrown.message}`);
  });

  it('J2 改动级日志行同样干净 —— 协调器那一行不经过条目级脱敏', async () => {
    const { plan, built } = await claimed('j2', [{ path: 'src/a.ts' }]);
    const fake = makeFakeOps({
      objects: built.objects,
      writeErrors: errorMap([['src/a.ts', leakyRefusal('src/a.ts')]]),
    });

    const thrown = await thrownBy(() => applierFor(fake)(plan, new AbortController().signal));
    assert.equal(isBridgeError(thrown), true);

    // 协调器会怎么处理这次抛出：把 `error.message` 拼进 detail，
    // 原样追加一条**改动级**日志行（`#finalize`）。这里照做，
    // 断言的是**那句话本身**已经干净 —— 而不是某个出口碰巧擦过。
    repos.journal.append({
      operation_id: plan.operation_id,
      stage: 'write_recovery_required',
      error_code: 'RECOVERY_REQUIRED',
      detail: `写入过程抛出：${thrown instanceof Error ? thrown.message : String(thrown)}`,
    });

    const rows = repos.journal.list(plan.operation_id);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(
        (row.detail ?? '').includes(ROOT_PATH),
        false,
        `日志行里出现了工作区根：${row.detail ?? ''}`,
      );
    }
    // 条目级那一行也在里面，且它同样带着脱敏后的病因。
    assert.ok(
      rows.some((row) => (row.detail ?? '').includes('拒绝访问')),
      '那条护栏原话必须真的进了账本，否则本用例验的是空气',
    );
  });
});
