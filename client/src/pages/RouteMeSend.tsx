import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useGeolocation } from "../hooks/useGeolocation";
import { useAutoDismiss } from "../hooks/useAutoDismiss";
import { IconBack } from "../components/Icon";
import { Logo } from "../components/Logo";

interface CreateResult {
  delivered: boolean;
  expiresInMinutes: number;
  devLink?: string;
}

/**
 * "Route me" — sender side (splash-screen entry point, no login required). Deliberately does
 * NOT fall back to FALLBACK_COORDS on a denied/unavailable geolocation the way HouseholdHome
 * does: the whole point of this page is "route them to *my real* location right now," so a
 * demo/placeholder position would silently send someone the wrong place.
 */
export default function RouteMeSend() {
  const navigate = useNavigate();
  const { coords, error: geoError } = useGeolocation(false);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResult | null>(null);
  useAutoDismiss(error, setError);

  async function send() {
    if (!coords) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<CreateResult>("/route-share", {
        method: "POST",
        body: { phone, senderLon: coords.lon, senderLat: coords.lat },
        auth: false,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <div className="content">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ marginBottom: 20 }}
          onClick={() => navigate("/login")}
        >
          <IconBack size={18} />
          Back
        </button>

        <div style={{ marginBottom: 22 }}>
          <Logo size={30} />
        </div>

        <h1 className="h-disp" style={{ fontSize: 26, marginBottom: 8 }}>
          Route me
        </h1>
        <p className="muted" style={{ marginBottom: 22, maxWidth: 340 }}>
          Enter a phone number and we'll text a link to a map that routes them straight to where you are right now —
          no account needed on either end.
        </p>

        {result ? (
          <div className="banner ok stack" style={{ gap: 10 }}>
            <span>
              {result.delivered
                ? `Text sent — the link expires in ${result.expiresInMinutes} minutes.`
                : "SMS isn't available right now, so here's the link to send yourself:"}
            </span>
            {result.devLink && (
              <a href={result.devLink} style={{ wordBreak: "break-all" }}>
                {result.devLink}
              </a>
            )}
          </div>
        ) : (
          <div className="stack">
            {!coords && !geoError && <p className="muted">Finding your location…</p>}
            {geoError && (
              <div className="banner err">
                We need your location to build a route — allow location access in your browser, then reload this
                page.
              </div>
            )}

            <div>
              <label>Their phone number</label>
              <input
                className="field"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0XX XXX XXXX"
                inputMode="tel"
                type="tel"
              />
            </div>

            {error && <div className="banner err">{error}</div>}

            <button className="btn btn-green" disabled={!coords || busy || phone.trim().length < 8} onClick={send}>
              {busy ? "Sending…" : "Send route link"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
