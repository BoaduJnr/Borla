import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../hooks/AuthContext";
import { useSocket } from "../hooks/SocketContext";
import { useGeolocation, FALLBACK_COORDS } from "../hooks/useGeolocation";
import { useAutoDismiss } from "../hooks/useAutoDismiss";
import { MapView, type MapPoint } from "../components/MapView";
import { RoutePanel } from "../components/RoutePanel";
import { StatusChip } from "./HouseholdHome";
import { RequestReviews } from "../components/RequestReviews";
import { IconPower, IconPhone } from "../components/Icon";
import { Avatar } from "../components/Avatar";
import { haversineM, formatDistance } from "../utils/geo";

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
  arrived_at: string | null;
  cancelled_by: string | null;
  household_id: string;
  household_name: string | null;
  household_lon: number | null;
  household_lat: number | null;
  can_mark_arrived: boolean;
  // Where this collector was the instant they accepted (server-side snapshot) — compared
  // against their own current live-watched position (`center`) to show "how far you've
  // travelled since accepting". Straight-line displacement, not a real path length; null if
  // accepted before this existed, or the collector had never gone online yet at accept time.
  accept_lon: number | null;
  accept_lat: number | null;
}

// Widened from the original 25s/12s/8s (Redis command-quota + per-identity rate-limit pressure —
// see the concurrent-user assessment this followed from). HEARTBEAT_MS must stay safely under
// presence.ts's 45s `presence:{id}` TTL or a slow tick would let the key itself expire between
// heartbeats; 35s keeps a comfortable margin. The poll intervals below are now a safety-net/
// catch-up mechanism (reconnect gaps, distance recompute) rather than the primary update path —
// every state transition they'd otherwise catch already arrives near-instantly over the socket
// (request:new/accepted/rejected/arrived/cancelled, broadcast:new/cleared below).
const HEARTBEAT_MS = 35_000;

type Tab = "home" | "requests" | "history";
const TERMINAL = ["rejected", "timed_out", "cancelled"];

export default function CollectorHome() {
  const { user, profile, refreshProfile } = useAuth();
  const socket = useSocket();
  const { coords } = useGeolocation(true); // watch — needed while roaming online
  const center = coords ?? FALLBACK_COORDS;

  const [tab, setTab] = useState<Tab>("home");
  const [online, setOnline] = useState<boolean>(Boolean(profile?.online));
  const [pins, setPins] = useState<Pin[]>([]);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Record<string, string>>({});
  const [routeDistances, setRouteDistances] = useState<Record<string, number>>({});
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useAutoDismiss(info, setInfo);
  useAutoDismiss(error, setError);

  async function loadPins() {
    if (!online) return;
    try {
      const data = await api<{ pins: Pin[] }>(`/pins/nearby?lon=${center.lon}&lat=${center.lat}&radius=1500`);
      setPins(data.pins);
    } catch {
      /* ignore transient */
    }
  }
  // The socket-listener effect below only re-subscribes when `socket`'s identity changes (once
  // per login session — see SocketContext.tsx), so a plain closure over loadPins there would
  // freeze `online`/`center` at whatever they were on that one render (very likely `online:false`,
  // before the collector ever taps "Go online"). Routing the broadcast:new push through this ref
  // instead means it always calls the *current* loadPins, not a stale one that silently no-ops
  // forever after the collector goes online.
  const loadPinsRef = useRef(loadPins);
  loadPinsRef.current = loadPins;

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
    const t = setInterval(loadRequests, 20000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    loadPins();
    const t = online ? setInterval(loadPins, 20000) : null;
    return () => {
      if (t) clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, center.lon, center.lat]);

  useEffect(() => {
    if (!socket) return;
    const onNewRequest = () => loadRequests();
    // Previously reused onNewRequest here (a stale comment claimed this "triggers a pin refresh
    // via loadPins on next tick", but the handler only ever called loadRequests() — a broadcast
    // notification was refetching the wrong list and the new pin actually waited for the next
    // poll tick to appear). Calling loadPins() directly is what makes this a real push instead of
    // a no-op that happened to be masked by the old 12s poll.
    const onNewBroadcast = () => loadPinsRef.current();
    const onCleared = (payload: { broadcastId: string }) =>
      setPins((p) => p.filter((pin) => pin.id !== payload.broadcastId));
    const onArrived = () => {
      setInfo("🎉 Arrival confirmed — the household has been notified by SMS.");
      loadRequests();
    };
    const onCancelled = (payload: { cancelledBy: string }) => {
      setInfo(payload.cancelledBy === "household" ? "The household cancelled this request." : "Request cancelled.");
      loadRequests();
    };
    socket.on("request:new", onNewRequest);
    socket.on("broadcast:new", onNewBroadcast);
    socket.on("broadcast:cleared", onCleared);
    socket.on("request:arrived", onArrived);
    socket.on("request:cancelled", onCancelled);
    return () => {
      socket.off("request:new", onNewRequest);
      socket.off("broadcast:new", onNewBroadcast);
      socket.off("broadcast:cleared", onCleared);
      socket.off("request:arrived", onArrived);
      socket.off("request:cancelled", onCancelled);
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

  async function cancelRequest(requestId: string) {
    setError(null);
    try {
      await api(`/requests/${requestId}/cancel`, { method: "POST" });
      loadRequests();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not cancel");
    }
  }

  async function markArrived(requestId: string) {
    setError(null);
    try {
      await api(`/requests/${requestId}/arrived`, { method: "POST" });
      setInfo("🎉 Arrival confirmed — the household has been notified by SMS.");
      loadRequests();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not confirm arrival");
    }
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
  // Closest household first, kept current as the collector (or household) moves — see
  // RoutePanel's onDistanceChange, HouseholdHome has the same pattern for its own request list.
  const active = requests
    .filter((r) => r.status === "accepted" && !r.arrived_at)
    .slice()
    .sort((a, b) => (routeDistances[a.id] ?? Infinity) - (routeDistances[b.id] ?? Infinity));
  const history = requests.filter((r) => TERMINAL.includes(r.status) || (r.status === "accepted" && r.arrived_at));

  return (
    <div className="content stack">
      <div className="spread">
        <div className="row">
          <Avatar name={user?.display_name} role="collector" />
          <h2 className="h-disp" style={{ fontSize: 22 }}>
            Hi{user?.display_name ? `, ${user.display_name}` : ""}
          </h2>
        </div>
        <span className={`tag-chip ${online ? "t-green" : "t-coral"}`}>{online ? "Online" : "Offline"}</span>
      </div>

      <div className="row">
        <button className={`btn btn-sm ${tab === "home" ? "btn-dark" : "btn-ghost"}`} onClick={() => setTab("home")}>
          Home
        </button>
        <button className={`btn btn-sm ${tab === "requests" ? "btn-dark" : "btn-ghost"}`} onClick={() => setTab("requests")}>
          Requests{pending.length + active.length > 0 ? ` (${pending.length + active.length})` : ""}
        </button>
        <button className={`btn btn-sm ${tab === "history" ? "btn-dark" : "btn-ghost"}`} onClick={() => setTab("history")}>
          History
        </button>
      </div>

      {error && (
        <div className="banner err row" style={{ justifyContent: "space-between" }}>
          <span>{error}</span>
          <button type="button" className="btn btn-ghost btn-sm" style={{ padding: "4px 10px" }} onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {info && (
        <div className="banner ok row" style={{ justifyContent: "space-between" }}>
          <span>{info}</span>
          <button type="button" className="btn btn-ghost btn-sm" style={{ padding: "4px 10px" }} onClick={() => setInfo(null)}>
            Dismiss
          </button>
        </div>
      )}
      {!user?.verified && (
        <div className="banner">Your collector account is awaiting admin verification before you can go online.</div>
      )}

      {tab === "home" && (
        <>
      {!online && (
        <div className="stack" style={{ alignItems: "center", padding: "18px 0" }}>
          <button className="power-dial" onClick={toggleOnline} aria-label="Go online">
            <IconPower size={38} color="#2A1C00" />
            <b className="h-disp" style={{ fontSize: 15, marginTop: 6 }}>
              Go online
            </b>
          </button>
          <p className="muted" style={{ fontSize: 12.5, maxWidth: 240, textAlign: "center" }}>
            Going online shares your live location so nearby waste alerts reach you.
          </p>
        </div>
      )}

      <div className="map-wrap hero full-bleed">
        <MapView center={center} points={points} className="map-fill" />
        {online && (
          <button
            className="power-dial online map-overlay-btn"
            onClick={toggleOnline}
            aria-label="Go offline"
            style={{ width: 64, height: 64, left: "50%", bottom: 14, transform: "translateX(-50%)" }}
          >
            <IconPower size={22} />
          </button>
        )}
      </div>

      <h3 className="h-disp" style={{ fontSize: 16 }}>
        Nearby waste ({pins.length})
      </h3>
      <div className="stack">
        {pins.length === 0 && <p className="muted">{online ? "No active pins nearby." : "Go online to see nearby waste."}</p>}
        {pins.map((p) => (
          <div key={p.id} className="card row" style={{ justifyContent: "space-between" }}>
            <Avatar name={p.household_name} role="household" size={36} />
            <div style={{ flex: 1 }}>
              <b>{p.household_name ?? "Household"}</b>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {Math.round(p.distance_m)}m · {p.waste_type ?? "unspecified"} {p.note ? `· ${p.note}` : ""}
              </div>
            </div>
            <a className="btn btn-green btn-sm" href={`tel:${p.household_phone}`}>
              <IconPhone size={16} color="#fff" /> Call
            </a>
          </div>
        ))}
      </div>
        </>
      )}

      {tab === "requests" && (
        <>
      {pending.length > 0 && (
        <>
          <h3 className="h-disp" style={{ fontSize: 16 }}>
            Incoming requests
          </h3>
          <div className="stack">
            {pending.map((r) => (
              <div key={r.id} className="card stack">
                <div className="spread">
                  <div className="row">
                    <Avatar name={r.household_name} role="household" size={32} />
                    <b>{r.household_name ?? "Household"}</b>
                  </div>
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

      {active.length > 0 && (
        <>
          <h3 className="h-disp" style={{ fontSize: 16 }}>
            On the way
          </h3>
          <div className="stack">
            {active.map((r) => (
              <CollectorRequestCard
                key={r.id}
                r={r}
                center={center}
                reveal={reveal}
                onRevealContact={revealContact}
                onCancel={cancelRequest}
                onArrived={markArrived}
                onDistanceChange={(m) => setRouteDistances((d) => ({ ...d, [r.id]: m }))}
              />
            ))}
          </div>
        </>
      )}
      {pending.length === 0 && active.length === 0 && <p className="muted">No active requests.</p>}
        </>
      )}

      {tab === "history" && (
        <div className="stack">
          {history.length === 0 && <p className="muted">Nothing here yet.</p>}
          {history.map((r) => (
            <CollectorRequestCard key={r.id} r={r} center={center} reveal={reveal} onRevealContact={revealContact} isHistory />
          ))}
        </div>
      )}
    </div>
  );
}

function CollectorRequestCard({
  r,
  center,
  reveal,
  onRevealContact,
  onCancel,
  onArrived,
  onDistanceChange,
  isHistory,
}: {
  r: RequestRow;
  center: { lon: number; lat: number };
  reveal: Record<string, string>;
  onRevealContact: (id: string) => void;
  onCancel?: (id: string) => void;
  onArrived?: (id: string) => void;
  onDistanceChange?: (distanceM: number) => void;
  /** In History, the route is gone (nothing left to navigate to) and the conversation is frozen —
   * shown only on request, mirroring HouseholdHome's HouseholdRequestCard. */
  isHistory?: boolean;
}) {
  const arrived = Boolean(r.arrived_at);
  const [showChat, setShowChat] = useState(false);
  return (
    <div className="card stack">
      <div className="spread">
        <b>{r.household_name ?? "Household"}</b>
        <StatusChip status={r.status} arrived={arrived} />
      </div>
      {r.status === "accepted" && (
        <div>
          {reveal[r.id] ? (
            <a className="btn btn-green btn-sm" href={`tel:${reveal[r.id]}`}>
              <IconPhone size={16} color="#fff" /> Call {reveal[r.id]}
            </a>
          ) : (
            <button className="btn btn-green btn-sm" onClick={() => onRevealContact(r.id)}>
              Show contact
            </button>
          )}
          {!isHistory && r.household_lon != null && r.household_lat != null && (
            <RoutePanel
              from={center}
              to={{ lon: r.household_lon, lat: r.household_lat }}
              label={r.household_name ?? "household"}
              onDistanceChange={onDistanceChange}
            />
          )}
          {!isHistory && r.accept_lon != null && r.accept_lat != null && (
            <p className="muted" style={{ fontSize: 12 }}>
              You've travelled {formatDistance(haversineM({ lon: r.accept_lon, lat: r.accept_lat }, center))} since accepting
            </p>
          )}
          {!isHistory && onArrived && r.can_mark_arrived && (
            <button className="btn btn-gold btn-sm" style={{ marginTop: 8 }} onClick={() => onArrived(r.id)}>
              I've arrived
            </button>
          )}
          {isHistory ? (
            <>
              <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => setShowChat((s) => !s)}>
                {showChat ? "Hide conversation" : "View conversation"}
              </button>
              {showChat && <RequestReviews requestId={r.id} subjectId={r.household_id} canReview={false} interactive={false} />}
            </>
          ) : (
            <RequestReviews requestId={r.id} subjectId={r.household_id} canReview interactive />
          )}
          {onCancel && (
            <button className="btn btn-coral btn-sm" style={{ marginTop: 8 }} onClick={() => onCancel(r.id)}>
              Cancel request
            </button>
          )}
        </div>
      )}
      {r.status === "cancelled" && (
        <p className="muted">{r.cancelled_by === "household" ? "The household cancelled this." : "You cancelled this."}</p>
      )}
    </div>
  );
}
