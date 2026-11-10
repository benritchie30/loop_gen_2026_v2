import { describe, expect, it } from 'vitest';
import { FILTER_METRICS, filterByMetrics, formatUnpaved, sanitizeRouteFilters, sortPaths } from '../pathFiltering';
import { PINNED_FILTERS, SORT_OPTIONS } from '../../hooks/usePathSets';

const route = (id, miles, climb) => ({ id, properties: { total_miles: miles, total_climb_ft: climb } });

describe('sorting', () => {
    // a: 10 mi, 500 ft (50 ft/mi)   b: 20 mi, 600 ft (30 ft/mi)   c: 5 mi, 400 ft (80 ft/mi)
    const paths = [route('a', 10, 500), route('b', 20, 600), route('c', 5, 400)];

    it('offers Best, every route variable, and Similar', () => {
        expect(SORT_OPTIONS.map((o) => o.label)).toEqual([
            'Best', 'Length', 'Climb rate', 'Total climb', 'Difficulty', 'Loop share', '% Unpaved', 'Discomfort', 'Similar',
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

describe('% unpaved', () => {
    const gravel = (id, miles, unpaved) => ({ id, properties: { total_miles: miles, unpaved_miles: unpaved } });
    // a: 10% unpaved, b: none, c: half; old: saved before surfaces (no value)
    const paths = [gravel('a', 10, 1), gravel('b', 20, 0), gravel('c', 4, 2), { id: 'old', properties: { total_miles: 5 } }];

    it('sorts by the share of the route that is unpaved; routes without it last either way', () => {
        expect(sortPaths(paths, 'unpaved_share', true).map((p) => p.id)).toEqual(['b', 'a', 'c', 'old']);
        expect(sortPaths(paths, 'unpaved_share', false).map((p) => p.id)).toEqual(['c', 'a', 'b', 'old']);
    });

    it('filters by it (routes without it are kept, as for every filter)', () => {
        const kept = filterByMetrics(paths, [{ key: 'unpaved_share', range: [0, 0.2] }]);
        expect(kept.map((p) => p.id)).toEqual(['a', 'b', 'old']);
    });

    it('reads as a whole percent, a trace of gravel as <1%', () => {
        expect(formatUnpaved(0.123)).toBe('12%');
        expect(formatUnpaved(0)).toBe('0%');
        expect(formatUnpaved(0.003)).toBe('<1%');
        expect(formatUnpaved(null)).toBe('—');
    });
});

describe('filters', () => {
    it('start with Length only', () => {
        expect(PINNED_FILTERS).toEqual(['total_miles']);
    });

    it('turns are not a filter any more; a saved turns filter is dropped', () => {
        expect(FILTER_METRICS.map((m) => m.key)).not.toContain('turns');
        expect(sanitizeRouteFilters([{ key: 'turns', range: [0, 20] }, { key: 'total_miles', range: [5, 10] }]))
            .toEqual([{ key: 'total_miles', range: [5, 10] }]);
    });

    it('a climb rate range keeps the routes inside it', () => {
        const paths = [route('a', 10, 500), route('b', 20, 600), route('c', 5, 400)];
        const kept = filterByMetrics(paths, [{ key: 'climb_rate', range: [40, 60] }]);
        expect(kept.map((p) => p.id)).toEqual(['a']);
    });
});
