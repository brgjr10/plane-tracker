# ✈️ PlaneTracker

> Last updated: 2026-11-10

A live flight tracker built in Angular 19 — simulated aircraft moving along real great-circle routes across continents, with a Leaflet 2D map and a Three.js 3D chase-camera view (plus a cockpit mode). Designed as the frontend for a future event-driven backend, so every model is shaped like the Kafka event that will eventually feed it.

<img width="1365" height="638" alt="2D map — day mode" src="https://github.com/user-attachments/assets/b04b9938-d32e-439c-9cc8-e451e868a2b8" />

<img width="1364" height="634" alt="image" src="https://github.com/user-attachments/assets/34e24c19-edb0-43be-84b4-f5a3009628d7" />

<img width="1363" height="633" alt="3D flight view — day mode" src="https://github.com/user-attachments/assets/ba8353fc-7bfb-4057-8281-363aca574b7c" />

---

## Architecture

Today the simulator runs in the browser; the backend (FastAPI + OpenSky/ADS-B) is built but dormant in development. The `Aircraft` model is already shaped as the future `flight-position` event, so the UI won't change when the data source flips.

| Mode | Data Source | Backend |
|------|-------------|---------|
| **Development** (`ng serve`) | Client-side simulator (20 flights, pure function of time) | None |
| **Production** (FastAPI serves `dist/`) | OpenSky Network API + ADS-B fallbacks via WebSocket | `backend/main.py` |

---

## What it does

**20 aircraft** on intercontinental routes (JFK↔LHR, DXB↔SIN, NRT↔SYD, LHR↔YYZ, and more), continuously simulated in-browser. In production, live aircraft from OpenSky replace the simulator.

### 2D map
- **Great-circle routes** — planes follow real spherical paths, including antimeridian crossings (Seoul → LA takes the Pacific, not Europe)
- **Route overlay** — click a flight to see its flown/remaining path drawn as a great-circle arc; other planes fade out so the route reads clearly
- **Follow mode** — the map pans smoothly (~5 s cadence) to keep the selected plane centred at your current zoom
- **Shareable URL** — pan/zoom updates `/lat,lng/zoom` in the address bar (FR24-style), so any view is a link you can paste
- **Day/night themes** — muted-colourful map by day, dark by night; theme swap propagates everywhere
- **Info panel** — aircraft photo, type, live altitude/speed/heading, progress bar
- **Altitude-scaled markers** with heading rotation and a hover card
- **Clustering** — below zoom 8, nearby aircraft bucket into grid cells with count badges

### 3D flight view
- **Chase camera** behind the aircraft, with orbit controls (drag to look around)
- **Cockpit view** — first-person camera fixed on the heading, view rolls with the banking
- **Real-world terrain** — satellite imagery draped over open elevation tiles (Esri World Imagery + AWS Terrain Tiles, both keyless/no-billing), GPU-displaced in the vertex shader and anchored to the aircraft's live lat/lon so the actual ground streams past
- **Occasional gentle banking** — the plane eases into random ±8–18° rolls between straight-flight periods
- **Wind streaks** off the trailing edges of both wings, speed-scaled
- **Drifting billboard clouds** with parallax scroll
- **Starfield** at night — 820 stars on a fixed dome, cool-blue and warm-yellow tints
- **Radio chatter toggle** for atmosphere
- **Day/night theming** on sky, fog, terrain, clouds, lights

---

## Tech stack

**Frontend:** Angular 19 (standalone components, signals), TypeScript, RxJS, Leaflet + OpenStreetMap/CartoDB tiles (no API key), Three.js, GLSL shaders.

**Backend:** FastAPI + Uvicorn, OpenSky Network API (primary), adsb.lol / adsb.fi / airplanes.live (fallbacks), WebSocket (native protocol), OAuth2 for OpenSky auth.

---

## The interesting bits

A few implementation details I enjoyed figuring out:

- **Spherical slerp** for aircraft positions ([`geo.ts`](src/app/utils/geo.ts)) — a linear lat/lng lerp drifts off `geodesic: true` polylines and goes the wrong way across the antimeridian. Slerp fixes both, and because Mercator is conformal, the great-circle bearing matches the on-screen tangent — so headings line up with actual motion for free.
- **Time-based simulator** ([`flight-simulator.service.ts`](src/app/services/flight-simulator.service.ts)) — positions are a *pure function of wall-clock time*, so the render loop can sample at 60 fps for smooth motion while the data still represents a 1 Hz feed. No drift.
- **GPU terrain splatting** ([`terrain.ts`](src/app/components/flight-view-3d/terrain.ts)) — one plane geometry, vertex displacement in a custom shader chunk, biome weights driven by elevation *and* slope in the fragment shader, blended photo textures + normal maps per biome. World-XZ-aligned UVs mean the tangent basis is trivial (no tangent attributes needed).
- **URL-synced view** ([`map.component.ts`](src/app/components/map/map.component.ts)) — Google Maps' `idle` event is a naturally-debounced "movement done" signal, so no manual throttling.

---

## Getting started

### Development (simulator only — no backend needed)

```bash
npm install
ng serve
```

Then open [http://localhost:4200](http://localhost:4200).

### Production (full stack)

```bash
# Build frontend
npm run build

# Start backend (serves dist/ + API + WebSocket)
cd backend
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

Then open [http://localhost:8000](http://localhost:8000).

> The 3D view's terrain streams keyless open tiles — **Esri World Imagery** (© Esri, Maxar, Earthstar Geographics) for satellite imagery and **AWS Terrain Tiles / Mapzen** for elevation. No API key or billing account is required; the credit line rendered in the view satisfies both sources' attribution terms.

---

## Documentation

| File | Description |
|------|-------------|
| [`FEATURE_DATA_MAP.md`](FEATURE_DATA_MAP.md) | Complete feature audit — every feature, its data source (mocked vs live), and all unused/generated-but-unused data points |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | System architecture — component diagram, data flow modes, 3D scene graph, backend design |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Operations guide — dev/prod setup, Docker, nginx, OpenSky auth, monitoring, troubleshooting |
| [`API.md`](API.md) | API reference — REST endpoints, WebSocket protocol, Aircraft schema, OpenSky/ADS-B formats |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | Developer guide — project structure, key files, common tasks, testing, linting |
| [`DATA_MODELS.md`](DATA_MODELS.md) | Data models — TypeScript interfaces, seed data, backend dicts, geospatial utilities |

---

## Credits

Terrain textures are CC0 from [Poly Haven](https://polyhaven.com) — full attribution in [`public/textures/terrain/CREDITS.md`](public/textures/terrain/CREDITS.md).

---

## Roadmap

- **Phase 1 — Frontend** ✅
- **Phase 2 — Event-driven backend** 🚧: Kafka, WebSocket gateway, Tracking service (Redis), REST gateway, notifications, analytics, DLQ resilience.

---

## Local development notes

Dev server: `ng serve` — hot-reloads on save.
Build: `ng build` — output to `dist/`.