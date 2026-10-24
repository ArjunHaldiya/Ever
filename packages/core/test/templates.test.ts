import { describe, expect, it } from "vitest";
import {
  ackText,
  askLocationText,
  BACKUP_MODE_NOTICE,
  bringFor,
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
