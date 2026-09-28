# LWB-015: workspace search deadline evidence

Date: 2026-09-28

## Observed ChatGPT behavior

- On the live `maas_business` workspace, an unscoped `text_search` for the unique acceptance marker returned `SERVICE_UNAVAILABLE`, IPC `TIMEOUT`, and `outcome_unknown=true`. No retry was issued.
- An immediate `bridge_status` call succeeded (`daemon_adapter_tunnel_reachable=true`, `paused=false`, protocol `lwb-ipc-v1`). A separate exact-file-glob search returned one match with `scope.complete=true`, `scanned_files=1`, `skipped_files=2447`, `denied_files=11`, and `scanned_bytes=24`.
- After deploying the first traversal-checkpoint change, a live unscoped search returned the marker and a partial result rather than IPC timeout, but took about 42 seconds and stopped at the 64 MiB byte budget (`scanned_files=1485`, `scanned_bytes=68,485,718`, `deadline_exceeded=false`, `scope.complete=false`).
- After restarting with the monotonic-clock correction, a new unscoped request returned `ok=true` without IPC timeout: `deadline_exceeded=true`, `byte_budget_exceeded=false`, `scope.complete=false`, `truncated=false`, `scanned_files=111`, `scanned_bytes=930,533`, and no matches/cursor. The partial result explicitly says the 3,000 ms budget expired. This does not prove that the marker or query is absent from the rest of the workspace.
- Therefore the MCP search tool and search grant worked for a narrow scope; the full-root call did not return an authoritative result and is not a “no matches” result.

## Root cause and correction

`LIMITS.SEARCH_TIME_BUDGET_MS` is 3 seconds. Two defects prevented that budget from doing its job: first, the search checked its clock only before each candidate file, so directory listing pages could run without yielding to it; second, it formed the deadline from `args.now` (epoch milliseconds) even though production `deps.clock` is `performance.now()` (monotonic milliseconds). The mixed clock origins made the deadline comparison false for practical runtimes. The generic 30-second IPC timeout then fired first, discarding the promised partial-result envelope.

The deadline now starts from `deps.clock()` itself. The walker accepts the shared cancellation/deadline checkpoint and evaluates it before and after directory-listing calls and between entries. The search visitor also checks before and after each guarded file scan. When the budget expires, it preserves validated matches and returns `deadline_exceeded=true` with `scope.complete=false` and an explanatory `incomplete_reason`; it does not claim that the workspace was fully searched. A single in-flight guarded file read is not preempted, but is checked immediately after it completes.

## Verification and remaining live check

- Search walker and text-search tests: **37/37 PASS**, including budget exhaustion during directory enumeration and mid-walk cancellation.
- Release-evidence dirty-tree tests: **4/4 PASS**; root typecheck passes.
- Full `npm run check` after the clock-origin correction passed: root **1,821 PASS / 15 SKIP / 0 FAIL**, Console **162/162 PASS**. Search tests are **37/37 PASS**, release-evidence tests **4/4 PASS**, and typecheck, FsGuard and secret scan pass.
- The live source daemon was restarted after the clock-origin correction; the newest unscoped ChatGPT call now returns the explicit 3-second partial-result envelope instead of IPC `TIMEOUT`. Because it found no match before the deadline and issued no continuation cursor, exact coverage still requires a narrower path/glob. The targeted exact-file search was also verified separately.
