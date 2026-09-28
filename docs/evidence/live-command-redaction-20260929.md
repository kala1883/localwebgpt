# Live MCP command-output redaction check — 2026-09-29

Status: **FAIL for the currently running service; source-code regression tests pass.**

## Scope

This was a live Local Workspace Bridge MCP connector call from Codex Apps, not a
ChatGPT browser conversation. It used the existing `maas_business` workspace and
printed a synthetic path-shaped marker only; the command did not read, create,
edit, or delete files and made no network request.

The earlier attempt against `本项目目录` was rejected with
`NOT_AUTHORIZED` / `CAPABILITY_NOT_GRANTED`; it did not return a command result.
This is consistent with command execution being separately authorized per
workspace rather than inferred from the general `direct_write_enabled` flag.

## Result

The harmless command emitted a synthetic `file:///...` marker and a second
completion marker. The live result was:

```text
exit_code=0
duration_ms=353
output_truncated=false
output_withheld=false
```

The returned stdout still contained the synthetic file-URL marker. This
contradicts the current source-level behavior, where the shared
`isSafeForModel()` filter rejects POSIX paths and file URLs and local tests pass.
The active daemon's exact source/build hash is unknown; `server_version=0.1.0`
is not a commit identity. Treat path redaction as **not live-verified** until
the service has loaded the current fix and this check is repeated.

No actual local path or file content was supplied to the command. Do not use
real path-bearing output in this still-running service until it is refreshed or
restarted and the same synthetic check returns `output_withheld=true` without
the marker in stdout.
