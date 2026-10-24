/**
 * Structured JSON logs (CLAUDE.md convention): keys that could hold message text or
 * phone numbers are dropped, so a careless call can't leak PII into CloudWatch.
 */
const FORBIDDEN_KEYS = new Set([
  "text", "texts", "body", "message", "sender", "to", "phone", "handle", "redactedText",
]);

export function scrub(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([k]) => !FORBIDDEN_KEYS.has(k)));
}

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...scrub(fields), at: new Date().toISOString() }));
}

/** "+14085551234" -> "***1234" for the rare case a hint is useful. */
export function maskHandle(handle: string | undefined): string {
  return handle ? `***${handle.slice(-4)}` : "unknown";
}
