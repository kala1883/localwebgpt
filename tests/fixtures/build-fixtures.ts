/**
 * LWB-001 测试夹具生成器（确定性、幂等、可重复运行）。
 *
 * 为什么需要它：
 * 项目要求「验收只使用专门的测试目录，不拿真实业务仓库做破坏性试验」。
 * 本生成器构造一个**固定内容**的测试仓库，让后续所有测试（读取、搜索、
 * Git 只读、编辑提案、审批、应用、撤回）都能在可复现的输入上断言，
 * 并且能验证「授权范围之外的文件没有被改动」。
 *
 * 覆盖的边界（方案 §5、§13 A01/A02/A11/A12/A22）：
 *   - 中文路径与 emoji 路径（Windows 非 ASCII 文件名）
 *   - UTF-8 BOM / 仅 BOM / 无 BOM
 *   - LF / CRLF / 混合换行 / 无末尾换行
 *   - 空文件、超长单行、超过可编辑上限的大文件
 *   - 高置信度秘密诱饵（**全部是公开示例值，不是真实凭证**）
 *   - node_modules 排除验证
 *   - Git：已提交 / 已修改未暂存 / 已暂存未提交 / 未跟踪 / 已删除
 *
 * 用法：
 *   node --import tsx tests/fixtures/build-fixtures.ts            # 已存在则跳过
 *   node --import tsx tests/fixtures/build-fixtures.ts --force    # 重建
 *
 * 安全声明：
 *   生成物一律位于 tests/fixtures/generated/（已在 .gitignore 中），
 *   不会写入用户任何真实目录。生成器只操作自己的输出目录与其内的独立 Git 仓库。
 *   本文件位于 tests/ 下，是 scripts/check-fsguard-imports.mjs 允许直接使用
 *   fs / child_process 的路径之一。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const GENERATED = path.join(here, 'generated');
const REPO = path.join(GENERATED, 'testrepo');
const SLACK_TOKEN_SAMPLE = ['xoxb', 'synthetic', 'test', 'canary'].join('-');
const CANARY = path.join(GENERATED, 'outside-canary');
const MANIFEST = path.join(GENERATED, 'manifest.json');

const force = process.argv.includes('--force');

// ---------------------------------------------------------------------------
// 固定的 Git 身份与时间戳：保证提交哈希可复现
// ---------------------------------------------------------------------------

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'LWB Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@lwb.invalid',
  GIT_COMMITTER_NAME: 'LWB Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@lwb.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00+00:00',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00+00:00',
  // 关键：禁止 Git 自动转换换行，否则 CRLF 夹具会被写回 LF。
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.autocrlf',
  GIT_CONFIG_VALUE_0: 'false',
};

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO, env: GIT_ENV, encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// 夹具内容（全部为固定字面量，不含随机性）
// ---------------------------------------------------------------------------

const BOM = '﻿';

interface FixtureFile {
  /** 相对测试仓库根的路径，统一 / 分隔。 */
  readonly relPath: string;
  /** 原始字节。 */
  readonly bytes: Buffer;
  /** 该文件预期的 Git 状态。 */
  readonly gitState:
    | 'committed_and_modified' // 已提交，之后被修改（未暂存）
    | 'committed'
    | 'staged'
    | 'untracked'
    | 'deleted'
    | 'ignored_by_lwb_policy';
  /** 是否落在可编辑范围内（用于后续 change_prepare 断言）。 */
  readonly editable: boolean;
  /** 人类可读说明。 */
  readonly note: string;
}

function text(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

function buildFixtureFiles(): FixtureFile[] {
  const files: FixtureFile[] = [];

  // --- 中文路径与 emoji 路径 -------------------------------------------------
  files.push({
    relPath: '文档/设计说明.md',
    bytes: text('# 设计说明\n\n这是初始提交的内容。\n第二行。\n'),
    gitState: 'committed_and_modified',
    editable: true,
    note: '中文目录 + 中文文件名，且存在未提交修改（最终验收 A01/A02 使用）',
  });
  files.push({
    relPath: '资料/2026年方案/📄笔记.txt',
    bytes: text('emoji 路径夹具\n数字与中文混合：2026 年方案\n'),
    gitState: 'committed',
    editable: true,
    note: 'emoji 目录 + 中文文件名',
  });

  // --- 编码与 BOM -----------------------------------------------------------
  files.push({
    relPath: 'bom/with-bom.txt',
    bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), text('带 BOM 的文件\n第二行。\n')]),
    gitState: 'committed',
    editable: true,
    note: 'UTF-8 BOM：写入时必须保留 BOM，不能静默丢弃',
  });
  files.push({
    relPath: 'edge/bom-only.txt',
    bytes: Buffer.from([0xef, 0xbb, 0xbf]),
    gitState: 'committed',
    editable: true,
    note: '仅含 BOM（3 字节，无正文）',
  });

  // --- 换行风格 -------------------------------------------------------------
  files.push({
    relPath: 'newline/lf.txt',
    bytes: text('lf-line-1\nlf-line-2\nlf-line-3\n'),
    gitState: 'committed',
    editable: true,
    note: '纯 LF',
  });
  files.push({
    relPath: 'newline/crlf.txt',
    bytes: text('crlf-line-1\r\ncrlf-line-2\r\ncrlf-line-3\r\n'),
    gitState: 'committed',
    editable: true,
    note: '纯 CRLF：写入时必须保持 CRLF',
  });
  files.push({
    relPath: 'newline/mixed.txt',
    bytes: text('mixed-1\nmixed-2\r\nmixed-3\r\nmixed-4\n'),
    gitState: 'committed',
    editable: false,
    note: '混合换行：行级编辑必须被拒绝（无法可靠重建原始换行）',
  });
  files.push({
    relPath: 'newline/no-trailing-newline.txt',
    bytes: text('no-trailing-1\nno-trailing-2'),
    gitState: 'committed',
    editable: true,
    note: '无末尾换行：不得在写入时擅自补一个换行',
  });

  // --- 边界尺寸 -------------------------------------------------------------
  files.push({
    relPath: 'edge/empty.txt',
    bytes: Buffer.alloc(0),
    gitState: 'committed',
    editable: false,
    note: '0 字节文件：行级编辑无法表达，必须走整文件替换或拒绝',
  });
  files.push({
    relPath: 'edge/long-line.txt',
    bytes: text(`${'x'.repeat(9000)}\n`),
    gitState: 'committed',
    editable: false,
    note: '单行 9000 字节，超过 MAX_LINE_BYTES(8KiB) 行长度上限',
  });
  files.push({
    relPath: 'large/big.txt',
    bytes: text(
      Array.from({ length: 48000 }, (_, i) => `line ${String(i).padStart(6, '0')} ${'y'.repeat(40)}`).join(
        '\n',
      ) + '\n',
    ),
    gitState: 'committed',
    editable: false,
    note: '约 2.4 MiB，超过 MAX_EDITABLE_FILE_BYTES(2MiB)：读取应截断且不得签发可编辑票据',
  });

  // --- 秘密诱饵（全部为公开示例值）------------------------------------------
  // 注意：这些是刻意构造的**假**凭证，用于验证硬拒绝与脱敏逻辑。
  // 它们都是已公开的示例格式，不是任何真实服务的凭证。
  files.push({
    relPath: 'secrets/.env',
    bytes: text(
      '# LWB 测试诱饵：以下均为公开示例格式的假值，不是真实凭证。\n' +
        'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n' +
        'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n' +
        'APP_MODE=fixture\n',
    ),
    gitState: 'committed',
    editable: false,
    note: '硬拒绝：.env 及常见变体',
  });
  files.push({
    relPath: 'secrets/aws.env',
    bytes: text(
      '# LWB 测试诱饵：公开示例格式的假值。\n' +
        'aws_access_key_id = AKIAIOSFODNN7EXAMPLE\n' +
        'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n',
    ),
    gitState: 'committed',
    editable: false,
    note: '硬拒绝：*.env 变体',
  });
  files.push({
    relPath: 'secrets/id_rsa',
    bytes: text(
      '# LWB 测试诱饵：这是一个格式合法但内容无意义的假私钥，不是真实密钥。\n' +
        '-----BEGIN OPENSSH PRIVATE KEY-----\n' +
        'Tk9UX0FSRUFMU0VDUkVUVEhJU0lTQUZJWFRVUkVERU1PAAAA\n' +
        '-----END OPENSSH PRIVATE KEY-----\n',
    ),
    gitState: 'committed',
    editable: false,
    note: '硬拒绝：私钥文件名 + 私钥块内容',
  });
  files.push({
    relPath: 'secrets/token.txt',
    bytes: text(
      '# LWB 测试诱饵：公开示例格式的假 token。\n' +
        'GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz\n' +
        'SLACK_TOKEN=' + SLACK_TOKEN_SAMPLE + '\n',
    ),
    gitState: 'committed',
    editable: false,
    note: '硬拒绝/脱敏：高置信度 token 模式',
  });
  files.push({
    relPath: 'config/.env.example',
    bytes: text('APP_MODE=example\nLOG_LEVEL=info\n'),
    gitState: 'committed',
    editable: true,
    note: '.env.example 不得被自动豁免：由本机策略显式决定，默认从严',
  });

  // --- 正常代码文件 ---------------------------------------------------------
  files.push({
    relPath: 'README.md',
    bytes: text('# Fixture Repo\n\n用于 LWB 验收的固定测试仓库。\n'),
    gitState: 'committed',
    editable: true,
    note: '普通 README，含会被搜索命中的锚点词',
  });
  files.push({
    relPath: 'src/main.ts',
    bytes: text(
      "// 搜索锚点：LWB_ANCHOR_TOKEN\n" +
        "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n",
    ),
    gitState: 'committed',
    editable: true,
    note: '含搜索锚点 LWB_ANCHOR_TOKEN',
  });
  files.push({
    relPath: 'src/staged.ts',
    bytes: text('export const staged = true;\n'),
    gitState: 'staged',
    editable: true,
    note: '已暂存未提交：git status 必须与未暂存修改区分开',
  });
  files.push({
    relPath: 'src/untracked.ts',
    bytes: text('export const untracked = true;\n'),
    gitState: 'untracked',
    editable: true,
    note: '未跟踪文件',
  });

  // --- node_modules 排除验证 ------------------------------------------------
  files.push({
    relPath: 'node_modules/fake-dep/index.js',
    bytes: text("module.exports = 'fake dependency for exclusion tests';\n"),
    gitState: 'ignored_by_lwb_policy',
    editable: false,
    note: '搜索排除：node_modules 属于性能排除，不是硬拒绝；但默认不参与搜索',
  });

  return files;
}

// ---------------------------------------------------------------------------
// 写入与 Git 状态构造
// ---------------------------------------------------------------------------

async function writeFixture(file: FixtureFile, bytes: Buffer): Promise<void> {
  const abs = path.join(REPO, ...file.relPath.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

interface ManifestFile {
  relPath: string;
  sha256: string;
  bytes: number;
  gitState: FixtureFile['gitState'];
  editable: boolean;
  note: string;
  lineCount: number | null;
  hasBom: boolean;
  newline: 'lf' | 'crlf' | 'mixed' | 'none';
  contentKind: 'text' | 'binary-ish';
}

function analyze(bytes: Buffer, editable: boolean): Omit<ManifestFile, 'relPath' | 'gitState' | 'editable' | 'note'> {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = hasBom ? bytes.subarray(3) : bytes;
  const asText = body.toString('utf8');
  const crlf = (asText.match(/\r\n/g) ?? []).length;
  const loneLf = (asText.match(/(?<!\r)\n/g) ?? []).length;
  let newline: ManifestFile['newline'];
  if (body.length === 0) newline = 'none';
  else if (crlf > 0 && loneLf > 0) newline = 'mixed';
  else if (crlf > 0) newline = 'crlf';
  else if (loneLf > 0) newline = 'lf';
  else newline = 'none';

  const lineCount = body.length === 0 ? 0 : asText.split(/\r\n|\n/).length - (asText.endsWith('\n') || asText.endsWith('\r\n') ? 1 : 0);

  return {
    sha256: sha256(bytes),
    bytes: bytes.length,
    lineCount,
    hasBom,
    newline,
    contentKind: asText.includes('�') ? 'binary-ish' : 'text',
  };
}

async function build(): Promise<void> {
  if (existsSync(MANIFEST) && !force) {
    console.log(`夹具已存在，跳过（如需重建请加 --force）：${path.relative(process.cwd(), GENERATED)}`);
    return;
  }

  if (existsSync(GENERATED)) {
    await rm(GENERATED, { recursive: true, force: true });
  }
  await mkdir(REPO, { recursive: true });
  await mkdir(CANARY, { recursive: true });

  const files = buildFixtureFiles();

  // 1) 先写入「已提交」态的原始内容（含需要之后被修改的那个文件）。
  const initialContent = new Map<string, Buffer>();
  for (const file of files) {
    // 未跟踪与「稍后暂存」的文件都不参与首次提交，否则它们会被固化进基线，
    // 之后无法再构造出「已暂存未提交」这一状态。
    if (file.gitState === 'untracked' || file.gitState === 'staged') continue;
    await writeFixture(file, file.bytes);
    initialContent.set(file.relPath, file.bytes);
  }

  // 2) 已删除文件：先提交，随后从磁盘删除。
  const deletedRel = 'src/deleted.ts';
  await writeFixture(
    { relPath: deletedRel, bytes: Buffer.alloc(0), gitState: 'deleted', editable: false, note: '' },
    text('export const willBeDeleted = true;\n'),
  );

  // 3) 初始化仓库并提交基线。
  git(['init', '--quiet', '--initial-branch=main']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'core.quotepath', 'false']);
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'fixture: 基线提交']);

  const headCommit = git(['rev-parse', 'HEAD']).trim();

  // 4) 暂存但未提交。
  const staged = files.find((f) => f.gitState === 'staged');
  if (staged) {
    await writeFixture(staged, staged.bytes);
    git(['add', '--', staged.relPath]);
  }

  // 5) 已提交后再修改（未暂存）。
  const modified = files.find((f) => f.gitState === 'committed_and_modified');
  let modifiedBytes: Buffer | null = null;
  if (modified) {
    modifiedBytes = text(
      '# 设计说明\n\n这是初始提交的内容。\n第二行。\n\n' +
        '## 未提交的追加段落\n\n由夹具生成器在基线提交之后追加，用于验证：\n' +
        '- 读取到的是磁盘上已保存的字节；\n' +
        '- 撤销与冲突判定不会覆盖这处未提交修改。\n' +
        '搜索锚点：LWB_ANCHOR_UNCOMMITTED\n',
    );
    await writeFixture(modified, modifiedBytes);
  }

  // 6) 未跟踪文件（写入但不 add）。
  for (const file of files.filter((f) => f.gitState === 'untracked')) {
    await writeFixture(file, file.bytes);
  }

  // 7) 已删除文件：从磁盘移除，保留在索引中。
  await rm(path.join(REPO, ...deletedRel.split('/')), { force: true });

  // 8) 生成 manifest（哈希取**当前磁盘真实字节**）。
  const manifestFiles: ManifestFile[] = [];
  for (const file of files) {
    const abs = path.join(REPO, ...file.relPath.split('/'));
    let bytes: Buffer | null = null;
    if (existsSync(abs)) bytes = await readFile(abs);
    else if (file.relPath === deletedRel) continue;

    const source = bytes ?? file.bytes;
    manifestFiles.push({
      relPath: file.relPath,
      gitState: file.gitState,
      editable: file.editable,
      note: file.note,
      ...analyze(source, file.editable),
    });
  }

  // 9) 授权范围外的 canary：用于证明越权访问没有改动范围外文件。
  const canaryBytes = text(
    'LWB_CANARY_CONTENT_v1\n本文件位于测试工作区根目录之外。\n' +
      '任何越权写入都会改变它，测试通过比对哈希来发现。\n',
  );
  await writeFile(path.join(CANARY, 'canary.txt'), canaryBytes);
  await writeFile(path.join(CANARY, 'EXPECTED.sha256'), `${sha256(canaryBytes)}  canary.txt\n`);

  const gitStatus = git(['status', '--porcelain', '-uall']);

  const manifest = {
    generated_by: 'tests/fixtures/build-fixtures.ts',
    fixture_version: 1,
    note: '所有 secrets/* 内容均为公开示例格式的假值，不是真实凭证。',
    repo_root: 'generated/testrepo',
    canary_root: 'generated/outside-canary',
    canary_sha256: sha256(canaryBytes),
    head_commit: headCommit,
    git_status_porcelain: gitStatus.split(/\r?\n/).filter(Boolean),
    files: manifestFiles,
  };

  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log('夹具已生成：');
  console.log(`  仓库：      ${path.relative(process.cwd(), REPO)}`);
  console.log(`  授权外金丝雀：${path.relative(process.cwd(), CANARY)}`);
  console.log(`  清单：      ${path.relative(process.cwd(), MANIFEST)}`);
  console.log(`  文件数：    ${manifestFiles.length}`);
  console.log(`  HEAD：      ${headCommit}`);
  console.log('  git status --porcelain：');
  for (const line of manifest.git_status_porcelain) console.log(`    ${line}`);
}

await build();
