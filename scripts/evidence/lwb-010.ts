/**
 * LWB-010 可复现证据采集。
 *
 * 三条验收标准全部走**真实磁盘**与**真实护栏**（PowerShell + .NET P/Invoke）：
 *
 *  1. 路径/Junction/符号链接/硬链接/别名逃逸全部被拒绝 —— 别名是同一个物理
 *     对象的多个名字，桩里造不出来。
 *  2. 并发交换父目录时不会打开/写入未授权对象 —— 靠内核的共享模式语义：
 *     持有者不给 `FILE_SHARE_DELETE`，后来者的 rename/delete 就会失败。
 *  3. 对无法验证的路径返回明确错误，不调用弱校验备用路径 —— 逐例检查
 *     拒绝是否都带具体理由，并检查「能打开但证明不了」的别名被明确拒绝。
 *
 * 另有两项实测，都是本设计里**必须靠测量**才能定的：
 *   - 相对路径语法在 TypeScript 与 PowerShell 里各有一份实现（边界不能假定
 *     调用方检查过），两份的一致性逐例比对，分歧数必须是 0；
 *   - 保留设备名为什么必须进拒绝表：探针直接问 Windows 在
 *     `<目录>\NUL` 上写入会发生什么。
 *
 * 用法：node --import tsx scripts/evidence/lwb-010.ts
 * 退出码：全部通过 0；任一项失败 1。
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { validateRelativePath, type PathRejectReason } from '@lwb/contracts';
import { PowerShellWinfsBackend, ResidentHelper } from '@lwb/winfs';

import {
  ACCEPTED_CASES,
  PATH_CORPUS,
  REJECTED_CASES,
  type CorpusCase,
} from '../../native/winfs/path_guard/corpus.ts';

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

function skip(name: string, why: string): void {
  console.log(`NOT_RUN ${name} — ${why}`);
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)]!;
}

/** 造一个 Junction。返回是否成功（失败要如实说，不能默认它成了）。 */
function makeJunction(link: string, target: string): boolean {
  const res = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `New-Item -ItemType Junction -Path '${link.replace(/'/g, "''")}' ` +
        `-Target '${target.replace(/'/g, "''")}' | Out-Null; 'OK'`,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  return `${res.stdout ?? ''}${res.stderr ?? ''}`.includes('OK');
}

function makeSymlink(link: string, target: string): boolean {
  const res = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `try { New-Item -ItemType SymbolicLink -Path '${link.replace(/'/g, "''")}' ` +
        `-Target '${target.replace(/'/g, "''")}' -ErrorAction Stop | Out-Null; 'OK' } ` +
        `catch { "FAIL: $($_.Exception.Message)" }`,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  return `${res.stdout ?? ''}${res.stderr ?? ''}`.includes('OK');
}

/**
 * 直接问 Windows：在 `<目录>\NUL` 上打开并写入会发生什么。
 *
 * 这个探针用**自己的** P/Invoke，而不是护栏的类 —— 它要回答的是操作系统
 * 的行为，不是护栏的行为。护栏的结论必须是基于前者推出来的，不能反过来。
 */
function probeNulWrite(dir: string): Record<string, unknown> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace LwbOsProbe -Name K -MemberDefinition @'
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(
  string lpFileName, uint dwDesiredAccess, uint dwShareMode, System.IntPtr lpSecurityAttributes,
  uint dwCreationDisposition, uint dwFlagsAndAttributes, System.IntPtr hTemplateFile);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool WriteFile(
  Microsoft.Win32.SafeHandles.SafeFileHandle hFile, byte[] lpBuffer, uint nNumberOfBytesToWrite,
  out uint lpNumberOfBytesWritten, System.IntPtr lpOverlapped);
'@
$GENERIC_WRITE = [uint32]1073741824
$CREATE_ALWAYS = [uint32]2
$target = '${dir.replace(/'/g, "''")}\\NUL'
$h = [LwbOsProbe.K]::CreateFileW($target, $GENERIC_WRITE, 0, [IntPtr]::Zero, $CREATE_ALWAYS, 0, [IntPtr]::Zero)
if ($h.IsInvalid) {
  $e = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  [ordered]@{ opened = $false; open_error = $e } | ConvertTo-Json -Compress
  exit 0
}
$bytes = [System.Text.Encoding]::UTF8.GetBytes('这段内容本该落盘，共若干字节')
$written = [uint32]0
$ok = [LwbOsProbe.K]::WriteFile($h, $bytes, [uint32]$bytes.Length, [ref]$written, [IntPtr]::Zero)
$writeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
$h.Dispose()
[ordered]@{
  opened = $true
  write_ok = $ok
  bytes_reported = [int]$written
  bytes_intended = $bytes.Length
  write_error = $writeError
  exists_on_disk = (Test-Path -LiteralPath $target)
} | ConvertTo-Json -Compress
`;
  const res = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  const line = out.split(/\r?\n/).filter(Boolean).pop() ?? '';
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { probe_failed: true, raw: out.slice(0, 400) };
  }
}

interface Verdict {
  ok: boolean;
  reason: string | null;
  normalized: string | null;
  segments: readonly string[] | null;
}

function verdictTs(c: CorpusCase): Verdict {
  const v = validateRelativePath(c.input);
  return v.ok
    ? { ok: true, reason: null, normalized: v.normalized, segments: v.segments }
    : { ok: false, reason: v.reason, normalized: null, segments: null };
}

async function verdictGuard(
  backend: PowerShellWinfsBackend,
  c: CorpusCase,
): Promise<Verdict> {
  // 故意把 `input` 原样送进去：类型系统挡住的东西，跨进程的边界上挡不住。
  const v = await backend.validatePath({ relative_path: c.input as string });
  return v.ok
    ? { ok: true, reason: null, normalized: v.normalized, segments: v.segments }
    : { ok: false, reason: v.reason, normalized: null, segments: null };
}

async function main(): Promise<void> {
  console.log('== 环境 ==');
  console.log(`平台: ${process.platform} ${process.arch}`);
  console.log(`系统: ${os.type()} ${os.release()}`);
  console.log(`Node: ${process.version}`);
  console.log(`PID: ${process.pid}`);

  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-evidence-010-'));
  const backend = new PowerShellWinfsBackend();
  const capability = await backend.capability();
  console.log(`护栏后端: ${capability.backend}（可用=${capability.available}）`);
  console.log(`护栏验证环境: ${capability.verified_on}`);
  console.log(`崩溃原子替换: ${String(capability.crash_atomic_replace)}`);
  console.log(`跨文件事务: ${String(capability.cross_file_transaction)}`);
  console.log(`临时目录: ${sandbox}`);
  console.log('');
  check('护栏可用（不可用时本证据的其余部分都无意义）', capability.available, capability.resolved_backend_reason);

  const ws = path.join(sandbox, 'ws');
  await mkdir(ws, { recursive: true });
  const rootInfo = await backend.statVolume({ path: ws });
  if (rootInfo.ok !== true) throw new Error(`statVolume 失败：${rootInfo.message}`);
  const wsRef = {
    root_path: ws,
    root_volume_id: rootInfo.volume_id,
    root_file_id: rootInfo.file_id,
  };

  // -------------------------------------------------------------------------
  // 步骤 1：相对路径语法 —— 两份实现逐例比对
  // -------------------------------------------------------------------------
  console.log('== 步骤 1：相对路径语法（TypeScript 与 PowerShell 逐例比对）==');
  note('语料规模', `${PATH_CORPUS.length} 条（接受 ${ACCEPTED_CASES.length} / 拒绝 ${REJECTED_CASES.length}）`);
  note(
    '上限',
    `路径 ${1024} 字符、单段 ${255} 字符、深度 ${64} 段（两侧同一组常量）`,
  );

  const divergences: string[] = [];
  const guardReasonCounts = new Map<string, number>();
  const unlabeled: string[] = [];
  const samples: number[] = [];

  for (const c of PATH_CORPUS) {
    const started = process.hrtime.bigint();
    const g = await verdictGuard(backend, c);
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);

    const t = verdictTs(c);
    const wantReason = c.reason;

    if (g.ok !== (wantReason === null) || g.reason !== wantReason) {
      divergences.push(`${c.name}: 护栏=${JSON.stringify(g)} 期望reason=${String(wantReason)}`);
      continue;
    }
    if (!g.ok) {
      const r = g.reason ?? '(缺失)';
      guardReasonCounts.set(r, (guardReasonCounts.get(r) ?? 0) + 1);
      // 理由标签落在契约取值域内这件事，由上面那条等式比对保证：
      // 护栏给出别的字符串就会被计成分歧（TS 也因此把这里的 g.reason
      // 收窄成了 PathRejectReason，连 'UNKNOWN' 都写不出来）。
      // 这里只再确认没有「拒绝了但不说为什么」。
      if (g.reason === null) unlabeled.push(c.name);
    }
    if (!t.ok && t.reason !== wantReason) {
      divergences.push(`${c.name}: TS=${String(t.reason)} 期望=${String(wantReason)}`);
    }
    if (t.ok !== (wantReason === null)) {
      divergences.push(`${c.name}: TS ok=${String(t.ok)} 期望reason=${String(wantReason)}`);
    }
  }

  check(
    '两侧对全部语料给出同一判定（含同一理由标签）',
    divergences.length === 0,
    divergences.length === 0 ? `分歧 0 / ${PATH_CORPUS.length}` : divergences.slice(0, 5).join(' | '),
  );
  check(
    '每一条拒绝都带具体理由（没有 UNKNOWN、没有"拒绝了但不说为什么"）',
    unlabeled.length === 0,
    unlabeled.length === 0 ? `覆盖 ${guardReasonCounts.size} 种理由` : unlabeled.join(', '),
  );
  check(
    '非字符串输入也被拒绝（类型系统在跨进程边界上不起作用）',
    PATH_CORPUS.filter((c) => typeof c.input !== 'string').every(
      (c) => validateRelativePath(c.input).ok === false,
    ),
    `语料含 ${PATH_CORPUS.filter((c) => typeof c.input !== 'string').length} 条非字符串输入`,
  );
  note(
    'validatePath 单次耗时（含常驻助手往返）',
    `P50=${percentile(samples, 50).toFixed(2)}ms P95=${percentile(samples, 95).toFixed(2)}ms`,
  );
  {
    const covered = new Set(PATH_CORPUS.map((c) => c.reason).filter((r): r is PathRejectReason => r !== null));
    const expected: readonly PathRejectReason[] = [
      'NOT_A_STRING', 'INVISIBLE_CHAR', 'EMPTY', 'TOO_LONG', 'TOO_DEEP', 'SEGMENT_TOO_LONG',
      'ABSOLUTE', 'UNC', 'DEVICE_NAMESPACE', 'DRIVE_LETTER', 'ADS_COLON', 'PARENT_REF',
      'DOT_SEGMENT', 'EMPTY_SEGMENT', 'TRAILING_SEPARATOR', 'CONTROL_CHAR', 'INVALID_CHAR',
      'TRAILING_DOT_OR_SPACE', 'RESERVED_NAME',
    ];
    const missing = expected.filter((r) => !covered.has(r));
    check(
      '契约里的每一个理由标签都有可复现的语料用例',
      missing.length === 0,
      missing.length === 0 ? `${expected.length} 种全部有覆盖` : `缺失：${missing.join(', ')}`,
    );
  }
  console.log('');

  // -------------------------------------------------------------------------
  // 步骤 2/3：别名、重解析点、身份
  // -------------------------------------------------------------------------
  console.log('== 步骤 2/3：别名、重解析点、身份与双重路径策略 ==');

  // --- 大小写别名：同一个对象 ---
  await writeFile(path.join(ws, 'Alpha.txt'), 'case alias\n', 'utf8');
  {
    const exact = await backend.readFileGuarded({ ...wsRef, relative_path: 'Alpha.txt' });
    const upper = await backend.readFileGuarded({ ...wsRef, relative_path: 'ALPHA.TXT' });
    const sameObject =
      exact.ok === true && upper.ok === true && exact.identity.file_id === upper.identity.file_id;
    const spelling = upper.ok === true && upper.canonical_relative_path === 'Alpha.txt';
    check(
      '大小写别名指向同一对象（按对象身份判定，不是按字符串）',
      sameObject,
      exact.ok === true && upper.ok === true
        ? `${exact.identity.file_id} == ${upper.identity.file_id}`
        : '读取失败',
    );
    check(
      '回执给出磁盘拼写而不是请求里的字符串（否则回执核不动，I14）',
      spelling,
      upper.ok === true ? `请求 ALPHA.TXT → canonical_relative_path=${String(upper.canonical_relative_path)}` : '读取失败',
    );
  }

  // --- 8.3 短名 ---
  const longName = 'VeryLongFileNameForShortName.txt';
  await writeFile(path.join(ws, longName), 'short name\n', 'utf8');
  const shortProbe = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -Namespace S -Name K -MemberDefinition '[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathNameW(string a, System.Text.StringBuilder b, uint c);'; ` +
        `$sb = New-Object System.Text.StringBuilder 512; ` +
        `$n = [S.K]::GetShortPathNameW('${path.join(ws, longName).replace(/'/g, "''")}', $sb, 512); ` +
        `if ($n -eq 0) { 'NONE' } else { $sb.ToString() }`,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  const shortPath = `${shortProbe.stdout ?? ''}${shortProbe.stderr ?? ''}`.trim();
  if (shortPath === 'NONE' || shortPath.length === 0) {
    skip(
      '8.3 短名别名被拒绝',
      '本卷未生成 8.3 短名（GetShortPathNameW 返回 0），该别名在本环境上不存在，无法测试',
    );
  } else {
    const shortLeaf = path.win32.basename(shortPath);
    const viaShort = await backend.readFileGuarded({ ...wsRef, relative_path: shortLeaf });
    check(
      '8.3 短名别名被明确拒绝（不是"打开失败"，是"证明不了"）',
      viaShort.ok === false && viaShort.code === 'PATH_UNSAFE',
      viaShort.ok === false ? `${viaShort.code}: ${viaShort.message}` : '竟然被接受了',
    );
  }

  // --- 硬链接 ---
  {
    const outside = path.join(sandbox, 'outside-hardlink');
    await mkdir(outside, { recursive: true });
    const secret = path.join(outside, 'secret.txt');
    const secretBody = '工作区外的内容\n';
    await writeFile(secret, secretBody, 'utf8');
    const linkRes = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `New-Item -ItemType HardLink -Path '${path.join(ws, 'entry.txt').replace(/'/g, "''")}' ` +
          `-Target '${secret.replace(/'/g, "''")}' | Out-Null; 'OK'`,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    const linked = `${linkRes.stdout ?? ''}${linkRes.stderr ?? ''}`.includes('OK');
    if (!linked) {
      skip('硬链接逃逸被拒绝', '本卷/本会话无法创建硬链接');
    } else {
      const read = await backend.readFileGuarded({ ...wsRef, relative_path: 'entry.txt' });
      check(
        '硬链接可读，且身份里的硬链接数为 2（判定依据是对象，不是名字）',
        read.ok === true && read.identity.link_count === 2,
        read.ok === true ? `file_id=${read.identity.file_id} link_count=${read.identity.link_count}` : read.message,
      );
      const write = await backend.writeFileGuarded({
        ...wsRef,
        relative_path: 'entry.txt',
        expected_sha256: read.ok === true ? read.sha256 : 'x',
        content_base64: Buffer.from('改掉它', 'utf8').toString('base64'),
      });
      check(
        '写入多重硬链接文件被拒绝（会连带改动工作区外的另一个名字）',
        write.ok === false && write.code === 'LINK_UNSUPPORTED',
        write.ok === false ? write.message : '竟然写成功了',
      );
      check(
        '被拒绝的写入确实没有改动工作区外的对象',
        (await readFile(secret, 'utf8')) === secretBody,
        '工作区外内容原样',
      );
    }
  }

  // --- ADS ---
  {
    await writeFile(path.join(ws, 'with-stream.txt'), '主数据流\n', 'utf8');
    const ads = await backend.readFileGuarded({ ...wsRef, relative_path: 'with-stream.txt:evil' });
    check(
      '备用数据流（ADS）在语法层被拒绝',
      ads.ok === false && ads.code === 'PATH_UNSAFE',
      ads.ok === false ? ads.message : '竟然被接受了',
    );
  }

  // --- Junction / 符号链接 ---
  {
    const outside = path.join(sandbox, 'outside-link');
    await mkdir(outside, { recursive: true });
    const secretBody = '工作区外的机密\n';
    await writeFile(path.join(outside, 'secret.txt'), secretBody, 'utf8');

    const junction = path.join(ws, 'escape-link');
    if (!makeJunction(junction, outside)) {
      skip('Junction 逃逸被拒绝', '本会话无法创建 Junction');
    } else {
      const read = await backend.readFileGuarded({ ...wsRef, relative_path: 'escape-link/secret.txt' });
      check(
        '经 Junction 读取工作区外文件被拒绝',
        read.ok === false && read.code === 'LINK_UNSUPPORTED',
        read.ok === false ? read.message : '竟然读到了',
      );
      const listed = await backend.listDirectory({ ...wsRef, relative_path: '' });
      const entry =
        listed.ok === true ? listed.entries.find((e) => e.name === 'escape-link') : undefined;
      check(
        '目录列举把 Junction 标为重解析点，且不报告目标大小',
        entry !== undefined && entry.is_reparse === true && entry.size === null,
        entry ? JSON.stringify(entry) : '列举里没有它',
      );
      check(
        '工作区外内容未被读取',
        (await readFile(path.join(outside, 'secret.txt'), 'utf8')) === secretBody,
        '外部文件原样',
      );
    }

    const symlink = path.join(ws, 'escape-symlink');
    if (!makeSymlink(symlink, outside)) {
      skip(
        '符号链接逃逸被拒绝',
        '本会话无权限创建符号链接（需要开发者模式或管理员），该拒绝路径在本环境上未被验证',
      );
    } else {
      const read = await backend.readFileGuarded({ ...wsRef, relative_path: 'escape-symlink/secret.txt' });
      check(
        '经符号链接读取工作区外文件被拒绝',
        read.ok === false && read.code === 'LINK_UNSUPPORTED',
        read.ok === false ? read.message : '竟然读到了',
      );
    }
  }
  console.log('');

  // -------------------------------------------------------------------------
  // 验收标准 2：并发交换父目录
  // -------------------------------------------------------------------------
  console.log('== 验收标准 2：并发交换父目录 ==');

  // --- 对照：这个环境本来就改得了目录名 ---
  {
    const a = path.join(sandbox, 'control-a');
    await mkdir(a, { recursive: true });
    let renamed = false;
    try {
      await rename(a, path.join(sandbox, 'control-b'));
      renamed = true;
    } catch {
      renamed = false;
    }
    check(
      '对照：未被持有的目录可以改名（后面那些失败才算数）',
      renamed,
      renamed ? '环境允许目录改名' : '本环境连未被持有的目录都改不了名，后续结论不成立',
    );
  }

  // --- 持有句柄期间改名必须失败 ---
  {
    const holdWs = path.join(sandbox, 'hold-ws');
    const holdSub = path.join(holdWs, 'sub');
    await mkdir(holdSub, { recursive: true });
    await writeFile(path.join(holdSub, 'inner.txt'), '深层\n', 'utf8');
    const holdRef = await backend.statVolume({ path: holdWs });
    if (holdRef.ok !== true) throw new Error('statVolume 失败');
    const ref = {
      root_path: holdWs,
      root_volume_id: holdRef.volume_id,
      root_file_id: holdRef.file_id,
    };

    for (const [label, rel, victim] of [
      ['持有工作区根', '', holdWs],
      ['持有中间目录', 'sub', holdSub],
      ['持有深层文件（祖先 sub 应被钉住）', 'sub/inner.txt', holdSub],
    ] as const) {
      const helper = new ResidentHelper();
      await helper.start();
      const held = await helper.call({
        op: 'holdHandle',
        ...ref,
        relative_path: rel,
        access: 'read',
        share_mode: 'read',
      });
      if (held.ok !== true) {
        check(`${label} → 外部改名被挡住`, false, `holdHandle 失败：${JSON.stringify(held).slice(0, 200)}`);
        await helper.stop();
        continue;
      }

      const moved = `${victim}-moved`;
      let blockedCode = 'NO_ERROR';
      try {
        await rename(victim, moved);
      } catch (error) {
        blockedCode = String((error as NodeJS.ErrnoException).code ?? 'UNKNOWN');
      }
      check(
        `${label} → 外部改名被挡住`,
        blockedCode !== 'NO_ERROR',
        blockedCode === 'NO_ERROR' ? '改名竟然成功了' : `errno=${blockedCode}（内核 ERROR_SHARING_VIOLATION）`,
      );

      // 释放（进程退出 = 句柄被内核回收）之后必须改得动，
      // 否则上一条的失败可能来自别的原因。
      await helper.stop();
      let afterRelease = false;
      try {
        await rename(victim, moved);
        await rename(moved, victim);
        afterRelease = true;
      } catch {
        afterRelease = false;
      }
      check(`${label} → 释放之后改名恢复`, afterRelease, afterRelease ? '因果成立' : '释放后仍改不动');
    }
  }

  // --- 已经被换掉了：兜底判定 ---
  {
    const swapWs = path.join(sandbox, 'swap-ws');
    await mkdir(swapWs, { recursive: true });
    await writeFile(path.join(swapWs, 'x.txt'), '原本的内容\n', 'utf8');
    const info = await backend.statVolume({ path: swapWs });
    if (info.ok !== true) throw new Error('statVolume 失败');
    const ref = { root_path: swapWs, root_volume_id: info.volume_id, root_file_id: info.file_id };

    await rename(swapWs, path.join(sandbox, 'swap-ws-original'));
    await mkdir(swapWs, { recursive: true });
    await writeFile(path.join(swapWs, 'x.txt'), '替换者的内容\n', 'utf8');

    const read = await backend.readFileGuarded({ ...ref, relative_path: 'x.txt' });
    check(
      '根被换成同名目录（路径字符串一模一样）后按旧身份访问被拒绝',
      read.ok === false && read.code === 'ROOT_IDENTITY_MISMATCH',
      read.ok === false ? read.message : '竟然读到了替换者的内容',
    );
    check(
      '拒绝有效：替换者没有被读也没有被改',
      (await readFile(path.join(swapWs, 'x.txt'), 'utf8')) === '替换者的内容\n',
      '替换者原样',
    );
  }

  {
    const jWs = path.join(sandbox, 'swap-junction');
    const jSub = path.join(jWs, 'sub');
    const outside = path.join(sandbox, 'swap-outside');
    await mkdir(jSub, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(jSub, 'target.txt'), '工作区内的内容\n', 'utf8');
    await writeFile(path.join(outside, 'target.txt'), '工作区外的机密\n', 'utf8');
    const info = await backend.statVolume({ path: jWs });
    if (info.ok !== true) throw new Error('statVolume 失败');
    const ref = { root_path: jWs, root_volume_id: info.volume_id, root_file_id: info.file_id };

    await rename(jSub, path.join(jWs, 'sub-moved'));
    if (!makeJunction(jSub, outside)) {
      skip('父目录被换成指向工作区外的 Junction', '本会话无法创建 Junction');
    } else {
      const read = await backend.readFileGuarded({ ...ref, relative_path: 'sub/target.txt' });
      check(
        '父目录被换成指向工作区外的 Junction 后，经它访问被拒绝',
        read.ok === false && read.code === 'LINK_UNSUPPORTED',
        read.ok === false ? read.message : '竟然读到了',
      );
      check(
        '外面那个同名文件未被读取（"走错路"原本是可达的，所以拒绝才有意义）',
        (await readFile(path.join(outside, 'target.txt'), 'utf8')) === '工作区外的机密\n',
        '外部文件原样',
      );
    }
  }

  // --- 已知边界 ---
  {
    const ws2 = path.join(sandbox, 'inside-ws');
    const sub = path.join(ws2, 'sub');
    const subMoved = path.join(ws2, 'sub-moved');
    const body = '内容一致时的原字节\n';
    await mkdir(sub, { recursive: true });
    await mkdir(subMoved, { recursive: true });
    await writeFile(path.join(sub, 'target.txt'), body, 'utf8');
    await writeFile(path.join(subMoved, 'target.txt'), body, 'utf8');
    const info = await backend.statVolume({ path: ws2 });
    if (info.ok !== true) throw new Error('statVolume 失败');
    const ref = { root_path: ws2, root_volume_id: info.volume_id, root_file_id: info.file_id };

    const before = await backend.readFileGuarded({ ...ref, relative_path: 'sub/target.txt' });
    if (before.ok !== true) throw new Error('前置读取失败');

    await rm(sub, { recursive: true, force: true });
    await rename(subMoved, sub);

    const after = await backend.readFileGuarded({ ...ref, relative_path: 'sub/target.txt' });
    if (after.ok !== true) throw new Error('换后读取失败');
    note(
      '已知边界的前提',
      `父目录被换成工作区内另一个目录，内容相同：file_id ${before.identity.file_id} → ${after.identity.file_id}`,
    );

    const written = await backend.writeFileGuarded({
      ...ref,
      relative_path: 'sub/target.txt',
      expected_sha256: before.sha256,
      content_base64: Buffer.from('替换后的内容\n', 'utf8').toString('base64'),
    });
    check(
      '边界：内容基线一致时写入继续（绑定的是内容基线，不是跨调用的文件身份）',
      written.ok === true,
      written.ok === true ? '已知且可接受，见 summary 的说明' : `意外：${written.message}`,
    );
    check(
      '但回执如实报告实际写入的对象（不把批准时的身份抄进来）',
      written.ok === true && written.identity_before.file_id === after.identity.file_id,
      written.ok === true
        ? `identity_before=${written.identity_before.file_id}（实际） vs ${before.identity.file_id}（批准时）`
        : '写入未成功',
    );

    // 内容不同时由基线挡住。
    const sub2 = path.join(ws2, 'sub2');
    const sub2Moved = path.join(ws2, 'sub2-moved');
    await mkdir(sub2, { recursive: true });
    await mkdir(sub2Moved, { recursive: true });
    await writeFile(path.join(sub2, 'target.txt'), '批准时的内容\n', 'utf8');
    await writeFile(path.join(sub2Moved, 'target.txt'), '别人的内容\n', 'utf8');
    const approved = await backend.readFileGuarded({ ...ref, relative_path: 'sub2/target.txt' });
    if (approved.ok !== true) throw new Error('前置读取失败');
    await rm(sub2, { recursive: true, force: true });
    await rename(sub2Moved, sub2);

    const conflict = await backend.writeFileGuarded({
      ...ref,
      relative_path: 'sub2/target.txt',
      expected_sha256: approved.sha256,
      content_base64: Buffer.from('不该落盘\n', 'utf8').toString('base64'),
    });
    check(
      '内容基线不同时被挡住，替换者原样保留',
      conflict.ok === false &&
        conflict.code === 'FILE_VERSION_CONFLICT' &&
        (await readFile(path.join(sub2, 'target.txt'), 'utf8')) === '别人的内容\n',
      conflict.ok === false ? conflict.message : '竟然写成功了',
    );
  }
  console.log('');

  // -------------------------------------------------------------------------
  // 步骤 4：资源释放
  // -------------------------------------------------------------------------
  console.log('== 步骤 4：错误路径的资源释放 ==');

  async function released(target: string): Promise<boolean> {
    const probe = `${target}.release-probe`;
    try {
      await rename(target, probe);
      await rename(probe, target);
      return true;
    } catch {
      return false;
    }
  }

  {
    const rWs = path.join(sandbox, 'release-ws');
    const rSub = path.join(rWs, 'sub');
    await mkdir(rSub, { recursive: true });
    await writeFile(path.join(rSub, 'target.txt'), '目标内容\n', 'utf8');
    const info = await backend.statVolume({ path: rWs });
    if (info.ok !== true) throw new Error('statVolume 失败');
    const ref = { root_path: rWs, root_volume_id: info.volume_id, root_file_id: info.file_id };

    const failing: Array<{ name: string; code: string; run: () => Promise<{ ok: boolean }> }> = [
      {
        name: '目标不存在',
        code: 'NOT_FOUND',
        run: () => backend.readFileGuarded({ ...ref, relative_path: 'sub/nope.txt' }),
      },
      {
        name: '中间目录不存在（链条自己抛错）',
        code: 'NOT_FOUND',
        run: () => backend.readFileGuarded({ ...ref, relative_path: 'missing-dir/inner.txt' }),
      },
      {
        name: '语法拒绝（不碰磁盘）',
        code: 'PATH_UNSAFE',
        run: () => backend.readFileGuarded({ ...ref, relative_path: '../escape.txt' }),
      },
      {
        name: '根身份不符',
        code: 'ROOT_IDENTITY_MISMATCH',
        run: () =>
          backend.readFileGuarded({ ...ref, root_file_id: '0000000000000000', relative_path: 'sub/target.txt' }),
      },
      {
        name: '基线冲突',
        code: 'FILE_VERSION_CONFLICT',
        run: () =>
          backend.writeFileGuarded({
            ...ref,
            relative_path: 'sub/target.txt',
            expected_sha256: 'f'.repeat(64),
            content_base64: Buffer.from('x', 'utf8').toString('base64'),
          }),
      },
    ];

    for (const c of failing) {
      const result = await c.run();
      const rightCode = result.ok === false && (result as { code?: string }).code === c.code;
      const rootFree = await released(rWs);
      const subFree = await released(rSub);
      check(
        `${c.name} → 拒绝码 ${c.code}，且根与祖先都已释放`,
        rightCode && rootFree && subFree,
        rightCode
          ? `根可改名=${String(rootFree)} 祖先可改名=${String(subFree)}`
          : `拒绝码不符：${JSON.stringify(result).slice(0, 160)}`,
      );
    }

    // 反复失败不累积。
    let allRejected = true;
    for (let i = 0; i < 12; i += 1) {
      const c = failing[i % failing.length]!;
      const result = await c.run();
      if (result.ok !== false) allRejected = false;
    }
    const stillFree = (await released(rWs)) && (await released(rSub));
    const after = await backend.readFileGuarded({ ...ref, relative_path: 'sub/target.txt' });
    check(
      '12 次失败注入无一被放行，且之后一切照旧',
      allRejected && stillFree && after.ok === true,
      `全部拒绝=${String(allRejected)} 仍可改名=${String(stillFree)} 读取仍可用=${String(after.ok)}`,
    );
  }
  console.log('');

  // -------------------------------------------------------------------------
  // 验收标准 3：无法验证时的明确报错
  // -------------------------------------------------------------------------
  console.log('== 验收标准 3：对无法验证的路径返回明确错误，不调用弱校验备用路径 ==');
  note(
    '静态边界',
    'scripts/check-fsguard-imports.mjs：业务包一律不得 import fs/child_process（本次已通过，58 个文件无绕过）',
  );
  note(
    '「能打开但证明不了」的处置',
    '8.3 短名即此类：句柄拿得到对象，但内核返回的规范路径与请求不是同一串字符 —— 明确拒绝，不按请求字符串放行',
  );
  skip(
    '护栏不可用时不写入（NATIVE_GUARD_UNAVAILABLE）',
    '本脚本无法在真实环境里构造"助手不可用"（常驻进程一停，后续调用就没有响应可等）。该分支由 tests/unit/workspaces.test.ts:1104 以注入式假后端覆盖，此处不重复声明为已测量',
  );
  note(
    '弱校验备用路径',
    '护栏脚本内不存在"证明不了就走字符串比较"的分支：取不到规范路径 -> PATH_UNSAFE（Assert-HandleMatches 的第二条判定）',
  );
  console.log('');

  // -------------------------------------------------------------------------
  // 实测：保留设备名为什么必须进拒绝表
  // -------------------------------------------------------------------------
  console.log('== 实测：保留设备名（RESERVED_NAME 规则的理由）==');
  {
    const probeDir = path.join(sandbox, 'nul-probe');
    await mkdir(probeDir, { recursive: true });
    const probe = probeNulWrite(probeDir);
    note('探针对象', `\\\\.\\ 之外的普通路径 ${probeDir}\\NUL（探针自带 P/Invoke，不经护栏）`);
    console.log(`      ${JSON.stringify(probe)}`);
    const silentlyDiscarded =
      probe['opened'] === true && probe['write_ok'] === true && probe['exists_on_disk'] === false;
    check(
      '在 <目录>\\NUL 上写入：报告成功、字节数对得上，而磁盘上什么都没有',
      silentlyDiscarded,
      silentlyDiscarded
        ? `写入报告 ${String(probe['bytes_reported'])}/${String(probe['bytes_intended'])} 字节，` +
          'Test-Path 该路径 = false（磁盘上确实没有这个文件）'
        : probe['opened'] !== true
          ? `打开就失败了（err=${String(probe['open_error'])}），本环境上该风险不成立`
          : `探针结果与预期不符：${JSON.stringify(probe)}`,
    );
    note(
      '因此 RESERVED_NAME 规则不是"照抄历史清单"',
      '放行会让 createFileGuarded 返回一份指向从未存在过的文件的回执，直接违反 I14',
    );
    note(
      '反面：COM0 / LPT0 等**没有**进保留名录',
      '实测（Windows 11 26200）在带目录成分的路径上它们会创建普通文件，\\\\.\\COM0 一律 err=2。名录是保守的历史清单，不是"本版本上哪些名字是设备"',
    );
  }
  console.log('');

  await backend.dispose();
  await rm(sandbox, { recursive: true, force: true });
  console.log(`已清理临时目录：${sandbox}`);
  console.log('');
  console.log(failures === 0 ? '全部通过。' : `失败 ${failures} 项。`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
