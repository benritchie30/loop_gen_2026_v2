/**
 * Geometry for pointing at routes on the map: where on the shown route the
 * pointer is (hover marker + elevation chart), and which routes run past a
 * clicked spot. Routes are read from their elevation_profile rows
 * [dist_mi, elev_ft, lat, lng, bearing] (a sample about every 50 m).
 */

const M_PER_DEG = 111320;

/** Metres per screen pixel at a zoom level and latitude (Web Mercator). */
export function metersPerPixel(zoom, lat) {
    return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / (2 ** zoom);
}

/** Pointer reach: a route or road within this many pixels counts as "under" the pointer. */
export const HOVER_PX = 24;
const MIN_REACH_M = 30; // zoomed far in, still forgive a few metres

/**
 * The pointer's reach in metres at a zoom level and latitude. One value for
 * every map gesture (route hover, clicking routes, the Road tool, double-click
 * to remove), so they all feel the same.
 */
export function pointerReachM(zoom, lat) {
    return Math.max(MIN_REACH_M, HOVER_PX * metersPerPixel(zoom, lat));
}

/**
 * The hover marker on the shown route reaches further than clicks do (there
 * is only one route to find): it appears within ROUTE_HOVER_PX of the route
 * and, once shown, stays until the pointer is ROUTE_HOVER_KEEP_PX away, so it
 * does not blink at the edge of its reach.
 */
export const ROUTE_HOVER_PX = 48;
export const ROUTE_HOVER_KEEP_PX = 64;
const MIN_ROUTE_HOVER_M = 40;

export function routeHoverReachM(zoom, lat, showing = false) {
    const px = showing ? ROUTE_HOVER_KEEP_PX : ROUTE_HOVER_PX;
    return Math.max(MIN_ROUTE_HOVER_M, px * metersPerPixel(zoom, lat));
}

function usable(row) {
    return row && row.length >= 4 && row[2] != null && row[3] != null;
}

/**
 * Every segment of the profile within maxM of (lat, lng), as runs of
 * consecutive segments. A run is one pass of the route near the point; the
 * stem of a lollipop (out and back on the same road) gives two runs.
 * Each run: { i, t, d } of its closest segment (profile[i - 1] -> profile[i],
 * t in [0, 1] along it, d metres away).
 */
function passesNear(profile, lat, lng, maxM) {
    const cos = Math.cos((lat * Math.PI) / 180);
    const runs = [];
    let run = null;
    for (let i = 1; i < profile.length; i++) {
        const a = profile[i - 1];
        const b = profile[i];
        if (!usable(a) || !usable(b)) {
            run = null;
            continue;
        }
        // Local metres with the point at the origin.
        const ax = (a[3] - lng) * M_PER_DEG * cos;
        const ay = (a[2] - lat) * M_PER_DEG;
        const vx = (b[3] - a[3]) * M_PER_DEG * cos;
        const vy = (b[2] - a[2]) * M_PER_DEG;
        const den = vx * vx + vy * vy;
        const t = den === 0 ? 0 : Math.max(0, Math.min(1, -(ax * vx + ay * vy) / den));
        const d = Math.hypot(ax + vx * t, ay + vy * t);
        if (d > maxM) {
            run = null;
            continue;
        }
        if (!run) {
            run = { i, t, d };
            runs.push(run);
        } else if (d < run.d) {
            run.i = i;
            run.t = t;
            run.d = d;
        }
    }
    return runs;
}

/**
 * The point of the route nearest (lat, lng), within maxM, interpolated
 * between samples so the marker glides. Where the route passes the spot more
 * than once (the stem, ridden out and back), the pass nearest `prevDistance`
 * (miles, the last hovered point) wins, so the marker stays on the leg it is
 * on instead of jumping between them.
 * Returns { distance, elevation, coordinate: [lat, lng], bearing, offM } or null.
 */
export function nearestOnProfile(profile, lat, lng, maxM, prevDistance = null) {
    if (!Array.isArray(profile) || profile.length < 2) return null;
    const runs = passesNear(profile, lat, lng, maxM);
    if (!runs.length) return null;

    const at = (run) => {
        const a = profile[run.i - 1];
        const b = profile[run.i];
        const f = run.t;
        return {
            distance: a[0] + (b[0] - a[0]) * f,
            elevation: a[1] + (b[1] - a[1]) * f,
            coordinate: [a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f],
            bearing: b[4] ?? a[4] ?? 0,
            offM: run.d,
        };
    };

    let best = runs[0];
    runs.forEach((run) => { if (run.d < best.d) best = run; });
    if (prevDistance == null || runs.length === 1) return at(best);

    // Passes about as close as the best one are the same road ridden again.
    const slack = Math.max(5, maxM * 0.1);
    let chosen = null;
    let chosenGap = Infinity;
    runs.forEach((run) => {
        if (run.d > best.d + slack) return;
        const point = at(run);
        const gap = Math.abs(point.distance - prevDistance);
        if (gap < chosenGap) {
            chosen = point;
            chosenGap = gap;
        }
    });
    return chosen || at(best);
}

/** Distance in metres from (lat, lng) to the route, or Infinity. */
export function distanceToRoute(path, lat, lng, maxM) {
    const profile = path?.properties?.elevation_profile;
    if (!Array.isArray(profile) || profile.length < 2) return Infinity;
    const runs = passesNear(profile, lat, lng, maxM);
    let best = Infinity;
    runs.forEach((run) => { if (run.d < best) best = run.d; });
    return best;
}

/**
 * Routes that run past a clicked spot, in list order. Only the routes on the
 * nearest road count (within `slackM` of the closest one), so a click picks
 * the road under the pointer, not one a little further away.
 */
export function routesAtPoint(paths, lat, lng, maxM, slackM = Math.max(5, maxM * 0.15)) {
    const hits = [];
    let best = Infinity;
    (paths || []).forEach((path, index) => {
        const d = distanceToRoute(path, lat, lng, maxM);
        if (d <= maxM) {
            hits.push({ path, index, d });
            if (d < best) best = d;
        }
    });
    return hits
        .filter((hit) => hit.d <= best + slackM)
        .sort((a, b) => a.index - b.index)
        .map((hit) => hit.path);
}

/**
 * The route a click at (lat, lng) should show. Clicking again where the
 * shown route runs with others steps to the next of them (wrapping), so
 * repeated clicks cycle through every route on that road. Null when no
 * route is within maxM.
 */
export function routeForClick(paths, currentId, lat, lng, maxM) {
    const here = routesAtPoint(paths, lat, lng, maxM);
    if (!here.length) return null;
    const i = here.findIndex((path) => path.id === currentId);
    if (i < 0) return here[0];
    return here[(i + 1) % here.length];
}
