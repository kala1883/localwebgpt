# LWB-015: workspace search deadline evidence

Date: 2026-09-28

## Observed ChatGPT behavior

- On the live `maas_business` workspace, an unscoped `text_search` for the unique acceptance marker returned `SERVICE_UNAVAILABLE`, IPC `TIMEOUT`, and `outcome_unknown=true`. No retry was issued.
- An immediate `bridge_status` call succeeded (`daemon_adapter_tunnel_reachable=true`, `paused=false`, protocol `lwb-ipc-v1`). A separate exact-file-glob search returned one match with `scope.complete=true`, `scanned_files=1`, `skipped_files=2447`, `denied_files=11`, and `scanned_bytes=24`.
- Therefore the MCP search tool and search grant worked for a narrow scope; the full-root call did not return an authoritative result and is not a “no matches” result.

## Root cause and correction

`LIMITS.SEARCH_TIME_BUDGET_MS` is 3 seconds, but before this correction the search checked its clock only before each candidate file. Directory listing pages could therefore be enumerated for a long time without yielding to the search budget; the generic 30-second IPC request timeout could fire first, discarding the promised partial-result envelope.

The walker now accepts the search cancellation/deadline checkpoint and evaluates it before and after directory-listing calls and between entries. The search visitor also checks before and after each guarded file scan. When the budget expires, it preserves validated matches and returns `deadline_exceeded=true` with `scope.complete=false` and an explanatory `incomplete_reason`; it does not claim that the workspace was fully searched. A single in-flight guarded file read is not preempted, but is checked immediately after it completes.

## Verification and remaining live check

- Search walker and text-search tests: **37/37 PASS**, including budget exhaustion during directory enumeration and mid-walk cancellation.
- Release-evidence dirty-tree tests: **4/4 PASS**; root typecheck passes.
- The last full `npm run check` (before widening the release-evidence `ENOENT` catch to cover hashing) passed: root **1,821 PASS / 15 SKIP / 0 FAIL**, Console **162/162 PASS**. After that narrow change, release-evidence tests are **4/4 PASS**, search tests **37/37 PASS**, and root typecheck passes.
- This source correction has not yet been loaded by the live ChatGPT tunnel process. Repeat one unscoped search only after deploying/restarting this commit; until then the live broad-search behavior remains **NOT_RETESTED**. The targeted exact-file search above was verified on the previous live daemon.
