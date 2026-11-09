/** Client-side route filters. Samples come from elevation_profile rows [dist, elev, lat, lng, bearing]. */

export const POINT_RADIUS_M = 45;
export const SNAP_RADIUS_M = 80;
const SNAP_PIXELS = 16;
export const MIN_DRAG_M = 20;
const CELL_M = 80;
const M_PER_DEG = 111320;

const sampleCache = new WeakMap();
const cellCache = new WeakMap();
// One grid for every run, so two generations can share a cell id.
const MATCH_COS = Math.cos((35 * Math.PI) / 180);

export function metersBetween(lat1, lng1, lat2, lng2) {
    const midLat = ((lat1 + lat2) * 0.5 * Math.PI) / 180;
    const dNorth = (lat2 - lat1) * M_PER_DEG;
    const dEast = (lng2 - lng1) * M_PER_DEG * Math.cos(midLat);
    return Math.hypot(dNorth, dEast);
}

export function pathSamples(path) {
    const cached = sampleCache.get(path);
    if (cached) return cached;

    const profile = path?.properties?.elevation_profile;
    const samples = [];
    if (profile) {
        for (let i = 0; i < profile.length; i++) {
            const row = profile[i];
            if (!row || row.length < 4 || row[2] == null || row[3] == null) continue;
            samples.push(row[2], row[3]);
        }
    }
    sampleCache.set(path, samples);
    return samples;
}

function pointInRing(lat, lng, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const latI = ring[i][0];
        const lngI = ring[i][1];
        const latJ = ring[j][0];
        const lngJ = ring[j][1];
        const crosses = (latI > lat) !== (latJ > lat);
        if (!crosses) continue;
        const x = ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI;
        if (lng < x) inside = !inside;
    }
    return inside;
}

// Painted roads: a route sample counts as "on the road" within EDGE_HIT_M of
// the road's interior. The ends are trimmed by EDGE_TRIM_M so a route that only
// passes through the road's intersections is not on it (the search forbids or
// requires riding the edge, not touching its nodes); a short edge keeps its
// midpoint.
const EDGE_HIT_M = 25;
const EDGE_TRIM_M = 30;
const EDGE_CELL_M = 50;
const edgeGridCache = new WeakMap();

/** Grid of points every ~15 m along the interior of a painted selection's roads, built once. */
function edgeGrid(selection) {
    const cached = edgeGridCache.get(selection);
    if (cached) return cached;
    const lines = selection.lines || [];
    const cos = lines.length && lines[0].length
        ? Math.cos((lines[0][0][0] * Math.PI) / 180)
        : 1;
    const cells = new Map();
    const put = (lat, lng) => {
        const key = `${Math.floor((lng * M_PER_DEG * cos) / EDGE_CELL_M)},${Math.floor((lat * M_PER_DEG) / EDGE_CELL_M)}`;
        const list = cells.get(key);
        if (list) list.push(lat, lng);
        else cells.set(key, [lat, lng]);
    };
    lines.forEach((pts) => {
        if (pts.length < 2) return;
        const segs = [];
        let total = 0;
        for (let i = 1; i < pts.length; i++) {
            const seg = Math.hypot((pts[i][0] - pts[i - 1][0]) * M_PER_DEG, (pts[i][1] - pts[i - 1][1]) * M_PER_DEG * cos);
            segs.push(seg);
            total += seg;
        }
        const at = (d) => {
            // Point d metres along the polyline.
            let acc = 0;
            for (let i = 0; i < segs.length; i++) {
                if (acc + segs[i] >= d || i === segs.length - 1) {
                    const f = segs[i] > 0 ? Math.min(1, Math.max(0, (d - acc) / segs[i])) : 0;
                    return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
                }
                acc += segs[i];
            }
            return pts[pts.length - 1];
        };
        let from = EDGE_TRIM_M;
        let to = total - EDGE_TRIM_M;
        if (to <= from) {
            from = total / 2;
            to = total / 2;
        }
        for (let d = from; d <= to + 1e-6; d += 15) {
            const p = at(Math.min(d, to));
            put(p[0], p[1]);
        }
        const end = at(to);
        put(end[0], end[1]);
    });
    const grid = { cells, cos };
    edgeGridCache.set(selection, grid);
    return grid;
}

function edgesContain(selection, lat, lng) {
    const { cells, cos } = edgeGrid(selection);
    const cx = Math.floor((lng * M_PER_DEG * cos) / EDGE_CELL_M);
    const cy = Math.floor((lat * M_PER_DEG) / EDGE_CELL_M);
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            const list = cells.get(`${cx + dx},${cy + dy}`);
            if (!list) continue;
            for (let i = 0; i < list.length; i += 2) {
                if (metersBetween(lat, lng, list[i], list[i + 1]) <= EDGE_HIT_M) return true;
            }
        }
    }
    return false;
}

export function selectionContains(selection, lat, lng) {
    if (selection.shape === 'edges') {
        return edgesContain(selection, lat, lng);
    }
    if (selection.shape === 'point' || selection.shape === 'circle') {
        return metersBetween(lat, lng, selection.lat, selection.lng) <= selection.radiusM;
    }
    if (selection.shape === 'box') {
        return lat <= selection.north && lat >= selection.south
            && lng <= selection.east && lng >= selection.west;
    }
    if (selection.shape === 'freeform' && selection.coordinates?.length >= 3) {
        return pointInRing(lat, lng, selection.coordinates);
    }
    return false;
}

export function pathMatchesSelection(path, selection) {
    const samples = pathSamples(path);
    let hit = false;
    for (let i = 0; i < samples.length; i += 2) {
        if (selectionContains(selection, samples[i], samples[i + 1])) {
            hit = true;
            break;
        }
    }
    return selection.type === 'exclude' ? !hit : hit;
}

export function filterByRouteSelections(paths, selections) {
    if (!selections?.length) return paths;
    return paths.filter((path) => selections.every((selection) => pathMatchesSelection(path, selection)));
}

/** Click tolerance: at least 80 m, and wide enough to hit the line at the current zoom. */
export function snapToleranceMeters(zoom, lat) {
    const metersPerPixel = 156543.03392 * Math.cos(lat * Math.PI / 180) / (2 ** zoom);
    return Math.max(SNAP_RADIUS_M, SNAP_PIXELS * metersPerPixel);
}

/** Snap a click onto the nearest elevation sample within maxM. */
export function snapToRoutes(paths, lat, lng, maxM = SNAP_RADIUS_M) {
    let bestLat = null;
    let bestLng = null;
    let best = maxM;
    for (let p = 0; p < paths.length; p++) {
        const samples = pathSamples(paths[p]);
        for (let i = 0; i < samples.length; i += 2) {
            const dist = metersBetween(lat, lng, samples[i], samples[i + 1]);
            if (dist < best) {
                best = dist;
                bestLat = samples[i];
                bestLng = samples[i + 1];
            }
        }
    }
    if (bestLat == null) return null;
    return { lat: bestLat, lng: bestLng };
}

function cellsFor(path) {
    const cached = cellCache.get(path);
    if (cached) return cached;

    const samples = pathSamples(path);
    const cells = new Set();
    if (samples.length >= 2) {
        const cos = Math.cos(samples[0] * Math.PI / 180);
        for (let i = 0; i < samples.length; i += 2) {
            const x = Math.round((samples[i + 1] * M_PER_DEG * cos) / CELL_M);
            const y = Math.round((samples[i] * M_PER_DEG) / CELL_M);
            cells.add(`${x},${y}`);
        }
    }
    cellCache.set(path, cells);
    return cells;
}

function jaccard(a, b) {
    if (a.size === 0 && b.size === 0) return 0;
    let inter = 0;
    const small = a.size <= b.size ? a : b;
    const large = small === a ? b : a;
    for (const cell of small) {
        if (large.has(cell)) inter++;
    }
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
}

/**
 * Walk routes that share pavement. The first route is the shortest (or longest).
 * Each next route is the unused one with the most overlapping ground.
 */
export function sortBySimilarity(paths, ascending = true) {
    const count = paths.length;
    if (count <= 1) return paths.slice();

    const cells = paths.map(cellsFor);
    let seed = 0;
    let seedMiles = paths[0].properties?.total_miles ?? 0;
    for (let i = 1; i < count; i++) {
        const miles = paths[i].properties?.total_miles ?? 0;
        if (ascending ? miles < seedMiles : miles > seedMiles) {
            seed = i;
            seedMiles = miles;
        }
    }

    const used = new Uint8Array(count);
    const ordered = new Array(count);
    ordered[0] = paths[seed];
    used[seed] = 1;
    let current = seed;

    for (let placed = 1; placed < count; placed++) {
        let best = -1;
        let bestScore = -1;
        let bestMiles = Infinity;
        const currentMiles = paths[current].properties?.total_miles ?? 0;
        for (let i = 0; i < count; i++) {
            if (used[i]) continue;
            const score = jaccard(cells[current], cells[i]);
            const miles = Math.abs((paths[i].properties?.total_miles ?? 0) - currentMiles);
            if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && miles < bestMiles)) {
                best = i;
                bestScore = score;
                bestMiles = miles;
            }
        }
        used[best] = 1;
        ordered[placed] = paths[best];
        current = best;
    }

    return ordered;
}

/** One line describing the painted roads and areas (and old pins). */
export function describeSelections(selections) {
    const parts = [];
    const count = (label, n) => { if (n) parts.push(`${n} ${label}${n === 1 ? '' : 's'}`); };
    const edges = selections.filter((s) => s.shape === 'edges');
    const isArea = (s) => s.kind === 'area';
    count('required road', edges.filter((s) => s.type === 'include' && s.kind === 'road').length);
    count('required edge', edges.filter((s) => s.type === 'include' && s.kind !== 'road').length);
    count('avoided road', edges.filter((s) => s.type === 'exclude' && !isArea(s)).length);
    count('through area', selections.filter((s) => s.type === 'include' && ['circle', 'box', 'freeform'].includes(s.shape)).length);
    count('avoided area', edges.filter((s) => s.type === 'exclude' && isArea(s)).length
        + selections.filter((s) => s.type === 'exclude' && ['circle', 'box', 'freeform'].includes(s.shape)).length);
    count('pin', selections.filter((s) => s.shape === 'point').length);
    return parts.join(' · ');
}
