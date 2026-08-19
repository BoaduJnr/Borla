import { useEffect, useState } from "react";
import { api } from "../api/client";
import { IconSearch } from "./Icon";

export interface LandmarkResult {
  name: string;
  lon: number;
  lat: number;
}

const MIN_QUERY_LENGTH = 3;
const DEBOUNCE_MS = 500;

/**
 * Search box + dropdown over the backend's Nominatim proxy (server/src/modules/landmarks/routes.ts).
 * Debounced and length-gated on purpose, not just for a snappier feel: Nominatim's own usage
 * policy explicitly asks callers not to fire a request on every keystroke, and the backend
 * enforces the same 3-character minimum independently — this is belt and suspenders, not the
 * only thing standing between this box and Nominatim's shared rate limit.
 */
export function LandmarkSearch({ onSelect }: { onSelect: (result: LandmarkResult) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<LandmarkResult[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const query = q.trim();
    if (query.length < MIN_QUERY_LENGTH) {
      setResults(null);
      return;
    }
    setLoading(true);
    const t = setTimeout(() => {
      let cancelled = false;
      api<{ results: LandmarkResult[]; available: boolean }>(
        `/landmarks/search?q=${encodeURIComponent(query)}`,
        { auth: false }
      )
        .then((res) => {
          if (cancelled) return;
          setResults(res.results);
          setAvailable(res.available);
        })
        .catch(() => {
          if (cancelled) return;
          setResults([]);
          setAvailable(false);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ position: "relative" }}>
        <input
          className="field"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a place — market, hospital, landmark…"
          style={{ paddingLeft: 38 }}
        />
        <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
          <IconSearch size={16} color="var(--muted)" />
        </span>
      </div>

      {loading && <p className="muted" style={{ fontSize: 12.5 }}>Searching…</p>}

      {!loading && results && !available && (
        <p className="muted" style={{ fontSize: 12.5 }}>Search isn't available right now — try again shortly.</p>
      )}

      {!loading && results && available && results.length === 0 && (
        <p className="muted" style={{ fontSize: 12.5 }}>No matches for "{q.trim()}".</p>
      )}

      {!loading && results && available && results.length > 0 && (
        <div className="card stack" style={{ padding: 0, overflow: "hidden" }}>
          {results.map((r, i) => (
            <button
              key={`${r.lon},${r.lat},${i}`}
              type="button"
              onClick={() => {
                onSelect(r);
                setQ(r.name);
                setResults(null);
              }}
              className="btn btn-ghost"
              style={{
                width: "100%",
                justifyContent: "flex-start",
                textAlign: "left",
                borderRadius: 0,
                border: 0,
                borderBottom: i < results.length - 1 ? "1px solid var(--line)" : 0,
                fontWeight: 500,
                fontSize: 13.5,
              }}
            >
              {r.name}
            </button>
          ))}
          <p className="muted" style={{ fontSize: 11, padding: "6px 12px 8px", margin: 0 }}>
            Search by OpenStreetMap
          </p>
        </div>
      )}
    </div>
  );
}
