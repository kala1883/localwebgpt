# LWB-043 TransportAndAI controlled-copy journey evidence

Status: **PARTIAL**. The current run validates the real Windows filesystem guard,
LocalWebGPT tool handlers, one-call workspace-granted writes, and MCP readback
against a disposable copy of representative TransportAndAI files. It does not
validate the desktop daemon/tunnel path or ChatGPT's live web client.

## Reproduction

On Windows, point the test at a clean controlled TransportAndAI copy:

```powershell
$env:LWB043_SOURCE_ROOT = 'D:\MyProjects\MyApps\transportandai-ma026-vue'
npm run acceptance:lwb043
```

Latest observed run: exit code `0`; **1/1 test passed**. Source commit:
`99f312a451f7e897ac66acb7640393dab4857413`; source worktree was clean before
and after. The test copied only four tracked files into a fresh temp NTFS Git
repository and removed that repository in teardown.

## Observed journey

1. Read the MyAgent security module and AiGroup configuration through
   `file_read`; searched the AiGroup phrase with `text_search` and found two
   matches. Read the MyAgent host-read documentation too.
2. Committed the four-file baseline **inside the disposable copy only**, then
   appended a synthetic saved-but-unstaged marker to its Vue sample. `file_read`
   reported `source=disk`, saw the marker, and returned the exact baseline hash.
3. With the workspace's file-modification grant, `file_edit` returned
   `APPLIED` directly (no per-change console approval). Operation
   `op_f4ad08a80e924372b7f48ca71b8918d2` changed the Vue SHA-256 from
   `56cc0485e28716109071a02a086c89dc1fbbd00fea9223b939fb7218b4726316` to
   `92aafef14241322261618da03a78e16e416b6324a3b18f139a3dee4b75cb5a42`.
   A follow-up MCP `file_read` returned the same after-hash and expected marker.
4. `file_create` returned `APPLIED` in one call. Operation
   `op_0aa647f88b644ecd999533f5e078ba0d` created
   `docs/lwb043-workspace-grant-acceptance.md` with SHA-256
   `1dea021a02eac740ed2ba010030f76e5eb02f1cdf3afc2c771d9f21830dd68e0`;
   a follow-up MCP `file_read` returned the same hash and expected content.
5. Only the Vue sample and generated note changed in the disposable working
   tree. Git HEAD and staged diff were unchanged; no commit or push occurred.
   The outside-workspace canary retained its hash, and the original controlled
   source copy remained clean.

This uses test-harness facts and real per-workspace grants. It does not change
production configuration or run against the original TransportAndAI working
tree. The V1 disk reader cannot see an editor's unsaved buffer.

## Remaining acceptance

- Live ChatGPT browser tool sequence and saved-file readback: **NOT_RUN**.
- Unsaved editor buffer: unsupported by the V1 disk-only read contract.
- Main TransportAndAI working tree: deliberately not edited; the test uses a
  separate clean controlled copy.

This is test evidence, not an independent security review or a release sign-off.
