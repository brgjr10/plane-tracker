# PlaneTracker — Deployment & Operations

> Last updated: 2026-11-10

## Quick Start

### Development (Client-Side Only)
```bash
cd plane-tracker-main
npm install
npm start          # Runs on http://localhost:4200
```
- Uses `FlightSimulatorService` exclusively
- No backend required
- Hot reload enabled

### Production (Full Stack)
```bash
# 1. Build Angular
cd plane-tracker-main
npm run build      # Outputs to dist/plane-tracker/

# 2. Start FastAPI (serves dist/ + API + WebSocket)
cd backend
pip install -r requirements.txt  # fastapi, uvicorn, httpx, websockets, python-dotenv
uvicorn main:app --host 0.0.0.0 --port 8000
```
- App at `http://localhost:8000`
- API at `http://localhost:8000/api/flights`
- WebSocket at `ws://localhost:8000/ws/flights`

### Docker (Optional)
```dockerfile
# Dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM python:3.11-slim
WORKDIR /app
COPY --from=builder /app/dist/plane-tracker /app/static
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/main.py .
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

```bash
docker build -t plane-tracker .
docker run -p 8000:8000 plane-tracker
```

## Environment Variables

### Backend (`backend/.env` or shell)
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENSKY_CLIENT_ID` | No | — | OpenSky OAuth2 client ID (for higher rate limits) |
| `OPENSKY_CLIENT_SECRET` | No | — | OpenSky OAuth2 client secret |
| `USE_AIRPLANES_LIVE` | No | `false` | Enable airplanes.live fallback (opt-in) |
| `POLL_INTERVAL_SECONDS` | No | `10` | Backend poll interval |
| `WS_PING_INTERVAL` | No | `30` | WebSocket keep-alive ping |

### Frontend (build-time only)
| Variable | Description |
|----------|-------------|
| `ng build --configuration=production` | Uses `environment.prod.ts` if configured |

**No runtime env vars needed for frontend** — WebSocket URL is derived from `window.location` (same host, `ws:`/`wss:`).

## OpenSky API Setup

1. Register at https://openskynetwork.org
2. Create OAuth2 client (API → Developer → Create Client)
3. Set `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET`
4. Without credentials: anonymous access (rate-limited, no historical data)

Rate limits (approximate):
- Anonymous: ~10 req/min, current states only
- Authenticated: ~100 req/min, extended data

## ADS-B Fallback Sources (No Key Required)

| Source | Endpoint | Format | Notes |
|--------|----------|--------|-------|
| adsb.lol | `https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}` | readsb JSON | Global, good coverage |
| adsb.fi | `https://adsb.fi/api/flights?lat={lat}&lon={lon}&radius={nm}` | readsb JSON | European focus |
| airplanes.live | `https://airplanes.live/api/flights?lat={lat}&lon={lon}&radius={nm}` | readsb JSON | Opt-in via `USE_AIRPLANES_LIVE=true` |

All return readsb-style JSON with fields: `hex`, `flight`, `lat`, `lon`, `alt_baro`, `track`, `gs`, `t`, `on_ground`.

## Reverse Proxy (Nginx Example)

```nginx
server {
    listen 80;
    server_name tracker.example.com;

    # Static files (Angular build)
    location / {
        root /app/static;
        try_files $uri $uri/ /index.html;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # API + WebSocket
    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /ws/flights {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
```

## Health Checks

```bash
# Backend health
curl http://localhost:8000/health
# {"status": "ok", "clients": 3, "last_poll": "2026-01-15T10:30:00Z"}

# Fleet snapshot
curl http://localhost:8000/api/flights | jq 'length'
# 1247

# WebSocket test
wscat -c ws://localhost:8000/ws/flights
```

## Monitoring & Logs

### Key Metrics to Watch
- Backend poll success/failure rate (OpenSky vs fallbacks)
- WebSocket connected clients
- Fleet size per poll
- Poll latency (should be <2s)

### Structured Logging (add to `main.py`)
```python
import logging, json, time

class JsonFormatter(logging.Formatter):
    def format(self, record):
        return json.dumps({
            "ts": time.time(),
            "level": record.levelname,
            "msg": record.getMessage(),
            "module": record.module,
        })

handler = logging.StreamHandler()
handler.setFormatter(JsonFormatter())
logging.getLogger().addHandler(handler)
logging.getLogger().setLevel(logging.INFO)
```

### Prometheus Metrics (Optional)
```python
from prometheus_client import Counter, Gauge, Histogram

POLL_TOTAL = Counter('plane_poll_total', 'Total polls', ['source', 'status'])
FLEET_SIZE = Gauge('plane_fleet_size', 'Aircraft in fleet')
WS_CLIENTS = Gauge('plane_ws_clients', 'Connected WebSocket clients')
POLL_LATENCY = Histogram('plane_poll_latency_seconds', 'Poll duration')
```

## Scaling Considerations

| Component | Bottleneck | Mitigation |
|-----------|------------|------------|
| Backend poll | OpenSky rate limit | Use OAuth2; cache results; stagger fallbacks |
| WebSocket broadcast | O(n) clients × fleet size | Batch sends; consider Redis pub/sub for multi-instance |
| Frontend rendering | 1000+ markers | Clustering (already implemented < zoom 8); canvas renderer |
| 3D terrain tiles | Tile fetch volume | LOD by distance; cache in IndexedDB; limit concurrent loads |

## Backup / Restore

**Nothing to backup** — all data is ephemeral (live API or computed). Static assets are in git.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| Empty fleet in prod | Backend not polling | Check `uvicorn` logs; verify OpenSky credentials |
| WebSocket fails | Proxy not upgrading | Add `proxy_set_header Connection "upgrade"` in nginx |
| 3D terrain missing | CORS / network | Verify `services.arcgisonline.com` and `s3.amazonaws.com` reachable |
| Markers not rotating | Leaflet version mismatch | Pin `leaflet@1.9.4` in package.json |
| Radio no sound | Browser autoplay policy | User must interact first (click map) — SpeechSynthesis requires gesture |

## Security Notes

- **No authentication** on frontend or API — add auth proxy if exposed publicly
- **No secrets in frontend** — OpenSky credentials only in backend env
- **WebSocket accepts any origin** — add `origin` check in `main.py` if needed
- **CORS open** for tile sources — no credentials sent

## CI/CD Example (GitHub Actions)

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: {node-version: '20'}
      - run: npm ci && npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/plane-tracker/
  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with: {name: dist, path: ./dist}
      - name: Deploy to server
        run: |
          rsync -avz ./dist/ user@server:/app/static/
          ssh user@server "cd /app && docker compose up -d --build"
```