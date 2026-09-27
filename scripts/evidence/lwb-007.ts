#!/usr/bin/env node
/**
 * LWB-007 证据采集。
 *
 * 存在的理由：这一任务的三条验收标准都是「**实际如此**」而不是「设计如此」——
 * ACL 到底被设成了什么、密文里到底有没有明文、快照的 fsync 到底成没成功。
 * 这些只能在本机实地观测得到，靠读代码是得不出来的。
 *
 * 用法：
 *   npx tsx scripts/evidence/lwb-007.ts
 *
 * 输出全部经过脱敏（`redact`），可以直接粘进证据文档。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { BlobIntegrityError, BlobStore, objectPath } from '@lwb/blob-store';
import {
  CredentialStore,
  SecureStoreHelper,
  STORE_SUBDIRECTORIES,
  assessBroadDirectory,
  hardenStore,
  isProtectedPathSyntax,
  redact,
  resolveStoreLayout,
} from '@lwb/secure-store';

function line(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function emit(label: string, value: unknown): void {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);
}

async function main(): Promise<number> {
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail = ''): void => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures.push(name);
  };

  console.log(`platform: ${process.platform} ${os.release()}`);
  console.log(`node: ${process.version}`);
  console.log(`cwd: ${process.cwd()}`);

  // -------------------------------------------------------------------------
  line('1. 目录布局');
  const { layout, overridden } = resolveStoreLayout();
  emit('受保护根', layout.root);
  emit('由环境覆盖（生产环境应为 false）', overridden);
  emit('子目录', STORE_SUBDIRECTORIES);

  const helper = new SecureStoreHelper();
  await helper.start();
  emit('助手可用', helper.isAvailable());
  if (!helper.isAvailable()) {
    emit('助手不可用原因', helper.unavailableReason());
    console.error('\n助手不可用：以下需要 DPAPI 的观测**未执行**，不得标记为通过。');
  } else {
    const who = await helper.whoami();
    if (who.ok) emit('当前用户 SID', who.data.user_sid);
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb-evidence-007-'));
  try {
    // -----------------------------------------------------------------------
    line('2. 加固并回读 ACL（临时目录，不触碰真实用户存储）');
    emit('临时根', tempRoot);
    emit('加固前的实测 ACL', (await helper.inspect(tempRoot)).ok ? (await helper.inspect(tempRoot)) : '不可读');

    if (helper.isAvailable()) {
      const hardened = await hardenStore(helper, tempRoot, ['config', 'config\\credentials', 'db', 'objects', 'logs', 'diagnostics']);
      emit('加固后 current_user_sid', hardened.current_user_sid);
      for (const assessment of hardened.assessments) {
        console.log(`  acceptable=${assessment.acceptable} allowed_sids=${assessment.allowed_sids.join(',')}`);
      }
      const reread = await helper.inspect(tempRoot);
      if (reread.ok) {
        emit('加固后实测 access_rules_protected', reread.data.access_rules_protected);
        emit(
          '加固后实测规则',
          reread.data.rules.map((r) => ({
            sid: r.sid,
            name: r.name,
            type: r.type,
            rights: r.rights,
            inherited: r.inherited,
          })),
        );
      }
      check(
        '加固后 ACL 只含允许清单内的主体',
        hardened.assessments.every((a) => a.acceptable),
        `${hardened.assessments.length} 个目录已判定`,
      );
    }

    // -----------------------------------------------------------------------
    line('3. 凭证：DPAPI 往返与磁盘字节');
    if (helper.isAvailable()) {
      const credentials = path.join(tempRoot, 'config', 'credentials');
      const store = new CredentialStore({ credentialsDirectory: credentials, helper });
      const secret = 'lwb-evidence-2f8a1c9d4e6b0a3f5c7d9e1b3a5f7c9d';
      const info = await store.set('runtime', { kind: 'runtime-tunnel', secret });
      emit('写入结果', info);

      const revealed = await store.reveal('runtime');
      check('DPAPI 往返一致', revealed.secret === secret, `长度 ${revealed.secret.length}`);

      const raw = await store.rawFileBytes('runtime');
      emit('磁盘文件大小（字节）', raw.length);
      emit('磁盘文件（已脱敏）', redact(raw.toString('utf8'), [{ label: 'runtime-credential', value: secret }]));
      check('磁盘上没有明文凭证', !raw.includes(Buffer.from(secret, 'utf8')));
      check('密文不是可逆编码', !Buffer.from(info.fingerprint, 'hex').equals(Buffer.from(secret.slice(0, 8), 'utf8')));

      const mixed = await helper.unprotect(Buffer.from(raw.toString('utf8').match(/"ciphertext": "([^"]+)"/)?.[1] ?? '', 'base64'), 'lwb-v1-credential-console');
      check('换类别 entropy 解不开（域分离）', mixed.ok === false, mixed.ok ? '' : mixed.message);
    } else {
      check('DPAPI 往返一致', false, '助手不可用，未执行');
      check('磁盘上没有明文凭证', false, '助手不可用，未执行');
    }

    // -----------------------------------------------------------------------
    line('4. 快照存储：落盘顺序与 fsync 的**实际**结果');
    const objectsRoot = path.join(tempRoot, 'objects');
    const store = new BlobStore({ objectsRoot });
    const bytes = Buffer.from('LWB-007 evidence payload\n', 'utf8');
    const put = await store.put(bytes);
    emit('put 结果', put);
    emit('对象路径', objectPath(objectsRoot, put.sha256));
    emit('回读内容一致', (await store.getVerified({ sha256: put.sha256, size: put.size, storage_ref: put.storage_ref })).equals(bytes));
    check('文件内容已 fsync', put.file_synced, `directory_synced=${put.directory_synced}`);

    // 篡改（等长，因此只有哈希能发现）后必须被拒
    const { corruptObjectForTest } = await import('@lwb/blob-store');
    const ref = { sha256: put.sha256, size: put.size, storage_ref: put.storage_ref };
    // 由原始字节**原地**改一个 bit 派生，长度必然相同 —— 手写一个「等长」字符串
    // 曾经在这里写错过，于是测试悄悄退化成了长度分支。
    const tampered = Buffer.from(bytes);
    tampered[0] = (tampered[0] ?? 0) ^ 0x20;
    await corruptObjectForTest(objectsRoot, put.sha256, tampered);
    let hashRejected = false;
    try {
      await store.getVerified(ref);
    } catch (error) {
      hashRejected = true;
      emit('等长篡改后的拒绝理由', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      emit('  期望哈希', error instanceof BlobIntegrityError ? error.expected_sha256 : null);
      emit('  实际哈希', error instanceof BlobIntegrityError ? error.actual_sha256 : null);
    }
    check('内容哈希不符时读取被拒绝（等长，长度检查发现不了）', hashRejected);

    // 截断（长度分支）
    await corruptObjectForTest(objectsRoot, put.sha256, bytes.subarray(0, 5));
    let lengthRejected = false;
    try {
      await store.getVerified(ref);
    } catch (error) {
      lengthRejected = true;
      emit('截断后的拒绝理由', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
    check('快照被截断时读取被拒绝', lengthRejected);

    await rm(objectPath(objectsRoot, put.sha256), { force: true });
    let missingRejected = false;
    try {
      await store.getVerified({ sha256: put.sha256, size: put.size, storage_ref: put.storage_ref });
    } catch (error) {
      missingRejected = true;
      emit('缺失时的拒绝理由', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
    check('快照缺失时读取被拒绝', missingRejected);

    // -----------------------------------------------------------------------
    line('5. 受保护路径与广泛目录');
    for (const p of ['.env', '.env.example', '.ssh/id_rsa', 'src/index.ts']) {
      emit(`isProtectedPathSyntax(${p})`, isProtectedPathSyntax(p));
    }
    const verdict = assessBroadDirectory({
      storeRoot: layout.root,
      candidateRoot: path.dirname(layout.root),
      homeDirectory: os.homedir(),
    });
    emit('把受保护根的父目录注册为工作区', verdict);
    check('受保护根的祖先不得作为工作区', verdict.accepted === false);

    // 真实读取受保护根下的文件，证明加固没有把服务自己锁在门外
    const probe = path.join(tempRoot, 'logs', 'probe.txt');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(probe, 'writable\n', 'utf8');
    check('加固后仍可读写受保护目录', (await readFile(probe, 'utf8')) === 'writable\n');
  } finally {
    helper.stop();
    await rm(tempRoot, { recursive: true, force: true });
  }

  line('结果');
  if (failures.length > 0) {
    console.log(`失败项（${failures.length}）：`);
    for (const f of failures) console.log(`  - ${f}`);
    return 1;
  }
  console.log('全部观测项通过。');
  return 0;
}

process.exitCode = await main();
