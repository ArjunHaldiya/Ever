import { describe, expect, it } from "vitest";
import {
  CONVERSATION_TTL_MS,
  extractNeedByRules,
  processMessage,
  zipGeocoder,
  type ConversationState,
  type PipelineDeps,
  type ProcessingMode,
} from "../src";
import { makeResource, NOON_PT } from "./fixtures";

const centroids = { "95112": { lat: 37.3492, lng: -121.8943 } };
let nextId = 0;

function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    resources: [makeResource({ id: "ph", name: "Demo Pharmacy" })],
    geocode: zipGeocoder(centroids),
    newNeedId: () => `need-${++nextId}`,
    now: NOON_PT,
    ...overrides,
  };
}

function run(
  text: string,
  opts: { mode?: ProcessingMode; conversation?: ConversationState | null; deps?: Partial<PipelineDeps> } = {},
) {
  return processMessage(
    {
      text,
      extracted: extractNeedByRules(text),
      mode: opts.mode ?? "ai",
      conversation: opts.conversation ?? null,
    },
    deps(opts.deps),
  );
}

describe("routing", () => {
  it("routes a located request to the nearest open, powered resource", async () => {
    const r = await run("my insulin needs to stay cold, 95112");
    expect(r.match?.resource.id).toBe("ph");
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]).toContain("Demo Pharmacy");
    expect(r.replies[0]).toContain("Chosen:");
    expect(r.need).toMatchObject({ status: "routed", resourceId: "ph", zip: "95112", mode: "ai" });
    expect(r.conversation).toBeNull();
  });

  it("says so when nothing is open and powered, without marking the need failed", async () => {
    const r = await run("my insulin needs to stay cold, 95112", {
      deps: { resources: [makeResource({ hasPower: false })] },
    });
    expect(r.match).toBeNull();
    expect(r.replies[0]).toContain("couldn't find an open place");
    expect(r.need.status).toBe("new");
    expect(r.need.resourceId).toBeNull();
  });

  it("announces backup mode in degraded mode (FR-9)", async () => {
    const r = await run("need a pharmacy 95112", { mode: "degraded" });
    expect(r.replies[0]).toContain("Running in backup mode");
    expect(r.need.mode).toBe("degraded");
  });
});

describe("emergencies (FR-2)", () => {
  it("sends the 911 line first, then continues the normal flow", async () => {
    const r = await run("I can't breathe, my oxygen machine has no power, 95112", {
      deps: { resources: [makeResource({ id: "cc", name: "Demo Center", supports: ["device_power"] })] },
    });
    expect(r.replies[0]).toContain("911");
    expect(r.replies).toHaveLength(2);
    expect(r.replies[1]).toContain("Go to:");
    expect(r.need.emergency).toBe(true);
  });

  it("sends only the 911 line when there is nothing else to act on", async () => {
    const r = await run("I can't breathe");
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]).toContain("911");
  });

  it("catches emergencies an LLM extractor missed", async () => {
    const text = "he is not breathing";
    const r = await processMessage(
      { text, extracted: { ...extractNeedByRules("hello"), emergency: false }, mode: "ai", conversation: null },
      deps(),
    );
    expect(r.replies[0]).toContain("911");
  });
});

describe("missing location (FR-4)", () => {
  it("asks once and holds state", async () => {
    const r = await run("I need food");
    expect(r.replies).toEqual(["What's your ZIP or nearest cross streets?"]);
    expect(r.need.status).toBe("awaiting_location");
    expect(r.need.latRounded).toBeNull();
    expect(r.conversation).toMatchObject({ needId: r.need.id });
  });

  it("routes the held need when the answer arrives, keeping the same need id", async () => {
    const first = await run("need a pharmacy");
    const second = await run("95112", { conversation: first.conversation });
    expect(second.need.id).toBe(first.need.id);
    expect(second.need.needType).toBe("pharmacy");
    expect(second.replies[0]).toContain("Demo Pharmacy");
    expect(second.conversation).toBeNull();
  });

  it("does not repeat the question when the answer has no usable location", async () => {
    const first = await run("need a pharmacy");
    const second = await run("hello?", { conversation: first.conversation });
    expect(second.replies[0]).toContain("5-digit ZIP");
    expect(second.replies[0]).not.toContain("nearest cross streets");
    expect(second.conversation).toMatchObject({ needId: first.need.id, startedAt: first.conversation?.startedAt });
  });

  it("treats a location it cannot geocode as not found", async () => {
    const r = await run("need a pharmacy at 123 Main St");
    expect(r.replies[0]).toContain("couldn't find that location");
    expect(r.need.status).toBe("awaiting_location");
  });

  it("treats a geocoder error as not found", async () => {
    const r = await run("need a pharmacy 95112", {
      deps: { geocode: async () => { throw new Error("location service down"); } },
    });
    expect(r.replies[0]).toContain("couldn't find that location");
  });

  it("lets a fresh, confident request replace the pending question", async () => {
    const first = await run("need a pharmacy");
    const second = await run("actually I need food 95112", { conversation: first.conversation });
    expect(second.need.id).not.toBe(first.need.id);
    expect(second.need.needType).toBe("food");
  });

  it("ignores held state older than the TTL", async () => {
    const first = await run("need a pharmacy");
    const later = new Date(NOON_PT.getTime() + CONVERSATION_TTL_MS + 1000);
    const second = await run("95112", { conversation: first.conversation, deps: { now: later } });
    expect(second.need.id).not.toBe(first.need.id);
    // "95112" alone is not a need, so with the stale state dropped it gets the clarify prompt.
    expect(second.replies[0]).toContain("medicine, food, a cool place, or phone charging");
  });
});

describe("nothing actionable", () => {
  it("asks a clarifying question when confidence is low", async () => {
    const r = await run("hello there");
    expect(r.replies[0]).toContain("medicine, food, a cool place, or phone charging");
    expect(r.conversation).toBeNull();
  });
});

describe("privacy (FR-7)", () => {
  it("stores rounded coordinates and redacted text only", async () => {
    const r = await run("call me at 408-555-1234, need a pharmacy 95112");
    expect(r.need.latRounded).toBe(37.349);
    expect(r.need.lngRounded).toBe(-121.894);
    expect(r.need.redactedText).toContain("[PHONE]");
    expect(JSON.stringify(r.need)).not.toContain("555-1234");
  });

  it("keeps raw text out of held conversation state", async () => {
    const r = await run("call 408-555-1234, I need food");
    expect(r.conversation).not.toBeNull();
    expect(JSON.stringify(r.conversation)).not.toContain("555-1234");
  });
});
