import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../hooks/AuthContext";
import { useSocket } from "../hooks/SocketContext";
import { useGeolocation, FALLBACK_COORDS } from "../hooks/useGeolocation";
import { MapView, type MapPoint } from "../components/MapView";
import { ReviewForm } from "../components/ReviewForm";
import { IconTrash, IconRecycle, IconLeaf, IconBox, IconPin, IconPhone } from "../components/Icon";
import { Avatar } from "../components/Avatar";
import { Stars } from "../components/Stars";

const WASTE_TYPES = [
  { id: "general", label: "General", Icon: IconTrash },
  { id: "recyclable", label: "Recyclable", Icon: IconRecycle },
  { id: "organic", label: "Organic", Icon: IconLeaf },
  { id: "bulky", label: "Bulky", Icon: IconBox },
] as const;

interface Broadcast {
  id: string;
  lon: number;
  lat: number;
  waste_type: string | null;
  note: string | null;
  status: string;
  created_at: string;
  expires_at: string;
}

interface RequestRow {
  id: string;
  status: string;
  waste_type: string | null;
  note: string | null;
  requested_at: string;
  responded_at: string | null;
  collector_id: string;
  collector_name: string | null;
}

export default function HouseholdHome() {
  const { coords } = useGeolocation(false);
  const center = coords ?? FALLBACK_COORDS;
  const socket = useSocket();
  const { user } = useAuth();

  const [collectors, setCollectors] = useState<any[]>([]);
  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [wasteType, setWasteType] = useState<string | undefined>(undefined);
  const [note, setNote] = useState("");
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [confirmPrompt, setConfirmPrompt] = useState<{ broadcastId: string } | null>(null);
  const [reveal, setReveal] = useState<Record<string, { phone: string; name: string | null }>>({});
  const lastBroadcastId = useRef<string | null>(null);

  async function loadNearbyCollectors() {
    try {
      const data = await api<{ collectors: any[] }>(
        `/collectors/nearby?lon=${center.lon}&lat=${center.lat}&radius=2000`
      );
      setCollectors(data.collectors);
    } catch {
      /* transient — next poll retries */
    }
  }

  async function loadActiveBroadcast() {
    try {
      const data = await api<{ broadcast: Broadcast | null }>("/broadcasts/me/active");
      if (!data.broadcast && lastBroadcastId.current) {
        setConfirmPrompt({ broadcastId: lastBroadcastId.current });
        lastBroadcastId.current = null;
      }
      setBroadcast(data.broadcast);
      if (data.broadcast) lastBroadcastId.current = data.broadcast.id;
    } catch {
      /* ignore */
    }
  }

  async function loadRequests() {
    try {
      const data = await api<{ requests: RequestRow[] }>("/requests/mine");
      setRequests(data.requests);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    loadNearbyCollectors();
    loadActiveBroadcast();
    loadRequests();
    const t1 = setInterval(loadNearbyCollectors, 15000);
    const t2 = setInterval(loadActiveBroadcast, 8000);
    const t3 = setInterval(loadRequests, 8000);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
      clearInterval(t3);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center.lon, center.lat]);

  useEffect(() => {
    if (!socket) return;
    const onUpdate = () => {
      loadRequests();
    };
    // Fan-out now runs as a BullMQ job (Technical_Debt_Plan.md TD-05), off the request thread —
    // the notified-count arrives over the socket once the job actually finishes, not in the
    // POST /broadcasts response itself.
    const onFannedOut = (payload: { broadcastId: string; notified: number }) => {
      setInfo(`Pin is live — ${payload.notified} nearby collector(s) notified.`);
    };
    socket.on("request:seen", onUpdate);
    socket.on("request:accepted", onUpdate);
    socket.on("request:rejected", onUpdate);
    socket.on("request:timed_out", onUpdate);
    socket.on("broadcast:fanned_out", onFannedOut);
    return () => {
      socket.off("request:seen", onUpdate);
      socket.off("request:accepted", onUpdate);
      socket.off("request:rejected", onUpdate);
      socket.off("request:timed_out", onUpdate);
      socket.off("broadcast:fanned_out", onFannedOut);
    };
  }, [socket]);

  async function submitBroadcast() {
    setError(null);
    try {
      await api("/broadcasts", {
        method: "POST",
        body: { lon: center.lon, lat: center.lat, wasteType, note: note || undefined },
      });
      setInfo("Pin is live — notifying nearby collectors…");
      setShowForm(false);
      setNote("");
      loadActiveBroadcast();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create broadcast");
    }
  }

  async function clearBroadcast() {
    if (!broadcast) return;
    await api(`/broadcasts/${broadcast.id}/clear`, { method: "POST" });
    loadActiveBroadcast();
  }

  async function sendRequest(collectorId: string) {
    setError(null);
    try {
      await api("/requests", {
        method: "POST",
        body: { collectorId, lon: center.lon, lat: center.lat, wasteType },
      });
      setInfo("Request sent.");
      loadRequests();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send request");
    }
  }

  async function revealContact(requestId: string) {
    const data = await api<{ request: any }>(`/requests/${requestId}`);
    setReveal((r) => ({ ...r, [requestId]: { phone: data.request.collector_phone, name: data.request.collector_name } }));
  }

  async function confirmPickup(came: boolean, collectorId?: string) {
    if (!confirmPrompt) return;
    await api("/confirmations", {
      method: "POST",
      body: { broadcastId: confirmPrompt.broadcastId, came, collectorId },
    }).catch(() => null);
    setConfirmPrompt(null);
  }

  const points: MapPoint[] = collectors.map((c) => ({
    id: c.id,
    lon: c.last_lon,
    lat: c.last_lat,
    color: "#0E6E4E",
    label: c.display_name ?? "Collector",
    popup: `${c.display_name ?? "Collector"} · ${Math.round(c.distance_m)}m away`,
  }));

  return (
    <div className="content stack">
      <h2 className="h-disp" style={{ fontSize: 22 }}>
        Hi{user?.display_name ? `, ${user.display_name}` : ""} 👋
      </h2>

      {error && <div className="banner err">{error}</div>}
      {info && <div className="banner ok">{info}</div>}

      <div className="map-wrap">
        <MapView center={center} points={points} className="map-wrap" />
      </div>

      {broadcast ? (
        <div className="banner stack">
          <div className="beacon-wrap">
            <div className="beacon">
              <div className="ring"></div>
              <div className="ring"></div>
              <div className="ring"></div>
              <div className="core"></div>
            </div>
          </div>
          <div className="row">
            <IconPin size={16} />
            <span>Your signal is out — someone coming? Tap to clear so others don't drive over.</span>
          </div>
          <button className="btn btn-coral" onClick={clearBroadcast}>
            Clear — someone's coming
          </button>
        </div>
      ) : showForm ? (
        <div className="card stack">
          <label>Waste type (optional)</label>
          <div className="grid2">
            {WASTE_TYPES.map((w) => (
              <button
                key={w.id}
                className={`type-tile ${wasteType === w.id ? "sel" : ""}`}
                onClick={() => setWasteType(wasteType === w.id ? undefined : w.id)}
              >
                <w.Icon color={wasteType === w.id ? "var(--green)" : "var(--ink)"} />
                {w.label}
              </button>
            ))}
          </div>
          <label>Note (optional)</label>
          <input className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. by the blue gate" />
          <button className="btn btn-gold" onClick={submitBroadcast}>
            Confirm — I have waste
          </button>
          <button className="btn btn-ghost" onClick={() => setShowForm(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button className="btn btn-gold" style={{ fontSize: 18, padding: 18 }} onClick={() => setShowForm(true)}>
          <IconTrash />
          I HAVE WASTE
        </button>
      )}

      {confirmPrompt && (
        <ConfirmPickup broadcastId={confirmPrompt.broadcastId} onDone={confirmPickup} />
      )}

      <h3 className="h-disp" style={{ fontSize: 16, marginTop: 10 }}>
        Nearby collectors ({collectors.length})
      </h3>
      <div className="stack">
        {collectors.length === 0 && <p className="muted">No collectors online nearby right now.</p>}
        {collectors.map((c) => (
          <div key={c.id} className="card row" style={{ justifyContent: "space-between" }}>
            <Avatar name={c.display_name} role="collector" />
            <div style={{ flex: 1 }}>
              <b>{c.display_name ?? "Collector"}</b>
              <div className="row muted" style={{ fontSize: 12.5, gap: 5 }}>
                {c.rating_avg && <Stars rating={c.rating_avg} size={11} />}
                <span>
                  {c.rating_avg ? `${c.rating_avg} · ` : ""}
                  {c.vehicle_type ?? "vehicle n/a"} · {Math.round(c.distance_m)}m away
                </span>
              </div>
            </div>
            <button className="btn btn-green btn-sm" onClick={() => sendRequest(c.id)}>
              Request
            </button>
          </div>
        ))}
      </div>

      <h3 className="h-disp" style={{ fontSize: 16, marginTop: 10 }}>
        My requests
      </h3>
      <div className="stack">
        {requests.length === 0 && <p className="muted">No requests yet.</p>}
        {requests.map((r) => (
          <div key={r.id} className="card stack">
            <div className="spread">
              <div className="row">
                <Avatar name={r.collector_name} role="collector" size={32} />
                <b>{r.collector_name ?? "Collector"}</b>
              </div>
              <StatusChip status={r.status} />
            </div>
            {r.status === "accepted" && (
              <div>
                {reveal[r.id] ? (
                  <a className="btn btn-green btn-sm" href={`tel:${reveal[r.id].phone}`}>
                    <IconPhone size={16} color="#fff" /> Call {reveal[r.id].phone}
                  </a>
                ) : (
                  <button className="btn btn-green btn-sm" onClick={() => revealContact(r.id)}>
                    Show contact
                  </button>
                )}
                <div style={{ marginTop: 8 }}>
                  <ReviewForm requestId={r.id} subjectId={r.collector_id} />
                </div>
              </div>
            )}
            {r.status === "rejected" && <p className="muted">Try another collector.</p>}
            {r.status === "timed_out" && <p className="muted">No response — try another collector.</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function ConfirmPickup({ broadcastId, onDone }: { broadcastId: string; onDone: (came: boolean, collectorId?: string) => void }) {
  const [collectors, setCollectors] = useState<{ id: string; display_name: string | null }[]>([]);
  useEffect(() => {
    api<{ collectors: any[] }>(`/broadcasts/${broadcastId}/notified`).then((d) => setCollectors(d.collectors));
  }, [broadcastId]);

  return (
    <div className="card stack banner">
      <b>Did someone come for your waste?</b>
      {collectors.length > 0 ? (
        <div className="stack">
          {collectors.map((c) => (
            <button key={c.id} className="btn btn-green btn-sm" onClick={() => onDone(true, c.id)}>
              Yes — {c.display_name ?? "this collector"} came
            </button>
          ))}
          <button className="btn btn-ghost" onClick={() => onDone(false)}>
            No one came
          </button>
        </div>
      ) : (
        <button className="btn btn-ghost" onClick={() => onDone(false)}>
          Dismiss
        </button>
      )}
    </div>
  );
}

export function StatusChip({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    requested: ["t-gold", "Sent"],
    seen: ["t-gold", "Seen"],
    accepted: ["t-green", "Accepted"],
    rejected: ["t-coral", "Rejected"],
    timed_out: ["t-coral", "No response"],
  };
  const [cls, label] = map[status] ?? ["t-gold", status];
  return <span className={`tag-chip ${cls}`}>{label}</span>;
}
