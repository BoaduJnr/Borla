import { useEffect } from "react";

/**
 * Clears a transient one-off message (a socket-driven "the household cancelled this request"
 * banner, "Request sent.", etc.) after a fixed delay instead of leaving it on screen forever
 * until some unrelated event happens to overwrite it. Reported by a user: the cancellation
 * banner (and others sharing the same `info` state in HouseholdHome/CollectorHome) stayed
 * stuck indefinitely — there was no dismiss mechanism, automatic or manual, at all.
 *
 * Pass the `useState` setter directly (not a wrapping arrow function) — it's referentially
 * stable across renders, so the timer only resets when `value` itself actually changes, not on
 * every unrelated re-render (these pages poll every few seconds).
 */
export function useAutoDismiss(value: string | null, setValue: (v: string | null) => void, delayMs = 6000) {
  useEffect(() => {
    if (!value) return;
    const t = setTimeout(() => setValue(null), delayMs);
    return () => clearTimeout(t);
  }, [value, setValue, delayMs]);
}
