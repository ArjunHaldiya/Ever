/**
 * Registers a phone number as a Photon "shared" user (the free-plan shared iMessage line).
 * Photon's Spectrum API: POST /projects/{projectId}/users/ with HTTP Basic auth
 * (projectId:projectSecret). It is idempotent per phone number and returns the number
 * that person must text ("assignedPhoneNumber").
 */

export type PhotonUser = { userId: string; assignedNumber: string | null };

export class PhotonError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PhotonError";
  }
}

export const PHOTON_API = "https://spectrum.photon.codes";

export async function registerSharedUser(args: {
  projectId: string;
  projectSecret: string;
  phone: string;
  firstName?: string;
  fetchFn?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<PhotonUser> {
  const { projectId, projectSecret, phone, firstName, fetchFn = fetch, baseUrl = PHOTON_API, timeoutMs = 8000 } = args;
  const res = await fetchFn(`${baseUrl}/projects/${encodeURIComponent(projectId)}/users/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`${projectId}:${projectSecret}`).toString("base64")}`,
    },
    body: JSON.stringify({ type: "shared", phoneNumber: phone, ...(firstName ? { firstName } : {}) }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (!res.ok) {
    const message = typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : res.statusText;
    throw new PhotonError(res.status, message || "request failed");
  }
  // The user object may be wrapped as { data: {...} } or returned directly.
  const user = (typeof record.data === "object" && record.data !== null ? record.data : record) as Record<string, unknown>;
  if (typeof user.id !== "string") throw new PhotonError(502, "unexpected response from Photon");
  return {
    userId: user.id,
    assignedNumber: typeof user.assignedPhoneNumber === "string" ? user.assignedPhoneNumber : null,
  };
}
