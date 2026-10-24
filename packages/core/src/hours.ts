/**
 * Resource hours are a string: "24/7" or "HH:MM-HH:MM" (24h clock, local time).
 * A window whose close is earlier than its open wraps past midnight ("20:00-06:00").
 */
export type HoursWindow =
  | { kind: "always" }
  | { kind: "window"; openMin: number; closeMin: number };

export const DEFAULT_TIME_ZONE = "America/Los_Angeles";

const WINDOW_RE = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;

export function parseHours(hours: string): HoursWindow | null {
  const s = hours.trim().toLowerCase();
  if (s === "24/7" || s === "24 hours" || s === "24h") return { kind: "always" };
  const m = WINDOW_RE.exec(s);
  if (!m) return null;
  const openMin = Number(m[1]) * 60 + Number(m[2]);
  const closeMin = Number(m[3]) * 60 + Number(m[4]);
  if (Number(m[2]) > 59 || Number(m[4]) > 59) return null;
  if (openMin >= 24 * 60 || closeMin > 24 * 60) return null;
  if (openMin === closeMin) return null;
  return { kind: "window", openMin, closeMin };
}

/** Minutes since local midnight in `timeZone` at instant `now`. */
export function minutesOfDay(now: Date, timeZone: string = DEFAULT_TIME_ZONE): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/** Unparseable hours count as closed: never route someone to a guess. */
export function isOpenAt(
  hours: string,
  now: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
): boolean {
  const w = parseHours(hours);
  if (!w) return false;
  if (w.kind === "always") return true;
  const t = minutesOfDay(now, timeZone);
  return w.openMin < w.closeMin
    ? t >= w.openMin && t < w.closeMin
    : t >= w.openMin || t < w.closeMin;
}

function formatClock(totalMin: number): string {
  const m = totalMin % (24 * 60);
  const h24 = Math.floor(m / 60);
  const mm = m % 60;
  const suffix = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return mm === 0 ? `${h12} ${suffix}` : `${h12}:${String(mm).padStart(2, "0")} ${suffix}`;
}

/** Human-readable hours for replies: "8 AM-10 PM" or "Open 24 hours". */
export function formatHours(hours: string): string {
  const w = parseHours(hours);
  if (!w) return hours;
  if (w.kind === "always") return "Open 24 hours";
  return `${formatClock(w.openMin)}-${formatClock(w.closeMin)}`;
}
