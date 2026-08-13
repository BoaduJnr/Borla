export interface QuietHours {
  start: string; // "HH:MM"
  end: string;
}

/** True if `nowMinutes` (minutes since midnight) falls inside the collector's quiet-hours window. */
export function inQuietHours(nowMinutes: number, qh: QuietHours): boolean {
  const toMin = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  };
  const start = toMin(qh.start);
  const end = toMin(qh.end);
  if (start === end) return false; // degenerate window = always-on collector, never suppress
  if (start < end) return nowMinutes >= start && nowMinutes < end;
  return nowMinutes >= start || nowMinutes < end; // wraps midnight, e.g. 22:00–05:00
}
