import { describe, expect, it } from 'vitest';
import {
    DEFAULT_SURFACE, SURFACE_PREFERENCES, profileSlice, reverseUnpaved, surfacePieces, surfacePreference, unpavedRuns, unpavedShare,
} from '../surface';

// A straight route of 7 points, 0.1 mi apart, going east.
const coords = Array.from({ length: 7 }, (_, i) => [-81 + i * 0.002, 36]);
const route = (unpaved) => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
    properties: { total_miles: 0.6, unpaved, unpaved_miles: 0.3 },
});
const latLng = (i) => [coords[i][1], coords[i][0]];

describe('unpaved stretches', () => {
    it('keeps only well-formed stretches; old routes have none', () => {
        expect(unpavedRuns({ unpaved: [[1, 3, 0.1, 0.3], [3, 3, 0.3, 0.3], ['a'], [4, 6, 0.4, 0.6]] }))
            .toEqual([[1, 3, 0.1, 0.3], [4, 6, 0.4, 0.6]]);
        expect(unpavedRuns({})).toEqual([]);
        expect(unpavedRuns(null)).toEqual([]);
    });

    it('reversed: same points, miles from the other end, in riding order', () => {
        expect(reverseUnpaved([[1, 2, 0.1, 0.2], [4, 6, 0.4, 0.6]], 0.6))
            .toEqual([[4, 6, 0, 0.2], [1, 2, 0.4, 0.5]]);
        // Twice is the original again.
        const runs = [[1, 2, 0.1, 0.2], [4, 6, 0.4, 0.6]];
        expect(reverseUnpaved(reverseUnpaved(runs, 0.6), 0.6)).toEqual(runs);
    });

    it('share of the route', () => {
        expect(unpavedShare({ total_miles: 10, unpaved_miles: 2.5 })).toBe(0.25);
        expect(unpavedShare({ total_miles: 10 })).toBeNull();
    });
});

describe('map pieces', () => {
    it('cut the line into paved and unpaved pieces that share their ends', () => {
        const pieces = surfacePieces(route([[1, 3, 0.1, 0.3], [4, 5, 0.4, 0.5]]));
        expect(pieces.unpaved).toEqual([[latLng(1), latLng(2), latLng(3)], [latLng(4), latLng(5)]]);
        expect(pieces.paved).toEqual([[latLng(0), latLng(1)], [latLng(3), latLng(4)], [latLng(5), latLng(6)]]);
    });

    it('a route unpaved from end to end has no paved piece', () => {
        const pieces = surfacePieces(route([[0, 6, 0, 0.6]]));
        expect(pieces.paved).toEqual([]);
        expect(pieces.unpaved).toEqual([coords.map((_, i) => latLng(i))]);
    });

    it('no stretches (or an old route): draw it as one line', () => {
        expect(surfacePieces(route([]))).toBeNull();
        expect(surfacePieces(route(undefined))).toBeNull();
    });

    it('overlapping or out-of-range stretches do not draw twice', () => {
        const pieces = surfacePieces(route([[1, 3, 0.1, 0.3], [2, 4, 0.2, 0.4], [5, 99, 0.5, 0.6]]));
        expect(pieces.unpaved).toEqual([[latLng(1), latLng(2), latLng(3)], [latLng(3), latLng(4)], [latLng(5), latLng(6)]]);
        expect(pieces.paved).toEqual([[latLng(0), latLng(1)], [latLng(4), latLng(5)]]);
    });
});

describe('chart shading', () => {
    const profile = [[0, 100], [1, 200], [2, 100]];
    it('the profile between two distances, ends interpolated', () => {
        expect(profileSlice(profile, 0.5, 1.5)).toEqual([[0.5, 150], [1, 200], [1.5, 150]]);
        expect(profileSlice(profile, -1, 0.5)).toEqual([[0, 100], [0.5, 150]]);
        expect(profileSlice(profile, 1.5, 9)).toEqual([[1.5, 150], [2, 100]]);
        expect(profileSlice(profile, 3, 4)).toEqual([]);
    });
});

describe('surface preference', () => {
    it('Paved only, Allow gravel (the default), Prefer gravel', () => {
        expect(SURFACE_PREFERENCES.map((p) => p.label)).toEqual(['Paved only', 'Allow gravel', 'Prefer gravel']);
        expect(SURFACE_PREFERENCES.map((p) => p.id)).toEqual(['paved', 'allow', 'gravel']); // the server's names
        expect(DEFAULT_SURFACE).toBe('allow');
    });

    it('a saved choice that is missing or unknown is the default', () => {
        expect(surfacePreference('gravel')).toBe('gravel');
        expect(surfacePreference(undefined)).toBe('allow');
        expect(surfacePreference('mud')).toBe('allow');
    });
});
