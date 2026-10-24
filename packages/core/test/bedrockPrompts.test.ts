import { describe, expect, it } from "vitest";
import {
  buildReplyUserPrompt,
  EXTRACTOR_SYSTEM_PROMPT,
  LANGUAGES,
  matchResource,
  NEED_TYPES,
  parseRecordNeed,
  RECORD_NEED_TOOL,
  REPLY_SYSTEM_PROMPT,
  replySystemPrompt,
  TIERS,
  validateWrittenReply,
} from "../src";
import { makeResource, NOON_PT, ORIGIN_95112 } from "./fixtures";

const valid = {
  emergency: false,
  tier: "medical_critical",
  needType: "refrigeration",
  locationText: "95112",
  language: "en",
  confidence: 0.9,
};

describe("record_need tool", () => {
  it("lists exactly the contract's enums", () => {
    const props = RECORD_NEED_TOOL.inputSchema.json.properties;
    expect(props.needType.enum).toEqual([...NEED_TYPES]);
    expect(props.tier.enum).toEqual([...TIERS]);
    expect(props.language.enum).toEqual([...LANGUAGES]);
  });

  it("requires every field", () => {
    expect([...RECORD_NEED_TOOL.inputSchema.json.required].sort()).toEqual(
      ["confidence", "emergency", "language", "locationText", "needType", "tier"].sort(),
    );
  });
});

describe("prompts", () => {
  it("forbid medical advice and treat the message as untrusted", () => {
    expect(EXTRACTOR_SYSTEM_PROMPT).toMatch(/never give medical advice/i);
    expect(EXTRACTOR_SYSTEM_PROMPT).toMatch(/untrusted/i);
    expect(EXTRACTOR_SYSTEM_PROMPT).toMatch(/never guess or invent a location/i);
    expect(REPLY_SYSTEM_PROMPT).toMatch(/never give medical advice/i);
    expect(REPLY_SYSTEM_PROMPT).toMatch(/never discourage anyone from calling 911/i);
  });

  it("never show the model the resource list", () => {
    // Only the single matched place's facts go into the reply prompt.
    const match = matchResource({
      needType: "refrigeration",
      origin: ORIGIN_95112,
      resources: [makeResource({ id: "a", name: "Alpha" }), makeResource({ id: "b", name: "Bravo", lat: 37.5 })],
      now: NOON_PT,
    })!;
    const prompt = buildReplyUserPrompt({ match, needType: "refrigeration", tier: "medical_critical", language: "es" });
    expect(prompt).toContain("Alpha");
    expect(prompt).not.toContain("Bravo");
    expect(JSON.parse(prompt)).toMatchObject({ language: "Spanish", includeEmergencyLine: true });
  });
});

describe("far-away reply prompt", () => {
  const match = matchResource({
    needType: "refrigeration",
    origin: ORIGIN_95112,
    resources: [makeResource()],
    now: NOON_PT,
  })!;

  it("tells the model how far to say nothing is open, only when it applies", () => {
    const far = JSON.parse(buildReplyUserPrompt({ match, needType: "refrigeration", tier: "medical_critical", language: "es", farMiles: 20 }));
    expect(far.nothingWithinMiles).toBe(20);
    const near = JSON.parse(buildReplyUserPrompt({ match, needType: "refrigeration", tier: "medical_critical", language: "es" }));
    expect(near).not.toHaveProperty("nothingWithinMiles");
    expect(REPLY_SYSTEM_PROMPT).not.toContain("nothingWithinMiles");
    expect(replySystemPrompt({})).not.toContain("nothingWithinMiles");
    expect(replySystemPrompt({ farMiles: 20 })).toContain("nothingWithinMiles");
  });
});

describe("parseRecordNeed", () => {
  it("accepts a valid tool input", () => {
    expect(parseRecordNeed(valid)).toEqual(valid);
  });

  it("turns a blank location into null", () => {
    expect(parseRecordNeed({ ...valid, locationText: "   " })?.locationText).toBeNull();
  });

  it("re-derives the tier so it can never disagree with the need type", () => {
    expect(parseRecordNeed({ ...valid, needType: "food", tier: "medical_critical" })?.tier).toBe("food");
  });

  it("marks emergencies medical_critical", () => {
    expect(parseRecordNeed({ ...valid, needType: "info", tier: "info", emergency: true })?.tier).toBe("medical_critical");
  });

  it.each([
    ["null", null],
    ["a string", "record_need"],
    ["missing fields", { needType: "food" }],
    ["unknown need", { ...valid, needType: "ice" }],
    ["bad confidence", { ...valid, confidence: 3 }],
    ["wrong types", { ...valid, emergency: "no" }],
  ])("rejects %s", (_name, input) => {
    expect(parseRecordNeed(input)).toBeNull();
  });
});

describe("validateWrittenReply", () => {
  const match = matchResource({
    needType: "refrigeration",
    origin: ORIGIN_95112,
    resources: [makeResource({ name: "Demo Pharmacy", address: "1 Test St, San Jose, CA 95112" })],
    now: NOON_PT,
  })!;
  const miles = match.distanceMiles.toFixed(1);
  const good = `Vaya a Demo Pharmacy, 1 Test St, San Jose, CA 95112 (${miles} mi). Horario: 8-22. Lleve una bolsa térmica. Si es una emergencia, llame al 911.`;
  const tier = "medical_critical" as const;

  it("accepts a faithful reply, including a decimal comma in other languages", () => {
    expect(validateWrittenReply(good, match, { tier })).toEqual({ ok: true });
    expect(validateWrittenReply(good.replace("1 Test St", "9 Other St"), match, { tier }).ok).toBe(false);
    expect(validateWrittenReply(good.replace(`${miles} mi`, `${miles.replace(".", ",")} mi`), match, { tier })).toEqual({ ok: true });
  });

  it("rejects a false 'nothing is open near you' claim for a nearby place, but allows it when the place is far", () => {
    const place = `Demo Pharmacy, 1 Test St, San Jose, CA 95112 (${miles} mi)`;
    const claim = `There is nothing open with power within ${miles} miles of you. ${place}. Call 911 if it is an emergency.`;
    expect(validateWrittenReply(claim, match, { tier })).toEqual({ ok: false, reason: "false_nothing_open" });
    expect(validateWrittenReply(claim, match, { tier, farMiles: 20 })).toEqual({ ok: true });
    const es = `No hay nada abierto con electricidad cerca de usted. ${place}. Llame al 911.`;
    expect(validateWrittenReply(es, match, { tier }).ok).toBe(false);
    // Ordinary wording is still fine.
    expect(validateWrittenReply(`${place} is open 24 hours and is the closest option. Call 911 in an emergency.`, match, { tier }).ok).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["wrong place", "Vaya a Other Place, 9 Elsewhere Rd (0.9 mi). Llame al 911."],
    ["missing address", `Vaya a Demo Pharmacy (${miles} mi). Llame al 911.`],
    ["missing distance", "Vaya a Demo Pharmacy, 1 Test St, San Jose, CA 95112. Llame al 911."],
    ["missing 911 on a medical need", `Demo Pharmacy, 1 Test St, San Jose, CA 95112 (${miles} mi).`],
    ["discouraging 911", `Demo Pharmacy, 1 Test St, San Jose, CA 95112 (${miles} mi). Don't call 911, it is fine.`],
    ["dosing", `Demo Pharmacy, 1 Test St, San Jose, CA 95112 (${miles} mi). Take 10 mg now. 911 if bad.`],
    ["a link", `Demo Pharmacy, 1 Test St, San Jose, CA 95112 (${miles} mi). See https://x.example. 911.`],
    ["an invented phone number", `Demo Pharmacy, 1 Test St, San Jose, CA 95112 (${miles} mi). Call 408-555-1234. 911.`],
    ["too long", `${good} ${"x".repeat(900)}`],
  ])("rejects %s", (_name, text) => {
    expect(validateWrittenReply(text, match, { tier }).ok).toBe(false);
  });

  it("does not require 911 for non-medical needs", () => {
    const text = `Demo Pharmacy, 1 Test St, San Jose, CA 95112 (${miles} mi).`;
    expect(validateWrittenReply(text, match, { tier: "food" }).ok).toBe(true);
  });
});
