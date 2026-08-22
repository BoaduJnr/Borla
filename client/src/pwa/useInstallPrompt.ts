import { useEffect, useState } from "react";
import { isStandalone } from "../utils/platform";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Real "Install app" behaviour (Technical_Debt_Plan.md TD-04) — Chrome/Edge/Android fire
 * `beforeinstallprompt` once the manifest+service-worker installability criteria are met; we
 * capture it (browsers only let you call .prompt() from a real user gesture, so it has to be
 * stashed here and fired later from a button click) and expose a simple install() action.
 * iOS Safari never fires this event — there, "Add to Home Screen" is a manual Share-sheet
 * action with no JS hook, so `canInstall` correctly stays false there.
 */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone);

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function install() {
    if (!deferred) return false;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    setDeferred(null);
    return outcome === "accepted";
  }

  return { canInstall: Boolean(deferred) && !installed, installed, install };
}
