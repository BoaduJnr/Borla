<div class="cover">
<h1>Borla</h1>
<div class="sub">Testing Report</div>
<div class="meta">
Student: <b>George Boadu Junior</b><br>
Student ID: <b>22427354</b><br>
Course: CSCD 602 — Advanced Software Engineering, University of Ghana<br>
Document: Testing_Report.pdf &nbsp;·&nbsp; Version 1.0 &nbsp;·&nbsp; 13 August 2026
</div>
</div>

## 1. Test strategy

Four layers, in the order they were actually run during the build:

1. **Unit tests** (Vitest) — pure functions with no I/O: OTP hashing/verification, the
   quiet-hours time-window predicate.
2. **Integration tests** (Vitest + Supertest) — the real Express app (`createApp()`) against a
   real PostgreSQL+PostGIS instance (a local Docker container running the exact same
   `postgis/postgis:16-3.4` image family Render uses), covering every route's happy path and its
   most important failure mode.
3. **Component tests** (Vitest + React Testing Library) — client-side rendering/interaction
   logic in isolation, with `fetch` mocked.
4. **System / User Acceptance Testing** — manual, scripted, end-to-end walkthroughs against the
   running application (server + Postgres + browser), exercising both roles and the admin
   console exactly as a real user would.

Security and usability checks (§5, §6) were folded into the same passes rather than run as a
separate phase, which is appropriate at this scale.

## 2. Automated test results

### 2.1 Server (`npm run test -w server`)

```
✓ test/unit/otp.test.ts (3 tests)
✓ test/unit/quietHours.test.ts (4 tests)
✓ test/unit/sms.test.ts (3 tests)
✓ test/integration/auth.test.ts (8 tests)
✓ test/integration/broadcasts.test.ts (4 tests)
✓ test/integration/requests.test.ts (4 tests)
✓ test/integration/reviews.test.ts (4 tests)
✓ test/integration/admin.test.ts (4 tests)

 Test Files  8 passed (8)
      Tests  34 passed (34)
   Duration  14.60s
```

### 2.2 Client (`npm run test -w client`)

```
✓ src/pages/StatusChip.test.tsx (2 tests)
✓ src/components/ReviewForm.test.tsx (2 tests)

 Test Files  2 passed (2)
      Tests  4 passed (4)
```

**Total: 38/38 automated tests passing** at time of submission. Re-run with `npm test` from the
repository root (requires a reachable Postgres+PostGIS — see `README.md`).

## 3. Test case log

Representative cases spanning all four rubric areas (functional, unit, integration, system/UAT).
"Actual result" reflects the real run, including two real defects caught and fixed during
development (rows T-08 and T-19).

| # | Test case | Layer | Expected result | Actual result | Pass/Fail |
|---|---|---|---|---|---|
| T-01 | Request an OTP for a brand-new phone number with no `role` | Integration | `400` — role required to sign up | `400` returned with actionable message | Pass |
| T-02 | Request an OTP, verify with the correct code | Integration | New user created, `access`/`refresh` issued | User created with `role='household'`, tokens returned | Pass |
| T-03 | Verify with an incorrect 6-digit code | Integration | `400`, attempt counter incremented | `400` returned | Pass |
| T-04 | Re-use an already-consumed OTP code | Integration | `400` — rejected as already used | `400` returned | Pass |
| T-05 | `GET /auth/me` with no bearer token | Integration | `401` | `401` returned | Pass |
| T-06 | `GET /auth/me` with a valid token | Integration | `200` with role-specific profile | `200`, `profile.alert_radius_m` present for household | Pass |
| T-07 | Admin login with a non-admin phone number | Integration | `401` | `401` returned | Pass |
| T-08 | **(defect)** OTP-verify signup path for a brand-new number | Integration (found while writing T-02) | New user row created with the requested role | **First implementation threw `role_missing` inside a dead transaction branch and never created the user** — see §4 | Fail → **Fixed**, now Pass |
| T-09 | Collector attempts to go online before admin verification | Integration | `403` | `403` returned | Pass |
| T-10 | Verified + online collector, household broadcasts nearby | Integration | Fan-out notifies ≥1 collector; pin appears in that collector's `/pins/nearby` | `notifiedCollectors: 1`; pin present with correct `distance_m` | Pass |
| T-11 | Household creates a second broadcast while one is active | Integration | `409` | `409` returned | Pass |
| T-12 | Collector role attempts to create a broadcast | Integration | `403` (role guard) | `403` returned | Pass |
| T-13 | Household requests an **offline** collector | Integration | `409` | `409` returned | Pass |
| T-14 | Full request lifecycle: requested → seen → accepted, contact reveal timing | Integration | Phone numbers absent pre-accept, present post-accept | Confirmed via direct field assertion pre/post | Pass |
| T-15 | Reject a request **after** it was already accepted | Integration | `409`, status stays `accepted` (not resurrected to `rejected`) | `409` returned, status unchanged | Pass |
| T-16 | A collector who wasn't the request's target tries to accept it | Integration | `409` (conditional update matches 0 rows) | `409` returned | Pass |
| T-17 | Review submitted against a request that is **not yet accepted** | Integration | `400` | `400` returned | Pass |
| T-18 | Duplicate review on the same accepted request | Integration | `409` (unique constraint) | `409` returned | Pass |
| T-19 | **(defect)** Reply to a review before it is moderation-visible | Integration (found while writing this test) | `400` — cannot reply to a non-visible review | **First implementation only checked `subject_id`, not `status`, allowing a reply on a still-pending review** — see §4 | Fail → **Fixed**, now Pass |
| T-20 | Second reply attempt on an already-replied review | Integration | `409` (one reply per review) | `409` returned | Pass |
| T-21 | Admin verifies a collector; collector can now go online; action appears in audit log | Integration | `200` → `200`; `audit_log` contains `verify_collector` | All three confirmed | Pass |
| T-22 | Admin suspends a household; suspended user's `/auth/me` is blocked; reinstate restores access | Integration | `403` while suspended, `200` after reinstatement | Confirmed | Pass |
| T-23 | Admin edits an unknown config key | Integration | `404` | `404` returned | Pass |
| T-24 | Full **system walkthrough**: household broadcast → collector sees pin on map → household clears it | System/UAT (manual, live server) | Pin visible then gone from collector's feed | Verified against the running app with real curl/browser sessions | Pass |
| T-25 | Full **system walkthrough**: direct request → accept → contact reveal → review both sides → double-blind release fires within the 2-minute sweep window | System/UAT (manual, live server) | Both reviews become visible **simultaneously**, rating aggregates recompute correctly | `rating_avg`/`rating_count` confirmed via direct DB query after the sweep ran | Pass |
| T-26 | Manual moderation fallback (no `GEMINI_API_KEY` set) | System/UAT | Submitted reviews appear in `/admin/moderation/queue → awaitingManual`, not silently published | Confirmed — both test reviews appeared, required explicit admin approval | Pass |
| T-27 | Quiet-hours predicate across a midnight-wrapping window | Unit | Inside/outside window classified correctly at boundaries | 4/4 boundary cases correct | Pass |
| T-28 | OTP hash/verify round-trip and mismatch rejection | Unit | Correct code verifies true, wrong code false | Both confirmed | Pass |
| T-29 | `StatusChip` renders the correct label for every request status + an unknown fallback | Component | Exact label text present for each of 5 statuses + fallback | Confirmed | Pass |
| T-30 | `ReviewForm` treats a `409` (already reviewed) the same as success | Component | Renders the thank-you state, not an error banner | Confirmed | Pass |
| T-31 | Production client build (`vite build`) and server build (`tsc`) both compile clean | Build/System | Zero TypeScript errors, bundle produced | Both confirmed (`tsc --noEmit` clean; `dist/` produced) | Pass |
| T-32 | GiantSMS phone-number normalisation (`+233…` / `233…` → local `0…` form) | Unit | Both prefixes normalise to the same local number; an already-local number is untouched | 3/3 cases correct | Pass |
| T-33 | GiantSMS end-to-end SMS delivery against the real funded account | Not run | — | **Not exercised** — the HTTP contract was reconstructed from third-party client libraries, not confirmed with a real send (Technical_Debt_Plan.md TD-02) | N/A |

## 4. Defects found during development

| Defect | Where | Root cause | Corrective action |
|---|---|---|---|
| D-01 | `server/src/utils/jwt.ts` | `jsonwebtoken`'s TypeScript types don't accept a plain `string` for `expiresIn` (expects its own `StringValue` literal union) | Cast through `jwt.SignOptions["expiresIn"]` explicitly rather than loosening the type globally |
| D-02 | `server/src/modules/auth/routes.ts` (OTP verify) | An early draft wrapped user-creation in a transaction block that threw a sentinel error (`role_missing`) to short-circuit — but the `catch` swallowed it without ever inserting the user, so first-time signup silently returned an "unexpected signup state" error | Rewritten as a straight-line `if (!user) { ...INSERT... }` with no transaction/sentinel-error indirection; covered by T-02/T-08 |
| D-03 | `server/src/seed.ts` | First draft referenced a non-existent `verified_note` column on `collectors` (copy-paste artefact) wrapped in a silent `.catch()` fallback that masked the real error | Removed the phantom column and the `.catch()` swallow entirely; seed now fails loudly if it ever breaks again |
| D-04 | `server/src/modules/reviews/routes.ts` (reply endpoint) | Only checked `review.subject_id === user.id`, not `review.status === 'visible'`, so a reply could be posted on a still-hidden/pending review | Added the status check; covered by T-19 |

All four were caught by writing the test suite immediately after the corresponding feature,
not by separate manual QA — direct evidence for why TD-10 (test depth) is listed as
"scheduled," not "critical": the practice worked, it just hasn't been extended to every corner
of the app yet.

## 5. Security testing

| Check | Method | Result |
|---|---|---|
| Every mutating/reading-sensitive route requires a valid JWT | Automated (T-05, T-12, T-16, T-22) + manual `curl` without a token | Consistently `401`/`403` |
| SQL injection surface | Code review — every query in `server/src/modules/**` uses parameterised `$1..$n` placeholders, none concatenate user input into SQL | No string-built SQL found |
| OTP brute-force / spam | Code review + manual test | 5-per-10-minutes request cap and a 5-attempt verify cap are enforced (`otp/routes.ts`); acknowledged as coarse, see TD-05 |
| Role escalation (collector calling household-only routes, etc.) | Automated (T-12) + manual `curl` across all role-gated routes | Consistently `403` |
| Contact information leakage pre-accept | Automated (T-14) | Phone fields verified absent from the JSON payload itself (not just hidden in the UI) before acceptance |
| Secrets handling | Code review | JWT secrets and the Gemini key are read from environment variables only, never committed (`.env` is git-ignored, `.env.example` has placeholders) |

## 6. Usability testing

A short heuristic pass against the approved `borla_UI_design.html` design system: tap targets
≥44px (`.btn` padding), icon-first primary actions ("🔔 I HAVE WASTE", "🚛 Go online"), a
single primary action per screen, and colour contrast matching the approved palette (green/
marigold/coral on a warm paper background). Confirmed manually in-browser at mobile viewport
widths (390px, 414px) and desktop.

## 7. Performance testing

Out of scope at pilot scale by design (see SRS NFR discussion) — the one performance-relevant
check performed was confirming the PostGIS `ST_DWithin`/`GEOSEARCH`-equivalent nearby queries
use the `GIST` index created in `001_init.sql` (`EXPLAIN` on `broadcasts_loc_gix` confirmed an
index scan, not a sequential scan, even against the small seeded dataset).

## 8. What was NOT tested (honestly stated, ties to Technical_Debt_Plan.md TD-10)

Real end-to-end SMS delivery via GiantSMS (T-33 — deliberately not fired against the funded
account during this test pass to avoid burning real SMS credit on an unverified integration;
the safe fallback to on-screen OTP was verified instead); concurrent double-accept under real
network race conditions (only sequential-call idempotency is proven); load/stress testing;
cross-browser automated testing (manual only); the four
`CollectorHome`/`HouseholdHome`/`AdminDashboard`/`Profile` React pages have no component tests
yet, only the two smaller components (`StatusChip`, `ReviewForm`).
