"""What a visitor's browser may ask for (the public site trusts no message).

Every number from a message goes through here: non-numbers, NaN and infinity
(Python's json accepts them) fall back to defaults, and values are clamped to
what the UI itself offers (Advanced settings), so a hand-made message cannot
ask for more work than the UI could. Lists (selections, a rebuild's route
centroids) are capped in length. The server-wide knobs (message size,
connections per IP, message rate) are environment variables, see RUNNING.md.
"""
import math
import os


def env_number(name, default, kind=int, lo=None):
    """A numeric setting from the environment. Unset or empty: the default. A
    value that is not a number (or below lo) is not silently ignored: it prints
    a warning naming the setting and uses the default. (In cmd,
    `set LOOP_X=2 python server.py` sets LOOP_X to "2 python server.py".)"""
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return kind(default)
    try:
        value = kind(float(raw.strip()))
    except ValueError:
        value = None
    if value is None or (lo is not None and value < lo):
        print(f"WARNING: setting {name}={raw!r} is not "
              + ("a number" if value is None else f"at least {lo}") + f"; using {default}.")
        return kind(default)
    return value


MAX_MESSAGE_BYTES = 4 * 1024 * 1024  # an excluded area over a whole dense map is ~1 MB of node pairs
MAX_CONN_PER_IP = env_number("LOOP_MAX_CONN_PER_IP", 8, lo=1)  # open tabs of one visitor
MAX_CONNECTIONS = env_number("LOOP_MAX_CONNECTIONS", 100, lo=1)  # everyone together
# Messages per connection: a burst of MSG_BURST, refilled at MSG_RATE per second.
# The UI sends a handful per action; a flood closes the connection.
MSG_RATE = env_number("LOOP_MSG_RATE", 20, float, lo=1)
MSG_BURST = env_number("LOOP_MSG_BURST", 200, float, lo=10)

MAX_PATHS = 200          # routes per request (Advanced: "Routes per search" up to 200)
MAX_SELECTIONS = 100     # painted roads + areas on one generation
MAX_EDGES_PER_SELECTION = 50_000
MAX_EDGES_TOTAL = 100_000
MAX_RING_POINTS = 5_000  # points of one freeform outline
MAX_CENTROIDS = 10_000   # routes a rebuilt generation remembers
MAX_ID_LEN = 64          # pathSetId, areaId, selection ids
MAX_ROAD_CLASSES = 50


def number(value, default, lo=None, hi=None):
    """A finite float from a message, clamped to [lo, hi]; default when missing or not a number."""
    try:
        num = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(num):
        return default
    if lo is not None:
        num = max(lo, num)
    if hi is not None:
        num = min(hi, num)
    return num


def count(value, default, hi, lo=1):
    return int(number(value, default, lo, hi))


def lat_lng(lat, lng):
    """(lat, lng) when both are real coordinates (web map latitudes), else None."""
    lat, lng = number(lat, None), number(lng, None)
    if lat is None or lng is None or abs(lat) > 85.0 or abs(lng) > 180.0:
        return None
    return lat, lng


def ident(value):
    """An id from the client (pathSetId, areaId): a short string, else None."""
    if isinstance(value, str) and 0 < len(value) <= MAX_ID_LEN:
        return value
    return None


def road_weights(raw):
    """The Advanced road table: class → turns per mile, at most MAX_ROAD_CLASSES
    short names, values clamped to 0..1000. None means the built-in table."""
    if not isinstance(raw, dict) or not raw:
        return None
    cleaned = {}
    for key, value in list(raw.items())[:MAX_ROAD_CLASSES]:
        num = number(value, None, 0.0, 1000.0)
        if num is not None and isinstance(key, str) and len(key) <= 40:
            cleaned[key] = num
    return cleaned or None


def _pair(p):
    """[a, b] of two numbers, else None (node pairs, ring points, centroids)."""
    if isinstance(p, (list, tuple)) and len(p) == 2:
        a, b = number(p[0], None), number(p[1], None)
        if a is not None and b is not None:
            return a, b
    return None


def selections(raw):
    """Client selections, capped: at most MAX_SELECTIONS, each a dict with a
    short id; node pairs and outline points that are not two numbers are
    dropped, and long lists are cut. Shapes are still checked where they are
    used (loop_tree.resolve_selections reports bad ones back to the user)."""
    if not isinstance(raw, list):
        return []
    out, edges_left = [], MAX_EDGES_TOTAL
    for sel in raw[:MAX_SELECTIONS]:
        if not isinstance(sel, dict):
            continue
        sel = dict(sel)
        sid = sel.get("id")
        if not isinstance(sid, (str, int)) or len(str(sid)) > MAX_ID_LEN:
            sel["id"] = None
        if sel.get("edges") is not None:
            pairs = sel["edges"] if isinstance(sel["edges"], list) else []
            cap = min(MAX_EDGES_PER_SELECTION, edges_left)
            sel["edges"] = [[int(a), int(b)] for a, b in filter(None, map(_pair, pairs[:cap]))]
            edges_left -= len(sel["edges"])
        if sel.get("coordinates") is not None:
            ring = sel["coordinates"] if isinstance(sel["coordinates"], list) else []
            sel["coordinates"] = [list(p) for p in filter(None, map(_pair, ring[:MAX_RING_POINTS]))]
        out.append(sel)
    return out


def centroids(raw):
    """A rebuild's route centroids: at most MAX_CENTROIDS [lng, lat] pairs."""
    if not isinstance(raw, list):
        return []
    return [c for c in map(_pair, raw[:MAX_CENTROIDS]) if c is not None]


class RateLimit:
    """Token bucket for one connection's messages."""

    def __init__(self, rate=None, burst=None, clock=None):
        import time
        self.rate = MSG_RATE if rate is None else rate
        self.burst = MSG_BURST if burst is None else burst
        self.clock = clock or time.monotonic
        self.tokens = self.burst
        self.last = self.clock()

    def allow(self) -> bool:
        now = self.clock()
        self.tokens = min(self.burst, self.tokens + (now - self.last) * self.rate)
        self.last = now
        if self.tokens < 1:
            return False
        self.tokens -= 1
        return True
