/** Bounded, best-effort redaction. This is not an encrypted raw transcript store. */
export interface CapturedValue {
  readonly json: string;
  readonly original_bytes: number;
  readonly retained_bytes: number;
  readonly redacted: boolean;
  readonly truncated: boolean;
}
const SECRET_KEY = /(?:password|passwd|passphrase|secret|authorization|cookie|credential|private[-_]?key|api[-_]?key|access[-_]?token|refresh[-_]?token|read[-_]?token|^token$|^nonce$|^proof$|^cursor$)/i;
export function captureValue(value: unknown, maxBytes = 65_536): CapturedValue {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1_048_576) throw new RangeError('Invalid payload limit.');
  let redacted = false, truncated = false, nodes = 0;
  const seen = new WeakSet<object>();
  const scrub = (text: string): string => {
    const cleaned = text
      .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED:private-key]')
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+\/._=\-]{8,}/gi, '[REDACTED:authorization]')
      .replace(/\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}/g, '[REDACTED:token]')
      .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED:access-key]')
      .replace(/(\b(?:password|passwd|passphrase|secret|token|api[_-]?key)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;,\r\n]+)/gi, '$1[REDACTED]')
      .replace(/(--(?:password|passwd|secret|token|api-key)\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;]+)/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/)[^\s\/@]+:[^\s\/@]+@/gi, '$1[REDACTED]@')
      .replace(/([?&](?:token|key|sig|signature|x-amz-signature|access_token)=)[^&\s]+/gi, '$1[REDACTED]');
    redacted ||= cleaned !== text;
    return cleaned;
  };
  const walk = (v: unknown, depth: number): unknown => {
    if (++nodes > 10_000 || depth > 24) { truncated = true; return '[TRUNCATED:structure]'; }
    if (typeof v === 'string') {
      const cleaned = scrub(v);
      if (Buffer.byteLength(cleaned, 'utf8') > maxBytes) {
        truncated = true;
        // Slice only after redaction. JSON is serialized again after the cut.
        return Buffer.from(cleaned, 'utf8').subarray(0, maxBytes / 2).toString('utf8') + '[TRUNCATED]';
      }
      return cleaned;
    }
    if (v === null || typeof v === 'boolean' || typeof v === 'number') return v;
    if (typeof v !== 'object') return String(v);
    if (seen.has(v)) { truncated = true; return '[UNSERIALIZABLE:cycle]'; }
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (v.length > 1000) truncated = true;
        return v.slice(0,1000).map(item => walk(item, depth + 1));
      }
      const out: Record<string, unknown> = Object.create(null);
      const entries = Object.entries(v);
      if (entries.length > 1000) truncated = true;
      for (const [k, child] of entries.slice(0,1000)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') { redacted = true; continue; }
        const key = k.length > 256 ? k.slice(0,256) : k;
        if (k.length > 256) truncated = true;
        if (SECRET_KEY.test(k)) { out[key] = '[REDACTED]'; redacted = true; }
        else out[key] = walk(child, depth + 1);
      }
      return out;
    } finally { seen.delete(v); }
  };
  let originalBytes = 0;
  try { originalBytes = Buffer.byteLength(JSON.stringify(value) ?? 'null','utf8'); } catch { truncated = true; }
  let json = JSON.stringify(walk(value, 0)) ?? 'null';
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    truncated = true;
    json = JSON.stringify({ note: 'TRUNCATED_PAYLOAD', preview: Buffer.from(json,'utf8').subarray(0,Math.floor(maxBytes / 4)).toString('utf8') });
  }
  return { json, original_bytes: originalBytes, retained_bytes: Buffer.byteLength(json,'utf8'), redacted, truncated };
}
