# Borla — Technical Design & Implementation Plan (v1)

*Real-time matchmaker connecting Ghanaian households with nearby roaming waste collectors.*

---

## 1. Design principles

Borla is a **matchmaker, not a dispatcher**. The app's job is to make two people aware of each other; the pickup itself is negotiated and completed in the physical world. Every design decision follows from four principles:

1. **Push complexity into the real world where possible.** The broadcast plane deliberately has no digital "winner" and no locking, which removes an entire class of concurrency bugs. Contention is resolved by whoever arrives or calls first.
2. **Two planes, kept apart.** The *broadcast* plane is stateless, lossy, and cheap. The *request* plane is stateful, reliable, and shallow. They share a presence layer but nothing else. Never let a broadcast pin behave like a request or vice versa.
3. **The device is hostile.** Low-end Android, expensive metered data, aggressive OS battery-killing, patchy signal. The architecture assumes location updates are sparse, connections drop, and the app is often backgrounded or killed.
4. **A muted app is a dead app.** Notification discipline is a first-class feature, not an afterthought. Every alert must be earned.

---

## 2. System architecture

```
┌─────────────────────────┐        ┌─────────────────────────┐
│  HOUSEHOLD (PWA)         │        │  COLLECTOR (Capacitor)   │
│  React + Vite            │        │  React + Vite + native   │
│  Service worker          │        │  Background geolocation  │
│  Web Push (VAPID)        │        │  FCM push                │
│  Geolocation (on-demand) │        │  Foreground location svc │
└───────────┬─────────────┘        └───────────┬─────────────┘
            │  HTTPS (REST) + WSS (Socket.IO)   │
            └─────────────────┬─────────────────┘
                              │
                  ┌───────────▼────────────┐
                  │   Express + TypeScript  │
                  │  ┌───────────────────┐  │
                  │  │ REST API          │  │
                  │  │ Socket.IO gateway │  │
                  │  │ Matching service  │  │
                  │  │ Notification svc  │  │
                  │  │ Presence svc      │  │
                  │  └───────────────────┘  │
                  └───┬──────────────┬──────┘
                      │              │
            ┌─────────▼───┐   ┌──────▼───────────┐
            │ PostgreSQL  │   │ Redis            │
            │ + PostGIS   │   │ • presence (TTL) │
            │ (source of  │   │ • live geo sets  │
            │  truth)     │   │ • BullMQ queues  │
            │             │   │ • rate limiters  │
            └─────────────┘   └──────┬───────────┘
                                     │ BullMQ workers
                              ┌──────▼───────────┐
                              │ Async jobs:      │
                              │ • notif fan-out  │
                              │ • pin expiry     │
                              │ • presence sweep │
                              └──────┬───────────┘
                                     │
                    ┌────────────────┼────────────────┐
              ┌─────▼─────┐   ┌──────▼──────┐   ┌──────▼──────┐
              │ SMS gw    │   │ Web Push    │   │ FCM         │
              │ (OTP +    │   │ (VAPID)     │   │ (collector  │
              │  fallback)│   │ (household) │   │  native)    │
              └───────────┘   └─────────────┘   └─────────────┘
```

**Why the Postgres/Redis split matters.** Live collector positions are high-write (updated as they roam) and ephemeral — putting every position update into Postgres would thrash it. So **Redis holds the hot, live state** (who's online, where they are right now, rate-limit counters) and **Postgres/PostGIS holds durable truth** (users, broadcasts, requests, last-known locations, history, analytics). The matching engine reads live data from Redis; everything auditable persists to Postgres.

---

## 3. The two data planes

### 3.1 Broadcast plane (stateless, best-effort)

**Purpose:** the digital bell. A household announces "I have waste here"; every nearby online collector hears it; the physical world sorts out who takes it.

**Lifecycle (there is barely one):**

```
CREATED ──(household clears)──► CLEARED
   │
   └────(auto-expiry 30–60m)──► EXPIRED
```

There is **no collector binding, no accept, no lock, ever.** The record only exists so we can (a) fan out one notification and (b) show the pin on collectors' maps until it's gone.

**Flow:**
1. Household taps "I have waste" → confirms location (defaults to current GPS / saved home) → optional waste type + optional note.
2. Server writes the broadcast row (`status = active`, `expires_at = now + 45m`), adds it to the Redis geo set `pins:active`, and enqueues a `fanout` job.
3. The fan-out worker runs a radius query for online collectors, filters them (see §7), and pushes `broadcast:new` over Socket.IO to connected collectors + FCM to the rest.
4. Collectors see the pin on their map. **No in-app action** — they either drive there or tap-to-call.
5. Household is **prompted hard** to clear the pin the moment someone shows: a sticky banner ("Someone coming? Tap to clear so others don't drive over"). On clear → `status = cleared`, removed from `pins:active`, and a `broadcast:cleared` event tells collectors' maps to drop it.
6. Backstop: the **pin-expiry** repeatable job sweeps `pins:active` for `expires_at < now`, marks them `expired`, and removes them.

**The critical non-obvious rule:** stale pins are the #1 churn risk for collectors (wasted trips). The strong clear-prompt + short expiry aren't polish — they're what keeps collectors trusting the map.

### 3.2 Request plane (stateful, shallow)

**Purpose:** a household picks one specific collector and asks them directly. This is the only plane with a real state machine.

**State machine:**

```
        create
          │
          ▼
     ┌─────────┐   collector opens/receives   ┌──────┐
     │REQUESTED│ ───────────────────────────► │ SEEN │
     └────┬────┘                              └──┬───┘
          │                                      │
          │        no response in T (e.g. 90s)   │ accept ─► ACCEPTED ─► (contact unlocked)
          ├──────────────────────────────────►  │ reject ─► REJECTED ─► (household re-searches)
          │            TIMED_OUT                 │
          ▼                                      ▼
     TIMED_OUT                             ACCEPTED / REJECTED
```

- **REQUESTED → SEEN:** set when the collector's client acknowledges receipt (delivered + surfaced). Lets the household UI show "Seen" vs "Sent".
- **ACCEPTED:** notify household; unlock contact (masked call — see §10). The app now *steps back*; coordination is a phone call. No en-route or collected tracking in v1.
- **REJECTED:** notify household; they return to search. **No auto-fallback** in v1 (deliberate — keeps it simple and human).
- **TIMED_OUT:** a timer (BullMQ delayed job) fires if no accept/reject within T; household is told "No response — try another collector." This exists so a household never stares at a silent screen.

**Concurrency note:** because a request targets exactly one collector, there's no claim race. The only guard needed is idempotent state transitions (a reject arriving after a timeout must not resurrect the request) — enforce with a `WHERE status = 'requested'` conditional update and treat zero-rows-affected as "already resolved."

---

## 4. Data model

### 4.1 PostgreSQL + PostGIS (durable)

```sql
-- enable once
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         TEXT UNIQUE NOT NULL,          -- E.164, verified via OTP
  role          TEXT NOT NULL CHECK (role IN ('household','collector')),
  display_name  TEXT,
  language      TEXT NOT NULL DEFAULT 'en',    -- en, tw, ga, dag, ...
  verified      BOOLEAN NOT NULL DEFAULT FALSE,-- collectors gated on this
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE households (
  user_id       UUID PRIMARY KEY REFERENCES users(id),
  home_location GEOGRAPHY(Point,4326),         -- optional saved home
  alert_radius_m INT NOT NULL DEFAULT 800,     -- "alert me when collector nearby"
  alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE collectors (
  user_id        UUID PRIMARY KEY REFERENCES users(id),
  vehicle_type   TEXT,                          -- tricycle, pickup, ...
  waste_types    TEXT[] NOT NULL DEFAULT '{}',  -- interests: general, recyclable, ...
  last_location  GEOGRAPHY(Point,4326),         -- last-known (durable copy)
  last_seen_at   TIMESTAMPTZ,
  reliability    NUMERIC(4,3),                  -- optional score, 0..1
  quiet_hours    JSONB                          -- {"start":"22:00","end":"05:00"}
);

CREATE TABLE broadcasts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES users(id),
  location     GEOGRAPHY(Point,4326) NOT NULL,
  waste_type   TEXT,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','cleared','expired')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX broadcasts_loc_gix ON broadcasts USING GIST (location);
CREATE INDEX broadcasts_active_ix ON broadcasts (status) WHERE status = 'active';

CREATE TABLE requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  UUID NOT NULL REFERENCES users(id),
  collector_id  UUID NOT NULL REFERENCES users(id),
  location      GEOGRAPHY(Point,4326) NOT NULL,
  agreed_price  NUMERIC(10,2),                  -- payment-READY, unused in v1
  status        TEXT NOT NULL DEFAULT 'requested'
                  CHECK (status IN ('requested','seen','accepted','rejected','timed_out')),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at  TIMESTAMPTZ
);
CREATE INDEX requests_collector_ix ON requests (collector_id, status);
CREATE INDEX requests_household_ix ON requests (household_id, status);

-- optional (only if ratings ship at launch)
CREATE TABLE pickup_confirmations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   UUID REFERENCES requests(id),
  broadcast_id UUID REFERENCES broadcasts(id),
  household_id UUID NOT NULL REFERENCES users(id),
  collector_id UUID,
  came         BOOLEAN NOT NULL,                -- "Did they come?"
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- TWO-SIDED REVIEWS (§16). Every review MUST reference a real interaction
-- (an accepted request, or a confirmed broadcast) so no one can review a
-- stranger they never dealt with.
CREATE TABLE reviews (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id    UUID NOT NULL REFERENCES users(id),   -- who wrote it
  subject_id   UUID NOT NULL REFERENCES users(id),   -- who is reviewed
  author_role  TEXT NOT NULL CHECK (author_role IN ('household','collector')),
  request_id   UUID REFERENCES requests(id),         -- interaction context
  broadcast_id UUID REFERENCES broadcasts(id),       -- (one of the two set)
  rating       SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment      TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'       -- moderation state
                 CHECK (status IN ('pending','visible','flagged','removed')),
  visible_at   TIMESTAMPTZ,                           -- for double-blind release
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- one review per author per interaction
  UNIQUE (author_id, request_id),
  UNIQUE (author_id, broadcast_id)
);
CREATE INDEX reviews_subject_ix ON reviews (subject_id, status);

CREATE TABLE review_replies (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id  UUID NOT NULL REFERENCES reviews(id),
  author_id  UUID NOT NULL REFERENCES users(id),      -- MUST equal reviews.subject_id
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','visible','flagged','removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (review_id)                                  -- one public reply per review
);

-- denormalized rolling aggregates for fast profile reads (updated on review visible)
ALTER TABLE collectors ADD COLUMN rating_avg NUMERIC(3,2), ADD COLUMN rating_count INT NOT NULL DEFAULT 0;
ALTER TABLE households ADD COLUMN rating_avg NUMERIC(3,2), ADD COLUMN rating_count INT NOT NULL DEFAULT 0;

-- moderation queue (feeds the admin portal §17; AI pre-flags into here, §18)
CREATE TABLE moderation_flags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type TEXT NOT NULL CHECK (target_type IN ('review','reply')),
  target_id   UUID NOT NULL,
  reason      TEXT NOT NULL,          -- 'abuse','pii','spam','harassment',...
  source      TEXT NOT NULL,          -- 'ai','user_report','admin'
  score       NUMERIC(4,3),           -- AI confidence, if source='ai'
  resolved    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ADMIN (§17)
CREATE TABLE admins (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT UNIQUE NOT NULL,
  role         TEXT NOT NULL DEFAULT 'ops'  -- 'ops','moderator','superadmin'
                 CHECK (role IN ('ops','moderator','superadmin')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (           -- every privileged action is recorded
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID REFERENCES admins(id),
  action      TEXT NOT NULL,       -- 'verify_collector','suspend_user','remove_review',...
  target_id   UUID,
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_config (          -- tune radius/TTL/limits without redeploy
  key        TEXT PRIMARY KEY,     -- 'broadcast_radius_m','pin_ttl_min','notif_cap_10m',...
  value      JSONB NOT NULL,
  updated_by UUID REFERENCES admins(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- add a 'suspended' state to users for moderation
ALTER TABLE users ADD COLUMN suspended BOOLEAN NOT NULL DEFAULT FALSE;
```

**Note on `GEOGRAPHY` vs `GEOMETRY`:** use `GEOGRAPHY(Point,4326)` so `ST_DWithin(a, b, meters)` works in metres directly — no projection math. Slightly slower than projected geometry but correct and simple, which is the right trade at this scale.

### 4.2 Redis (hot / ephemeral)

| Key | Type | Purpose | TTL |
|---|---|---|---|
| `presence:{collectorId}` | string `"1"` | is-online flag | ~45s, refreshed by heartbeat |
| `geo:collectors` | GEO set | live positions of **online** collectors | member removed on sweep |
| `heartbeat:zset` | ZSET (score = last-seen epoch) | drives the presence sweep | — |
| `pins:active` | GEO set | active broadcast pin locations | member removed on clear/expiry |
| `ratelimit:notif:{collectorId}` | string counter | cap alerts per window | e.g. 10m |
| `socket:{userId}` | string | current Socket.IO connection id | on disconnect |

Redis is the **matching substrate**: all live proximity math hits `geo:collectors` and `pins:active`, never Postgres.

---

## 5. Geospatial matching engine

There are exactly **two proximity questions**, run in opposite directions:

**Q1 — "Which online collectors are near this point?"**
Used for: broadcast fan-out, and the household's "collectors near me" map.

```
GEOSEARCH geo:collectors FROMLONLAT <lon> <lat> BYRADIUS <R> m ASC WITHCOORD
```
Then intersect with `presence:*` (membership already implies online because we only keep online collectors in the set — see §6). Result: the exact list to notify or display.

**Q2 — "Which active waste pins / alerting households are near this moving collector?"**
Used for: the collector's live map of nearby waste, and the "alert household when a collector is near" feature.

As a collector's position updates, run:
```
GEOSEARCH pins:active FROMLONLAT <lon> <lat> BYRADIUS <R> m ASC
```
to refresh what they see, and separately check standing household alert zones (households with `alerts_enabled` and a `home_location`) — these are lower-frequency and can be served from PostGIS with `ST_DWithin`, throttled to fire each household at most once per cooldown.

**Why not do it all in PostGIS?** PostGIS is perfectly capable of these queries and is the source of truth, but collector positions change constantly; running every match against Postgres on every movement update would dominate DB load. Redis GEO absorbs the churn; PostGIS handles the durable, lower-frequency queries (standing alerts, analytics, and as a correctness fallback). This is the standard hot-path/cold-path split.

**Tuning:** keep **R tight** (e.g. 800–1500 m). Tight radius = fewer wasted trips, less privacy exposure, and denser-feeling liquidity. Radius is a per-plane, tunable config, not a constant.

---

## 6. Presence & heartbeat

Presence is the load-bearing wall: a request or broadcast must **never** reach an offline collector, so "online" has to be honest even when apps get killed or lose signal.

**Mechanism (self-healing via TTL + sweep):**
1. Collector toggles **Go online** → native foreground location service starts (persistent notification, Android requirement).
2. Client sends a heartbeat every ~20–30 s, or on significant movement (whichever first). Each heartbeat:
   - `SET presence:{id} 1 EX 45` (refresh online flag)
   - `GEOADD geo:collectors <lon> <lat> {id}` (refresh position)
   - `ZADD heartbeat:zset <now> {id}` (record last-seen)
3. If heartbeats stop (app killed, tunnel, dead battery), `presence:{id}` **expires on its own** after 45 s → collector is effectively offline.
4. A **presence-sweep** repeatable job (every ~30 s) does `ZRANGEBYSCORE heartbeat:zset 0 <now-45s>` and, for each stale member, `ZREM` + `ZREM geo:collectors` — so stale positions leave the matchable set even though GEO sets have no native TTL.
5. **Go offline** (explicit) does the same removals immediately + stops the foreground service.

**Battery/data discipline (tie "online" to the toggle):**
- Distance-filtered updates (fire on ~50–100 m moved), not a fixed high-frequency timer.
- Activity-aware throttle: when the OS reports "still", drop to a slow keep-alive; resume on movement.
- Batch + compress queued positions; flush on interval or on reconnect.
- Never track when offline. The explicit toggle is both the battery saver and the honesty guarantee.

---

## 7. Notification system

Every alert crosses a **gauntlet** before it's allowed to fire. Order matters (cheapest filters first):

```
candidate collectors (from GEOSEARCH within R)
  └─► online?            (presence membership — already true)
      └─► waste-type match?   (collector.waste_types ∩ pin.waste_type)
          └─► not in quiet hours?
              └─► under rate limit?  (ratelimit:notif:{id})
                  └─► not already notified for this event? (dedup)
                      └─► SEND
```

**Delivery channels, chosen by state:**
- **App open / socket connected** → `broadcast:new` / `request:new` over Socket.IO (instant, free, no push service).
- **App closed / backgrounded** → **FCM** (collector native) or **Web Push/VAPID** (household PWA).
- The server checks `socket:{userId}` to decide: connected → socket; else → push.

**Rate limiting:** `INCR ratelimit:notif:{collectorId}` with a windowed TTL; if over cap (e.g. >N broadcasts in 10 min), suppress push (optionally still show in-app). Protects against alert fatigue in dense areas.

**Quiet hours:** per-user JSON; during quiet hours suppress push, keep in-app.

**Fan-out at scale:** the fan-out is a BullMQ job so a single broadcast can notify many collectors without blocking the request thread, with retries and backoff for push failures.

---

## 8. Realtime layer (Socket.IO)

**Connection & rooms:**
- On connect (JWT-authenticated), each user joins a private room `user:{id}`. Store `socket:{userId}` in Redis for the "connected?" check.
- Use the **Redis adapter** for Socket.IO so it scales across multiple Express instances (events emitted on any node reach the right socket).

**Events:**

| Event | Direction | Payload |
|---|---|---|
| `presence:toggle` | collector → server | `{online, lon, lat}` |
| `heartbeat` | collector → server | `{lon, lat}` (or via REST) |
| `broadcast:new` | server → collector | `{broadcastId, lon, lat, wasteType, note}` |
| `broadcast:cleared` | server → collector | `{broadcastId}` |
| `collector:nearby` | server → household | `{collectorId, distance}` |
| `request:new` | server → collector | `{requestId, householdId, lon, lat}` |
| `request:seen` | server → household | `{requestId}` |
| `request:accepted` | server → household | `{requestId, callToken}` |
| `request:rejected` | server → household | `{requestId}` |
| `request:timed_out` | server → household | `{requestId}` |

Position streams are **not** broadcast widely over sockets — collectors send positions up (REST/socket, batched), and the server emits only the small, relevant events above. This keeps socket traffic (and data cost) minimal.

---

## 9. Authentication

- **Phone + SMS OTP** (users are phone-first; no email). Flow: enter phone → server sends 6-digit OTP via Ghanaian SMS gateway (Hubtel / Arkesel / mNotify) → verify → issue **JWT access (short-lived) + refresh token**.
- Store minimal PII: phone (E.164), role, display name, language.
- **Collector gating:** `users.verified` must be true before a collector can go online. v1 verification can be lightweight (confirmed phone + a manual/vouched check per neighbourhood during onboarding) but the flag exists so the privacy model (only *verified* collectors receive broadcasts) holds from day one.
- Rate-limit OTP requests per phone/IP to prevent SMS-cost abuse.

---

## 10. Privacy & masked contact

Broadcast inherently exposes a household's **location + a way to be contacted** to every nearby online collector — that's the model, but it must be bounded:

- **Tight radius**, **verified + online collectors only**, and location shown at street-level (not exact rooftop) until contact is established.
- **Masked calling** rather than exposing raw numbers. Options, in order of recommendation for v1:
  1. **Reveal-on-accept (simplest):** in the request plane, unlock the collector↔household phone numbers only after `accepted`, log the reveal, and let them dial normally. Fast to ship; acceptable given the low stakes and that the household chose that collector.
  2. **Provider number-masking (better):** route calls through proxy numbers via a telephony provider (e.g. Hubtel) so neither party sees the other's real number. Add when abuse or scale warrants — it costs per-call.
  3. **In-app VoIP (avoid for v1):** WebRTC voice is fragile on 2G/3G and burns data; not worth it now.
- Households control `alerts_enabled` and can go "invisible" (no standing alerts, broadcast on demand only).
- Never show a collector's full movement history to households; they see a live dot and distance, nothing persistent.

---

## 11. Frontend architecture — shared React + Capacitor

**One React codebase, two targets.** Households only need on-demand location (browser Geolocation is fine) → ship a **pure installable PWA**. Collectors need **background** location while roaming with the screen off, which **a browser PWA cannot do reliably** → ship the same React app wrapped in **Capacitor** as a native Android app with a background-geolocation plugin and native push.

**Monorepo (pnpm workspaces / Turborepo):**

```
borla/
├─ packages/
│  ├─ shared/            # the bulk of the code lives here
│  │  ├─ api/            # typed REST + socket client
│  │  ├─ components/     # map, buttons, sheets, banners
│  │  ├─ hooks/          # useGeolocation, useSocket, usePresence
│  │  ├─ i18n/           # en, tw, ga, dag strings
│  │  ├─ map/            # MapLibre wrapper + OSM tile config
│  │  └─ types/          # Broadcast, Request, Presence, User
│  └─ config/            # eslint, tsconfig, tailwind preset
├─ apps/
│  ├─ household-pwa/     # Vite; service worker (Workbox); Web Push
│  │  └─ src/            # thin: routes + household screens
│  └─ collector-app/     # Vite + Capacitor
│     ├─ src/            # thin: routes + collector screens
│     ├─ capacitor.config.ts
│     └─ android/        # native shell
│        # plugins: @capacitor-community/background-geolocation
│        #          (or transistorsoft), @capacitor/push-notifications
└─ server/               # Express + TS, Socket.IO, BullMQ workers
```

**Key frontend choices:**
- **MapLibre GL JS** + OSM-based vector tiles (no Google per-map fees; fits the OSM ecosystem).
- **Offline tolerance:** service worker caches the app shell + last map view + saved home so the app opens and shows *something* with no signal; queued actions (e.g. clear-pin) flush on reconnect.
- **Low-literacy / local-language UI:** icon-first, large tap targets, minimal text, i18n from day one (English + at least Twi/Ga for the pilot community), and a voice/IVR-friendly path considered for later.
- The **"go online" foreground service** and its persistent notification live only in `collector-app` (native); everything else is shared.

---

## 12. Screen flows

### 12.1 Household

```
Onboarding: phone → OTP → language → (optional) set home location
        │
        ▼
   HOME / MAP  ──────────────────────────────────────────────┐
   • live dots of nearby online collectors                    │
   • big primary button: "I HAVE WASTE"                        │
   • secondary: "Find a collector"                             │
        │                                   │                  │
   [I HAVE WASTE]                       [Find a collector]      │
        ▼                                   ▼                  │
   BROADCAST                            SEARCH LIST/MAP         │
   • confirm location                  • tap a collector       │
   • optional waste type/note          ▼                       │
   • CONFIRM → pin active           REQUEST SENT (requested)    │
        ▼                              • shows Sent → Seen      │
   ACTIVE PIN                          ▼                        │
   • sticky: "Someone coming?      accepted → CONTACT UNLOCKED  │
      Tap to CLEAR"                    (masked call button) ────┘
   • auto-expires in 45m           rejected → "Try another"
        ▼                          timed_out → "No response,
   CLEARED / EXPIRED                    try another collector"
```

### 12.2 Collector

```
Onboarding: phone → OTP → vehicle + waste types → verification
        │
        ▼
   OFFLINE (default)
   • big toggle: "GO ONLINE"
        │  (starts foreground location service + persistent notif)
        ▼
   ONLINE / LIVE MAP  ◄──────── heartbeat + position updates
   • nearby active waste pins (broadcast + ambient)
   • incoming DIRECT REQUESTS surface as a card
        │                         │
   [tap a pin]               [direct request card]
        ▼                         ▼
   PIN DETAIL                 REQUEST: Accept / Reject
   • navigate (device nav)         │ accept → household notified,
   • tap-to-call household         │          contact unlocked, call
   • NO accept (broadcast)         │ reject → household notified
   • drive → first there wins      ▼
                              (after accept, app steps back)
        │
   [GO OFFLINE] → stops service, removed from matchable set
```

Optional tail on both: after a pickup, a one-tap **"Did they come?"** prompt feeds the reliability score (ship only if ratings are in scope at launch).

---

## 13. API surface (representative)

**REST**
```
POST /auth/otp/request        {phone}
POST /auth/otp/verify         {phone, code} -> {access, refresh, user}
POST /auth/refresh            {refresh}

GET  /me
PATCH /me                     {display_name, language, ...}
PATCH /households/me          {home_location, alert_radius_m, alerts_enabled}
PATCH /collectors/me          {vehicle_type, waste_types, quiet_hours}

POST /presence                {online, lon, lat}         # go online/offline
POST /presence/heartbeat      {lon, lat}                 # (or via socket)

POST /broadcasts              {lon, lat, waste_type?, note?} -> broadcast
POST /broadcasts/:id/clear
GET  /collectors/nearby?lon&lat&radius                   # household map
GET  /pins/nearby?lon&lat&radius                         # collector map

POST /requests                {collector_id, lon, lat, agreed_price?}
POST /requests/:id/seen
POST /requests/:id/accept
POST /requests/:id/reject
GET  /requests/:id                                       # poll fallback

POST /confirmations           {request_id?|broadcast_id?, came}  # optional
```

**Socket events:** as tabulated in §8.

**Redis keys / jobs:** as tabulated in §4.2 and §6 (fan-out, pin-expiry, presence-sweep are BullMQ repeatable/delayed jobs).

---

## 14. Riskiest parts & how to de-risk them

| # | Risk | Why it's dangerous | De-risking |
|---|------|--------------------|-----------|
| 1 | **Background location on cheap Android** | If collectors' phones stop reporting when backgrounded, the whole app has no live supply. This is the single biggest technical risk. | Native foreground service via Capacitor (persistent notification); distance-filtered + activity-aware updates; test on real low-end devices across OEM battery-killers (Tecno, Infinix, itel are common in-market); explicit "go online" state. |
| 2 | **Dishonest presence** | Households request/see collectors who aren't actually there → instant loss of trust. | TTL heartbeat + presence sweep so offline is self-healing; only online members ever live in `geo:collectors`; tune TTL vs. signal reality in the pilot. |
| 3 | **Wasted trips from stale pins** | No-winner broadcast + forgotten pins send 3 collectors to a cleared house; they learn to ignore the map. | Aggressive clear-prompt; short auto-expiry; `broadcast:cleared` removes the pin from all maps immediately; monitor "pins cleared vs expired" as a health metric. |
| 4 | **Cold-start / per-neighbourhood density** | Proximity match is useless without local supply; city-wide numbers don't help. | Launch one neighbourhood at a time; **onboard existing collectors first**; treat "active online collectors per neighbourhood at peak" as the north-star metric before adding households. |
| 5 | **Notification fatigue** | Two planes pinging users → they mute → dead app. | The full gauntlet in §7: online + in-range + waste-type + quiet-hours + rate-limit + dedup; measure mute/uninstall rate; prefer in-app over push when connected. |
| 6 | **Privacy exposure via broadcast** | Location + contact exposed to strangers; abuse/harassment. | Tight radius; verified+online only; reveal-on-accept then provider masking; street-level location until contact; household invisibility mode. |
| 7 | **Connectivity & data cost** | Users on metered, patchy networks close data-hungry apps. | Batch/compress positions; socket over push when possible; offline-tolerant shell; SMS fallback for critical alerts (request accepted/rejected). |
| 8 | **Request race after timeout** | Reject/accept arriving after timeout corrupts state. | Conditional `WHERE status='requested'` transitions; treat 0-rows as already-resolved; idempotent handlers. |
| 9 | **Review abuse / fake ratings / PII in comments** | Free-text public fields + stranger exposure invite harassment, brigading, and address/number leaks. | Reviews tied to real interactions only (unique-per-interaction constraints); double-blind release; mandatory AI moderation for abuse/PII → human queue; one capped reply. |
| 10 | **Admin over-reach / unlogged actions** | Admins can verify, suspend, and delete content — a trust and audit liability. | Separate `admins` table + 2FA; role tiers; every privileged action written to `audit_log`; read-replica for analytics so admin never touches the hot path. |
| 11 | **AI free-tier data leakage** | Free-tier LLM APIs may train on prompts — and Borla's AI inputs are its most sensitive data (review PII, photos of homes). | Free tier for the workbench only; move to paid pay-as-you-go (no data-sharing) before real users; keys server-side; moderation fails *closed*; log verdicts not raw content. |

---

## 15. Implementation roadmap

**Phase 0 — Foundations (weeks 1–3)**
Monorepo + shared package; Express + Postgres/PostGIS + Redis wired; phone-OTP auth; user/role model; Socket.IO with Redis adapter; CI + managed infra (Neon/Supabase + Upstash + Render). Deliverable: a user can sign up, log in, and hold a socket connection.

**Phase 1 — Presence + broadcast plane (weeks 3–6)**
Collector Capacitor shell with foreground background-geolocation; go-online/heartbeat; presence TTL + sweep; `geo:collectors`; household "I have waste" → broadcast → fan-out job → collector map + push; clear-prompt + auto-expiry. Deliverable: the digital bell works end to end in one test area.

**Phase 2 — Request plane (weeks 6–8)**
Household "find a collector" → request state machine → accept/reject/timeout → household notifications → reveal-on-accept contact + tap-to-call. Deliverable: targeted matchmaking works end to end.

**Phase 3 — Trust layer: reviews + admin (weeks 8–11)**
Two-sided reviews/comments/replies tied to interactions (§16) with double-blind release; **AI moderation** on comments/replies (§18) feeding `moderation_flags`; admin portal (§17) — auth + audit log, live ops map, verify/suspend, moderation queue, `app_config` live tuning. Deliverable: interactions can be rated and disputes/content can be managed.

**Phase 4 — Hardening + pilot (weeks 11–14)**
Notification gauntlet (rate limits, quiet hours, waste-type filter); i18n (English + Twi/Ga); offline shell; low-literacy UI pass; SMS fallback for accept/reject; observability (presence honesty, pin clear-vs-expire, notify→action, rating trends). Optional: "Did they come?" ratings surfaced; recycling pin tags; **photo waste-classification** (§18) if bandwidth allows. Deliverable: supervised pilot in **one neighbourhood**, collectors onboarded first.

**Deliberately deferred (post-v1):** in-app payment/escrow (keep `agreed_price` field ready), live turn-by-turn tracking, auto-fallback dispatch, provider call-masking, the heavier AI pieces (anomaly scoring, demand forecasting, admin NL-analytics, local-language voice), expansion beyond the pilot neighbourhood.

---

## 16. Two-sided ratings, comments & replies

Both sides rate each other, exactly like ride-hailing / home-stay platforms: households rate collectors, and collectors rate households (a household that leaves waste that isn't ready, or is rude, is a real cost to a collector). The feature is a small stateful sub-system, but its integrity rules are what make it worth anything.

**Non-negotiable: reviews hang off real interactions.** A review must reference either an `accepted` request or a **confirmed** broadcast pickup (via the `pickup_confirmations` "Did they come?" tap, which is what identifies *which* collector served a no-winner broadcast). This is the anti-fraud spine — without it, anyone could brigade a rating. The `UNIQUE (author_id, request_id)` / `(author_id, broadcast_id)` constraints enforce one review per side per interaction.

**Lifecycle:**

```
interaction resolves (request accepted / broadcast confirmed)
        │
        ▼
   both parties eligible to review  ──(review window, e.g. 7 days)
        │
   author submits {rating 1–5, comment}
        │
        ▼  status = pending  ──► AI moderation pre-check (§18)
        │                          ├─ clean  → visible
        │                          └─ risky  → flagged → admin queue (§17)
        ▼
   VISIBLE ──► subject may post ONE public REPLY (also moderated)
        │
   aggregates recomputed → collectors/households.rating_avg, rating_count
```

**Double-blind release (recommended).** To curb retaliation bias ("you gave me 2 stars so I'll give you 2 back"), hold each review hidden until *both* sides submit **or** the review window closes — then reveal together. That's what `visible_at` is for. It's optional but materially improves rating honesty; ride-hailing and Airbnb both do it.

**Replies** are capped at one public reply by the reviewed party (`review_replies.UNIQUE(review_id)`), so the subject can give their side without a comment war. Replies are moderated on the same path as reviews.

**Moderation is mandatory, not optional** — these are the app's only free-text, publicly visible, user-to-user fields, and the broadcast model already exposes people to strangers. Every comment/reply passes AI pre-screening for abuse, harassment, spam, and **PII leakage** (a collector must not be able to post a household's address or number in a public review). Anything the classifier flags lands in `moderation_flags` for a human moderator in the admin portal. Users can also report a review, which creates the same flag with `source='user_report'`.

**Reads are cheap:** profile screens read the denormalized `rating_avg` / `rating_count`; the full review list + replies is a paginated query on `reviews` filtered to `status='visible'`. Aggregates are recomputed only when a review transitions to/from `visible`.

**API additions:**
```
POST  /reviews                 {subject_id, request_id?|broadcast_id?, rating, comment}
GET   /users/:id/reviews       # paginated, visible only
POST  /reviews/:id/reply       {body}          # author must be the review subject
POST  /reviews/:id/report      {reason}        # any party flags for moderation
```

---

## 17. Admin portal

A separate web app (`apps/admin` in the same monorepo — plain React + Vite, **not** Capacitor, since admins are desk users), role-gated to the `admins` table with **stronger auth than the field apps**: email + password + 2FA rather than phone-OTP, because these accounts can suspend users and remove content. Every privileged action writes to `audit_log`.

**What it does, grouped:**

*Monitoring / stats (read-mostly)*
- Live ops view: online collectors and active pins on a map, **per neighbourhood** — the north-star density metric made visible.
- Funnels and health: broadcasts created → cleared vs **expired** (the wasted-trip proxy), requests by status, match rate, notify→action rate, median response time, presence-honesty (heartbeat gaps).
- Two-sided rating distributions and trend, per collector / per neighbourhood.

*User management*
- Approve / verify collectors (flips `users.verified` — the gate that lets them go online); the KYC-lite review step from §9 lives here.
- Suspend / reinstate users (`users.suspended`); view any user's full interaction + review history for support and dispute resolution.

*Content moderation*
- A queue backed by `moderation_flags`: AI-flagged and user-reported reviews/replies, ranked by AI `score`; moderator can hide, remove, warn, or clear.

*Neighbourhood & config management*
- Define/launch neighbourhoods; per-zone tuning of broadcast radius, pin TTL, notification caps, quiet-hour defaults — written to `app_config` and read live by the services, **so ops can tune the system without a redeploy** (critical during a pilot where you're calibrating radius vs. wasted trips in real time).

*Dispute support*
- Reconstruct a broadcast or request timeline (created → notified whom → accepted → confirmed / expired) to adjudicate "the collector didn't come" complaints — the accountability loop from earlier turns, now with a human backstop.

**Data-access pattern:** the admin portal reads almost entirely from **Postgres** (durable, analytical), plus a thin live overlay from **Redis** for the real-time map. Heavy analytics should hit a **read replica or scheduled materialized views** (e.g. hourly per-neighbourhood rollups) so dashboards never contend with the transactional hot path.

---

## 18. Where AI genuinely fits (and where it doesn't)

Borla is, at its core, a proximity-matching logistics app — **most of it needs no AI, and the hot matching path must never call a model** (proximity is math: GEOSEARCH, not inference — adding an LLM there just buys latency, cost, and flakiness). That said, a few places pay off. Ranked by value-to-effort:

| AI use | Type | Value | When |
|---|---|---|---|
| **Comment/reply moderation** | LLM / text classifier | Directly required by §16 — flags abuse, harassment, spam, and PII leakage before publish. Highest-value, lowest-regret. | v1 (ships with reviews) |
| **Photo → waste type & rough volume** | Vision model | Household snaps a photo instead of picking from a menu — better matching, better recycling routing, and **far friendlier for low-literacy users** (tap camera, not read a list). Genuinely on-brand. | v1.x |
| **Reliability / anomaly scoring** | Classical ML | Learns a real reliability signal from "did they come" + behavioural data; detects accept-then-ghost collectors, fake pins, and review brigading (risks #2/#3/#8). Feeds `collectors.reliability` and `moderation_flags`. | v1.x → v2 |
| **Notification ranking / smart throttle** | Classical ML | Learns which collectors act on which alerts and tunes who gets pinged — attacks fatigue (risk #5) beyond static rules. | v2 |
| **Demand forecasting / supply nudging** | Time-series ML | Predicts where/when waste demand spikes (bin days, market days, month-end) and nudges collectors to go online in under-served areas at the right time — attacks the density/cold-start problem (risk #4). | v2 |
| **Admin natural-language analytics** | LLM over stats | "Which neighbourhoods lost collector supply this week?" answered in the admin portal — real leverage for a tiny ops team. | v2, nice-to-have |
| **Local-language voice / IVR** | ASR + LLM | Twi/Ga voice interface for low-literacy and feature-phone users — highest *impact*, but Ghanaian-language ASR is still immature, so treat as R&D, not a v1 promise. | later / exploratory |

**Avoid:** a chatbot for its own sake; "AI routing" that's really just directions; any model in the request/broadcast matching path. The rule of thumb: AI belongs on the **trust, accessibility, and ops-intelligence** edges of Borla, never in the core matchmaking loop.

Practically, the two AI pieces worth building alongside the features you just asked for are **moderation** (it's the safety valve for the review system) and, close behind, **photo waste-classification** (it compounds the low-literacy and recycling goals already in the brief). Both can call a hosted model API behind the notification/moderation workers — no ML infrastructure needed to start.

### 18.1 The two v1 jobs — implementation

Both run at **content-creation time, not match time**, so the matching loop (§5) stays pure geo-math and the AI never adds latency to the core experience. Both are single structured-output (JSON) calls to a hosted multimodal model, wrapped in a BullMQ job so a slow or failed model call never blocks the user's action.

**Job A — comment/reply moderation** (safety valve for §16)
- **Trigger:** a `review` or `review_reply` is submitted → row saved as `status='pending'` → `moderate` job enqueued.
- **Input:** the free-text body (+ minimal context: author role, whether it's a review or reply).
- **Prompt shape:** classify for abuse, harassment, spam, and PII leakage; return JSON only.
- **Output:** `{ verdict: allow|flag|block, categories: [...], pii_found: bool, confidence: 0..1, reason }`.
- **Effect:** `allow` → `status='visible'` and aggregates recomputed; `flag`/`block` → write `moderation_flags` (`source='ai'`, `score=confidence`) and leave hidden for a human moderator (§17).
- **Volume:** one call per submitted review/reply — occasional, not per-pickup.
- **Fail-safe:** on model error/timeout, default to `pending`/hidden (fail *closed* for safety), not auto-publish.

**Job B — photo → waste type & volume** (serves low-literacy UX + recycling)
- **Trigger:** a household attaches a photo to a broadcast/request → `classify-photo` job enqueued.
- **Input:** the image (multimodal).
- **Output:** `{ waste_type: general|recyclable|bulky|organic, volume: small|medium|large, confidence }`.
- **Effect:** auto-fills the waste-type tag (user taps the camera instead of reading a menu) and feeds matching + recycling routing; low confidence → fall back to the manual picker.
- **Volume:** one call per photo.
- **Note:** downscale/compress the image client-side before upload — saves the user's metered data *and* model input cost.

Both jobs live behind a single thin **`aiClient`** wrapper in `server/` (one place to swap model, key, and tier), called only from the moderation and broadcast workers.

### 18.2 Provider, cost & the free-vs-paid trigger

Use **Google's Gemini API** — one API covers both text moderation and image understanding with JSON output, on a **Flash-class model** (Pro is unnecessary here and is now paid-only). *(Numbers below reflect early-2026 terms and shift often — confirm on Google's live pricing page before committing.)*

| Stage | Tier | Why |
|---|---|---|
| Building & testing | **Free tier** (Google AI Studio) | ~1,500 requests/day, 15 RPM, multimodal + JSON included, no card. Far above dev/pilot volume. |
| Real users / pilot onward | **Pay-as-you-go (Tier 1) or Vertex AI** | Removes the data-sharing clause, raises limits, adds SLA. Cost is trivial at this scale — Flash text calls are fractions of a cent; images a few cents; **realistically a few dollars/month at pilot scale**. |

**The upgrade trigger is privacy, not volume.** On the free tier, prompts and responses may be used to improve Google's products — and Borla's AI inputs are exactly its most sensitive data: **review text that may contain names/disputes, and photos of people's homes tied to a location.** So the rule is hard: **flip to paid pay-as-you-go before the pilot touches real user data.** Free tier is for the workbench only.

Operational guardrails regardless of tier: keep the model key server-side only (never in the PWA/Capacitor client); strip/aggregate PII before sending where possible; log the model verdict, not the raw content, for audit; and treat the classifier as advisory — a human moderator always has final say on `flag`/`block`.

---

## 19. One-line summary

Borla is dispatch-pattern software (ride-hailing mechanics) applied to informal waste, split into a **cheap stateless broadcast plane** and a **shallow stateful request plane** over a **shared, self-healing presence layer** — with a two-sided review system for trust, an admin portal for ops and moderation, and AI confined to the trust/accessibility/ops edges rather than the matching core. The make-or-break stays operational (per-neighbourhood collector density, honest presence, fresh pins, earned notifications), not algorithmic.
