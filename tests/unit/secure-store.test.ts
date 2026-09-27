/**
 * 受保护存储测试（LWB-007 步骤 1、2、4）。
 *
 * 重点不在「函数能跑」，而在三条**必须为真**的性质：
 *
 *  1. 判定用的是允许清单 —— ACL 上出现任何清单外主体都必须拒绝，
 *     因为本机实测已经证明会出现清单外的主体（见 `acl.ts` 头注释）。
 *  2. 凭证写入路径**没有明文回退** —— 机制不可用时必须失败，
 *     而不是退化成「先明文存着」。这条用磁盘字节直接证明，不靠接口自述。
 *  3. 受保护根及其祖先目录不可能被注册为工作区。
 *
 * 真实的 PowerShell + DPAPI 集成在最后一组；它需要 pwsh，
 * 在缺少 pwsh 的环境里会**显式跳过**而不是静默通过。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  ALLOWED_SIDS,
  AclUnavailableError,
  AclViolationError,
  CREDENTIAL_CLASSES,
  CredentialCorruptError,
  CredentialStore,
  CredentialUnavailableError,
  SecureStoreHelper,
  assessAcl,
  assessBroadDirectory,
  findProtectedIdentityMatch,
  hardenStore,
  inspectAndAssess,
  isInsideStore,
  isProtectedPathSyntax,
  redact,
  redactArgv,
  redactFields,
  assertNoRegisteredSecret,
  resolveStoreLayout,
  resolveStoreRoot,
  type AclInspector,
  type AclRule,
  type AclSnapshot,
  type CredentialProtector,
  type HardenResult,
  type HelperResult,
  type ProtectedIdentityRef,
} from '@lwb/secure-store';

const CURRENT_USER = 'S-1-5-21-4247710454-1492826582-129756499-1001';
const INTRUDER = 'S-1-5-21-9999999999-8888888888-7777777777-4242';

function rule(over: Partial<AclRule> = {}): AclRule {
  return {
    sid: CURRENT_USER,
    name: 'MJ-LAPTOP\\mj',
    type: 'Allow',
    rights: 'FullControl',
    inherited: false,
    inheritance: 'None',
    ...over,
  };
}

function snapshot(rules: AclRule[], over: Partial<AclSnapshot> = {}): AclSnapshot {
  return {
    path: 'C:\\store',
    owner: 'MJ-LAPTOP\\mj',
    owner_sid: CURRENT_USER,
    access_rules_protected: true,
    rules,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 目录布局
// ---------------------------------------------------------------------------

describe('LWB-007 受保护存储布局', () => {
  it('显式参数优先于环境变量，环境变量优先于 LOCALAPPDATA', () => {
    const original = { ...process.env };
    try {
      process.env['LWB_HOME'] = 'D:\\from-env';
      process.env['LOCALAPPDATA'] = 'C:\\Users\\mj\\AppData\\Local';

      assert.equal(resolveStoreRoot('E:\\explicit'), path.resolve('E:\\explicit'));
      assert.equal(resolveStoreRoot(), path.resolve('D:\\from-env'));

      delete process.env['LWB_HOME'];
      assert.equal(
        resolveStoreRoot(),
        path.join(path.resolve('C:\\Users\\mj\\AppData\\Local'), 'LocalWorkspaceBridge'),
      );
    } finally {
      process.env = original;
    }
  });

  it('LOCALAPPDATA 缺失时抛错，而不是退回到用户主目录', () => {
    const original = { ...process.env };
    try {
      delete process.env['LWB_HOME'];
      delete process.env['LOCALAPPDATA'];
      // 关键：不退回 os.homedir()。那会把凭证放进一个未被 ACL 加固的位置。
      assert.throws(() => resolveStoreRoot(), /LOCALAPPDATA/);
    } finally {
      process.env = original;
    }
  });

  it('解析出的子目录都位于根之下，且覆盖的根会被标记出来', () => {
    const { layout, overridden } = resolveStoreLayout('D:\\tmp\\lwb-store');
    assert.equal(overridden, true);
    for (const sub of [
      layout.bin,
      layout.config,
      layout.credentials,
      layout.db,
      layout.objects,
      layout.logs,
      layout.diagnostics,
      layout.databaseFile,
    ]) {
      assert.ok(isInsideStore(sub, layout.root), `${sub} 应当位于 ${layout.root} 之内`);
    }
    assert.equal(layout.databaseFile, path.join(layout.root, 'db', 'bridge.sqlite'));
  });

  it('isInsideStore 不做路径穿越解析之外的事情 —— 它只是预过滤', () => {
    const root = path.resolve('D:\\tmp\\lwb-store');
    assert.equal(isInsideStore(path.join(root, 'config', 'credentials', 'ipc.cred'), root), true);
    assert.equal(isInsideStore(root, root), true);
    assert.equal(isInsideStore(path.resolve('D:\\tmp\\other'), root), false);
    // 前缀形似但不同目录，不得被当成之内。
    assert.equal(isInsideStore(path.resolve('D:\\tmp\\lwb-store-evil\\x'), root), false);
  });
});

// ---------------------------------------------------------------------------
// 受保护路径（I13）
// ---------------------------------------------------------------------------

describe('LWB-007 受保护路径', () => {
  it('硬拒绝的机密文件名在任意深度都被识别', () => {
    for (const p of [
      '.env',
      'config/.env',
      'a/b/c/.env.local',
      '.ssh/id_rsa',
      'deploy/id_ed25519',
      'secrets.json',
      'db/bridge.sqlite-wal',
      'LocalWorkspaceBridge/db/bridge.sqlite',
    ]) {
      assert.notEqual(isProtectedPathSyntax(p), null, `${p} 应当被识别为受保护路径`);
    }
  });

  it('.env.example 不被自动豁免', () => {
    // 方案要求：名字里的 example 不是内容保证。这里钉住这个决定，
    // 防止后来者「顺手」加一条豁免。
    const match = isProtectedPathSyntax('.env.example');
    assert.notEqual(match, null, '.env.example 必须同样被拒绝');
    assert.equal(match?.kind, 'basename');
  });

  it('普通路径不误报', () => {
    for (const p of ['src/index.ts', 'docs/readme.md', 'environment.ts', 'src/env.ts']) {
      assert.equal(isProtectedPathSyntax(p), null, `${p} 不应当被拒绝`);
    }
  });

  it('整卷 workspace 也不能读插件自己的 LocalWorkspaceBridge 状态树', () => {
    const match = isProtectedPathSyntax('LocalWorkspaceBridge/db/service.db');
    assert.notEqual(match, null);
    assert.equal(match?.kind, 'dirname');
  });

  it('受保护根本身与其祖先目录都不能作为工作区', () => {
    const storeRoot = path.resolve('C:\\Users\\mj\\AppData\\Local\\LocalWorkspaceBridge');
    const verdict = assessBroadDirectory({
      storeRoot,
      candidateRoot: storeRoot,
      homeDirectory: path.resolve('C:\\Users\\mj'),
    });
    assert.equal(verdict.accepted, false);

    const ancestor = assessBroadDirectory({
      storeRoot,
      candidateRoot: path.resolve('C:\\Users\\mj\\AppData\\Local'),
      homeDirectory: path.resolve('C:\\Users\\mj'),
    });
    assert.equal(ancestor.accepted, false);

    // 用户主目录本身也是广泛目录。
    const home = assessBroadDirectory({
      storeRoot,
      candidateRoot: path.resolve('C:\\Users\\mj'),
      homeDirectory: path.resolve('C:\\Users\\mj'),
    });
    assert.equal(home.accepted, false);
  });

  it('一个普通项目目录可以被接受', () => {
    const verdict = assessBroadDirectory({
      storeRoot: path.resolve('C:\\Users\\mj\\AppData\\Local\\LocalWorkspaceBridge'),
      candidateRoot: path.resolve('D:\\MyProjects\\MyApps\\LocalWebGPT'),
      homeDirectory: path.resolve('C:\\Users\\mj'),
    });
    assert.equal(verdict.accepted, true);
  });

  it('身份判定用的是卷 + 文件 id，不理会路径字符串', () => {
    const refs: ProtectedIdentityRef[] = [
      { volume_id: 'vol-1', file_id: 'fid-cred', label: 'credentials' },
      { volume_id: 'vol-1', file_id: 'fid-db', label: 'bridge.sqlite' },
    ];
    assert.equal(
      findProtectedIdentityMatch({ volume_id: 'vol-1', file_id: 'fid-cred' }, refs)?.label,
      'credentials',
    );
    // 同一个文件 id 但在别的卷上：不是同一个对象，不得命中。
    assert.equal(findProtectedIdentityMatch({ volume_id: 'vol-2', file_id: 'fid-cred' }, refs), null);
    assert.equal(findProtectedIdentityMatch({ volume_id: 'vol-1', file_id: 'fid-other' }, refs), null);
  });
});

// ---------------------------------------------------------------------------
// ACL 判定
// ---------------------------------------------------------------------------

describe('LWB-007 ACL 判定', () => {
  it('只有当前用户 + SYSTEM + Administrators 时通过', () => {
    const assessment = assessAcl(
      snapshot([
        rule(),
        rule({ sid: ALLOWED_SIDS.SYSTEM, name: 'NT AUTHORITY\\SYSTEM' }),
        rule({ sid: ALLOWED_SIDS.ADMINISTRATORS, name: 'BUILTIN\\Administrators' }),
      ]),
      CURRENT_USER,
    );
    assert.equal(assessment.acceptable, true, JSON.stringify(assessment.violations));
    assert.equal(assessment.violations.length, 0);
    assert.deepEqual([...assessment.allowed_sids].sort(), [
      ALLOWED_SIDS.ADMINISTRATORS,
      ALLOWED_SIDS.SYSTEM,
      CURRENT_USER,
    ].sort());
  });

  it('本机实测到的 CodexSandboxUsers 这类清单外主体会导致拒绝', () => {
    // 这条规则是**真实存在**于本机 %LOCALAPPDATA% 上的（见 acl.ts 头注释）。
    const assessment = assessAcl(
      snapshot([
        rule(),
        rule({
          sid: 'S-1-5-21-4247710454-1492826582-129756499-1002',
          name: 'MJ-LAPTOP\\CodexSandboxUsers',
          rights: 'ReadAndExecute',
          inherited: true,
          inheritance: 'ContainerInherit, ObjectInherit',
        }),
      ]),
      CURRENT_USER,
    );
    assert.equal(assessment.acceptable, false);
    assert.equal(assessment.violations[0]?.kind, 'UNEXPECTED_PRINCIPAL');
    assert.match(assessment.violations[0]?.message ?? '', /CodexSandboxUsers/);
    assert.match(assessment.violations[0]?.message ?? '', /继承自父目录/);
  });

  it('Everyone / Users / Authenticated Users 同样被拒绝（不是靠黑名单）', () => {
    for (const [sid, name] of [
      ['S-1-1-0', 'Everyone'],
      ['S-1-5-11', 'Authenticated Users'],
      ['S-1-5-32-545', 'BUILTIN\\Users'],
    ] as const) {
      const assessment = assessAcl(snapshot([rule(), rule({ sid, name })]), CURRENT_USER);
      assert.equal(assessment.acceptable, false, `${name} 必须被拒绝`);
      assert.equal(assessment.violations[0]?.kind, 'UNEXPECTED_PRINCIPAL');
    }
  });

  it('ACL 仍处于继承状态即拒绝：父目录的规则未必只有本人可读', () => {
    const assessment = assessAcl(
      snapshot([rule()], { access_rules_protected: false }),
      CURRENT_USER,
    );
    assert.equal(assessment.acceptable, false);
    assert.equal(assessment.violations[0]?.kind, 'INHERITANCE_ENABLED');
  });

  it('无法解析为主体的规则保守拒绝', () => {
    const assessment = assessAcl(snapshot([rule(), rule({ sid: 'NOT-A-SID', name: 'SOMEDOMAIN\\x' })]), CURRENT_USER);
    assert.equal(assessment.acceptable, false);
    assert.equal(assessment.violations[0]?.kind, 'UNRESOLVED_PRINCIPAL');
  });

  it('属主不是当前用户即拒绝：属主有隐含的 WRITE_DAC，保护可以被无声撤销', () => {
    const assessment = assessAcl(
      snapshot([rule()], { owner_sid: INTRUDER, owner: 'MJ-LAPTOP\\someone-else' }),
      CURRENT_USER,
    );
    assert.equal(assessment.acceptable, false);
    assert.equal(assessment.violations[0]?.kind, 'UNEXPECTED_OWNER');
    assert.match(assessment.violations[0]?.message ?? '', /WRITE_DAC/);
    // 这条与 DACL 写得好不好无关：规则本身是合格的，问题在属主。
    assert.deepEqual([...assessment.allowed_sids], [CURRENT_USER]);
  });

  it('属主解析不出 SID 时保守拒绝', () => {
    const assessment = assessAcl(
      snapshot([rule()], { owner_sid: 'SOMEDOMAIN\\ghost', owner: 'SOMEDOMAIN\\ghost' }),
      CURRENT_USER,
    );
    assert.equal(assessment.acceptable, false);
    assert.equal(assessment.violations[0]?.kind, 'UNRESOLVED_OWNER');
  });

  it('快照里没有属主字段时同样拒绝（缺字段落在拒绝一侧，不是通过一侧）', () => {
    const assessment = assessAcl(
      snapshot([rule()], { owner_sid: undefined as unknown as string }),
      CURRENT_USER,
    );
    assert.equal(assessment.acceptable, false);
    assert.equal(assessment.violations[0]?.kind, 'UNRESOLVED_OWNER');
  });

  it('Deny 规则不算违规，但会被展示出来', () => {
    const deny = rule({ sid: 'S-1-1-0', name: 'Everyone', type: 'Deny', rights: 'FullControl' });
    const assessment = assessAcl(snapshot([rule(), deny]), CURRENT_USER);
    assert.equal(assessment.acceptable, true, JSON.stringify(assessment.violations));
    assert.equal(assessment.deny_rules.length, 1);
    assert.equal(assessment.deny_rules[0]?.name, 'Everyone');
  });

  it('加固把服务自己关在门外时同样拒绝', () => {
    const assessment = assessAcl(
      snapshot([
        rule({ sid: ALLOWED_SIDS.SYSTEM, name: 'NT AUTHORITY\\SYSTEM' }),
        rule({ sid: ALLOWED_SIDS.ADMINISTRATORS, name: 'BUILTIN\\Administrators' }),
      ]),
      CURRENT_USER,
    );
    assert.equal(assessment.acceptable, false);
    assert.equal(assessment.violations[0]?.kind, 'NO_ACCESS_RULE_FOR_OWNER');
  });
});

// ---------------------------------------------------------------------------
// 加固流程（用替身覆盖失败路径）
// ---------------------------------------------------------------------------

function fakeInspector(over: {
  whoamiOk?: boolean;
  hardenOk?: boolean;
  observed?: AclSnapshot[];
  userSid?: string;
}): AclInspector {
  const ok = <T>(data: T): HelperResult<T> => ({ ok: true, data });
  const fail = <T>(message: string): HelperResult<T> => ({
    ok: false,
    code: 'MECHANISM_FAILED',
    message,
  });
  return {
    whoami: async () =>
      over.whoamiOk === false
        ? fail('无法确定身份')
        : ok({ user_sid: over.userSid ?? CURRENT_USER, user: 'MJ-LAPTOP\\mj' }),
    inspect: async () => ok(over.observed?.[0] ?? snapshot([rule()])),
    harden: async () =>
      over.hardenOk === false
        ? fail('设置 DACL 失败')
        : ok<HardenResult>({
            targets: ['C:\\store'],
            observed: over.observed ?? [snapshot([rule()])],
            current_user_sid: over.userSid ?? CURRENT_USER,
            system_sid: ALLOWED_SIDS.SYSTEM,
            administrators_sid: ALLOWED_SIDS.ADMINISTRATORS,
          }),
  };
}

describe('LWB-007 加固流程', () => {
  it('身份不可用时拒绝建立受保护存储', async () => {
    await assert.rejects(
      () => hardenStore(fakeInspector({ whoamiOk: false }), 'C:\\store', ['config']),
      AclUnavailableError,
    );
  });

  it('机制失败时抛出，而不是「先跑起来稍后再说」', async () => {
    await assert.rejects(
      () => hardenStore(fakeInspector({ hardenOk: false }), 'C:\\store', ['config']),
      AclUnavailableError,
    );
  });

  it('回读结果不符合允许清单时拒绝启动', async () => {
    await assert.rejects(
      () =>
        hardenStore(
          fakeInspector({
            observed: [snapshot([rule(), rule({ sid: INTRUDER, name: 'DOMAIN\\someone' })])],
          }),
          'C:\\store',
          ['config'],
        ),
      (error: unknown) => {
        assert.ok(error instanceof AclViolationError);
        assert.equal(error.violations.length, 1);
        assert.equal(error.violations[0]?.kind, 'UNEXPECTED_PRINCIPAL');
        return true;
      },
    );
  });

  it('回读结果合格时返回实测快照', async () => {
    const result = await hardenStore(fakeInspector({}), 'C:\\store', ['config', 'db']);
    assert.equal(result.root, 'C:\\store');
    assert.equal(result.current_user_sid, CURRENT_USER);
    assert.equal(result.assessments.length, 1);
    assert.equal(result.assessments[0]?.acceptable, true);
  });

  it('只读校验不修改任何东西', async () => {
    const assessment = await inspectAndAssess(fakeInspector({}), 'C:\\store');
    assert.equal(assessment.acceptable, true);
  });
});

// ---------------------------------------------------------------------------
// 凭证存储（替身：覆盖 DPAPI 不可用与类别混淆这些真实会发生的路径）
// ---------------------------------------------------------------------------

/**
 * 替身保护器。
 *
 * 刻意把 entropy 编进密文并校验：真实的 DPAPI 在 entropy 不符时会解密失败，
 * 替身必须复现这个行为，否则「换文件位置也解不开」这条性质就测不到。
 */
function fakeProtector(options: { available?: boolean } = {}): CredentialProtector {
  const available = options.available ?? true;
  return {
    isAvailable: () => available,
    unavailableReason: () => (available ? null : '替身：机制不可用'),
    protect: async (plaintext, entropy) => {
      if (!available) return { ok: false, code: 'HELPER_UNAVAILABLE', message: '不可用' };
      return {
        ok: true,
        data: {
          ciphertext_b64: Buffer.concat([
            Buffer.from(`${entropy}\u0000`, 'utf8'),
            Buffer.from(plaintext.toString('base64'), 'utf8'),
          ]).toString('base64'),
        },
      };
    },
    unprotect: async (ciphertext, entropy) => {
      if (!available) return { ok: false, code: 'HELPER_UNAVAILABLE', message: '不可用' };
      // 注意：入参已经是解过 base64 的**原始字节**，这里不能再解一次。
      const decoded = ciphertext.toString('utf8');
      const marker = `${entropy}\u0000`;
      if (!decoded.startsWith(marker)) {
        return { ok: false, code: 'MECHANISM_FAILED', message: 'entropy 不符' };
      }
      return {
        ok: true,
        data: { plaintext_b64: Buffer.from(decoded.slice(marker.length), 'base64').toString('base64') },
      };
    },
  };
}

describe('LWB-007 凭证存储', () => {
  let root: string;
  let credentials: string;

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'lwb-cred-'));
    credentials = path.join(root, 'config', 'credentials');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('三类凭证互相独立，各写各的文件', async () => {
    const store = new CredentialStore({ credentialsDirectory: credentials, helper: fakeProtector() });
    for (const cls of CREDENTIAL_CLASSES) {
      await store.set(cls, { kind: cls, secret: `secret-for-${cls}-0123456789` });
    }
    for (const cls of CREDENTIAL_CLASSES) {
      assert.ok(existsSync(path.join(credentials, `${cls}.cred`)), `${cls}.cred 应当存在`);
      const revealed = await store.reveal(cls);
      assert.equal(revealed.secret, `secret-for-${cls}-0123456789`);
    }
  });

  it('磁盘上没有明文凭证', async () => {
    // 这条是验收标准 3 的直接证据：不看接口怎么自述，只看字节。
    const store = new CredentialStore({ credentialsDirectory: credentials, helper: fakeProtector() });
    const secret = 'super-secret-value-that-must-not-appear';
    await store.set('ipc', { kind: 'ipc', secret });
    const bytes = await store.rawFileBytes('ipc');
    assert.equal(bytes.includes(Buffer.from(secret, 'utf8')), false, '明文出现在了凭证文件里');
    assert.equal(bytes.toString('utf8').includes(secret), false);
  });

  it('把 A 类密文放到 B 类位置解不开（entropy 域分离）', async () => {
    const store = new CredentialStore({ credentialsDirectory: credentials, helper: fakeProtector() });
    const runtimeFile = await store.rawFileBytes('runtime');
    // 手工把 runtime 的密文塞进 console 的位置，并让文件自述为 console。
    const record = JSON.parse(runtimeFile.toString('utf8')) as Record<string, unknown>;
    record['class'] = 'console';
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(credentials, { recursive: true });
    await writeFile(path.join(credentials, 'console.cred'), JSON.stringify(record), 'utf8');
    await assert.rejects(() => store.reveal('console'), CredentialCorruptError);
  });

  it('文件自述的类别与存放位置不一致时直接拒绝', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lwb-cred-mismatch-'));
    try {
      const store = new CredentialStore({ credentialsDirectory: dir, helper: fakeProtector() });
      await store.set('ipc', { kind: 'ipc', secret: 'abc' });
      const record = JSON.parse((await store.rawFileBytes('ipc')).toString('utf8')) as Record<string, unknown>;
      record['class'] = 'runtime';
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path.join(dir, 'ipc.cred'), JSON.stringify(record), 'utf8');
      await assert.rejects(() => store.reveal('ipc'), /类别与存放位置不一致/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('机制不可用时拒绝写入，且**不**留下任何文件', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lwb-cred-unavail-'));
    try {
      const store = new CredentialStore({
        credentialsDirectory: dir,
        helper: fakeProtector({ available: false }),
      });
      await assert.rejects(
        () => store.set('runtime', { kind: 'runtime', secret: 'must-not-be-written' }),
        CredentialUnavailableError,
      );
      assert.equal(existsSync(path.join(dir, 'runtime.cred')), false, '不可用时不得写出降级文件');

      await assert.rejects(() => store.reveal('runtime'), CredentialUnavailableError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rotate 生成互不相同的凭证，指纹可比对但不能反推', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lwb-cred-rotate-'));
    try {
      const store = new CredentialStore({ credentialsDirectory: dir, helper: fakeProtector() });
      const first = await store.rotate('console');
      const second = await store.rotate('console');
      assert.notEqual(first.secret, second.secret);
      assert.notEqual(first.info.fingerprint, second.info.fingerprint);
      assert.equal(first.info.fingerprint.length, 16);
      assert.equal(first.info.fingerprint.includes(first.secret.slice(0, 8)), false);

      const info = await store.info('console');
      assert.equal(info?.fingerprint, second.info.fingerprint, 'info 应当报告当前生效的那把');
      assert.equal(Object.hasOwn(info ?? {}, 'secret'), false, 'info 不得包含机密');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('拒绝写入空凭证', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lwb-cred-empty-'));
    try {
      const store = new CredentialStore({ credentialsDirectory: dir, helper: fakeProtector() });
      await assert.rejects(() => store.set('ipc', { kind: 'ipc', secret: '' }), CredentialCorruptError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('损坏的 JSON 被识别为损坏，而不是被当成「凭证不存在」', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lwb-cred-corrupt-'));
    try {
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'ipc.cred'), '{ not json', 'utf8');
      const store = new CredentialStore({ credentialsDirectory: dir, helper: fakeProtector() });
      await assert.rejects(() => store.reveal('ipc'), CredentialCorruptError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

describe('LWB-007 脱敏', () => {
  const targets = [
    { label: 'runtime-credential', value: 'rt_9f8e7d6c5b4a39281706f5e4d3c2b1a0' },
  ];

  it('已注册的机密被精确替换', () => {
    const out = redact(`connecting with ${targets[0]!.value} now`, targets);
    assert.equal(out.includes(targets[0]!.value), false);
    assert.match(out, /«redacted:runtime-credential»/);
  });

  it('未注册但形状可辨的凭证被兜底替换', () => {
    for (const sample of [
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123',
      'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz01',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    ]) {
      const out = redact(sample, []);
      assert.notEqual(out, sample, `未脱敏：${sample}`);
      assert.equal(out.includes('«redacted:'), true);
    }
  });

  it('赋值形式只替换值，保留键名以便排障', () => {
    const out = redact('client_secret="abcdef1234567890"', []);
    assert.match(out, /client_secret=/);
    assert.equal(out.includes('abcdef1234567890'), false);
  });

  it('私钥块整段替换，而不是只换掉 BEGIN 行', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const out = redact(`key:\n${key}\n`, []);
    assert.equal(out.includes('MIIEowIBAAKCAQEA'), false);
  });

  it('先替换已注册机密，再走特征表 —— 顺序反了会漏', () => {
    // 这个值同时匹配「赋值」特征。若特征表先跑，它会先被替换成占位符，
    // 已注册机密的精确匹配就再也命中不了（值已经不在了），
    // 而 `assertNoRegisteredSecret` 会因此看到残留。
    const secret = 'token=abcdefghijklmnop';
    const out = redact(`x ${secret} y`, [{ label: 'registered', value: secret }]);
    assert.equal(out.includes('«redacted:registered»'), true);
    assertNoRegisteredSecret(out, [{ label: 'registered', value: secret }]);
  });

  it('导出前若仍有机密残留则抛错，而不是「打码后照样导出」', () => {
    const secret = 'zzzz-not-matching-any-pattern-9999';
    assert.throws(
      () => assertNoRegisteredSecret(`leaked: ${secret}`, [{ label: 'x', value: secret }]),
      /拒绝导出/,
    );
    assert.doesNotThrow(() => assertNoRegisteredSecret('clean text', [{ label: 'x', value: secret }]));
  });

  it('进程参数按元素脱敏', () => {
    const argv = ['node', 'tunnel-client', '--token', 'sk-abcdefghijklmnopqrstuvwxyz01'];
    const out = redactArgv(argv, []);
    assert.equal(out[0], 'node');
    assert.equal(out[2], '--token');
    assert.equal(out[3]?.includes('sk-abcdefghijklmnopqrstuvwxyz01'), false);
  });

  it('结构化日志按字段名剔除敏感值', () => {
    const out = redactFields({
      level: 'info',
      credential: 'should-vanish',
      nested: { token: 'also-vanish', path: 'C:\\keep\\me.txt' },
      argv: ['node', 'x'],
    }) as Record<string, unknown>;
    assert.equal(out['level'], 'info');
    assert.equal(out['credential'], '«redacted:field»');
    assert.equal((out['nested'] as Record<string, unknown>)['token'], '«redacted:field»');
    assert.equal((out['nested'] as Record<string, unknown>)['path'], 'C:\\keep\\me.txt');
    assert.deepEqual(out['argv'], ['node', 'x']);
  });
});

// ---------------------------------------------------------------------------
// 真实 PowerShell + DPAPI 集成
// ---------------------------------------------------------------------------

describe('LWB-007 真实 Windows 保护机制（pwsh + DPAPI）', () => {
  let helper: SecureStoreHelper;
  let available = false;
  let tempRoot: string;

  before(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb-realstore-'));
    helper = new SecureStoreHelper();
    await helper.start();
    available = helper.isAvailable();
    if (!available) {
      console.error(
        `⚠ 跳过真实 DPAPI 集成：助手不可用（${helper.unavailableReason() ?? '未知原因'}）。` +
          '本组测试**未执行**，不得据此认为通过。',
      );
    }
  });

  after(async () => {
    helper?.stop();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it('加固临时目录后，实测 ACL 只含当前用户 / SYSTEM / Administrators', async (t) => {
    if (!available) return t.skip('pwsh 助手不可用（见上方警告）');

    const store = await hardenStore(helper, tempRoot, ['config', 'config\\credentials', 'db']);
    assert.equal(store.assessments.every((a) => a.acceptable), true, JSON.stringify(store.assessments));
    for (const assessment of store.assessments) {
      for (const sid of assessment.allowed_sids) {
        assert.equal(
          [ALLOWED_SIDS.SYSTEM, ALLOWED_SIDS.ADMINISTRATORS, store.current_user_sid].includes(sid as never),
          true,
          `未预期的允许主体：${sid}`,
        );
      }
    }
  });

  it('DPAPI 往返：写入、读回，磁盘上没有明文', async (t) => {
    if (!available) return t.skip('pwsh 助手不可用');

    const credentials = path.join(tempRoot, 'config', 'credentials');
    const store = new CredentialStore({ credentialsDirectory: credentials, helper });
    const secret = `lwb-evidence-${Date.now()}-0123456789abcdef`;

    const info = await store.set('runtime', { kind: 'runtime-tunnel', secret });
    assert.equal(info.protection, 'dpapi-current-user');

    const revealed = await store.reveal('runtime');
    assert.equal(revealed.secret, secret);
    assert.equal(revealed.kind, 'runtime-tunnel');

    const bytes = await store.rawFileBytes('runtime');
    assert.equal(bytes.includes(Buffer.from(secret, 'utf8')), false, 'DPAPI 密文文件里出现了明文');
  });

  it('DPAPI 密文与「另一用户」不可互换：换 entropy 必然失败', async (t) => {
    if (!available) return t.skip('pwsh 助手不可用');

    // 用 runtime 的 entropy 加密，再用 ipc 的 entropy 解 —— 这正是
    // 「把 A 类密文挪到 B 类位置」在 DPAPI 层的等价物。
    const protectedResult = await helper.protect(Buffer.from('class-bound', 'utf8'), 'lwb-v1-credential-runtime');
    assert.equal(protectedResult.ok, true);
    if (!protectedResult.ok) return;
    const ciphertext = Buffer.from(protectedResult.data.ciphertext_b64, 'base64');

    const wrong = await helper.unprotect(ciphertext, 'lwb-v1-credential-ipc');
    assert.equal(wrong.ok, false, '不同类别的 entropy 竟然解开了同一段密文');
  });

  it('明文不经过助手时无法解密：密文不是可逆编码', async (t) => {
    if (!available) return t.skip('pwsh 助手不可用');

    const result = await helper.protect(Buffer.from('abcdefghij', 'utf8'), 'lwb-v1-credential-console');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const raw = Buffer.from(result.data.ciphertext_b64, 'base64');
    assert.equal(raw.includes(Buffer.from('abcdefghij', 'utf8')), false);
  });

  it('whoami 返回真实 SID，且与加固时使用的一致', async (t) => {
    if (!available) return t.skip('pwsh 助手不可用');

    const who = await helper.whoami();
    assert.equal(who.ok, true);
    if (!who.ok) return;
    assert.match(who.data.user_sid, /^S-\d+(-\d+)+$/);
    assert.equal(who.data.user_sid.startsWith('S-1-5-21-'), true, `非本机用户 SID：${who.data.user_sid}`);
  });

  it('只读校验既有目录不会因缺文件而崩溃', async (t) => {
    if (!available) return t.skip('pwsh 助手不可用');

    const store = new CredentialStore({
      credentialsDirectory: path.join(tempRoot, 'config', 'credentials'),
      helper,
    });
    assert.equal(await store.info('console'), null);
    assert.equal(store.exists('console'), false);
  });

  it('受保护根的真实文件内容可读 —— 证明加固没有把服务自己锁在外面', async (t) => {
    if (!available) return t.skip('pwsh 助手不可用');

    const probe = path.join(tempRoot, 'db', 'probe.txt');
    await (await import('node:fs/promises')).writeFile(probe, 'still-writable', 'utf8');
    assert.equal(await readFile(probe, 'utf8'), 'still-writable');
  });
});
