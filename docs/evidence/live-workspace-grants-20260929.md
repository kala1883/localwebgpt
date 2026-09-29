# Live workspace-grant and MCP file-tool check — 2026-09-29

Status: **LIVE CHATGPT WEB AND CODEX-CONNECTOR ACCEPTANCE — PARTIAL.** A real
ChatGPT web conversation discovered and called `workspace_list` and
`command_exec`, and completed a temporary file create/edit/delete sequence. The
active service still does not return `granted_tools` or `build_id`. The daemon
was not restarted or paused, and no grants or pre-existing workspace files were
changed by the web smoke; its uniquely named temporary file was verified
absent. Separate source-tree edits are recorded in the repository diff.

## Observed connector responses

- `workspace_list` returned two enabled directory workspaces: `maas_business`
  and `本项目目录`. Each summary contained the legacy daemon-level
  `capabilities` flags (`read_enabled`, `git_enabled`, `proposal_enabled`,
  `direct_write_enabled`, `recovery_required`), but no `granted_tools` field.
- `bridge_status` returned protocol `lwb-ipc-v1`, contract `0.1.0`,
  `server_version=0.1.0`, `paused=false`, and zero pending stop/recovery counts.
  It did not return `build_id`; the source now adds one for future deployments.
  The same response said the platform/native-guard verification values are
  informational and do not close locally granted workspace tools.

## Live command grant smoke

Using the `maas_business` workspace ID returned by `workspace_list`, the
connector ran a no-write PowerShell command:

```powershell
Write-Output 'LWB_LIVE_COMMAND_SMOKE_20260929'
```

The result was exit code 0 in 353 ms, with `timed_out=false`,
`output_withheld=false`, and the expected fixed marker in stdout. PowerShell
also emitted its normal first-use progress record in stderr. The command did
not access files or the network. This confirms that `command_exec` is currently
usable in `maas_business`; the missing `granted_tools` field is an observability
gap, not proof that this workspace lacks its command grant.

The same no-write marker command was then sent to `本项目目录`. The daemon
rejected it with `NOT_AUTHORIZED`, `CAPABILITY_NOT_GRANTED`, and
`policy_check=connection`; no shell result or command output was returned. This
is the expected negative result for that workspace's current grant. Together,
the two calls confirm that a tool can be discoverable for a connection while
its command capability is allowed on `maas_business` and denied on the project
workspace.

A follow-up duration check ran `Start-Sleep -Seconds 26; Write-Output
LWB_LONG_COMMAND_OK` on the granted `maas_business` workspace. The live MCP
result returned exit code 0 after 26,767 ms with `timed_out=false`, no truncation
or withholding, and the expected marker. It performed no file or network
operations. PowerShell emitted a first-use CLIXML progress record on stderr;
that output was returned as-is. This confirms the current local execution path
has no 25-second hard deadline; it does not test caller-disconnect behavior or
the ChatGPT web UI.

Regression coverage was added in `tests/windows/command-processes.test.ts`:
the Windows run passed 7 tests and skipped 1 WSL Bash case, including a
26,508-ms process result with `timed_out=false`. Its 60-second watchdog belongs
to the test runner only; production `command_exec` remains without a hard
runtime deadline.

## Real ChatGPT webpage acceptance

In a new ChatGPT conversation, the Plugins page showed Local Workspace Bridge as
connected; **Try in chat** attached it to the conversation. ChatGPT then called
`workspace_list` and reported both enabled workspaces and their legacy
capability flags. It correctly said `granted_tools` was not present in the
response rather than guessing. This was an actual ChatGPT webpage tool call,
not only an adapter test or Codex-side MCP call.

The same web conversation ran a PowerShell command in the returned
`maas_business` workspace:

```powershell
Start-Sleep -Seconds 26; Write-Output LWB_CHATGPT_LONG_COMMAND_OK
```

The successful result was `exit_code=0`, `duration_ms=28859`,
`timed_out=false`, and stdout `LWB_CHATGPT_LONG_COMMAND_OK`; stderr contained
PowerShell's first-use CLIXML progress record. No files or network were touched.
An initial attempt was rejected before process start because the model omitted
the required `idempotency_key`; the retry used a stable key and completed once.

The web conversation also completed the temporary
`docs/evidence/lwb-chatgpt-web-smoke-20260929.txt` lifecycle in `本项目目录`:
`file_create` → `file_read` → exact-line `file_edit` → `file_read` →
`file_delete` → final `file_read=NOT_FOUND`. The first create attempt omitted
the required `summary` and was rejected before writing; a local existence check
confirmed the path remained absent before the corrected request. The final
read and an independent local `Test-Path` both confirmed that the temporary
file is absent. No other path was read or changed, and no project test was
claimed as run by the web tool. The observed pre-execution schema rejections
have been captured in the ChatGPT evaluation contract: create/edit/delete must
include `summary` and stable `idempotency_key` values before the tool call.
The working-tree tool descriptions now state those fields are mandatory and
that exact retries reuse the same key; `tests/unit/chatgpt-evals.test.ts`
asserts the descriptions and eval requirements. The live service has not yet
been restarted, so this description fix has not been reloaded into the ChatGPT
connection. The real-process MCP adapter E2E now also asserts that `tools/list`
forwards the required `summary`/`idempotency_key` schema and explicit write
descriptions; its Windows run passes 12/12.

## Live file-read consistency

The connector then read the saved `package.json` from `本项目目录` (53 lines,
not truncated). The first response's SHA-256 matched the local file, but it
reported mixed LF/CRLF newlines and correctly withheld an editable read ticket.
The local manifest's line endings were normalized to CRLF without changing its
JSON data. A second MCP `file_read` then reported `newline=crlf`,
`editable=true`, and SHA-256
`91117bdd0d5fcefc2fd21c169c6d00141c6f3eb910b0eec7ecb9b58949157254`; a local
SHA-256 check matched exactly. No `file_edit` was called.

A scan of changed text files found the same mixed-newline blocker in 24 other
source/document files and two Console Vue views. Those 26 files were normalized
to CRLF with canonical text equivalence checks; live `file_read` then reported
CRLF/editable metadata and matching local hashes for representative daemon,
contract, operator-guide, and Console-view files. The two README files were
left unchanged because their content is independently redacted by the egress
policy, so newline normalization alone would not make them editable.

## Live file-tool lifecycle — `本项目目录`

Before writing, the local checkout confirmed that
`docs/evidence/lwb-web-mcp-smoke-20260929.txt` did not exist. Using the
workspace ID returned by `workspace_list`, the MCP connector then completed:

| Tool | Result |
| --- | --- |
| `file_create` (`req_55`) | `APPLIED`, file `VERIFIED`; created `phase=created` |
| `file_read` (`req_56`) | `editable=true`, `newline=lf`, exact content and matching SHA-256; its read token was used only for the next call and is intentionally not recorded |
| `file_edit` (`req_58`) | `APPLIED`, file `VERIFIED`; changed the exact line to `phase=edited` |
| `file_read` | Confirmed `phase=edited` before cleanup |
| `file_delete` (`req_60`) | `APPLIED`, file `VERIFIED` |
| final `file_read` (`req_61`) | `NOT_FOUND`; confirms the temporary path no longer exists |

The marker in this section was created solely for the Codex-connector smoke and
is absent now. The separate ChatGPT webpage file lifecycle is recorded above.

## Interpretation

The real ChatGPT webpage now confirms app discovery and successful execution of
the tested tools. However, `granted_tools` and `build_id` remain **absent from
the currently running connector/service response**, despite being present in
the working-tree contract and isolated MCP E2E tests. The observation does not
distinguish an older daemon from stale connector metadata; `server_version=0.1.0`
alone does not identify the source commit. This absence is not evidence that
either workspace lacks an individual grant.

The daemon enforces a single instance per Windows user SID. Starting the
disposable browser-acceptance daemon while the user's instance is active would
be rejected as `already_running`; the running instance was left untouched.
Rebuild/restart and a subsequent MCP metadata refresh are required before a
live ChatGPT check can verify the new field. The current web check did not
exercise conflicts, caller disconnect, reconnect, or adversarial conversations;
no user authentication or browser security settings were automated.
