import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const OPEN_BROWSER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$targetUrl = $env:LWB_CONSOLE_STARTUP_URL',
  '$env:LWB_CONSOLE_STARTUP_URL = $null',
  '$startInfo = [System.Diagnostics.ProcessStartInfo]::new()',
  '$startInfo.FileName = $targetUrl',
  '$startInfo.UseShellExecute = $true',
  '$null = [System.Diagnostics.Process]::Start($startInfo)',
].join('; ');

async function launchWindowsBrowser(url: string): Promise<void> {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(?:CONTROL_PLANE_API_KEY|CONTROL_PLANE_TUNNEL_ID|OPENAI_API_KEY|LWB_IPC_SECRET_.*)$/i.test(name)) {
      delete env[name];
    }
  }
  env['LWB_CONSOLE_STARTUP_URL'] = url;
  // Use the registered HTTP handler. Keep the one-time URL out of argv and
  // remove it from the helper environment before starting the browser.
  await execFileAsync(
    'pwsh.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', OPEN_BROWSER_SCRIPT],
    { env, windowsHide: true, timeout: 10_000 },
  );
}

export async function openConsoleInDefaultBrowser(
  url: string,
  options: {
    readonly launch?: (url: string) => Promise<void>;
    readonly log?: (message: string) => void;
  } = {},
): Promise<boolean> {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
      parsed.port.length === 0 || parsed.pathname !== '/' || parsed.search !== '' ||
      parsed.username !== '' || parsed.password !== '' ||
      !/^#t=lwb_boot_[A-Za-z0-9_-]+$/.test(parsed.hash)
    ) {
      throw new Error('Invalid console startup URL');
    }
    await (options.launch ?? launchWindowsBrowser)(url);
    log('已通过 Windows 默认浏览器打开本地管理界面。');
    return true;
  } catch {
    // Browser association failures must not stop the daemon or expose the
    // startup token through child-process errors.
    log('无法自动打开默认浏览器；请复制终端里的控制台地址手动打开。');
    return false;
  }
}
