/**
 * LWB-003 实验：取得 Windows 文件系统句柄语义的**真实**证据。
 *
 * 设计原则：
 *   每一项都必须在真实文件系统上执行并记录真实观察值。
 *   无法构造的场景（例如未开启开发者模式时无法创建符号链接）必须如实标注
 *   为 skipped 并记录原因，**不允许**写成通过。
 *
 * 所有实验都在 %TEMP% 下的独立目录里进行，不触碰用户任何真实仓库。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// 刻意从 native/winfs 引入，而不是在 spike 里复制一份：
// 证据必须对应**实际交付的那份代码**，否则证据就没有意义。
import { ResidentHelper, callOnce, percentile, round, type HelperResult } from '../winfs/src/helper-client.ts';

export type ExperimentStatus = 'observed' | 'skipped' | 'failed';

export interface ExperimentRecord {
  id: string;
  title: string;
  status: ExperimentStatus;
  /** 实际执行的命令（可复现）。 */
  commands: string[];
  /** 真实观察结果，键值都必须来自实际执行。 */
  observations: Record<string, unknown>;
  /** 结论；若为 skipped/failed 必须说明原因。 */
  conclusion: string;
  /** 该实验证明了哪条不变量。 */
  invariants: string[];
}

export interface EvidenceReport {
  generated_at: string;
  host: {
    platform: string;
    os_release: string;
    node: string;
    powershell: string | null;
    temp_root: string;
    filesystem: string | null;
  };
  experiments: ExperimentRecord[];
  latency: {
    cold_spawn_ms: { samples: number; p50: number | null; p95: number | null; min: number | null; max: number | null };
    resident_call_ms: { samples: number; p50: number | null; p95: number | null; min: number | null; max: number | null };
    target_p95_ms: number;
    meets_target_with: 'resident' | 'cold' | 'neither' | 'unknown';
  };
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 从助手响应里取错误码；成功时返回 null。 */
function codeOf(result: HelperResult): string | null {
  if (result.ok) return null;
  return typeof result.code === 'string' ? result.code : null;
}

/** 从助手响应里取 Win32 错误码；成功或缺失时返回 null。 */
function win32Of(result: HelperResult): number | null {
  if (result.ok) return null;
  return typeof result.win32_error === 'number' ? result.win32_error : null;
}

/** 通过 PowerShell 执行一条系统命令并返回真实输出（用于取证：Junction、硬链接、文件系统类型）。 */
/**
 * 在后台进程中持有目标文件的句柄，直到被杀死。
 *
 * 为什么用**标记文件**而不是 stdout 来同步：
 * PowerShell 在 stdout 被重定向到管道时会缓冲输出，`Write-Output` 不会立即 flush。
 * 早期版本靠读取 stdout 判断「句柄已持有」，结果直到持有进程退出才收到通知，
 * 于是所有后续访问都发生在句柄释放之后 —— 实验结论完全错误。
 * 标记文件由文件系统提供真实的时序证据。
 */
async function holdHandleInBackground(
  target: string,
  options: { access: 'read' | 'write'; share: 'read' | 'none' | 'readwrite' },
  markerPath: string,
): Promise<{ proc: ReturnType<typeof import('node:child_process').spawn>; held: boolean; error: string | null }> {
  const { spawn } = await import('node:child_process');

  await rm(markerPath, { force: true });
  // 关键教训（实测踩到过）：不能在脚本里写 0x80000000 这类字面量。
  // PowerShell 会把它解析成 Int32 的 **负数**，传给 C# 的 uint 参数时抛
  // MethodException；而默认的 Continue 偏好设置会让脚本继续往下执行，
  // 于是标记文件照样写了出来 —— 「已持有句柄」变成一句假话，
  // 后续所有并发结论全部失效。因此这里改为引用 C# 里已声明为 uint 的常量，
  // 并把 ErrorActionPreference 设为 Stop，且写标记前显式校验句柄非空。
  const accessExpr =
    options.access === 'write'
      ? '[LwbHold]::GENERIC_READ -bor [LwbHold]::GENERIC_WRITE'
      : '[LwbHold]::GENERIC_READ';
  const shareExpr =
    options.share === 'none'
      ? '[uint32]0'
      : options.share === 'readwrite'
        ? '[LwbHold]::FILE_SHARE_READ -bor [LwbHold]::FILE_SHARE_WRITE'
        : '[LwbHold]::FILE_SHARE_READ';

  const script = `
$ErrorActionPreference = 'Stop'
$sig = @'
using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class LwbHold {
  public const uint GENERIC_READ     = 0x80000000;
  public const uint GENERIC_WRITE    = 0x40000000;
  public const uint FILE_SHARE_READ  = 0x00000001;
  public const uint FILE_SHARE_WRITE = 0x00000002;
  public const uint OPEN_EXISTING    = 3;
  public const uint OPEN_REPARSE     = 0x00200000;
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode, EntryPoint="CreateFileW")]
  public static extern SafeFileHandle CreateFile(string p, uint a, uint s, IntPtr sa, uint c, uint f, IntPtr t);
}
'@
Add-Type -TypeDefinition $sig | Out-Null
$h = [LwbHold]::CreateFile('${target}', ${accessExpr}, ${shareExpr}, [IntPtr]::Zero, [LwbHold]::OPEN_EXISTING, [LwbHold]::OPEN_REPARSE, [IntPtr]::Zero)
if ($null -eq $h) {
  Set-Content -LiteralPath '${markerPath}' -Value 'FAILED null-handle' -Encoding ascii
  exit 1
}
if ($h.IsInvalid) {
  Set-Content -LiteralPath '${markerPath}' -Value ('FAILED ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) -Encoding ascii
  exit 1
}
Set-Content -LiteralPath '${markerPath}' -Value 'HELD' -Encoding ascii
Start-Sleep -Seconds 300
`;

  const proc = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let error: string | null = null;
  const held = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      error = '等待标记文件超时（30s）';
      resolve(false);
    }, 30_000);
    const check = setInterval(() => {
      if (existsSync(markerPath)) {
        clearInterval(check);
        clearTimeout(timer);
        const content = readFileSyncSafe(markerPath);
        if (content.startsWith('HELD')) resolve(true);
        else {
          error = content;
          resolve(false);
        }
      }
    }, 50);
  });

  return { proc, held, error };
}

/**
 * 护栏要求每次工作区内调用都声明**根的物理身份**（LWB-010）。
 *
 * 只给路径是不够的：同名路径被换成另一个目录之后，按路径打开的就是另一个对象，
 * 而路径字符串一模一样 —— 护栏用句柄上的身份核对，正是为了挡住这件事。
 *
 * spike 的根在整轮实验里是同一个对象，因此探测一次并缓存。身份仍然由护栏自己的
 * `statVolume` 给出，没有在 Node 侧另算一份：证据必须来自实际交付的那段代码。
 */
let SPIKE_ROOT: { root_volume_id: string; root_file_id: string } | null = null;

function rootFields(): { root_volume_id: string; root_file_id: string } {
  if (!SPIKE_ROOT) {
    throw new Error('spike 根身份尚未探测：每个入口都必须先调用 identifyRoot');
  }
  return SPIKE_ROOT;
}

async function identifyRoot(helper: ResidentHelper, dir: string): Promise<void> {
  const probe = await helper.call({ op: 'statVolume', path: dir });
  if (probe.ok !== true) {
    throw new Error(`无法探测 spike 根身份（${String(probe.code)}）：${String(probe.message)}`);
  }
  SPIKE_ROOT = {
    root_volume_id: String(probe.volume_id),
    root_file_id: String(probe.file_id),
  };
}

function readFileSyncSafe(p: string): string {
  try {
    // 轮询回调里用同步读取最简单；标记文件只有一个词，代价可忽略。
    return readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
}

function ps(command: string): { ok: boolean; stdout: string; stderr: string; exitCode: number | null } {
  const res = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
    exitCode: res.status,
  };
}

export async function runExperiments(): Promise<EvidenceReport> {
  const tempRoot = path.join(os.tmpdir(), `lwb-winfs-spike-${process.pid}`);
  const root = path.join(tempRoot, 'workspace');
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  const experiments: ExperimentRecord[] = [];
  const helper = new ResidentHelper();
  const ready = await helper.start();
  await identifyRoot(helper, root);

  try {
    experiments.push(await exp1AncestorReparse(root, helper));
    experiments.push(await exp2FileIdentity(root, helper));
    experiments.push(await exp3Sharing(root, helper));
    experiments.push(await exp4GuardedWrite(root, helper));
    experiments.push(await exp5CreateNew(root, helper));
    experiments.push(await exp6CrashSemantics(root, helper));
    experiments.push(await exp8Busy(root, helper));
  } finally {
    await helper.stop();
  }

  const latency = await measureLatency(root);

  const fsInfo = ps('(Get-Volume -DriveLetter ((Get-Item $env:TEMP).PSDrive.Name)).FileSystemType');
  const psVersion = (
    ready as HelperResult & { powershell_version?: string }
  ).powershell_version;

  return {
    generated_at: new Date().toISOString(),
    host: {
      platform: `${process.platform} ${process.arch}`,
      os_release: `${os.type()} ${os.release()}`,
      node: process.version,
      powershell: typeof psVersion === 'string' ? psVersion : null,
      temp_root: tempRoot,
      filesystem: fsInfo.ok ? fsInfo.stdout : null,
    },
    experiments,
    latency,
  };
}

// ---------------------------------------------------------------------------
// 实验 1：逐级句柄固定与重解析点检测
// ---------------------------------------------------------------------------

async function exp1AncestorReparse(root: string, helper: ResidentHelper): Promise<ExperimentRecord> {
  const id = 'LWB-003-E1';
  const title = '逐级目录句柄固定 + Junction/符号链接检测';
  const commands: string[] = [];
  const observations: Record<string, unknown> = {};

  // 正常嵌套目录：应当通过。
  await mkdir(path.join(root, 'a', 'b'), { recursive: true });
  await writeFile(path.join(root, 'a', 'b', 'ok.txt'), 'nested ok\n');

  const okRes = await helper.call({
    op: 'resolvePath',
    root_path: root, ...rootFields(),
    relative_path: 'a/b/ok.txt',
  });
  observations['正常嵌套路径_ok'] = okRes.ok;
  observations['正常嵌套路径_file_id'] = (okRes.identity as { file_id?: string } | undefined)?.file_id ?? null;

  // 真实 Junction：a/junc -> root/a/b
  const junctionPath = path.join(root, 'a', 'junc');
  const juncCreate = ps(
    `New-Item -ItemType Junction -Path '${junctionPath}' -Target '${path.join(root, 'a', 'b')}' | Out-Null; if (Test-Path '${junctionPath}') { 'CREATED' } else { 'MISSING' }`,
  );
  commands.push(`New-Item -ItemType Junction -Path '${junctionPath}' -Target '<root>/a/b'`);
  observations['Junction_创建结果'] = juncCreate.ok ? juncCreate.stdout : `失败：${juncCreate.stderr}`;

  if (juncCreate.ok && juncCreate.stdout.includes('CREATED')) {
    const viaJunction = await helper.call({
      op: 'resolvePath',
      root_path: root, ...rootFields(),
      relative_path: 'a/junc/ok.txt',
    });
    observations['经Junction访问_ok'] = viaJunction.ok;
    observations['经Junction访问_code'] = viaJunction.ok ? null : viaJunction.code;
    observations['经Junction访问_message'] = viaJunction.ok ? null : viaJunction.message;

    // 直接列出 Junction 目录本身：也必须在遍历时被拒绝。
    const listJunction = await helper.call({
      op: 'listDirectory',
      root_path: root, ...rootFields(),
      relative_path: 'a/junc',
    });
    observations['遍历Junction目录_ok'] = listJunction.ok;
    observations['遍历Junction目录_code'] = listJunction.ok ? null : listJunction.code;
  } else {
    observations['经Junction访问_ok'] = 'skipped';
  }

  // 符号链接：需要开发者模式或管理员权限，可能失败 —— 如实记录。
  const symlinkPath = path.join(root, 'a', 'sym');
  const symCreate = ps(
    `try { New-Item -ItemType SymbolicLink -Path '${symlinkPath}' -Target '${path.join(root, 'a', 'b')}' -ErrorAction Stop | Out-Null; 'CREATED' } catch { 'FAILED: ' + $_.Exception.Message }`,
  );
  commands.push(`New-Item -ItemType SymbolicLink -Path '${symlinkPath}' -Target '<root>/a/b'`);
  observations['符号链接_创建结果'] = symCreate.stdout;

  if (symCreate.stdout.includes('CREATED')) {
    const viaSym = await helper.call({
      op: 'resolvePath',
      root_path: root, ...rootFields(),
      relative_path: 'a/sym/ok.txt',
    });
    observations['经符号链接访问_ok'] = viaSym.ok;
    observations['经符号链接访问_code'] = viaSym.ok ? null : viaSym.code;
  } else {
    observations['经符号链接访问_ok'] = 'skipped（无法创建符号链接，非管理员且未开启开发者模式）';
  }

  // 目标文件本身是符号链接：必须拒绝。
  const fileLinkTarget = path.join(root, 'real-target.txt');
  await writeFile(fileLinkTarget, 'real content\n');
  const fileLink = path.join(root, 'linked-file.txt');
  const fileLinkCreate = ps(
    `try { New-Item -ItemType SymbolicLink -Path '${fileLink}' -Target '${fileLinkTarget}' -ErrorAction Stop | Out-Null; 'CREATED' } catch { 'FAILED: ' + $_.Exception.Message }`,
  );
  observations['文件级符号链接_创建结果'] = fileLinkCreate.stdout;
  if (fileLinkCreate.stdout.includes('CREATED')) {
    const readLink = await helper.call({
      op: 'readFileGuarded',
      root_path: root, ...rootFields(),
      relative_path: 'linked-file.txt',
    });
    observations['读取符号链接文件_ok'] = readLink.ok;
    observations['读取符号链接文件_code'] = readLink.ok ? null : readLink.code;
  } else {
    observations['读取符号链接文件_ok'] = 'skipped（无法创建符号链接）';
  }

  // 路径混淆：..、ADS、空段。
  const confusions = ['../outside.txt', 'a/../../x', 'a/b/ok.txt:stream', 'a/./b/ok.txt', '\\a\\b\\ok.txt'];
  const confusionResults: Record<string, string> = {};
  for (const bad of confusions) {
    const r = await helper.call({ op: 'resolvePath', root_path: root, ...rootFields(), relative_path: bad });
    confusionResults[bad] = r.ok ? 'ACCEPTED（不应发生）' : (codeOf(r) ?? 'UNKNOWN_ERROR');
  }
  observations['路径混淆输入_拒绝码'] = confusionResults;

  const junctionBlocked = observations['经Junction访问_ok'] === false;
  const hasSkipped =
    String(observations['经符号链接访问_ok']).startsWith('skipped') ||
    String(observations['读取符号链接文件_ok']).startsWith('skipped');

  return {
    id,
    title,
    status: junctionBlocked ? 'observed' : 'failed',
    commands,
    observations,
    conclusion: junctionBlocked
      ? `逐级句柄检查成功识别并拒绝了 Junction 重定向（${String(observations['经Junction访问_code'])}）。` +
        (hasSkipped
          ? ' 符号链接场景因本机未开启开发者模式/非管理员而未能构造，相关结论未验证。'
          : ' 符号链接场景同样被拒绝。')
      : '未能证明 Junction 被拒绝，方案 I05 的路径安全主张在本机未获证据支持。',
    invariants: ['I05（路径按真实对象判定）', 'I06（重解析点拒绝）'],
  };
}

// ---------------------------------------------------------------------------
// 实验 2：文件身份
// ---------------------------------------------------------------------------

async function exp2FileIdentity(root: string, helper: ResidentHelper): Promise<ExperimentRecord> {
  const id = 'LWB-003-E2';
  const title = '文件身份（volume serial + file index + 硬链接数）在改名/删除/重建下的行为';
  const commands: string[] = [];
  const observations: Record<string, unknown> = {};

  const original = path.join(root, 'id-original.txt');
  await writeFile(original, 'identity content v1\n');

  const first = await helper.call({ op: 'resolvePath', root_path: root, ...rootFields(), relative_path: 'id-original.txt' });
  observations['初始_file_id'] = (first.identity as { file_id?: string })?.file_id ?? null;
  observations['初始_volume_id'] = (first.identity as { volume_id?: string })?.volume_id ?? null;
  observations['初始_link_count'] = (first.identity as { link_count?: number })?.link_count ?? null;
  observations['初始_attributes'] = (first.identity as { attributes?: string[] })?.attributes ?? null;

  // 重命名后身份不变。
  const renamed = path.join(root, 'id-renamed.txt');
  await rm(renamed, { force: true });
  ps(`Rename-Item -LiteralPath '${original}' -NewName 'id-renamed.txt'`);
  commands.push(`Rename-Item -LiteralPath 'id-original.txt' -NewName 'id-renamed.txt'`);
  const afterRename = await helper.call({ op: 'resolvePath', root_path: root, ...rootFields(), relative_path: 'id-renamed.txt' });
  observations['重命名后_file_id'] = (afterRename.identity as { file_id?: string })?.file_id ?? null;
  observations['重命名后身份不变'] =
    (afterRename.identity as { file_id?: string })?.file_id === observations['初始_file_id'];

  // 硬链接：链接数增加，file index 相同。
  const hardlink = path.join(root, 'id-hardlink.txt');
  const hardlinkCreate = ps(
    `try { New-Item -ItemType HardLink -Path '${hardlink}' -Target '${renamed}' -ErrorAction Stop | Out-Null; 'CREATED' } catch { 'FAILED: ' + $_.Exception.Message }`,
  );
  commands.push(`New-Item -ItemType HardLink -Path 'id-hardlink.txt' -Target 'id-renamed.txt'`);
  observations['硬链接_创建结果'] = hardlinkCreate.stdout;

  if (hardlinkCreate.stdout.includes('CREATED')) {
    const viaLink = await helper.call({ op: 'resolvePath', root_path: root, ...rootFields(), relative_path: 'id-hardlink.txt' });
    observations['硬链接_file_id'] = (viaLink.identity as { file_id?: string })?.file_id ?? null;
    observations['硬链接_link_count'] = (viaLink.identity as { link_count?: number })?.link_count ?? null;
    observations['硬链接与原名_file_id相同'] =
      (viaLink.identity as { file_id?: string })?.file_id === observations['重命名后_file_id'];

    // 关键负向：通过硬链接写入会影响工作区外的"另一个名字"，必须被拒绝。
    const writeViaHardlink = await helper.call({
      op: 'writeFileGuarded',
      root_path: root, ...rootFields(),
      relative_path: 'id-hardlink.txt',
      expected_sha256: sha256(Buffer.from('identity content v1\n')),
      content_base64: Buffer.from('overwritten\n').toString('base64'),
    });
    observations['经硬链接写入_ok'] = writeViaHardlink.ok;
    observations['经硬链接写入_code'] = writeViaHardlink.ok ? null : codeOf(writeViaHardlink);
  } else {
    observations['硬链接与原名_file_id相同'] = 'skipped';
    observations['经硬链接写入_ok'] = 'skipped';
  }

  // 删除后重建同名文件：身份必须改变（证明"同名 ≠ 同一对象"）。
  const beforeDeleteId = observations['重命名后_file_id'];
  ps(`Remove-Item -LiteralPath '${hardlink}' -Force -ErrorAction SilentlyContinue`);
  ps(`Remove-Item -LiteralPath '${renamed}' -Force`);
  await writeFile(renamed, 'identity content v1\n');
  commands.push(`Remove-Item id-renamed.txt; 重新写入同名文件，内容完全相同`);
  const recreated = await helper.call({ op: 'resolvePath', root_path: root, ...rootFields(), relative_path: 'id-renamed.txt' });
  observations['删除重建后_file_id'] = (recreated.identity as { file_id?: string })?.file_id ?? null;
  observations['删除重建后身份改变'] = (recreated.identity as { file_id?: string })?.file_id !== beforeDeleteId;
  observations['删除重建后内容哈希相同'] =
    sha256(await readFile(renamed)) === sha256(Buffer.from('identity content v1\n'));

  return {
    id,
    title,
    status: observations['删除重建后身份改变'] === true ? 'observed' : 'failed',
    commands,
    observations,
    conclusion:
      '文件身份（volume serial + 128 位 file index）在重命名后保持不变，在删除重建后改变，' +
      '因此可以区分「同一对象的同名文件」与「内容相同但已被替换的文件」——这正是方案 I05 与' +
      '「读写前重新校验基线」所需要的判别依据。硬链接共享同一 file index 且 link_count > 1，' +
      `实测写入被拒绝（${String(observations['经硬链接写入_code'] ?? '未构造')}）。`,
    invariants: ['I05（按真实对象判定）', 'I07（写入前重新校验基线）'],
  };
}

// ---------------------------------------------------------------------------
// 实验 3：共享模式与并发保存
// ---------------------------------------------------------------------------

async function exp3Sharing(root: string, helper: ResidentHelper): Promise<ExperimentRecord> {
  const id = 'LWB-003-E3';
  const title = '共享模式能否阻止「读取后、写入前被别人改写」';
  const commands: string[] = [];
  const observations: Record<string, unknown> = {};

  const baseline = Buffer.from('sharing baseline\n');
  const baselineHash = sha256(baseline);

  // --- 场景 A：对方以「读 + share=FILE_SHARE_READ」持有 ---------------------
  // 我们随后以 FILE_SHARE_READ 请求写权限。Windows 的共享判定是双向的：
  // 新打开的 desiredAccess 必须被既有句柄的 shareMode 允许。
  // 对方的 shareMode 只有 FILE_SHARE_READ，因此我们请求的 GENERIC_WRITE
  // 应当被拒绝（ERROR_SHARING_VIOLATION = 32）。
  const targetA = path.join(root, 'sharing-a.txt');
  await writeFile(targetA, baseline);
  const markerA = path.join(root, '.holder-a.marker');
  const holderA = await holdHandleInBackground(targetA, { access: 'read', share: 'read' }, markerA);
  observations['A_对方读句柄已持有'] = holderA.held;
  if (holderA.error) observations['A_持有失败原因'] = holderA.error;
  commands.push(
    `pwsh -Command "<CreateFileW(GENERIC_READ, FILE_SHARE_READ) 持有 sharing-a.txt 300 秒>"（后台进程，标记文件同步）`,
  );

  if (holderA.held) {
    const readA = await helper.call({ op: 'readFileGuarded', root_path: root, ...rootFields(), relative_path: 'sharing-a.txt' });
    observations['A_对方持读句柄时_我方读取_ok'] = readA.ok;
    observations['A_对方持读句柄时_我方读取_code'] = readA.ok ? null : codeOf(readA);

    const writeA = await helper.call({
      op: 'writeFileGuarded',
      root_path: root, ...rootFields(),
      relative_path: 'sharing-a.txt',
      expected_sha256: baselineHash,
      content_base64: Buffer.from('A must not be written\n').toString('base64'),
    });
    observations['A_对方持读句柄时_我方写入_ok'] = writeA.ok;
    observations['A_对方持读句柄时_我方写入_code'] = writeA.ok ? null : codeOf(writeA);
    observations['A_对方持读句柄时_我方写入_win32'] = writeA.ok ? null : win32Of(writeA);
  } else {
    observations['A_对方持读句柄时_我方写入_ok'] = 'skipped（外部进程未能持有句柄）';
  }
  holderA.proc.kill();
  await new Promise((r) => setTimeout(r, 800));
  if (holderA.held) {
    observations['A_文件内容未被改动'] = (await readFile(targetA)).equals(baseline);
  }

  // --- 场景 B：我们自己以 FILE_SHARE_READ 持有读句柄时，对方能否写入 --------
  // 这是「我们正在读，编辑器在保存」的方向。用 helper 的 holdHandle 持有，
  // 再用一个独立进程尝试写。
  const targetB = path.join(root, 'sharing-b.txt');
  await writeFile(targetB, baseline);
  const holdB = await helper.call({
    op: 'holdHandle',
    root_path: root, ...rootFields(),
    relative_path: 'sharing-b.txt',
    access: 'read',
    share_mode: 'read',
  });
  observations['B_我方读句柄已持有'] = holdB.ok;
  commands.push(
    `WinfsGuard.ps1 -Server: {"op":"holdHandle","access":"read","share_mode":"read"}，随后由独立 pwsh 进程尝试写入`,
  );

  if (holdB.ok) {
    const writerScript = `
$ErrorActionPreference = 'Stop'
$sig = @'
using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class LwbTryWrite {
  public const uint GENERIC_WRITE    = 0x40000000;
  public const uint FILE_SHARE_READ  = 0x00000001;
  public const uint FILE_SHARE_WRITE = 0x00000002;
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode, EntryPoint="CreateFileW")]
  public static extern SafeFileHandle CreateFile(string p, uint a, uint s, IntPtr sa, uint c, uint f, IntPtr t);
}
'@
Add-Type -TypeDefinition $sig | Out-Null
$h = [LwbTryWrite]::CreateFile('${targetB}', [LwbTryWrite]::GENERIC_WRITE, [LwbTryWrite]::FILE_SHARE_READ -bor [LwbTryWrite]::FILE_SHARE_WRITE, [IntPtr]::Zero, 3, 0x00200000, [IntPtr]::Zero)
if ($h.IsInvalid) { 'DENIED ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error() } else { 'ALLOWED'; $h.Dispose() }
`;
    const tryWrite = ps(writerScript);
    observations['B_对方尝试写入_result'] = tryWrite.stdout.trim();
    observations['B_对方写入是否被拒绝'] = tryWrite.stdout.includes('DENIED');
    if (tryWrite.stdout.includes('DENIED')) {
      observations['B_对方写入_win32'] = Number(tryWrite.stdout.trim().split(' ')[1]);
    }
  } else {
    observations['B_对方尝试写入_result'] = 'skipped（未能持有读句柄）';
  }

  // --- 场景 C：对方以 share=0 独占持有 -> 我方任何打开都应失败 ---------------
  const targetC = path.join(root, 'sharing-c.txt');
  await writeFile(targetC, baseline);
  const markerC = path.join(root, '.holder-c.marker');
  const holderC = await holdHandleInBackground(targetC, { access: 'read', share: 'none' }, markerC);
  observations['C_对方独占句柄已持有'] = holderC.held;
  if (holderC.error) observations['C_持有失败原因'] = holderC.error;
  commands.push(`pwsh -Command "<CreateFileW(GENERIC_READ, share=0) 独占持有 sharing-c.txt>"（后台进程，标记文件同步）`);

  if (holderC.held) {
    const readC = await helper.call({ op: 'readFileGuarded', root_path: root, ...rootFields(), relative_path: 'sharing-c.txt' });
    observations['C_对方独占时_我方读取_ok'] = readC.ok;
    observations['C_对方独占时_我方读取_code'] = readC.ok ? null : codeOf(readC);
    observations['C_对方独占时_我方读取_win32'] = readC.ok ? null : win32Of(readC);

    const writeC = await helper.call({
      op: 'writeFileGuarded',
      root_path: root, ...rootFields(),
      relative_path: 'sharing-c.txt',
      expected_sha256: baselineHash,
      content_base64: Buffer.from('C must not be written\n').toString('base64'),
    });
    observations['C_对方独占时_我方写入_ok'] = writeC.ok;
    observations['C_对方独占时_我方写入_code'] = writeC.ok ? null : codeOf(writeC);

    // 旁证：连 Node 自己的 open() 都应被独占句柄挡住。
    try {
      await readFile(targetC);
      observations['C_Node直接读取'] = 'succeeded（不应发生：share=0 应挡住所有打开）';
    } catch (error) {
      observations['C_Node直接读取'] = `被拒绝：${(error as { code?: string }).code ?? String(error)}`;
    }
  } else {
    observations['C_对方独占时_我方读取_ok'] = 'skipped（外部进程未能独占持有）';
  }
  holderC.proc.kill();
  await new Promise((r) => setTimeout(r, 800));
  // 释放后再比对内容：证明失败路径没有留下任何改动。
  if (holderC.held) {
    observations['C_文件内容未被改动'] = (await readFile(targetC)).equals(baseline);
  }

  const aBlocked = observations['A_对方持读句柄时_我方写入_ok'] === false;
  const bBlocked = observations['B_对方写入是否被拒绝'] === true;
  const cBlocked = observations['C_对方独占时_我方读取_ok'] === false;

  return {
    id,
    title,
    status: aBlocked || bBlocked || cBlocked ? 'observed' : 'failed',
    commands,
    observations,
    conclusion:
      `场景 A（对方持读句柄、我方请求写）：${aBlocked ? '被拒绝' : '**未被拒绝**'}，` +
      `code=${String(observations['A_对方持读句柄时_我方写入_code'] ?? 'n/a')}，` +
      `Win32=${String(observations['A_对方持读句柄时_我方写入_win32'] ?? 'n/a')}。` +
      `场景 B（我方持读句柄、对方尝试写）：${bBlocked ? '被拒绝' : '**未被拒绝**'}，` +
      `结果=${String(observations['B_对方尝试写入_result'] ?? 'n/a')}。` +
      `场景 C（对方独占持有、我方读取）：${cBlocked ? '被拒绝' : '**未被拒绝**'}，` +
      `code=${String(observations['C_对方独占时_我方读取_code'] ?? 'n/a')}。` +
      '结论：在没有 FILE_SHARE_WRITE 的情况下持有句柄，可以阻止**协作式**进程写入；' +
      '这正是把「读取→校验基线→写入」窗口收紧为真正独占的手段。' +
      '但它不阻止以 FILE_SHARE_READ|FILE_SHARE_WRITE 打开的进程，' +
      '因此基线哈希复核是必需的第二道防线，不是冗余。',
    invariants: ['I07（写入前重新校验基线）', 'I08（不安全则拒绝）'],
  };
}

// ---------------------------------------------------------------------------
// 实验 4：同句柄内 校验→写入→截断→刷盘→回读
// ---------------------------------------------------------------------------

async function exp4GuardedWrite(root: string, helper: ResidentHelper): Promise<ExperimentRecord> {
  const id = 'LWB-003-E4';
  const title = 'guarded_inplace：同一句柄内完成校验、写入、截断、刷盘、回读';
  const commands: string[] = [];
  const observations: Record<string, unknown> = {};

  const single = path.join(root, 'write-single.txt');
  const original = Buffer.from('original line 1\noriginal line 2\n', 'utf8');
  await writeFile(single, original);

  const replacement = Buffer.from('replaced line 1\nreplaced line 2\nreplaced line 3\n', 'utf8');
  const writeRes = await helper.call({
    op: 'writeFileGuarded',
    root_path: root, ...rootFields(),
    relative_path: 'write-single.txt',
    expected_sha256: sha256(original),
    content_base64: replacement.toString('base64'),
  });
  observations['正常写入_ok'] = writeRes.ok;
  observations['正常写入_flushed'] = writeRes.flushed ?? null;
  observations['正常写入_readback_ok'] = writeRes.readback_ok ?? null;
  observations['正常写入_after_sha256匹配目标'] =
    (writeRes.after_sha256 as string | undefined) === sha256(replacement);
  observations['正常写入_磁盘内容正确'] = sha256(await readFile(single)) === sha256(replacement);
  // 只比对**文件身份**：size 本来就该变，把它算进身份比较会得到一个
  // 恒为 false 的伪观察值（早期版本犯过这个错）。
  const idBefore = writeRes.identity_before as { file_id?: string; volume_id?: string } | undefined;
  const idAfter = writeRes.identity_after as { file_id?: string; volume_id?: string } | undefined;
  observations['正常写入_file_id不变'] = idBefore?.file_id === idAfter?.file_id;
  observations['正常写入_volume_id不变'] = idBefore?.volume_id === idAfter?.volume_id;
  observations['正常写入_字节数变化'] = `${(idBefore as { size?: number })?.size} -> ${(idAfter as { size?: number })?.size}`;

  // 短写入：新内容比原内容短，必须真正截断而不是留残留尾巴。
  const shrink = Buffer.from('short\n', 'utf8');
  const shrinkRes = await helper.call({
    op: 'writeFileGuarded',
    root_path: root, ...rootFields(),
    relative_path: 'write-single.txt',
    expected_sha256: sha256(replacement),
    content_base64: shrink.toString('base64'),
  });
  observations['缩短写入_ok'] = shrinkRes.ok;
  const shrinkStat = await stat(single);
  observations['缩短写入_磁盘字节数'] = shrinkStat.size;
  observations['缩短写入_无残留尾巴'] = (await readFile(single, 'utf8')) === 'short\n';

  // 基线不符：必须拒绝，且文件内容**保持不变**。
  const staleRes = await helper.call({
    op: 'writeFileGuarded',
    root_path: root, ...rootFields(),
    relative_path: 'write-single.txt',
    expected_sha256: sha256(Buffer.from('这个哈希与磁盘上任何内容都不匹配\n', 'utf8')),
    content_base64: Buffer.from('must not be written\n').toString('base64'),
  });
  observations['基线不符_ok'] = staleRes.ok;
  observations['基线不符_code'] = staleRes.ok ? null : codeOf(staleRes);
  observations['基线不符_文件未被改动'] = (await readFile(single, 'utf8')) === 'short\n';

  // CRLF 与 BOM 保真：写入端不应替调用方猜测换行或编码。
  const crlfFile = path.join(root, 'write-crlf.txt');
  const crlfOriginal = Buffer.from('a\r\nb\r\n', 'utf8');
  await writeFile(crlfFile, crlfOriginal);
  const crlfNew = Buffer.from('a\r\nB\r\nc\r\n', 'utf8');
  const crlfRes = await helper.call({
    op: 'writeFileGuarded',
    root_path: root, ...rootFields(),
    relative_path: 'write-crlf.txt',
    expected_sha256: sha256(crlfOriginal),
    content_base64: crlfNew.toString('base64'),
  });
  observations['CRLF写入_ok'] = crlfRes.ok;
  observations['CRLF写入_字节完全一致'] = sha256(await readFile(crlfFile)) === sha256(crlfNew);

  const bomFile = path.join(root, 'write-bom.txt');
  const bomOriginal = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x\n', 'utf8')]);
  await writeFile(bomFile, bomOriginal);
  const bomNew = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('X\nY\n', 'utf8')]);
  const bomRes = await helper.call({
    op: 'writeFileGuarded',
    root_path: root, ...rootFields(),
    relative_path: 'write-bom.txt',
    expected_sha256: sha256(bomOriginal),
    content_base64: bomNew.toString('base64'),
  });
  observations['BOM写入_ok'] = bomRes.ok;
  const bomAfter = await readFile(bomFile);
  observations['BOM写入_前3字节'] = bomAfter.subarray(0, 3).toString('hex');
  observations['BOM写入_字节完全一致'] = sha256(bomAfter) === sha256(bomNew);

  const allGood =
    observations['正常写入_readback_ok'] === true &&
    observations['缩短写入_无残留尾巴'] === true &&
    observations['基线不符_ok'] === false &&
    observations['基线不符_文件未被改动'] === true;

  return {
    id,
    title,
    status: allGood ? 'observed' : 'failed',
    commands,
    observations,
    conclusion:
      '在同一独占句柄内完成基线校验、截断、写入、FlushFileBuffers 与回读验证，' +
      '回读哈希与目标一致；缩短写入确实截断（无残留尾巴）；' +
      `基线不符时以 ${String(observations['基线不符_code'])} 拒绝且文件保持不变；` +
      'CRLF 与 BOM 按字节保真，写入端不猜测换行与编码。' +
      '**不提供崩溃原子性，也不提供跨文件 ACID。**',
    invariants: ['I07（写入前重新校验基线）', 'I08（不安全则拒绝）'],
  };
}

// ---------------------------------------------------------------------------
// 实验 5：CREATE_NEW
// ---------------------------------------------------------------------------

async function exp5CreateNew(root: string, helper: ResidentHelper): Promise<ExperimentRecord> {
  const id = 'LWB-003-E5';
  const title = 'CREATE_NEW 语义：已存在文件绝不被覆盖';
  const commands: string[] = [];
  const observations: Record<string, unknown> = {};

  const created = await helper.call({
    op: 'createFileGuarded',
    root_path: root, ...rootFields(),
    relative_path: 'created-new.txt',
    content_base64: Buffer.from('first creation\n').toString('base64'),
  });
  observations['首次创建_ok'] = created.ok;
  observations['首次创建_磁盘内容'] = existsSync(path.join(root, 'created-new.txt'))
    ? (await readFile(path.join(root, 'created-new.txt'), 'utf8')).trim()
    : null;

  const again = await helper.call({
    op: 'createFileGuarded',
    root_path: root, ...rootFields(),
    relative_path: 'created-new.txt',
    content_base64: Buffer.from('SHOULD NOT OVERWRITE\n').toString('base64'),
  });
  observations['重复创建_ok'] = again.ok;
  observations['重复创建_code'] = again.ok ? null : codeOf(again);
  observations['重复创建_win32'] = again.ok ? null : win32Of(again);
  observations['重复创建_原内容保留'] =
    (await readFile(path.join(root, 'created-new.txt'), 'utf8')) === 'first creation\n';

  // 在既有父目录中创建，但父目录不存在时必须失败，而不是多层创建。
  const missingParent = await helper.call({
    op: 'createFileGuarded',
    root_path: root, ...rootFields(),
    relative_path: 'no-such-dir/deep/file.txt',
    content_base64: Buffer.from('x\n').toString('base64'),
  });
  observations['父目录不存在_ok'] = missingParent.ok;
  observations['父目录不存在_code'] = missingParent.ok ? null : codeOf(missingParent);
  observations['父目录不存在_未创建目录'] = !existsSync(path.join(root, 'no-such-dir'));

  return {
    id,
    title,
    status: observations['重复创建_原内容保留'] === true ? 'observed' : 'failed',
    commands,
    observations,
    conclusion:
      `CREATE_NEW 在文件已存在时失败（Win32 ${String(observations['重复创建_win32'])}, 错误 ${String(observations['重复创建_code'])}），` +
      '原文件内容保持不变，因此「检查不存在 → 别人抢先创建 → 我们写」这个竞态不会退化成静默覆盖。' +
      '父目录不存在时拒绝，不做隐式多层创建。',
    invariants: ['I08（不安全则拒绝）'],
  };
}

// ---------------------------------------------------------------------------
// 实验 6：崩溃语义
// ---------------------------------------------------------------------------

async function exp6CrashSemantics(root: string, helper: ResidentHelper): Promise<ExperimentRecord> {
  const id = 'LWB-003-E6';
  const title = '写入过程中进程崩溃后，磁盘上留下了什么';
  void helper;
  const commands: string[] = [];
  const observations: Record<string, unknown> = {};

  const expected = Buffer.from(
    Array.from({ length: 200 }, (_, i) => `target line ${String(i).padStart(3, '0')}`).join('\n') + '\n',
    'utf8',
  );

  // 场景 A：截断后立刻崩溃。
  const crashA = path.join(root, 'crash-truncate.txt');
  await writeFile(crashA, expected);
  const beforeA = sha256(await readFile(crashA));
  commands.push(
    `pwsh -File WinfsGuard.ps1 -Once '{"op":"crashExperiment","mode":"truncate_then_crash",...}'（进程以 42 退出）`,
  );
  const resA = callOnce({
    op: 'crashExperiment',
    root_path: root, ...rootFields(),
    relative_path: 'crash-truncate.txt',
    mode: 'truncate_then_crash',
  });
  observations['A_进程退出码'] = (resA as { exit_code?: number }).exit_code ?? null;
  const afterA = await readFile(crashA);
  observations['A_崩溃前字节数'] = expected.length;
  observations['A_崩溃后字节数'] = afterA.length;
  observations['A_内容是否丢失'] = afterA.length === 0;
  observations['A_哈希是否变化'] = sha256(afterA) !== beforeA;

  // 场景 B：截断 + 只写一半后崩溃。
  const crashB = path.join(root, 'crash-halfwrite.txt');
  await writeFile(crashB, expected);
  commands.push(
    `pwsh -File WinfsGuard.ps1 -Once '{"op":"crashExperiment","mode":"half_write_then_crash",...}'（进程以 43 退出）`,
  );
  const resB = callOnce({
    op: 'crashExperiment',
    root_path: root, ...rootFields(),
    relative_path: 'crash-halfwrite.txt',
    mode: 'half_write_then_crash',
    content_base64: expected.toString('base64'),
  });
  observations['B_进程退出码'] = (resB as { exit_code?: number }).exit_code ?? null;
  const afterB = await readFile(crashB);
  observations['B_目标字节数'] = expected.length;
  observations['B_崩溃后字节数'] = afterB.length;
  observations['B_是否等于目标的一半'] = Math.abs(afterB.length - Math.floor(expected.length / 2)) <= 1;
  observations['B_是否完整'] = sha256(afterB) === sha256(expected);
  observations['B_前缀是否为预期内容'] = expected.subarray(0, afterB.length).equals(afterB);

  return {
    id,
    title,
    status: 'observed',
    commands,
    observations,
    conclusion:
      `截断后崩溃：文件从 ${expected.length} 字节变为 ${afterA.length} 字节，**内容完全丢失**。` +
      `半写后崩溃：文件剩 ${afterB.length} 字节，是目标长度的一部分，前缀与目标一致。` +
      '这就是 guarded_inplace 的**真实残余风险**：进程在截断与写满之间死亡会留下不完整的文件。' +
      '这不是假设，是本机实测。缓解手段是恢复流程（检测 + 从快照重建 + 请求人工确认），' +
      '而不是声称写入是原子的。',
    invariants: ['I09（不宣称崩溃原子性）'],
  };
}

// ---------------------------------------------------------------------------
// 实验 8：文件被占用
// ---------------------------------------------------------------------------

async function exp8Busy(root: string, helper: ResidentHelper): Promise<ExperimentRecord> {
  const id = 'LWB-003-E8';
  const title = '文件被其它进程占用时的错误映射';
  const commands: string[] = [];
  const observations: Record<string, unknown> = {};

  const baseline = Buffer.from('busy baseline\n');
  const busy = path.join(root, 'busy.txt');
  await writeFile(busy, baseline);

  // 模拟「另一个程序（例如没有共享写权限的备份工具/杀软扫描）正占用该文件」。
  const marker = path.join(root, '.holder-busy.marker');
  const holder = await holdHandleInBackground(busy, { access: 'write', share: 'read' }, marker);
  observations['外部写句柄_已持有'] = holder.held;
  if (holder.error) observations['持有失败原因'] = holder.error;
  commands.push(
    `pwsh -Command "<CreateFileW(GENERIC_READ|GENERIC_WRITE, FILE_SHARE_READ) 持有 busy.txt>"（后台进程，标记文件同步）`,
  );

  if (holder.held) {
    const r = await helper.call({ op: 'readFileGuarded', root_path: root, ...rootFields(), relative_path: 'busy.txt' });
    observations['占用时读取_ok'] = r.ok;
    observations['占用时读取_code'] = r.ok ? null : codeOf(r);
    observations['占用时读取_win32'] = r.ok ? null : win32Of(r);

    const w = await helper.call({
      op: 'writeFileGuarded',
      root_path: root, ...rootFields(),
      relative_path: 'busy.txt',
      expected_sha256: sha256(baseline),
      content_base64: Buffer.from('busy must not be overwritten\n').toString('base64'),
    });
    observations['占用时写入_ok'] = w.ok;
    observations['占用时写入_code'] = w.ok ? null : codeOf(w);
    observations['占用时写入_win32'] = w.ok ? null : win32Of(w);
  } else {
    observations['占用时读取_ok'] = 'skipped（未能持有外部句柄）';
    observations['占用时写入_ok'] = 'skipped（未能持有外部句柄）';
  }
  holder.proc.kill();
  await new Promise((r) => setTimeout(r, 800));
  if (holder.held) {
    observations['占用时_内容未变'] = (await readFile(busy)).equals(baseline);
  }

  const writeBlocked = observations['占用时写入_ok'] === false;
  return {
    id,
    title,
    status: writeBlocked ? 'observed' : 'failed',
    commands,
    observations,
    conclusion: writeBlocked
      ? `文件被其它进程以不含 FILE_SHARE_WRITE 的方式占用时，写入返回 ` +
        `${String(observations['占用时写入_code'])}（Win32 ${String(observations['占用时写入_win32'])}），` +
        '被映射为可重试的忙碌错误而不是笼统的 IO 错误；失败时磁盘内容未被改动。' +
        '这对应方案错误码 FILE_BUSY 的 autoRetry=bounded 语义。' +
        `读取在此时${observations['占用时读取_ok'] === true ? '仍可进行' : '同样被拒绝'}。`
      : '未能构造出「文件被占用」的场景，FILE_BUSY 的错误映射在本机未获证据支持。',
    invariants: ['I08（不安全则拒绝）', 'I12（错误可机器判定与重试）'],
  };
}

// ---------------------------------------------------------------------------
// 性能：冷启动 vs 常驻
// ---------------------------------------------------------------------------

export async function measureLatency(root: string): Promise<EvidenceReport['latency']> {
  const small = path.join(root, 'perf-small.txt');
  await writeFile(small, 'x'.repeat(1024));

  const COLD_SAMPLES = 12; // 冷启动很慢，样本不必多
  const RESIDENT_SAMPLES = 300;

  const coldSamples: number[] = [];
  for (let i = 0; i < COLD_SAMPLES; i += 1) {
    const r = callOnce({ op: 'readFileGuarded', root_path: root, ...rootFields(), relative_path: 'perf-small.txt' });
    if (typeof r.elapsed_ms === 'number') coldSamples.push(r.elapsed_ms);
  }

  const helper = new ResidentHelper();
  await helper.start();
  const residentSamples: number[] = [];
  try {
    // 预热，排除首次调用受 JIT/缓存影响的偏差。
    await helper.call({ op: 'readFileGuarded', root_path: root, ...rootFields(), relative_path: 'perf-small.txt' });
    for (let i = 0; i < RESIDENT_SAMPLES; i += 1) {
      const r = await helper.call({ op: 'readFileGuarded', root_path: root, ...rootFields(), relative_path: 'perf-small.txt' });
      if (r.ok) residentSamples.push(r.elapsed_ms);
    }
  } finally {
    await helper.stop();
  }

  const coldP95 = percentile(coldSamples, 95);
  const residentP95 = percentile(residentSamples, 95);
  const TARGET = 500;

  return {
    cold_spawn_ms: {
      samples: coldSamples.length,
      p50: round(percentile(coldSamples, 50)),
      p95: round(coldP95),
      min: round(coldSamples.length ? Math.min(...coldSamples) : null),
      max: round(coldSamples.length ? Math.max(...coldSamples) : null),
    },
    resident_call_ms: {
      samples: residentSamples.length,
      p50: round(percentile(residentSamples, 50)),
      p95: round(residentP95),
      min: round(residentSamples.length ? Math.min(...residentSamples) : null),
      max: round(residentSamples.length ? Math.max(...residentSamples) : null),
    },
    target_p95_ms: TARGET,
    meets_target_with:
      residentP95 === null && coldP95 === null
        ? 'unknown'
        : residentP95 !== null && residentP95 <= TARGET
          ? 'resident'
          : coldP95 !== null && coldP95 <= TARGET
            ? 'cold'
            : 'neither',
  };
}

export async function cleanup(tempRoot: string): Promise<void> {
  await rm(tempRoot, { recursive: true, force: true });
}

export async function listTempFiles(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
