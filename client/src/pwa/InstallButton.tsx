import { useState } from "react";
import { useInstallPrompt } from "./useInstallPrompt";

export function InstallButton() {
  const { canInstall, installed, install } = useInstallPrompt();
  const [justInstalled, setJustInstalled] = useState(false);

  if (installed || justInstalled) {
    return <p className="muted" style={{ fontSize: 12.5 }}>✓ Borla is installed on this device.</p>;
  }
  if (!canInstall) return null;

  return (
    <button
      className="btn btn-dark btn-sm"
      onClick={async () => {
        const accepted = await install();
        if (accepted) setJustInstalled(true);
      }}
    >
      Install Borla app
    </button>
  );
}
