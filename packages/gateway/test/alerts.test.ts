import { beforeAll, describe, expect, it, vi } from "vitest";
import { onReadReceipt, onWarningSent, watchDelivery, type AlertKey, type AlertStore, type DeliveryInfo } from "../src/alerts";
import { drainOutboundOnce, type QueuedMessage } from "../src/outbound";

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

const KEY: AlertKey = { alertId: "alert_1", phoneHash: "h1" };
const T = new Date("2026-10-24T07:00:00Z");

/** In-memory AlertStore with the same "first observation wins" behavior as the real one. */
function fakeStore() {
  const row = { sentAt: null as Date | null, deliveredAt: null as Date | null, readAt: null as Date | null, messageId: null as string | null, error: null as string | null };
  const sent = new Map<string, AlertKey>();
  const store: AlertStore = {
    markSent: async (key, messageId, at) => {
      row.sentAt = at;
      row.messageId = messageId;
      row.error = null;
      sent.set(messageId, key);
    },
    markDelivered: async (_k, at) => void (row.deliveredAt ??= at),
    markRead: async (_k, at) => {
      row.readAt ??= at;
      row.deliveredAt ??= at;
    },
    markError: async (_k, e) => void (row.error = e),
    lookupSent: async (id) => sent.get(id) ?? null,
  };
  return { row, store, sent };
}

describe("sent", () => {
  it("records sentAt and the message id", async () => {
    const f = fakeStore();
    await onWarningSent(f.store, KEY, "msg-1", T);
    expect(f.row).toMatchObject({ sentAt: T, messageId: "msg-1", error: null });
  });

  it("flags an error when Photon returns no message id, since delivery and read can't be matched", async () => {
    const f = fakeStore();
    await onWarningSent(f.store, KEY, undefined, T);
    expect(f.row.sentAt).toBeNull();
    expect(f.row.error).toContain("without a message id");
  });
});

describe("read receipts", () => {
  it("marks a warning read, and delivered with it, matched by message id", async () => {
    const f = fakeStore();
    await onWarningSent(f.store, KEY, "msg-1", T);
    const read = new Date("2026-10-24T07:00:09Z");
    expect(await onReadReceipt(f.store, "msg-1", read)).toBe(true);
    expect(f.row.readAt).toEqual(read);
    expect(f.row.deliveredAt).toEqual(read);
  });

  it("ignores receipts for messages that were not warnings", async () => {
    const f = fakeStore();
    await onWarningSent(f.store, KEY, "msg-1", T);
    expect(await onReadReceipt(f.store, "some-reply-id", T)).toBe(false);
    expect(f.row.readAt).toBeNull();
  });

  it("keeps the first read time when a second receipt arrives", async () => {
    const f = fakeStore();
    await onWarningSent(f.store, KEY, "msg-1", T);
    const first = new Date("2026-10-24T07:00:09Z");
    await onReadReceipt(f.store, "msg-1", first);
    await onReadReceipt(f.store, "msg-1", new Date("2026-10-24T07:05:00Z"));
    expect(f.row.readAt).toEqual(first);
  });
});

describe("delivery watch", () => {
  const sleep = async () => undefined;

  it("marks delivered as soon as the message shows as delivered, then stops checking", async () => {
    const f = fakeStore();
    const checks: DeliveryInfo[] = [{ delivered: false }, { delivered: false }, { delivered: true, deliveredAt: new Date("2026-10-24T07:00:06Z") }, { delivered: true }];
    const check = vi.fn(async () => checks.shift()!);
    await watchDelivery({ store: f.store, key: KEY, messageId: "msg-1", check, sleep, delaysMs: [1, 2, 3, 4] });
    expect(check).toHaveBeenCalledTimes(3);
    expect(f.row.deliveredAt).toEqual(new Date("2026-10-24T07:00:06Z"));
  });

  it("also records a read time if the delivery check already shows one", async () => {
    const f = fakeStore();
    const readAt = new Date("2026-10-24T07:01:00Z");
    await watchDelivery({
      store: f.store,
      key: KEY,
      messageId: "msg-1",
      check: async () => ({ delivered: true, deliveredAt: T, readAt }),
      sleep,
      delaysMs: [1],
    });
    expect(f.row).toMatchObject({ deliveredAt: T, readAt });
  });

  it("gives up quietly when the message never shows as delivered", async () => {
    const f = fakeStore();
    const check = vi.fn(async () => ({ delivered: false }));
    await watchDelivery({ store: f.store, key: KEY, messageId: "m", check, sleep, delaysMs: [1, 2, 3] });
    expect(check).toHaveBeenCalledTimes(3);
    expect(f.row.deliveredAt).toBeNull();
  });

  it("survives a failing check and a missing message", async () => {
    const f = fakeStore();
    let n = 0;
    await watchDelivery({
      store: f.store,
      key: KEY,
      messageId: "m",
      check: async () => {
        n += 1;
        if (n === 1) throw new Error("Photon timeout");
        if (n === 2) return null;
        return { delivered: true, deliveredAt: T };
      },
      sleep,
      delaysMs: [1, 2, 3],
    });
    expect(f.row.deliveredAt).toEqual(T);
  });

  it("waits only the gaps between check times, not the total each time", async () => {
    const f = fakeStore();
    const waits: number[] = [];
    await watchDelivery({
      store: f.store, key: KEY, messageId: "m",
      check: async () => ({ delivered: false }),
      sleep: async (ms) => void waits.push(ms),
      delaysMs: [2000, 5000, 10000],
    });
    expect(waits).toEqual([2000, 3000, 5000]);
  });
});

describe("outbound warnings end to end", () => {
  const warning = (over = {}) =>
    JSON.stringify({ to: "+14085550101", texts: ["Heads up: planned shutoff"], kind: "warning", alertId: "alert_1", phoneHash: "h1", ...over });
  const queueOf = (items: QueuedMessage[]) => {
    const removed: string[] = [];
    return { removed, q: { receive: async () => items, remove: async (r: string) => void removed.push(r) } };
  };

  it("records sent and starts the delivery watch for a warning", async () => {
    const f = fakeStore();
    const watch = vi.fn(async () => undefined);
    const { q, removed } = queueOf([{ body: warning(), receipt: "r1" }]);
    const check = async () => ({ delivered: true });
    await drainOutboundOnce(q, { sendTexts: async () => ({ messageIds: ["msg-9"], checkDelivery: check }) }, { store: f.store, now: () => T, watch });
    expect(removed).toEqual(["r1"]);
    expect(f.row).toMatchObject({ sentAt: T, messageId: "msg-9" });
    expect(watch).toHaveBeenCalledWith(expect.objectContaining({ key: KEY, messageId: "msg-9", check }));
  });

  it("does not track ordinary replies", async () => {
    const f = fakeStore();
    const watch = vi.fn(async () => undefined);
    const { q } = queueOf([{ body: warning({ kind: "reply", alertId: undefined, phoneHash: undefined }), receipt: "r1" }]);
    await drainOutboundOnce(q, { sendTexts: async () => ({ messageIds: ["m"], checkDelivery: async () => null }) }, { store: f.store, watch });
    expect(f.row.sentAt).toBeNull();
    expect(watch).not.toHaveBeenCalled();
  });

  it("flags the alert and leaves the message queued when sending fails", async () => {
    const f = fakeStore();
    const { q, removed } = queueOf([{ body: warning(), receipt: "r1" }]);
    const n = await drainOutboundOnce(q, { sendTexts: async () => { throw new Error("not registered"); } }, { store: f.store });
    expect(n).toBe(0);
    expect(removed).toEqual([]);
    expect(f.row.error).toBe("send failed");
  });
});
