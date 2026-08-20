/**
 * PushManager.subscribe's applicationServerKey wants a Uint8Array, but the VAPID public key
 * travels everywhere else (server config, the API response) as a URL-safe base64 string —
 * standard boilerplate conversion, not Borla-specific.
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64Safe);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}
