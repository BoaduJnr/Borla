import { Router } from "express";
import { z } from "zod";
import { asyncHandler, ApiError } from "../../middleware/errorHandler.js";
import { validateQuery } from "../../middleware/validate.js";

export const landmarksRouter = Router();

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const TIMEOUT_MS = 5000;

// Nominatim's public instance is a free, shared resource — its usage policy caps traffic at
// roughly 1 request/second in AGGREGATE across every caller, not per user
// (https://operations.osmfoundation.org/policies/nominatim/). That's exactly why this is a
// backend proxy rather than a direct client-side call like MapView's OSRM routing: only a single
// server-side choke point can actually hold every concurrent Borla user's searches to one shared
// budget. No Redis needed for this — Borla runs one Render web service, one Node process
// (render.yaml), so plain module-level state is enough; a second instance would need this moved
// to Redis the same way rateLimit.ts's counters are.
let nextAvailableAt = 0;
const MIN_INTERVAL_MS = 1100; // safely over the ~1 req/s policy limit
const MAX_QUEUE_WAIT_MS = 4000; // beyond this, refuse rather than make a caller wait indefinitely

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const searchSchema = z.object({
  // Same 3-character minimum the frontend's debounce enforces (LandmarkSearch.tsx) — checked
  // again here so a client can't bypass it and spam single/double-letter queries.
  q: z.string().trim().min(3).max(200),
});

interface NominatimHit {
  display_name: string;
  lat: string;
  lon: string;
}

/**
 * GET /landmarks/search — public, no login, same as Route me's other unauthenticated reads.
 * Proxies Nominatim (OpenStreetMap's free geocoder) instead of a curated table or a paid API —
 * see the "Landmark search & routing" brief. Fails open on any Nominatim error/timeout
 * (`available: false`, not a thrown error) so a flaky free third party never breaks the page,
 * matching the same philosophy sendSms/useRoute already use elsewhere in this app.
 */
landmarksRouter.get(
  "/landmarks/search",
  validateQuery(searchSchema),
  asyncHandler(async (req, res) => {
    const { q } = req.query as unknown as { q: string };

    const now = Date.now();
    const scheduledAt = Math.max(now, nextAvailableAt);
    if (scheduledAt - now > MAX_QUEUE_WAIT_MS) {
      throw new ApiError(429, "Search is busy right now — try again in a moment");
    }
    // Synchronous read-then-write with no `await` between them — Node's single-threaded event
    // loop means no other request's handler can interleave here, so this is race-free without
    // needing a lock.
    nextAvailableAt = scheduledAt + MIN_INTERVAL_MS;
    const wait = scheduledAt - now;
    if (wait > 0) await sleep(wait);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const url = new URL(NOMINATIM_URL);
      url.searchParams.set("q", q);
      url.searchParams.set("format", "json");
      url.searchParams.set("limit", "5");
      url.searchParams.set("countrycodes", "gh");

      const resp = await fetch(url, {
        signal: controller.signal,
        headers: {
          // Required by Nominatim's usage policy for server-to-server calls — a direct
          // browser call would carry an identifying Referer instead, but this proxy has none.
          "User-Agent": "Borla-Waste-Collector-App (https://borla.onrender.com)",
        },
      });
      if (!resp.ok) {
        console.error(`[landmarks] Nominatim HTTP error ${resp.status}`);
        return res.json({ results: [], available: false });
      }
      const hits = (await resp.json()) as NominatimHit[];
      res.json({
        results: hits.map((h) => ({ name: h.display_name, lon: Number(h.lon), lat: Number(h.lat) })),
        available: true,
      });
    } catch (err) {
      console.error("[landmarks] Nominatim search failed", err);
      res.json({ results: [], available: false });
    } finally {
      clearTimeout(timeout);
    }
  })
);
