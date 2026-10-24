import type { Focus, Resource } from "@ever/core";
import { describe, expect, it } from "vitest";
import { FOCUS_LABEL, isUsable, matchingPlaces, modelLabel, placeLook } from "../src/lib/format";

const place = (over: Partial<Resource> = {}): Resource => ({
  id: "p1",
  name: "Downtown Care Pharmacy",
  type: "pharmacy",
  lat: 37.33,
  lng: -121.89,
  address: "1 Main St",
  hasPower: true,
  capacity: 6,
  capacityUnit: "fridge slots",
  hours: "24/7",
  supports: ["pharmacy", "refrigeration"],
  ...over,
});
const focus = (needType: Focus["needType"]): Focus => ({ needType, at: "2026-10-24T07:00:00.000Z" });

describe("placeLook (where to send people)", () => {
  it("highlights places that can help with the request in focus", () => {
    expect(placeLook(place(), focus("pharmacy"))).toBe("match");
    expect(placeLook(place(), focus("refrigeration"))).toBe("match");
  });

  it("fades places that cannot help", () => {
    expect(placeLook(place(), focus("food"))).toBe("dim");
  });

  it("shows a matching place with no power or no room, but does not highlight it", () => {
    expect(placeLook(place({ hasPower: false }), focus("pharmacy"))).toBe("match-off");
    expect(placeLook(place({ capacity: 0 }), focus("pharmacy"))).toBe("match-off");
  });

  it("draws every place normally when nothing is in focus", () => {
    expect(placeLook(place(), null)).toBe("normal");
    expect(placeLook(place({ hasPower: false }), null)).toBe("off");
  });

  it("keeps the highlight until the focus changes", () => {
    const f = focus("pharmacy");
    expect(placeLook(place(), f)).toBe(placeLook(place(), f));
    expect(placeLook(place(), focus("charging"))).toBe("dim");
  });
});

describe("matchingPlaces", () => {
  const all = [
    place({ id: "a" }),
    place({ id: "b", supports: ["food"] }),
    place({ id: "c", hasPower: false }),
    place({ id: "d", capacity: 0 }),
  ];
  it("returns only usable places that support the need", () => {
    expect(matchingPlaces(all, focus("pharmacy")).map((p) => p.id)).toEqual(["a"]);
    expect(matchingPlaces(all, focus("food")).map((p) => p.id)).toEqual(["b"]);
  });
  it("returns nothing without a focus", () => {
    expect(matchingPlaces(all, null)).toEqual([]);
  });
  it("defines usable as power and room left", () => {
    expect(isUsable(place())).toBe(true);
    expect(isUsable(place({ capacity: 0 }))).toBe(false);
  });
});

describe("labels", () => {
  it("has a map label for every kind of request", () => {
    for (const k of ["pharmacy", "refrigeration", "device_power", "food", "cooling", "charging"] as const) {
      expect(FOCUS_LABEL[k].length).toBeGreaterThan(3);
    }
  });
  it("formats model ids", () => {
    expect(modelLabel("amazon.nova-lite-v1:0")).toBe("NOVA LITE");
    expect(modelLabel(null)).toBe("BEDROCK");
  });
});
