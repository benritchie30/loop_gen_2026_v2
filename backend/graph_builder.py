"""Build the search graph for one generation from raw OSM ways.

Input is the ways of the map tiles around the start (see map_store). Output is
the MultiDiGraph the search reads:

  node: x (lng), y (lat), elevation (m)
  edge (one per direction it may be ridden, key 0): length (m),
        geometry (LineString oriented u->v), highway, name, cycleway*,
        bicycle, lanes, maxspeed, osmid, parts, stress

Steps, all on plain Python structures (networkx only for the block analysis
and the final graph, which keeps it a few seconds for a city):

1. keep rideable ways (bike classes, bike-legal footways; no private roads
   unless bikes are allowed, no pedestrian areas)
2. keep nodes within max/2 (+ margin) of the start. No route of length
   `max` can reach farther, so nothing usable is lost. With a custom
   boundary (boundary.py), keep the nodes inside it instead
3. split ways at junctions
4. prune dead ends and tiny loops (same block-cut rule as the old pipeline:
   keep biconnected blocks of >= 3 nodes and >= 3 km, and what joins them).
   The start is the OSM node nearest the pin on the nearest road that leads
   to what is kept (also in the middle of a road or at the end of a dead
   end; a path that no rideable road joins is skipped). The road is cut
   there, and the shortest way from the start to what is kept stays too (a
   start at the end of a dead end rides it out and back as the stem)
5. merge chains through degree-2 nodes (never through the start). Direction is kept: a chain can be
   ridden one way only if every piece can. `parts` keeps each piece's
   length and tags so stress stays length-weighted at search time
6. parallel roads: the search keeps one edge per direction between two
   junctions, so when two roads join the same junctions the most pleasant
   keeps the direct link and the other is split at an OSM node in its
   middle (a quiet greenway beside a primary survives). Only a road with no
   node to split at is dropped
7. drop nodes no loop of length `max` can reach by road:
   from_start + to_start > max (+ slack)

Node ids are OSM node ids, so roads painted on one build stay valid on a
larger build around the same start.
"""
import heapq
import math
import time
from typing import Dict, Iterable, List, Optional, Tuple

import networkx as nx
from shapely.geometry import LineString

import boundary as boundary_mod
from road_stress import annotate_edge_stress, edge_stress

# Rideable classes (same list the old download used) plus bike-legal footways.
BIKE_HIGHWAYS = {
    'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
    'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street',
    'pedestrian', 'cycleway', 'path', 'bridleway', 'road',
}
BIKE_OK = {'yes', 'designated', 'permissive'}
KEEP_TAGS = ('highway', 'name', 'ref', 'cycleway', 'cycleway:left', 'cycleway:right',
             'cycleway:both', 'bicycle', 'lanes', 'maxspeed')
EDGE_TAGS = ('highway', 'name', 'cycleway', 'cycleway:left', 'cycleway:right',
             'cycleway:both', 'bicycle', 'lanes', 'maxspeed')

MIN_BLOCK_M = 3000.0   # biconnected blocks shorter than this are pruned unless they join others
MARGIN_M = 800.0       # beyond max/2: room for one-way detours near the edge of reach
TRIM_SLACK_M = 1000.0  # road-distance trim keeps from_start + to_start <= max + this
EARTH_R = 6371008.8


class BuildError(ValueError):
    """The area has no usable roads (message is shown to the user)."""


def haversine(lng1, lat1, lng2, lat2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


def rideable(tags) -> bool:
    hw = tags.get('highway')
    if hw == 'footway':
        return tags.get('bicycle') in BIKE_OK and tags.get('footway') != 'sidewalk'
    if hw not in BIKE_HIGHWAYS:
        return False
    if tags.get('area') == 'yes':
        return False
    if tags.get('access') in ('private', 'no') and tags.get('bicycle') not in BIKE_OK:
        return False
    return True


def direction(tags) -> int:
    """+1 one-way along the way, -1 one-way against it, 0 both (for a bicycle)."""
    if tags.get('oneway:bicycle') == 'no' or tags.get('cycleway') in (
            'opposite', 'opposite_lane', 'opposite_track'):
        return 0
    ow = tags.get('oneway')
    if ow in ('yes', 'true', '1'):
        return 1
    if ow == '-1':
        return -1
    if ow is None and tags.get('junction') in ('roundabout', 'circular'):
        return 1
    return 0


def _coerce_name(value):
    """OSM name / ref: 'A;B' becomes ['A', 'B'], blanks become None."""
    if value is None:
        return None
    parts = [p.strip() for p in str(value).split(';') if p.strip()]
    if not parts:
        return None
    return parts[0] if len(parts) == 1 else parts


def _edge_tags(tags) -> dict:
    out = {k: tags[k] for k in EDGE_TAGS if k in tags}
    name = _coerce_name(tags.get('name')) or _coerce_name(tags.get('ref'))
    if name is not None:
        out['name'] = name
    else:
        out.pop('name', None)
    return out


class Segment:
    """A piece of road between two junctions, stored in its allowed direction
    (dir 1: u->v only, 0: both ways). nodes / coords run u -> v; parts are
    (length, tags) pieces in the same order."""
    __slots__ = ('u', 'v', 'nodes', 'coords', 'length', 'dir', 'parts', 'tags', 'osmid')

    def __init__(self, nodes, coords, length, d, parts, tags, osmid):
        self.u, self.v = nodes[0], nodes[-1]
        self.nodes, self.coords, self.length = nodes, coords, length
        self.dir, self.parts, self.tags, self.osmid = d, parts, tags, osmid

    def reversed(self) -> 'Segment':
        return Segment(self.nodes[::-1], self.coords[::-1], self.length, self.dir,
                       self.parts[::-1], self.tags, self.osmid)


def _undirected(segments: List[Segment]) -> nx.Graph:
    """Junction graph of the segments, ignoring direction (shortest length per pair)."""
    U = nx.Graph()
    for s in segments:
        if s.u == s.v:
            continue
        d = U.get_edge_data(s.u, s.v)
        if d is None or s.length < d['length']:
            U.add_edge(s.u, s.v, length=s.length)
    return U


def _prune_nodes(U: nx.Graph, min_block_m: float) -> Optional[set]:
    """Nodes to keep: biconnected blocks of >= 3 nodes and >= min_block_m,
    plus every block and cut vertex on the way between two such blocks.
    None when there is no large block at all (keep everything)."""
    blocks = list(nx.biconnected_components(U))
    cut = set(nx.articulation_points(U))

    lengths = []
    for comp in blocks:
        total = 0.0
        for u in comp:
            for v, d in U[u].items():
                if v in comp and u < v:
                    total += d['length']
        lengths.append(total)
    large = [i for i, comp in enumerate(blocks) if len(comp) >= 3 and lengths[i] >= min_block_m]
    if not large:
        return None

    # Block-cut tree: block i <-> each cut vertex it contains.
    tree: Dict[object, List[object]] = {}
    for i, comp in enumerate(blocks):
        b = ('B', i)
        tree.setdefault(b, [])
        for n in comp:
            if n in cut:
                tree[b].append(('C', n))
                tree.setdefault(('C', n), []).append(b)

    large_set = {('B', i) for i in large}
    keep_tree = set()
    seen = set()
    for root in large_set:
        if root in seen:
            continue
        # Iterative DFS; a tree node is needed if its subtree holds a large block.
        parent = {root: None}
        order = []
        stack = [root]
        while stack:
            x = stack.pop()
            order.append(x)
            for y in tree[x]:
                if y not in parent:
                    parent[y] = x
                    stack.append(y)
        seen.update(order)
        needed = {}
        for x in reversed(order):
            need = x in large_set or needed.get(x, False)
            if need:
                keep_tree.add(x)
                p = parent[x]
                if p is not None:
                    needed[p] = True
            needed[x] = need

    keep = set()
    for kind, val in keep_tree:
        if kind == 'B':
            keep.update(blocks[val])
        else:
            keep.add(val)
    return keep


def _way_to(U: nx.Graph, src, targets: set) -> List[int]:
    """Nodes of the shortest road from src to the nearest node of `targets`
    (both ends included); [] when none can be reached."""
    dist = {src: 0.0}
    prev = {}
    heap = [(0.0, src)]
    while heap:
        d, n = heapq.heappop(heap)
        if d > dist.get(n, math.inf):
            continue
        if n in targets:
            path = [n]
            while path[-1] != src:
                path.append(prev[path[-1]])
            return path
        for m, data in U[n].items():
            nd = d + data['length']
            if nd < dist.get(m, math.inf):
                dist[m] = nd
                prev[m] = n
                heapq.heappush(heap, (nd, m))
    return []


def _merge_chains(segments: List[Segment], stops: Iterable[int] = ()) -> List[Segment]:
    """Join segments through nodes that have exactly two pieces of road to two
    different neighbours (never through a node in `stops`: the start). A
    chain that cannot be ridden in either direction (conflicting one-ways) is
    dropped."""
    inc: Dict[int, List[int]] = {}
    for i, s in enumerate(segments):
        inc.setdefault(s.u, []).append(i)
        inc.setdefault(s.v, []).append(i)
    stops = set(stops)

    def through(n):
        if n in stops:
            return False
        ids = inc.get(n, ())
        if len(ids) != 2:
            return False
        a, b = segments[ids[0]], segments[ids[1]]
        oa = a.v if a.u == n else a.u
        ob = b.v if b.u == n else b.u
        return oa != ob and oa != n and ob != n

    used = [False] * len(segments)
    out: List[Segment] = []

    def walk(start, first):
        """Chain from junction `start` along segment `first` to the next junction."""
        coords: List[tuple] = []
        nodes: List[int] = []
        parts = []
        fwd = back = True
        length = 0.0
        best = None
        node, idx = start, first
        while True:
            used[idx] = True
            s = segments[idx]
            along = s.u == node
            pts = s.coords if along else s.coords[::-1]
            ids = s.nodes if along else s.nodes[::-1]
            coords.extend(pts if not coords else pts[1:])
            nodes.extend(ids if not nodes else ids[1:])
            length += s.length
            parts.extend(s.parts if along else s.parts[::-1])
            if s.dir == 1:  # stored direction u->v only
                if along:
                    back = False
                else:
                    fwd = False
            if best is None or s.length > best.length:
                best = s
            node = s.v if along else s.u
            if not through(node) or node == start:
                break
            a, b = inc[node]
            idx = b if a == idx else a
            if used[idx]:
                break
        return node, nodes, coords, length, fwd, back, parts, best

    junctions = [n for n in inc if not through(n)]
    for n in junctions:
        for idx in list(inc[n]):
            if used[idx]:
                continue
            end, nodes, coords, length, fwd, back, parts, best = walk(n, idx)
            if (not fwd and not back) or end == n:
                continue  # conflicting one-ways, or a loop back to the same junction
            seg = Segment(nodes, coords, length, 0 if (fwd and back) else 1, parts, best.tags, best.osmid)
            out.append(seg if fwd else seg.reversed())
    # Anything left is a ring with no junction (no way in or out): dropped.
    return out


def _pleasant_cost(s: Segment) -> float:
    """Default search cost of riding a segment: busy-road stress plus the
    default detour charge (0.3 turns per mile), per the built-in road table."""
    stress = sum(edge_stress(tags) * length for length, tags in s.parts)
    return stress + s.length * 0.3 / 1609.0


def _split(s: Segment) -> Optional[Tuple[Segment, Segment]]:
    """Cut a segment at the OSM node nearest its middle (None if it has none)."""
    if len(s.nodes) < 3:
        return None
    dists = _along(s)
    cut = min(range(1, len(s.nodes) - 1), key=lambda i: abs(dists[i] - dists[-1] / 2))
    return _cut(s, cut, dists)


def _along(s: Segment) -> List[float]:
    """Distance along the segment's geometry at each of its nodes."""
    acc, dists = 0.0, [0.0]
    for a, b in zip(s.coords[:-1], s.coords[1:]):
        acc += haversine(a[0], a[1], b[0], b[1])
        dists.append(acc)
    return dists


def _cut(s: Segment, cut: int, dists: Optional[List[float]] = None) -> Tuple[Segment, Segment]:
    """The two segments either side of the segment's node number `cut` (0 < cut < last)."""
    dists = dists or _along(s)
    total, acc = s.length, dists[-1]
    scale = total / acc if acc > 0 else 1.0
    at = dists[cut] * scale
    first, second, run = [], [], 0.0
    for length, tags in s.parts:
        if run + length <= at + 1e-9:
            first.append((length, tags))
        elif run >= at - 1e-9:
            second.append((length, tags))
        else:
            first.append((at - run, tags))
            second.append((run + length - at, tags))
        run += length
    a = Segment(s.nodes[:cut + 1], s.coords[:cut + 1], at, s.dir, first or [(at, s.tags)], s.tags, s.osmid)
    b = Segment(s.nodes[cut:], s.coords[cut:], total - at, s.dir, second or [(total - at, s.tags)],
                s.tags, s.osmid)
    return a, b


def _one_per_direction(segments: List[Segment]) -> Dict[tuple, Segment]:
    """{(u, v): segment} with one segment per directed junction pair. Most
    pleasant first; a road that would repeat a taken (u, v) is split at a
    middle node so it stays its own path, else that direction is dropped."""
    best: Dict[tuple, Segment] = {}
    todo = sorted(segments, key=lambda s: (_pleasant_cost(s), s.osmid, s.u, s.v))
    for s in todo:
        keys = [(s.u, s.v)] if s.dir == 1 else [(s.u, s.v), (s.v, s.u)]
        if not any(k in best for k in keys):
            for k in keys:
                best[k] = s
            continue
        halves = _split(s)
        if halves is not None and not any(
                k in best for h in halves for k in ((h.u, h.v), (h.v, h.u))):
            for h in halves:
                for k in ([(h.u, h.v)] if h.dir == 1 else [(h.u, h.v), (h.v, h.u)]):
                    best[k] = h
            continue
        for k in keys:  # cannot split: keep whichever direction is still free
            best.setdefault(k, s)
    return best


def _snap_node(runs, lat: float, lng: float, usable: Optional[set] = None) -> Optional[int]:
    """The OSM node where a start at (lat, lng) joins the roads: on the road
    nearest the pin, the end of the nearest piece of it that is nearer the
    pin. Only runs with a node in `usable` count (None: every run). None
    when there are no roads."""
    k = math.cos(math.radians(lat))
    m_per_deg = 111320.0

    def xy(c):  # local metres around the pin
        return ((c[0] - lng) * k * m_per_deg, (c[1] - lat) * m_per_deg)

    best_d, best = math.inf, None
    for _w, nodes, coords, _t, _d in runs:
        if usable is not None and nodes[0] not in usable and nodes[-1] not in usable:
            continue
        prev = xy(coords[0])
        for i in range(1, len(coords)):
            cur = xy(coords[i])
            dx, dy = cur[0] - prev[0], cur[1] - prev[1]
            den = dx * dx + dy * dy
            t = 0.0 if den == 0 else max(0.0, min(1.0, -(prev[0] * dx + prev[1] * dy) / den))
            d = math.hypot(prev[0] + dx * t, prev[1] + dy * t)
            if d < best_d:
                best_d = d
                near_prev = math.hypot(*prev) <= math.hypot(*cur)
                best = nodes[i - 1] if near_prev else nodes[i]
            prev = cur
    return best


def _dijkstra(adj: Dict[int, List[Tuple[int, float]]], src: int) -> Dict[int, float]:
    dist = {src: 0.0}
    heap = [(0.0, src)]
    while heap:
        d, n = heapq.heappop(heap)
        if d > dist.get(n, math.inf):
            continue
        for m, w in adj.get(n, ()):
            nd = d + w
            if nd < dist.get(m, math.inf):
                dist[m] = nd
                heapq.heappush(heap, (nd, m))
    return dist


def _elevations(nodes: Dict[int, tuple]) -> Dict[int, float]:
    """SRTM elevation per node (0 when SRTM is off or paused after a failure; see route_features)."""
    from route_features import _get_srtm, _srtm_elevation
    data = _get_srtm()
    out = {}
    for n, (x, y) in nodes.items():
        e = _srtm_elevation(data, y, x) if data is not None else None
        out[n] = float(e) if e is not None else 0.0
    return out


def build_graph(
    ways: Iterable[tuple],
    lat: float,
    lng: float,
    max_m: float,
    margin_m: float = MARGIN_M,
    min_block_m: float = MIN_BLOCK_M,
    trim: bool = True,
    elevation: bool = True,
    boundary: Optional[dict] = None,
) -> Tuple[nx.MultiDiGraph, int, dict]:
    """Search graph for routes up to `max_m` (whole route) from (lat, lng).

    ways: (way_id, node_ids, coords [(lng, lat), ...], tags) tuples.
    boundary: a custom search boundary (boundary.py): only the roads inside
    it are kept (else those within reach of the start).
    Returns (G, start_node, stats). Raises BuildError when no roads remain.
    """
    t0 = time.perf_counter()
    timing = {}
    stats = {'ways_in': 0, 'ways_rideable': 0}
    radius = max_m / 2.0 + margin_m
    k = math.cos(math.radians(lat))
    # Quick reject in degrees before the exact test.
    r_lat = radius / 111320.0
    r_lng = radius / (111320.0 * max(k, 0.05))

    def inside(x, y):
        if abs(y - lat) > r_lat or abs(x - lng) > r_lng:
            return False
        return haversine(lng, lat, x, y) <= radius

    coord: Dict[int, tuple] = {}
    runs = []  # (way_id, node ids, coords, tags, dir)
    kept_ways = []
    for way_id, node_ids, coords, tags in ways:
        stats['ways_in'] += 1
        if len(node_ids) < 2 or not rideable(tags):
            continue
        stats['ways_rideable'] += 1
        kept_ways.append((way_id, node_ids, coords, tags))
    # Which points are in: inside the boundary (one vectorized test), else within reach.
    area = boundary_mod.geometry(boundary) if boundary else None
    if area is not None:
        flags = boundary_mod.contains(area, (c[0] for w in kept_ways for c in w[2]),
                                      (c[1] for w in kept_ways for c in w[2]))
        stats['boundary'] = boundary_mod.key(boundary)
    else:
        flags = [inside(c[0], c[1]) for w in kept_ways for c in w[2]]
    base = 0
    for way_id, node_ids, coords, tags in kept_ways:
        d = direction(tags)
        run_n, run_c = [], []
        first, base = base, base + len(coords)
        for i, (n, c) in enumerate(zip(node_ids, coords)):
            if flags[first + i]:
                run_n.append(n)
                run_c.append(c)
                continue
            if len(run_n) >= 2:
                runs.append((way_id, run_n, run_c, tags, d))
            run_n, run_c = [], []
        if len(run_n) >= 2:
            runs.append((way_id, run_n, run_c, tags, d))
    timing['clip'] = time.perf_counter() - t0

    t = time.perf_counter()
    use: Dict[int, int] = {}
    for _w, nodes, coords, _t, _d in runs:
        for n, c in zip(nodes, coords):
            use[n] = use.get(n, 0) + 1
            coord[n] = c
        use[nodes[0]] += 1
        use[nodes[-1]] += 1

    tag_cache: Dict[int, dict] = {}
    segments: List[Segment] = []
    for way_id, nodes, coords, tags, d in runs:
        etags = tag_cache.get(way_id)
        if etags is None:
            etags = tag_cache[way_id] = _edge_tags(tags)
        start, length = 0, 0.0
        for i in range(1, len(nodes)):
            a, b = coords[i - 1], coords[i]
            length += haversine(a[0], a[1], b[0], b[1])
            if use[nodes[i]] > 1 or i == len(nodes) - 1:
                u, v = nodes[start], nodes[i]
                if u != v and length > 0:
                    seg = Segment(nodes[start:i + 1], coords[start:i + 1], length, 1 if d else 0,
                                  [(length, etags)], etags, way_id)
                    segments.append(seg.reversed() if d == -1 else seg)
                start, length = i, 0.0
    stats['split_segments'] = len(segments)
    timing['split'] = time.perf_counter() - t
    if not segments:
        raise BuildError('No rideable roads inside this boundary.' if area is not None
                         else 'No rideable roads near this start.')

    t = time.perf_counter()
    U = _undirected(segments)
    keep = _prune_nodes(U, min_block_m)
    # The start: where the pin joins a road that leads to what is kept
    # (loops are possible there). The road is cut at it, and the shortest way
    # from it to what is kept stays.
    if keep is None:
        usable = None
    else:
        usable = set()
        for comp in nx.connected_components(U):
            if not keep.isdisjoint(comp):
                usable |= comp
    snap = _snap_node(runs, lat, lng, usable)
    if snap is not None:
        for i, seg in enumerate(segments):
            if snap in seg.nodes[1:-1]:
                a, b = _cut(seg, seg.nodes.index(snap, 1))
                segments[i:i + 1] = [a, b]
                U.add_edge(a.u, a.v, length=a.length)
                U.add_edge(b.u, b.v, length=b.length)
                break
        if keep is not None and snap not in keep:
            keep.update(_way_to(U, snap, keep))
    if keep is not None:
        segments = [s for s in segments if s.u in keep and s.v in keep]
    timing['prune'] = time.perf_counter() - t

    t = time.perf_counter()
    segments = _merge_chains(segments, stops=() if snap is None else (snap,))
    best = _one_per_direction(segments)
    timing['merge'] = time.perf_counter() - t
    if not best:
        raise BuildError('No loops are possible from here: the nearby roads are all dead ends.')

    # Start: where the pin joins the roads, if a loop can leave and come back
    # there (not at the end of a one-way road); else the node nearest the pin
    # of the roads every one of which can be reached from the others and back.
    t = time.perf_counter()
    D = nx.DiGraph()
    D.add_edges_from(best)
    rideable_both_ways = max(nx.strongly_connected_components(D), key=len)
    if snap in rideable_both_ways:
        start = snap
    else:
        start = min(rideable_both_ways,
                    key=lambda n: (coord[n][1] - lat) ** 2 + ((coord[n][0] - lng) * k) ** 2)
    stats['start_snapped'] = start == snap

    if trim:
        fwd: Dict[int, List[Tuple[int, float]]] = {}
        rev: Dict[int, List[Tuple[int, float]]] = {}
        for (a, b), s in best.items():
            fwd.setdefault(a, []).append((b, s.length))
            rev.setdefault(b, []).append((a, s.length))
        d_from = _dijkstra(fwd, start)
        d_to = _dijkstra(rev, start)
        limit = max_m + TRIM_SLACK_M
        reach = {n for n, d in d_from.items() if d + d_to.get(n, math.inf) <= limit}
        best = {key: s for key, s in best.items() if key[0] in reach and key[1] in reach}
    timing['trim'] = time.perf_counter() - t
    if not best:
        raise BuildError('No loops are possible from here within this distance.')

    t = time.perf_counter()
    G = nx.MultiDiGraph()
    nodes_used = sorted({n for key in best for n in key})  # sorted: same graph every build
    elev = _elevations({n: coord[n] for n in nodes_used}) if elevation else {}
    for n in nodes_used:
        x, y = coord[n]
        G.add_node(n, x=x, y=y, elevation=elev.get(n, 0.0))
    lines: Dict[int, LineString] = {}
    for (a, b), s in sorted(best.items(), key=lambda item: item[0]):
        line = lines.get(id(s))
        if line is None:
            line = lines[id(s)] = LineString(s.coords)
        geom = line if a == s.u else LineString(s.coords[::-1])
        G.add_edge(a, b, length=s.length, geometry=geom, osmid=s.osmid, parts=s.parts, **s.tags)
    annotate_edge_stress(G)
    timing['graph'] = time.perf_counter() - t

    stats.update(nodes=G.number_of_nodes(), edges=G.number_of_edges())
    stats['seconds'] = round(time.perf_counter() - t0, 2)
    stats['timing'] = {k2: round(v, 2) for k2, v in timing.items()}
    G.graph['built'] = {'lat': lat, 'lng': lng, 'max_m': max_m, 'start': start,
                        'boundary': stats.get('boundary')}
    return G, start, stats
