import { haversineMiles } from "./geo";
import { isOpenAt } from "./hours";
import type { LatLng, NeedType, Resource } from "./types";

export type Match = {
  resource: Resource;
  distanceMiles: number;
  /** One-line reason shown with every routed answer (FR-6), without a "Chosen:" prefix. */
  reason: string;
};

export type MatchInput = {
  needType: NeedType;
  origin: LatLng;
  resources: readonly Resource[];
  now: Date;
  timeZone?: string;
};

const WHAT_IT_HAS: Record<NeedType, string> = {
  refrigeration: "has power and fridge space",
  device_power: "has power for medical devices",
  pharmacy: "open pharmacy with power",
  food: "serving food now",
  cooling: "has power and cooling",
  charging: "has power and charging outlets",
  info: "open now",
};

function explain(m: Pick<Match, "resource" | "distanceMiles">, needType: NeedType, total: number): string {
  const { resource, distanceMiles } = m;
  const rank = total > 1 ? `closest of ${total} open options` : "the only open option";
  return [
    WHAT_IT_HAS[needType],
    "open now",
    `${resource.capacity} ${resource.capacityUnit} left`,
    `${rank} (${distanceMiles.toFixed(1)} mi)`,
  ].join(", ");
}

/**
 * Deterministic matcher, shared by the AI and degraded paths.
 * Keeps resources that have power, are open now, have capacity, and support the
 * need; sorts by distance, then remaining capacity (more first), then id.
 * `info` needs are not routed to a place.
 */
export function rankResources(input: MatchInput): Match[] {
  const { needType, origin, resources, now, timeZone } = input;
  if (needType === "info") return [];
  const eligible = resources
    .filter(
      (r) =>
        r.hasPower &&
        r.capacity > 0 &&
        r.supports.includes(needType) &&
        isOpenAt(r.hours, now, timeZone),
    )
    .map((resource) => ({ resource, distanceMiles: haversineMiles(origin, resource) }))
    .sort(
      (a, b) =>
        a.distanceMiles - b.distanceMiles ||
        b.resource.capacity - a.resource.capacity ||
        a.resource.id.localeCompare(b.resource.id),
    );
  return eligible.map((m) => ({ ...m, reason: explain(m, needType, eligible.length) }));
}

export function matchResource(input: MatchInput): Match | null {
  return rankResources(input)[0] ?? null;
}
