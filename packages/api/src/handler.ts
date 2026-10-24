import { logEvent } from "@ever/core";
import { buildDeps } from "./aws";
import { handleRequest, type ApiDeps } from "./routes";

/** Lambda entry point for the API Gateway HTTP API (payload format 2.0). */

type HttpEvent = {
  rawPath: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
};

let deps: ApiDeps | undefined;

export async function handler(event: HttpEvent): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  try {
    deps ??= buildDeps();
    const body = event.body && event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    const res = await handleRequest(deps, {
      method: event.requestContext.http.method,
      path: event.rawPath,
      headers: event.headers ?? {},
      body,
    });
    return { ...res, headers: { "content-type": "application/json", "cache-control": "no-store" } };
  } catch (err) {
    logEvent("api_error", { error: err instanceof Error ? err.name : "unknown", message: undefined });
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "internal error" }),
    };
  }
}
