import { useRegisterSW } from "virtual:pwa-register/react";
import { IconCheck } from "../components/Icon";

/**
 * Real PWA update behaviour (Technical_Debt_Plan.md TD-04): a new deployed build doesn't
 * silently swap content under an open tab. The service worker downloads the new version in the
 * background, then this banner offers an explicit "Update" action — click it and the new
 * version takes over and reloads. Until then, the tab keeps running the version it loaded with,
 * which is the safer default (`registerType: 'prompt'` in vite.config.ts, not 'autoUpdate').
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      // Poll for a new service worker periodically so a tab left open for a long time still
      // eventually notices a new deploy, without needing a full reload to find out.
      if (!registration) return;
      setInterval(() => {
        registration.update().catch(() => {});
      }, 60 * 60 * 1000);
    },
  });

  if (offlineReady && !needRefresh) {
    return (
      <div
        className="banner ok row"
        style={{ position: "fixed", left: 16, right: 16, bottom: 78, zIndex: 50, gap: 6 }}
      >
        <IconCheck size={14} color="var(--green)" />
        <span>Borla is ready to work offline.</span>
        <button
          className="btn btn-ghost btn-sm"
          style={{ marginLeft: "auto", padding: "4px 10px" }}
          onClick={() => setOfflineReady(false)}
        >
          Dismiss
        </button>
      </div>
    );
  }

  if (needRefresh) {
    return (
      <div
        className="banner row"
        style={{ position: "fixed", left: 16, right: 16, bottom: 78, zIndex: 50, gap: 10 }}
      >
        <span>A new version of Borla is available.</span>
        <button
          className="btn btn-green btn-sm"
          style={{ marginLeft: "auto" }}
          onClick={() => updateServiceWorker(true)}
        >
          Update
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setNeedRefresh(false)}>
          Later
        </button>
      </div>
    );
  }

  return null;
}
