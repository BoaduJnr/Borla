import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../hooks/AuthContext";

export default function Profile() {
  const { user, profile, refreshProfile } = useAuth();
  const [reviews, setReviews] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (user) api<{ reviews: any[] }>(`/users/${user.id}/reviews`).then((d) => setReviews(d.reviews));
  }, [user?.id]);

  if (!user) return null;

  async function saveHousehold(form: FormData) {
    setError(null);
    setSaved(false);
    try {
      await api("/households/me", {
        method: "PATCH",
        body: {
          alertRadiusM: Number(form.get("alertRadiusM")),
          alertsEnabled: form.get("alertsEnabled") === "on",
        },
      });
      setSaved(true);
      refreshProfile();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  async function saveCollector(form: FormData) {
    setError(null);
    setSaved(false);
    try {
      const wasteTypes = form.getAll("wasteTypes") as string[];
      await api("/collectors/me", {
        method: "PATCH",
        body: { vehicleType: String(form.get("vehicleType") || ""), wasteTypes },
      });
      setSaved(true);
      refreshProfile();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  return (
    <div className="content stack">
      <h2 className="h-disp" style={{ fontSize: 22 }}>
        Profile
      </h2>
      <div className="card stack">
        <div>
          <b>{user.display_name ?? "—"}</b>
          <div className="muted">{user.phone}</div>
        </div>
        {profile?.rating_avg && (
          <div className="stars">
            {"★".repeat(Math.round(profile.rating_avg))}
            {"☆".repeat(5 - Math.round(profile.rating_avg))}{" "}
            <span className="muted">
              {profile.rating_avg} ({profile.rating_count} review{profile.rating_count === 1 ? "" : "s"})
            </span>
          </div>
        )}
      </div>

      {error && <div className="banner err">{error}</div>}
      {saved && <div className="banner ok">Saved.</div>}

      {user.role === "household" && (
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            saveHousehold(new FormData(e.currentTarget));
          }}
        >
          <label>Alert radius (metres)</label>
          <input className="field" name="alertRadiusM" type="number" min={100} max={5000} defaultValue={profile?.alert_radius_m ?? 800} />
          <label className="row">
            <input type="checkbox" name="alertsEnabled" defaultChecked={profile?.alerts_enabled ?? true} />
            Alerts enabled
          </label>
          <button className="btn btn-green">Save</button>
        </form>
      )}

      {user.role === "collector" && (
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            saveCollector(new FormData(e.currentTarget));
          }}
        >
          <label>Vehicle type</label>
          <input className="field" name="vehicleType" defaultValue={profile?.vehicle_type ?? ""} placeholder="tricycle, pickup…" />
          <label>Waste types accepted</label>
          <div className="row">
            {["general", "recyclable", "organic", "bulky"].map((wt) => (
              <label key={wt} className="row" style={{ gap: 4 }}>
                <input type="checkbox" name="wasteTypes" value={wt} defaultChecked={profile?.waste_types?.includes(wt)} />
                {wt}
              </label>
            ))}
          </div>
          <button className="btn btn-green">Save</button>
        </form>
      )}

      <h3 className="h-disp" style={{ fontSize: 16 }}>
        Reviews received
      </h3>
      <div className="stack">
        {reviews.length === 0 && <p className="muted">No visible reviews yet.</p>}
        {reviews.map((r) => (
          <div key={r.id} className="card stack">
            <div className="spread">
              <b>{r.author_name ?? "Anonymous"}</b>
              <span className="stars">{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</span>
            </div>
            {r.comment && <p>{r.comment}</p>}
            {r.reply_body ? (
              <div className="card" style={{ background: "var(--paper)" }}>
                <b style={{ fontSize: 12.5 }}>Reply:</b> {r.reply_body}
              </div>
            ) : (
              <ReplyBox reviewId={r.id} onSent={() => setReviews((rs) => rs.map((x) => (x.id === r.id ? { ...x, reply_body: "(pending moderation)" } : x)))} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReplyBox({ reviewId, onSent }: { reviewId: string; onSent: () => void }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [sent, setSent] = useState(false);

  async function send() {
    await api(`/reviews/${reviewId}/reply`, { method: "POST", body: { body } }).catch(() => null);
    setSent(true);
    onSent();
  }

  if (sent) return <p className="muted" style={{ fontSize: 12 }}>Reply submitted (awaiting moderation).</p>;
  if (!open)
    return (
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        Reply
      </button>
    );
  return (
    <div className="row">
      <input className="field" value={body} onChange={(e) => setBody(e.target.value)} maxLength={500} placeholder="Your reply…" />
      <button className="btn btn-green btn-sm" onClick={send}>
        Send
      </button>
    </div>
  );
}
