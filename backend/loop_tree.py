"""Area-sweep loop search built from best-route trees.

One Dijkstra grows the cheapest route from the start to every directed edge
(an outbound tree). A second grows the cheapest route from every directed edge
back to the start (a return tree). Cost is pleasant cost (turns + discomfort)
plus `detour_weight` turns per mile, so branches stay fairly direct.

Any junction v joins an outbound route arriving at v with a return route
leaving v. That pair is a candidate loop whose far point is v, and its length
is just the two route lengths. Every road in reach is the far point of some
candidate, so no area is starved the way it is in a best-first path search.

Candidates stream by score = (turns + discomfort) per mile ×
(1 + `explore_weight` × (1 − novelty)), where novelty is how much of the loop
sits in ~400 m cells that earlier routes have not covered. The bonus scales
cost rather than adding to it, so a much busier loop cannot win on newness.
After every `round_every` routes the trees are regrown with `reuse_weight`
turns per mile added on roads already used by a loop, which yields
alternatives in the same areas. A candidate scoring worse than
`defer_ratio` × the best route sent so
far waits for a fresh round first, so sparse graphs do not drain into busy
loops before the trees have been regrown.

Turns here use the road direction within ~25 m of each junction rather than
the straight line between merged nodes, so curvy merged edges do not count
false turns.
"""
import heapq
import math
import random
import time
import weakref
from typing import Any, Callable, Dict, Generator, List, Optional

import networkx as nx

from road_stress import CROSSING_CAP, CROSSING_MAX_M, MILE_M, annotate_edge_stress

TURN_DEG = 30.0
TANGENT_M = 25.0
CELL_M = 400.0
CELL_STEP_M = 100.0
HUG_M = 150.0
REPAIR_FACTOR = 3.0
REPAIR_M = 150.0
PAIRS_PER_NODE = 2
M_PER_DEG = 111139.0

ANCHORS_PER_ROUND = 4
ANCHOR_SECTORS = (0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15)  # of 16, spread first
ANCHOR_BANDS = ((0.25, 0.35), (0.35, 0.45), (0.15, 0.25))  # route distance / max length
LEG_AVOID = 4.0  # turns per mile on the outbound route while growing a cross leg
TRI_PER_ANCHOR = 300
TRI_MIN_SPREAD = 25.0
COVER_MIN_NEW = 3
COVER_TIERS = (0.25, 0.1)  # share of a loop's cells that must be new, per area pass
COVER_QPM_CAP = 3.0  # area pass holds back loops worse than this × the best sent
DRY_ROUNDS = 3
MAX_ROUNDS_ALL = 60
INF = float('inf')

# Guided continuation (tree_guided): routes through user pins / areas.
SNAP_MAX_M = 150.0  # a pin farther than this from any road is rejected
SAMPLE_M = 50.0  # edge geometry sampling for "touches this area", same as the client
GUIDE_AREA_ANCHORS = 6  # anchor edges (legs) per round from one pin / area
GUIDE_ORDERS_PER_ROUND = 3  # multi-pin visiting orders tried per round
GUIDE_MAX_ROUNDS = 10  # rounds per continuation request
GUIDE_DRY_ROUNDS = 2  # rounds in a row sending nothing before a request is done
GUIDE_FULL_ORDERS = 3  # try every visiting order up to this many constraints
GUIDE_DETOURS = (1.0, 2.0, 4.0, 8.0)  # turns per mile on guided legs; escalates on a dry round
GUIDE_PENALTY_CAP = 3.0  # turns per mile; routes through one pin pile reuse penalty on few roads
GUIDE_DEFER_RATIO = 3.0  # guided routes spread wider in quality, so defer less eagerly
GUIDE_PER_ANCHOR = 1000  # pairs kept per guided leg; most lose to the doubled stem in shaping



def idle(note=None) -> dict:
    """Item a guided generator yields when a request is finished."""
    return {'idle': True, 'note': note}


def is_idle(item) -> bool:
    return isinstance(item, dict) and item.get('idle') is True

_TABLES: 'weakref.WeakKeyDictionary' = weakref.WeakKeyDictionary()


def _delta(b1, b2):
    d = abs(b1 - b2) % 360.0
    return d if d <= 180.0 else 360.0 - d


def _flat_bearing(p, q, k):
    dx = (q[0] - p[0]) * k
    dy = q[1] - p[1]
    return (math.degrees(math.atan2(dx, dy)) + 360.0) % 360.0


def _point_along(coords, k, target_m):
    """Vertex roughly target_m along coords (or the far end)."""
    acc = 0.0
    prev = coords[0]
    for pt in coords[1:]:
        acc += math.hypot((pt[0] - prev[0]) * k, pt[1] - prev[1]) * M_PER_DEG
        prev = pt
        if acc >= target_m:
            break
    return prev


def _edge_cells(coords, k):
    """Cells touched by a polyline, sampled every CELL_STEP_M."""
    cells = set()

    def add(pt):
        cells.add((int(pt[1] * M_PER_DEG // CELL_M), int(pt[0] * k * M_PER_DEG // CELL_M)))

    add(coords[0])
    for a, b in zip(coords[:-1], coords[1:]):
        seg = math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * M_PER_DEG
        steps = int(seg // CELL_STEP_M)
        for i in range(1, steps + 1):
            f = i / (steps + 1)
            add((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
        add(b)
    return tuple(cells)


class EdgeTable:
    """Flat arrays over the first parallel edge of each (u, v).

    Geometry-derived fields are built once per graph. Stress is reread by
    refresh_stress() because each request can change road weights.
    """

    def __init__(self, G: nx.MultiDiGraph):
        from route_features import _oriented_edge_geom

        ys = [d['y'] for _, d in G.nodes(data=True)]
        k = math.cos(math.radians(sorted(ys)[len(ys) // 2])) if ys else 1.0

        self.tail: List[int] = []
        self.head: List[int] = []
        self.length: List[float] = []
        self.b_out: List[float] = []
        self.b_in: List[float] = []
        self.uid: List[int] = []
        self.data: List[dict] = []
        self.out: Dict[int, List[int]] = {n: [] for n in G.nodes()}
        self.inc: Dict[int, List[int]] = {n: [] for n in G.nodes()}
        self.cells: List[tuple] = []
        self.geom: List[list] = []  # coords (x, y) per uid, first edge's direction
        self.by_uid: List[List[int]] = []  # directed edges per uid
        uids: Dict[tuple, int] = {}

        for u, v in G.edges():
            if u == v or (self.out[u] and any(self.head[e] == v for e in self.out[u])):
                continue
            data = G[u][v][0]
            coords = list(_oriented_edge_geom(G, u, v).coords)
            ku = math.cos(math.radians(coords[0][1]))
            p_out = _point_along(coords, ku, TANGENT_M)
            p_in = _point_along(coords[::-1], ku, TANGENT_M)
            if p_out == coords[0] or p_in == coords[-1]:
                chord = _flat_bearing(coords[0], coords[-1], ku)
                b_out = b_in = chord
            else:
                b_out = _flat_bearing(coords[0], p_out, ku)
                b_in = _flat_bearing(p_in, coords[-1], ku)

            key = (u, v) if u < v else (v, u)
            uid = uids.get(key)
            if uid is None:
                uid = len(uids)
                uids[key] = uid
                self.cells.append(_edge_cells(coords, k))
                self.geom.append(coords)
                self.by_uid.append([])

            e = len(self.tail)
            self.tail.append(u)
            self.head.append(v)
            self.length.append(float(data.get('length') or 0.0))
            self.b_out.append(b_out)
            self.b_in.append(b_in)
            self.uid.append(uid)
            self.data.append(data)
            self.out[u].append(e)
            self.inc[v].append(e)
            self.by_uid[uid].append(e)

        self.n = len(self.tail)
        self.n_uid = len(uids)
        self.pair_uid: Dict[tuple, int] = {(self.tail[e], self.head[e]): self.uid[e] for e in range(self.n)}
        by_pair = {(self.tail[e], self.head[e]): e for e in range(self.n)}
        self.rev: List[int] = [by_pair.get((self.head[e], self.tail[e]), -1) for e in range(self.n)]
        self._k = k
        self._xy = {n: (d['x'], d['y']) for n, d in G.nodes(data=True)}
        self.stress: List[float] = [0.0] * self.n
        self._detours: Dict[int, tuple] = {}
        self._cell_uids: Optional[Dict[tuple, List[int]]] = None
        self._samples: Dict[int, list] = {}

    def node_cell(self, n, size_m):
        x, y = self._xy[n]
        return (int(y * M_PER_DEG // size_m), int(x * self._k * M_PER_DEG // size_m))

    def bearing_from(self, a, b):
        (x0, y0), (x1, y1) = self._xy[a], self._xy[b]
        return (math.degrees(math.atan2((x1 - x0) * self._k, y1 - y0)) + 360.0) % 360.0

    def refresh_stress(self):
        self.stress = [float(d.get('stress') or 0.0) for d in self.data]

    def uid_of(self, u, v):
        """Undirected edge id of the road between nodes u and v, or None."""
        got = self.pair_uid.get((u, v))
        return got if got is not None else self.pair_uid.get((v, u))

    def road_name(self, uid) -> str:
        """Street name of an undirected edge ('' when unnamed). Merged
        edges carry lists; those join with ' / '."""
        name = self.data[self.by_uid[uid][0]].get('name')
        if name is None:
            return ''
        if isinstance(name, (list, tuple)):
            parts = []
            for part in name:
                if isinstance(part, (list, tuple)):
                    parts.extend(str(p) for p in part)
                else:
                    parts.append(str(part))
            return ' / '.join(dict.fromkeys(parts))
        return str(name)

    def cell_uids(self) -> Dict[tuple, List[int]]:
        """Undirected edges per CELL_M cell, built on first use."""
        if self._cell_uids is None:
            index: Dict[tuple, List[int]] = {}
            for uid, cells in enumerate(self.cells):
                for c in cells:
                    index.setdefault(c, []).append(uid)
            self._cell_uids = index
        return self._cell_uids

    def samples(self, uid) -> list:
        """(lat, lng) every SAMPLE_M along the edge, both ends included."""
        got = self._samples.get(uid)
        if got is not None:
            return got
        coords = self.geom[uid]
        k = self._k
        out = [(coords[0][1], coords[0][0])]
        carry = 0.0
        for a, b in zip(coords[:-1], coords[1:]):
            seg = math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * M_PER_DEG
            if seg <= 0:
                continue
            pos = SAMPLE_M - carry
            while pos < seg:
                f = pos / seg
                out.append((a[1] + (b[1] - a[1]) * f, a[0] + (b[0] - a[0]) * f))
                pos += SAMPLE_M
            carry = seg - (pos - SAMPLE_M)
        out.append((coords[-1][1], coords[-1][0]))
        self._samples[uid] = out
        return out

    def nearest_edge(self, lat, lng, max_m=SNAP_MAX_M):
        """(uid, lat, lng, dist_m) of the closest road within max_m, else None.

        Only edges with a cell sample in the 3×3 cells around the point are
        checked, so max_m must stay under CELL_M.
        """
        k = self._k
        cy, cx = int(lat * M_PER_DEG // CELL_M), int(lng * k * M_PER_DEG // CELL_M)
        index = self.cell_uids()
        seen = set()
        best = (max_m, None, None, None)
        px, py = lng * k, lat
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for uid in index.get((cy + dy, cx + dx), ()):
                    if uid in seen:
                        continue
                    seen.add(uid)
                    coords = self.geom[uid]
                    for a, b in zip(coords[:-1], coords[1:]):
                        ax, ay, bx, by = a[0] * k, a[1], b[0] * k, b[1]
                        vx, vy = bx - ax, by - ay
                        den = vx * vx + vy * vy
                        t = 0.0 if den == 0 else max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / den))
                        qx, qy = ax + vx * t, ay + vy * t
                        d = math.hypot(px - qx, py - qy) * M_PER_DEG
                        if d < best[0]:
                            best = (d, uid, qy, qx / k)
        if best[1] is None:
            return None
        d, uid, qlat, qlng = best
        return uid, qlat, qlng, d

    def edges_in(self, selection) -> set:
        """Undirected edges with a SAMPLE_M point inside a circle, box, or
        freeform selection (client selection dict, lat/lng)."""
        lo_lat, hi_lat, lo_lng, hi_lng = _selection_bbox(selection)
        if lo_lat is None:
            return set()
        k = self._k
        index = self.cell_uids()
        y0, y1 = int(lo_lat * M_PER_DEG // CELL_M) - 1, int(hi_lat * M_PER_DEG // CELL_M) + 1
        x0, x1 = int(lo_lng * k * M_PER_DEG // CELL_M) - 1, int(hi_lng * k * M_PER_DEG // CELL_M) + 1
        if (y1 - y0 + 1) * (x1 - x0 + 1) > 4 * len(self.cells) + 64:
            candidates = range(len(self.cells))
        else:
            candidates = set()
            for cy in range(y0, y1 + 1):
                for cx in range(x0, x1 + 1):
                    candidates.update(index.get((cy, cx), ()))
        hit = set()
        for uid in candidates:
            for lat, lng in self.samples(uid):
                if _selection_contains(selection, lat, lng):
                    hit.add(uid)
                    break
        return hit

    def reverse_of(self, x) -> tuple:
        """Edges from head[x] back to tail[x]: the reverse edge, else the
        shortest way round within REPAIR_FACTOR × length + REPAIR_M (split
        intersections, short one-way pairs). () if there is none."""
        r = self.rev[x]
        if r >= 0:
            return (r,)
        got = self._detours.get(x)
        if got is None:
            got = self._short_way(self.head[x], self.tail[x],
                                  REPAIR_FACTOR * self.length[x] + REPAIR_M)
            self._detours[x] = got
        return got

    def _short_way(self, a, b, limit) -> tuple:
        best = {a: 0.0}
        par: Dict[int, int] = {}
        heap = [(0.0, a)]
        while heap:
            d, n = heapq.heappop(heap)
            if n == b:
                out = []
                while n != a:
                    e = par[n]
                    out.append(e)
                    n = self.tail[e]
                return tuple(reversed(out))
            if d > best.get(n, INF):
                continue
            for e in self.out[n]:
                m = self.head[e]
                nd = d + self.length[e]
                if nd <= limit and nd < best.get(m, INF):
                    best[m] = nd
                    par[m] = e
                    heapq.heappush(heap, (nd, m))
        return ()


def _point_in_ring(lat, lng, ring) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        lat_i, lng_i = ring[i][0], ring[i][1]
        lat_j, lng_j = ring[j][0], ring[j][1]
        if (lat_i > lat) != (lat_j > lat):
            x = (lng_j - lng_i) * (lat - lat_i) / (lat_j - lat_i) + lng_i
            if lng < x:
                inside = not inside
        j = i
    return inside


def _meters_between(lat1, lng1, lat2, lng2) -> float:
    k = math.cos(math.radians((lat1 + lat2) * 0.5))
    return math.hypot((lat2 - lat1), (lng2 - lng1) * k) * M_PER_DEG


def _selection_contains(sel, lat, lng) -> bool:
    """Same test as the client's selectionContains."""
    shape = sel.get('shape')
    if shape in ('point', 'circle'):
        return _meters_between(lat, lng, sel['lat'], sel['lng']) <= float(sel.get('radiusM') or 0.0)
    if shape == 'box':
        return sel['south'] <= lat <= sel['north'] and sel['west'] <= lng <= sel['east']
    if shape == 'freeform':
        ring = sel.get('coordinates') or []
        return len(ring) >= 3 and _point_in_ring(lat, lng, ring)
    return False


def _selection_bbox(sel):
    shape = sel.get('shape')
    try:
        if shape in ('point', 'circle'):
            r = float(sel.get('radiusM') or 0.0)
            lat, lng = float(sel['lat']), float(sel['lng'])
            d_lat = r / M_PER_DEG
            d_lng = r / (M_PER_DEG * max(0.05, math.cos(math.radians(lat))))
            return lat - d_lat, lat + d_lat, lng - d_lng, lng + d_lng
        if shape == 'box':
            return float(sel['south']), float(sel['north']), float(sel['west']), float(sel['east'])
        if shape == 'freeform':
            ring = sel.get('coordinates') or []
            if len(ring) >= 3:
                lats = [float(p[0]) for p in ring]
                lngs = [float(p[1]) for p in ring]
                return min(lats), max(lats), min(lngs), max(lngs)
    except (KeyError, TypeError, ValueError):
        pass
    return None, None, None, None


def resolve_selections(G, selections) -> dict:
    """Turn client selections into edge sets for a guided request.

    Returns {'require': [uid sets for include selections that hit a road],
             'via': [their ids], 'forbidden': uid set of every exclude
             selection, 'results': per selection {id, ok, lat, lng, edges,
             error}}. A pin snaps to the nearest road within SNAP_MAX_M and
             its result carries the snapped position.
    """
    E = edge_table(G)
    require, via, results = [], [], []
    forbidden = set()
    for sel in selections or []:
        sid = sel.get('id')
        exclude = sel.get('type') == 'exclude'
        result = {'id': sid, 'ok': False, 'edges': 0}
        uids = set()
        try:
            if sel.get('shape') == 'edges':
                # Roads picked on the map by node pair; a road group is one set.
                for pair in sel.get('edges') or []:
                    uid = E.uid_of(int(pair[0]), int(pair[1]))
                    if uid is not None:
                        uids.add(uid)
                if not uids:
                    result['error'] = 'Those roads are not in this graph'
            elif sel.get('shape') == 'point':
                hit = E.nearest_edge(float(sel['lat']), float(sel['lng']))
                if hit is None:
                    result['error'] = f'No road within {int(SNAP_MAX_M)} m'
                else:
                    uid, lat, lng, _d = hit
                    uids = {uid}
                    result['lat'], result['lng'] = round(lat, 7), round(lng, 7)
            else:
                uids = E.edges_in(sel)
                if not uids:
                    result['error'] = 'No road in this area'
        except (KeyError, TypeError, ValueError) as exc:
            result['error'] = f'Bad selection: {exc}'
        if uids:
            result['ok'] = True
            result['edges'] = len(uids)
            if exclude:
                forbidden |= uids
            else:
                require.append(frozenset(uids))
                via.append(sid)
        results.append(result)
    # An excluded road inside an include area: the area still has to be
    # crossed, on one of its other roads. Aiming at a road no route may use
    # would only waste search rounds.
    if forbidden and require:
        by_id = {r['id']: r for r in results}
        kept_require, kept_via = [], []
        for uids, sid in zip(require, via):
            rest = uids - forbidden
            if rest:
                kept_require.append(frozenset(rest))
                kept_via.append(sid)
            elif sid in by_id:
                by_id[sid].update(ok=False, error='Every road here is avoided')
        require, via = kept_require, kept_via
    return {'require': require, 'via': via, 'forbidden': forbidden, 'results': results}


def edge_table(G) -> EdgeTable:
    table = _TABLES.get(G)
    if table is None or table.n == 0:
        table = EdgeTable(G)
        _TABLES[G] = table
    return table


def _node_dist(E: EdgeTable, start, forward: bool) -> Dict[int, float]:
    """Shortest length from start (forward) or to start (backward) per node.
    `start` may be an iterable of nodes (multi-source)."""
    starts = [start] if isinstance(start, int) else list(start)
    dist = {n: 0.0 for n in starts}
    heap = [(0.0, n) for n in starts]
    heapq.heapify(heap)
    while heap:
        d, n = heapq.heappop(heap)
        if d > dist.get(n, INF):
            continue
        for e in (E.out[n] if forward else E.inc[n]):
            m = E.head[e] if forward else E.tail[e]
            nd = d + E.length[e]
            if nd < dist.get(m, INF):
                dist[m] = nd
                heapq.heappush(heap, (nd, m))
    return dist


class Tree:
    """Settled states of one grow_tree run.

    route_hash identifies a state's whole route, so a later round can tell
    when it rebuilt the same route and skip pairs it already judged.
    """
    __slots__ = ('forward', 'cost', 'dist', 'qual', 'par', 'done', 'route_hash', '_chains')

    def __init__(self, forward, cost, dist, qual, par, done, route_hash):
        self.forward = forward
        self.cost = cost
        self.dist = dist
        self.qual = qual
        self.par = par
        self.done = done
        self.route_hash = route_hash
        self._chains: Dict[int, List[int]] = {}

    def chain(self, e) -> List[int]:
        """Edges in travel order: start→e (forward) or e→start (backward)."""
        cached = self._chains.get(e)
        if cached is not None:
            return cached
        out = []
        par = self.par
        x = e
        while x >= 0:
            out.append(x)
            x = par[x]
        if self.forward:
            out.reverse()
        self._chains[e] = out
        return out


def grow_tree(
    E: EdgeTable,
    start: int,
    forward: bool,
    max_len: float,
    bound: Dict[int, float],
    detour_per_m: float,
    penalty: List[float],
    should_stop: Optional[Callable[[], bool]] = None,
    seeds: Optional[List[tuple]] = None,
    forbidden: Optional[set] = None,
    blocked_nodes: Optional[set] = None,
) -> Tree:
    """Edge-state Dijkstra on turns + discomfort + detour + reuse penalty.

    A state is a directed edge. Forward: best route start→…→edge. Backward:
    best route edge→…→start. `bound` is the plain shortest distance the other
    half needs, so states that cannot close within max_len are skipped.
    Short busy crossings follow the pleasant rule against the tree parent.
    `seeds` replaces the start edges with (edge, cost, dist, qual) states, so
    a forward tree can continue a route that already reached `start`.
    `forbidden` undirected edges (uids) and `blocked_nodes` are never entered.
    """
    n = E.n
    cost = [INF] * n
    dist = [0.0] * n
    qual = [0.0] * n
    par = [-1] * n
    done = bytearray(n)
    route_hash = [0] * n
    length, stress, b_in, b_out = E.length, E.stress, E.b_in, E.b_out
    tail, head, uid = E.tail, E.head, E.uid

    heap = []
    if seeds is None:
        seeds = []
        for e in (E.out[start] if forward else E.inc[start]):
            L = length[e]
            d = stress[e] * L
            seeds.append((e, d + (detour_per_m + penalty[uid[e]]) * L, L, d))
    for e, c, L, d in seeds:
        far = head[e] if forward else tail[e]
        if L + bound.get(far, INF) > max_len:
            continue
        if forbidden and uid[e] in forbidden:
            continue
        if blocked_nodes and far in blocked_nodes:
            continue
        if c < cost[e]:
            cost[e], dist[e], qual[e] = c, L, d
            heapq.heappush(heap, (c, e))

    pops = 0
    while heap:
        c, e = heapq.heappop(heap)
        if done[e]:
            continue
        done[e] = 1
        p = par[e]
        route_hash[e] = ((route_hash[p] if p >= 0 else 0) * 1000003 + e + 1) & 0xFFFFFFFFFFFFFFFF
        pops += 1
        if should_stop is not None and pops % 4096 == 0 and should_stop():
            break

        L_e = length[e]
        s_e = stress[e]
        if forward:
            node, back_node, nexts = head[e], tail[e], E.out[head[e]]
        else:
            node, back_node, nexts = tail[e], head[e], E.inc[tail[e]]
        for e2 in nexts:
            if done[e2]:
                continue
            if forbidden and uid[e2] in forbidden:
                continue
            if forward:
                w = head[e2]
                delta = _delta(b_in[e], b_out[e2])
            else:
                w = tail[e2]
                delta = _delta(b_in[e2], b_out[e])
            if w == back_node or (blocked_nodes and w in blocked_nodes):
                continue
            L2 = length[e2]
            nd = dist[e] + L2
            if nd + bound.get(w, INF) > max_len:
                continue
            s2 = stress[e2]
            dq = s2 * L2
            if delta >= TURN_DEG:
                crossing = False
                if p >= 0 and L_e <= CROSSING_MAX_M and s_e > s2 and s_e > stress[p]:
                    other = _delta(b_in[p], b_out[e]) if forward else _delta(b_in[e], b_out[p])
                    crossing = other >= TURN_DEG
                if crossing:
                    full = s_e * L_e
                    dq -= full - min(full, CROSSING_CAP)
                else:
                    dq += 1.0
            nc = c + dq + (detour_per_m + penalty[uid[e2]]) * L2
            if nc < cost[e2]:
                cost[e2] = nc
                dist[e2] = nd
                qual[e2] = qual[e] + dq
                par[e2] = e
                heapq.heappush(heap, (nc, e2))

    return Tree(forward, cost, dist, qual, par, done, route_hash)


def score_walk(E: EdgeTable, walk: List[int], turn_upto: int):
    """(turns over walk[:turn_upto], turns over all, discomfort over all)."""
    turns = 0
    turns_at_cut = 0
    disc = 0.0
    length, stress, b_in, b_out = E.length, E.stress, E.b_in, E.b_out
    for i, e in enumerate(walk):
        if i == turn_upto:
            turns_at_cut = turns
        disc += stress[e] * length[e]
        if i == 0:
            continue
        a = walk[i - 1]
        if _delta(b_in[a], b_out[e]) < TURN_DEG:
            continue
        if i >= 2:
            z = walk[i - 2]
            if (length[a] <= CROSSING_MAX_M and stress[a] > stress[z] and stress[a] > stress[e]
                    and _delta(b_in[z], b_out[a]) >= TURN_DEG):
                full = stress[a] * length[a]
                disc -= full - min(full, CROSSING_CAP)
                continue
        turns += 1
    if turn_upto >= len(walk):
        turns_at_cut = turns
    return turns_at_cut, turns, max(disc, 0.0)


def find_paths_tree(
    G: nx.MultiDiGraph,
    start_node: int,
    min_path_length: float,
    max_path_length: float,
    loop_ratio_floor: float,
    min_loop_length: float = 600.0,
    min_dist_m: float = 50.0,
    road_weights: Optional[Dict[str, float]] = None,
    rural_scale: bool = True,
    should_stop: Optional[Callable[[], bool]] = None,
    detour_weight: float = 0.3,
    explore_weight: float = 2.0,
    reuse_weight: float = 1.0,
    round_every: int = 8,
    max_rounds: int = 20,
    defer_ratio: float = 1.5,
    triangles: bool = False,
    policy: str = 'best',
    noise: float = 0.0,
    guided: bool = False,
    tag: str = 'tree_loops',
    require: Optional[list] = None,
    forbidden: Optional[set] = None,
    known_centroids: Optional[list] = None,
) -> Generator[Dict[str, Any], Optional[dict], None]:
    """Yields lollipop routes as GeoJSON Features (same shape as find_paths).

    triangles: also build three-leg loops (start → anchor → cross leg → home)
    from anchors spread by direction and distance, ANCHORS_PER_ROUND a round.

    policy 'best': one stream ordered by score, with deferral rounds.
    policy 'cover': an area pass first sends, best first, only loops adding
    at least COVER_MIN_NEW unseen cells; then everything else streams best
    first, regrowing until DRY_ROUNDS rounds in a row send nothing (or
    MAX_ROUNDS_ALL), so a long run lists every loop the trees can find.

    noise: up to this many turns per mile of random cost on each road for
    rounds after the first, so rebuilt trees find near-best alternatives
    away from roads already used too.

    guided: the generator never finishes on its own. When a pass runs dry
    (or should_stop fires) it yields IDLE and waits for a request sent in
    with generator.send(). A request is the dict from resolve_selections
    (`require`: uid sets every route must cross, `via`: their ids,
    `forbidden`: uids no route may use) plus optional `batch`. Every sent
    route is remembered across requests (seen paths, centroids, judged
    pairs, reuse penalty), so a later request never repeats one. Routes
    from a request carry properties `batch` and `via`.

    require / forbidden (uid sets, see resolve_selections) constrain the
    first pass the same way: a non-empty `require` makes it a guided pass
    (batch 0), `forbidden` edges are never entered. known_centroids are
    routes from elsewhere in the generation that must not be repeated;
    a request may carry more under the same key.
    """
    from route_features import (
        _calculate_path_centroid, _create_properties, _is_centroid_too_close,
        compute_difficulty, compute_elevation_profile, path_to_geojson,
        MILES_PER_METER,
    )

    E = edge_table(G)
    if G.number_of_edges():
        annotate_edge_stress(G, turns_per_mile=road_weights, rural=rural_scale)
    E.refresh_stress()
    if start_node not in E.out:
        return
    my_stress = list(E.stress)  # this request's road weights; restored per continuation

    def refresh():
        """Other sessions on the same graph may have re-annotated stress."""
        if E.stress != my_stress:
            E.stress = list(my_stress)

    detour_per_m = detour_weight / MILE_M
    reuse_per_m = reuse_weight / MILE_M
    noise_per_m = noise / MILE_M
    penalty = [0.0] * E.n_uid
    anchors: Optional[List[int]] = None
    to_start = _node_dist(E, start_node, forward=False)
    from_start = _node_dist(E, start_node, forward=True)

    heap: list = []
    cands: list = []
    seq = 0
    cover: Dict[tuple, int] = {}
    cover_ver = 0
    seen_paths = set()
    judged = set()
    stats = {'validated': 0, 'bad_shape': 0, 'stem': 0, 'one_way': 0, 'near_dup': 0,
             'three_leg_sent': 0, 'missed_pin': 0, 'forbidden': 0}
    timing = {'rounds_s': 0.0, 'shape_s': 0.0, 'elev_s': 0.0}
    centroids: list = [tuple(c) for c in (known_centroids or []) if c]
    yielded = 0
    yielded_at_round = 0
    rounds = 0

    # Guided request state. `require` is a list of uid sets (one per include
    # selection); a route must use an edge from every set. Empty with a
    # request active means "more routes, avoiding `forbidden`".
    initial_require = [frozenset(r) for r in (require or []) if r]
    initial_forbidden = set(forbidden or ())
    require: List[frozenset] = []
    via: list = []
    forbidden: set = initial_forbidden
    batch = 0  # 0 = initial pass, then one per request
    in_request = False  # guided rules apply (a request, or a constrained first pass)
    continuing = bool(centroids)  # adding to a generation that already has routes
    batch_rounds = 0
    guided_orders: Optional[list] = None  # visiting orders of the pins
    guided_cursor = 0
    guided_detour = 0  # index into GUIDE_DETOURS
    notes: List[str] = []  # why a request found little, for the UI

    def stopped():
        return should_stop is not None and should_stop()

    def add_round():
        t0 = time.perf_counter()
        if in_request and require:
            _add_guided_round()
        else:
            _add_round()
        timing['rounds_s'] += time.perf_counter() - t0

    def grow(start, forward, bound, pen, seeds=None, detour=None):
        return grow_tree(E, start, forward, max_path_length, bound,
                         detour_per_m if detour is None else detour, pen,
                         should_stop, seeds=seeds, forbidden=forbidden or None)

    def pair_up(T, B, prefix, min_leg, only_uids=None):
        """Queue T-route + B-route pairs joined at each junction.

        T is the outbound tree, or a leg tree continuing `prefix`, a tuple
        of (tree, edge) steps whose dist and qual already include them. A
        leg keeps only its TRI_PER_ANCHOR best pairs, at junctions at least
        TRI_MIN_SPREAD degrees (seen from the start) away from its anchor.
        only_uids limits pairs to those arriving or leaving on one of
        those undirected edges (a single pin or area).
        """
        nonlocal seq
        added = 0
        th, bh = T.route_hash, B.route_hash
        head_key = () if prefix is None else tuple(tr.route_hash[ed] for tr, ed in prefix)
        base = 0.0 if prefix is None else prefix[-1][0].dist[prefix[-1][1]]
        per_node = PAIRS_PER_NODE if prefix is None else 1
        anchor_b = None if prefix is None else E.bearing_from(start_node, E.head[prefix[-1][1]])
        if only_uids is None:
            junctions = E.out
        else:
            junctions = set()
            for u in only_uids:
                for x in E.by_uid[u]:
                    junctions.add(E.tail[x])
                    junctions.add(E.head[x])
        found = []
        for v in junctions:
            if anchor_b is not None and (
                    v == start_node
                    or _delta(anchor_b, E.bearing_from(start_node, v)) < TRI_MIN_SPREAD):
                continue
            ins = [e for e in E.inc[v] if T.done[e] and T.dist[e] - base >= min_leg]
            if not ins:
                continue
            outs = [g for g in E.out[v] if B.done[g]]
            pairs = []
            for e in ins:
                de, qe, te = T.dist[e], T.qual[e], E.tail[e]
                bi = E.b_in[e]
                e_hit = only_uids is None or E.uid[e] in only_uids
                for g in outs:
                    if E.head[g] == te:
                        continue
                    if not e_hit and E.uid[g] not in only_uids:
                        continue
                    total = de + B.dist[g]
                    if total < min_path_length or total > max_path_length:
                        continue
                    q = qe + B.qual[g]
                    if _delta(bi, E.b_out[g]) >= TURN_DEG:
                        q += 1.0
                    pairs.append((q / (total / MILE_M), e, g))
            if not pairs:
                continue
            # Pairs at one junction mostly trace the same loop; keep the best
            # few that share neither the arriving nor the leaving road.
            pairs.sort()
            kept = []
            for qpm, e, g in pairs:
                if any(e == ke or g == kg for _q, ke, kg in kept):
                    continue
                kept.append((qpm, e, g))
                if len(kept) == per_node:
                    break
            found.extend(kept)
        if prefix is not None:
            found.sort()
            del found[GUIDE_PER_ANCHOR if in_request else TRI_PER_ANCHOR:]
        for qpm, e, g in found:
            key = head_key + (th[e], bh[g])
            if key in judged:
                continue
            judged.add(key)
            cands.append((prefix, T, e, B, g, key))
            heapq.heappush(heap, (qpm, seq, len(cands) - 1, -1))
            seq += 1
            added += 1
        return added

    def pick_anchors(F):
        """Best-reached junction per (distance band, direction) slot, spread first."""
        best: Dict[tuple, tuple] = {}
        for v, outs in E.out.items():
            if v == start_node or len(outs) < 3:
                continue
            arr = [e for e in E.inc[v] if F.done[e]]
            if not arr:
                continue
            e = min(arr, key=lambda x: F.cost[x])
            share = F.dist[e] / max_path_length
            band = next((b for b, (lo, hi) in enumerate(ANCHOR_BANDS) if lo <= share < hi), None)
            if band is None:
                continue
            slot = (band, int(E.bearing_from(start_node, v) // 22.5) % 16)
            score = F.qual[e] / (F.dist[e] / MILE_M)
            if slot not in best or score < best[slot][0]:
                best[slot] = (score, v)
        return [best[(b, s)][1] for b in range(len(ANCHOR_BANDS))
                for s in ANCHOR_SECTORS if (b, s) in best]

    def grow_leg(prefix, pen, bound=None, detour=None, hard=False):
        """Forward tree continuing the route of `prefix` past its last edge.

        The roads that route already used get LEG_AVOID, or with `hard`
        are never entered: a leg that must still reach another pin cannot
        afford to touch the route so far, since the lollipop closes at the
        first revisited node and everything after it is dropped. `bound`
        is the plain distance still needed from each node (default: home).
        """
        T_prev, eA = prefix[-1]
        dpm = detour_per_m if detour is None else detour
        avoid = list(pen)
        block = set(forbidden) if hard else None
        block_nodes = set() if hard else None
        for tr, ed in prefix:
            for x in tr.chain(ed):
                if hard:
                    block.add(E.uid[x])
                    block_nodes.add(E.tail[x])
                    block_nodes.add(E.head[x])
                else:
                    avoid[E.uid[x]] += LEG_AVOID / MILE_M
        A = E.head[eA]
        if hard:
            block_nodes.discard(A)
        seeds = []
        for e2 in E.out[A]:
            if E.head[e2] == E.tail[eA]:
                continue
            L2 = E.length[e2]
            dq = E.stress[e2] * L2 + (1.0 if _delta(E.b_in[eA], E.b_out[e2]) >= TURN_DEG else 0.0)
            seeds.append((e2, dq + (dpm + avoid[E.uid[e2]]) * L2,
                          T_prev.dist[eA] + L2, T_prev.qual[eA] + dq))
        return grow_tree(E, A, True, max_path_length, to_start if bound is None else bound,
                         dpm, avoid, should_stop, seeds=seeds,
                         forbidden=block if hard else (forbidden or None),
                         blocked_nodes=block_nodes)

    def leg_min():
        return max(min_loop_length, 0.15 * min_path_length)

    def cross_leg(F, B, A, pen):
        """Three-leg loops through junction A, continuing F's best route there."""
        arr = [e for e in E.inc[A] if F.done[e]]
        if not arr:
            return 0
        eA = min(arr, key=lambda x: F.cost[x])
        prefix = ((F, eA),)
        return pair_up(grow_leg(prefix, pen), B, prefix, leg_min())

    def _add_round():
        nonlocal rounds, batch_rounds, yielded_at_round, anchors
        rounds += 1
        batch_rounds += 1
        yielded_at_round = yielded
        pen = penalty
        if noise > 0 and rounds > 1:
            rng = random.Random(rounds)
            pen = [p + rng.random() * noise_per_m for p in penalty]
        F = grow(start_node, True, to_start, pen)
        B = grow(start_node, False, from_start, pen)
        added = pair_up(F, B, None, 0.0)
        tri = 0
        if triangles:
            if anchors is None:
                anchors = pick_anchors(F)
            for j in range(ANCHORS_PER_ROUND):
                if not anchors or stopped():
                    break
                A = anchors[((rounds - 1) * ANCHORS_PER_ROUND + j) % len(anchors)]
                tri += cross_leg(F, B, A, pen)
        print(f"[{tag}] round {rounds}: +{added} pair +{tri} three-leg candidates, heap={len(heap)}")

    # ---- guided rounds: routes through every required edge set ----

    def reached_edges(T, R):
        """Directed edges of uid set R settled by tree T."""
        return [x for u in R for x in E.by_uid[u] if T.done[x]]

    def nodes_of(R):
        out = set()
        for u in R:
            for x in E.by_uid[u]:
                out.add(E.tail[x])
                out.add(E.head[x])
        return out

    plain_to: Dict[int, Dict[int, float]] = {}  # constraint index -> plain dist to it

    def to_constraint(i):
        got = plain_to.get(i)
        if got is None:
            got = _node_dist(E, nodes_of(require[i]), forward=False)
            plain_to[i] = got
        return got

    def leg_bounds(order):
        """Per leg of `order`, the plain distance still needed after a node:
        to the next constraint, then through the rest and home. Lets each
        leg's tree drop routes that could not finish the chain in max length.
        None when the chain cannot close at all."""
        k = len(order)
        tail = [INF] * (k + 1)
        tail[k] = 0.0
        for i in range(k - 1, -1, -1):
            nxt = to_start if i == k - 1 else to_constraint(order[i + 1])
            tail[i] = min((nxt.get(n, INF) for n in nodes_of(require[order[i]])), default=INF) + tail[i + 1]
        if tail[0] == INF:
            return None
        bounds = []
        for i in range(k):
            to_c = to_constraint(order[i])
            rem = tail[i]
            bounds.append({w: d + rem for w, d in to_c.items()})
        return bounds

    def spread_anchors(T, R, limit):
        """Directed edges of R reached by T: all of them for a pin, else the
        best (qual per mile) per 45° sector seen from the start, best first."""
        xs = reached_edges(T, R)
        if len(R) == 1:
            xs.sort(key=lambda x: T.cost[x])
            return xs[:limit]
        best: Dict[int, tuple] = {}
        for x in xs:
            if T.dist[x] <= 0:
                continue
            sector = int(E.bearing_from(start_node, E.head[x]) // 45.0) % 8
            score = T.qual[x] / (T.dist[x] / MILE_M)
            if sector not in best or score < best[sector][0]:
                best[sector] = (score, x)
        return [x for _s, x in sorted(best.values())][:limit]

    def plan_orders():
        """Visiting orders for several pins, cheapest plain distance first.

        Up to GUIDE_FULL_ORDERS constraints every order is tried; beyond
        that only clockwise, counter-clockwise and nearest-neighbour.
        """
        k = len(require)
        reps = []
        for i in range(k):
            nodes = [n for n in nodes_of(require[i]) if n in from_start and n in to_start]
            if not nodes:
                notes.append('a pin is on a road that cannot be reached from the start')
                return []
            reps.append(min(nodes, key=lambda n: from_start[n]))

        def order_cost(order):
            c = from_start.get(reps[order[0]], INF)
            for a, b in zip(order[:-1], order[1:]):
                c += to_constraint(b).get(reps[a], INF)
            return c + to_start.get(reps[order[-1]], INF)

        if k <= GUIDE_FULL_ORDERS:
            import itertools
            orders = list(itertools.permutations(range(k)))
        else:
            by_bearing = sorted(range(k), key=lambda i: E.bearing_from(start_node, reps[i]))
            orders = [tuple(by_bearing), tuple(reversed(by_bearing))]
            left, cur, nn = set(range(k)), None, []
            while left:
                nxt = min(left, key=lambda i: (from_start.get(reps[i], INF) if cur is None
                                               else to_constraint(i).get(reps[cur], INF)))
                nn.append(nxt)
                left.discard(nxt)
                cur = nxt
            orders.append(tuple(nn))
        orders = list(dict.fromkeys(orders))
        if orders:
            shortest = min(order_cost(o) for o in orders)
            if shortest > max_path_length:
                notes.append(f"the pins are {shortest / MILE_M:.1f} mi around by the shortest "
                             f"roads, more than the {max_path_length / MILE_M:.1f} mi maximum")
        orders = [o for o in orders if order_cost(o) <= max_path_length]
        orders.sort(key=order_cost)
        return orders

    def return_tree(prefix, pen, dpm):
        """Return tree that prefers not to retrace the chain so far, so the
        loop closes near the start instead of doubling a long stem."""
        avoid = list(pen)
        for tr, ed in prefix:
            for x in tr.chain(ed):
                avoid[E.uid[x]] += LEG_AVOID / MILE_M
        return grow(start_node, False, from_start, avoid, detour=dpm)

    def run_order(B, order, pen, dpm):
        """Legs through the constraints in `order`, then pairs with a return
        tree. One pin pairs with the shared B; a chain of pins gets its own
        return tree per anchor (see return_tree), since the shared one
        tends to come home along the first leg.

        Each leg's tree is bounded so it can still reach the remaining
        constraints and home; the last leg is free to pair anywhere.
        """
        bounds = leg_bounds(order)
        if bounds is None:
            return 0, 0
        F = grow(start_node, True, bounds[0], pen, detour=dpm)
        added = 0
        if len(order) == 1:
            added = pair_up(F, B, None, 0.0, only_uids=require[order[0]])
        firsts = spread_anchors(F, require[order[0]], 2 if len(order) > 1 else GUIDE_AREA_ANCHORS)
        legs = 0
        for first in firsts:
            if stopped():
                break
            prefix = ((F, first),)
            crossed = {E.uid[x] for x in F.chain(first)}
            failed = False
            for i, ci in enumerate(order[1:], start=1):
                if require[ci] & crossed:
                    continue  # already on the way; no leg needed
                T = grow_leg(prefix, pen, bounds[i], dpm, hard=True)
                xs = reached_edges(T, require[ci])
                if not xs:
                    failed = True
                    break
                nxt = min(xs, key=lambda x: T.cost[x])
                prefix = prefix + ((T, nxt),)
                crossed.update(E.uid[x] for x in T.chain(nxt))
            if failed:
                continue
            R = B if len(order) == 1 else return_tree(prefix, pen, dpm)
            legs += pair_up(grow_leg(prefix, pen, to_start, dpm), R, prefix, leg_min())
        return added, legs

    def _add_guided_round():
        """Guided legs start at max(detour_weight, GUIDE_DETOURS[0]) turns
        per mile for directness. A round that sends nothing escalates to
        the next level for the rest of the request (see the main loop), so
        pins that only fit by fairly direct roads still get routes."""
        nonlocal rounds, batch_rounds, yielded_at_round, guided_orders, guided_cursor
        rounds += 1
        batch_rounds += 1
        yielded_at_round = yielded
        cap = GUIDE_PENALTY_CAP / MILE_M
        pen = [p if p <= cap else cap for p in penalty]
        if guided_orders is None:
            guided_orders = plan_orders()
        n = len(guided_orders)
        added = legs = 0
        dpm = max(detour_weight, GUIDE_DETOURS[guided_detour]) / MILE_M
        B = grow(start_node, False, from_start, pen, detour=dpm)
        for j in range(min(GUIDE_ORDERS_PER_ROUND, n)):
            if stopped():
                break
            a, l = run_order(B, guided_orders[(guided_cursor + j) % n], pen, dpm)
            added += a
            legs += l
        guided_cursor += GUIDE_ORDERS_PER_ROUND
        print(f"[{tag}] guided round {rounds} (batch {batch}, {len(require)} pins, "
              f"{n} orders, detour {dpm * MILE_M:g}/mi): +{added} pair +{legs} leg "
              f"candidates, heap={len(heap)}")

    def escalate():
        """Next directness level after a dry guided round. False at the top."""
        nonlocal guided_detour
        if guided_detour + 1 >= len(GUIDE_DETOURS):
            return False
        guided_detour += 1
        print(f"[{tag}] nothing sent; guided legs now {GUIDE_DETOURS[guided_detour]:g} turns/mi")
        return True

    def apply_request(req):
        """Start a continuation: new constraints, fresh candidate heap, same
        memory of everything already sent. Candidates left unsent go back
        to unjudged so a later request can find them again."""
        nonlocal require, via, forbidden, batch, batch_rounds, best_qpm, dry, in_request, continuing
        nonlocal guided_orders, guided_cursor, guided_detour, heap, held
        for _s, _q, idx, _v in heap + held:
            judged.discard(cands[idx][5])
        require = [frozenset(r) for r in (req.get('require') or []) if r]
        # A set that contains another is satisfied whenever the smaller one
        # is (an edge and the road it lies on): keep only the smallest.
        require = [r for i, r in enumerate(require)
                   if not any(o < r or (o == r and j < i) for j, o in enumerate(require))]
        via = list(req.get('via') or [])
        forbidden = set(req.get('forbidden') or ())
        batch = req.get('batch')
        batch = batch + 1 if batch is None else int(batch)
        in_request = True
        continuing = continuing or batch > 0
        for c in req.get('known_centroids') or []:
            if c:
                centroids.append(tuple(c))
        batch_rounds = 0
        best_qpm = None
        dry = 0
        guided_orders = None
        guided_cursor = 0
        guided_detour = 0
        notes.clear()
        plain_to.clear()
        heap = []
        held = []
        info.clear()
        cands.clear()
        refresh()
        print(f"[{tag}] request batch {batch}: {len(require)} required, "
              f"{len(forbidden)} forbidden edges")

    def validate(idx):
        stats['validated'] += 1
        t0 = time.perf_counter()
        item = _shape(idx)
        timing['shape_s'] += time.perf_counter() - t0
        if item is None:
            stats['bad_shape'] += 1
        return item

    def _hugs(stem_edges, back, loop_edges):
        """Return route stays within HUG_M of the stem and off the loop."""
        tail = E.tail
        grid = {E.node_cell(tail[x], HUG_M) for x in stem_edges}
        loop_nodes = {tail[x] for x in loop_edges}
        for x in back[1:]:
            n = tail[x]
            if n in loop_nodes:
                return False
            cx, cy = E.node_cell(n, HUG_M)
            if not any((cx + dx, cy + dy) in grid for dx in (-1, 0, 1) for dy in (-1, 0, 1)):
                return False
        return True

    def _shape(idx):
        """Lollipop closed by the first node the out-and-back walk revisits.

        Same closing rule as the best-first search. A clean pair gives its
        own stem and loop; a pair whose halves touch keeps the far loop and
        returns along the outbound stem. Where that stem has a one-way edge,
        the return tree's own route back is used if it hugs the stem (split
        carriageways, one-way pairs), else each one-way stem edge is undone
        by EdgeTable.reverse_of. None if none of these works, or the result
        misses the length, loop, or ratio limits, or (guided) misses a
        required edge set or touches a forbidden edge.
        """
        prefix, T, e, B, g, _key = cands[idx]
        walk = T.chain(e) + B.chain(g)
        if prefix is not None:
            lead = []
            for tr, ed in prefix:
                lead += tr.chain(ed)
            walk = lead + walk
        head, length, rev = E.head, E.length, E.rev
        start = E.tail[walk[0]]
        nodes = [start]
        pos = {start: 0}
        hit = -1
        for j, x in enumerate(walk):
            n = head[x]
            if n in pos:
                hit = j
                break
            pos[n] = j + 1
            nodes.append(n)
        if hit < 0:
            return None
        i = pos[head[walk[hit]]]
        stem_edges = walk[:i]
        loop_edges = walk[i:hit + 1]
        if len(loop_edges) < 3:
            return None
        back = [rev[x] for x in reversed(stem_edges)]
        if -1 in back:
            back = walk[hit + 1:]
            if not _hugs(stem_edges, back, loop_edges):
                back = []
                for x in reversed(stem_edges):
                    way = E.reverse_of(x)
                    if not way:
                        back = None
                        break
                    back.extend(way)
                if back:
                    loop_set = {E.tail[x] for x in loop_edges}
                    if any(E.tail[x] in loop_set for x in back[1:]):
                        back = None
                if not back:
                    stats['one_way'] += 1
                    return None
        stem_dist = sum(length[x] for x in stem_edges)
        loop_dist = sum(length[x] for x in loop_edges)
        total = stem_dist + loop_dist + sum(length[x] for x in back)
        if (total < min_path_length or total > max_path_length
                or loop_dist < min_loop_length or loop_dist / total < loop_ratio_floor):
            stats['stem'] += 1
            if in_request:
                why = ('short' if total < min_path_length else 'long' if total > max_path_length
                       else 'loop' if loop_dist < min_loop_length else 'ratio')
                stats[f'g_{why}'] = stats.get(f'g_{why}', 0) + 1
            return None

        full = stem_edges + loop_edges + back
        if require:
            used = {E.uid[x] for x in stem_edges}
            used.update(E.uid[x] for x in loop_edges)
            if any(not (R & used) for R in require):
                stats['missed_pin'] += 1
                return None
        if forbidden and any(E.uid[x] in forbidden for x in full):
            stats['forbidden'] += 1
            return None
        one_way_turns, all_turns, disc = score_walk(E, full, len(stem_edges) + len(loop_edges))
        cells = set()
        for x in loop_edges:
            cells.update(E.cells[E.uid[x]])
        stem = nodes[:i + 1]
        loop_nodes = nodes[i:] + [nodes[i]]
        return_nodes = [nodes[i]] + [head[x] for x in back]
        return {
            'path': stem + loop_nodes + return_nodes,
            'loop_edges': loop_edges, 'cells': cells,
            'total': total, 'loop_dist': loop_dist, 'ratio': loop_dist / total,
            'turns': one_way_turns, 'discomfort': disc,
            'qpm': (all_turns + disc) / (total / MILE_M),
            'three_leg': prefix is not None,
        }

    def novelty(cells):
        if not cells:
            return 0.0
        return sum(1.0 / (1 + cover.get(c, 0)) for c in cells) / len(cells)

    info: Dict[int, dict] = {}
    best_qpm = None
    covering = policy == 'cover'  # still in the area pass
    held: list = []  # area-pass candidates that add no new area
    tier = 0
    dry = 0
    round_cap = max_rounds if policy == 'best' else MAX_ROUNDS_ALL

    def can_round():
        """Another regrow is allowed in this pass."""
        if in_request:
            return batch_rounds < GUIDE_MAX_ROUNDS
        return rounds < round_cap

    def report(label):
        print(f"[{tag}] {label}: yielded={yielded} rounds={rounds} "
              f"candidates={len(cands)} {stats} "
              + ' '.join(f"{k}={v:.1f}" for k, v in timing.items()))

    request = None
    if initial_require:
        # Constrained first pass: same machinery as a request, numbered 0.
        apply_request({'require': initial_require, 'forbidden': initial_forbidden, 'batch': 0})
    add_round()

    try:
        while True:
            if request is not None:
                apply_request(request)
                request = None

            while not stopped():
                if not heap:
                    if in_request:
                        if batch_rounds > 0:
                            dry = dry + 1 if yielded == yielded_at_round else 0
                            if dry and require and escalate():
                                dry = 0
                        if dry >= GUIDE_DRY_ROUNDS or not can_round():
                            break
                    elif policy == 'best':
                        if rounds >= max_rounds or yielded == 0:
                            break
                    else:
                        dry = dry + 1 if yielded == yielded_at_round else 0
                        if covering and (dry >= DRY_ROUNDS or rounds >= round_cap):
                            print(f"[{tag}] area pass {tier + 1} done: {yielded} routes, {len(cover)} cells")
                            tier += 1
                            covering = tier < len(COVER_TIERS)
                            dry = 0
                            heap = held
                            heapq.heapify(heap)
                            held = []
                            continue
                        if dry >= DRY_ROUNDS or rounds >= round_cap:
                            break
                    add_round()
                    if not heap and policy == 'best' and not in_request:
                        break
                    continue

                score, _s, idx, ver = heapq.heappop(heap)
                item = info.get(idx)
                if item is None:
                    item = validate(idx)
                    if item is None:
                        continue
                    info[idx] = item
                final = score
                if covering and not in_request:
                    cells = item['cells']
                    new = sum(1 for c in cells if c not in cover)
                    if (new < max(COVER_MIN_NEW, COVER_TIERS[tier] * len(cells))
                            or (best_qpm is not None and item['qpm'] > COVER_QPM_CAP * best_qpm)):
                        held.append((score, seq, idx, ver))
                        seq += 1
                        continue
                elif ver != cover_ver:
                    final = item['qpm'] * (1.0 + explore_weight * (1.0 - novelty(item['cells'])))
                    if heap and final > heap[0][0] + 1e-9:
                        heapq.heappush(heap, (final, seq, idx, cover_ver))
                        seq += 1
                        continue
                if ((policy == 'best' or in_request) and best_qpm is not None and can_round()
                        and yielded > yielded_at_round
                        and final > (GUIDE_DEFER_RATIO if in_request else defer_ratio) * best_qpm):
                    heapq.heappush(heap, (final, seq, idx, cover_ver))
                    seq += 1
                    add_round()
                    continue
                del info[idx]

                path = item['path']
                key = tuple(path)
                if key in seen_paths:
                    continue
                seen_paths.add(key)
                centroid = _calculate_path_centroid(G, path)
                if _is_centroid_too_close(centroid, centroids, min_dist_m=min_dist_m):
                    stats['near_dup'] += 1
                    if continuing:
                        # Re-found a route this generation already has: penalize
                        # its roads as if sent, so the next regrow looks elsewhere.
                        for x in item['loop_edges']:
                            penalty[E.uid[x]] += reuse_per_m
                    continue

                turns, discomfort = item['turns'], item['discomfort']
                total = item['total']
                t0 = time.perf_counter()
                elev_profile, climb_ft, _ = compute_elevation_profile(G, path)
                timing['elev_s'] += time.perf_counter() - t0
                difficulty = compute_difficulty(total * MILES_PER_METER, climb_ft)
                props = _create_properties(
                    turns, item['ratio'], item['loop_dist'], total, path,
                    climb_ft, difficulty, elev_profile, centroid, discomfort=discomfort,
                )
                if in_request or guided:
                    props['batch'] = batch
                    props['via'] = list(via)
                feature = path_to_geojson(G, path, props)
                if not feature:
                    continue

                if centroid:
                    centroids.append(centroid)
                if best_qpm is None or item['qpm'] < best_qpm:
                    best_qpm = item['qpm']
                for c in item['cells']:
                    cover[c] = cover.get(c, 0) + 1
                cover_ver += 1
                for x in item['loop_edges']:
                    penalty[E.uid[x]] += reuse_per_m
                yielded += 1
                if item['three_leg']:
                    stats['three_leg_sent'] += 1
                sent = yield feature
                if sent is not None:
                    request = sent
                    break

                if yielded % round_every == 0 and can_round():
                    add_round()

            if request is not None:
                continue
            if not guided:
                break
            # Park until the caller sends the next request. A plain next()
            # keeps it parked.
            report(f"pass done (batch {batch})")
            while request is None:
                request = yield idle('; '.join(notes) or None)
    finally:
        report('done')
