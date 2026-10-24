import { useCallback, useEffect, useState } from "react";
import { DemoPanel } from "./components/DemoPanel";
import { Header, type PanelId } from "./components/Header";
import { LoginGate } from "./components/LoginGate";
import { MapPanel } from "./components/MapPanel";
import { WarningsRail } from "./components/WarningsRail";
import { useDashboardState } from "./lib/useDashboardState";

const STORAGE_KEY = "ever.apiKey";

function loadKey(): string | null {
  const fromEnv = import.meta.env.VITE_API_KEY as string | undefined;
  if (fromEnv) return fromEnv;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function App() {
  const [apiKey, setApiKey] = useState<string | null>(loadKey);
  const [toast, setToast] = useState<string | null>(null);
  // Demo controls are hidden by default. Press D (or open the page with #demo) to show them.
  const [demo, setDemo] = useState(() => window.location.hash === "#demo");
  // #warnings opens the shutoff warning panel straight away.
  const [panel, setPanel] = useState<PanelId | null>(() => (window.location.hash === "#warnings" ? "warnings" : null));
  const { state, connection, refresh } = useDashboardState(apiKey);

  const saveKey = (key: string) => {
    try {
      localStorage.setItem(STORAGE_KEY, key);
    } catch {
      /* storage unavailable: the key just won't persist */
    }
    setApiKey(key);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key.toLowerCase() !== "d" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      setDemo((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const onError = useCallback((m: string) => setToast(m), []);

  if (!apiKey || connection === "unauthorized") {
    return <LoginGate onKey={saveKey} message={connection === "unauthorized" ? "That key was not accepted. Check it and try again." : undefined} />;
  }

  return (
    <div className="app">
      <Header connection={connection} panel={panel} onPanel={setPanel} />
      <div className="body">
        <div className="stage">
          <MapPanel state={state} />
          {demo && <DemoPanel state={state} apiKey={apiKey} onChanged={refresh} onError={onError} />}
        </div>
        {panel === "warnings" && (
          <WarningsRail state={state} apiKey={apiKey} onChanged={refresh} onError={onError} onClose={() => setPanel(null)} />
        )}
      </div>
      {toast && <div className="toast" role="alert">{toast}</div>}
    </div>
  );
}
