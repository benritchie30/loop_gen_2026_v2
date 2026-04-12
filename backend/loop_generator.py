
import heapq
import math
from typing import List, Tuple, Dict, Any, Generator, Optional, Set
import networkx as nx
import shapely.geometry
from shapely.ops import linemerge
import srtm
from pyproj import Geod
import functools

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

def _sample_path_geometry(G, path, sample_interval_m=50):
    """Yields (dist_m, lat, lng, bearing) uniformly sampled along path."""
    cumulative_m = 0.0
    
    # Check start
    if not path:
        return

    for u, v in zip(path[:-1], path[1:]):
        if G.has_edge(u, v):
            data = G[u][v][0] if G.is_multigraph() else G[u][v]
            if 'geometry' in data:
                geom = data['geometry']
            else:
                p1 = (G.nodes[u]['x'], G.nodes[u]['y'])
                p2 = (G.nodes[v]['x'], G.nodes[v]['y'])
                geom = shapely.geometry.LineString([p1, p2])
        else:
            continue

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
    centroid: Optional[Tuple[float, float]] = None
) -> Dict[str, Any]:
    """Creates GeoJSON properties dictionary."""
    if centroid is None and elevation_profile:
        # profile items: [dist, elev, lat, lng, bearing]
        # Use simple average of sampled points as centroid
        lats = [p[2] for p in elevation_profile if len(p) >= 4]
        lngs = [p[3] for p in elevation_profile if len(p) >= 4]
        if lats:
            centroid = (round(sum(lats) / len(lats), 6), round(sum(lngs) / len(lngs), 6))

    return {
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

def path_to_geojson(
    G: nx.MultiDiGraph,
    path: List[int],
    properties: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """Converts a sequence of node IDs to a GeoJSON Feature."""
    if not path:
        return None
        
    line_strings = []
    
    for u, v in zip(path[:-1], path[1:]):
        # Retrieve edge geometry if available
        if G.has_edge(u, v):
            # For MultiDiGraph, G[u][v] is a dict of edges
            # We take the first one (0) or iterate to find best fit
            data = G[u][v][0] if G.is_multigraph() else G[u][v]
            
            if 'geometry' in data:
                line_strings.append(data['geometry'])
            else:
                # Create straight line if no geometry
                p1 = shapely.geometry.Point(G.nodes[u]['x'], G.nodes[u]['y'])
                p2 = shapely.geometry.Point(G.nodes[v]['x'], G.nodes[v]['y'])
                line_strings.append(shapely.geometry.LineString([p1, p2]))
                
    if not line_strings:
        return None

    merged = linemerge(line_strings)
    
    return {
        "type": "Feature",
        "geometry": shapely.geometry.mapping(merged),
        "properties": properties
    }


def find_paths_turns_dist(
    G: nx.MultiDiGraph,
    start_node: int,
    min_path_length: float,
    max_path_length: float,
    loop_ratio_floor: float,
    similarity_ceiling: float,
    min_loop_length: float = MIN_LOOP_LENGTH_METERS,
    deduplication: str = 'centroid',
    min_dist_m: float = 50.0
) -> Generator[Dict[str, Any], None, None]:
    """Yields unique loop paths meeting criteria using optimized Dijkstra-like search."""
    # Priority queue: (turns, distance, node_id), current_node, visited_mask
    queue = [((0, 0.0, start_node), PathNode(start_node), 0)]
    path_masks: Set[int] = set()
    existing_centroids: List[Tuple[float, float]] = []

    # print(f"Starting loop detection... range {min_path_length}-{max_path_length}m")
    
    iters = 0
    yielded = 0
    max_dist_reached = 0.0
    MAX_ITERS = 1000000
    PRINT_EVERY = 10000
    # MAX_ITERS = 100000000
    while queue:
        iters += 1
        if iters > MAX_ITERS:
            print(f"Max iterations {MAX_ITERS} reached. Stopping.")
            print(f"  queue={len(queue)}, yielded={yielded}, "
                  f"max_dist_reached={max_dist_reached:.0f}m")
            break

        (turns, dist, _), curr_node, visited_mask = heapq.heappop(queue)

        if dist > max_dist_reached:
            max_dist_reached = dist

        if iters % PRINT_EVERY == 0:
            print(f"Iter {iters}: queue={len(queue)}, yielded={yielded}, "
                  f"pop_dist={dist:.0f}m, pop_turns={turns}, "
                  f"max_dist_reached={max_dist_reached:.0f}m")
        
        # Periodic status print
        # Periodic status print
        # if iters % 1 == 0:
        #    print(f"Iter {iters}: Queue size {len(queue)}, Current dist {dist:.1f}, Turns {turns}")

        if dist > max_path_length:
            continue

        # Detect loops when current node exists in visited mask
        if (visited_mask & (1 << curr_node.id)) and (dist >= min_path_length):
            # print(f"Iter {iters}: Loop detected at node {curr_node.id} traverse:")
            # print(curr_node.traverse())
            path_segment, loop_start = curr_node.traverse_to(curr_node.id)
            if not path_segment or not loop_start:
                # print(f"Iter {iters}: Loop detected but reconstruction failed")
                continue

            loop_dist = dist - loop_start.dist
            # print(f"Loop dist: {loop_dist:.1f}m, dist: {dist:.1f}m, loop_start.dist: {loop_start.dist:.1f}m")
            if loop_dist < min_loop_length:
                # print(f"Iter {iters}: Loop too short ({loop_dist:.1f}m < {min_loop_length}m)")
                continue

            total_dist = 2 * loop_start.dist + loop_dist
            loop_ratio = loop_dist / total_dist
            
            if loop_ratio < loop_ratio_floor:
                # print(f"Iter {iters}: Loop ratio too low ({loop_ratio:.2f})")
                continue

            # Check path uniqueness
            if visited_mask in path_masks:
                # print(f"Iter {iters}: Path mask duplicate")
                continue

            centroid = None
            out_back_section = loop_start.traverse() 
            path = out_back_section + path_segment + out_back_section[::-1] 
            # print(f"Path: {path}")
            if deduplication == 'centroid':
                centroid = _calculate_path_centroid(G, path)
                if _is_centroid_too_close(centroid, existing_centroids, min_dist_m=min_dist_m):
                    # print(f"Iter {iters}: Centroid too close")
                    continue
            elif deduplication == 'jaccard':
                 if not _is_unique_path(visited_mask, path_masks, similarity_ceiling):
                    # print(f"Iter {iters}: Jaccard overlap too high")
                    continue

            # Yield valid path
            # print(f"Iter {iters}: **Yielding valid path** (Turns: {turns}, Dist: {dist:.1f}m)")
            
            total_miles = total_dist * MILES_PER_METER
            elev_profile, climb_ft, _ = compute_elevation_profile(G, path)
            difficulty = compute_difficulty(total_miles, climb_ft)
            properties = _create_properties(turns, visited_mask, loop_ratio, loop_dist, total_dist, path, climb_ft, difficulty, elev_profile, centroid)
            geojson_feature = path_to_geojson(G, path, properties)
            
            if geojson_feature:
                path_masks.add(visited_mask)
                if centroid:
                    existing_centroids.append(centroid)
                yielded += 1
                yield geojson_feature

            continue

        # Expand to neighbors
        new_mask = visited_mask | (1 << curr_node.id)
        
        for neighbor in G.neighbors(curr_node.id):
            if neighbor == getattr(curr_node.prev, 'id', None):
                continue  # Skip immediate backtracking

            new_turns, new_dist = weight_function_turns_dist(G, curr_node, neighbor, turns, dist)
            tiebreaker = neighbor  # Ensures heap can compare elements
            new_node = PathNode(neighbor, curr_node, new_dist)
            
            heapq.heappush(queue, (
                (new_turns, new_dist, tiebreaker),
                new_node,
                new_mask
            ))

def find_paths(
    G: nx.MultiDiGraph,
    start_node: int,
    min_path_length: float,
    max_path_length: float,
    loop_ratio_floor: float,
    similarity_ceiling: float,
    min_loop_length: float = MIN_LOOP_LENGTH_METERS,
    algorithm: str = 'turn',
    deduplication: str = 'centroid',
    min_dist_m: float = 50.0
) -> Generator[Dict[str, Any], None, None]:
    """Dispatcher for path finding algorithms."""
    # Algorithm parameter is ignored as we use turn-only
    return find_paths_turns_dist(G, start_node, min_path_length, max_path_length, loop_ratio_floor, similarity_ceiling, min_loop_length, deduplication, min_dist_m)
