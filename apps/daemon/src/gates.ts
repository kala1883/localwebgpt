/**
 * 门禁状态与由它推出的能力开关（LWB-017）。
 *
 * ## 为什么这两件事写在一个文件里
 *
 * 「四个开关现在是关的」如果散落在装配代码、工具描述和测试装置三处，
 * 它们迟早会不一致，而**不一致的方向通常是放开**：某处为了让一个演示跑通
 * 把 `read_enabled` 传成 true，而另外两处还在说「读取是关的」。
 *
 * 因此这里只做一件事：把门禁的三个事实（G0、原生护栏、§3 平台兼容性）
 * 变成一个 `CapabilityFlags`。**它是纯函数**，于是「G0 未过 ⇒ 四个开关全关」
 * 是一条能被测试钉住的等式，而不是一句注释。
 *
 * ## 三个事实从哪里来
 *
 * | 事实 | 来源 | 当前值 |
 * | --- | --- | --- |
 * | `g0_platform_verified` | `docs/adr/003-protocol-and-trust.md` §5.2 检查单 | `false`（网页元数据通路有部分观察；完整读写回读、身份边界与隧道恢复检查未通过/未签署） |
 * | `native_guard_verified` | 原生模块的验证状态 | `false`（原生模块仍是 fail-closed 占位实现） |
 * | `compatibility_section3_passed` | `docs/compatibility.md` §3 表格 | `false`（全部「未验证」） |
 * | `g4_concurrency_fault_passed` | `docs/evidence/g4-write.md` | `false`（判定未通过） |
 *
 * 前两项是契约字段（`BridgeStatusData.gates`），后两项**不在契约里** ——
 * 它们是评审结论，不是运行时读数。但 §3 与 G0 在文档里给出的是**同一个**后果
 * （「在 §3 全部通过之前：四个开关保持关闭」，`docs/compatibility.md`），
 * 所以它必须参与这个与运算，否则「按代码算出来是全关」这句话就不成立。
 *
 * ## 为什么 G4 单列一项，而不是并进另外三项里的某一项
 *
 * G4 的原文是「竞争与故障测试通过」（`docs/LWB_COMPLETE_PLAN.md` §12），
 * 它管的是**写入这一段的鲁棒性**，与 G0（平台能不能被调用）、
 * `native_guard_verified`（底层句柄护栏本身可不可信）、§3（平台兼容性）
 * 都不是同一件事。把它并进任何一项，都等于悄悄声称「那一项通过了，
 * 所以并发与故障也验过了」—— 而 G4 的全部内容恰恰是**那一步没有被验证**。
 *
 * 它只参与 `direct_write_enabled`，不参与读取与提议：方案 §12 的原文是
 * 「G4/G6 通过后……开放小范围写入」，管的是写入那一段，不是读取。
 *
 * ## 为什么默认值是「全关」而不是契约里的 `DEFAULT_CAPABILITIES`
 *
 * `@lwb/contracts` 的 `DEFAULT_CAPABILITIES` 是「只读，不写入」，
 * 那是**产品**的保守默认值（一个新工作区默认不接受写入）。
 * 而这里是**门禁**：平台能不能用尚未验证时，连读取都不宣称可用。
 * 两者不矛盾，但也不是同一个东西，因此本文件不用 `DEFAULT_CAPABILITIES`。
 *
 * 全部关掉意味着生产装配下每一个工具调用都会被 `POLICY_DENIED` 拒绝 ——
 * 这是**有意的**，并且在界面上要如实展示（`bridge_status.limitations`）。
 * 一个「描述里写着能读、实际拒绝」的工具面，会让模型反复重试，
 * 最后诱导操作者去放宽权限（ADR-003 §5.1）。
 */

import type { CapabilityFlags } from '@lwb/contracts';
import type { PauseStatus } from '@lwb/executor';
import type { WorkspaceRecord } from '@lwb/persistence';

/** 门禁事实。前两项与 `BridgeStatusData.gates` 同形。 */
export interface PlatformGates {
  /** G0 第 1、2 项：真实 ChatGPT 网页会话能发现并调用本工具面。 */
  readonly g0_platform_verified: boolean;
  /** Windows 句柄护栏的**原生模块**验证通过（LWB-003 的 PowerShell 证据不算）。 */
  readonly native_guard_verified: boolean;
  /** `docs/compatibility.md` §3 平台兼容性表格全部验证通过。 */
  readonly compatibility_section3_passed: boolean;
  /**
   * G4：竞争与故障专项测试通过（LWB-033）。
   *
   * 判定与依据在 `docs/evidence/g4-write.md`。与上面三项一样，这是一个
   * **需要人去改的常量**：它没有运行时来源，只能由一次代码变更打开。
   */
  readonly g4_concurrency_fault_passed: boolean;
}

/**
 * 当前门禁状态。**这是一处需要人去改的常量，这是刻意的。**
 *
 * 它没有从环境变量或配置文件读：一个可以被配置打开的门禁，
 * 就不是门禁了 —— 它会成为「本机上有人把它打开了」的同义词。
 * 改它的动作必须是一次代码变更，从而留下评审记录。
 */
export const BRIDGE_GATES: PlatformGates = {
  g0_platform_verified: false,
  native_guard_verified: false,
  compatibility_section3_passed: false,
  g4_concurrency_fault_passed: false,
};

/**
 * 门禁 → 能力开关。
 *
 * 四项**同一个与运算**，而不是各配各的条件。理由：它们全部依赖同一批
 * 未验证事实，任何一项单独放宽都等于宣称「平台已经能用一部分」——
 * 而「一部分可用」这句话本身没有任何证据支持。当门禁通过时四项一起开，
 * 那时的证据（真实会话发现并调用了工具）同时支持这四项。
 *
 * `direct_write_enabled` 还额外依赖两项：原生护栏（即使 G0 过了，
 * 没有通过验证的句柄护栏也不能直写，ADR-002）与 G4（竞争与故障专项测试）。
 * 因此它多两个与项。**这是本函数里唯一的不对称，而它不对称的方向是更严** ——
 * 读取与提议不需要这两个与项，因为它们不写用户文件。
 *
 * 方案 §12 的那条规则（「G4 未通过时 `direct_write_enabled` 对真实目录
 * 必须保持关闭」）在这里不是一个约定，而是这个与运算本身：
 * `g4_concurrency_fault_passed` 为假时，无论另外三项取什么值，
 * 这个返回值的第四项都是 `false`，而它是**唯一**一处算出这个开关的地方。
 * 穷尽 16 格的实测见 `tests/unit/gate-combinations.test.ts`。
 */
export function capabilityFlagsFrom(gates: PlatformGates): CapabilityFlags {
  const platform_ready =
    gates.g0_platform_verified && gates.compatibility_section3_passed;
  return {
    read_enabled: platform_ready,
    git_enabled: platform_ready,
    proposal_enabled: platform_ready,
    direct_write_enabled:
      platform_ready && gates.native_guard_verified && gates.g4_concurrency_fault_passed,
    // 待人工恢复的置位来自恢复日志（尚不存在），装配根另行叠加。
    recovery_required: false,
  };
}

/** 生产用：当前门禁下的开关。测试**注入自己的**，不读这里。 */
export const BRIDGE_CAPABILITY_FLAGS: CapabilityFlags = capabilityFlagsFrom(BRIDGE_GATES);

/** 装配根交给工具层的能力开关来源：门禁开关 + 逐工作区的恢复置位。 */
export function capabilityFlagsWith(
  gates: PlatformGates,
  recoveryRequired: (workspace: WorkspaceRecord) => boolean,
): (workspace: WorkspaceRecord) => CapabilityFlags {
  const base = capabilityFlagsFrom(gates);
  return (workspace) => ({ ...base, recovery_required: recoveryRequired(workspace) });
}

/**
 * 模型可见的限制说明。**由开关与门禁推导**，不是一列手写文案。
 *
 * 手写的清单会与真实开关脱节，而脱节的方向通常是「清单里还写着能读、
 * 开关已经关了」。推导出来的清单不可能自相矛盾：每一句的存在与否
 * 就是那个布尔值本身。
 */
export function limitationsOf(
  flags: CapabilityFlags,
  gates: PlatformGates,
  /**
   * 全局暂停的现值（LWB-034）。省略即「这台机器从来没有暂停过」。
   *
   * 它收的就是 `PauseService.status()` 的那一份报告，**不另造一个
   * 「只要三个数」的形状**：同一件事的两个类型迟早会被两个人分别扩展，
   * 而扩展出来的那个字段只有一边有。
   */
  pause: PauseStatus | null = null,
): readonly string[] {
  const out: string[] = [];

  // 暂停那几句放在**最前面**：它们描述的是此刻的实情，而下面那些
  // 说的是长期配置。一个被紧急停用的服务，第一句就该是「停着」。
  if (pause !== null && pause.paused) {
    out.push('**本地服务已被操作者紧急停用**：新的读取与新应用一律被阻断，直到本地控制台解除为止。');
    if (pause.stopping.length > 0) {
      // 「正在停止」与「已经停止」是两句不同的话，而把它们说成一句
      // 正是这一格最容易被写出来的那种假话 —— 操作者会据此以为
      // 盘上已经没有在动了。
      out.push(
        `停用**尚未完成**：仍有 ${String(pause.stopping.length)} 件写入正握着写盘权并正在安全边界上停止。`,
      );
    }
    if (pause.unrevoked_change_sets.length > 0) {
      out.push(
        `有 ${String(pause.unrevoked_change_sets.length)} 条修改集仍然处于待执行状态而未被作废；` +
          '它们在停用期间不会被应用，但操作者应当知道废止没有做完。',
      );
    }
  }
  if (pause !== null && pause.recovery_operations.length > 0) {
    // 与暂停无关，因此在暂停之外也报：一个等着人核验的写入现场，
    // 是这台机器上唯一一件「不管有没有暂停都要有人去看」的事。
    out.push(
      `有 ${String(pause.recovery_operations.length)} 个写入操作处于待恢复状态，需要本地操作者核验；` +
        '在它被处理之前，本工具面不会对相关文件做出任何承诺。',
    );
  }

  if (!flags.read_enabled) {
    out.push('读取类能力（列举、读取、搜索）当前**关闭**：本工具面不会返回任何工作区内容。');
  }
  if (!flags.git_enabled) {
    out.push('只读 Git 能力当前关闭。');
  }
  if (!flags.proposal_enabled) {
    out.push('生成修改集的能力当前关闭：不能提出任何修改，也不会创建修改记录。');
  }
  if (!flags.direct_write_enabled) {
    out.push('写入用户文件的能力当前关闭。');
  }
  if (!gates.compatibility_section3_passed) {
    out.push('平台兼容性（§3）尚未完整验证；它与 G0 一起决定全局读取、Git 与提议能力是否可用。');
  }
  if (!gates.g0_platform_verified) {
    out.push(
      '**G0 完整验收尚未通过**：`bridge_status` / `workspace_list` 等连接与元数据结果，不替代真实文件内容读取、测试目录写入回读、身份边界及断连重连核验；全局读取门禁因此保持关闭。',
    );
  }
  if (!gates.native_guard_verified) {
    out.push('原生句柄护栏尚未通过验证；直写在门禁层被保持关闭。');
  }
  if (!gates.g4_concurrency_fault_passed) {
    out.push(
      '**竞争与故障专项测试尚未通过（G4 未通过）**：写入路径在并发、崩溃与存储故障下的表现未经检验，直写因此在门禁层被保持关闭。',
    );
  }
  out.push('结果只覆盖本地操作者显式授权的工作区，不是对本机文件系统的扫描。');
  out.push('所有路径均为工作区内相对路径；本工具面从不返回本机绝对路径。');
  return out;
}
