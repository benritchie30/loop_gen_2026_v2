/**
 * Small hand-made data for the logic tests: a grid of roads and routes
 * along them near 36.0 N, 81.0 W. About 111 m per 0.001 deg of latitude and
 * 90 m per 0.001 deg of longitude there.
 */
import { buildRoadIndex } from '../graphRoads';

export const LAT0 = 36.0;
export const LNG0 = -81.0;
export const DLAT = 0.001; // ~111 m
export const DLNG = 0.001; // ~90 m

/** Node id for grid corner (row, col). */
export const node = (r, c) => r * 10 + c + 1;
export const at = (r, c) => [LAT0 + r * DLAT, LNG0 + c * DLNG];

/**
 * 4 x 4 grid of nodes. Horizontal roads are "Row r" (same name along a row,
 * so Ctrl-click paints the whole row); vertical ones are unnamed.
 */
export function gridRecords() {
    const records = [];
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            if (c < 3) records.push({ u: node(r, c), v: node(r, c + 1), name: `Row ${r}`, pts: [at(r, c), at(r, c + 1)] });
            if (r < 3) records.push({ u: node(r, c), v: node(r + 1, c), name: '', pts: [at(r, c), at(r + 1, c)] });
        }
    }
    return records;
}

export const gridIndex = () => buildRoadIndex(gridRecords());

/** Edge object of the index between two grid corners. */
export function edgeBetween(index, a, b) {
    const u = node(...a);
    const v = node(...b);
    return index.byKey.get(u < v ? `${u}-${v}` : `${v}-${u}`);
}

/**
 * A route through grid corners as a path object with an elevation profile
 * sampled every ~25 m ([dist_mi, elev_ft, lat, lng, bearing]). Elevation
 * rises 1 ft per sample unless `elev` is given.
 */
export function routeThrough(id, corners, { elev = (i) => i, props = {} } = {}) {
    const pts = corners.map((c) => at(...c));
    const profile = [];
    let dist = 0;
    let i = 0;
    for (let k = 1; k < pts.length; k++) {
        const [aLat, aLng] = pts[k - 1];
        const [bLat, bLng] = pts[k];
        const segM = Math.hypot((bLat - aLat) * 111320, (bLng - aLng) * 111320 * Math.cos((aLat * Math.PI) / 180));
        const steps = Math.max(1, Math.round(segM / 25));
        for (let s = k === 1 ? 0 : 1; s <= steps; s++) {
            const f = s / steps;
            const d = dist + (segM * f) / 1609.34;
            profile.push([d, elev(i), aLat + (bLat - aLat) * f, aLng + (bLng - aLng) * f, 0]);
            i += 1;
        }
        dist += segM / 1609.34;
    }
    return { id, type: 'Feature', properties: { elevation_profile: profile, total_miles: dist, ...props } };
}
