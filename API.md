# PlaneTracker — API Reference

> Last updated: 2026-11-10

## Backend REST API (FastAPI)

Base URL: `http://<host>:8000`

### `GET /api/flights`
Returns current fleet snapshot as JSON array.

**Response:** `Aircraft[]` (see Aircraft Schema below)

```bash
curl http://localhost:8000/api/flights
```

### `GET /health`
Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "clients": 3,
  "last_poll": "2026-01-15T10:30:00Z",
  "fleet_size": 1247
}
```

### `GET /ws/flights`
WebSocket endpoint for real-time fleet updates.

**Protocol:** Server pushes full fleet snapshot every ~10 seconds (configurable via `POLL_INTERVAL_SECONDS`).

**Message Format:**
```json
{
  "type": "fleet",
  "timestamp": "2026-01-15T10:30:00.123Z",
  "aircraft": [ /* Aircraft[] */ ]
}
```

**Client Example (JavaScript):**
```javascript
const ws = new WebSocket('ws://localhost:8000/ws/flights');
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'fleet') {
    console.log(`Received ${msg.aircraft.length} aircraft at ${msg.timestamp}`);
  }
};
```

---

## Aircraft Schema

All aircraft (simulated, OpenSky, ADS-B) conform to this TypeScript interface:

```typescript
interface Aircraft {
  // Identity
  flightId: string;          // Callsign (e.g. "BAW123") or ICAO24 hex
  icao24: string;            // 6-char ICAO24 hex (transponder code)
  airline: string;           // ICAO airline code (e.g. "BAW") — may be empty
  aircraft: string;          // Aircraft type (e.g. "Airbus A320neo") — often empty for live
  source: string;            // Origin IATA code (e.g. "LHR") — empty for live unless enriched
  destination: string;       // Destination IATA code (e.g. "JFK") — empty for live unless enriched

  // Position (WGS84)
  latitude: number;          // Decimal degrees
  longitude: number;         // Decimal degrees
  altitude: number;          // Feet (barometric altitude)
  heading: number;           // Degrees 0-359 (true track)

  // Motion
  speed: number;             // Knots (ground speed)
  progress: number;          // 0-1 along route (sim only; 0 for live)
  onGround: boolean;         // True if on ground (live only; always false for sim)

  // Time
  departure: string;         // ISO timestamp (sim: leg start; live: last contact)
  eta: string;               // ISO timestamp — ALWAYS EMPTY in current impl
}
```

### Field Availability by Source

| Field | Simulator | OpenSky Live | ADS-B Live (readsb) |
|-------|-----------|--------------|---------------------|
| `flightId` | ✓ (seed) | ✓ (callsign/icao24) | ✓ (flight/hex) |
| `icao24` | ✓ (seed) | ✓ | ✓ (hex) |
| `airline` | ✓ (seed) | ✓ (state[2]) | ~ (not in readsb) |
| `aircraft` | ✓ (seed) | **empty** | ~ (type/desc available but not mapped) |
| `source` | ✓ (seed) | **empty** | **empty** |
| `destination` | ✓ (seed) | **empty** | **empty** |
| `latitude` | ✓ (slerp) | ✓ (state[6]) | ✓ (lat) |
| `longitude` | ✓ (slerp) | ✓ (state[5]) | ✓ (lon) |
| `altitude` | ✓ (profile) | ✓ (state[7] m→ft) | ✓ (alt_baro ft) |
| `heading` | ✓ (bearing) | ✓ (state[10]) | ✓ (track deg) |
| `speed` | ✓ (random 420–530) | ✓ (state[9] m/s→kts) | ✓ (gs kts) |
| `progress` | ✓ (0-1 loop) | **0** | **0** |
| `onGround` | **false** | ✓ (state[8]) | ✓ (on_ground) |
| `departure` | ✓ (leg start) | ✓ (state[3]→ISO) | ~ (not in readsb) |
| `eta` | **empty** | **empty** | **empty** |

---

## WebSocket Message Types

### Server → Client

#### `fleet` (periodic, ~10s)
```json
{
  "type": "fleet",
  "timestamp": "2026-01-15T10:30:00.123Z",
  "aircraft": [ /* Aircraft[] */ ]
}
```

#### `ping` (keep-alive, ~30s)
```json
{ "type": "ping" }
```
Client should respond with `{"type": "pong"}` or ignore.

#### `error` (rare)
```json
{
  "type": "error",
  "code": "UPSTREAM_RATE_LIMIT",
  "message": "OpenSky rate limited; using cached data"
}
```

### Client → Server

#### `pong` (optional)
```json
{ "type": "pong" }
```

#### `subscribe` (future use — not implemented)
```json
{ "type": "subscribe", "filters": { "bounds": [[lat,lon],[lat,lon]] } }
```

---

## Frontend Service APIs (TypeScript)

### `FlightSimulatorService`

```typescript
@Injectable({ providedIn: 'root' })
export class FlightSimulatorService {
  /** Observable emitting fleet at ~60fps (requestAnimationFrame) */
  readonly fleet$: Observable<Aircraft[]>;

  /** Pure function — computes fleet for a given timestamp */
  sample(nowMs: number): Aircraft[];

  /** Current fleet snapshot (synchronous) */
  getCurrentFleet(): Aircraft[];
}
```

**Usage:**
```typescript
// Reactive (recommended)
this.simulator.fleet$.subscribe(fleet => { ... });

// One-shot
const fleet = this.simulator.getCurrentFleet();
```

### `LiveFlightService`

```typescript
@Injectable({ providedIn: 'root' })
export class LiveFlightService {
  /** Signal with latest fleet from WebSocket */
  readonly fleet = signal<Aircraft[]>([]);

  /** Connection status */
  readonly connected = signal<boolean>(false);

  /** Connect to WebSocket (auto-reconnects) */
  connect(): void;

  /** Disconnect */
  disconnect(): void;
}
```

**Usage:**
```typescript
// In component
effect(() => {
  const fleet = this.liveFlight.fleet();
  // fleet updates when WS pushes
});

// Manual connect (usually auto in component init)
this.liveFlight.connect();
```

### `MapThemeService`

```typescript
@Injectable({ providedIn: 'root' })
export class MapThemeService {
  readonly theme = signal<'day' | 'night'>('day');
  toggle(): void;
}
```

### `RadioService`

```typescript
@Injectable({ providedIn: 'root' })
export class RadioService {
  /** Start chatter for a specific aircraft */
  start(plane: Aircraft): void;

  /** Stop chatter */
  stop(): void;

  /** Current speaking state */
  readonly speaking = signal<boolean>(false);
}
```

---

## OpenSky API (External Reference)

Used by backend. Documented here for debugging.

### `GET https://opensky-network.org/api/states/all`
Returns all current state vectors.

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `lamin` | float | Min latitude |
| `lomin` | float | Min longitude |
| `lamax` | float | Max latitude |
| `lomax` | float | Max longitude |
| `extended` | bool | Include extended fields (requires auth) |

**Response:**
```json
{
  "time": 1705312200,
  "states": [
    [
      "a1b2c3",     // 0: icao24
      "BAW123  ",   // 1: callsign (padded)
      "EGLL",       // 2: origin_country
      1705312195,   // 3: time_position (unix)
      1705312195,   // 4: last_contact (unix)
      -0.453,       // 5: longitude
      51.470,       // 6: latitude
      11887.2,      // 7: baro_altitude (meters)
      false,        // 8: on_ground
                    // 9: velocity (m/s)
                    // 10: true_track (degrees)
                    // 11: vertical_rate (m/s)
                    // 12: sensors
                    // 13: geo_altitude (m)
                    // 14: squawk
                    // 15: spi
                    // 16: position_source
    ]
  ]
}
```

**OAuth2 Token (for authenticated requests):**
```bash
curl -X POST https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token \
  -d "grant_type=client_credentials&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET"
```
Use `Authorization: Bearer <token>` header.

---

## ADS-B Fallback APIs (External Reference)

### adsb.lol
```
GET https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}
```
Returns readsb-format JSON array.

### adsb.fi
```
GET https://adsb.fi/api/flights?lat={lat}&lon={lon}&radius={nm}
```
Returns readsb-format JSON array.

### airplanes.live (opt-in)
```
GET https://airplanes.live/api/flights?lat={lat}&lon={lon}&radius={nm}
```
Returns readsb-format JSON array.

### readsb Format (common to all three)
```json
[
  {
    "hex": "a1b2c3",
    "flight": "BAW123",
    "lat": 51.470,
    "lon": -0.453,
    "alt_baro": 39000,
    "track": 275,
    "gs": 450,
    "t": "A320",
    "on_ground": false,
    "seen": 2.3,
    "rssi": -12.4
  }
]
```

---

## Data Enrichment (Client-Side)

`LiveFlightService.enrichRoutes()` runs client-side after receiving fleet:

```typescript
// Matches callsign prefix (e.g. "BAW123" → "BAW") against static map
const airlinePrefix = flightId.replace(/\d+$/, '').toUpperCase();
const route = AIRLINE_ROUTES[airlinePrefix];
if (route) {
  aircraft.source = route.from;
  aircraft.destination = route.to;
}
```

**Static Map (`AIRLINE_ROUTES`):** ~40 entries mapping ICAO airline code → (origin ICAO, destination ICAO) pair. Duplicated in frontend and backend; both copies translate ICAO→IATA at enrichment time via a shared `ICAO_TO_IATA` table so the IATA-keyed `AIRPORTS` map can resolve them.

---

## Error Codes (WebSocket)

| Code | Meaning |
|------|---------|
| `UPSTREAM_RATE_LIMIT` | OpenSky/ADS-B rate limited; serving stale data |
| `UPSTREAM_UNAVAILABLE` | All upstream sources failed |
| `NORMALISATION_FAILED` | Could not parse upstream response |
| `WS_CLOSED` | Server shutting down |