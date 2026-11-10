# PlaneTracker — Feature & Data Source Map

> Last updated: 2026-11-10

This document catalogs every user-visible feature in the application, its data source (mocked vs. live), and any data that is generated/called but **unused** in the current implementation.

---

## Overview of Data Flow

| Layer | Source | Notes |
|-------|--------|-------|
| **Frontend (Angular)** | Client-side simulation (`FlightSimulatorService`) | Pure TS, runs in browser |
| **Backend (FastAPI)** | OpenSky Network API + ADS-B fallbacks (adsb.lol, adsb.fi) | Polled server-side, pushed via WebSocket |
| **Static Seed Data** | `src/app/data/seed-data.ts` | 20 hardcoded flights, 38 airports, 20 routes |

The app **currently runs entirely on the client-side simulator**. The backend exists but is not wired into the Angular dev server — the `LiveFlightService` connects to `/ws/flights` which only exists when the FastAPI backend serves the built frontend.

---

## Features by Component

### 1. Aircraft Info Panel (`aircraft-info-panel.component.ts`)

| Feature | Data Fields | Source |
|---------|-------------|--------|
| Flight code | `flightCode` | `Aircraft.flightId` (live from simulator or OpenSky) |
| Airline name | `airline` | `Aircraft.airline` (seed data for sim; OpenSky `airline` field for live) |
| Aircraft type | `aircraftType` | `Aircraft.aircraft` (seed data for sim; OpenSky `aircraft` field for live — often empty) |
| Aircraft photo | `photoUrl` | **Static seed lookup** via `SEED_FLIGHTS.find(...).photo` — only works for seeded flights |
| Origin airport | `origin.code`, `origin.city`, `origin.airport` | `Aircraft.source` (IATA) → resolved via `AIRPORTS` static map |
| Destination airport | `destination.code`, `destination.city`, `destination.airport` | `Aircraft.destination` (IATA) → resolved via `AIRPORTS` static map |
| Progress bar | `progress` (0–1) | **Simulator**: computed from great-circle distance + speed × elapsed time<br>**Live (OpenSky)**: always `0` (not provided by API) |
| Altitude | `altitudeFt` | **Simulator**: vertical profile (climb/cruise/descent) from `progress`<br>**Live**: `baro_altitude` from OpenSky state vector (m → ft) |
| Speed | `speedKts` | **Simulator**: randomised 420–530 kts per flight<br>**Live**: `velocity` from OpenSky (m/s → kts) |
| Heading | `headingDeg` | **Simulator**: great-circle bearing from current position to destination<br>**Live**: `true_track` from OpenSky (degrees) |

**Unused / never rendered in panel:**
- `departure` (ISO timestamp) — present on `Aircraft` but not displayed
- `eta` — always empty string in both simulator and live
- `onGround` — not shown in panel (used only for map filtering)

---

### 2. 2D Map (`map.component.ts`)

| Feature | Data Source |
|---------|-------------|
| **Base map tiles** | Day: OpenStreetMap (`tile.openstreetmap.org`)<br>Night: CartoDB Dark Matter (`basemaps.cartocdn.com`) — both keyless |
| **Aircraft markers** | Position: `Aircraft.latitude` / `longitude` (simulator or live)<br>Heading: `Aircraft.heading` (simulator bearing or OpenSky `true_track`)<br>Size: scaled by `Aircraft.altitude` (30–52px for 0–35k ft) |
| **Marker hover card** | Same fields as info panel (via `AircraftCardInfo`) — photo from seed lookup |
| **Route overlay (flown/remaining)** | **Only for seeded flights**: `AIRPORTS[plane.source]` + `AIRPORTS[plane.destination]` → great-circle polyline split at current `progress`<br>**Live OpenSky flights**: NO route drawn (empty `source`/`destination`) |
| **Follow mode** | Pans map to selected aircraft every 5s (`FOLLOW_PAN_INTERVAL_MS`) using live position |
| **Shareable URL** | `/lat,lng/zoom` format (FR24-style) — reads/writes `router.url` on `moveend` |
| **Day/night theme** | `MapThemeService` signal (`'day'` \| `'night'`) — toggled from header |
| **Clustering** | Below zoom 8, buckets nearby aircraft into grid cells (160px cells, 60–250km) — shows count badge |
| **Hide grounded toggle** | Filters `Aircraft.onGround === true` — only meaningful for live OpenSky data |
| **URL view parsing** | On load, parses `/lat,lng/zoom` from URL if present; otherwise `fitBounds(worldBounds)` |

**Unused / dead code in map component:**
- `LABEL_ZOOM_THRESHOLD` (imported from `map-styles.ts`, value `7`) — referenced in `applyMapStyle()` but **labels visibility is never actually toggled** (the tile layers don't support label layers)
- `airportLabel(code)` method — defined but **never called**
- `selectedFlightInfo` computed uses `panelInfoFor()` which looks up `SEED_FLIGHTS` for photo — **live flights get empty photo**

---

### 3. Flight Simulator (`flight-simulator.service.ts`)

**This is the PRIMARY data source for the current demo.** All 20 aircraft positions are computed here.

| Computed Field | Formula / Source |
|----------------|------------------|
| `latitude`, `longitude` | Spherical slerp (`interpolatePosition`) along great-circle from `route.source` → `route.destination` at fraction `progress` |
| `progress` (0→1 loop) | `(speedKts × elapsedHours) % distanceNm / distanceNm` — wraps continuously |
| `heading` | `bearing(currentPosition, route.destination)` — great-circle initial bearing |
| `speed` | Randomised per flight: `420 + Math.random() × 110` kts (constant per flight) |
| `altitude` | Piecewise: climb 0→15% (0→35k ft), cruise 15%→85% (35k ft), descent 85%→100% (35k→0 ft) |
| `departure` | `new Date(legStartMs).toISOString()` — recomputed each loop |
| `eta` | **Always empty string** — `// ETA intentionally deferred for now (Phase 2 scope)` |
| `onGround` | **Always `false`** — simulator only generates airborne aircraft |
| `flightId`, `airline`, `aircraft`, `source`, `destination` | Copied directly from `SEED_FLIGHTS` + `ROUTES` (static data) |

**Key design:** `sample(nowMs)` is a **pure function of wall-clock time** — no mutable state, no drift. Called at ~60fps for smooth animation while representing a 1Hz feed.

---

### 4. Live Flight Service (`live-flight.service.ts`)

**Currently UNUSED in the Angular dev server** — only active when FastAPI backend serves the built app.

| Feature | Data Source |
|---------|-------------|
| WebSocket connection | `/ws/flights` (same host, `ws:` or `wss:`) |
| Fleet updates | Server pushes full fleet snapshot every 10s (OpenSky) or 10s (fallback ADS-B) |
| Aircraft normalisation | Maps backend dict → strict `Aircraft` interface (see `normalise()`) |
| Route enrichment | **Client-side**, incremental: matches `flightId` callsign prefix (e.g. `BAW123` → `BAW`) against static `AIRLINE_ROUTES` map (copied from backend). The map stores **ICAO** airport codes (e.g. `EGLL`); `enrichSingle()` translates them to **IATA** (e.g. `LHR`) via `ICAO_TO_IATA` and only assigns them when the IATA code resolves in the `AIRPORTS` table — so only seeded airports can draw a route. |
| Enrichment scheduling | Staggered 80ms per aircraft to avoid UI jank |

**Backend data flow (FastAPI `main.py`):**
1. Polls OpenSky `/api/states/all` (with OAuth2 token if credentials provided)
2. On failure/rate-limit, falls back to: `adsb.lol` → `adsb.fi` → `airplanes.live` (opt-in)
3. Maps each source to `Aircraft`-shaped dict:
   - OpenSky: `opensky_to_aircraft()` — uses state vector indices
   - ADS-B (readsb-style): `readsb_to_aircraft()` — uses `lat`, `lon`, `alt_baro`, `track`, `gs`, `flight`, `hex`, `t`, `on_ground`
4. Enriches routes via `enrich_routes_static()` — same static `AIRLINE_ROUTES` map. The map stores **ICAO** codes; the function translates them to **IATA** via `ICAO_TO_IATA` so the frontend's IATA-keyed `AIRPORTS` table can resolve them. |
5. Broadcasts via WebSocket + REST `/api/flights`

**Fields populated from live OpenSky:**
| Aircraft Field | OpenSky Source |
|----------------|----------------|
| `flightId` | `callsign` or `icao24` |
| `icao24` | `state[0]` |
| `airline` | `state[2]` (ICAO airline code) |
| `aircraft` | **Empty string** — OpenSky doesn't provide type |
| `source`, `destination` | **Empty** — enriched client-side only if callsign matches known airline |
| `latitude`, `longitude` | `state[6]`, `state[5]` |
| `altitude` | `state[7]` (baro altitude, m → ft) |
| `heading` | `state[10]` (true track, degrees) |
| `speed` | `state[9]` (velocity, m/s → kts) |
| `progress` | **Always 0** — not computable without route |
| `departure` | `state[3]` (last contact timestamp → ISO) |
| `eta` | **Empty** |
| `onGround` | `state[8]` (boolean) |

**Unused in live path:**
- `aircraft` type — never filled (OpenSky doesn't have it; ADS-B `t`/`type`/`desc` mapped but not used)
- `progress` — always 0, route overlay won't draw for live flights
- `eta` — never filled

---

### 5. 3D Flight View (`flight-view-3d.component.ts`)

| Feature | Data Source |
|---------|-------------|
| **Aircraft model** | `public/models/aircraft.obj` + `aircraft.mtl` (fallback to generated material) — loaded via Three.js `OBJLoader`/`MTLLoader` |
| **Position/orientation** | Same `LiveFlightService` fleet — finds aircraft by `flightId` from route param |
| **Heading** | `Aircraft.heading` → applied to model pivot `rotation.y` |
| **Terrain** | **Real-world**: Esri World Imagery (satellite) + AWS Terrain Tiles (elevation, Terrarium PNG) — both keyless, CORS-enabled. Anchored to aircraft's live `latitude`/`longitude`/`altitude` via `terrain.setView()` each frame. |
| **Clouds** | Billboard particles (`clouds.ts`) — parallax scroll opposite flight direction, speed-scaled |
| **Wing trails** | GPU particle streaks (`wing-trails.ts`) — attached to bank group, rolls with banking |
| **Stars** | 820 points on dome (`stars.ts`) — visible only in night theme |
| **Banking (roll)** | Procedural: random ±8–18° every 4–10s, 60% chance when level, eased at 1.5/s |
| **Time scaling** | `VISUAL_TIME_SCALE = 1.0` — samples the simulator at real time. The 0.15 slowdown was a workaround for hypersonic base speeds; with realistic 420–530 kts the tile grid (anchored to true lat/lon) loads at a natural pace, so no artificial slowdown is needed. |
| **Cockpit view** | First-person camera at fixed offset from aircraft origin, rolls with bank |
| **Chase camera** | Third-person, lerps behind aircraft (distance 18, height 6) until user orbits |
| **Radio chatter** | `RadioService` — browser TTS (SpeechSynthesis) + Web Audio noise bed/crackle/roger beep |
| **Day/night theming** | Shared `MapThemeService` — swaps sky, fog, terrain, clouds, lights, star visibility |

**Unused / mock data in 3D view:**
- `MODEL_YAW_OFFSET_DEG`, `MODEL_PITCH_OFFSET_DEG`, `MODEL_NOSE_YAW_DEG` — hardcoded corrections for the specific OBJ model; would need adjustment for different models
- `REFERENCE_SPEED_KTS = 480` — arbitrary reference for cloud scroll factor (visual tuning only)
- `CLOUD_SCROLL_UNITS = 8`, `FLOW_YAW_OFFSET_DEG = 0` — visual tuning constants
- Terrain `TERRAIN_BASE_Y` — initial Y offset before live position anchors it

---

### 6. Radio Service (`radio.service.ts`)

**Purely atmospheric — no real data connection.**

| Feature | Source |
|---------|--------|
| Callsign | `plane.airline + spokenDigits(flightNumber)` — e.g. "IndiGo two zero one" |
| Flight level | `plane.altitude / 100` → spoken as 3 digits ("three five zero") |
| Heading | `plane.heading` → spoken as 3 digits ("zero niner five") |
| Center name | `cityForAirport(plane.destination)` — destination city from static `AIRPORTS` map |
| Frequency | Random 118–135 MHz + fixed decimals (`.05`, `.15`, `.35`, `.55`, `.75`) |
| Phraseology | 6 hardcoded exchange templates (ATC↔pilot) with slots filled from above |
| Voices | Browser `speechSynthesis` — picks two distinct male English voices |
| Audio texture | Web Audio: bandpass noise bed (idle/open gain), random crackle bursts, 1400Hz roger beep |

**All content is generated locally** — no external API, no real ATC data.

---

### 7. Static Seed Data (`seed-data.ts`)

| Data Set | Count | Notes |
|----------|-------|-------|
| `AIRPORTS` | 38 | IATA code → {code, name, city, lat, lon} — mix of Indian domestic + major international |
| `ROUTES` | 20 | Great-circle routes between airport pairs (e.g. `JFK-LHR`, `DXB-SIN`, `ICN-LAX`) |
| `SEED_FLIGHTS` | 20 | Each has unique `flightId`, `airline`, `aircraft`, `routeId`, `photo` (reuses 3 images) |

**Photos:** Only 3 actual image files exist (`public/aircraft/6E-201.jpg`, `AI-505.jpg`, `UK-777.jpg`). All 20 flights cycle through these.

**Unused airports in seed:** Many `AIRPORTS` entries are not referenced by any `ROUTE` (e.g. `HND`, `AMS`, `SFO`, `ORD`, `MEX`, `SCL`, `AKL` — wait, checking... actually all 38 are used across the 20 routes).

---

### 8. Map Theme Service (`map-theme.service.ts`)

| Feature | Implementation |
|---------|----------------|
| Theme state | Angular `signal<'day' \| 'night'>` — default `'day'` |
| Toggle | `theme.update(current => current === 'day' ? 'night' : 'day')` |
| Consumers | Header toggle, 2D map (tile layer swap), 3D view (sky/fog/terrain/clouds/stars/lights) |

---

### 9. Header Component (`header.component.ts`)

| Feature | Data Source |
|---------|-------------|
| Title | Hardcoded `'Plane Tracker'` |
| Theme toggle | Reads `MapThemeService.theme()` signal, calls `toggle()` |
| Theme icon | Template switches sun/moon icon based on `theme()` |

---

## Data Generated/Collected But UNUSED

### In Simulator (`flight-simulator.service.ts`)
| Field | Status |
|-------|--------|
| `eta` | Always `''` — **never populated**, commented as Phase 2 |
| `onGround` | Always `false` — simulator only produces airborne aircraft |

### In Live Flight Service / Backend
| Field | Status |
|-------|--------|
| `Aircraft.aircraft` (type) | **Empty for OpenSky**; ADS-B provides `t`/`type`/`desc` but mapped to `aircraft` field — **never displayed in UI** (info panel shows it but live flights have empty string) |
| `Aircraft.progress` | Always `0` for live — **route overlay cannot draw** without it |
| `Aircraft.eta` | Always `''` — never filled by any source |
| `Aircraft.departure` | Filled from OpenSky `state[3]` (last contact) — **not displayed in panel** |
| `AIRLINE_ROUTES` static map | Duplicated in **both** frontend (`live-flight.service.ts`) and backend (`main.py`) — must stay in sync. Stores **ICAO** airport codes; both copies translate to **IATA** via a shared `ICAO_TO_IATA` table so the frontend's IATA-keyed `AIRPORTS` map can resolve them. |

### In Map Component
| Item | Status |
|------|--------|
| `LABEL_ZOOM_THRESHOLD` | Imported, used in `applyMapStyle()` key but **no label layer exists** on either tile source |
| `airportLabel(code)` method | Defined, **never called** |
| `selectedFlightInfo` photo lookup | Falls back to `''` for live flights — **no placeholder** |

### In 3D View
| Constant | Status |
|----------|--------|
| `MODEL_*_OFFSET_DEG` | Model-specific corrections — **hardcoded for current OBJ only** |
| `VISUAL_TIME_SCALE` | Arbitrary 0.15 — **tuned by eye**, not derived from real physics |
| `REFERENCE_SPEED_KTS` | Arbitrary 2000 — **visual tuning only** |
| Terrain `TERRAIN_BASE_Y` | Initial offset — **overwritten immediately** by `setView()` |

### In Radio Service
| Item | Status |
|------|--------|
| All chatter content | **100% synthetic** — no real ATC feed, no real frequencies, no real traffic |

---

## Data Flow Summary Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        ANGULAR APP                              │
├─────────────────────────────────────────────────────────────────┤
│  FlightSimulatorService (PURE FUNCTION OF TIME)                │
│    └─► sample(nowMs) ───► Aircraft[] (20 flights)             │
│         │                                                    │
│         ├─► MapComponent: markers, routes, follow, clustering │
│         ├─► AircraftInfoPanel: flight details, progress bar   │
│         └─► FlightView3D: model pose, terrain anchor, clouds  │
│                                                                 │
│  LiveFlightService (WebSocket) ◄── NOT CONNECTED IN DEV       │
│    └─► fleet signal (empty until backend serves app)          │
│                                                                 │
│  Static Seed Data (seed-data.ts)                              │
│    ├─► AIRPORTS[38] ──► cityForAirport(), panel lookups       │
│    ├─► ROUTES[20] ──► simulator great-circle paths            │
│    └─► SEED_FLIGHTS[20] ──► identity (id, airline, type, photo)│
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ ng build + FastAPI serves dist/
                              │
┌─────────────────────────────────────────────────────────────────┐
│                        FASTAPI BACKEND                          │
├─────────────────────────────────────────────────────────────────┤
│  poll_flights() ────► OpenSky / adsb.lol / adsb.fi             │
│       │                                                      │
│       ├─► opensky_to_aircraft() / readsb_to_aircraft()        │
│       ├─► enrich_routes_static() (AIRLINE_ROUTES map)         │
│       └─► WebSocket broadcast /api/flights REST               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Takeaways

1. **The app is a client-side demo** — the simulator is the "source of truth" for all visible data during `ng serve`.

2. **Live data path exists but is dormant** — `LiveFlightService` connects to `/ws/flights` which only exists when the FastAPI backend serves the production build.

3. **Route overlays only work for seeded flights** — live OpenSky flights have empty `source`/`destination` (enrichment is best-effort, callsign-prefix-based, and incomplete).

4. **Progress/ETA are simulated** — live data has no progress (always 0) and no ETA.

5. **Aircraft type is missing from live feeds** — OpenSky doesn't provide it; ADS-B does but it's not surfaced in UI.

6. **No real ATC/radio data** — `RadioService` is entirely synthetic atmosphere.

7. **Terrain in 3D is real-world** — Esri imagery + AWS elevation tiles, anchored to live lat/lon (keyless, no billing).

8. **Duplicated static data** — `AIRLINE_ROUTES` map exists in both frontend and backend.

9. **Three actual aircraft photos** — 20 flights cycle through 3 images via `photo` field on seed.