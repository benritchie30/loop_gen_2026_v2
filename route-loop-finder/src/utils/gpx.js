/**
 * GPX export of a route, for Ride with GPS, Strava, Komoot, Garmin, Wahoo...
 *
 * A route is written as one track (<trk>) of every point of its geometry
 * (OpenStreetMap node positions, so curves stay as drawn), each with its
 * elevation in metres (<ele>) interpolated from the elevation profile.
 * Track points carry no <time>: with times, apps take a file for a ride
 * that happened (an activity) instead of a route to follow.
 *
 * Direction: the file runs the way the elevation chart shows it. Reverse
 * flips only the profile, never the geometry, and a loop ends where it
 * starts, so the geometry's ends cannot tell. Instead the profile's own
 * positions are compared with the geometry run forwards and backwards: the
 * stem matches both ways, the loop only the way the profile runs.
 */
import { formatDistance } from './units';

const M_PER_FT = 0.3048;
const EARTH_R = 6371008.8;

function metersBetween(lat1, lng1, lat2, lng2) {
    const p1 = (lat1 * Math.PI) / 180;
    const p2 = (lat2 * Math.PI) / 180;
    const dp = p2 - p1;
    const dl = ((lng2 - lng1) * Math.PI) / 180;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The route's points as [lng, lat] (a MultiLineString's parts joined). */
function geometryCoords(route) {
    const g = route?.geometry;
    if (!g) return [];
    if (g.type === 'LineString') return g.coordinates || [];
    if (g.type === 'MultiLineString') return (g.coordinates || []).flat();
    return [];
}

/** Distance (m) from the first point to each point. */
function cumulative(coords) {
    const out = [0];
    for (let i = 1; i < coords.length; i++) {
        const [lng0, lat0] = coords[i - 1];
        const [lng1, lat1] = coords[i];
        out.push(out[i - 1] + metersBetween(lat0, lng0, lat1, lng1));
    }
    return out;
}

/** [lat, lng] at distance d (m) along coords (cum: their distances). */
function pointAt(coords, cum, d) {
    if (d <= 0) return [coords[0][1], coords[0][0]];
    const last = coords.length - 1;
    if (d >= cum[last]) return [coords[last][1], coords[last][0]];
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= d) lo = mid;
        else hi = mid;
    }
    const span = cum[hi] - cum[lo] || 1;
    const t = (d - cum[lo]) / span;
    return [
        coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t,
        coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t,
    ];
}

/**
 * Does the profile run against the geometry (the route was reversed)?
 * profile items: [dist_mi, elev_ft, lat, lng, bearing].
 */
export function profileRunsBackward(coords, profile) {
    if (!Array.isArray(profile) || profile.length < 3 || coords.length < 2) return false;
    const cum = cumulative(coords);
    const total = cum[cum.length - 1];
    const profTotal = profile[profile.length - 1][0];
    if (!(total > 0) || !(profTotal > 0)) return false;
    let forward = 0;
    let backward = 0;
    const samples = 24;
    for (let k = 1; k < samples; k++) {
        const p = profile[Math.round((k / samples) * (profile.length - 1))];
        if (p.length < 4) return false;
        const d = (p[0] / profTotal) * total; // the profile's distances, on the geometry's scale
        const [fLat, fLng] = pointAt(coords, cum, d);
        const [bLat, bLng] = pointAt(coords, cum, total - d);
        forward += metersBetween(p[2], p[3], fLat, fLng);
        backward += metersBetween(p[2], p[3], bLat, bLng);
    }
    return backward < forward;
}

/** Distance (m) and offset (m) of point (lat, lng) on segment i of coords (local flat metres). */
function onSegment(coords, cum, i, lat, lng) {
    const [lngA, latA] = coords[i];
    const [lngB, latB] = coords[i + 1];
    const kx = 111320 * Math.cos((lat * Math.PI) / 180);
    const ky = 110574;
    const ax = (lngA - lng) * kx;
    const ay = (latA - lat) * ky;
    const bx = (lngB - lng) * kx;
    const by = (latB - lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const off = Math.hypot(ax + dx * t, ay + dy * t);
    return { along: cum[i] + (cum[i + 1] - cum[i]) * t, off };
}

const SEARCH_AHEAD_M = 400; // how far past its expected place a sample is looked for

/**
 * Where each profile sample lies along the geometry (m from its start).
 * A sample's elevation belongs to its position (SRTM is read there), and its
 * stated distance can be off by tens of metres on a long curvy road (the
 * server spaces samples in degrees), so samples are placed by position:
 * each on the nearest segment from the previous sample's onwards, never
 * back (the stem is ridden twice), within a window past where its distance
 * puts it.
 */
function profileAlong(coords, cum, profile) {
    const total = cum[cum.length - 1];
    const profTotal = profile[profile.length - 1][0];
    const out = [];
    let seg = 0;
    let prev = 0;
    for (const p of profile) {
        if (p.length < 4 || !Number.isFinite(p[2]) || !Number.isFinite(p[3])) {
            prev = Math.max(prev, (p[0] / profTotal) * total); // no position: trust the distance
            out.push(prev);
            continue;
        }
        const limit = Math.max(prev, (p[0] / profTotal) * total) + SEARCH_AHEAD_M;
        let best = null;
        let bestSeg = seg;
        for (let i = seg; i < coords.length - 1 && cum[i] <= limit; i++) {
            const hit = onSegment(coords, cum, i, p[2], p[3]);
            if (best === null || hit.off < best.off - 0.01) {
                best = hit;
                bestSeg = i;
            }
        }
        if (best) {
            seg = bestSeg;
            prev = Math.max(prev, best.along);
        }
        out.push(prev);
    }
    return out;
}

/**
 * The track points in riding order: [{ lat, lon, ele }] with ele in metres
 * (null without a profile), interpolated between the profile samples
 * around each point.
 */
export function trackPoints(route) {
    let coords = geometryCoords(route).filter((c) => Number.isFinite(c?.[0]) && Number.isFinite(c?.[1]));
    if (coords.length < 2) return [];
    const profile = (route?.properties?.elevation_profile || [])
        .filter((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]));
    if (profileRunsBackward(coords, profile)) coords = [...coords].reverse();
    const cum = cumulative(coords);
    const hasProfile = profile.length > 1 && profile[profile.length - 1][0] > 0 && cum[cum.length - 1] > 0;
    const along = hasProfile ? profileAlong(coords, cum, profile) : [];

    let j = 0;
    return coords.map(([lon, lat], i) => {
        let ele = null;
        if (hasProfile) {
            const d = cum[i];
            while (j < along.length - 2 && along[j + 1] < d) j++;
            const span = along[j + 1] - along[j];
            const t = span > 0 ? Math.min(1, Math.max(0, (d - along[j]) / span)) : 0;
            ele = (profile[j][1] + (profile[j + 1][1] - profile[j][1]) * t) * M_PER_FT;
        }
        return { lat, lon, ele };
    });
}

function xmlEscape(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/** The GPX 1.1 document for a route, or null when it has no geometry. */
export function routeToGpx(route, { name = 'Loop', description = '' } = {}) {
    const points = trackPoints(route);
    if (points.length < 2) return null;
    const pts = points.map(({ lat, lon, ele }) => (ele == null
        ? `      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"/>`
        : `      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><ele>${ele.toFixed(1)}</ele></trkpt>`));
    const desc = description ? `\n    <desc>${xmlEscape(description)}</desc>` : '';
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="Loop Finder" xmlns="http://www.topografix.com/GPX/1/1"'
            + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
            + ' xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
        `  <metadata>\n    <name>${xmlEscape(name)}</name>${desc}\n  </metadata>`,
        '  <trk>',
        `    <name>${xmlEscape(name)}</name>${desc}`,
        '    <type>cycling</type>',
        '    <trkseg>',
        ...pts,
        '    </trkseg>',
        '  </trk>',
        '</gpx>',
        '',
    ].join('\n');
}

/** A name safe as a file name on every system ("Dilworth, Charlotte - route 3 - 24.6 mi"). */
export function safeFileName(text) {
    const clean = String(text || '')
        .replace(/[\\/:*?"<>|]+/g, ' ')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+/, '');
    return clean.slice(0, 120).trim() || 'loop';
}

/**
 * Name and description of a route's file. setName: its generation's name;
 * number: its place in the list (null for a favorite); units: 'mi' | 'km'.
 */
export function gpxLabels(route, { setName, number = null, units = 'mi' } = {}) {
    const p = route?.properties || {};
    const length = formatDistance(p.total_miles, units);
    const base = setName || 'Loop';
    const name = [base, number != null ? `route ${number}` : null, length !== '—' ? length : null]
        .filter(Boolean).join(' - ');
    const climb = Number.isFinite(p.total_climb_ft)
        ? `${Math.round(units === 'km' ? p.total_climb_ft * M_PER_FT : p.total_climb_ft).toLocaleString()} ${units === 'km' ? 'm' : 'ft'} of climbing`
        : null;
    const description = [length !== '—' ? `${length} loop` : null, climb].filter(Boolean).join(', ');
    return { name, fileName: `${safeFileName(name)}.gpx`, description: description ? `${description}. Made with Loop Finder.` : '' };
}

/** Download a route as a .gpx file. Returns false when it has nothing to write. */
export function downloadRouteGpx(route, options = {}) {
    const { name, fileName, description } = gpxLabels(route, options);
    const text = routeToGpx(route, { name, description });
    if (!text) return false;
    const url = URL.createObjectURL(new Blob([text], { type: 'application/gpx+xml' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
}
