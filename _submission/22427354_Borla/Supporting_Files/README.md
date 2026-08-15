# Borla

A real-time matchmaker connecting Ghanaian households with nearby roaming waste collectors —
built as the CSCD 602 (Advanced Software Engineering) individual capstone project.

> Borla is a **matchmaker, not a dispatcher**. A household broadcasts "I have waste" to every
> nearby online collector (no accept, no lock — whoever gets there first wins), or picks one
> collector directly and sends a request that goes through a real accept/reject/timeout state
> machine. See `docs/Project_Documentation.md` for the full write-up and
> `borla-technical-design.md` for the original (larger) design this build is intentionally
> scoped down from.

## Stack

- **Server**: Node.js + Express + TypeScript, PostgreSQL + PostGIS, Socket.IO, node-cron
- **Client**: React + Vite + TypeScript, Leaflet/OpenStreetMap, Socket.IO client
- **AI**: Gemini API for review/reply moderation (optional — degrades gracefully without a key)
- **Deploy**: Render (one Web Service serves both the API and the built client; one Postgres)

## Local development

Requires Node 20+ and a Postgres+PostGIS instance (the fastest way: `docker run -d --name
borla-postgres -e POSTGRES_USER=borla -e POSTGRES_PASSWORD=borla -e POSTGRES_DB=borla -p
5432:5432 postgis/postgis:16-3.4`).

```bash
npm install
cp .env.example server/.env   # then edit DATABASE_URL if needed
npm run seed -w server        # applies migrations + creates demo admin/household/collector
npm run dev                   # server on :4000, client on :5173 (proxies /api and /socket.io)
```

Log in with the phone numbers and password printed by `npm run seed` — see
`docs/User_Manual.md` for the full walkthrough. There is no real SMS gateway wired up in this
build; the OTP is returned directly in the API response / shown in the login screen.

## Tests

```bash
npm test              # server (vitest + supertest, needs a running Postgres) then client
npm run test:server
npm run test:client
```

## Documentation

See `docs/` for the SRS, effort estimation, technical debt plan, testing report, user manual,
and the consolidated project documentation covering the full lifecycle required by the course.

## Acknowledgements

Built with Express, PostgreSQL/PostGIS, Socket.IO, React, Vite, Leaflet/OpenStreetMap,
node-cron, and (optionally) Google's Gemini API. See `docs/Project_Documentation.md` §19
(References) for the full list with links.
