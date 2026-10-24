import type { DashboardState } from "@ever/core";
import { useState } from "react";
import { triggerShutoff } from "../lib/api";
import { clockShort } from "../lib/format";

function defaultShutoffLocal(): string {
  const d = new Date();
  d.setHours(20, 0, 0, 0);
  if (d.getTime() < Date.now() + 30 * 60_000) {
    d.setTime(Date.now() + 2 * 3_600_000);
    d.setMinutes(Math.ceil(d.getMinutes() / 30) * 30, 0, 0);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type Props = { state: DashboardState | null; apiKey: string; onChanged: () => void; onError: (m: string) => void; onClose: () => void };

/** Right rail: send a shutoff warning to a ZIP and see how many opted-in residents it was sent to. Totals only. */
export function WarningsRail({ state, apiKey, onChanged, onError, onClose }: Props) {
  const [zip, setZip] = useState("95112");
  const [when, setWhen] = useState(defaultShutoffLocal);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const zipOk = /^\d{5}$/.test(zip);
  const warning = state?.warning ?? null;

  const send = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await triggerShutoff(apiKey, zip, new Date(when).toISOString());
      setNote(res.residents === 0 ? `No one has opted in for ${zip} yet.` : `Warning queued for ${res.queued} of ${res.residents} opted-in ${res.residents === 1 ? "person" : "people"}.`);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not send the warning");
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="rail">
      <div className="rail__header">
        <div className="rail__title-row">
          <h2 className="rail__title">SHUTOFF WARNING</h2>
          <button className="rail__close" onClick={onClose} aria-label="Close the shutoff warning panel">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </div>
        <p className="rail__sub">Warn everyone who opted in for a ZIP.</p>
        <div className="form-row">
          <label className="field field--zip">
            <span className="label">ZIP</span>
            <input className="input input--mono" inputMode="numeric" maxLength={5} value={zip} onChange={(e) => setZip(e.target.value.replace(/\D/g, ""))} />
          </label>
          <label className="field">
            <span className="label">POWER GOES OFF AT</span>
            <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </label>
        </div>
        <button className="btn btn--accent btn--block" disabled={!zipOk || busy || !when} onClick={send}>
          {busy ? "SENDING…" : zipOk ? `SEND WARNING TO ${zip}` : "ENTER A 5-DIGIT ZIP"}
        </button>
        {note && <div className="note">{note}</div>}
      </div>

      <div className="rail__scroll">
        {warning ? (
          <div className="status-head">
            <div className="rail__title-row">
              <h3 className="status-head__title">ZIP {warning.zip} · {clockShort(warning.shutoffAt)}</h3>
              <span className="small muted">sent {clockShort(warning.createdAt)}</span>
            </div>
            <div className="headlines">
              <div className="headline" style={{ flex: 1 }}><div className="headline__value">{warning.sent}<span className="headline__of"> /{warning.total}</span></div><div className="label">SENT TO OPTED-IN RESIDENTS</div></div>
            </div>
            {warning.failed > 0 && <div className="note note--error">{warning.failed} could not be sent.</div>}
          </div>
        ) : (
          <div className="empty">No warnings sent yet. Send one above and the number sent appears here.</div>
        )}
      </div>
    </aside>
  );
}
