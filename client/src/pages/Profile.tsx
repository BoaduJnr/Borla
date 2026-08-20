import { useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../hooks/AuthContext";
import { useAutoDismiss } from "../hooks/useAutoDismiss";
import { Avatar } from "../components/Avatar";
import { Stars } from "../components/Stars";
import { InstallButton } from "../pwa/InstallButton";
import { useInstallPrompt } from "../pwa/useInstallPrompt";
import { PushToggle } from "../pwa/PushToggle";

export default function Profile() {
  const { user, profile, refreshProfile } = useAuth();
  const { installed } = useInstallPrompt();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useAutoDismiss(error, setError);
  useAutoDismiss(saved ? "saved" : null, () => setSaved(false));

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
      <div className="card row">
        <Avatar name={user.display_name} role={user.role === "collector" ? "collector" : "household"} size={56} />
        <div>
          <b>{user.display_name ?? "—"}</b>
          <div className="muted">{user.phone}</div>
          {profile?.rating_avg && (
            <div className="row" style={{ gap: 6, marginTop: 4 }}>
              <Stars rating={profile.rating_avg} />
              <span className="muted" style={{ fontSize: 12.5 }}>
                {profile.rating_avg} ({profile.rating_count} review{profile.rating_count === 1 ? "" : "s"})
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="card row" style={{ justifyContent: "space-between" }}>
        {!installed && (
          <span className="muted" style={{ fontSize: 13 }}>Add Borla to your home screen for one-tap access.</span>
        )}
        <InstallButton />
      </div>

      <div className="card">
        <PushToggle />
      </div>

      {error && (
        <div className="banner err row" style={{ justifyContent: "space-between" }}>
          <span>{error}</span>
          <button type="button" className="btn btn-ghost btn-sm" style={{ padding: "4px 10px" }} onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {saved && (
        <div className="banner ok row" style={{ justifyContent: "space-between" }}>
          <span>Saved.</span>
          <button type="button" className="btn btn-ghost btn-sm" style={{ padding: "4px 10px" }} onClick={() => setSaved(false)}>
            Dismiss
          </button>
        </div>
      )}

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
    </div>
  );
}
