import { usePushSubscription } from "./usePushSubscription";

/** Mirrors InstallButton's shape/placement — sits alongside it in Profile.tsx. */
export function PushToggle() {
  const { supported, needsIOSInstall, subscribed, busy, error, subscribe, unsubscribe } = usePushSubscription();

  if (!supported) return null;

  // iOS only delivers push to an installed Home-Screen PWA, never a plain Safari tab — showing
  // the normal "Enable notifications" button here would just fail silently (found live: worked
  // on a laptop browser, did nothing on an iPhone). Tell the user what to actually do instead of
  // offering a button that can't work yet.
  if (needsIOSInstall) {
    return (
      <p className="muted" style={{ fontSize: 12.5 }}>
        On iPhone/iPad, add Borla to your Home Screen first (Share → Add to Home Screen), then open it from there to turn on
        notifications.
      </p>
    );
  }

  return (
    <div className="stack" style={{ gap: 6 }}>
      {subscribed ? (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>✓ Notifications are on for this device.</p>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={unsubscribe}>
            Turn off
          </button>
        </div>
      ) : (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="muted" style={{ fontSize: 13 }}>
            Get notified even when Borla isn't open.
          </span>
          <button className="btn btn-dark btn-sm" disabled={busy} onClick={subscribe}>
            {busy ? "Enabling…" : "Enable notifications"}
          </button>
        </div>
      )}
      {error && (
        <p className="muted" style={{ fontSize: 12, color: "var(--coral)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
