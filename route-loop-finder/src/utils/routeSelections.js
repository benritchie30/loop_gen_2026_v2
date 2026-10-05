/** Client-side route filters. Samples come from elevation_profile rows [dist, elev, lat, lng, bearing]. */

export const POINT_RADIUS_M = 45;
export const SNAP_RADIUS_M = 80;
const SNAP_PIXELS = 16;
export const MIN_DRAG_M = 20;
const CELL_M = 80;
const M_PER_DEG = 111320;

const sampleCache = new WeakMap();
const cellCache = new WeakMap();

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

export function selectionContains(selection, lat, lng) {
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
