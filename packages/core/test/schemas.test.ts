import { describe, expect, it } from "vitest";
import {
  ChaosBodySchema,
  ExtractedNeedSchema,
  InboundMessageSchema,
  ResourceSchema,
  ShutoffBodySchema,
} from "../src";
import { makeResource } from "./fixtures";

const validNeed = {
  emergency: false,
  tier: "food",
  needType: "food",
  locationText: "95112",
  language: "en",
  confidence: 0.9,
};

describe("ExtractedNeedSchema", () => {
  it("accepts a valid need, including a null location", () => {
    expect(ExtractedNeedSchema.safeParse(validNeed).success).toBe(true);
    expect(ExtractedNeedSchema.safeParse({ ...validNeed, locationText: null }).success).toBe(true);
  });

  it.each([
    ["unknown tier", { tier: "urgent" }],
    ["unknown needType", { needType: "ice" }],
    ["unknown language", { language: "fr" }],
    ["confidence > 1", { confidence: 1.2 }],
    ["confidence < 0", { confidence: -0.1 }],
    ["string emergency", { emergency: "false" }],
  ])("rejects %s (LLM output must be validated)", (_name, patch) => {
    expect(ExtractedNeedSchema.safeParse({ ...validNeed, ...patch }).success).toBe(false);
  });

  it("rejects missing fields", () => {
    const { language: _language, ...rest } = validNeed;
    expect(ExtractedNeedSchema.safeParse(rest).success).toBe(false);
  });
});

describe("ResourceSchema", () => {
  it("accepts a valid resource and rejects bad hours / capacity / coords", () => {
    expect(ResourceSchema.safeParse(makeResource()).success).toBe(true);
    expect(ResourceSchema.safeParse(makeResource({ hours: "whenever" })).success).toBe(false);
    expect(ResourceSchema.safeParse(makeResource({ capacity: -1 })).success).toBe(false);
    expect(ResourceSchema.safeParse(makeResource({ lat: 123 })).success).toBe(false);
  });
});

describe("InboundMessageSchema", () => {
  it("requires id, sender, and an ISO timestamp", () => {
    const ok = {
      messageId: "m1",
      sender: "+14085551234",
      text: "hi",
      receivedAt: "2026-10-23T19:00:00.000Z",
      provider: "terminal",
    };
    expect(InboundMessageSchema.safeParse(ok).success).toBe(true);
    expect(InboundMessageSchema.safeParse({ ...ok, messageId: "" }).success).toBe(false);
    expect(InboundMessageSchema.safeParse({ ...ok, receivedAt: "yesterday" }).success).toBe(false);
  });
});

describe("API bodies", () => {
  it("validates the chaos toggle", () => {
    expect(ChaosBodySchema.safeParse({ mode: "degraded" }).success).toBe(true);
    expect(ChaosBodySchema.safeParse({ mode: "on" }).success).toBe(false);
  });

  it("validates the shutoff trigger", () => {
    expect(
      ShutoffBodySchema.safeParse({ zip: "95112", shutoffAt: "2026-10-24T02:00:00-07:00" }).success,
    ).toBe(true);
    expect(ShutoffBodySchema.safeParse({ zip: "9511", shutoffAt: "2026-10-24T02:00:00Z" }).success).toBe(false);
    expect(ShutoffBodySchema.safeParse({ zip: "95112", shutoffAt: "tonight" }).success).toBe(false);
  });
});
