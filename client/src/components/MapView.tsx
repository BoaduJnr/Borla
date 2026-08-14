import { MapContainer, TileLayer, CircleMarker, Polyline, Popup, useMap } from "react-leaflet";
import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";

export interface MapPoint {
  id: string;
  lon: number;
  lat: number;
  color: string;
  label: string;
  popup?: string;
}

export interface RouteEndpoint {
  lon: number;
  lat: number;
}

export interface RouteInfo {
  distanceM: number;
  durationS: number;
  roadFollowing: boolean; // false when this is the straight-line fallback, not a real route
}

/**
 * Keeps the map centred on `lon`/`lat` as it updates live — until the user takes over. A
 * collector's own position streams in every few seconds while online/roaming, and a route's
 * zoom recomputes as distance changes (RoutePanel); without this guard, either one yanks the
 * viewport back out from under a finger mid-pan on mobile, making the map impossible to look
 * around in ("resets when you move" — reported directly by a user testing on an iPhone).
 * Once a real drag or pinch-zoom is detected, auto-recentring stops for the life of this map
 * instance; the "you are here"/route markers keep tracking live coordinates regardless, since
 * they're plain props on CircleMarker/Polyline, independent of this viewport-following logic.
 */
function Recenter({ lon, lat, zoom }: { lon: number; lat: number; zoom?: number }) {
  const map = useMap();
  const [follow, setFollow] = useState(true);
  // Distinguishes our own setView-triggered zoomstart/zoomend from a real pinch/double-tap zoom
  // — setView never fires "dragstart" on its own, only zoomstart/zoomend when the zoom changes.
  const programmaticZoom = useRef(false);

  useEffect(() => {
    if (!follow) return;
    programmaticZoom.current = true;
    map.setView([lat, lon], zoom ?? map.getZoom());
  }, [lon, lat, zoom, follow, map]);

  useEffect(() => {
    const onZoomEnd = () => {
      programmaticZoom.current = false;
    };
    const onDragStart = () => setFollow(false);
    const onZoomStart = () => {
      if (!programmaticZoom.current) setFollow(false);
    };
    map.on("zoomend", onZoomEnd);
    map.on("dragstart", onDragStart);
    map.on("zoomstart", onZoomStart);
    return () => {
      map.off("zoomend", onZoomEnd);
      map.off("dragstart", onDragStart);
      map.off("zoomstart", onZoomStart);
    };
  }, [map]);

  return null;
}

/**
 * Straight-line distance (metres) — used both as the route fallback geometry and to compute
 * distance/duration when the routing service itself is unreachable.
 */
function haversineM(a: RouteEndpoint, b: RouteEndpoint): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/**
 * Draws a route between two points — collector-to-household or household-to-collector, once a
 * direct request is accepted (the only point where both sides have a concrete "target" — see
 * Technical_Debt_Plan.md for why the broadcast plane, with no collector binding, doesn't get one).
 * Uses OSRM's public demo routing server, the same zero-config choice already made for the OSM
 * tile layer above (no API key/account) — falls back to a straight line if it's unreachable, so
 * a flaky third-party service never blocks the map from rendering.
 */
function useRoute(from?: RouteEndpoint, to?: RouteEndpoint, onInfo?: (info: RouteInfo) => void) {
  const [state, setState] = useState<{ path: [number, number][]; roadFollowing: boolean } | null>(null);

  useEffect(() => {
    if (!from || !to) {
      setState(null);
      return;
    }
    let cancelled = false;
    const fallback = () => {
      if (cancelled) return;
      setState({ path: [[from.lat, from.lon], [to.lat, to.lon]], roadFollowing: false });
      onInfo?.({ distanceM: haversineM(from, to), durationS: 0, roadFollowing: false });
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    fetch(
      `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`,
      { signal: controller.signal }
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("routing service error"))))
      .then((data) => {
        const route = data?.routes?.[0];
        const coords = route?.geometry?.coordinates;
        if (cancelled) return;
        if (Array.isArray(coords) && coords.length > 1) {
          setState({ path: coords.map(([lon, lat]: [number, number]) => [lat, lon]), roadFollowing: true });
          onInfo?.({ distanceM: route.distance, durationS: route.duration, roadFollowing: true });
        } else {
          fallback();
        }
      })
      .catch(() => fallback())
      .finally(() => clearTimeout(timeout));

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from?.lon, from?.lat, to?.lon, to?.lat]);

  return state;
}

/**
 * Leaflet + raw OSM raster tiles instead of the original design's MapLibre + vector tiles —
 * zero-config, no tile-provider account needed (Technical_Debt_Plan.md, TD-03).
 */
export function MapView({
  center,
  points,
  className,
  route,
  onRouteInfo,
  zoom = 14,
  interactive = true,
}: {
  center: { lon: number; lat: number };
  points: MapPoint[];
  className?: string;
  route?: { from: RouteEndpoint; to: RouteEndpoint };
  onRouteInfo?: (info: RouteInfo) => void;
  /** Lets a route map zoom in as the two points get closer together (RoutePanel computes this
   * from live distance) instead of sitting at one fixed zoom regardless of scale. */
  zoom?: number;
  /** false for a small preview meant to be wrapped in a "tap to enlarge" button — disables
   * Leaflet's own pan/zoom handlers so they don't fight the button's click, and so scrolling
   * the page past a small map doesn't accidentally zoom it. The enlarged lightbox stays fully
   * interactive. */
  interactive?: boolean;
}) {
  const routeState = useRoute(route?.from, route?.to, onRouteInfo);

  return (
    <div className={className}>
      <MapContainer
        center={[center.lat, center.lon]}
        zoom={zoom}
        style={{ height: "100%", width: "100%" }}
        dragging={interactive}
        scrollWheelZoom={interactive}
        touchZoom={interactive}
        doubleClickZoom={interactive}
        boxZoom={interactive}
        keyboard={interactive}
        zoomControl={interactive}
        attributionControl={interactive}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Recenter lon={center.lon} lat={center.lat} zoom={zoom} />
        {routeState && (
          <Polyline
            positions={routeState.path}
            pathOptions={{
              color: "#2F7CEC",
              weight: 4,
              opacity: 0.75,
              // Dashed = straight-line fallback (routing service unreachable), not a real road route.
              dashArray: routeState.roadFollowing ? undefined : "2 10",
            }}
          />
        )}
        <CircleMarker
          center={[center.lat, center.lon]}
          radius={8}
          pathOptions={{ color: "#fff", weight: 3, fillColor: "#2F7CEC", fillOpacity: 1 }}
        >
          <Popup>You are here</Popup>
        </CircleMarker>
        {points.map((p) => (
          <CircleMarker
            key={p.id}
            center={[p.lat, p.lon]}
            radius={9}
            pathOptions={{ color: "#fff", weight: 2, fillColor: p.color, fillOpacity: 1 }}
          >
            <Popup>{p.popup ?? p.label}</Popup>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  );
}
