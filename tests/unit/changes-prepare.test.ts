/**
 * LWB-020 单元测试：规范化摘要与不可变修改集。
 *
 * ## 装置为什么是这个形状
 *
 * 摘要那一半是纯函数，直接测。建立修改集那一半要读真实字节、写状态库、
 * 落快照，因此装置里这三样都是真的：
 *
 *  - **真实文件**（写进临时目录）—— 「最终字节与原文件除目标行外逐字节相同」
 *    这句话，只有在真的从磁盘读、真的往快照写之后才检验得到；
 *  - **真实状态库**（内存 SQLite）—— 恒等、不可变、外键、触发器全在库里，
 *    桩掉它们等于把被测的顺序逻辑换成桩自己的顺序；
 *  - **真实快照库**（`BlobStore` 落在同一临时目录）—— 验收标准 3
 *    「预览显示的最终字节与待应用 blob 一致」，字面意思就是把预览里的哈希
 *    与快照里的字节对一遍。
 *
 * 而**护栏是桩**（`tests/tools/fixture-ops.ts`）：它的事实来自磁盘，但它不
 * 假装做了句柄级身份复核。哪些性质因此**没有**在本文件里被证明，逐条写在
 * `docs/evidence/lwb-020/summary.md` 的「未执行项」里 —— 最要紧的一条是
 * 「两个不同拼写指向同一个物理文件」在桩上造不出来（它的 `file_id` 由路径
 * 派生），因此 prepare 的**身份层**去重在单测里够不着。
 *
 * ## 负向用例优先
 *
 * 这条路径上「正确的输出」是建出一份对的修改集，而「错误的输出」是**建出
 * 一份悄悄不对的**。因此每个负向用例都断言两件事：抛出的码与理由，以及
 * **没有留下任何修改集** —— 只断言「抛了个错」会放过「先建了一半再抛」。
 *
 * ## 断言方式
 *
 * 涉及字节的一律精确相等，不用「包含 / 不含」：断言「输出里没有 X」在输出
 * 整个错位时也可能为真。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { BlobStore } from '@lwb/blob-store';
import { BridgeError, CONTRACT_VERSION, LIMITS } from '@lwb/contracts';
import type { ChangeItem, ChangePrepareInput, ChangePrepareData } from '@lwb/contracts';
import { createReadTicketAuthority, inspectBytes } from '@lwb/files';
import type { ReadScope, ReadTicketAuthority, ReadTicketFacts } from '@lwb/files';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { ChangeItemRecord, OpenDatabaseResult } from '@lwb/persistence';
import type { WinfsOps } from '@lwb/winfs';

import {
  canonicalChangeDigest,
  canonicalizeChangeDigest,
  changeRequestFingerprint,
  changeSetViewOf,
  deriveRisks,
  prepareChange,
  shortCodeOf,
  CHANGE_PREPARE_TOOL,
} from '@lwb/changes';
import type { ChangeDigestInput, PrepareChangeArgs, PrepareChangeDeps, PrepareLimits } from '@lwb/changes';

import { fileIdOf, makeFixtureOps } from '../tools/fixture-ops.ts';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const CONNECTION = 'conn-prepare';
const WORKSPACE = 'ws-prepare';
const PRINCIPAL = 'principal-prepare';
const GENERATION = 3;
const POLICY_VERSION = 7;
const VOLUME = 'c6e22015';
const KEY = 'lwb-prepare-test-key-0123456789abcdef01';
const MAX_EDITABLE = 4096;

const authority: ReadTicketAuthority = createReadTicketAuthority({ key: KEY });

let sandbox: string;
let repoRoot: string;
let opened: OpenDatabaseResult;
let repos: Repositories;
let blobs: BlobStore;
let ops: WinfsOps;
let scope: ReadScope;
let idCounter = 0;

/** 固定 id 生成器：让「同一个键只建一个修改集」这类断言不被随机 id 掩盖。 */
function nextId(): string {
  idCounter += 1;
  return `id${String(idCounter).padStart(6, '0')}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function totalLinesOf(bytes: Uint8Array): number {
  const decoded = inspectBytes(bytes);
  if (decoded.kind === 'text') return decoded.lines.total_lines;
  // 非文本字节也要能铸票据：负向用例正是要构造「票据说可编辑、字节说不行」。
  return Buffer.from(bytes).toString('utf8').split('\n').length;
}

/**
 * 铸一张**真实**票据。负向用例也走这里，只改字节、时间或调用方给的字段。
 *
 * 身份字段必须与 `makeFixtureOps` 派生的一致，否则先撞上的是
 * `TICKET_IDENTITY_MISMATCH` —— 那是装置的锅，不是被测代码的。
 */
function ticketFor(bytes: Uint8Array, relPath: string, over: Partial<ReadTicketFacts> = {}, mintedAt = NOW): string {
  const lines = totalLinesOf(bytes);
  const facts: ReadTicketFacts = {
    connection_id: CONNECTION,
    workspace_id: WORKSPACE,
    generation: GENERATION,
    canonical_path: relPath,
    volume_id: VOLUME,
    file_id: fileIdOf(path.join(repoRoot, ...relPath.split('/'))),
    raw_bytes_sha256: sha256(bytes),
    size: bytes.length,
    total_lines: lines,
    range_start: 1,
    range_end_exclusive: lines + 1,
    truncated: false,
    truncated_lines: [],
    editable: true,
    editable_blockers: [],
    redacted: false,
    ...over,
  };
  return authority.mintReadTicket(facts, { now: mintedAt, ttl_ms: LIMITS.READ_TOKEN_TTL_MS });
}

interface Edit {
  readonly start_line: number;
  readonly end_line_exclusive: number;
  readonly old_lines: readonly string[];
  readonly new_lines: readonly string[];
}

/** 按**磁盘上的真实字节**建一个 `edit_text` 项（票据与基线哈希自洽）。 */
function editItem(relPath: string, bytes: Uint8Array, edits: readonly Edit[]): ChangeItem {
  return { op: 'edit_text', path: relPath, base_sha256: sha256(bytes), read_token: ticketFor(bytes, relPath), edits };
}

function replaceItem(relPath: string, bytes: Uint8Array, content: string): ChangeItem {
  return { op: 'replace_text', path: relPath, base_sha256: sha256(bytes), read_token: ticketFor(bytes, relPath), content };
}

function createItem(relPath: string, content: string, newline: 'lf' | 'crlf' = 'lf', bom = false): ChangeItem {
  return { op: 'create_text', path: relPath, content, newline, bom };
}

function inputWith(items: readonly ChangeItem[], key: string, summary = '测试用摘要'): ChangePrepareInput {
  return { workspace_id: WORKSPACE, idempotency_key: key, summary, items };
}

function deps(over: Partial<PrepareChangeDeps> = {}): PrepareChangeDeps {
  return { ops, authority, blobs, repos, newId: nextId, ...over };
}

function args(input: ChangePrepareInput, over: Partial<PrepareChangeArgs> = {}): PrepareChangeArgs {
  return {
    principal_id: PRINCIPAL,
    connection_id: CONNECTION,
    workspace_id: WORKSPACE,
    generation: GENERATION,
    policy_version: POLICY_VERSION,
    scope,
    now: NOW,
    input,
    ...over,
  };
}

/**
 * 跑一次 prepare。
 *
 * 上限默认收紧到 4 KiB（夹具文件都很小，因此「超限」用例只要声明一个更小的
 * 数字就够），用第三个参数逐用例调整。
 */
function run(
  input: ChangePrepareInput,
  over: Partial<PrepareChangeArgs> = {},
  limitOver: Partial<PrepareLimits> = {},
): Promise<ChangePrepareData> {
  return prepareChange(
    args(input, over),
    deps({ limits: { max_editable_file_bytes: MAX_EDITABLE, ...limitOver } }),
  );
}

function changeCount(): number {
  return repos.changes.list({ limit: 500 }).length;
}

/** 一次性取回某个 blob 的字节。 */
function bytesOf(blobId: string): Promise<Buffer> {
  return blobs.getVerified(repos.blobs.requireById(blobId));
}

function readRepoFile(relPath: string): Promise<Buffer> {
  return readFile(path.join(repoRoot, ...relPath.split('/')));
}

/**
 * 断言一次调用以指定的码与理由失败，且**没有**建立修改集。
 *
 * 「没有留下修改集」是重点：失败路径若先写了一半，只断言抛错是看不出来的。
 */
async function expectPrepareError(
  promise: Promise<unknown>,
  code: string,
  reason: string | null,
): Promise<BridgeError> {
  const before = changeCount();
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
  assert.equal(changeCount(), before, '失败的 prepare 不得留下修改集');
  return caught;
}

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'lwb-prepare-'));
  repoRoot = path.join(sandbox, 'repo');
  await mkdir(path.join(repoRoot, 'docs'), { recursive: true });

  await writeFile(path.join(repoRoot, 'README.md'), '# 标题\n第二行\n第三行\n', 'utf8');
  await writeFile(path.join(repoRoot, 'docs', '空行.md'), '甲\n\n\n乙\n', 'utf8');
  await writeFile(path.join(repoRoot, 'crlf.txt'), 'A\r\nB\r\nC\r\n', 'utf8');

  opened = openDatabase({ path: ':memory:' });
  repos = new Repositories(opened.db);
  repos.connections.create({
    id: CONNECTION,
    principal_kind: 'model_surface',
    principal_id: PRINCIPAL,
    alias: '测试连接',
    enabled: true,
  });
  repos.workspaces.create({
    id: WORKSPACE,
    alias: '夹具',
    kind: 'directory',
    canonical_root: repoRoot,
    volume_id: VOLUME,
    root_file_id: 'root-file-id',
    policy_version: POLICY_VERSION,
    mode: 'read_propose_apply_with_local_approval',
  });

  ops = makeFixtureOps();
  blobs = new BlobStore({ objectsRoot: path.join(sandbox, 'objects'), registry: repos.blobs, newId: nextId });
  scope = {
    workspace_id: WORKSPACE,
    kind: 'directory',
    mode: 'read_propose_apply_with_local_approval',
    generation: GENERATION,
    root_path: repoRoot,
    root_volume_id: VOLUME,
    root_file_id: 'root-file-id',
  };
});

after(async () => {
  closeDatabase(opened.db);
  await rm(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 摘要
// ---------------------------------------------------------------------------

const DIGEST_BASE: ChangeDigestInput = {
  contract_version: CONTRACT_VERSION,
  policy_version: POLICY_VERSION,
  root_generation: GENERATION,
  workspace_id: WORKSPACE,
  files: [
    {
      path: 'README.md',
      op: 'edit_text',
      before_sha256: 'a'.repeat(64),
      before_size: 100,
      after_sha256: 'b'.repeat(64),
      after_size: 120,
      encoding: 'utf-8',
      newline: 'lf',
      bom: false,
    },
  ],
};

describe('LWB-020 规范化摘要', () => {
  it('同一份事实永远给出同一个摘要（重复调用、另一个对象实例）', () => {
    const once = canonicalChangeDigest(DIGEST_BASE);
    const twice = canonicalChangeDigest({ ...DIGEST_BASE, files: [{ ...DIGEST_BASE.files[0]! }] });
    assert.equal(once, twice);
    assert.match(once, /^[0-9a-f]{64}$/);
  });

  it('逐个字段：任意一处**效果**变化都改变摘要', () => {
    const base = canonicalChangeDigest(DIGEST_BASE);
    const f = DIGEST_BASE.files[0]!;
    const mutations: readonly (readonly [string, ChangeDigestInput])[] = [
      ['路径', { ...DIGEST_BASE, files: [{ ...f, path: 'README.txt' }] }],
      ['操作', { ...DIGEST_BASE, files: [{ ...f, op: 'replace_text' }] }],
      ['基线哈希', { ...DIGEST_BASE, files: [{ ...f, before_sha256: 'c'.repeat(64) }] }],
      ['结果哈希', { ...DIGEST_BASE, files: [{ ...f, after_sha256: 'c'.repeat(64) }] }],
      ['基线尺寸', { ...DIGEST_BASE, files: [{ ...f, before_size: 101 }] }],
      ['结果尺寸', { ...DIGEST_BASE, files: [{ ...f, after_size: 121 }] }],
      ['编码', { ...DIGEST_BASE, files: [{ ...f, encoding: 'utf-8-bom' }] }],
      ['换行', { ...DIGEST_BASE, files: [{ ...f, newline: 'crlf' }] }],
      ['BOM', { ...DIGEST_BASE, files: [{ ...f, bom: true }] }],
      ['策略版本', { ...DIGEST_BASE, policy_version: POLICY_VERSION + 1 }],
      ['权限代次', { ...DIGEST_BASE, root_generation: GENERATION + 1 }],
      ['工作区', { ...DIGEST_BASE, workspace_id: 'ws-other' }],
      ['契约版本', { ...DIGEST_BASE, contract_version: '9.9.9' }],
      ['文件集合为空', { ...DIGEST_BASE, files: [] }],
    ];

    const seen = new Map<string, string>([[base, '(基准)']]);
    for (const [label, mutated] of mutations) {
      const digest = canonicalChangeDigest(mutated);
      const clash = seen.get(digest);
      assert.equal(clash, undefined, `「${label}」与「${clash}」得到了同一个摘要`);
      seen.set(digest, label);
    }
  });

  it('文件次序改变会改变摘要（次序是逐文件回执的次序，不是展示细节）', () => {
    const two = (order: readonly string[]): ChangeDigestInput => ({
      ...DIGEST_BASE,
      files: order.map((p, i) => ({ ...DIGEST_BASE.files[0]!, path: p, after_size: 200 + i })),
    });
    assert.notEqual(canonicalChangeDigest(two(['a.md', 'b.md'])), canonicalChangeDigest(two(['b.md', 'a.md'])));
  });

  it('长度前缀：字段值里的分隔符造不出碰撞', () => {
    // 直接拼 `\n` 的实现会把这两者判成同一份：
    //   一个文件、路径是 'a' + 换行 + 'path 1:b'
    //   两个文件、路径分别是 'a' 与 'b'
    const def = DIGEST_BASE.files[0]!;
    const smuggled = canonicalizeChangeDigest({ ...DIGEST_BASE, files: [{ ...def, path: 'a\npath 1:b' }] });
    const twoFiles = canonicalizeChangeDigest({ ...DIGEST_BASE, files: [{ ...def, path: 'a' }, { ...def, path: 'b' }] });
    assert.notEqual(smuggled, twoFiles);
    assert.ok(smuggled.includes(`${'a\npath 1:b'.length}:a\npath 1:b`), '长度前缀必须写在字段值之前');
  });

  it('摘要**不含**增量行数、summary 与幂等键（它们是解释、散文与查询键）', () => {
    const def = DIGEST_BASE.files[0]!;
    const noisy = canonicalChangeDigest({
      ...DIGEST_BASE,
      files: [{ ...def, added_lines: 99, removed_lines: 99, summary: '不受信的散文', idempotency_key: 'key' } as never],
    });
    assert.equal(noisy, canonicalChangeDigest(DIGEST_BASE));
  });

  it('短核对编号只取摘要前缀，且刻意不是凭证', () => {
    const digest = canonicalChangeDigest(DIGEST_BASE);
    const code = shortCodeOf(digest);
    assert.equal(code, `${digest.slice(0, 4).toUpperCase()}-${digest.slice(4, 8).toUpperCase()}`);
    assert.match(code, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
    // 只有 32 位可见字符 —— 这一点决定了它不能用于任何放行判定。
    assert.equal(code.replace('-', '').length, 8);
  });

  it('请求指纹：只有令牌不同则指纹相同，内容不同则指纹不同', () => {
    const item = {
      op: 'edit_text' as const,
      path: 'README.md',
      base_sha256: 'a'.repeat(64),
      edits: [{ start_line: 2, end_line_exclusive: 3, old_lines: ['第二行'], new_lines: ['改过'] }],
    };
    const base = {
      tool: CHANGE_PREPARE_TOOL,
      workspace_id: WORKSPACE,
      connection_id: CONNECTION,
      summary: '摘要',
      items: [item],
    };
    const reference = changeRequestFingerprint(base);
    assert.equal(changeRequestFingerprint({ ...base, items: [{ ...item }] }), reference);

    const differ: readonly (readonly [string, Parameters<typeof changeRequestFingerprint>[0]])[] = [
      ['连接', { ...base, connection_id: 'conn-other' }],
      ['工作区', { ...base, workspace_id: 'ws-other' }],
      ['摘要', { ...base, summary: '另一段摘要' }],
      ['工具', { ...base, tool: 'change_get' }],
      ['路径', { ...base, items: [{ ...item, path: 'OTHER.md' }] }],
      ['基线', { ...base, items: [{ ...item, base_sha256: 'b'.repeat(64) }] }],
      ['行区间', { ...base, items: [{ ...item, edits: [{ ...item.edits[0]!, start_line: 3 }] }] }],
      ['旧行文本', { ...base, items: [{ ...item, edits: [{ ...item.edits[0]!, old_lines: ['别的'] }] }] }],
      ['新行文本', { ...base, items: [{ ...item, edits: [{ ...item.edits[0]!, new_lines: ['别的'] }] }] }],
    ];
    const seen = new Set<string>([reference]);
    for (const [label, mutated] of differ) {
      const fp = changeRequestFingerprint(mutated);
      assert.ok(!seen.has(fp), `改了「${label}」之后指纹没变`);
      seen.add(fp);
    }
  });

  it('请求指纹：行文本里的换行不会把两个请求拼成同一个指纹', () => {
    const mk = (lines: readonly string[]) => ({
      tool: CHANGE_PREPARE_TOOL,
      workspace_id: WORKSPACE,
      connection_id: CONNECTION,
      summary: 's',
      items: [
        {
          op: 'edit_text' as const,
          path: 'a.txt',
          base_sha256: 'a'.repeat(64),
          edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: ['x'], new_lines: lines }],
        },
      ],
    });
    assert.notEqual(changeRequestFingerprint(mk(['a', 'b'])), changeRequestFingerprint(mk(['a\nb'])));
  });
});

// ---------------------------------------------------------------------------
// 验收标准 1：prepare 不改变用户工作区任何文件
// ---------------------------------------------------------------------------

describe('LWB-020 验收 1：prepare 不写工作区', () => {
  it('建立修改集前后，仓库里每个文件的字节与 mtime 都不变', async () => {
    const paths = ['README.md', 'docs/空行.md', 'crlf.txt'];
    const snapshot = async (): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const p of paths) {
        const abs = path.join(repoRoot, ...p.split('/'));
        const s = await stat(abs);
        out[p] = `${sha256(await readFile(abs))}:${s.mtimeMs}:${s.size}`;
      }
      return out;
    };

    const before = await snapshot();
    const original = await readRepoFile('README.md');
    const result = await run(
      inputWith(
        [editItem('README.md', original, [{ start_line: 2, end_line_exclusive: 3, old_lines: ['第二行'], new_lines: ['改过'] }])],
        'k-no-write',
      ),
    );

    assert.equal(result.workspace_modified, false);
    assert.deepEqual(await snapshot(), before, 'prepare 之后工作区必须逐字节、逐个 mtime 不变');
  });

  it('新建类提案也不落地：目标文件在 prepare 之后仍然不存在', async () => {
    const exists = (p: string): Promise<boolean> =>
      stat(path.join(repoRoot, ...p.split('/'))).then(
        () => true,
        () => false,
      );
    assert.equal(await exists('docs/新增.md'), false);
    await run(inputWith([createItem('docs/新增.md', '第一行\n第二行\n')], 'k-create-no-write'));
    assert.equal(await exists('docs/新增.md'), false, 'create_text 在 prepare 阶段绝不能真的建出文件');
  });

  it('替换类提案同样不落地', async () => {
    const original = await readRepoFile('docs/空行.md');
    await run(inputWith([replaceItem('docs/空行.md', original, '全新内容\n')], 'k-replace-no-write'));
    assert.deepEqual(await readRepoFile('docs/空行.md'), original);
  });

  it('护栏的写方法在 prepare 全程一次都不被调用（写就抛错的桩证明了这一点）', async () => {
    // `makeFixtureOps` 的 `writeFileGuarded` / `createFileGuarded` 一律抛错，
    // 因此只要 prepare 能正常返回，就说明它没走写入通道。
    const original = await readRepoFile('README.md');
    const result = await run(
      inputWith(
        [
          editItem('README.md', original, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['# 标题'], new_lines: ['# 新标题'] }]),
          createItem('docs/另一个.md', 'x\n'),
        ],
        'k-no-write-calls',
      ),
    );
    assert.equal(result.files.length, 2);
  });
});

// ---------------------------------------------------------------------------
// 验收标准 2：相同幂等请求同一修改集，不同内容不同摘要
// ---------------------------------------------------------------------------

describe('LWB-020 验收 2：幂等与摘要', () => {
  it('相同幂等键 + 相同请求 → 同一个修改集，且标记为重放', async () => {
    const original = await readRepoFile('README.md');
    const payload = inputWith(
      [editItem('README.md', original, [{ start_line: 2, end_line_exclusive: 3, old_lines: ['第二行'], new_lines: ['幂等'] }])],
      'k-replay',
    );

    const first = await run(payload);
    const afterFirst = changeCount();
    const second = await run(payload);

    assert.equal(second.change_id, first.change_id);
    assert.equal(second.digest, first.digest);
    assert.equal(second.short_code, first.short_code);
    assert.equal(second.idempotent_replay, true);
    assert.equal(first.idempotent_replay, false);
    assert.deepEqual(second.files, first.files);
    assert.deepEqual(second.risks, first.risks);
    assert.equal(changeCount(), afterFirst, '重放不得新建修改集');
  });

  it('同一个键换一份内容 → IDEMPOTENCY_CONFLICT，且既有修改集一字未改', async () => {
    const original = await readRepoFile('README.md');
    const first = await run(
      inputWith([editItem('README.md', original, [{ start_line: 2, end_line_exclusive: 3, old_lines: ['第二行'], new_lines: ['甲'] }])], 'k-conflict'),
    );
    const digestBefore = repos.changes.requireById(first.change_id).digest;

    await expectPrepareError(
      run(
        inputWith([editItem('README.md', original, [{ start_line: 2, end_line_exclusive: 3, old_lines: ['第二行'], new_lines: ['乙'] }])], 'k-conflict'),
      ),
      'IDEMPOTENCY_CONFLICT',
      'IDEMPOTENCY_KEY_REUSED',
    );

    assert.equal(repos.changes.requireById(first.change_id).digest, digestBefore);
  });

  it('只有 summary 不同也算换了请求（它是被指纹覆盖的调用方撰写字段）', async () => {
    const original = await readRepoFile('README.md');
    const items = [editItem('README.md', original, [{ start_line: 2, end_line_exclusive: 3, old_lines: ['第二行'], new_lines: ['丙'] }])];
    await run(inputWith(items, 'k-summary', '第一段摘要'));
    await expectPrepareError(
      run(inputWith(items, 'k-summary', '第二段摘要')),
      'IDEMPOTENCY_CONFLICT',
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('换了内容就是另一个修改集、另一个摘要（修订生成新 ID）', async () => {
    const original = await readRepoFile('README.md');
    const a = await run(
      inputWith([editItem('README.md', original, [{ start_line: 2, end_line_exclusive: 3, old_lines: ['第二行'], new_lines: ['A 版'] }])], 'k-diff-a'),
    );
    const b = await run(
      inputWith([editItem('README.md', original, [{ start_line: 2, end_line_exclusive: 3, old_lines: ['第二行'], new_lines: ['B 版'] }])], 'k-diff-b'),
    );
    assert.notEqual(a.change_id, b.change_id, '修订必须生成新 ID');
    assert.notEqual(a.digest, b.digest, '内容不同必须得到不同摘要');
    assert.notEqual(a.short_code, b.short_code);
    assert.equal(repos.changes.requireById(a.change_id).state, 'PENDING_APPROVAL');
    assert.equal(repos.changes.requireById(b.change_id).state, 'PENDING_APPROVAL');
  });

  it('申请校验失败**不占用**幂等键：改对参数后同一个键仍然可用', async () => {
    const bytes = await readRepoFile('crlf.txt');
    await expectPrepareError(
      // 第 9 行从未被读过（票据只覆盖 1..3），契约校验就该拒绝 ——
      // 处置是「重新读」，所以它是 READ_TOKEN_STALE 而不是参数错误。
      run(inputWith([editItem('crlf.txt', bytes, [{ start_line: 9, end_line_exclusive: 10, old_lines: ['不存在'], new_lines: ['x'] }])], 'k-after-failure')),
      'READ_TOKEN_STALE',
      'EDIT_RANGE_NOT_READ',
    );

    const result = await run(
      inputWith([editItem('crlf.txt', bytes, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['A'], new_lines: ['Z'] }])], 'k-after-failure'),
    );
    assert.equal(result.state, 'PENDING_APPROVAL');
  });

  it('幂等记录是**按主体**隔离的：另一个主体用同一个键不会命中别人的记录', () => {
    const key = 'k-scope';
    const hash = 'x'.repeat(64);
    const entry = { tool: CHANGE_PREPARE_TOOL, key, request_hash: hash };

    assert.equal(repos.idempotency.begin({ id: nextId(), principal_id: PRINCIPAL, ...entry }).kind, 'new');
    // 同一主体、同一键、同一请求 → 重放。
    assert.equal(repos.idempotency.begin({ id: nextId(), principal_id: PRINCIPAL, ...entry }).kind, 'replay');
    // 同一主体、同一键、**不同请求** → 冲突（这正是 prepare 抛 IDEMPOTENCY_CONFLICT 的来源）。
    assert.equal(
      repos.idempotency.begin({ id: nextId(), principal_id: PRINCIPAL, ...entry, request_hash: 'y'.repeat(64) }).kind,
      'conflict',
    );
    // 换一个主体 → 全新的记录。一个主体不能靠猜别人的键来接触别人的修改集。
    assert.equal(repos.idempotency.begin({ id: nextId(), principal_id: 'principal-other', ...entry }).kind, 'new');
  });
});

// ---------------------------------------------------------------------------
// 验收标准 3：预览显示的最终字节与待应用 blob 一致
// ---------------------------------------------------------------------------

describe('LWB-020 验收 3：预览与待应用 blob 一致', () => {
  it('预览的 after_sha256 / after_size 就是新 blob 的字节，且内容等于「原文件换掉目标行」', async () => {
    const original = await readRepoFile('README.md');
    const result = await run(
      inputWith(
        [editItem('README.md', original, [{ start_line: 3, end_line_exclusive: 4, old_lines: ['第三行'], new_lines: ['第三行改', '多了第四行'] }])],
        'k-blob-match',
      ),
    );

    const item = repos.changes.items(result.change_id)[0]!;
    const newBytes = await bytesOf(item.new_blob_id);
    const oldBytes = await bytesOf(item.old_blob_id!);

    // 预览 = 落库 = 快照。三方必须说的是同一件事。
    assert.equal(sha256(newBytes), result.files[0]!.after_sha256);
    assert.equal(newBytes.length, result.files[0]!.after_size);
    assert.equal(item.target_sha256, result.files[0]!.after_sha256);

    // 而它**确实**是「原文件换掉第 3 行」的结果 —— 未触及的字节逐字节保留。
    assert.equal(newBytes.toString('utf8'), '# 标题\n第二行\n第三行改\n多了第四行\n');

    // 旧字节也在快照里且等于磁盘上那份（回滚要靠它）。
    assert.deepEqual(oldBytes, original);
    assert.equal(result.files[0]!.before_sha256, sha256(original));
    assert.equal(result.files[0]!.before_size, original.length);
  });

  it('增量行数落库后从库里读回来是同一个数（迁移 v4 的存在理由）', async () => {
    const original = await readRepoFile('README.md');
    const result = await run(
      inputWith([editItem('README.md', original, [{ start_line: 3, end_line_exclusive: 4, old_lines: ['第三行'], new_lines: ['甲', '乙'] }])], 'k-counts'),
    );
    const item = repos.changes.items(result.change_id)[0]!;
    assert.equal(item.added_lines, 2);
    assert.equal(item.removed_lines, 1);

    // 从**落库事实**重建的预览与建立时返回的预览必须逐字段相同。
    const rebuilt = changeSetViewOf(repos.changes.requireById(result.change_id), [item], (id) => repos.blobs.requireById(id).size);
    assert.deepEqual(rebuilt.files, result.files);
  });

  it('CRLF 文件的产物整份保持 CRLF（未触及的行连 \\r 都没被重新编码）', async () => {
    const original = await readRepoFile('crlf.txt');
    assert.equal(original.toString('utf8'), 'A\r\nB\r\nC\r\n');
    const result = await run(
      inputWith([editItem('crlf.txt', original, [{ start_line: 3, end_line_exclusive: 4, old_lines: ['C'], new_lines: ['C 改'] }])], 'k-crlf'),
    );
    const item = repos.changes.items(result.change_id)[0]!;
    assert.equal(item.newline, 'crlf');
    assert.equal(item.encoding, 'utf-8');
    assert.equal(item.bom, false);
    assert.equal((await bytesOf(item.new_blob_id)).toString('utf8'), 'A\r\nB\r\nC 改\r\n');
    assert.equal(result.files[0]!.newline, 'crlf');
  });

  it('新建文件的预览：before 侧为空、after 侧就是提交的内容', async () => {
    const result = await run(inputWith([createItem('docs/新增.md', '第一行\n第二行\n')], 'k-create-view'));
    const item = repos.changes.items(result.change_id)[0]!;
    const file = result.files[0]!;

    assert.equal(file.op, 'create_text');
    assert.equal(file.before_sha256, null);
    assert.equal(file.before_size, 0);
    assert.equal(item.old_blob_id, null);
    assert.equal(item.base_sha256, null);
    assert.equal(file.added_lines, 2);
    assert.equal(file.removed_lines, 0);
    assert.equal((await bytesOf(item.new_blob_id)).toString('utf8'), '第一行\n第二行\n');
    assert.equal(file.after_sha256, sha256(Buffer.from('第一行\n第二行\n', 'utf8')));
  });

  it('新建文件带 BOM 与 CRLF：预览与 blob 逐字节一致', async () => {
    const result = await run(inputWith([createItem('docs/bom.txt', '甲\n乙\n', 'crlf', true)], 'k-create-bom'));
    const item = repos.changes.items(result.change_id)[0]!;
    const bytes = await bytesOf(item.new_blob_id);

    assert.equal(item.encoding, 'utf-8-bom');
    assert.equal(item.newline, 'crlf');
    assert.equal(item.bom, true);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(bytes.toString('utf8'), '﻿甲\r\n乙\r\n');
    assert.equal(result.files[0]!.after_sha256, sha256(bytes));
  });

  it('摘要可由**落库的事实**重算（批准绑定在跨进程重启后仍然成立的前提）', async () => {
    const original = await readRepoFile('README.md');
    const result = await run(
      inputWith([editItem('README.md', original, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['# 标题'], new_lines: ['# 新标题'] }])], 'k-recompute'),
    );

    const record = repos.changes.requireById(result.change_id);
    const items = repos.changes.items(record.id);
    const view = changeSetViewOf(record, items, (id) => repos.blobs.requireById(id).size);

    // 重算的输入**只有**数据库里的列：路径、前后哈希、blob 尺寸、编码、换行、BOM。
    const recomputed = canonicalChangeDigest({
      contract_version: record.contract_version,
      policy_version: record.policy_version,
      root_generation: record.root_generation,
      workspace_id: record.workspace_id,
      files: view.files,
    });
    assert.equal(recomputed, record.digest);
    assert.equal(record.digest, result.digest);
  });

  it('落库的规范化字段来自调用参数：契约版本、策略版本、代次与归属连接', async () => {
    const original = await readRepoFile('README.md');
    const result = await run(
      inputWith([editItem('README.md', original, [{ start_line: 2, end_line_exclusive: 3, old_lines: ['第二行'], new_lines: ['元数据'] }])], 'k-meta'),
      { policy_version: POLICY_VERSION + 5 },
    );
    const record = repos.changes.requireById(result.change_id);
    assert.equal(record.contract_version, CONTRACT_VERSION);
    assert.equal(record.policy_version, POLICY_VERSION + 5);
    assert.equal(record.root_generation, GENERATION);
    assert.equal(record.owner_connection_id, CONNECTION);
    assert.equal(record.workspace_id, WORKSPACE);
  });
});

// ---------------------------------------------------------------------------
// 建立时的重读与拒绝
// ---------------------------------------------------------------------------

describe('LWB-020 建立时的重读', () => {
  it('磁盘内容被改过（尺寸也变了）→ READ_TOKEN_STALE / TICKET_SIZE_MISMATCH', async () => {
    const original = await readRepoFile('crlf.txt');
    const item = editItem('crlf.txt', original, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['A'], new_lines: ['Z'] }]);
    await writeFile(path.join(repoRoot, 'crlf.txt'), 'A\r\nB\r\nC\r\nD\r\n', 'utf8');
    try {
      await expectPrepareError(run(inputWith([item], 'k-stale-size')), 'READ_TOKEN_STALE', 'TICKET_SIZE_MISMATCH');
    } finally {
      await writeFile(path.join(repoRoot, 'crlf.txt'), original);
    }
  });

  it('同尺寸的原地改写 → READ_TOKEN_STALE / TICKET_CONTENT_MISMATCH（尺寸判据抓不到，内容判据抓得到）', async () => {
    const rel = 'docs/空行.md';
    const original = await readRepoFile(rel);
    const item = editItem(rel, original, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['甲'], new_lines: ['乙'] }]);
    const sameSize = Buffer.from('丙\n\n\n丁\n', 'utf8');
    assert.equal(sameSize.length, original.length, '装置前提：替换后的字节数必须相同');
    await writeFile(path.join(repoRoot, rel), sameSize);
    try {
      await expectPrepareError(run(inputWith([item], 'k-stale-content')), 'READ_TOKEN_STALE', 'TICKET_CONTENT_MISMATCH');
    } finally {
      await writeFile(path.join(repoRoot, rel), original);
    }
  });

  it('身份对不上（票据里的 file_id 是别处的）→ READ_TOKEN_STALE / TICKET_IDENTITY_MISMATCH', async () => {
    const bytes = await readRepoFile('crlf.txt');
    const item: ChangeItem = {
      op: 'edit_text',
      path: 'crlf.txt',
      base_sha256: sha256(bytes),
      read_token: ticketFor(bytes, 'crlf.txt', { file_id: fileIdOf(path.join(repoRoot, 'README.md')) }),
      edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: ['A'], new_lines: ['Z'] }],
    };
    await expectPrepareError(run(inputWith([item], 'k-stale-identity')), 'READ_TOKEN_STALE', 'TICKET_IDENTITY_MISMATCH');
  });

  it('票据过期 → READ_TOKEN_STALE（时间戳在令牌里，重读之前就查）', async () => {
    const bytes = await readRepoFile('crlf.txt');
    const item: ChangeItem = {
      op: 'edit_text',
      path: 'crlf.txt',
      base_sha256: sha256(bytes),
      read_token: ticketFor(bytes, 'crlf.txt', {}, NOW - LIMITS.READ_TOKEN_TTL_MS - 1),
      edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: ['A'], new_lines: ['Z'] }],
    };
    await expectPrepareError(run(inputWith([item], 'k-expired')), 'READ_TOKEN_STALE', null);
  });

  it('重读发现不再是文本 → ENCODING_UNSUPPORTED（票据说可编辑，当场事实说不行）', async () => {
    const rel = 'bin.dat';
    const binary = Buffer.from([0x00, 0x01, 0x02]);
    await writeFile(path.join(repoRoot, rel), binary);
    // 票据是拿**同一批字节**铸的（因此「磁盘 vs 票据」核对会通过），但它声称
    // `editable: true`。这正是「签发票据那一刻的裁定」与「重新读到的字节」分叉
    // 的场景 —— 沿用旧裁定就等于让一次过期的许可继续生效。
    const item: ChangeItem = {
      op: 'edit_text',
      path: rel,
      base_sha256: sha256(binary),
      read_token: ticketFor(binary, rel),
      edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: ['x'], new_lines: ['y'] }],
    };
    try {
      await expectPrepareError(run(inputWith([item], 'k-not-text')), 'ENCODING_UNSUPPORTED', 'NOT_EDITABLE_TEXT_AT_PREPARE');
    } finally {
      await rm(path.join(repoRoot, rel), { force: true });
    }
  });

  it('目标位置上是一个目录 → FILE_VERSION_CONFLICT / TARGET_EXISTS（绝不覆盖）', async () => {
    await expectPrepareError(run(inputWith([createItem('docs', 'x\n')], 'k-create-dir')), 'FILE_VERSION_CONFLICT', 'TARGET_EXISTS');
  });

  it('目标已存在（文件）→ FILE_VERSION_CONFLICT / TARGET_EXISTS', async () => {
    await expectPrepareError(run(inputWith([createItem('README.md', 'x\n')], 'k-create-file')), 'FILE_VERSION_CONFLICT', 'TARGET_EXISTS');
  });

  it('父目录不存在 → NOT_FOUND（V1 只支持在已存在的父目录里新建）', async () => {
    await expectPrepareError(run(inputWith([createItem('没有这个目录/x.md', 'x\n')], 'k-create-nodir')), 'NOT_FOUND', null);
  });

  /**
   * 父目录正是**工作区根**的那一条。
   *
   * 它值得单独一个用例，因为真实护栏在这里有一个会被漏掉的坑：护栏的
   * `resolvePath` 对「目录根 + 空相对路径」是**故意**拒绝的（「列举根目录请用
   * listDirectory」）。若 prepare 老老实实拿 `parent = ''` 去探一次，一次完全
   * 正常的「在工作区根下新建文件」就会变成 `PATH_UNSAFE`。
   *
   * **注意本用例证明不了那件事**：夹具桩对空相对路径是宽松的（它把 `''`
   * 当成根，按 `expect` 判类型），因此这条用例在修复前后都会通过。真正抓住
   * 这个坑的是 Windows 证据（scripts/evidence/lwb-020.ts 的 `create_text`
   * 段落）。留在这里是为了把「根下可新建」这条行为契约固定在快速层，
   * 并让桩的这处宽松有据可查。
   */
  it('在目录工作区的根下新建文件 → 正常建立（根就是那个已存在的父目录）', async () => {
    const result = await run(inputWith([createItem('根下新建.md', '甲\n乙\n')], 'k-create-at-root'));
    assert.equal(result.state, 'PENDING_APPROVAL');
    assert.equal(result.files[0]?.path, '根下新建.md');
    assert.equal(result.files[0]?.before_sha256, null);
  });

  it('读取目标不存在 → NOT_FOUND', async () => {
    const ghost = Buffer.from('幽灵\n', 'utf8');
    const item: ChangeItem = {
      op: 'edit_text',
      path: '不存在.md',
      base_sha256: sha256(ghost),
      read_token: ticketFor(ghost, '不存在.md'),
      edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: ['幽灵'], new_lines: ['x'] }],
    };
    await expectPrepareError(run(inputWith([item], 'k-missing')), 'NOT_FOUND', null);
  });

  it('基线哈希与票据不符 → 契约校验就拒绝', async () => {
    const bytes = await readRepoFile('crlf.txt');
    const item: ChangeItem = {
      op: 'edit_text',
      path: 'crlf.txt',
      base_sha256: 'f'.repeat(64),
      read_token: ticketFor(bytes, 'crlf.txt'),
      edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: ['A'], new_lines: ['Z'] }],
    };
    await expectPrepareError(run(inputWith([item], 'k-base-mismatch')), 'READ_TOKEN_STALE', null);
  });

  it('票据属于另一条连接 → 契约校验就拒绝（跨连接不继承）', async () => {
    const bytes = await readRepoFile('crlf.txt');
    const item: ChangeItem = {
      op: 'edit_text',
      path: 'crlf.txt',
      base_sha256: sha256(bytes),
      read_token: ticketFor(bytes, 'crlf.txt', { connection_id: 'conn-other' }),
      edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: ['A'], new_lines: ['Z'] }],
    };
    await expectPrepareError(run(inputWith([item], 'k-cross-conn')), 'READ_TOKEN_STALE', 'TICKET_CROSS_CONNECTION');
  });

  it('票据属于另一代次 → 契约校验就拒绝（撤权后不继承）', async () => {
    const bytes = await readRepoFile('crlf.txt');
    const item: ChangeItem = {
      op: 'edit_text',
      path: 'crlf.txt',
      base_sha256: sha256(bytes),
      read_token: ticketFor(bytes, 'crlf.txt', { generation: GENERATION + 1 }),
      edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: ['A'], new_lines: ['Z'] }],
    };
    await expectPrepareError(run(inputWith([item], 'k-cross-gen')), 'READ_TOKEN_STALE', 'TICKET_GENERATION_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// 上限、形态与不可变
// ---------------------------------------------------------------------------

describe('LWB-020 上限与形态', () => {
  it('文件超过可编辑上限 → SIZE_LIMIT_EXCEEDED / FILE_TOO_LARGE_FOR_EDIT', async () => {
    const bytes = await readRepoFile('crlf.txt');
    await expectPrepareError(
      run(
        inputWith([editItem('crlf.txt', bytes, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['A'], new_lines: ['Z'] }])], 'k-too-large'),
        {},
        { max_editable_file_bytes: bytes.length - 1 },
      ),
      'SIZE_LIMIT_EXCEEDED',
      'FILE_TOO_LARGE_FOR_EDIT',
    );
  });

  it('最终字节总量超限 → SIZE_LIMIT_EXCEEDED / CHANGE_TOTAL_TOO_LARGE', async () => {
    const bytes = await readRepoFile('crlf.txt');
    await expectPrepareError(
      run(
        inputWith([editItem('crlf.txt', bytes, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['A'], new_lines: ['Z'] }])], 'k-total'),
        {},
        { max_change_total_bytes: 1 },
      ),
      'SIZE_LIMIT_EXCEEDED',
      'CHANGE_TOTAL_TOO_LARGE',
    );
  });

  it('条目数超过调用方声明的上限 → INVALID_ARGUMENT / TOO_MANY_CHANGE_FILES', async () => {
    const bytes = await readRepoFile('crlf.txt');
    await expectPrepareError(
      run(
        inputWith([editItem('crlf.txt', bytes, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['A'], new_lines: ['Z'] }])], 'k-files'),
        {},
        { max_change_files: 0 },
      ),
      'INVALID_ARGUMENT',
      'TOO_MANY_CHANGE_FILES',
    );
  });

  it('同一个文件在一次修改集里出现两次（大小写不同的拼写）→ DUPLICATE_TARGET_PATH', async () => {
    const bytes = await readRepoFile('crlf.txt');
    await expectPrepareError(
      run(
        inputWith(
          [
            editItem('crlf.txt', bytes, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['A'], new_lines: ['Z'] }]),
            editItem('CRLF.TXT', bytes, [{ start_line: 3, end_line_exclusive: 4, old_lines: ['C'], new_lines: ['Y'] }]),
          ],
          'k-dup',
        ),
      ),
      'INVALID_ARGUMENT',
      'DUPLICATE_TARGET_PATH',
    );
  });

  it('create_text 与 edit_text 撞同一个名字 → DUPLICATE_TARGET_PATH（创建侧只有路径层判据）', async () => {
    const bytes = await readRepoFile('crlf.txt');
    await expectPrepareError(
      run(
        inputWith(
          [
            editItem('crlf.txt', bytes, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['A'], new_lines: ['Z'] }]),
            createItem('CRLF.txt', 'x\n'),
          ],
          'k-dup-create',
        ),
      ),
      'INVALID_ARGUMENT',
      'DUPLICATE_TARGET_PATH',
    );
  });

  it('路径不合法（穿越）→ 契约校验拒绝，且不读磁盘', async () => {
    const bytes = await readRepoFile('crlf.txt');
    const item: ChangeItem = {
      op: 'edit_text',
      path: '../外面.txt',
      base_sha256: sha256(bytes),
      read_token: ticketFor(bytes, '../外面.txt'),
      edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: ['A'], new_lines: ['Z'] }],
    };
    const error = await expectPrepareError(run(inputWith([item], 'k-traversal')), 'INVALID_ARGUMENT', 'CHANGE_PATH_INVALID');
    assert.equal(error.details?.['path_reason'], 'PARENT_REF', '理由要指向具体是哪一条路径规则');
  });

  it('修改集建立后内容不可变（数据库触发器是最后一道）', async () => {
    const original = await readRepoFile('README.md');
    const result = await run(
      inputWith([editItem('README.md', original, [{ start_line: 2, end_line_exclusive: 3, old_lines: ['第二行'], new_lines: ['不可变'] }])], 'k-immutable'),
    );

    assert.throws(
      () => opened.db.prepare('UPDATE change_items SET target_sha256 = ? WHERE change_id = ?').run('f'.repeat(64), result.change_id),
      /不可变/,
    );
    assert.throws(
      () => opened.db.prepare('UPDATE changesets SET digest = ? WHERE id = ?').run('f'.repeat(64), result.change_id),
      /不可变/,
    );
    assert.equal(repos.changes.requireById(result.change_id).digest, result.digest);
  });

  it('初态恒为 PENDING_APPROVAL，且 prepare 不产生批准、不产生执行记录', async () => {
    const original = await readRepoFile('README.md');
    const result = await run(
      inputWith([editItem('README.md', original, [{ start_line: 2, end_line_exclusive: 3, old_lines: ['第二行'], new_lines: ['待批准'] }])], 'k-state'),
    );
    assert.equal(result.state, 'PENDING_APPROVAL');
    assert.equal(result.approval_required, false);
    assert.equal(repos.changes.requireById(result.change_id).state, 'PENDING_APPROVAL');
    assert.equal(repos.approvals.findActive(result.change_id), null, 'prepare 不得产生任何批准记录');
    assert.equal(repos.operations.findByChangeId(result.change_id), null, 'prepare 不得产生任何执行记录');
  });

  it('调用方塞进 input 的 approved / user_id / conversation_label 都不参与判定', async () => {
    const original = await readRepoFile('README.md');
    const payload = inputWith(
      [editItem('README.md', original, [{ start_line: 2, end_line_exclusive: 3, old_lines: ['第二行'], new_lines: ['无视'] }])],
      'k-approved-hint',
    ) as ChangePrepareInput & { approved: boolean; user_id: string; conversation_label: string };
    // 这三个字段在契约里都不存在。即便模型把它们塞进来，它们也不能参与任何
    // 判定：批准的唯一来源是 approvals 表里与摘要绑定的一条记录。
    payload.approved = true;
    payload.user_id = PRINCIPAL;
    payload.conversation_label = '某个会话';

    const result = await run(payload);
    assert.equal(result.state, 'PENDING_APPROVAL');
    assert.equal(result.approval_required, false);
    assert.equal(result.workspace_modified, false);
    assert.equal(repos.approvals.findActive(result.change_id), null);
  });

  it('落库用**磁盘规范拼写**，并留出大小写不敏感的比对键', async () => {
    const bytes = await readRepoFile('crlf.txt');
    const result = await run(
      inputWith([editItem('crlf.txt', bytes, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['A'], new_lines: ['Z'] }])], 'k-canonical'),
    );
    const item = repos.changes.items(result.change_id)[0]!;
    assert.equal(item.canonical_path, 'crlf.txt');
    assert.equal(item.canonical_path_key, 'crlf.txt');
    assert.equal(item.base_file_id, fileIdOf(path.join(repoRoot, 'crlf.txt')));
  });

  it('视图的固定文案：明确说明尚未写盘、且模型无法批准', async () => {
    const bytes = await readRepoFile('crlf.txt');
    const result = await run(
      inputWith([editItem('crlf.txt', bytes, [{ start_line: 1, end_line_exclusive: 2, old_lines: ['A'], new_lines: ['Z'] }])], 'k-view'),
    );
    assert.equal(result.workspace_modified, false);
    assert.match(result.next_action, /尚未写入任何文件/);
    assert.match(result.next_action, /授予文件修改权限/);
    assert.equal(result.short_code, shortCodeOf(result.digest));
    assert.equal(result.summary, '测试用摘要');
    assert.equal(result.workspace_id, WORKSPACE);
    // 有效期由**策略时钟**决定，与机器上的钟无关。
    //
    // 这里原来写的是 `Date.parse(created_at) <= Date.parse(expires_at)`，而那是一条
    // **定时炸弹**：两个字段来自不同的时钟 —— `expires_at` 由注入的 `now`
    // （本文件的 `NOW`）算出，`created_at` 由仓储自己的时钟写下
    // （`repositories.ts` 的 `this.clock()`，真机上是真实时间）。
    // `NOW` 定在 2026-09-25T12:00Z，于是那条断言在 2026-09-26T12:00Z 之前恒真、
    // 之后恒假：LWB-034 那一轮取证时它是绿的，LWB-035 这一轮同样是它变红，
    // 而两轮之间**没有任何代码被改过**。
    //
    // 要钉的其实是「修改集一出生就带着 24 小时的有效期」：
    assert.equal(Date.parse(result.expires_at) - NOW, LIMITS.CHANGE_TTL_MS);
    // 而 `created_at` 只要求是一个可解析的时刻 —— 它的值属于仓储的时钟，
    // 不是这条用例的题目。
    assert.ok(Number.isFinite(Date.parse(result.created_at)));
  });
});

// ---------------------------------------------------------------------------
// 风险提示
// ---------------------------------------------------------------------------

describe('LWB-020 风险提示', () => {
  const base: ChangeItemRecord = {
    id: 'ci',
    change_id: 'chg',
    seq: 0,
    op: 'edit_text',
    canonical_path: 'src/app.ts',
    canonical_path_key: 'src/app.ts',
    base_file_id: 'f',
    base_sha256: 'a'.repeat(64),
    target_sha256: 'b'.repeat(64),
    old_blob_id: 'ob',
    new_blob_id: 'nb',
    encoding: 'utf-8',
    bom: false,
    newline: 'lf',
    added_lines: 1,
    removed_lines: 1,
    created_at: '2026-09-25T00:00:00.000Z',
  };
  const codes = (items: readonly ChangeItemRecord[]): string[] => deriveRisks(items).map((r) => r.code);

  it('普通的逐行编辑不产生任何风险提示', () => {
    assert.deepEqual(codes([base]), []);
  });

  it('逐条：整文件替换、新建、大幅删减、脚本、凭据形状', () => {
    assert.deepEqual(codes([{ ...base, op: 'replace_text' }]), ['WHOLE_FILE_REPLACED']);
    assert.deepEqual(
      codes([{ ...base, op: 'create_text', base_sha256: null, base_file_id: null, old_blob_id: null, removed_lines: 0 }]),
      ['NEW_FILE_CREATED'],
    );
    assert.deepEqual(codes([{ ...base, added_lines: 1, removed_lines: 100 }]), ['LARGE_DELETION']);
    assert.deepEqual(codes([{ ...base, canonical_path: 'tools/gen.ps1', canonical_path_key: 'tools/gen.ps1' }]), ['EXECUTABLE_OR_SCRIPT']);
    assert.deepEqual(codes([{ ...base, canonical_path: 'keys/id_rsa', canonical_path_key: 'keys/id_rsa' }]), ['CREDENTIAL_SHAPED_PATH']);
  });

  it('多文件提示：条目多于一条就出现（≥10 条时升级为 warning）', () => {
    const many = Array.from({ length: 10 }, (_unused, i) => ({ ...base, id: `ci${i}`, seq: i }));
    assert.deepEqual(codes([base, { ...base, id: 'ci2', seq: 1 }]), ['MULTIPLE_FILES']);
    assert.equal(deriveRisks(many)[0]!.level, 'warning');
    assert.equal(deriveRisks([base, { ...base, id: 'ci2', seq: 1 }])[0]!.level, 'notice');
  });

  it('大幅删减的判据是**净删**：删得多但补得更多，不报', () => {
    assert.deepEqual(codes([{ ...base, added_lines: 500, removed_lines: 100 }]), []);
    // 删得不够多（不足 20 行）也不报，哪怕一行都没补。
    assert.deepEqual(codes([{ ...base, added_lines: 0, removed_lines: 19 }]), []);
  });

  it('凭据形状认得的是**基名**，不是整条路径', () => {
    const withName = (p: string): string[] => codes([{ ...base, canonical_path: p, canonical_path_key: p }]);
    assert.ok(withName('a/.env.local').includes('CREDENTIAL_SHAPED_PATH'));
    assert.ok(withName('deep/nested/app.pem').includes('CREDENTIAL_SHAPED_PATH'));
    assert.ok(withName('a/tokens.ts').includes('CREDENTIAL_SHAPED_PATH'));
  });

  it('一条够不着的规则不如没有：`.env` 没有专属提示，因为它被策略直接挡在门外', () => {
    // `.env` / `.env.*` / `*.env` 由 `HD-ENV` 硬拒绝，连读取票据都拿不到，
    // 永远到不了修改集。若这里给它一条提示，读者会以为这一类路径「只是被提示」，
    // 而实际上它们是被挡住的。剩下的凭据形状（`.env.local` 之类）确实可以是
    // 工作区里的普通文件，所以它们才需要被提示 —— 两条规则同在，见下。
    const env = deriveRisks([{ ...base, canonical_path: '.env', canonical_path_key: '.env' }]);
    assert.deepEqual(env.map((r) => r.code), ['CREDENTIAL_SHAPED_PATH']);
    assert.match(env[0]!.message, /形如凭据或密钥/, '是「名字形状像」，不是「它是 .env」');
  });

  it('风险由落库事实推导、不落库：同一份事实两次推导给出同一结果', () => {
    const items: readonly ChangeItemRecord[] = [{ ...base, op: 'replace_text' }, { ...base, id: 'ci2', seq: 1 }];
    assert.deepEqual(deriveRisks(items), deriveRisks(items));
    assert.deepEqual(
      deriveRisks(items).map((r) => r.level),
      ['notice', 'warning'],
      '两个文件给 notice、整文件替换给 warning',
    );
  });
});
