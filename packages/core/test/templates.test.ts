import { describe, expect, it } from "vitest";
import {
  ackText,
  askLocationText,
  BACKUP_MODE_NOTICE,
  bringFor,
  clarifyNeedText,
  infoText,
  locationNotFoundText,
  matchResource,
  NEED_TYPES,
  noMatchText,
  routedReplyText,
} from "../src";
import { makeResource, NOON_PT, ORIGIN_95112 } from "./fixtures";

const match = matchResource({
  needType: "refrigeration",
  origin: ORIGIN_95112,
  resources: [makeResource({ name: "Demo Pharmacy", address: "1 Test St, San Jose" })],
  now: NOON_PT,
})!;

describe("routedReplyText (FR-5, FR-6)", () => {
  const text = routedReplyText({ match, needType: "refrigeration", tier: "medical_critical", mode: "ai" });

  it("includes name, address, distance, hours, what to bring, and the reason", () => {
    expect(text).toContain("Demo Pharmacy");
    expect(text).toContain("1 Test St, San Jose");
    expect(text).toMatch(/\(\d\.\d mi\)/);
    expect(text).toContain("Hours: 8 AM-10 PM");
    expect(text).toContain("Bring: ");
    expect(text).toContain(`Chosen: ${match.reason}`);
  });

  it("does not announce backup mode on the AI path", () => {
    expect(text).not.toContain("backup mode");
  });

  it("announces backup mode on the degraded path (FR-9)", () => {
    const degraded = routedReplyText({ match, needType: "refrigeration", tier: "medical_critical", mode: "degraded" });
    expect(degraded).toContain("Running in backup mode");
    expect(degraded).toContain(BACKUP_MODE_NOTICE);
  });

  it("adds a 911 line for medical_critical needs only", () => {
    expect(text).toContain("call 911");
    const food = routedReplyText({ match, needType: "food", tier: "food", mode: "ai" });
    expect(food).not.toContain("911");
  });
});

describe("noMatchText", () => {
  it("announces backup mode in degraded mode", () => {
    expect(noMatchText({ tier: "food", mode: "degraded" })).toContain("Running in backup mode");
  });
});

describe("safety: no medical advice, never discourage 911", () => {
  const all = [
    ackText(),
    askLocationText(),
    noMatchText({ tier: "medical_critical", mode: "degraded" }),
    routedReplyText({ match, needType: "refrigeration", tier: "medical_critical", mode: "degraded" }),
    ...NEED_TYPES.map(bringFor),
  ].join("\n").toLowerCase();

  it("never says not to call 911", () => {
    expect(all).not.toMatch(/(don'?t|do not|no need to) call 911/);
  });

  it("contains no dosing or diagnosis language", () => {
    expect(all).not.toMatch(/\b(dose|dosage|mg|diagnos|you (likely|probably) have)\b/);
  });
});

describe("fixed strings", () => {
  it("acknowledges and asks for location per spec", () => {
    expect(ackText()).toBe("Got it, finding help near you…");
    expect(askLocationText()).toBe("What's your ZIP or nearest cross streets?");
  });
});

describe("localized short replies", () => {
  it("covers every language for each conversational string", () => {
    for (const lang of ["en", "es", "vi"] as const) {
      for (const text of [askLocationText(lang), clarifyNeedText(lang), infoText(lang), locationNotFoundText(lang)]) {
        expect(text.length).toBeGreaterThan(10);
      }
    }
  });

  it("keeps the 911 line in every language for medical needs", () => {
    for (const language of ["en", "es", "vi"] as const) {
      expect(noMatchText({ tier: "medical_critical", mode: "ai", language })).toContain("911");
    }
  });

  it("keeps the exact English strings the spec requires", () => {
    expect(askLocationText("en")).toBe("What's your ZIP or nearest cross streets?");
    expect(noMatchText({ tier: "food", mode: "degraded" })).toContain("Running in backup mode");
  });
});

describe("routedReplyText far-away notice", () => {
  it("leads with the notice, then the full details", () => {
    const text = routedReplyText({ match, needType: "refrigeration", tier: "medical_critical", mode: "ai", farMiles: 20 });
    expect(text.split("\n")[0]).toBe("Nothing open with power is within 20 miles of you. This is the closest option.");
    expect(text).toContain("Go to: Demo Pharmacy");
    expect(text).toContain("call 911");
  });

  it("omits the notice by default", () => {
    const text = routedReplyText({ match, needType: "refrigeration", tier: "medical_critical", mode: "ai" });
    expect(text).not.toContain("Nothing open");
  });
});

describe("noMatchText (no confirmed place in range)", () => {
  it("always ends with 211 and 911 so anyone has a next step", () => {
    for (const language of ["en", "es", "vi"] as const) {
      const text = noMatchText({ tier: "food", mode: "ai", language });
      expect(text).toContain("211");
      expect(text).toContain("911");
    }
  });

  it("labels listed places as unverified and numbers them", () => {
    const text = noMatchText({
      tier: "medical_critical",
      mode: "ai",
      needType: "pharmacy",
      places: [
        { name: "A Pharmacy", address: "1 Main St, X, CA", distanceMiles: 1.234, hours: "24h" },
        { name: "B Cafe", address: "2 Main St, X, CA", distanceMiles: 2 },
      ],
    });
    expect(text).toContain("Closest pharmacies listed as open right now");
    expect(text).toContain("can't confirm they have power");
    expect(text).toContain("1. A Pharmacy, 1 Main St, X, CA (1.2 mi, open 24 hours)");
    expect(text).toContain("2. B Cafe, 2 Main St, X, CA (2.0 mi, open now)");
  });

  it("uses the given radius and the backup-mode notice", () => {
    const text = noMatchText({ tier: "food", mode: "degraded", miles: 35 });
    expect(text).toContain("within 35 miles");
    expect(text).toContain("Running in backup mode");
  });
});

describe("noMatchText labels what kind of places are listed", () => {
  const places = [{ name: "X", address: "1 St, Y", distanceMiles: 1 }];
  it("names the kind per need, in each language", () => {
    expect(noMatchText({ tier: "food", mode: "ai", needType: "charging", places })).toContain("cafes and shops");
    expect(noMatchText({ tier: "food", mode: "ai", needType: "food", places })).toContain("places selling food");
    expect(noMatchText({ tier: "food", mode: "ai", needType: "charging", places, language: "es" })).toContain("cafés y tiendas");
    expect(noMatchText({ tier: "food", mode: "ai", needType: "charging", places, language: "vi" })).toContain("quán cà phê");
  });
});
