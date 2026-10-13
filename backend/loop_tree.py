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
        from loop_generator import _oriented_edge_geom

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

        self.n = len(self.tail)
        self.n_uid = len(uids)
        by_pair = {(self.tail[e], self.head[e]): e for e in range(self.n)}
        self.rev: List[int] = [by_pair.get((self.head[e], self.tail[e]), -1) for e in range(self.n)]
        self._k = k
        self._xy = {n: (d['x'], d['y']) for n, d in G.nodes(data=True)}
        self.stress: List[float] = [0.0] * self.n
        self._detours: Dict[int, tuple] = {}

    def node_cell(self, n, size_m):
        x, y = self._xy[n]
        return (int(y * M_PER_DEG // size_m), int(x * self._k * M_PER_DEG // size_m))

    def bearing_from(self, a, b):
        (x0, y0), (x1, y1) = self._xy[a], self._xy[b]
        return (math.degrees(math.atan2((x1 - x0) * self._k, y1 - y0)) + 360.0) % 360.0

    def refresh_stress(self):
        self.stress = [float(d.get('stress') or 0.0) for d in self.data]

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


def edge_table(G) -> EdgeTable:
    table = _TABLES.get(G)
    if table is None or table.n == 0:
        table = EdgeTable(G)
        _TABLES[G] = table
    return table


def _node_dist(E: EdgeTable, start: int, forward: bool) -> Dict[int, float]:
    """Shortest length from start (forward) or to start (backward) per node."""
    dist = {start: 0.0}
    heap = [(0.0, start)]
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
) -> Tree:
    """Edge-state Dijkstra on turns + discomfort + detour + reuse penalty.

    A state is a directed edge. Forward: best route start→…→edge. Backward:
    best route edge→…→start. `bound` is the plain shortest distance the other
    half needs, so states that cannot close within max_len are skipped.
    Short busy crossings follow the pleasant rule against the tree parent.
    `seeds` replaces the start edges with (edge, cost, dist, qual) states, so
    a forward tree can continue a route that already reached `start`.
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
            if forward:
                w = head[e2]
                delta = _delta(b_in[e], b_out[e2])
            else:
                w = tail[e2]
                delta = _delta(b_in[e2], b_out[e])
            if w == back_node:
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
    tag: str = 'tree_loops',
) -> Generator[Dict[str, Any], None, None]:
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
    """
    from loop_generator import (
        _calculate_path_centroid, _create_properties, _is_centroid_too_close,
        compute_difficulty, compute_elevation_profile, path_to_geojson,
        MILES_PER_METER,
    )

    if G.number_of_edges():
        annotate_edge_stress(G, turns_per_mile=road_weights, rural=rural_scale)
    E = edge_table(G)
    E.refresh_stress()
    if start_node not in E.out:
        return

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
             'three_leg_sent': 0}
    timing = {'rounds_s': 0.0, 'shape_s': 0.0, 'elev_s': 0.0}
    centroids: list = []
    yielded = 0
    yielded_at_round = 0
    rounds = 0

    def stopped():
        return should_stop is not None and should_stop()

    def add_round():
        t0 = time.perf_counter()
        _add_round()
        timing['rounds_s'] += time.perf_counter() - t0

    def pair_up(T, B, prefix, min_leg):
        """Queue T-route + B-route pairs joined at each junction.

        T is the outbound tree, or a cross-leg tree continuing `prefix`
        (outbound tree, edge) whose dist and qual already include it. A cross
        leg keeps only its TRI_PER_ANCHOR best pairs, at junctions at least
        TRI_MIN_SPREAD degrees (seen from the start) away from its anchor.
        """
        nonlocal seq
        added = 0
        th, bh = T.route_hash, B.route_hash
        head_key = () if prefix is None else (prefix[0].route_hash[prefix[1]],)
        base = 0.0 if prefix is None else prefix[0].dist[prefix[1]]
        per_node = PAIRS_PER_NODE if prefix is None else 1
        anchor_b = None if prefix is None else E.bearing_from(start_node, E.head[prefix[1]])
        found = []
        for v in E.out:
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
                for g in outs:
                    if E.head[g] == te:
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
            del found[TRI_PER_ANCHOR:]
        for qpm, e, g in found:
            key = head_key + (th[e], bh[g])
            if key in judged:
                continue
            judged.add(key)
            cands.append((prefix, T, e, B, g))
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

    def cross_leg(F, B, A, pen):
        """Forward tree from anchor A continuing F's route there, off that route."""
        arr = [e for e in E.inc[A] if F.done[e]]
        if not arr:
            return 0
        eA = min(arr, key=lambda x: F.cost[x])
        avoid = list(pen)
        for x in F.chain(eA):
            avoid[E.uid[x]] += LEG_AVOID / MILE_M
        seeds = []
        for e2 in E.out[A]:
            if E.head[e2] == E.tail[eA]:
                continue
            L2 = E.length[e2]
            dq = E.stress[e2] * L2 + (1.0 if _delta(E.b_in[eA], E.b_out[e2]) >= TURN_DEG else 0.0)
            seeds.append((e2, dq + (detour_per_m + avoid[E.uid[e2]]) * L2,
                          F.dist[eA] + L2, F.qual[eA] + dq))
        T = grow_tree(E, A, True, max_path_length, to_start, detour_per_m, avoid,
                      should_stop, seeds=seeds)
        return pair_up(T, B, (F, eA), max(min_loop_length, 0.15 * min_path_length))

    def _add_round():
        nonlocal rounds, yielded_at_round, anchors
        rounds += 1
        yielded_at_round = yielded
        pen = penalty
        if noise > 0 and rounds > 1:
            rng = random.Random(rounds)
            pen = [p + rng.random() * noise_per_m for p in penalty]
        F = grow_tree(E, start_node, True, max_path_length, to_start,
                      detour_per_m, pen, should_stop)
        B = grow_tree(E, start_node, False, max_path_length, from_start,
                      detour_per_m, pen, should_stop)
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
        misses the length, loop, or ratio limits.
        """
        prefix, T, e, B, g = cands[idx]
        walk = T.chain(e) + B.chain(g)
        if prefix is not None:
            walk = prefix[0].chain(prefix[1]) + walk
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
            return None

        full = stem_edges + loop_edges + back
        one_way_turns, all_turns, disc = score_walk(E, full, len(stem_edges) + len(loop_edges))
        cells = set()
        for x in loop_edges:
            cells.update(E.cells[E.uid[x]])
        stem = nodes[:i + 1]
        loop_nodes = nodes[i:] + [nodes[i]]
        return_nodes = [nodes[i]] + [head[x] for x in back]
        return {
            'path': stem + loop_nodes + return_nodes,
            'loop_nodes': nodes[i:], 'loop_edges': loop_edges, 'cells': cells,
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
    add_round()

    try:
        while not stopped():
            if not heap:
                if policy == 'best':
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
                if not heap and policy == 'best':
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
            if covering:
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
            if (policy == 'best' and best_qpm is not None and rounds < max_rounds
                    and yielded > yielded_at_round and final > defer_ratio * best_qpm):
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
                continue

            turns, discomfort = item['turns'], item['discomfort']
            total = item['total']
            t0 = time.perf_counter()
            elev_profile, climb_ft, _ = compute_elevation_profile(G, path)
            timing['elev_s'] += time.perf_counter() - t0
            difficulty = compute_difficulty(total * MILES_PER_METER, climb_ft)
            mask = 0
            for n in item['loop_nodes']:
                mask |= 1 << n
            props = _create_properties(
                turns, mask, item['ratio'], item['loop_dist'], total, path,
                climb_ft, difficulty, elev_profile, centroid, discomfort=discomfort,
            )
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
            yield feature

            if yielded % round_every == 0 and rounds < round_cap:
                add_round()
    finally:
        print(f"[{tag}] done: yielded={yielded} rounds={rounds} "
              f"candidates={len(cands)} {stats} "
              + ' '.join(f"{k}={v:.1f}" for k, v in timing.items()))

