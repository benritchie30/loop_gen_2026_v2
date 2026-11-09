import { describe, expect, it } from 'vitest';
import { filterByMetrics, sortPaths } from '../pathFiltering';
import { PINNED_FILTERS, SORT_OPTIONS } from '../../hooks/usePathSets';

const route = (id, miles, climb) => ({ id, properties: { total_miles: miles, total_climb_ft: climb } });

describe('sorting', () => {
    // a: 10 mi, 500 ft (50 ft/mi)   b: 20 mi, 600 ft (30 ft/mi)   c: 5 mi, 400 ft (80 ft/mi)
    const paths = [route('a', 10, 500), route('b', 20, 600), route('c', 5, 400)];

    it('offers Best, every route variable, and Similar', () => {
        expect(SORT_OPTIONS.map((o) => o.label)).toEqual([
            'Best', 'Length', 'Climb rate', 'Total climb', 'Difficulty', 'Loop share', 'Turns', 'Discomfort', 'Similar',
        ]);
    });

    it('climb rate sorts by climb per mile, not total climb', () => {
        expect(sortPaths(paths, 'climb_rate', true).map((p) => p.id)).toEqual(['b', 'a', 'c']);
        expect(sortPaths(paths, 'total_climb_ft', true).map((p) => p.id)).toEqual(['c', 'a', 'b']);
    });

    it('flipping reverses', () => {
        expect(sortPaths(paths, 'total_miles', false).map((p) => p.id)).toEqual(['b', 'a', 'c']);
        expect(sortPaths(paths, 'found', false).map((p) => p.id)).toEqual(['c', 'b', 'a']);
    });
});

describe('filters', () => {
    it('start with Length only', () => {
        expect(PINNED_FILTERS).toEqual(['total_miles']);
    });

    it('a climb rate range keeps the routes inside it', () => {
        const paths = [route('a', 10, 500), route('b', 20, 600), route('c', 5, 400)];
        const kept = filterByMetrics(paths, [{ key: 'climb_rate', range: [40, 60] }]);
        expect(kept.map((p) => p.id)).toEqual(['a']);
    });
});
