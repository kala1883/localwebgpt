/**
 * 只读 Git 在**真实护栏 + 真实 NTFS + 真实仓库**上的集成测试（LWB-016）。
 *
 * `tests/git/git-reader.test.ts` 验的是行解码、窄范围清单、归一化这些纯逻辑
 * （用的是桩）；本文件验的是「接上真实句柄护栏与一份真的 `.git` 之后仍然成立」。
 *
 * 只在 Windows 上运行；其它平台整体跳过，而不是伪装通过。
 *
 * ## 期望值来自 manifest，不来自本文件
 *
 * 夹具仓库的四条 `git status --porcelain` 是**生成器**在造夹具时记下来的
 * （`manifest.git_status_porcelain`），硬拒绝名单取自每个文件的 `note`。
 * 自己算一份期望值等于拿实现验实现 —— 状态解码只要和 porcelain 的读法一起
 * 错，两边会同时错成同一个样子，而测试照样是绿的。
 *
 * ## 为什么本文件不自己造仓库
 *
 * `scripts/evidence/lwb-016.ts` 里的临时仓库（用 git CLI 现造 `AM`/`D ` 这类
 * porcelain 组合）已经把那几种状态采过一遍，那是**证据**。测试这一层要的是
 * 可重复、不依赖外部 `git` 可执行文件，因此状态那一块直接对着夹具的四条
 * （` D`/`A `/` M`/`??` —— 四种状态各一条）。夹具是**只读的验收对象**，
 * 本文件对它只做读取；需要造目录形态（`.git` 是个文件、没有仓库）时一律在
 * `mkdtemp` 里造，不动夹具一个字节。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { EgressBudget } from '@lwb/egress';
import { createReadTicketAuthority, readFile as readFileTool, type ReadScope } from '@lwb/files';
import { gitDiff, gitStatus } from '@lwb/git-reader';
import type { PolicyAction, PolicyDecision } from '@lwb/policy';
import { decide } from '@lwb/policy';
import type { WinfsOps } from '@lwb/winfs';
import { PowerShellWinfsBackend, isWinfsError } from '@lwb/winfs';

import { TESTREPO_DIR, loadManifest, type FixtureManifest } from '../fixtures/index.ts';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const CONNECTION = 'conn-1';
const KEY = 'lwb-test-key-0123456789abcdef0123456789abcdef';
const WS = 'ws-1';

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * porcelain 的两格 → 我们的 `{head, worktree}`。
 *
 * 第一格是**索引 vs HEAD**，第二格是**工作区 vs 索引** —— 这个次序就是
 * `git status --porcelain` 的定义，不是我们的翻译习惯。
 */
const PORCELAIN_EXPECTATION: Record<string, { head: string; worktree: string }> = {
  ' D': { head: 'unmodified', worktree: 'deleted' },
  'A ': { head: 'added', worktree: 'unmodified' },
  ' M': { head: 'unmodified', worktree: 'modified' },
  '??': { head: 'absent', worktree: 'untracked' },
};

/**
 * 按需覆盖若干方法的装饰器。
 *
 * **不能用 `{...backend, readFileGuarded}`**：类的方法是原型上的属性，
 * 展开一个类实例只会拿到它自己的实例字段，于是除被覆盖那个之外的方法
 * 全部消失。那种对象会在第一次调用时才炸，而它看起来「只改了一个方法」。
 */
function decorate(ops: WinfsOps, overrides: Partial<WinfsOps>): WinfsOps {
  return {
    capability: () => ops.capability(),
    statVolume: (req) => ops.statVolume(req),
    validatePath: (req) => ops.validatePath(req),
    resolvePath: (req) => ops.resolvePath(req),
    readFileGuarded: (req) => ops.readFileGuarded(req),
    writeFileGuarded: (req) => ops.writeFileGuarded(req),
    createFileGuarded: (req) => ops.createFileGuarded(req),
    listDirectory: (req) => ops.listDirectory(req),
    ...overrides,
  };
}

function rawDecision(action: PolicyAction, actionPath = ''): PolicyDecision {
  return decide({
    connection: {
      connection_id: CONNECTION,
      enabled: true,
      granted_capabilities: ['read', 'search', 'list', 'git_read', 'propose'],
      audience: 'mcp_adapter',
      granted_workspace_ids: [WS],
    },
    workspace: {
      workspace_id: WS,
      kind: 'directory',
      mode: 'read_propose_apply_with_local_approval',
      capabilities: {
        read_enabled: true,
        git_enabled: true,
        proposal_enabled: true,
        direct_write_enabled: false,
        recovery_required: false,
      },
      current_generation: 1,
      current_policy_version: 1,
      root_volume_id: '00000000',
      root_file_id: '0000000000000000',
      paused: false,
    },
    presented: { generation: null, policy_version: null },
    // path 留空时判的是「工作区根」这条路 —— 具体的硬拒绝会由工具内部再判一次。
    action: { action, path: actionPath, approval: null },
    now: NOW,
  });
}

/**
 * 装置前提：这条动作**应当被允许**。
 *
 * 被策略拒绝的路径（硬拒绝、秘密筛查、`.git` 内部）不适用 —— 那里
 * `allow:false` 正是要被检验的前提，顺手断言掉它会让「工具必须拒绝」这条
 * 测试因为装置自己抛错而「通过」，而它什么也没验。
 */
function allowedDecision(action: PolicyAction, actionPath = ''): PolicyDecision {
  const decision = rawDecision(action, actionPath);
  assert.equal(decision.allow, true, `装置前提：${action} ${actionPath} 应被允许`);
  return decision;
}

function budget(): EgressBudget {
  return new EgressBudget({ limit_bytes_per_hour: 64 * 1024 * 1024, now: () => NOW });
}

/** 整棵树的逐文件摘要。**包含 `.git/**`** —— 少看一个目录就等于少验一条。 */
async function treeDigest(root: string): Promise<{ digest: string; files: number }> {
  const lines: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(path.join(root, rel), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else lines.push(`${child} ${sha256(await readFile(path.join(root, child)))}`);
    }
  };
  await walk('');
  return { digest: sha256(lines.join('\n')), files: lines.length };
}

async function expectError(
  code: string,
  fn: () => Promise<unknown>,
  hint: string,
): Promise<{ details?: Record<string, unknown>; message: string }> {
  try {
    await fn();
  } catch (cause) {
    const err = cause as { code?: string; message?: string; details?: Record<string, unknown> };
    assert.equal(err.code, code, `${hint} 的错误码（消息：${err.message}）`);
    return { details: err.details, message: err.message ?? '' };
  }
  assert.fail(`${hint}：应当抛出 ${code}`);
}

describeWindows('LWB-016 只读 Git（真实护栏 / 真实 NTFS / 真实 .git）', () => {
  let backend: PowerShellWinfsBackend;
  let manifest: FixtureManifest;
  let scratch: string;

  before(async () => {
    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(capability.available, true, `护栏后端不可用：${capability.resolved_backend_reason}`);
    manifest = await loadManifest();
    scratch = await mkdtemp(path.join(os.tmpdir(), 'lwb-git-reader-'));
  });

  after(async () => {
    await backend?.dispose();
    await rm(scratch, { recursive: true, force: true });
  });

  /** 工作区根的**物理身份**由护栏自己给出 —— 测试不自算一份。 */
  async function scopeFor(root: string, kind: 'directory' | 'file' = 'directory'): Promise<ReadScope> {
    const info = await backend.statVolume({ path: root });
    if (isWinfsError(info)) throw new Error(`statVolume 失败：${info.code} ${info.message}`);
    return {
      workspace_id: WS,
      kind,
      mode: 'read_propose_apply_with_local_approval',
      generation: 1,
      root_path: root,
      root_volume_id: info.volume_id,
      root_file_id: info.file_id,
    };
  }

  function statusArgs(scope: ReadScope, input: { path?: string } = {}) {
    return {
      scope,
      connection_id: CONNECTION,
      decision: allowedDecision('git_status', input.path ?? ''),
      input: { workspace_id: WS, ...input },
    };
  }

  function diffArgs(
    scope: ReadScope,
    input: { path: string; comparison?: 'head_vs_worktree' | 'index_vs_worktree' | 'head_vs_index' },
    /** `false` 时不要求判定被允许 —— 用于「这条路径**应当**被拒绝」的场景。 */
    expectAllow = true,
  ) {
    return {
      scope,
      connection_id: CONNECTION,
      decision: expectAllow ? allowedDecision('git_diff', input.path) : rawDecision('git_diff', input.path),
      input: { workspace_id: WS, ...input },
    };
  }

  // -------------------------------------------------------------------------
  // 验收 1：查询前后不变
  // -------------------------------------------------------------------------

  it('状态查询前后，整棵树（含 `.git/**`）逐文件 sha256 完全相同', async () => {
    const beforeTree = await treeDigest(TESTREPO_DIR);

    const scope = await scopeFor(TESTREPO_DIR);
    const data = await gitStatus(statusArgs(scope), { ops: backend, budget: budget() });

    assert.ok(data.entries.length > 0, '装置前提：夹具仓库应当有结果');

    const afterTree = await treeDigest(TESTREPO_DIR);
    assert.equal(afterTree.files, beforeTree.files);
    assert.equal(afterTree.digest, beforeTree.digest, '查询不得改动工作区，也不得改动 .git');

    // 连查两次结果相同：第一次查询若留下了任何状态（缓存、索引 stat），
    // 第二次就会与第一次不同 —— 这条比上面那条更早发现「读改写」。
    const again = await gitStatus(statusArgs(scope), { ops: backend, budget: budget() });
    assert.deepEqual(again, data);
  });

  it('护栏的**写入口一次都没被调用**（拒绝不只发生在库那一层）', async () => {
    let writes = 0;
    const counted = decorate(backend, {
      // 参数类型由 `Partial<WinfsOps>` 推出：写方法的入参比读方法多带
      // 内容与摘要，手写 `WinfsPathRef` 会写错，而写错的后果是「这段其实
      // 没装饰上」—— 计数器永远是 0，测试永远是绿的。
      writeFileGuarded: (req) => {
        writes += 1;
        return backend.writeFileGuarded(req);
      },
      createFileGuarded: (req) => {
        writes += 1;
        return backend.createFileGuarded(req);
      },
    });

    const scope = await scopeFor(TESTREPO_DIR);
    const data = await gitStatus(statusArgs(scope), { ops: counted, budget: budget() });

    assert.ok(data.entries.length > 0);
    assert.equal(writes, 0, '只读查询不得向护栏请求任何写入');
  });

  // -------------------------------------------------------------------------
  // 验收 2：四种状态可区分（期望值来自 manifest）
  // -------------------------------------------------------------------------

  it('已暂存 / 未暂存 / 未跟踪 / 已删除四种状态与 manifest 记下的 porcelain 一致', async () => {
    const scope = await scopeFor(TESTREPO_DIR);
    const data = await gitStatus(statusArgs(scope), { ops: backend, budget: budget() });
    const byPath = new Map(data.entries.map((e) => [e.path, e]));

    assert.equal(manifest.git_status_porcelain.length, 4, '装置前提：夹具记了四种状态');
    for (const line of manifest.git_status_porcelain) {
      const status = line.slice(0, 2);
      const rel = line.slice(3);
      const expected = PORCELAIN_EXPECTATION[status];
      assert.ok(expected !== undefined, `装置前提：porcelain「${status}」在本文件的对照表里`);
      const actual = byPath.get(rel);
      assert.ok(actual !== undefined, `porcelain 里的 ${rel} 必须出现在结果里`);
      assert.equal(actual.head, expected.head, `${rel} 的 head（porcelain「${status}」）`);
      assert.equal(actual.worktree, expected.worktree, `${rel} 的 worktree（porcelain「${status}」）`);
    }

    assert.equal(data.head_commit, manifest.head_commit, 'HEAD 提交 ID 取自真实仓库');
    assert.equal(data.limited_to_authorized_paths, true);
  });

  // -------------------------------------------------------------------------
  // 验收 4：秘密不出现在结果里
  // -------------------------------------------------------------------------

  it('四个已提交的硬拒绝文件不出现在状态里，只体现在计数上', async () => {
    // 名单**写死这四条**，不用 `note.startsWith('硬拒绝')` 筛：`secrets/token.txt`
    // 的 note 是「硬拒绝/脱敏」，但它**不是**硬拒绝 —— 策略表里没有一条规则
    // 匹配它的路径，它是一条普通条目，内容由 `file_read` 那一层脱敏。
    // 按 note 前缀筛会把它算进来，于是这条测试会因为「它没被摘掉」而失败，
    // 而正确的修法是把它从名单里拿掉，不是去让实现摘掉它。
    const denied = ['secrets/.env', 'secrets/aws.env', 'secrets/id_rsa', 'config/.env.example'];
    for (const rel of denied) {
      assert.ok(
        manifest.files.some((f) => f.relPath === rel && f.gitState.startsWith('committed')),
        `装置前提：${rel} 在 HEAD 里有对象，这条拒绝才有意义`,
      );
    }

    const scope = await scopeFor(TESTREPO_DIR);
    const data = await gitStatus(statusArgs(scope), { ops: backend, budget: budget() });
    const paths = new Set(data.entries.map((e) => e.path));

    const leaked = denied.filter((p) => paths.has(p));
    assert.deepEqual(leaked, [], '硬拒绝的路径不得出现在 entries 里');
    // 只检查 entries 是不够的：`excluded` 也回显名字（它带 path），
    // 秘密筛查命中的路径同样只进计数。整份结果里都不该出现这些名字。
    const serialized = JSON.stringify(data);
    assert.deepEqual(denied.filter((p) => serialized.includes(p)), [], '整份结果里不得出现硬拒绝路径的名字');
    assert.equal(data.policy_hidden_count, denied.length, '它们必须被计入 policy_hidden_count');

    // 反过来的一半：只脱敏、不硬拒绝的文件**应当**还在结果里（如实报告）。
    assert.equal(
      paths.has('secrets/token.txt'),
      true,
      '策略表没拦它的路径，它就该是一条普通条目 —— 把「脱敏」与「硬拒绝」并成一件事会让这条证据看起来更严，实际是错的',
    );
  });

  it('秘密在 HEAD 里有 blob，但 diff 拒绝返回它 —— 未授权历史 blob 的入口在路径判定上就断了', async () => {
    assert.ok(
      manifest.files.some((f) => f.relPath === 'secrets/aws.env' && f.gitState.startsWith('committed')),
      '装置前提：该路径在 HEAD 里确实有对象，这条拒绝才有意义',
    );

    const scope = await scopeFor(TESTREPO_DIR);
    const error = await expectError(
      'POLICY_DENIED',
      () => gitDiff(diffArgs(scope, { path: 'secrets/aws.env' }, false), { ops: backend, budget: budget() }),
      'diff 一个硬拒绝路径',
    );
    assert.ok(!JSON.stringify(error).includes('aws.env'), '拒绝里不带路径名');
    assert.ok(!error.message.includes('AKIA'), '拒绝里不带内容');
  });

  it('未改动的秘密文件：零 hunk，且结果里不含凭证', async () => {
    const scope = await scopeFor(TESTREPO_DIR);
    const data = await gitDiff(diffArgs(scope, { path: 'secrets/token.txt' }), { ops: backend, budget: budget() });

    // 没有改动就没有内容可发，也就没有东西可脱敏 —— 这正是「没改过的秘密
    // 不泄漏」的原理：出口不在「过滤」，在「两侧内容相同就一个字节都不发」。
    assert.equal(data.hunks.length, 0);
    assert.ok(!JSON.stringify(data).includes('ghp_'), '不得出现凭证形状的内容');
    assert.equal(data.redacted, false, '如实说：这一份确实没有脱敏动作');
  });

  // -------------------------------------------------------------------------
  // 真实的差异
  // -------------------------------------------------------------------------

  it('改动过的文件给出真实 hunk，旧侧是 HEAD、给固定提交 ID', async () => {
    const beforeTree = await treeDigest(TESTREPO_DIR);

    const scope = await scopeFor(TESTREPO_DIR);
    const data = await gitDiff(diffArgs(scope, { path: '文档/设计说明.md' }), { ops: backend, budget: budget() });

    assert.ok(data.hunks.length > 0, '夹具里这个文件有未提交修改');
    assert.equal(data.base_commit, manifest.head_commit);
    assert.equal(data.compare_commit, null, '新侧不是提交');
    assert.ok(data.old_sha256 !== null && data.new_sha256 !== null);
    assert.notEqual(data.old_sha256, data.new_sha256);
    for (const hunk of data.hunks) {
      assert.ok(hunk.lines.some((l) => l.startsWith('+') || l.startsWith('-')), 'hunk 里得有改动行');
    }

    const afterTree = await treeDigest(TESTREPO_DIR);
    assert.equal(afterTree.digest, beforeTree.digest, 'diff 也不得改动任何字节');
  });

  // -------------------------------------------------------------------------
  // 降级：读不懂的布局只失去 Git 能力
  // -------------------------------------------------------------------------

  it('`.git` 是个文件（外置 gitdir）时降级，而同一工作区的 file_read 仍然可用', async () => {
    const root = path.join(scratch, 'linked');
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, '.git'), 'gitdir: ../elsewhere\n', 'utf8');
    await writeFile(path.join(root, 'note.txt'), '普通文件\n', 'utf8');

    const scope = await scopeFor(root);
    const status = await expectError(
      'GIT_LAYOUT_UNSUPPORTED',
      () => gitStatus(statusArgs(scope), { ops: backend, budget: budget() }),
      '状态',
    );
    assert.equal(status.details?.['reason'], 'GITDIR_FILE');
    const diff = await expectError(
      'GIT_LAYOUT_UNSUPPORTED',
      () => gitDiff(diffArgs(scope, { path: 'note.txt' }), { ops: backend, budget: budget() }),
      '差异',
    );
    assert.equal(diff.details?.['reason'], 'GITDIR_FILE');

    const read = await readFileTool(
      {
        scope,
        connection_id: CONNECTION,
        decision: allowedDecision('read', 'note.txt'),
        input: { workspace_id: WS, path: 'note.txt' },
        now: NOW,
      },
      { ops: backend, authority: createReadTicketAuthority({ key: KEY }), budget: budget() },
    );
    assert.equal(read.content, '普通文件\n', '降级只降 Git 能力');
  });

  it('不是仓库的目录给 NOT_FOUND/NO_GIT_DIR（不是「参数错」）', async () => {
    const root = path.join(scratch, 'plain');
    await mkdir(root, { recursive: true });

    const scope = await scopeFor(root);
    const error = await expectError(
      'NOT_FOUND',
      () => gitStatus(statusArgs(scope), { ops: backend, budget: budget() }),
      '不是仓库的目录',
    );
    assert.equal(error.details?.['reason'], 'NO_GIT_DIR');
  });

  it('单文件工作区没有仓库；错误说明普通读取不受影响', async () => {
    const file = path.join(scratch, 'single.txt');
    await writeFile(file, 'single\n', 'utf8');

    const scope = await scopeFor(file, 'file');
    const error = await expectError(
      'NOT_FOUND',
      () => gitStatus(statusArgs(scope), { ops: backend, budget: budget() }),
      '单文件工作区',
    );
    assert.equal(error.details?.['reason'], 'FILE_WORKSPACE');
  });

  it('`.git` 内部路径是**入参错误**：本工具不接受，内部解析由窄范围清单自己读', async () => {
    const scope = await scopeFor(TESTREPO_DIR);
    for (const p of ['.git/HEAD', '.git/config', 'sub/.git']) {
      // 判定用**原始**结果：`.git/config` 同时也是 `HD-GIT-CONFIG` 的硬拒绝
      // 路径，此时 `allow` 本来就是 false。而入参检查排在出站闸门之前，
      // 因此答案不取决于判定是允许还是拒绝 —— 这正是要验的那一点：
      // 这个拒绝来自**工具不接受这种入参**，不是来自策略恰好也拦了它。
      const status = await expectError(
        'INVALID_ARGUMENT',
        () =>
          gitStatus(
            { scope, connection_id: CONNECTION, decision: rawDecision('git_status', p), input: { workspace_id: WS, path: p } },
            { ops: backend, budget: budget() },
          ),
        `git_status ${p}`,
      );
      assert.equal(status.details?.['reason'], 'GIT_INTERNAL_PATH');
    }
  });
});
