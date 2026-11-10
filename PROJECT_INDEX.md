# PlaneTracker — Project Index

> Last updated: 2026-11-10

This repository contains a **flight tracking application** with both a client-side simulator (for demos/development) and a production-ready backend integrating live ADS-B data from OpenSky and fallback providers.

## Documentation Files

| File | Description |
|------|-------------|
| [`FEATURE_DATA_MAP.md`](FEATURE_DATA_MAP.md) | **Complete feature inventory** — every user-visible feature, its data source (mocked vs live), and all unused/generated-but-unused data points |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | **System architecture** — component diagram, data flow modes, service responsibilities, 3D view internals, backend design, extension points |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | **Operations guide** — dev/prod setup, Docker, nginx, OpenSky auth, monitoring, scaling, troubleshooting |
| [`API.md`](API.md) | **API reference** — REST endpoints, WebSocket protocol, Aircraft schema, OpenSky/ADS-B external APIs, frontend service APIs |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | **Developer guide** — project structure, key files, common tasks (add flight/airport, modify physics, change tiles, debug), testing, linting |
| [`DATA_MODELS.md`](DATA_MODELS.md) | **Data models** — TypeScript interfaces, seed data structures, backend dicts, geospatial utilities, marker interfaces, 3D data flow, validation rules |

## Quick Links

### For Developers
- **Start here:** `DEVELOPMENT.md` — project structure, common tasks, debugging
- **Data structures:** `DATA_MODELS.md` — all interfaces, seed data, backend formats
- **Architecture:** `ARCHITECTURE.md` — component communication, 3D scene graph, backend flow

### For Operations
- **Deploy:** `DEPLOYMENT.md` — dev/prod, Docker, nginx, OpenSky setup, health checks
- **API:** `API.md` — REST, WebSocket, external provider formats

### For Product/Review
- **Feature audit:** `FEATURE_DATA_MAP.md` — what's real vs mocked, what's unused, data flow summary

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend Framework | Angular 19 (standalone components, signals) |
| 2D Map | Leaflet 1.9 + custom rotating markers |
| 3D View | Three.js (r152+) + Esri imagery + AWS terrain |
| Backend | FastAPI + Uvicorn (Python 3.11+) |
| Live Data | OpenSky Network API (primary) + adsb.lol / adsb.fi / airplanes.live (fallbacks) |
| Real-time | WebSocket (native `ws` protocol) |
| Styling | SCSS + CSS custom properties (dark/light theme) |
| Build | Angular CLI + FastAPI static file serving |

## Data Flow Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                        DEVELOPMENT (ng serve)                   │
├─────────────────────────────────────────────────────────────────┤
│  FlightSimulatorService (pure function of wall-clock time)     │
│    └─► 20 aircraft on 20 great-circle routes                   │
│         ├─► MapComponent (2D Leaflet)                          │
│         ├─► AircraftInfoPanel (detail sidebar)                 │
│         └─► FlightView3D (Three.js + real terrain)             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ ng build + FastAPI serves dist/
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        PRODUCTION (FastAPI)                     │
├─────────────────────────────────────────────────────────────────┤
│  Backend (main.py)                                              │
│    ├─► Poll OpenSky every 10s (OAuth2 if configured)           │
│    ├─► Fallback: adsb.lol → adsb.fi → airplanes.live           │
│    ├─► Normalize → Aircraft dict                                │
│    ├─► Enrich routes from static AIRLINE_ROUTES map             │
│    └─► WebSocket broadcast + REST /api/flights                  │
│                                                                 │
│  Frontend (served from dist/)                                   │
│    └─► LiveFlightService connects to /ws/flights                │
│         ├─► Receives fleet updates                              │
│         ├─► Client-side route enrichment (callsign prefix)      │
│         └─► Feeds same components as simulator                  │
└─────────────────────────────────────────────────────────────────┘
```

## Key Characteristics

| Aspect | Status |
|--------|--------|
| **Primary data source (dev)** | Client-side simulator (20 flights, deterministic) |
| **Primary data source (prod)** | OpenSky Network API (live, global) |
| **Route overlays** | **Seeded flights**: always. **Live flights**: when the callsign prefix matches `AIRLINE_ROUTES` *and* both airports resolve in the `AIRPORTS` table (ICAO→IATA translated at enrichment time). |
| **Progress/ETA** | Simulated only (live: progress=0, ETA=empty) |
| **Aircraft type** | Seed data only (OpenSky doesn't provide) |
| **3D terrain** | Real-world (Esri imagery + AWS elevation, keyless) |
| **Radio/ATC** | 100% synthetic (browser TTS + Web Audio) |
| **Photos** | 3 real images cycled across 20 flights |

## Known Gaps (from `FEATURE_DATA_MAP.md`)

- `AIRLINE_ROUTES` map duplicated in frontend + backend (stores ICAO; both copies share an `ICAO_TO_IATA` translation table — keep them in sync)
- Live flights have no `aircraft` type, no `progress`, no `ETA`
- Route overlay only draws for seeded flights **and** for live flights whose callsign prefix matches `AIRLINE_ROUTES` with both airports seeded
- Model offsets hardcoded for current OBJ file
- No automated tests for Three.js components
- Cluster count badge not accessible (a11y)
- `VISUAL_TIME_SCALE` and `REFERENCE_SPEED_KTS` are visual tuning constants, not derived from physics

## Getting Started

```bash
# Development (simulator only)
npm install && npm start
# → http://localhost:4200

# Production (full stack)
npm run build
cd backend && pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
# → http://localhost:8000
```

## Repository Structure

```
plane-tracker-main/
├── src/app/                    # Angular frontend
│   ├── components/             # Map, 3D, Panel, Header
│   ├── services/               # Simulator, LiveFlight, Theme, Radio
│   ├── models/                 # Aircraft, Airport, FlightRoute
│   ├── data/                   # seed-data.ts (38 airports, 20 routes, 20 flights)
│   ├── utils/                  # geo.ts, tiles.ts
│   └── app.routes.ts           # Routes
├── backend/
│   └── main.py                 # FastAPI + OpenSky + WebSocket
├── public/                     # Static assets (images, OBJ/MTL, SVG)
├── dist/                       # Build output (served by FastAPI)
├── FEATURE_DATA_MAP.md         # Feature → data source audit
├── ARCHITECTURE.md             # System architecture
├── DEPLOYMENT.md               # Operations guide
├── API.md                      # API reference
├── DEVELOPMENT.md              # Developer guide
├── DATA_MODELS.md              # Data schemas
└── PROJECT_INDEX.md            # This file
```

## License / Attribution

**Tile Sources (keyless, CORS-enabled, attribution required):**
- OpenStreetMap: `https://tile.openstreetmap.org` — © OpenStreetMap contributors
- CartoDB Dark Matter: `https://basemaps.cartocdn.com` — © OpenStreetMap contributors © CARTO
- Esri World Imagery: `https://services.arcgisonline.com` — © Esri, Maxar, Earthstar Geographics
- AWS Terrain Tiles: `https://s3.amazonaws.com/elevation-tiles-prod` — AWS Terrain Tiles / Mapzen

**Data Sources:**
- OpenSky Network: https://opensky-network.org (OAuth2 for higher limits)
- adsb.lol: https://api.adsb.lol
- adsb.fi: https://adsb.fi
- airplanes.live: https://airplanes.live

---
*Generated documentation suite for PlaneTracker — see individual files for details.*