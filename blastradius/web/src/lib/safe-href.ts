/**
 * Evidence URLs come from scanned registry/repository metadata, so only https
 * URLs become clickable links. Anything else (http:, javascript:, data:,
 * relative) returns null and is rendered as plain text by the caller.
 */
export function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}
