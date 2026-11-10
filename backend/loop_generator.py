"""Search entry point: strategy registry and the find_paths dispatcher.

Every strategy is the Area Sweep (best-route trees, see loop_tree.py) with a
different configuration. The app uses `tree_guided`. The others are kept for
comparison in tools/bench_search.py and only show up in the UI when the
server runs with LOOP_DEV=1.
"""
import os
from typing import Any, Callable, Dict, Generator, List, Optional

import networkx as nx

DEFAULT_ALGORITHM = 'tree_guided'
DEV = os.environ.get('LOOP_DEV', '').strip().lower() in ('1', 'true', 'yes', 'on')

# tree: keyword arguments for loop_tree.find_paths_tree.
# resumable: the generator parks when a pass runs dry and takes CONTINUE
# requests (pins, areas, roads, "more routes").
# dev: hidden from the UI unless LOOP_DEV=1.
ALGORITHMS: Dict[str, Dict[str, Any]] = {
    'tree_guided': {
        'label': 'Area sweep',
        'tree': {'guided': True},
        'resumable': True,
    },
    'tree_loops': {
        'label': 'Area sweep, one pass (not resumable)',
        'tree': {},
        'dev': True,
    },
    'tree_cover': {
        'label': 'Area sweep: every area first, then every loop',
        'tree': {'policy': 'cover'},
        'dev': True,
    },
    'tree_triangles': {
        'label': 'Area sweep + three-leg loops',
        'tree': {'triangles': True},
        'dev': True,
    },
    'loop_atlas': {
        'label': 'Loop atlas (three-leg, every area, then everything)',
        'tree': {'triangles': True, 'policy': 'cover', 'noise': 1.0},
        'dev': True,
    },
}


def list_algorithms(include_dev: Optional[bool] = None) -> List[Dict[str, Any]]:
    """UI-facing list of {id, label, resumable}. Dev strategies only with LOOP_DEV=1."""
    show_dev = DEV if include_dev is None else include_dev
    return [{'id': k, 'label': v['label'], 'resumable': bool(v.get('resumable'))}
            for k, v in ALGORITHMS.items() if show_dev or not v.get('dev')]


def resolve_algorithm(name: Optional[str]) -> str:
    """Registry key for a requested name. Unknown or removed names (old saved
    settings such as 'pleasant_capped') fall back to the default."""
    return name if name in ALGORITHMS else DEFAULT_ALGORITHM


def is_resumable(name: Optional[str]) -> bool:
    """True when the strategy's generator can take CONTINUE requests."""
    return bool(ALGORITHMS[resolve_algorithm(name)].get('resumable'))


def find_paths(
    G: nx.MultiDiGraph,
    start_node: int,
    min_path_length: float,
    max_path_length: float,
    loop_ratio_floor: float,
    min_loop_length: float = 600.0,
    algorithm: str = DEFAULT_ALGORITHM,
    min_dist_m: float = 50.0,
    road_weights: Optional[Dict[str, float]] = None,
    rural_scale: bool = True,
    surface_preference: str = 'allow',
    should_stop: Optional[Callable[[], bool]] = None,
    explore_weight: Optional[float] = None,
    detour_weight: Optional[float] = None,
    reuse_weight: Optional[float] = None,
    require: Optional[list] = None,
    forbidden: Optional[set] = None,
    known_centroids: Optional[list] = None,
) -> Generator[Dict[str, Any], Optional[dict], None]:
    """Look up the strategy and start its search (a generator of GeoJSON Features).

    Lengths are meters and bound the whole route (stem out, loop, stem back).
    explore_weight / detour_weight / reuse_weight: None keeps the defaults in
    loop_tree.find_paths_tree. surface_preference: 'paved' | 'allow' |
    'gravel' (surface.py). require / forbidden / known_centroids: see
    loop_tree.resolve_selections.
    """
    from loop_tree import find_paths_tree

    algo_id = resolve_algorithm(algorithm)
    opts = ALGORITHMS[algo_id]
    tree_kw = dict(opts.get('tree', {}), tag=algo_id)
    if explore_weight is not None:
        tree_kw['explore_weight'] = float(explore_weight)
    if detour_weight is not None:
        tree_kw['detour_weight'] = float(detour_weight)
    if reuse_weight is not None:
        tree_kw['reuse_weight'] = float(reuse_weight)
    print(f"Algorithm: {algo_id} ({opts['label']}) {tree_kw}")
    return find_paths_tree(
        G, start_node, min_path_length, max_path_length, loop_ratio_floor,
        min_loop_length=min_loop_length, min_dist_m=min_dist_m,
        road_weights=road_weights, rural_scale=rural_scale,
        surface_preference=surface_preference, should_stop=should_stop, require=require, forbidden=forbidden,
        known_centroids=known_centroids, **tree_kw,
    )
