/**
 * LWB-044 bounded Windows performance run.
 *
 * This is an opt-in integration benchmark, not part of the fast default suite:
 *   node --import tsx --test tests/performance/lwb-044.test.ts
 *
 * It creates and removes only its own temporary NTFS roots. “First-touch” is
 * deliberately not called a cold-cache read: Windows cache eviction is not
 * available to this process and would make the measurement misleading.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { approveChange } from '@lwb/approvals';
import type {
  ChangeApplyData,
  ChangePrepareData,
  FileReadData,
  GitStatusData,
  TextSearchData,
} from '@lwb/contracts';
import { PowerShellWinfsBackend } from '@lwb/winfs';
import type { WinfsOps } from '@lwb/winfs';
import type { WorkspaceEnvironment } from '@lwb/workspaces';

import {
  GATES_ON,
  NOW,
  callTool,
  dataOf,
  errorOf,
  makeToolHarness,
  type ToolHarness,
} from '../tools/harness.ts';

const isWindows = process.platform === 'win32';
const runBenchmark = isWindows && process.env.LWB_PERF_RUN === '1';
const describeWindows = runBenchmark ? describe : describe.skip;
const ITERATIONS = Math.max(5, Math.min(30, Number(process.env.LWB_PERF_ITERATIONS ?? 10)));
const DENIED_FILES = 1_004;
const REGULAR_FILES = 80;
const LONG_LINE_BYTES = 256 * 1024;
const SEARCH_NEEDLE = 'lwb044-benchmark-needle';
let guardedReads: string[] = [];

interface Samples {
  readonly count: number;
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly max_ms: number;
}

function summarize(values: readonly number[]): Samples {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number): number =>
    sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
  return {
    count: sorted.length,
    p50_ms: Number(percentile(50).toFixed(2)),
    p95_ms: Number(percentile(95).toFixed(2)),
    max_ms: Number((sorted.at(-1) ?? 0).toFixed(2)),
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
}

function git(root: string, args: readonly string[]): void {
  const result = spawnSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'LWB benchmark',
      GIT_AUTHOR_EMAIL: 'lwb-benchmark@invalid.example',
      GIT_COMMITTER_NAME: 'LWB benchmark',
      GIT_COMMITTER_EMAIL: 'lwb-benchmark@invalid.example',
    },
    windowsHide: true,
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

/** Forward every real backend method while counting actual guarded reads. */
function countingOps(backend: WinfsOps, reads: string[]): WinfsOps {
  return {
    capability: () => backend.capability(),
    statVolume: (request) => backend.statVolume(request),
    validatePath: (request) => backend.validatePath(request),
    resolvePath: (request) => backend.resolvePath(request),
    readFileGuarded: (request) => {
      reads.push(request.relative_path);
      return backend.readFileGuarded(request);
    },
    writeFileGuarded: (request) => backend.writeFileGuarded(request),
    createFileGuarded: (request) => backend.createFileGuarded(request),
    listDirectory: (request) => backend.listDirectory(request),
  };
}

function processHandleCount(): number | null {
  if (!isWindows) return null;
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).HandleCount`],
    { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
  );
  if (result.status !== 0) return null;
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) ? value : null;
}

function ownedHelperPid(): number {
  const command =
    `$parent=${process.pid}; ` +
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent" | ` +
    `Where-Object { $_.Name -eq 'pwsh.exe' -and $_.CommandLine -like '*WinfsGuard.ps1*' -and $_.CommandLine -like '*-Server*' } | ` +
    `Select-Object -First 1 -ExpandProperty ProcessId`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  assert.equal(result.status, 0, `could not identify the benchmark-owned helper: ${result.stderr}`);
  const pid = Number(result.stdout.trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'must find the helper started by this test worker');
  return pid;
}

function temporaryVolume(root: string): { drive: string; file_system: string; size_bytes: number } {
  const letter = path.parse(root).root[0]?.toUpperCase();
  assert.match(letter ?? '', /^[A-Z]$/, 'temporary workspace must reside on a local drive');
  const command =
    `$volume=Get-Volume -DriveLetter '${letter}'; ` +
    `[Console]::WriteLine($volume.FileSystem); [Console]::WriteLine($volume.Size)`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  assert.equal(result.status, 0, `could not inspect temporary test volume: ${result.stderr}`);
  const [fileSystem, size] = result.stdout.trim().split(/\r?\n/);
  assert.equal(fileSystem, 'NTFS', 'LWB-044 real-backend benchmark requires NTFS');
  const sizeBytes = Number(size);
  assert.ok(Number.isSafeInteger(sizeBytes) && sizeBytes > 0);
  return { drive: `${letter}:`, file_system: fileSystem, size_bytes: sizeBytes };
}

describeWindows('LWB-044 bounded Windows performance run', () => {
  let root = '';
  let envRoot = '';
  let otherRoot = '';
  let backend: PowerShellWinfsBackend;
  let harness: ToolHarness;
  let fixtureBytes = 0;
  let volume: { drive: string; file_system: string; size_bytes: number };

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'lwb044-workspace-'));
    volume = temporaryVolume(root);
    envRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb044-private-'));
    otherRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb044-other-'));

    const writeFixture = async (target: string, body: string): Promise<void> => {
      await writeFile(target, body, 'utf8');
      fixtureBytes += Buffer.byteLength(body);
    };
    await writeFixture(path.join(root, 'README.md'), `baseline ${SEARCH_NEEDLE}\n`);
    await mkdir(path.join(root, 'long'), { recursive: true });
    await writeFixture(path.join(root, 'long', 'line.txt'), `${'x'.repeat(LONG_LINE_BYTES)}\n`);
    await mkdir(path.join(root, 'src'), { recursive: true });
    for (let i = 0; i < REGULAR_FILES; i += 1) {
      const body = i === 0 ? `export const marker = '${SEARCH_NEEDLE}';\n` : `export const row = ${i};\n`;
      await writeFixture(path.join(root, 'src', `file-${String(i).padStart(3, '0')}.ts`), body);
    }
    for (let start = 0; start < DENIED_FILES; start += 200) {
      const end = Math.min(start + 200, DENIED_FILES);
      await Promise.all(
        Array.from({ length: end - start }, (_, offset) => {
          const name = `.env.${String(start + offset).padStart(4, '0')}`;
          return writeFixture(path.join(root, name), `TOKEN=${SEARCH_NEEDLE}\n`);
        }),
      );
    }

    git(root, ['init', '--quiet']);
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', 'LWB-044 disposable benchmark fixture']);

    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(capability.available, true, `native path guard unavailable: ${capability.resolved_backend_reason}`);

    const environment: WorkspaceEnvironment = {
      store_root: path.join(envRoot, 'store'),
      home_directory: path.join(envRoot, 'home'),
      extra_broad_probes: [],
      protected_refs: [],
      policy_version: 7,
    };
    await mkdir(environment.store_root, { recursive: true });
    await mkdir(environment.home_directory, { recursive: true });

    guardedReads = [];
    const benchmarkOrigin = performance.now();
    const benchmarkNow = (): number => NOW + Math.round(performance.now() - benchmarkOrigin);
    harness = await makeToolHarness({
      root,
      other_root: otherRoot,
      ops: countingOps(backend, guardedReads),
      probe: backend,
      environment,
      gates: GATES_ON,
      now: benchmarkNow,
      search_clock: benchmarkNow,
    });
  });

  after(async () => {
    if (harness) harness.close();
    await backend?.dispose();
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    if (envRoot) await rm(envRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    if (otherRoot) await rm(otherRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('measures real read/search/git/apply paths and asserts bounded skip/output behavior', async () => {
    const workspaceId = harness.workspace.id;
    const readPath = 'README.md';
    const read = async (): Promise<FileReadData> =>
      dataOf<FileReadData>(
        await callTool(harness, 'file_read', { workspace_id: workspaceId, path: readPath }),
        'file_read',
      );

    const handleCountBefore = processHandleCount();
    const rssBefore = process.memoryUsage().rss;
    const firstTouch = await timed(read);
    assert.equal(firstTouch.value.path, readPath);
    const readSamples: number[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      const sample = await timed(read);
      assert.equal(sample.value.sha256, firstTouch.value.sha256);
      readSamples.push(sample.ms);
    }

    const searchSamples: number[] = [];
    let partialSearchRuns = 0;
    let finalSearch: TextSearchData | null = null;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const sample = await timed(async () =>
        dataOf<TextSearchData>(
          await callTool(harness, 'text_search', { workspace_id: workspaceId, query: SEARCH_NEEDLE }),
          'text_search',
        ),
      );
      assert.equal(sample.value.matches.some((match) => match.path.includes('.env.')), false);
      assert.equal(sample.value.scope.complete, sample.value.incomplete_reason === null);
      assert.ok(
        sample.value.scope.complete || sample.value.deadline_exceeded || sample.value.byte_budget_exceeded,
        'an incomplete search must identify the bound that stopped it',
      );
      if (!sample.value.scope.complete) partialSearchRuns += 1;
      finalSearch = sample.value;
      searchSamples.push(sample.ms);
    }
    assert.ok(finalSearch);
    assert.ok(finalSearch.scope.denied_files > 0);
    assert.equal(finalSearch.scope.scanned_files <= REGULAR_FILES + 2, true);
    assert.equal(guardedReads.some((p) => p.startsWith('.env.')), false,
      'hard-denied credentials must never reach the guarded file-read API');
    assert.ok(JSON.stringify(finalSearch).length < 256 * 1024, 'search response should remain bounded');

    const longLineSamples: number[] = [];
    let longLineResult: TextSearchData | null = null;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const sample = await timed(async () =>
        dataOf<TextSearchData>(
          await callTool(harness, 'text_search', {
            workspace_id: workspaceId,
            query: 'no-match-in-benchmark-long-line',
            path: 'long',
          }),
          'text_search(long-line)',
        ),
      );
      assert.equal(sample.value.scope.complete, true);
      assert.equal(sample.value.scope.scanned_files, 1);
      assert.ok(JSON.stringify(sample.value).length < 16 * 1024);
      longLineResult = sample.value;
      longLineSamples.push(sample.ms);
    }

    const gitSamples: number[] = [];
    let finalGit: GitStatusData | null = null;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const sample = await timed(async () =>
        dataOf<GitStatusData>(
          await callTool(harness, 'git_status', { workspace_id: workspaceId }),
          'git_status',
        ),
      );
      assert.equal(sample.value.limited_to_authorized_paths, true);
      finalGit = sample.value;
      gitSamples.push(sample.ms);
    }
    assert.ok(finalGit);
    assert.equal(finalGit.truncated, false);
    assert.ok(JSON.stringify(finalGit).length < 256 * 1024, 'Git status response should remain bounded');

    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const afterIdle = await timed(read);
    assert.equal(afterIdle.value.sha256, firstTouch.value.sha256);

    // Kill only this test worker's own disposable resident helper. The first
    // request must fail without replay; the next independent request must boot
    // and validate a replacement helper automatically.
    const helperPid = ownedHelperPid();
    const killed = spawnSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${helperPid} -Force`],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
    );
    assert.equal(killed.status, 0, `could not stop the benchmark-owned helper: ${killed.stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const reconnectStarted = performance.now();
    const interrupted = errorOf(
      await callTool(harness, 'file_read', { workspace_id: workspaceId, path: readPath }),
      'first call after disposable helper exit',
    );
    assert.equal(interrupted.error.code, 'NATIVE_GUARD_UNAVAILABLE');
    const afterReconnect = dataOf<FileReadData>(
      await callTool(harness, 'file_read', { workspace_id: workspaceId, path: readPath }),
      'file_read after helper restart',
    );
    assert.equal(afterReconnect.sha256, firstTouch.value.sha256);
    const helperReconnectMs = performance.now() - reconnectStarted;

    const started = performance.now();
    const proposal = dataOf<ChangePrepareData>(
      await callTool(harness, 'file_edit', {
        workspace_id: workspaceId,
        idempotency_key: 'lwb044-approved-write-benchmark',
        summary: 'LWB-044 isolated temporary fixture benchmark',
        path: readPath,
        base_sha256: firstTouch.value.sha256,
        read_token: firstTouch.value.read_token,
        edits: [{ start_line: 1, end_line_exclusive: 2, old_lines: [`baseline ${SEARCH_NEEDLE}`], new_lines: [`updated ${SEARCH_NEEDLE}`] }],
      }),
      'file_edit',
    );
    assert.equal(proposal.state, 'PENDING_APPROVAL');
    assert.equal((await readFile(path.join(root, readPath), 'utf8')).startsWith('baseline '), true);
    approveChange({
      repos: harness.repos,
      change_id: proposal.change_id,
      digest: proposal.digest,
      actor: 'console:lwb-044-local-approval',
      now: new Date(harness.now()).toISOString(),
    });
    const applied = dataOf<ChangeApplyData>(
      await callTool(harness, 'change_apply', {
        change_id: proposal.change_id,
        idempotency_key: 'lwb044-approved-write-apply',
      }),
      'change_apply',
    );
    const applyMs = performance.now() - started;
    assert.equal(applied.state, 'APPLIED');
    assert.equal((await readFile(path.join(root, readPath), 'utf8')).startsWith('updated '), true);
    const rssAfter = process.memoryUsage().rss;
    const handleCountAfter = processHandleCount();

    const report = {
      platform: `${os.platform()} ${os.release()}`,
      node: process.version,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      logical_cpus: os.cpus().length,
      ram_bytes: os.totalmem(),
      filesystem: volume,
      fixture: {
        regular_text_files: REGULAR_FILES + 2,
        hard_denied_env_files: DENIED_FILES,
        long_line_bytes: LONG_LINE_BYTES,
        total_fixture_bytes: fixtureBytes,
        benchmark_iterations: ITERATIONS,
      },
      timings: {
        file_read_first_touch_ms: Number(firstTouch.ms.toFixed(2)),
        file_read_warm: summarize(readSamples),
        text_search: summarize(searchSamples),
        text_search_long_line: summarize(longLineSamples),
        git_status: summarize(gitSamples),
        five_second_idle_read_ms: Number(afterIdle.ms.toFixed(2)),
        helper_exit_to_reconnect_ms: Number(helperReconnectMs.toFixed(2)),
        proposal_local_approval_and_apply_ms: Number(applyMs.toFixed(2)),
      },
      bounds: {
        search_denied_file_count_last_run: finalSearch.scope.denied_files,
        search_scanned_file_count: finalSearch.scope.scanned_files,
        search_serialized_bytes: Buffer.byteLength(JSON.stringify(finalSearch)),
        search_partial_run_count: partialSearchRuns,
        long_line_scanned_bytes: longLineResult?.scope.scanned_bytes ?? 0,
        git_truncated: finalGit.truncated,
        git_serialized_bytes: Buffer.byteLength(JSON.stringify(finalGit)),
        node_rss_delta_bytes: rssAfter - rssBefore,
        node_process_handles_before: handleCountBefore,
        node_process_handles_after: handleCountAfter,
        node_process_handle_delta:
          handleCountBefore === null || handleCountAfter === null ? null : handleCountAfter - handleCountBefore,
      },
      not_measured: [
        'Windows standby/hibernate and resume of the same resident PowerShell helper (abrupt helper exit and next-call restart measured instead)',
        'OS file-cache eviction and true cold-cache latency',
        'hours-long idle soak and a statistically powered tail-latency run',
      ],
    };

    process.stdout.write(`\nLWB-044_RESULT=${JSON.stringify(report)}\n`);
  });
});
