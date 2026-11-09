import { describe, expect, it } from 'vitest';
import { lineKey, routeKey } from '../routeIdentity';

// A lollipop: out along a stem, round a loop, back along the stem.
const LOOP = [
    [-80.8, 35.2], [-80.799, 35.2], [-80.798, 35.2005], [-80.797, 35.201],
    [-80.798, 35.2015], [-80.799, 35.201], [-80.799, 35.2], [-80.8, 35.2],
];
const feature = (coords) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });

describe('route identity (favorites)', () => {
    it('the same route has the same key, in any generation (another object)', () => {
        expect(routeKey(feature(LOOP))).toBe(routeKey(feature(LOOP.map((c) => [...c]))));
    });

    it('ridden the other way it is the same route', () => {
        expect(lineKey([...LOOP].reverse())).toBe(lineKey(LOOP));
    });

    it('another route is another key', () => {
        const other = LOOP.map(([x, y], i) => (i === 3 ? [x, y + 0.0003] : [x, y]));
        expect(lineKey(other)).not.toBe(lineKey(LOOP));
        expect(lineKey(LOOP.slice(0, -2))).not.toBe(lineKey(LOOP));
    });

    it('float noise and repeated points do not matter', () => {
        const noisy = LOOP.map(([x, y]) => [x + 1e-10, y - 1e-10]);
        const doubled = [LOOP[0], ...LOOP];
        expect(lineKey(noisy)).toBe(lineKey(LOOP));
        expect(lineKey(doubled)).toBe(lineKey(LOOP));
    });

    it('no line, no key', () => {
        expect(routeKey(null)).toBeNull();
        expect(routeKey({ geometry: null })).toBeNull();
        expect(lineKey([[-80.8, 35.2]])).toBeNull();
    });
});
