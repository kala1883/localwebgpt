#requires -Version 7.0
<#
  LWB-003 / LWB-010 Windows 文件系统护栏 —— PowerShell + .NET P/Invoke 实现。

  存在的理由：
  本机没有 Rust / MSVC / Windows SDK，编译型原生模块无法构建。
  但方案的 I05/I06/I10 不变量要求「路径安全必须由逐级句柄与文件身份证明，
  不能用字符串前缀判断」。PowerShell 7 自带 Roslyn，可以通过 Add-Type 编译
  C# 并直接 P/Invoke kernel32，因此可以在**不安装工具链**的前提下执行真实的
  Win32 调用并取得真实证据。

  这不是权宜的伪造品：它调用的是与编译型模块完全相同的 Win32 API，
  并且同样遵守 fail-closed —— 任何一步无法证明安全就返回错误，
  绝不退化成普通的托管文件 API 写入。

  两种运行模式：
    -Once  '<json>'  单次调用（用于测量冷启动开销）
    -Server          常驻模式，按行读取 JSON 请求，每行一个 JSON 响应
#>
param(
  [string]$Once,
  [switch]$Server
)

$ErrorActionPreference = 'Stop'

# 必须同时设置输入与输出的编码。
# 只设 OutputEncoding 时，[Console]::In.ReadLine() 仍按控制台代码页（本机为 936）
# 解码 stdin，于是 "文档/设计说明.md" 会变成 "µûçµíú/..."，
# 表现为「中文路径不存在」这种看似文件系统、实为编码的故障。
# 中文路径夹具（tests/fixtures）正是为了逼出这类问题而存在的。
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$cs = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class LwbWin32
{
    public const uint GENERIC_READ          = 0x80000000;
    public const uint GENERIC_WRITE         = 0x40000000;
    public const uint DELETE_ACCESS         = 0x00010000;
    public const uint FILE_SHARE_READ       = 0x00000001;
    public const uint FILE_SHARE_WRITE      = 0x00000002;
    public const uint FILE_SHARE_DELETE     = 0x00000004;
    public const uint OPEN_EXISTING         = 3;
    public const uint CREATE_NEW            = 1;
    public const uint FILE_FLAG_BACKUP_SEMANTICS  = 0x02000000;
    public const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    public const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    public const uint FILE_ATTRIBUTE_DIRECTORY     = 0x00000010;
    // 云占位文件（OneDrive 按需文件）的两个标志。
    // RECALL_ON_OPEN 表示打开即触发下载 —— 这正是注册阶段**不能**踩的坑。
    public const uint FILE_ATTRIBUTE_RECALL_ON_OPEN        = 0x00040000;
    public const uint FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x00400000;
    public const int  FILE_BEGIN            = 0;
    public const int  FILE_DISPOSITION_INFO_CLASS = 4;
    public const uint VOLUME_NAME_DOS       = 0x0;

    // GetDriveTypeW 的返回值
    public const uint DRIVE_UNKNOWN     = 0;
    public const uint DRIVE_NO_ROOT_DIR = 1;
    public const uint DRIVE_REMOVABLE   = 2;
    public const uint DRIVE_FIXED       = 3;
    public const uint DRIVE_REMOTE      = 4;
    public const uint DRIVE_CDROM       = 5;
    public const uint DRIVE_RAMDISK     = 6;

    [StructLayout(LayoutKind.Sequential)]
    public struct BY_HANDLE_FILE_INFORMATION
    {
        public uint dwFileAttributes;
        public uint ftCreationTimeLow, ftCreationTimeHigh;
        public uint ftLastAccessTimeLow, ftLastAccessTimeHigh;
        public uint ftLastWriteTimeLow, ftLastWriteTimeHigh;
        public uint dwVolumeSerialNumber;
        public uint nFileSizeHigh, nFileSizeLow;
        public uint nNumberOfLinks;
        public uint nFileIndexHigh, nFileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct FILE_DISPOSITION_INFO
    {
        [MarshalAs(UnmanagedType.Bool)]
        public bool DeleteFile;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateFileW")]
    public static extern SafeFileHandle CreateFile(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes,
        uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetFileInformationByHandle(SafeFileHandle h, out BY_HANDLE_FILE_INFORMATION info);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "GetFinalPathNameByHandleW")]
    public static extern uint GetFinalPathNameByHandle(SafeFileHandle h, StringBuilder buf, uint len, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadFile(SafeFileHandle h, byte[] buf, uint toRead, out uint read, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteFile(SafeFileHandle h, byte[] buf, uint toWrite, out uint written, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetFilePointerEx(SafeFileHandle h, long distance, IntPtr newPos, uint method);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetEndOfFile(SafeFileHandle h);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FlushFileBuffers(SafeFileHandle h);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetFileInformationByHandle(
        SafeFileHandle h, int fileInformationClass,
        ref FILE_DISPOSITION_INFO fileInformation, uint bufferSize);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "GetDriveTypeW")]
    public static extern uint GetDriveType(string lpRootPathName);

    /**
     * 按**句柄**取卷信息，而不是按盘符。
     * 按盘符取会在挂载点、目录联接、以及「同一卷挂在两个盘符下」时给出错误答案。
     */
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "GetVolumeInformationByHandleW")]
    public static extern bool GetVolumeInformationByHandle(
        SafeFileHandle h, StringBuilder volumeNameBuf, uint volumeNameSize,
        out uint volumeSerialNumber, out uint maxComponentLength, out uint fsFlags,
        StringBuilder fsNameBuf, uint fsNameSize);

    public static ulong FileIndex(BY_HANDLE_FILE_INFORMATION i)
    {
        return ((ulong)i.nFileIndexHigh << 32) | i.nFileIndexLow;
    }

    public static long FileSize(BY_HANDLE_FILE_INFORMATION i)
    {
        return ((long)i.nFileSizeHigh << 32) | i.nFileSizeLow;
    }

    public static string FinalPath(SafeFileHandle h)
    {
        var sb = new StringBuilder(1024);
        uint n = GetFinalPathNameByHandle(h, sb, (uint)sb.Capacity, VOLUME_NAME_DOS);
        if (n == 0) return null;
        if (n > sb.Capacity)
        {
            sb = new StringBuilder((int)n + 1);
            n = GetFinalPathNameByHandle(h, sb, (uint)sb.Capacity, VOLUME_NAME_DOS);
            if (n == 0) return null;
        }
        return sb.ToString();
    }
}
'@

Add-Type -TypeDefinition $cs -Language CSharp | Out-Null

# 相对路径的语法校验（LWB-010 步骤 1）。护栏侧独立实现，理由见该文件开头。
# 这里 dot-source 而不是内联，是为了让它能被一致性测试单独加载。
. (Join-Path $PSScriptRoot 'path_guard/RelativePath.ps1')

# ---------------------------------------------------------------------------
# 错误类型：携带可机器判定的错误码，绝不用「任何异常都当 IO 错误」糊过去
# ---------------------------------------------------------------------------

class LwbFsException : System.Exception {
  [string]$Code
  [int]$Win32Error
  <#
    写失败之后**在同一句柄里**看到的实际磁盘状态（LWB-027）。默认 $null。

    为什么它是异常上的一个字段，而不是返回值：出现它的场合恰恰是
    「没有一个成功的返回值可返回」。而它承载的信息（文件现在到底剩下
    什么）**比错误码本身更重要** —— 调用方要决定的是「这次写入是没开始、
    还是留下了一个半成品」，而后者必须进入恢复流程、由人来定案。

    第一次出现它的调用是 `Op-WriteFileGuarded`。之所以要在这里写清楚，
    是因为**没有**这个字段的含义很强：它表示这次调用从未进入截断之后的
    区域，也就是「一个字节都没动」—— 而不是「护栏没顾上看」。
    进程被杀这类情形不会产生任何响应，因此不会走到这个字段上。
  #>
  [object]$ActualState = $null
  <#
    「这次调用进入了破坏性区域」这一件事本身（LWB-029）。默认 $false。

    ## 为什么 `ActualState` 单独还不够

    观测是**尽力而为**的（`Get-BoundedActualState` 自己失败时返回 $null），
    而上面那句「没有 `actual_state` 就是一个字节都没动」因此有一个洞：
    **越过那条线之后失败、且观测本身也失败**的调用，会带着一个
    「干净」的失败响应回去 —— 与一次线前失败长得一模一样。

    两类调用的正确处置**相反**：线前失败是「磁盘上什么都没变，报冲突即可」，
    线后失败是「磁盘上可能是半份，必须进恢复」。把它们混在一起，等于让
    调用方在最需要事实的那一格上只能猜。

    所以进入破坏性区域这件事**与观测成败分开记录**：它是护栏在句柄里
    *知道*的事实（`$touched` 这个局部变量），不依赖任何后续读取。
    两个字段的读法因此是：

      - `touched` 为 `$true`  + `actual_state` 有值  ⇒ 动了，现场已知；
      - `touched` 为 `$true`  + `actual_state` 为 $null ⇒ 动了，现场**未知**；
      - `touched` 为 `$false`（或没有这一项）      ⇒ 一个字节都没动。

    第三行仍然是那个强命题，只是它现在由正确的字段承载。
  #>
  [bool]$Touched = $false
  LwbFsException([string]$code, [string]$message, [int]$win32) : base($message) {
    $this.Code = $code
    $this.Win32Error = $win32
  }
}

$SCRIPT:SHARING_VIOLATION = 32
$SCRIPT:FILE_EXISTS = 80
$SCRIPT:ACCESS_DENIED = 5
$SCRIPT:PATH_NOT_FOUND = 3

<#
  单次 listDirectory 返回条目的硬上限。

  为什么**存在**这个上限，而不是让调用方自己夹取：
  一次列举的代价花在**护栏进程物化整份清单**上，而那一刻调用方还什么都没拿到。
  没有上限时，对一个几十万项的目录（Windows 的临时目录、用户目录、node_modules）
  调用一次列举，就会先把几十万个托管对象建出来 —— 内存花掉了就收不回来，
  调用方事后再怎么"夹取"都晚了。因此夹取必须在**枚举发生的地方**做。

  默认值就是硬上限：不存在"不设上限"这个取值。调用方要更多条目就带游标翻页。
#>
$SCRIPT:LIST_HARD_CAP = 1000

<#
  把一条记录按 ordinal 顺序插进有序列表。

  插入位置**从尾部线性回扫**，不写二分。理由不是"懒得写"：
  这个列表的长度被 $SCRIPT:LIST_HARD_CAP 限死在 1001，而 `List.Insert` 本身
  就是 O(k) 的搬移，二分省下的那点比较换不来任何可见的收益，
  却引入了一处真实踩过的坑 —— 原先写的是 `[int](($lo + $hi) / 2)`，
  而 PowerShell 的 `[int]` 转换是**四舍五入**（banker's rounding）而不是截断：
  lo=1、hi=2 时中点算出来是 2 == hi，于是被取的元素越过了搜索区间，
  最后以 `Index must be within the bounds of the List` 收场。
  线性回扫没有这个形态。
#>
function Insert-SortedByName {
  param(
    [System.Collections.Generic.List[object]]$List,
    [hashtable]$Rec
  )
  $at = $List.Count
  while ($at -gt 0 -and [string]::CompareOrdinal($List[$at - 1].name, $Rec.name) -gt 0) {
    $at -= 1
  }
  $List.Insert($at, $Rec)
}

# 期望的根身份。十六进制串：卷序列号 8 位、文件索引 16 位。
$SCRIPT:LWB_VOLUME_ID_RE = '^[0-9a-fA-F]{8}$'
$SCRIPT:LWB_FILE_ID_RE = '^[0-9a-fA-F]{16}$'
# SHA-256 的十六进制拼写。写在**写入之前**的校验里，理由是它决定了一条
# 重要区分：一个形状不对的 `expected_sha256` 会让「基线比对」永远不等，
# 于是一次**调用方自己坏了**的错误会被报成「磁盘与计划不符」（FILE_VERSION
# CONFLICT）—— 而这两件事对操作者的含义完全不同（前者要改代码，后者要重新
# 提案并重新批准）。
$SCRIPT:LWB_SHA256_RE = '^[0-9a-fA-F]{64}$'

<#
  Win32 错误码 -> 契约错误码的唯一映射点。

  必须区分「可提示用户」与「真故障」：把 ERROR_FILE_NOT_FOUND(2)、
  ERROR_PATH_NOT_FOUND(3)、ERROR_DIRECTORY(267) 都映射为 NOT_FOUND，
  否则「父目录不存在」会退化成 IO_ERROR，调用方无法给出正确提示，
  也无法判断是否值得重试。
#>
function Convert-Win32Error([int]$Win32Error) {
  switch ($Win32Error) {
    32      { return @{ Code = 'FILE_BUSY'; Message = '文件被其它进程占用（共享冲突）' } }
    33      { return @{ Code = 'FILE_BUSY'; Message = '文件被其它进程锁定（区域锁）' } }
    80      { return @{ Code = 'FILE_VERSION_CONFLICT'; Message = '文件已存在，CREATE_NEW 拒绝覆盖' } }
    183     { return @{ Code = 'FILE_VERSION_CONFLICT'; Message = '目标已存在' } }
    2       { return @{ Code = 'NOT_FOUND'; Message = '文件不存在' } }
    3       { return @{ Code = 'NOT_FOUND'; Message = '路径不存在（中间目录缺失）' } }
    267     { return @{ Code = 'NOT_FOUND'; Message = '路径中的某一级不是目录' } }
    5       { return @{ Code = 'PERMISSION_DENIED'; Message = '拒绝访问' } }
    1920    { return @{ Code = 'PERMISSION_DENIED'; Message = '无法打开该对象（重解析点或设备对象）' } }
    4390    { return @{ Code = 'LINK_UNSUPPORTED'; Message = '该对象不是普通文件系统对象' } }
    default { return @{ Code = 'IO_ERROR'; Message = "CreateFileW 失败（Win32 $Win32Error）" } }
  }
}

function Get-AttributeNames([uint32]$attrs) {
  $names = @()
  if ($attrs -band 0x00000001) { $names += 'readonly' }
  if ($attrs -band 0x00000002) { $names += 'hidden' }
  if ($attrs -band 0x00000004) { $names += 'system' }
  if ($attrs -band 0x00000010) { $names += 'directory' }
  if ($attrs -band 0x00000020) { $names += 'archive' }
  if ($attrs -band 0x00000400) { $names += 'reparse_point' }
  return $names
}

<#
  「文件身份」这一件事只有这一处定义。

  它是十六进制的**文件索引**（NTFS 的 128 位 File ID），而不是路径：
  改名不改变它，删除重建会改变它。LWB-027 起写入路径要拿它与批准时记下的
  身份比对 —— 两处各写一遍格式化，迟早有一处漏了 `ToLowerInvariant`，
  而那时两次比对照样"通过"，只是永远不等（一个大小写不同的十六进制串）。
#>
function Get-FileIdHex([LwbWin32+BY_HANDLE_FILE_INFORMATION]$info) {
  return ('{0:x16}' -f [LwbWin32]::FileIndex($info)).ToLowerInvariant()
}

function New-Identity([LwbWin32+BY_HANDLE_FILE_INFORMATION]$info) {
  return [ordered]@{
    volume_id  = ('{0:x8}' -f $info.dwVolumeSerialNumber)
    file_id    = (Get-FileIdHex $info)
    link_count = [int]$info.nNumberOfLinks
    size       = [long]([LwbWin32]::FileSize($info))
    attributes = @(Get-AttributeNames $info.dwFileAttributes)
    is_reparse = (($info.dwFileAttributes -band [LwbWin32]::FILE_ATTRIBUTE_REPARSE_POINT) -ne 0)
  }
}

function Get-Sha256Hex([byte[]]$bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

<#
  一次事后观测的**字节上界**（LWB-027）。

  为什么必须有上界：这个函数只在**失败路径**上被调用，而它调用时句柄还开着；
  一个几 GB 的目标文件会让「失败」变成一次几 GB 的读取，于是原本一次干净
  的拒绝会退化成一次内存压力 —— 而它发生在本进程最没有余力的时刻。

  1 MiB 是**观测**的上界，不是可写文件的上界：超过它时报告里 `sha256` 为
  $null，调用方据此知道「这次只看了前面一段」。这个取舍是刻意的：
  宁可给出「大小 + 身份 + 前 1 MiB」并说清它不完整，也不给一个看起来
  完整、实际来路不明的哈希。
#>
$SCRIPT:ACTUAL_STATE_CAP_BYTES = 1048576

<#
  在**仍然持有句柄**的时刻，取一份磁盘上实际状态的**有界**观测。

  它回答的问题是「这次失败之后，文件到底剩下什么」，而不是「怎么把它改回去」。
  恢复与定案（把操作送到 APPLIED 或 ROLLED_BACK）是 LWB-030 的职责，
  本函数刻意**不写任何字节**：一次失败的写入之后再自动改回来，是凭空多出
  的第二次写 —— 而它同样可能失败、同样会留下没人批准过的内容。

  尽力而为：观测本身失败时返回 $null，**绝不**覆盖掉原来那个错误。
#>
function Get-BoundedActualState($Handle) {
  try {
    $info = New-Object LwbWin32+BY_HANDLE_FILE_INFORMATION
    if (-not [LwbWin32]::GetFileInformationByHandle($Handle, [ref]$info)) { return $null }
    $size = [long]([LwbWin32]::FileSize($info))
    $want = [int][Math]::Min($size, [long]$SCRIPT:ACTUAL_STATE_CAP_BYTES)

    $hash = $null
    $observed = 0
    if ($want -eq 0) {
      # 空文件的哈希是有意义的（e3b0c442…），不能与「没看到」混为一谈。
      if ($size -eq 0) { $hash = (Get-Sha256Hex (New-Object byte[] 0)) }
    } else {
      if ([LwbWin32]::SetFilePointerEx($Handle, 0, [IntPtr]::Zero, [LwbWin32]::FILE_BEGIN)) {
        $buf = New-Object byte[] $want
        $read = [uint32]0
        if ([LwbWin32]::ReadFile($Handle, $buf, [uint32]$want, [ref]$read, [IntPtr]::Zero)) {
          $n = [int]$read
          if ($n -gt 0) {
            $observed = $n
            # 只对**读全了**的那一段求哈希。部分读的哈希描述的是半份字节，
            # 而它会在报告里长得和完整哈希一模一样。
            if ($n -eq $want) {
              $slice = New-Object byte[] $n
              [Array]::Copy($buf, $slice, $n)
              $hash = (Get-Sha256Hex $slice)
            }
          }
        }
      }
    }

    return [ordered]@{
      size            = $size
      identity        = (New-Identity $info)
      sha256          = $hash
      observed_bytes  = $observed
      cap_bytes       = [int]$SCRIPT:ACTUAL_STATE_CAP_BYTES
      observed_at_utc = [DateTime]::UtcNow.ToString('o')
    }
  } catch { return $null }
}

# ---------------------------------------------------------------------------
# 逐级句柄固定
# ---------------------------------------------------------------------------

<#
  逐级打开祖先目录，每一级都：
    1. 以 FILE_FLAG_OPEN_REPARSE_POINT 打开（不跟随重解析点），
    2. 检查属性里是否有 FILE_ATTRIBUTE_REPARSE_POINT -> 有则拒绝，
    3. 用 GetFinalPathNameByHandleW 取回内核认定的真实路径并与预期比对。

  这是方案 §5.3 的「逐级句柄固定」。
#>
<#
  路径比较键。`\\?\` 前缀与末尾分隔符都不参与比较；大小写不敏感（Windows 语义）。
  盘符根 `C:\` 归一为 `C:\`（不是 `C:`），避免与盘符相对路径 `C:` 混淆。
#>
function Get-PathCompareKey([string]$Path) {
  $p = $Path -replace '^\\\\\?\\', ''
  if ($p -match '^[A-Za-z]:\\?$') { return $p.Substring(0, 2).ToUpperInvariant() + '\' }
  return $p.TrimEnd('\').ToLowerInvariant()
}

<#
  打开一个目录并**持有**它，且不允许别人改它的名字。

  `FILE_SHARE_DELETE` 是这里唯一真正的机制，不是防御性写法：
  重命名或删除一个对象需要对该对象的 DELETE 权限，而我们不在共享模式里给出它，
  于是持有句柄期间任何 rename/delete 都会以共享冲突失败。这让
  「并发交换父目录」在**结构上**不可能，而不是「窗口很小」。

  之前这里给的是 `SHARE_READ|WRITE|DELETE`，而且**立刻 Dispose** ——
  两者合起来意味着：祖先链检查完之后，任何人都可以把它改名换掉，
  后续按路径字符串打开的就是另一个对象了。这正是验收标准 2 要挡的事。
#>
function Open-PinnedDirectory([string]$Path, [string]$Label) {
  $h = [LwbWin32]::CreateFile(
    $Path,
    [LwbWin32]::GENERIC_READ,
    ([LwbWin32]::FILE_SHARE_READ -bor [LwbWin32]::FILE_SHARE_WRITE),
    [IntPtr]::Zero,
    [LwbWin32]::OPEN_EXISTING,
    ([LwbWin32]::FILE_FLAG_BACKUP_SEMANTICS -bor [LwbWin32]::FILE_FLAG_OPEN_REPARSE_POINT),
    [IntPtr]::Zero)

  if ($h.IsInvalid) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $mapped = Convert-Win32Error -Win32Error $err
    throw [LwbFsException]::new($mapped.Code, "$Label（$($mapped.Message)）：$Path", $err)
  }
  return $h
}

<#
  取句柄的属性与身份，并做两条基础判定：
    1. 不是重解析点 —— 否则字符串前缀仍然「看起来」在工作区内，
       真实对象已经在别处（I03 要挡的正是这件事）。
    2. 句柄的真实规范路径与预期一致 —— 大小写、分隔符、`\\?\` 前缀不参与比较。
       8.3 短名（`PROGRA~1`）在这里会**不一致**而拒绝，方向是 fail-closed：
       同一个对象有两种写法本身就会让基于路径的比较失效。

  下面几条消息里一律写 `${Label}` 而不是 `$Label`，这不是风格偏好：
  PowerShell 的变量名允许 CJK 字母，`"$Label是重解析点"` 会被解析成
  一个名为 `Label是重解析点` 的变量（值为 $null），于是拒绝理由前半截
  **静默消失**，只剩「（Junction / 符号链接 / 云占位），拒绝继续：…」。
  实测（本文件 LWB-010 期间踩到过一次）：三类消息全部丢了主语，
  而功能仍然"正常拒绝" —— 只有断言消息内容的用例才发现。
  变量名后面紧跟非 ASCII 字符时，一律用 `${}` 划清边界。
#>
function Assert-HandleMatches([Microsoft.Win32.SafeHandles.SafeFileHandle]$Handle, [string]$Expected, [string]$Label) {
  $info = New-Object LwbWin32+BY_HANDLE_FILE_INFORMATION
  if (-not [LwbWin32]::GetFileInformationByHandle($Handle, [ref]$info)) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw [LwbFsException]::new('IO_ERROR', "GetFileInformationByHandle 失败：$Expected", $err)
  }

  if (($info.dwFileAttributes -band [LwbWin32]::FILE_ATTRIBUTE_REPARSE_POINT) -ne 0) {
    throw [LwbFsException]::new(
      'LINK_UNSUPPORTED',
      "${Label}是重解析点（Junction / 符号链接 / 云占位），拒绝继续：$Expected",
      0)
  }

  $final = [LwbWin32]::FinalPath($Handle)
  if ($null -eq $final) {
    # 取不到内核认定的真实路径 -> 无法证明，拒绝。绝不「拿不到就跳过这一步」。
    throw [LwbFsException]::new(
      'PATH_UNSAFE',
      "${Label}无法取得规范路径，不能证明其身份，拒绝：$Expected",
      0)
  }
  if ((Get-PathCompareKey $final) -ne (Get-PathCompareKey $Expected)) {
    throw [LwbFsException]::new(
      'PATH_UNSAFE',
      "${Label}的句柄真实路径与预期不一致：预期 $Expected，内核返回 $final",
      0)
  }
  return $info
}

<#
  目标相对于工作区根的**磁盘规范拼写**。

  为什么不能直接把调用方给的 `relative_path` 回显到回执里：
  NTFS 大小写不敏感，`ALPHA.TXT` 与磁盘上的 `Alpha.txt` 是**同一个对象**，
  但它们是两个不同的字符串。回执里写 `ALPHA.TXT`，任何人拿去和目录一比对
  都会发现"这个文件不存在" —— 一份核不动的回执没有意义（I14）。
  8.3 短名同理：`ALPHA~1.TXT` 能打开同一个对象，但它不是它的名字。

  两个规范路径都取自 `GetFinalPathNameByHandleW`，因此同一条目录链在两者中的
  拼写必然一致，前缀比较是可靠的（而不是"在字符串层面猜"）。
  取不到、或证明不了目标在根之下时返回 `$null` —— 调用方此时不应给出规范路径，
  也不能退回去回显请求里的那个字符串。
#>
function Get-CanonicalRelativePath {
  param(
    [Microsoft.Win32.SafeHandles.SafeFileHandle]$RootHandle,
    [Microsoft.Win32.SafeHandles.SafeFileHandle]$TargetHandle
  )

  $canonRoot = [LwbWin32]::FinalPath($RootHandle)
  $canonTarget = [LwbWin32]::FinalPath($TargetHandle)
  if ($null -eq $canonRoot -or $null -eq $canonTarget) { return $null }

  $r = $canonRoot -replace '^\\\\\?\\', ''
  $t = $canonTarget -replace '^\\\\\?\\', ''
  if ((Get-PathCompareKey $t) -eq (Get-PathCompareKey $r)) { return '' }

  $prefix = $r.TrimEnd('\') + '\'
  if ($t.Length -le $prefix.Length) { return $null }
  if ((Get-PathCompareKey $t.Substring(0, $prefix.Length)) -ne (Get-PathCompareKey $prefix)) {
    return $null
  }
  return ($t.Substring($prefix.Length) -replace '\\', '/')
}

<#
  解析工作区内目标，并**整条链**都持有句柄到调用方用完为止。

  返回 @{ handles = @(祖先句柄，由外向内); target_path = '...'; root_is_directory = $bool }

  调用方必须在 finally 里释放 `handles`。顺序是刻意的：先开完祖先并**持住**，
  再开目标 —— 若反过来（先开目标再核祖先），中间就有一个可以交换目录的窗口。
#>
function Open-GuardedChain {
  param(
    [string]$RootPath,
    [string[]]$Segments,
    [string]$ExpectVolumeId,
    [string]$ExpectFileId,
    # 允许「0 段 + 目录根」，即目标就是工作区根自己。只有 listDirectory 传它。
    [switch]$AllowEmptyTarget
  )

  $handles = [System.Collections.Generic.List[object]]::new()
  try {
    # --- 1. 盘符根到工作区根之间的每一级 -------------------------------------
    # 工作区根自己也可能被改名换掉，因此它**上面**的每一级同样要钉住。
    $rootKey = Get-PathCompareKey $RootPath
    $driveRoot = $RootPath.Substring(0, 3)          # 'C:\'
    if ($rootKey -ne (Get-PathCompareKey $driveRoot)) {
      $hDrive = Open-PinnedDirectory -Path $driveRoot -Label '打开盘符根失败'
      $handles.Add($hDrive)
      [void](Assert-HandleMatches -Handle $hDrive -Expected $driveRoot -Label '盘符根')

      $rel = $RootPath.Substring(3).TrimEnd('\')
      if ($rel.Length -gt 0) {
        $expected = $driveRoot
        $parts = $rel.Split([char]'\')
        for ($i = 0; $i -lt $parts.Length - 1; $i++) {
          $expected = Join-Path $expected $parts[$i]
          $h = Open-PinnedDirectory -Path $expected -Label '打开祖先目录失败'
          $handles.Add($h)
          [void](Assert-HandleMatches -Handle $h -Expected $expected -Label '工作区根的祖先目录')
        }
      }
    }

    # --- 2. 工作区根本身：身份必须与调用方声明的完全一致 ----------------------
    # 这一条关掉的是「daemon 刚重新探测过根身份，护栏拿到请求时根已被换掉」
    # 这个窗口。仅比对路径字符串挡不住它 —— 换掉之后路径字符串一模一样。
    $hRoot = Open-PinnedDirectory -Path $RootPath -Label '打开工作区根失败'
    $handles.Add($hRoot)
    $rootInfo = New-Object LwbWin32+BY_HANDLE_FILE_INFORMATION
    if (-not [LwbWin32]::GetFileInformationByHandle($hRoot, [ref]$rootInfo)) {
      $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw [LwbFsException]::new('IO_ERROR', "取工作区根信息失败：$RootPath", $err)
    }
    $rootIsDirectory = (($rootInfo.dwFileAttributes -band [LwbWin32]::FILE_ATTRIBUTE_DIRECTORY) -ne 0)
    if ($rootIsDirectory) {
      [void](Assert-HandleMatches -Handle $hRoot -Expected $RootPath -Label '工作区根')
    } elseif (($rootInfo.dwFileAttributes -band [LwbWin32]::FILE_ATTRIBUTE_REPARSE_POINT) -ne 0) {
      throw [LwbFsException]::new('LINK_UNSUPPORTED', "工作区根是重解析点，拒绝：$RootPath", 0)
    }

    $actualVolume = ('{0:x8}' -f $rootInfo.dwVolumeSerialNumber)
    $actualFileId = (Get-FileIdHex $rootInfo)
    if ($actualVolume -ne $ExpectVolumeId.ToLowerInvariant() -or
        $actualFileId -ne $ExpectFileId.ToLowerInvariant()) {
      throw [LwbFsException]::new(
        'ROOT_IDENTITY_MISMATCH',
        "工作区根不是被授权的那一个对象：期望 $ExpectVolumeId/$ExpectFileId，" +
        "实际 $actualVolume/$actualFileId。拒绝按路径继续（路径字符串相同不代表对象相同）。",
        0)
    }

    if (-not $rootIsDirectory) {
      # 单文件工作区：根就是那个文件，它没有子项。
      if ($Segments.Length -eq 0) {
        return [ordered]@{
          handles = $handles; target_path = $RootPath
          root_handle = $hRoot; root_is_directory = $false
        }
      }
      throw [LwbFsException]::new(
        'PATH_UNSAFE',
        "工作区根是一个文件，其中不存在相对路径：$RootPath",
        0)
    }
    if ($Segments.Length -eq 0) {
      if (-not $AllowEmptyTarget) {
        throw [LwbFsException]::new(
          'PATH_UNSAFE',
          "相对路径为空，而工作区根是一个目录：$RootPath。" +
          '本操作需要一个具体目标；列举根目录请用 listDirectory。',
          0)
      }
      return [ordered]@{
        handles = $handles; target_path = $RootPath
        root_handle = $hRoot; root_is_directory = $true
      }
    }

    # --- 3. 目标之前的每一级中间目录 -----------------------------------------
    $expected = $RootPath
    for ($i = 0; $i -lt $Segments.Length - 1; $i++) {
      $expected = Join-Path $expected $Segments[$i]
      $h = Open-PinnedDirectory -Path $expected -Label '打开祖先目录失败'
      $handles.Add($h)
      [void](Assert-HandleMatches -Handle $h -Expected $expected -Label '祖先目录')
    }

    $target = Join-Path $expected $Segments[$Segments.Length - 1]
    return [ordered]@{
      handles = $handles; target_path = $target
      root_handle = $hRoot; root_is_directory = $true
    }
  } catch {
    foreach ($h in $handles) { $h.Dispose() }
    throw
  }
}

<#
  校验请求里的路径字段，返回可用的相对路径段。

  `root_volume_id` / `root_file_id` 是**必需**的：护栏不接受「按路径打开一个
  看起来像工作区根的东西」。调用方（daemon）从 `authorizeAccess` 拿到这两个值，
  护栏用它们证明自己操作的是被授权的那个对象（I05）。
#>
function Resolve-Target {
  param($req)

  $root = [string]$req.root_path
  if ([string]::IsNullOrWhiteSpace($root)) {
    throw [LwbFsException]::new('INVALID_ARGUMENT', 'root_path 不能为空', 0)
  }
  if ($root -notmatch '^[A-Za-z]:\\' -and $root -notmatch '^[A-Za-z]:$') {
    throw [LwbFsException]::new('INVALID_ARGUMENT', "root_path 必须是完全限定的绝对路径：$root", 0)
  }

  $volumeId = [string]$req.root_volume_id
  $fileId = [string]$req.root_file_id
  if ($volumeId -notmatch $SCRIPT:LWB_VOLUME_ID_RE) {
    throw [LwbFsException]::new('INVALID_ARGUMENT',
      "root_volume_id 必须是 8 位十六进制卷序列号，实际：'$volumeId'", 0)
  }
  if ($fileId -notmatch $SCRIPT:LWB_FILE_ID_RE) {
    throw [LwbFsException]::new('INVALID_ARGUMENT',
      "root_file_id 必须是 16 位十六进制文件索引，实际：'$fileId'", 0)
  }

  # 显式空串在这里**放行**，交给 Open-GuardedChain 按「根是文件还是目录」裁决。
  #
  # 为什么不在这里判：这里不知道根是文件还是目录，而答案取决于它 ——
  #   单文件工作区：空串是**唯一**的寻址方式（根就是那个文件）；
  #   目录工作区：空串表示「根目录自己」，只有 listDirectory 认。
  # 在一个拿不到所需信息的地方下判断，正是本文件一直在避免的形态。
  #
  # 注意 `null` / 字段缺失**不**等于空串：前者仍然按 NOT_A_STRING 拒绝。
  # 「没给路径」被当成「整个工作区」正是要避免的静默扩大（I02 的形态）。
  $relRaw = $req.relative_path
  $isEmptyString = ($relRaw -is [string]) -and ([string]$relRaw).Length -eq 0
  if ($isEmptyString -and $req.ContainsKey('relative_path')) {
    return [ordered]@{ segments = @(); root = $root; volume_id = $volumeId; file_id = $fileId }
  }

  $verdict = Test-LwbRelativePath -Path $relRaw
  if (-not $verdict.ok) {
    throw [LwbFsException]::new('PATH_UNSAFE', "[$($verdict.reason)] $($verdict.detail)", 0)
  }

  return [ordered]@{ segments = @($verdict.segments); root = $root; volume_id = $volumeId; file_id = $fileId }
}

# ---------------------------------------------------------------------------
# 操作实现
# ---------------------------------------------------------------------------

function Open-Guarded {
  param(
    [string]$Path,
    [uint32]$Access,
    [uint32]$Share,
    [uint32]$Creation
  )

  # FILE_FLAG_BACKUP_SEMANTICS **无条件**设置。
  #
  # 目录必须以它打开（否则得到 ERROR_ACCESS_DENIED，把「打不开」误报成
  # 「路径不安全」）。早先的写法是先按路径问一次「这是不是目录」再决定要不要
  # 加这个标志 —— 那是一次**按路径**的判定，而本文件存在的全部意义就是不用
  # 路径做判定。实测普通文件带该标志同样能正常打开（err=0），
  # 于是这个分支连同它的 TOCTOU 窗口一起消失了。
  #
  # FILE_FLAG_OPEN_REPARSE_POINT 照旧：不跟随重解析点。
  $flags = [LwbWin32]::FILE_FLAG_OPEN_REPARSE_POINT -bor [LwbWin32]::FILE_FLAG_BACKUP_SEMANTICS

  $h = [LwbWin32]::CreateFile($Path, $Access, $Share, [IntPtr]::Zero, $Creation,
    $flags, [IntPtr]::Zero)
  if ($h.IsInvalid) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $mapped = Convert-Win32Error -Win32Error $err
    throw [LwbFsException]::new($mapped.Code, "$($mapped.Message)`：$Path", $err)
  }
  return $h
}

function Op-ReadFileGuarded {
  param($req)
  $t = Resolve-Target -req $req
  $rel = [string]$req.relative_path

  $chain = Open-GuardedChain -RootPath $t.root -Segments $t.segments `
    -ExpectVolumeId $t.volume_id -ExpectFileId $t.file_id
  try {
    $full = $chain.target_path

    # 共享模式刻意**不含** FILE_SHARE_WRITE：
    # 持有该句柄期间，其它进程无法获得写权限，从而把
    # 「我们读完、别人写入、我们再写」的窗口从根上关掉。
    # 也不含 FILE_SHARE_DELETE：重命名/删除同样需要 DELETE 权限。
    $h = Open-Guarded -Path $full -Access ([LwbWin32]::GENERIC_READ) `
      -Share ([LwbWin32]::FILE_SHARE_READ) -Creation ([LwbWin32]::OPEN_EXISTING)
    try {
      # 重解析点与规范路径都在这里判（Assert-HandleMatches）。
      $info = Assert-HandleMatches -Handle $h -Expected $full -Label '目标'
      if (($info.dwFileAttributes -band [LwbWin32]::FILE_ATTRIBUTE_DIRECTORY) -ne 0) {
        throw [LwbFsException]::new('INVALID_ARGUMENT', "目标是目录，不是文件：$full", 0)
      }

      $size = [LwbWin32]::FileSize($info)
      $buf = New-Object byte[] ([int]$size)
      $read = [uint32]0
      if ($size -gt 0) {
        if (-not [LwbWin32]::ReadFile($h, $buf, [uint32]$size, [ref]$read, [IntPtr]::Zero)) {
          $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
          throw [LwbFsException]::new('IO_ERROR', 'ReadFile 失败', $err)
        }
      }
      if ($read -ne $size) {
        throw [LwbFsException]::new('IO_ERROR', "读取字节数不符：预期 $size，实际 $read", 0)
      }

      $identity = New-Identity $info
      return [ordered]@{
        ok            = $true
        relative_path = $rel
        canonical_relative_path = (Get-CanonicalRelativePath -RootHandle $chain.root_handle -TargetHandle $h)
        absolute_path = $full
        identity      = $identity
        size          = $size
        sha256        = (Get-Sha256Hex $buf)
        bytes_base64  = [Convert]::ToBase64String($buf)
      }
    } finally { $h.Dispose() }
  } finally { foreach ($x in $chain.handles) { $x.Dispose() } }
}

<#
  方案 §5.4 的 guarded_inplace 写入：
  在**同一个独占句柄**内完成 校验基线 -> 截断 -> 写入 -> 刷盘 -> 回读。
  它不提供崩溃原子性，也不提供跨文件 ACID。残余风险见 ADR-002。

  ## 句柄内的校验清单，以及每一项**在哪里**

  任务书 §LWB-027 步骤 2 要求「在同一句柄内验证文件 ID、硬链接、哈希、编码和权限」。
  五项里有四项在这里，第五项（编码）刻意**不在**这里：

  | 项 | 在哪 | 为什么 |
  | --- | --- | --- |
  | 文件 ID | 本函数（`expected_file_id`） | 只有句柄知道自己在哪个对象上；路径字符串不知道 |
  | 硬链接 | 本函数（`nNumberOfLinks`） | 同上，且它是 NTFS 的元数据 |
  | 哈希 | 本函数（读回当前字节再比） | 必须与写入共用**同一个**句柄，否则中间有窗口 |
  | 权限 | 打开句柄本身 | 见下 |
  | 编码 | 调用方（`@lwb/files` 的 `inspectBytes`） | 编码规则只有一份定义；在这里再写一遍就是第二份 |

  「权限」那一项没有单独的检查，这是**实测的结论**而不是遗漏：属性为只读的
  文件在 `CreateFile(GENERIC_READ|GENERIC_WRITE)` 就失败
  （Win32 5 / ERROR_ACCESS_DENIED → `PERMISSION_DENIED`），文件一个字节都没动。
  见 `docs/evidence/lwb-027/`。一个「打开之后再看一眼只读属性」的检查会在
  这条路径上永远走不到，而**走不到的检查**比没有检查更糟：它让人以为
  那句话有人验过。

  ## 失败之后：有界观测，而不是回滚

  截断之后任何一步失败，都会先在**仍然持有句柄**的时刻取一份实际状态
  （`Get-BoundedActualState`），再抛出去。调用方的报告里因此带上了
  「文件现在到底剩下什么」，而不是只能猜。这个函数**不**把旧内容写回去：
  一次失败的写入之后再自动写一次，是凭空多出的第二次写 —— 它同样可能失败，
  同样会留下没人批准过的内容。定案属 LWB-030。
#>
function Op-WriteFileGuarded {
  param($req)
  $expected = ([string]$req.expected_sha256).ToLowerInvariant()
  if ($expected -notmatch $SCRIPT:LWB_SHA256_RE) {
    throw [LwbFsException]::new('INVALID_ARGUMENT',
      "expected_sha256 必须是 64 位十六进制串，实际：'$expected'", 0)
  }
  $expectedFileId = ([string]$req.expected_file_id).ToLowerInvariant()
  if ($expectedFileId -ne '' -and $expectedFileId -notmatch $SCRIPT:LWB_FILE_ID_RE) {
    throw [LwbFsException]::new('INVALID_ARGUMENT',
      "expected_file_id 必须是 16 位十六进制串，实际：'$expectedFileId'", 0)
  }
  $payload = $null
  try { $payload = [Convert]::FromBase64String([string]$req.content_base64) }
  catch {
    throw [LwbFsException]::new('INVALID_ARGUMENT', 'content_base64 不是合法的 base64', 0)
  }
  $t = Resolve-Target -req $req
  $rel = [string]$req.relative_path

  $chain = Open-GuardedChain -RootPath $t.root -Segments $t.segments `
    -ExpectVolumeId $t.volume_id -ExpectFileId $t.file_id
  try {
    $full = $chain.target_path

    $h = Open-Guarded -Path $full -Access ([LwbWin32]::GENERIC_READ -bor [LwbWin32]::GENERIC_WRITE) `
      -Share ([LwbWin32]::FILE_SHARE_READ) -Creation ([LwbWin32]::OPEN_EXISTING)
    try {
      $infoBefore = Assert-HandleMatches -Handle $h -Expected $full -Label '目标'
      if (($infoBefore.dwFileAttributes -band [LwbWin32]::FILE_ATTRIBUTE_DIRECTORY) -ne 0) {
        throw [LwbFsException]::new('INVALID_ARGUMENT', "目标是目录，不是文件：$full", 0)
      }
      # 硬链接：对象在工作区内有名字，但同一个对象在工作区**外**还有别的名字。
      # NTFS 的文件没有「父目录」概念，写入会同时改变那个外面的名字 ——
      # 因此写一律拒绝。读不拒绝：读到的确实是工作区内的一个对象。
      if ([int]$infoBefore.nNumberOfLinks -gt 1) {
        throw [LwbFsException]::new('LINK_UNSUPPORTED',
          "文件存在 $($infoBefore.nNumberOfLinks) 个硬链接；写入会影响工作区外对象，拒绝", 0)
      }

      # --- 步骤 0：对象身份（文件 ID）------------------------------------------
      # 先判身份再判内容。反过来的话，「同名位置上换了一个内容**恰好相同**的
      # 对象」会一路通过到写入 —— 而它是一次真实发生的操作序列：
      # 删除 + 重建（编辑器保存、git checkout、解压覆盖都会这么做）会得到一个
      # 新的 File ID，内容可能与原对象逐字节相同。批准针对的是**那一个**对象，
      # 因此这种情形必须停在写入之前，而不是「内容一样所以无所谓」。
      #
      # 缺省（空串）表示调用方没有身份可比 —— 那是 LWB-027 之前的调用形态。
      # 不因此放行别的检查：哈希、硬链接、路径仍然逐项在判。
      if ($expectedFileId -ne '') {
        $actualFileId = (Get-FileIdHex $infoBefore)
        if ($actualFileId -ne $expectedFileId) {
          throw [LwbFsException]::new('FILE_VERSION_CONFLICT',
            "目标对象已不是被批准的那一个：期望文件 ID $expectedFileId，实际 $actualFileId" +
            '（改名不改变文件 ID，删除重建会）。拒绝写入，未改动任何字节。', 0)
        }
      }

      # --- 步骤 1：在句柄内读取当前字节并比对基线哈希 ---------------------------
      $sizeBefore = [LwbWin32]::FileSize($infoBefore)
      $bufBefore = New-Object byte[] ([int]$sizeBefore)
      $readBefore = [uint32]0
      if ($sizeBefore -gt 0) {
        if (-not [LwbWin32]::ReadFile($h, $bufBefore, [uint32]$sizeBefore, [ref]$readBefore, [IntPtr]::Zero)) {
          $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
          throw [LwbFsException]::new('IO_ERROR', '基线读取失败', $err)
        }
      }
      $actual = Get-Sha256Hex $bufBefore
      if ($actual -ne $expected) {
        throw [LwbFsException]::new('FILE_VERSION_CONFLICT',
          "基线哈希不符：预期 $expected，磁盘实际 $actual", 0)
      }

      # --- 步骤 2~4：截断 → 写入 → 刷盘 → 回读 --------------------------------
      # 破坏性区域整个在 `Invoke-GuardedRewrite` 里，包括「越过那条线之后
      # 失败该怎么办」。放在这里会让本函数的线性流程被一层 try/catch 劈开，
      # 而那段处理与步骤 1 之前的任何校验都无关。
      $rewrite = Invoke-GuardedRewrite -Handle $h -Payload $payload -InfoBefore $infoBefore

      return [ordered]@{
        ok              = $true
        relative_path   = $rel
        canonical_relative_path = (Get-CanonicalRelativePath -RootHandle $chain.root_handle -TargetHandle $h)
        absolute_path   = $full
        identity_before = (New-Identity $infoBefore)
        identity_after  = $rewrite.identity_after
        before_sha256   = $actual
        after_sha256    = $rewrite.after_sha256
        target_sha256   = $rewrite.target_sha256
        readback_ok     = $rewrite.readback_ok
        flushed         = $rewrite.flushed
        bytes_written   = $rewrite.bytes_written
      }
    } finally { $h.Dispose() }
  } finally { foreach ($x in $chain.handles) { $x.Dispose() } }
}

<#
  一次写入：把 Payload 全部写下去，**少一个字节就报错**。

  「少写了」与「写失败」是两件事，而 `WriteFile` 成功返回但写少了正是
  最容易被漏掉的那一种：调用方拿到的是「成功」，而磁盘上是半份内容。
  写入路径与创建路径共用这一处，因此两条路的字节数判据不可能不一样。
#>
function Invoke-GuardedWrite($Handle, [byte[]]$Payload) {
  $written = [uint32]0
  if ($Payload.Length -gt 0) {
    if (-not [LwbWin32]::WriteFile($Handle, $Payload, [uint32]$Payload.Length, [ref]$written, [IntPtr]::Zero)) {
      $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw [LwbFsException]::new('IO_ERROR', 'WriteFile 失败', $err)
    }
    if ($written -ne $Payload.Length) {
      throw [LwbFsException]::new('IO_ERROR', "写入字节数不符：预期 $($Payload.Length)，实际 $written", 0)
    }
  }
  return [int]$written
}

<#
  回读验证：把句柄挪回开头，读回**全部**字节，与本该写下去的那一份比对。

  写入路径与创建路径都必须走它，且判据只能有一处：验收标准在两边是同一句
  （「回读哈希等于已批准的新哈希」），两处各写一遍的必然结果是其中一处
  少比一个字段 —— 而那一处会以「写成功了」的样子出现在日志里。

  读回来的长度也要核。`ReadFile` 成功但读少了同样会给出一个「成功」，
  而它的哈希描述的是半份字节，却长得和完整哈希一模一样。
#>
function Invoke-GuardedReadback($Handle, [byte[]]$Payload) {
  if (-not [LwbWin32]::SetFilePointerEx($Handle, 0, [IntPtr]::Zero, [LwbWin32]::FILE_BEGIN)) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw [LwbFsException]::new('IO_ERROR', 'SetFilePointerEx(回读) 失败', $err)
  }
  $infoAfter = New-Object LwbWin32+BY_HANDLE_FILE_INFORMATION
  [void][LwbWin32]::GetFileInformationByHandle($Handle, [ref]$infoAfter)
  $sizeAfter = [LwbWin32]::FileSize($infoAfter)
  $bufAfter = New-Object byte[] ([int]$sizeAfter)
  $readAfter = [uint32]0
  if ($sizeAfter -gt 0) {
    if (-not [LwbWin32]::ReadFile($Handle, $bufAfter, [uint32]$sizeAfter, [ref]$readAfter, [IntPtr]::Zero)) {
      $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw [LwbFsException]::new('IO_ERROR', '回读失败', $err)
    }
    if ($readAfter -ne $sizeAfter) {
      throw [LwbFsException]::new('IO_ERROR', "回读字节数不符：预期 $sizeAfter，实际 $readAfter", 0)
    }
  }
  $afterHash = Get-Sha256Hex $bufAfter
  $targetHash = Get-Sha256Hex $Payload
  return [ordered]@{
    identity_after = (New-Identity $infoAfter)
    after_sha256   = $afterHash
    target_sha256  = $targetHash
    readback_ok    = ($afterHash -eq $targetHash)
  }
}

<#
  破坏性区域：截断 → 写入 → 刷盘 → 回读。**必须在已经打开的写句柄上调用。**

  单独成一个函数的理由不是「短一点」，而是因为「越过那条线之后失败怎么办」
  只能有一处实现。那条线画在 `SetEndOfFile` 的**调用之前**：

   - 线**之前**的失败（身份、硬链接、基线哈希、路径）意味着「一个字节都没动」，
     这是**已知的**，不是「没看」—— 因此那些失败既不带 `actual_state`，
     也不带 `touched`；
   - 线**之后**的失败会先在同一句柄里取一份实际状态再抛出去。`SetEndOfFile`
     自己就可能失败，而它失败时文件大小是「可能变了、也可能没有」，
     那正是要去看一眼的场合。

  因此**可以依赖的事实**是「`touched` 缺席 ⇒ 一个字节都没动」，
  而不是「没有 `actual_state` ⇒ 没动过」—— 观测是尽力而为的，
  「动过但没观测到」必须能与「没动过」区分开（见 `LwbFsException.Touched`）。
  调用方据此区分「没写成」(conflict)、「动过且现场已知」与
  「动过但现场未知」（后两者都必须进恢复）。
#>
function Invoke-GuardedRewrite {
  param($Handle, [byte[]]$Payload, $InfoBefore)
  $touched = $false
  try {
    if (-not [LwbWin32]::SetFilePointerEx($Handle, 0, [IntPtr]::Zero, [LwbWin32]::FILE_BEGIN)) {
      $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw [LwbFsException]::new('IO_ERROR', 'SetFilePointerEx 失败', $err)
    }
    $touched = $true
    if (-not [LwbWin32]::SetEndOfFile($Handle)) {
      $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw [LwbFsException]::new('IO_ERROR', 'SetEndOfFile(截断) 失败', $err)
    }
    $written = Invoke-GuardedWrite -Handle $Handle -Payload $Payload

    # --- 刷盘 ---------------------------------------------------------------
    # `FlushFileBuffers` 失败**不**上抛：它返回 false 表示「刷盘没能完成」，
    # 而文件内容已经在页缓存里 —— 那是「刷盘没成功」，不是「内容不对」。
    # 如实把 `flushed=false` 交回去，由上层决定要不要因此报成功。
    $flushed = [LwbWin32]::FlushFileBuffers($Handle)

    $readback = Invoke-GuardedReadback -Handle $Handle -Payload $Payload

    return [ordered]@{
      identity_after = $readback.identity_after
      after_sha256   = $readback.after_sha256
      target_sha256  = $readback.target_sha256
      readback_ok    = $readback.readback_ok
      flushed        = [bool]$flushed
      bytes_written  = $written
    }
  } catch {
    if ($touched -and $_.Exception -is [LwbFsException]) {
      # 「动过」先记，而且**不看观测的成败**：越过了那条线就是越过了，
      # 观测失败只能说明现场未知，不能说明没动过（见 `LwbFsException.Touched`）。
      $_.Exception.Touched = $true
      $state = Get-BoundedActualState -Handle $Handle
      if ($null -ne $state) { $_.Exception.ActualState = $state }
    }
    throw
  }
}

<#
  删除：按**同一句柄**核对路径、对象身份、硬链接数与完整基线哈希，再提交
  FileDispositionInfo。不是 `Remove-Item` / `DeleteFile(path)`：删除决定必须
  绑定到刚核验的那个句柄，避免「核对后换名/换对象，再删掉新对象」的窗口。

  成功回执只在关闭删除句柄后，重新尝试打开原路径并得到 NOT_FOUND 时返回。
  若另一个句柄使删除仍处于 pending，或有人抢先在该位置创建新对象，本次不报成功；
  `touched` 会要求上层按操作账本进入核验/恢复。
#>
function Op-DeleteFileGuarded {
  param($req)
  $expected = ([string]$req.expected_sha256).ToLowerInvariant()
  if ($expected -notmatch $SCRIPT:LWB_SHA256_RE) {
    throw [LwbFsException]::new('INVALID_ARGUMENT', 'expected_sha256 必须是 64 位十六进制串', 0)
  }
  $expectedFileId = ([string]$req.expected_file_id).ToLowerInvariant()
  if ($expectedFileId -notmatch $SCRIPT:LWB_FILE_ID_RE) {
    throw [LwbFsException]::new('INVALID_ARGUMENT', 'expected_file_id 必须是 16 位十六进制串', 0)
  }

  $t = Resolve-Target -req $req
  $rel = [string]$req.relative_path
  $chain = Open-GuardedChain -RootPath $t.root -Segments $t.segments `
    -ExpectVolumeId $t.volume_id -ExpectFileId $t.file_id
  $h = $null
  $touched = $false
  try {
    $full = $chain.target_path
    # DELETE access and no FILE_SHARE_WRITE / FILE_SHARE_DELETE pin the target
    # against concurrent edits, renames, and competing delete operations.
    $h = Open-Guarded -Path $full `
      -Access ([LwbWin32]::GENERIC_READ -bor [LwbWin32]::DELETE_ACCESS) `
      -Share ([LwbWin32]::FILE_SHARE_READ) -Creation ([LwbWin32]::OPEN_EXISTING)
    $info = Assert-HandleMatches -Handle $h -Expected $full -Label '待删除目标'
    if (($info.dwFileAttributes -band [LwbWin32]::FILE_ATTRIBUTE_DIRECTORY) -ne 0) {
      throw [LwbFsException]::new('INVALID_ARGUMENT', 'file_delete 只删除普通文件，不删除目录', 0)
    }
    if ([int]$info.nNumberOfLinks -gt 1) {
      throw [LwbFsException]::new('LINK_UNSUPPORTED', '目标有多个硬链接；删除会影响工作区外的另一个名字', 0)
    }
    $actualFileId = (Get-FileIdHex $info)
    if ($actualFileId -ne $expectedFileId) {
      throw [LwbFsException]::new('FILE_VERSION_CONFLICT', '目标对象已不是最近读取的那个文件，拒绝删除', 0)
    }

    $size = [long]([LwbWin32]::FileSize($info))
    # `file_delete` snapshots the original bytes so a later recovery can recreate
    # the file. Keep the native helper's allocation bounded even if a caller lies.
    if ($size -gt 2097152) {
      throw [LwbFsException]::new('INVALID_ARGUMENT', '待删除文件超过 2 MiB 快照上限，拒绝删除', 0)
    }
    $bytes = New-Object byte[] ([int]$size)
    $read = [uint32]0
    if ($size -gt 0) {
      if (-not [LwbWin32]::ReadFile($h, $bytes, [uint32]$size, [ref]$read, [IntPtr]::Zero)) {
        $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw [LwbFsException]::new('IO_ERROR', '删除前读取基线失败', $err)
      }
    }
    if ($read -ne $size) {
      throw [LwbFsException]::new('IO_ERROR', "删除前读取字节数不符：预期 $size，实际 $read", 0)
    }
    $beforeSha = Get-Sha256Hex $bytes
    if ($beforeSha -ne $expected) {
      throw [LwbFsException]::new('FILE_VERSION_CONFLICT', '目标内容哈希已变化，拒绝删除', 0)
    }

    $canonical = Get-CanonicalRelativePath -RootHandle $chain.root_handle -TargetHandle $h
    $identityBefore = New-Identity $info
    $disposition = New-Object LwbWin32+FILE_DISPOSITION_INFO
    $disposition.DeleteFile = $true
    if (-not [LwbWin32]::SetFileInformationByHandle(
      $h, [LwbWin32]::FILE_DISPOSITION_INFO_CLASS, [ref]$disposition, [uint32]4)) {
      $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      $mapped = Convert-Win32Error -Win32Error $err
      throw [LwbFsException]::new($mapped.Code, "提交文件删除失败（$($mapped.Message)）", $err)
    }
    $touched = $true
    $h.Dispose()
    $h = $null

    # Independent path check after the delete handle closes. If the name was
    # recreated, report uncertainty rather than deleting the new object too.
    $probe = $null
    try {
      $probe = Open-Guarded -Path $full -Access ([LwbWin32]::GENERIC_READ) `
        -Share ([LwbWin32]::FILE_SHARE_READ) -Creation ([LwbWin32]::OPEN_EXISTING)
      [void](Assert-HandleMatches -Handle $probe -Expected $full -Label '删除后的路径核验')
      $state = Get-BoundedActualState -Handle $probe
      $failure = [LwbFsException]::new('FILE_VERSION_CONFLICT', '删除后目标路径仍被占用，拒绝把结果报告为已删除', 0)
      $failure.Touched = $true
      if ($null -ne $state) { $failure.ActualState = $state }
      throw $failure
    } catch [LwbFsException] {
      if ($_.Exception.Code -ne 'NOT_FOUND') { throw }
    } finally {
      if ($null -ne $probe) { $probe.Dispose() }
    }

    return [ordered]@{
      ok = $true
      relative_path = $rel
      canonical_relative_path = $canonical
      identity_before = $identityBefore
      before_sha256 = $beforeSha
      bytes_deleted = $size
      readback_missing = $true
    }
  } catch {
    if ($touched -and $_.Exception -is [LwbFsException]) {
      $_.Exception.Touched = $true
      if ($null -ne $h -and -not $h.IsClosed) {
        $state = Get-BoundedActualState -Handle $h
        if ($null -ne $state) { $_.Exception.ActualState = $state }
      }
    }
    throw
  } finally {
    if ($null -ne $h) { $h.Dispose() }
    foreach ($x in $chain.handles) { $x.Dispose() }
  }
}

<#
  创建：**只在已经存在的父目录里**，**只用 CREATE_NEW**。

  ## 判定与创建是同一次系统调用

  调用方（适配器）在写之前会探一次「那个名字现在还空着吗」，但那一次探测
  只回答「刚才空着」。它到这次创建之间有一个窗口，而验收标准第一条问的正是
  这个窗口里发生的事：别人抢先建了同名文件。

  这里的答案是**没有第二种可能** —— `CREATE_NEW` 在目标已存在时失败
  （Win32 80 / 183，映射为 `FILE_VERSION_CONFLICT`），而它在**同一次系统调用**
  里既做了判定又做了创建。「检查之后发现不存在」到「真的创建」之间因此没有
  任何可以插进去的间隙，也就不存在「覆盖掉别人刚建的文件」这条路径 ——
  本函数里根本没有 `CREATE_ALWAYS`，`OPEN_ALWAYS` 也没有。

  父目录不在这里创建：`Open-GuardedChain` 逐级打开中间目录，缺一级就
  `NOT_FOUND`。本工程**不**隐式建目录，也**不**动 ACL（`CreateFile` 建出来的
  对象继承父目录的 ACL，护栏不调用任何 `SetSecurityInfo`），更不设置执行位
  （NTFS 上根本没有这个概念，`attributes` 里报的只有只读/隐藏/系统/存档）。

  ## `actual_state` 在这条路上的含义

  写入路径上它的含义是「已越过截断那条线」。这里**没有**截断，对应的线画在
  `CREATE_NEW` **成功的那一刻**：从那一刻起路径上那个对象就是我们建的，
  后面任何失败都留下了一个「可能是半份」的对象。因此：

   - `CREATE_NEW` 自己失败 ⇒ 抛在 `$h` 被赋值之前 ⇒ **不带** `touched`
     ⇒ 调用方据此知道「一个对象都没被创建」；
   - 创建之后任何失败 ⇒ 带 `touched`，`actual_state`（尺寸、身份、前 1 MiB
     的摘要）则尽力而为。判「有没有留下一个对象」看 `touched`，
     判「留下的那一个是什么样」看 `actual_state`。

  ## 失败之后**不删**那个对象

  验收标准说的是「失败后**只处理**能证明由本操作创建且未被修改的对象」——
  这是一句**许可**，不是一句要求。这里选择不处理，理由有三条：
  本函数无法在不重新读取的前提下证明「未被修改」（`actual_state` 是一次
  有上界的观测，超过 1 MiB 时它给不出完整哈希）；一次删除是不可逆的，
  而一个多余的空文件是可逆的；恢复与定案（含清理）是 LWB-030 的职责，
  那里拿得到本函数交出去的 `identity_after` 与观测哈希作为凭据。
#>
function Op-CreateFileGuarded {
  param($req)
  $payload = [Convert]::FromBase64String([string]$req.content_base64)
  $t = Resolve-Target -req $req
  $rel = [string]$req.relative_path

  $chain = Open-GuardedChain -RootPath $t.root -Segments $t.segments `
    -ExpectVolumeId $t.volume_id -ExpectFileId $t.file_id
  try {
    $full = $chain.target_path

    # CREATE_NEW：已存在即失败。绝不用 CREATE_ALWAYS 覆盖。
    # 这一句失败时抛在下面这个 try **之外**，因此不带 actual_state —— 那是对的：
    # 失败意味着**一个对象都没被创建**。反过来说，凡是进到 catch 里的失败，
    # 都发生在创建**之后**，因此都要带现场。
    $h = Open-Guarded -Path $full -Access ([LwbWin32]::GENERIC_READ -bor [LwbWin32]::GENERIC_WRITE) `
      -Share ([LwbWin32]::FILE_SHARE_READ) -Creation ([LwbWin32]::CREATE_NEW)
    try {
      # 刚创建的文件不可能是重解析点，但规范路径仍要核：若父目录在这一瞬间
      # 被换成指向别处的 Junction，句柄拿到的对象就不在预期路径上。
      [void](Assert-HandleMatches -Handle $h -Expected $full -Label '新建目标')

      $written = Invoke-GuardedWrite -Handle $h -Payload $payload
      $flushed = [LwbWin32]::FlushFileBuffers($h)
      $readback = Invoke-GuardedReadback -Handle $h -Payload $payload

      return [ordered]@{
        ok             = $true
        relative_path  = $rel
        canonical_relative_path = (Get-CanonicalRelativePath -RootHandle $chain.root_handle -TargetHandle $h)
        absolute_path  = $full
        identity_after = $readback.identity_after
        after_sha256   = $readback.after_sha256
        target_sha256  = $readback.target_sha256
        readback_ok    = $readback.readback_ok
        flushed        = [bool]$flushed
        bytes_written  = $written
      }
    } catch {
      # 现场必须在**句柄还开着**的时候取（见 Get-BoundedActualState）。
      # 没有 `if` 包着：能到这里就一定已经创建过了（见上面的说明）；
      # 而「已经创建过」这件事同样先于观测被记下来 —— 观测失败只说明
      # 那个半成品的大小与内容未知，不说明它不存在。
      if ($_.Exception -is [LwbFsException]) {
        $_.Exception.Touched = $true
        $state = Get-BoundedActualState -Handle $h
        if ($null -ne $state) { $_.Exception.ActualState = $state }
      }
      throw
    } finally { $h.Dispose() }
  } finally { foreach ($x in $chain.handles) { $x.Dispose() } }
}

<#
  仅用于 spike 的崩溃实验：截断/半写之后立即 Exit，不做刷盘。
  用于取得「崩溃后文件到底剩下什么」的真实观测，而不是假设。
#>
function Op-CrashExperiment {
  param($req)
  $mode = [string]$req.mode
  $t = Resolve-Target -req $req
  $full = $t.root
  if ($t.segments.Length -gt 0) { $full = Join-Path $t.root ($t.segments -join '\') }

  $h = Open-Guarded -Path $full -Access ([LwbWin32]::GENERIC_READ -bor [LwbWin32]::GENERIC_WRITE) `
    -Share ([LwbWin32]::FILE_SHARE_READ) -Creation ([LwbWin32]::OPEN_EXISTING)
  try {
    [void][LwbWin32]::SetFilePointerEx($h, 0, [IntPtr]::Zero, [LwbWin32]::FILE_BEGIN)
    [void][LwbWin32]::SetEndOfFile($h)

    if ($mode -eq 'truncate_then_crash') {
      [Console]::Out.Flush()
      [Environment]::Exit(42)   # 截断后立刻退出：文件应为 0 字节
    }

    if ($mode -eq 'half_write_then_crash') {
      $payload = [Convert]::FromBase64String([string]$req.content_base64)
      $half = [int]([Math]::Floor($payload.Length / 2))
      $part = New-Object byte[] $half
      [Array]::Copy($payload, $part, $half)
      $written = [uint32]0
      [void][LwbWin32]::WriteFile($h, $part, [uint32]$half, [ref]$written, [IntPtr]::Zero)
      [Console]::Out.Flush()
      [Environment]::Exit(43)   # 半写后退出：文件应为 half 字节
    }

    throw [LwbFsException]::new('INVALID_ARGUMENT', "未知的崩溃实验模式：$mode", 0)
  } finally { $h.Dispose() }
}

# 仅用于 spike：以指定共享模式持有一个句柄，供并发测试观察。
#
# 持有的句柄必须**留住引用**（见下面 `$script:LwbHeldHandles`）：.NET 的
# `SafeFileHandle` 是终结器对象，函数一返回、局部变量一不可达，GC 就会把
# 句柄关掉。实测过一次：同一段代码连跑 20 轮，第 20 轮的「外部保存被挡住」
# 只见 19 次 —— 那一次不是环境抖动，是句柄被回收了。一个会自己松手的
# 「持有」不能用来做并发证据，因此引用存到脚本作用域，活到助手进程退出为止。
$script:LwbHeldHandles = [System.Collections.Generic.List[object]]::new()

function Op-HoldHandle {
  param($req)
  # `-AllowEmptyTarget`：本操作用来观察「护栏持有整条链时，外部能否改名/删除」，
  # 而**持有工作区根本身**正是最该被观察的那一种 —— 根是授权对象的所在。
  $t = Resolve-Target -req $req
  $rel = [string]$req.relative_path
  $chain = Open-GuardedChain -RootPath $t.root -Segments $t.segments `
    -ExpectVolumeId $t.volume_id -ExpectFileId $t.file_id -AllowEmptyTarget
  $full = $chain.target_path
  # 祖先句柄**故意不释放**：本操作存在的意义就是让调用方在「护栏持有整条链」
  # 的状态下从外部尝试改名/删除，观察并发交换是否被挡住。
  # 把它们连同下面那个目标句柄一起存进脚本作用域 —— 否则 GC 会在函数返回后
  # 任意时刻终结它们，「持有」就变成了一件碰运气的事。
  $shareMode = [string]$req.share_mode
  $share = switch ($shareMode) {
    'read'      { [LwbWin32]::FILE_SHARE_READ }
    'none'      { [uint32]0 }
    'readwrite' { [LwbWin32]::FILE_SHARE_READ -bor [LwbWin32]::FILE_SHARE_WRITE }
    default     { [LwbWin32]::FILE_SHARE_READ }
  }
  $access = if ([string]$req.access -eq 'write') {
    [LwbWin32]::GENERIC_READ -bor [LwbWin32]::GENERIC_WRITE
  } else { [LwbWin32]::GENERIC_READ }

  $h = Open-Guarded -Path $full -Access $access -Share $share -Creation ([LwbWin32]::OPEN_EXISTING)
  $info = New-Object LwbWin32+BY_HANDLE_FILE_INFORMATION
  [void][LwbWin32]::GetFileInformationByHandle($h, [ref]$info)
  $identity = New-Identity $info
  foreach ($held in $chain.handles) { [void]$script:LwbHeldHandles.Add($held) }
  [void]$script:LwbHeldHandles.Add($h)
  return [ordered]@{
    ok            = $true
    relative_path = $rel
    share_mode    = $shareMode
    access        = [string]$req.access
    identity      = $identity
    held_handles  = $script:LwbHeldHandles.Count
  }
}

function Op-ListDirectory {
  param($req)
  # 相对路径可以是空串，表示列举**工作区根目录**。
  $t = Resolve-Target -req $req
  $rel = [string]$req.relative_path

  # --- 有界、有序、可续的列举 -----------------------------------------------
  #
  # 这三个词各解决一件真实的事，缺一个这个操作就不能用于分页：
  #
  #  * 有界：见 $SCRIPT:LIST_HARD_CAP。夹取发生在这里，因为内存是在这里花的。
  #  * 有序：**ordinal（UTF-16 码元序）**，不是 PowerShell 的 `-gt`。
  #    `-gt` 按当前区域设置比较，同一个目录在不同区域设置下给出不同顺序，
  #    而游标是按顺序定位的 —— 那样"下一页"会随机器而变。
  #    ordinal 与调用方（TypeScript 里字符串的 `<`）是同一套顺序，
  #    两侧因此对"下一个是谁"给出同一个答案。
  #  * 可续：`after_name` 表示"这个名字已经返回过了"。续读时只取严格大于它的，
  #    于是翻页不会重复、也不会因为目录变大而卡在同一页（若只按"前 N 项"分页，
  #    在第 N 项之前插入一个新文件就会让后面的页永远推进不过去）。
  #
  # 顺便记一条**故意不做**的事：这里不返回条目的文件身份。目录扫描给出的属性
  # 是扫描本身的副产品（因此不额外发按路径的查询、不跟随重解析点），
  # 而身份需要逐个打开句柄 —— 那会把一次列举变成 N 次文件打开。
  $max = if ($null -ne $req.max_entries) { [int]$req.max_entries } else { $SCRIPT:LIST_HARD_CAP }
  if ($max -lt 1) {
    throw [LwbFsException]::new('INVALID_ARGUMENT', "max_entries 必须是 >= 1 的整数：$($req.max_entries)", 0)
  }
  if ($max -gt $SCRIPT:LIST_HARD_CAP) { $max = $SCRIPT:LIST_HARD_CAP }
  $after = if ($null -ne $req.after_name) { [string]$req.after_name } else { '' }

  $chain = Open-GuardedChain -RootPath $t.root -Segments $t.segments `
    -ExpectVolumeId $t.volume_id -ExpectFileId $t.file_id -AllowEmptyTarget
  try {
    $full = $chain.target_path
    $canonRel = $null

    # 目录句柄也**不含** FILE_SHARE_DELETE：持有期间这个目录不能被改名/删除，
    # 于是下面按规范路径遍历时，遍历的确实是我们刚刚验证过的那个对象。
    $h = Open-Guarded -Path $full -Access ([LwbWin32]::GENERIC_READ) `
      -Share ([LwbWin32]::FILE_SHARE_READ -bor [LwbWin32]::FILE_SHARE_WRITE) `
      -Creation ([LwbWin32]::OPEN_EXISTING)
    try {
      $info = Assert-HandleMatches -Handle $h -Expected $full -Label '目录'
      if (($info.dwFileAttributes -band [LwbWin32]::FILE_ATTRIBUTE_DIRECTORY) -eq 0) {
        throw [LwbFsException]::new('INVALID_ARGUMENT', "目标是文件，不是目录：$full", 0)
      }

      # 用**句柄的规范路径**遍历，而不是调用方给的字符串。
      # 旧实现用调用方路径遍历：句柄验过之后、遍历之前，那个路径完全可能
      # 已经被指向另一个目录 —— 句柄验了 A，遍历了 B。
      $canonical = [LwbWin32]::FinalPath($h) -replace '^\\\\\?\\', ''

      # 条目里的相对路径用**磁盘拼写**拼，不用调用方传来的字符串：
      # 否则请求写 ALPHA 时，条目会回成 "ALPHA/child.txt"，而磁盘上是
      # "Alpha\child.txt" —— 回执与文件系统对不上。
      $canonRel = Get-CanonicalRelativePath -RootHandle $chain.root_handle -TargetHandle $h

      # 有界选取：只保留 (name > $after) 中**最小**的 $want 项。
      # 多留一项就是为了知道"还有没有下一页" —— 只看前 $max 项时，
      # 恰好装满一页与"刚好只剩这些"这两种情况无法区分。
      $want = $max + 1
      $selected = [System.Collections.Generic.List[object]]::new()

      # 用 EnumerateFileSystemInfos 而不是 EnumerateFileSystemEntries：
      # 属性的取值来自**目录扫描本身**，不会对每一项再发一次按路径的查询。
      # 对重解析点尤其重要 —— 按路径查询会跟随链接，从而泄漏链接**指向**的
      # 那个对象的属性与长度（工作区外的信息）。
      foreach ($item in [System.IO.DirectoryInfo]::new($canonical).EnumerateFileSystemInfos()) {
        $name = $item.Name
        if ([string]::CompareOrdinal($name, $after) -le 0) { continue }

        $isReparse = (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
        $isDir = (($item.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0)
        $size = $null
        # 重解析点不取长度：Length 会跟随链接去问目标对象的长度。
        if (-not $isDir -and -not $isReparse) {
          try { $size = $item.Length } catch { }
        }
        $rec = @{
          name = $name
          entry = [ordered]@{
            name          = $name
            relative_path = if ($canonRel) { "$canonRel/$name" } else { $name }
            type          = if ($isDir) { 'directory' } else { 'file' }
            size          = $size
            is_reparse    = $isReparse
          }
        }

        if ($selected.Count -lt $want) {
          Insert-SortedByName -List $selected -Rec $rec
        } elseif ([string]::CompareOrdinal($name, $selected[$selected.Count - 1].name) -lt 0) {
          # 已经攒够 $want 项，但这一项比当前最大的一项还小 —— 换掉它。
          # 这一支正是"内存有界"的实现：无论目录里有多少项，
          # 常驻的永远只有 $want 条记录。
          $selected.RemoveAt($selected.Count - 1)
          Insert-SortedByName -List $selected -Rec $rec
        }
      }

      $hasMore = $selected.Count -gt $max
      if ($hasMore) { $selected.RemoveAt($selected.Count - 1) }
      $entries = @($selected | ForEach-Object { $_.entry })

      return [ordered]@{
        ok = $true
        relative_path = $rel
        canonical_relative_path = $canonRel
        entries = $entries
        # 本次列举是否还有条目没返回（严格按 ordinal 顺序、$after 之后的）。
        # 调用方据此决定要不要发游标。
        has_more = $hasMore
      }
    } finally { $h.Dispose() }
  } finally { foreach ($x in $chain.handles) { $x.Dispose() } }
}

function Get-DriveTypeName([uint32]$t) {
  switch ($t) {
    ([LwbWin32]::DRIVE_FIXED)     { return 'fixed' }
    ([LwbWin32]::DRIVE_REMOTE)    { return 'remote' }
    ([LwbWin32]::DRIVE_REMOVABLE) { return 'removable' }
    ([LwbWin32]::DRIVE_CDROM)     { return 'cdrom' }
    ([LwbWin32]::DRIVE_RAMDISK)   { return 'ramdisk' }
    ([LwbWin32]::DRIVE_NO_ROOT_DIR) { return 'no_root_dir' }
    default { return 'unknown' }
  }
}

<#
  注册期的环境事实查询（LWB-009 步骤 2）。

  与其他操作不同，本操作接受**绝对路径**而不是 root + relative_path ——
  注册时工作区根还不存在，没有 root 可以相对。因此它只能用于
  「注册/复核候选根」这一条路径，绝不可用于工作区内的文件访问；
  在 daemon 侧它只挂在 `workspaces.manage` 能力下（仅控制台）。

  以 FILE_FLAG_OPEN_REPARSE_POINT 打开：对云占位文件而言，**跟随**重解析点
  会触发下载（把几 GB 拉到本地），而我们只是想识别它。这个标志让我们
  看到占位文件本身，而不是把它实体化。
#>
function Op-StatVolume($req) {
  $path = [string]$req.path
  if ([string]::IsNullOrWhiteSpace($path)) {
    throw [LwbFsException]::new('INVALID_ARGUMENT', 'statVolume 需要 path。', 0)
  }

  $h = [LwbWin32]::CreateFile(
    $path,
    [LwbWin32]::GENERIC_READ,
    ([LwbWin32]::FILE_SHARE_READ -bor [LwbWin32]::FILE_SHARE_WRITE -bor [LwbWin32]::FILE_SHARE_DELETE),
    [IntPtr]::Zero,
    [LwbWin32]::OPEN_EXISTING,
    ([LwbWin32]::FILE_FLAG_BACKUP_SEMANTICS -bor [LwbWin32]::FILE_FLAG_OPEN_REPARSE_POINT),
    [IntPtr]::Zero)

  if ($h.IsInvalid) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $mapped = Convert-Win32Error -Win32Error $err
    throw [LwbFsException]::new($mapped.Code, "打开候选根失败（$($mapped.Message)）：$path", $err)
  }

  try {
    $info = New-Object LwbWin32+BY_HANDLE_FILE_INFORMATION
    if (-not [LwbWin32]::GetFileInformationByHandle($h, [ref]$info)) {
      $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw [LwbFsException]::new('IO_ERROR', "读取候选根信息失败（Win32 $err）：$path", $err)
    }

    $fsName = New-Object System.Text.StringBuilder 256
    $volName = New-Object System.Text.StringBuilder 256
    $serial = [uint32]0
    $maxComp = [uint32]0
    $fsFlags = [uint32]0
    $gotVolume = [LwbWin32]::GetVolumeInformationByHandle(
      $h, $volName, [uint32]$volName.Capacity, [ref]$serial, [ref]$maxComp, [ref]$fsFlags,
      $fsName, [uint32]$fsName.Capacity)

    $attrs = $info.dwFileAttributes
    $recallOnOpen = (($attrs -band [LwbWin32]::FILE_ATTRIBUTE_RECALL_ON_OPEN) -ne 0)
    $recallOnData = (($attrs -band [LwbWin32]::FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS) -ne 0)

    # 盘符类型只能按路径问，句柄接口不提供它。
    # 对非盘符根（如 UNC）GetDriveType 返回 UNKNOWN，因此这一项**不作为
    # 拒绝的唯一依据** —— 拒绝逻辑在 TypeScript 侧，见 packages/workspaces。
    $driveType = [LwbWin32]::GetDriveType([System.IO.Path]::GetPathRoot($path))

    return [ordered]@{
      ok                    = $true
      path                  = $path
      drive_type            = (Get-DriveTypeName $driveType)
      file_system           = $(if ($gotVolume) { $fsName.ToString() } else { $null })
      file_system_flags     = [uint32]$fsFlags
      volume_label          = $(if ($gotVolume) { $volName.ToString() } else { $null })
      max_component_length  = [uint32]$maxComp
      volume_id             = ('{0:x8}' -f $info.dwVolumeSerialNumber)
      file_id               = ('{0:x16}' -f [LwbWin32]::FileIndex($info))
      link_count            = [int]$info.nNumberOfLinks
      is_directory          = (($attrs -band [LwbWin32]::FILE_ATTRIBUTE_DIRECTORY) -ne 0)
      is_reparse            = (($attrs -band [LwbWin32]::FILE_ATTRIBUTE_REPARSE_POINT) -ne 0)
      recall_on_open        = $recallOnOpen
      recall_on_data_access = $recallOnData
      # 两者任一成立即为云占位文件：对它的任何读取都可能触发网络下载，
      # 也可能在网络不可用时失败 —— V1 明确不支持这种形态。
      is_cloud_placeholder  = ($recallOnOpen -or $recallOnData)
      volume_info_available = $gotVolume
    }
  } finally { $h.Dispose() }
}

function Op-Capability {
  return [ordered]@{
    ok                           = $true
    backend                      = 'powershell-helper'
    powershell_version           = $PSVersionTable.PSVersion.ToString()
    clr_version                  = [System.Environment]::Version.ToString()
    os_version                   = [System.Environment]::OSVersion.VersionString
    supports_exclusive_handle    = $true
    supports_flush               = $true
    supports_create_new          = $true
    supports_reparse_detection   = $true
    supports_file_identity       = $true
    supports_hardlink_count      = $true
    supports_final_path_by_handle = $true
  }
}

# ---------------------------------------------------------------------------
# 调度
# ---------------------------------------------------------------------------

function Invoke-LwbRequest($req) {
  try {
    $op = [string]$req.op
    $result = switch ($op) {
      'capability'        { Op-Capability }
      # 只做**语法**校验，不碰磁盘。存在的意义有两个：
      #   1. 调用方可以在花一次句柄打开之前先问护栏它会不会接受（快速失败）；
      #   2. 让护栏的规则集**可观测** —— 一致性测试正是通过它逐例比对
      #      护栏侧与 contracts 侧对同一输入的结论。
      'validatePath'      {
        $verdict = Test-LwbRelativePath -Path $req.relative_path
        if ($verdict.ok) {
          [ordered]@{ ok = $true; segments = @($verdict.segments); normalized = $verdict.normalized }
        } else {
          [ordered]@{ ok = $false; code = 'PATH_UNSAFE'; reason = $verdict.reason
                      message = "[$($verdict.reason)] $($verdict.detail)"; win32_error = 0 }
        }
      }
      'resolvePath'       {
        $t = Resolve-Target -req $req
        $chain = Open-GuardedChain -RootPath $t.root -Segments $t.segments `
          -ExpectVolumeId $t.volume_id -ExpectFileId $t.file_id
        try {
          $full = $chain.target_path
          $h = Open-Guarded -Path $full -Access ([LwbWin32]::GENERIC_READ) `
            -Share ([LwbWin32]::FILE_SHARE_READ) -Creation ([LwbWin32]::OPEN_EXISTING)
          try {
            $info = Assert-HandleMatches -Handle $h -Expected $full -Label '目标'
            [ordered]@{
              ok            = $true
              relative_path = [string]$req.relative_path
              # 规范拼写必须在这里就有：读取侧的硬拒绝预检要用它，
              # 而那次预检发生在读**任何字节**之前 —— 那时还没有
              # readFileGuarded 的结果可用。少了这一项，预检只能拿到
              # 请求里的字符串，而它正是不能用来判定的那个东西
              # （`DATA.TXT` 与磁盘上的 `data.txt` 是两个字符串、同一个对象）。
              canonical_relative_path = (Get-CanonicalRelativePath -RootHandle $chain.root_handle -TargetHandle $h)
              absolute_path = $full
              identity      = (New-Identity $info)
            }
          } finally { $h.Dispose() }
        } finally { foreach ($x in $chain.handles) { $x.Dispose() } }
      }
      'readFileGuarded'   { Op-ReadFileGuarded $req }
      'writeFileGuarded'  { Op-WriteFileGuarded $req }
      'createFileGuarded' { Op-CreateFileGuarded $req }
      'deleteFileGuarded' { Op-DeleteFileGuarded $req }
      'listDirectory'     { Op-ListDirectory $req }
      'statVolume'        { Op-StatVolume $req }
      'crashExperiment'   { Op-CrashExperiment $req }
      'holdHandle'        { Op-HoldHandle $req }
      default {
        [ordered]@{ ok = $false; code = 'INVALID_ARGUMENT'; message = "未知操作：$op"; win32_error = 0 }
      }
    }
    return $result
  } catch [LwbFsException] {
    $response = [ordered]@{
      ok          = $false
      code        = $_.Exception.Code
      message     = $_.Exception.Message
      win32_error = $_.Exception.Win32Error
    }
    # 两个字段分开报，读法见 `LwbFsException.Touched`：
    #   - `touched`      = 这次调用进入了破坏性区域（护栏在句柄里知道的事实）；
    #   - `actual_state` = 现场的**有界**观测，尽力而为，可能缺席。
    # 「没有 actual_state」**不再**被当作「没动过」—— 那个等式只在
    # `touched` 也缺失时才成立。进程被杀这类情形根本不产生响应，
    # 因此不会伪装成一份「干净」的失败。
    if ($_.Exception.Touched) {
      $response.touched = $true
    }
    if ($null -ne $_.Exception.ActualState) {
      $response.actual_state = $_.Exception.ActualState
    }
    return $response
  } catch {
    return [ordered]@{
      ok          = $false
      code        = 'INTERNAL_ERROR'
      message     = $_.Exception.Message
      win32_error = 0
    }
  }
}

function Write-Response($obj) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $obj -Depth 12 -Compress))
  [Console]::Out.Flush()
}

if ($Once) {
  $parsed = $Once | ConvertFrom-Json -AsHashtable
  Write-Response (Invoke-LwbRequest $parsed)
  exit 0
}

if ($Server) {
  Write-Response ([ordered]@{
    ok                 = $true
    ready              = $true
    backend            = 'powershell-pinvoke'
    powershell_version = $PSVersionTable.PSVersion.ToString()
    os_version         = [System.Environment]::OSVersion.VersionString
  })
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq '') { continue }
    if ($line.Trim() -eq '__exit__') { break }
    try {
      $parsed = $line | ConvertFrom-Json -AsHashtable
      Write-Response (Invoke-LwbRequest $parsed)
    } catch {
      Write-Response ([ordered]@{ ok = $false; code = 'INVALID_ARGUMENT'; message = $_.Exception.Message; win32_error = 0 })
    }
  }
  exit 0
}

Write-Error '需要 -Once 或 -Server 参数'
exit 2
