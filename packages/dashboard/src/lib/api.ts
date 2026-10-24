import { StateSchema, type DashboardState } from "@ever/core";

/** Thin client for the dashboard API. The key goes in the x-api-key header on every call. */

export const API_URL: string = import.meta.env.VITE_API_URL ?? "";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function call(path: string, key: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "x-api-key": key, "content-type": "application/json", ...init.headers },
  });
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const message = typeof body === "object" && body && "error" in body ? String((body as { error: unknown }).error) : res.statusText;
    throw new ApiError(res.status, message);
  }
  return body;
}

export async function fetchState(key: string, signal?: AbortSignal): Promise<DashboardState> {
  return StateSchema.parse(await call("/state", key, { signal }));
}

export const setChaos = (key: string, mode: "primary" | "degraded") =>
  call("/chaos", key, { method: "POST", body: JSON.stringify({ mode }) });

export const setWorker = (key: string, enabled: boolean) =>
  call("/worker", key, { method: "POST", body: JSON.stringify({ enabled }) });

export type ShutoffResult = { alertId: string; residents: number; queued: number };

export async function triggerShutoff(key: string, zip: string, shutoffAt: string): Promise<ShutoffResult> {
  return (await call("/shutoff", key, { method: "POST", body: JSON.stringify({ zip, shutoffAt }) })) as ShutoffResult;
}
