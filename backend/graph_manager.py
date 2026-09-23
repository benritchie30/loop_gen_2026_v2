import pickle
import os
import json
import math
from datetime import datetime
import osmnx as ox
import networkx as nx
from shapely.geometry import Polygon, Point, LineString, MultiLineString, mapping
from shapely.ops import unary_union
import geopandas as gpd
import matplotlib.pyplot as plt
import srtm
from road_stress import annotate_edge_stress

# Overpass highway filter. `unclassified` is the quiet through-street below
# tertiary. `pedestrian` streets are few and pleasant. Footways are omitted:
# they are mostly sidewalks that duplicate the roadway.
DEFAULT_CUSTOM_FILTER = (
    '["highway"~"trunk|trunk_link|primary|primary_link|secondary|secondary_link|'
    'tertiary|tertiary_link|unclassified|residential|living_street|pedestrian|'
    'cycleway|path|bridleway|road"]'
)

# Kept through simplification so stress can see bike facilities, width, and speed.
EDGE_ATTR_WHITELIST = {
    'geometry', 'length', 'name', 'highway', 'ref',
    'cycleway', 'cycleway:left', 'cycleway:right', 'cycleway:both',
    'bicycle', 'lanes', 'maxspeed',
}

class GraphManager:
    _instance = None
    _graph = None
    _active_name = None
    _graphs_dir = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(GraphManager, cls).__new__(cls)
        return cls._instance

    def set_graphs_dir(self, graphs_dir: str):
        """Sets the directory containing graph files."""
        self._graphs_dir = graphs_dir

    def load_graph(self, path: str):
        """Loads the graph from a pickle file."""
        print(f"Loading graph from {path}...")
        try:
            with open(path, 'rb') as f:
                self._graph = pickle.load(f)
            # Derive the active name from the filename
            self._active_name = os.path.splitext(os.path.basename(path))[0]
            num_nodes = self._graph.number_of_nodes()
            num_edges = self._graph.number_of_edges()
            avg_deg = (2 * num_edges) / num_nodes if num_nodes else 0
            print(f"Graph loaded successfully: {self._active_name} "
                  f"({num_nodes} nodes, {num_edges} edges, avg degree {avg_deg:.2f})")

            # Auto-add elevation if missing (migration for old graphs)
            sample_node = next(iter(self._graph.nodes))
            if 'elevation' not in self._graph.nodes[sample_node]:
                print("Graph missing elevation data, adding...")
                self._add_elevation_data(self._graph)
                # Save back with elevation
                with open(path, 'wb') as f:
                    pickle.dump(self._graph, f, pickle.HIGHEST_PROTOCOL)
                print("Elevation data added and graph re-saved.")

            # After any elevation rewrite, so stress stays in memory only.
            self._ensure_edge_stress()
        except Exception as e:
            print(f"Error loading graph: {e}")
            raise

    def _ensure_edge_stress(self):
        """Annotate highway-class stress in memory when a saved graph has none.

        Not written back: scoring is cheap, unlike the elevation migration.
        Older graphs only have `highway`, so bike-lane and speed modifiers
        wait until the graph is downloaded again.
        """
        G = self._graph
        if G is None or G.number_of_edges() == 0:
            return
        _u, _v, sample = next(iter(G.edges(data=True)))
        if 'stress' in sample:
            return
        print("Graph missing edge stress, annotating from highway tags...")
        annotate_edge_stress(G)

    def switch_graph(self, name: str):
        """Switch to a different graph by name (without .gpickle extension)."""
        if self._graphs_dir is None:
            raise ValueError("Graphs directory not set. Call set_graphs_dir() first.")
        path = os.path.join(self._graphs_dir, f"{name}.gpickle")
        if not os.path.exists(path):
            raise FileNotFoundError(f"Graph file not found: {path}")
        self.load_graph(path)

    def get_active_name(self) -> str:
        """Returns the name of the currently loaded graph."""
        return self._active_name

    @staticmethod
    def list_graphs(graphs_dir: str) -> list:
        """Lists available graph names (without extension) in the given directory."""
        if not os.path.isdir(graphs_dir):
            return []
        return sorted([
            os.path.splitext(f)[0]
            for f in os.listdir(graphs_dir)
            if f.endswith('.gpickle')
        ])

    @staticmethod
    def get_graph_boundaries(graphs_dir: str) -> dict:
        """Returns {name: boundary_data} for all graphs that have .boundary.json files."""
        boundaries = {}
        if not os.path.isdir(graphs_dir):
            return boundaries
        for f in os.listdir(graphs_dir):
            if f.endswith('.boundary.json'):
                name = f.replace('.boundary.json', '')
                try:
                    with open(os.path.join(graphs_dir, f), 'r') as fh:
                        boundaries[name] = json.load(fh)
                except Exception:
                    pass
        return boundaries

    def _save_boundary(self, name: str, boundary_data: dict, exclusion_zones: list = None):
        """Saves boundary metadata as a sidecar JSON file."""
        if exclusion_zones:
            boundary_data['exclusion_zones'] = exclusion_zones
        path = os.path.join(self._graphs_dir, f"{name}.boundary.json")
        with open(path, 'w') as f:
            json.dump(boundary_data, f)

    def get_graph(self):
        """Returns the loaded graph instance."""
        if self._graph is None:
            raise ValueError("Graph not loaded. Call load_graph() first.")
        return self._graph

    def get_nearest_node(self, lat: float, lng: float):
        """Finds the nearest node to the given coordinates."""
        G = self.get_graph()
        return ox.nearest_nodes(G, lng, lat)

    def get_nodes_in_polygon(self, coordinates: list) -> list:
        """
        Finds all nodes within a polygon defined by coordinates.
        coordinates: List of [lat, lng] pairs (note: check if your polygon needs [lng, lat])
        Returns a list of node IDs.
        """
        G = self.get_graph()
        
        # Ensure coordinates are in the correct order for Polygon (lng, lat)
        # Frontend sends [lat, lng], so we swap
        poly_coords = [(lng, lat) for lat, lng in coordinates]
        
        polygon = Polygon(poly_coords)
        
        nodes_in_region = []
        
        # Basic implementation: check every node. Optimization: use spatial index if needed.
        # For typical graphs (thousands of nodes), this might be slow.
        # Better: use ox.graph_to_gdfs to get nodes as GeoDataFrame, then sjoin or within.
        
        gdf_nodes = ox.graph_to_gdfs(G, nodes=True, edges=False)
        
        # Create a GeoSeries with the polygon
        poly_gdf = gpd.GeoSeries([polygon], crs=gdf_nodes.crs) # Assumes graph crs matches if not specified, usually lat/lon is 4326

        # Actually, ox graphs usually have crs. 
        # If coordinates are lat/lng, we assume EPSG:4326.
        
        # Check if nodes are within the polygon
        # This is strictly for "drawing" feature which returns a mask of nodes.
        
        # Let's do a simple bounding box check first if we care about perf, 
        # but geopandas `within` is reasonably optimized.
        
        # However, checking every node might be heavy.
        # Let's stick to the simplest correct method first.
        
        # Create geometry for all nodes
        # filtered = gdf_nodes[gdf_nodes.geometry.within(polygon)]
        
        # Actually, let's just use the geometry from the GDF
        mask = gdf_nodes.intersects(polygon)
        filtered_nodes = gdf_nodes[mask]
        
        return filtered_nodes.index.tolist()

    def get_nodes_near_polyline(self, coordinates: list, buffer_meters: float = 300.0) -> list:
        """
        Finds all nodes within a certain distance of a polyline.
        coordinates: List of [lat, lng] pairs
        buffer_meters: Distance in meters to buffer the line (approximate if using varying projection, 
                       but for small areas simple degree conversion or treating as meters if projected is needed.
                       However, osmnx graphs are usually unprojected (lat/lon). 
                       Buffering lat/lon by 'meters' requires projection.)
        """
        G = self.get_graph()
        
        # Swap because frontend sends [lat, lng], shapely wants (lng, lat)
        line_coords = [(lng, lat) for lat, lng in coordinates]
        line = LineString(line_coords)
        
        # Project to UTM for accurate buffering in meters
        # We can use the graph's UTM projection if it has one, or project the geometry.
        # Simple heuristic: 1 degree approx 111km. 20m is approx 0.00018 degrees.
        # Let's use a rough degree approximation for speed/simplicity if we don't want to reproject everything.
        # 20m / 111000m/deg ~= 0.00018
        buffer_degrees = buffer_meters / 111111.0
        
        polygon = line.buffer(buffer_degrees)
        
        gdf_nodes = ox.graph_to_gdfs(G, nodes=True, edges=False)
        
        mask = gdf_nodes.intersects(polygon)
        filtered_nodes = gdf_nodes[mask]
        
        return filtered_nodes.index.tolist()

    def get_edges_near_polyline(self, coordinates: list, buffer_meters: float = 25.0):
        """
        Finds shortest path between two clicked points on the graph.
        Snaps both to nearest nodes, returns path nodes + edge GeoJSON.
        """
        G = self.get_graph()

        if len(coordinates) < 2:
            return [], None

        start_lat, start_lng = coordinates[0]
        end_lat, end_lng = coordinates[-1]

        start_node = ox.nearest_nodes(G, start_lng, start_lat)
        end_node = ox.nearest_nodes(G, end_lng, end_lat)

        if start_node == end_node:
            return [start_node], None

        try:
            path = nx.shortest_path(G, start_node, end_node, weight='length')
        except nx.NetworkXNoPath:
            print(f"No path found between {start_node} and {end_node}")
            return [], None

        # Extract edge geometries along the path
        edge_geometries = []
        for u, v in zip(path[:-1], path[1:]):
            if G.has_edge(u, v):
                data = G[u][v][0] if G.is_multigraph() else G[u][v]
                if 'geometry' in data:
                    edge_geometries.append(data['geometry'])
                else:
                    p1 = (G.nodes[u]['x'], G.nodes[u]['y'])
                    p2 = (G.nodes[v]['x'], G.nodes[v]['y'])
                    edge_geometries.append(LineString([p1, p2]))

        edges_geojson = None
        if edge_geometries:
            multi = MultiLineString(edge_geometries)
            edges_geojson = {
                "type": "Feature",
                "geometry": mapping(multi),
                "properties": {}
            }

        return path, edges_geojson

    def create_node_mask(self, node_ids: list) -> int:
        """Creates a bitmask from a list of node IDs."""
        mask = 0
        for node_id in node_ids:
            mask |= (1 << node_id)
        return mask

    @staticmethod
    def _coerce_name(name_data):
        """Normalize an OSM name or ref into a string, a list, or None."""
        if name_data is None:
            return None
        if isinstance(name_data, str):
            if ';' in name_data:
                parts = [part.strip() for part in name_data.split(';') if part.strip()]
                if not parts:
                    return None
                return parts[0] if len(parts) == 1 else parts
            text = name_data.strip()
            return text or None
        if isinstance(name_data, (list, tuple)):
            flat = []
            for item in name_data:
                coerced = GraphManager._coerce_name(item)
                if coerced is None:
                    continue
                if isinstance(coerced, list):
                    flat.extend(coerced)
                else:
                    flat.append(coerced)
            if not flat:
                return None
            return flat[0] if len(flat) == 1 else flat
        text = str(name_data).strip()
        return text or None

    @staticmethod
    def _update_edge_names(G):
        """Keep street names. Use `ref` only when the edge has no name."""
        for u, v, data in G.edges(data=True):
            existing = GraphManager._coerce_name(data.get('name')) if 'name' in data else None
            if existing is not None:
                data['name'] = existing
            else:
                data['name'] = GraphManager._coerce_name(data.get('ref'))
            if 'ref' in data:
                del data['ref']

    @staticmethod
    def _relabel_graph(G):
        """Relabels graph nodes to sequential integers starting from 0."""
        mapping = {old_id: new_id for new_id, old_id in enumerate(G.nodes)}
        return nx.relabel_nodes(G, mapping)

    @staticmethod
    def _remove_node_and_merge(G, u, n, v):
        """Removes intermediate node n and merges edges u->n and n->v into u->v."""
        edges_u_n = G.get_edge_data(u, n)
        if edges_u_n is None:
            G.remove_node(n)
            return False
        attr_u = edges_u_n[list(edges_u_n.keys())[0]]

        edges_n_v = G.get_edge_data(n, v)
        if edges_n_v is None:
            G.remove_node(n)
            return False
        attr_v = edges_n_v[list(edges_n_v.keys())[0]]

        # Merge geometry
        geo1 = attr_u.get('geometry')
        geo2 = attr_v.get('geometry')
        if not geo1:
            geo1 = LineString([(G.nodes[u]['x'], G.nodes[u]['y']),
                               (G.nodes[n]['x'], G.nodes[n]['y'])])
        if not geo2:
            geo2 = LineString([(G.nodes[n]['x'], G.nodes[n]['y']),
                               (G.nodes[v]['x'], G.nodes[v]['y'])])

        def _orient(coords, origin):
            if len(coords) < 2:
                return coords
            start, end = coords[0], coords[-1]
            d_start = (start[0] - origin[0]) ** 2 + (start[1] - origin[1]) ** 2
            d_end = (end[0] - origin[0]) ** 2 + (end[1] - origin[1]) ** 2
            return coords[::-1] if d_end < d_start else coords

        u_xy = (G.nodes[u]['x'], G.nodes[u]['y'])
        n_xy = (G.nodes[n]['x'], G.nodes[n]['y'])
        coords1 = _orient(list(geo1.coords), u_xy)
        coords2 = _orient(list(geo2.coords), n_xy)

        fwd_geom = LineString(coords1[:-1] + coords2)
        l1 = float(attr_u.get('length') or 0)
        l2 = float(attr_v.get('length') or 0)
        # Highway / name / bike tags follow the longer piece. Stress is the
        # length-weighted average so a short busy segment is not forgotten.
        longer = attr_v if l2 > l1 else attr_u
        new_attr = longer.copy()
        new_attr['geometry'] = fwd_geom
        new_attr['length'] = l1 + l2
        s1 = float(attr_u.get('stress') or 0)
        s2 = float(attr_v.get('stress') or 0)
        total_l = l1 + l2
        new_attr['stress'] = ((s1 * l1 + s2 * l2) / total_l) if total_l > 0 else max(s1, s2)

        rev_attr = new_attr.copy()
        rev_attr['geometry'] = LineString(list(fwd_geom.coords)[::-1])

        G.remove_node(n)
        G.add_edge(u, v, **new_attr)
        G.add_edge(v, u, **rev_attr)
        return True

    @staticmethod
    def _keep_shortest_edge(G):
        """Keeps only the shortest edge between any pair of nodes in a MultiDiGraph."""
        edges_to_remove = []
        for u in G.nodes():
            for v in G[u]:
                if len(G[u][v]) > 1:
                    min_len = float('inf')
                    best_key = None
                    for k, data in G[u][v].items():
                        length = data.get('length', float('inf'))
                        if length < min_len:
                            min_len = length
                            best_key = k
                    for k in G[u][v]:
                        if k != best_key:
                            edges_to_remove.append((u, v, k))
        if edges_to_remove:
            G.remove_edges_from(edges_to_remove)
            print(f"  Removed {len(edges_to_remove)} redundant multi-edges.")

    @staticmethod
    def _debug_plot_graph(G, title, filepath, highlight_nodes=None):
        """Plot nodes+edges; red overlay = about to be removed/merged. Saves PNG and tries to show a window."""
        highlight_nodes = set(highlight_nodes or [])
        print(f"  [plot] {title}")
        print(f"         -> {filepath}")
        if G.number_of_nodes() == 0:
            print("  [plot] skip (empty graph)")
            return

        os.makedirs(os.path.dirname(filepath), exist_ok=True)

        try:
            fig, ax = ox.plot_graph(
                G,
                node_color='#2980b9',
                node_size=8,
                edge_color='#7f8c8d',
                edge_linewidth=1.0,
                bgcolor='white',
                figsize=(12, 12),
                show=False,
                close=False,
            )
            if highlight_nodes:
                H = G.subgraph(highlight_nodes)
                if H.number_of_nodes() > 0:
                    ox.plot_graph(
                        H,
                        ax=ax,
                        node_color='#c0392b',
                        node_size=22,
                        edge_color='#e74c3c',
                        edge_linewidth=2.0,
                        bgcolor='white',
                        show=False,
                        close=False,
                    )
            ax.set_title(title, fontsize=11)
            fig.savefig(filepath, dpi=150, bbox_inches='tight')
            plt.show(block=True)
            plt.close(fig)
        except Exception as e:
            print(f"  [plot] failed ({e}).")
            try:
                plt.close('all')
            except Exception:
                pass

    @staticmethod
    def _degree2_nodes(G):
        G_undir = G.to_undirected()
        return {n for n, d in G_undir.degree() if d == 2}

    @staticmethod
    def _consolidation_cluster_nodes(G, tolerance=15):
        """Nodes whose projected buffers overlap (approx what consolidate_intersections merges)."""
        if G.number_of_nodes() < 2:
            return set()
        G_proj = ox.project_graph(G)
        gdf = ox.graph_to_gdfs(G_proj, nodes=True, edges=False)
        undir = G.to_undirected()
        # dead_ends=False in consolidate_intersections skips degree-1 nodes
        eligible = gdf.loc[[n for n in gdf.index if undir.degree(n) > 1]]
        if eligible.empty:
            return set()
        buffered = eligible.buffer(tolerance)
        merged = unary_union(list(buffered.geometry))
        geoms = list(merged.geoms) if hasattr(merged, 'geoms') else [merged]
        clusters = gpd.GeoDataFrame(geometry=geoms, crs=eligible.crs)
        joined = gpd.sjoin(eligible, clusters, predicate='intersects')
        sizes = joined.groupby('index_right').size()
        multi = set(sizes[sizes > 1].index)
        if not multi:
            return set()
        return set(joined[joined['index_right'].isin(multi)].index)

    @staticmethod
    def _compute_biconnected_prune_nodes(G, min_component_length):
        """Nodes dropped by block-cut pruning, including isolates that would follow. None = skip prune."""
        G_undir = G.to_undirected()
        components = list(nx.biconnected_components(G_undir))

        comp_lengths = []
        for comp in components:
            comp_set = set(comp)
            total_length = 0
            seen_edges = set()
            for u in comp_set:
                for v in G_undir.neighbors(u):
                    if v in comp_set:
                        edge_pair = (min(u, v), max(u, v))
                        if edge_pair not in seen_edges:
                            seen_edges.add(edge_pair)
                            edge_dict = G_undir[u][v]
                            min_length = min(
                                d.get('length', 0) for d in edge_dict.values()
                            ) if edge_dict else 0
                            total_length += min_length
            comp_lengths.append(total_length)

        art_points = set(nx.articulation_points(G_undir))
        block_cut_tree = nx.Graph()
        for i, comp in enumerate(components):
            block_id = f"B{i}"
            is_large = len(comp) >= 3 and comp_lengths[i] >= min_component_length
            block_cut_tree.add_node(block_id, type='block', index=i,
                                    length=comp_lengths[i], is_large=is_large)
            for ap in art_points:
                if ap in comp:
                    block_cut_tree.add_edge(block_id, ap)
                    block_cut_tree.nodes[ap]['type'] = 'cut_vertex'

        large_blocks = [n for n in block_cut_tree.nodes()
                        if block_cut_tree.nodes[n].get('is_large')]

        if not large_blocks:
            return None

        large_set = set(large_blocks)

        def mark_needed_iterative(root):
            parent = {root: None}
            order = []
            stack = [root]
            while stack:
                node = stack.pop()
                order.append(node)
                for neighbor in block_cut_tree.neighbors(node):
                    if neighbor not in parent:
                        parent[neighbor] = node
                        stack.append(neighbor)
            needed = {}
            for node in reversed(order):
                needed[node] = node in large_set
                for neighbor in block_cut_tree.neighbors(node):
                    if parent.get(neighbor) == node:
                        if needed.get(neighbor, False):
                            needed[node] = True
                if needed[node]:
                    block_cut_tree.nodes[node]['keep'] = True

        visited_bct = set()
        for lb in large_blocks:
            if lb not in visited_bct:
                tree_component = set(nx.node_connected_component(block_cut_tree, lb))
                visited_bct.update(tree_component)
                mark_needed_iterative(lb)

        valid_nodes = set()
        for node in block_cut_tree.nodes():
            node_data = block_cut_tree.nodes[node]
            if node_data.get('keep'):
                if node_data.get('type') == 'block':
                    valid_nodes.update(components[node_data['index']])
                else:
                    valid_nodes.add(node)

        nodes_to_remove = set(G.nodes()) - valid_nodes
        soon_isolates = set()
        for n in G.nodes():
            if n in nodes_to_remove:
                continue
            nbrs = set(G.predecessors(n)) | set(G.successors(n))
            if not nbrs or nbrs <= nodes_to_remove:
                soon_isolates.add(n)
        return nodes_to_remove | soon_isolates

    @staticmethod
    def _prune_graph_biconnected(G, min_component_length=3000):
        """Prunes dead-end branches and tiny loops using block-cut tree analysis."""
        print(f"  Pruning graph (min_component_length={min_component_length}m)...")
        initial_nodes = len(G.nodes)

        nodes_to_remove = GraphManager._compute_biconnected_prune_nodes(G, min_component_length)
        if nodes_to_remove is None:
            print("  WARNING: No large components found. Skipping pruning.")
            return set()

        G.remove_nodes_from(nodes_to_remove)
        isolates = list(nx.isolates(G))
        if isolates:
            G.remove_nodes_from(isolates)

        print(f"  Pruned: {initial_nodes} -> {len(G.nodes)} nodes")
        return nodes_to_remove | set(isolates)

    @staticmethod
    def _simplify_graph_topology(G):
        """Merges degree-2 intermediate nodes, preserving road geometry."""
        print("  Simplifying topology (merging degree-2 nodes)...")
        initial_nodes = len(G.nodes)
        nodes_removed = 0

        while True:
            G_undir = G.to_undirected()
            degree_2_nodes = [n for n, d in G_undir.degree() if d == 2]

            removed_in_this_pass = 0
            for n in degree_2_nodes:
                if n not in G:
                    continue
                neighbors = list(G_undir.neighbors(n))
                if len(neighbors) == 2:
                    u, v = neighbors[0], neighbors[1]
                    if u != v and u in G and v in G:
                        if G.has_edge(u, n) and G.has_edge(n, v):
                            success = GraphManager._remove_node_and_merge(G, u, n, v)
                        elif G.has_edge(v, n) and G.has_edge(n, u):
                            success = GraphManager._remove_node_and_merge(G, v, n, u)
                        else:
                            success = False
                        if success:
                            removed_in_this_pass += 1
                            nodes_removed += 1

            if removed_in_this_pass == 0:
                break

        print(f"  Topology simplified: {initial_nodes} -> {len(G.nodes)} nodes ({nodes_removed} removed)")

    @staticmethod
    def _process_graph(G, debug_name="graph"):
        """Full graph simplification pipeline: prune, consolidate, simplify."""
        print(f"\n=== Processing Graph ({len(G.nodes)} nodes, {len(G.edges)} edges) ===")

        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        plot_dir = os.path.join(os.path.dirname(__file__), "simp_debug", f"{debug_name}_{stamp}")
        os.makedirs(plot_dir, exist_ok=True)
        print(f"  Simplification plots: {plot_dir}")
        print("  Close each plot window to continue to the next stage.")

        def plot(filename, title, graph, highlight=None):
            GraphManager._debug_plot_graph(
                graph, title, os.path.join(plot_dir, filename), highlight
            )

        # 1. Strip non-essential edge attributes
        whitelist = EDGE_ATTR_WHITELIST
        for u, v, k, data in G.edges(keys=True, data=True):
            for key in [k for k in list(data.keys()) if k not in whitelist]:
                data.pop(key)

        plot("00_initial.png", "Initial graph (after OSM download + attr strip)", G)

        # 2. Prune dead ends and tiny loops
        min_comp = 3000
        prune_nodes = GraphManager._compute_biconnected_prune_nodes(G, min_comp)
        if prune_nodes is None:
            print("  WARNING: No large components found. Skipping pruning.")
            plot("01_prune_skipped.png", "Prune skipped (no large components)", G)
        else:
            plot(
                "01_prune_will_remove.png",
                f"Prune (min_component_length={min_comp}m): red = nodes/edges to remove",
                G,
                prune_nodes,
            )
            GraphManager._prune_graph_biconnected(G, min_component_length=min_comp)
            plot("02_prune_after.png", "After prune", G)

        # 3. Consolidate complex intersections
        # print("  Consolidating intersections...")
        # cons_nodes = GraphManager._consolidation_cluster_nodes(G, tolerance=25)
        # plot(
        #     "03_consolidate_will_merge.png",
        #     "Consolidate intersections (15m): red = nodes in merge clusters",
        #     G,
        #     cons_nodes,
        # )
        # G_proj = ox.project_graph(G)
        # G_proj_cons = ox.simplification.consolidate_intersections(
        #     G_proj, rebuild_graph=True, tolerance=25, dead_ends=False
        # )
        # G = ox.project_graph(G_proj_cons, to_crs='epsg:4326')
        # print(f"  After consolidation: {len(G.nodes)} nodes, {len(G.edges)} edges")
        # plot("04_consolidate_after.png", "After intersection consolidation", G)

        # 4. Keep only shortest edge between node pairs
        # GraphManager._keep_shortest_edge(G)

        # 5. Score edges before degree-2 merge so each block keeps its own class.
        annotate_edge_stress(G)

        # 6. Merge degree-2 nodes
        deg2 = GraphManager._degree2_nodes(G)
        plot(
            "05_topology_will_merge.png",
            "Topology simplify: red = degree-2 nodes to merge",
            G,
            deg2,
        )
        GraphManager._simplify_graph_topology(G)
        plot("06_topology_after.png", "After merging degree-2 nodes", G)

        # 7. Remove self-loops and isolates
        # G.remove_edges_from(list(nx.selfloop_edges(G)))
        isolates = list(nx.isolates(G))
        if isolates:
            plot(
                "07_isolates_will_remove.png",
                "Isolates: red = nodes to remove",
                G,
                isolates,
            )
        G.remove_nodes_from(isolates)
        plot("08_final.png", "After isolate removal (final simplified graph)", G)

        print(f"=== Processing complete: {len(G.nodes)} nodes, {len(G.edges)} edges ===\n")
        return G

    def _apply_exclusions(self, G, exclusion_zones):
        """Removes nodes/edges that fall within exclusion polygons."""
        if not exclusion_zones:
            return G

        print(f"Applying {len(exclusion_zones)} exclusion zones...")
        initial_nodes = len(G.nodes)
        
        # Convert exclusion zones (list of list of [lat, lng]) to Shapely Polygons
        polygons = []
        for zone in exclusion_zones:
            # Swap to (lng, lat) for Shapely
            poly_coords = [(lng, lat) for lat, lng in zone]
            if len(poly_coords) >= 3:
                polygons.append(Polygon(poly_coords))
        
        if not polygons:
            return G

        # Identify nodes to remove
        nodes_to_remove = set()
        for node, data in G.nodes(data=True):
            # Check against all polygons
            pt = Point(data['x'], data['y'])
            for poly in polygons:
                if poly.contains(pt):
                    nodes_to_remove.add(node)
                    break
        
        if nodes_to_remove:
            G.remove_nodes_from(nodes_to_remove)
            print(f"Removed {len(nodes_to_remove)} nodes based on exclusion zones.")
            
        # Clean up isolated nodes if any (OSMnx usually handles this but good to be safe)
        # G = ox.utils_graph.remove_isolated_nodes(G)
        
        print(f"Graph filtered: {initial_nodes} -> {len(G.nodes)} nodes.")
        return G

    def _finalize_and_save_graph(self, G, name: str, boundary_metadata: dict, exclusion_zones: list = None):
        """Helper method to process, attach metadata, and save a generated graph."""
        if self._graphs_dir is None:
            raise ValueError("Graphs directory not set.")

        G = self._apply_exclusions(G, exclusion_zones)
        G = self._process_graph(G, debug_name=name)
        G = self._relabel_graph(G)
        self._update_edge_names(G)
        self._add_elevation_data(G)

        os.makedirs(self._graphs_dir, exist_ok=True)
        file_path = os.path.join(self._graphs_dir, f"{name}.gpickle")
        with open(file_path, 'wb') as f:
            pickle.dump(G, f, pickle.HIGHEST_PROTOCOL)

        # Save boundary metadata
        self._save_boundary(name, boundary_metadata, exclusion_zones)

        print(f"Graph saved at: {file_path}")
        return name

    @staticmethod
    def _canonical_bbox(south, west, north, east):
        """Order corners geographically. Handles swapped NW/SE handles from the UI."""
        south, north = min(south, north), max(south, north)
        west, east = min(west, east), max(west, east)
        return south, west, north, east

    @staticmethod
    def _osmnx_bbox_tuple(south, west, north, east):
        """OSMnx 1.x wants (north, south, east, west); 2.x wants (left, bottom, right, top)."""
        major = int(ox.__version__.split(".")[0])
        if major >= 2:
            return (west, south, east, north)
        return (north, south, east, west)

    def generate_graph(self, name: str, south: float, west: float, north: float, east: float,
                       custom_filter: str = DEFAULT_CUSTOM_FILTER,
                       exclusion_zones: list = None):
        """Downloads, processes, and saves a new graph from OSMnx using bounding box."""
        south, west, north, east = self._canonical_bbox(south, west, north, east)
        print(f"Generating graph '{name}' for bbox: S={south}, W={west}, N={north}, E={east}")

        G = ox.graph_from_bbox(
            bbox=self._osmnx_bbox_tuple(south, west, north, east),
            network_type='all',
            simplify=True,
            custom_filter=custom_filter
        )
        
        boundary_metadata = {
            'type': 'box',
            'north': north, 'south': south, 'east': east, 'west': west
        }
        return self._finalize_and_save_graph(G, name, boundary_metadata, exclusion_zones)

    def generate_graph_from_polygon(self, name: str, coordinates: list,
                                     custom_filter: str = DEFAULT_CUSTOM_FILTER,
                                     exclusion_zones: list = None):
        """Downloads, processes, and saves a new graph from OSMnx using polygon boundary.
        coordinates: list of [lat, lng] pairs."""
        # Shapely uses (lng, lat) order
        poly = Polygon([(lng, lat) for lat, lng in coordinates])
        print(f"Generating graph '{name}' from polygon with {len(coordinates)} vertices")

        G = ox.graph_from_polygon(
            poly,
            network_type='all',
            simplify=True,
            custom_filter=custom_filter
        )

        boundary_metadata = {
            'type': 'polygon',
            'coordinates': coordinates
        }
        return self._finalize_and_save_graph(G, name, boundary_metadata, exclusion_zones)

    def generate_graph_from_circle(self, name: str, center_lat: float, center_lng: float,
                                    radius_miles: float,
                                    custom_filter: str = DEFAULT_CUSTOM_FILTER,
                                    exclusion_zones: list = None):
        """Downloads, processes, and saves a new graph from a circular boundary.
        radius_miles: radius in miles."""
        print(f"Generating graph '{name}' from circle: center=({center_lat}, {center_lng}), radius={radius_miles}mi")
        # Convert radius in miles to meters for graph_from_point (1 mile = 1609.344 meters)
        dist_meters = radius_miles * 1609.344
        center_point = (center_lat, center_lng)
        
        G = ox.graph_from_point(
            center_point,
            dist=dist_meters,
            network_type='all',
            simplify=True,
            custom_filter=custom_filter
        )

        boundary_metadata = {
            'type': 'circle',
            'center': [center_lat, center_lng],
            'radius_miles': radius_miles
        }
        return self._finalize_and_save_graph(G, name, boundary_metadata, exclusion_zones)

    @staticmethod
    def _add_elevation_data(G):
        """Adds elevation (meters) to each node using SRTM data.
        SRTM tiles are automatically downloaded and cached on first use."""
        print("Adding elevation data from SRTM...")
        elevation_data = srtm.get_data()
        missing = 0
        for node, data in G.nodes(data=True):
            lat = data.get('y', 0)
            lng = data.get('x', 0)
            elev = elevation_data.get_elevation(lat, lng)
            data['elevation'] = elev if elev is not None else 0
            if elev is None:
                missing += 1
        if missing > 0:
            print(f"Warning: {missing} nodes had no SRTM elevation data (set to 0).")
        print(f"Elevation added to {len(G.nodes) - missing}/{len(G.nodes)} nodes.")
