# VectorRun

Local-first web app for orienteering training analysis. Compare route decisions across runners with synchronized replay and per-leg splits.

## Requirements

- Node.js 20+
- npm

## Setup (local)

```bash
npm install
npm run seed    # creates a demo event with map + 3 GPX tracks
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Demo session (after seed):  
[http://localhost:3000/events/00000000-0000-4000-8000-000000000001](http://localhost:3000/events/00000000-0000-4000-8000-000000000001)

## Deploy on Railway

### 1. Push the repo to GitHub

```bash
git init
git add .
git commit -m "Initial VectorRun"
# create a GitHub repo, then:
git remote add origin git@github.com:YOU/VectorRun.git
git push -u origin main
```

### 2. Create the Railway project

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → select VectorRun.
2. Railway will build using the included `Dockerfile` (`railway.toml`).

### 3. Add a persistent volume (required)

Without this, GPX/maps/DB are lost on every redeploy.

1. Open your service → **Settings** → **Volumes** (or **+ Volume**).
2. Mount path: **`/data`**
3. Size: **1 GB** is enough to start.

### 4. Set environment variables

Service → **Variables**:

| Name | Value |
|------|--------|
| `DATA_DIR` | `/data` |
| `NODE_ENV` | `production` |

(`PORT` is set by Railway automatically.)

### 5. Generate a public URL

**Settings** → **Networking** → **Generate Domain**.

### 6. (Optional) seed demo data once

Railway service → one-off command / shell:

```bash
DATA_DIR=/data npx tsx scripts/seed-demo.ts
```

Or skip seeding and upload GPX in the UI.

### If something fails

- Build fails on `better-sqlite3` → confirm deploy uses the **Dockerfile**.
- Uploads vanish after redeploy → volume not at `/data`, or `DATA_DIR` missing.
- 502 → check **Deploy Logs**; app must listen on `0.0.0.0` (already configured).

## Workflow

1. **Create an event** (opens the session immediately).
2. **Upload GPX** — map image is optional.
3. **Optional Setup** — map georef and/or OSM controls for splits.
4. **Session** — replay, per-runner sync, speed chart, leg splits.

## Stack

- Next.js (App Router) + TypeScript + Tailwind
- SQLite (`better-sqlite3`) under `DATA_DIR` (default `./data`)
- Leaflet map with optional image overlay

## MVP scope

In: events, map/georef, controls, GPX, overlay, sync, replay, splits, speed chart.

Out (later): FIT/Strava, AI coach, clustering, long-term stats.
