# LWB-015: workspace search deadline evidence

Date: 2026-09-28

## Observed ChatGPT behavior

- On the live `maas_business` workspace, an unscoped `text_search` for the unique acceptance marker returned `SERVICE_UNAVAILABLE`, IPC `TIMEOUT`, and `outcome_unknown=true`. No retry was issued.
- An immediate `bridge_status` call succeeded (`daemon_adapter_tunnel_reachable=true`, `paused=false`, protocol `lwb-ipc-v1`). A separate exact-file-glob search returned one match with `scope.complete=true`, `scanned_files=1`, `skipped_files=2447`, `denied_files=11`, and `scanned_bytes=24`.
- After deploying the first traversal-checkpoint change, a live unscoped search returned the marker and a partial result rather than IPC timeout, but took about 42 seconds and stopped at the 64 MiB byte budget (`scanned_files=1485`, `scanned_bytes=68,485,718`, `deadline_exceeded=false`, `scope.complete=false`).
- Therefore the MCP search tool and search grant worked for a narrow scope; the full-root call did not return an authoritative result and is not a “no matches” result.

## Root cause and correction

`LIMITS.SEARCH_TIME_BUDGET_MS` is 3 seconds. Two defects prevented that budget from doing its job: first, the search checked its clock only before each candidate file, so directory listing pages could run without yielding to it; second, it formed the deadline from `args.now` (epoch milliseconds) even though production `deps.clock` is `performance.now()` (monotonic milliseconds). The mixed clock origins made the deadline comparison false for practical runtimes. The generic 30-second IPC timeout then fired first, discarding the promised partial-result envelope.

The deadline now starts from `deps.clock()` itself. The walker accepts the shared cancellation/deadline checkpoint and evaluates it before and after directory-listing calls and between entries. The search visitor also checks before and after each guarded file scan. When the budget expires, it preserves validated matches and returns `deadline_exceeded=true` with `scope.complete=false` and an explanatory `incomplete_reason`; it does not claim that the workspace was fully searched. A single in-flight guarded file read is not preempted, but is checked immediately after it completes.

## Verification and remaining live check

- Search walker and text-search tests: **37/37 PASS**, including budget exhaustion during directory enumeration and mid-walk cancellation.
- Release-evidence dirty-tree tests: **4/4 PASS**; root typecheck passes.
- Full `npm run check` after the clock-origin correction passed: root **1,821 PASS / 15 SKIP / 0 FAIL**, Console **162/162 PASS**. Search tests are **37/37 PASS**, release-evidence tests **4/4 PASS**, and typecheck, FsGuard and secret scan pass.
- The current live daemon was started before the clock-origin correction and has not loaded it yet. Repeat one unscoped search after deploying/restarting the latest source; until then the final broad-search behavior remains **NOT_RETESTED**. The targeted exact-file search was verified on a live daemon.
