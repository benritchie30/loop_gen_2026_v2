/**
 * A route's unpaved stretches (dashed on the map, bars under the elevation chart's line) (gravel and dirt alike; the server's
 * surface.py decides from OSM tags, and an unknown surface counts as paved).
 *
 * The server sends properties.unpaved = [[first point, last point, start mi,
 * end mi], ...]: point indices into the route's geometry (which never
 * changes), and miles along the elevation profile (which Reverse flips, so
 * they are flipped with it: reverseUnpaved). Routes saved before surfaces
 * existed have none and show as paved.
 */

/** The unpaved stretches of a route's properties, cleaned ([] when none). */
export function unpavedRuns(properties) {
    const runs = properties?.unpaved;
    if (!Array.isArray(runs)) return [];
    return runs.filter((r) => Array.isArray(r) && r.length >= 4
        && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[1] > r[0]
        && Number.isFinite(r[2]) && Number.isFinite(r[3]) && r[3] > r[2]);
}

/** The stretches for a route ridden the other way (Reverse): same points, miles from the other end. */
export function reverseUnpaved(runs, totalMiles) {
    if (!Array.isArray(runs) || !Number.isFinite(totalMiles)) return runs;
    const flip = (d) => Math.max(0, Number((totalMiles - d).toFixed(3)));
    return runs.map(([a, b, d0, d1]) => [a, b, flip(d1), flip(d0)]).reverse();
}

/** Share of the route that is unpaved, 0..1 (null without surface data). */
export function unpavedShare(properties) {
    const miles = properties?.total_miles;
    const unpaved = properties?.unpaved_miles;
    if (!Number.isFinite(miles) || miles <= 0 || !Number.isFinite(unpaved)) return null;
    return Math.min(1, Math.max(0, unpaved / miles));
}

/** The route's points as Leaflet [lat, lng] (a MultiLineString's parts joined). */
function latLngs(path) {
    const g = path?.geometry;
    const coords = g?.type === 'LineString' ? g.coordinates
        : g?.type === 'MultiLineString' ? g.coordinates.flat() : [];
    return (coords || []).map(([lng, lat]) => [lat, lng]);
}

/**
 * The route's line cut into paved and unpaved pieces for the map:
 * { paved: [[[lat, lng], ...], ...], unpaved: [...] }. Neighbouring pieces
 * share their end point, so the line stays whole. Null when the route has
 * no unpaved stretch (draw it as one line).
 */
export function surfacePieces(path) {
    const runs = unpavedRuns(path?.properties);
    if (!runs.length) return null;
    const pts = latLngs(path);
    if (pts.length < 2) return null;
    const last = pts.length - 1;
    const sorted = runs
        .map(([a, b]) => [Math.max(0, Math.min(a, last)), Math.max(0, Math.min(b, last))])
        .filter(([a, b]) => b > a)
        .sort((x, y) => x[0] - y[0]);
    const paved = [];
    const unpaved = [];
    let at = 0;
    for (const [a, b] of sorted) {
        if (b <= at) continue;
        const from = Math.max(a, at);
        if (from > at) paved.push(pts.slice(at, from + 1));
        unpaved.push(pts.slice(from, b + 1));
        at = b;
    }
    if (at < last) paved.push(pts.slice(at));
    return unpaved.length ? { paved, unpaved } : null;
}

/**
 * The elevation profile between two distances, ends interpolated:
 * [[dist, elev], ...] (same units as the profile). For shading the area
 * under the chart line over an unpaved stretch.
 */
export function profileSlice(profile, d0, d1) {
    if (!Array.isArray(profile) || profile.length < 2 || !(d1 > d0)) return [];
    const at = (d) => {
        let i = 1;
        while (i < profile.length - 1 && profile[i][0] < d) i++;
        const [x0, y0] = profile[i - 1];
        const [x1, y1] = profile[i];
        const t = x1 > x0 ? Math.min(1, Math.max(0, (d - x0) / (x1 - x0))) : 0;
        return [d, y0 + (y1 - y0) * t];
    };
    const start = Math.max(d0, profile[0][0]);
    const end = Math.min(d1, profile[profile.length - 1][0]);
    if (!(end > start)) return [];
    const inside = profile.filter((p) => p[0] > start && p[0] < end).map((p) => [p[0], p[1]]);
    return [at(start), ...inside, at(end)];
}

/**
 * The Surface choice for a search (the server's surface.py): Paved only keeps
 * off unpaved roads (a strong charge, and a loop with more than 400 m of them
 * is left out), Allow gravel ignores surface, Prefer gravel seeks unpaved
 * roads and lists the most unpaved loops first.
 */
export const SURFACE_PREFERENCES = [
    {
        id: 'paved',
        label: 'Paved only',
        chip: 'Paved',
        short: 'Keeps off gravel and dirt',
        hint: 'Keeps off gravel and dirt. Only a short unavoidable stretch (under a quarter mile) is allowed.',
    },
    {
        id: 'allow',
        label: 'Allow gravel',
        chip: 'Any surface',
        short: 'Surface does not matter',
        hint: 'Gravel and dirt are fine: routes are chosen without looking at the surface.',
    },
    {
        id: 'gravel',
        label: 'Prefer gravel',
        chip: 'Gravel',
        short: 'Seeks out gravel and dirt',
        hint: 'Goes out of its way for gravel and dirt roads, and lists the most unpaved loops first.',
    },
];
export const DEFAULT_SURFACE = 'allow';

/** A saved or sent Surface choice, or the default. */
export function surfacePreference(value) {
    return SURFACE_PREFERENCES.some((p) => p.id === value) ? value : DEFAULT_SURFACE;
}
