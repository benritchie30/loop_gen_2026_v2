"""Roads of the downloaded map tiles.

- For drawing the offline basemap (GET_TILE_ROADS): the browser asks for the
  tiles in view and draws their roads itself, so the map is readable without
  internet before any start is chosen, everywhere map data has been
  downloaded. Per tile: every way's line, simplified to about SIMPLIFY_M
  (Douglas-Peucker) and rounded to 5 decimals (about 1 m), tagged with a
  drawing class.
- For painting roads without a start (GET_ROAD_SEGMENTS, the plan's
  Favorites tab): the tile's rideable roads split at junctions,
  {u, v, name, pts: [[lat, lng], ...]} like an area's GRAPH_EDGES, but
  straight from the tile, without building a search graph.

Both are built once per tile and kept.
"""
import math
import threading
from collections import OrderedDict

from map_store import MapError

SIMPLIFY_M = 4.0
CACHED_TILES = 64

# Drawing classes: 0 major, 1 minor, 2 local streets, 3 paths.
ROAD_CLASS = {
    'trunk': 0, 'trunk_link': 0, 'primary': 0, 'primary_link': 0, 'secondary': 0, 'secondary_link': 0,
    'tertiary': 1, 'tertiary_link': 1, 'unclassified': 1, 'road': 1,
    'residential': 2, 'living_street': 2,
    'cycleway': 3, 'path': 3, 'bridleway': 3, 'pedestrian': 3, 'footway': 3, 'track': 3,
}


def _simplify(xy, tol):
    """Indices of the points Douglas-Peucker keeps (xy in metres)."""
    n = len(xy)
    if n < 3:
        return list(range(n))
    keep = {0, n - 1}
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = xy[a]
        bx, by = xy[b]
        dx, dy = bx - ax, by - ay
        den = dx * dx + dy * dy
        best, best_i = -1.0, -1
        for i in range(a + 1, b):
            px, py = xy[i]
            if den == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / den))
                d = math.hypot(px - ax - dx * t, py - ay - dy * t)
            if d > best:
                best, best_i = d, i
        if best > tol:
            keep.add(best_i)
            stack.append((a, best_i))
            stack.append((best_i, b))
    return sorted(keep)


def tile_lines(ways):
    """[[class, lat, lng, lat, lng, ...], ...] for a tile's ways ([id, nodes, flat lng/lat, tags])."""
    out = []
    for _way_id, _nodes, flat, tags in ways:
        if len(flat) < 4:
            continue
        k = math.cos(math.radians(flat[1])) * 111320.0
        xy = [(flat[i] * k, flat[i + 1] * 111320.0) for i in range(0, len(flat), 2)]
        line = [ROAD_CLASS.get((tags or {}).get('highway'), 2)]
        for i in _simplify(xy, SIMPLIFY_M):
            line.append(round(flat[2 * i + 1], 5))
            line.append(round(flat[2 * i], 5))
        out.append(line)
    return out


def tile_segments(ways):
    """A tile's rideable roads split where they meet another ([id, nodes, flat lng/lat, tags] in)."""
    from graph_builder import _coerce_name, rideable
    rows = [(nodes, flat, tags or {}) for _way_id, nodes, flat, tags in ways
            if len(nodes) >= 2 and len(flat) == 2 * len(nodes) and rideable(tags or {})]
    use = {}
    for nodes, _flat, _tags in rows:
        last = len(nodes) - 1
        for i, n in enumerate(nodes):
            use[n] = use.get(n, 0) + (2 if i in (0, last) else 1)
    out = []
    for nodes, flat, tags in rows:
        name = _coerce_name(tags.get('name')) or _coerce_name(tags.get('ref')) or ''
        if isinstance(name, list):
            name = name[0]
        start = 0
        for i in range(1, len(nodes)):
            if use[nodes[i]] > 1 or i == len(nodes) - 1:
                if nodes[start] != nodes[i]:
                    pts = [[round(flat[2 * j + 1], 5), round(flat[2 * j], 5)] for j in range(start, i + 1)]
                    out.append({'u': nodes[start], 'v': nodes[i], 'name': name, 'pts': pts})
                start = i
    return out


class TileRoads:
    """Per-tile drawing lines, built on first use and kept (LRU)."""

    def __init__(self, store, cached=CACHED_TILES):
        self.store = store
        self.cached = cached
        self._lines = OrderedDict()
        self._segments = OrderedDict()
        self._lock = threading.Lock()

    def _cached(self, cache, build, tile):
        tile = (int(tile[0]), int(tile[1]))
        with self._lock:
            got = cache.get(tile)
            if got is not None:
                cache.move_to_end(tile)
                return got
        if not self.store.has(tile):
            return None
        try:
            value = build(self.store.tile_ways(tile))
        except MapError:
            return None
        with self._lock:
            cache[tile] = value
            while len(cache) > self.cached:
                cache.popitem(last=False)
        return value

    def lines(self, tile):
        """The tile's drawing lines, or None when the tile is not downloaded."""
        return self._cached(self._lines, tile_lines, tile)

    def segments(self, tile):
        """The tile's rideable roads split at junctions, or None when it is not downloaded."""
        return self._cached(self._segments, tile_segments, tile)
