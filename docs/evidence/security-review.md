# LWB-042 security review evidence

Status: **PARTIAL — not an independent review or release approval.** This
implementation pass added focused regressions and assembled evidence from
existing suites. The task requires review by a non-implementer; that review has
not occurred. No severity has been lowered and no test was removed to obtain a
pass.

## Evidence run in this pass

| Command | Result |
| --- | --- |
| `npm run test:security` | 3/3 pass |
| `node --import tsx --test tests/unit/control-plane.test.ts tests/unit/daemon-tools.test.ts tests/unit/egress.test.ts tests/unit/policy.test.ts tests/windows/daemon-apply-tool.test.ts tests/windows/files-search.test.ts tests/windows/git-reader.test.ts` | 259/259 pass; real Windows NTFS suites included |
| `node --import tsx --test tests/unit/daemon-audit.test.ts` | 49/49 pass |
| `npm run test:console` | 164/164 pass, including 28 `DiffView` tests |
| `node --import tsx --test tests/fault-injection/guard-death.test.ts` | 5/5 pass on real Windows processes/NTFS |
| `npm run typecheck` | pass |
| `npm run check:secrets` / `npm run check:imports` | pass; import scan checked 214 files |

The new focused suite is `tests/security/lwb-042.test.ts`. It proves at the tool
boundary that a different connection cannot read the workspace, `.env` is
rejected before `readFileGuarded`, oversized paths/queries are rejected before
filesystem access, and a model-supplied `approved:true` or a mismatched digest
cannot create an approval or operation. A hostile README is returned as
untrusted plain text; the MCP layer does not claim to neutralize prompt
injection. A legal Windows filename containing markup-like percent escapes is
kept as a path string, not interpreted by the daemon.

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
| Build/update provenance | `docs/release/build-record.md`, `docs/release/sbom.json` | Formal Windows runtime build, independent supply-chain review and signature remain pending under LWB-045 |

## Unresolved release risks / limitations

- **Independent reviewer: NOT_RUN.** The author of the implementation cannot
  sign off their own work as independent.
- Real ChatGPT web acceptance and adversarial conversations: **NOT_RUN**.
- File contents can contain prompt-injection instructions. The tool contract
  identifies disk data as untrusted; safety still depends on the consuming
  model and was not proved against a live account.
- Unsaved editor buffers are outside the V1 disk-only source; the UI must not
  imply otherwise.
- Platform acceptance fields are informational. Production access is governed
  by explicit per-workspace grants; this report is not an independent security
  sign-off or a recommendation to grant broad roots.
- Runtime packaging/signing and independent update-chain review are incomplete.

Accordingly this document records test evidence and open risks, not a claim that
all security issues are closed. Keep LWB-042 **PARTIAL** and do not use this
report as a launch authorization.
