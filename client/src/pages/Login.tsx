import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../hooks/AuthContext";
import { Mark } from "../components/Logo";
import { IconHome, IconTruck, IconBack } from "../components/Icon";

type Step = "splash" | "phone" | "code" | "admin";

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "tw", label: "Twi" },
  { code: "ga", label: "Ga" },
  { code: "dag", label: "Dagbani" },
] as const;

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>("splash");
  const [language, setLanguage] = useState<string>("en");
  const [languageNote, setLanguageNote] = useState(false);

  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<"household" | "collector">("household");
  const [displayName, setDisplayName] = useState("");
  const [code, setCode] = useState("");
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [otpMessage, setOtpMessage] = useState<string>("");
  const [smsDelivered, setSmsDelivered] = useState(false);
  const [isNewUser, setIsNewUser] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function pickLanguage(code: string) {
    setLanguage(code);
    setLanguageNote(code !== "en");
  }

  /**
   * Single unified entry point (design: "their number tells who they are") — the caller never
   * has to say upfront whether they're a household, a collector, or an admin. The phone number
   * alone decides what happens next:
   *   - a seeded admin's number -> requiresPassword, go straight to the password screen
   *   - anyone else -> an OTP is sent/shown; `isNewUser` decides whether the code screen also
   *     collects a role + name, or just logs straight in
   */
  async function requestOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const data = await api<{
        requiresPassword: boolean;
        message: string;
        devOtp?: string;
        delivered: boolean;
        isNewUser: boolean;
      }>("/auth/otp/request", {
        method: "POST",
        auth: false,
        body: { phone },
      });
      if (data.requiresPassword) {
        setStep("admin");
        return;
      }
      setDevOtp(data.devOtp ?? null);
      setOtpMessage(data.message);
      setSmsDelivered(data.delivered);
      setIsNewUser(data.isNewUser);
      setStep("code");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not request a code");
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (isNewUser && !displayName.trim()) {
      setError("Your name is required to finish signing up.");
      return;
    }
    setBusy(true);
    try {
      const data = await api<{ access: string; refresh: string; user: any }>("/auth/otp/verify", {
        method: "POST",
        auth: false,
        body: { phone, code, role: isNewUser ? role : undefined, displayName: isNewUser ? displayName.trim() : undefined },
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
      setError(err instanceof ApiError ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  function backToPhone() {
    setError(null);
    setPassword("");
    setCode("");
    setStep("phone");
  }

  // ---------------------------------------------------------------- splash
  if (step === "splash") {
    return (
      <div
        className="stack"
        style={{
          minHeight: "calc(100vh - 64px)",
          background: "linear-gradient(160deg, var(--green), var(--green-d))",
          color: "#fff",
          padding: "40px 24px 26px",
          justifyContent: "space-between",
          borderRadius: 24,
          margin: 16,
        }}
      >
        <div style={{ marginTop: 36 }}>
          <div style={{ background: "#fff", borderRadius: "50%", width: 74, height: 74, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Mark size={48} />
          </div>
          <h1 className="h-disp" style={{ fontSize: 44, margin: "20px 0 6px" }}>
            Borla
          </h1>
          <p style={{ fontSize: 16, opacity: 0.9, margin: 0, maxWidth: 260 }}>
            Get your waste collected by a trusted rider near you.
          </p>
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, opacity: 0.8, marginBottom: 9 }}>Choose language</div>
          <div className="grid2" style={{ gap: 8, marginBottom: 10 }}>
            {LANGUAGES.map((l) => (
              <button
                key={l.code}
                type="button"
                onClick={() => pickLanguage(l.code)}
                className="btn"
                style={{
                  padding: 12,
                  fontSize: 14,
                  background: language === l.code ? "#fff" : "rgba(255,255,255,.15)",
                  color: language === l.code ? "var(--green)" : "#fff",
                }}
              >
                {l.label}
              </button>
            ))}
          </div>
          {languageNote && (
            <p style={{ fontSize: 12, opacity: 0.85, margin: "0 0 12px" }}>
              {LANGUAGES.find((l) => l.code === language)?.label} is coming soon — continuing in English for now.
            </p>
          )}
          <button className="btn btn-gold lg" onClick={() => setStep("phone")}>
            Get started
          </button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- phone / code / admin
  return (
    <div className="content" style={{ maxWidth: 420, margin: "24px auto" }}>
      <div className="stack">
        {step !== "phone" && (
          <button className="row" style={{ background: "none", border: 0, padding: 0, cursor: "pointer", width: "fit-content" }} onClick={backToPhone}>
            <IconBack size={18} />
            <span className="muted" style={{ fontWeight: 700, fontSize: 14 }}>
              Back
            </span>
          </button>
        )}

        {error && <div className="banner err">{error}</div>}

        {step === "phone" && (
          <form className="stack card" onSubmit={requestOtp}>
            <div>
              <label>Phone number</label>
              <input
                className="field"
                placeholder="+233200000001"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoFocus
                required
              />
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                We'll text you a code. New here? We'll ask what you need after that.
              </p>
            </div>
            <button className="btn btn-green" disabled={busy} type="submit">
              {busy ? "Sending…" : "Continue"}
            </button>
          </form>
        )}

        {step === "code" && (
          <form className="stack card" onSubmit={verifyOtp}>
            {smsDelivered ? (
              <div className="banner ok">📱 Code sent via SMS — check your phone.</div>
            ) : (
              devOtp && (
                <div className="otp-dev-banner">
                  {otpMessage || "SMS delivery unavailable right now (see Technical Debt Plan, TD-02)."}
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
                autoFocus
                required
              />
            </div>

            {isNewUser && (
              <>
                <div className="banner" style={{ background: "var(--green-tint)", borderColor: "var(--green)", color: "var(--green-d)" }}>
                  First time here — tell us a bit about you.
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
                </div>
                <div>
                  <label>Your name</label>
                  <input
                    className="field"
                    placeholder="e.g. Ama"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    required
                  />
                </div>
              </>
            )}

            <button className="btn btn-green" disabled={busy} type="submit">
              {busy ? "Verifying…" : isNewUser ? "Create account" : "Verify & continue"}
            </button>
          </form>
        )}

        {step === "admin" && (
          <form className="stack card" onSubmit={adminLogin}>
            <div className="banner" style={{ background: "#F1F0E8", borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              This number is registered as an admin — sign in with your password.
            </div>
            <div>
              <label>Admin phone</label>
              <input className="field" value={phone} disabled style={{ opacity: 0.7 }} />
            </div>
            <div>
              <label>Password</label>
              <input
                className="field"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
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
