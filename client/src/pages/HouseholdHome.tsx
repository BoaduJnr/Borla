import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../hooks/AuthContext";
import { useSocket } from "../hooks/SocketContext";
import { useGeolocation, FALLBACK_COORDS } from "../hooks/useGeolocation";
import { MapView, type MapPoint } from "../components/MapView";
import { RoutePanel } from "../components/RoutePanel";
import { RequestReviews } from "../components/RequestReviews";
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
  arrived_at: string | null;
  cancelled_by: string | null;
  collector_id: string;
  collector_name: string | null;
  collector_lon: number | null;
  collector_lat: number | null;
}

type Tab = "home" | "requests" | "history";
const TERMINAL = ["rejected", "timed_out", "cancelled"];

export default function HouseholdHome() {
  const { coords } = useGeolocation(false);
  const center = coords ?? FALLBACK_COORDS;
  const socket = useSocket();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("home");

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
  const [routeDistances, setRouteDistances] = useState<Record<string, number>>({});
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
    const onArrived = () => {
      setInfo("🎉 Your collector has arrived!");
      loadRequests();
    };
    const onCancelled = (payload: { cancelledBy: string }) => {
      setInfo(payload.cancelledBy === "collector" ? "The collector cancelled this request." : "Request cancelled.");
      loadRequests();
    };
    socket.on("request:seen", onUpdate);
    socket.on("request:accepted", onUpdate);
    socket.on("request:rejected", onUpdate);
    socket.on("request:timed_out", onUpdate);
    socket.on("request:arrived", onArrived);
    socket.on("request:cancelled", onCancelled);
    socket.on("broadcast:fanned_out", onFannedOut);
    return () => {
      socket.off("request:seen", onUpdate);
      socket.off("request:accepted", onUpdate);
      socket.off("request:rejected", onUpdate);
      socket.off("request:timed_out", onUpdate);
      socket.off("request:arrived", onArrived);
      socket.off("request:cancelled", onCancelled);
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

  async function cancelRequest(requestId: string) {
    try {
      await api(`/requests/${requestId}/cancel`, { method: "POST" });
      loadRequests();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not cancel");
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

  // Closest collector first — and kept current as collectors move, not just sorted once at load:
  // each card's RoutePanel reports its live road-route distance back up via onDistanceChange, so
  // this re-sorts on every route update rather than only reflecting distance at page-load time.
  const activeRequests = requests
    .filter((r) => !TERMINAL.includes(r.status) && !r.arrived_at)
    .slice()
    .sort((a, b) => (routeDistances[a.id] ?? Infinity) - (routeDistances[b.id] ?? Infinity));
  const historyRequests = requests.filter((r) => TERMINAL.includes(r.status) || r.arrived_at);

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

      <div className="row">
        <button className={`btn btn-sm ${tab === "home" ? "btn-dark" : "btn-ghost"}`} onClick={() => setTab("home")}>
          Home
        </button>
        <button className={`btn btn-sm ${tab === "requests" ? "btn-dark" : "btn-ghost"}`} onClick={() => setTab("requests")}>
          My requests{activeRequests.length > 0 ? ` (${activeRequests.length})` : ""}
        </button>
        <button className={`btn btn-sm ${tab === "history" ? "btn-dark" : "btn-ghost"}`} onClick={() => setTab("history")}>
          History
        </button>
      </div>

      {error && <div className="banner err">{error}</div>}
      {info && <div className="banner ok">{info}</div>}

      {tab === "home" && (
        <>
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
        </>
      )}

      {tab === "requests" && (
      <div className="stack">
        {activeRequests.length === 0 && <p className="muted">No active requests.</p>}
        {activeRequests.map((r) => (
          <HouseholdRequestCard
            key={r.id}
            r={r}
            center={center}
            reveal={reveal}
            onRevealContact={revealContact}
            onCancel={cancelRequest}
            onDistanceChange={(m) => setRouteDistances((d) => ({ ...d, [r.id]: m }))}
          />
        ))}
      </div>
      )}

      {tab === "history" && (
      <div className="stack">
        {historyRequests.length === 0 && <p className="muted">Nothing here yet.</p>}
        {historyRequests.map((r) => (
          <HouseholdRequestCard key={r.id} r={r} center={center} reveal={reveal} onRevealContact={revealContact} />
        ))}
      </div>
      )}
    </div>
  );
}

function HouseholdRequestCard({
  r,
  center,
  reveal,
  onRevealContact,
  onCancel,
  onDistanceChange,
}: {
  r: RequestRow;
  center: { lon: number; lat: number };
  reveal: Record<string, { phone: string; name: string | null }>;
  onRevealContact: (id: string) => void;
  onCancel?: (id: string) => void;
  onDistanceChange?: (distanceM: number) => void;
}) {
  const arrived = Boolean(r.arrived_at);
  return (
    <div className="card stack">
      <div className="spread">
        <div className="row">
          <Avatar name={r.collector_name} role="collector" size={32} />
          <b>{r.collector_name ?? "Collector"}</b>
        </div>
        <StatusChip status={r.status} arrived={arrived} />
      </div>
      {r.status === "accepted" && (
        <div>
          {reveal[r.id] ? (
            <a className="btn btn-green btn-sm" href={`tel:${reveal[r.id].phone}`}>
              <IconPhone size={16} color="#fff" /> Call {reveal[r.id].phone}
            </a>
          ) : (
            <button className="btn btn-green btn-sm" onClick={() => onRevealContact(r.id)}>
              Show contact
            </button>
          )}
          {r.collector_lon != null && r.collector_lat != null && (
            <RoutePanel
              from={center}
              to={{ lon: r.collector_lon, lat: r.collector_lat }}
              label={r.collector_name ?? "collector"}
              onDistanceChange={onDistanceChange}
            />
          )}
          <RequestReviews requestId={r.id} subjectId={r.collector_id} canReview />
          {onCancel && (
            <button className="btn btn-coral btn-sm" style={{ marginTop: 8 }} onClick={() => onCancel(r.id)}>
              Cancel request
            </button>
          )}
        </div>
      )}
      {(r.status === "requested" || r.status === "seen") && onCancel && (
        <button className="btn btn-coral btn-sm" onClick={() => onCancel(r.id)}>
          Cancel request
        </button>
      )}
      {r.status === "rejected" && <p className="muted">Try another collector.</p>}
      {r.status === "timed_out" && <p className="muted">No response — try another collector.</p>}
      {r.status === "cancelled" && (
        <p className="muted">{r.cancelled_by === "collector" ? "The collector cancelled this." : "You cancelled this."}</p>
      )}
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

export function StatusChip({ status, arrived }: { status: string; arrived?: boolean }) {
  if (status === "accepted" && arrived) return <span className="tag-chip t-green">Arrived</span>;
  const map: Record<string, [string, string]> = {
    requested: ["t-gold", "Sent"],
    seen: ["t-gold", "Seen"],
    accepted: ["t-green", "On the way"],
    rejected: ["t-coral", "Rejected"],
    timed_out: ["t-coral", "No response"],
    cancelled: ["t-coral", "Cancelled"],
  };
  const [cls, label] = map[status] ?? ["t-gold", status];
  return <span className={`tag-chip ${cls}`}>{label}</span>;
}
