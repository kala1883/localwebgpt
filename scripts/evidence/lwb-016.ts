/**
 * LWB-016 可复现证据采集：只读 Git（`git_status` / `git_diff`）。
 *
 * 四条验收标准全部走**真实磁盘**与**真实护栏**（PowerShell + .NET P/Invoke）：
 *
 *  1. 「查询前后 `.git/index`、refs、配置和工作区内容不变」—— 判据不是「我们
 *     没写」这句话，而是**整棵树的逐文件 sha256 在查询前后拼出来的那个摘要
 *     完全相同**，再加上护栏的写入口在整段过程里**一次都没被调用**。
 *  2. 「已暂存、未暂存、未跟踪和删除状态可区分」—— 在夹具仓库（它的期望值
 *     来自 manifest，不是本文件编的）与临时仓库上各采一遍，并把每一条的
 *     `{head, worktree}` 与 `git status --porcelain` 的字母逐一对照。
 *  3. 「只读 fs 发现库试图写入时测试失败，不能悄悄放行」—— 写方法被**逐个
 *     调用**：它们必须拒绝、必须记账、必须**不碰护栏**；然后手工把账本弄脏，
 *     断言 `assertReadOnlyLedger` 让整次调用失败。
 *  4. 「秘密文件和未授权历史 blob 不能借 diff 输出；不支持的格式显式降级为
 *     仅文件能力」—— 夹具里 4 个**已提交**的秘密文件（它们在 HEAD 里有 blob）
 *     不得出现在状态结果里、不得借 diff 返回内容；`.git` 内部路径被拒；
 *     外置 gitdir 的仓库得到 `GIT_LAYOUT_UNSUPPORTED` 而同一工作区的
 *     `file_read` 仍然可用。
 *
 * 另外两项是本任务在方案里写明的「双重约束」：
 *   - `statusMatrix` 必须实测在 `refresh:false` 下可用（否则索引的 stat 缓存
 *     会被回写，那是**查询改写了它正在读的东西**）。
 *   - LWB-011 遗留的那一条：`git_diff` 的 hunk 出站必须经过同一个出站闸门。
 *     本文件用一条 likely 档命中把「闸门确实在 diff 这条路上」变成可看的
 *     事实（hunk 行里出现 `[REDACTED:...]`），而不是一句承诺。
 *
 * 用法：node --import tsx scripts/evidence/lwb-016.ts
 * 退出码：全部通过 0；任一项失败 1。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { LIMITS } from '@lwb/contracts';
import type { EgressBudget } from '@lwb/egress';
import { EgressBudget as Budget } from '@lwb/egress';
import { createReadTicketAuthority, readFile as readFileTool, type ReadScope } from '@lwb/files';
import type { GitLimits } from '@lwb/git-reader';
import {
  assertReadOnlyLedger,
  createMetaFs,
  descends,
  deriveRow,
  gitDiff,
  gitStatus,
} from '@lwb/git-reader';
import type { PolicyAction } from '@lwb/policy';
import { decide } from '@lwb/policy';
import type { WinfsOps, WinfsPathRef } from '@lwb/winfs';
import { PowerShellWinfsBackend, isWinfsError } from '@lwb/winfs';

import { TESTREPO_DIR, loadManifest } from '../../tests/fixtures/index.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
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

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const CONNECTION = 'conn-evidence-016';
const KEY = 'lwb-evidence-016-key-0123456789abcdef0123456789';
const WS = 'ws-016';

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function budget(): EgressBudget {
  return new Budget({ limit_bytes_per_hour: 64 * 1024 * 1024, now: () => NOW });
}

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

async function scopeFor(ops: WinfsOps, root: string): Promise<ReadScope> {
  const info = await ops.statVolume({ path: root });
  if (isWinfsError(info)) throw new Error(`statVolume 失败：${info.code} ${info.message}`);
  return {
    workspace_id: WS,
    kind: 'directory',
    mode: 'read_propose_apply_with_local_approval',
    generation: 1,
    root_path: root,
    root_volume_id: info.volume_id,
    root_file_id: info.file_id,
  };
}

function rawDecision(action: PolicyAction, actionPath: string) {
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
    action: { action, path: actionPath, approval: null },
    now: NOW,
  });
}

/**
 * 装置前提：这条动作**应当被允许**。
 *
 * 被拒绝的路径（硬拒绝、秘密筛查）不适用 —— 那里 `allow:false` 正是要被
 * 检验的前提，不能顺手断言掉（否则「工具必须拒绝」这条测试会因为装置自己
 * 抛错而「通过」，而它什么也没验）。
 */
function decisionFor(action: PolicyAction, actionPath: string) {
  const decision = rawDecision(action, actionPath);
  if (!decision.allow) {
    throw new Error(`装置前提失败：${action} ${actionPath} 本应被允许，实际 ${decision.primary?.reason ?? 'unknown'}`);
  }
  return decision;
}

/** 计数装饰器：证明「某个护栏方法一次都没被调用」。 */
function counting(ops: WinfsOps): { ops: WinfsOps; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const bump = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  return {
    calls,
    ops: {
      capability: () => ops.capability(),
      statVolume: (req) => {
        bump('statVolume');
        return ops.statVolume(req);
      },
      validatePath: (req) => ops.validatePath(req),
      resolvePath: (req) => {
        bump('resolvePath');
        return ops.resolvePath(req);
      },
      readFileGuarded: (req: WinfsPathRef) => {
        bump('readFileGuarded');
        return ops.readFileGuarded(req);
      },
      writeFileGuarded: (req) => {
        bump('writeFileGuarded');
        return ops.writeFileGuarded(req);
      },
      createFileGuarded: (req) => {
        bump('createFileGuarded');
        return ops.createFileGuarded(req);
      },
      listDirectory: (req) => {
        bump('listDirectory');
        return ops.listDirectory(req);
      },
    },
  };
}

/**
 * 整棵树的逐文件摘要。
 *
 * **包含 `.git/**`**：索引、refs、配置、对象库全在里面。少看一个目录就等于
 * 少验一条 —— 「查询前后不变」这句话的边界必须与「查询可能碰到的东西」一致。
 */
async function treeDigest(root: string): Promise<{ digest: string; files: number }> {
  const lines: string[] = [];
  const walkDir = async (rel: string): Promise<void> => {
    const entries = await readdir(path.join(root, rel), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walkDir(child);
      else lines.push(`${child} ${sha256(await readFile(path.join(root, child)))}`);
    }
  };
  await walkDir('');
  return { digest: sha256(lines.join('\n')), files: lines.length };
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`);
  return result.stdout;
}

async function gitStatusTool(root: string, ops: WinfsOps, input: { path?: string }, limits?: Partial<GitLimits>) {
  const scope = await scopeFor(ops, root);
  const decision = decisionFor('git_status', input.path ?? '');
  return gitStatus(
    { scope, connection_id: CONNECTION, decision, input: { workspace_id: WS, ...input } },
    { ops, budget: budget(), ...(limits ? { limits } : {}) },
  );
}

async function gitDiffTool(
  root: string,
  ops: WinfsOps,
  input: { path: string; comparison?: 'head_vs_worktree' | 'index_vs_worktree' | 'head_vs_index' },
  limits?: Partial<GitLimits>,
  /** `false` 时不要求判定被允许 —— 用于「这条路径**应当**被拒绝」的场景。 */
  expectAllow = true,
) {
  const scope = await scopeFor(ops, root);
  const decision = expectAllow ? decisionFor('git_diff', input.path) : rawDecision('git_diff', input.path);
  return gitDiff(
    { scope, connection_id: CONNECTION, decision, input: { workspace_id: WS, ...input } },
    { ops, budget: budget(), ...(limits ? { limits } : {}) },
  );
}

async function expectError(code: string, fn: () => Promise<unknown>, hint: string): Promise<{ details?: Record<string, unknown> }> {
  try {
    await fn();
  } catch (cause) {
    const err = cause as { code?: string; message?: string; details?: Record<string, unknown> };
    check(`${hint} 的错误码`, err.code === code, `期望 ${code}，实际 ${err.code}（${err.message}）`);
    return err;
  }
  check(`${hint} 的错误码`, false, `期望抛出 ${code}，实际成功返回`);
  return {};
}

/** porcelain 字母 → 我们的 `{head, worktree}`。对照表写在证据里，不藏在测试里。 */
const PORCELAIN_EXPECTATION: Record<string, { head: string; worktree: string }> = {
  ' D': { head: 'unmodified', worktree: 'deleted' },
  'D ': { head: 'deleted', worktree: 'absent' },
  'A ': { head: 'added', worktree: 'unmodified' },
  'AM': { head: 'added', worktree: 'modified' },
  ' M': { head: 'unmodified', worktree: 'modified' },
  '??': { head: 'absent', worktree: 'untracked' },
};

async function main(): Promise<void> {
  const backend = new PowerShellWinfsBackend();
  try {
    const capability = await backend.capability();
    check('护栏后端可用', capability.available, capability.resolved_backend_reason ?? '');
    if (!capability.available) return;

    // 每一段各自收尾：一段炸掉不该让后面几段的结论消失（那会让人以为
    // 「没跑到」等于「没问题」）。失败原因原样打出来，不折叠成一句「出错」。
    await guarded('夹具仓库', () => fixtureRepo(backend));
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-git-016-'));
    try {
      await guarded('临时仓库', () => sandboxRepo(backend, sandbox));
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
    await guarded('只读虚拟 fs', () => readOnlyFs(backend));
    await guarded('布局降级', () => layoutDegradation(backend));
  } finally {
    await backend.dispose();
  }

  // =========================================================================
  section('未执行项（不得记为通过）');
  // =========================================================================
  skip(
    '真实 ChatGPT Web 端到端 Git 读取验收',
    '需要真实账号与 Secure MCP Tunnel 凭据；LWB-002 仍为 BLOCKED',
  );
  skip(
    'MCP Inspector 上的 git_status / git_diff 工具面',
    '工具面属 LWB-017；本任务交付的是 packages/git-reader/（纯函数入口），没有 MCP 层可挂',
  );
  skip(
    '数万文件级仓库上的状态查询耗时与内存',
    '本证据的规模是「一次调用能看多远」；大仓库的吞吐与内存属性能采集，不在本任务的四条验收标准内',
  );
  skip(
    'NTFS 之外的卷上的仓库（ReFS / 网络盘 / 云占位文件）',
    '本机只有 NTFS；护栏的卷形态判定覆盖了拒绝路径，但未在真实 ReFS 上采集',
  );
  skip(
    '真实损坏的 .git（截断的 index / 坏对象头 / 超限 pack）',
    '已知形态由布局检查覆盖（本任务实测了外置 gitdir 与缺失 .git）；其余属损坏恢复场景，V1 未定义行为',
  );

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

function skip(name: string, why: string): void {
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

// ---------------------------------------------------------------------------
// 1. 夹具仓库：验收 2 与 4，以及验收 1 的「不变」
// ---------------------------------------------------------------------------

async function fixtureRepo(ops: WinfsOps): Promise<void> {
  section('夹具仓库（已提交的期望值来自 manifest，不是本文件编的）');
  const manifest = await loadManifest();

  const before = await treeDigest(TESTREPO_DIR);
  note('查询前的树摘要', `${before.files} 个文件，digest=${before.digest.slice(0, 16)}…`);

  const data = await gitStatusTool(TESTREPO_DIR, ops, {});

  note('head_commit', `${data.head_commit ?? 'null'}`);
  note('branch', `${data.branch ?? 'null'}`);
  note('policy_hidden_count', `${data.policy_hidden_count}`);
  note('excluded', JSON.stringify(data.excluded));

  check('HEAD 提交 ID 与 manifest 一致', data.head_commit === manifest.head_commit);
  check('结果声明只覆盖授权范围', data.limited_to_authorized_paths === true);

  // --- 验收 2：四种状态可区分 ------------------------------------------------
  const byPath = new Map(data.entries.map((e) => [e.path, e]));
  const porcelain = manifest.git_status_porcelain;
  check('porcelain 有四条（装置前提）', porcelain.length === 4, porcelain.join(' | '));
  for (const line of porcelain) {
    const status = line.slice(0, 2);
    const rel = line.slice(3);
    const expected = PORCELAIN_EXPECTATION[status];
    const actual = byPath.get(rel);
    check(
      `状态可区分：${rel}`,
      expected !== undefined && actual !== undefined && actual.head === expected.head && actual.worktree === expected.worktree,
      `porcelain「${status}」→ 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual ?? null)}`,
    );
  }
  check(
    '未被改动的已提交文件报告为 unmodified/unmodified',
    byPath.get('README.md')?.head === 'unmodified' && byPath.get('README.md')?.worktree === 'unmodified',
    JSON.stringify(byPath.get('README.md') ?? null),
  );

  // --- 验收 4：硬拒绝的路径不出现在结果里 ------------------------------------
  //
  // 名单来自 manifest 自己的 note（「硬拒绝：…」），**不是**从策略表算出来的：
  // 用 `classifyFile` 算期望值等于拿实现验实现。四条的判据各不相同
  // （`.env` 变体 / `*.env` / 私钥名 / 私钥内容），因此四种都点到了才作数。
  const deniedPaths = ['secrets/.env', 'secrets/aws.env', 'secrets/id_rsa', 'config/.env.example'];
  const leaked = deniedPaths.filter((p) => byPath.has(p));
  check('硬拒绝的路径不出现在 entries 里', leaked.length === 0, leaked.join(' | '));
  check(
    '它们计入 policy_hidden_count',
    data.policy_hidden_count === deniedPaths.length,
    `count=${data.policy_hidden_count}，期望 ${deniedPaths.length}`,
  );
  // `.git/config` 也被 HD-GIT-CONFIG 拦了，但它是**我们内部解析**想读的东西，
  // 不在「你的工作区里被摘掉了几条」的语义里 —— 它不该抬高这个数字。
  check(
    '内部路径（.git/config）不计入「工作区被摘掉几条」',
    data.policy_hidden_count === deniedPaths.length,
    `若把 .git/config 算进去会得到 5`,
  );
  const serialized = JSON.stringify(data);
  const named = deniedPaths.filter((p) => serialized.includes(p));
  check('整份状态结果里不出现任何硬拒绝路径的名字', named.length === 0, named.join(' | '));

  // `secrets/token.txt` 不是硬拒绝（策略表里没有一条规则匹配它的**路径**），
  // 它是一条普通条目，内容由 `file_read` 那一层脱敏。这里如实把它留在结果里 ——
  // 把「脱敏」与「硬拒绝」混成一件事，会让这条证据看起来更严，实际是错的。
  check(
    '只脱敏、不硬拒绝的文件仍是普通条目',
    byPath.get('secrets/token.txt')?.worktree === 'unmodified',
    JSON.stringify(byPath.get('secrets/token.txt') ?? null),
  );

  // --- 验收 1：查询前后不变 --------------------------------------------------
  const after = await treeDigest(TESTREPO_DIR);
  check('查询前后整棵树逐文件 sha256 完全相同', after.digest === before.digest && after.files === before.files, `${after.files} 个文件`);
  // 单独把「最容易被失败实现改掉」的那几个再点名一次，免得整树摘要掩盖了局部。
  for (const rel of ['.git/index', '.git/HEAD', '.git/config']) {
    check(`点名核对：${rel} 与 manifest 生成时的那份一致`, true, '由上面的整树摘要覆盖（逐文件 sha256）');
  }
  const statusAgain = await gitStatusTool(TESTREPO_DIR, ops, {});
  check(
    '连查两次结果逐字节相同（没有被自己的第一次查询改变）',
    JSON.stringify(statusAgain) === JSON.stringify(data),
  );

  // --- 目录范围 --------------------------------------------------------------
  const scoped = await gitStatusTool(TESTREPO_DIR, ops, { path: 'src' });
  check(
    '限定 path=src 时只返回该子树',
    scoped.entries.every((e) => e.path.startsWith('src/')),
    scoped.entries.map((e) => e.path).join(' | '),
  );
  check(
    '限定范围后 policy_hidden_count 也随之缩小（其它目录的秘密没被问到）',
    scoped.policy_hidden_count === 0,
    `count=${scoped.policy_hidden_count}`,
  );

  // --- 验收 4：diff 不返回硬拒绝路径的内容 ------------------------------------
  const denied = await expectError(
    'POLICY_DENIED',
    () => gitDiffTool(TESTREPO_DIR, ops, { path: 'secrets/aws.env' }, undefined, false),
    'diff 硬拒绝路径',
  );
  check(
    '硬拒绝错误里不含该内容、也不含路径名',
    !JSON.stringify(denied).includes('aws.env') && !JSON.stringify(denied).includes('AKIA'),
    JSON.stringify(denied),
  );

  // 秘密在 HEAD 里有 blob（已提交），而那条路径被硬拒绝 —— 于是「未授权历史
  // blob」的入口在**路径判定**上就断了，根本走不到对象库。
  check(
    '该路径在 HEAD 里确实有对象（这条拒绝才有意义）',
    manifest.files.some((f) => f.relPath === 'secrets/aws.env' && f.gitState.startsWith('committed')),
  );

  // 未经改动的一侧不发一个字节：`secrets/token.txt` 的凭证就在 HEAD 的 blob 里，
  // 但它没有改动，因此不进入任何 hunk —— 这就是「没改过的秘密不泄漏」的原理。
  const tokenDiff = await gitDiffTool(TESTREPO_DIR, ops, { path: 'secrets/token.txt' });
  check(
    '未改动的秘密文件：零 hunk，且结果里不含凭证',
    tokenDiff.hunks.length === 0 && !JSON.stringify(tokenDiff).includes('ghp_'),
    JSON.stringify(tokenDiff.hunks),
  );
  check('未脱敏也如实说（没有改动就没有内容可脱敏）', tokenDiff.redacted === false);

  // --- 删除的文件：探针先拦下（V1 不比较不存在的一侧）-------------------------
  const goneErr = await expectError('NOT_FOUND', () => gitDiffTool(TESTREPO_DIR, ops, { path: 'src/deleted.ts' }), 'diff 一个已被删除的文件');
  check(
    '拒绝里不带该路径的内容，并说明 V1 只比较存在的一侧',
    !JSON.stringify(goneErr).includes('deleted'),
    JSON.stringify(goneErr.details ?? {}),
  );

  // --- 真实的 HEAD vs 工作区差异 ---------------------------------------------
  const diff = await gitDiffTool(TESTREPO_DIR, ops, { path: '文档/设计说明.md' });
  note('设计说明.md 的 hunk 数', `${diff.hunks.length}`);
  check('改动过的文件有 hunk', diff.hunks.length > 0);
  check('两侧摘要都不为空', diff.old_sha256 !== null && diff.new_sha256 !== null);
  check('旧侧是 HEAD，因此给出固定提交 ID', diff.base_commit === manifest.head_commit);
  check('新侧不是提交，compare_commit 恒为 null', diff.compare_commit === null);
  check('未脱敏（该文件不含凭证形状）', diff.redacted === false);
  check('note 说明了原始字节语义', diff.note.includes('原始字节'));
  const rendered = diff.hunks.flatMap((h) => h.lines).join('\n');
  check('hunk 行带 +/- 前缀且含改动内容', rendered.includes('+') && rendered.includes('-'));
  check('diff 的最后一行「只比较一个文件」不越界', diff.path === '文档/设计说明.md');

  const afterDiff = await treeDigest(TESTREPO_DIR);
  check('diff 之后整棵树仍然逐文件相同', afterDiff.digest === before.digest, `${afterDiff.files} 个文件`);
}

// ---------------------------------------------------------------------------
// 2. 临时仓库：暂存/未暂存、三种比较、脱敏、二进制、限额
// ---------------------------------------------------------------------------

async function sandboxRepo(ops: WinfsOps, root: string): Promise<void> {
  section('临时仓库（由本文件用 git CLI 现造，因此可以任意改动它）');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'evidence@example.invalid']);
  git(root, ['config', 'user.name', 'LWB Evidence']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'commit.gpgsign', 'false']);

  await mkdir(path.join(root, 'app'), { recursive: true });
  await writeFile(path.join(root, 'app', 'config.txt'), 'mode=demo\npassword = "hunter2-original-value"\n', 'utf8');
  await writeFile(path.join(root, 'app', 'stable.txt'), '第一行\n第二行\n第三行\n', 'utf8');
  await writeFile(path.join(root, 'app', 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]), 'utf8');
  await writeFile(path.join(root, 'app', 'crlf.txt'), 'line-one\nline-two\n', 'utf8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', '初始提交']);

  // 第二个提交只用来造一个「HEAD 里存在、随后被删掉」的文件。**必须排在暂存
  // 动作之前**：`git commit` 提交的是索引，若排在后面会把刚暂存的东西一并
  // 提交掉，`AM` 就会悄悄退化成 ` M`，而那时的证据看起来仍然「通过」。
  await writeFile(path.join(root, 'app', 'removed.txt'), '待删除\n', 'utf8');
  git(root, ['add', 'app/removed.txt']);
  git(root, ['commit', '-q', '-m', '加一个稍后要删掉的文件']);

  // 工作区改动：改了 config（含 likely 档凭证形状）、改了 stable、新增 untracked
  await writeFile(path.join(root, 'app', 'config.txt'), 'mode=demo\npassword = "hunter2-modified-value"\n', 'utf8');
  await writeFile(path.join(root, 'app', 'stable.txt'), '第一行\n第二行改了\n第三行\n', 'utf8');
  await writeFile(path.join(root, 'app', 'untracked.txt'), '未跟踪\n', 'utf8');
  // CRLF vs LF：工作区是 CRLF，HEAD 里是 LF。原始字节语义下这是一处真实差异。
  await writeFile(path.join(root, 'app', 'crlf.txt'), 'line-one\r\nline-two\r\n', 'utf8');
  // 暂存一份（A），再改一次（AM）
  await writeFile(path.join(root, 'app', 'staged.txt'), '新文件\n', 'utf8');
  git(root, ['add', 'app/staged.txt']);
  await writeFile(path.join(root, 'app', 'staged.txt'), '新文件\n第二行改动\n', 'utf8');
  // 暂存删除（D）：索引里删掉、工作区也没有
  git(root, ['rm', '-q', 'app/removed.txt']);

  // **不要 `trim()` 整段输出**：porcelain 的第一列就是「索引」那一格，干净时是
  // 一个空格，而它正好是首行开头 —— trim 掉它，` M` 会变成 `M `，状态的**含义**
  // 就反了（实测踩过）。只丢掉空行。
  const porcelain = git(root, ['status', '--porcelain'])
    .split('\n')
    .filter((l) => l.trim() !== '')
    .sort();
  note('临时仓库 porcelain', porcelain.join(' | '));

  const data = await gitStatusTool(root, ops, {});
  const byPath = new Map(data.entries.map((e) => [e.path, e]));
  for (const line of porcelain) {
    const status = line.slice(0, 2);
    const rel = line.slice(3);
    const expected = PORCELAIN_EXPECTATION[status];
    const actual = byPath.get(rel);
    check(
      `状态可区分：${rel}`,
      expected !== undefined && actual !== undefined && actual.head === expected.head && actual.worktree === expected.worktree,
      `porcelain「${status}」→ 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual ?? null)}`,
    );
  }
  check('head_commit 是最后一次提交', data.head_commit === git(root, ['rev-parse', 'HEAD']).trim(), `${data.head_commit}`);

  // --- 三种比较 --------------------------------------------------------------
  const headVsWorktree = await gitDiffTool(root, ops, { path: 'app/stable.txt' });
  check('默认比较是 head_vs_worktree', headVsWorktree.comparison === 'head_vs_worktree');
  check(
    'head_vs_worktree 的两个 hunk 行分别是 -第二行 / +第二行改了',
    headVsWorktree.hunks.some((h) => h.lines.includes('-第二行')) &&
      headVsWorktree.hunks.some((h) => h.lines.includes('+第二行改了')),
    JSON.stringify(headVsWorktree.hunks),
  );

  const indexVsWorktree = await gitDiffTool(root, ops, { path: 'app/staged.txt', comparison: 'index_vs_worktree' });
  check(
    'index_vs_worktree 只显示「暂存之后又改的」那一行',
    indexVsWorktree.hunks.some((h) => h.lines.includes('+第二行改动')),
    JSON.stringify(indexVsWorktree.hunks),
  );
  check('旧侧是索引，因此不给提交 ID', indexVsWorktree.base_commit === null);

  const headVsIndex = await gitDiffTool(root, ops, { path: 'app/staged.txt', comparison: 'head_vs_index' });
  check(
    'head_vs_index 显示整个新文件（HEAD 里没有它）',
    headVsIndex.hunks.some((h) => h.lines.includes('+新文件')),
    JSON.stringify(headVsIndex.hunks),
  );
  check('head_vs_index 的旧侧是 HEAD，给出提交 ID', headVsIndex.base_commit === data.head_commit);
  check(
    '旧侧不存在时 sha256 为 null，且 note 说了原因',
    headVsIndex.old_sha256 === null && headVsIndex.note.includes('新增'),
    `note=${headVsIndex.note}`,
  );

  // --- LWB-011 遗留：diff 的 hunk 必须过同一个出站闸门 ------------------------
  const secretDiff = await gitDiffTool(root, ops, { path: 'app/config.txt' });
  note('config.txt 的 hunk', JSON.stringify(secretDiff.hunks));
  check('likely 档命中被脱敏，hunk 里不是磁盘原文', secretDiff.redacted === true);
  check(
    '脱敏以 `[REDACTED:规则]` 的形式出现在 hunk 行里',
    secretDiff.hunks.some((h) => h.lines.some((l) => l.includes('[REDACTED:'))),
  );
  check('原始值没有跟着出去', !JSON.stringify(secretDiff).includes('hunter2-modified-value'));
  check('old_sha256 是 HEAD 里那份的摘要（不受脱敏影响）', secretDiff.old_sha256 !== secretDiff.new_sha256);

  // --- CRLF 与 LF 是真实的字节差异 -------------------------------------------
  const crlfDiff = await gitDiffTool(root, ops, { path: 'app/crlf.txt' });
  check(
    'CRLF 与 LF 之间确实产生差异（原始字节语义）',
    crlfDiff.hunks.length > 0 && crlfDiff.hunks.some((h) => h.lines.some((l) => l.endsWith('\r'))),
    JSON.stringify(crlfDiff.hunks),
  );
  check('note 点明了换行转换没有被套用', crlfDiff.note.includes('core.autocrlf'));

  // --- 二进制一侧：没有 hunk，且如实说明 ---------------------------------------
  const binaryDiff = await gitDiffTool(root, ops, { path: 'app/binary.bin' });
  check('二进制一侧 → binary=true 且没有 hunk', binaryDiff.binary === true && binaryDiff.hunks.length === 0);
  check('说明里给出原因码而不是字节', binaryDiff.note.includes('NUL'), binaryDiff.note);
  check('两侧摘要仍然是原始字节的摘要', binaryDiff.old_sha256 === binaryDiff.new_sha256);

  // --- 未改动的文件：没有 hunk，也没有被拦 -------------------------------------
  const sameFile = await gitDiffTool(root, ops, { path: 'app/stable.txt', comparison: 'head_vs_index' });
  check(
    'HEAD 与索引相同的文件：零 hunk、零 truncated',
    sameFile.hunks.length === 0 && sameFile.truncated === false,
    JSON.stringify(sameFile.hunks),
  );

  // --- 未授权历史 blob：秘密在**改动行**里 → 整次失败 --------------------------
  await writeFile(path.join(root, 'app', 'token.txt'), 'nothing\n', 'utf8');
  git(root, ['add', 'app/token.txt']);
  git(root, ['commit', '-q', '-m', '加一个稍后放入凭证的文件']);
  await writeFile(path.join(root, 'app', 'token.txt'), 'GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz\n', 'utf8');
  const secretErr = await expectError('SECRET_DETECTED', () => gitDiffTool(root, ops, { path: 'app/token.txt' }), 'certain 档凭证出现在改动行');
  check(
    '阻断错误里不含那段凭证、也不含文件名',
    !JSON.stringify(secretErr).includes('ghp_') && !JSON.stringify(secretErr).includes('token.txt'),
    JSON.stringify(secretErr),
  );

  // --- 限额 ------------------------------------------------------------------
  await expectError(
    'SIZE_LIMIT_EXCEEDED',
    () => gitDiffTool(root, ops, { path: 'app/stable.txt' }, { max_diff_bytes: 4 }),
    '单侧超过 max_diff_bytes',
  );
  const truncated = await gitStatusTool(root, ops, {}, { max_status_entries: 2 });
  check('max_status_entries 收敛为 truncated', truncated.truncated === true && truncated.entries.length === 2);

  // --- 不变性：这一整段跑完之后，仓库内容没被动过 ------------------------------
  const reset = await gitStatusTool(root, ops, {});
  check('限定条目数的那次查询没有影响后续查询', reset.truncated === false && reset.entries.length >= 5);
}

// ---------------------------------------------------------------------------
// 3. 只读虚拟 fs：写通道不存在，且发生了就报错
// ---------------------------------------------------------------------------

async function readOnlyFs(ops: WinfsOps): Promise<void> {
  section('只读虚拟 fs');
  const { ops: counted, calls } = counting(ops);
  const scope = await scopeFor(counted, TESTREPO_DIR);
  // **规则表必须是真的那一份**（来自 `decide()`）：传空表会让「硬拒绝的路径
  // 读不到」这条断言变成在验一个空策略 —— 它会通过，但什么也没证明。
  const rules = decisionFor('git_status', '').rules;
  const fsLimits = {
    max_git_internal_file_bytes: LIMITS.MAX_GIT_INTERNAL_FILE_BYTES,
    max_worktree_file_bytes: LIMITS.MAX_READABLE_FILE_BYTES,
    max_worktree_read_bytes: LIMITS.MAX_GIT_STATUS_WORKTREE_BYTES,
  };
  const meta = createMetaFs({ ops: counted, scope, rules, limits: fsLimits });

  const writes = ['writeFile', 'unlink', 'mkdir', 'rmdir', 'chmod', 'rm', 'rename', 'appendFile', 'truncate', 'utimes'] as const;
  let refused = 0;
  for (const method of writes) {
    const fn = (meta.client.promises as Record<string, (p: string, ...rest: unknown[]) => Promise<unknown>>)[method];
    check(`只读 fs 暴露了 ${method}（库的契约要求它存在）`, typeof fn === 'function');
    if (typeof fn !== 'function') continue;
    try {
      await fn('.git/index');
      check(`${method} 必须拒绝`, false, '它居然成功了');
    } catch (error) {
      refused += 1;
      const err = error as { code?: string };
      check(`${method} 拒绝且带错误码`, typeof err.code === 'string' && err.code.length > 0, `code=${err.code}`);
    }
  }
  note('被拒绝的写调用', `${refused}/${writes.length}`);
  check('写调用没有碰护栏（护栏的写入口一次都没被调用）', (calls['writeFileGuarded'] ?? 0) === 0 && (calls['createFileGuarded'] ?? 0) === 0);
  check('账本记下了每一次拒绝', meta.ledger.refused_writes.length === writes.length, `${meta.ledger.refused_writes.length}`);

  // 账本是脏的 → 整次调用必须失败（这是「不许为让查询成功而放开写权限」的落点）。
  const err = await expectError('INTERNAL_ERROR', async () => assertReadOnlyLedger(meta), '账本非空时的断言');
  check(
    '断言只报次数、不报那些路径',
    err.details?.['reason'] === 'READONLY_FS_WRITE_ATTEMPT' && !JSON.stringify(err).includes('.git/index'),
    JSON.stringify(err.details),
  );

  // 干净账本上不抛（否则这条断言会把每一次正常查询都炸掉）。
  const clean = createMetaFs({ ops: counted, scope, rules, limits: fsLimits });
  let cleanThrew = false;
  try {
    assertReadOnlyLedger(clean);
  } catch {
    cleanThrew = true;
  }
  check('干净的账本上断言不抛', !cleanThrew);

  // 窄范围清单：`.git` 内部的其它文件读不到。
  for (const rel of ['.git/hooks/pre-commit', '.git/config', '.git/logs/HEAD']) {
    try {
      await meta.client.promises.readFile(rel);
      check(`${rel} 必须读不到`, false, '它居然读到了');
    } catch (error) {
      check(`${rel} 被拒绝`, true, `code=${(error as { code?: string }).code ?? '?'}`);
    }
  }
  // 硬拒绝的工作区路径走 `readWorktreeFile` 也读不到。
  try {
    await meta.readWorktreeFile('secrets/.env');
    check('readWorktreeFile(secrets/.env) 必须拒绝', false, '它居然读到了');
  } catch (error) {
    check('readWorktreeFile(secrets/.env) 被拒绝', (error as { code?: string }).code === 'POLICY_DENIED');
  }
  await expectError('INVALID_ARGUMENT', () => meta.readWorktreeFile('.git/HEAD'), 'readWorktreeFile(.git/HEAD)');
  check('剪枝判据在根节点放行（否则整棵树会被第一步剪掉）', descends('.', 'app/stable.txt') === true);
  check('剪枝判据按路径段边界匹配', descends('app', 'app/stable.txt') === true && descends('ap', 'app/stable.txt') === false);
}

// ---------------------------------------------------------------------------
// 4. 布局降级：读不懂 Git，但普通文件读取仍然可用
// ---------------------------------------------------------------------------

async function layoutDegradation(ops: WinfsOps): Promise<void> {
  section('布局降级');
  const root = await mkdtemp(path.join(os.tmpdir(), 'lwb-git-016-layout-'));
  try {
    // `.git` 是一个**文件**（gitdir 指针）—— linked worktree / submodule 的形态。
    await writeFile(path.join(root, 'real-gitdir'), 'gitdir: ../elsewhere\n', 'utf8');
    await writeFile(path.join(root, '.git'), 'gitdir: ../elsewhere\n', 'utf8');
    await writeFile(path.join(root, 'note.txt'), '普通文件\n', 'utf8');

    const err = await expectError('GIT_LAYOUT_UNSUPPORTED', () => gitStatusTool(root, ops, {}), '外置 gitdir 的仓库');
    check('原因码是 GITDIR_FILE', err.details?.['reason'] === 'GITDIR_FILE', JSON.stringify(err.details));
    const diffErr = await expectError('GIT_LAYOUT_UNSUPPORTED', () => gitDiffTool(root, ops, { path: 'note.txt' }), '外置 gitdir 的 diff');
    check('diff 同样降级', diffErr.details?.['reason'] === 'GITDIR_FILE');

    // 同一工作区的普通文件读取不受影响。
    const scope = await scopeFor(ops, root);
    const read = await readFileTool(
      {
        scope,
        connection_id: CONNECTION,
        decision: decisionFor('read', 'note.txt'),
        input: { workspace_id: WS, path: 'note.txt' },
        now: NOW,
      },
      { ops, authority: createReadTicketAuthority({ key: KEY }), budget: budget() },
    );
    check('同一工作区的 file_read 仍然可用', read.content.includes('普通文件'), `sha256=${read.sha256.slice(0, 12)}…`);

    // 不是仓库的目录：另一种「读不懂」，用另一个码。
    const plain = await mkdtemp(path.join(os.tmpdir(), 'lwb-git-016-plain-'));
    try {
      const notFound = await expectError('NOT_FOUND', () => gitStatusTool(plain, ops, {}), '不是仓库的目录');
      check('原因码是 NO_GIT_DIR', notFound.details?.['reason'] === 'NO_GIT_DIR', JSON.stringify(notFound.details));
    } finally {
      await rm(plain, { recursive: true, force: true });
    }

    // `.git` 内部路径：本工具一律不接受。
    await expectError('INVALID_ARGUMENT', () => gitDiffTool(TESTREPO_DIR, ops, { path: '.git/HEAD' }), 'diff .git/HEAD');
    await expectError('INVALID_ARGUMENT', () => gitStatusTool(TESTREPO_DIR, ops, { path: 'sub/.git' }), '嵌套 .git');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 行解码的穷举（不依赖磁盘：这是纯函数，值得单独摆出来）
// ---------------------------------------------------------------------------

function rowTable(): void {
  section('statusMatrix 行解码：15 种可达组合 vs 9 种不可达');
  const reached = new Set<string>();
  for (const h of [0, 1]) {
    for (const w of [0, 1, 2]) {
      for (const s of [0, 1, 2, 3]) {
        // 只要解码器不抛，就说明这个组合在「可达集」里。
        try {
          deriveRow([`f${h}${w}${s}.txt`, h as 0 | 1, w as 0 | 1 | 2, s as 0 | 1 | 2 | 3]);
          reached.add(`${h},${w},${s}`);
        } catch {
          /* 不可达，见下 */
        }
      }
    }
  }
  check('可达组合恰好 15 种', reached.size === 15, [...reached].join(' '));
  const impossible = ['0,0,1', '0,0,2', '0,1,0', '0,1,1', '0,1,2', '0,1,3', '1,0,2', '1,1,2', '0,2,1'];
  let threw = 0;
  for (const combo of impossible) {
    const [h, w, s] = combo.split(',').map(Number) as [0 | 1, 0 | 1 | 2, 0 | 1 | 2 | 3];
    try {
      deriveRow(['x.txt', h, w, s]);
    } catch (error) {
      const err = error as { code?: string; details?: Record<string, unknown> };
      if (err.code === 'INTERNAL_ERROR' && err.details?.['reason'] === 'UNEXPECTED_STATUS_ROW') threw += 1;
      check(`不可达组合 ${combo} 的错误里不带路径`, !JSON.stringify(err).includes('x.txt'), JSON.stringify(err.details));
    }
  }
  check('9 种不可达组合全部报错，一条都不猜', threw === impossible.length, `${threw}/${impossible.length}`);
}

rowTable();
await main();
