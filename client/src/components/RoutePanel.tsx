import { useState } from "react";
import { MapView, type RouteEndpoint, type RouteInfo } from "./MapView";
import { IconClose } from "./Icon";
import { formatDistance, zoomForDistance } from "../utils/geo";

/**
 * Route to the other side of an accepted direct request — a household's target collector, or a
 * collector's target household (design intent: "introduce a route" once both sides have a
 * concrete match; the broadcast plane has no equivalent binding, so this only applies here).
 * Zooms in as the distance closes (a wide view is useless once someone's at the gate) and
 * expands into a full-screen lightbox on tap for a better look.
 */
export function RoutePanel({
  from,
  to,
  label,
  onDistanceChange,
  resumeFollowAfterMs,
}: {
  from: RouteEndpoint;
  to: RouteEndpoint;
  label: string;
  /** Reported every time the route's distance updates — e.g. so a list of several active
   * requests can sort itself by "closest first" and keep that order current as either side
   * moves, instead of only ever reflecting distance at the moment the list was loaded. */
  onDistanceChange?: (distanceM: number) => void;
  /** Forwarded to MapView — opt-in per caller (see MapView.tsx). Left off by default: only a
   * collector's own accepted-request route currently opts in, not the household side of that
   * same route. */
  resumeFollowAfterMs?: number;
}) {
  const [info, setInfo] = useState<RouteInfo | null>(null);
  const [expanded, setExpanded] = useState(false);
  const zoom = zoomForDistance(info?.distanceM);

  const handleInfo = (i: RouteInfo) => {
    setInfo(i);
    onDistanceChange?.(i.distanceM);
  };

  return (
    <div className="stack" style={{ marginTop: 8 }}>
      <button
        type="button"
        className="map-wrap"
        style={{ height: 160, border: 0, padding: 0, cursor: "pointer", position: "relative" }}
        onClick={() => setExpanded(true)}
        aria-label="Enlarge map"
      >
        <MapView
          center={from}
          points={[{ id: "target", lon: to.lon, lat: to.lat, color: "#0E6E4E", label }]}
          route={{ from, to }}
          onRouteInfo={handleInfo}
          zoom={zoom}
          interactive={false}
          className="map-wrap"
          resumeFollowAfterMs={resumeFollowAfterMs}
        />
        <span
          className="muted"
          style={{
            position: "absolute",
            bottom: 6,
            right: 8,
            fontSize: 10.5,
            background: "rgba(255,255,255,0.85)",
            padding: "2px 6px",
            borderRadius: 6,
            pointerEvents: "none",
          }}
        >
          Tap to enlarge
        </span>
      </button>
      {info && (
        <p className="muted" style={{ fontSize: 12 }}>
          Route to {label}: {formatDistance(info.distanceM)}
          {info.roadFollowing && info.durationS > 0 ? ` · ~${Math.max(1, Math.round(info.durationS / 60))} min` : ""}
          {!info.roadFollowing && " (straight-line estimate — road route unavailable)"}
        </p>
      )}

      {expanded && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <button
            type="button"
            aria-label="Close"
            onClick={() => setExpanded(false)}
            style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.65)", border: 0, cursor: "pointer" }}
          />
          <div
            className="map-wrap"
            style={{ width: "100%", maxWidth: 640, height: "80vh", position: "relative", zIndex: 1 }}
          >
            <MapView
              center={from}
              points={[{ id: "target", lon: to.lon, lat: to.lat, color: "#0E6E4E", label }]}
              route={{ from, to }}
              zoom={zoom}
              className="map-wrap"
              resumeFollowAfterMs={resumeFollowAfterMs}
            />
            <button
              type="button"
              className="btn btn-dark btn-sm"
              style={{ position: "absolute", top: 10, right: 10, padding: 8, borderRadius: 999 }}
              onClick={() => setExpanded(false)}
              aria-label="Close"
            >
              <IconClose size={18} color="#fff" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
