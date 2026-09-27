# LWB-039 tunnel reconnect evidence

Status: **PARTIAL**. The launcher keeps the existing daemon alive when its
Secure MCP Tunnel child exits, waits with capped backoff, reruns `doctor`, and
now rechecks the local ChatGPT-connection enable state after backoff before
`doctor`, and immediately before each tunnel run. The second check closes the
window where the operator disables the connection while `doctor` is running.
Reconnection cannot create workspace grants or open production capability
gates.

## Reproduction and result

```powershell
node --import tsx --test tests/unit/chatgpt-local-launch.test.ts
npm run typecheck
```

Observed: **15/15 tunnel-launch unit tests passed**; typecheck passed. The new
cases simulate (1) connection disabled during backoff, then locally re-enabled
before doctor and restart, (2) connection left disabled, and (3) connection
disabled during `doctor`, which blocks the next run.

## Behavior boundaries

- A runtime-key/configuration failure from `doctor` stops retries; it does not
  loop indefinitely or print the key.
- Stop during backoff or connection-enable waiting does not launch another
  tunnel process; the daemon remains under its single-instance lock until its
  normal shutdown path completes.
- Tool calls after a successful tunnel reconnect still pass the daemon's
  current connection/workspace authorization, read-ticket, approval-digest,
  expiry, pause, and recovery checks. The reconnect code does not cache or
  replay an approval.
- The retry tests use injected child-process results and time; they do **not**
  suspend this workstation or prove actual OS sleep/wake behavior.

## Not run / remaining

- Real Secure MCP Tunnel run with the user's Platform `tunnel_id` and runtime
  key; ChatGPT web tool discovery/read/write acceptance.
- Windows sleep/standby/hibernate and network-resume test against the real
  tunnel-client process.
- Explicit per-user startup-at-login option and a packaged interactive installer.
- Port conflict and real native-helper exceptions through the complete packaged
  launcher.

The implementation deliberately uses the foreground launcher and unit-level
supervision tests as evidence only; it is not an OS-level sleep test or a
release sign-off.
