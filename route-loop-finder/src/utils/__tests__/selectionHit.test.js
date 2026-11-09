import { describe, expect, it } from 'vitest';
import { distanceToOutline, selectionAt } from '../selectionHit';
import { addExcludedArea, toggleEdgesIn } from '../paintRoads';
import { edgesInShape, roadOf } from '../graphRoads';
import { at, edgeBetween, gridIndex, LAT0, LNG0 } from './fixtures';

const index = gridIndex();
const M_LAT = 1 / 111320;

describe('double-click to remove (selectionAt)', () => {
    it('hits a painted road near the pointer and returns its whole selection', () => {
        const row = roadOf(index, edgeBetween(index, [2, 0], [2, 1]));
        const list = toggleEdgesIn([], row, { type: 'include', kind: 'road' });
        const [lat, lng] = at(2, 2.5);
        expect(selectionAt(list, lat + 10 * M_LAT, lng, 30)?.id).toBe(list[0].id);
        expect(selectionAt(list, lat + 80 * M_LAT, lng, 30)).toBeNull();
    });

    it('hits an area on its outline, not in the middle', () => {
        const circle = { id: 'c', type: 'include', shape: 'circle', lat: LAT0, lng: LNG0, radiusM: 200 };
        expect(distanceToOutline(circle, LAT0 + 190 * M_LAT, LNG0)).toBeCloseTo(10, 0);
        expect(selectionAt([circle], LAT0 + 190 * M_LAT, LNG0, 30)?.id).toBe('c');
        expect(selectionAt([circle], LAT0, LNG0, 30)).toBeNull();
    });

    it('an excluded area is hit on its outline; its hidden roads are not', () => {
        const outline = { shape: 'box', south: LAT0 - 0.0005, north: LAT0 + 0.0025, west: LNG0 - 0.0005, east: LNG0 + 0.0015 };
        const list = addExcludedArea([], edgesInShape(index, outline), outline);
        const [lat, lng] = at(1, 0.5); // on a red road, far from the outline
        expect(selectionAt(list, lat, lng, 20)).toBeNull();
        expect(selectionAt(list, outline.north + 5 * M_LAT, lng, 20)?.id).toBe(list[0].id);
    });
});
