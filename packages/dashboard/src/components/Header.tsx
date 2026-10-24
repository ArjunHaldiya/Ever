import { useEffect, useRef, useState } from "react";
import type { Connection } from "../lib/useDashboardState";

export type PanelId = "warnings";

const MENU: { id: PanelId; label: string; hint: string }[] = [
  { id: "warnings", label: "Shutoff warning", hint: "Warn opted-in residents and track reads" },
];

type Props = {
  connection: Connection;
  /** The panel currently open on the right, if any. */
  panel: PanelId | null;
  onPanel: (panel: PanelId | null) => void;
};

/** Slim top bar: brand on the left, a menu on the right. Demo controls live in a hidden panel (press D). */
export function Header({ connection, panel, onPanel }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <header className="header">
      <div className="brand">
        <div className="brand__mark" aria-hidden>
          <svg width="16" height="18" viewBox="0 0 16 18" fill="none"><path d="M9.5 0L1 10.2h5.6L5.8 18 15 7.2H9.1L9.5 0Z" fill="#15171A" /></svg>
        </div>
        <div>
          <div className="brand__name">EVER</div>
          <div className="label label--dark">RESPONDER VIEW</div>
        </div>
      </div>
      <div className="spacer" />
      {connection !== "live" && (
        <div className={`conn conn--${connection}`}>
          {connection === "connecting" ? "CONNECTING" : connection === "unauthorized" ? "WRONG KEY" : "OFFLINE · SHOWING LAST UPDATE"}
        </div>
      )}
      <div className="menu" ref={wrap}>
        <button className={`menu__btn ${open || panel ? "menu__btn--on" : ""}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <svg width="18" height="14" viewBox="0 0 18 14" fill="none" aria-hidden><path d="M1 1.5h16M1 7h16M1 12.5h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          MENU
        </button>
        {open && (
          <div className="menu__list" role="menu">
            {MENU.map((item) => (
              <button
                key={item.id}
                role="menuitem"
                className={`menu__item ${panel === item.id ? "menu__item--on" : ""}`}
                onClick={() => {
                  onPanel(panel === item.id ? null : item.id);
                  setOpen(false);
                }}
              >
                <span className="menu__label">{item.label}</span>
                <span className="small muted">{item.hint}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </header>
  );
}
