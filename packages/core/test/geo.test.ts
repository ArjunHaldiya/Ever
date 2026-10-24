import { describe, expect, it } from "vitest";
import { extractZip, haversineMiles, lookupZip, roundCoord, roundLatLng } from "../src";

describe("haversineMiles", () => {
  it("is zero for the same point", () => {
    expect(haversineMiles({ lat: 37.3, lng: -121.9 }, { lat: 37.3, lng: -121.9 })).toBe(0);
  });

  it("matches a known distance (San Jose -> San Francisco is ~42 mi)", () => {
    const d = haversineMiles(
      { lat: 37.3382, lng: -121.8863 },
      { lat: 37.7749, lng: -122.4194 },
    );
    expect(d).toBeGreaterThan(41);
    expect(d).toBeLessThan(43.5);
  });

  it("is symmetric", () => {
    const a = { lat: 37.3, lng: -121.9 };
    const b = { lat: 37.4, lng: -122.0 };
    expect(haversineMiles(a, b)).toBeCloseTo(haversineMiles(b, a), 10);
  });
});

describe("rounding (FR-7)", () => {
  it("rounds to 3 decimal places", () => {
    expect(roundCoord(37.349234)).toBe(37.349);
    expect(roundCoord(-121.89438)).toBe(-121.894);
    expect(roundLatLng({ lat: 37.3496, lng: -121.8943 })).toEqual({ lat: 37.35, lng: -121.894 });
  });
});

describe("extractZip / lookupZip", () => {
  it("finds a 5-digit ZIP and ignores ZIP+4 suffix", () => {
    expect(extractZip("I'm in 95112")).toBe("95112");
    expect(extractZip("95112-4321 please")).toBe("95112");
  });

  it("does not mistake phone numbers or long numbers for a ZIP", () => {
    expect(extractZip("call 408-555-1234")).toBeNull();
    expect(extractZip("order 1234567")).toBeNull();
    expect(extractZip("no zip here")).toBeNull();
  });

  it("looks up centroids from the seeded table", () => {
    const table = { "95112": { lat: 37.349, lng: -121.894 } };
    expect(lookupZip(table, "95112")).toEqual({ lat: 37.349, lng: -121.894 });
    expect(lookupZip(table, "00000")).toBeNull();
  });
});
