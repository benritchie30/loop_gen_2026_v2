"""WebSocket server: map areas, route generation, and continuation.

Messages are JSON with a `type`. See project-overview.mdc for the contract.
Map data is downloaded by map_store (tiles, once per area) and each
generation searches its own graph built by areas / graph_builder, so there
is no global "active graph".
"""
import asyncio
import contextvars
import http
import time
import errno
import json
import os
import sys
import threading
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

import websockets

import boundary as boundary_mod
import limits
from areas import Areas, MapError, tiles_needed
from graph_builder import BuildError
from loop_generator import find_paths, is_resumable, list_algorithms, resolve_algorithm
from loop_tree import is_idle, resolve_selections
from map_store import TILE_DEG, MapStore
from road_stress import preference_weights
from tile_roads import TileRoads
from work_queue import WorkQueue

# Settings (environment variables; see RUNNING.md and DEPLOY.md).
HOST = os.environ.get("LOOP_HOST") or "localhost"  # behind a web server on the same machine: keep localhost
PORT = limits.env_number("LOOP_PORT", 8765, lo=1)
# Generations kept in memory (parked search, centroids; each holds its area), all
# connections. A dropped one is rebuilt from the browser's copy when used again.
MAX_SESSIONS = limits.env_number("LOOP_MAX_SESSIONS", 12, lo=1)
# Generations and areas unused this long are dropped, so an idle server gives its memory back.
IDLE_S = limits.env_number("LOOP_IDLE_MINUTES", 30, float, lo=0.1) * 60
SWEEP_S = 60
MILE_M = 1609.34
# Longest route anyone can ask for. The map area (download and memory) grows
# with the square of this. The UI's slider stops at the same value (utils/units.js).
MAX_ROUTE_MILES = limits.env_number("LOOP_MAX_MILES", 50, float, lo=1)

store = MapStore()
# Searches and area builds take turns (LOOP_SEARCH_SLOTS at a time, default 1):
# work_queue.py says why. Waiting visitors get MAP_PROGRESS {phase: 'queue', ahead}.
WORK = WorkQueue(limits.env_number("LOOP_SEARCH_SLOTS", 1, lo=1))
# When the request being served arrived (time.monotonic()): its place in WORK's
# line, for its map build and its search alike. Set as each message comes in;
# the task started for it keeps that value.
ARRIVED: "contextvars.ContextVar[float | None]" = contextvars.ContextVar("arrived", default=None)
areas = Areas(store, queue=WORK)
tile_roads = TileRoads(store)
MAX_TILES_PER_REQUEST = 64


def map_info() -> dict:
    """MAP_INFO: size of the map data, and which tiles are downloaded (the offline basemap)."""
    return {"type": "MAP_INFO", **store.stats(), "tileDeg": TILE_DEG,
            "coverage": [list(t) for t in store.tiles()]}

# Every generation's server state by pathSetId, shared by all connections so a
# reload (new connection) resumes it. Least recently used first. A lost
# session (restart, eviction) is rebuilt from the `rebuild` payload the
# client sends with OPEN_GENERATION / CONTINUE_GENERATION.
SESSIONS: "OrderedDict[str, dict]" = OrderedDict()
_session_locks: dict = {}


# Open connections per visitor address (limits.MAX_CONN_PER_IP, MAX_CONNECTIONS).
CONNECTIONS: "dict[str, int]" = {}


def client_ip(connection) -> str:
    """The visitor's address. Behind the web server on this machine (the
    connection comes from loopback) it is the last X-Forwarded-For entry,
    the one that server added; otherwise the socket's own address."""
    remote = connection.remote_address[0] if connection.remote_address else "?"
    if remote in ("127.0.0.1", "::1", "localhost") and connection.request is not None:
        forwarded = connection.request.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[-1].strip() or remote
    return remote


async def handler(websocket):
    ip = client_ip(websocket)
    CONNECTIONS[ip] = CONNECTIONS.get(ip, 0) + 1
    try:
        await _serve_connection(websocket)
    finally:
        CONNECTIONS[ip] -= 1
        if CONNECTIONS[ip] <= 0:
            del CONNECTIONS[ip]


async def _serve_connection(websocket):
    print(f"Client connected ({sum(CONNECTIONS.values())} open)")
    await send(websocket, {"type": "ALGORITHMS_LIST", "algorithms": list_algorithms()})
    await send(websocket, map_info())

    # One running batch per connection. Each batch gets a fresh stop Event;
    # the session it runs on reads it (session["stop"]).
    gen_state = {"task": None, "stop": threading.Event()}
    # Background map download for the pin being placed (one at a time).
    prefetch_state = {"task": None, "stop": threading.Event()}
    # Generations being opened: their rebuilds stop when the connection closes.
    open_stop = threading.Event()
    # Road layers are sent one request at a time per connection.
    layers_lock = asyncio.Lock()
    rate = limits.RateLimit()
    conn_id = object()

    async def stop_current_generation():
        task = gen_state["task"]
        gen_state["stop"].set()
        if task is not None and not task.done():
            await task

    def stop_prefetch():
        # Not awaited: an old prefetch may be mid-build. Its AREA_READY still
        # arrives; the client ignores one for a pin it no longer has.
        prefetch_state["stop"].set()

    try:
        closing = False
        async for message in websocket:
            if closing:
                continue  # keep reading, so the close handshake is not stuck behind queued messages
            if not rate.allow():
                print(f"Too many messages from {client_ip(websocket)}; closing the connection")
                closing = True
                gen_state["stop"].set()
                asyncio.create_task(websocket.close(1008, "too many messages"))
                continue
            try:
                data = json.loads(message)
                if not isinstance(data, dict):
                    continue
                msg_type = data.get("type")
                print(f"Received: {str(msg_type)[:40]}")
                ARRIVED.set(time.monotonic())  # copied into the task started below

                if msg_type == "START_GENERATION":
                    await stop_current_generation()
                    gen_state["stop"] = threading.Event()
                    gen_state["task"] = asyncio.create_task(
                        guarded(_run_generation(websocket, data, gen_state), "generation"))
                elif msg_type == "CONTINUE_GENERATION":
                    await stop_current_generation()
                    gen_state["stop"] = threading.Event()
                    gen_state["task"] = asyncio.create_task(
                        guarded(_continue_generation(websocket, data, gen_state), "continuation"))
                elif msg_type == "STOP_GENERATION":
                    gen_state["stop"].set()
                elif msg_type == "PREFETCH_AREA":
                    stop_prefetch()
                    prefetch_state["stop"] = threading.Event()
                    prefetch_state["task"] = asyncio.create_task(
                        guarded(_prefetch(websocket, data, prefetch_state["stop"], conn_id), "prefetch"))
                elif msg_type == "OPEN_GENERATION":
                    asyncio.create_task(guarded(_open_generation(websocket, data, open_stop), "open generation"))
                elif msg_type == "GET_TILE_ROADS":
                    asyncio.create_task(guarded(_one_at_a_time(layers_lock, handle_get_tile_roads(websocket, data)),
                                                "tile roads"))
                elif msg_type == "GET_ROAD_SEGMENTS":
                    asyncio.create_task(guarded(_one_at_a_time(layers_lock, handle_get_road_segments(websocket, data)),
                                                "road segments"))
                elif msg_type == "GET_GRAPH_EDGES":
                    asyncio.create_task(guarded(_one_at_a_time(layers_lock, handle_get_graph_edges(websocket, data)),
                                                "road layer"))
                else:
                    print(f"Unknown message type: {str(msg_type)[:40]}")
            except json.JSONDecodeError:
                print("Failed to decode JSON")
            except Exception as e:
                print(f"Error handling message: {e}")
                import traceback
                traceback.print_exc()

    except websockets.exceptions.ConnectionClosed:
        print("Client disconnected")
    finally:
        # Sessions stay: a reload reconnects and continues them.
        await stop_current_generation()
        stop_prefetch()
        open_stop.set()
        store.cancel_prefetch(conn_id)


async def _one_at_a_time(lock, coro):
    async with lock:
        await coro


async def send(websocket, payload):
    await websocket.send(json.dumps(payload))


async def guarded(coro, label):
    """Run a per-connection task; a dropped connection is not an error."""
    try:
        await coro
    except websockets.exceptions.ConnectionClosed:
        print(f"Client disconnected during {label}")
    except Exception as e:
        print(f"Error during {label}: {e}")
        import traceback
        traceback.print_exc()


def _progress_sender(websocket, loop, extra):
    """progress(phase, done, total, mb) callable for worker threads."""
    def progress(phase, done, total, mb=None):
        payload = {"type": "MAP_PROGRESS", "phase": phase, "done": done, "total": total, **extra}
        if phase == "queue":
            payload["ahead"] = done  # searches / builds ahead of this one
        if mb is not None:
            payload["mb"] = mb
        asyncio.run_coroutine_threadsafe(send(websocket, payload), loop)
    return progress


def _max_meters(data) -> float:
    return limits.number(data.get("max_path_len"), MAX_ROUTE_MILES, 1.0, MAX_ROUTE_MILES) * MILE_M


async def _get_area(websocket, lat, lng, max_m, stop_event, extra, hold=True, boundary=None):
    """The search graph for this start (inside `boundary`, a custom search
    boundary, if given), downloading tiles and building as needed, with
    MAP_PROGRESS messages. Returns (area, error message)."""
    loop = asyncio.get_running_loop()
    progress = _progress_sender(websocket, loop, extra)
    arrived = ARRIVED.get()
    try:
        area = await loop.run_in_executor(
            None, lambda: areas.get(lat, lng, max_m, progress=progress,
                                    should_stop=stop_event.is_set, hold=hold, priority=arrived,
                                    boundary=boundary))
        return area, None
    except (MapError, BuildError) as exc:
        return None, str(exc)


async def _prefetch(websocket, data, stop_event, conn_id):
    """A pin was placed or moved: download its map tiles in the background and
    build its graph, so generating starts at once and roads can be painted.
    Queued downloads for the previous pin are cancelled."""
    point = limits.lat_lng(data.get("lat"), data.get("lng"))
    if point is None:
        return
    lat, lng = point
    max_m = _max_meters(data)
    boundary = data.get("boundary")
    tiles = tiles_needed(lat, lng, max_m, boundary)
    store.cancel_prefetch(conn_id, keep=tiles)
    store.prefetch(tiles, owner=conn_id)
    # `token` (the UI's, echoed): which request of this pin an answer is for
    # (another max or boundary asks again for the same pin).
    token = limits.ident(data.get("token"))
    extra = {"scope": "prefetch", "lat": lat, "lng": lng, "token": token}
    area, error = await _get_area(websocket, lat, lng, max_m, stop_event, extra, hold=False, boundary=boundary)
    if stop_event.is_set():
        return
    if error:
        await send(websocket, {"type": "MAP_ERROR", "scope": "prefetch", "lat": lat, "lng": lng,
                               "token": token, "error": error})
    elif area is not None:
        # For the pin asked about (the area may have been built for the pin
        # before it moved onto its start); `start` is where routes begin.
        await send(websocket, {"type": "AREA_READY", "scope": "prefetch", **area.info(), "lat": lat, "lng": lng,
                               "token": token})
        await send(websocket, map_info())  # tiles may have been downloaded


async def _stream_batch(websocket, gen, path_set_id, max_paths, stop_event, first=None, centroids=None):
    """Pull up to max_paths routes off the generator in a worker thread.

    `first` is a request to send() into a parked guided generator. Sent
    routes' centroids are appended to `centroids` (the generation's memory,
    so a later search with another algorithm never repeats them). Returns
    (count, note, dead): note is the generator's reason when it parked with
    nothing more to give; dead means the generator finished for good and
    cannot be resumed.
    """
    loop = asyncio.get_running_loop()
    count = 0
    note = None
    dead = False
    pending = first

    # Take a turn (other visitors' searches and builds first).
    waited = []

    def on_wait(ahead):
        waited.append(ahead)
        asyncio.run_coroutine_threadsafe(send(websocket, {
            "type": "MAP_PROGRESS", "pathSetId": path_set_id, "phase": "queue", "ahead": ahead,
            "done": ahead, "total": 0}), loop)

    arrived = ARRIVED.get()
    got_turn = await loop.run_in_executor(None, lambda: WORK.acquire(should_stop=stop_event.is_set,
                                                                      on_wait=on_wait, priority=arrived))
    if not got_turn:
        return count, note, dead
    try:
        if waited:
            print(f"Search {path_set_id[:8]} waited its turn ({waited[0]} ahead at first)")
            # Clears the waiting line in the UI (no text for this phase).
            await send(websocket, {"type": "MAP_PROGRESS", "pathSetId": path_set_id, "phase": "search",
                                   "done": 0, "total": 0})
        return await _stream_turn(websocket, gen, path_set_id, max_paths, stop_event, pending, centroids)
    finally:
        WORK.release()


async def _stream_turn(websocket, gen, path_set_id, max_paths, stop_event, pending, centroids):
    """_stream_batch's work, while it has the turn."""
    loop = asyncio.get_running_loop()
    count = 0
    note = None
    dead = False

    def step():
        try:
            if pending is not None:
                return gen.send(pending)
            return next(gen)
        except StopIteration:
            return None

    while count < max_paths and not stop_event.is_set():
        item = await loop.run_in_executor(None, step)
        pending = None
        if item is None:
            dead = True
            break
        if is_idle(item):
            note = item.get("note")
            break
        await send(websocket, {"type": "PATH_RECEIVED", "pathSetId": path_set_id, "path": item})
        count += 1
        centroid = (item.get("properties") or {}).get("centroid")
        if centroids is not None and centroid:
            centroids.append(tuple(centroid))
    return count, note, dead


def _touch(session):
    session["used"] = time.monotonic()
    area = session.get("area")
    if area is not None:
        area.used = time.time()  # an area in use stays in the area cache


def _get_session(path_set_id):
    session = SESSIONS.get(path_set_id)
    if session is not None:
        SESSIONS.move_to_end(path_set_id)
        _touch(session)
    return session


def _drop_session(session_id):
    old = SESSIONS.pop(session_id)
    _session_locks.pop(session_id, None)
    if old.get("gen") is not None:
        old["gen"].close()


def _remember_session(path_set_id, session):
    SESSIONS[path_set_id] = session
    SESSIONS.move_to_end(path_set_id)
    _touch(session)
    for old_id in list(SESSIONS):
        if len(SESSIONS) <= MAX_SESSIONS:
            break
        if SESSIONS[old_id]["lock"].locked():
            continue  # streaming right now
        _drop_session(old_id)


def _rss_mb():
    """This process's resident memory (Linux), or None."""
    try:
        with open("/proc/self/statm") as f:
            return int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 1e6
    except (OSError, ValueError, IndexError):
        return None


def _malloc_trim():
    """Hand freed memory back to the system (glibc keeps it otherwise)."""
    try:
        import ctypes
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):
        pass


def sweep(idle_s=None):
    """Drop generations and areas unused for idle_s seconds (default IDLE_S),
    and generations whose area left the area cache (they would keep a whole
    graph alive); with no area left, the parsed map tiles too. A dropped
    generation is rebuilt from the browser's copy when used again.
    Returns (sessions dropped, areas dropped)."""
    idle_s = IDLE_S if idle_s is None else idle_s
    now = time.monotonic()
    gone_areas = areas.drop_idle(idle_s)
    gone = []
    for sid, session in list(SESSIONS.items()):
        if session["lock"].locked():
            continue  # streaming or waiting for its turn
        idle = now - session.get("used", now)
        orphan = areas.by_id(session["area"].id) is None
        if idle > idle_s or (orphan and idle > SWEEP_S):
            _drop_session(sid)
            gone.append(sid)
    if gone_areas and len(areas) == 0:
        store.clear_cache()  # nothing left to build near: the parsed tiles go too
    if gone or gone_areas:
        import gc
        gc.collect()
        _malloc_trim()
        rss = _rss_mb()
        print(f"[memory] dropped {len(gone)} generations, {len(gone_areas)} areas; now "
              f"{len(SESSIONS)} generations, {len(areas)} areas"
              + (f", {rss:.0f} MB" if rss is not None else ""))
    return len(gone), len(gone_areas)


async def _sweeper():
    while True:
        await asyncio.sleep(SWEEP_S)
        try:
            sweep()
        except Exception as exc:  # never let the sweeper die
            print(f"[memory] sweep failed: {exc}")


def _new_session(path_set_id, lat, lng, area, kwargs, algorithm, settings, centroids=(), batches=0):
    return {
        "id": path_set_id, "lat": lat, "lng": lng, "area": area, "G": area.G,
        "start_node": area.start, "kwargs": kwargs, "settings": dict(settings or {}),
        "algorithm": algorithm, "batches": batches, "gen": None,
        "centroids": [tuple(c) for c in centroids if c], "foreign": [],
        "stop": threading.Event(), "lock": asyncio.Lock(), "used": time.monotonic(),
    }


async def _ensure_session(websocket, path_set_id, rebuild, stop_event):
    """The generation's session, rebuilt from the client's `rebuild` payload
    ({lat, lng, settings, centroids, batches}) when this process lost it.
    Returns (session, error): (None, None) when stopped or nothing to rebuild from."""
    session = _get_session(path_set_id)
    if session is not None or not isinstance(rebuild, dict) or not rebuild:
        return session, None
    lock = _session_locks.setdefault(path_set_id, asyncio.Lock())
    try:
        async with lock:  # one rebuild per generation, even from two requests
            session = _get_session(path_set_id)
            if session is not None:
                return session, None
            point = limits.lat_lng(rebuild.get("lat"), rebuild.get("lng"))
            if point is None:
                return None, "This generation cannot be continued (no start point)."
            lat, lng = point
            settings = rebuild.get("settings") if isinstance(rebuild.get("settings"), dict) else {}
            kwargs = _search_kwargs(settings)
            area, error = await _get_area(websocket, lat, lng, kwargs["max_path_length"], stop_event,
                                          {"pathSetId": path_set_id}, boundary=settings.get("boundary"))
            if area is None:
                return None, error
            session = _new_session(path_set_id, lat, lng, area, kwargs,
                                   _algorithm(settings.get("algorithm")), settings,
                                   centroids=limits.centroids(rebuild.get("centroids")),
                                   batches=limits.count(rebuild.get("batches"), 0, 100_000, lo=0))
            _remember_session(path_set_id, session)
            print(f"Rebuilt session {path_set_id[:8]}: {len(session['centroids'])} known routes, area {area.id}")
            return session, None
    finally:
        if path_set_id not in SESSIONS and not lock.locked():
            _session_locks.pop(path_set_id, None)  # a failed rebuild leaves nothing behind


async def _apply_settings(websocket, session, settings, stop_event):
    """New length / roads / tuning / boundary for a generation's later batches.
    Needs a fresh generator (the parked one has its limits built in) and, when
    the max grew past the area or the boundary changed, another area. Returns
    an error message or None."""
    kwargs = _search_kwargs(settings)
    boundary = settings.get("boundary")
    new_boundary = boundary_mod.key(boundary) != session["area"].boundary_key
    if kwargs == session["kwargs"] and not new_boundary:
        return None
    if new_boundary or kwargs["max_path_length"] > session["area"].max_m + 1.0:
        area, error = await _get_area(websocket, session["lat"], session["lng"], kwargs["max_path_length"],
                                      stop_event, {"pathSetId": session["id"]}, boundary=boundary)
        if area is None:
            return error or "Stopped."
        session.update(area=area, G=area.G, start_node=area.start)
        await send(websocket, {"type": "AREA_READY", "pathSetId": session["id"], **area.info()})
        await send(websocket, map_info())  # tiles may have been downloaded
    if session.get("gen") is not None:
        session["gen"].close()
        session["gen"] = None
    session["kwargs"] = kwargs
    session["settings"] = dict(settings)
    print(f"Session {session['id'][:8]}: new settings "
          f"{kwargs['min_path_length'] / MILE_M:.1f}-{kwargs['max_path_length'] / MILE_M:.1f} mi"
          f"{', boundary ' + str(session['area'].boundary_key) if session['area'].boundary_key else ''}")
    return None


async def _resolve_and_report(websocket, path_set_id, G, selections):
    """Turn client selections into require / forbidden edge sets and tell
    the client where pins landed (or which selections hit no road)."""
    loop = asyncio.get_running_loop()
    resolved = await loop.run_in_executor(None, resolve_selections, G, selections or [])
    if selections:
        await send(websocket, {"type": "CONSTRAINTS_RESOLVED", "pathSetId": path_set_id,
                               "results": resolved["results"]})
    return resolved


def _search_kwargs(data):
    """find_paths keyword arguments from a START_GENERATION payload (miles in)."""
    max_path_len = _max_meters(data)
    min_path_len = limits.number(data.get("min_path_len"), 2.0, 0.5) * MILE_M
    min_path_len = min(min_path_len, max_path_len)
    tuning = {}
    for key in ("explore_weight", "detour_weight", "reuse_weight"):
        value = limits.number(data.get(key), None, 0.0, 100.0)
        if value is not None:
            tuning[key] = value
    rural_scale = data.get("rural_scale", True)
    if isinstance(rural_scale, str):
        rural_scale = rural_scale.strip().lower() not in ("false", "0", "no")
    else:
        rural_scale = bool(rural_scale)
    return dict(
        min_path_length=min_path_len,
        max_path_length=max_path_len,
        loop_ratio_floor=limits.number(data.get("loop_ratio"), 0.5, 0.2, 0.9),  # the UI offers 0.2-0.9
        min_loop_length=600,
        min_dist_m=limits.number(data.get("min_dist_m"), 50.0, 10.0, 1000.0),
        # Custom weights (Advanced table) win over the Roads choice.
        road_weights=limits.road_weights(data.get("road_weights"))
        or preference_weights(data.get("road_preference")),
        rural_scale=rural_scale,
        **tuning,
    )


def _algorithm(value, fallback=None):
    """Registry key for a client's algorithm name (anything else: the fallback / default)."""
    return resolve_algorithm(value if isinstance(value, str) else fallback)


async def _complete(websocket, path_set_id, stopped, added, note, resumable):
    await send(websocket, {"type": "GENERATION_COMPLETE", "pathSetId": path_set_id,
                           "stopped": stopped, "added": added, "note": note, "resumable": resumable})


async def _run_generation(websocket, data, gen_state):
    stop_event = gen_state["stop"]
    point = limits.lat_lng(data.get("lat"), data.get("lng"))
    if point is None:
        return
    lat, lng = point

    path_set_id = str(uuid.uuid4())
    await send(websocket, {"type": "PATHSET_CREATED", "pathSetId": path_set_id,
                           "markerPosition": {"lat": lat, "lng": lng}})

    # 1. The graph for this start and distance (downloads map tiles the first time).
    kwargs = _search_kwargs(data)
    area, error = await _get_area(websocket, lat, lng, kwargs["max_path_length"], stop_event,
                                  {"pathSetId": path_set_id}, boundary=data.get("boundary"))
    if area is None:
        await _complete(websocket, path_set_id, stop_event.is_set(), 0, error, False)
        return
    await send(websocket, {"type": "AREA_READY", "pathSetId": path_set_id, **area.info()})
    await send(websocket, map_info())  # tiles may have been downloaded

    G, start_node = area.G, area.start
    max_paths = limits.count(data.get("num_paths"), 50, limits.MAX_PATHS)
    algorithm = _algorithm(data.get("algorithm"))
    resumable = is_resumable(algorithm)

    # 2. Roads / areas painted before generating constrain the first search too.
    resolved = await _resolve_and_report(websocket, path_set_id, G, limits.selections(data.get("selections")))
    constraints = {
        "require": [sorted(r) for r in resolved["require"]],
        "forbidden": sorted(resolved["forbidden"]),
    }
    roads = "custom weights" if data.get("road_weights") else (data.get("road_preference") or "balanced")
    print(f"Starting generation: {max_paths} paths, {algorithm}, "
          f"{kwargs['min_path_length'] / MILE_M:.1f}-{kwargs['max_path_length'] / MILE_M:.1f} mi, "
          f"roads {roads}, area {area.id}, {len(constraints['require'])} required sets, "
          f"{len(constraints['forbidden'])} forbidden edges")

    # 3. Every generation keeps a session: start, settings, graph, and the
    # centroids of every route sent, so later batches never repeat a route.
    # A tree_guided generator is parked in it. The search runs in a worker
    # thread so STOP_GENERATION gets through; it reads the session's stop
    # flag, which each batch points at the stop Event of whoever runs it.
    session = _new_session(path_set_id, lat, lng, area, kwargs, algorithm, data)
    session["stop"] = stop_event
    gen = find_paths(G, start_node, algorithm=algorithm,
                     should_stop=lambda: session["stop"].is_set(), **kwargs, **constraints)
    _remember_session(path_set_id, session)
    count, note = 0, None
    dead = True
    async with session["lock"]:
        try:
            count, note, dead = await _stream_batch(
                websocket, gen, path_set_id, max_paths, stop_event, centroids=session["centroids"])
        finally:
            if resumable and not dead:
                session["gen"] = gen  # parked, takes CONTINUE requests
            else:
                gen.close()

    stopped = stop_event.is_set()
    if stopped:
        print(f"Generation stopped by client after {count} paths")
    await _complete(websocket, path_set_id, stopped, count, note, True)


async def _continue_generation(websocket, data, gen_state):
    """More routes for a generation, through the client's selections.

    Include pins / roads / areas become edge sets every new route must
    cross, exclude selections become edges no route may use. `settings`
    (optional) are the generation's settings for this batch: a new length or
    road choice restarts the search (no repeats) and may grow the area.
    `rebuild` lets the server recreate the generation if it lost it. A
    parked tree_guided generator with unchanged settings resumes in place;
    otherwise a fresh one runs, seeded with every route the generation has,
    and is parked for the next batch.
    """
    stop_event = gen_state["stop"]
    path_set_id = limits.ident(data.get("pathSetId"))
    if path_set_id is None:
        return
    session, error = await _ensure_session(websocket, path_set_id, data.get("rebuild"), stop_event)
    if session is None:
        if error:
            await _complete(websocket, path_set_id, stop_event.is_set(), 0, error, True)
        elif not stop_event.is_set():
            await send(websocket, {
                "type": "GENERATION_ERROR", "pathSetId": path_set_id, "code": "SESSION_EXPIRED",
                "error": "This generation can no longer be continued. Start a new generation.",
            })
        else:
            await _complete(websocket, path_set_id, True, 0, None, True)
        return

    async with session["lock"]:
        session["stop"] = stop_event
        await send(websocket, {"type": "GENERATION_RESUMED", "pathSetId": path_set_id,
                               "batch": session["batches"] + 1, "via": [],
                               "algorithm": session["algorithm"]})
        if isinstance(data.get("settings"), dict) and data["settings"]:
            error = await _apply_settings(websocket, session, data["settings"], stop_event)
            if error:
                await _complete(websocket, path_set_id, stop_event.is_set(), 0, error, True)
                return

        selections = limits.selections(data.get("selections"))
        max_paths = limits.count(data.get("num_paths"), 10, limits.MAX_PATHS)
        algorithm = _algorithm(data.get("algorithm"), session["algorithm"])

        resolved = await _resolve_and_report(websocket, path_set_id, session["G"], selections)
        session["batches"] += 1
        request = {
            "require": [sorted(r) for r in resolved["require"]],
            "via": resolved["via"],
            "forbidden": sorted(resolved["forbidden"]),
            "batch": session["batches"],
        }
        print(f"Continuing {path_set_id[:8]} batch {session['batches']} with {algorithm}: "
              f"{len(request['require'])} required sets, {len(request['forbidden'])} forbidden edges, "
              f"up to {max_paths} routes")

        parked = session.get("gen")
        if parked is not None and algorithm == session["algorithm"]:
            # Resume in place; tell it about routes other engines added meanwhile.
            request["known_centroids"] = [list(c) for c in session["foreign"]]
            session["foreign"] = []
            count, note, dead = await _stream_batch(
                websocket, parked, path_set_id, max_paths, stop_event, first=request,
                centroids=session["centroids"])
            if dead:
                session["gen"] = None
        else:
            fresh = find_paths(
                session["G"], session["start_node"], algorithm=algorithm,
                should_stop=lambda: session["stop"].is_set(),
                require=request["require"], forbidden=request["forbidden"],
                known_centroids=[list(c) for c in session["centroids"]],
                **session["kwargs"],
            )
            # No parked generator yet (new settings, rebuilt session): this one
            # becomes it. Another algorithm than the parked one runs once.
            park = parked is None and is_resumable(algorithm)
            if park:
                session["algorithm"] = algorithm
            before = len(session["centroids"])
            dead = True
            try:
                count, note, dead = await _stream_batch(
                    websocket, fresh, path_set_id, max_paths, stop_event, centroids=session["centroids"])
            finally:
                if park and not dead:
                    session["gen"] = fresh
                else:
                    fresh.close()
            if not park:
                session["foreign"].extend(session["centroids"][before:])
            if count == 0 and note is None and not stop_event.is_set():
                note = "No new routes were found with these settings."
    stopped = stop_event.is_set()
    if note is None and count == 0 and not stopped:
        note = "No more routes through these selections were found."
    await _complete(websocket, path_set_id, stopped, count, note, True)


async def _open_generation(websocket, data, stop_event):
    """A generation was opened (or reopened after a reload): make sure the
    server has its session and area, so its roads can be painted and More
    routes starts at once. Answers AREA_READY {pathSetId, areaId, ...}.
    stop_event: the connection closed."""
    path_set_id = limits.ident(data.get("pathSetId"))
    if path_set_id is None:
        return
    session, error = await _ensure_session(websocket, path_set_id, data.get("rebuild"), stop_event)
    if stop_event.is_set():
        return
    if session is None:
        await send(websocket, {"type": "GENERATION_ERROR", "pathSetId": path_set_id,
                               "code": "MAP_ERROR" if error else "SESSION_EXPIRED",
                               "error": error or "This generation can no longer be continued."})
        return
    await send(websocket, {"type": "AREA_READY", "pathSetId": path_set_id, **session["area"].info()})


def _graph_edge_lines(G):
    """One record per undirected edge: node pair, street name, and geometry
    as [lat, lng] points. Feeds the road layer, road painting, and the
    offline basemap."""
    from loop_tree import edge_table
    E = edge_table(G)
    out = []
    for uid, coords in enumerate(E.geom):
        e = E.by_uid[uid][0]
        out.append({
            "u": E.tail[e], "v": E.head[e], "name": E.road_name(uid),
            "pts": [[round(y, 5), round(x, 5)] for x, y in coords],
        })
    return out


async def handle_get_graph_edges(websocket, data):
    """Road geometry of one area (`areaId`), or of a generation's area (`pathSetId`)."""
    area_id = limits.ident(data.get("areaId"))
    area = areas.by_id(area_id) if area_id else None
    if area is None:
        for sid, session in SESSIONS.items():
            a = session.get("area")
            if a is not None and (a.id == area_id or sid == data.get("pathSetId")):
                area = a
                break
    lines = []
    if area is not None:
        loop = asyncio.get_running_loop()
        lines = await loop.run_in_executor(None, _graph_edge_lines, area.G)
    await send(websocket, {"type": "GRAPH_EDGES", "areaId": area.id if area else area_id,
                           "lines": lines})


ADDRESS_IN_USE = {errno.EADDRINUSE, 10048}  # 10048: Windows


async def _backend_already_there(port) -> bool:
    """Is the program on the port another copy of this backend? (It greets with ALGORITHMS_LIST.)"""
    try:
        async with websockets.connect(f"ws://localhost:{port}", open_timeout=2, max_size=None) as ws:
            first = json.loads(await asyncio.wait_for(ws.recv(), 2))
            return first.get("type") == "ALGORITHMS_LIST"
    except Exception:
        return False


def _listener_pid(port):
    """(pid, command line) of the process listening on the port, on Linux (from /proc), else None."""
    inodes = set()
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(table) as f:
                next(f)
                for line in f:
                    parts = line.split()
                    local, state, inode = parts[1], parts[3], parts[9]
                    if state == "0A" and int(local.rsplit(":", 1)[1], 16) == port:  # 0A: LISTEN
                        inodes.add(inode)
        except (OSError, ValueError, IndexError, StopIteration):
            continue
    if not inodes:
        return None
    wanted = {f"socket:[{i}]" for i in inodes}
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            fds = os.listdir(f"/proc/{pid}/fd")
        except OSError:
            continue
        for fd in fds:
            try:
                if os.readlink(f"/proc/{pid}/fd/{fd}") in wanted:
                    with open(f"/proc/{pid}/cmdline", "rb") as f:
                        cmd = f.read().replace(b"\0", b" ").decode(errors="replace").strip()
                    return int(pid), cmd
            except OSError:
                continue
    return None


def _port_in_use_help(port, ours) -> str:
    if ours:
        who = (f"Port {port} is in use by another Loop Finder backend that is still running\n"
               "(an earlier `python server.py`, in another terminal or in the background).\n"
               "The UI can simply use that one. To restart it, stop it first:")
    else:
        who = f"Port {port} is in use by another program. Stop it, or use another port:"
    found = _listener_pid(port) if sys.platform.startswith("linux") else None
    if found:
        pid, cmd = found
        find = f"  It is process {pid}: {cmd}\n  kill {pid}"
    elif os.name == "nt":
        find = (f"  netstat -ano | findstr :{port}        (the last number is the PID)\n"
                "  taskkill /PID <PID> /F")
    else:
        find = (f"  ss -ltnp | grep {port}                (shows pid=<PID>; or: lsof -i :{port})\n"
                "  kill <PID>")
    if os.name == "nt":
        other = f"  set LOOP_PORT={port + 1} && python server.py"
    else:
        other = f"  LOOP_PORT={port + 1} python server.py"
    return (f"\n{who}\n{find}\n"
            f"Or run this one on another port:\n{other}\n"
            f"  and start the UI with the same port: LOOP_PORT={port + 1} npm run dev\n")


async def handle_get_tile_roads(websocket, data):
    """GET_TILE_ROADS {tiles: [[row, col], ...]} -> one TILE_ROADS {tile, lines} per tile
    (lines: [[class, lat, lng, lat, lng, ...], ...]; `missing: true` when not downloaded)."""
    loop = asyncio.get_running_loop()
    started, sent = time.time(), 0
    for raw in (data.get("tiles") or [])[:MAX_TILES_PER_REQUEST]:
        try:
            tile = (int(raw[0]), int(raw[1]))
        except (TypeError, ValueError, IndexError):
            continue
        lines = await loop.run_in_executor(None, tile_roads.lines, tile)
        payload = {"type": "TILE_ROADS", "tile": list(tile), "lines": lines or []}
        if lines is None:
            payload["missing"] = True
        await send(websocket, payload)
        sent += 1
    print(f"Tile roads: {sent} tiles sent in {time.time() - started:.1f}s")


async def handle_get_road_segments(websocket, data):
    """GET_ROAD_SEGMENTS {tiles} -> one ROAD_SEGMENTS {tile, lines, missing?} per tile:
    its rideable roads split at junctions ({u, v, name, pts}), for painting
    roads where no start is (the plan's Favorites tab)."""
    loop = asyncio.get_running_loop()
    tiles = data.get("tiles")
    for raw in (tiles if isinstance(tiles, list) else [])[:MAX_TILES_PER_REQUEST]:
        try:
            tile = (int(raw[0]), int(raw[1]))
        except (TypeError, ValueError, IndexError, KeyError):
            continue
        lines = await loop.run_in_executor(None, tile_roads.segments, tile)
        payload = {"type": "ROAD_SEGMENTS", "tile": list(tile), "lines": lines or []}
        if lines is None:
            payload["missing"] = True
        await send(websocket, payload)


def process_request(connection, request):
    """Plain HTTP on the WebSocket port: GET /healthz answers "ok" (uptime
    monitors, the deploy check). A visitor with too many open connections (or
    a full server) gets 429 before the WebSocket handshake; the UI retries."""
    if request.path.split("?", 1)[0] == "/healthz":
        return connection.respond(http.HTTPStatus.OK, "ok\n")
    origins = ALLOWED_ORIGINS
    origin = request.headers.get("Origin")
    if origins and origin is not None and origin not in origins:
        # Said here, not only refused by websockets: a mismatch (www., http vs https)
        # otherwise only shows as "Server Disconnected" in the browser.
        print(f"Refused a page from {origin[:100]}: not in LOOP_ALLOWED_ORIGINS "
              f"({', '.join(o for o in origins if o)})")
        return connection.respond(http.HTTPStatus.FORBIDDEN, "This site may not connect\n")
    ip = client_ip(connection)
    if CONNECTIONS.get(ip, 0) >= limits.MAX_CONN_PER_IP or sum(CONNECTIONS.values()) >= limits.MAX_CONNECTIONS:
        print(f"Refused a connection from {ip}: {CONNECTIONS.get(ip, 0)} open from there, "
              f"{sum(CONNECTIONS.values())} in all")
        return connection.respond(http.HTTPStatus.TOO_MANY_REQUESTS, "Too many connections\n")
    return None


def settings_summary() -> str:
    """The limits in effect, printed at start (so a mistyped setting shows)."""
    from areas import MAX_AREAS
    from map_store import CONTACT, CONTACT_PLACEHOLDER
    origins = allowed_origins()
    text = (f"Limits: {limits.MAX_CONN_PER_IP} connections per visitor, {limits.MAX_CONNECTIONS} in all; "
            f"{WORK.slots} search at a time; memory: {MAX_AREAS} areas, {MAX_SESSIONS} generations, "
            f"{store.cache_tiles} tiles, idle after {IDLE_S / 60:g} min; "
            f"sites allowed: {', '.join(o for o in origins if o) if origins else 'any'}; "
            f"map data contact: {CONTACT}")
    if origins and CONTACT == CONTACT_PLACEHOLDER:
        # LOOP_ALLOWED_ORIGINS is set: this is the public server.
        text += ("\nWARNING: LOOP_CONTACT is still the placeholder. Set it to your email or project URL "
                 "(the public Overpass servers ask for a way to reach heavy users).")
    return text


def allowed_origins():
    """LOOP_ALLOWED_ORIGINS (comma-separated, e.g. https://loops.example.com):
    only pages from these sites may connect (plus clients that send no Origin,
    like scripts and uptime monitors). Unset: any site (local development)."""
    raw = os.environ.get("LOOP_ALLOWED_ORIGINS") or ""
    origins = [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]
    return origins + [None] if origins else None


ALLOWED_ORIGINS = allowed_origins()


async def main():
    info = store.stats()
    print(f"Map data: {store.tile_dir} ({info['tiles']} tiles, {info['mb']} MB)")
    print(f"Starting WebSocket server on {HOST}:{PORT} (routes up to {MAX_ROUTE_MILES:g} mi)...")
    print(settings_summary())
    try:
        server = await websockets.serve(handler, HOST, PORT, max_size=limits.MAX_MESSAGE_BYTES,
                                        process_request=process_request, origins=ALLOWED_ORIGINS)
    except OSError as exc:
        if exc.errno not in ADDRESS_IN_USE:
            raise
        print(_port_in_use_help(PORT, await _backend_already_there(PORT)))
        return 1
    # Worker threads: searches, builds, downloads and the visitors waiting for a
    # turn all sit in one (the default pool is only CPUs + 4, too few to wait in).
    asyncio.get_running_loop().set_default_executor(ThreadPoolExecutor(max_workers=64))
    sweeper = asyncio.create_task(_sweeper())
    async with server:
        print(f"Ready: ws://{HOST}:{PORT}")
        try:
            await asyncio.Future()  # run forever
        finally:
            sweeper.cancel()


def _websockets_too_old():
    """A message when the installed websockets predates the asyncio server (14.0) this file uses."""
    try:
        major = int(websockets.__version__.split(".")[0])
    except (AttributeError, ValueError):
        return None
    if major >= 14:
        return None
    return (f"\nThis backend needs websockets 14 or newer; this Python has {websockets.__version__}\n"
            f"({sys.executable}). Update it in the environment you start the server with:\n"
            f"  pip install -U \"websockets>=14\"\n"
            f"or: pip install -r requirements.txt\n")


if __name__ == "__main__":
    too_old = _websockets_too_old()
    if too_old:
        print(too_old)
        sys.exit(1)
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        print("Stopped.")
