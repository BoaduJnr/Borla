<div class="cover">
<h1>Borla</h1>
<div class="sub">User Manual</div>
<div class="meta">
Student: <b>George Boadu Junior</b><br>
Student ID: <b>22427354</b><br>
Course: CSCD 602 — Advanced Software Engineering, University of Ghana<br>
Document: User_Manual.pdf &nbsp;·&nbsp; Version 1.0 &nbsp;·&nbsp; 13 August 2026
</div>
</div>

## 1. What Borla is

Borla connects households that have waste to dispose of with nearby collectors who are online
and looking for work. There are two ways to get matched:
- **Broadcast** — tap "I HAVE WASTE" and every nearby online collector sees a pin on their map.
  Whoever gets there first collects it; you clear the pin the moment someone shows up.
- **Direct request** — pick one specific collector from the map and send them a request; they
  accept or reject it, and if they accept, you can both see and call each other.

## 2. Logging in (all roles)

1. Open the app's URL (see `Deployment_and_Source_Links.txt`).
2. Enter your phone number.
3. If it's a brand-new number, pick **Household** or **Collector**.
4. Tap **Send OTP**.
5. **If SMS delivery is configured and working**, a text arrives with your 6-digit code and the
   screen simply says "Code sent via SMS — check your phone."
6. **If SMS delivery isn't available** (no gateway configured, or the send failed), the screen
   shows the code directly in a dark banner labelled "SMS delivery unavailable right now" — this
   is a documented, deliberate fallback (see `Technical_Debt_Plan.md` TD-02), not a bug: nobody
   is ever locked out just because a text didn't arrive.
7. Type the 6-digit code (from the text or the banner) and, if this is your first login, your
   name. Tap **Verify & continue**.

Admins do not use OTP — see §5.

## 3. Household walkthrough

1. After login you land on your **Home** screen: a map centred on your current location (allow
   location access when the browser asks), with green dots for nearby online collectors.
2. **To broadcast**: tap the big gold **"🔔 I HAVE WASTE"** button, optionally pick a waste type
   and add a short note, then **Confirm — I have waste**. A banner shows how many collectors
   were notified. The pin auto-expires after 45 minutes if you forget it.
3. **The moment someone comes for it**: tap **Clear pin** on the sticky banner — this removes
   it from every collector's map immediately, so nobody else wastes a trip.
4. **To request one specific collector**: scroll to "Nearby collectors," pick one, and tap
   **Request**. Your request appears under "My requests" with a status chip: *Sent* → *Seen* →
   *Accepted*/*Rejected*/*No response*.
5. **Once accepted**: tap **Show contact** to reveal the collector's phone number and call them
   directly. You'll also see a **⭐ Leave a review** option — rate 1–5 and optionally comment;
   it becomes public once it passes moderation and the other side has also reviewed (or after
   the review window closes).
6. **Profile tab**: adjust your alert radius and whether standing alerts are on; see reviews
   collectors have left about you.

## 4. Collector walkthrough

1. After login you land on your **Home** screen, offline by default.
2. **New collector accounts start unverified** — you'll see a banner saying an admin must
   approve you before you can go online. This is a deliberate anti-abuse gate (only verified
   collectors ever receive broadcasts); ask an admin to verify your account (§5).
3. **Go online**: tap **Go online** (allow location access). Your position updates while the
   tab stays open in the foreground — this build has no native background-location service, so
   locking your phone or switching apps pauses updates (documented in `Technical_Debt_Plan.md`
   TD-03; keep the tab open and the screen on while actively collecting).
4. **Nearby waste**: active pins appear on your map and in the list below it, closest first,
   with a one-tap **📞 Call** button.
5. **Incoming direct requests**: appear as a card with **Accept**/**Reject**. Accepting reveals
   the household's phone number to both of you and lets you leave a review afterwards.
6. **Go offline** when you're done — this immediately removes you from the matchable set.

## 5. Admin walkthrough

1. At the login screen, tap the **Admin** toggle instead of Household/Collector.
2. Enter the admin phone number and password (see `Deployment_and_Source_Links.txt` for the
   seeded demo admin credentials).
3. You land on **Admin — Ops console** with five tabs:
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
     timeout, review window) — changes apply immediately, no redeploy.

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
| Reviews never appear on a profile | Awaiting moderation and/or the other side hasn't reviewed yet | Check Admin → Moderation; double-blind release also waits up to the configured review window |
| Build fails on Render with "vite: not found" | `NODE_ENV=production` made `npm ci` skip devDependencies | Already fixed in `render.yaml` (`--include=dev` on the build command) |
