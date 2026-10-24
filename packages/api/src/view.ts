import type { AlertRecord, Focus, Stats, WarningView } from "@ever/core";

/**
 * Derives the privacy-safe pieces of the dashboard state from raw rows. Raw Needs rows hold a
 * redacted message, a rounded location and a ZIP; none of that leaves this file. Only the kind
 * of help asked for, and aggregate counts, are returned.
 */

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const time = (v: unknown): number | null => {
  const s = str(v);
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? null : t;
};

const NEED_TYPES = new Set(["refrigeration", "device_power", "pharmacy", "food", "cooling", "charging"]);

/** The newest request that asks for a place. "info" messages (hello, unclear) do not change it. */
export function deriveFocus(rows: readonly Row[]): Focus | null {
  const newest = rows
    .filter((r) => time(r.createdAt) !== null && NEED_TYPES.has(String(r.needType)))
    .sort((a, b) => time(b.createdAt)! - time(a.createdAt)!)[0];
  return newest ? { needType: newest.needType as Focus["needType"], at: String(newest.createdAt) } : null;
}

export function deriveStats(rows: readonly Row[]): Stats {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const bedrock = rows.filter((r) => r.extractor === "bedrock");
  const latest = [...bedrock].sort((a, b) => (time(b.createdAt) ?? 0) - (time(a.createdAt) ?? 0))[0];
  return {
    requests: rows.length,
    bedrockPct: rows.length ? Math.round((100 * bedrock.length) / rows.length) : null,
    avgExtractMs: mean(bedrock.map((r) => num(r.latencyMs)).filter((n): n is number => n !== null)),
    avgReplyMs: mean(
      rows.flatMap((r) => {
        const start = time(r.createdAt);
        const end = time(r.routedAt);
        return start !== null && end !== null && end >= start ? [end - start] : [];
      }),
    ),
    modelId: latest ? str(latest.modelId) : null,
  };
}

/** The latest shutoff warning as totals only. Nothing per person leaves the server. */
export function deriveWarning(alerts: readonly AlertRecord[]): WarningView | null {
  if (alerts.length === 0) return null;
  const newest = [...alerts].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
  const group = alerts.filter((a) => a.alertId === newest.alertId);
  return {
    alertId: newest.alertId,
    zip: newest.zip,
    shutoffAt: newest.shutoffAt,
    createdAt: newest.createdAt,
    total: group.length,
    sent: group.filter((a) => a.sentAt).length,
    delivered: group.filter((a) => a.deliveredAt).length,
    read: group.filter((a) => a.readAt).length,
    failed: group.filter((a) => a.error && !a.sentAt).length,
  };
}
