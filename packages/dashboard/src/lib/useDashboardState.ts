import type { DashboardState } from "@ever/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchState } from "./api";

export const POLL_MS = 2000;

export type Connection = "connecting" | "live" | "stale" | "unauthorized";

/** Polls GET /state every 2 s (no websockets, per the design). Keeps the last good state when a poll fails. */
export function useDashboardState(apiKey: string | null) {
  const [state, setState] = useState<DashboardState | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    if (!apiKey) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const poll = async () => {
      try {
        const next = await fetchState(apiKey, controller.signal);
        if (stopped) return;
        setState(next);
        setConnection("live");
      } catch (err) {
        if (stopped || (err instanceof DOMException && err.name === "AbortError")) return;
        setConnection(err instanceof ApiError && err.status === 401 ? "unauthorized" : "stale");
      }
    };
    const loop = async () => {
      await poll();
      if (!stopped) timer = setTimeout(loop, POLL_MS);
    };
    refreshRef.current = poll;
    void loop();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [apiKey]);

  const refresh = useCallback(() => refreshRef.current(), []);
  return { state, connection, refresh };
}
