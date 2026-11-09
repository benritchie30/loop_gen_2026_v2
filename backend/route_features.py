"""Route output: geometry, sampling, elevation, centroid, and the GeoJSON
Feature the client receives. Shared by every search strategy.

Per-edge samples and centroid sums are memoized per graph (weak-keyed, never
pickled), so output is identical to recomputing.
"""
import math
import time
import weakref
from typing import Any, Dict, List, Optional, Tuple

import networkx as nx
import shapely.geometry
from shapely.ops import linemerge
import srtm
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


def _srtm_elevation(elev_data, lat, lng):
    """Elevation from SRTM, or None (no data there, or paused). A
    download failure pauses SRTM instead of retrying on every sample."""
    if elev_data is None or not _srtm_ok():
        return None
    try:
        return elev_data.get_elevation(lat, lng)
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


def _sample_path_geometry(G, path, sample_interval_m=50):
    """Yields (dist_m, lat, lng, bearing) uniformly sampled along path."""
    cumulative_m = 0.0
    
    # Check start
    if not path:
        return

    for u, v in zip(path[:-1], path[1:]):
        if not (G.has_edge(u, v) or G.has_edge(v, u)):
            continue
        geom = _oriented_edge_geom(G, u, v)

        # Compute geodesic length
        coords = list(geom.coords)
        edge_length_m = 0.0
        # Replicate logic for geodesic length
        for i in range(1, len(coords)):
             _, _, dist = _geod.inv(coords[i-1][0], coords[i-1][1], coords[i][0], coords[i][1])
             edge_length_m += dist

        if edge_length_m < 1:
            continue

        num_samples = max(2, int(edge_length_m / sample_interval_m) + 1)
        for j in range(num_samples):
            # Avoid duplicate point at exact end of edge?
            # Handled by consumer filtering usually, or we can filter here.
            # We yield all to be safe for diverse consumers.
            
            frac = j / (num_samples - 1)
            pt = geom.interpolate(frac, normalized=True)
            lng, lat = pt.x, pt.y
            
            # Bearing
            epsilon = min(0.01, 1.0 - frac)
            if epsilon > 0.0001:
                pt_ahead = geom.interpolate(frac + epsilon, normalized=True)
                fwd_az, _, _ = _geod.inv(lng, lat, pt_ahead.x, pt_ahead.y)
                bearing = round(fwd_az % 360, 1)
            else:
                bearing = 0.0 # Should inherit previous but let consumer handle

            dist_along_m = cumulative_m + frac * edge_length_m
            yield dist_along_m, lat, lng, bearing
            
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


def compute_elevation_profile(G, path, sample_interval_m=50):
    """Samples SRTM elevation along path. Uses _sample_path_geometry."""
    profile = []
    
    total_climb = 0.0
    total_descent = 0.0
    prev_elev = None
    last_dist_m = -1000.0

    for dist_m, lat, lng, bearing, elev_m in _path_elevation_samples(G, path, sample_interval_m):
        # Filter duplicates (e.g. edge boundaries)
        if dist_m < last_dist_m + 1.0: 
             continue
        last_dist_m = dist_m

        if elev_m is None: continue
        elev_ft = elev_m * FEET_PER_METER
        
        dist_mi = dist_m * MILES_PER_METER
        
        if prev_elev is not None:
            delta = elev_ft - prev_elev
            if delta > 0: total_climb += delta
            else: total_descent += abs(delta)
        prev_elev = elev_ft
        
        profile.append([round(dist_mi, 3), round(elev_ft, 1), round(lat, 6), round(lng, 6), bearing])

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

def path_to_geojson(
    G: nx.MultiDiGraph,
    path: List[int],
    properties: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """Converts a sequence of node IDs to a GeoJSON Feature."""
    if not path:
        return None
        
    coords = []
    for u, v in zip(path[:-1], path[1:]):
        if not (G.has_edge(u, v) or G.has_edge(v, u)):
            continue
        part = list(_oriented_edge_geom(G, u, v).coords)
        if not part:
            continue
        if coords and coords[-1] == part[0]:
            coords.extend(part[1:])
        else:
            coords.extend(part)

    if len(coords) < 2:
        return None

    merged = shapely.geometry.LineString(coords)
    
    return {
        "type": "Feature",
        "geometry": shapely.geometry.mapping(merged),
        "properties": properties
    }
