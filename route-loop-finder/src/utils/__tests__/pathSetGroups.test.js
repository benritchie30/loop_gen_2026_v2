import { describe, expect, it } from 'vitest';
import { groupByStart, groupFavorites, lengthRange, sameStart, setsAtStart, SAME_START_M } from '../pathSetGroups';

const M_LAT = 1 / 111320;
const A = { lat: 35.2, lng: -80.8 };
const north = (p, m) => ({ lat: p.lat + m * M_LAT, lng: p.lng });

describe('sets that share a start', () => {
    it('the same start allows a few metres', () => {
        expect(sameStart(A, north(A, SAME_START_M - 2))).toBe(true);
        expect(sameStart(A, north(A, SAME_START_M + 2))).toBe(false);
        expect(sameStart(A, null)).toBe(false);
    });

    it('one pin per start, with every set of it', () => {
        const groups = groupByStart([
            { id: 'a', position: A },
            { id: 'b', position: north(A, 500) },
            { id: 'c', position: north(A, 5) },
            { id: 'd', position: null },
        ]);
        expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['a', 'c'], ['b']]);
        expect(groups[0].position).toBe(A);
        expect(groups[0].key).toBe('a');
    });

    it('sets at a start, newest first; none for no start', () => {
        const gens = [
            { id: 'old', markerPosition: A, createdAt: 1 },
            { id: 'far', markerPosition: north(A, 300), createdAt: 3 },
            { id: 'new', markerPosition: north(A, 3), createdAt: 2 },
        ];
        expect(setsAtStart(gens, A).map((g) => g.id)).toEqual(['new', 'old']);
        expect(setsAtStart(gens, null)).toEqual([]);
    });
});

describe('length range of a set', () => {
    it('shortest and longest route', () => {
        const paths = [7.2, 14.9, 9.1].map((m) => ({ properties: { total_miles: m } }));
        expect(lengthRange(paths)).toEqual([7.2, 14.9]);
        expect(lengthRange([])).toBeNull();
        expect(lengthRange([{ properties: {} }])).toBeNull();
    });
});

describe('favorites grouped by start', () => {
    const fav = (key, start, createdAt, pathSetId = null, setName = null) => ({ key, start, createdAt, pathSetId, setName });

    it('newest first, one group per start, opening the favorite\'s own generation', () => {
        const gens = [
            { id: 'g1', name: 'Dilworth', markerPosition: A, createdAt: 1 },
            { id: 'g2', name: 'Dilworth 2', markerPosition: A, createdAt: 2 },
        ];
        const groups = groupFavorites([
            fav('a', A, 1, 'g1', 'Dilworth'),
            fav('b', north(A, 900), 3, 'gone', 'Boone'),
            fav('c', north(A, 4), 2, 'g1', 'Dilworth'),
        ], gens);
        expect(groups.map((g) => g.records.map((r) => r.key))).toEqual([['b'], ['c', 'a']]);
        expect(groups[1]).toMatchObject({ setId: 'g1', title: 'Dilworth' });
    });

    it('a deleted generation: another one at that start, else none (its saved name)', () => {
        const gens = [{ id: 'g2', name: 'Dilworth 2', markerPosition: A, createdAt: 2 }];
        const [here] = groupFavorites([fav('a', A, 1, 'gone', 'Dilworth')], gens);
        expect(here).toMatchObject({ setId: 'g2', title: 'Dilworth 2' });
        const [away] = groupFavorites([fav('b', north(A, 900), 1, 'gone', 'Boone')], gens);
        expect(away).toMatchObject({ setId: null, title: 'Boone' });
    });

    it('favorites without a start are one group at the end', () => {
        const groups = groupFavorites([fav('x', null, 5), fav('a', A, 1)], []);
        expect(groups.map((g) => g.key)).toEqual(['a', 'no-start']);
        expect(groups[1].position).toBeNull();
    });
});
