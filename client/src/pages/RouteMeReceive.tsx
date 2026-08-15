import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useGeolocation } from "../hooks/useGeolocation";
import { MapView } from "../components/MapView";
import { Logo } from "../components/Logo";
import { haversineM, formatDistance, type LonLat } from "../utils/geo";

interface ShareInfo {
  senderLon: number;
  senderLat: number;
  expiresAt: string;
}

/**
 * "Route me" — recipient side. Opened cold from an SMS, so this asks for geolocation
 * permission only after an explicit "Locate me" tap (not automatically on load) — a stranger
 * with zero app context deserves an informed prompt, not a surprise browser popup. Never shows
 * who sent the link (product decision: always anonymous) — the API itself never returns a
 * phone number or name, only coordinates.
 */
export default function RouteMeReceive() {
  const { token } = useParams<{ token: string }>();
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<ShareInfo>(`/route-share/${token}`, { auth: false })
      .then((res) => {
        if (!cancelled) setShare(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "This link isn't working right now.");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="app-shell">
      <div className="content">
        <div style={{ marginBottom: 22 }}>
          <Logo size={30} />
        </div>

        {error && <div className="banner err">{error}</div>}
        {!error && !share && <p className="muted">Loading…</p>}

        {share && !locating && (
          <div className="stack">
            <h1 className="h-disp" style={{ fontSize: 24 }}>
              Someone wants you to find them
            </h1>
            <p className="muted" style={{ maxWidth: 340 }}>
              Use the map to locate yourself, and we'll draw a route from where you are to where they are.
            </p>
            <button className="btn btn-green" onClick={() => setLocating(true)}>
              Locate me
            </button>
          </div>
        )}

        {share && locating && <RouteToSender senderLon={share.senderLon} senderLat={share.senderLat} />}
      </div>
    </div>
  );
}

function RouteToSender({ senderLon, senderLat }: { senderLon: number; senderLat: number }) {
  // Watched (not one-shot) so the recipient's own position keeps updating while they actually
  // walk toward the sender — the same live-tracking pattern CollectorHome uses while a collector
  // roams. `receivePoint` is the first fix only, captured once and never overwritten, exactly
  // like requests.accept_lon/accept_lat is a one-time snapshot rather than a moving target — it's
  // the baseline "how far have you travelled since you started" is measured from.
  const { coords, error: geoError } = useGeolocation(true);
  const [receivePoint, setReceivePoint] = useState<LonLat | null>(null);

  useEffect(() => {
    if (coords && !receivePoint) setReceivePoint(coords);
  }, [coords, receivePoint]);

  if (geoError) {
    return (
      <div className="banner err">
        We couldn't get your location — allow location access in your browser and try again.
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
          points={[{ id: "sender", lon: senderLon, lat: senderLat, color: "#0E6E4E", label: "Them" }]}
          route={{ from: coords, to: { lon: senderLon, lat: senderLat } }}
          className="map-fill"
        />
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}>
        Their location was captured when this link was sent and won't update live.
      </p>
      {receivePoint && (
        <p className="muted" style={{ fontSize: 12 }}>
          You've travelled {formatDistance(haversineM(receivePoint, coords))} since you started tracking
        </p>
      )}
    </div>
  );
}
