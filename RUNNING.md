# Running the app

Two processes: the Python backend (`backend/server.py`, WebSocket on port 8765) and the
Vite dev server for the React UI (`route-loop-finder/`, http://localhost:5173).

## 1. Python backend in a virtual environment

Always use a virtual environment (`venv/` in the project folder). Installing into the
system Python fails on Debian / Ubuntu with *externally-managed-environment*.

```bash
cd loop_gen_2026_v2_p2
python3 -m venv venv
source venv/bin/activate                      # Windows: venv\Scripts\activate
pip install -r backend/requirements.txt       # networkx, websockets, shapely, pyproj, SRTM.py
pip install -r backend/requirements-dev.txt   # optional: also what the checks need (see TESTING.md)
```

A conda environment works too: activate it and run the same `pip install -r backend/requirements.txt`
(it also upgrades an old `websockets`; the server needs 14 or newer and says so if it is older).

## 2. Start the backend

```bash
cd backend
../venv/bin/python server.py       # or, with the venv activated: python server.py
```

It prints `Ready: ws://localhost:8765` and runs until Ctrl-C. `http://localhost:8765/healthz` answers `ok` while it runs. Only one backend can use the
port: if one is already running (an earlier start, in another terminal or in the background),
a second start says so, shows the process and how to stop it (`kill <PID>`), or how to run on
another port (`LOOP_PORT=8766`, and the same `LOOP_PORT=8766` when starting the UI).

Map data downloads by itself: placing a start pin fetches the OpenStreetMap roads around
it into `backend/map_data/` (stored as 0.1° tiles, about 7 × 5.7 mi each, but downloaded
in one request for up to 16 tiles). The public Overpass server takes tens of seconds per
request and is sometimes overloaded (HTTP 502/504) or rate-limits (429); the server then
moves to the next Overpass server in the list, or waits for the slot its status page
announces. After the first time, the area is on disk and is not downloaded again.
Settings (environment variables). Set them before starting the server, in the same window:

```bash
LOOP_MAX_CONN_PER_IP=2 python server.py        # Linux / macOS: on the same line
set LOOP_MAX_CONN_PER_IP=2                     # Windows cmd / Anaconda Prompt: its own line,
python server.py                               #   then start the server (not on one line)
$env:LOOP_MAX_CONN_PER_IP="2"; python server.py   # Windows PowerShell
```

The server prints the limits in effect when it starts (`Limits: ...`), and a `WARNING` for a
setting it cannot read (then it uses the default).


| Variable | Meaning |
|---|---|
| `LOOP_MAP_DIR` | where map tiles are kept (default `backend/map_data/`) |
| `OVERPASS_URL` | Overpass endpoints to use in order, comma-separated (default: overpass-api.de, then overpass.private.coffee) |
| `LOOP_PORT` | WebSocket port (default 8765) |
| `LOOP_HOST` | address to listen on (default `localhost`; keep it behind a web server on the same machine) |
| `LOOP_MAX_MILES` | longest route anyone can ask for (default 50; the UI slider stops at 50 mi / 80 km) |
| `LOOP_ALLOWED_ORIGINS` | sites whose pages may connect, comma-separated (e.g. `https://loops.example.com`); unset: any (local use). A refused page is logged (`Refused a page from ...`) |
| `LOOP_CONTACT` | email or project URL sent to the public map data servers with each download (default: a placeholder, which a public server warns about) |
| `LOOP_MAX_CONN_PER_IP` | open connections (tabs) per visitor address (default 8); more get HTTP 429 and the UI retries |
| `LOOP_MAX_CONNECTIONS` | open connections in all (default 100) |
| `LOOP_SEARCH_SLOTS` | searches / map builds running at once, all visitors (default 1; the rest wait their turn and are told so) |
| `LOOP_MAX_AREAS` | built search graphs kept in memory (default 4, for a 4 GB server) |
| `LOOP_MAX_SESSIONS` | generations kept in memory for More routes (default 12; others are rebuilt when used) |
| `LOOP_TILE_CACHE` | parsed map tiles kept in memory (default 16) |
| `LOOP_IDLE_MINUTES` | generations and areas unused this long are dropped (default 30) |
| `LOOP_MSG_RATE`, `LOOP_MSG_BURST` | messages per second per connection (default 20, bursts of 200); a flood closes that connection |
| `LOOP_DEV=1` | show every Area sweep variant in the UI |

## 3. Start the UI

```bash
cd route-loop-finder
npm install                                   # only if node_modules/ is missing; needs internet
npm run dev
```

Open http://localhost:5173. The UI talks to the backend at `/ws` on the same address; the
Vite server forwards that to port 8765 (or `LOOP_PORT`). Search a place with the icon at the top left
(or press `/`), or click the map to set the start. Settings for the UI go in `route-loop-finder/.env.local`:
`VITE_WS_URL` points it straight at another server (e.g. `ws://localhost:8799`), `VITE_GEOCODER_URL`
at another Photon geocoder (default https://photon.komoot.io).

## 4. Blank road network map

Map tiles (OpenStreetMap, CyclOSM, Esri, USGS) come from the internet. Or pick **Blank road
network** from the layers button (top left of the map, under the search icon); the map also
switches to it by itself after a few tiles fail to load. It draws the roads of every
downloaded map tile (`backend/map_data/`) on a light background with a dashed outline, and
leaves the rest grey, so you can see which areas are already downloaded:

- Nothing downloaded in view: a button at the bottom, **Go to the nearest**, takes the map there.
- The dashed circle around the start is the area the search needs (half the longest route,
  plus a little). If it reaches into the grey, the map says how many tiles are missing;
  they are downloaded when you search.
- Below zoom 10 only the outline is drawn; major roads from zoom 10, every road from zoom 12.

The uploaded tiles cover Boone / Blowing Rock, NC (rural) and central Charlotte, NC (city).

## 5. Checking changes

See [TESTING.md](TESTING.md): the logic tests (`npm test`), lint and build, and the browser
check (`backend/tools/check_frontend.py`), how to set them up, and what they cover.

Other tools: `tools/bench_search.py` compares search strategies (speed, coverage).
