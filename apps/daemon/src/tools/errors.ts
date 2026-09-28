/**
 * 出站错误载荷：本进程里**唯一**把异常翻成模型可见载荷的地方（LWB-017）。
 *
 * ## 为什么不能直接把异常交给 MCP 层
 *
 * 有两条现成的、都会泄露的路：
 *
 *  1. **IPC 层的兜底**。`packages/ipc/src/server.ts` 的 `#handleRequest` 把
 *     处理器抛出的错误收成 `{ ok: false, code: 'OPERATION_FAILED',
 *     reason: error.message }`。那条 `reason` 是给本地排障写的 ——
 *     里面可以有本机绝对路径（护栏的异常文本就带）、可以有源码片段。
 *     IPC 层**不认识** `@lwb/contracts`，它无从判断哪些能出站。
 *  2. **直接把 BridgeError 的 message 交出去**。本工程的 BridgeError 消息
 *     大多是写好的中文短句，但有几处插值了底层错误文本
 *     （`packages/files/src/guard-bridge.ts`、`packages/git-reader/src/layout.ts`），
 *     那些文本来自 PowerShell 助手，包含被拒绝的路径。
 *
 * 因此工具处理器**不抛异常**：它捕获一切，在这里翻译成 `BridgeErrorPayload`，
 * 作为**结果**（`{ok:false, error}` 信封）返回。IPC 层于是永远只看到
 * 「处理器正常返回」，`OPERATION_FAILED` 这条路径在本工具面上不再被走到。
 *
 * ## 判据：形态与内容，两道都过才放行
 *
 *  - **形态**：出现 Windows 盘符/UNC/设备路径、POSIX 绝对路径或 `file:` URL，
 *    即判定「这是本机诊断文本」，整句换成该错误码的 `summary`。
 *  - **内容**：`screenText` 命中**高置信度**秘密同样换掉。这里只认 certain 档，
 *    与 `packages/files/src/list.ts` 对文件名的处置一致 —— likely 档会给
 *    大量假阳性，而假阳性的代价是「错误信息里全是被替换掉的占位符」。
 *
 * 两道的处置都是**整句替换**而不是就地打码：一句被打了码的诊断文本仍然
 * 带着它周围的形状，而调用方对错误信息的期待本来就是「要么能用要么没有」。
 *
 * ## 本地那一份不会被丢掉
 *
 * `describeForLocalAudit` 返回**原样**的文本，供审计层（LWB-018）落盘。
 * 诊断信息不消失，它只是不出站。
 */

import { BridgeError, BRIDGE_ERRORS } from '@lwb/contracts';
import type { BridgeErrorPayload } from '@lwb/contracts';
import { screenText } from '@lwb/egress';

/**
 * Windows 本机绝对路径的形状。
 *
 * 前导字符那一段是必要的：`C:/x` 里的 `C:` 只有在词首才是指盘符，
 * 否则 `abc:C:/x` 也算 —— 那会让一句话里的普通文本被整句换掉，
 * 属于假阳性方向，代价是整个错误信息失去信息量。
 */
const LOCAL_PATH_SHAPE = /(?:^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\)/;
// `file:` is checked separately so punctuation before the scheme (including a
// localized colon) cannot bypass the path filter; raw POSIX paths keep a
// narrower boundary to avoid treating ordinary URL paths as local filenames.
const FILE_URL_PATH_SHAPE = /(?:^|[^A-Za-z0-9])file:(?:\/\/(?:localhost)?\/+|\/+)(?:[A-Za-z0-9._~+-]+\/)*[A-Za-z0-9._~+-]+/i;
const POSIX_PATH_SHAPE = /(?:^|[\s"'`=])\/(?:[A-Za-z0-9._~+-]+\/)*[A-Za-z0-9._~+-]+/;

/** 这段文本能不能出站。 */
export function isSafeForModel(text: string): boolean {
  if (LOCAL_PATH_SHAPE.test(text) || FILE_URL_PATH_SHAPE.test(text) || POSIX_PATH_SHAPE.test(text)) return false;
  return !screenText(text).has_certain;
}

/**
 * 异常 → 模型可见载荷。
 *
 * 非 `BridgeError` 一律折成 `INTERNAL_ERROR`，并且**绝不**带上原始
 * `error.message` —— 一个来路不明的异常，它的消息是本进程里唯一
 * 未经审视的自由文本。
 */
export function toModelPayload(cause: unknown): BridgeErrorPayload {
  if (!(cause instanceof BridgeError)) {
    const spec = BRIDGE_ERRORS.INTERNAL_ERROR;
    return {
      code: 'INTERNAL_ERROR',
      message: spec.summary,
      category: spec.category,
      auto_retry: spec.autoRetry,
      details: { reason: 'UNEXPECTED_ERROR' },
    };
  }

  const spec = BRIDGE_ERRORS[cause.code];
  const payload: BridgeErrorPayload = {
    code: cause.code,
    message: isSafeForModel(cause.message) ? cause.message : spec.summary,
    category: spec.category,
    auto_retry: spec.autoRetry,
  };

  // 明细整体保留或整体丢弃。逐项丢弃会让「哪些字段还在」取决于内容，
  // 于是同一个错误码在不同调用里长得不一样，调用方无法按形状判断。
  if (cause.details !== undefined && detailsAreSafe(cause.details)) {
    return { ...payload, details: cause.details };
  }
  return payload;
}

function detailsAreSafe(details: Readonly<Record<string, string | number | boolean | null>>): boolean {
  for (const value of Object.values(details)) {
    if (typeof value === 'string' && !isSafeForModel(value)) return false;
  }
  return true;
}

/** 本地审计用：原样的异常描述。**不得**进入任何工具结果。 */
export function describeForLocalAudit(cause: unknown): string {
  if (cause instanceof BridgeError) return `${cause.code}: ${cause.message}`;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}
