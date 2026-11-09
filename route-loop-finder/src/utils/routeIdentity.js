/**
 * Which routes are "the same route" (favorites): the same roads in the same
 * order, ridden either way. A route's key comes from its exact coordinates,
 * which are OpenStreetMap node positions, the same in every generation and
 * every build of the map, so a route found again in another generation (or
 * from a search with other settings) has the same key. The centroid is not
 * used: it is an average of points sampled from the start, which shifts with
 * the direction, and two different routes can share one.
 */

const DECIMALS = 7; // about 1 cm: only removes float noise

/** 53-bit string hash (cyrb53). */
function hash53(str) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Rounded points of a line, repeats in a row dropped. */
function points(coords) {
    const out = [];
    let last = null;
    (coords || []).forEach((c) => {
        if (!Array.isArray(c) || c.length < 2) return;
        const p = `${Number(c[0]).toFixed(DECIMALS)},${Number(c[1]).toFixed(DECIMALS)}`;
        if (p !== last) out.push(p);
        last = p;
    });
    return out;
}

/** The key of a line given as [[lng, lat], ...]: the same either way round. */
export function lineKey(coords) {
    const pts = points(coords);
    if (pts.length < 2) return null;
    const forward = pts.join(';');
    const backward = pts.slice().reverse().join(';');
    const text = forward <= backward ? forward : backward;
    return `${pts.length}-${hash53(text).toString(36)}`;
}

const keys = new WeakMap();

/** A route's (GeoJSON Feature's) key, or null without a line. Remembered per route object. */
export function routeKey(path) {
    if (!path || typeof path !== 'object') return null;
    if (keys.has(path)) return keys.get(path);
    const geometry = path.geometry;
    let coords = null;
    if (geometry?.type === 'LineString') coords = geometry.coordinates;
    else if (geometry?.type === 'MultiLineString') coords = (geometry.coordinates || []).flat();
    const key = coords ? lineKey(coords) : null;
    keys.set(path, key);
    return key;
}
