import { SearchPlaceIndexForTextCommand, type LocationClient } from "@aws-sdk/client-location";
import { SearchTextCommand, type GeoPlacesClient } from "@aws-sdk/client-geo-places";
import { logEvent, type LatLng, type NearbyPlace, type NeedType } from "@ever/core";

const METERS_PER_MILE = 1609.34;
const NEARBY_MAX_MILES = 15;
const ALL_DAYS = 7;

/** The subset of a Places search result we read. */
export type PlaceItem = {
  PlaceId?: string;
  Title?: string;
  Distance?: number;
  Address?: { Label?: string };
  OpeningHours?: { OpenNow?: boolean; Components?: { OpenDuration?: string; Recurrence?: string }[] }[];
};

function isOpenAllDay(item: PlaceItem): boolean {
  return (item.OpeningHours ?? []).some((h) =>
    (h.Components ?? []).some((c) => {
      if (c.OpenDuration !== "PT24H00M") return false;
      const days = /BYDAY:([A-Z,]+)/.exec(c.Recurrence ?? "")?.[1];
      return days === undefined || days.split(",").length === ALL_DAYS;
    }),
  );
}

/** "All Star Cafe, 1500 Market St, San Francisco, CA 94102, United States" -> "1500 Market St, San Francisco, CA 94102" */
function cleanAddress(title: string, label: string): string {
  const withoutTitle = label.startsWith(`${title}, `) ? label.slice(title.length + 2) : label;
  return withoutTitle.replace(/,\s*United States$/, "").trim();
}

/**
 * Turn place-search results into the short list shown to a person: only places the provider
 * lists as open right now, within `maxMiles`, nearest first, no duplicates, at most `limit`.
 * Power status is unknown for every place, which the reply says.
 */
export function parseOpenNowPlaces(items: readonly PlaceItem[], maxMiles: number, limit = 3): NearbyPlace[] {
  const seen = new Set<string>();
  const places: NearbyPlace[] = [];
  const sorted = [...items].sort((a, b) => (a.Distance ?? Infinity) - (b.Distance ?? Infinity));
  for (const item of sorted) {
    if (!item.Title || !item.Address?.Label || item.Distance === undefined) continue;
    if (!(item.OpeningHours ?? []).some((h) => h.OpenNow === true)) continue;
    const miles = item.Distance / METERS_PER_MILE;
    if (miles > maxMiles) continue;
    const address = cleanAddress(item.Title, item.Address.Label);
    const key = item.PlaceId ?? `${item.Title}|${address}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    places.push({
      name: item.Title,
      address,
      distanceMiles: Math.round(miles * 10) / 10,
      hours: isOpenAllDay(item) ? "24h" : "open",
    });
    if (places.length === limit) break;
  }
  return places;
}

/** What to search for, per need. Needs with no entry (medical device power) get 211 + utility guidance. */
const SEARCHES: Partial<Record<NeedType, string[]>> = {
  pharmacy: ["pharmacy"],
  refrigeration: ["pharmacy"],
  charging: ["cafe", "convenience store"],
  cooling: ["library", "cafe"],
  food: ["grocery store", "convenience store"],
};

/** Real places that are open right now near a point (Amazon Location Places). Errors return []. */
export function makeNearbySearch(client: Pick<GeoPlacesClient, "send">) {
  return {
    findNearby: async (needType: NeedType, origin: LatLng): Promise<NearbyPlace[]> => {
      const queries = SEARCHES[needType];
      if (!queries) return [];
      const lists = await Promise.all(
        queries.map((QueryText) =>
          client
            .send(
              new SearchTextCommand({
                QueryText,
                BiasPosition: [origin.lng, origin.lat],
                MaxResults: 15,
                AdditionalFeatures: ["Contact"], // includes opening hours
                Filter: { IncludeCountries: ["USA"] },
              }),
              { abortSignal: AbortSignal.timeout(3000) },
            )
            .then((out) => (out.ResultItems ?? []) as PlaceItem[])
            .catch((err) => {
              logEvent("nearby_search_failed", { error: err instanceof Error ? err.name : "unknown" });
              return [] as PlaceItem[];
            }),
        ),
      );
      return parseOpenNowPlaces(lists.flat(), NEARBY_MAX_MILES);
    },
  };
}

/** Turn free text (ZIP, address, intersection, place name) into coordinates anywhere in the US. */
export function makeGeocoder(client: Pick<LocationClient, "send">, indexName: string) {
  return {
    geocodeText: async (text: string): Promise<LatLng | null> => {
      if (!indexName) return null;
      try {
        const out = await client.send(
          new SearchPlaceIndexForTextCommand({
            IndexName: indexName,
            Text: text,
            FilterCountries: ["USA"],
            MaxResults: 1,
          }),
          { abortSignal: AbortSignal.timeout(3000) },
        );
        const point = out.Results?.[0]?.Place?.Geometry?.Point;
        return point && point.length === 2 ? { lat: point[1]!, lng: point[0]! } : null;
      } catch (err) {
        logEvent("geocode_failed", { error: err instanceof Error ? err.name : "unknown" });
        return null;
      }
    },
  };
}
