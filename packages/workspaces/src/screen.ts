/**
 * 候选根筛查（LWB-009 步骤 2、3）。
 *
 * 本模块是**纯函数**：给它事实，它给结论。探测（打开句柄、读卷信息）不在这里，
 * 因为那需要原生层，而原生层在测试里不该被牵着走。
 * 事实与结论分开还有一个好处：拒绝逻辑可以被穷举测试，
 * 而不用为每条规则去造一个真实的网络盘或云占位文件。
 *
 * ## 默认拒绝
 *
 * 函数返回「拒绝理由列表」，调用方在列表非空时拒绝。这里刻意**不**
 * 提供「返回 true 表示通过」的写法：漏接一个返回值的后果，
 * 从「拒绝一次合法登记」变成「接受一次非法登记」，方向完全不同。
 */

import type { WorkspaceKind, WorkspaceMode } from '@lwb/contracts';
import type { BroadDirectoryVerdict, ProtectedIdentityRef } from '@lwb/secure-store';

import { ancestorPaths, isStrictAncestor, parseAbsoluteRoot, rootKey } from './root-path.ts';
import type { RootRejection, RootRejectionReason } from './rejections.ts';

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

/** 调用来源。模型侧永远不是 `local_console`。 */
export type WorkspaceAdminOrigin = 'local_console' | 'model_surface';

/**
 * 原生层在**已打开句柄**上读到的候选根事实。
 *
 * 与 `@lwb/winfs` 的 `WinfsVolumeInfo` 同形，但这里只声明本模块真正用到的字段，
 * 便于测试构造：把整个 WinfsVolumeInfo 搬进来会让每个测试都要写十几个无关字段。
 */
export interface RootFacts {
  readonly path: string;
  readonly volume_id: string;
  readonly file_id: string;
  readonly drive_type: string;
  readonly file_system: string | null;
  readonly is_cloud_placeholder: boolean;
  readonly is_reparse: boolean;
  readonly is_directory: boolean;
  readonly link_count: number;
  readonly volume_info_available: boolean;
}

/** 已登记工作区的投影：重叠判定只需要这几个字段。 */
export interface ExistingRoot {
  readonly id: string;
  readonly alias: string;
  readonly kind: WorkspaceKind;
  readonly mode: WorkspaceMode;
  readonly path: string;
  readonly volume_id: string;
  readonly file_id: string;
}

export interface ScreenInput {
  readonly origin: WorkspaceAdminOrigin;
  readonly alias: string;
  readonly kind: WorkspaceKind;
  readonly mode: WorkspaceMode;
  /** 规范化后的候选根（来自 `parseAbsoluteRoot`）。 */
  readonly root: string;
  readonly facts: RootFacts;
  /** 自外向内、不含自身的严格祖先链事实；缺一级即视为无法验证。 */
  readonly ancestors: readonly RootFacts[];
  /** 来自 `assessBroadDirectory`（受保护存储 + 系统级/用户级广泛目录）。 */
  readonly broad: BroadDirectoryVerdict;
  /** 来自 `findProtectedIdentityMatch`（受保护对象的**真实身份**）。 */
  readonly protected_identity: ProtectedIdentityRef | null;
  /** 在册工作区（不含已移除）。 */
  readonly existing: readonly ExistingRoot[];
}

/** V1 已验证的文件系统。只列 NTFS —— 其余形态没有在本机验证过。 */
export const VERIFIED_FILESYSTEMS: readonly string[] = ['NTFS'];

/** `validateAlias` 的结果。 */
export type AliasCheck = { readonly ok: true } | { readonly ok: false; readonly detail: string };

export const MAX_ALIAS_CHARS = 64;

/**
 * 别名会出现在 `workspace_list` 里回给模型，因此它不能是路径或密钥。
 * 别名是**本机操作者**填的，这条检查挡的是「顺手把路径粘进来」。
 */
export function validateAlias(alias: unknown): AliasCheck {
  if (typeof alias !== 'string') return { ok: false, detail: '别名必须是字符串' };
  const trimmed = alias.trim();
  if (trimmed.length === 0) return { ok: false, detail: '别名不能为空' };
  if (trimmed.length > MAX_ALIAS_CHARS) {
    return { ok: false, detail: `别名超过 ${MAX_ALIAS_CHARS} 字符` };
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return { ok: false, detail: '别名含控制字符' };
  }
  // 路径形状的别名会把本机路径带进模型可见的输出。
  if (/^[A-Za-z]:/.test(trimmed) || trimmed.startsWith('\\') || trimmed.startsWith('/')) {
    return { ok: false, detail: '别名不能是路径' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

function anyWritable(a: WorkspaceMode, b: WorkspaceMode): boolean {
  return a !== 'read_only' || b !== 'read_only';
}

/**
 * 与在册工作区的关系判定（步骤 3）。
 *
 * 两条独立的判据，缺一不可：
 *
 *  1. **身份相等**：同一个物理对象登记两次。它拦得住「换一种写法」——
 *     `D:\a` 与 `\\?\D:\a`、`D:\PROGRA~1` 与 `D:\Program Files` 的字符串
 *     完全不同，身份却相同。
 *  2. **路径包含**：候选根与在册根互为祖孙。它拦得住「字符串不同、
 *     身份也不同」的重叠 —— 例如父目录与子目录，这是两个不同的物理对象。
 *
 * 只做 (1) 会漏掉父子目录；只做 (2) 会漏掉别名写法。两者都要。
 */
function overlapsWithExisting(input: ScreenInput, out: RootRejection[]): void {
  const candidateIsDriveRoot = /^([A-Za-z]):\\$/.test(input.root);
  for (const existing of input.existing) {
    if (existing.volume_id === input.facts.volume_id && existing.file_id === input.facts.file_id) {
      out.push({
        reason: 'DUPLICATE_IDENTITY',
        detail: `与在册工作区「${existing.alias}」是同一个物理对象（卷 ${existing.volume_id} / 文件 ${existing.file_id}）。`,
      });
      continue;
    }
    if (rootKey(existing.path) === rootKey(input.root)) {
      out.push({
        reason: 'DUPLICATE_PATH',
        detail: `路径已被在册工作区「${existing.alias}」占用。`,
      });
      continue;
    }
    // 明确登记整块卷会覆盖该卷上已有的窄目录 grant；这是操作者要求的
    // 扩权，不应被旧的目录重叠保护反向锁住。反过来，在册整卷仍会阻止
    // 之后再登记一个看似更窄、实际会被整卷 grant 绕开的子目录。
    if (candidateIsDriveRoot) continue;
    if (!anyWritable(existing.mode, input.mode)) continue;

    if (isStrictAncestor(existing.path, input.root)) {
      out.push({
        reason: 'WRITABLE_ROOT_OVERLAP',
        detail: `候选根位于在册工作区「${existing.alias}」之内。至少一侧可写时，内层授权会让外层的限制形同虚设。`,
      });
    } else if (isStrictAncestor(input.root, existing.path)) {
      out.push({
        reason: 'WRITABLE_ROOT_OVERLAP',
        detail: `候选根包含在册工作区「${existing.alias}」。至少一侧可写时，外层授权会让内层的限制形同虚设。`,
      });
    }
  }

  // 祖先链上的身份比对：候选根的某一级**就是**某条在册工作区，
  // 只是写法不同（8.3 短名、大小写、别名）。字符串包含判定看不出来。
  const byIdentity = new Map(
    input.existing.map((e) => [`${e.volume_id}\u0000${e.file_id}`, e] as const),
  );
  for (const ancestor of input.ancestors) {
    const hit = byIdentity.get(`${ancestor.volume_id}\u0000${ancestor.file_id}`);
    if (!hit) continue;
    if (!anyWritable(hit.mode, input.mode)) continue;
    if (rootKey(hit.path) === rootKey(input.root)) continue; // 上面已按路径报过
    out.push({
      reason: 'WRITABLE_ROOT_OVERLAP',
      detail: `候选根的上级「${ancestor.path}」是在册工作区「${hit.alias}」的根（写法不同，身份相同）。`,
    });
  }
}

function push(out: RootRejection[], reason: RootRejectionReason, detail: string): void {
  out.push({ reason, detail });
}

/**
 * 汇总一次候选根筛查的全部拒绝理由。
 *
 * 刻意**收集全部**理由而不是遇到第一条就返回：本地操作者一次就能看到
 * 所有问题，而不是改一个跑一次。
 */
export function screenRoot(input: ScreenInput): RootRejection[] {
  const out: RootRejection[] = [];

  // --- 来源：外部模型不能创建工作区（步骤 4） ---------------------------
  if (input.origin !== 'local_console') {
    push(out, 'ORIGIN_NOT_LOCAL', `调用来源为 ${input.origin}，只有本地控制台可以登记工作区。`);
  }

  // --- 别名 ------------------------------------------------------------
  const alias = validateAlias(input.alias);
  if (!alias.ok) push(out, 'INVALID_ALIAS', alias.detail);

  // --- 广泛目录 / 受保护存储（来自 secure-store 的判定） ----------------
  const explicitlySelectedDriveRoot = /^([A-Za-z]):\\$/.test(input.root) && input.kind === 'directory';
  if (!input.broad.accepted && !explicitlySelectedDriveRoot) {
    // secure-store 把「受保护根的祖先」与「系统级广泛目录」合并在一个 verdict 里，
    // 这里按措辞拆回两个理由码，好让测试能分别钉住。
    const reason: RootRejectionReason = input.broad.reason.includes('受保护存储')
      ? 'PROTECTED_STORE'
      : 'BROAD_DIRECTORY';
    push(out, reason, input.broad.reason);
  }
  if (input.protected_identity) {
    push(
      out,
      'PROTECTED_IDENTITY',
      `候选根的文件身份等于受保护对象「${input.protected_identity.label}」。`,
    );
  }

  // --- 形态 ------------------------------------------------------------
  const facts = input.facts;
  if (!facts.volume_info_available) {
    push(out, 'VOLUME_INFO_UNAVAILABLE', '取不到卷信息，无法判定文件系统；V1 不接受未验证的形态。');
  } else if (facts.file_system === null) {
    push(out, 'VOLUME_INFO_UNAVAILABLE', '卷信息中不含文件系统名。');
  } else if (!VERIFIED_FILESYSTEMS.includes(facts.file_system.toUpperCase())) {
    push(
      out,
      'FILESYSTEM_UNVERIFIED',
      `文件系统为 ${facts.file_system}，不在 V1 已验证范围（${VERIFIED_FILESYSTEMS.join('/')}）。`,
    );
  }

  if (facts.drive_type === 'remote') {
    push(out, 'DRIVE_TYPE_REMOTE', '候选根位于网络盘（GetDriveTypeW = DRIVE_REMOTE）。');
  } else if (facts.drive_type !== 'fixed') {
    push(
      out,
      'DRIVE_TYPE_UNSUPPORTED',
      `盘型为 ${facts.drive_type}，不在 V1 已验证范围（仅 fixed）。`,
    );
  }

  if (facts.is_cloud_placeholder) {
    push(out, 'CLOUD_PLACEHOLDER', '候选根带云端回调属性，读取可能触发下载。');
  }
  if (facts.is_reparse) {
    push(out, 'ROOT_IS_REPARSE', '候选根自身是重解析点。');
  }
  if (facts.link_count > 1) {
    push(out, 'HARDLINK', `候选根硬链接数为 ${facts.link_count}。`);
  }

  const actualKind: WorkspaceKind = facts.is_directory ? 'directory' : 'file';
  if (actualKind !== input.kind) {
    push(
      out,
      'KIND_MISMATCH',
      `登记形态为 ${input.kind}，磁盘上实际是 ${actualKind}。`,
    );
  }

  // --- 祖先链 ----------------------------------------------------------
  // 只检查最终一级是不够的：中间某级是 Junction 时，字符串前缀仍然
  // 「看起来」在工作区内，真实对象已经在别处（方案 §5.2）。
  const expectedAncestors = ancestorPaths(input.root);
  const seenAncestors = new Set(input.ancestors.map((a) => rootKey(a.path)));
  for (const expected of expectedAncestors) {
    if (!seenAncestors.has(rootKey(expected))) {
      push(out, 'ANCESTOR_UNVERIFIABLE', `未取得上级路径「${expected}」的形态事实。`);
    }
  }
  for (const ancestor of input.ancestors) {
    if (ancestor.is_reparse) {
      push(out, 'ANCESTOR_IS_REPARSE', `上级路径「${ancestor.path}」是重解析点。`);
    }
  }

  // --- 与在册工作区的关系 ----------------------------------------------
  overlapsWithExisting(input, out);

  return out;
}

/**
 * 把候选根解析成规范化路径；解析失败时转成拒绝理由。
 *
 * 独立导出是为了让登记流程**只有一条**解析路径：流程里任何一处
 * 直接用 `parseAbsoluteRoot` 都会绕过理由码的转换，从而在错误信息里
 * 丢掉具体原因。
 */
export function parseRootOrReject(raw: unknown): { root: string } | { rejections: RootRejection[] } {
  const parsed = parseAbsoluteRoot(raw);
  if (parsed.ok) return { root: parsed.normalized };
  return { rejections: [{ reason: parsed.reason, detail: parsed.detail }] };
}
