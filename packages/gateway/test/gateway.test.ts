import { beforeAll, describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "@ever/core";
import { handleInboundText, type InboundEvent } from "../src/inbound";
import { drainOutboundOnce, type QueuedMessage } from "../src/outbound";

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

const NOW = new Date("2026-10-23T19:00:00Z");
const noSleep = async () => undefined;

function event(over: Partial<InboundEvent> = {}, replies: string[] = []): InboundEvent {
  return {
    messageId: "m1",
    sender: "+14085550123",
    text: "I need food, 95112",
    receivedAt: NOW,
    reply: async (t) => void replies.push(t),
    ...over,
  };
}

function inboundDeps(over: Partial<Parameters<typeof handleInboundText>[0]> = {}) {
  const claimed = new Set<string>();
  const queued: InboundMessage[] = [];
  return {
    claimed,
    queued,
    deps: {
      claim: async (k: string) => (claimed.has(k) ? false : (claimed.add(k), true)),
      release: async (k: string) => void claimed.delete(k),
      enqueue: async (m: InboundMessage) => void queued.push(m),
      sleep: noSleep,
      ...over,
    },
  };
}

describe("inbound: verify, dedupe, enqueue, acknowledge", () => {
  it("enqueues a validated message, then acknowledges", async () => {
    const replies: string[] = [];
    const { deps, queued } = inboundDeps();
    expect(await handleInboundText(deps, event({}, replies))).toBe("enqueued");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ messageId: "m1", provider: "photon", text: "I need food, 95112" });
    expect(replies).toEqual(["Got it, finding help near you…"]);
  });

  it("queues a STOP but does not send the 'finding help' acknowledgement", async () => {
    const replies: string[] = [];
    const { deps, queued } = inboundDeps();
    expect(await handleInboundText(deps, event({ text: "STOP" }, replies))).toBe("enqueued");
    expect(queued).toHaveLength(1);
    expect(replies).toEqual([]);
  });

  it("skips a duplicate message id (FR-13) without acknowledging twice", async () => {
    const replies: string[] = [];
    const { deps, queued } = inboundDeps();
    await handleInboundText(deps, event({}, replies));
    expect(await handleInboundText(deps, event({}, replies))).toBe("duplicate");
    expect(queued).toHaveLength(1);
    expect(replies).toHaveLength(1);
  });

  it("ignores empty messages", async () => {
    const { deps, queued } = inboundDeps();
    expect(await handleInboundText(deps, event({ text: "   " }))).toBe("empty");
    expect(queued).toHaveLength(0);
  });

  it("retries a failed enqueue and still acknowledges once it succeeds", async () => {
    const replies: string[] = [];
    let calls = 0;
    const { deps, queued } = inboundDeps({
      enqueue: async (m) => {
        calls += 1;
        if (calls < 3) throw new Error("SQS throttled");
        queued.push(m);
      },
    });
    expect(await handleInboundText(deps, event({}, replies))).toBe("enqueued");
    expect(calls).toBe(3);
    expect(replies).toEqual(["Got it, finding help near you…"]);
  });

  it("when the queue stays down, frees the claim and asks the person to resend", async () => {
    const replies: string[] = [];
    const { deps, claimed } = inboundDeps({
      enqueue: async () => {
        throw new Error("SQS down");
      },
    });
    expect(await handleInboundText(deps, event({}, replies))).toBe("failed");
    expect(claimed.has("in:m1")).toBe(false);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("send your message again");
  });

  it("does not lose a queued message when the acknowledgement fails", async () => {
    const { deps, queued } = inboundDeps();
    const out = await handleInboundText(
      deps,
      event({
        reply: async () => {
          throw new Error("Photon send failed");
        },
      }),
    );
    expect(out).toBe("enqueued");
    expect(queued).toHaveLength(1);
  });
});

describe("outbound: send queued replies", () => {
  const body = (over = {}) =>
    JSON.stringify({ to: "+14085550123", texts: ["Call 911 now.", "Go to: Demo"], kind: "reply", needId: "n1", ...over });

  function queue(items: QueuedMessage[]) {
    const removed: string[] = [];
    return {
      removed,
      q: {
        receive: async () => items,
        remove: async (r: string) => void removed.push(r),
      },
    };
  }

  it("sends every text in order, then deletes the queue message", async () => {
    const sent: [string, string[]][] = [];
    const { q, removed } = queue([{ body: body(), receipt: "r1" }]);
    const n = await drainOutboundOnce(q, { sendTexts: async (to, texts) => (sent.push([to, texts]), { messageIds: [] }) });
    expect(n).toBe(1);
    expect(sent).toEqual([["+14085550123", ["Call 911 now.", "Go to: Demo"]]]);
    expect(removed).toEqual(["r1"]);
  });

  it("leaves a message in the queue when sending fails, so SQS retries then dead-letters it", async () => {
    const { q, removed } = queue([{ body: body(), receipt: "r1" }]);
    const n = await drainOutboundOnce(q, {
      sendTexts: async () => {
        throw new Error("Photon unavailable");
      },
    });
    expect(n).toBe(0);
    expect(removed).toEqual([]);
  });

  it("keeps going past a malformed message", async () => {
    const sent: string[] = [];
    const { q, removed } = queue([
      { body: "not json", receipt: "bad" },
      { body: body(), receipt: "good" },
    ]);
    const n = await drainOutboundOnce(q, { sendTexts: async (to) => (sent.push(to), { messageIds: [] }) });
    expect(n).toBe(1);
    expect(removed).toEqual(["good"]);
  });

  it("rejects messages missing required fields", async () => {
    const { q, removed } = queue([{ body: JSON.stringify({ to: "x", texts: [], kind: "reply" }), receipt: "r" }]);
    expect(await drainOutboundOnce(q, { sendTexts: async () => ({ messageIds: [] }) })).toBe(0);
    expect(removed).toEqual([]);
  });
});
