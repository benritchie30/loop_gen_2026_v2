"""Route output: geometry, sampling, elevation, centroid, and the GeoJSON
Feature the client receives. Shared by every search strategy.

Per-edge samples and centroid sums are memoized per graph (weak-keyed, never
pickled), so output is identical to recomputing.
"""
import bisect
import math
import time
import weakref
from typing import Any, Dict, List, Optional, Tuple

import networkx as nx
import shapely.geometry
from shapely.ops import linemerge
import srtm

import surface as surface_mod
from pyproj import Geod

MILES_PER_METER = 0.000621371
FEET_PER_METER = 3.28084


# SRTM elevation. Tiles are downloaded on first use and cached under
# ~/.cache/srtm. A failed download (the mirror briefly down) pauses SRTM for
# SRTM_RETRY_S, then it is tried again, so a long-running server recovers by
# itself; meanwhile samples fall back to the graph's node elevations,
# interpolated along each edge (not memoized, so the area gets real elevation
# back once SRTM answers again).
SRTM_RETRY_S = 600.0
_srtm_data = None
_srtm_down_until = 0.0  # time.monotonic() before which SRTM is not tried


def _srtm_ok() -> bool:
    return time.monotonic() >= _srtm_down_until


def _srtm_failed(what, exc):
    global _srtm_down_until
    _srtm_down_until = time.monotonic() + SRTM_RETRY_S
    print(f"SRTM {what} failed ({type(exc).__name__}: {exc}); using graph node elevations "
          f"for the next {SRTM_RETRY_S / 60:g} min, then trying again.")


def _get_srtm():
    """SRTM query object, or None when paused after a failure."""
    global _srtm_data
    if not _srtm_ok():
        return None
    if _srtm_data is None:
        try:
            _srtm_data = srtm.get_data()
        except Exception as exc:  # no cache dir, no network for the url list
            _srtm_failed("setup", exc)
            return None
    return _srtm_data


def _bilinear(grid_file, lat, lng):
    """Elevation at (lat, lng) blended from the four SRTM grid points around
    it (bilinear), or None. SRTM stores whole metres on a 1 (US) or 3
    arc-second grid; srtm.py's own lookup takes one grid point (the one
    north-west of the point), which makes roads step in 1 m stairs and
    shift by up to a cell. A void point (no data) is left out and the
    others reweighted."""
    n = grid_file.square_side - 1
    fr = (grid_file.latitude + 1 - lat) * n   # rows run south from the north edge
    fc = (lng - grid_file.longitude) * n
    r0 = min(max(int(math.floor(fr)), 0), n - 1)
    c0 = min(max(int(math.floor(fc)), 0), n - 1)
    tr = min(max(fr - r0, 0.0), 1.0)
    tc = min(max(fc - c0, 0.0), 1.0)
    total = weight = 0.0
    for dr, dc, w in ((0, 0, (1 - tr) * (1 - tc)), (0, 1, (1 - tr) * tc),
                      (1, 0, tr * (1 - tc)), (1, 1, tr * tc)):
        if w <= 0:
            continue
        value = grid_file.get_elevation_from_row_and_column(r0 + dr, c0 + dc)
        if value is not None:
            total += w * value
            weight += w
    return total / weight if weight > 0 else None


def _srtm_elevation(elev_data, lat, lng):
    """Elevation from SRTM (bilinear between grid points), or None (no data
    there, or paused). A download failure pauses SRTM instead of retrying
    on every sample."""
    if elev_data is None or not _srtm_ok():
        return None
    try:
        get_file = getattr(elev_data, 'get_file', None)
        if get_file is None:  # a stand-in without grid files (tests)
            return elev_data.get_elevation(lat, lng)
        grid_file = get_file(lat, lng)
        return _bilinear(grid_file, lat, lng) if grid_file else None
    except Exception as exc:
        _srtm_failed("download", exc)
        return None

# Initialize Geod for bearing/distance
_geod = Geod(ellps='WGS84')


# Per-graph memo tables. Keyed weakly by graph so a switched-out graph frees
# its entries, and kept off G.graph so they never get pickled.
_CENTROID_PARTS: 'weakref.WeakKeyDictionary' = weakref.WeakKeyDictionary()
_ELEV_SAMPLES: 'weakref.WeakKeyDictionary' = weakref.WeakKeyDictionary()


def _graph_memo(table, G):
    memo = table.get(G)
    if memo is None:
        memo = {}
        table[G] = memo
    return memo


def _oriented_edge_geom(G, u, v):
    """LineString for u→v, reversed if stored coords run v→u.

    Degree-2 merges write one geometry onto both directed edges. Sampling and
    GeoJSON must follow travel direction or the elevation hover walks backward.
    A lollipop stem can retrace a one-way edge, so v→u's geometry stands in
    when u→v is missing.
    """
    ux, uy = G.nodes[u]['x'], G.nodes[u]['y']
    vx, vy = G.nodes[v]['x'], G.nodes[v]['y']
    geom = None
    for a, b in ((u, v), (v, u)):
        if G.has_edge(a, b):
            data = G[a][b][0] if G.is_multigraph() else G[a][b]
            geom = data.get('geometry')
            break
    if geom is None or geom.is_empty:
        return shapely.geometry.LineString([(ux, uy), (vx, vy)])
    if geom.geom_type == 'MultiLineString':
        geom = linemerge(geom)
        if geom.geom_type != 'LineString':
            geom = max(geom.geoms, key=lambda g: g.length)
    coords = list(geom.coords)
    if len(coords) < 2:
        return shapely.geometry.LineString([(ux, uy), (vx, vy)])
    start, end = coords[0], coords[-1]
    d_start_u = (start[0] - ux) ** 2 + (start[1] - uy) ** 2
    d_end_u = (end[0] - ux) ** 2 + (end[1] - uy) ** 2
    if d_end_u < d_start_u:
        return shapely.geometry.LineString(coords[::-1])
    return geom


def _point_along(coords, along, d):
    """(lng, lat) at d metres along a line (along: metres to each vertex).
    Straight between vertices, which are metres apart on a road."""
    n = len(coords)
    if d <= 0:
        return coords[0]
    if d >= along[-1]:
        return coords[-1]
    lo = bisect.bisect_right(along, d) - 1
    lo = min(max(lo, 0), n - 2)
    span = along[lo + 1] - along[lo]
    t = (d - along[lo]) / span if span > 0 else 0.0
    (x0, y0), (x1, y1) = coords[lo], coords[lo + 1]
    return (x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)


def _sample_path_geometry(G, path, sample_interval_m=50):
    """Yields (dist_m, lat, lng, bearing) uniformly sampled along path.

    Samples are spaced evenly in metres along each edge (geodesic), so a
    sample's distance is where it is. (Spacing them by shapely's normalized
    interpolate, in degrees, put them up to ~100 m from their distance on
    long curvy edges: a degree of longitude is shorter than one of latitude.)
    """
    cumulative_m = 0.0

    if not path:
        return

    for u, v in zip(path[:-1], path[1:]):
        if not (G.has_edge(u, v) or G.has_edge(v, u)):
            continue
        geom = _oriented_edge_geom(G, u, v)

        coords = list(geom.coords)
        along = [0.0]
        for i in range(1, len(coords)):
            _, _, dist = _geod.inv(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])
            along.append(along[-1] + dist)
        edge_length_m = along[-1]

        if edge_length_m < 1:
            continue

        num_samples = max(2, int(edge_length_m / sample_interval_m) + 1)
        for j in range(num_samples):
            # Consumers drop the duplicate where one edge ends and the next starts.
            frac = j / (num_samples - 1)
            d = frac * edge_length_m
            lng, lat = _point_along(coords, along, d)

            # Bearing: towards a point 1% of the edge ahead (none at its very end).
            ahead = min(0.01, 1.0 - frac) * edge_length_m
            if ahead > 0.0001 * edge_length_m:
                a_lng, a_lat = _point_along(coords, along, d + ahead)
                fwd_az, _, _ = _geod.inv(lng, lat, a_lng, a_lat)
                bearing = round(fwd_az % 360, 1)
            else:
                bearing = 0.0  # Should inherit previous but let consumer handle

            yield cumulative_m + d, lat, lng, bearing

        cumulative_m += edge_length_m

def _edge_centroid_parts(G, u, v):
    """(sum_lat, sum_lng, count, first_lat, first_lng) of u→v's 50 m samples.

    None when the edge is missing or under 1 m, which path sampling skips.
    """
    memo = _graph_memo(_CENTROID_PARTS, G)
    key = (u, v)
    if key in memo:
        return memo[key]
    parts = None
    sum_lat = sum_lng = 0.0
    count = 0
    first = None
    for _d, lat, lng, _b, _e in _edge_elevation_samples(G, u, v, 50):
        if first is None:
            first = (lat, lng)
        sum_lat += lat
        sum_lng += lng
        count += 1
    if count:
        parts = (sum_lat, sum_lng, count, first[0], first[1])
    memo[key] = parts
    return parts


def _calculate_path_centroid(G: nx.MultiDiGraph, path_nodes: List[int]) -> Optional[Tuple[float, float]]:
    """Centroid (avg lat, avg lng) of the path's 50 m geometry samples.

    Matches sampling the whole path: each edge after the first drops its
    first sample, which sits on the previous edge's last one.
    """
    if not path_nodes:
        return None

    sum_lat = 0.0
    sum_lng = 0.0
    count = 0
    for u, v in zip(path_nodes[:-1], path_nodes[1:]):
        parts = _edge_centroid_parts(G, u, v)
        if parts is None:
            continue
        e_lat, e_lng, e_n, f_lat, f_lng = parts
        sum_lat += e_lat
        sum_lng += e_lng
        count += e_n
        if count > e_n:
            sum_lat -= f_lat
            sum_lng -= f_lng
            count -= 1

    if count == 0:
        return None

    return (sum_lat / count, sum_lng / count)

def _is_centroid_too_close(
    centroid: Optional[Tuple[float, float]],
    existing_centroids: List[Tuple[float, float]],
    min_dist_m: float = 50.0 
) -> bool:
    """Checks if centroid is too close to any existing centroids (distance in meters)."""
    if not centroid:
        return False
        
    lat, lng = centroid
    # Approx conversion: 1 deg lat = 111,139 m. Longitude varies but this is a rough filter.
    # We use a safe approximation for "too close".
    min_dist_deg = min_dist_m / 111139.0
    threshold_sq = min_dist_deg * min_dist_deg
    
    for ex_lat, ex_lng in existing_centroids:
        d_lat = lat - ex_lat
        d_lng = lng - ex_lng
        if (d_lat*d_lat + d_lng*d_lng) < threshold_sq:
            return True
            
    return False

def _edge_elevation_samples(G, u, v, sample_interval_m):
    """[(dist_along_edge_m, lat, lng, bearing, elev_m)] for u→v, memoized."""
    memo = _graph_memo(_ELEV_SAMPLES, G)
    key = (u, v, sample_interval_m)
    samples = memo.get(key)
    if samples is None:
        elev_data = _get_srtm()
        points = list(_sample_path_geometry(G, [u, v], sample_interval_m))
        if elev_data is not None:
            samples = [(d, lat, lng, bearing, _srtm_elevation(elev_data, lat, lng))
                       for d, lat, lng, bearing in points]
        fallback = elev_data is None or not _srtm_ok()
        if fallback:
            # SRTM paused: straight-line interpolation between the edge's node elevations.
            eu = G.nodes[u].get('elevation')
            ev = G.nodes[v].get('elevation')
            eu = float(eu) if eu is not None else (float(ev) if ev is not None else 0.0)
            ev = float(ev) if ev is not None else eu
            span = points[-1][0] if points else 0.0
            samples = [
                (d, lat, lng, bearing, eu + (ev - eu) * (d / span if span > 0 else 0.0))
                for d, lat, lng, bearing in points
            ]
        if not fallback:
            memo[key] = samples  # a paused SRTM's stand-in is not kept
    return samples


def _path_elevation_samples(G, path, sample_interval_m):
    """Same stream as sampling the whole path, built from per-edge memos."""
    cumulative_m = 0.0
    for u, v in zip(path[:-1], path[1:]):
        samples = _edge_elevation_samples(G, u, v, sample_interval_m)
        if not samples:
            continue
        for d, lat, lng, bearing, elev_m in samples:
            yield cumulative_m + d, lat, lng, bearing, elev_m
        cumulative_m += samples[-1][0]


# Route elevation profile: sampled finer than the SRTM grid (30 m in the US),
# so no grid point is skipped, then lightly smoothed, since SRTM is a surface
# model in whole metres (roofs and canopy add bumps that inflate climb and
# make grades jump). Total climb is counted on the smoothed profile, the
# one the chart shows. Tuned against a synthetic 30 m grid with roof and
# canopy noise: climb within ~8% of the true ground's, where single-point
# raw samples every 50 m read 30-50% high.
PROFILE_SAMPLE_M = 25.0
PROFILE_SMOOTH_SIGMA_M = 30.0


def _smooth_profile(dists, elevs, sigma=PROFILE_SMOOTH_SIGMA_M):
    """Gaussian-weighted mean of each elevation with its neighbours within
    3 sigma (by distance). Near the ends the reach shrinks to stay centred,
    so the start and finish keep their own elevation."""
    n = len(elevs)
    if n < 3 or sigma <= 0:
        return list(elevs)
    out = []
    lo = 0
    first, last = dists[0], dists[-1]
    for i in range(n):
        d = dists[i]
        reach = min(3.0 * sigma, d - first, last - d)
        while dists[lo] < d - reach - 1e-9:
            lo += 1
        total = weight = 0.0
        j = lo
        while j < n and dists[j] <= d + reach + 1e-9:
            w = math.exp(-0.5 * ((dists[j] - d) / sigma) ** 2)
            total += w * elevs[j]
            weight += w
            j += 1
        out.append(total / weight)
    return out


def compute_elevation_profile(G, path, sample_interval_m=PROFILE_SAMPLE_M):
    """Elevation along path: [[dist_mi, elev_ft, lat, lng, bearing], ...]
    every sample_interval_m (SRTM, bilinear), smoothed (_smooth_profile),
    with the total climb and descent (ft) of that smoothed profile."""
    samples = []
    last_dist_m = -1000.0
    for dist_m, lat, lng, bearing, elev_m in _path_elevation_samples(G, path, sample_interval_m):
        # Filter duplicates (e.g. edge boundaries)
        if dist_m < last_dist_m + 1.0:
            continue
        last_dist_m = dist_m
        if elev_m is None:
            continue
        samples.append((dist_m, lat, lng, bearing, float(elev_m)))

    smoothed = _smooth_profile([x[0] for x in samples], [x[4] for x in samples])
    profile = []
    total_climb = 0.0
    total_descent = 0.0
    prev_elev = None
    for (dist_m, lat, lng, bearing, _raw), elev_m in zip(samples, smoothed):
        elev_ft = elev_m * FEET_PER_METER
        if prev_elev is not None:
            delta = elev_ft - prev_elev
            if delta > 0:
                total_climb += delta
            else:
                total_descent -= delta
        prev_elev = elev_ft
        profile.append([round(dist_m * MILES_PER_METER, 4), round(elev_ft, 1), round(lat, 6), round(lng, 6), bearing])

    return profile, round(total_climb, 0), round(total_descent, 0)

def compute_difficulty(total_miles, total_climb_ft):
    """Scores route difficulty 1-10 based on climb rate (ft/mile)."""
    if total_miles <= 0:
        return 1
    climb_rate = total_climb_ft / total_miles
    score = 1 + (climb_rate / 200) * 9
    return round(min(max(score, 1), 10), 1)

def _create_properties(
    turns: int,
    loop_ratio: float,
    loop_dist: float,
    total_dist: float,
    path: List[int],
    total_climb_ft: float = 0.0,
    difficulty: float = 1.0,
    elevation_profile: List = None,
    centroid: Optional[Tuple[float, float]] = None,
    discomfort: Optional[float] = None,
) -> Dict[str, Any]:
    """Creates GeoJSON properties dictionary."""
    if centroid is None and elevation_profile:
        # profile items: [dist, elev, lat, lng, bearing]
        # Use simple average of sampled points as centroid
        lats = [p[2] for p in elevation_profile if len(p) >= 4]
        lngs = [p[3] for p in elevation_profile if len(p) >= 4]
        if lats:
            centroid = (round(sum(lats) / len(lats), 6), round(sum(lngs) / len(lngs), 6))

    properties = {
        'turns': turns,
        'loop_ratio': round(loop_ratio, 3),
        'loop_miles': round(loop_dist * MILES_PER_METER, 3),
        'total_miles': round(total_dist * MILES_PER_METER, 3),
        'node_count': len(path),
        'total_climb_ft': total_climb_ft,
        'difficulty': difficulty,
        'elevation_profile': elevation_profile or [],
        'centroid': centroid
    }
    if discomfort is not None:
        properties['discomfort'] = round(float(discomfort), 3)
    return properties

def _assemble(G, path):
    """The route's coordinates and where each edge lies in them.

    Returns (coords, pieces): coords [(lng, lat), ...] joined edge after edge
    (an edge starting where the last ended shares that point); pieces
    [(u, v, first index, edge coords)] for each edge used.
    """
    coords = []
    pieces = []
    for u, v in zip(path[:-1], path[1:]):
        if not (G.has_edge(u, v) or G.has_edge(v, u)):
            continue
        part = list(_oriented_edge_geom(G, u, v).coords)
        if not part:
            continue
        if coords and coords[-1] == part[0]:
            first = len(coords) - 1
            coords.extend(part[1:])
        else:
            first = len(coords)
            coords.extend(part)
        pieces.append((u, v, first, part))
    return coords, pieces


_EDGE_SURFACE: 'weakref.WeakKeyDictionary' = weakref.WeakKeyDictionary()


def _edge_parts(G, u, v):
    """[(length, tags)] of u->v in travel order (v->u's reversed for a stem
    retracing a one-way), or None."""
    if G.has_edge(u, v):
        data = G[u][v][0] if G.is_multigraph() else G[u][v]
        return data.get('parts') or [(data.get('length') or 0.0, data)]
    if G.has_edge(v, u):
        data = G[v][u][0] if G.is_multigraph() else G[v][u]
        parts = data.get('parts') or [(data.get('length') or 0.0, data)]
        return parts[::-1]
    return None


def _edge_unpaved(G, u, v, edge_coords):
    """(edge length m, [(i0, i1, m0, m1)]) for u->v: its geodesic length (as
    the elevation samples measure it; 0 under 1 m, which they skip) and its
    unpaved stretches as point indices into edge_coords and metres from its
    start. Memoized per graph.

    Parts (graph_builder) are the pieces of the ways merged into the edge,
    in order, each starting and ending on an OSM node, so a part boundary is
    the point where the parts' lengths add up to it.
    """
    memo = _graph_memo(_EDGE_SURFACE, G)
    key = (u, v)
    if key in memo:
        return memo[key]
    n = len(edge_coords)
    along = [0.0]
    for i in range(1, n):
        _, _, dist = _geod.inv(edge_coords[i - 1][0], edge_coords[i - 1][1], edge_coords[i][0], edge_coords[i][1])
        along.append(along[-1] + dist)
    edge_m = along[-1] if along[-1] >= 1 else 0.0
    spans = []
    parts = _edge_parts(G, u, v) or []
    total_parts = sum(length for length, _tags in parts)
    if edge_m > 0 and total_parts > 0 and n >= 2:
        at = 0.0
        i = 0
        last = len(parts) - 1
        for k, (length, tags) in enumerate(parts):
            start_i = i
            at += length
            if k == last:
                i = n - 1
            else:
                # The point where this part ends: its share of the edge's length.
                target = at / total_parts * edge_m
                while i < n - 1 and abs(along[i + 1] - target) <= abs(along[i] - target):
                    i += 1
            if length <= 0 or not surface_mod.is_unpaved(tags):
                continue
            end_i = i
            if end_i <= start_i:
                continue
            if spans and spans[-1][1] == start_i:
                spans[-1] = (spans[-1][0], end_i, spans[-1][2], along[end_i])
            else:
                spans.append((start_i, end_i, along[start_i], along[end_i]))
    result = (edge_m, spans)
    memo[key] = result
    return result


def surface_properties(G, path, pieces=None) -> Dict[str, Any]:
    """The route's unpaved stretches, for the map and the elevation chart.

    'unpaved': [[first point, last point, start mi, end mi], ...], point
    indices into the route's GeoJSON coordinates (exact on the map) and
    miles along the route on the elevation profile's scale (every edge's
    geodesic length). 'unpaved_miles': their total. Unknown surfaces count
    as paved (surface.py).
    """
    if pieces is None:
        _coords, pieces = _assemble(G, path)
    runs = []
    cum_m = 0.0
    for u, v, first, edge_coords in pieces:
        edge_m, spans = _edge_unpaved(G, u, v, edge_coords)
        for i0, i1, m0, m1 in spans:
            a, b = first + i0, first + i1
            d0, d1 = cum_m + m0, cum_m + m1
            if runs and a - runs[-1][1] <= 1 and abs(runs[-1][3] - d0) < 1.0:
                runs[-1][1], runs[-1][3] = b, d1  # carries on the last stretch (the next edge)
            else:
                runs.append([a, b, d0, d1])
        cum_m += edge_m
    unpaved_m = sum(r[3] - r[2] for r in runs)
    return {
        'unpaved': [[a, b, round(d0 * MILES_PER_METER, 3), round(d1 * MILES_PER_METER, 3)] for a, b, d0, d1 in runs],
        'unpaved_miles': round(unpaved_m * MILES_PER_METER, 3),
    }


def path_to_geojson(
    G: nx.MultiDiGraph,
    path: List[int],
    properties: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """Converts a sequence of node IDs to a GeoJSON Feature, with its unpaved
    stretches (surface_properties) added to properties."""
    if not path:
        return None

    coords, pieces = _assemble(G, path)
    if len(coords) < 2:
        return None

    merged = shapely.geometry.LineString(coords)
    properties.update(surface_properties(G, path, pieces))

    return {
        "type": "Feature",
        "geometry": shapely.geometry.mapping(merged),
        "properties": properties
    }
