# PlaneTracker — Data Models & Schemas

> Last updated: 2026-11-10

## TypeScript Interfaces (Frontend)

### `Aircraft` — Core Entity
```typescript
// src/app/models/aircraft.model.ts
export interface Aircraft {
  // Identity
  flightId: string;          // Callsign (e.g. "6E-201", "BAW123") or ICAO24 hex
  icao24: string;            // 6-char hex transponder code (e.g. "8001a2")
  airline: string;           // ICAO airline code (e.g. "IGO", "BAW") — may be empty
  aircraft: string;          // Human-readable type (e.g. "Airbus A320neo") — often empty for live
  source: string;            // Origin IATA (e.g. "HYD") — empty for live unless enriched
  destination: string;       // Destination IATA (e.g. "BLR") — empty for live unless enriched

  // Position (WGS84)
  latitude: number;          // Decimal degrees [-90, 90]
  longitude: number;         // Decimal degrees [-180, 180]
  altitude: number;          // Feet (barometric altitude, MSL)
  heading: number;           // Degrees 0-359 (true track, 0 = North)

  // Motion
  speed: number;             // Knots (ground speed)
  progress: number;          // 0-1 along great-circle route (sim only; 0 for live)
  onGround: boolean;         // True if on ground (live only; always false for sim)

  // Time
  departure: string;         // ISO 8601 timestamp (sim: leg start; live: last contact)
  eta: string;               // ISO 8601 timestamp — ALWAYS EMPTY in current implementation
}
```

### `Airport` — Static Reference
```typescript
// src/app/models/airport.model.ts
export interface Airport {
  code: string;      // IATA code (e.g. "HYD", "JFK")
  name: string;      // Full airport name (e.g. "Rajiv Gandhi International")
  city: string;      // City name (e.g. "Hyderabad")
  latitude: number;  // Decimal degrees
  longitude: number; // Decimal degrees
}
```

### `FlightRoute` — Route Geometry
```typescript
// src/app/models/flight-route.model.ts
export interface FlightRoute {
  id: string;           // Route identifier (e.g. "HYD-BLR")
  source: string;       // Origin IATA code
  destination: string;  // Destination IATA code
  distanceNm: number;   // Great-circle distance in nautical miles
}
```

---

## Seed Data Structures (`seed-data.ts`)

### `AIRPORTS` — Record<string, Airport>
38 airports, keyed by IATA code. Mix of Indian domestic + major international hubs.

**Indian Domestic (18):**
`DEL, BOM, BLR, HYD, MAA, CCU, AMD, COK, GOI, IXC, IXJ, IXR, VNS, PAT, IXB, IMF, IXZ, GAY`

**International (20):**
`DXB, SIN, KUL, BKK, HKG, NRT, ICN, PEK, PVG, LHR, CDG, FRA, AMS, JFK, EWR, ORD, LAX, SFO, YYZ, SYD`

### `ROUTES` — FlightRoute[]
20 great-circle routes connecting the above airports.

| Route ID | Source | Destination | Distance (nm) |
|----------|--------|-------------|---------------|
| HYD-BLR | HYD | BLR | ~240 |
| DEL-BOM | DEL | BOM | ~590 |
| BOM-BLR | BOM | BLR | ~430 |
| MAA-CCU | MAA | CCU | ~760 |
| DEL-DXB | DEL | DXB | ~1150 |
| BOM-SIN | BOM | SIN | ~1700 |
| BLR-KUL | BLR | KUL | ~1350 |
| HYD-BKK | HYD | BKK | ~1450 |
| DEL-HKG | DEL | HKG | ~1950 |
| BOM-NRT | BOM | NRT | ~3000 |
| MAA-ICN | MAA | ICN | ~2800 |
| DEL-PEK | DEL | PEK | ~1900 |
| BOM-PVG | BOM | PVG | ~2300 |
| HYD-LHR | HYD | LHR | ~3800 |
| DEL-CDG | DEL | CDG | ~3600 |
| BOM-FRA | BOM | FRA | ~3200 |
| BLR-AMS | BLR | AMS | ~3400 |
| DEL-JFK | DEL | JFK | ~6300 |
| BOM-LAX | BOM | LAX | ~7400 |
| MAA-SYD | MAA | SYD | ~4600 |

### `SEED_FLIGHTS` — Array<SeedFlight>
20 flights, each assigned to one route.

```typescript
interface SeedFlight {
  flightId: string;      // Callsign (e.g. "6E-201")
  airline: string;       // Airline name (e.g. "IndiGo")
  aircraft: string;      // Type (e.g. "Airbus A320neo")
  routeId: string;       // Matches ROUTES[i].id
  photo: string;         // Path under public/aircraft/ (cycles 3 images)
}
```

**Airlines represented:** IndiGo (6E), Air India (AI), Vistara (UK), SpiceJet (SG), GoAir (G8), AirAsia India (I5), Akasa (QP), Alliance Air (9I), Star Air (S5), FlyBig (S9)

**Photos:** Only 3 actual files (`6E-201.jpg`, `AI-505.jpg`, `UK-777.jpg`) — 20 flights cycle through them.

---

## Backend Data Structures (`main.py`)

### Normalised Aircraft Dict (Python)
```python
# Output of opensky_to_aircraft() / readsb_to_aircraft()
{
    "flightId": str,        # callsign.strip() or icao24
    "icao24": str,          # 6-char hex
    "airline": str,         # ICAO code (OpenSky state[2]) or ""
    "aircraft": str,        # Always "" for OpenSky; readsb has 't'/'type'/'desc'
    "source": str,          # "" initially; enriched via AIRLINE_ROUTES
    "destination": str,     # "" initially; enriched via AIRLINE_ROUTES
    "latitude": float,      # degrees
    "longitude": float,     # degrees
    "altitude": float,      # feet
    "heading": float,       # degrees 0-359
    "speed": float,         # knots
    "progress": float,      # Always 0.0
    "onGround": bool,       # True/False
    "departure": str,       # ISO timestamp from last_contact
    "eta": str,             # Always ""
}
```

### OpenSky State Vector Indices
```python
# https://openskynetwork.github.io/opensky-api/rest.html#response
state = [
    0: icao24,           # str
    1: callsign,         # str (padded)
    2: origin_country,   # str (ICAO airline code)
    3: time_position,    # int (unix) or None
    4: last_contact,     # int (unix)
    5: longitude,        # float or None
    6: latitude,         # float or None
    7: baro_altitude,    # float (meters) or None
    8: on_ground,        # bool
    9: velocity,         # float (m/s) or None
    10: true_track,      # float (degrees) or None
    11: vertical_rate,   # float (m/s) or None
    12: sensors,         # list[int] or None
    13: geo_altitude,    # float (meters) or None
    14: squawk,          # str or None
    15: spi,             # bool
    16: position_source, # int
]
```

### readsb / ADS-B JSON Format
```json
{
  "hex": "a1b2c3",
  "flight": "BAW123",
  "lat": 51.470,
  "lon": -0.453,
  "alt_baro": 39000,
  "track": 275,
  "gs": 450,
  "t": "A320",
  "type": "Airbus A320",
  "desc": "Airbus A320-200",
  "on_ground": false,
  "seen": 2.3,
  "rssi": -12.4
}
```

### `AIRLINE_ROUTES` — Static Enrichment Map
Duplicated in frontend (`live-flight.service.ts`) and backend (`main.py`).

```python
AIRLINE_ROUTES = {
    "BAW": {"from": "LHR", "to": "JFK"},
    "DLH": {"from": "FRA", "to": "LAX"},
    "AFR": {"from": "CDG", "to": "SFO"},
    "UAL": {"from": "ORD", "to": "LHR"},
    "AAL": {"from": "DFW", "to": "LHR"},
    "DAL": {"from": "ATL", "to": "CDG"},
    "SWA": {"from": "MDW", "to": "LAX"},
    "QFA": {"from": "SYD", "to": "LAX"},
    "SIA": {"from": "SIN", "to": "LHR"},
    "CPA": {"from": "HKG", "to": "SFO"},
    "KAL": {"from": "ICN", "to": "LAX"},
    "ANA": {"from": "HND", "to": "SFO"},
    "JAL": {"from": "NRT", "to": "SFO"},
    "CCA": {"from": "PEK", "to": "LAX"},
    "CES": {"from": "PVG", "to": "LAX"},
    "THA": {"from": "BKK", "to": "LHR"},
    "MAS": {"from": "KUL", "to": "LHR"},
    "GIA": {"from": "CGK", "to": "SIN"},
    "VIR": {"from": "LHR", "to": "JFK"},
    "EZY": {"from": "LTN", "to": "AMS"},
    "RYR": {"from": "STN", "to": "BCN"},
    "WZZ": {"from": "BUD", "to": "LHR"},
    "IGO": {"from": "DEL", "to": "BOM"},
    "AIC": {"from": "DEL", "to": "LHR"},
    "VTI": {"from": "BOM", "to": "DEL"},
    "SEJ": {"from": "DEL", "to": "BLR"},
    "GOW": {"from": "BOM", "to": "GOI"},
    "IAD": {"from": "BLR", "to": "DEL"},
    "AKJ": {"from": "BOM", "to": "BLR"},
    "LLR": {"from": "HYD", "to": "BLR"},
    "SBG": {"from": "IXC", "to": "DEL"},
}
# ~50 entries total
```

**Enrichment Logic (both frontend & backend):**
```python
# Extract airline prefix from callsign (e.g. "BAW123" -> "BAW")
prefix = re.sub(r'\d+$', '', callsign).upper()
if prefix in AIRLINE_ROUTES:
    aircraft["source"] = AIRLINE_ROUTES[prefix]["from"]
    aircraft["destination"] = AIRLINE_ROUTES[prefix]["to"]
```

---

## Geospatial Utilities (`geo.ts`)

### `LatLng` — Minimal Position
```typescript
export interface LatLng {
  latitude: number;
  longitude: number;
}
```

### Functions
| Function | Purpose | Used By |
|----------|---------|---------|
| `interpolatePosition(from, to, t)` | Spherical slerp (great-circle) at fraction t | Simulator position |
| `bearing(from, to)` | Initial great-circle bearing (0-359°) | Simulator heading, marker rotation |
| `haversineDistanceNm(from, to)` | Distance in nautical miles | Speed → progress conversion |
| `destinationPoint(from, bearing, distanceM)` | Point at distance along bearing | 3D camera look-ahead |
| `lerp(a, b, t)` | Linear interpolation | Internal helper |
| `toRadians/degrees` | Unit conversion | Internal helper |

**Constants:**
- `EARTH_RADIUS_NM = 3440.065` — NM for haversine
- `EARTH_RADIUS_M = 6_371_000` — Metres for destinationPoint

---

## Tile Utilities (`tiles.ts`)

### `TileFrac` — Fractional Tile Coordinates
```typescript
export interface TileFrac { x: number; y: number; }
```

### Functions
| Function | Purpose |
|----------|---------|
| `lonLatToTileFrac(lon, lat, z)` | Lon/lat → fractional tile at zoom z |
| `tileToLonLat(x, y, z)` | Inverse: tile → lon/lat |
| `tileSizeMetres(lat, z)` | Ground size of tile edge at latitude |
| `terrariumToMetres(r, g, b)` | Decode Terrarium RGB → elevation (m) |
| `wrapTile(v, z)` | Wrap tile X index (longitude wraps) |
| `clampTile(v, z)` | Clamp tile Y index (no wrap) |
| `imageryTileUrl(x, y, z)` | Esri World Imagery URL |
| `elevationTileUrl(x, y, z)` | AWS Terrarium elevation URL |

**Constants:**
- `TILE_PIXELS = 256`
- `EARTH_CIRCUMFERENCE_M = 40075016.686`

---

## Map Marker Interfaces (`aircraft-marker.overlay.ts`)

### `AircraftCardInfo` — Static Hover Card Data
```typescript
export interface AircraftCardInfo {
  flightCode: string;      // e.g. "6E-201"
  aircraftType: string;    // e.g. "Airbus A320neo"
  photoUrl: string;        // e.g. "aircraft/6E-201.jpg"
  originCity: string;      // e.g. "Hyderabad"
  destinationCity: string; // e.g. "Bengaluru"
}
```

### `AircraftLiveStats` — Dynamic Hover Card Data
```typescript
export interface AircraftLiveStats {
  altitudeFt: number;   // Current altitude
  speedKts: number;     // Current ground speed
  progress: number;     // 0-1 leg completion
}
```

### `AircraftMarkerOptions` — Marker Creation
```typescript
export interface AircraftMarkerOptions {
  iconUrl: string;           // Marker SVG (e.g. "markers/flight.svg")
  sizePx: number;            // Base diameter in pixels
  rotationOffsetDeg: number; // Icon correction (nose-up = 0)
  card: AircraftCardInfo;    // Static card data
  onClick?: () => void;      // Optional click handler
}
```

### `AircraftMarker` — Control Interface
```typescript
export interface AircraftMarker {
  update(position, heading, stats, sizePx): void;
  setSelected(selected: boolean): void;
  setMap(map: L.Map | null): void;
}
```

---

## 3D View Data Flow

### Aircraft State → Three.js
```typescript
// In FlightView3DComponent animation loop
const plane = fleet.find(p => p.flightId === flightId);
if (plane) {
  // Position (lat/lon/alt) → Three.js world coordinates
  terrain.setView(plane.latitude, plane.longitude, plane.altitude);
  
  // Heading → model pivot rotation.y
  aircraftModel.setHeading(plane.heading);
  
  // Banking animation (procedural)
  aircraftModel.setBank(currentBankAngle);
  
  // Speed → visual time scale
  simTime += delta * VISUAL_TIME_SCALE; // 0.15
}
```

### Terrain Tile Request
```
Imagery: https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}
Elevation: https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
```
- Loaded in `TerrainManager` around aircraft position
- LOD: zoom 10-14 depending on distance
- Decoded via `terrariumToMetres(r, g, b)` in shader

---

## WebSocket Message Schema

### Fleet Update (Server → Client)
```json
{
  "type": "fleet",
  "timestamp": "2026-01-15T10:30:00.123Z",
  "aircraft": [
    { /* Aircraft dict as defined above */ }
  ]
}
```

### Ping/Pong
```json
{ "type": "ping" }
{ "type": "pong" }
```

### Error
```json
{
  "type": "error",
  "code": "UPSTREAM_RATE_LIMIT",
  "message": "OpenSky rate limited; using cached data"
}
```

---

## Data Validation Rules

| Field | Constraints |
|-------|-------------|
| `flightId` | Non-empty string; callsign or icao24 |
| `icao24` | 6 hex chars `[0-9a-f]` |
| `latitude` | -90 to 90 |
| `longitude` | -180 to 180 |
| `altitude` | >= 0 (feet) |
| `heading` | 0 to 359 (degrees) |
| `speed` | >= 0 (knots) |
| `progress` | 0 to 1 |
| `departure` | Valid ISO 8601 or empty |
| `eta` | Valid ISO 8601 or empty (always empty currently) |

---

## Migration Notes (Future Schema Changes)

### Planned: Kafka `flight-position` Event
```json
{
  "eventId": "uuid",
  "eventTime": "ISO8601",
  "flight": {
    "flightId": "string",
    "icao24": "string",
    "airline": "string",
    "aircraftType": "string",
    "origin": {"iata": "string", "lat": "number", "lon": "number"},
    "destination": {"iata": "string", "lat": "number", "lon": "number"},
    "position": {"lat": "number", "lon": "number", "altFt": "number", "heading": "number", "speedKts": "number"},
    "status": "AIRBORNE|ON_GROUND|LANDED|DEPARTED",
    "progress": "number",
    "eta": "ISO8601|null"
  }
}
```
Current `Aircraft` interface maps 1:1 with `flight` object above.

### Planned: Historical Track Points
```typescript
interface TrackPoint {
  timestamp: string;  // ISO8601
  lat: number;
  lon: number;
  altFt: number;
  speedKts: number;
  heading: number;
}
```
Would be appended to `Aircraft` as `track: TrackPoint[]` for trail rendering.

---

## Quick Reference: Field Availability Matrix

| Field | Sim | OpenSky | ADS-B (readsb) | Seed Photo |
|-------|-----|---------|----------------|------------|
| flightId | ✓ | ✓ | ✓ | — |
| icao24 | ✓ | ✓ | ✓ | — |
| airline | ✓ | ✓ | ~ | — |
| aircraft | ✓ | ✗ | ✓ (t/type/desc) | — |
| source | ✓ | ✗* | ✗* | — |
| destination | ✓ | ✗* | ✗* | — |
| latitude | ✓ | ✓ | ✓ | — |
| longitude | ✓ | ✓ | ✓ | — |
| altitude | ✓ | ✓ | ✓ | — |
| heading | ✓ | ✓ | ✓ | — |
| speed | ✓ | ✓ | ✓ | — |
| progress | ✓ | 0 | 0 | — |
| onGround | false | ✓ | ✓ | — |
| departure | ✓ | ✓ | ~ | — |
| eta | ✗ | ✗ | ✗ | — |
| photo | — | — | — | ✓ (seed only) |

* Enriched client-side via `AIRLINE_ROUTES` map if callsign prefix matches.