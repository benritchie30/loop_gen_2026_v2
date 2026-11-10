"""Several visitors at once: they take turns, waiting ones are told so, Stop
works while waiting, and the server gives its memory back when they leave.
Starts its own backend (the tiles in backend/map_data) on port 8796
with a short idle time (LOOP_IDLE_MINUTES=0.5), and reads its memory use.

    cd backend
    python tools/check_load.py              # 3 visitors
    python tools/check_load.py --users 5    # more

Prints each visitor's timeline, the server's memory, PASS / FAIL per check,
and exits non-zero on a failure. Takes 2-4 minutes (it waits for the idle
sweep at the end).
"""
import argparse
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
PORT = 8796
URL = f"ws://localhost:{PORT}"
LOG_PATH = os.path.join(BACKEND, "check_load.log")
# Starts whose whole search area is inside the uploaded tiles (no download needed):
# Charlotte (city) and Boone (rural).
PLACES = [
    {"lat": 35.200, "lng": -80.800, "min_path_len": 5, "max_path_len": 10},
    {"lat": 36.254622, "lng": -81.851116, "min_path_len": 6, "max_path_len": 12},
    {"lat": 35.195, "lng": -80.805, "min_path_len": 4, "max_path_len": 9},
    {"lat": 35.210, "lng": -80.810, "min_path_len": 4, "max_path_len": 8},
    {"lat": 36.260, "lng": -81.860, "min_path_len": 5, "max_path_len": 10},
    {"lat": 35.190, "lng": -80.790, "min_path_len": 4, "max_path_len": 8},
]
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))


def rss_mb(pid):
    """The server's memory in MB: psutil if installed (any system), else /proc (Linux), else None."""
    try:
        import psutil
        return psutil.Process(pid).memory_info().rss / 1e6
    except ImportError:
        pass
    except Exception:
        return None
    try:
        with open(f"/proc/{pid}/statm") as f:
            return int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 1e6
    except (OSError, ValueError, AttributeError):
        return None


def mb(value):
    return f"{value:.0f} MB" if value is not None else "unknown"


class Visitor:
    def __init__(self, name, place, routes, stop_after_wait=False):
        self.name, self.place, self.routes = name, place, routes
        self.stop_after_wait = stop_after_wait
        self.events = []  # (seconds, text)
        self.ahead_seen = []
        self.first = None
        self.count = 0
        self.done = None
        self.stopped = None
        self.t0 = None

    def log(self, text):
        self.events.append((time.time() - self.t0, text))

    async def run(self, delay):
        await asyncio.sleep(delay)
        async with websockets.connect(URL, max_size=None) as ws:
            for _ in range(2):
                await ws.recv()
            self.t0 = time.time()
            await ws.send(json.dumps({"type": "START_GENERATION", **self.place, "num_paths": self.routes}))
            self.log("asked for routes")
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), 300))
                kind = msg.get("type")
                if kind == "MAP_PROGRESS" and msg.get("phase") == "queue":
                    self.ahead_seen.append(msg.get("ahead"))
                    self.log(f"waiting, {msg.get('ahead')} ahead")
                    if self.stop_after_wait and len(self.ahead_seen) == 1:
                        await ws.send(json.dumps({"type": "STOP_GENERATION"}))
                        self.log("pressed Stop")
                elif kind == "MAP_PROGRESS" and msg.get("phase") in ("build", "search") and msg.get("done") == 0:
                    self.log("its turn: " + ("building the map" if msg["phase"] == "build" else "searching"))
                elif kind == "PATH_RECEIVED":
                    self.count += 1
                    if self.first is None:
                        self.first = time.time() - self.t0
                        self.log("first route")
                elif kind == "GENERATION_COMPLETE":
                    self.done = time.time() - self.t0
                    self.stopped = msg.get("stopped")
                    self.log(f"complete: {self.count} routes" + (" (stopped)" if self.stopped else ""))
                    return


async def main(args, pid):
    base = rss_mb(pid)
    print(f"Server memory at start: {mb(base)}" + ("" if base is not None else
          " (pip install psutil to measure it; the memory check is skipped)"))
    peak = [base or 0.0]

    async def watch():
        while True:
            m = rss_mb(pid)
            if m:
                peak[0] = max(peak[0], m)
            await asyncio.sleep(0.25)

    watcher = asyncio.create_task(watch())

    # Alone first: the speed one visitor gets.
    solo = Visitor("solo", PLACES[0], args.routes)
    await solo.run(0)
    print(f"\nOne visitor alone: first route {solo.first:.1f} s, {solo.count} routes in {solo.done:.1f} s")

    # Then everyone at once (different starts, so each needs its own map build too),
    # 0.3 s apart. One more arrives 2 s in, while all of them are busy, and presses
    # Stop as soon as it is told to wait.
    users = [Visitor(f"visitor {i + 1}", PLACES[(i + 1) % len(PLACES)], args.routes)
             for i in range(args.users)]
    users.append(Visitor("impatient visitor", PLACES[0], args.routes, stop_after_wait=True))
    delays = [0.3 * i for i in range(args.users)] + [2.0]
    await asyncio.gather(*(u.run(d) for u, d in zip(users, delays)))
    print(f"\n{args.users} visitors at once (0.3 s apart), and one that gives up:")
    for u in users:
        print(f"  {u.name}:")
        for t, text in u.events:
            print(f"    {t:6.1f} s  {text}")
    busy_peak = peak[0]
    after = rss_mb(pid)
    print(f"\nServer memory: peak {mb(busy_peak if base is not None else None)}, after the searches {mb(after)}")

    first = users[0]
    # Building a map and searching are separate turns: between its build and its
    # search, the first visitor may wait for the next visitor's build (one ahead).
    check("the first visitor waits at most for one other map build", all(a <= 1 for a in first.ahead_seen),
          f"waiting messages {first.ahead_seen}")
    check("...and gets routes at about solo speed", first.first is not None and first.first < solo.first * 2 + 3,
          f"first route {first.first:.1f} s (alone: {solo.first:.1f} s)" if first.first else "no route")
    others = users[1:-1]
    check("later visitors are told they are waiting", all(u.ahead_seen for u in others),
          "; ".join(f"{u.name}: {u.ahead_seen}" for u in others))
    check("...and every visitor gets routes", all(u.count > 0 and not u.stopped for u in users[:-1]),
          ", ".join(f"{u.name}: {u.count}" for u in users[:-1]))
    turns = sorted((u.events[[e[1] for e in u.events].index("first route")][0] + u.t0, u.name)
                   for u in users[:-1] if u.first is not None)
    check("turns are taken in arrival order", [n for _t, n in turns] == [u.name for u in users[:-1]],
          " -> ".join(n for _t, n in turns))
    last = users[-1]
    stop_t = next((t for t, e in last.events if e == "pressed Stop"), None)
    check("Stop while waiting ends that search at once",
          last.stopped is True and last.count == 0 and stop_t is not None and last.done - stop_t < 2,
          f"stopped={last.stopped}, {last.count} routes, {last.done - stop_t:.1f} s after Stop" if stop_t else
          f"never waited ({last.ahead_seen})")

    # Everyone leaves: after the idle time (30 s here) the sweep drops their generations and areas.
    print("\nWaiting for the idle sweep (about 90 s)...")
    await asyncio.sleep(95)
    watcher.cancel()
    idle = rss_mb(pid)
    with open(LOG_PATH) as f:
        sweeps = [line.strip() for line in f if line.startswith("[memory]")]
    print(f"Server memory after the sweep: {mb(idle)}")
    for line in sweeps:
        print(f"  log: {line}")
    check("idle generations and areas are dropped", bool(sweeps), sweeps[-1] if sweeps else "no sweep logged")
    if base is None or idle is None:
        print("  [SKIP] ...and memory is given back - memory cannot be read here (pip install psutil)")
    else:
        check("...and memory is given back", idle < busy_peak - 0.3 * (busy_peak - base),
              f"start {base:.0f} MB, peak {busy_peak:.0f} MB, idle {idle:.0f} MB")


def run():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--users", type=int, default=3)
    ap.add_argument("--routes", type=int, default=15, help="routes each visitor asks for")
    args = ap.parse_args()
    args.users = max(2, args.users)
    env = dict(os.environ, LOOP_PORT=str(PORT), LOOP_IDLE_MINUTES="0.5",
               PYTHONUNBUFFERED="1")
    with open(LOG_PATH, "w") as log:
        server = subprocess.Popen([sys.executable, "server.py"], cwd=BACKEND, env=env,
                                  stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(100):
                try:
                    urllib.request.urlopen(f"http://localhost:{PORT}/healthz", timeout=1)
                    break
                except (urllib.error.URLError, ConnectionError):
                    time.sleep(0.2)
            asyncio.run(main(args, server.pid))
        finally:
            server.terminate()
            server.wait(timeout=10)
    failed = results.count(False)
    print(f"\n{results.count(True)} passed, {failed} failed. Server log: {LOG_PATH}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(run())
