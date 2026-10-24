import {
  AddResidentBodySchema,
  AiModeSchema,
  ChaosBodySchema,
  RemoveResidentBodySchema,
  ShutoffBodySchema,
  WorkerBodySchema,
  logEvent,
  shutoffWarningText,
  type AiMode,
  type AlertRecord,
  type DashboardState,
  type OutboundMessage,
  type Resource,
  type ResidentView,
  ResourceSchema,
} from "@ever/core";
import { normalizeHandle } from "@ever/core/hash";
import { timingSafeEqual } from "node:crypto";
import { PhotonError, type PhotonUser } from "./photon";
import { deriveFocus, deriveStats, deriveWarning } from "./view";

/**
 * Dashboard API logic with every AWS call injected, so it is testable without AWS.
 * Routes: GET /state, POST /chaos, POST /worker, POST /shutoff. All need the x-api-key header.
 */

export type Resident = {
  phoneHash: string;
  phone: string;
  zip: string;
  needType: string;
  optedIn: boolean;
  /** The shared-line number this person texts. */
  assignedNumber?: string | null;
  photonUserId?: string;
  createdAt?: string;
};

export type ApiDeps = {
  now: () => Date;
  getApiKey: () => Promise<string>;
  getAiMode: () => Promise<AiMode>;
  setAiMode: (mode: AiMode) => Promise<void>;
  getWorkerEnabled: () => Promise<boolean | null>;
  setWorkerEnabled: (enabled: boolean) => Promise<void>;
  getQueueDepths: () => Promise<DashboardState["system"]["queues"]>;
  scanNeeds: () => Promise<Record<string, unknown>[]>;
  scanResources: () => Promise<Record<string, unknown>[]>;
  scanAlerts: () => Promise<AlertRecord[]>;
  residentsByZip: (zip: string) => Promise<Resident[]>;
  scanResidents: () => Promise<Resident[]>;
  putResident: (resident: Resident) => Promise<void>;
  deleteResident: (phoneHash: string) => Promise<void>;
  hashPhone: (phone: string) => Promise<string>;
  /** Registers the phone with Photon and returns the number they should text. */
  registerPhoton: (phone: string, firstName?: string) => Promise<PhotonUser>;
  putAlert: (alert: AlertRecord) => Promise<void>;
  sendOutbound: (message: OutboundMessage) => Promise<void>;
};

export type ApiRequest = {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string | undefined;
};
export type ApiResponse = { statusCode: number; body: string };

/** Safety cap on one shutoff trigger: this is a demo, not a broadcast tool. */
const MAX_RESIDENTS_PER_SHUTOFF = 25;

/** Safety cap on opted-in residents: this is a demo, not a subscriber list. */
const MAX_RESIDENTS = 50;
const E164 = /^\+[1-9]\d{9,14}$/;

export function toResidentView(r: Resident): ResidentView {
  return {
    phoneHash: r.phoneHash,
    label: `***${r.phone.slice(-4)}`,
    zip: r.zip,
    needType: r.needType as ResidentView["needType"],
    assignedNumber: r.assignedNumber ?? null,
    createdAt: r.createdAt ?? "",
  };
}

const json = (statusCode: number, data: unknown): ApiResponse => ({ statusCode, body: JSON.stringify(data) });

function keysMatch(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseBody(body: string | undefined): unknown {
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    return undefined;
  }
}

export async function buildState(deps: ApiDeps): Promise<DashboardState> {
  const [aiMode, workerEnabled, queues, needs, resources, alerts] = await Promise.all([
    deps.getAiMode(),
    deps.getWorkerEnabled().catch(() => null),
    deps.getQueueDepths(),
    deps.scanNeeds(),
    deps.scanResources(),
    deps.scanAlerts(),
  ]);
  // Raw needs and alerts are reduced to anonymous summaries here; see view.ts and core/dashboard.ts.
  return {
    now: deps.now().toISOString(),
    places: resources.flatMap((r): Resource[] => {
      const parsed = ResourceSchema.safeParse(r);
      return parsed.success ? [parsed.data] : [];
    }),
    focus: deriveFocus(needs),
    warning: deriveWarning(alerts),
    system: { aiMode: AiModeSchema.parse(aiMode), workerEnabled, queues },
    stats: deriveStats(needs),
  };
}

async function triggerShutoff(deps: ApiDeps, zip: string, shutoffAt: string) {
  const residents = (await deps.residentsByZip(zip)).filter((r) => r.optedIn).slice(0, MAX_RESIDENTS_PER_SHUTOFF);
  const alertId = `alert_${deps.now().getTime()}_${zip}`;
  const text = shutoffWarningText({ zip, shutoffAt: new Date(shutoffAt) });
  let queued = 0;
  for (const r of residents) {
    const alert: AlertRecord = {
      alertId,
      phoneHash: r.phoneHash,
      zip,
      shutoffAt,
      label: `***${r.phone.slice(-4)}`,
      createdAt: deps.now().toISOString(),
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      messageId: null,
      error: null,
    };
    await deps.putAlert(alert);
    try {
      await deps.sendOutbound({ to: r.phone, texts: [text], kind: "warning", alertId, phoneHash: r.phoneHash });
      queued += 1;
    } catch (err) {
      await deps.putAlert({ ...alert, error: "could not queue" });
      logEvent("shutoff_queue_failed", { alertId, error: err instanceof Error ? err.name : "unknown" });
    }
  }
  logEvent("shutoff_triggered", { alertId, zip, residents: residents.length, queued });
  return { alertId, residents: residents.length, queued };
}

export async function handleRequest(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const route = `${req.method.toUpperCase()} ${req.path}`;
  const known = ["GET /state", "POST /chaos", "POST /worker", "POST /shutoff", "POST /residents", "POST /residents/remove"];
  if (!known.includes(route)) return json(404, { error: "not found" });

  if (!keysMatch(await deps.getApiKey(), req.headers["x-api-key"])) {
    return json(401, { error: "missing or wrong x-api-key" });
  }

  if (route === "GET /state") return json(200, await buildState(deps));

  const body = parseBody(req.body);
  if (body === undefined) return json(400, { error: "body is not valid JSON" });

  switch (route) {
    case "POST /chaos": {
      const parsed = ChaosBodySchema.safeParse(body);
      if (!parsed.success) return json(400, { error: "mode must be primary or degraded" });
      await deps.setAiMode(parsed.data.mode);
      logEvent("chaos_set", { mode: parsed.data.mode });
      return json(200, { mode: parsed.data.mode });
    }
    case "POST /worker": {
      const parsed = WorkerBodySchema.safeParse(body);
      if (!parsed.success) return json(400, { error: "enabled must be true or false" });
      await deps.setWorkerEnabled(parsed.data.enabled);
      logEvent("worker_toggled", { enabled: parsed.data.enabled });
      return json(200, { enabled: parsed.data.enabled });
    }
    case "POST /residents": {
      const parsed = AddResidentBodySchema.safeParse(body);
      if (!parsed.success) return json(400, { error: "Enter a phone number, a 5-digit ZIP and what they need." });
      const phone = normalizeHandle(parsed.data.phone);
      if (phone.includes("@") || !E164.test(phone)) return json(400, { error: "Enter a valid phone number, for example 408 555 0123." });
      const existing = await deps.scanResidents();
      if (existing.length >= MAX_RESIDENTS && !existing.some((r) => r.phone === phone)) {
        return json(409, { error: `Up to ${MAX_RESIDENTS} residents. Remove one first.` });
      }
      let photon: PhotonUser;
      try {
        photon = await deps.registerPhoton(phone, parsed.data.firstName || undefined);
      } catch (err) {
        logEvent("photon_register_failed", { error: err instanceof Error ? err.name : "unknown", status: err instanceof PhotonError ? err.status : undefined });
        return json(502, {
          error: err instanceof PhotonError ? `Photon could not register this number (${err.status}).` : "Photon could not be reached. Try again.",
        });
      }
      const resident: Resident = {
        phoneHash: await deps.hashPhone(phone),
        phone,
        zip: parsed.data.zip,
        needType: parsed.data.needType,
        optedIn: true,
        assignedNumber: photon.assignedNumber,
        photonUserId: photon.userId,
        createdAt: deps.now().toISOString(),
      };
      await deps.putResident(resident);
      logEvent("resident_added", { zip: resident.zip, needType: resident.needType });
      return json(200, { resident: toResidentView(resident) });
    }
    case "POST /residents/remove": {
      const parsed = RemoveResidentBodySchema.safeParse(body);
      if (!parsed.success) return json(400, { error: "phoneHash is required" });
      await deps.deleteResident(parsed.data.phoneHash);
      logEvent("resident_removed", {});
      return json(200, { removed: true });
    }
    default: {
      const parsed = ShutoffBodySchema.safeParse(body);
      if (!parsed.success) return json(400, { error: "zip must be 5 digits and shutoffAt an ISO date-time" });
      return json(200, await triggerShutoff(deps, parsed.data.zip, parsed.data.shutoffAt));
    }
  }
}
