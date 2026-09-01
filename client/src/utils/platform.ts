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

/**
 * Real Safari on any Apple device (iOS or desktop macOS) — `vendor` is the standard, reliable way
 * to tell it apart from Chrome/Edge/Firefox running on a Mac, which all report a different
 * vendor string despite sharing the same "Macintosh" bits of the user agent. Desktop Safari has
 * its own version of iOS's install requirement (historically: added to the Dock via Safari's own
 * File menu, not just any tab) — less certain/more version-dependent than the confirmed iOS case,
 * so this only powers an error-message *hint*, not a hard gate like isIOS()/needsIOSInstall does.
 * Blocking the button outright on a guess would risk hiding a feature that works fine for some
 * desktop Safari versions; a hint on actual failure doesn't have that downside.
 */
export function isSafari(): boolean {
  return navigator.vendor === "Apple Computer, Inc.";
}
