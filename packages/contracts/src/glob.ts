/**
 * 受限 glob 匹配（text_search 的 path_glob）。
 *
 * 只支持三种通配：
 *  - `*`  匹配路径段内的任意字符（不跨 `/`）
 *  - `?`  匹配路径段内的单个字符（不跨 `/`）
 *  - `**` 作为整段时匹配任意层目录
 *
 * **不**支持字符类、花括号展开、`!` 取反。原因是这些特性容易演变成
 * 任意正则，而方案明确禁止把用户输入变成任意模式匹配。所有正则元字符
 * 在转换过程中都被转义。
 *
 * 与安全无关：匹配成功只影响搜索范围，不构成任何授权判定。
 */

const MAX_GLOB_CHARS = 256;
const MAX_GLOB_SEGMENTS = 32;

export interface GlobRejected {
  readonly ok: false;
  readonly reason: string;
}

export interface GlobAccepted {
  readonly ok: true;
  readonly regex: RegExp;
  readonly source: string;
}

export type GlobCompileResult = GlobAccepted | GlobRejected;

function escapeRegExpSegment(segment: string): string {
  let out = '';
  for (const ch of segment) {
    if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

/**
 * 编译 glob。大小写按 Windows 语义处理为不敏感。
 */
export function compileGlob(pattern: unknown): GlobCompileResult {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { ok: false, reason: 'path_glob 必须是非空字符串' };
  }
  if (pattern.length > MAX_GLOB_CHARS) {
    return { ok: false, reason: `path_glob 超过 ${MAX_GLOB_CHARS} 字符` };
  }
  const unified = pattern.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = unified.split('/');
  if (segments.length > MAX_GLOB_SEGMENTS) {
    return { ok: false, reason: `path_glob 层级超过 ${MAX_GLOB_SEGMENTS}` };
  }

  const parts: string[] = ['^'];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] as string;
    if (segment === '**') {
      // `**/` 匹配零个或多个目录层。
      parts.push('(?:[^/]+/)*');
    } else {
      parts.push(escapeRegExpSegment(segment));
      if (i < segments.length - 1) {
        parts.push('/');
      }
    }
  }
  parts.push('$');

  try {
    return { ok: true, regex: new RegExp(parts.join(''), 'i'), source: unified };
  } catch (error) {
    return { ok: false, reason: `path_glob 编译失败：${(error as Error).message}` };
  }
}

export function matchesGlob(regex: RegExp, path: string): boolean {
  return regex.test(path);
}
