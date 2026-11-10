import { describe, expect, it } from 'vitest';
import { addExcludedArea, applyPaint, planRoadClick, toggleEdgesIn, toggleInArea } from '../paintRoads';
import { edgesInShape, roadOf } from '../graphRoads';
import { filterByRouteSelections } from '../routeSelections';
import { at, edgeBetween, gridIndex, routeThrough, LAT0, LNG0, DLAT, DLNG } from './fixtures';

const index = gridIndex();
const e01 = edgeBetween(index, [0, 0], [0, 1]);
const e12 = edgeBetween(index, [0, 1], [0, 2]);
const row0 = roadOf(index, e01);

const box = (r0, c0, r1, c1) => ({
    shape: 'box', south: LAT0 + r0 * DLAT, north: LAT0 + r1 * DLAT, west: LNG0 + c0 * DLNG, east: LNG0 + c1 * DLNG,
});

describe('Road tool clicks', () => {
    it('paints an unpainted road in the current mode', () => {
        const green = toggleEdgesIn([], [e01], { type: 'include', kind: 'edge' });
        expect(green).toHaveLength(1);
        expect(green[0].type).toBe('include');
        const red = toggleEdgesIn([], [e01], { type: 'exclude', kind: 'edge' });
        expect(red[0].type).toBe('exclude');
    });

    it('a click on a painted road clears it, in either mode', () => {
        const green = toggleEdgesIn([], [e01], { type: 'include', kind: 'edge' });
        expect(toggleEdgesIn(green, [e01], { type: 'exclude', kind: 'edge' })).toEqual([]);
        expect(toggleEdgesIn(green, [e01], { type: 'include', kind: 'edge' })).toEqual([]);
        const red = toggleEdgesIn([], [e01], { type: 'exclude', kind: 'edge' });
        expect(toggleEdgesIn(red, [e01], { type: 'include', kind: 'edge' })).toEqual([]);
    });

    it('Ctrl-click: a partly painted road is painted whole; a fully painted one is cleared', () => {
        const one = toggleEdgesIn([], [e01], { type: 'exclude', kind: 'edge' });
        const whole = toggleEdgesIn(one, row0, { type: 'include', kind: 'road' });
        expect(whole).toHaveLength(1);
        expect(whole[0].keys).toHaveLength(row0.length);
        expect(whole[0].type).toBe('include');
        expect(toggleEdgesIn(whole, row0, { type: 'exclude', kind: 'road' })).toEqual([]);
    });
});

describe('excluded areas', () => {
    const outline = box(-0.5, -0.5, 1.5, 1.5); // around corners (0..1, 0..1)
    const inside = edgesInShape(index, outline);

    it('keep their outline and skip roads already painted', () => {
        const green = toggleEdgesIn([], [e01], { type: 'include', kind: 'edge' });
        const next = addExcludedArea(green, inside, outline);
        const area = next[1];
        expect(area.kind).toBe('area');
        expect(area.outline).toBe(outline);
        expect(area.keys).not.toContain(e01.key);
        expect(next[0]).toBe(green[0]); // the green road is untouched
    });

    it('roads inside can be turned back on and off again; the area stays', () => {
        const list = addExcludedArea([], inside, outline);
        const id = list[0].id;
        const n = list[0].keys.length;
        const on = toggleInArea(list, id, [e01]);
        expect(on).toHaveLength(1);
        expect(on[0].keys).toHaveLength(n - 1);
        expect(on[0].keys).not.toContain(e01.key);
        const off = toggleInArea(on, id, [e01]);
        expect(off[0].keys).toHaveLength(n);
        // Every road back on: the outline is still there.
        const empty = toggleInArea(list, id, inside);
        expect(empty).toHaveLength(1);
        expect(empty[0].keys).toEqual([]);
    });

    it('a route on a road turned back on is no longer filtered out', () => {
        const route = routeThrough('r', [[0, 0], [0, 1]]); // rides e01 only
        const list = addExcludedArea([], inside, outline);
        expect(filterByRouteSelections([route], list)).toHaveLength(0);
        const on = toggleInArea(list, list[0].id, [e01]);
        expect(filterByRouteSelections([route], on)).toHaveLength(1);
    });

    it('a red road inside a green area: routes must enter the area but avoid the road', () => {
        const greenArea = { id: 'g', type: 'include', ...box(-0.5, -0.5, 0.5, 2.5) };
        const list = applyPaint([greenArea], [e01], { type: 'exclude', kind: 'edge' });
        const onRed = routeThrough('a', [[0, 0], [0, 1]]);
        const beside = routeThrough('b', [[0, 1], [0, 2]]);
        const away = routeThrough('c', [[2, 0], [3, 0]]);
        expect(filterByRouteSelections([onRed, beside, away], list).map((p) => p.id)).toEqual(['b']);
    });
});

describe('planRoadClick (what the Road tool hover shows and a click does)', () => {
    const near = (r, c) => {
        const [lat, lng] = at(r, c);
        return { lat: lat + 0.00005, lng };
    };
    const plan = (selections, latlng, opts = {}) => planRoadClick({
        roadIndex: index, selections, latlng, maxM: 30, ctrl: false, exclude: false, ...opts,
    });

    it('an unpainted road: include or exclude by mode; a painted one: clear', () => {
        expect(plan([], near(0, 0.5)).action).toBe('include');
        expect(plan([], near(0, 0.5), { exclude: true }).action).toBe('exclude');
        const green = toggleEdgesIn([], [e01], { type: 'include', kind: 'edge' });
        expect(plan(green, near(0, 0.5), { exclude: true }).action).toBe('clear');
    });

    it('inside an excluded area: reveals it and toggles its roads', () => {
        const outline = box(-0.5, -0.5, 1.5, 1.5);
        const list = addExcludedArea([], edgesInShape(index, outline), outline);
        const p = plan(list, near(0, 0.5));
        expect(p.revealId).toBe(list[0].id);
        expect(p.areaId).toBe(list[0].id);
        expect(p.action).toBe('clear'); // excluded now: a click turns it back on
        const on = toggleInArea(list, list[0].id, p.edges);
        expect(plan(on, near(0, 0.5)).action).toBe('exclude');
        // Outside the area: nothing revealed.
        expect(plan(list, near(3, 2.5)).revealId).toBeNull();
    });

    it('Ctrl inside an area only takes the part of the road inside it', () => {
        const outline = box(-0.5, -0.5, 0.5, 1.5); // row 0, columns 0..1
        const inside = edgesInShape(index, outline);
        const list = addExcludedArea([], inside, outline);
        const p = plan(list, near(0, 0.5), { ctrl: true });
        const keys = new Set(inside.map((e) => e.key));
        expect(p.edges.every((e) => keys.has(e.key))).toBe(true);
        expect(p.edges.some((e) => e.key === e12.key)).toBe(true); // e12 reaches into the box
    });
});
