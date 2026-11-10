import { describe, expect, it } from 'vitest';
import { rangeTotals } from '../profileStats';

// Up 100, down 50, up 30, down 80: [dist, elev]
const profile = [[0, 1000], [1, 1100], [2, 1050], [3, 1080], [4, 1000]];

describe('totals of a stretch of the profile', () => {
    it('the whole route: its length, climb and descent', () => {
        expect(rangeTotals(profile)).toEqual({ distance: 4, climb: 130, descent: 130 });
    });

    it('a part, ends interpolated', () => {
        // 0.5 -> 2.5: from 1050 up to 1100, down to 1050, up to 1065
        expect(rangeTotals(profile, 0.5, 2.5)).toEqual({ distance: 2, climb: 65, descent: 50 });
    });

    it('a part past the ends is cut to the route', () => {
        expect(rangeTotals(profile, 3, 10)).toEqual({ distance: 1, climb: 0, descent: 80 });
    });

    it('nothing to total', () => {
        expect(rangeTotals([[0, 1]])).toBeNull();
        expect(rangeTotals(profile, 5, 6)).toEqual({ distance: 0, climb: 0, descent: 0 });
    });
});
