import { describe, expect, it } from "vitest";
import { loadSeed } from "../../../seed/load";
import { extractZip, NEED_TYPES, rankResources } from "../src";
import { NOON_PT } from "./fixtures";

const seed = loadSeed();

describe("seed data", () => {
  it("has about 30 valid resources and is labeled as demo data", () => {
    expect(seed.resources.length).toBeGreaterThanOrEqual(28);
    expect(seed.notices.join(" ")).toMatch(/DEMO DATA/);
  });

  it("has unique resource ids", () => {
    const ids = seed.resources.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every routable need type with at least one powered resource", () => {
    for (const needType of NEED_TYPES.filter((n) => n !== "info")) {
      const powered = seed.resources.filter(
        (r) => r.hasPower && r.capacity > 0 && r.supports.includes(needType),
      );
      expect(powered.length, needType).toBeGreaterThan(0);
    }
  });

  it("includes unpowered and full resources so the matcher traps are exercised", () => {
    expect(seed.resources.some((r) => !r.hasPower)).toBe(true);
    expect(seed.resources.some((r) => r.capacity === 0)).toBe(true);
  });

  it("has a centroid for every ZIP the resources sit in", () => {
    for (const r of seed.resources) {
      const zip = extractZip(r.address);
      expect(zip && seed.zipCentroids[zip], r.id).toBeTruthy();
    }
  });

  it("has a centroid for the demo ZIP, 95112", () => {
    expect(seed.zipCentroids["95112"]).toBeDefined();
  });

  it("never routes the 95112 refrigeration demo to an unpowered or full pharmacy", () => {
    const ranked = rankResources({
      needType: "refrigeration",
      origin: seed.zipCentroids["95112"]!,
      resources: seed.resources,
      now: NOON_PT,
    });
    expect(ranked.length).toBeGreaterThan(0);
    for (const m of ranked) {
      expect(m.resource.hasPower).toBe(true);
      expect(m.resource.capacity).toBeGreaterThan(0);
    }
    expect(ranked.map((m) => m.resource.id)).not.toContain("ph-03"); // unpowered
    expect(ranked.map((m) => m.resource.id)).not.toContain("ph-07"); // full
  });

  it("uses only fictional 555-01xx placeholder numbers in the committed residents file", () => {
    if (seed.residentsSource === "demo_residents.json") {
      for (const r of seed.residents) expect(r.handle).toMatch(/^\+1555555/);
    }
  });
});
