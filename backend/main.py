import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from typing import Dict, Optional

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("planetracker")

OPENSKY_URL = "https://opensky-network.org/api/states/all"
BASE_POLL_INTERVAL_SEC = 10.0
MAX_POLL_INTERVAL_SEC = 120.0

OPENSKY_USERNAME = os.getenv("OPENSKY_USERNAME", "")
OPENSKY_PASSWORD = os.getenv("OPENSKY_PASSWORD", "")

app = FastAPI(title="Plane Tracker Live Feed")

# Connected WebSocket clients
clients: set[WebSocket] = set()

# Latest fleet snapshot keyed by icao24
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


async def poll_opensky():
    """Background task: poll OpenSky and broadcast to WebSocket clients.

    Uses optional OpenSky auth (OPENSKY_USERNAME / OPENSKY_PASSWORD env vars)
    when available — unauthenticated requests are heavily rate limited (429).
    On any failure the poller backs off exponentially up to MAX_POLL_INTERVAL_SEC
    and resets to BASE_POLL_INTERVAL_SEC on success.
    """
    log.info("OpenSky poller started")
    backoff = BASE_POLL_INTERVAL_SEC
    auth = (OPENSKY_USERNAME, OPENSKY_PASSWORD) if OPENSKY_USERNAME else None
    async with httpx.AsyncClient(timeout=15.0) as client:
        while True:
            try:
                resp = await client.get(OPENSKY_URL, auth=auth)
                resp.raise_for_status()
                data = resp.json()
                states = data.get("states", []) or []
                new_fleet: Dict[str, dict] = {}
                for state in states:
                    ac = opensky_to_aircraft(state)
                    if ac:
                        new_fleet[ac["icao24"]] = ac
                fleet.clear()
                fleet.update(new_fleet)
                payload = {
                    "type": "fleet",
                    "ts": datetime.now(tz=timezone.utc).isoformat(),
                    "count": len(fleet),
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
                log.info("Polled OpenSky: %d aircraft, %d clients", len(fleet), len(clients))
            except Exception as exc:
                log.exception("OpenSky poll failed: %s", exc)
                backoff = min(backoff * 2, MAX_POLL_INTERVAL_SEC)
            await asyncio.sleep(backoff)


@app.on_event("startup")
async def startup():
    asyncio.create_task(poll_opensky())


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
app.mount("/", StaticFiles(directory="/app/dist/plane-tracker/browser", html=True), name="static")

@app.get("/{full_path:path}")
async def spa(full_path: str):
    return FileResponse("/app/dist/plane-tracker/browser/index.html")
