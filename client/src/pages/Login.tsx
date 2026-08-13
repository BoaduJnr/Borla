import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../hooks/AuthContext";
import { Logo } from "../components/Logo";
import { IconHome, IconTruck } from "../components/Icon";

type Step = "phone" | "code";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [mode, setMode] = useState<"otp" | "admin">("otp");
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<"household" | "collector">("household");
  const [displayName, setDisplayName] = useState("");
  const [code, setCode] = useState("");
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [smsDelivered, setSmsDelivered] = useState(false);
  const [isNewUser, setIsNewUser] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const data = await api<{ devOtp?: string; delivered: boolean; isNewUser: boolean }>("/auth/otp/request", {
        method: "POST",
        auth: false,
        body: { phone, role: role },
      });
      setDevOtp(data.devOtp ?? null);
      setSmsDelivered(data.delivered);
      setIsNewUser(data.isNewUser);
      setStep("code");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not request OTP");
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const data = await api<{ access: string; refresh: string; user: any }>("/auth/otp/verify", {
        method: "POST",
        auth: false,
        body: { phone, code, role: isNewUser ? role : undefined, displayName: displayName || undefined },
      });
      login(data.access, data.refresh, data.user);
      navigate(data.user.role === "collector" ? "/collector" : "/household");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }

  async function adminLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const data = await api<{ access: string; refresh: string; user: any }>("/auth/admin/login", {
        method: "POST",
        auth: false,
        body: { phone, password },
      });
      login(data.access, data.refresh, data.user);
      navigate("/admin");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="content" style={{ maxWidth: 420, margin: "40px auto" }}>
      <div className="stack">
        <div>
          <Logo size={52} />
          <p className="muted" style={{ marginTop: 10 }}>Waste, sorted — one ring away.</p>
        </div>

        <div className="row" style={{ gap: 6 }}>
          <button
            className={`btn btn-sm ${mode === "otp" ? "btn-green" : "btn-ghost"}`}
            onClick={() => {
              setMode("otp");
              setError(null);
            }}
          >
            Household / Collector
          </button>
          <button
            className={`btn btn-sm ${mode === "admin" ? "btn-dark" : "btn-ghost"}`}
            onClick={() => {
              setMode("admin");
              setError(null);
            }}
          >
            Admin
          </button>
        </div>

        {error && <div className="banner err">{error}</div>}

        {mode === "otp" && step === "phone" && (
          <form className="stack card" onSubmit={requestOtp}>
            <div>
              <label>Phone number</label>
              <input
                className="field"
                placeholder="+233200000001"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
              />
            </div>
            <div>
              <label>I am a…</label>
              <div className="row">
                <button
                  type="button"
                  className={`type-tile ${role === "household" ? "sel" : ""}`}
                  onClick={() => setRole("household")}
                >
                  <IconHome color={role === "household" ? "var(--green)" : "var(--ink)"} />
                  Household
                </button>
                <button
                  type="button"
                  className={`type-tile ${role === "collector" ? "sel" : ""}`}
                  onClick={() => setRole("collector")}
                >
                  <IconTruck color={role === "collector" ? "var(--green)" : "var(--ink)"} />
                  Collector
                </button>
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Only used if this is a new phone number.
              </p>
            </div>
            <button className="btn btn-green" disabled={busy} type="submit">
              {busy ? "Sending…" : "Send OTP"}
            </button>
          </form>
        )}

        {mode === "otp" && step === "code" && (
          <form className="stack card" onSubmit={verifyOtp}>
            {smsDelivered ? (
              <div className="banner ok">📱 Code sent via SMS — check your phone.</div>
            ) : (
              devOtp && (
                <div className="otp-dev-banner">
                  🔧 SMS delivery unavailable right now (see Technical Debt Plan, TD-02).
                  <br />
                  Your one-time code is: <b>{devOtp}</b>
                </div>
              )
            )}
            <div>
              <label>Enter the 6-digit code</label>
              <input
                className="field"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            </div>
            {isNewUser && (
              <div>
                <label>Your name</label>
                <input
                  className="field"
                  placeholder="e.g. Ama"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
            )}
            <button className="btn btn-green" disabled={busy} type="submit">
              {busy ? "Verifying…" : "Verify & continue"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setStep("phone")}>
              Back
            </button>
          </form>
        )}

        {mode === "admin" && (
          <form className="stack card" onSubmit={adminLogin}>
            <div>
              <label>Admin phone</label>
              <input className="field" value={phone} onChange={(e) => setPhone(e.target.value)} required />
            </div>
            <div>
              <label>Password</label>
              <input
                className="field"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <button className="btn btn-dark" disabled={busy} type="submit">
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
