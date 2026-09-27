/**
 * 工作区登记测试（LWB-009）。
 *
 * 三条验收标准各有对应的用例，其中：
 *  - 「单文件授权不会顺带暴露其整个父目录」与「同名路径被替换为另一目录后
 *    原授权失效」需要**真实文件身份**，因此在 tests/windows/ 下用真实护栏跑；
 *    本文件里用注入事实的方式覆盖同一条判定的**逻辑**部分。
 *  - 「移除工作区后旧修改集、读取票据和游标不能继续使用」是状态与代次问题，
 *    在这里用真实的 `:memory:` 状态库跑完整流程。
 *
 * 约定：断言信息里带上实际值。拒绝类断言同时断言**理由码**，
 * 因为「被拒绝了」和「因为正确的原因被拒绝」是两件事。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { BridgeError } from '@lwb/contracts';
import { OperationRegistry, type RequestContext } from '@lwb/ipc';
import {
  Repositories,
  closeDatabase,
  openDatabase,
  type OpenDatabaseResult,
  type WorkspaceRecord,
} from '@lwb/persistence';
import type { WinfsError, WinfsVolumeInfo } from '@lwb/winfs';
import {
  RootRejectedError,
  WorkspaceRegistry,
  ancestorPaths,
  isStrictAncestor,
  parseAbsoluteRoot,
  rootKey,
  screenRoot,
  validateAlias,
  type RootFacts,
  type RootProbe,
  type ScreenInput,
  type WorkspaceEnvironment,
} from '@lwb/workspaces';

import { registerWorkspaceOperations } from '../../apps/daemon/src/control/workspaces.ts';

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

function facts(over: Partial<RootFacts> & { path: string }): RootFacts {
  return {
    volume_id: 'aabbccdd',
    file_id: '0000000000000001',
    drive_type: 'fixed',
    file_system: 'NTFS',
    is_cloud_placeholder: false,
    is_reparse: false,
    is_directory: true,
    link_count: 1,
    volume_info_available: true,
    ...over,
  };
}

/** 把 RootFacts 补成原生层返回的完整结构（登记表只读其中一部分字段）。 */
function asVolumeInfo(f: RootFacts): WinfsVolumeInfo {
  return {
    ok: true,
    ...f,
    drive_type: f.drive_type as WinfsVolumeInfo['drive_type'],
    file_system_flags: 0,
    volume_label: null,
    max_component_length: 255,
    recall_on_open: false,
    recall_on_data_access: false,
  };
}

/**
 * 只回答预设事实的探测器。
 *
 * `calls` 记录被问过的路径 —— 好几个用例断言的是「**根本没有探测**」
 * （例如来源不是本地控制台时），那比断言错误码更强。
 */
class FakeProbe implements RootProbe {
  readonly calls: string[] = [];
  readonly #byPath = new Map<string, RootFacts>();

  constructor(entries: readonly RootFacts[]) {
    for (const entry of entries) {
      this.#byPath.set(rootKey(entry.path), entry);
    }
  }

  async statVolume(req: { path: string }): Promise<WinfsVolumeInfo | WinfsError> {
    this.calls.push(req.path);
    const hit = this.#byPath.get(rootKey(req.path));
    if (!hit) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: `桩：未预设路径 ${req.path}`,
        win32_error: 2,
      };
    }
    return asVolumeInfo(hit);
  }
}

/** 一个候选根 + 它的整条祖先链，全部为合法的固定 NTFS 事实。 */
function chainFor(root: string, over: Partial<RootFacts> = {}, ancestorOver: Partial<RootFacts> = {}) {
  const parsed = parseAbsoluteRoot(root);
  if (!parsed.ok) throw new Error(`测试根不合法：${parsed.detail}`);
  const out: RootFacts[] = [facts({ path: parsed.normalized, ...over })];
  for (const ancestor of ancestorPaths(parsed.normalized)) {
    out.push(facts({ path: ancestor, ...ancestorOver }));
  }
  return out;
}

const TEST_ENV: WorkspaceEnvironment = {
  store_root: 'C:\\LWBTEST\\store',
  home_directory: 'C:\\LWBTEST\\home',
  extra_broad_probes: [],
  protected_refs: [],
  policy_version: 7,
};

interface Harness {
  readonly opened: OpenDatabaseResult;
  readonly repos: Repositories;
  readonly registry: WorkspaceRegistry;
  readonly probe: FakeProbe;
}

function makeHarness(
  probeEntries: readonly RootFacts[],
  env: WorkspaceEnvironment = TEST_ENV,
): Harness {
  const opened = openDatabase({ path: ':memory:' });
  const repos = new Repositories(opened.db);
  const probe = new FakeProbe(probeEntries);
  let counter = 0;
  const registry = new WorkspaceRegistry({
    repos,
    probe,
    environment: env,
    newId: () => `ws_${String(++counter).padStart(4, '0')}`,
  });
  return { opened, repos, registry, probe };
}

const harnesses: OpenDatabaseResult[] = [];
after(() => {
  for (const opened of harnesses) closeDatabase(opened.db);
  harnesses.length = 0;
});

function newHarness(
  probeEntries: readonly RootFacts[],
  env: WorkspaceEnvironment = TEST_ENV,
): Harness {
  const h = makeHarness(probeEntries, env);
  harnesses.push(h.opened);
  return h;
}

function rejectionReasons(error: unknown): string[] {
  assert.ok(error instanceof RootRejectedError, `应抛 RootRejectedError，实际：${String(error)}`);
  return error.rejections.map((r) => r.reason);
}

function expectBridgeError(code: string, fn: () => unknown, hint = ''): BridgeError {
  try {
    fn();
  } catch (cause) {
    assert.ok(cause instanceof BridgeError, `${hint} 应抛 BridgeError，实际：${String(cause)}`);
    assert.equal(cause.code, code, `${hint} 的错误码`);
    return cause;
  }
  assert.fail(`${hint} 应当抛出 ${code}，但没有抛错`);
}

async function expectAsyncBridgeError(
  code: string,
  fn: () => Promise<unknown>,
  hint = '',
): Promise<BridgeError> {
  try {
    await fn();
  } catch (cause) {
    assert.ok(cause instanceof BridgeError, `${hint} 应抛 BridgeError，实际：${String(cause)}`);
    assert.equal(cause.code, code, `${hint} 的错误码`);
    return cause;
  }
  assert.fail(`${hint} 应当抛出 ${code}，但没有抛错`);
}

// ---------------------------------------------------------------------------
// 1. 绝对路径语法
// ---------------------------------------------------------------------------

describe('LWB-009 候选根路径语法', () => {
  it('拒绝盘符根：它等价于授权整块磁盘', () => {
    const parsed = parseAbsoluteRoot('D:\\');
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok === false ? parsed.reason : '', 'DRIVE_ROOT');
  });

  it('拒绝 UNC、设备命名空间、根相对、盘符相对', () => {
    const cases: readonly [string, string][] = [
      ['\\\\server\\share\\dir', 'UNC'],
      ['//server/share', 'UNC'],
      ['\\\\?\\D:\\dir', 'DEVICE_NAMESPACE'],
      ['\\\\.\\PhysicalDrive0', 'DEVICE_NAMESPACE'],
      ['\\??\\D:\\dir', 'DEVICE_NAMESPACE'],
      ['\\dir', 'ROOT_RELATIVE'],
      ['/dir', 'ROOT_RELATIVE'],
      ['D:', 'DRIVE_RELATIVE'],
      ['D:dir', 'DRIVE_RELATIVE'],
      ['dir\\sub', 'NOT_ABSOLUTE'],
      ['..\\..\\Windows', 'NOT_ABSOLUTE'],
    ];
    for (const [input, reason] of cases) {
      const parsed = parseAbsoluteRoot(input);
      assert.equal(parsed.ok, false, `${input} 应当被拒绝`);
      assert.equal(parsed.ok === false ? parsed.reason : '', reason, `${input} 的拒绝理由`);
    }
  });

  it('拒绝混淆性段：..、.、ADS 冒号、非法字符、尾点尾空格、保留名', () => {
    const cases: readonly [string, string][] = [
      ['D:\\a\\..\\b', 'PARENT_REF'],
      ['D:\\a\\.\\b', 'DOT_SEGMENT'],
      ['D:\\a\\b:c', 'ADS_COLON'],
      ['D:\\a\\b*c', 'INVALID_CHAR'],
      ['D:\\a\\b.', 'TRAILING_DOT_OR_SPACE'],
      ['D:\\a\\b \\c', 'TRAILING_DOT_OR_SPACE'],
      ['D:\\a\\NUL', 'RESERVED_NAME'],
      ['D:\\a\\con.txt', 'RESERVED_NAME'],
      ['D:\\a\\\\b', 'EMPTY_SEGMENT'],
      ['D:\\a\\', 'EMPTY_SEGMENT'],
      ['D:\\a\u0000b', 'CONTROL_CHAR'],
      [`D:\\${Array.from({ length: 65 }, () => 'a').join('\\')}`, 'TOO_DEEP'],
      [`D:\\${'x'.repeat(256)}`, 'SEGMENT_TOO_LONG'],
    ];
    for (const [input, reason] of cases) {
      const parsed = parseAbsoluteRoot(input);
      assert.equal(parsed.ok, false, `${JSON.stringify(input)} 应当被拒绝`);
      assert.equal(parsed.ok === false ? parsed.reason : '', reason, `${JSON.stringify(input)} 的理由`);
    }
  });

  it('规范化：接受正反斜杠混写，统一为反斜杠；尾部分隔符要先被拒掉', () => {
    const trailing = parseAbsoluteRoot('d:/MyProjects\\MyApps/');
    assert.equal(trailing.ok, false, '尾分隔符不应被静默去掉');
    assert.equal(trailing.ok === false ? trailing.reason : '', 'EMPTY_SEGMENT');

    const ok = parseAbsoluteRoot('d:/MyProjects\\MyApps');
    assert.equal(ok.ok, true);
    assert.equal(ok.ok === true ? ok.normalized : '', 'D:\\MyProjects\\MyApps');
    assert.deepEqual(ok.ok === true ? [...ok.segments] : [], ['D:', 'MyProjects', 'MyApps']);
  });

  it('**不**凭字符串里的 ~ 判定 8.3 别名（那需要文件身份）', () => {
    // 方案 §5.2 明确要求：大小写与 8.3 别名必须用实际身份消歧，
    // 不能因为出现 `~` 就拒绝 —— 合法文件名里也可能有 ~。
    const parsed = parseAbsoluteRoot('D:\\PROGRA~1\\app');
    assert.equal(parsed.ok, true, '8.3 形式在语法层不构成拒绝理由');
  });

  it('祖先链由外向内且不含自身', () => {
    assert.deepEqual(ancestorPaths('D:\\a\\b\\c'), ['D:\\', 'D:\\a', 'D:\\a\\b']);
    assert.deepEqual(ancestorPaths('D:\\a'), ['D:\\']);
  });

  it('祖先判定大小写不敏感，且不把同级当作包含', () => {
    assert.equal(isStrictAncestor('d:\\A', 'D:\\a\\b'), true);
    assert.equal(isStrictAncestor('D:\\a', 'D:\\ab'), false, '前缀相同但不是子路径');
    assert.equal(isStrictAncestor('D:\\a', 'D:\\a'), false, '相等不是严格祖先');
  });

  it('别名不能是路径、不能含控制字符、不能过长', () => {
    assert.equal(validateAlias('D:\\secret').ok, false);
    assert.equal(validateAlias('\\\\server\\share').ok, false);
    assert.equal(validateAlias('/etc').ok, false);
    assert.equal(validateAlias('').ok, false);
    assert.equal(validateAlias('a\u0000b').ok, false);
    assert.equal(validateAlias('x'.repeat(65)).ok, false);
    assert.equal(validateAlias('TransportAndAI').ok, true);
  });
});

// ---------------------------------------------------------------------------
// 2. 筛查（纯函数）
// ---------------------------------------------------------------------------

function screenInput(over: Partial<ScreenInput> = {}): ScreenInput {
  const root = over.root ?? 'D:\\work';
  return {
    origin: 'local_console',
    alias: 'work',
    kind: 'directory',
    mode: 'read_propose_apply_with_local_approval',
    root,
    facts: facts({ path: root }),
    ancestors: ancestorPaths(root).map((p) => facts({ path: p })),
    broad: { accepted: true },
    protected_identity: null,
    existing: [],
    ...over,
  };
}

describe('LWB-009 候选根筛查', () => {
  it('全部条件满足时没有任何拒绝理由', () => {
    assert.deepEqual(screenRoot(screenInput()), []);
  });

  it('来源不是本地控制台时拒绝（模型不能创建工作区）', () => {
    const reasons = screenRoot(screenInput({ origin: 'model_surface' })).map((r) => r.reason);
    assert.deepEqual(reasons, ['ORIGIN_NOT_LOCAL']);
  });

  it('云占位文件被拒绝', () => {
    const reasons = screenRoot(
      screenInput({ facts: facts({ path: 'D:\\work', is_cloud_placeholder: true }) }),
    ).map((r) => r.reason);
    assert.ok(reasons.includes('CLOUD_PLACEHOLDER'), `实际：${reasons.join(',')}`);
  });

  it('网络盘与非 fixed 盘型被拒绝', () => {
    assert.ok(
      screenRoot(screenInput({ facts: facts({ path: 'D:\\work', drive_type: 'remote' }) })).some(
        (r) => r.reason === 'DRIVE_TYPE_REMOTE',
      ),
    );
    for (const drive_type of ['removable', 'cdrom', 'ramdisk', 'unknown']) {
      assert.ok(
        screenRoot(screenInput({ facts: facts({ path: 'D:\\work', drive_type }) })).some(
          (r) => r.reason === 'DRIVE_TYPE_UNSUPPORTED',
        ),
        `${drive_type} 应当被拒绝`,
      );
    }
  });

  it('未验证的文件系统被拒绝，且理由里带上实际文件系统名', () => {
    const rejections = screenRoot(
      screenInput({ facts: facts({ path: 'D:\\work', file_system: 'exFAT' }) }),
    );
    const hit = rejections.find((r) => r.reason === 'FILESYSTEM_UNVERIFIED');
    assert.ok(hit, 'exFAT 应当被拒绝');
    assert.ok(hit.detail.includes('exFAT'), `理由中应含实际文件系统：${hit.detail}`);
  });

  it('取不到卷信息时拒绝，而不是当作通过', () => {
    const reasons = screenRoot(
      screenInput({
        facts: facts({ path: 'D:\\work', volume_info_available: false, file_system: null }),
      }),
    ).map((r) => r.reason);
    assert.deepEqual(reasons, ['VOLUME_INFO_UNAVAILABLE']);
  });

  it('根自身是重解析点时拒绝', () => {
    const reasons = screenRoot(
      screenInput({ facts: facts({ path: 'D:\\work', is_reparse: true }) }),
    ).map((r) => r.reason);
    assert.ok(reasons.includes('ROOT_IS_REPARSE'), `实际：${reasons.join(',')}`);
  });

  it('祖先中任何一级是重解析点都拒绝（只看最后一级会漏）', () => {
    const root = 'D:\\work\\deep';
    const ancestors = ancestorPaths(root).map((p) =>
      facts({ path: p, is_reparse: p.toLowerCase() === 'd:\\work' }),
    );
    const reasons = screenRoot(screenInput({ root, ancestors })).map((r) => r.reason);
    assert.ok(reasons.includes('ANCESTOR_IS_REPARSE'), `实际：${reasons.join(',')}`);
  });

  it('祖先事实缺失即拒绝：无法证明就等于不安全', () => {
    const reasons = screenRoot(screenInput({ root: 'D:\\work\\deep', ancestors: [] })).map(
      (r) => r.reason,
    );
    assert.deepEqual(reasons, ['ANCESTOR_UNVERIFIABLE', 'ANCESTOR_UNVERIFIABLE']);
  });

  it('硬链接数大于 1 时拒绝', () => {
    const reasons = screenRoot(
      screenInput({ facts: facts({ path: 'D:\\work\\f.txt', link_count: 2, is_directory: false }), kind: 'file' }),
    ).map((r) => r.reason);
    assert.ok(reasons.includes('HARDLINK'), `实际：${reasons.join(',')}`);
  });

  it('登记形态与磁盘实际形态不符时拒绝', () => {
    const asFile = screenRoot(
      screenInput({ kind: 'file', root: 'D:\\work', facts: facts({ path: 'D:\\work' }) }),
    ).map((r) => r.reason);
    assert.ok(asFile.includes('KIND_MISMATCH'), `实际：${asFile.join(',')}`);

    const asDir = screenRoot(
      screenInput({
        kind: 'directory',
        root: 'D:\\work\\f.txt',
        facts: facts({ path: 'D:\\work\\f.txt', is_directory: false }),
        ancestors: ancestorPaths('D:\\work\\f.txt').map((p) => facts({ path: p })),
      }),
    ).map((r) => r.reason);
    assert.ok(asDir.includes('KIND_MISMATCH'), `实际：${asDir.join(',')}`);
  });

  it('广泛目录与受保护存储被区分成两个理由码', () => {
    const broad = screenRoot(
      screenInput({ broad: { accepted: false, reason: '该目录是系统级或用户级广泛目录，范围过大，不得作为工作区。' } }),
    ).map((r) => r.reason);
    assert.deepEqual(broad, ['BROAD_DIRECTORY']);

    const store = screenRoot(
      screenInput({
        broad: { accepted: false, reason: '该目录包含本地服务的受保护存储（凭证、状态库、快照、日志），不得作为工作区。' },
      }),
    ).map((r) => r.reason);
    assert.deepEqual(store, ['PROTECTED_STORE']);
  });

  it('受保护对象的身份命中时拒绝（换了写法也拦得住）', () => {
    const reasons = screenRoot(
      screenInput({
        root: 'D:\\alias-of-store',
        facts: facts({ path: 'D:\\alias-of-store', volume_id: 'ffffffff', file_id: 'deadbeef' }),
        ancestors: ancestorPaths('D:\\alias-of-store').map((p) => facts({ path: p })),
        protected_identity: { volume_id: 'ffffffff', file_id: 'deadbeef', label: '受保护存储根' },
      }),
    ).map((r) => r.reason);
    assert.ok(reasons.includes('PROTECTED_IDENTITY'), `实际：${reasons.join(',')}`);
  });
});

// ---------------------------------------------------------------------------
// 3. 重叠与物理别名（步骤 3）
// ---------------------------------------------------------------------------

const WRITE_MODE = 'read_propose_apply_with_local_approval' as const;

function existingRoot(over: Partial<ScreenInput['existing'][number]> = {}) {
  return {
    id: 'ws_old',
    alias: 'old',
    kind: 'directory' as const,
    mode: WRITE_MODE,
    path: 'D:\\work',
    volume_id: 'aabbccdd',
    file_id: '0000000000000001',
    ...over,
  };
}

describe('LWB-009 重叠的可写根与物理别名', () => {
  it('同一个物理对象换个写法登记会被身份判定拦下', () => {
    const reasons = screenRoot(
      screenInput({
        root: 'D:\\work-alias',
        facts: facts({ path: 'D:\\work-alias', volume_id: 'aabbccdd', file_id: '0000000000000001' }),
        ancestors: ancestorPaths('D:\\work-alias').map((p) => facts({ path: p })),
        existing: [existingRoot()],
      }),
    ).map((r) => r.reason);
    assert.ok(reasons.includes('DUPLICATE_IDENTITY'), `实际：${reasons.join(',')}`);
  });

  it('同一路径（大小写不同）登记两次被拒绝', () => {
    const root = 'd:\\WORK';
    const reasons = screenRoot(
      screenInput({
        root,
        facts: facts({ path: root, volume_id: 'zzzz', file_id: 'other' }),
        ancestors: ancestorPaths(root).map((p) => facts({ path: p })),
        existing: [existingRoot()],
      }),
    ).map((r) => r.reason);
    assert.ok(reasons.includes('DUPLICATE_PATH'), `实际：${reasons.join(',')}`);
  });

  it('候选根在在册可写根之内：拒绝', () => {
    const root = 'D:\\work\\sub';
    const reasons = screenRoot(
      screenInput({
        root,
        facts: facts({ path: root, volume_id: 'zzzz', file_id: 'other' }),
        ancestors: ancestorPaths(root).map((p) => facts({ path: p })),
        existing: [existingRoot()],
      }),
    ).map((r) => r.reason);
    assert.ok(reasons.includes('WRITABLE_ROOT_OVERLAP'), `实际：${reasons.join(',')}`);
  });

  it('候选根包含在册可写根：同样拒绝', () => {
    const root = 'D:\\';
    const reasons = screenRoot(
      screenInput({
        root: 'D:\\work',
        facts: facts({ path: 'D:\\work', volume_id: 'zzzz', file_id: 'other' }),
        ancestors: ancestorPaths('D:\\work').map((p) => facts({ path: p })),
        existing: [existingRoot({ path: 'D:\\work\\inner', id: 'ws_inner', alias: 'inner' })],
      }),
    ).map((r) => r.reason);
    assert.ok(reasons.includes('WRITABLE_ROOT_OVERLAP'), `实际：${reasons.join(',')}`);
    assert.ok(root.length > 0);
  });

  it('可写根与**只读**根重叠也拒绝：写入会穿过只读边界', () => {
    const root = 'D:\\work\\sub';
    const reasons = screenRoot(
      screenInput({
        root,
        facts: facts({ path: root, volume_id: 'zzzz', file_id: 'other' }),
        ancestors: ancestorPaths(root).map((p) => facts({ path: p })),
        existing: [existingRoot({ mode: 'read_only' })],
      }),
    ).map((r) => r.reason);
    assert.ok(reasons.includes('WRITABLE_ROOT_OVERLAP'), `实际：${reasons.join(',')}`);
  });

  it('两侧都只读时允许重叠：读同一批文件不产生新的能力', () => {
    const root = 'D:\\work\\sub';
    const reasons = screenRoot(
      screenInput({
        root,
        mode: 'read_only',
        facts: facts({ path: root, volume_id: 'zzzz', file_id: 'other' }),
        ancestors: ancestorPaths(root).map((p) => facts({ path: p })),
        existing: [existingRoot({ mode: 'read_only' })],
      }),
    ).map((r) => r.reason);
    assert.deepEqual(reasons, []);
  });

  it('候选根的某一级**就是**在册可写根，只是写法不同：按身份拒绝', () => {
    const root = 'D:\\PROGRA~1\\app';
    const reasons = screenRoot(
      screenInput({
        root,
        facts: facts({ path: root, volume_id: 'zzzz', file_id: 'other' }),
        ancestors: [
          facts({ path: 'D:\\', volume_id: 'aabbccdd', file_id: '0000000000000001' }),
          facts({ path: 'D:\\PROGRA~1', volume_id: 'yyyy', file_id: 'other2' }),
        ],
        existing: [existingRoot({ path: 'D:\\Program Files' })],
      }),
    ).map((r) => r.reason);
    assert.ok(reasons.includes('WRITABLE_ROOT_OVERLAP'), `实际：${reasons.join(',')}`);
  });
});

// ---------------------------------------------------------------------------
// 4. 登记表：步骤 1、2
// ---------------------------------------------------------------------------

describe('LWB-009 登记', () => {
  it('登记目录：保存规范根、卷身份、根身份与访问模式', async () => {
    const h = newHarness(chainFor('D:\\work'));
    const record = await h.registry.register({
      alias: 'work',
      kind: 'directory',
      path: 'D:\\work',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    assert.equal(record.canonical_root, 'D:\\work');
    assert.equal(record.volume_id, 'aabbccdd');
    assert.equal(record.root_file_id, '0000000000000001');
    assert.equal(record.mode, WRITE_MODE);
    assert.equal(record.kind, 'directory');
    assert.equal(record.generation, 1);
    assert.equal(record.policy_version, TEST_ENV.policy_version);
    assert.equal(record.removed_at, null);
    assert.equal(record.enabled, true);
  });

  it('登记单个文件：根身份是**文件**的身份，不是它所在目录的', async () => {
    const entries = [
      facts({ path: 'D:\\work\\only.txt', is_directory: false, file_id: '00000000000000ff' }),
      facts({ path: 'D:\\work', file_id: '0000000000000001' }),
      facts({ path: 'D:\\' }),
    ];
    const h = newHarness(entries);
    const record = await h.registry.register({
      alias: 'only',
      kind: 'file',
      path: 'D:\\work\\only.txt',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    assert.equal(record.kind, 'file');
    assert.equal(record.canonical_root, 'D:\\work\\only.txt');
    assert.equal(record.root_file_id, '00000000000000ff', '必须是该文件自己的身份');
    assert.notEqual(record.root_file_id, '0000000000000001', '不得是父目录的身份');
  });

  it('来源不是本地控制台：拒绝，并且**一次探测都不发生**', async () => {
    const h = newHarness(chainFor('D:\\work'));
    const error = await h.registry
      .register({
        alias: 'work',
        kind: 'directory',
        path: 'D:\\work',
        mode: WRITE_MODE,
        origin: 'model_surface',
      })
      .then(
        () => assert.fail('模型侧登记必须被拒绝'),
        (cause: unknown) => cause,
      );
    assert.deepEqual(rejectionReasons(error), ['ORIGIN_NOT_LOCAL']);
    assert.deepEqual(h.probe.calls, [], '被拒绝的请求不该在原生层留下痕迹');
    assert.equal(h.repos.workspaces.list({ include_disabled: true }).length, 0);
  });

  it('盘符根在语法阶段就被拒绝，不进入探测', async () => {
    const h = newHarness([]);
    const error = await h.registry
      .register({ alias: 'disk', kind: 'directory', path: 'D:\\', mode: WRITE_MODE, origin: 'local_console' })
      .then(
        () => assert.fail('盘符根必须被拒绝'),
        (cause: unknown) => cause,
      );
    assert.deepEqual(rejectionReasons(error), ['DRIVE_ROOT']);
    assert.deepEqual(h.probe.calls, []);
  });

  it('云占位文件被拒绝，且不写入任何行', async () => {
    const h = newHarness(chainFor('D:\\cloud', { is_cloud_placeholder: true }));
    const error = await h.registry
      .register({ alias: 'cloud', kind: 'directory', path: 'D:\\cloud', mode: WRITE_MODE, origin: 'local_console' })
      .then(
        () => assert.fail('云占位必须被拒绝'),
        (cause: unknown) => cause,
      );
    assert.ok(rejectionReasons(error).includes('CLOUD_PLACEHOLDER'));
    assert.equal(h.repos.workspaces.list({ include_disabled: true }).length, 0);
  });

  it('过宽用户目录被拒绝（主目录本身）', async () => {
    const env: WorkspaceEnvironment = { ...TEST_ENV, home_directory: 'D:\\Users\\me' };
    const h = newHarness(chainFor('D:\\Users\\me'), env);
    const error = await h.registry
      .register({
        alias: 'profile',
        kind: 'directory',
        path: 'D:\\Users\\me',
        mode: WRITE_MODE,
        origin: 'local_console',
      })
      .then(
        () => assert.fail('用户主目录必须被拒绝'),
        (cause: unknown) => cause,
      );
    assert.ok(rejectionReasons(error).includes('BROAD_DIRECTORY'), rejectionReasons(error).join(','));
  });

  it('受保护存储根的**祖先**被拒绝（只拒绝存储根本身是不够的）', async () => {
    const env: WorkspaceEnvironment = { ...TEST_ENV, store_root: 'D:\\work\\store' };
    const h = newHarness(chainFor('D:\\work'), env);
    const error = await h.registry
      .register({ alias: 'work', kind: 'directory', path: 'D:\\work', mode: WRITE_MODE, origin: 'local_console' })
      .then(
        () => assert.fail('受保护存储根的祖先必须被拒绝'),
        (cause: unknown) => cause,
      );
    assert.ok(rejectionReasons(error).includes('PROTECTED_STORE'), rejectionReasons(error).join(','));
  });

  it('受保护存储根本身被拒绝', async () => {
    const env: WorkspaceEnvironment = { ...TEST_ENV, store_root: 'D:\\work\\store' };
    const h = newHarness(chainFor('D:\\work\\store'), env);
    const error = await h.registry
      .register({
        alias: 'store',
        kind: 'directory',
        path: 'D:\\work\\store',
        mode: WRITE_MODE,
        origin: 'local_console',
      })
      .then(
        () => assert.fail('受保护存储根必须被拒绝'),
        (cause: unknown) => cause,
      );
    assert.ok(rejectionReasons(error).includes('PROTECTED_STORE'), rejectionReasons(error).join(','));
  });

  it('受保护对象的身份命中即拒绝，即使路径字符串完全不同', async () => {
    const env: WorkspaceEnvironment = {
      ...TEST_ENV,
      protected_refs: [{ volume_id: 'aabbccdd', file_id: '0000000000000001', label: '状态库目录' }],
    };
    const h = newHarness(chainFor('D:\\looks-innocent'), env);
    const error = await h.registry
      .register({
        alias: 'innocent',
        kind: 'directory',
        path: 'D:\\looks-innocent',
        mode: WRITE_MODE,
        origin: 'local_console',
      })
      .then(
        () => assert.fail('身份命中必须被拒绝'),
        (cause: unknown) => cause,
      );
    assert.ok(rejectionReasons(error).includes('PROTECTED_IDENTITY'), rejectionReasons(error).join(','));
  });

  it('非 NTFS 被拒绝，并在理由里说明实际文件系统', async () => {
    const h = newHarness(chainFor('D:\\work', { file_system: 'ReFS' }));
    const error = await h.registry
      .register({ alias: 'work', kind: 'directory', path: 'D:\\work', mode: WRITE_MODE, origin: 'local_console' })
      .then(
        () => assert.fail('ReFS 必须被拒绝'),
        (cause: unknown) => cause,
      );
    const reasons = rejectionReasons(error);
    assert.ok(reasons.includes('FILESYSTEM_UNVERIFIED'), reasons.join(','));
  });

  it('祖先无法探测即拒绝：无法证明链上没有重解析点', async () => {
    const h = newHarness([facts({ path: 'D:\\work\\deep' })]);
    const error = await h.registry
      .register({
        alias: 'deep',
        kind: 'directory',
        path: 'D:\\work\\deep',
        mode: WRITE_MODE,
        origin: 'local_console',
      })
      .then(
        () => assert.fail('祖先不可验证必须被拒绝'),
        (cause: unknown) => cause,
      );
    const reasons = rejectionReasons(error);
    assert.ok(reasons.includes('ANCESTOR_UNVERIFIABLE'), reasons.join(','));
  });

  it('别名重复被拒绝', async () => {
    const h = newHarness([
      ...chainFor('D:\\work'),
      ...chainFor('D:\\other', { volume_id: 'zzzz', file_id: '0000000000000002' }),
    ]);
    await h.registry.register({
      alias: 'work',
      kind: 'directory',
      path: 'D:\\work',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    const error = await h.registry
      .register({
        alias: 'work',
        kind: 'directory',
        path: 'D:\\other',
        mode: WRITE_MODE,
        origin: 'local_console',
      })
      .then(
        () => assert.fail('别名重复必须被拒绝'),
        (cause: unknown) => cause,
      );
    assert.ok(rejectionReasons(error).includes('DUPLICATE_ALIAS'), rejectionReasons(error).join(','));
  });

  it('同一个物理目录换个路径写法登记两次被拒绝', async () => {
    const h = newHarness([
      ...chainFor('D:\\work'),
      // 别名路径指向同一个物理对象：路径不同、身份相同。
      facts({ path: 'D:\\alias', volume_id: 'aabbccdd', file_id: '0000000000000001' }),
      facts({ path: 'D:\\' }),
    ]);
    await h.registry.register({
      alias: 'work',
      kind: 'directory',
      path: 'D:\\work',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    const error = await h.registry
      .register({
        alias: 'alias',
        kind: 'directory',
        path: 'D:\\alias',
        mode: WRITE_MODE,
        origin: 'local_console',
      })
      .then(
        () => assert.fail('物理别名必须被拒绝'),
        (cause: unknown) => cause,
      );
    assert.ok(rejectionReasons(error).includes('DUPLICATE_IDENTITY'), rejectionReasons(error).join(','));
  });
});

// ---------------------------------------------------------------------------
// 5. 代次（步骤 3）
// ---------------------------------------------------------------------------

describe('LWB-009 代次', () => {
  it('暂停与恢复**都**递增代次', async () => {
    const h = newHarness(chainFor('D:\\work'));
    const record = await h.registry.register({
      alias: 'work',
      kind: 'directory',
      path: 'D:\\work',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    assert.equal(record.generation, 1);

    const paused = h.registry.pause(record.id, 'local_console');
    assert.equal(paused.enabled, false);
    assert.equal(paused.generation, 2, '暂停必须递增代次，否则停用前签发的票据仍然有效');

    const resumed = await h.registry.resume(record.id, 'local_console');
    assert.equal(resumed.enabled, true);
    assert.equal(resumed.generation, 3, '恢复是一次重新授权，同样递增代次');
  });

  it('访问时携带旧代次会被拒绝，并说明当前代次', async () => {
    const h = newHarness(chainFor('D:\\work'));
    const record = await h.registry.register({
      alias: 'work',
      kind: 'directory',
      path: 'D:\\work',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    const stale = record.generation;
    h.registry.pause(record.id, 'local_console');
    await h.registry.resume(record.id, 'local_console');

    const error = await expectAsyncBridgeError(
      'WORKSPACE_GENERATION_CHANGED',
      () => h.registry.authorizeAccess(record.id, { generation: stale }),
      '旧代次',
    );
    assert.equal(error.details?.['current_generation'], 3);
    assert.equal(error.details?.['presented_generation'], 1);
  });

  it('停用的工作区不能被访问', async () => {
    const h = newHarness(chainFor('D:\\work'));
    const record = await h.registry.register({
      alias: 'work',
      kind: 'directory',
      path: 'D:\\work',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    h.registry.pause(record.id, 'local_console');
    await expectAsyncBridgeError('WORKSPACE_NOT_GRANTED', () => h.registry.authorizeAccess(record.id));
  });

  it('重定位会递增代次，并对新路径重跑完整筛查', async () => {
    const h = newHarness([
      ...chainFor('D:\\work'),
      ...chainFor('D:\\other', { volume_id: 'zzzz', file_id: '0000000000000002' }),
    ]);
    const record = await h.registry.register({
      alias: 'work',
      kind: 'directory',
      path: 'D:\\work',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    const moved = await h.registry.relocate(record.id, 'D:\\other', 'local_console');
    assert.equal(moved.canonical_root, 'D:\\other');
    assert.equal(moved.volume_id, 'zzzz');
    assert.equal(moved.generation, 2);
  });

  it('重定位到盘符根会被拒绝：不能先登记安全目录再换过去', async () => {
    const h = newHarness(chainFor('D:\\work'));
    const record = await h.registry.register({
      alias: 'work',
      kind: 'directory',
      path: 'D:\\work',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    const error = await h.registry
      .relocate(record.id, 'D:\\', 'local_console')
      .then(
        () => assert.fail('重定位到盘符根必须被拒绝'),
        (cause: unknown) => cause,
      );
    assert.deepEqual(rejectionReasons(error), ['DRIVE_ROOT']);
    assert.equal(h.repos.workspaces.requireById(record.id).generation, 1, '被拒绝的重定位不得改状态');
  });

  it('重定位到云占位目录会被拒绝', async () => {
    const h = newHarness([
      ...chainFor('D:\\work'),
      ...chainFor('D:\\cloud', { is_cloud_placeholder: true, volume_id: 'zzzz', file_id: '0000000000000002' }),
    ]);
    const record = await h.registry.register({
      alias: 'work',
      kind: 'directory',
      path: 'D:\\work',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    const error = await h.registry
      .relocate(record.id, 'D:\\cloud', 'local_console')
      .then(
        () => assert.fail('重定位到云占位必须被拒绝'),
        (cause: unknown) => cause,
      );
    assert.ok(rejectionReasons(error).includes('CLOUD_PLACEHOLDER'));
  });
});

// ---------------------------------------------------------------------------
// 6. 验收标准 1：单文件授权不会顺带暴露其整个父目录
// ---------------------------------------------------------------------------

describe('LWB-009 验收：单文件授权的范围', () => {
  it('文件工作区的根身份是文件自己，且记录中不含父目录路径', async () => {
    const entries = [
      facts({ path: 'D:\\work\\only.txt', is_directory: false, file_id: '00000000000000ff' }),
      facts({ path: 'D:\\work', file_id: '0000000000000001' }),
      facts({ path: 'D:\\' }),
    ];
    const h = newHarness(entries);
    const record = await h.registry.register({
      alias: 'only',
      kind: 'file',
      path: 'D:\\work\\only.txt',
      mode: WRITE_MODE,
      origin: 'local_console',
    });

    // 结构性断言：整条记录里没有任何字段指向父目录。
    // 这不是「我记得检查了」，而是「根本没有可以承载它的字段」。
    assert.equal(
      Object.values(record).some((value) => value === 'D:\\work'),
      false,
      `记录中不得有字段等于父目录路径：${JSON.stringify(record)}`,
    );
    assert.equal(record.canonical_root, 'D:\\work\\only.txt');

    const authorized = await h.registry.authorizeAccess(record.id);
    assert.equal(authorized.root_path, 'D:\\work\\only.txt');
    assert.equal(authorized.kind, 'file');
    assert.equal(authorized.file_id, '00000000000000ff');
  });

  it('登记文件**不会**顺带授权父目录：父目录是另一次独立登记', async () => {
    const entries = [
      facts({ path: 'D:\\work\\only.txt', is_directory: false, file_id: '00000000000000ff' }),
      ...chainFor('D:\\work'),
    ];
    const h = newHarness(entries);
    await h.registry.register({
      alias: 'only',
      kind: 'file',
      path: 'D:\\work\\only.txt',
      mode: WRITE_MODE,
      origin: 'local_console',
    });

    // 父目录此时仍未被授权：把它登记进来会与文件工作区**重叠**而被拒绝。
    // 换句话说，文件授权既没有涵盖父目录，也没有把父目录锁死 ——
    // 它是另一次必须显式做出的授权决定。
    const error = await h.registry
      .register({
        alias: 'parent',
        kind: 'directory',
        path: 'D:\\work',
        mode: WRITE_MODE,
        origin: 'local_console',
      })
      .then(
        () => assert.fail('父目录与在册可写文件工作区重叠，必须被拒绝'),
        (cause: unknown) => cause,
      );
    assert.ok(rejectionReasons(error).includes('WRITABLE_ROOT_OVERLAP'), rejectionReasons(error).join(','));
  });

  it('同目录下的另一个文件是独立的物理对象，与第一个文件不重叠', async () => {
    const entries = [
      facts({ path: 'D:\\work\\a.txt', is_directory: false, file_id: '00000000000000aa' }),
      facts({ path: 'D:\\work\\b.txt', is_directory: false, file_id: '00000000000000bb' }),
      facts({ path: 'D:\\work', file_id: '0000000000000001' }),
      facts({ path: 'D:\\' }),
    ];
    const h = newHarness(entries);
    const a = await h.registry.register({
      alias: 'a',
      kind: 'file',
      path: 'D:\\work\\a.txt',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    const b = await h.registry.register({
      alias: 'b',
      kind: 'file',
      path: 'D:\\work\\b.txt',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    assert.notEqual(a.root_file_id, b.root_file_id);
    assert.notEqual(a.id, b.id);
    // 两条授权互不涵盖：删除 a 不影响 b。
    h.registry.remove(a.id, 'local_console');
    const stillB = await h.registry.authorizeAccess(b.id);
    assert.equal(stillB.root_path, 'D:\\work\\b.txt');
  });
});

// ---------------------------------------------------------------------------
// 7. 验收标准 2：同名路径被替换为另一目录后原授权失效（状态层）
// ---------------------------------------------------------------------------

describe('LWB-009 验收：根被替换后原授权失效', () => {
  it('身份变化时访问被拒绝，且**不**自动重新授权', async () => {
    const h = newHarness(chainFor('D:\\work'));
    const record = await h.registry.register({
      alias: 'work',
      kind: 'directory',
      path: 'D:\\work',
      mode: WRITE_MODE,
      origin: 'local_console',
    });

    // 模拟「同名路径被替换为另一个目录」：路径字符串没变，身份变了。
    // 直接改桩返回的事实，等价于磁盘上换了一个对象。
    const mutable = h.probe as unknown as { statVolume: RootProbe['statVolume'] };
    const original = mutable.statVolume.bind(h.probe);
    mutable.statVolume = async (req: { path: string }) => {
      const result = await original(req);
      if (result.ok === true && req.path.toLowerCase() === 'd:\\work') {
        return { ...result, volume_id: 'aabbccdd', file_id: '00000000000000ff' };
      }
      return result;
    };

    const identity = await h.registry.verifyRootIdentity(record.id);
    assert.equal(identity.kind, 'identity_changed', `实际：${identity.kind}`);

    const error = await expectAsyncBridgeError(
      'WORKSPACE_GENERATION_CHANGED',
      () => h.registry.authorizeAccess(record.id),
      '根被替换后访问',
    );
    assert.equal(error.details?.['cause'], 'root_replaced');
    assert.equal(
      h.repos.workspaces.requireById(record.id).root_file_id,
      '0000000000000001',
      '拒绝访问时不得顺手把登记改成新对象（那等于自动重新授权）',
    );

    // 重新验证是**显式**的重新授权：代次递增，登记指向新对象。
    const outcome = await h.registry.reverify(record.id, 'local_console');
    assert.equal(outcome.kind, 'relocated', `实际：${outcome.kind}`);
    assert.equal(outcome.workspace.generation, 2);
    assert.equal(outcome.workspace.root_file_id, '00000000000000ff');

    // 旧代次的票据仍然不能用了。
    await expectAsyncBridgeError(
      'WORKSPACE_GENERATION_CHANGED',
      () => h.registry.authorizeAccess(record.id, { generation: 1 }),
      '重新授权前的旧代次',
    );
  });

  it('根消失时访问被拒绝，且**不**递增代次（脱机不等于换了对象）', async () => {
    const h = newHarness(chainFor('D:\\work'));
    const record = await h.registry.register({
      alias: 'work',
      kind: 'directory',
      path: 'D:\\work',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    const mutable = h.probe as unknown as { statVolume: RootProbe['statVolume'] };
    mutable.statVolume = async () => ({
      ok: false,
      code: 'NOT_FOUND',
      message: '桩：根已消失',
      win32_error: 2,
    });

    const outcome = await h.registry.reverify(record.id, 'local_console');
    assert.equal(outcome.kind, 'missing');
    assert.equal(h.repos.workspaces.requireById(record.id).generation, 1);

    const error = await expectAsyncBridgeError(
      'WORKSPACE_GENERATION_CHANGED',
      () => h.registry.authorizeAccess(record.id),
      '根消失后访问',
    );
    assert.equal(error.details?.['cause'], 'root_missing');
  });

  it('护栏不可用时访问被拒绝，且错误码是 NATIVE_GUARD_UNAVAILABLE 而不是「未授权」', async () => {
    const h = newHarness(chainFor('D:\\work'));
    const record = await h.registry.register({
      alias: 'work',
      kind: 'directory',
      path: 'D:\\work',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    const mutable = h.probe as unknown as { statVolume: RootProbe['statVolume'] };
    mutable.statVolume = async () => ({
      ok: false,
      code: 'NATIVE_GUARD_UNAVAILABLE',
      message: '桩：护栏不可用',
      win32_error: 0,
    });

    const error = await expectAsyncBridgeError(
      'NATIVE_GUARD_UNAVAILABLE',
      () => h.registry.authorizeAccess(record.id),
      '护栏不可用时访问',
    );
    assert.equal(error.details?.['code'], 'NATIVE_GUARD_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// 8. 验收标准 3：移除工作区后旧修改集、读取票据和游标不能继续使用
// ---------------------------------------------------------------------------

const HEX64 = 'a'.repeat(64);

/** 造一个绑定了指定工作区代次的在途修改集，模拟「旧修改集」。 */
function seedChangeSet(h: Harness, workspace: WorkspaceRecord, id: string): void {
  h.repos.connections.create({
    id: 'conn_1',
    principal_kind: 'model_surface',
    principal_id: 'p1',
    alias: 'adapter',
    enabled: true,
  });
  const oldBlob = h.repos.blobs.ensure({ id: `${id}_old`, sha256: 'b'.repeat(64), size: 3, storage_ref: 'b/x' });
  const newBlob = h.repos.blobs.ensure({ id: `${id}_new`, sha256: 'c'.repeat(64), size: 4, storage_ref: 'b/y' });
  h.repos.changes.create({
    id,
    owner_connection_id: 'conn_1',
    workspace_id: workspace.id,
    root_generation: workspace.generation,
    policy_version: workspace.policy_version,
    contract_version: '0.1.0',
    digest: HEX64,
    summary: '在途修改集',
    expires_at: '2099-01-01T00:00:00.000Z',
    items: [
      {
        id: `${id}_i0`,
        path: 'src/main.ts',
        op: 'edit_text',
        base_file_id: '0000000000000001',
        base_sha256: 'b'.repeat(64),
        target_sha256: 'c'.repeat(64),
        old_blob_id: oldBlob.blob.id,
        new_blob_id: newBlob.blob.id,
        encoding: 'utf-8',
        bom: false,
        newline: 'lf',
        added_lines: 1,
        removed_lines: 2,
      },
    ],
  });
}

describe('LWB-009 验收：移除后旧对象失效', () => {
  it('移除后：代次递增、旧修改集绑定被打断、访问被拒绝', async () => {
    const h = newHarness(chainFor('D:\\work'));
    const record = await h.registry.register({
      alias: 'work',
      kind: 'directory',
      path: 'D:\\work',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    seedChangeSet(h, record, 'chg_inflight');

    const before = h.repos.changes.requireById('chg_inflight');
    assert.equal(before.root_generation, 1, '修改集绑定的是签发时的代次');

    const removed = h.registry.remove(record.id, 'local_console');
    assert.notEqual(removed.removed_at, null);
    assert.equal(removed.enabled, false);
    assert.equal(removed.generation, 2, '移除必须递增代次');

    // 旧修改集：它绑定的代次与当前代次已经不同 —— 任何按代次比对的
    // 执行路径都会拒绝它，不需要额外记得去查 removed_at。
    const after = h.repos.changes.requireById('chg_inflight');
    assert.notEqual(
      after.root_generation,
      h.repos.workspaces.requireById(record.id).generation,
      '修改集的代次绑定必须被打断',
    );

    // 旧读取票据 / 游标：它们携带的是 1，而现在既被移除又是代次 2。
    await expectAsyncBridgeError(
      'WORKSPACE_NOT_GRANTED',
      () => h.registry.authorizeAccess(record.id, { generation: 1 }),
      '移除后的旧票据',
    );
    await expectAsyncBridgeError(
      'WORKSPACE_NOT_GRANTED',
      () => h.registry.authorizeAccess(record.id, { generation: 2 }),
      '移除后即使代次相同也不可用',
    );
  });

  it('重新登记同一路径得到新的工作区；旧票据不会被接续到新授权上', async () => {
    const h = newHarness(chainFor('D:\\work'));
    const first = await h.registry.register({
      alias: 'work',
      kind: 'directory',
      path: 'D:\\work',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    const oldGeneration = first.generation;
    h.registry.remove(first.id, 'local_console');

    // 部分唯一索引（WHERE removed_at IS NULL）让同一个别名与同一个根
    // 可以被重新登记 —— 否则移除一次就永久占用了这个名字。
    const second = await h.registry.register({
      alias: 'work',
      kind: 'directory',
      path: 'D:\\work',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    assert.notEqual(second.id, first.id, '重新登记必须是新的 workspace_id');
    assert.equal(second.generation, 1);

    // 旧的 workspace_id 永远不再可用，因此旧票据无法「碰巧」对上
    // 新工作区 —— 这正是票据必须绑定 workspace_id 而不只是代次的原因。
    await expectAsyncBridgeError(
      'WORKSPACE_NOT_GRANTED',
      () => h.registry.authorizeAccess(first.id, { generation: oldGeneration }),
      '旧 workspace_id 的票据',
    );
    const ok = await h.registry.authorizeAccess(second.id, { generation: second.generation });
    assert.equal(ok.workspace_id, second.id);
  });

  it('已移除的工作区不能再被暂停、恢复、重定位或重新验证', async () => {
    const h = newHarness(chainFor('D:\\work'));
    const record = await h.registry.register({
      alias: 'work',
      kind: 'directory',
      path: 'D:\\work',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    h.registry.remove(record.id, 'local_console');

    expectBridgeError('WORKSPACE_NOT_GRANTED', () => h.registry.pause(record.id, 'local_console'));
    await expectAsyncBridgeError('WORKSPACE_NOT_GRANTED', () =>
      h.registry.resume(record.id, 'local_console'),
    );
    await expectAsyncBridgeError('WORKSPACE_NOT_GRANTED', () =>
      h.registry.reverify(record.id, 'local_console'),
    );
    await expectAsyncBridgeError('WORKSPACE_NOT_GRANTED', () =>
      h.registry.relocate(record.id, 'D:\\work', 'local_console'),
    );
    expectBridgeError('CHANGE_STATE_INVALID', () => h.registry.remove(record.id, 'local_console'));
  });

  it('移除后该物理对象可以被重新登记（部分唯一索引不得把它锁死）', async () => {
    const h = newHarness([...chainFor('D:\\work'), ...chainFor('D:\\other', { volume_id: 'zz', file_id: 'ff' })]);
    const a = await h.registry.register({
      alias: 'a',
      kind: 'directory',
      path: 'D:\\work',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    h.registry.remove(a.id, 'local_console');
    // 同一物理对象、不同别名：移除后不该再被「已占用」挡住。
    const b = await h.registry.register({
      alias: 'a-again',
      kind: 'directory',
      path: 'D:\\work',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    assert.equal(b.volume_id, 'aabbccdd');
    assert.notEqual(b.id, a.id);
  });

  it('移除是软移除：历史行仍在，审计可追溯', async () => {
    const h = newHarness(chainFor('D:\\work'));
    const record = await h.registry.register({
      alias: 'work',
      kind: 'directory',
      path: 'D:\\work',
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    h.registry.remove(record.id, 'local_console');

    assert.notEqual(
      h.repos.workspaces.findById(record.id),
      null,
      '历史修改集必须继续指向一个真实存在的行',
    );
    assert.deepEqual(h.registry.list(), [], '默认列表不含已移除的工作区');
    const all = h.repos.workspaces.list({ include_removed: true, include_disabled: true });
    assert.equal(all.length, 1);

    const events = h.repos.audit.list();
    assert.ok(
      events.some((e) => e.action === 'workspace.remove'),
      `审计中应有移除事件：${JSON.stringify(events)}`,
    );
    // 审计里不得出现本机绝对路径。
    assert.equal(
      JSON.stringify(events).includes('D:\\\\work'),
      false,
      '审计事件不得包含本机绝对路径',
    );
  });
});

// ---------------------------------------------------------------------------
// 9. 控制操作
// ---------------------------------------------------------------------------

function context(audience: 'console' | 'mcp-adapter'): RequestContext {
  return { audience, connection_id: 'c1', pid: 1234, request_id: 'r1' };
}

describe('LWB-009 控制操作', () => {
  it('能力要求由服务端声明，且全部是 workspaces.manage', () => {
    const registry = new OperationRegistry();
    const h = newHarness(chainFor('D:\\work'));
    registerWorkspaceOperations(registry, h.registry);

    const names = registry.names();
    assert.ok(names.length >= 8, `实际注册了 ${names.length} 个操作`);
    for (const name of names) {
      const definition = registry.lookup(name);
      assert.ok(definition, `${name} 应可查到`);
      assert.equal(
        definition.required,
        'workspaces.manage',
        `${name} 所需能力必须是 workspaces.manage（它不授予模型）`,
      );
      assert.ok(name.startsWith('workspaces.'), `${name} 应属于 workspaces.* 命名空间`);
    }
    assert.ok(names.includes('workspaces.register'));
    assert.ok(names.includes('workspaces.remove'));
    assert.ok(names.includes('workspaces.reverify'));
  });

  it('控制台可以登记；适配器即使绕过能力检查到达 handler 也会被拒绝', async () => {
    const registry = new OperationRegistry();
    const h = newHarness(chainFor('D:\\work'));
    registerWorkspaceOperations(registry, h.registry);
    const register = registry.lookup('workspaces.register');
    assert.ok(register);

    const viaConsole = await register.handler(
      { alias: 'work', kind: 'directory', path: 'D:\\work', mode: WRITE_MODE },
      context('console'),
    );
    assert.equal((viaConsole as { alias: string }).alias, 'work');

    const error = await Promise.resolve(
      register.handler(
        { alias: 'evil', kind: 'directory', path: 'D:\\work', mode: WRITE_MODE },
        context('mcp-adapter'),
      ),
    ).then(
      () => assert.fail('适配器登记必须被拒绝'),
      (cause: unknown) => cause,
    );
    assert.ok(error instanceof RootRejectedError);
    assert.deepEqual(
      error.rejections.map((r) => r.reason),
      ['ORIGIN_NOT_LOCAL'],
    );
  });

  it('入参校验：kind/mode 只接受闭集，缺字段直接 INVALID_ARGUMENT', async () => {
    const registry = new OperationRegistry();
    const h = newHarness(chainFor('D:\\work'));
    registerWorkspaceOperations(registry, h.registry);
    const register = registry.lookup('workspaces.register');
    assert.ok(register);

    for (const body of [
      { alias: 'a', kind: 'symlink', path: 'D:\\work', mode: WRITE_MODE },
      { alias: 'a', kind: 'directory', path: 'D:\\work', mode: 'read_write' },
      { alias: '', kind: 'directory', path: 'D:\\work', mode: WRITE_MODE },
      { kind: 'directory', path: 'D:\\work', mode: WRITE_MODE },
      { alias: 'a', kind: 'directory', mode: WRITE_MODE },
      [],
    ]) {
      await expectAsyncBridgeError(
        'INVALID_ARGUMENT',
        () => Promise.resolve(register.handler(body, context('console'))),
        JSON.stringify(body),
      );
    }
  });

  it('控制台列表带上根路径（操作者需要确认登记的是哪一个目录）', async () => {
    const registry = new OperationRegistry();
    const h = newHarness(chainFor('D:\\work'));
    registerWorkspaceOperations(registry, h.registry);
    const register = registry.lookup('workspaces.register');
    const list = registry.lookup('workspaces.list');
    assert.ok(register && list);
    await register.handler(
      { alias: 'work', kind: 'directory', path: 'D:\\work', mode: WRITE_MODE },
      context('console'),
    );
    const rows = (await list.handler({}, context('console'))) as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['root'], 'D:\\work');
    assert.equal(rows[0]?.['generation'], 1);
  });
});

// ---------------------------------------------------------------------------
// 10. 真实目录：别名重复、移除后可重登记等边界（不需要护栏）
// ---------------------------------------------------------------------------

describe('LWB-009 与真实临时目录交互（不经护栏）', () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'lwb-ws-unit-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('规范化后的根不会带尾部分隔符，两个写法产生同一个键', () => {
    const a = parseAbsoluteRoot(`${dir}\\`);
    const b = parseAbsoluteRoot(dir);
    assert.equal(a.ok, false, '尾分隔符应被拒绝');
    assert.equal(b.ok, true);
    if (b.ok) assert.equal(rootKey(b.normalized), dir.toLowerCase());
  });
});
