import asyncio
import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from typing import Dict, Optional

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("planetracker")

OPENSKY_URL = "https://opensky-network.org/api/states/all"
OPENSKY_FLIGHT_URL = "https://opensky-network.org/api/flights/aircraft"
OPENSKY_TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"
BASE_POLL_INTERVAL_SEC = 30.0
MAX_POLL_INTERVAL_SEC = 180.0
ROUTE_ENRICH_INTERVAL_SEC = 300.0  # 5 min
ROUTE_CACHE_TTL_SEC = 86400.0  # 24h

OPENSKY_CLIENT_ID = os.getenv("OPENSKY_CLIENT_ID", "")
OPENSKY_CLIENT_SECRET = os.getenv("OPENSKY_CLIENT_SECRET", "")

# Fallback ADS-B providers (readsb-style). OpenSky is tried first; on failure/rate-limit
# we fall back in order. airplanes.live requires explicit opt-in because its public API
# may require coordination/credentials; set AIRPLANES_LIVE_URL to enable it.
ADSB_LOL_URL = os.getenv("ADSB_LOL_URL", "https://api.adsb.lol/v2/lat/0/lon/0/dist/25000")
ADSB_FI_URL = os.getenv("ADSB_FI_URL", "https://opendata.adsb.fi/api/v2/lat/0/lon/0/dist/25000")
AIRPLANES_LIVE_URL = os.getenv("AIRPLANES_LIVE_URL", "").strip()

# OAuth2 access token cache (Bearer token expires after 30 minutes)
_token: Optional[str] = None
_token_expires_at: float = 0.0

# Static airline route mapping: callsign prefix -> (origin, destination) IATA codes.
# Covers major commercial carriers. Extend as needed.
AIRLINE_ROUTES = {
    # US majors
    "AAL": ("KDFW", "KLAX"), "DAL": ("KATL", "KLAX"), "UAL": ("KORD", "KSFO"),
    "SWA": ("KDAL", "KPHX"), "JBU": ("KJFK", "KLAX"), "ASA": ("KSEA", "KPDX"),
    "FFT": ("KDEN", "KLAS"), "NKS": ("KFLL", "KLGA"), "HAW": ("PHNL", "KOGG"),
    # Canadian
    "ACA": ("CYYZ", "CYVR"), "WJA": ("CYYC", "CYVR"),
    # European majors
    "BAW": ("EGLL", "EHAM"), "AFR": ("LFPG", "LFMN"), "DLH": ("EDDF", "EDDM"),
    "KLM": ("EHAM", "LEMD"), "RYR": ("EIDW", "LIRF"), "EZY": ("EGKK", "LFPG"),
    "SAS": ("ESSA", "EKCH"), "FIN": ("EFHK", "EFVA"), "IBE": ("LEMD", "LEBL"),
    "VLG": ("LEBL", "LEPA"),
    # Middle East
    "UAE": ("OMDB", "OTHH"), "QTR": ("OTHH", "OMDB"), "ETD": ("OMAA", "OMDB"),
    # Asian
    "SIA": ("WSSS", "WMKK"), "CPA": ("VHHH", "ZBAA"), "ANA": ("RJAA", "RJBB"),
    "JAL": ("RJTT", "RJOO"), "KAL": ("RKSI", "RKPK"), "CSN": ("ZGGG", "ZBAA"),
    "CCA": ("ZBAA", "ZSPD"), "CES": ("ZSPD", "ZGGG"), "HKE": ("VHHH", "RKSI"),
    "THA": ("VTBD", "VTCC"), "MAS": ("WMKK", "WBKK"), "GIA": ("WIII", "WAHH"),
    # Australian
    "QFA": ("YSSY", "YMML"), "VOZ": ("YBBN", "YMML"),
    # Cargo
    "FDX": ("KMEM", "KIND"), "UPS": ("KSDF", "KONT"),
}


def enrich_routes_static(fleet: Dict[str, dict]) -> None:
    """Populate source/destination from static airline route map based on callsign prefix."""
    for icao24, ac in fleet.items():
        callsign = ac.get("callsign", "").strip().upper()
        if not callsign:
            continue
        if ac.get("source") or ac.get("destination"):
            continue
        match = re.match(r"^([A-Z]{2,3})\d", callsign)
        if not match:
            continue
        airline = match.group(1)
        if airline in AIRLINE_ROUTES:
            origin, dest = AIRLINE_ROUTES[airline]
            ac["source"] = origin
            ac["destination"] = dest


app = FastAPI(title="Plane Tracker Live Feed")

# Connected WebSocket clients
clients: set[WebSocket] = set()

# Latest fleet snapshot keyed by icao24/flight id
fleet: Dict[str, dict] = {}


def opensky_to_aircraft(state: list) -> Optional[dict]:
    """Map an OpenSky state vector to the Aircraft-shaped dict."""
    if len(state) < 17:
        return None
    icao24 = state[0]
    callsign = (state[1] or "").strip()
    longitude = state[5]
    latitude = state[6]
    baro_altitude = state[7]
    on_ground = state[8]
    velocity = state[9]  # m/s
    true_track = state[10]  # degrees
    if latitude is None or longitude is None or baro_altitude is None:
        return None
    flight_id = callsign or icao24
    speed_kts = round((velocity or 0) * 1.94384)  # m/s -> knots
    altitude_ft = round((baro_altitude or 0) * 3.28084)  # m -> ft
    heading = round(true_track or 0)
    return {
        "flightId": flight_id or icao24,
        "icao24": icao24,
        "airline": state[2] or "",
        "aircraft": "",
        "source": "",
        "destination": "",
        "latitude": round(latitude, 6),
        "longitude": round(longitude, 6),
        "altitude": altitude_ft,
        "heading": heading,
        "speed": speed_kts,
        "progress": 0.0,
        "departure": datetime.fromtimestamp(state[3], tz=timezone.utc).isoformat()
        if state[3]
        else "",
        "eta": "",
        "onGround": bool(on_ground),
    }


def _num(value, default=0):
    try:
        if value is None or value == "" or value == "ground":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def readsb_to_aircraft(ac: dict) -> Optional[dict]:
    """Map a readsb-style ADS-B record (adsb.lol/adsb.fi/airplanes.live-like) to Aircraft."""
    lat = ac.get("lat")
    lon = ac.get("lon")
    if lat is None or lon is None:
        return None
    hex_id = str(ac.get("hex") or ac.get("icao") or ac.get("icao24") or "").strip().lower()
    flight = str(ac.get("flight") or ac.get("callsign") or "").strip()
    reg = str(ac.get("r") or ac.get("reg") or "").strip()
    flight_id = flight or reg or hex_id
    if not flight_id:
        return None
    alt_baro = ac.get("alt_baro")
    on_ground = bool(ac.get("on_ground") or ac.get("onGround") or alt_baro == "ground")
    altitude_ft = 0 if on_ground else round(_num(alt_baro if alt_baro != "ground" else None, _num(ac.get("alt_geom"))))
    heading = round(_num(ac.get("track"), _num(ac.get("true_heading"), _num(ac.get("mag_heading"))))) % 360
    speed_kts = round(_num(ac.get("gs"), _num(ac.get("tas"), _num(ac.get("ias")))))
    aircraft_type = str(ac.get("t") or ac.get("type") or ac.get("desc") or "").strip()
    return {
        "flightId": flight_id,
        "icao24": hex_id or flight_id,
        "airline": "",
        "aircraft": aircraft_type,
        "source": "",
        "destination": "",
        "latitude": round(float(lat), 6),
        "longitude": round(float(lon), 6),
        "altitude": max(0, int(altitude_ft)),
        "heading": int(heading),
        "speed": max(0, int(speed_kts)),
        "progress": 0.0,
        "departure": "",
        "eta": "",
        "onGround": on_ground,
        "callsign": flight,  # <-- include callsign for route enrichment
    }


async def fetch_opensky(client: httpx.AsyncClient) -> Optional[Dict[str, dict]]:
    token = await get_access_token(client)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    resp = await client.get(OPENSKY_URL, headers=headers)
    resp.raise_for_status()
    states = resp.json().get("states", []) or []
    fleet_out: Dict[str, dict] = {}
    for state in states:
        ac = opensky_to_aircraft(state)
        if ac:
            fleet_out[ac["icao24"]] = ac
    return fleet_out


async def fetch_readsb(client: httpx.AsyncClient, url: str, label: str) -> Optional[Dict[str, dict]]:
    if not url:
        return None
    resp = await client.get(url)
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, dict) and data.get("error"):
        log.warning("%s returned error: %s", label, data.get("error"))
        return None
    records = []
    if isinstance(data, list):
        records = data
    elif isinstance(data, dict):
        for key in ("ac", "aircraft", "states"):
            val = data.get(key)
            if isinstance(val, list):
                records = val
                break
    fleet_out: Dict[str, dict] = {}
    for rec in records:
        if isinstance(rec, dict):
            ac = readsb_to_aircraft(rec)
            if ac:
                fleet_out[ac["icao24"]] = ac
    if not fleet_out:
        log.warning("%s returned no usable aircraft", label)
        return None
    return fleet_out


async def poll_flights():
    """Poll OpenSky first, then configured ADS-B fallbacks, and broadcast snapshots."""
    log.info(
        "Flight poller started (primary=OpenSky, fallbacks=adsb.lol,adsb.fi%s)",
        ",airplanes.live(opt-in)" if AIRPLANES_LIVE_URL else "",
    )
    backoff = BASE_POLL_INTERVAL_SEC
    sources = [
        ("OpenSky", lambda c: fetch_opensky(c)),
        ("adsb.lol", lambda c: fetch_readsb(c, ADSB_LOL_URL, "adsb.lol")),
        ("adsb.fi", lambda c: fetch_readsb(c, ADSB_FI_URL, "adsb.fi")),
    ]
    if AIRPLANES_LIVE_URL:
        sources.append(("airplanes.live", lambda c: fetch_readsb(c, AIRPLANES_LIVE_URL, "airplanes.live")))

    async with httpx.AsyncClient(timeout=20.0, headers={"Accept": "application/json"}) as client:
        # Initial delay to respect poll interval and avoid immediate rate-limit
        await asyncio.sleep(BASE_POLL_INTERVAL_SEC)
        while True:
            new_fleet: Optional[Dict[str, dict]] = None
            used_source = None
            errors = []
            for name, fetcher in sources:
                try:
                    result = await fetcher(client)
                    if result:
                        new_fleet = result
                        used_source = name
                        break
                    errors.append(f"{name}: empty")
                except Exception as exc:
                    errors.append(f"{name}: {exc}")
                    if name == "OpenSky":
                        log.warning("OpenSky fetch failed, trying fallbacks: %s", exc)
                    else:
                        log.warning("%s fetch failed: %s", name, exc)

            if new_fleet and used_source:
                fleet.clear()
                fleet.update(new_fleet)
                # Enrich with static airline route mapping (callsign prefix -> origin/dest)
                enrich_routes_static(fleet)
                payload = {
                    "type": "fleet",
                    "ts": datetime.now(tz=timezone.utc).isoformat(),
                    "count": len(fleet),
                    "source": used_source,
                    "aircraft": list(fleet.values()),
                }
                message = json.dumps(payload)
                dead = []
                for ws in list(clients):
                    try:
                        await ws.send_text(message)
                    except Exception:
                        dead.append(ws)
                for ws in dead:
                    clients.discard(ws)
                backoff = BASE_POLL_INTERVAL_SEC
                log.info("Polled %s: %d aircraft, %d clients", used_source, len(fleet), len(clients))
            else:
                log.warning("All flight sources failed: %s", "; ".join(errors) or "unknown")
                backoff = min(max(backoff * 2, BASE_POLL_INTERVAL_SEC), MAX_POLL_INTERVAL_SEC)

            await asyncio.sleep(backoff)


@app.on_event("startup")
async def startup():
    asyncio.create_task(poll_flights())


@app.websocket("/ws/flights")
async def flights_ws(websocket: WebSocket):
    await websocket.accept()
    clients.add(websocket)
    log.info("WS client connected (%d total)", len(clients))
    try:
        # Send latest snapshot immediately
        if fleet:
            payload = {
                "type": "fleet",
                "ts": datetime.now(tz=timezone.utc).isoformat(),
                "count": len(fleet),
                "aircraft": list(fleet.values()),
            }
            await websocket.send_text(json.dumps(payload))
        while True:
            await websocket.receive_text()  # keepalive / ignore client messages
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(websocket)
        log.info("WS client disconnected (%d total)", len(clients))


@app.get("/api/flights")
async def flights_rest():
    return {
        "ts": datetime.now(tz=timezone.utc).isoformat(),
        "count": len(fleet),
        "aircraft": list(fleet.values()),
    }


# Serve the built Angular frontend
# Static files first (assets, index.html for root). Mount at root with html=True.
app.mount("/", StaticFiles(directory="/app/dist/plane-tracker/browser", html=True), name="static")

# Middleware: on 404 for non-asset/API paths, serve index.html (SPA fallback)
from starlette.responses import FileResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

class SPAMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if response.status_code == 404:
            path = request.url.path.lstrip("/")
            # Skip API, WS, and asset paths — let them 404
            if path.startswith(("api/", "ws/", "chunk-", "main-", "polyfills-", "styles-", "logo.", "markers/", "favicon.", "assets/")):
                return response
            # Serve index.html for client-side routes
            return FileResponse("/app/dist/plane-tracker/browser/index.html")
        return response

app.add_middleware(SPAMiddleware)
