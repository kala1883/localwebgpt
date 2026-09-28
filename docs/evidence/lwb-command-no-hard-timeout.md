# Live `command_exec` no-hard-timeout smoke

Date: 2026-09-28

## Setup and scope

- The local source service was gracefully stopped and restarted after the no-hard-timeout change; `.env` validation passed without printing credential values, and Tunnel `/healthz` and `/readyz` both returned HTTP 200.
- On the ChatGPT Plugins → Local Workspace Bridge Manage page, **Refresh tools** was run without changing tool permissions or workspace grants. A new Temporary Chat then issued one `command_exec` call against the already-authorized `maas_business` workspace (`ws_2db8a9f54fe181181d70d0ba87ab056a`).
- The only command was `Start-Sleep -Seconds 26; Write-Output 'LWB_NO_HARD_TIMEOUT_OK'`. It waits and writes to stdout only; it does not read or modify files.

## Result

ChatGPT displayed the Local Workspace Bridge result:

```json
{
  "duration_ms": 28601,
  "exit_code": 0,
  "timed_out": false,
  "output_truncated": false,
  "output_withheld": false,
  "stdout": "LWB_NO_HARD_TIMEOUT_OK\r\n"
}
```

The 28.6-second runtime exceeds the former 25-second limit and confirms this live service did not impose that hard deadline. The model also loaded the app tool resource list once before calling `command_exec`; it made no other Local Workspace Bridge tool calls. The current `command_exec` schema does not accept a `summary` field, so none was sent.

This smoke verifies only a harmless long-running command. It does not prove sandboxing, cancellation on revocation/pause, behavior at the output cap, or that arbitrary commands are confined to the workspace. The command grant still executes with the LocalWebGPT user's permissions and the workspace root remains a working directory, not a sandbox.
