import { useState } from "react";

export function LoginGate({ onKey, message }: { onKey: (key: string) => void; message?: string }) {
  const [value, setValue] = useState("");
  return (
    <main className="gate">
      <form
        className="gate__card"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onKey(value.trim());
        }}
      >
        <div className="brand brand--gate">
          <div className="brand__mark" aria-hidden>
            <svg width="16" height="18" viewBox="0 0 16 18" fill="none"><path d="M9.5 0L1 10.2h5.6L5.8 18 15 7.2H9.1L9.5 0Z" fill="#15171A" /></svg>
          </div>
          <div className="brand__name brand__name--gate">EVER</div>
        </div>
        <h1 className="gate__title">RESPONDER VIEW</h1>
        <p className="gate__text">Enter the dashboard access key (the <span className="mono">app/api-key</span> secret in AWS Secrets Manager). It stays in this browser only.</p>
        <input className="input input--mono" type="password" autoFocus placeholder="access key" value={value} onChange={(e) => setValue(e.target.value)} />
        {message && <div className="note note--error">{message}</div>}
        <button className="btn btn--accent btn--block" type="submit">OPEN DASHBOARD</button>
      </form>
    </main>
  );
}
