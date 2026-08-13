import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../hooks/AuthContext";
import { useSocket } from "../hooks/SocketContext";
import { useGeolocation, FALLBACK_COORDS } from "../hooks/useGeolocation";
import { MapView, type MapPoint } from "../components/MapView";
import { StatusChip } from "./HouseholdHome";
import { ReviewForm } from "../components/ReviewForm";

interface Pin {
  id: string;
  lon: number;
  lat: number;
  waste_type: string | null;
  note: string | null;
  household_name: string | null;
  household_phone: string;
  distance_m: number;
}

interface RequestRow {
  id: string;
  status: string;
  waste_type: string | null;
  note: string | null;
  requested_at: string;
  household_id: string;
  household_name: string | null;
}

const HEARTBEAT_MS = 25_000;

export default function CollectorHome() {
  const { user, profile, refreshProfile } = useAuth();
  const socket = useSocket();
  const { coords } = useGeolocation(true); // watch — needed while roaming online
  const center = coords ?? FALLBACK_COORDS;

  const [online, setOnline] = useState<boolean>(Boolean(profile?.online));
  const [pins, setPins] = useState<Pin[]>([]);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Record<string, string>>({});
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function loadPins() {
    if (!online) return;
    try {
      const data = await api<{ pins: Pin[] }>(`/pins/nearby?lon=${center.lon}&lat=${center.lat}&radius=1500`);
      setPins(data.pins);
    } catch {
      /* ignore transient */
    }
  }

  async function loadRequests() {
    try {
      const data = await api<{ requests: RequestRow[] }>("/requests/mine");
      setRequests(data.requests);
      for (const r of data.requests) {
        if (r.status === "requested") void api(`/requests/${r.id}/seen`, { method: "POST" }).catch(() => null);
      }
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    loadRequests();
    const t = setInterval(loadRequests, 8000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    loadPins();
    const t = online ? setInterval(loadPins, 12000) : null;
    return () => {
      if (t) clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, center.lon, center.lat]);

  useEffect(() => {
    if (!socket) return;
    const onNew = () => loadRequests();
    const onCleared = (payload: { broadcastId: string }) =>
      setPins((p) => p.filter((pin) => pin.id !== payload.broadcastId));
    socket.on("request:new", onNew);
    socket.on("broadcast:new", onNew); // cheap: just triggers a pin refresh via loadPins on next tick
    socket.on("broadcast:cleared", onCleared);
    return () => {
      socket.off("request:new", onNew);
      socket.off("broadcast:new", onNew);
      socket.off("broadcast:cleared", onCleared);
    };
  }, [socket]);

  async function toggleOnline() {
    setError(null);
    if (!user?.verified) {
      setError("Your account is not verified yet — an admin must approve you before you can go online.");
      return;
    }
    try {
      if (!online) {
        await api("/presence", { method: "POST", body: { online: true, lon: center.lon, lat: center.lat } });
        setOnline(true);
        heartbeatRef.current = setInterval(() => {
          api("/presence/heartbeat", { method: "POST", body: { lon: center.lon, lat: center.lat } }).catch(() => null);
        }, HEARTBEAT_MS);
      } else {
        await api("/presence", { method: "POST", body: { online: false } });
        setOnline(false);
        if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      }
      refreshProfile();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update presence");
    }
  }

  useEffect(() => () => {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
  }, []);

  async function respond(requestId: string, action: "accept" | "reject") {
    await api(`/requests/${requestId}/${action}`, { method: "POST" });
    loadRequests();
  }

  async function revealContact(requestId: string) {
    const data = await api<{ request: any }>(`/requests/${requestId}`);
    setReveal((r) => ({ ...r, [requestId]: data.request.household_phone }));
  }

  const points: MapPoint[] = pins.map((p) => ({
    id: p.id,
    lon: p.lon,
    lat: p.lat,
    color: "#F5A208",
    label: p.household_name ?? "Waste pin",
    popup: `${p.household_name ?? "Household"} · ${Math.round(p.distance_m)}m · ${p.waste_type ?? "unspecified"}`,
  }));

  const pending = requests.filter((r) => r.status === "requested" || r.status === "seen");
  const resolved = requests.filter((r) => !["requested", "seen"].includes(r.status));

  return (
    <div className="content stack">
      <div className="spread">
        <h2 className="h-disp" style={{ fontSize: 22 }}>
          Hi{user?.display_name ? `, ${user.display_name}` : ""} 🚛
        </h2>
        <span className={`tag-chip ${online ? "t-green" : "t-coral"}`}>{online ? "Online" : "Offline"}</span>
      </div>

      {error && <div className="banner err">{error}</div>}
      {!user?.verified && (
        <div className="banner">Your collector account is awaiting admin verification before you can go online.</div>
      )}

      <button className={`btn ${online ? "btn-coral" : "btn-green"}`} onClick={toggleOnline}>
        {online ? "Go offline" : "Go online"}
      </button>

      <div className="map-wrap tall">
        <MapView center={center} points={points} className="map-wrap tall" />
      </div>

      {pending.length > 0 && (
        <>
          <h3 className="h-disp" style={{ fontSize: 16 }}>
            Incoming requests
          </h3>
          <div className="stack">
            {pending.map((r) => (
              <div key={r.id} className="card stack">
                <div className="spread">
                  <b>{r.household_name ?? "Household"}</b>
                  <StatusChip status={r.status} />
                </div>
                {r.note && <p className="muted">{r.note}</p>}
                <div className="row">
                  <button className="btn btn-green btn-sm" onClick={() => respond(r.id, "accept")}>
                    Accept
                  </button>
                  <button className="btn btn-coral btn-sm" onClick={() => respond(r.id, "reject")}>
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <h3 className="h-disp" style={{ fontSize: 16 }}>
        Nearby waste ({pins.length})
      </h3>
      <div className="stack">
        {pins.length === 0 && <p className="muted">{online ? "No active pins nearby." : "Go online to see nearby waste."}</p>}
        {pins.map((p) => (
          <div key={p.id} className="card row" style={{ justifyContent: "space-between" }}>
            <div>
              <b>{p.household_name ?? "Household"}</b>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {Math.round(p.distance_m)}m · {p.waste_type ?? "unspecified"} {p.note ? `· ${p.note}` : ""}
              </div>
            </div>
            <a className="btn btn-green btn-sm" href={`tel:${p.household_phone}`}>
              📞 Call
            </a>
          </div>
        ))}
      </div>

      {resolved.length > 0 && (
        <>
          <h3 className="h-disp" style={{ fontSize: 16 }}>
            Recent requests
          </h3>
          <div className="stack">
            {resolved.map((r) => (
              <div key={r.id} className="card stack">
                <div className="spread">
                  <b>{r.household_name ?? "Household"}</b>
                  <StatusChip status={r.status} />
                </div>
                {r.status === "accepted" && (
                  <div>
                    {reveal[r.id] ? (
                      <a className="btn btn-green btn-sm" href={`tel:${reveal[r.id]}`}>
                        📞 Call {reveal[r.id]}
                      </a>
                    ) : (
                      <button className="btn btn-green btn-sm" onClick={() => revealContact(r.id)}>
                        Show contact
                      </button>
                    )}
                    <div style={{ marginTop: 8 }}>
                      <ReviewForm requestId={r.id} subjectId={r.household_id} />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
