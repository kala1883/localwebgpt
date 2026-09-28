# LWB-044 performance and bounded-runtime evidence

Status: **PARTIAL**. The opt-in Windows benchmark exercises real tool handlers,
the PowerShell/Win32 filesystem guard, an isolated NTFS Git repository, and the
current workspace-grant direct-write path. It edits a disposable file and reads
it back through MCP. This evidence does not grant access to a user's workspace.

## Reproduction

```powershell
$env:LWB_PERF_ITERATIONS = '5'
npm run test:performance:lwb-044
```

The default test suite skips this benchmark; the dedicated npm script explicitly
sets the opt-in flag for its child test process.

Latest observed exit code: `0`; **1/1 benchmark test passed** with five measured
iterations per repeated operation. The test uses only three `lwb044-*`
temporary roots and removes them in teardown. It terminates only the helper
child process started by its own test worker.

## Machine and fixture

- Windows `10.0.26200`, Node `v22.20.0`
- 13th Gen Intel Core i7-13620H, 16 logical CPUs, 16 GiB RAM
- Windows temporary volume `C:` (NTFS, 322,123,591,680 bytes); the benchmark
  queries the workspace volume and requires NTFS. OS cache state and cache
  eviction were not controlled.
- 1,004 synthetic hard-denied `.env.*` files, 80 small source files, README,
  and one 262,144-byte single-line file; **294,155 fixture bytes** in total.
- Five measured iterations per repeated operation. P95 uses the nearest-rank
  estimator; at `n=5`, P95 is the sample maximum and is not a strong tail claim.

## Measurements

| Operation | P50 | P95 | Notes |
| --- | ---: | ---: | --- |
| File read, first touch | — | — | 203.24 ms; not a true cold-cache measurement |
| File read, warm (`n=5`) | 27.50 ms | 47.93 ms | Same bytes/hash on every read |
| Workspace search (`n=5`) | 1,352.32 ms | 1,599.20 ms | All five calls completed within the 3-second budget |
| Search of 256 KiB long line (`n=5`) | 37.57 ms | 41.89 ms | One file/262,145 bytes scanned; bounded response |
| Git status (`n=5`) | 1,350.57 ms | 1,569.95 ms | `truncated=false`; serialized response 6,383 bytes |
| Direct `file_edit` + MCP readback | — | — | 214.60 ms; `APPLIED` receipt hash matched the subsequent MCP readback |
| Read after 5 seconds idle | — | — | 9.98 ms |
| Helper exit → next-call restart | — | — | 1,608.72 ms; first call failed closed, next independent call succeeded |

Search saw all 1,004 hard-denied names on the last iteration but never sent any
of those paths to the guarded file-read API. Each search scanned 82 ordinary
text files, returned a 657-byte JSON payload, and reported a complete scope.
Git status remained bounded at 6,383 serialized bytes.

Node RSS increased by 26,079,232 bytes over this short run; Windows process
handle count was 264 before and after (delta `0`). These are before/after
observations, not a leak-free long-duration proof. Search has no persistent
content index/cache; OS filesystem caching remains outside this measurement.

The write timing now measures the current policy: the harness has a workspace
grant, `file_edit` returns `APPLIED` in one call, and a following MCP `file_read`
checks the write receipt hash. No per-call local approval step is included.

## Recovery behavior

`PowerShellWinfsBackend` now detects when its resident helper has exited,
returns that operation's failure without replay, and clears the stale transport.
The next independent request starts and capability-checks a fresh helper. The
benchmark terminates only the helper process it created in the disposable test
worker; it does not target the user's daemon or other process.

## Not run / remaining

- Windows sleep/standby/hibernate and resume of the **same** helper process.
- Hour-scale idle soak, memory/handle trend sampling, or OS cache eviction.
- A statistically meaningful tail-latency run on multiple disks/machines.
- Browser/ChatGPT live acceptance; this benchmark is local and does not prove
  the remote web client path.

Accordingly LWB-044 remains **PARTIAL**. Do not quote the timings as general
product guarantees; they describe only this machine and this synthetic fixture.
