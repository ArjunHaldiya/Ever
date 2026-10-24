import { describe, expect, it } from "vitest";
import { matchResource, rankResources } from "../src";
import { ELEVEN_PM_PT, makeResource, NOON_PT, ORIGIN_95112 } from "./fixtures";

const base = { needType: "refrigeration", origin: ORIGIN_95112, now: NOON_PT } as const;

describe("matcher filters", () => {
  it("excludes resources without power", () => {
    const resources = [makeResource({ id: "dark", hasPower: false })];
    expect(matchResource({ ...base, resources })).toBeNull();
  });

  it("excludes resources with no capacity", () => {
    const resources = [makeResource({ id: "full", capacity: 0 })];
    expect(matchResource({ ...base, resources })).toBeNull();
  });

  it("excludes resources that do not support the need", () => {
    const resources = [makeResource({ id: "no-fridge", supports: ["pharmacy"] })];
    expect(matchResource({ ...base, resources })).toBeNull();
  });

  it("excludes resources that are closed now", () => {
    const resources = [makeResource({ id: "closed", hours: "08:00-22:00" })];
    expect(matchResource({ ...base, resources, now: ELEVEN_PM_PT })).toBeNull();
  });

  it("includes 24/7 and overnight resources at 11 PM", () => {
    const resources = [
      makeResource({ id: "always", hours: "24/7" }),
      makeResource({ id: "overnight", hours: "20:00-06:00" }),
    ];
    const ids = rankResources({ ...base, resources, now: ELEVEN_PM_PT }).map((m) => m.resource.id);
    expect(ids.sort()).toEqual(["always", "overnight"]);
  });

  it("treats unparseable hours as closed", () => {
    const resources = [makeResource({ id: "weird", hours: "whenever" })];
    expect(matchResource({ ...base, resources })).toBeNull();
  });

  it("never routes 'info' needs to a place", () => {
    const resources = [makeResource({ supports: ["info"] })];
    expect(rankResources({ ...base, needType: "info", resources })).toEqual([]);
  });

  it("returns null for an empty resource list", () => {
    expect(matchResource({ ...base, resources: [] })).toBeNull();
  });
});

describe("matcher ordering", () => {
  const near = makeResource({ id: "near", lat: 37.35, lng: -121.895 });
  const far = makeResource({ id: "far", lat: 37.45, lng: -121.95 });

  it("sorts by distance, nearest first, regardless of input order", () => {
    const ids = rankResources({ ...base, resources: [far, near] }).map((m) => m.resource.id);
    expect(ids).toEqual(["near", "far"]);
  });

  it("skips a closer ineligible resource and picks the nearest eligible one", () => {
    const closerButDark = makeResource({ id: "closer-dark", lat: 37.3493, lng: -121.8944, hasPower: false });
    const best = matchResource({ ...base, resources: [closerButDark, far, near] });
    expect(best?.resource.id).toBe("near");
  });

  it("breaks distance ties by remaining capacity, then id", () => {
    const a = makeResource({ id: "a", capacity: 3 });
    const b = makeResource({ id: "b", capacity: 9 });
    const c = makeResource({ id: "c", capacity: 9 });
    const ids = rankResources({ ...base, resources: [a, c, b] }).map((m) => m.resource.id);
    expect(ids).toEqual(["b", "c", "a"]);
  });

  it("does not mutate its input", () => {
    const resources = [far, near];
    rankResources({ ...base, resources });
    expect(resources.map((r) => r.id)).toEqual(["far", "near"]);
  });

  it("reports a plausible distance in miles", () => {
    const best = matchResource({ ...base, resources: [makeResource()] });
    // ~0.9 mi between the fixture origin and resource
    expect(best?.distanceMiles).toBeGreaterThan(0.5);
    expect(best?.distanceMiles).toBeLessThan(1.5);
  });
});

describe("matcher reason (FR-6)", () => {
  it("explains the choice in one line with power, capacity and distance", () => {
    const best = matchResource({ ...base, resources: [makeResource({ capacity: 4 })] });
    expect(best?.reason).toContain("fridge space");
    expect(best?.reason).toContain("4 fridge slots left");
    expect(best?.reason).toContain("the only open option");
    expect(best?.reason).not.toContain("\n");
  });

  it("says how many options it chose from", () => {
    const resources = [makeResource({ id: "x" }), makeResource({ id: "y", lat: 37.4, lng: -121.9 })];
    expect(matchResource({ ...base, resources })?.reason).toContain("closest of 2 open options");
  });
});
