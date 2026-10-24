import type { DashboardState } from "@ever/core";
import { useState } from "react";
import { setChaos, setWorker } from "../lib/api";
import { modelLabel } from "../lib/format";

type Props = { state: DashboardState | null; apiKey: string; onChanged: () => void; onError: (m: string) => void };

/**
 * Hidden by default (press D). For the live demo: break the AI path on purpose, pause the worker so
 * the queue builds, and show Bedrock at work. Aggregates only, never per-request data.
 */
export function DemoPanel({ state, apiKey, onChanged, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const degraded = state?.system.aiMode === "degraded";
  const workerOn = state?.system.workerEnabled;
  const q = state?.system.queues;
  const waiting = q ? q.inbound.visible + q.inbound.inFlight : 0;
  const dead = q ? q.inboundDlq.visible + q.outboundDlq.visible : 0;
  const stats = state?.stats;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="demo" aria-label="Demo controls">
      <div className="demo__head">
        <span className="demo__title">DEMO CONTROLS</span>
        <span className="small muted">press D to hide</span>
      </div>

      <div className="demo__ai">
        <span className={`dot ${degraded ? "dot--warn" : "dot--ok"}`} />
        <div>
          <div className="label">AI PATH</div>
          <div className="demo__ai-value">{degraded ? "BACKUP RULES · NO AI" : `BEDROCK · ${modelLabel(stats?.modelId)}`}</div>
        </div>
      </div>

      <dl className="demo__grid">
        <div><dt className="label">QUEUE</dt><dd>{waiting}</dd></div>
        <div><dt className="label" title="Messages that failed three times and were set aside">FAILED</dt><dd className={dead > 0 ? "demo__alert" : ""}>{dead}</dd></div>
        <div><dt className="label">WORKER</dt><dd>{workerOn === null || workerOn === undefined ? "?" : workerOn ? "ON" : "PAUSED"}</dd></div>
        <div><dt className="label">REQUESTS</dt><dd>{stats?.requests ?? 0}</dd></div>
        <div><dt className="label">BY BEDROCK</dt><dd>{stats?.bedrockPct === null || stats === undefined ? "–" : `${stats.bedrockPct}%`}</dd></div>
        <div><dt className="label">MODEL TIME</dt><dd>{stats?.avgExtractMs == null ? "–" : `${Math.round(stats.avgExtractMs)} ms`}</dd></div>
      </dl>

      <div className="demo__buttons">
        <button className="btn btn--accent btn--small" disabled={busy || !state} onClick={() => run(() => setChaos(apiKey, degraded ? "primary" : "degraded"))}>
          {degraded ? "RESTORE THE AI" : "BREAK THE AI"}
        </button>
        <button className="btn btn--ink btn--small" disabled={busy || workerOn === null || workerOn === undefined} onClick={() => run(() => setWorker(apiKey, !workerOn))}>
          {workerOn === false ? "RESUME WORKER" : "PAUSE WORKER"}
        </button>
      </div>
    </aside>
  );
}
