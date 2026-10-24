import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AiMode, AlertRecord, OutboundMessage } from "@ever/core";
import { PhotonError } from "../src/photon";
import { handleRequest, type ApiDeps, type Resident } from "../src/routes";

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

const KEY = "test-key";
/** Like the real hash: an opaque digest that does not contain the number. */
const fakeHash = (phone: string) => createHash("sha256").update(`salt:${phone}`).digest("hex");
const NOW = new Date("2026-10-24T07:00:00Z");

type Fake = {
  deps: ApiDeps;
  residents: Resident[];
  alerts: AlertRecord[];
  outbound: OutboundMessage[];
  state: { aiMode: AiMode; worker: boolean | null };
};

function makeFake(over: Partial<ApiDeps> = {}, residents: Resident[] = []): Fake {
  const alerts: AlertRecord[] = [];
  const outbound: OutboundMessage[] = [];
  const state = { aiMode: "primary" as AiMode, worker: true as boolean | null };
  const deps: ApiDeps = {
    now: () => NOW,
    getApiKey: async () => KEY,
    getAiMode: async () => state.aiMode,
    setAiMode: async (m) => void (state.aiMode = m),
    getWorkerEnabled: async () => state.worker,
    setWorkerEnabled: async (e) => void (state.worker = e),
    getQueueDepths: async () => ({
      inbound: { visible: 3, inFlight: 1 },
      inboundDlq: { visible: 0, inFlight: 0 },
      outbound: { visible: 0, inFlight: 0 },
      outboundDlq: { visible: 0, inFlight: 0 },
    }),
    scanNeeds: async () => [],
    scanResources: async () => [],
    scanAlerts: async () => alerts,
    residentsByZip: async (zip) => residents.filter((r) => r.zip === zip),
    scanResidents: async () => residents,
    putResident: async (r) => {
      const i = residents.findIndex((x) => x.phoneHash === r.phoneHash);
      if (i >= 0) residents[i] = r;
      else residents.push(r);
    },
    deleteResident: async (h) => {
      const i = residents.findIndex((x) => x.phoneHash === h);
      if (i >= 0) residents.splice(i, 1);
    },
    hashPhone: async (p) => fakeHash(p),
    registerPhoton: async () => ({ userId: "photon-user-1", assignedNumber: "+16285024061" }),
    putAlert: async (a) => {
      const i = alerts.findIndex((x) => x.alertId === a.alertId && x.phoneHash === a.phoneHash);
      if (i >= 0) alerts[i] = a;
      else alerts.push(a);
    },
    sendOutbound: async (m) => void outbound.push(m),
    ...over,
  };
  return { deps, residents, alerts, outbound, state };
}

const call = (deps: ApiDeps, method: string, path: string, body?: unknown, key: string | null = KEY) =>
  handleRequest(deps, {
    method,
    path,
    headers: key === null ? {} : { "x-api-key": key },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

const needRow = (over: Record<string, unknown> = {}) => ({
  id: "n1",
  tier: "medical_critical",
  needType: "refrigeration",
  language: "en",
  emergency: false,
  status: "routed",
  mode: "ai",
  zip: "95112",
  latRounded: 37.349,
  lngRounded: -121.894,
  resourceId: "ph-02",
  distanceMiles: 0.9,
  unverifiedShown: 0,
  extractor: "bedrock",
  modelId: "amazon.nova-lite-v1:0",
  latencyMs: 520,
  fallbackReason: null,
  replyBy: "bedrock",
  redactedText: "my insulin needs to stay cold, 95112",
  createdAt: "2026-10-24T06:50:00.000Z",
  routedAt: "2026-10-24T06:50:01.000Z",
  ...over,
});

describe("auth and routing", () => {
  it("rejects a missing or wrong key, but not before checking the route exists", async () => {
    const { deps } = makeFake();
    expect((await call(deps, "GET", "/state", undefined, null)).statusCode).toBe(401);
    expect((await call(deps, "GET", "/state", undefined, "nope")).statusCode).toBe(401);
    expect((await call(deps, "GET", "/state", undefined, "test-keyX")).statusCode).toBe(401);
    expect((await call(deps, "GET", "/nothing")).statusCode).toBe(404);
    expect((await call(deps, "DELETE", "/state")).statusCode).toBe(404);
  });

  it("rejects malformed JSON", async () => {
    const { deps } = makeFake();
    expect((await call(deps, "POST", "/chaos", "{not json")).statusCode).toBe(400);
  });
});

describe("GET /state", () => {
  it("returns places, system status and aggregate stats", async () => {
    const { deps } = makeFake({
      scanResources: async () => [
        { id: "ph-02", name: "Downtown Care Pharmacy", type: "pharmacy", lat: 37.3, lng: -121.9, address: "1 Main St", hasPower: true, capacity: 6, capacityUnit: "fridge slots", hours: "24/7", supports: ["pharmacy"] },
        { id: "broken" },
      ],
      scanNeeds: async () => [needRow({ id: "a", latencyMs: 400 }), needRow({ id: "b", latencyMs: 600 }), needRow({ id: "c", extractor: "rules", latencyMs: 1 })],
    });
    const res = await call(deps, "GET", "/state");
    expect(res.statusCode).toBe(200);
    const state = JSON.parse(res.body);
    expect(state.places.map((p: { id: string }) => p.id)).toEqual(["ph-02"]); // invalid rows are dropped
    expect(state.system).toMatchObject({ aiMode: "primary", workerEnabled: true });
    expect(state.system.queues.inbound).toEqual({ visible: 3, inFlight: 1 });
    expect(state.stats).toMatchObject({ requests: 3, bedrockPct: 67, avgExtractMs: 500, modelId: "amazon.nova-lite-v1:0" });
  });

  it("highlights only the KIND of help most recently asked for", async () => {
    const { deps } = makeFake({
      scanNeeds: async () => [
        needRow({ id: "old", needType: "food", createdAt: "2026-10-24T06:00:00.000Z" }),
        needRow({ id: "new", needType: "pharmacy", createdAt: "2026-10-24T06:55:00.000Z" }),
        needRow({ id: "hello", needType: "info", createdAt: "2026-10-24T06:59:00.000Z" }), // not a request for a place
      ],
    });
    const state = JSON.parse((await call(deps, "GET", "/state")).body);
    expect(state.focus).toEqual({ needType: "pharmacy", at: "2026-10-24T06:55:00.000Z" });
  });

  it("has no focus before any request, or when every request was unclear", async () => {
    expect(JSON.parse((await call(makeFake().deps, "GET", "/state")).body).focus).toBeNull();
    const only = makeFake({ scanNeeds: async () => [needRow({ needType: "info" })] });
    expect(JSON.parse((await call(only.deps, "GET", "/state")).body).focus).toBeNull();
  });

  it("still answers when the worker trigger can't be read", async () => {
    const { deps } = makeFake({
      getWorkerEnabled: async () => {
        throw new Error("AccessDenied");
      },
    });
    expect(JSON.parse((await call(deps, "GET", "/state")).body).system.workerEnabled).toBeNull();
  });

  // The privacy guarantee: the browser must never receive where a request came from, what it said, or who sent it.
  it("never returns request locations, requester ZIPs, message text, or any phone number", async () => {
    const { deps } = makeFake(
      {
        scanNeeds: async () => [
          needRow({ zip: "95123", latRounded: 37.2481, lngRounded: -121.8312, redactedText: "I live alone and need insulin kept cold", phone: "+14085550123", sender: "+14085550123" }),
        ],
      },
      [{ phoneHash: "h1", phone: "+14085550177", zip: "94110", needType: "refrigeration", optedIn: true, assignedNumber: "+16285024061", createdAt: "2026-10-24T06:00:00.000Z" }],
    );
    const body = (await call(deps, "GET", "/state")).body;
    for (const secret of ["95123", "37.2481", "-121.8312", "live alone", "insulin kept cold", "4085550123", "4085550177", "94110", "redactedText", "latRounded", "phoneHash"]) {
      expect(body, secret).not.toContain(secret);
    }
    const state = JSON.parse(body);
    expect(Object.keys(state).sort()).toEqual(["focus", "now", "places", "stats", "system", "warning"]);
    expect(state).not.toHaveProperty("needs");
    expect(state).not.toHaveProperty("residents");
    expect(state).not.toHaveProperty("alerts");
  });
});

describe("POST /chaos and /worker", () => {
  it("flips the AI mode", async () => {
    const f = makeFake();
    expect((await call(f.deps, "POST", "/chaos", { mode: "degraded" })).statusCode).toBe(200);
    expect(f.state.aiMode).toBe("degraded");
    expect((await call(f.deps, "POST", "/chaos", { mode: "on" })).statusCode).toBe(400);
    expect(f.state.aiMode).toBe("degraded");
  });

  it("pauses and resumes the worker", async () => {
    const f = makeFake();
    await call(f.deps, "POST", "/worker", { enabled: false });
    expect(f.state.worker).toBe(false);
    await call(f.deps, "POST", "/worker", { enabled: true });
    expect(f.state.worker).toBe(true);
    expect((await call(f.deps, "POST", "/worker", { enabled: "yes" })).statusCode).toBe(400);
  });
});

describe("POST /shutoff (FR-11)", () => {
  const residents: Resident[] = [
    { phoneHash: "h1", phone: "+14085550101", zip: "95112", needType: "refrigeration", optedIn: true },
    { phoneHash: "h2", phone: "+14085550102", zip: "95112", needType: "device_power", optedIn: true },
    { phoneHash: "h3", phone: "+14085550103", zip: "95112", needType: "refrigeration", optedIn: false },
    { phoneHash: "h4", phone: "+14085550104", zip: "95116", needType: "refrigeration", optedIn: true },
  ];
  const body = { zip: "95112", shutoffAt: "2026-10-24T20:00:00-07:00" };

  it("warns every opted-in resident in the ZIP, and nobody else", async () => {
    const f = makeFake({}, residents);
    const res = await call(f.deps, "POST", "/shutoff", body);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ residents: 2, queued: 2 });
    expect(f.outbound.map((m) => m.to).sort()).toEqual(["+14085550101", "+14085550102"]);
    expect(f.outbound.every((m) => m.kind === "warning" && m.alertId && m.phoneHash)).toBe(true);
    expect(f.outbound[0]!.texts[0]).toContain("planned power shutoff");
    expect(f.outbound[0]!.texts[0]).toContain("95112");
  });

  it("tracks each resident's warning, but the dashboard receives totals only", async () => {
    const f = makeFake({}, residents);
    await call(f.deps, "POST", "/shutoff", body);
    expect(f.alerts).toHaveLength(2); // stored per resident
    const stateBody = (await call(f.deps, "GET", "/state")).body;
    const state = JSON.parse(stateBody);
    expect(state.warning).toMatchObject({ zip: "95112", total: 2, sent: 0, delivered: 0, read: 0, failed: 0 });
    expect(Object.keys(state.warning).sort()).toEqual(["alertId", "createdAt", "delivered", "failed", "read", "sent", "shutoffAt", "total", "zip"]);
    for (const secret of ["4085550101", "4085550102", "***0101", "***0102", "h1", "h2", "phoneHash", "label", "residents"]) {
      expect(stateBody, secret).not.toContain(secret);
    }
  });

  it("counts progress as it happens", async () => {
    const f = makeFake({}, residents);
    await call(f.deps, "POST", "/shutoff", body);
    f.alerts[0]!.sentAt = "2026-10-24T07:00:01.000Z";
    f.alerts[1]!.sentAt = "2026-10-24T07:00:01.000Z";
    f.alerts[1]!.deliveredAt = "2026-10-24T07:00:02.000Z";
    f.alerts[1]!.readAt = "2026-10-24T07:00:09.000Z";
    const w = JSON.parse((await call(f.deps, "GET", "/state")).body).warning;
    expect(w).toMatchObject({ total: 2, sent: 2, delivered: 1, read: 1 });
  });

  it("counts people the warning could not reach", async () => {
    const f = makeFake({}, residents);
    await call(f.deps, "POST", "/shutoff", body);
    f.alerts[0]!.error = "send failed";
    expect(JSON.parse((await call(f.deps, "GET", "/state")).body).warning.failed).toBe(1);
  });

  it("does nothing, successfully, when no one is opted in for that ZIP", async () => {
    const f = makeFake({}, residents);
    const res = await call(f.deps, "POST", "/shutoff", { ...body, zip: "90210" });
    expect(JSON.parse(res.body)).toMatchObject({ residents: 0, queued: 0 });
    expect(f.outbound).toHaveLength(0);
  });

  it("marks an alert as errored when it can't be queued, and still warns the others", async () => {
    let n = 0;
    const f = makeFake(
      {
        sendOutbound: async (m) => {
          n += 1;
          if (n === 1) throw new Error("SQS down");
          f.outbound.push(m);
        },
      },
      residents,
    );
    const res = JSON.parse((await call(f.deps, "POST", "/shutoff", body)).body);
    expect(res).toMatchObject({ residents: 2, queued: 1 });
    expect(f.alerts.filter((a) => a.error).length).toBe(1);
  });

  it("rejects a bad ZIP or time", async () => {
    const { deps } = makeFake();
    expect((await call(deps, "POST", "/shutoff", { zip: "951", shutoffAt: body.shutoffAt })).statusCode).toBe(400);
    expect((await call(deps, "POST", "/shutoff", { zip: "95112", shutoffAt: "tonight" })).statusCode).toBe(400);
  });

  it("caps one trigger at 25 residents", async () => {
    const many = Array.from({ length: 40 }, (_, i): Resident => ({
      phoneHash: `h${i}`,
      phone: `+1408555${String(1000 + i)}`,
      zip: "95112",
      needType: "info",
      optedIn: true,
    }));
    const f = makeFake({}, many);
    expect(JSON.parse((await call(f.deps, "POST", "/shutoff", body)).body).queued).toBe(25);
  });
});

describe("POST /residents (add from the dashboard)", () => {
  const add = { phone: "(408) 555-0199", zip: "95112", needType: "refrigeration", firstName: "Sam" };

  it("registers the phone with Photon, stores an opted-in resident, and returns the number to text", async () => {
    const registered: [string, string | undefined][] = [];
    const f = makeFake({ registerPhoton: async (p, n) => (registered.push([p, n]), { userId: "u-9", assignedNumber: "+16285024061" }) });
    const res = await call(f.deps, "POST", "/residents", add);
    expect(res.statusCode).toBe(200);
    expect(registered).toEqual([["+14085550199", "Sam"]]);
    expect(f.residents).toHaveLength(1);
    expect(f.residents[0]).toMatchObject({
      phone: "+14085550199",
      phoneHash: fakeHash("+14085550199"),
      zip: "95112",
      needType: "refrigeration",
      optedIn: true,
      assignedNumber: "+16285024061",
      photonUserId: "u-9",
    });
    expect(JSON.parse(res.body).resident).toMatchObject({ label: "***0199", assignedNumber: "+16285024061" });
  });

  it("never returns the full phone number, and /state does not list residents at all", async () => {
    const f = makeFake();
    const res = await call(f.deps, "POST", "/residents", add);
    expect(res.body).not.toContain("4085550199");
    const stateBody = (await call(f.deps, "GET", "/state")).body;
    expect(JSON.parse(stateBody)).not.toHaveProperty("residents");
    expect(stateBody).not.toContain("4085550199");
    expect(stateBody).not.toContain("0199");
  });

  it("makes the new resident a target of the next shutoff warning for that ZIP", async () => {
    const f = makeFake();
    await call(f.deps, "POST", "/residents", add);
    const res = JSON.parse((await call(f.deps, "POST", "/shutoff", { zip: "95112", shutoffAt: "2026-10-24T20:00:00-07:00" })).body);
    expect(res).toMatchObject({ residents: 1, queued: 1 });
    expect(f.outbound[0]!.to).toBe("+14085550199");
  });

  it.each([
    ["too short", { ...add, phone: "12345" }],
    ["an email", { ...add, phone: "a@b.com" }],
    ["letters", { ...add, phone: "call me maybe" }],
    ["a bad ZIP", { ...add, zip: "951" }],
    ["the 'info' need", { ...add, needType: "info" }],
    ["a missing field", { phone: add.phone }],
  ])("rejects %s without calling Photon", async (_name, body) => {
    let called = false;
    const f = makeFake({ registerPhoton: async () => ((called = true), { userId: "x", assignedNumber: null }) });
    expect((await call(f.deps, "POST", "/residents", body)).statusCode).toBe(400);
    expect(called).toBe(false);
    expect(f.residents).toHaveLength(0);
  });

  it("does not store anyone Photon could not register", async () => {
    const f = makeFake({
      registerPhoton: async () => {
        throw new PhotonError(402, "plan limit");
      },
    });
    const res = await call(f.deps, "POST", "/residents", add);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error).toContain("402");
    expect(f.residents).toHaveLength(0);
  });

  it("reports a network failure to Photon without leaking details", async () => {
    const f = makeFake({
      registerPhoton: async () => {
        throw new Error("connect ETIMEDOUT 1.2.3.4");
      },
    });
    const res = await call(f.deps, "POST", "/residents", add);
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("1.2.3.4");
  });

  it("adding the same number twice updates it instead of duplicating it", async () => {
    const f = makeFake();
    await call(f.deps, "POST", "/residents", add);
    await call(f.deps, "POST", "/residents", { ...add, zip: "95116" });
    expect(f.residents).toHaveLength(1);
    expect(f.residents[0]!.zip).toBe("95116");
  });

  it("stops at the resident cap, but still lets an existing number be updated", async () => {
    const full = Array.from({ length: 50 }, (_, i): Resident => ({
      phoneHash: `h${i}`, phone: `+1408555${String(1000 + i)}`, zip: "95112", needType: "info", optedIn: true,
    }));
    const f = makeFake({}, full);
    expect((await call(f.deps, "POST", "/residents", add)).statusCode).toBe(409);
    expect((await call(f.deps, "POST", "/residents", { ...add, phone: "+14085551000" })).statusCode).toBe(200);
  });
});

describe("POST /residents/remove", () => {
  it("removes the resident so they are no longer warned", async () => {
    const f = makeFake();
    await call(f.deps, "POST", "/residents", { phone: "408 555 0199", zip: "95112", needType: "refrigeration" });
    const hash = f.residents[0]!.phoneHash;
    expect((await call(f.deps, "POST", "/residents/remove", { phoneHash: hash })).statusCode).toBe(200);
    expect(f.residents).toHaveLength(0);
    const res = JSON.parse((await call(f.deps, "POST", "/shutoff", { zip: "95112", shutoffAt: "2026-10-24T20:00:00-07:00" })).body);
    expect(res.residents).toBe(0);
  });

  it("requires a phoneHash and the API key", async () => {
    const { deps } = makeFake();
    expect((await call(deps, "POST", "/residents/remove", {})).statusCode).toBe(400);
    expect((await call(deps, "POST", "/residents/remove", { phoneHash: "x" }, null)).statusCode).toBe(401);
    expect((await call(deps, "POST", "/residents", {}, null)).statusCode).toBe(401);
  });
});
