# PlaneTracker — Development Guide

> Last updated: 2026-11-10

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 20+ | LTS recommended |
| npm | 10+ | Comes with Node |
| Python | 3.11+ | For FastAPI backend |
| uv / pip | latest | Python package manager |

## Project Setup

```bash
# Clone
git clone <repo>
cd plane-tracker-main

# Frontend deps
npm install

# Backend deps
cd backend
pip install -r requirements.txt
# or: uv pip install -r requirements.txt
```

## Running Locally

### Frontend Only (Simulator Mode)
```bash
npm start
# → http://localhost:4200
# Hot reload enabled
# Uses FlightSimulatorService exclusively
```

### Full Stack (Production Mode)
```bash
# Terminal 1: Build frontend
npm run build

# Terminal 2: Start backend (serves dist/)
cd backend
uvicorn main:app --reload --host 0.0.0.0 --port 8000
# → http://localhost:8000
```

### Backend Only (API Development)
```bash
cd backend
uvicorn main:app --reload --port 8000
# API at http://localhost:8000/api/flights
# WebSocket at ws://localhost:8000/ws/flights
```

## Project Structure Deep Dive

### Frontend (`src/app/`)

```
app/
├── components/
│   ├── map/                    # 2D Leaflet map
│   │   ├── map.component.ts        # Main map logic (300+ lines)
│   │   ├── map.component.html      # Template (minimal)
│   │   ├── map.component.scss      # Styles (marker, card, cluster)
│   │   ├── aircraft-marker.overlay.ts  # Custom L.Layer for rotating markers
│   │   └── map-styles.ts           # Tile layer config (day/night)
│   ├── flight-view-3d/         # Three.js 3D view
│   │   ├── flight-view-3d.component.ts  # Main 3D logic (500+ lines)
│   │   ├── flight-view-3d.component.html
│   │   ├── flight-view-3d.component.scss
│   │   └── three/                  # Three.js submodules
│   │       ├── terrain.ts          # Esri + AWS terrain tiles
│   │       ├── aircraft-model.ts   # OBJ/MTL loader + banking
│   │       ├── clouds.ts           # Billboard particle clouds
│   │       ├── wing-trails.ts      # GPU particle wing trails
│   │       └── stars.ts            # Star dome (night only)
│   ├── aircraft-info-panel/    # Flight detail sidebar
│   │   ├── aircraft-info-panel.component.ts
│   │   ├── aircraft-info-panel.component.html
│   │   └── aircraft-info-panel.component.scss
│   └── header/                 # App bar + theme toggle
├── services/
│   ├── flight-simulator.service.ts    # Pure time→position (core)
│   ├── live-flight.service.ts         # WebSocket + enrichment
│   ├── map-theme.service.ts           # Day/night signal
│   └── radio.service.ts               # SpeechSynthesis + Web Audio
├── models/
│   ├── aircraft.model.ts       # Aircraft interface
│   ├── airport.model.ts        # Airport interface
│   └── flight-route.model.ts   # FlightRoute interface
├── data/
│   └── seed-data.ts            # 38 airports, 20 routes, 20 flights
├── utils/
│   ├── geo.ts                  # Great-circle math (slerp, bearing, haversine)
│   └── tiles.ts                # Web Mercator tile math + Terrarium decode
├── app.routes.ts               # Routes: '' (map), 'flight/:id/3d' (3D)
├── app.component.ts            # Root component
├── app.config.ts               # App config (provideRouter, etc.)
└── main.ts                     # Bootstrap
```

### Backend (`backend/`)

```
backend/
├── main.py                     # FastAPI app (single file, ~300 lines)
└── requirements.txt            # fastapi, uvicorn, httpx, websockets, python-dotenv
```

### Static Assets (`public/`)

```
public/
├── aircraft/
│   ├── 6E-201.jpg      # IndiGo A320neo
│   ├── AI-505.jpg      # Air India B787
│   └── UK-777.jpg      # Vistara B777
├── markers/
│   └── flight.svg      # Aircraft marker icon (nose-up)
└── models/
    ├── aircraft.obj    # 3D model (low-poly airliner)
    └── aircraft.mtl    # Material file
```

## Key Files to Understand First

| File | Why It Matters |
|------|----------------|
| `flight-simulator.service.ts` | Core data source — pure function, deterministic |
| `seed-data.ts` | All static data (airports, routes, flights) |
| `geo.ts` | Great-circle math — slerp matches Leaflet geodesic lines |
| `live-flight.service.ts` | WebSocket client + route enrichment logic |
| `map.component.ts` | 2D map — markers, clustering, follow, URL sharing |
| `flight-view-3d.component.ts` | 3D view — Three.js scene, terrain, effects |
| `backend/main.py` | Full backend — polling, normalization, WebSocket |
| `aircraft-marker.overlay.ts` | Custom rotating marker with hover card |

## Common Development Tasks

### Add a New Seed Flight
1. Edit `src/app/data/seed-data.ts`
2. Add entry to `SEED_FLIGHTS` array:
```typescript
{
  flightId: 'BAW283',
  airline: 'British Airways',
  aircraft: 'Airbus A350-1000',
  routeId: 'LHR-SFO',
  photo: 'aircraft/BAW283.jpg',  // Add file to public/aircraft/
}
```
3. Ensure `routeId` exists in `ROUTES` or add new route
4. Ensure airports exist in `AIRPORTS`

### Add a New Airport
```typescript
// In AIRPORTS object in seed-data.ts
'SYD': { code: 'SYD', name: 'Kingsford Smith', city: 'Sydney', lat: -33.9399, lon: 151.1753 },
```
Then reference in a `ROUTES` entry.

### Modify Simulator Physics
Edit `flight-simulator.service.ts`:
- `SPEED_RANGE_KTS` — min/max cruise speed
- `ALTITUDE_PROFILE` — climb/cruise/descent percentages
- `UPDATE_INTERVAL_MS` — emission rate (default ~16ms for 60fps)

### Change Map Tile Source
Edit `src/app/components/map/map-styles.ts`:
```typescript
const DAY_TILE_URL = 'https://your-tiles/{z}/{x}/{y}.png';
const NIGHT_TILE_URL = 'https://your-dark-tiles/{z}/{x}/{y}.png';
```
Must be keyless, CORS-enabled, 256px tiles, XYZ scheme.

### Add a New ADS-B Fallback Source
In `backend/main.py`, add to `FALLBACK_SOURCES` list:
```python
FALLBACK_SOURCES = [
    ("adsb.lol", fetch_adsb_lol),
    ("adsb.fi", fetch_adsb_fi),
    # Add yours here
]
```
Implement fetcher returning readsb-format JSON.

### Customize 3D Aircraft Model
1. Replace `public/models/aircraft.obj` and `.mtl`
2. Adjust offsets in `flight-view-3d.component.ts`:
```typescript
const MODEL_YAW_OFFSET_DEG = 90;   // Model nose direction
const MODEL_PITCH_OFFSET_DEG = 0;  // Level flight pitch
```
3. Scale if needed: `model.scale.setScalar(0.01)` in `AircraftModel.load()`

### Debug Simulator Positions
Open browser console:
```javascript
// Get simulator service (if exposed globally for debugging)
const sim = document.querySelector('app-root')._simulator; // or inject manually
sim.getCurrentFleet().forEach(p => console.log(p.flightId, p.latitude, p.longitude, p.progress));
```

### Inspect WebSocket Messages
```javascript
const ws = new WebSocket('ws://localhost:8000/ws/flights');
ws.onmessage = e => console.log(JSON.parse(e.data));
```

## Testing

### Unit Tests (Frontend)
```bash
npm test                    # Run once
npm run test:watch         # Watch mode
```
- Test `geo.ts` functions (pure, easy)
- Test `flight-simulator.service.ts` `sample()` at known timestamps
- Test `tiles.ts` coordinate conversions

### Backend Tests
```bash
cd backend
pytest                      # If tests added
```
Suggested: mock OpenSky/ADS-B responses, test normalization functions.

### E2E Tests (Optional)
```bash
npm run e2e                 # Cypress/Playwright if configured
```

## Code Style & Linting

```bash
npm run lint               # ESLint + Prettier
npm run format             # Prettier write
```
Config: `.eslintrc.json`, `.prettierrc`

### Angular-Specific
- Use `signal()` / `computed()` for reactive state (not `BehaviorSubject` where possible)
- Prefer `inject()` over constructor injection in new code
- Standalone components only (no NgModules)
- `OnPush` change detection by default

## Debugging Tips

### Simulator Determinism
`FlightSimulatorService.sample(nowMs)` is **pure** — same input = same output.
```typescript
// Replay a specific moment
const fleet = simulator.sample(1705312200000); // Jan 15 2026 10:30:00 UTC
```

### 3D View Performance
- `VISUAL_TIME_SCALE = 1.0` — samples the simulator at real time. The 0.15 slowdown was a workaround for hypersonic base speeds; with realistic 420–530 kts the tile grid (anchored to true lat/lon) loads at a natural pace, so no artificial slowdown is needed.
- Terrain tiles loaded in `TerrainManager` with priority queue by distance
- Max concurrent tile loads: 8 (configurable)
- LOD: tiles beyond 50km use lower zoom

### Marker Clustering (2D)
- Below zoom 8: grid-based clustering (cell size 160px → ~60-250km)
- Cluster shows count badge; click to zoom in
- Implemented in `MapComponent.updateClusters()`

### URL Sharing (2D)
- Format: `/lat,lng/zoom` (e.g. `/51.5,-0.1/8`)
- Parsed on init; written on `moveend` (debounced 500ms)
- FR24-compatible

## Extending the Project

### Add Historical Replay
1. Store `sample(nowMs)` outputs to IndexedDB/localStorage
2. Add time scrubber UI component
3. Feed stored positions to map/3D instead of live `fleet$`

### Add Multi-User Sync
1. Backend: add session ID to WebSocket, broadcast selected flight
2. Frontend: sync `selectedAircraftId` via WS
3. URL includes session: `/s/:sessionId/flight/:id/3d`

### Add Real ATC Audio
1. Replace `RadioService` with WebSocket to LiveATC or similar
2. Parse audio stream / metadata
3. Sync with aircraft position (sector-based)

### Add Weather Layer
1. Backend: fetch METAR/TAF or radar tiles
2. Frontend: overlay on map (Leaflet `L.TileLayer.WMS` or custom)
3. 3D: volumetric clouds via Three.js shaders

## Known Issues / Technical Debt

| Issue | Location | Severity |
|-------|----------|----------|
| `AIRLINE_ROUTES` duplicated in frontend + backend (stores ICAO; both copies share `ICAO_TO_IATA`) | `live-flight.service.ts`, `main.py` | Medium |
| Live flights have no `aircraft` type | OpenSky limitation | Low |
| `progress` always 0 for live → route overlay only draws a static origin→plane→destination line (no flown/remaining split) | `LiveFlightService` | Low |
| `eta` never populated (Phase 2) | `flight-simulator.service.ts` | Low |
| Model offsets hardcoded for current OBJ | `flight-view-3d.component.ts` | Low |
| No tests for Three.js components | `flight-view-3d/three/*.ts` | Medium |
| Cluster count badge not accessible | `map.component.ts` | Low |
| `VISUAL_TIME_SCALE` / `REFERENCE_SPEED_KTS` are visual tuning constants, not derived from physics | `flight-view-3d.component.ts` | Low |

## Useful Commands Cheat Sheet

```bash
# Frontend
npm start              # Dev server
npm run build          # Production build
npm run lint           # Lint
npm run format         # Format
npm test               # Unit tests

# Backend
cd backend
uvicorn main:app --reload --port 8000
python -c "import main; print(main.poll_flights())"  # Test poll once

# Docker
docker build -t plane-tracker .
docker run -p 8000:8000 plane-tracker

# Quick API test
curl localhost:8000/api/flights | jq '.[0]'
wscat -c ws://localhost:8000/ws/flights
```