import { describe, expect, it } from 'vitest';
import { at, routeThrough } from './fixtures';
import { gpxLabels, profileRunsBackward, routeToGpx, safeFileName, trackPoints } from '../gpx';
import realRoute from './gpxRoute.json';

const FT = 0.3048;

/** A route with geometry: the grid corners, elevation = 10 ft per profile sample. */
function route(corners, props = {}) {
    const r = routeThrough('r', corners, { elev: (i) => 1000 + i * 10, props });
    r.geometry = { type: 'LineString', coordinates: corners.map((c) => { const [lat, lng] = at(...c); return [lng, lat]; }) };
    return r;
}

/** What Reverse does (usePathSets.reverseCurrentPathProfile): the profile only. */
function reversed(r) {
    const profile = r.properties.elevation_profile;
    const total = profile[profile.length - 1][0];
    return {
        ...r,
        properties: {
            ...r.properties,
            elevation_profile: profile.map((p) => [total - p[0], p[1], p[2], p[3], (p[4] + 180) % 360]).reverse(),
        },
    };
}

// A lollipop: a stem up column 0 (0,0)->(1,0), a loop round the square
// (1,0)->(1,2)->(3,2)->(3,0)->(1,0), and the stem back to (0,0).
const LOLLIPOP = [[0, 0], [1, 0], [1, 2], [3, 2], [3, 0], [1, 0], [0, 0]];

describe('GPX track points', () => {
    it('follow the geometry, with the profile elevation in metres', () => {
        const pts = trackPoints(route(LOLLIPOP));
        expect(pts).toHaveLength(LOLLIPOP.length);
        expect([pts[2].lat, pts[2].lon]).toEqual(at(1, 2));
        expect(pts[0].ele).toBeCloseTo(1000 * FT, 3);
        // Elevation only rises in this profile, and ends at the last sample's.
        for (let i = 1; i < pts.length; i++) expect(pts[i].ele).toBeGreaterThan(pts[i - 1].ele);
        const last = route(LOLLIPOP).properties.elevation_profile.at(-1)[1];
        expect(pts.at(-1).ele).toBeCloseTo(last * FT, 3);
    });

    it('a reversed loop is written the other way round, although it starts and ends at the same place', () => {
        const r = route(LOLLIPOP);
        expect(profileRunsBackward(r.geometry.coordinates, r.properties.elevation_profile)).toBe(false);
        const back = reversed(r);
        expect(profileRunsBackward(back.geometry.coordinates, back.properties.elevation_profile)).toBe(true);
        const pts = trackPoints(back);
        // Round the loop the other way: after the stem it goes to (3,0), not (1,2).
        expect([pts[2].lat, pts[2].lon]).toEqual(at(3, 0));
        // The reversed profile falls, so the file's elevation falls too.
        expect(pts[0].ele).toBeGreaterThan(pts.at(-1).ele);
    });

    it('without a profile, points have no elevation', () => {
        const r = route(LOLLIPOP);
        r.properties.elevation_profile = [];
        const pts = trackPoints(r);
        expect(pts).toHaveLength(LOLLIPOP.length);
        expect(pts.every((p) => p.ele === null)).toBe(true);
        expect(routeToGpx(r)).not.toContain('<ele>');
    });
});

describe('GPX document', () => {
    it('is one track of points with elevation and no times', () => {
        const text = routeToGpx(route(LOLLIPOP), { name: 'Boone & Blowing Rock <3>', description: '5 mi loop' });
        expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
        expect(text).toContain('<gpx version="1.1" creator="Loop Finder" xmlns="http://www.topografix.com/GPX/1/1"');
        expect(text).toContain('<name>Boone &amp; Blowing Rock &lt;3&gt;</name>');
        expect(text.match(/<trkpt /g)).toHaveLength(LOLLIPOP.length);
        expect(text.match(/<ele>/g)).toHaveLength(LOLLIPOP.length);
        expect(text).toContain(`<trkpt lat="${at(0, 0)[0].toFixed(7)}" lon="${at(0, 0)[1].toFixed(7)}"><ele>304.8</ele></trkpt>`);
        expect(text).not.toContain('<time>');
        expect(text.match(/<trk>/g)).toHaveLength(1);
        expect(text.trim().endsWith('</gpx>')).toBe(true);
    });

    it('is well-formed XML', () => {
        // No DOM in these tests: a light well-formedness check (every open tag closed in order).
        const text = routeToGpx(route(LOLLIPOP), { name: 'x' });
        const stack = [];
        for (const m of text.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([a-zA-Z:]+)[^>]*?(\/?)>/g)) {
            const [, close, tag, selfClose] = m;
            if (selfClose) continue;
            if (close) expect(stack.pop()).toBe(tag);
            else stack.push(tag);
        }
        expect(stack).toEqual([]);
    });

    it('a route without geometry has no file', () => {
        expect(routeToGpx({ properties: {} })).toBeNull();
    });
});

describe('GPX names', () => {
    it('set name, place in the list and length; a favorite has no number', () => {
        const r = route(LOLLIPOP, { total_miles: 24.56, total_climb_ft: 1240 });
        const inList = gpxLabels(r, { setName: 'Dilworth, Charlotte', number: 3, units: 'mi' });
        expect(inList.name).toBe('Dilworth, Charlotte - route 3 - 24.6 mi');
        expect(inList.fileName).toBe('Dilworth, Charlotte - route 3 - 24.6 mi.gpx');
        expect(inList.description).toBe('24.6 mi loop, 1,240 ft of climbing. Made with Loop Finder.');
        const fav = gpxLabels(r, { setName: 'Dilworth, Charlotte', units: 'km' });
        expect(fav.name).toBe('Dilworth, Charlotte - 39.5 km');
        expect(fav.description).toBe('39.5 km loop, 378 m of climbing. Made with Loop Finder.');
    });

    it('file names lose characters no system allows', () => {
        expect(safeFileName('a/b:c*d?"e"<f>|g')).toBe('a b c d e f g');
        expect(safeFileName('...')).toBe('loop');
        expect(safeFileName('')).toBe('loop');
    });
});

describe('GPX of a real route', () => {
    // A lollipop the search found near Boone (8.7 mi, loop share 0.47: a long
    // stem ridden out and back). Its profile is given a smooth made-up
    // terrain so every point's elevation can be checked where it is.
    const terrain = (lat, lng) => 3000 + 30000 * (lat - 36.2) + 500 * Math.sin((lng + 81.67) * 100);
    const real = {
        ...realRoute,
        properties: {
            ...realRoute.properties,
            elevation_profile: realRoute.properties.elevation_profile.map((p) => [p[0], terrain(p[2], p[3]), p[2], p[3], p[4]]),
        },
    };
    const worstError = (r) => Math.max(...trackPoints(r).map((p) => Math.abs(p.ele / FT - terrain(p.lat, p.lon))));

    it('finds the direction both ways round', () => {
        const coords = real.geometry.coordinates;
        expect(profileRunsBackward(coords, real.properties.elevation_profile)).toBe(false);
        expect(profileRunsBackward(coords, reversed(real).properties.elevation_profile)).toBe(true);
        expect(trackPoints(reversed(real))[1].lat).toBe(coords.at(-2)[1]);
    });

    it('puts the elevation of where each point is (samples placed by position, not their distance)', () => {
        // A sample's distance can be ~100 m off on a long curvy road; by distance
        // this was ~35 ft out. What is left is the road bending between samples.
        expect(worstError(real)).toBeLessThan(10);
        expect(worstError(reversed(real))).toBeLessThan(10);
    });
});
