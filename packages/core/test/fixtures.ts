import type { LatLng, Resource } from "../src";

/** Noon in San Jose (PDT, UTC-7) on Fri 2026-10-23. */
export const NOON_PT = new Date("2026-10-23T19:00:00Z");
/** 11 PM in San Jose the same day. */
export const ELEVEN_PM_PT = new Date("2026-10-24T06:00:00Z");

export const ORIGIN_95112: LatLng = { lat: 37.3492, lng: -121.8943 };

export function makeResource(overrides: Partial<Resource> = {}): Resource {
  return {
    id: "r-default",
    name: "Test Pharmacy",
    type: "pharmacy",
    lat: 37.3382,
    lng: -121.8863,
    address: "1 Test St, San Jose, CA 95112",
    hasPower: true,
    capacity: 10,
    capacityUnit: "fridge slots",
    hours: "08:00-22:00",
    supports: ["pharmacy", "refrigeration"],
    ...overrides,
  };
}
