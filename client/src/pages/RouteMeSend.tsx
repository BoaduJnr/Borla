import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useGeolocation } from "../hooks/useGeolocation";
import { useAutoDismiss } from "../hooks/useAutoDismiss";
import { IconBack, IconPerson, IconSearch } from "../components/Icon";
import { Logo } from "../components/Logo";
import { MapView, type RouteInfo } from "../components/MapView";
import { LandmarkSearch, type LandmarkResult } from "../components/LandmarkSearch";
import { zoomForDistance, LIVE_TRACKING_RESUME_MS } from "../utils/geo";

interface CreateResult {
  delivered: boolean;
  expiresInMinutes: number;
  devLink?: string;
}

type Mode = "share" | "search" | null;

/**
 * "Route me" splash-screen entry point, no login required. Forks into two genuinely different
 * flows rather than one form: "Share my location with" texts someone else a link to find you
 * (the original Route me — unchanged below); "Route me to" searches a place and shows the route
 * to it right here, for the searcher themselves — no SMS, no link, no one else involved.
 */
export default function RouteMeSend() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>(null);

  return (
    <div className="app-shell">
      <div className="content">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ marginBottom: 20 }}
          onClick={() => (mode ? setMode(null) : navigate("/login"))}
        >
          <IconBack size={18} />
          Back
        </button>

        <div style={{ marginBottom: 22 }}>
          <Logo size={30} />
        </div>

        {mode === null && <ModePicker onPick={setMode} />}
        {mode === "share" && <ShareLocationForm />}
        {mode === "search" && <SearchAndRoute />}
      </div>
    </div>
  );
}

function ModePicker({ onPick }: { onPick: (mode: Mode) => void }) {
  return (
    <div className="stack">
      <h1 className="h-disp" style={{ fontSize: 26, marginBottom: 4 }}>
        Route me
      </h1>
      <p className="muted" style={{ marginBottom: 6, maxWidth: 360 }}>
        No account needed on either end — pick what you're trying to do.
      </p>

      <button type="button" className="card row" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => onPick("share")}>
        <div className="avatar">
          <IconPerson size={20} color="var(--green-d)" />
        </div>
        <div style={{ flex: 1 }}>
          <b>Share my location with…</b>
          <div className="muted" style={{ fontSize: 12.5 }}>
            Text someone a link — they'll see a route from where they are to where you are.
          </div>
        </div>
      </button>

      <button type="button" className="card row" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => onPick("search")}>
        <div className="avatar g">
          <IconSearch size={18} color="var(--marigold-d)" />
        </div>
        <div style={{ flex: 1 }}>
          <b>Route me to…</b>
          <div className="muted" style={{ fontSize: 12.5 }}>
            Search a place — market, hospital, landmark — and see the route from here to there.
          </div>
        </div>
      </button>
    </div>
  );
}

/** The original Route me flow, unchanged — texts a route-back-to-me link to a phone number. */
function ShareLocationForm() {
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
    <div className="stack">
      <h1 className="h-disp" style={{ fontSize: 24, marginBottom: 4 }}>
        Share my location
      </h1>
      <p className="muted" style={{ marginBottom: 6, maxWidth: 340 }}>
        Enter a phone number and we'll text a link to a map that routes them straight to where you are right now.
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
  );
}

/** New: search a place, see the route to it. Entirely personal/on-page — no SMS, no link, no
 * route_shares row, since nobody else is involved in this flow. */
function SearchAndRoute() {
  const [selected, setSelected] = useState<LandmarkResult | null>(null);

  return (
    <div className="stack">
      <h1 className="h-disp" style={{ fontSize: 24, marginBottom: 4 }}>
        Route me to…
      </h1>
      <p className="muted" style={{ marginBottom: 6, maxWidth: 340 }}>
        Search a place and we'll show the route from where you are to there.
      </p>

      <LandmarkSearch onSelect={setSelected} />

      {selected && <RouteToLandmark destination={selected} />}
    </div>
  );
}

function RouteToLandmark({ destination }: { destination: LandmarkResult }) {
  const { coords, error: geoError } = useGeolocation(false);
  const [info, setInfo] = useState<RouteInfo | null>(null);

  if (geoError) {
    return (
      <div className="banner err">
        We need your location to build a route — allow location access in your browser, then reload this page.
      </div>
    );
  }
  if (!coords) {
    return <p className="muted">Finding your location…</p>;
  }
  return (
    <div className="stack">
      <div className="map-wrap tall">
        <MapView
          center={coords}
          points={[{ id: "destination", lon: destination.lon, lat: destination.lat, color: "#F5A208", label: destination.name }]}
          route={{ from: coords, to: { lon: destination.lon, lat: destination.lat } }}
          onRouteInfo={setInfo}
          zoom={zoomForDistance(info?.distanceM)}
          className="map-fill"
          resumeFollowAfterMs={LIVE_TRACKING_RESUME_MS}
        />
      </div>
      {info && (
        <p className="muted" style={{ fontSize: 12.5 }}>
          {(info.distanceM / 1000).toFixed(1)} km to {destination.name}
          {info.roadFollowing && info.durationS > 0 ? ` · ~${Math.max(1, Math.round(info.durationS / 60))} min` : ""}
        </p>
      )}
    </div>
  );
}
