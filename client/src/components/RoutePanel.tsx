import { useState } from "react";
import { MapView, type RouteEndpoint, type RouteInfo } from "./MapView";

/**
 * Route to the other side of an accepted direct request — a household's target collector, or a
 * collector's target household (design intent: "introduce a route" once both sides have a
 * concrete match; the broadcast plane has no equivalent binding, so this only applies here).
 */
export function RoutePanel({ from, to, label }: { from: RouteEndpoint; to: RouteEndpoint; label: string }) {
  const [info, setInfo] = useState<RouteInfo | null>(null);

  return (
    <div className="stack" style={{ marginTop: 8 }}>
      <div className="map-wrap" style={{ height: 160 }}>
        <MapView
          center={from}
          points={[{ id: "target", lon: to.lon, lat: to.lat, color: "#0E6E4E", label }]}
          route={{ from, to }}
          onRouteInfo={setInfo}
          className="map-wrap"
        />
      </div>
      {info && (
        <p className="muted" style={{ fontSize: 12 }}>
          Route to {label}: {formatDistance(info.distanceM)}
          {info.roadFollowing && info.durationS > 0 ? ` · ~${Math.max(1, Math.round(info.durationS / 60))} min` : ""}
          {!info.roadFollowing && " (straight-line estimate — road route unavailable)"}
        </p>
      )}
    </div>
  );
}

function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}
