# PlaneTracker — Architecture Overview

> Last updated: 2026-11-10

## High-Level Structure

```
plane-tracker-main/
├── src/
│   ├── app/
│   │   ├── components/
│   │   │   ├── map/                 # 2D Leaflet map + markers
│   │   │   ├── flight-view-3d/      # Three.js 3D view + terrain
│   │   │   ├── aircraft-info-panel/ # Flight detail sidebar
│   │   │   ├── header/              # App bar + theme toggle
│   │   │   └── flight-selector/     # Dropdown to pick flight (if used)
│   │   ├── services/
│   │   │   ├── flight-simulator.service.ts   # Pure time→position function
│   │   │   ├── live-flight.service.ts        # WebSocket to backend
│   │   │   ├── map-theme.service.ts          # Day/night signal
│   │   │   └── radio.service.ts              # Synthetic ATC chatter
│   │   ├── models/                  # Aircraft, Airport, FlightRoute interfaces
│   │   ├── data/                    # seed-data.ts (38 airports, 20 routes, 20 flights)
│   │   ├── utils/
│   │   │   ├── geo.ts               # Great-circle math (slerp, bearing, haversine)
│   │   │   └── tiles.ts             # Web Mercator tile math + Terrarium elevation decode
│   │   ├── app.routes.ts            # / (map), /flight/:id/3d (3D view)
│   │   └── app.component.ts         # Root layout
│   └── assets/                      # Static assets (marker SVGs, aircraft OBJ/MTL)
├── backend/
│   └── main.py                      # FastAPI + OpenSky/ADS-B polling + WebSocket
├── public/
│   ├── aircraft/*.jpg               # 3 aircraft photos
│   ├── markers/flight.svg           # Aircraft marker icon
│   └── models/aircraft.obj|.mtl     # 3D aircraft model
└── dist/                            # ng build output (served by FastAPI in prod)
```

## Data Flow Modes

### Mode 1: Development (`ng serve`) — **Default**
- Angular dev server on `http://localhost:4200`
- **Only** `FlightSimulatorService` runs
- 20 aircraft computed client-side at ~60fps from wall-clock time
- No backend, no WebSocket, no live data

### Mode 2: Production (FastAPI serves `dist/`)
- FastAPI on `http://localhost:8000` serves static files + API
- `LiveFlightService` connects to `ws://host/ws/flights`
- Backend polls OpenSky every 10s (with OAuth2 if configured)
- Falls back to adsb.lol → adsb.fi → airplanes.live on rate-limit
- WebSocket pushes full fleet snapshot to all connected clients
- Simulator still available as fallback if WS disconnects

## Core Services

| Service | Responsibility | Key API |
|---------|---------------|---------|
| `FlightSimulatorService` | Pure function `sample(nowMs) → Aircraft[]` | `getFleet()` observable |
| `LiveFlightService` | WebSocket client + route enrichment | `fleet$` signal, `connect()` |
| `MapThemeService` | Day/night theme signal | `theme()` signal, `toggle()` |
| `RadioService` | SpeechSynthesis + Web Audio chatter | `start(plane)`, `stop()` |

## Component Communication

```
AppComponent
  ├─ HeaderComponent (theme toggle)
  ├─ MapComponent (2D view)
  │    ├─ consumes: FlightSimulatorService.getFleet()
  │    ├─ consumes: LiveFlightService.fleet$ (when connected)
  │    ├─ emits: selected aircraft → AircraftInfoPanel
  │    └─ emits: selected aircraft → FlightView3D (via router)
  ├─ AircraftInfoPanelComponent
  │    └─ @Input() aircraft: Aircraft | null
  └─ FlightView3DComponent (lazy-loaded route)
       ├─ reads flightId from ActivatedRoute
       ├─ subscribes to LiveFlightService.fleet$
       ├─ falls back to FlightSimulatorService.getFleet()
       └─ starts RadioService for that aircraft
```

## 3D View Architecture (Three.js)

```
Scene
 ├─ Camera (chase or cockpit)
 ├─ Lighting (sun + ambient, theme-aware)
 ├─ Terrain (Esri imagery + AWS elevation tiles)
 │    └─ TerrainManager: loads tiles around aircraft, LOD by distance
 ├─ Aircraft (OBJ/MTL model + pivot for banking)
 │    └─ AircraftModel: loads model, applies heading/roll
 ├─ Clouds (billboard particles, parallax scroll)
 ├─ WingTrails (GPU particle streaks, roll-coupled)
 └─ Stars (dome, night-only)

Animation Loop (requestAnimationFrame):
  1. Advance sim time by delta × VISUAL_TIME_SCALE (0.15)
  2. Update aircraft position/heading from fleet
  3. Update terrain anchor (lat/lon/alt) → TerrainManager.reload()
  4. Update cloud parallax, wing trails, banking animation
  5. Render
```

## Backend Architecture (FastAPI)

```
FastAPI App
 ├─ /api/flights           # REST snapshot
 ├─ /ws/flights            # WebSocket push (10s interval)
 ├─ /health                # Health check
 └─ StaticFiles(/app)      # Serves dist/ in production

Background Tasks:
 ├─ poll_flights() every 10s
 │    ├─ try OpenSky (OAuth2 token if configured)
 │    ├─ fallback: adsb.lol → adsb.fi → airplanes.live
 │    ├─ normalise each source → Aircraft dict
 │    ├─ enrich_routes_static() from AIRLINE_ROUTES map
 │    └─ broadcast to WebSocket clients
 └─ cleanup stale WS connections
```

## Key Design Decisions

1. **Simulator as pure function** — `sample(nowMs)` has no mutable state; enables deterministic replay, easy testing, smooth 60fps animation while representing 1Hz data.

2. **Great-circle interpolation (slerp)** — Matches Leaflet's `geodesic: true` polylines; avoids antimeridian drift and keeps heading aligned with path tangent.

3. **Shared static data** — `AIRLINE_ROUTES` map duplicated in frontend (for client-side enrichment) and backend (for server-side enrichment). Single source of truth would require a shared package.

4. **Terrain anchored to aircraft** — 3D view reloads imagery/elevation tiles around current position each frame; works because both sources are keyless and CORS-enabled.

5. **Visual time scale (0.15)** — Slows 2000–3500 kts sim speed to ~300–525 kts visual groundspeed to prevent tile thrashing and allow terrain streaming.

6. **No real ATC data** — Radio service is 100% synthetic atmosphere using browser TTS + Web Audio.

## Extension Points

| Feature | Where to Add |
|---------|--------------|
| New data source | Backend: add fetcher in `poll_flights()`; Frontend: normalise in `LiveFlightService.normalise()` |
| New map layer | `map-styles.ts` + `MapComponent.applyMapStyle()` |
| New 3D effect | `FlightView3DComponent` → add to scene in `initThree()` |
| Real ATC feed | Replace `RadioService` with WebSocket to ATC provider |
| Historical replay | Store `sample(nowMs)` outputs; add time scrubber UI |
| Multi-user sessions | Backend: add session management; Frontend: sync selected flight via WS |