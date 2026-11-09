"""The public server's limits, end to end: bad and oversized messages, floods,
too many connections, other sites' pages. Starts its own backend (the
tiles in backend/map_data, no map downloads) on port 8798 with small connection caps.

    cd backend
    python tools/check_limits.py

Prints PASS / FAIL per check and exits non-zero on a failure.
"""
import asyncio
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
PORT = 8798
URL = f"ws://localhost:{PORT}"
ORIGIN = "https://loops.example.test"
CITY = {"lat": 35.2, "lng": -80.8}  # uploaded Charlotte tiles
LOG_PATH = os.path.join(BACKEND, "check_limits.log")
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))


async def connect(origin=ORIGIN, **kw):
    ws = await websockets.connect(URL, origin=origin, max_size=None, **kw)
    for _ in range(2):  # ALGORITHMS_LIST, MAP_INFO
        await asyncio.wait_for(ws.recv(), 10)
    return ws


async def until(ws, types, timeout=90):
    """Messages until one whose type is in `types` (that one last)."""
    out = []
    end = time.time() + timeout
    while time.time() < end:
        msg = json.loads(await asyncio.wait_for(ws.recv(), end - time.time()))
        out.append(msg)
        if msg.get("type") in types:
            return out
    raise TimeoutError(types)


async def alive(label):
    """The server still answers a normal request."""
    ws = await connect()
    await ws.send(json.dumps({"type": "START_GENERATION", **CITY, "min_path_len": 4, "max_path_len": 8,
                              "num_paths": 2}))
    msgs = await until(ws, {"GENERATION_COMPLETE"})
    await ws.close()
    n = sum(m["type"] == "PATH_RECEIVED" for m in msgs)
    check(f"server still works after {label}", n == 2, f"{n} routes")


async def main():
    # Health check
    try:
        body = urllib.request.urlopen(f"http://localhost:{PORT}/healthz", timeout=5).read().decode()
        check("/healthz answers ok", body.strip() == "ok", repr(body))
    except urllib.error.URLError as exc:
        check("/healthz answers ok", False, str(exc))

    # Junk of every kind on one connection
    ws = await connect()
    junk = [
        "not json", "[1, 2]", "null", '"text"', json.dumps({"type": 5}),
        json.dumps({"type": "START_GENERATION", "lat": "x", "lng": None}),
        json.dumps({"type": "START_GENERATION", "lat": 1e308, "lng": -1e308}),
        '{"type": "PREFETCH_AREA", "lat": NaN, "lng": Infinity}',
        json.dumps({"type": "CONTINUE_GENERATION", "pathSetId": ["x"], "rebuild": "y"}),
        json.dumps({"type": "CONTINUE_GENERATION", "pathSetId": "x" * 500}),
        json.dumps({"type": "OPEN_GENERATION", "pathSetId": "nope", "rebuild": {"lat": "a"}}),
        json.dumps({"type": "GET_GRAPH_EDGES", "areaId": {"a": 1}}),
        json.dumps({"type": "GET_TILE_ROADS", "tiles": [["a", "b"], None, 5]}),
        # min above max: the server makes them equal (nothing to find, but no crash)
        json.dumps({"type": "START_GENERATION", **CITY, "min_path_len": 99, "max_path_len": 4}),
        json.dumps({"type": "START_GENERATION", **CITY, "algorithm": ["x"], "selections": "y",
                    "road_weights": {"primary": "z"}, "num_paths": "many", "min_path_len": 3,
                    "max_path_len": "8", "loop_ratio": "most", "min_dist_m": -5}),
    ]
    for m in junk:
        await ws.send(m)
    # Two starts have a real start point (the others are dropped): the first is
    # stopped by the second, which finishes.
    await until(ws, {"GENERATION_COMPLETE"})
    done = (await until(ws, {"GENERATION_COMPLETE"}))[-1]
    check("junk messages are ignored, a messy but valid start still runs",
          done.get("added", 0) >= 1, f"{done.get('added')} routes, note {done.get('note')!r}")
    await ws.close()

    # num_paths is capped: a billion becomes 200 (the server logs what it runs)
    ws = await connect()
    await ws.send(json.dumps({"type": "START_GENERATION", **CITY, "min_path_len": 1, "max_path_len": 3,
                              "num_paths": 10**9}))
    await until(ws, {"GENERATION_COMPLETE"}, timeout=120)
    await ws.close()
    with open(LOG_PATH) as f:
        asked = [line for line in f if line.startswith("Starting generation:")]
    check("num_paths is capped at 200", bool(asked) and asked[-1].startswith("Starting generation: 200 paths"),
          asked[-1].strip() if asked else "no log line")

    # Oversized message: the connection is closed (1009), the server lives on
    ws = await connect()
    try:
        await ws.send(json.dumps({"type": "GET_TILE_ROADS", "pad": "x" * (5 * 1024 * 1024)}))
        await asyncio.wait_for(ws.recv(), 10)
        check("a 5 MB message closes the connection", False, "still open")
    except websockets.exceptions.ConnectionClosed as exc:
        check("a 5 MB message closes the connection", exc.rcvd is not None and exc.rcvd.code == 1009,
              f"code {exc.rcvd.code if exc.rcvd else None}")

    # Flood: past the burst the connection is closed (1008)
    ws = await connect()
    try:
        for _ in range(400):
            await ws.send(json.dumps({"type": "STOP_GENERATION"}))
        await asyncio.wait_for(ws.recv(), 10)
        check("a flood of messages closes the connection", False, "still open")
    except websockets.exceptions.ConnectionClosed as exc:
        check("a flood of messages closes the connection", exc.rcvd is not None and exc.rcvd.code == 1008,
              f"code {exc.rcvd.code if exc.rcvd else None}")

    # Connections per address (LOOP_MAX_CONN_PER_IP=3 here)
    open_ = [await connect() for _ in range(3)]
    try:
        extra = await connect()
        await extra.close()
        check("a 4th connection from one address is refused", False, "accepted")
    except websockets.exceptions.InvalidStatus as exc:
        check("a 4th connection from one address is refused", exc.response.status_code == 429,
              f"HTTP {exc.response.status_code}")
    # ...counted per visitor behind the web server (X-Forwarded-For from loopback)
    other = await connect(additional_headers={"X-Forwarded-For": "203.0.113.9"})
    check("...but another visitor behind the web server still gets in", True)
    await other.close()
    for c in open_:
        await c.close()
    await asyncio.sleep(0.3)
    again = await connect()
    check("closing connections frees the slots", True)
    await again.close()

    # Pages from other sites (LOOP_ALLOWED_ORIGINS)
    try:
        bad = await connect(origin="https://evil.example")
        await bad.close()
        check("a page from another site is refused", False, "accepted")
    except websockets.exceptions.InvalidStatus as exc:
        check("a page from another site is refused", exc.response.status_code == 403,
              f"HTTP {exc.response.status_code}")
    ws = await connect(origin=None)
    check("a client without Origin (script, monitor) is allowed", True)
    await ws.close()

    await alive("all of the above")


def run():
    env = dict(os.environ, LOOP_PORT=str(PORT), LOOP_MAX_CONN_PER_IP="3",
               LOOP_ALLOWED_ORIGINS=ORIGIN, PYTHONUNBUFFERED="1")
    log_path = LOG_PATH
    with open(log_path, "w") as log:
        server = subprocess.Popen([sys.executable, "server.py"], cwd=BACKEND, env=env,
                                  stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(100):
                try:
                    urllib.request.urlopen(f"http://localhost:{PORT}/healthz", timeout=1)
                    break
                except (urllib.error.URLError, ConnectionError):
                    time.sleep(0.2)
            asyncio.run(main())
        finally:
            server.terminate()
            server.wait(timeout=10)
    failed = results.count(False)
    print(f"\n{results.count(True)} passed, {failed} failed. Server log: {log_path}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(run())
