[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
  throw 'LocalWebGPT stop command is supported on Windows only.'
}

$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sidBytes = [System.Text.Encoding]::UTF8.GetBytes($currentSid)
$digestBytes = [System.Security.Cryptography.SHA256]::HashData($sidBytes)
$sidHash = [System.Convert]::ToHexString($digestBytes).ToLowerInvariant().Substring(0, 16)
$pipeName = "LocalWorkspaceBridge.$sidHash"
$pipeClient = [System.IO.Pipes.NamedPipeClientStream]::new(
  '.',
  $pipeName,
  [System.IO.Pipes.PipeDirection]::InOut
)

try {
  try {
    $pipeClient.Connect(2000)
  } catch [System.TimeoutException] {
    Write-Host '未连接到当前 Windows 用户的 LocalWebGPT 服务；它可能尚未运行。没有终止任何进程。'
    exit 0
  }

  $requestBytes = [System.Text.Encoding]::UTF8.GetBytes("LWB_STOP`n")
  $pipeClient.Write($requestBytes, 0, $requestBytes.Length)
  $pipeClient.Flush()

  $reply = [System.Text.StringBuilder]::new()
  $readBuffer = [byte[]]::new(1)
  $readDeadline = [DateTime]::UtcNow.AddSeconds(3)
  while ($reply.Length -lt 32) {
    $remainingMilliseconds = [int][Math]::Floor(($readDeadline - [DateTime]::UtcNow).TotalMilliseconds)
    if ($remainingMilliseconds -le 0) {
      throw 'LocalWebGPT 未在 3 秒内确认停止请求；没有终止任何进程。'
    }
    $readTask = $pipeClient.ReadAsync($readBuffer, 0, 1)
    if (-not $readTask.Wait($remainingMilliseconds)) {
      throw 'LocalWebGPT 未在 3 秒内确认停止请求；没有终止任何进程。'
    }
    $readCount = $readTask.Result
    if ($readCount -le 0 -or $readBuffer[0] -eq 10) { break }
    $nextByte = $readBuffer[0]
    if ($nextByte -ne 13) { [void]$reply.Append([char]$nextByte) }
  }
  if ($reply.ToString() -cne 'STOPPING') {
    throw 'LocalWebGPT 未确认停止请求；没有尝试终止任何进程。'
  }

  Write-Host 'LocalWebGPT 已接受停止请求。正在关闭隧道子进程和本地服务；请等待启动终端返回提示符。'
} finally {
  $pipeClient.Dispose()
  [Array]::Clear($sidBytes, 0, $sidBytes.Length)
  [Array]::Clear($digestBytes, 0, $digestBytes.Length)
}
