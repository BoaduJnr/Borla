import { useEffect, useState } from "react";

export interface Coords {
  lon: number;
  lat: number;
}

/**
 * Thin wrapper over the browser Geolocation API — on-demand for households, and polled while
 * a collector is "online" (see CollectorHome). This is the "device is hostile" trade-off made
 * explicit: a browser tab only reports location while open and foregrounded, unlike the native
 * background-geolocation service in the original design (Technical_Debt_Plan.md, TD-04).
 */
export function useGeolocation(watch = false) {
  const [coords, setCoords] = useState<Coords | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!navigator.geolocation) {
      setError("Geolocation is not supported on this device/browser");
      return;
    }
    const onSuccess = (pos: GeolocationPosition) => {
      setCoords({ lon: pos.coords.longitude, lat: pos.coords.latitude });
      setError(null);
    };
    const onError = (err: GeolocationPositionError) => setError(err.message);

    if (watch) {
      const id = navigator.geolocation.watchPosition(onSuccess, onError, {
        enableHighAccuracy: true,
        maximumAge: 15_000,
      });
      return () => navigator.geolocation.clearWatch(id);
    } else {
      navigator.geolocation.getCurrentPosition(onSuccess, onError, { enableHighAccuracy: true });
    }
  }, [watch]);

  return { coords, error };
}

// Accra fallback, used only if the browser denies/lacks geolocation — keeps the demo usable.
export const FALLBACK_COORDS: Coords = { lon: -0.187, lat: 5.6037 };
