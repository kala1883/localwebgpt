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
   `APPLIED` directly (no per-change console approval). Latest operation
   `op_4e98014ba13d45468e4012f6c5b76884` (`chg_ef081b1c-4b43-4a11-bd80-7035978eb4fe`)
   changed the Vue SHA-256 from
   `4c39d9d91a5692c6b166f6666c8c2fa8fceaca3f7271079a72f081c0f304ec27` to
   `b6fe002ac6f03501f93442051c3d7ca2af7fa66ba6030f5e09a85315a2b764e0`.
   A follow-up MCP `file_read` returned the same after-hash and expected marker.
4. `file_create` returned `APPLIED` in one call. Operation
   `op_7f28f2cf457e4907b21626b7782866a1` (`chg_c2df1cc4-a680-48e8-9dbc-ce362ad83239`) created
   `docs/lwb043-workspace-grant-acceptance.md` with SHA-256
   `1dea021a02eac740ed2ba010030f76e5eb02f1cdf3afc2c771d9f21830dd68e0`;
   a follow-up MCP `file_read` returned the same hash and expected content.
5. Only the Vue sample and generated note changed in the disposable working
   tree after its baseline commit. Git HEAD and staged diff remained unchanged;
   no post-baseline commit or push occurred.
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
