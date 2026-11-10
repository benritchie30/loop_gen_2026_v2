"""Run loop searches headless and compare speed and area coverage.

    python bench_search.py --graph south_charlotte --algos pleasant_capped tree_loops
    python bench_search.py --graph clt_huge --lat 35.2 --lng -80.85 --min 10 --max 20 --png

Coverage counts ~400 m grid cells touched by the loop part of each route
(stem excluded). PNGs go to backend/bench_out/.
"""
import argparse
import math
import os
import pickle
import statistics
import time

from PIL import Image, ImageDraw

import loop_generator as lg
from road_stress import annotate_edge_stress

CELL_M = 400.0
MILE_M = 1609.34


def nearest_node(G, lat, lng):
    best, best_d = None, float('inf')
    k = math.cos(math.radians(lat))
    for n, d in G.nodes(data=True):
        dd = (d['y'] - lat) ** 2 + ((d['x'] - lng) * k) ** 2
        if dd < best_d:
            best, best_d = n, dd
    return best


def loop_cells(feature, lat0):
    """Grid cells of the loop portion, from the elevation profile samples."""
    props = feature['properties']
    prof = props.get('elevation_profile') or []
    total = props.get('total_miles') or 0
    loop = props.get('loop_miles') or 0
    stem = (total - loop) / 2.0
    k = math.cos(math.radians(lat0))
    cells = set()
    for p in prof:
        if stem <= p[0] <= stem + loop:
            cells.add((int(p[2] * 111139 / CELL_M), int(p[3] * 111139 * k / CELL_M)))
    return cells


def draw(G, features, start, path):
    xs = [d['x'] for _, d in G.nodes(data=True)]
    ys = [d['y'] for _, d in G.nodes(data=True)]
    min_x, max_x, min_y, max_y = min(xs), max(xs), min(ys), max(ys)
    size, pad = 1000, 20
    k = math.cos(math.radians((min_y + max_y) / 2))
    span = max((max_x - min_x) * k, max_y - min_y) or 1e-6

    def proj(x, y):
        return (pad + (x - min_x) * k / span * (size - 2 * pad),
                pad + (max_y - y) / span * (size - 2 * pad))

    img = Image.new('RGB', (size, size), (255, 255, 255))
    dr = ImageDraw.Draw(img)
    for u, v in G.edges():
        dr.line([proj(G.nodes[u]['x'], G.nodes[u]['y']), proj(G.nodes[v]['x'], G.nodes[v]['y'])],
                fill=(205, 205, 205), width=1)
    n = max(1, len(features))
    for i, f in enumerate(features):
        t = i / n
        color = (int(40 + 200 * t), int(80 * (1 - t)), int(220 * (1 - t)))
        pts = [proj(x, y) for x, y in f['geometry']['coordinates']]
        dr.line(pts, fill=color, width=2)
    sx, sy = proj(G.nodes[start]['x'], G.nodes[start]['y'])
    dr.ellipse([sx - 7, sy - 7, sx + 7, sy + 7], fill=(39, 174, 96), outline=(0, 0, 0))
    img.save(path)


def draw_tiles(G, features, start, path, cols=4, tile=330):
    """One tile per route: grey base, route colored green (free) to red (busy)."""
    from shapely.geometry import LineString, Point
    feats = features[:cols * 3]
    rows = max(1, (len(feats) + cols - 1) // cols)
    img = Image.new('RGB', (cols * tile, rows * tile), (255, 255, 255))
    dr = ImageDraw.Draw(img)
    stress_at = {}
    for u, v, d in G.edges(data=True):
        stress_at[(u, v)] = d.get('stress') or 0
    sx0, sy0 = G.nodes[start]['x'], G.nodes[start]['y']
    for i, f in enumerate(feats):
        coords = f['geometry']['coordinates']
        xs = [c[0] for c in coords] + [sx0]
        ys = [c[1] for c in coords] + [sy0]
        k = math.cos(math.radians(sy0))
        span = max((max(xs) - min(xs)) * k, max(ys) - min(ys)) or 1e-6
        ox, oy = (i % cols) * tile, (i // cols) * tile
        pad = 14

        def proj(x, y):
            return (ox + pad + (x - min(xs)) * k / span * (tile - 2 * pad),
                    oy + pad + (max(ys) - y) / span * (tile - 2 * pad))

        bx0, bx1 = min(xs), min(xs) + span / k
        by0, by1 = max(ys) - span, max(ys)
        for u, v in G.edges():
            a, b = G.nodes[u], G.nodes[v]
            if bx0 <= a['x'] <= bx1 and by0 <= a['y'] <= by1:
                dr.line([proj(a['x'], a['y']), proj(b['x'], b['y'])], fill=(222, 222, 222))
        path_nodes = f['properties'].get('_path') or []
        for u, v in zip(path_nodes[:-1], path_nodes[1:]):
            if u == v or not G.has_edge(u, v):
                continue
            s = stress_at.get((u, v), 0) * 1609
            t = min(1.0, s / 4.0)
            color = (int(40 + 215 * t), int(160 * (1 - t)), 40)
            geom = lg._oriented_edge_geom(G, u, v)
            dr.line([proj(x, y) for x, y in geom.coords], fill=color, width=3)
        px, py = proj(sx0, sy0)
        dr.ellipse([px - 5, py - 5, px + 5, py + 5], fill=(30, 90, 220))
        p = f['properties']
        dr.text((ox + 4, oy + 2),
                f"#{i + 1} {p['total_miles']:.1f}mi t={p['turns']} d={p.get('discomfort', 0):.1f}",
                fill=(0, 0, 0))
        dr.rectangle([ox, oy, ox + tile - 1, oy + tile - 1], outline=(150, 150, 150))
    img.save(path)


def run(G, start, algo, args, lat0):
    t0 = time.time()
    gen = lg.find_paths(
        G, start, args.min * MILE_M, args.max * MILE_M, args.loop_ratio, 0.7,
        min_loop_length=600, algorithm=algo, min_dist_m=args.min_dist,
        cap_k=args.cap_k, explore_weight=args.explore_w,
        detour_weight=args.detour_w, reuse_weight=args.reuse_w,
    )
    feats, times = [], []
    covered = set()
    cover_curve = []
    try:
        for f in gen:
            feats.append(f)
            times.append(time.time() - t0)
            covered |= loop_cells(f, lat0)
            cover_curve.append(len(covered))
            if len(feats) >= args.num or time.time() - t0 > args.time:
                break
    finally:
        gen.close()
    elapsed = time.time() - t0

    def per_mile(key):
        vals = [f['properties'].get(key) for f in feats]
        vals = [v / f['properties']['total_miles'] for v, f in zip(vals, feats)
                if v is not None and f['properties']['total_miles']]
        return statistics.mean(vals) if vals else float('nan')

    import loop_tree
    E = loop_tree.edge_table(G)
    E.refresh_stress()
    chord, tangent = [], []
    for f in feats:
        p = f['properties']
        if p.get('_path') and p['total_miles']:
            nodes = [n for i, n in enumerate(p['_path']) if i == 0 or n != p['_path'][i - 1]]
            chord.append(lg.score_pleasant_path(G, nodes)[0] / p['total_miles'])
            walk = []
            for u, v in zip(nodes[:-1], nodes[1:]):
                walk.extend(e for e in E.out[u] if E.head[e] == v)
            tangent.append(loop_tree.score_walk(E, walk, len(walk))[1] / p['total_miles'])

    miles = [f['properties']['total_miles'] for f in feats]
    row = {
        'algo': algo,
        'paths': len(feats),
        'secs': round(elapsed, 2),
        'first_s': round(times[0], 2) if times else None,
        'cells': len(covered),
        'cells@10': cover_curve[min(9, len(cover_curve) - 1)] if cover_curve else 0,
        'turns/mi': round(per_mile('turns'), 2),
        'chord_t/mi': round(statistics.mean(chord), 2) if chord else None,
        'junct_t/mi': round(statistics.mean(tangent), 2) if tangent else None,
        'discomf/mi': round(per_mile('discomfort'), 3),
        'miles': f"{min(miles):.1f}-{max(miles):.1f}" if miles else '-',
    }
    return row, feats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--graph', default='south_charlotte')
    ap.add_argument('--lat', type=float)
    ap.add_argument('--lng', type=float)
    ap.add_argument('--algos', nargs='+', default=['pleasant_capped'])
    ap.add_argument('--min', type=float, default=8)
    ap.add_argument('--max', type=float, default=20)
    ap.add_argument('--num', type=int, default=30)
    ap.add_argument('--time', type=float, default=120)
    ap.add_argument('--loop-ratio', type=float, default=0.5)
    ap.add_argument('--min-dist', type=float, default=50)
    ap.add_argument('--cap-k', type=int, default=3)
    ap.add_argument('--explore-w', type=float)
    ap.add_argument('--detour-w', type=float)
    ap.add_argument('--reuse-w', type=float)
    ap.add_argument('--tag', default='', help='suffix for PNG names')
    ap.add_argument('--png', action='store_true')
    args = ap.parse_args()
    lg.PRINT_EVERY = 10 ** 9

    to_geojson = lg.path_to_geojson

    def keep_path(G, path, props):
        props['_path'] = list(path)
        return to_geojson(G, path, props)

    lg.path_to_geojson = keep_path

    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, 'graphs', f'{args.graph}.gpickle'), 'rb') as f:
        G = pickle.load(f)
    if args.lat is None:
        args.lat = statistics.median(d['y'] for _, d in G.nodes(data=True))
        args.lng = statistics.median(d['x'] for _, d in G.nodes(data=True))
    start = nearest_node(G, args.lat, args.lng)
    print(f"{args.graph}: {G.number_of_nodes()} nodes, start {start} "
          f"({args.lat:.5f}, {args.lng:.5f}), {args.min}-{args.max} mi, num={args.num}")

    out_dir = os.path.join(here, 'bench_out')
    rows = []
    for algo in args.algos:
        annotate_edge_stress(G)
        row, feats = run(G, start, algo, args, args.lat)
        rows.append(row)
        print(row)
        if args.png and feats:
            os.makedirs(out_dir, exist_ok=True)
            path = os.path.join(out_dir, f'{args.graph}_{algo}_{args.min:g}-{args.max:g}{args.tag}.png')
            draw(G, feats, start, path)
            tiles = path.replace('.png', '_tiles.png')
            draw_tiles(G, feats, start, tiles)
            print(f'  -> {path}\n  -> {tiles}')

    keys = list(rows[0].keys())
    print()
    print(' | '.join(f'{k:>11}' for k in keys))
    for r in rows:
        print(' | '.join(f'{str(r[k]):>11}' for k in keys))


if __name__ == '__main__':
    main()
