import asyncio
import websockets
import json
import uuid
import os
from graph_manager import GraphManager
from loop_generator import find_paths, list_algorithms

# Configuration
PORT = 8765
GRAPHS_DIR = os.path.join(os.path.dirname(__file__), "graphs")
DEFAULT_GRAPH = "avl_20mi"

# Shared graph manager (singleton)
gm = GraphManager()
gm.set_graphs_dir(GRAPHS_DIR)

async def handler(websocket):
    print(f"Client connected")
    
    # Send available graphs and algorithms on connect
    await send_graphs_list(websocket)
    await send_algorithms_list(websocket)
    
    try:
        async for message in websocket:
            try:
                data = json.loads(message)
                msg_type = data.get("type")
                print(f"Received: {msg_type} {data}")

                if msg_type == "START_GENERATION":
                    await handle_start_generation(websocket, data)
                elif msg_type == "GET_NODES_IN_REGION":
                    await handle_get_nodes_in_region(websocket, data)
                elif msg_type == "GET_NODES_NEAR_POLYLINE":
                    await handle_get_nodes_near_polyline(websocket, data)
                elif msg_type == "LIST_GRAPHS":
                    await send_graphs_list(websocket)
                elif msg_type == "SWITCH_GRAPH":
                    await handle_switch_graph(websocket, data)
                elif msg_type == "CREATE_GRAPH":
                    await handle_create_graph(websocket, data)
                elif msg_type == "GET_GRAPH_NODES":
                    await handle_get_graph_nodes(websocket, data)
                else:
                    print(f"Unknown message type: {msg_type}")

            except json.JSONDecodeError:
                print("Failed to decode JSON")
            except Exception as e:
                print(f"Error handling message: {e}")
                import traceback
                traceback.print_exc()

    except websockets.exceptions.ConnectionClosed:
        print("Client disconnected")

async def send_graphs_list(websocket):
    """Send the list of available graphs to the client."""
    graphs = GraphManager.list_graphs(GRAPHS_DIR)
    active = gm.get_active_name()
    boundaries = GraphManager.get_graph_boundaries(GRAPHS_DIR)
    await websocket.send(json.dumps({
        "type": "GRAPHS_LIST",
        "graphs": graphs,
        "active": active,
        "boundaries": boundaries
    }))

async def send_algorithms_list(websocket):
    """Send selectable pathfinding strategies to the client."""
    await websocket.send(json.dumps({
        "type": "ALGORITHMS_LIST",
        "algorithms": list_algorithms()
    }))

async def handle_switch_graph(websocket, data):
    """Switch to a different graph."""
    name = data.get("name")
    if not name:
        return
    try:
        gm.switch_graph(name)
        await websocket.send(json.dumps({
            "type": "GRAPH_SWITCHED",
            "name": name
        }))
        print(f"Switched to graph: {name}")
    except (FileNotFoundError, ValueError) as e:
        await websocket.send(json.dumps({
            "type": "GRAPH_CREATE_ERROR",
            "error": str(e)
        }))

async def handle_create_graph(websocket, data):
    """Create a new graph from bounding box or polygon coordinates."""
    name = data.get("name")
    boundary_type = data.get("boundary_type", "box")
    # custom_filter = data.get("filter", '["highway"~"trunk|primary|secondary|tertiary"]')
    exclusion_zones = data.get("exclusion_zones", [])

    if not name:
        await websocket.send(json.dumps({
            "type": "GRAPH_CREATE_ERROR",
            "error": "Missing required field: name"
        }))
        return

    # Validate based on boundary type
    if boundary_type == "polygon":
        coordinates = data.get("coordinates")
        if not coordinates or len(coordinates) < 3:
            await websocket.send(json.dumps({
                "type": "GRAPH_CREATE_ERROR",
                "error": "Polygon requires at least 3 coordinate pairs"
            }))
            return
    elif boundary_type == "circle":
        center_lat = data.get("center_lat")
        center_lng = data.get("center_lng")
        radius_miles = data.get("radius_miles")
        if center_lat is None or center_lng is None or radius_miles is None or radius_miles <= 0:
            await websocket.send(json.dumps({
                "type": "GRAPH_CREATE_ERROR",
                "error": "Circle requires center_lat, center_lng, and positive radius_miles"
            }))
            return
    else:
        south = data.get("south")
        west = data.get("west")
        north = data.get("north")
        east = data.get("east")
        if not all([south is not None, west is not None, north is not None, east is not None]):
            await websocket.send(json.dumps({
                "type": "GRAPH_CREATE_ERROR",
                "error": "Missing required fields: south, west, north, east"
            }))
            return

    # Notify client that creation has started
    await websocket.send(json.dumps({
        "type": "GRAPH_CREATING",
        "name": name
    }))

    try:
        loop = asyncio.get_event_loop()
        if boundary_type == "polygon":
            await loop.run_in_executor(
                None,
                lambda: gm.generate_graph_from_polygon(name, coordinates, exclusion_zones=exclusion_zones)
            )
        elif boundary_type == "circle":
            await loop.run_in_executor(
                None,
                lambda: gm.generate_graph_from_circle(name, center_lat, center_lng, radius_miles, exclusion_zones=exclusion_zones)
            )
        else:
            await loop.run_in_executor(
                None,
                lambda: gm.generate_graph(name, south, west, north, east, exclusion_zones=exclusion_zones)
            )

        # Load the newly created graph
        gm.switch_graph(name)

        await websocket.send(json.dumps({
            "type": "GRAPH_CREATED",
            "name": name
        }))

        # Send updated graphs list (includes boundaries)
        await send_graphs_list(websocket)
        print(f"Graph '{name}' created and loaded successfully")

    except Exception as e:
        import traceback
        traceback.print_exc()
        await websocket.send(json.dumps({
            "type": "GRAPH_CREATE_ERROR",
            "error": str(e)
        }))

async def handle_start_generation(websocket, data):
    lat = data.get("lat")
    lng = data.get("lng")
    
    if lat is None or lng is None:
        return

    # 1. Find nearest node
    start_node = gm.get_nearest_node(lat, lng)
    print(f"Start node: {start_node}")

    # 2. Create PathSet ID
    path_set_id = str(uuid.uuid4())

    # 3. Notify frontend
    await websocket.send(json.dumps({
        "type": "PATHSET_CREATED",
        "pathSetId": path_set_id,
        "markerPosition": {"lat": lat, "lng": lng}
    }))

    # 4. Start generation
    G = gm.get_graph()
    
    # Parameters from request with defaults
    min_path_len = (data.get("min_path_len", 2)) * 1609.34 
    max_path_len = (data.get("max_path_len", 50)) * 1609.34
    loop_ratio_floor = data.get("loop_ratio", 0.5)
    similarity_ceiling = data.get("sim_ceiling", 0.7)
    max_paths = data.get("num_paths", 50)
    algorithm = data.get("algorithm", "turns")
    deduplication = data.get("deduplication", "centroid")
    min_dist_m = float(data.get("min_dist_m") or 50.0)
    cap_k = data.get("cap_k")
    cap_k = int(cap_k) if cap_k is not None else None
    debug_snapshots = bool(data.get("debug_snapshots", False))
    snapshot_every = int(data.get("snapshot_every") or 25000)
    graph_name = gm.get_active_name() or "graph"
    
    print(f"Starting generation: {max_paths} paths, Alg: {algorithm}, Dedup: {deduplication}, MinDist: {min_dist_m}m, Range: {min_path_len/1609.34:.1f}-{max_path_len/1609.34:.1f}mi")

    # Run generator
    count = 0

    for path_geojson in find_paths(
        G, 
        start_node, 
        min_path_len, 
        max_path_len, 
        loop_ratio_floor, 
        similarity_ceiling, 
        min_loop_length=600,
        algorithm=algorithm,
        deduplication=deduplication,
        min_dist_m=min_dist_m,
        cap_k=cap_k,
        debug_snapshots=debug_snapshots,
        snapshot_every=snapshot_every,
        graph_name=graph_name,
    ):
        response = {
            "type": "PATH_RECEIVED",
            "pathSetId": path_set_id,
            "path": path_geojson
        }
        await websocket.send(json.dumps(response))
        await asyncio.sleep(0) # Yield control
        
        count += 1
        if count >= max_paths:
            break

    # 5. Complete
    await websocket.send(json.dumps({
        "type": "GENERATION_COMPLETE",
        "pathSetId": path_set_id
    }))

async def handle_get_nodes_in_region(websocket, data):
    coordinates = data.get("coordinates") # [[lat, lng], ...]
    if not coordinates:
        return

    nodes = gm.get_nodes_in_polygon(coordinates)
    mask = gm.create_node_mask(nodes)
    print("region path", nodes, mask)
    
    await websocket.send(json.dumps({
        "type": "NODES_IN_REGION",
        "mask": hex(mask)
    }))

async def handle_get_nodes_near_polyline(websocket, data):
    coordinates = data.get("coordinates") # [[lat, lng], ...]
    if not coordinates:
        return

    # Use edge-based matching for accurate visualization
    nodes, edges_geojson = gm.get_edges_near_polyline(coordinates, buffer_meters=25.0)
    mask = gm.create_node_mask(nodes)
    
    response = {
        "type": "NODES_ALONG_PATH",
        "mask": hex(mask)
    }
    if edges_geojson:
        response["edges"] = edges_geojson
    
    await websocket.send(json.dumps(response))

async def handle_get_graph_nodes(websocket, data):
    """Returns the coordinates of all nodes in the currently active graph."""
    try:
        G = gm.get_graph()
        nodes = []
        for node, data in G.nodes(data=True):
            if 'y' in data and 'x' in data:
                nodes.append([data['y'], data['x']]) # [lat, lng]
                
        await websocket.send(json.dumps({
            "type": "GRAPH_NODES",
            "nodes": nodes
        }))
    except ValueError:
        # Graph might not be loaded yet
        await websocket.send(json.dumps({
            "type": "GRAPH_NODES",
            "nodes": []
        }))

async def main():
    print("Initializing GraphManager...")
    
    # Load default graph
    default_path = os.path.join(GRAPHS_DIR, f"{DEFAULT_GRAPH}.gpickle")
    if os.path.exists(default_path):
        gm.load_graph(default_path)
    else:
        print(f"Default graph not found: {default_path}")
        # Try to load the first available graph
        graphs = GraphManager.list_graphs(GRAPHS_DIR)
        if graphs:
            gm.switch_graph(graphs[0])
            print(f"Loaded first available graph: {graphs[0]}")
        else:
            print("No graphs available! Create one through the UI.")

    available = GraphManager.list_graphs(GRAPHS_DIR)
    print(f"Available graphs: {available}")
    print(f"Active graph: {gm.get_active_name()}")

    print(f"Starting WebSocket server on port {PORT}...")
    async with websockets.serve(handler, "localhost", PORT):
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    asyncio.run(main())
