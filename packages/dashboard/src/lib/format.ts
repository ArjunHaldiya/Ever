import type { Focus, Resource } from "@ever/core";

/** What the highlighted places can help with, in the words shown on the map. */
export const FOCUS_LABEL: Record<Focus["needType"], string> = {
  pharmacy: "PHARMACIES",
  refrigeration: "COLD STORAGE",
  device_power: "POWER FOR MEDICAL DEVICES",
  food: "FOOD",
  cooling: "COOLING CENTERS",
  charging: "PHONE CHARGING",
};

/** "amazon.nova-lite-v1:0" -> "NOVA LITE". Works for other model ids too. */
export function modelLabel(modelId: string | null | undefined): string {
  if (!modelId) return "BEDROCK";
  const base = modelId.split(".").pop() ?? modelId;
  return base.replace(/-v\d+.*$/, "").replace(/[-_:]/g, " ").trim().toUpperCase() || "BEDROCK";
}

export type PlaceLook = "match" | "match-off" | "dim" | "normal" | "off";

/** A place is usable if it has power and room left. */
export const isUsable = (p: Resource): boolean => p.hasPower && p.capacity > 0;

/**
 * How a place is drawn. With a request in focus, places that can help are highlighted and the rest
 * fade back; a matching place with no power or no room is shown but not highlighted.
 */
export function placeLook(place: Resource, focus: Focus | null): PlaceLook {
  if (!focus) return isUsable(place) ? "normal" : "off";
  if (place.supports.includes(focus.needType)) return isUsable(place) ? "match" : "match-off";
  return "dim";
}

/** Places that can help with the focused request and are usable now. */
export function matchingPlaces(places: readonly Resource[], focus: Focus | null): Resource[] {
  return focus ? places.filter((p) => placeLook(p, focus) === "match") : [];
}

export function clockShort(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
