/** Correlation only. None of these values grants permission or identifies an OS process. */
export const ARCHIVED_CALL_OPERATION = 'tools.invoke_archived.v1';
export interface ConversationHint {
  readonly status: 'present' | 'missing' | 'invalid';
  readonly session?: string;
}
export interface ArchivedInvocation {
  readonly name: string;
  readonly input: unknown;
  readonly conversation: ConversationHint;
}
const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
function sessionValue(v: unknown): ConversationHint {
  if (v === undefined) return { status: 'missing' };
  if (typeof v !== 'string' || v.length < 1 || v.length > 512 || /[\s\x00-\x1f\x7f]/.test(v)) {
    return { status: 'invalid' };
  }
  return { status: 'present', session: v };
}
/** Read ONLY MCP request.params._meta, never tool arguments or a chat title. */
export function conversationHint(meta: unknown): ConversationHint {
  if (meta === undefined) return { status: 'missing' };
  if (!isObject(meta)) return { status: 'invalid' };
  return sessionValue(Object.hasOwn(meta, 'openai/session') ? meta['openai/session'] : undefined);
}
/** Revalidate the adapter envelope at the authenticated daemon boundary. */
export function parseArchivedInvocation(raw: unknown): ArchivedInvocation {
  if (!isObject(raw) || Object.keys(raw).some(k => !['name','input','conversation'].includes(k)) ||
      typeof raw['name'] !== 'string' || raw['name'].length > 128 || !isObject(raw['conversation'])) {
    throw new TypeError('Invalid archived invocation.');
  }
  const h = raw['conversation'];
  if (Object.keys(h).some(k => !['status','session'].includes(k))) throw new TypeError('Invalid correlation.');
  if (h['status'] === 'present') {
    const parsed = sessionValue(h['session']);
    if (parsed.status !== 'present') throw new TypeError('Invalid correlation.');
    return { name: raw['name'], input: raw['input'], conversation: parsed };
  }
  if ((h['status'] !== 'missing' && h['status'] !== 'invalid') || h['session'] !== undefined) {
    throw new TypeError('Invalid correlation.');
  }
  return { name: raw['name'], input: raw['input'], conversation: { status: h['status'] } };
}
