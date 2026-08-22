/**
 * Is this page currently running as an installed, standalone app (Home Screen / desktop install)
 * rather than a normal browser tab? Shared by useInstallPrompt.ts (has the app already been
 * installed) and usePushSubscription.ts (iOS specifically requires this to be true before Web
 * Push works at all — see isIOS below).
 */
export function isStandalone(): boolean {
  return (
    (window.matchMedia?.("(display-mode: standalone)").matches ?? false) ||
    // Older iOS Safari never reflects standalone launches in the display-mode media query — it
    // exposes this non-standard boolean instead.
    Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone)
  );
}

/**
 * iPhone/iPad, including iPadOS 13+ requesting the desktop site — which reports `navigator.
 * platform` as "MacIntel" like a real Mac, so plain UA sniffing alone misses it. The standard
 * workaround: a "Mac" that also has touch points is actually an iPad.
 */
export function isIOS(): boolean {
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}
