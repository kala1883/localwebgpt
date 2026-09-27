# Local Workspace Bridge —— 受保护存储的 Windows 机制层（LWB-007）。
#
# 本文件只提供**机制**，不做安全判定：
#   - `harden`   设置显式 DACL 并返回**实测到的**规则列表；是否可接受由 TypeScript 侧判定。
#   - `inspect`  只读地返回实测到的规则列表。
#   - `protect` / `unprotect`  调用 crypt32.dll 的 DPAPI（当前用户范围）。
#
# 把判定留在 Node 侧的理由：安全策略必须能被单元测试覆盖、能被评审阅读。
# PowerShell 只回答「磁盘上现在是什么」，不回答「这是不是可以接受」。
#
# 协议：stdin/stdout 上的 JSON 行，与 native/winfs/WinfsGuard.ps1 相同。
# 不共用同一份助手是刻意的：写护栏进程与凭证进程是两个安全域，
# 合并会让其中一个的失陷直接波及另一个。

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# 写 ACL 用的是 .NET 的 `[System.IO.FileSystemAclExtensions]::SetAccessControl`，
# 不是 `Set-Acl` 这个 cmdlet。原因见 `Op-Harden` 里的说明：后者**第二次**加固
# 同一个目录必然失败。PowerShell 7 默认不加载这个程序集（它的扩展方法不以
# 类型名出现在 PowerShell 里），所以要先显式加载。
Add-Type -AssemblyName System.IO.FileSystem.AccessControl

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class LwbDpapi {
    [StructLayout(LayoutKind.Sequential)]
    public struct DATA_BLOB { public int cbData; public IntPtr pbData; }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CryptProtectData(ref DATA_BLOB pDataIn, string szDataDescr,
        ref DATA_BLOB pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct,
        uint dwFlags, out DATA_BLOB pDataOut);

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CryptUnprotectData(ref DATA_BLOB pDataIn, IntPtr ppszDataDescr,
        ref DATA_BLOB pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct,
        uint dwFlags, out DATA_BLOB pDataOut);

    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr hMem);

    // 不弹任何 UI：本进程无交互桌面，弹窗会直接挂死。
    const uint CRYPTPROTECT_UI_FORBIDDEN = 0x1;

    static byte[] Call(bool protect, byte[] input, byte[] entropy, out int err) {
        var inBlob = new DATA_BLOB();
        var entBlob = new DATA_BLOB();
        IntPtr inPtr = IntPtr.Zero, entPtr = IntPtr.Zero;
        try {
            inPtr = Marshal.AllocHGlobal(input.Length == 0 ? 1 : input.Length);
            if (input.Length > 0) Marshal.Copy(input, 0, inPtr, input.Length);
            inBlob.cbData = input.Length; inBlob.pbData = inPtr;

            if (entropy != null && entropy.Length > 0) {
                entPtr = Marshal.AllocHGlobal(entropy.Length);
                Marshal.Copy(entropy, 0, entPtr, entropy.Length);
                entBlob.cbData = entropy.Length; entBlob.pbData = entPtr;
            }

            DATA_BLOB outBlob;
            bool ok = protect
                ? CryptProtectData(ref inBlob, null, ref entBlob, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, out outBlob)
                : CryptUnprotectData(ref inBlob, IntPtr.Zero, ref entBlob, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, out outBlob);
            if (!ok) { err = Marshal.GetLastWin32Error(); return null; }

            try {
                var result = new byte[outBlob.cbData];
                if (outBlob.cbData > 0) Marshal.Copy(outBlob.pbData, result, 0, outBlob.cbData);
                err = 0;
                return result;
            } finally { LocalFree(outBlob.pbData); }
        } finally {
            if (inPtr != IntPtr.Zero) Marshal.FreeHGlobal(inPtr);
            if (entPtr != IntPtr.Zero) Marshal.FreeHGlobal(entPtr);
        }
    }

    public static byte[] Protect(byte[] input, byte[] entropy, out int err) { return Call(true, input, entropy, out err); }
    public static byte[] Unprotect(byte[] input, byte[] entropy, out int err) { return Call(false, input, entropy, out err); }
}
'@ -Language CSharp

$script:SystemSid = 'S-1-5-18'
$script:AdminsSid = 'S-1-5-32-544'
$script:CurrentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value

function Get-ObservedAcl {
    param([string]$Path)
    $acl = Get-Acl -LiteralPath $Path
    $rules = @()
    foreach ($rule in $acl.Access) {
        $sid = $null
        try {
            $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        } catch {
            # 无法解析成 SID 的引用（极罕见）：保留原文，交由 Node 侧判为不可接受。
            $sid = $rule.IdentityReference.Value
        }
        $rules += [ordered]@{
            sid          = $sid
            name         = $rule.IdentityReference.Value
            type         = $rule.AccessControlType.ToString()
            rights       = $rule.FileSystemRights.ToString()
            inherited    = [bool]$rule.IsInherited
            inheritance  = $rule.InheritanceFlags.ToString()
        }
    }
    # 属主的 SID。`$acl.Owner` 是一个**名字**（`MJ-LAPTOP-FVES0\mj`），
    # 而名字是本地化过的、可变的、且不带域时无法比较 —— 判定要的是 SID。
    # 解析不出时原样回显：那样的一串过不了 Node 侧的 SID 形状检查，
    # 结果是保守拒绝，而不是当成通过。
    $ownerSid = $acl.Owner
    try {
        $ownerSid = ([System.Security.Principal.NTAccount]::new($acl.Owner)).
            Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        # 极罕见（属主已不存在、或本来就是一串 SID）：保留原文。
    }

    return [ordered]@{
        # 用 FullName 而不是 $acl.Path：后者带 PowerShell 提供程序前缀
        # （`Microsoft.PowerShell.Core\FileSystem::C:\...`），不是可用的文件系统路径。
        path                     = (Get-Item -LiteralPath $Path -Force).FullName
        owner                    = $acl.Owner
        owner_sid                = $ownerSid
        access_rules_protected   = [bool]$acl.AreAccessRulesProtected
        rules                    = $rules
    }
}

function Op-Inspect {
    param([string]$Root)
    if (-not (Test-Path -LiteralPath $Root)) {
        throw [System.IO.DirectoryNotFoundException]::new("路径不存在：$Root")
    }
    return Get-ObservedAcl -Path $Root
}

function Op-Harden {
    param([string]$Root, [string[]]$Subdirectories)

    if (-not (Test-Path -LiteralPath $Root)) {
        New-Item -ItemType Directory -Path $Root -ErrorAction Stop | Out-Null
    }

    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
                   [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $propagation = [System.Security.AccessControl.PropagationFlags]::None

    $targets = @($Root)
    foreach ($sub in $Subdirectories) {
        $full = Join-Path $Root $sub
        if (-not (Test-Path -LiteralPath $full)) {
            New-Item -ItemType Directory -Path $full -ErrorAction Stop | Out-Null
        }
        $targets += $full
    }

    foreach ($target in $targets) {
        $acl = New-Object System.Security.AccessControl.DirectorySecurity
        # 断开继承并**丢弃**继承来的规则。
        # 这是本文件存在的核心理由：父目录的 DACL 未必只有本人可读。
        # 实测本机 %LOCALAPPDATA% 就带有一条继承自父级的
        # `MJ-LAPTOP-FVES0\CodexSandboxUsers: ReadAndExecute` 规则 ——
        # 「LocalAppData 是私有的」是假设，不是事实。
        $acl.SetAccessRuleProtection($true, $false)

        # 这里**不设属主**。原来的写法是
        #   $acl.SetOwner(当前用户)
        # 意图是「顺手确保这个目录属于自己」。它在本机实测中有代价，而且是
        # 致命的：属主是 ACL 的一部分，`SetAccessControl` 会把它一并应用，
        # 而**改属主需要目标对象的 WRITE_OWNER**。当前用户在自己的配置目录里
        # 有 FullControl，这条调用因此恒成功、看起来无害；但在只通过**组**
        # 授权的位置（例如 D: 上的项目目录：DACL 只有
        # `Authenticated Users: Modify`，没有当前用户自己的规则）当前用户
        # 没有 WRITE_OWNER，于是整个调用抛
        #   Attempted to perform an unauthorized operation.
        # 而 DACL 那半也**一起没写进去**（实锤：失败之后回读，DACL 仍是原样）。
        #
        # 本机实测（同一份 ACL、同一个探针脚本，只差设不设属主）：
        #
        # | 目标                                   | 只写 DACL | 连属主一起写 |
        # | ---                                    | ---       | ---          |
        # | D:\...\LocalWebGPT\.lwb-local\...      | 成功      | **失败：unauthorized operation** |
        # | %TEMP%\lwb-acl-probe-*                 | 成功      | 成功         |
        # | %LOCALAPPDATA%\LocalWorkspaceBridge-*  | 成功      | 成功         |
        #
        # 后果不是「少设了一项」：`LWB_HOME` / `--home` 指向这样的目录时
        # daemon **直接起不来**，而报错只说「未经授权的操作」，看不出与属主有关
        # —— `--home` 恰恰是排障时才会用的那个开关。
        #
        # 改成不设属主的另一半理由是它本来就多余：目录是我们自己创建的，
        # 属主已经是当前用户（回读 `owner_sid` 可核对）。而「属主是不是当前用户」
        # 这件事本身是**判定**，判定留在 Node 侧（`assessAcl` 的
        # UNEXPECTED_OWNER）：属主对对象有隐含的 WRITE_DAC，因此外人当属主时
        # 这份 DACL 随时可能被他改回去，保护不成立，必须拒绝启动。
        # 也就是说，「不设属主」不是放松，而是把一次做不到的提权尝试
        # 换成一句能被执行层读懂的判断。

        foreach ($sid in @($script:CurrentUserSid, $script:SystemSid, $script:AdminsSid)) {
            $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                [System.Security.Principal.SecurityIdentifier]::new($sid),
                [System.Security.AccessControl.FileSystemRights]::FullControl,
                $inheritance,
                $propagation,
                [System.Security.AccessControl.AccessControlType]::Allow)
            $acl.AddAccessRule($rule)
        }

        # 用 .NET 的 `SetAccessControl`，**不用** `Set-Acl`。
        #
        # `Set-Acl` 在**已经加固过**的目录上必然失败：
        #   The process does not possess the 'SeSecurityPrivilege' privilege
        #   which is required for this operation.
        # 本机实测（`Get-Acl`/`Set-Acl` 各一次、两次、以及只设保护位/只设属主
        # 等变体）：首次恒成功，**第二次起恒失败**，且与设了哪几项无关。
        # 换个写法用同一个 .NET 调用则两次都成功，产物 SDDL 逐字节相同：
        #   O:<user>D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;<user>)
        # 机制上说得通：该 cmdlet 会连带请求审计段（SACL），而 SACL 的读写
        # 需要 SeSecurityPrivilege —— 非提权进程没有，本项目也**不申请**管理员。
        #
        # 这不是「换个写法」的小事：daemon 每次启动都要加固存储根，
        # 所以用 `Set-Acl` 等于**第一次启动成功、之后每一次都启动失败**，
        # 而报错把原因说成权限不足 —— 排查方向会被引到 ACL 本身，
        # 而 ACL 恰恰是已经正确的那一个。
        #
        # 换掉写入方不削弱「实测为准」：下面紧接着就从磁盘回读，
        # 判定在 TypeScript 侧（`assessAcl`）。写入方是谁不影响回读的结论。
        #
        # 报错里带上**是哪一个**目标失败：加固会依次处理根与每个子目录，
        # 而异常文本里原本只有「SetAccessControl 调用失败」，问不出是哪一层
        # —— 上面那次排查为此专门写了一个探针脚本才定位到。目录名不是机密，
        # 存储根本身就已经打印在启动日志里。
        try {
            [System.IO.FileSystemAclExtensions]::SetAccessControl(
                [System.IO.DirectoryInfo]::new($target), $acl)
        } catch {
            throw [System.UnauthorizedAccessException]::new(
                "$target —— $($_.Exception.Message)", $_.Exception)
        }
    }

    # 回读**实测**结果，而不是回显我们以为自己设置了什么。
    return [ordered]@{
        targets = $targets
        observed = @($targets | ForEach-Object { Get-ObservedAcl -Path $_ })
        current_user_sid = $script:CurrentUserSid
        system_sid = $script:SystemSid
        administrators_sid = $script:AdminsSid
    }
}

function Op-Protect {
    param([string]$PlaintextB64, [string]$Entropy)
    $plain = [Convert]::FromBase64String($PlaintextB64)
    $ent = [System.Text.Encoding]::UTF8.GetBytes($Entropy)
    $err = 0
    $ct = [LwbDpapi]::Protect($plain, $ent, [ref]$err)
    if ($null -eq $ct) { throw [System.ComponentModel.Win32Exception]::new($err, "DPAPI 保护失败（Win32 $err）") }
    return [ordered]@{ ciphertext_b64 = [Convert]::ToBase64String($ct) }
}

function Op-Unprotect {
    param([string]$CiphertextB64, [string]$Entropy)
    $ct = [Convert]::FromBase64String($CiphertextB64)
    $ent = [System.Text.Encoding]::UTF8.GetBytes($Entropy)
    $err = 0
    $plain = [LwbDpapi]::Unprotect($ct, $ent, [ref]$err)
    if ($null -eq $plain) { throw [System.ComponentModel.Win32Exception]::new($err, "DPAPI 解密失败（Win32 $err）") }
    return [ordered]@{ plaintext_b64 = [Convert]::ToBase64String($plain) }
}

function Write-Response {
    param($Id, $Ok, $Data, $ErrorCode, $ErrorMessage)
    $payload = [ordered]@{ id = $Id; ok = [bool]$Ok }
    if ($Ok) { $payload['data'] = $Data } else {
        $payload['error'] = [ordered]@{ code = $ErrorCode; message = $ErrorMessage }
    }
    [Console]::Out.WriteLine(($payload | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }

    $request = $null
    try { $request = $line | ConvertFrom-Json } catch {
        Write-Response -Id $null -Ok $false -ErrorCode 'INVALID_ARGUMENT' -ErrorMessage "无法解析请求：$($_.Exception.Message)"
        continue
    }

    $op = [string]$request.op
    if ($op -eq '__exit__') { break }

    try {
        switch ($op) {
            'inspect' {
                Write-Response -Id $request.id -Ok $true -Data (Op-Inspect -Root ([string]$request.root))
            }
            'harden' {
                $subs = @()
                if ($null -ne $request.subdirectories) { $subs = @($request.subdirectories | ForEach-Object { [string]$_ }) }
                Write-Response -Id $request.id -Ok $true -Data (Op-Harden -Root ([string]$request.root) -Subdirectories $subs)
            }
            'protect' {
                Write-Response -Id $request.id -Ok $true -Data (Op-Protect -PlaintextB64 ([string]$request.plaintext_b64) -Entropy ([string]$request.entropy))
            }
            'unprotect' {
                Write-Response -Id $request.id -Ok $true -Data (Op-Unprotect -CiphertextB64 ([string]$request.ciphertext_b64) -Entropy ([string]$request.entropy))
            }
            'whoami' {
                Write-Response -Id $request.id -Ok $true -Data ([ordered]@{ user_sid = $script:CurrentUserSid; user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name })
            }
            default {
                Write-Response -Id $request.id -Ok $false -ErrorCode 'INVALID_ARGUMENT' -ErrorMessage "未知操作：$op"
            }
        }
    } catch {
        Write-Response -Id $request.id -Ok $false -ErrorCode 'MECHANISM_FAILED' -ErrorMessage $_.Exception.Message
    }
}
