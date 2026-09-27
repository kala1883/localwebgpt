#requires -Version 7.0
<#
  工作区内相对路径的语法校验（LWB-010 步骤 1）—— **护栏侧**实现。

  ## 为什么这里有一份「重复」的实现

  `packages/contracts/src/path.ts` 里已经有一份同样规则的 TS 实现，daemon 在调用
  护栏之前会先跑它。但护栏**不能因此就不检查**：

    - 护栏是独立进程，请求经管道到达。它的边界是**它自己**打开的那个句柄，
      不是调用方声称已经检查过什么。调用方被绕过（或被替换、被降级、
      被将来的某个新调用点忘记调用）时，护栏必须仍然拒绝。
    - 这正是 I01/I03 的形态：判定必须发生在**拥有该判定所需信息的那一层**。
      语法信息在这里就够，所以这里判；身份信息只有句柄能给，所以在句柄上判。

  两份实现当然有漂移风险。处置方式不是「小心一点」，而是
  `tests/windows/path-escape/relative-path-parity.test.ts`：
  同一个用例语料分别喂给两份实现，**逐例断言结论与理由完全一致**。
  语料在 `native/winfs/path_guard/corpus.ts`，两边共用同一份数据。
  漂移会让测试变红，而不是让某一边静默放宽。

  ## 本模块不是安全边界的全部

  这里全是字符串判断。`D:\a` 与 `D:\b` 指向同一个目录（Junction、8.3 短名、
  大小写、硬链接）在这里看不出来 —— 那部分由逐级句柄固定与卷/文件身份判定
  承担（见 WinfsGuard.ps1 的 Resolve-SafeAncestors / Assert-RootIdentity）。
  本模块负责挡住**语法层面的混淆输入**，并给出可用的路径段。

  ## 顺序即语义

  下面的检查顺序与 TS 侧逐条对应，不是随手排的：
    - 不可见字符必须**先于空判断**（U+FEFF 上 JS 与 .NET 的空白定义不同，
      判在前面两侧才会给出同一个理由；见下方 FORMAT_CHARS）；
    - 控制字符必须在任何解析之前（NUL 截断一类混淆靠它防）；
    - `\\?\` 必须在 `\\` 的 UNC 判断之前（否则会被误报成 UNC）；
    - 盘符判断必须在统一分隔符之前（`C:/x` 与 `C:\x` 都要拦）；
    - `..` 的判断必须在「以点结尾」之前（`..` 也以点结尾，否则理由会错）；
    - 整串的非法字符判断必须在分段之前（`?` 出现在哪一段都该拒）。
#>

# 与 packages/contracts/src/path.ts 保持一致；改动必须同步两侧并更新语料。
$SCRIPT:LWB_MAX_RELATIVE_PATH_CHARS = 1024
$SCRIPT:LWB_MAX_SEGMENT_CHARS = 255
$SCRIPT:LWB_MAX_SEGMENT_DEPTH = 64

# Windows 保留设备名。比较时取「第一个点之前」的部分并大写，
# 因此 `CON.txt` 与 `con` 一样被拒绝。
$SCRIPT:LWB_RESERVED_DEVICE_NAMES = @(
  'CON', 'PRN', 'AUX', 'NUL', 'CLOCK$', 'CONIN$', 'CONOUT$'
) + @(1..9 | ForEach-Object { "COM$_" }) + @(1..9 | ForEach-Object { "LPT$_" })

# 不可见字符区间。与 packages/contracts/src/path.ts 的 isInvisibleChar 逐条对应。
#
# 与控制字符分成两类，因为危害方式不同：控制字符靠 C 字符串截断/断行骗人，
# 这些字符靠「看不见」骗人 —— `ab` 显示成 `ab`，
# `a<RTL>b.txt` 显示成 `atxt.b`。批准界面上看到的名字与打开的名字
# 不是同一个，那么「批准的是这一个」这句话就不成立了。
$SCRIPT:LWB_INVISIBLE_RANGES = @(
  @(0x00AD, 0x00AD),   # 软连字符
  @(0x061C, 0x061C),   # 阿拉伯字母标记
  @(0x200B, 0x200F),   # 零宽与方向标记
  @(0x2028, 0x202E),   # 行/段分隔符、双向嵌入与覆盖
  @(0x2060, 0x206F),   # 词连接符、不可见运算符、双向隔离
  @(0xFEFF, 0xFEFF),   # 零宽不换行空格（BOM）
  @(0xFFF9, 0xFFFB)    # 注解锚定
)

function Test-LwbInvisibleChar {
  param([int]$Code)
  foreach ($range in $SCRIPT:LWB_INVISIBLE_RANGES) {
    if ($Code -ge $range[0] -and $Code -le $range[1]) { return $true }
  }
  return $false
}

<#
  校验一个工作区内相对路径。

  返回 [ordered]@{ ok = $true; segments = @(...); normalized = 'a/b' }
  或     [ordered]@{ ok = $false; reason = 'PARENT_REF'; detail = '...' }

  `reason` 取值与 TS 的 PathRejectReason 一一对应，供一致性测试逐例比对。
#>
function Test-LwbRelativePath {
  param([AllowNull()][object]$Path)

  if ($null -eq $Path -or -not ($Path -is [string])) {
    return [ordered]@{ ok = $false; reason = 'NOT_A_STRING'; detail = 'path 必须是字符串' }
  }
  $p = [string]$Path

  # 不可见字符**排在空判断之前**：U+FEFF 上 JS 的 trim() 与 .NET 的
  # char.IsWhiteSpace 结论不同，判在前面两侧给出的才是同一个理由。
  for ($i = 0; $i -lt $p.Length; $i++) {
    $code = [int]$p[$i]
    if (Test-LwbInvisibleChar -Code $code) {
      return [ordered]@{
        ok = $false; reason = 'INVISIBLE_CHAR'
        detail = "path 第 $($i + 1) 个字符是不可见字符（U+$($code.ToString('X4'))）"
      }
    }
  }

  if ($p.Length -eq 0 -or $p.Trim().Length -eq 0) {
    return [ordered]@{ ok = $false; reason = 'EMPTY'; detail = 'path 不能为空' }
  }
  if ($p.Length -gt $SCRIPT:LWB_MAX_RELATIVE_PATH_CHARS) {
    return [ordered]@{
      ok = $false; reason = 'TOO_LONG'
      detail = "path 超过 $($SCRIPT:LWB_MAX_RELATIVE_PATH_CHARS) 字符"
    }
  }

  # 控制字符在任何位置都不允许，且必须在其它解析之前检查。
  for ($i = 0; $i -lt $p.Length; $i++) {
    $code = [int]$p[$i]
    if ($code -lt 0x20 -or $code -eq 0x7f) {
      return [ordered]@{
        ok = $false; reason = 'CONTROL_CHAR'
        detail = "path 第 $($i + 1) 个字符是控制字符"
      }
    }
  }

  # 设备命名空间：\\?\、\\.\、\??\ —— 这些会绕过 Win32 路径规范化。
  # 必须先于 UNC 判断：`\\?\D:\x` 也以 `\\` 开头。
  if ($p -match '^\\\\[.?]\\' -or $p.StartsWith('\??\')) {
    return [ordered]@{ ok = $false; reason = 'DEVICE_NAMESPACE'; detail = '不接受设备命名空间路径' }
  }
  if ($p.StartsWith('\\') -or $p.StartsWith('//')) {
    return [ordered]@{ ok = $false; reason = 'UNC'; detail = '不接受 UNC 路径' }
  }
  if ($p.StartsWith('\') -or $p.StartsWith('/')) {
    return [ordered]@{ ok = $false; reason = 'ABSOLUTE'; detail = '不接受绝对路径' }
  }
  # 盘符形式，包括 C:foo 与 C:\foo。
  if ($p -match '^[A-Za-z]:') {
    return [ordered]@{ ok = $false; reason = 'DRIVE_LETTER'; detail = '不接受盘符形式路径' }
  }

  $unified = $p.Replace('\', '/')

  # 统一分隔符之后任何冒号都是 ADS（备用数据流）或盘符残留。
  # ADS 是真实的绕过路径：`a.txt:stream` 的内容与 `a.txt` 不是同一个东西，
  # 而基于路径字符串的策略比对会认为它们是。
  if ($unified.Contains(':')) {
    return [ordered]@{ ok = $false; reason = 'ADS_COLON'; detail = '路径中不允许出现冒号（ADS 或盘符）' }
  }
  if ($unified.IndexOfAny([char[]]@('<', '>', '"', '|', '?', '*')) -ge 0) {
    return [ordered]@{ ok = $false; reason = 'INVALID_CHAR'; detail = '路径包含 Windows 非法字符 < > " | ? *' }
  }
  if ($unified.EndsWith('/')) {
    return [ordered]@{ ok = $false; reason = 'TRAILING_SEPARATOR'; detail = '路径不能以分隔符结尾' }
  }

  $segments = $unified.Split([char]'/')
  if ($segments.Length -gt $SCRIPT:LWB_MAX_SEGMENT_DEPTH) {
    return [ordered]@{
      ok = $false; reason = 'TOO_DEEP'
      detail = "路径深度超过 $($SCRIPT:LWB_MAX_SEGMENT_DEPTH) 级"
    }
  }

  foreach ($segment in $segments) {
    if ($segment.Length -eq 0) {
      return [ordered]@{ ok = $false; reason = 'EMPTY_SEGMENT'; detail = '路径包含空段（连续分隔符）' }
    }
    if ($segment.Length -gt $SCRIPT:LWB_MAX_SEGMENT_CHARS) {
      return [ordered]@{
        ok = $false; reason = 'SEGMENT_TOO_LONG'
        detail = "路径段超过 $($SCRIPT:LWB_MAX_SEGMENT_CHARS) 字符"
      }
    }
    if ($segment -eq '.') {
      return [ordered]@{ ok = $false; reason = 'DOT_SEGMENT'; detail = '路径不允许包含 "." 段' }
    }
    if ($segment -eq '..') {
      return [ordered]@{ ok = $false; reason = 'PARENT_REF'; detail = '路径不允许包含上级引用 ".."' }
    }
    # Win32 在打开时会**静默剥掉**段尾的点与空格：`a .txt` 与 `a.txt` 是同一个
    # 对象，`b.` 与 `b` 也是。于是「我们检查的字符串」与「实际打开的对象」
    # 不是同一个东西 —— 这正是能把策略比对骗过去的地方，必须拒绝。
    if ($segment.EndsWith('.') -or $segment.EndsWith(' ')) {
      return [ordered]@{ ok = $false; reason = 'TRAILING_DOT_OR_SPACE'; detail = '路径段不能以点或空格结尾' }
    }
    $dotIndex = $segment.IndexOf('.')
    $base = if ($dotIndex -eq -1) { $segment } else { $segment.Substring(0, $dotIndex) }
    if ($SCRIPT:LWB_RESERVED_DEVICE_NAMES -contains $base.ToUpperInvariant()) {
      return [ordered]@{ ok = $false; reason = 'RESERVED_NAME'; detail = '路径段是 Windows 保留设备名' }
    }
  }

  return [ordered]@{
    ok         = $true
    segments   = $segments
    normalized = ($segments -join '/')
  }
}
