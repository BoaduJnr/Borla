import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from "react-leaflet";
import { useEffect } from "react";
import "leaflet/dist/leaflet.css";

export interface MapPoint {
  id: string;
  lon: number;
  lat: number;
  color: string;
  label: string;
  popup?: string;
}

function Recenter({ lon, lat }: { lon: number; lat: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView([lat, lon], map.getZoom());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lon, lat]);
  return null;
}

/**
 * Leaflet + raw OSM raster tiles instead of the original design's MapLibre + vector tiles —
 * zero-config, no tile-provider account needed (Technical_Debt_Plan.md, TD-03).
 */
export function MapView({
  center,
  points,
  className,
}: {
  center: { lon: number; lat: number };
  points: MapPoint[];
  className?: string;
}) {
  return (
    <div className={className}>
      <MapContainer center={[center.lat, center.lon]} zoom={14} style={{ height: "100%", width: "100%" }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Recenter lon={center.lon} lat={center.lat} />
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
