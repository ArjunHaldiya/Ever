import { describe, expect, it } from "vitest";
import { ExtractedNeedSchema, extractLocationText, extractNeedByRules } from "../src";

describe("extractNeedByRules: need type and tier", () => {
  it.each([
    ["my insulin needs to stay cold, I'm at 95112", "refrigeration", "medical_critical"],
    ["need a fridge for my medication", "refrigeration", "medical_critical"],
    ["my oxygen concentrator has no power", "device_power", "medical_critical"],
    ["CPAP won't run without electricity", "device_power", "medical_critical"],
    ["I need a pharmacy to refill my prescription", "pharmacy", "medical_critical"],
    ["we are hungry and have no food", "food", "food"],
    ["it is too hot in my apartment", "cooling", "shelter_cooling"],
    ["my phone died, need to charge it", "charging", "shelter_cooling"],
    ["hello", "info", "info"],
  ] as const)("%j -> %s / %s", (text, needType, tier) => {
    const out = extractNeedByRules(text);
    expect(out.needType).toBe(needType);
    expect(out.tier).toBe(tier);
  });

  it("prefers the medical need when scores tie", () => {
    // "charge" (charging, 3) vs "oxygen" (device_power, 3)
    expect(extractNeedByRules("need to charge my oxygen machine").needType).toBe("device_power");
  });

  it("treats insulin + refill as a pharmacy need, insulin alone as refrigeration", () => {
    expect(extractNeedByRules("I need an insulin refill").needType).toBe("pharmacy");
    expect(extractNeedByRules("my insulin").needType).toBe("refrigeration");
  });

  it("understands Spanish and Vietnamese keywords", () => {
    const es = extractNeedByRules("necesito comida, tengo hambre");
    expect(es.needType).toBe("food");
    expect(es.language).toBe("es");
    const vi = extractNeedByRules("tôi cần thuốc");
    expect(vi.needType).toBe("pharmacy");
    expect(vi.language).toBe("vi");
  });

  it("defaults to English", () => {
    expect(extractNeedByRules("need food").language).toBe("en");
  });
});

describe("extractNeedByRules: emergency and confidence", () => {
  it("sets emergency and medical_critical tier regardless of need type", () => {
    const out = extractNeedByRules("I can't breathe and I'm hungry");
    expect(out.emergency).toBe(true);
    expect(out.tier).toBe("medical_critical");
  });

  it("is not an emergency for ordinary requests", () => {
    expect(extractNeedByRules("need food near 95112").emergency).toBe(false);
  });

  it("has low confidence (< 0.5) when nothing matches", () => {
    expect(extractNeedByRules("hello there").confidence).toBeLessThan(0.5);
  });

  it("has confidence >= 0.5 when a need is recognized", () => {
    expect(extractNeedByRules("I need a pharmacy").confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("always satisfies the ExtractedNeed contract", () => {
    for (const text of ["", "   ", "asdf qwerty", "I can't breathe", "hot 95112", "🔥🔥"]) {
      expect(() => ExtractedNeedSchema.parse(extractNeedByRules(text))).not.toThrow();
    }
  });
});

describe("extractLocationText", () => {
  it("prefers a ZIP", () => {
    expect(extractLocationText("I'm in 95112, need food")).toBe("95112");
    expect(extractLocationText("zip 95112-1234")).toBe("95112");
  });

  it("finds a street address", () => {
    expect(extractLocationText("I'm at 123 Main St and need food")).toBe("123 Main St");
  });

  it("finds cross streets", () => {
    expect(extractLocationText("corner of Story Rd and King Rd please")).toBe(
      "Story Rd and King Rd",
    );
  });

  it("finds a 'near X' place", () => {
    expect(extractLocationText("need ice near Santa Clara and 1st.")).toBe("Santa Clara and 1st");
  });

  it("returns null when there is no location", () => {
    expect(extractLocationText("I need insulin kept cold")).toBeNull();
    expect(extractLocationText("I'm at home")).toBeNull();
    expect(extractLocationText("near me")).toBeNull();
  });

  it("is carried through extractNeedByRules", () => {
    expect(extractNeedByRules("need food 95112").locationText).toBe("95112");
    expect(extractNeedByRules("need food").locationText).toBeNull();
  });
});
