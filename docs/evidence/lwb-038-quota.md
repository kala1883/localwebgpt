# LWB-038 snapshot quota and periodic maintenance evidence

Status: **PARTIAL**. The daemon now has a configurable snapshot-object byte
cap, batch preflight before the first snapshot is written, and a single-flight
hourly GC loop. This does not claim filesystem-wide free-space reservation or a
multi-hour soak.

## Configuration

- Default cap: **1 GiB** of snapshot object bytes.
- Local override: `snapshot_store_max_bytes` in the root `.env`, decimal bytes.
- Absolute hard ceiling: **2 GiB**; malformed, zero, unsafe or above-ceiling
  values fail daemon startup rather than silently disabling the cap.
- The cap counts regular files physically present under the protected `objects`
  directory, including orphaned objects discovered on the first quota check. It
  does not count filesystem allocation overhead or unrelated files on the disk.
- Lowering the cap below existing object usage deletes nothing. New distinct
  snapshot data is refused until the store is under the cap; deduplicated content
  can still be reused.

## Write-refusal proof

`BlobStore.putAndRegisterBatch` serializes batches, computes the unique new
content-addressed bytes, and checks the full batch before writing the first
object. `change_prepare` maps quota exhaustion to
`STORAGE_UNAVAILABLE` / `SNAPSHOT_QUOTA_EXCEEDED`. The Windows test sets the cap
to one byte and uses a real temporary NTFS workspace plus the real PowerShell /
Win32 guard. Both an edit and create proposal were rejected; the original file
SHA stayed identical, the new file remained absent, no object/ref row was
created, and no write guard method was called.

## Capacity lifecycle

- Duplicate snapshots are counted once by content hash.
- GC decrements the live in-process byte counter only after deleting the object;
  a new store rescans the physical object tree.
- Startup clears crash-left temporary files and runs retention-aware GC.
- Runtime maintenance runs hourly, single-flight. It expires eligible changes,
  then collects only when there are no queued/validating/applying or
  recovery-required operations and no workspace currently requiring recovery.
  Per-object retention remains governed by `snapshotGuard`.
- Shutdown cancels the schedule and awaits a pass already in flight. Runtime
  maintenance deliberately does not sweep `.tmp` files, which could belong to a
  live prepare operation.

## Tests executed

- `node --import tsx --test tests/unit/blob-store.test.ts tests/unit/snapshot-quota.test.ts tests/unit/blob-quota.test.ts tests/unit/snapshot-maintenance.test.ts tests/unit/chatgpt-local-launch.test.ts tests/unit/changes-invalidation.test.ts`: **87/87 passed**.
- `node --import tsx --test tests/windows/lwb038-storage-quota.test.ts`: **1/1 passed** on Windows/NTFS with the real path guard.
- `npm run typecheck`, `npm run check:secrets`, `npm run check:imports`: passed; import scan covered 216 files.
- PowerShell AST parse of `scripts/windows/Start-LocalWebGPT.ps1`: passed.

## Remaining

- No multi-hour disk-pressure/maintenance soak was run.
- Full daemon assembly with the maintenance timer was not observed through an hour-long runtime test.
- The cap reserves snapshot-object logical bytes, not all free disk space; an
  operating-system disk-full condition can still occur, but proposal
  preparation fails before applying workspace bytes.
- GC does not run immediately on a quota refusal; the hourly schedule or a
  daemon restart can reclaim expired/pending snapshots. Active and
  recovery-required snapshots remain protected.

Therefore LWB-038 remains **PARTIAL** pending a longer soak and operational
review of quota/reclamation behavior.
