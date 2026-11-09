# Loop Finder

A web app that finds **looping bike routes**. Drop a pin on the map, pick a length and how quiet
you want the roads, and a Python backend searches the OpenStreetMap road network around you and
streams candidate loops back as it finds them. The React UI lets you browse, sort, filter,
favorite and refine those loops.

- **Live results**: routes arrive one by one over a WebSocket while the search runs.
- **Sort and filter**: length, climb rate, total climb, difficulty, loop share, turns,
  discomfort (road stress), similarity; an elevation chart and sparkline for every route.
- **Steer the search**: paint roads or draw areas (circle, box, freeform) the routes must go
  through or avoid, then ask for **More routes**. New routes never repeat earlier ones.
- **Custom search boundaries**: draw the region routes must stay inside.
- **Favorites and history**: every generation and favorite is saved in your browser
  (IndexedDB). No accounts; the server keeps nothing about you.

> A generated loop is a *lollipop*: a stem out from the start, a loop, and the stem back. That
> is by design, so a loop can begin anywhere, including the end of a dead-end street.

## How it works

```
React UI (route-loop-finder/)  ──WebSocket /ws──▶  Python backend (backend/server.py)
  Leaflet map, route list,                            ├─ map_store.py   OSM roads as 0.1° tiles, fetched
  filters, favorites (IndexedDB)                      │                 from Overpass on demand → backend/map_data/
                                                      ├─ areas.py /     builds a search graph around the pin
                                                      │  graph_builder.py
                                                      ├─ loop_generator.py / loop_tree.py   the loop search
                                                      ├─ work_queue.py  one search at a time, visitors take turns
                                                      └─ limits.py      validates and caps every message
```

- **Frontend**: Vite + React 19 + react-leaflet. It talks to the backend only over the
  WebSocket at `/ws` on its own origin (the Vite dev server proxies it to port 8765).
- **Backend**: a single Python process (networkx, shapely, pyproj, websockets, SRTM.py for
  elevation). Map data is downloaded the first time you plan somewhere and cached on disk.

The full design (message contract, UI behaviour, memory limits) is in
[project-overview.mdc](project-overview.mdc).

## Quick start

You need **Python 3.9+** and **Node.js 18+**.

### 1. Backend

```bash
python -m venv venv
source venv/bin/activate            # Windows: venv\Scripts\activate
pip install -r backend/requirements.txt
cd backend
python server.py
```

It prints `Ready: ws://localhost:8765`; `http://localhost:8765/healthz` answers `ok`.

### 2. Frontend (in a second terminal)

```bash
cd route-loop-finder
npm install
npm run dev
```

Open http://localhost:5173. Search a place with the icon at the top left (or press `/`), or click
the map to set the start, then press **Find loops**.

The first search in a new place downloads its roads from the public Overpass servers, which can
take tens of seconds. After that the area loads from `backend/map_data/`.

## Configuration

The backend is configured with environment variables (`LOOP_PORT`, `LOOP_MAX_MILES`,
`LOOP_ALLOWED_ORIGINS`, `LOOP_CONTACT`, `OVERPASS_URL`, memory and rate limits, ...). The UI
reads `VITE_WS_URL` and `VITE_GEOCODER_URL` from `route-loop-finder/.env.local`. Every setting
is listed in [RUNNING.md](RUNNING.md).

## Testing

| Check | Command | Where |
|---|---|---|
| Frontend logic tests (Vitest) | `npm test` | `route-loop-finder/` |
| Lint and build | `npx eslint src && npm run build` | `route-loop-finder/` |
| Backend tests | `python -m unittest discover -s tests` | `backend/` |
| End-to-end browser check | `python tools/check_frontend.py` | `backend/` |
| Public-server limits and load | `python tools/check_limits.py`, `python tools/check_load.py` | `backend/` |

The browser check drives the real app in headless Chromium against the bundled map tiles
(Boone, NC and Charlotte, NC) and needs `pip install -r backend/requirements-dev.txt`. Details and
troubleshooting are in [TESTING.md](TESTING.md).

## Deployment

The app is built to run as a public demo on a small (4 GB) Linux VPS: Caddy serves the built UI
over HTTPS and forwards `/ws` to the backend, which runs as a systemd service.

```bash
bash /opt/loop-finder/deploy/setup.sh loops.example.com you@example.com   # first time
bash /opt/loop-finder/deploy/update.sh                                    # each new version
```

See [DEPLOY.md](DEPLOY.md) for the step-by-step guide, including a local rehearsal with
`deploy/Caddyfile.local`.

## Project layout

```
backend/              Python WebSocket server, map store, graph builder, loop search
  tests/              unit tests
  tools/              browser check, load / limits checks, search benchmark
route-loop-finder/    React + Vite frontend
  src/components/     MapView/ (map layers, tools) and ControlPanel/ (plan, routes, settings)
  src/hooks/          WebSocket, generations, favorites, boundaries
  src/utils/          pure logic (filters, hover maths, road painting, boundaries) + tests
deploy/               Caddyfile, systemd unit, setup / update scripts
RUNNING.md            running locally and every setting
TESTING.md            the checks and what they cover
DEPLOY.md             putting the site online
```

## Data and credits

Road data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, fetched via
the Overpass API. Elevation from NASA SRTM. Place search by [Photon](https://photon.komoot.io).
Set `LOOP_CONTACT` to your email or project URL so the public map data servers can reach you,
as their usage policies ask.
