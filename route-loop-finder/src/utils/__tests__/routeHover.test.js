import { describe, expect, it } from 'vitest';
import { nearestOnProfile, pointerReachM, routeForClick, routeHoverReachM, routesAtPoint } from '../routeHover';
import { at, routeThrough } from './fixtures';

const M_LAT = 1 / 111320; // degrees of latitude per metre

describe('nearestOnProfile (hover marker)', () => {
    const route = routeThrough('r', [[0, 0], [0, 3], [3, 3]]);
    const profile = route.properties.elevation_profile;

    it('finds the route when the pointer is near it, not only on it', () => {
        const [lat, lng] = at(0, 1.5);
        const hit = nearestOnProfile(profile, lat + 20 * M_LAT, lng, 40);
        expect(hit).not.toBeNull();
        expect(hit.offM).toBeCloseTo(20, 0);
        expect(hit.coordinate[0]).toBeCloseTo(lat, 6); // snapped onto the road
    });

    it('is null outside the reach', () => {
        const [lat, lng] = at(0, 1.5);
        expect(nearestOnProfile(profile, lat + 60 * M_LAT, lng, 40)).toBeNull();
    });

    it('glides between samples (interpolates distance and elevation)', () => {
        const a = profile[4];
        const b = profile[5];
        const lat = (a[2] + b[2]) / 2;
        const lng = (a[3] + b[3]) / 2;
        const hit = nearestOnProfile(profile, lat, lng, 30);
        expect(hit.distance).toBeGreaterThan(a[0]);
        expect(hit.distance).toBeLessThan(b[0]);
        expect(hit.elevation).toBeCloseTo((a[1] + b[1]) / 2, 5);
    });

    it('moving along the route never loses it (no flicker)', () => {
        for (let c = 0; c <= 3; c += 0.05) {
            const [lat, lng] = at(0, c);
            expect(nearestOnProfile(profile, lat + 15 * M_LAT, lng, 40)).not.toBeNull();
        }
    });

    it('on an out-and-back stem, stays on the leg it is on', () => {
        // Out along row 0 and back the same way: every spot is passed twice.
        const stem = routeThrough('s', [[0, 0], [0, 3], [0, 0]]).properties.elevation_profile;
        const total = stem[stem.length - 1][0];
        const [lat, lng] = at(0, 1);
        const out = nearestOnProfile(stem, lat, lng, 30, 0.05); // coming from the start
        const back = nearestOnProfile(stem, lat, lng, 30, total - 0.05); // coming back
        expect(out.distance).toBeLessThan(total / 2);
        expect(back.distance).toBeGreaterThan(total / 2);
    });
});

describe('pointerReachM', () => {
    it('is 24 px of ground, and never less than 30 m', () => {
        expect(pointerReachM(13, 36)).toBeGreaterThan(300);
        expect(pointerReachM(20, 36)).toBe(30);
    });
});

describe('clicking routes (pan mode)', () => {
    const a = routeThrough('a', [[0, 0], [0, 3]]);
    const b = routeThrough('b', [[0, 0], [0, 3], [3, 3]]);
    const c = routeThrough('c', [[1, 0], [1, 3]]); // the next road north
    const paths = [a, b, c];
    const [lat, lng] = at(0, 1.5);

    it('lists only routes on the road nearest the click', () => {
        const ids = routesAtPoint(paths, lat + 10 * M_LAT, lng, 200).map((p) => p.id);
        expect(ids).toEqual(['a', 'b']);
    });

    it('shows the first route there, then cycles through them on later clicks', () => {
        expect(routeForClick(paths, 'c', lat, lng, 200).id).toBe('a');
        expect(routeForClick(paths, 'a', lat, lng, 200).id).toBe('b');
        expect(routeForClick(paths, 'b', lat, lng, 200).id).toBe('a');
    });

    it('does nothing far from every route', () => {
        expect(routeForClick(paths, 'a', lat - 500 * M_LAT, lng, 50)).toBeNull();
    });
});

describe('routeHoverReachM (hover marker reach)', () => {
    it('reaches twice as far as a click, and further still once shown', () => {
        const click = pointerReachM(13, 36);
        const appear = routeHoverReachM(13, 36, false);
        const keep = routeHoverReachM(13, 36, true);
        expect(appear).toBeCloseTo(click * 2, 5);
        expect(keep).toBeGreaterThan(appear);
    });

    it('finds the route 40 px away at street zoom', () => {
        const route = routeThrough('r', [[0, 0], [0, 3]]);
        const [lat, lng] = at(0, 1.5);
        const mpp = 156543.03392 * Math.cos((lat * Math.PI) / 180) / (2 ** 16);
        const off = 40 * mpp * M_LAT;
        expect(nearestOnProfile(route.properties.elevation_profile, lat + off, lng, routeHoverReachM(16, lat))).not.toBeNull();
        expect(nearestOnProfile(route.properties.elevation_profile, lat + off, lng, pointerReachM(16, lat))).toBeNull();
    });
});
