/**
 * The server's map tiles (backend/map_store.py): the world in TILE_DEG x
 * TILE_DEG squares, named [row, col] = floor(lat / deg), floor(lng / deg).
 * Used for the offline basemap (which tiles to draw), its "downloaded area"
 * outline, and to tell whether a start needs tiles that are not downloaded.
 * tilesForCircle / tilesForStart match the server's tiles_for_circle /
 * tiles_needed exactly.
 */

export const TILE_DEG = 0.1;
const M_PER_DEG = 111320;
const START_MARGIN_M = 800; // graph_builder.MARGIN_M: the search area reaches max / 2 + this

export const tileKey = (row, col) => `${row}_${col}`;

export function tileOf(lat, lng, deg = TILE_DEG) {
    return [Math.floor(lat / deg), Math.floor(lng / deg)];
}

/** [[south, west], [north, east]] of a tile. */
export function tileBounds([row, col], deg = TILE_DEG) {
    const r = (v) => Math.round(v * 1e6) / 1e6;
    return [[r(row * deg), r(col * deg)], [r((row + 1) * deg), r((col + 1) * deg)]];
}

function metersToBox(lat, lng, [[s, w], [n, e]]) {
    const y = Math.min(Math.max(lat, s), n);
    const x = Math.min(Math.max(lng, w), e);
    const k = Math.cos((lat * Math.PI) / 180);
    return Math.hypot(y - lat, (x - lng) * k) * M_PER_DEG;
}

/** Tiles touching a circle (as the server picks them). */
export function tilesForCircle(lat, lng, radiusM, deg = TILE_DEG) {
    const dLat = radiusM / M_PER_DEG;
    const dLng = radiusM / (M_PER_DEG * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
    const [r0, c0] = tileOf(lat - dLat, lng - dLng, deg);
    const [r1, c1] = tileOf(lat + dLat, lng + dLng, deg);
    const out = [];
    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
            if (metersToBox(lat, lng, tileBounds([r, c], deg)) <= radiusM) out.push([r, c]);
        }
    }
    return out;
}

/** Tiles a start with this max route length needs (areas.tiles_needed). */
export function tilesForStart(lat, lng, maxMiles, deg = TILE_DEG) {
    return tilesForCircle(lat, lng, (maxMiles * 1609.34) / 2 + START_MARGIN_M, deg);
}

/** Tiles overlapping a Leaflet-style bounds {south, west, north, east}. */
export function tilesInBounds({ south, west, north, east }, deg = TILE_DEG) {
    const [r0, c0] = tileOf(south, west, deg);
    const [r1, c1] = tileOf(north, east, deg);
    const out = [];
    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) out.push([r, c]);
    }
    return out;
}

/** The outline of a set of tiles: the sides no other tile of the set shares, as 2-point lines. */
export function coverageOutline(tiles, deg = TILE_DEG) {
    const have = new Set(tiles.map(([r, c]) => tileKey(r, c)));
    const lines = [];
    tiles.forEach(([r, c]) => {
        const [[s, w], [n, e]] = tileBounds([r, c], deg);
        if (!have.has(tileKey(r - 1, c))) lines.push([[s, w], [s, e]]);
        if (!have.has(tileKey(r + 1, c))) lines.push([[n, w], [n, e]]);
        if (!have.has(tileKey(r, c - 1))) lines.push([[s, w], [n, w]]);
        if (!have.has(tileKey(r, c + 1))) lines.push([[s, e], [n, e]]);
    });
    return lines;
}

/**
 * Groups of touching tiles (corners count), each with its bounds and
 * centre: the separate places map data was downloaded for.
 */
export function coverageGroups(tiles, deg = TILE_DEG) {
    const left = new Map(tiles.map(([r, c]) => [tileKey(r, c), [r, c]]));
    const groups = [];
    while (left.size) {
        const [startKey, start] = left.entries().next().value;
        left.delete(startKey);
        const stack = [start];
        const members = [];
        while (stack.length) {
            const [r, c] = stack.pop();
            members.push([r, c]);
            for (let dr = -1; dr <= 1; dr++) {
                for (let dc = -1; dc <= 1; dc++) {
                    const key = tileKey(r + dr, c + dc);
                    if (left.has(key)) {
                        stack.push(left.get(key));
                        left.delete(key);
                    }
                }
            }
        }
        const rows = members.map((t) => t[0]);
        const cols = members.map((t) => t[1]);
        const south = Math.min(...rows) * deg;
        const north = (Math.max(...rows) + 1) * deg;
        const west = Math.min(...cols) * deg;
        const east = (Math.max(...cols) + 1) * deg;
        groups.push({
            tiles: members,
            bounds: [[south, west], [north, east]],
            center: [(south + north) / 2, (west + east) / 2],
        });
    }
    return groups;
}

/** The group whose centre is nearest (lat, lng). */
export function nearestGroup(groups, lat, lng) {
    let best = null;
    let bestD = Infinity;
    groups.forEach((group) => {
        const k = Math.cos((lat * Math.PI) / 180);
        const d = Math.hypot(group.center[0] - lat, (group.center[1] - lng) * k);
        if (d < bestD) {
            best = group;
            bestD = d;
        }
    });
    return best;
}
