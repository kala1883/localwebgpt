/**
 * ACL 加固与**实测**校验（LWB-007 步骤 1）。
 *
 * ## 为什么必须是允许清单而不是拒绝清单
 *
 * 本机实测发现：`%LOCALAPPDATA%` 的默认 DACL 上有一条**继承**来的
 * `MJ-LAPTOP-FVES0\CodexSandboxUsers: ReadAndExecute` 规则 —— 一个本机
 * 自定义组，对用户整个配置目录可读。
 * 「LocalAppData 是私有的」是假设，不是事实。
 *
 * 因此本模块不写「拒绝 Everyone / Users / Authenticated Users」这类名单：
 * 本机已经证明会出现名单之外的组。正确的做法是反过来——
 * **只允许**当前用户、SYSTEM、Administrators，其余任何 Allow 规则一律拒绝。
 *
 * ## 判定留在 TypeScript 侧
 *
 * PowerShell 助手只回答「磁盘上现在是什么」，安全判定在这里做：
 * 判定逻辑必须能被单元测试覆盖、能被评审阅读，而不是埋在脚本里。
 */

import type { AclInspector, AclRule, AclSnapshot } from './helper-client.ts';

/** 恒定的允许清单 SID。 */
export const ALLOWED_SIDS = {
  /** NT AUTHORITY\SYSTEM */
  SYSTEM: 'S-1-5-18',
  /** BUILTIN\Administrators —— 管理员本来就能取得任何文件，排除他们是表演。 */
  ADMINISTRATORS: 'S-1-5-32-544',
} as const;

/** 常见广域主体。仅用于把错误信息写清楚，**不**参与判定。 */
const WELL_KNOWN_BROAD_SIDS: Readonly<Record<string, string>> = {
  'S-1-1-0': 'Everyone',
  'S-1-5-11': 'Authenticated Users',
  'S-1-5-32-545': 'BUILTIN\\Users',
  'S-1-5-32-546': 'BUILTIN\\Guests',
  'S-1-5-4': 'INTERACTIVE',
  'S-1-5-7': 'ANONYMOUS LOGON',
};

export type AclViolationKind =
  | 'UNEXPECTED_PRINCIPAL'
  | 'UNRESOLVED_PRINCIPAL'
  | 'INHERITANCE_ENABLED'
  | 'UNEXPECTED_OWNER'
  | 'UNRESOLVED_OWNER'
  | 'NO_ACCESS_RULE_FOR_OWNER';

export interface AclViolation {
  readonly path: string;
  readonly kind: AclViolationKind;
  readonly sid: string;
  readonly name: string;
  readonly rights: string;
  readonly message: string;
}

export interface AclAssessment {
  readonly acceptable: boolean;
  readonly violations: readonly AclViolation[];
  /** 命中的允许清单 SID（即被接受的规则）。 */
  readonly allowed_sids: readonly string[];
  /** Deny 规则。它们只减少访问权，因此不构成违规，但需要展示出来。 */
  readonly deny_rules: readonly AclRule[];
}

/**
 * 判定一份实测 ACL 是否可接受。
 *
 * @param snapshot 助手回读到的**实际**规则，不是我们以为设置了的规则。
 * @param currentUserSid 当前进程所属用户的 SID。
 */
export function assessAcl(snapshot: AclSnapshot, currentUserSid: string): AclAssessment {
  const violations: AclViolation[] = [];
  const allowedSids = new Set<string>([ALLOWED_SIDS.SYSTEM, ALLOWED_SIDS.ADMINISTRATORS, currentUserSid]);
  const accepted: string[] = [];
  const denyRules: AclRule[] = [];

  if (!snapshot.access_rules_protected) {
    violations.push({
      path: snapshot.path,
      kind: 'INHERITANCE_ENABLED',
      sid: '',
      name: '',
      rights: '',
      message:
        'ACL 仍处于继承状态：父目录的规则会生效。父目录未必只有本人可读，因此拒绝。',
    });
  }

  // 属主判定排在规则之前：它是**整份 ACL 能不能算数**的问题，
  // 而规则是这份 ACL 写了什么。
  //
  // 属主对对象持有**隐含的** READ_CONTROL 与 WRITE_DAC（这是 Windows 的
  // 既定行为，不需要 DACL 里有任何一条关于他的规则）。也就是说，属主
  // 随时可以把这份 DACL 改成他想要的样子，而且改的时候不需要任何权限 ——
  // 那么「这份 DACL 只有当前用户能读」这句话对**外人当属主**的对象不成立：
  // 保护可以被撤销，且撤销不留痕迹。
  //
  // 因此属主只能有一个可接受的值：当前用户。
  // 注意那条隐含的 WRITE_DAC **不**包含 WRITE_OWNER —— 属主也改不了属主，
  // 这正是助手不再尝试设置属主的原因（见 `SecureStore.ps1` 的 `Op-Harden`）。
  const ownerSid: string = snapshot.owner_sid;
  if (!/^S-\d+(-\d+)+$/.test(ownerSid)) {
    // `owner_sid` 缺失时（助手版本不符、手工伪造的快照）走的是这一支：
    // `RegExp.test(undefined)` 为假。缺字段因此落在「保守拒绝」上，不是「通过」。
    violations.push({
      path: snapshot.path,
      kind: 'UNRESOLVED_OWNER',
      sid: typeof ownerSid === 'string' ? ownerSid : '',
      name: snapshot.owner,
      rights: '',
      message: `无法把属主（${snapshot.owner}）解析为主体 SID，也就无法确认这份 ACL 是否由当前用户掌控，保守拒绝。`,
    });
  } else if (ownerSid !== currentUserSid) {
    violations.push({
      path: snapshot.path,
      kind: 'UNEXPECTED_OWNER',
      sid: ownerSid,
      name: snapshot.owner,
      rights: '',
      message:
        `属主是 ${snapshot.owner}，不是当前用户（${currentUserSid}）：` +
        '属主对对象有隐含的 WRITE_DAC，他随时能把这份 ACL 改回去，因此这份保护不算数。',
    });
  }

  let ownerHasAccess = false;

  for (const rule of snapshot.rules) {
    if (rule.type === 'Deny') {
      denyRules.push(rule);
      continue;
    }
    if (!/^S-\d+(-\d+)+$/.test(rule.sid)) {
      // 解析不出 SID 的引用无法与允许清单比较，只能保守拒绝。
      violations.push({
        path: snapshot.path,
        kind: 'UNRESOLVED_PRINCIPAL',
        sid: rule.sid,
        name: rule.name,
        rights: rule.rights,
        message: `无法解析为主体 SID 的访问规则（${rule.name}），无法与允许清单比较，保守拒绝。`,
      });
      continue;
    }
    if (allowedSids.has(rule.sid)) {
      accepted.push(rule.sid);
      if (rule.sid === currentUserSid) ownerHasAccess = true;
      continue;
    }
    const known = WELL_KNOWN_BROAD_SIDS[rule.sid];
    violations.push({
      path: snapshot.path,
      kind: 'UNEXPECTED_PRINCIPAL',
      sid: rule.sid,
      name: rule.name,
      rights: rule.rights,
      message:
        `允许清单之外的主体 ${rule.name}${known ? `（${known}）` : ''} 拥有 ${rule.rights}` +
        `${rule.inherited ? '（继承自父目录）' : ''}。`,
    });
  }

  if (!ownerHasAccess) {
    violations.push({
      path: snapshot.path,
      kind: 'NO_ACCESS_RULE_FOR_OWNER',
      sid: currentUserSid,
      name: '',
      rights: '',
      message: '当前用户在 ACL 上没有访问规则：加固把服务自己关在了门外。',
    });
  }

  return {
    acceptable: violations.length === 0,
    violations,
    allowed_sids: [...new Set(accepted)],
    deny_rules: denyRules,
  };
}

export interface HardenedStore {
  readonly root: string;
  readonly current_user_sid: string;
  readonly assessments: readonly AclAssessment[];
}

export class AclUnavailableError extends Error {
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = 'AclUnavailableError';
    this.reason = reason;
  }
}

export class AclViolationError extends Error {
  readonly violations: readonly AclViolation[];
  constructor(message: string, violations: readonly AclViolation[]) {
    super(message);
    this.name = 'AclViolationError';
    this.violations = violations;
  }
}

/**
 * 建立受保护根、设置显式 DACL，并**回读校验**。
 *
 * 任一步无法完成或校验不通过都抛出：调用方必须停止启动，而不是
 * 「先跑起来，ACL 稍后再说」—— 那段时间里凭证就是可读的。
 */
export async function hardenStore(
  helper: AclInspector,
  root: string,
  subdirectories: readonly string[],
): Promise<HardenedStore> {
  const identity = await helper.whoami();
  if (!identity.ok) {
    throw new AclUnavailableError('无法确定当前用户身份，拒绝在未知身份下建立受保护存储。', identity.message);
  }

  const result = await helper.harden(root, subdirectories);
  if (!result.ok) {
    throw new AclUnavailableError(
      `无法设置受保护目录的访问控制：${result.message}`,
      result.message,
    );
  }

  const assessments = result.data.observed.map((snapshot) =>
    assessAcl(snapshot, result.data.current_user_sid),
  );
  const violations = assessments.flatMap((a) => a.violations);
  if (violations.length > 0) {
    throw new AclViolationError(
      `受保护目录的实测访问控制不符合允许清单（${violations.length} 处），拒绝启动。`,
      violations,
    );
  }

  return {
    root,
    current_user_sid: result.data.current_user_sid,
    assessments,
  };
}

/** 只读地校验既有目录；不修改任何 ACL。 */
export async function inspectAndAssess(
  helper: AclInspector,
  root: string,
): Promise<AclAssessment> {
  const identity = await helper.whoami();
  if (!identity.ok) {
    throw new AclUnavailableError('无法确定当前用户身份。', identity.message);
  }
  const snapshot = await helper.inspect(root);
  if (!snapshot.ok) {
    throw new AclUnavailableError(`无法读取访问控制信息：${snapshot.message}`, snapshot.message);
  }
  return assessAcl(snapshot.data, identity.data.user_sid);
}
