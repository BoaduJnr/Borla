<div class="cover">
<h1>Borla</h1>
<div class="sub">User Manual</div>
<div class="meta">
Student: <b>George Boadu Junior</b><br>
Student ID: <b>22427354</b><br>
Course: CSCD 602 — Advanced Software Engineering, University of Ghana<br>
Document: User_Manual.pdf &nbsp;·&nbsp; Version 1.0 &nbsp;·&nbsp; 14 August 2026
</div>
</div>

## 1. What Borla is

Borla connects households that have waste to dispose of with nearby collectors who are online
and looking for work. There are two ways to get matched:
- **Broadcast** — tap "I HAVE WASTE" and every nearby online collector sees a pin on their map.
  Whoever gets there first collects it; you clear the pin the moment someone shows up.
- **Direct request** — pick one specific collector from the map and send them a request; they
  accept or reject it, and if they accept, you can both see and call each other.

Borla is a real installable web app (a PWA): after logging in, open **Profile** and tap
**Install Borla app** to add it to your home screen with its own icon, launching full-screen
like a native app (Chrome/Edge/Android; on iPhone, use Safari's Share → **Add to Home Screen**
instead, since iOS doesn't offer the same in-app install button). When a new version is
deployed, a banner appears at the bottom of the screen offering to **Update** — nothing changes
under you without asking first.

## 2. Logging in (all roles) — one unified flow

There is a single entry point for everyone. You never have to say upfront whether you're a
household, a collector, or an admin — **your phone number tells the app who you are**:

1. Open the app's URL (see `Deployment_and_Source_Links.txt`). You land on the welcome/splash
   screen — tap **Get started**.
2. Enter your phone number and tap **Continue**. That's the only field on this screen — no role
   picker, no "Admin" toggle to find.
3. What happens next depends on the number itself:
   - **It's a seeded admin's number** → you're taken straight to a password field ("This number
     is registered as an admin — sign in with your password"). Enter the password and tap
     **Sign in**. See §5 for the admin credentials.
   - **Anything else** → a one-time code is sent.
4. **If SMS delivery is configured and working**, a text arrives with your 6-digit code and the
   screen simply says "Code sent via SMS — check your phone."
5. **If SMS delivery isn't available** (no gateway configured, or the send failed), the screen
   shows the code directly in a dark banner labelled "SMS delivery unavailable right now" — this
   is a documented, deliberate fallback (see `Technical_Debt_Plan.md` TD-02), not a bug: nobody
   is ever locked out just because a text didn't arrive.
   - **Exception — the two seeded demo numbers** (`Deployment_and_Source_Links.txt`): since
     those numbers are arbitrary, not real handsets, they always use the same fixed code
     (**482913**) and the app never even attempts a real SMS send to them, so grading never
     depends on a text reaching a phone that doesn't exist. Any other, real phone number still
     gets a genuine random code.
6. Type the 6-digit code.
   - **Brand-new number** → the screen also asks "First time here — tell us a bit about you":
     pick **Household** or **Collector** and enter your name, then tap **Create account**.
   - **Number you've used before** → there's nothing else to fill in; tap **Verify & continue**
     and you're straight in.

## 3. Household walkthrough

Three tabs run across the top: **Home** (map + broadcast + nearby collectors), **My requests**
(anything still active/in progress), and **History** (arrived, cancelled, rejected, or timed
out — out of the way once there's nothing left to do, newest-resolved first).

1. **Home tab**: a map centred on your current location (allow location access when the browser
   asks), with green dots for nearby online collectors.
2. **To broadcast**: tap the big gold **"🔔 I HAVE WASTE"** button, optionally pick a waste type
   and add a short note, then **Confirm — I have waste**. A banner shows how many collectors
   were notified. The pin auto-expires after 45 minutes if you forget it.
3. **The moment someone comes for it**: tap **Clear pin** on the sticky banner — this removes
   it from every collector's map immediately, so nobody else wastes a trip.
4. **To request one specific collector**: scroll to "Nearby collectors," pick one, and tap
   **Request**. It shows up under **My requests** with a status chip: *Sent* → *Seen* →
   *On the way* → *Arrived*. **My requests** splits into two sections as things progress —
   **Awaiting response** (sent, not yet accepted) and **On the way** (accepted) — so a quick
   glance tells you which of your requests still need a collector's attention versus which are
   already in motion. If you've requested more than one collector at once, the "On the way"
   section automatically re-orders itself **closest-first**, live, as each collector's actual
   route distance changes — not just once when the page loads. You can only have one live
   request (awaiting response *or* accepted) with the same collector at a time — tapping
   **Request** again on someone you've already asked is turned down until that one resolves,
   rather than sending a confusing second copy.
5. **Changed your mind?** Tap **Cancel request** any time before the collector arrives —
   whether it's still awaiting a response or already accepted. Once the collector has arrived
   there's nothing left to cancel. If a collector doesn't respond in time, the request
   auto-cancels on its own — by default within about 90 seconds of sending it (an admin can
   tune this in Admin → Config, §5) — so you're never left staring at "Sent" forever.
6. **Once accepted**: tap **Show contact** to reveal the collector's phone number and call them
   directly. A small map also appears showing the **route to your collector** with distance and
   an estimated time — a straight line if the routing service is briefly unreachable, a real
   road route otherwise. The map **zooms in as the collector gets closer** — wide while they're
   still crossing the neighbourhood, tight once they're at your gate. Tap the map to open it
   full-screen (dimmed background, tap the ✕ or anywhere outside the map to close it) for a
   better look.
7. **Arrival**: once the collector is right at your pickup point, *they* confirm it on their end
   with an **Arrived** button — you'll get an SMS ("Your Borla collector has arrived!") plus an
   in-app notification the moment they do, no need to refresh or ask. The request then moves to
   **History**.
8. **Reviews**: rate 1–5 and optionally comment, right there on the request card. It joins a
   **shared thread** with the collector's own rating — the moment either one clears moderation,
   *both of you* see it, at the same time, in the same place. Either side can then reply, as
   many times as you like, building a real back-and-forth (also moderated) instead of one
   capped reply. Nothing is held back waiting for the other person to review first — that's a
   deliberate change (see Technical_Debt_Plan.md TD-15) after early testers found the old
   "hidden until both sides reviewed" behaviour confusing (the same request looked different
   depending on who was looking at it). **Once a request is in History**, its map is gone (there's
   nothing left to navigate to) and the conversation itself is tucked behind a **"View
   conversation"** toggle rather than shown by default — tap it to read the full thread. It's
   frozen at that point: no new rating, no new reply, on either side.
9. **Profile tab**: adjust your alert radius and whether standing alerts are on; see your
   overall star rating and review count. Individual comments live on their request card, not
   here — Profile only shows the summary.

## 4. Collector walkthrough

Three tabs: **Home** (online toggle + map + nearby waste), **Requests** (incoming + on-the-way),
and **History** (arrived, cancelled, rejected, or timed out, newest-resolved first).

1. **Home tab**: offline by default. The map here runs edge-to-edge (no side margins) so it
   feels like the main event rather than a small inset; once you're online, the **Go offline**
   button floats right on top of the map instead of sitting above it.
2. **New collector accounts start unverified** — you'll see a banner saying an admin must
   approve you before you can go online. This is a deliberate anti-abuse gate (only verified
   collectors ever receive broadcasts); ask an admin to verify your account (§5).
3. **Go online**: tap **Go online** (allow location access). Your position updates while the
   tab stays open in the foreground — this build has no native background-location service, so
   locking your phone or switching apps pauses updates (documented in `Technical_Debt_Plan.md`
   TD-03; keep the tab open and the screen on while actively collecting).
4. **Nearby waste**: active pins appear on your map and in the list below it, closest first,
   with a one-tap **📞 Call** button.
5. **Requests tab**: incoming direct requests appear as a card with **Accept**/**Reject**.
   Accepting reveals the household's phone number to both of you and moves it into "On the
   way," with a small map showing the **route to that household** (distance + estimated time),
   zooming in as you close the gap. If you have more than one on the way, they sort
   **closest-first**, live, as you move. Tap any route map to open it full-screen for a clearer
   look, with a dimmed background and a close button — once open, feel free to pan or pinch-zoom
   to look around; it stays where you leave it instead of snapping back to your live position on
   the next update.
6. **Cancel** is available on anything you've accepted but haven't reached yet — use it if
   you're no longer able to make the pickup.
7. **Arrival is a button, not automatic**: once your live position is close enough to the
   household's pickup point (the **arrival radius**, tuned by an admin in §5), an **Arrived**
   button appears on the request card. Tap it to confirm — the server double-checks you're
   actually within range before accepting the tap (your device claiming it isn't enough on its
   own), then texts the household ("Your Borla collector has arrived!") and notifies both of you
   in real time. The request then moves to **History**.
8. **History**: once a request is resolved, its map disappears and the review thread is hidden
   behind a **"View conversation"** toggle instead of showing by default; tap it to read (or
   leave/reply to) the review — though once there, the thread is frozen read-only, so any
   rating or reply needs to happen before the card leaves the active list.
9. **Go offline** when you're done — this immediately removes you from the matchable set.

## 5. Admin walkthrough

1. At the sign-in screen, enter the admin's phone number and tap **Continue** — there is no
   separate admin toggle to find; the app recognises the number and shows a password field
   instead of sending an OTP ("This number is registered as an admin — sign in with your
   password").
2. Enter the password (see `Deployment_and_Source_Links.txt` for the seeded demo admin
   credentials) and tap **Sign in**.
3. You land on **Admin — Ops console** with six tabs:
   - **Stats**: online collectors, users by role, broadcasts/requests by status, moderation
     backlog.
   - **Map**: live view of active pins (gold) and online collectors (green).
   - **Users**: search, **Verify** a collector (required before they can go online), or
     **Suspend**/**Reinstate** any account.
   - **Moderation**: AI-flagged/user-reported items to **Clear** or **Remove**, plus anything
     still awaiting moderation entirely (shown here whenever no `GEMINI_API_KEY` is configured)
     with a one-click **Approve**.
   - **Audit**: every privileged action taken by any admin, with a timestamp.
   - **Config**: live-editable operational settings (pin TTL, broadcast radius, request
     timeout, notification cap, arrival radius — how close a collector's live position must get
     to the pickup point before the Arrived button appears) — changes apply immediately, no
     redeploy.

## 6. Redeploying / rolling back

The app auto-builds from the `main` branch of the connected GitHub repository. To ship a
change: push to `main`; Render rebuilds and redeploys automatically. To roll back: in the Render
dashboard, open the service → **Events**/**Deploys** tab → pick an earlier successful deploy →
**Redeploy**. Database migrations run automatically on server boot
(`server/src/db/migrate.ts`) and are additive/idempotent — rolling the *app* back does not roll
the *schema* back, so avoid rolling back past a deploy that introduced a schema change unless
you also revert `server/migrations/`.

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Your collector account is not verified yet" | New collector account, not yet admin-approved | Log in as admin → Users → Verify |
| No collectors/pins showing on the map | Location permission denied, or nobody online nearby | Allow location access; try again once a collector/household is nearby in the seed data |
| OTP screen shows the code instead of "sent via SMS" | SMS gateway not configured or the send failed | Expected fallback — use the shown code; see Technical_Debt_Plan.md TD-02 |
| A review you wrote never shows up | Still awaiting moderation | It joins the shared thread on that request card the moment it clears — there's no waiting on the other person any more. An admin can check Admin → Moderation if it seems stuck |
| Build fails on Render with "vite: not found" | `NODE_ENV=production` made `npm ci` skip devDependencies | Already fixed in `render.yaml` (`--include=dev` on the build command) |
