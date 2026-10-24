import type { ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { zipGeocoder, type ConversationState, type InboundMessage, type OutboundMessage } from "@ever/core";
import { loadSeed } from "../../../seed/load";
import type { ConverseFn } from "../src/bedrock";
import { processInbound, type NeedRecord, type WorkerDeps } from "../src/process";

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

const seed = loadSeed();
const NOON_PT = new Date("2026-10-23T19:00:00Z");
const SENDER = "+14085550123"; // fictional

function msg(text: string, id = "m1"): InboundMessage {
  return { messageId: id, sender: SENDER, text, receivedAt: NOON_PT.toISOString(), provider: "test" };
}

function toolReply(input: unknown): ConverseCommandOutput {
  return {
    $metadata: {},
    output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "t", name: "record_need", input } }] } },
  } as unknown as ConverseCommandOutput;
}
function textReply(text: string): ConverseCommandOutput {
  return { $metadata: {}, output: { message: { role: "assistant", content: [{ text }] } } } as unknown as ConverseCommandOutput;
}

type Fake = {
  deps: WorkerDeps;
  claimed: Set<string>;
  needs: Map<string, NeedRecord>;
  conversations: Map<string, ConversationState>;
  outbound: OutboundMessage[];
  optedOut: string[];
};

function makeFake(overrides: Partial<WorkerDeps> = {}): Fake {
  const claimed = new Set<string>();
  const needs = new Map<string, NeedRecord>();
  const conversations = new Map<string, ConversationState>();
  const outbound: OutboundMessage[] = [];
  const optedOut: string[] = [];
  const deps: WorkerDeps = {
    now: () => NOON_PT,
    hashSender: (s) => `hash(${s})`,
    getAiMode: async () => "primary",
    getResources: async () => seed.resources,
    geocode: zipGeocoder(seed.zipCentroids),
    converse: null,
    modelId: "",
    store: {
      claim: async (k) => (claimed.has(k) ? false : (claimed.add(k), true)),
      release: async (k) => void claimed.delete(k),
      getConversation: async (h) => conversations.get(h) ?? null,
      putConversation: async (h, s) => void (s ? conversations.set(h, s) : conversations.delete(h)),
      putNeed: async (n) => void needs.set(n.id, n),
      optOutResident: async (h) => void optedOut.push(h),
    },
    sendOutbound: async (m) => void outbound.push(m),
    ...overrides,
  };
  return { deps, claimed, needs, conversations, outbound, optedOut };
}

const BEDROCK_NEED = {
  emergency: false,
  tier: "medical_critical",
  needType: "refrigeration",
  locationText: "95112",
  language: "es",
  confidence: 0.93,
};

describe("degraded path (no Bedrock configured)", () => {
  it("routes a request, queues one reply, and saves the need", async () => {
    const f = makeFake();
    const out = await processInbound(f.deps, msg("my insulin needs to stay cold, 95112"));
    expect(out).toMatchObject({ status: "processed", needStatus: "routed", mode: "degraded" });
    expect(f.outbound).toHaveLength(1);
    expect(f.outbound[0]).toMatchObject({ to: SENDER, kind: "reply" });
    expect(f.outbound[0]!.texts[0]).toContain("Go to:");
    expect(f.outbound[0]!.texts[0]).toContain("Running in backup mode");
    const need = [...f.needs.values()][0]!;
    expect(need).toMatchObject({ status: "routed", extractor: "rules", fallbackReason: "no_model", replyBy: "template" });
  });

  it("derives the need id from the message id so retries upsert the same row", async () => {
    const f = makeFake();
    await processInbound(f.deps, msg("need food 95112", "abc"));
    expect([...f.needs.keys()]).toEqual(["need_abc"]);
  });

  it("sends the 911 line first, in the same outbound message", async () => {
    const f = makeFake();
    await processInbound(f.deps, msg("I can't breathe, my oxygen has no power, 95112"));
    expect(f.outbound[0]!.texts[0]).toContain("911");
    expect(f.outbound[0]!.texts.length).toBeGreaterThan(1);
  });

  it("announces backup mode when the chaos flag is on, even with Bedrock available", async () => {
    const converse = vi.fn<ConverseFn>(async () => toolReply(BEDROCK_NEED));
    const f = makeFake({ getAiMode: async () => "degraded", converse, modelId: "m" });
    await processInbound(f.deps, msg("need food 95112"));
    expect(converse).not.toHaveBeenCalled();
    expect(f.outbound[0]!.texts.join("\n")).toContain("Running in backup mode");
    expect([...f.needs.values()][0]).toMatchObject({ fallbackReason: "chaos", extractor: "rules" });
  });
});

describe("AI path (Bedrock)", () => {
  it("uses Bedrock for extraction and for a validated, translated reply", async () => {
    let reply = "";
    const converse: ConverseFn = async (input) => {
      if (input.toolConfig) return toolReply(BEDROCK_NEED);
      return textReply(reply);
    };
    const f = makeFake({ converse, modelId: "test-model" });
    // Prepare a faithful Spanish reply for whichever place the matcher picks.
    const first = makeFake();
    await processInbound(first.deps, msg("insulin fridge 95112", "probe"));
    const probeText = first.outbound[0]!.texts[0]!;
    const place = seed.resources.find((r) => probeText.includes(r.name))!;
    const miles = /\((\d+\.\d) mi\)/.exec(probeText)![1];
    reply = `Vaya a ${place.name}, ${place.address} (${miles} mi). Lleve una bolsa térmica. Si es una emergencia, llame al 911.`;

    const out = await processInbound(f.deps, msg("mi insulina necesita refrigerador, 95112", "m2"));
    expect(out).toMatchObject({ status: "processed", mode: "ai", needStatus: "routed" });
    expect(f.outbound[0]!.texts.at(-1)).toBe(reply);
    expect(f.outbound[0]!.texts.join("\n")).not.toContain("backup mode");
    expect([...f.needs.values()][0]).toMatchObject({
      extractor: "bedrock",
      modelId: "test-model",
      replyBy: "bedrock",
      language: "es",
    });
  });

  it("falls back to the template when Bedrock's reply fails validation", async () => {
    const converse: ConverseFn = async (input) =>
      input.toolConfig ? toolReply(BEDROCK_NEED) : textReply("Vaya a otro lugar. No llame al 911.");
    const f = makeFake({ converse, modelId: "m" });
    await processInbound(f.deps, msg("necesito refrigerador 95112"));
    const need = [...f.needs.values()][0]!;
    expect(need.replyBy).toBe("template");
    expect(need.replyFallbackReason).toMatch(/^invalid_/);
    expect(f.outbound[0]!.texts.at(-1)).toContain("Go to:");
  });

  it("falls back to rules (degraded) when Bedrock errors", async () => {
    const converse: ConverseFn = async () => {
      throw new Error("ThrottlingException");
    };
    const f = makeFake({ converse, modelId: "m" });
    const out = await processInbound(f.deps, msg("need food 95112"));
    expect(out).toMatchObject({ mode: "degraded" });
    expect([...f.needs.values()][0]).toMatchObject({ extractor: "rules", fallbackReason: "error" });
  });
});

describe("missing location (FR-4)", () => {
  it("asks once, holds state, and completes the same need on the next message", async () => {
    const f = makeFake();
    await processInbound(f.deps, msg("I need food", "m1"));
    expect(f.outbound[0]!.texts[0]).toContain("ZIP");
    expect(f.conversations.size).toBe(1);
    const firstNeedId = [...f.needs.keys()][0];

    await processInbound(f.deps, msg("95112", "m2"));
    expect(f.outbound[1]!.texts[0]).toContain("Go to:");
    expect(f.conversations.size).toBe(0);
    expect(f.needs.get(firstNeedId!)).toMatchObject({ status: "routed" });
  });
});

describe("idempotency and retries (zero message loss)", () => {
  it("skips a message it has already processed", async () => {
    const f = makeFake();
    await processInbound(f.deps, msg("need food 95112", "dup"));
    const second = await processInbound(f.deps, msg("need food 95112", "dup"));
    expect(second).toEqual({ status: "duplicate" });
    expect(f.outbound).toHaveLength(1);
  });

  it("releases the claim and throws when the reply can't be queued, so SQS can retry", async () => {
    let fail = true;
    const f = makeFake({
      sendOutbound: async (m) => {
        if (fail) throw new Error("SQS unavailable");
        f.outbound.push(m);
      },
    });
    await expect(processInbound(f.deps, msg("I need food", "r1"))).rejects.toThrow("SQS unavailable");
    expect(f.claimed.has("wk:r1")).toBe(false);
    expect(f.conversations.size).toBe(0); // state is written last, so a retry starts from the original state

    fail = false;
    const retry = await processInbound(f.deps, msg("I need food", "r1"));
    expect(retry.status).toBe("processed");
    expect(f.outbound).toHaveLength(1);
    expect(f.needs.size).toBe(1); // same row, not a second need
  });
});

describe("STOP", () => {
  it("opts the sender out, clears any held question, confirms, and stores no need", async () => {
    const f = makeFake();
    await processInbound(f.deps, msg("I need food", "m1"));
    expect(f.conversations.size).toBe(1);
    const needsBefore = f.needs.size;

    const out = await processInbound(f.deps, msg("STOP", "m2"));
    expect(out).toEqual({ status: "stopped" });
    expect(f.optedOut).toEqual([`hash(${SENDER})`]);
    expect(f.conversations.size).toBe(0);
    expect(f.needs.size).toBe(needsBefore);
    const reply = f.outbound.at(-1)!;
    expect(reply).toMatchObject({ to: SENDER, kind: "reply" });
    expect(reply.texts[0]).toContain("unsubscribed");
  });

  it("never calls the model for a STOP", async () => {
    const converse = vi.fn();
    const f = makeFake({ converse: converse as unknown as ConverseFn, modelId: "test-model" });
    await processInbound(f.deps, msg("stop"));
    expect(converse).not.toHaveBeenCalled();
  });

  it("answers in Spanish to PARAR, and is safe to repeat", async () => {
    const f = makeFake();
    await processInbound(f.deps, msg("PARAR", "a"));
    await processInbound(f.deps, msg("PARAR", "b"));
    expect(f.optedOut).toHaveLength(2);
    expect(f.outbound[0]!.texts[0]).toContain("Se canceló");
  });

  it("treats a sentence that merely contains stop as a normal request", async () => {
    const f = makeFake();
    const out = await processInbound(f.deps, msg("where can I stop to charge my phone, 95112", "m9"));
    expect(out).toMatchObject({ status: "processed" });
    expect(f.optedOut).toHaveLength(0);
  });
});

describe("privacy (FR-7)", () => {
  it("never stores message text, phone number, location or ZIP in the need", async () => {
    const f = makeFake();
    await processInbound(f.deps, msg("call me at 408-555-0199, need a pharmacy 95112"));
    const stored = JSON.stringify([...f.needs.values()]);
    expect(stored).not.toContain("555-0199");
    expect(stored).not.toContain(SENDER);
    expect(stored).not.toContain("95112");
    for (const need of f.needs.values()) {
      for (const gone of ["latRounded", "lngRounded", "zip", "redactedText", "resourceId", "distanceMiles"]) {
        expect(Object.keys(need)).not.toContain(gone);
      }
    }
  });

  it("keys conversations by the hashed sender, not the phone number", async () => {
    const f = makeFake();
    await processInbound(f.deps, msg("I need food"));
    expect([...f.conversations.keys()][0]).toBe(`hash(${SENDER})`);
  });
});

describe("far-away request (Dublin ZIP, San Jose data)", () => {
  const dublin = { "94568": { lat: 37.7, lng: -121.93 } };

  it("names the closest open place, flags it as far, and records the distance", async () => {
    const f = makeFake({ geocode: zipGeocoder(dublin) });
    await processInbound(f.deps, msg("my insulin needs to stay cold, 94568"));
    const text = f.outbound[0]!.texts.join("\n");
    expect(text).toContain("Nothing open with power is within 20 miles of you");
    expect(text).toContain("Go to:");
    const need = [...f.needs.values()][0]!;
    expect(need.status).toBe("routed");
  });

  it("passes the far-away flag to the Bedrock reply writer", async () => {
    const prompts: string[] = [];
    const converse: ConverseFn = async (input) => {
      if (input.toolConfig) return toolReply({ ...BEDROCK_NEED, locationText: "94568", language: "en" });
      prompts.push(String(input.messages?.[0]?.content?.[0]?.text));
      return textReply("irrelevant");
    };
    const f = makeFake({ geocode: zipGeocoder(dublin), converse, modelId: "m" });
    await processInbound(f.deps, msg("my insulin needs to stay cold, 94568"));
    expect(JSON.parse(prompts[0]!).nothingWithinMiles).toBe(20);
  });
});

describe("area fallback in the worker", () => {
  const dublin = { "94568": { lat: 37.7, lng: -121.93 } };
  const places = [{ name: "Premier Pharmacy", address: "6543 Regional St, Dublin, CA, 94568", distanceMiles: 0.1 }];

  it("sends the unverified-places reply and does not ask Bedrock to rephrase it", async () => {
    const calls: string[] = [];
    const converse: ConverseFn = async (input) => {
      calls.push(input.toolConfig ? "extract" : "reply");
      return input.toolConfig ? toolReply({ ...BEDROCK_NEED, locationText: "94568", language: "en" }) : textReply("x");
    };
    const f = makeFake({
      geocode: zipGeocoder(dublin),
      getResources: async () => [],
      findNearby: async () => places,
      converse,
      modelId: "m",
    });
    await processInbound(f.deps, msg("my insulin needs to stay cold, 94568"));
    const text = f.outbound[0]!.texts.join("\n");
    expect(text).toContain("listed as open right now");
    expect(text).toContain("Premier Pharmacy");
    expect(text).toContain("call 211");
    expect(calls).toEqual(["extract"]); // template text, no Bedrock reply call
    expect([...f.needs.values()][0]).toMatchObject({ status: "new", unverifiedShown: 1, replyBy: "template" });
  });
});
