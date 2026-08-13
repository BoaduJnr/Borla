import { useEffect, useState } from "react";
import { api } from "../api/client";
import { MapView, type MapPoint } from "../components/MapView";
import { FALLBACK_COORDS } from "../hooks/useGeolocation";

type Tab = "stats" | "map" | "users" | "moderation" | "audit" | "config";

export default function AdminDashboard() {
  const [tab, setTab] = useState<Tab>("stats");

  return (
    <div className="content stack">
      <h2 className="h-disp" style={{ fontSize: 22 }}>
        Admin — Ops console
      </h2>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {(["stats", "map", "users", "moderation", "audit", "config"] as Tab[]).map((t) => (
          <button
            key={t}
            className={`btn btn-sm ${tab === t ? "btn-dark" : "btn-ghost"}`}
            onClick={() => setTab(t)}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === "stats" && <StatsTab />}
      {tab === "map" && <LiveMapTab />}
      {tab === "users" && <UsersTab />}
      {tab === "moderation" && <ModerationTab />}
      {tab === "audit" && <AuditTab />}
      {tab === "config" && <ConfigTab />}
    </div>
  );
}

function StatsTab() {
  const [stats, setStats] = useState<any>(null);
  useEffect(() => {
    api("/admin/stats").then(setStats);
    const t = setInterval(() => api("/admin/stats").then(setStats), 15000);
    return () => clearInterval(t);
  }, []);
  if (!stats) return <p className="muted">Loading…</p>;

  const countBy = (rows: any[], key: string) => Object.fromEntries(rows.map((r) => [r[key], Number(r.count)]));
  const byRole = countBy(stats.usersByRole, "role");
  const byBroadcast = countBy(stats.broadcastsByStatus, "status");
  const byRequest = countBy(stats.requestsByStatus, "status");

  return (
    <div className="stack">
      <div className="kpis">
        <div className="kpi">
          <div className="k">Online collectors</div>
          <div className="v">{stats.onlineCollectors}</div>
        </div>
        <div className="kpi">
          <div className="k">Households</div>
          <div className="v">{byRole.household ?? 0}</div>
        </div>
        <div className="kpi">
          <div className="k">Collectors</div>
          <div className="v">{byRole.collector ?? 0}</div>
        </div>
        <div className="kpi">
          <div className="k">Moderation backlog</div>
          <div className="v">{stats.moderationBacklog}</div>
        </div>
      </div>
      <div className="grid2">
        <div className="card">
          <b>Broadcasts</b>
          <ul>
            {Object.entries(byBroadcast).map(([k, v]) => (
              <li key={k}>
                {k}: {v as number}
              </li>
            ))}
          </ul>
          <p className="muted" style={{ fontSize: 12 }}>
            Cleared vs expired is the wasted-trip proxy.
          </p>
        </div>
        <div className="card">
          <b>Requests</b>
          <ul>
            {Object.entries(byRequest).map(([k, v]) => (
              <li key={k}>
                {k}: {v as number}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function LiveMapTab() {
  const [data, setData] = useState<{ pins: any[]; collectors: any[] }>({ pins: [], collectors: [] });
  useEffect(() => {
    api("/admin/live-map").then(setData);
    const t = setInterval(() => api("/admin/live-map").then(setData), 15000);
    return () => clearInterval(t);
  }, []);

  const points: MapPoint[] = [
    ...data.pins.map((p) => ({ id: `pin-${p.id}`, lon: p.lon, lat: p.lat, color: "#F5A208", label: "Active pin" })),
    ...data.collectors.map((c) => ({
      id: `col-${c.id}`,
      lon: c.lon,
      lat: c.lat,
      color: "#0E6E4E",
      label: c.display_name ?? "Collector",
    })),
  ].filter((p) => p.lon != null && p.lat != null);

  const center = points[0] ? { lon: points[0].lon, lat: points[0].lat } : FALLBACK_COORDS;

  return (
    <div className="stack">
      <p className="muted row" style={{ fontSize: 12.5, gap: 14 }}>
        <span className="row" style={{ gap: 6 }}>
          <i className="legend-dot" style={{ background: "var(--marigold)" }} /> Active broadcast pins
        </span>
        <span className="row" style={{ gap: 6 }}>
          <i className="legend-dot" style={{ background: "var(--green)" }} /> Online collectors
        </span>
      </p>
      <div className="map-wrap tall">
        <MapView center={center} points={points} className="map-wrap tall" />
      </div>
    </div>
  );
}

function UsersTab() {
  const [users, setUsers] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");

  async function load() {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (role) params.set("role", role);
    const data = await api<{ users: any[] }>(`/admin/users?${params}`);
    setUsers(data.users);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function act(id: string, action: "verify" | "suspend" | "reinstate") {
    await api(`/admin/users/${id}/${action}`, { method: "POST", body: action === "suspend" ? { reason: "admin action" } : undefined });
    load();
  }

  return (
    <div className="stack">
      <div className="row">
        <input className="field" placeholder="Search phone/name" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="field" value={role} onChange={(e) => setRole(e.target.value)} style={{ width: 160 }}>
          <option value="">All roles</option>
          <option value="household">Household</option>
          <option value="collector">Collector</option>
          <option value="admin">Admin</option>
        </select>
        <button className="btn btn-dark btn-sm" onClick={load}>
          Search
        </button>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Phone</th>
              <th>Role</th>
              <th>Name</th>
              <th>Verified</th>
              <th>Suspended</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.phone}</td>
                <td>{u.role}</td>
                <td>{u.display_name ?? "—"}</td>
                <td>{u.verified ? "✓" : "—"}</td>
                <td>{u.suspended ? "✓" : "—"}</td>
                <td className="row">
                  {u.role === "collector" && !u.verified && (
                    <button className="btn btn-green btn-sm" onClick={() => act(u.id, "verify")}>
                      Verify
                    </button>
                  )}
                  {!u.suspended ? (
                    <button className="btn btn-coral btn-sm" onClick={() => act(u.id, "suspend")}>
                      Suspend
                    </button>
                  ) : (
                    <button className="btn btn-ghost btn-sm" onClick={() => act(u.id, "reinstate")}>
                      Reinstate
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ModerationTab() {
  const [queue, setQueue] = useState<{ flags: any[]; awaitingManual: any[] }>({ flags: [], awaitingManual: [] });
  async function load() {
    setQueue(await api("/admin/moderation/queue"));
  }
  useEffect(() => {
    load();
  }, []);

  async function resolveFlag(id: string, action: "remove" | "clear") {
    await api(`/admin/moderation/flags/${id}/resolve`, { method: "POST", body: { action } });
    load();
  }
  async function approve(id: string) {
    await api(`/admin/reviews/${id}/approve`, { method: "POST" });
    load();
  }

  return (
    <div className="stack">
      <div className="card stack">
        <b>AI-flagged / user-reported ({queue.flags.length})</b>
        {queue.flags.length === 0 && <p className="muted">Nothing flagged.</p>}
        {queue.flags.map((f) => (
          <div key={f.id} className="card stack">
            <div className="spread">
              <span className="tag-chip t-coral">{f.source}</span>
              <span className="muted" style={{ fontSize: 12 }}>
                {f.reason} {f.score ? `(${f.score})` : ""}
              </span>
            </div>
            <p>{f.text}</p>
            <div className="row">
              <button className="btn btn-green btn-sm" onClick={() => resolveFlag(f.id, "clear")}>
                Clear (keep visible)
              </button>
              <button className="btn btn-coral btn-sm" onClick={() => resolveFlag(f.id, "remove")}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="card stack">
        <b>Awaiting moderation ({queue.awaitingManual.length})</b>
        <p className="muted" style={{ fontSize: 12 }}>
          Items land here whenever AI screening doesn't return a confident verdict — review each
          one below.
        </p>
        {queue.awaitingManual.length === 0 && <p className="muted">Nothing pending.</p>}
        {queue.awaitingManual.map((item) => (
          <div key={item.id} className="card stack">
            <span className="tag-chip t-gold">{item.target_type}</span>
            <p>{item.text}</p>
            {item.target_type === "review" && (
              <button className="btn btn-green btn-sm" onClick={() => approve(item.id)}>
                Approve
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function AuditTab() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    api<{ auditLog: any[] }>("/admin/audit-log").then((d) => setRows(d.auditLog));
  }, []);
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Admin</th>
            <th>Action</th>
            <th>Target</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.created_at).toLocaleString()}</td>
              <td>{r.admin_name ?? "—"}</td>
              <td>{r.action}</td>
              <td style={{ fontFamily: "monospace", fontSize: 11 }}>{r.target_id ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Plain-English labels for the raw app_config keys (server/migrations/001_init.sql) — an admin
// tuning these live shouldn't need to know the underlying column name to know what it does.
const CONFIG_META: Record<string, { label: string; description: string; unit: string }> = {
  broadcast_radius_m: {
    label: "Broadcast radius",
    description: "How far a household's pin reaches nearby online collectors.",
    unit: "metres",
  },
  pin_ttl_minutes: {
    label: "Pin expiry",
    description: "How long an uncleared broadcast pin stays active before it auto-expires.",
    unit: "minutes",
  },
  request_timeout_seconds: {
    label: "Request timeout",
    description: "How long a collector has to respond before a direct request times out.",
    unit: "seconds",
  },
  review_window_days: {
    label: "Review window",
    description: "How long to wait for both sides to review before releasing a solo review anyway.",
    unit: "days",
  },
  notif_cap_per_10min: {
    label: "Notification cap",
    description: "The most broadcast alerts one collector can receive in a 10-minute window.",
    unit: "per 10 min",
  },
  arrival_radius_m: {
    label: "Arrival radius",
    description: "How close a collector's live position must get to the pickup point to be marked arrived.",
    unit: "metres",
  },
};

function ConfigTab() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    api<{ config: any[] }>("/admin/config").then((d) => setRows(d.config));
  }, []);

  async function update(key: string, value: string) {
    const num = Number(value);
    await api(`/admin/config/${key}`, { method: "PATCH", body: { value: Number.isNaN(num) ? value : num } });
  }

  return (
    <div className="stack">
      <p className="muted" style={{ fontSize: 12.5 }}>
        Live-tunable settings — changes apply without a redeploy.
      </p>
      {rows.map((r) => {
        const meta = CONFIG_META[r.key];
        return (
          <div key={r.key} className="card row" style={{ justifyContent: "space-between" }}>
            <div>
              <b>{meta?.label ?? r.key}</b>
              {meta && (
                <div className="muted" style={{ fontSize: 12 }}>
                  {meta.description}
                </div>
              )}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <input
                className="field"
                style={{ width: 90 }}
                defaultValue={r.value}
                onBlur={(e) => update(r.key, e.target.value)}
              />
              {meta && <span className="muted" style={{ fontSize: 12 }}>{meta.unit}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
