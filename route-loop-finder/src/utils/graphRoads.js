/**
 * Client-side index over the active graph's roads (GRAPH_EDGES records:
 * { u, v, name, pts: [[lat, lng], ...] }). Serves the Road tool: nearest edge
 * under the cursor, the connected run of same-named edges ("the whole road"),
 * and the edges inside a drawn shape. The server applies the same tests when
 * it resolves selections, so what you see painted is what the search gets.
 */
import { selectionContains } from './routeSelections';

const M_PER_DEG = 111320;
const CELL_M = 80;
const SAMPLE_M = 20;

export function edgeKey(u, v) {
    return u < v ? `${u}-${v}` : `${v}-${u}`;
}

function cellOf(lat, lng, cos) {
    return `${Math.floor((lng * M_PER_DEG * cos) / CELL_M)},${Math.floor((lat * M_PER_DEG) / CELL_M)}`;
}

/** Points every SAMPLE_M along a polyline, both ends included. */
export function samplePolyline(pts, cos, stepM = SAMPLE_M) {
    const out = [];
    if (!pts.length) return out;
    out.push(pts[0]);
    let carry = 0;
    for (let i = 1; i < pts.length; i++) {
        const [aLat, aLng] = pts[i - 1];
        const [bLat, bLng] = pts[i];
        const seg = Math.hypot((bLat - aLat) * M_PER_DEG, (bLng - aLng) * M_PER_DEG * cos);
        if (seg <= 0) continue;
        let pos = stepM - carry;
        while (pos < seg) {
            const f = pos / seg;
            out.push([aLat + (bLat - aLat) * f, aLng + (bLng - aLng) * f]);
            pos += stepM;
        }
        carry = seg - (pos - stepM);
    }
    out.push(pts[pts.length - 1]);
    return out;
}

/** Distance in metres from a point to a polyline, and the closest point on it. */
export function distanceToPolyline(pts, lat, lng, cos) {
    let best = Infinity;
    let bestLat = lat;
    let bestLng = lng;
    const px = lng * cos;
    const py = lat;
    for (let i = 1; i < pts.length; i++) {
        const ax = pts[i - 1][1] * cos;
        const ay = pts[i - 1][0];
        const bx = pts[i][1] * cos;
        const by = pts[i][0];
        const vx = bx - ax;
        const vy = by - ay;
        const den = vx * vx + vy * vy;
        const t = den === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / den));
        const qx = ax + vx * t;
        const qy = ay + vy * t;
        const d = Math.hypot(px - qx, py - qy) * M_PER_DEG;
        if (d < best) {
            best = d;
            bestLat = qy;
            bestLng = qx / cos;
        }
    }
    return { dist: best, lat: bestLat, lng: bestLng };
}

/**
 * Build the index. Road groups: edges with the same non-empty name that are
 * connected through shared nodes (so two "Main Streets" in different towns
 * stay apart). Unnamed edges form groups of one.
 */
export function buildRoadIndex(records) {
    if (!records || !records.length) return null;
    const cos = Math.cos((records[0].pts[0][0] * Math.PI) / 180);
    const edges = records.map((r, i) => ({
        idx: i, key: edgeKey(r.u, r.v), u: r.u, v: r.v, name: r.name || '', pts: r.pts,
    }));
    const byKey = new Map();
    const grid = new Map();
    edges.forEach((edge) => {
        byKey.set(edge.key, edge);
        const cells = new Set();
        samplePolyline(edge.pts, cos).forEach(([lat, lng]) => cells.add(cellOf(lat, lng, cos)));
        cells.forEach((cell) => {
            const list = grid.get(cell);
            if (list) list.push(edge.idx);
            else grid.set(cell, [edge.idx]);
        });
    });

    // Union-find over same-named edges sharing a node.
    const parent = edges.map((_, i) => i);
    const find = (i) => {
        while (parent[i] !== i) {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        return i;
    };
    const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[ra] = rb;
    };
    const byNameNode = new Map();
    edges.forEach((edge) => {
        if (!edge.name) return;
        [edge.u, edge.v].forEach((node) => {
            const k = `${edge.name}\u0000${node}`;
            const other = byNameNode.get(k);
            if (other != null) union(other, edge.idx);
            else byNameNode.set(k, edge.idx);
        });
    });
    const groups = new Map();
    edges.forEach((edge) => {
        const root = find(edge.idx);
        edge.group = root;
        const list = groups.get(root);
        if (list) list.push(edge);
        else groups.set(root, [edge]);
    });

    return { edges, byKey, grid, groups, cos };
}

/** Nearest edge within maxM of a point, with the closest point on it. */
export function nearestEdge(index, lat, lng, maxM) {
    if (!index) return null;
    const { grid, edges, cos } = index;
    const cx = Math.floor((lng * M_PER_DEG * cos) / CELL_M);
    const cy = Math.floor((lat * M_PER_DEG) / CELL_M);
    const reach = Math.ceil(maxM / CELL_M);
    const seen = new Set();
    let best = null;
    for (let dx = -reach; dx <= reach; dx++) {
        for (let dy = -reach; dy <= reach; dy++) {
            const list = grid.get(`${cx + dx},${cy + dy}`);
            if (!list) continue;
            for (const idx of list) {
                if (seen.has(idx)) continue;
                seen.add(idx);
                const hit = distanceToPolyline(edges[idx].pts, lat, lng, cos);
                if (hit.dist <= maxM && (!best || hit.dist < best.dist)) {
                    best = { edge: edges[idx], ...hit };
                }
            }
        }
    }
    return best;
}

/** Every edge in the same road group as the given edge. */
export function roadOf(index, edge) {
    if (!index || !edge) return [];
    return index.groups.get(edge.group) || [edge];
}

function selectionBounds(selection) {
    if (selection.shape === 'point' || selection.shape === 'circle') {
        const dLat = selection.radiusM / M_PER_DEG;
        const dLng = selection.radiusM / (M_PER_DEG * Math.max(0.05, Math.cos((selection.lat * Math.PI) / 180)));
        return [selection.lat - dLat, selection.lat + dLat, selection.lng - dLng, selection.lng + dLng];
    }
    if (selection.shape === 'box') {
        return [selection.south, selection.north, selection.west, selection.east];
    }
    if (selection.shape === 'freeform' && selection.coordinates?.length) {
        const lats = selection.coordinates.map((p) => p[0]);
        const lngs = selection.coordinates.map((p) => p[1]);
        return [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
    }
    return null;
}

/** Edges with a sample point inside a circle / box / freeform selection. */
export function edgesInShape(index, selection) {
    if (!index) return [];
    const bounds = selectionBounds(selection);
    if (!bounds) return [];
    const { edges, grid, cos } = index;
    const [latLo, latHi, lngLo, lngHi] = bounds;
    const x0 = Math.floor((lngLo * M_PER_DEG * cos) / CELL_M) - 1;
    const x1 = Math.floor((lngHi * M_PER_DEG * cos) / CELL_M) + 1;
    const y0 = Math.floor((latLo * M_PER_DEG) / CELL_M) - 1;
    const y1 = Math.floor((latHi * M_PER_DEG) / CELL_M) + 1;
    const seen = new Set();
    for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
            const list = grid.get(`${x},${y}`);
            if (list) list.forEach((idx) => seen.add(idx));
        }
    }
    const out = [];
    seen.forEach((idx) => {
        const edge = edges[idx];
        const pts = samplePolyline(edge.pts, cos);
        for (let i = 0; i < pts.length; i++) {
            if (selectionContains(selection, pts[i][0], pts[i][1])) {
                out.push(edge);
                break;
            }
        }
    });
    out.sort((a, b) => a.idx - b.idx);
    return out;
}

const areaEdgeCache = new WeakMap(); // outline -> { index, edges }

/** Every road inside an area's outline (cached per outline and road index). */
export function areaEdges(index, outline) {
    if (!index || !outline) return [];
    const cached = areaEdgeCache.get(outline);
    if (cached && cached.index === index) return cached.edges;
    const edges = edgesInShape(index, outline);
    areaEdgeCache.set(outline, { index, edges });
    return edges;
}

/**
 * Selection payload for a set of edges (what the server and the filters need).
 * An excluded area also keeps its `outline` (circle / box / freeform): the map
 * draws that instead of the red roads.
 */
export function edgesSelection(edgeList, { type, kind, label, id, outline }) {
    const selection = {
        id,
        type,
        shape: 'edges',
        kind, // 'edge' | 'road' | 'area'
        label: label || edgeList[0]?.name || '',
        edges: edgeList.map((e) => [e.u, e.v]),
        keys: edgeList.map((e) => e.key),
        lines: edgeList.map((e) => e.pts),
    };
    if (outline) selection.outline = outline;
    return selection;
}
