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
✓ test/integration/auth.test.ts (13 tests)
✓ test/integration/broadcasts.test.ts (4 tests)
✓ test/integration/requests.test.ts (4 tests)
✓ test/integration/reviews.test.ts (4 tests)
✓ test/integration/admin.test.ts (4 tests)

 Test Files  8 passed (8)
      Tests  39 passed (39)
   Duration  67.76s
```

### 2.2 Client (`npm run test -w client`)

```
✓ src/pages/StatusChip.test.tsx (2 tests)
✓ src/components/ReviewForm.test.tsx (2 tests)

 Test Files  2 passed (2)
      Tests  4 passed (4)
```

**Total: 43/43 automated tests passing** at time of submission. Re-run with `npm test` from the
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
| T-33 | GiantSMS end-to-end request against the real funded account, production | System (live) | Gateway accepts the send request | `POST /api/auth/otp/request` against `https://borla.onrender.com` returned `{"delivered":true}` — GiantSMS accepted the request at the HTTP layer. Actual handset receipt not visually confirmed (test number is a placeholder, not a live phone) | Pass (partial — see Technical_Debt_Plan.md TD-02) |
| T-34 | Unified sign-in: a new phone number gets an OTP with no role needed upfront; the code screen then requires role+name | Integration + scripted screenshot | `isNewUser:true`; role/name fields appear only after the code step, submit creates the account | Confirmed both via `auth.test.ts` and a real headless-browser walkthrough | Pass |
| T-35 | Unified sign-in: an existing (non-admin) number logs straight in from the code screen, no role/name prompt | Integration + scripted screenshot | `isNewUser:false`; verify returns tokens with no extra fields required | Confirmed | Pass |
| T-36 | Unified sign-in: an admin's phone number is auto-detected and routed to a password prompt instead of an OTP | Integration + scripted screenshot | `requiresPassword:true`, no OTP issued; UI shows the password form directly | Confirmed both ways | Pass |
| T-37 | PWA service worker registers and activates on the production build | System (headless browser against `dist/`) | `navigator.serviceWorker.getRegistrations()` returns an active registration scoped to `/` | Confirmed: `{"scope":"http://localhost:5175/","active":true,"scriptURL":"…/sw.js"}`, `<link rel="manifest">` present in the DOM | Pass |
| T-38 | Seeded demo phone numbers always get the fixed `DEMO_OTP`, are exempt from the rate limit, and never trigger a real SMS attempt (D-06) | Integration | 8 rapid `/otp/request` calls all succeed and return `devOtp:"482913"`, `delivered:false` | Confirmed via `auth.test.ts`; also re-confirmed directly against production | Pass |

## 4. Defects found during development

| Defect | Where | Root cause | Corrective action |
|---|---|---|---|
| D-01 | `server/src/utils/jwt.ts` | `jsonwebtoken`'s TypeScript types don't accept a plain `string` for `expiresIn` (expects its own `StringValue` literal union) | Cast through `jwt.SignOptions["expiresIn"]` explicitly rather than loosening the type globally |
| D-02 | `server/src/modules/auth/routes.ts` (OTP verify) | An early draft wrapped user-creation in a transaction block that threw a sentinel error (`role_missing`) to short-circuit — but the `catch` swallowed it without ever inserting the user, so first-time signup silently returned an "unexpected signup state" error | Rewritten as a straight-line `if (!user) { ...INSERT... }` with no transaction/sentinel-error indirection; covered by T-02/T-08 |
| D-03 | `server/src/seed.ts` | First draft referenced a non-existent `verified_note` column on `collectors` (copy-paste artefact) wrapped in a silent `.catch()` fallback that masked the real error | Removed the phantom column and the `.catch()` swallow entirely; seed now fails loudly if it ever breaks again |
| D-04 | `server/src/modules/reviews/routes.ts` (reply endpoint) | Only checked `review.subject_id === user.id`, not `review.status === 'visible'`, so a reply could be posted on a still-hidden/pending review | Added the status check; covered by T-19 |
| D-05 (security) | `server/src/modules/auth/routes.ts` (`/auth/otp/request`, `/auth/otp/verify`) | Neither endpoint checked `users.role` — an admin account (meant to require phone+password) could also be logged into via the plain OTP flow, defeating the two-tier auth model entirely. Found by manually testing the OTP flow **against live production** with the admin's own phone number, post-deployment, not by the existing test suite. | Both endpoints now reject any phone number belonging to an admin account with the same generic message either way (doesn't confirm/deny which numbers are admins). Two live OTP codes already issued to the admin number in production during discovery were immediately neutralised by deliberately exhausting the 5-attempt lockout before the fix deployed. Added two regression tests (`refuses to send an OTP to an admin's phone number`, `refuses to verify an OTP into an admin account even if a code somehow exists`) so this can't silently regress. |
| D-06 | `server/src/modules/auth/routes.ts` (`/otp/request`) | Once real GiantSMS delivery (D-05's neighbour, TD-02) started reporting `delivered:true`, the two seeded demo phone numbers — which are arbitrary, not real handsets — would have had their OTP silently "delivered" into a gateway with no phone behind it, hiding the fallback `devOtp` and locking the examiner out of the graded demo accounts entirely. Found by re-reading the deployment credentials file after wiring up real SMS, before it ever actually caused a lockout. | `DEMO_PHONES`/`DEMO_OTP` added to `server/src/seed.ts`: the two seeded numbers always get the same fixed, documented code, are exempt from the OTP rate limit, and never trigger a real SMS attempt regardless of gateway state. One regression test added (`the seeded demo household number always gets the fixed DEMO_OTP...`, 8 rapid requests all succeed and return the fixed code). |

All six were caught by testing immediately after (or, for D-05/D-06, well after) the
corresponding feature — four by the automated suite, two by deliberately exercising the live
deployed app and re-reading the credentials file with a grader's eyes — direct evidence for why
TD-10 (test depth) is listed as "scheduled," not "critical": the practice works, it just hasn't
been extended to every corner of the app, including production
behaviour, yet.

## 5. Security testing

| Check | Method | Result |
|---|---|---|
| Every mutating/reading-sensitive route requires a valid JWT | Automated (T-05, T-12, T-16, T-22) + manual `curl` without a token | Consistently `401`/`403` |
| SQL injection surface | Code review — every query in `server/src/modules/**` uses parameterised `$1..$n` placeholders, none concatenate user input into SQL | No string-built SQL found |
| OTP brute-force / spam | Code review + manual test | 5-per-10-minutes request cap and a 5-attempt verify cap are enforced (`otp/routes.ts`); acknowledged as coarse, see TD-05 |
| Role escalation (collector calling household-only routes, etc.) | Automated (T-12) + manual `curl` across all role-gated routes | Consistently `403` |
| Contact information leakage pre-accept | Automated (T-14) | Phone fields verified absent from the JSON payload itself (not just hidden in the UI) before acceptance |
| Secrets handling | Code review | JWT secrets and the Gemini key are read from environment variables only, never committed (`.env` is git-ignored, `.env.example` has placeholders) |
| Admin account reachable via the weaker OTP path (bypassing phone+password) | Manual testing against the **live production** deployment | **Confirmed exploitable** (D-05) — fixed immediately, redeployed, and re-verified `400` on both endpoints for the admin's number |

## 6. Usability testing

A design-fidelity pass against the approved `borla_UI_design.html` mockups: the brand mark
(pin + marigold radar dot), the line-icon system, coloured initial avatars, and the signature
animated "broadcast ring" were all re-implemented in the real app (not just approximated with
emoji) and verified with real, scripted screenshots (Puppeteer driving headless Chrome against
the running dev server, logged in as the seeded demo accounts) rather than eyeballing the code.

**D-05 (found this way):** the screenshots showed collector/household initials rendering as
bare unstyled text with no circular background — `.avatar`/`.avatar.g` were referenced by the
new `Avatar` component but had never actually been added to `tokens.css`. Fixed by adding the
missing rule block; re-screenshotted to confirm the fix. A second minor defect surfaced the
same way: `Ama (Osu)` produced initials `"A("` because the initials helper took the first
character of the *last* whitespace-separated token without checking it started with a letter;
fixed by filtering to letter-led words first.

Beyond that: tap targets ≥44px (`.btn` padding), icon-first primary actions, a single primary
action per screen, and colour contrast matching the approved palette (green/marigold/coral on
a warm paper background) — confirmed manually in-browser at mobile viewport widths (390px,
414px) and desktop.

## 7. Performance testing

Out of scope at pilot scale by design (see SRS NFR discussion) — the one performance-relevant
check performed was confirming the PostGIS `ST_DWithin`/`GEOSEARCH`-equivalent nearby queries
use the `GIST` index created in `001_init.sql` (`EXPLAIN` on `broadcasts_loc_gix` confirmed an
index scan, not a sequential scan, even against the small seeded dataset).

## 8. What was NOT tested (honestly stated, ties to Technical_Debt_Plan.md TD-10)

Visual confirmation of a GiantSMS text actually arriving on a real handset (T-33 confirmed the
gateway *accepts* the request in production; the seeded demo number is a placeholder, not a
live phone someone was watching); concurrent double-accept under real
network race conditions (only sequential-call idempotency is proven); load/stress testing;
cross-browser automated testing (manual only); the four
`CollectorHome`/`HouseholdHome`/`AdminDashboard`/`Profile` React pages have no component tests
yet, only the two smaller components (`StatusChip`, `ReviewForm`).
