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
    expect(r.need).toMatchObject({ status: "routed", mode: "ai" });
    expect(r.conversation).toBeNull();
  });

  it("says so when nothing is open and powered, without marking the need failed", async () => {
    const r = await run("my insulin needs to stay cold, 95112", {
      deps: { resources: [makeResource({ hasPower: false })] },
    });
    expect(r.match).toBeNull();
    expect(r.replies[0]).toContain("don't have a confirmed open place");
    expect(r.replies[0]).toContain("call 211");
    expect(r.need.status).toBe("new");
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
  it("stores no location, ZIP, place, distance or message text in the need", async () => {
    const r = await run("call me at 408-555-1234, need a pharmacy 95112");
    const keys = Object.keys(r.need);
    for (const gone of ["latRounded", "lngRounded", "zip", "redactedText", "resourceId", "distanceMiles"]) {
      expect(keys).not.toContain(gone);
    }
    const stored = JSON.stringify(r.need);
    expect(stored).not.toContain("555-1234");
    expect(stored).not.toContain("95112");
  });

  it("keeps message text and the mentioned place out of held conversation state", async () => {
    const r = await run("call 408-555-1234, I need food near Main St");
    expect(r.conversation).not.toBeNull();
    expect(JSON.stringify(r.conversation)).not.toContain("555-1234");
    expect(r.conversation!.extracted.locationText).toBeNull();
    expect(Object.keys(r.conversation!)).not.toContain("redactedText");
  });
});

describe("extraction metadata and language", () => {
  const bedrockMeta = { extractor: "bedrock", modelId: "test-model", latencyMs: 812, fallbackReason: null } as const;

  it("records which extractor, model and latency produced the need", async () => {
    const text = "need a pharmacy 95112";
    const r = await processMessage(
      { text, extracted: extractNeedByRules(text), extraction: bedrockMeta, mode: "ai", conversation: null },
      deps(),
    );
    expect(r.need).toMatchObject({ extractor: "bedrock", modelId: "test-model", latencyMs: 812, fallbackReason: null });
  });

  it("defaults to the rules extractor when none is given", async () => {
    const r = await run("need a pharmacy 95112");
    expect(r.need).toMatchObject({ extractor: "rules", modelId: null, fallbackReason: null });
  });

  it("keeps the original extraction metadata when a held need is completed", async () => {
    const text = "need a pharmacy";
    const first = await processMessage(
      { text, extracted: extractNeedByRules(text), extraction: bedrockMeta, mode: "ai", conversation: null },
      deps(),
    );
    const second = await run("95112", { conversation: first.conversation });
    expect(second.need).toMatchObject({ extractor: "bedrock", modelId: "test-model", latencyMs: 812 });
  });

  it("asks for the location in the person's language", async () => {
    const es = await run("necesito comida");
    expect(es.replies[0]).toContain("código postal");
    const vi = await run("tôi cần thức ăn");
    expect(vi.replies[0]).toContain("Mã ZIP");
  });

  it("localizes the 'nothing found' reply and backup notice", async () => {
    const r = await run("necesito una farmacia 95112", {
      mode: "degraded",
      deps: { resources: [makeResource({ hasPower: false })] },
    });
    expect(r.replies[0]).toContain("llame al 911");
    expect(r.replies[0]).toContain("modo de respaldo");
  });
});

describe("far-away results", () => {
  // Dublin, CA is roughly 26 miles from the San Jose fixture resource.
  const dublin = { "94568": { lat: 37.7, lng: -121.93 } };

  it("still names the closest open place, but says plainly that it is far", async () => {
    const r = await run("I need a pharmacy 94568", { deps: { geocode: zipGeocoder(dublin) } });
    expect(r.match?.resource.id).toBe("ph");
    expect(r.farMiles).toBe(20);
    expect(r.replies[0]).toContain("Nothing open with power is within 20 miles of you");
    expect(r.replies[0]).toContain("Go to: Demo Pharmacy");
    expect(r.need).toMatchObject({ status: "routed" });
  });

  it("keeps the 911 line on a far medical answer", async () => {
    const r = await run("my insulin needs to stay cold 94568", { deps: { geocode: zipGeocoder(dublin) } });
    expect(r.replies[0]).toContain("call 911");
  });

  it("does not add the notice when the place is nearby", async () => {
    const r = await run("I need a pharmacy 95112");
    expect(r.farMiles).toBeNull();
    expect(r.replies[0]).not.toContain("Nothing open");
  });

  it("honors a custom threshold", async () => {
    const r = await run("I need a pharmacy 94568", { deps: { geocode: zipGeocoder(dublin), farMiles: 50 } });
    expect(r.farMiles).toBeNull();
    expect(r.replies[0]).not.toContain("Nothing open");
  });

  it("still says nothing was found when no place is open at all", async () => {
    const r = await run("I need a pharmacy 94568", {
      deps: { geocode: zipGeocoder(dublin), resources: [makeResource({ hasPower: false })] },
    });
    expect(r.match).toBeNull();
    expect(r.replies[0]).toContain("don't have a confirmed open place");
    expect(r.replies[0]).toContain("call 211");
  });
});

describe("anywhere in the US: unverified places and 211", () => {
  const dublin = { "94568": { lat: 37.7, lng: -121.93 } };
  const pharmacies = [
    { name: "Premier Pharmacy", address: "6543 Regional St, Dublin, CA, 94568", distanceMiles: 0.1, hours: "open" as const },
    { name: "CVS Pharmacy", address: "7201 Regional St, Dublin, CA, 94568", distanceMiles: 0.4, hours: "24h" as const },
  ];

  it("lists real nearby places, labelled unverified, with 211 and 911, when nothing confirmed is in range", async () => {
    const r = await run("I need a pharmacy 94568", {
      deps: { geocode: zipGeocoder(dublin), resources: [], findNearby: async () => pharmacies },
    });
    expect(r.areaFallback).toBe(true);
    const text = r.replies[0]!;
    expect(text).toContain("don't have a confirmed open place with power within 20 miles");
    expect(text).toContain("listed as open right now");
    expect(text).toContain("can't confirm they have power");
    expect(text).toContain("1. Premier Pharmacy, 6543 Regional St, Dublin, CA, 94568 (0.1 mi, open now)");
    expect(text).toContain("2. CVS Pharmacy");
    expect(text).toContain("call 211");
    expect(text).toContain("call 911");
    expect(r.need).toMatchObject({ status: "new", unverifiedShown: 2 });
  });

  it("shows the far confirmed option next to the closer unverified ones", async () => {
    const r = await run("I need a pharmacy 94568", {
      deps: { geocode: zipGeocoder(dublin), findNearby: async () => pharmacies },
    });
    expect(r.areaFallback).toBe(true);
    expect(r.replies[0]).toContain("Confirmed open with power, but farther away:");
    expect(r.replies[0]).toContain("Demo Pharmacy");
  });

  it("falls back to the far confirmed answer when no nearby places are found", async () => {
    const r = await run("I need a pharmacy 94568", {
      deps: { geocode: zipGeocoder(dublin), findNearby: async () => [] },
    });
    expect(r.areaFallback).toBe(false);
    expect(r.replies[0]).toContain("Nothing open with power is within 20 miles of you");
    expect(r.need.status).toBe("routed");
  });

  it("ignores a failing place search", async () => {
    const r = await run("I need a pharmacy 94568", {
      deps: {
        geocode: zipGeocoder(dublin),
        resources: [],
        findNearby: async () => {
          throw new Error("search down");
        },
      },
    });
    expect(r.replies[0]).toContain("call 211");
    expect(r.need.unverifiedShown).toBe(0);
  });

  it("never lists places for needs the place search can't answer, but still gives 211", async () => {
    let called = 0;
    const r = await run("I need food 94568", {
      deps: { geocode: zipGeocoder(dublin), resources: [], findNearby: async () => (called++, []) },
    });
    expect(r.replies[0]).toContain("call 211");
    expect(r.replies[0]).not.toMatch(/^1\. /m); // no numbered list of places
  });

  it("adds a utility note for medical-device power needs", async () => {
    const r = await run("my oxygen machine has no power 94568", {
      deps: { geocode: zipGeocoder(dublin), resources: [] },
    });
    expect(r.replies[0]).toContain("contact your electric utility");
  });

  it("answers in the person's language", async () => {
    const r = await run("necesito una farmacia 94568", {
      deps: { geocode: zipGeocoder(dublin), resources: [], findNearby: async () => pharmacies },
    });
    expect(r.replies[0]).toContain("No tengo un lugar abierto");
    expect(r.replies[0]).toContain("llame al 211");
    expect(r.replies[0]).toContain("farmacias");
    expect(r.replies[0]).toContain("abierto las 24 horas");
  });
});

describe("places too far away to be an answer", () => {
  // Austin, TX: the only confirmed place in the data is ~1,500 miles away.
  const austin = { "78701": { lat: 30.27, lng: -97.74 } };

  it("drops a confirmed place beyond MAX_USEFUL_MILES and gives real places plus 211 instead", async () => {
    const r = await run("I need a pharmacy 78701", {
      deps: {
        geocode: zipGeocoder(austin),
        findNearby: async () => [{ name: "CVS", address: "500 Congress Ave, Austin, TX", distanceMiles: 0.1 }],
      },
    });
    expect(r.match).toBeNull();
    expect(r.replies[0]).not.toContain("Demo Pharmacy");
    expect(r.replies[0]).not.toContain("Confirmed open");
    expect(r.replies[0]).toContain("1. CVS");
    expect(r.replies[0]).toContain("call 211");
  });

  it("points a far (but regional) confirmed answer to 211 as well", async () => {
    const dublin = { "94568": { lat: 37.7, lng: -121.93 } };
    const r = await run("I need a pharmacy 94568", { deps: { geocode: zipGeocoder(dublin) } });
    expect(r.replies[0]).toContain("Nothing open with power is within 20 miles");
    expect(r.replies[0]).toContain("call 211");
  });
});

describe("far confirmed option next to a list of nearby places", () => {
  const places = [{ name: "Cafe", address: "1 St, X", distanceMiles: 0.1, hours: "24h" as const }];
  const at = (miles: number) => ({ "99999": { lat: 37.3382 + miles / 69, lng: -121.8863 } }); // due north of the fixture pharmacy

  it("shows it when it is within 30 miles", async () => {
    const r = await run("I need a pharmacy 99999", { deps: { geocode: zipGeocoder(at(25)), findNearby: async () => places } });
    expect(r.replies[0]).toContain("Confirmed open with power, but farther away:");
  });

  it("leaves it out when it is much farther than the listed places", async () => {
    const r = await run("I need a pharmacy 99999", { deps: { geocode: zipGeocoder(at(45)), findNearby: async () => places } });
    expect(r.replies[0]).toContain("1. Cafe");
    expect(r.replies[0]).not.toContain("Confirmed open");
  });
});
