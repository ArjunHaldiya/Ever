import { describe, expect, it } from "vitest";
import { PhotonError, registerSharedUser } from "../src/photon";

const reply = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch;

const base = { projectId: "42e03d0b-0000-0000-0000-000000000000", projectSecret: "s3cret", phone: "+14085550199" };

describe("registerSharedUser", () => {
  it("posts a shared-user request with Basic auth and returns the assigned number", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ data: { id: "u-1", assignedPhoneNumber: "+16285024061" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await registerSharedUser({ ...base, firstName: "Sam", fetchFn });
    expect(out).toEqual({ userId: "u-1", assignedNumber: "+16285024061" });
    expect(seen!.url).toBe(`https://spectrum.photon.codes/projects/${base.projectId}/users/`);
    expect(seen!.init.method).toBe("POST");
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from(`${base.projectId}:${base.projectSecret}`).toString("base64")}`);
    expect(JSON.parse(String(seen!.init.body))).toEqual({ type: "shared", phoneNumber: "+14085550199", firstName: "Sam" });
  });

  it("omits the name when none is given, and accepts an unwrapped response", async () => {
    let body = "";
    const fetchFn = (async (_u: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(JSON.stringify({ id: "u-2", assignedPhoneNumber: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await registerSharedUser({ ...base, fetchFn });
    expect(JSON.parse(body)).toEqual({ type: "shared", phoneNumber: "+14085550199" });
    expect(out).toEqual({ userId: "u-2", assignedNumber: null });
  });

  it("turns an error response into a PhotonError carrying the status", async () => {
    await expect(registerSharedUser({ ...base, fetchFn: reply(402, { message: "plan limit reached" }) })).rejects.toMatchObject({
      name: "PhotonError",
      status: 402,
      message: "plan limit reached",
    });
    await expect(registerSharedUser({ ...base, fetchFn: reply(500, "not json") })).rejects.toBeInstanceOf(PhotonError);
  });

  it("rejects a success response that has no user id", async () => {
    await expect(registerSharedUser({ ...base, fetchFn: reply(200, { data: {} }) })).rejects.toMatchObject({ status: 502 });
  });

  it("never puts the secret in an error message", async () => {
    const err = await registerSharedUser({ ...base, fetchFn: reply(401, { message: "bad credentials" }) }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(base.projectSecret);
  });
});
