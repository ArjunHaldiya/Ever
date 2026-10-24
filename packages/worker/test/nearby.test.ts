import { describe, expect, it } from "vitest";
import { parseOpenNowPlaces, type PlaceItem } from "../src/nearby";

const MILE = 1609.34;
const item = (over: Partial<PlaceItem> & { miles?: number; open?: boolean; allDay?: boolean } = {}): PlaceItem => ({
  PlaceId: over.PlaceId ?? `id-${Math.random()}`,
  Title: over.Title ?? "All Star Cafe",
  Distance: (over.miles ?? 0.1) * MILE,
  Address: over.Address ?? { Label: "All Star Cafe, 1500 Market St, San Francisco, CA 94102, United States" },
  OpeningHours: [
    {
      OpenNow: over.open ?? true,
      Components: over.allDay
        ? [{ OpenDuration: "PT24H00M", Recurrence: "FREQ:DAILY;BYDAY:MO,TU,WE,TH,FR,SA,SU" }]
        : [{ OpenDuration: "PT08H00M", Recurrence: "FREQ:DAILY;BYDAY:MO,TU,WE,TH,FR" }],
    },
  ],
});

describe("parseOpenNowPlaces", () => {
  it("keeps open-now places, cleans the address, and converts meters to miles", () => {
    expect(parseOpenNowPlaces([item({ allDay: true })], 15)).toEqual([
      { name: "All Star Cafe", address: "1500 Market St, San Francisco, CA 94102", distanceMiles: 0.1, hours: "24h" },
    ]);
  });

  it("marks a place open all day only when every day of the week is covered", () => {
    const weekdaysOnly = item({ allDay: true });
    weekdaysOnly.OpeningHours![0]!.Components![0]!.Recurrence = "FREQ:DAILY;BYDAY:SA,SU";
    expect(parseOpenNowPlaces([weekdaysOnly], 15)[0]!.hours).toBe("open");
    expect(parseOpenNowPlaces([item()], 15)[0]!.hours).toBe("open");
  });

  it("drops places that are closed now or have no hours information", () => {
    const noHours: PlaceItem = { ...item(), OpeningHours: undefined };
    expect(parseOpenNowPlaces([item({ open: false }), noHours], 15)).toEqual([]);
  });

  it("drops places beyond the radius", () => {
    expect(parseOpenNowPlaces([item({ miles: 40 })], 15)).toEqual([]);
  });

  it("sorts nearest first, removes duplicates, and keeps at most three", () => {
    const items = [
      item({ PlaceId: "d", Title: "D", miles: 4 }),
      item({ PlaceId: "a", Title: "A", miles: 1 }),
      item({ PlaceId: "a", Title: "A", miles: 1 }), // duplicate id
      item({ PlaceId: "b", Title: "B", miles: 2 }),
      item({ PlaceId: "c", Title: "C", miles: 3 }),
    ];
    expect(parseOpenNowPlaces(items, 15).map((p) => p.name)).toEqual(["A", "B", "C"]);
  });

  it("skips results missing a title, address or distance", () => {
    const bad = [{ ...item(), Title: undefined }, { ...item(), Address: undefined }, { ...item(), Distance: undefined }];
    expect(parseOpenNowPlaces(bad as PlaceItem[], 15)).toEqual([]);
  });

  it("leaves an address alone when it does not start with the title", () => {
    const out = parseOpenNowPlaces([item({ Address: { Label: "1 Main St, Austin, TX 78701, United States" } })], 15);
    expect(out[0]!.address).toBe("1 Main St, Austin, TX 78701");
  });
});
