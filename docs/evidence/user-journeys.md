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

Latest observed run: **2026-09-29**, exit code `0`; **1/1 test passed**.
Source commit: `99f312a451f7e897ac66acb7640393dab4857413`; source worktree was
clean both before and after. The test copied only four tracked files into a
fresh temp NTFS Git repository and removed its four temporary roots in teardown.

## Observed journey

1. Read the MyAgent security module and AiGroup configuration through
   `file_read`; searched the AiGroup phrase with `text_search` and found two
   matches. Read the MyAgent host-read documentation too. Read hashes were
   `226ebe544ecc739d6ecf286db3ad4711d6ccfd9dbf5844fdc7f07f43eb773660`
   (MyAgent) and `d764dcc0263c2697da4ff78594f348cf60a5d461173c7bd98b906ff0b746f3ff`
   (AiGroup).
2. Committed the four-file baseline **inside the disposable copy only**, then
   appended a synthetic saved-but-unstaged marker to its Vue sample. `file_read`
   reported `source=disk`, saw the marker, and returned the exact baseline hash.
3. With the workspace's file-modification grant, `file_edit` returned
   `APPLIED` directly (no per-change console approval). Operation
   `op_1e8149f4f64244cf8e2fbe26dc3d3c6d`
   (`chg_21f7fbbd-fe02-4868-9ecc-f65c08af2c06`) changed the Vue SHA-256 from
   `458cff439ecfb8d231668de522fd0a6ae2850276b00c530d2c385909bc81df59` to
   `29cb24df866543b54a9591ac3c52a0b9ead47f2778812d110f2786d1103349e3`.
   A follow-up MCP `file_read` returned the same after-hash and expected marker.
4. `file_create` returned `APPLIED` in one call. Operation
   `op_9f5102b671b14761ac0d2b68d82ebd60`
   (`chg_b6c2838a-ba94-4306-8f93-c64d4f20fb80`) created
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
