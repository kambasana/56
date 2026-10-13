/** Escaping helpers for rendering untrusted strings. */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/** Escape text for HTML element content and quoted attribute values. */
export function escapeHtml(value: unknown): string {
  const s = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  return s.replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c] ?? c).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** Return the URL if it is a plain http(s) URL, otherwise undefined (blocks javascript:, data:, …). */
export function safeHttpUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || url.length > 2048) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  return parsed.href;
}

/** Strip control characters and cap length (for SARIF / plain text). */
export function plainText(value: unknown, max = 2000): string {
  const s = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const t = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
