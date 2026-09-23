
import heapq
import math
from typing import List, Tuple, Dict, Any, Generator, Optional, Set
import networkx as nx
import shapely.geometry
from shapely.ops import linemerge
import srtm
from pyproj import Geod
import functools
from road_stress import CROSSING_CAP, CROSSING_MAX_M, annotate_edge_stress

# Constants
MILES_PER_METER = 0.000621371
FEET_PER_METER = 3.28084
MIN_LOOP_LENGTH_METERS = 1000  # Minimum loop length to be considered valid
TURN_ANGLE_THRESHOLD_DEG = 30.0  # edges with bearing change >= this count as a turn

# Initialize SRTM downloader
_srtm_data = None
def _get_srtm():
    global _srtm_data
    if _srtm_data is None:
        _srtm_data = srtm.get_data()
    return _srtm_data

# Initialize Geod for bearing/distance
_geod = Geod(ellps='WGS84')

class PathNode:
    """Helper class for path reconstruction to avoid storing full paths in queue."""
    __slots__ = ['id', 'prev', 'dist']
    
    def __init__(self, id: int, prev: 'PathNode' = None, dist: float = 0.0):
        self.id = id
        self.prev = prev
        self.dist = dist

    def __lt__(self, other):
        return self.dist < other.dist

    def traverse(self) -> List[int]:
        """Reconstructs path from this node back to start."""
        path = []
        curr = self
        while curr:
            path.append(curr.id)
            curr = curr.prev
        return path[::-1]
    
    def traverse_to(self, target_id: int) -> Tuple[List[int], Optional['PathNode']]:
        """
        Reconstructs path backwards until target_id is found.
        Returns (path_segment_to_target, node_at_target).
        Used for loop detection.
        """
        curr = self
        path = [curr.id]
        curr = curr.prev
        while curr:
            path.append(curr.id)
            if curr.id == target_id:
                # print(f"Path segment: {path[::-1]}, curr: {curr.id}")
                return path[::-1], curr
            curr = curr.prev
        return [], None

@functools.lru_cache(maxsize=100000)
def _calc_bearing(lat1_deg, lng1_deg, lat2_deg, lng2_deg):
    lat1 = math.radians(lat1_deg)
    lat2 = math.radians(lat2_deg)
    diffLong = math.radians(lng2_deg - lng1_deg)

    x = math.sin(diffLong) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - (math.sin(lat1) * math.cos(lat2) * math.cos(diffLong))

    initial_bearing = math.atan2(x, y)
    return (math.degrees(initial_bearing) + 360) % 360

# def calculate_initial_bearing(G, u, v):
#     """Calculates bearing from u to v using graph coordinates."""
#     if 'x' in G.nodes[u] and 'y' in G.nodes[u] and 'x' in G.nodes[v] and 'y' in G.nodes[v]:
#         return _calc_bearing(G.nodes[u]['y'], G.nodes[u]['x'], G.nodes[v]['y'], G.nodes[v]['x'])
#     return 0.0

def calculate_initial_bearing(G, u, v):
    """Calculates bearing from u to v using graph coordinates."""
    if 'x' in G.nodes[u] and 'y' in G.nodes[u] and 'x' in G.nodes[v] and 'y' in G.nodes[v]:
        # Simple bearing since edges are short
        lat1 = math.radians(G.nodes[u]['y'])
        lat2 = math.radians(G.nodes[v]['y'])
        diffLong = math.radians(G.nodes[v]['x'] - G.nodes[u]['x'])

        x = math.sin(diffLong) * math.cos(lat2)
        y = math.cos(lat1) * math.sin(lat2) - (math.sin(lat1) * math.cos(lat2) * math.cos(diffLong))

        initial_bearing = math.atan2(x, y)
        initial_bearing = math.degrees(initial_bearing)
        return (initial_bearing + 360) % 360
    return 0.0


def weight_function_dist(G, u_node, v, current_dist):
    """Simple distance-based weight."""
    edge_data = G.get_edge_data(u_node.id, v)
    if not edge_data: return float('inf')
    
    # Take the shortest edge if multiple exist
    length = min(d.get('length', 0) for d in edge_data.values())
    return current_dist + length


def _flatten_names(name_data):
    """Recursively flattens edge name data into a set of strings."""
    if name_data is None:
        return set()
    if isinstance(name_data, str):
        return {name_data}
    if isinstance(name_data, list):
        # Flatten list recursively
        flat = set()
        for item in name_data:
            flat.update(_flatten_names(item))
        return flat
    # Fallback for other types
    return {str(name_data)}

def _compare_edge_names(name1, name2):
    """Returns True if edge names match (continuation), False if turn."""
    if name1 is None or name2 is None:
        return False
    
    n1_set = _flatten_names(name1)
    n2_set = _flatten_names(name2)
    
    return bool(n1_set & n2_set)

def _bearing_delta(b1, b2):
    """Absolute bearing change in [0, 180] degrees."""
    d = abs(b1 - b2) % 360
    return d if d <= 180 else 360 - d

def weight_function_turns_dist(G, u_node, v, current_turns, current_dist):
    """Calculates path weight considering turns (by bearing change) and distance."""
    if not G.has_edge(u_node.id, v):
        return float('inf'), float('inf')
    try:
        curr_edge = G[u_node.id][v][0]
    except KeyError:
        print("KeyError in weight_function_turns_dist")
        print(u_node.id, v)
        return current_turns, current_dist

    new_dist = current_dist + curr_edge.get('length', 0)

    if u_node.prev is None:
        return 0, new_dist

    # Geometric turn: bearing change between previous edge and current edge.
    prev_bearing = calculate_initial_bearing(G, u_node.prev.id, u_node.id)
    curr_bearing = calculate_initial_bearing(G, u_node.id, v)
    delta = _bearing_delta(prev_bearing, curr_bearing)

    if delta >= TURN_ANGLE_THRESHOLD_DEG:
        current_turns += 1

    return current_turns, new_dist


def _edge_data(G, u, v):
    """First parallel edge from u to v, or None."""
    try:
        return G[u][v][0]
    except (KeyError, IndexError, TypeError):
        return None


def pleasant_extend(G, prev_prev, prev, curr, nxt, turns, dist, discomfort):
    """One pleasant-search step from curr to nxt.

    prev is the node we arrived from (None at the start). prev_prev is the
    node before that, used to recognize a short crossing.

    A crossing is a short edge that is strictly busier than both the edge
    before it and the edge after it, with a real turn onto it and off it.
    The pair counts as one turn (the entry turn, already counted) and that
    edge's discomfort is refunded down to CROSSING_CAP.
    """
    edge = _edge_data(G, curr, nxt)
    if edge is None:
        return turns, float('inf'), discomfort

    length = float(edge.get('length') or 0)
    new_dist = dist + length
    new_discomfort = discomfort + float(edge.get('stress') or 0) * length
    new_turns = turns

    if prev is None:
        return new_turns, new_dist, new_discomfort

    exit_delta = _bearing_delta(
        calculate_initial_bearing(G, prev, curr),
        calculate_initial_bearing(G, curr, nxt),
    )
    exit_turn = exit_delta >= TURN_ANGLE_THRESHOLD_DEG
    crossing = False

    arrived = _edge_data(G, prev, curr)
    if arrived is not None and exit_turn and prev_prev is not None:
        arrived_len = float(arrived.get('length') or 0)
        if arrived_len <= CROSSING_MAX_M:
            entry_delta = _bearing_delta(
                calculate_initial_bearing(G, prev_prev, prev),
                calculate_initial_bearing(G, prev, curr),
            )
            if entry_delta >= TURN_ANGLE_THRESHOLD_DEG:
                stress_arrived = float(arrived.get('stress') or 0)
                incoming = _edge_data(G, prev_prev, prev)
                stress_in = float(incoming.get('stress') or 0) if incoming is not None else 0.0
                stress_next = float(edge.get('stress') or 0)
                if stress_arrived > stress_in and stress_arrived > stress_next:
                    crossing = True
                    arrived_cost = stress_arrived * arrived_len
                    new_discomfort -= arrived_cost - min(arrived_cost, CROSSING_CAP)

    if not crossing and exit_turn:
        new_turns += 1

    if new_discomfort < 0:
        new_discomfort = 0.0
    return new_turns, new_dist, new_discomfort


def score_pleasant_path(G, path):
    """Discomfort along a full lollipop, stem included both ways.

    Consecutive duplicate nodes at the loop junction are skipped. The returned
    turn count is not what the UI shows; search reports the one-way count.
    """
    if not path:
        return 0, 0.0
    nodes = [path[0]]
    for node in path[1:]:
        if node != nodes[-1]:
            nodes.append(node)

    turns = 0
    dist = 0.0
    discomfort = 0.0
    prev_prev = None
    prev = None
    for i in range(len(nodes) - 1):
        curr = nodes[i]
        nxt = nodes[i + 1]
        turns, dist, discomfort = pleasant_extend(
            G, prev_prev, prev, curr, nxt, turns, dist, discomfort
        )
        prev_prev = prev
        prev = curr
    return turns, discomfort




def jaccard_similarity(set1_mask: int, set2_mask: int) -> float:
    """Calculates Jaccard similarity between two bitmasks."""
    intersection = bin(set1_mask & set2_mask).count('1')
    union = bin(set1_mask | set2_mask).count('1')
    return intersection / union if union > 0 else 0.0

def _is_unique_path(
    mask: int,
    existing_masks: Set[int],
    similarity_threshold: float
) -> bool:
    """Checks if path is sufficiently unique using Jaccard similarity."""
    for existing in existing_masks:
        if jaccard_similarity(mask, existing) > similarity_threshold:
            return False
    return True

def _oriented_edge_geom(G, u, v):
    """LineString for u→v, reversed if stored coords run v→u.

    Degree-2 merges write one geometry onto both directed edges. Sampling and
    GeoJSON must follow travel direction or the elevation hover walks backward.
    """
    ux, uy = G.nodes[u]['x'], G.nodes[u]['y']
    vx, vy = G.nodes[v]['x'], G.nodes[v]['y']
    geom = None
    if G.has_edge(u, v):
        data = G[u][v][0] if G.is_multigraph() else G[u][v]
        geom = data.get('geometry')
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
        if not G.has_edge(u, v):
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

def _calculate_path_centroid(G: nx.MultiDiGraph, path_nodes: List[int]) -> Optional[Tuple[float, float]]:
    """Calculates centroid (avg lat, avg lng) using uniform geometry sampling."""
    if not path_nodes:
        return None
        
    sum_lat = 0.0
    sum_lng = 0.0
    count = 0
    
    # Use the same sampling as elevation profile for consistency
    last_dist_m = -1000.0
    for dist_m, lat, lng, _ in _sample_path_geometry(G, path_nodes, sample_interval_m=50):
        if dist_m < last_dist_m + 1.0:
            continue
        last_dist_m = dist_m
        
        sum_lat += lat
        sum_lng += lng
        count += 1
            
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

def compute_elevation_profile(G, path, sample_interval_m=50):
    """Samples SRTM elevation along path. Uses _sample_path_geometry."""
    elev_data = _get_srtm()
    profile = []
    
    total_climb = 0.0
    total_descent = 0.0
    prev_elev = None
    last_dist_m = -1000.0

    for dist_m, lat, lng, bearing in _sample_path_geometry(G, path, sample_interval_m):
        # Filter duplicates (e.g. edge boundaries)
        if dist_m < last_dist_m + 1.0: 
             continue
        last_dist_m = dist_m

        elev_m = elev_data.get_elevation(lat, lng)
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
    visited_mask: int,
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
        'visited': hex(visited_mask),
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
        if not G.has_edge(u, v):
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


# Strategy registry. Baseline 'turns' must stay pop-for-pop identical to the
# original turns-first search (no prune, no A*, no cap).
ALGORITHMS: Dict[str, Dict[str, Any]] = {
    'turns': {
        'label': 'Turns-first (baseline)',
        'prune_self_cross': False,
        'astar_bound': False,
        'node_bucket_cap': None,
        'order': 'turns',
    },
    'turns_pruned': {
        'label': 'Turns-first + self-cross prune + A*',
        'prune_self_cross': True,
        'astar_bound': True,
        'node_bucket_cap': None,
        'order': 'turns',
    },
    'turns_capped': {
        'label': 'Turns-first + capped state space',
        'prune_self_cross': True,
        'astar_bound': True,
        'node_bucket_cap': 3,  # overridden by cap_k when provided
        'order': 'turns',
    },
    'pleasant_capped': {
        'label': 'Pleasant roads (capped)',
        'prune_self_cross': True,
        'astar_bound': True,
        'node_bucket_cap': 3,  # overridden by cap_k when provided
        'order': 'pleasant',
    },
}

BUCKET_M = 0.5 / MILES_PER_METER  # 0.5 miles in meters
LEGACY_ALGORITHM_ALIASES = {'scenic': 'turns', 'direct': 'turns', 'turn': 'turns'}
MAX_ITERS = 1000000  # overridable for tests
PRINT_EVERY = 10000


def list_algorithms() -> List[Dict[str, str]]:
    """UI-facing list of {id, label} from the registry."""
    return [{'id': k, 'label': v['label']} for k, v in ALGORITHMS.items()]


def resolve_algorithm(name: Optional[str]) -> str:
    """Map request / legacy names onto a registry key; unknown -> 'turns'."""
    if not name:
        return 'turns'
    key = LEGACY_ALGORITHM_ALIASES.get(name, name)
    return key if key in ALGORITHMS else 'turns'


def find_paths_turns_dist(
    G: nx.MultiDiGraph,
    start_node: int,
    min_path_length: float,
    max_path_length: float,
    loop_ratio_floor: float,
    similarity_ceiling: float,
    min_loop_length: float = MIN_LOOP_LENGTH_METERS,
    deduplication: str = 'centroid',
    min_dist_m: float = 50.0,
    prune_self_cross: bool = False,
    astar_bound: bool = False,
    node_bucket_cap: Optional[int] = None,
    bucket_m: float = BUCKET_M,
    algorithm_id: str = 'turns',
    graph_name: str = 'graph',
    debug_snapshots: bool = False,
    snapshot_every: int = 25000,
    order: str = 'turns',
) -> Generator[Dict[str, Any], None, None]:
    """Yields unique loop paths using turns-then-distance heap search.

    Options (all off for baseline 'turns'):
      prune_self_cross: drop paths that revisit a node before min_path_length
      astar_bound: skip states where dist + shortest_back_to_start > max
      node_bucket_cap: at most K expansions per (node, distance-bucket)
      order: 'turns' keeps the (turns, dist) heap. 'pleasant' uses
        (turns + discomfort, dist) and the short-crossing exemption.
    """
    if order == 'pleasant' and G.number_of_edges():
        _u, _v, sample = next(iter(G.edges(data=True)))
        if 'stress' not in sample:
            annotate_edge_stress(G)

    if order == 'pleasant':
        queue = [((0.0, 0.0, start_node), PathNode(start_node), 0, 0, 0.0)]
    else:
        queue = [((0, 0.0, start_node), PathNode(start_node), 0)]
    path_masks: Set[int] = set()
    existing_centroids: List[Tuple[float, float]] = []
    bucket_slots: Dict[Tuple[int, int], int] = {}

    back_dist: Dict[int, float] = {}
    if astar_bound:
        try:
            # Undirected shortest path back to start (lollipop stem returns the same way).
            G_undir = G.to_undirected()
            back_dist = nx.single_source_dijkstra_path_length(
                G_undir, start_node, weight='length'
            )
        except Exception as e:
            print(f"A* bound Dijkstra failed ({e}); continuing without bound")
            back_dist = {}

    debugger = None
    if debug_snapshots:
        try:
            from search_debug import SearchDebugger
            debugger = SearchDebugger(
                G, start_node, algorithm_id, graph_name=graph_name,
                snapshot_every=snapshot_every,
            )
        except Exception as e:
            print(f"SearchDebugger init failed ({e})")

    iters = 0
    yielded = 0
    max_dist_reached = 0.0

    try:
        while queue:
            iters += 1
            if iters > MAX_ITERS:
                print(f"Max iterations {MAX_ITERS} reached. Stopping.")
                print(f"  queue={len(queue)}, yielded={yielded}, "
                      f"max_dist_reached={max_dist_reached:.0f}m")
                break

            if order == 'pleasant':
                (_priority, dist, _), curr_node, visited_mask, turns, discomfort = heapq.heappop(queue)
            else:
                (turns, dist, _), curr_node, visited_mask = heapq.heappop(queue)

            if dist > max_dist_reached:
                max_dist_reached = dist

            if debugger is not None:
                debugger.record_pop(curr_node.id)
                debugger.maybe_snapshot(iters, len(queue), max_dist_reached, yielded)

            if iters % PRINT_EVERY == 0:
                print(f"Iter {iters}: queue={len(queue)}, yielded={yielded}, "
                      f"pop_dist={dist:.0f}m, pop_turns={turns}, "
                      f"max_dist_reached={max_dist_reached:.0f}m")

            if dist > max_path_length:
                continue

            if astar_bound and back_dist:
                remaining = back_dist.get(curr_node.id)
                if remaining is not None and dist + remaining > max_path_length:
                    continue

            revisiting = bool(visited_mask & (1 << curr_node.id))

            # Detect loops when current node exists in visited mask
            if revisiting and (dist >= min_path_length):
                path_segment, loop_start = curr_node.traverse_to(curr_node.id)
                if not path_segment or not loop_start:
                    continue

                loop_dist = dist - loop_start.dist
                if loop_dist < min_loop_length:
                    continue

                total_dist = 2 * loop_start.dist + loop_dist
                loop_ratio = loop_dist / total_dist

                if loop_ratio < loop_ratio_floor:
                    continue

                if visited_mask in path_masks:
                    continue

                centroid = None
                out_back_section = loop_start.traverse()
                path = out_back_section + path_segment + out_back_section[::-1]
                if deduplication == 'centroid':
                    centroid = _calculate_path_centroid(G, path)
                    if _is_centroid_too_close(centroid, existing_centroids, min_dist_m=min_dist_m):
                        continue
                elif deduplication == 'jaccard':
                    if not _is_unique_path(visited_mask, path_masks, similarity_ceiling):
                        continue

                total_miles = total_dist * MILES_PER_METER
                elev_profile, climb_ft, _ = compute_elevation_profile(G, path)
                difficulty = compute_difficulty(total_miles, climb_ft)
                reported_discomfort = None
                if order == 'pleasant':
                    _, reported_discomfort = score_pleasant_path(G, path)
                properties = _create_properties(
                    turns, visited_mask, loop_ratio, loop_dist, total_dist, path,
                    climb_ft, difficulty, elev_profile, centroid,
                    discomfort=reported_discomfort,
                )
                geojson_feature = path_to_geojson(G, path, properties)

                if geojson_feature:
                    path_masks.add(visited_mask)
                    if centroid:
                        existing_centroids.append(centroid)
                    yielded += 1
                    if debugger is not None:
                        debugger.record_yield(path)
                    yield geojson_feature

                continue

            # Self-cross before min length: baseline expands (legacy); pruned/capped stop.
            if revisiting:
                if prune_self_cross:
                    continue
                # Legacy: fall through and keep expanding (can produce sub-cycle loops).

            # Cap checked after loop detection so closures are never suppressed.
            if node_bucket_cap is not None:
                slot = (curr_node.id, int(dist // bucket_m))
                bucket_slots[slot] = bucket_slots.get(slot, 0) + 1
                if bucket_slots[slot] > node_bucket_cap:
                    continue

            new_mask = visited_mask | (1 << curr_node.id)

            for neighbor in G.neighbors(curr_node.id):
                if neighbor == getattr(curr_node.prev, 'id', None):
                    continue  # Skip immediate backtracking

                tiebreaker = neighbor
                if order == 'pleasant':
                    prev = curr_node.prev
                    prev_id = prev.id if prev is not None else None
                    prev_prev_id = (
                        prev.prev.id if prev is not None and prev.prev is not None else None
                    )
                    new_turns, new_dist, new_discomfort = pleasant_extend(
                        G, prev_prev_id, prev_id, curr_node.id, neighbor,
                        turns, dist, discomfort,
                    )
                    priority = new_turns + new_discomfort
                    new_node = PathNode(neighbor, curr_node, new_dist)
                    heapq.heappush(queue, (
                        (priority, new_dist, tiebreaker),
                        new_node,
                        new_mask,
                        new_turns,
                        new_discomfort,
                    ))
                else:
                    new_turns, new_dist = weight_function_turns_dist(
                        G, curr_node, neighbor, turns, dist
                    )
                    new_node = PathNode(neighbor, curr_node, new_dist)

                    heapq.heappush(queue, (
                        (new_turns, new_dist, tiebreaker),
                        new_node,
                        new_mask
                    ))
    finally:
        if debugger is not None:
            debugger.finish(iters, len(queue), max_dist_reached, yielded)


def find_paths(
    G: nx.MultiDiGraph,
    start_node: int,
    min_path_length: float,
    max_path_length: float,
    loop_ratio_floor: float,
    similarity_ceiling: float,
    min_loop_length: float = MIN_LOOP_LENGTH_METERS,
    algorithm: str = 'turns',
    deduplication: str = 'centroid',
    min_dist_m: float = 50.0,
    cap_k: Optional[int] = None,
    debug_snapshots: bool = False,
    snapshot_every: int = 25000,
    graph_name: str = 'graph',
) -> Generator[Dict[str, Any], None, None]:
    """Dispatcher: look up strategy in ALGORITHMS and run the turns-first core."""
    algo_id = resolve_algorithm(algorithm)
    opts = ALGORITHMS[algo_id]
    bucket_cap = opts['node_bucket_cap']
    if bucket_cap is not None:
        bucket_cap = int(cap_k) if cap_k is not None else int(bucket_cap)

    print(f"Algorithm: {algo_id} ({opts['label']}) "
          f"prune={opts['prune_self_cross']} astar={opts['astar_bound']} "
          f"cap={bucket_cap} order={opts.get('order', 'turns')}")

    return find_paths_turns_dist(
        G, start_node, min_path_length, max_path_length,
        loop_ratio_floor, similarity_ceiling, min_loop_length,
        deduplication, min_dist_m,
        prune_self_cross=opts['prune_self_cross'],
        astar_bound=opts['astar_bound'],
        node_bucket_cap=bucket_cap,
        algorithm_id=algo_id,
        graph_name=graph_name,
        debug_snapshots=debug_snapshots,
        snapshot_every=snapshot_every,
        order=opts.get('order', 'turns'),
    )
