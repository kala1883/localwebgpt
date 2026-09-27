/**
 * 受保护存储 ACL 加固的**机制**回归测试（LWB-007）。
 *
 * ## 为什么必须有这一份
 *
 * `tests/unit/secure-store.test.ts` 里 LWB-007 的用例全部走替身
 * （`fakeInspector`）：判定层覆盖得很好，而**机制层一次都没跑过**。
 * 交付的 `SecureStore.ps1` 因此长期带着一个只有真跑才会暴露的缺陷 —— 见下。
 *
 * ## 本文件钉住的缺陷：加固**第二次**必然失败
 *
 * 实测（本机 Windows 11，非提权）：
 *
 * | 写法 | 第 1 次 | 第 2 次 |
 * | --- | --- | --- |
 * | `Set-Acl` 这个 cmdlet | 成功 | **失败：SeSecurityPrivilege** |
 * | `[System.IO.FileSystemAclExtensions]::SetAccessControl` | 成功 | 成功 |
 *
 * 两种写法产出的 SDDL 逐字节相同：
 *   `O:<user>D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;<user>)`
 *
 * 与「设了哪几项」无关：只设保护位、只设属主、只加规则，第二次都失败。
 * 机制上也说得通 —— 该 cmdlet 会连带请求审计段（SACL），而读写 SACL 需要
 * SeSecurityPrivilege，非提权进程没有，本项目也不申请管理员。
 *
 * ## 它为什么值得单独跑一遍真助手
 *
 * daemon **每次**启动都会加固存储根。用 `Set-Acl` 意味着
 * 「第一次启动成功，此后每一次启动都失败」—— 而且报错把原因说成权限不足，
 * 排查方向会被引到 ACL 上，而 ACL 恰恰是已经正确的那一个。
 * 一个只在**全新临时目录**上跑过的测试永远看不到它：那些目录每次都不同。
 *
 * ## 本文件钉住的第二个缺陷：属主字段让整个加固在「只通过组授权」的位置失败
 *
 * 修好上面那条之后，`Op-Harden` 里还留着一句
 * `$acl.SetOwner(当前用户)`（意图是「顺手确保目录属于自己」）。属主是 ACL 的
 * 一部分，会随 `SetAccessControl` 一并应用，而**改属主需要 WRITE_OWNER**。
 *
 * 本机实测（Windows 11，非提权，同一份 ACL、同一个探针脚本，只差设不设属主）：
 *
 * | 目标                                   | 只写 DACL | 连属主一起写 |
 * | ---                                    | ---       | ---          |
 * | `D:\...\LocalWebGPT\.lwb-local\...`    | 成功      | **失败：Attempted to perform an unauthorized operation** |
 * | `%TEMP%\lwb-acl-probe-*`               | 成功      | 成功         |
 * | `%LOCALAPPDATA%\LocalWorkspaceBridge-*`| 成功      | 成功         |
 *
 * 差别在授权形状，不在盘：`%TEMP%` 与 `%LOCALAPPDATA%` 的 DACL 里有当前用户
 * 自己的 `FullControl` 规则，而 `D:` 上的目录只通过
 * `Authenticated Users: Modify` 授权 —— 那条权限里**不含** WRITE_OWNER
 * （它是 `0x1301bf`，含 SYNCHRONIZE/READ_CONTROL/DELETE/写数据，
 * 不含 0x80000），当前用户也不是……恰恰**是**属主，而属主只隐含
 * READ_CONTROL 与 WRITE_DAC，**不**隐含 WRITE_OWNER。
 *
 * 后果不是「少设了一项」：失败时连 DACL 那半也没写进去，而 `LWB_HOME` /
 * `--home` 指向这样的目录时 daemon **直接起不来** —— 报错只说
 * 「未经授权的操作」，看不出与属主有关，而 `--home` 恰恰是排障时才会用的开关。
 *
 * 因此这一份里多了一条用例：**先把目录的 DACL 换成「没有当前用户自己的
 * 规则、只有组」的形状**，再让 `hardenStore` 去加固它。只跑 `%TEMP%` 的
 * 测试永远造不出这个形状 —— 与上面那条缺陷是同一类：**临时目录不是
 * ACL 环境的代表**。
 *
 * 这些用例只在 Windows 上运行；其它平台整体跳过，而不是伪装通过。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { SecureStoreHelper, assessAcl, hardenStore, resolveStoreLayout } from '@lwb/secure-store';

/** 只用于**构造**测试环境：给目录换一份 ACL。判定一律走助手，不经过这里。 */
const quote = (text: string): string => `'${text.replace(/'/g, "''")}'`;

function pwsh(script: string): string {
  const res = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(res.status, 0, `pwsh 失败：${res.stdout ?? ''}${res.stderr ?? ''}`);
  return `${res.stdout ?? ''}${res.stderr ?? ''}`;
}

/**
 * 把目录的 ACL 换成「**没有当前用户自己的规则**、只有组」的形状。
 *
 * 形状取自本机 `D:` 上一个普通目录的实测 DACL：Administrators 与 SYSTEM
 * 全权、`Authenticated Users: Modify`、`Users: ReadAndExecute`。
 * 当前用户因此是**属主但不是任何一条规则的受益者** —— 这正是让
 * 「设属主」失败的那个条件。
 */
function makeGroupOnlyAcl(target: string): void {
  pwsh(
    [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.IO.FileSystem.AccessControl',
      '$acl = New-Object System.Security.AccessControl.DirectorySecurity',
      '$acl.SetAccessRuleProtection($true, $false)',
      '$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor ' +
        '[System.Security.AccessControl.InheritanceFlags]::ObjectInherit',
      'foreach ($spec in @(@("S-1-5-32-544","FullControl"), @("S-1-5-18","FullControl"), ' +
        '@("S-1-5-11","Modify"), @("S-1-5-32-545","ReadAndExecute"))) {',
      '  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(',
      '    [System.Security.Principal.SecurityIdentifier]::new($spec[0]),',
      '    [System.Security.AccessControl.FileSystemRights]$spec[1], $inherit,',
      '    [System.Security.AccessControl.PropagationFlags]::None,',
      '    [System.Security.AccessControl.AccessControlType]::Allow)',
      '  $acl.AddAccessRule($rule)',
      '}',
      `[System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.DirectoryInfo]::new(${quote(target)}), $acl)`,
    ].join('\n'),
  );
}

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;

describeWindows('LWB-007 受保护根加固（真实助手）', () => {
  let helper: SecureStoreHelper;
  let root: string;

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'lwb-acl-test-'));
    helper = new SecureStoreHelper();
    await helper.start();
    assert.equal(
      helper.isAvailable(),
      true,
      `PowerShell 助手不可用：${helper.unavailableReason() ?? '(无原因)'}`,
    );
  });

  after(async () => {
    helper.stop();
    await rm(root, { recursive: true, force: true });
  });

  /**
   * 读回实测 ACL 的「形状」，用于比较两次加固的结果。
   *
   * 刻意**不**直接比较 `AclSnapshot`：`owner` 与 `path` 之外还有一个
   * 会随加固次数变化的字段不应该被这条断言掩盖 —— 这里只关心
   * 「哪些主体、什么权限、是否仍继承」，也就是判定层真正看的那些。
   */
  async function aclShape(target: string): Promise<unknown> {
    const snapshot = await helper.inspect(target);
    assert.equal(snapshot.ok, true, `回读失败：${snapshot.ok ? '' : snapshot.message}`);
    return {
      protected: snapshot.data.access_rules_protected,
      rules: snapshot.data.rules
        .map((rule) => `${rule.type}:${rule.sid}:${rule.rights}:${rule.inherited}`)
        .sort(),
    };
  }

  it('同一目录连续加固，每一次都成功', async () => {
    const target = path.join(root, 'harden-repeat');
    const subs = ['config', 'db'];

    const afterFirst = await hardenStore(helper, target, subs).then(() => aclShape(target));

    // 第二次是「daemon 重启」的真实路径：目录已经加固过。
    // 正是这一步在修复前必然抛 SeSecurityPrivilege。
    const second = await hardenStore(helper, target, subs);
    assert.deepEqual(
      second.assessments.map((a) => a.acceptable),
      [true, true, true],
      '第二次加固的判定未通过（根 + 两个子目录）。',
    );
    assert.deepEqual(
      await aclShape(target),
      afterFirst,
      '第二次加固后的实测 ACL 与第一次不同：加固不幂等。',
    );
  });

  it('加固可以反复执行（重启多次也不退化）', async () => {
    const target = path.join(root, 'harden-many');
    for (let round = 1; round <= 4; round += 1) {
      const result = await hardenStore(helper, target, ['blobs']);
      assert.deepEqual(
        result.assessments.map((a) => a.acceptable),
        [true, true],
        `第 ${round} 次加固的判定不通过。`,
      );
    }
  });

  it('只读校验不改变磁盘上的任何东西', async () => {
    const target = path.join(root, 'inspect-unchanged');
    await hardenStore(helper, target, ['tmp']);

    const before = await helper.inspect(target);
    const again = await helper.inspect(target);
    assert.equal(before.ok, true);
    assert.deepEqual(again, before, '只读校验改变了实测到的访问控制。');
  });

  it('加固后的实测结果不含允许清单之外的主体，且继承已断开', async () => {
    const target = path.join(root, 'allowlist');
    const hardened = await hardenStore(helper, target, ['config']);
    assert.deepEqual(hardened.assessments.map((a) => a.acceptable), [true, true]);

    // 判定用**从磁盘独立回读**的快照再算一遍，而不是复用 `hardenStore`
    // 已经算好的结论 —— 否则这条用例只是在重复它自己的输出。
    const identity = await helper.whoami();
    assert.equal(identity.ok, true);

    for (const target_ of [target, path.join(target, 'config')]) {
      const snapshot = await helper.inspect(target_);
      assert.equal(snapshot.ok, true, `回读 ${target_} 失败。`);
      assert.deepEqual(assessAcl(snapshot.data, identity.data.user_sid).violations, []);
      assert.equal(snapshot.data.access_rules_protected, true, `${target_} 的继承没有被断开。`);
    }
  });

  it('在只通过组授权的位置加固成功（属主字段会让整个调用失败）', async () => {
    const target = path.join(root, 'group-only');
    await mkdir(target, { recursive: true });
    makeGroupOnlyAcl(target);

    // 装置自检：先证明这个目录**真的**是那个形状。
    // 没有这一步，一次静默失败（ACL 没换成）会让下面的用例变成一句空话：
    // 它在「和 %TEMP% 一样好客」的目录上照样通过。
    const identity = await helper.whoami();
    assert.equal(identity.ok, true);
    const before = await helper.inspect(target);
    assert.equal(before.ok, true);
    assert.deepEqual(
      before.data.rules.filter((rule) => rule.type === 'Allow' && rule.sid === identity.data.user_sid),
      [],
      '装置不成形：这个目录的 DACL 里仍然有当前用户自己的规则。',
    );
    assert.equal(before.data.owner_sid, identity.data.user_sid, '装置不成形：属主不是当前用户。');

    const hardened = await hardenStore(helper, target, ['config']);
    assert.deepEqual(
      hardened.assessments.map((a) => a.acceptable),
      [true, true],
      '在只通过组授权的位置加固失败。',
    );

    // 回读：这次是真的写进去了（不是「没报错」而已）。
    const after_ = await helper.inspect(target);
    assert.equal(after_.ok, true);
    assert.equal(after_.data.access_rules_protected, true);
    assert.equal(after_.data.owner_sid, identity.data.user_sid);
    assert.deepEqual(assessAcl(after_.data, identity.data.user_sid).violations, []);
  });

  it('布局解析对同一个根是稳定的（重启读的是同一批路径）', () => {
    assert.deepEqual(resolveStoreLayout(root), resolveStoreLayout(root));
  });
});
