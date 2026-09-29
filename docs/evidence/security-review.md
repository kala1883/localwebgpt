# LWB-042 security review evidence

Status: **PARTIAL — a separate read-only source review has run; this is not a
security sign-off or release approval.** It found five actionable findings.
The snapshot-export and POSIX file-URL egress fixes are committed and tested.
The current uncommitted Windows builder/uninstaller replacements also have
local regression evidence, but the committed `main` paths remain unresolved
until that migration is landed and independently reviewed. No severity has
been lowered and no test was removed to obtain a pass.

## Evidence run in this pass

| Command | Result |
| --- | --- |
| `npm run check` | 1,839 pass / 15 skipped / 0 fail; Console 168/168; root/Console types, secret scan and 220-file import scan pass |
| `node --import tsx --test tests/unit/database-upgrade.test.ts` | 4/4 pass; verifies pre-migration snapshot, pending-recovery block, current/missing DB behavior, and refusal of a newer schema without mutating its bytes |
| `node --import tsx --test tests/windows/daemon-apply-tool.test.ts` | 14/14 pass on Windows/NTFS; includes tool-level two-file application where the second guarded write is denied, the first file is restored, and the MCP receipt reports `ROLLED_BACK` with per-file outcomes |
| `node --import tsx --test tests/windows/command-processes.test.ts` | 7 pass / 1 skip on Windows; includes a 26.5-second command with `timed_out=false` (the 60-second test watchdog is not a production command deadline) |
| `node --import tsx --test tests/windows/uninstall-runtime.test.ts` | 6/6 pass on Windows/NTFS, including junction swaps, ordinary-root replacement, read-only files, protected-state preservation and credential-log checks |
| `node --import tsx --test tests/windows/daemon-command-exec.test.ts` | 5/5 pass, including `file:///` path-output withholding |
| `npm run test:performance:lwb-044` | 1/1 pass on Windows/NTFS; five iterations; short run only, not an hours-long soak |
| Separate read-only source review | Five findings; no tests or scripts run and no files edited; incomplete areas are listed below |

The new focused suite is `tests/security/lwb-042.test.ts`. It proves at the tool
boundary that a different connection cannot read the workspace, `.env` is
rejected before `readFileGuarded`, oversized paths/queries are rejected before
filesystem access, and a model-supplied `approved:true` or a mismatched digest
cannot create an approval or operation. A hostile README is returned as
untrusted plain text; the MCP layer does not claim to neutralize prompt
injection. A legal Windows filename containing markup-like percent escapes is
kept as a path string, not interpreted by the daemon.

## Separate read-only source review (2026-09-29)

A non-implementer review agent inspected workspace/root authorization, native
reparse handling, IPC principal binding, control-plane Origin/CSRF/nonces,
command execution/output filtering, recovery/snapshot paths, and the Windows
runtime builder/uninstaller. It did not edit files or run scripts/tests. It did
not verify named-pipe DACL/OS-observed peer PID or fully trace multi-file
rollback orchestration; those areas remain open.

| Finding | Disposition |
| --- | --- |
| `showSaveFilePicker()` clears an existing file before its promise resolves, so the former post-picker existence check was too late. | Fixed in `1ccb8ca`: recovery export now selects a directory and creates a browser-generated random filename; tests verify existing canaries, name collisions and create races. The File System Access draft specifies the existing-file clearing behavior ([§3.4](https://wicg.github.io/file-system-access/#api-showsavefilepicker)). Real browser acceptance remains pending. |
| `command_exec` may keep running after the caller disconnects; there is no hard runtime deadline or request-disconnect cancellation. | The user explicitly chose to retain no hard timeout. This remains a documented behavior, not a security control: the process may continue under the daemon user's full OS permissions. |
| A local `SHA256SUMS.txt` could be replaced together with the archive, then bless and execute a substituted `tunnel-client.exe`. | **Open on committed `main`**: the legacy `packaging/windows/build-runtime.ps1` still uses the sidecar as its trust anchor. In the current uncommitted replacement, the version-pinned hash plus `runtime-build-integrity.test.ts` reject a matching poisoned archive/sidecar pair before creating the output directory; these changes are not on `origin/main` until the migration is approved and committed. |
| Uninstaller path-based reparse-point checks can race recursive deletion if another process swaps a directory for a junction. | **Implemented and locally validated in the current uncommitted replacement**: cleanup binds the selected runtime's volume/file ID, pins ancestor and tree-entry handles without following reparse points, deletes through handles, and stores the handoff marker outside the runtime. Windows/NTFS tests cover a pre-existing junction, read-only payloads, concurrent junction-swap attempts, an ordinary replacement directory at the same path, and external canaries. The committed `main` version still has the legacy path-based implementation until the Windows migration is landed; independent review of the replacement remains pending. |
| Command/error output screening missed POSIX paths inside `file:///...` URLs. | Source fix is in `3dfc893`; real PowerShell and `daemon-tools` regressions pass. The live MCP connector still returned `output_withheld=false` for a synthetic file URL, so runtime redaction is **not verified** until reload/restart; see [`live-command-redaction-20260929.md`](live-command-redaction-20260929.md). No file was read or written by that synthetic command. |

## Coverage map

| Area | Evidence | Remaining caveat |
| --- | --- | --- |
| Path/root boundaries | `tests/unit/policy.test.ts`, `tests/windows/workspaces-roots.test.ts`, `tests/windows/path-escape/`, new LWB-042 tests | Independent review of root identity/TOCTOU chain pending |
| Authentication and cross-connection isolation | `tests/unit/control-plane.test.ts`, `tests/unit/daemon-tools.test.ts`, new LWB-042 tests | Live ChatGPT identity/tunnel behavior not exercised here |
| Approval digest and write non-replay | `tests/unit/approvals.test.ts`, `tests/windows/daemon-apply-tool.test.ts`, `tests/fault-injection/guard-death.test.ts` | Independent review of all digest/expiry/recovery transitions pending |
| Secret egress and hard-denied paths | `tests/unit/egress.test.ts`, `tests/windows/files-search.test.ts`, `tests/windows/git-reader.test.ts` | Model handling of prompt-injected file content is not established by unit tests |
| Git history/status | `tests/windows/git-reader.test.ts` | No external repository/account acceptance in this pass |
| Audit ranges and redaction | `tests/unit/daemon-audit.test.ts` | Does not independently verify every production log sink/configuration |
| UI rendering of hostile content | `apps/console/tests/diff-view.spec.ts`; full Console suite | Live browser/ChatGPT renderer path not tested |
| Recovery/helper death | `tests/fault-injection/guard-death.test.ts` | Full independent crash/recovery review remains pending |
| `command_exec` | `tests/windows/command-processes.test.ts`, `tests/windows/daemon-command-exec.test.ts`, workspace-grant/policy tests | Confirms grant boundary, output bounds, inherited-secret filtering, output screening, and pause/revocation stop; no hard deadline by explicit user choice, may continue after caller disconnect, and is not a directory sandbox |
| Build/update provenance | `docs/release/build-record.md`, `docs/release/sbom.json` | The local replacement script pins a hash, but committed main's legacy builder still trusts a local sidecar; installer, independent supply-chain review and signature remain pending under LWB-045 |

### 2026-09-29 follow-up: command execution and findings

`command_exec` was added after the original review run. Its grant/catalog/handler,
output-filtering, revocation, pause and packaged-runtime tests pass. This
verifies only the declared behavior; it does not make shell execution confined
to the workspace. The tool runs as the current Windows user, can access
out-of-root resources and the network, and has no file-level rollback.

## Unresolved release risks / limitations

- **Independent sign-off: NOT_COMPLETE.** A separate source review has reported
  findings. The current working tree contains fixes for the checksum trust root
  and uninstaller reparse race, but they are not yet on `origin/main`;
  named-pipe DACL/peer-PID verification and full multi-file rollback review
  also remain open.
- Basic real ChatGPT web MCP acceptance: **PASS** for workspace discovery, a 28,859-ms command with `timed_out=false`, and a temporary file create/read/edit/read/delete lifecycle. Adversarial conversations, disconnect/reconnect, conflict and refusal matrices remain **NOT_RUN**; see [`live-workspace-grants-20260929.md`](live-workspace-grants-20260929.md).
- File contents can contain prompt-injection instructions. The tool contract
  identifies disk data as untrusted; safety still depends on the consuming
  model and was not proved against a live account.
- `command_exec` is an explicit high-risk capability, not a directory sandbox.
  A granted shell runs with the current Windows user's permissions, can access
  out-of-root files or the network, and bypasses the protected file writer and
  snapshot rollback. Output scanning cannot prevent direct network exfiltration.
- Unsaved editor buffers are outside the V1 disk-only source; the UI must not
  imply otherwise.
- Platform acceptance fields are informational. Production access is governed
  by explicit per-workspace grants; this report is not an independent security
  sign-off or a recommendation to grant broad roots.
- Runtime packaging/signing and independent update-chain review are incomplete.

Accordingly this document records test evidence and open risks, not a claim that
all security issues are closed. Keep LWB-042 **PARTIAL** and do not use this
report as a launch authorization.
