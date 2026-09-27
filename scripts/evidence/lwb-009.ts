/**
 * LWB-009 可复现证据采集。
 *
 * 三条验收标准全部走**真实磁盘**与**真实护栏**（PowerShell + .NET P/Invoke）：
 *
 *  1. 单文件授权不会顺带暴露其整个父目录 —— 靠「文件打开后是不是目录」
 *     这个内核行为，桩里造不出来。
 *  2. 同名路径被替换为另一目录后原授权失效 —— 靠 NTFS 在新目录上给出
 *     不同的 file_id。
 *  3. 移除工作区后旧修改集/票据/游标失效 —— 走真实状态库。
 *
 * 另外采集一条实测数据：`statVolume` 的单次耗时。登记表在**每一次取用**时
 * 都重新探测根身份且不缓存，这条数据是那个决定的依据。
 *
 * 用法：node --import tsx scripts/evidence/lwb-009.ts
 * 退出码：全部通过 0；任一项失败 1。
 */

import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import { PowerShellWinfsBackend } from '@lwb/winfs';
import { RootRejectedError, WorkspaceRegistry } from '@lwb/workspaces';

const WRITE_MODE = 'read_propose_apply_with_local_approval' as const;
const HEX64 = 'a'.repeat(64);

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function note(name: string, detail: string): void {
  console.log(`NOTE ${name} — ${detail}`);
}

function skip(name: string, why: string): void {
  console.log(`NOT_RUN ${name} — ${why}`);
}

async function main(): Promise<void> {
  console.log('== 环境 ==');
  console.log(`平台: ${process.platform} ${process.arch}`);
  console.log(`Node: ${process.version}`);
  console.log(`PID: ${process.pid}`);

  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-evidence-009-'));
  const backend = new PowerShellWinfsBackend();
  const capability = await backend.capability();
  console.log(`护栏后端: ${capability.backend}（可用=${capability.available}）`);
  console.log(`护栏验证环境: ${capability.verified_on}`);
  console.log(`临时目录: ${sandbox}`);
  console.log('');
  if (!capability.available) {
    console.log(`护栏不可用，无法采集真实证据：${capability.resolved_backend_reason}`);
    process.exitCode = 1;
    return;
  }

  const opened = openDatabase({ path: ':memory:' });
  const repos = new Repositories(opened.db);
  let counter = 0;

  /**
   * 受保护存储根刻意放在**用户目录之外**。
   *
   * 放在临时目录下（也就是用户目录下）会让「用户主目录」这个候选根
   * 同时命中两条规则，而 `assessBroadDirectory` 命中第一条就返回 ——
   * 于是证据里只会看到 `PROTECTED_STORE`，`BROAD_DIRECTORY` 那条规则
   * 反而没被真正验证过。这是采集脚本第一版踩到的坑，保留说明以免回退。
   */
  const storeRoot = `${path.parse(sandbox).root}lwb-evidence-009-store`;

  const registry = new WorkspaceRegistry({
    repos,
    probe: backend,
    environment: {
      store_root: storeRoot,
      home_directory: os.homedir(),
      extra_broad_probes: [],
      protected_refs: [],
      policy_version: 1,
    },
    newId: () => `ws_${String(++counter).padStart(4, '0')}`,
  });

  try {
    // -----------------------------------------------------------------
    console.log('== 实测：statVolume 单次耗时（登记表每次取用都重新探测的依据）==');
    const timings: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now();
      await backend.statVolume({ path: sandbox });
      timings.push(performance.now() - t0);
    }
    timings.sort((a, b) => a - b);
    const p50 = timings[Math.floor(timings.length / 2)] ?? 0;
    const p95 = timings[Math.min(timings.length - 1, Math.floor(timings.length * 0.95))] ?? 0;
    note('statVolume', `P50 ${p50.toFixed(2)}ms，P95 ${p95.toFixed(2)}ms（n=${timings.length}）`);
    check('单次根身份探测足够便宜，可以每次取用都做', p95 < 500, `P95 ${p95.toFixed(2)}ms < 500ms`);
    console.log('');

    // -----------------------------------------------------------------
    console.log('== 验收标准 1：单文件授权不会顺带暴露其整个父目录 ==');
    const singleDir = path.join(sandbox, 'single');
    await mkdir(singleDir, { recursive: true });
    const onlyPath = path.join(singleDir, 'only.txt');
    const siblingPath = path.join(singleDir, 'sibling.txt');
    await writeFile(onlyPath, 'only 的内容\n', 'utf8');
    await writeFile(siblingPath, 'sibling 的内容\n', 'utf8');

    const only = await registry.register({
      alias: 'only',
      kind: 'file',
      path: onlyPath,
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    const fileProbe = await backend.statVolume({ path: onlyPath });
    const dirProbe = await backend.statVolume({ path: singleDir });
    // 护栏现在要求每次工作区内调用都声明根的物理身份（LWB-010）。
    // 取用**登记表发出的**那两个值，而不是自己再算一份 ——
    // 这样这几次调用同时也在验证「库里存的身份」就是「护栏认的身份」。
    let dirRef: { root_path: string; root_volume_id: string; root_file_id: string } | null = null;
    if (fileProbe.ok !== true || dirProbe.ok !== true) {
      check('取得文件与父目录的句柄身份', false, JSON.stringify({ fileProbe, dirProbe }));
    } else {
      dirRef = { root_path: singleDir, root_volume_id: dirProbe.volume_id, root_file_id: dirProbe.file_id };
      note('父目录 file_id', dirProbe.file_id);
      note('被授权文件 file_id', fileProbe.file_id);
      check(
        '根身份是被授权文件自己的（不是父目录的）',
        only.root_file_id === fileProbe.file_id && only.root_file_id !== dirProbe.file_id,
      );
      check('根路径就是该文件', only.canonical_root === onlyPath, only.canonical_root);
      check(
        '登记记录中没有任何字段等于父目录路径',
        !Object.values(only).some((v) => v === singleDir),
        JSON.stringify(only),
      );
    }

    const authorized = await registry.authorizeAccess(only.id);
    check('授权快照的根是该文件', authorized.root_path === onlyPath && authorized.kind === 'file');

    // 对照：同一目标经目录根可读。
    if (dirRef === null) throw new Error('父目录身份探测失败，本段证据无法继续');
    const viaDirectory = await backend.readFileGuarded({
      ...dirRef,
      relative_path: 'sibling.txt',
    });
    check(
      '对照：目标经**目录根**可读',
      viaDirectory.ok === true,
      viaDirectory.ok ? '读到内容' : JSON.stringify(viaDirectory),
    );

    // 判定：同一目标经文件根不可读。
    const viaFile = await backend.readFileGuarded({
      root_path: authorized.root_path,
      root_volume_id: authorized.volume_id,
      root_file_id: authorized.file_id,
      relative_path: 'sibling.txt',
    });
    check(
      '判定：同一目标经**文件根**不可读',
      viaFile.ok === false,
      viaFile.ok ? '竟然读到了' : `拒绝码 ${viaFile.code}`,
    );

    const overlap = await registry
      .register({
        alias: 'single-dir',
        kind: 'directory',
        path: singleDir,
        mode: WRITE_MODE,
        origin: 'local_console',
      })
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    const reasons =
      overlap instanceof RootRejectedError ? overlap.rejections.map((r) => r.reason) : [];
    check(
      '父目录是**另一次**授权：与在册可写文件工作区重叠而被拒绝',
      reasons.includes('WRITABLE_ROOT_OVERLAP'),
      reasons.join(',') || String(overlap),
    );

    const sibling = await registry.register({
      alias: 'sibling',
      kind: 'file',
      path: siblingPath,
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    check(
      '同目录另一个文件是独立授权（身份不同）',
      sibling.root_file_id !== only.root_file_id && sibling.id !== only.id,
    );
    registry.remove(only.id, 'local_console');
    const stillSibling = await registry.authorizeAccess(sibling.id);
    check('两条授权互不涵盖：移除其一，另一条照常可用', stillSibling.root_path === siblingPath);
    console.log('');

    // -----------------------------------------------------------------
    console.log('== 验收标准 2：同名路径被替换为另一目录后原授权失效 ==');
    const swapDir = path.join(sandbox, 'swap');
    const movedDir = path.join(sandbox, 'swap-moved-away');
    await mkdir(swapDir, { recursive: true });
    const swap = await registry.register({
      alias: 'swap',
      kind: 'directory',
      path: swapDir,
      mode: WRITE_MODE,
      origin: 'local_console',
    });
    const initial = await registry.verifyRootIdentity(swap.id);
    check('登记后身份未变', initial.kind === 'unchanged', initial.kind);

    await rename(swapDir, movedDir);
    await mkdir(swapDir, { recursive: true });
    const newProbe = await backend.statVolume({ path: swapDir });
    if (newProbe.ok === true) {
      note('原 file_id', swap.root_file_id);
      note('替换后 file_id', newProbe.file_id);
      check('NTFS 在同名路径上给出不同的文件身份', newProbe.file_id !== swap.root_file_id);
    } else {
      check('NTFS 在同名路径上给出不同的文件身份', false, JSON.stringify(newProbe));
    }

    const changed = await registry.verifyRootIdentity(swap.id);
    check('核查报告身份已变', changed.kind === 'identity_changed', changed.kind);

    const denied = await registry.authorizeAccess(swap.id).then(
      () => null,
      (cause: unknown) => cause,
    );
    const deniedCode = (denied as { code?: string } | null)?.code ?? '（未拒绝）';
    const deniedCause = (denied as { details?: Record<string, unknown> } | null)?.details?.['cause'];
    check('访问被拒绝', deniedCode === 'WORKSPACE_GENERATION_CHANGED', deniedCode);
    check('拒绝原因标明是「根被替换」而不是「票据过期」', deniedCause === 'root_replaced', String(deniedCause));
    const afterDenied = repos.workspaces.requireById(swap.id);
    check(
      '拒绝访问**没有**顺手把登记改写成新对象（否则等于自动重新授权）',
      afterDenied.root_file_id === swap.root_file_id && afterDenied.generation === swap.generation,
    );

    const outcome = await registry.reverify(swap.id, 'local_console');
    check('重新验证报告已重定位', outcome.kind === 'relocated', outcome.kind);
    if (outcome.kind === 'relocated') {
      note('重新验证后代次', `${swap.generation} → ${outcome.workspace.generation}`);
      check('重新验证递增代次', outcome.workspace.generation === swap.generation + 1);
    }
    const reAuthorized = await registry.authorizeAccess(swap.id).then(
      () => true,
      () => false,
    );
    check('重新授权后当前代次可用', reAuthorized);
    const staleDenied = await registry
      .authorizeAccess(swap.id, { generation: swap.generation })
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    check(
      '重新授权前签发的旧代次仍然不可用',
      (staleDenied as { code?: string } | null)?.code === 'WORKSPACE_GENERATION_CHANGED',
      (staleDenied as { code?: string } | null)?.code ?? '（未拒绝）',
    );
    console.log('');

    // -----------------------------------------------------------------
    console.log('== 验收标准 3：移除工作区后旧修改集、读取票据和游标不能继续使用 ==');
    const goneDir = path.join(sandbox, 'removable');
    await mkdir(goneDir, { recursive: true });
    const removable = await registry.register({
      alias: 'removable',
      kind: 'directory',
      path: goneDir,
      mode: WRITE_MODE,
      origin: 'local_console',
    });

    repos.connections.create({
      id: 'conn_evidence',
      principal_kind: 'model_surface',
      principal_id: 'p-evidence',
      alias: 'evidence-adapter',
      enabled: true,
    });
    const oldBlob = repos.blobs.ensure({
      id: 'blob_old',
      sha256: 'b'.repeat(64),
      size: 3,
      storage_ref: 'evidence/old',
    });
    const newBlob = repos.blobs.ensure({
      id: 'blob_new',
      sha256: 'c'.repeat(64),
      size: 4,
      storage_ref: 'evidence/new',
    });
    repos.changes.create({
      id: 'chg_evidence',
      owner_connection_id: 'conn_evidence',
      workspace_id: removable.id,
      root_generation: removable.generation,
      policy_version: removable.policy_version,
      contract_version: '0.1.0',
      digest: HEX64,
      summary: '在途修改集（证据采集）',
      expires_at: '2099-01-01T00:00:00.000Z',
      items: [
        {
          id: 'chg_evidence_i0',
          path: 'src/main.ts',
          op: 'edit_text',
          base_file_id: '0000000000000001',
          base_sha256: 'b'.repeat(64),
          target_sha256: 'c'.repeat(64),
          old_blob_id: oldBlob.blob.id,
          new_blob_id: newBlob.blob.id,
          encoding: 'utf-8',
          bom: false,
          newline: 'lf',
          added_lines: 1,
          removed_lines: 2,
        },
      ],
    });
    const boundGeneration = repos.changes.requireById('chg_evidence').root_generation;
    check('在途修改集绑定签发时的代次', boundGeneration === removable.generation, String(boundGeneration));

    const removed = registry.remove(removable.id, 'local_console');
    note('移除后代次', `${removable.generation} → ${removed.generation}`);
    check('移除递增代次', removed.generation === removable.generation + 1);
    check('移除后不再启用', removed.enabled === false && removed.removed_at !== null);
    const currentGeneration = repos.workspaces.requireById(removable.id).generation;
    check(
      '旧修改集的代次绑定已被打断',
      repos.changes.requireById('chg_evidence').root_generation !== currentGeneration,
    );

    const staleTicket = await registry
      .authorizeAccess(removable.id, { generation: removable.generation })
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    check(
      '旧读取票据/游标（携带旧代次）被拒绝',
      (staleTicket as { code?: string } | null)?.code === 'WORKSPACE_NOT_GRANTED',
      (staleTicket as { code?: string } | null)?.code ?? '（未拒绝）',
    );
    const sameGenTicket = await registry
      .authorizeAccess(removable.id, { generation: currentGeneration })
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    check(
      '即使代次碰巧相同，已移除的工作区仍然不可用',
      (sameGenTicket as { code?: string } | null)?.code === 'WORKSPACE_NOT_GRANTED',
      (sameGenTicket as { code?: string } | null)?.code ?? '（未拒绝）',
    );
    check('历史行仍在（审计可追溯）', repos.workspaces.findById(removable.id) !== null);
    check('默认列表不再包含已移除的工作区', !registry.list().some((w) => w.id === removable.id));
    console.log('');

    // -----------------------------------------------------------------
    console.log('== 步骤 2 的拒绝面（真实路径）==');
    // 空登记表：这一段要验证的是「候选根自身形态」的规则，
    // 若表里已有工作区，重叠规则会先命中，把要验证的那条盖过去。
    const cleanOpened = openDatabase({ path: ':memory:' });
    const cleanRepos = new Repositories(cleanOpened.db);
    let cleanCounter = 0;
    const cleanRegistry = new WorkspaceRegistry({
      repos: cleanRepos,
      probe: backend,
      environment: {
        store_root: storeRoot,
        home_directory: os.homedir(),
        extra_broad_probes: [],
        protected_refs: [],
        policy_version: 1,
      },
      newId: () => `ws_clean_${String(++cleanCounter).padStart(4, '0')}`,
    });
    try {
      await rejectionFace(cleanRegistry);
    } finally {
      closeDatabase(cleanOpened.db);
    }
    console.log('');
  } finally {
    closeDatabase(opened.db);
    await backend.dispose();
    await rm(sandbox, { recursive: true, force: true });
  }

  process.exitCode = failures === 0 ? 0 : 1;

  async function rejectionFace(target: WorkspaceRegistry): Promise<void> {
    const driveRoot = `${path.parse(sandbox).root.replace(/\\$/, '')}\\`;
    const driveRejected = await target
      .register({
        alias: 'whole-disk',
        kind: 'directory',
        path: driveRoot,
        mode: WRITE_MODE,
        origin: 'local_console',
      })
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    check(
      `盘符根被拒绝（${driveRoot}）`,
      driveRejected instanceof RootRejectedError &&
        driveRejected.rejections.some((r) => r.reason === 'DRIVE_ROOT'),
      driveRejected instanceof RootRejectedError
        ? driveRejected.rejections.map((r) => r.reason).join(',')
        : String(driveRejected),
    );

    const homeRejected = await target
      .register({
        alias: 'home',
        kind: 'directory',
        path: os.homedir(),
        mode: WRITE_MODE,
        origin: 'local_console',
      })
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    check(
      '过宽用户目录（真实主目录）被拒绝',
      homeRejected instanceof RootRejectedError &&
        homeRejected.rejections.some((r) => r.reason === 'BROAD_DIRECTORY'),
      homeRejected instanceof RootRejectedError
        ? homeRejected.rejections.map((r) => r.reason).join(',')
        : String(homeRejected),
    );

    // 用一条**本身完全合法**的路径来做来源检查：这样若来源检查被绕过，
    // 后面的形态检查不会替它兜住，失败信息能准确指向被绕过的那一条。
    const modelRejected = await target
      .register({
        alias: 'from-model',
        kind: 'directory',
        path: path.join(sandbox, 'removable'),
        mode: WRITE_MODE,
        origin: 'model_surface',
      })
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    check(
      '模型侧发起的登记被拒绝',
      modelRejected instanceof RootRejectedError &&
        modelRejected.rejections.some((r) => r.reason === 'ORIGIN_NOT_LOCAL'),
      modelRejected instanceof RootRejectedError
        ? modelRejected.rejections.map((r) => r.reason).join(',')
        : String(modelRejected),
    );

    skip(
      '网络盘（DRIVE_REMOTE）被拒绝',
      '本机没有映射网络驱动器，无法构造真实 DRIVE_REMOTE；该分支只在单元测试里以注入事实覆盖',
    );
    skip(
      '云占位文件被拒绝',
      '本机没有 OneDrive 一类的云端同步占位文件可供创建；该分支只在单元测试里以注入事实覆盖',
    );
    skip(
      '非 NTFS 卷被拒绝',
      '本机全部为固定 NTFS 卷，无法构造 exFAT/ReFS 候选根；该分支只在单元测试里以注入事实覆盖',
    );
    skip(
      '祖先级 Junction 被拒绝',
      '构造祖先级 Junction 需要开发者模式或管理员权限，本次会话无此权限；逐级重解析点判定由 LWB-010 的测试覆盖',
    );
    console.log('');
  }
}

await main();
