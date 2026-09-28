# LWB-042 security review evidence

Status: **PARTIAL — a separate read-only source review has run; this is not a
security sign-off or release approval.** It found five actionable findings.
Two code paths have since been fixed and tested; the build-checksum and
uninstaller findings remain open. No severity has been lowered and no test was
removed to obtain a pass.

## Evidence run in this pass

| Command | Result |
| --- | --- |
| `npm run check` | 1,823 pass / 15 skipped / 0 fail; Console 168/168; root/Console types, secret scan and 219-file import scan pass |
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
| A local `SHA256SUMS.txt` could be replaced together with the archive, then bless and execute a substituted `tunnel-client.exe`. | **Open on committed `main`**: the legacy `packaging/windows/build-runtime.ps1` uses the sidecar as its trust anchor. The current uncommitted `deployment/windows/build-runtime.ps1` has a version-pinned hash, but that migration is not committed and its negative tamper test remains outstanding. |
| Uninstaller path-based reparse-point checks can race recursive deletion if another process swaps a directory for a junction. | **Open** in both the committed legacy path and the uncommitted replacement. Handle-relative deletion or another race-proof strategy plus an external-canary swap test is required. |
| Command output screening missed POSIX paths inside `file:///...` URLs. | Fixed in `3dfc893`; the real PowerShell command test now withholds the file-URL form. |

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
  findings, but the checksum trust root, uninstaller reparse race, named-pipe
  DACL/peer-PID verification and full multi-file rollback review remain open.
- Real ChatGPT web acceptance and adversarial conversations: **NOT_RUN**.
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
