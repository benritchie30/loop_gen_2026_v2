import { describe, expect, it } from 'vitest';
import {
    automaticArea, boundaryBounds, boundaryContains, boundaryKey, boundaryPayload, cleanShapes, shapeLabel,
    simplifyOutline,
} from '../boundary';
import { metersBetween } from '../routeSelections';

const box = { shape: 'box', north: 35.21, south: 35.19, east: -80.78, west: -80.82 };
const circle = { shape: 'circle', lat: 35.3, lng: -80.8, radiusM: 500 };

describe('custom boundaries', () => {
    it('keeps only valid shapes; no shapes is the automatic area', () => {
        expect(cleanShapes([box, { shape: 'box', north: 1, south: 2, east: 0, west: 1 }, { shape: 'circle', radiusM: 5 }]))
            .toEqual([box]);
        expect(boundaryPayload({ name: 'x', shapes: [] })).toBeNull();
        expect(boundaryPayload({ id: 'a', name: 'x', shapes: [box] })).toEqual({ shapes: [box] });
    });

    it('the same shapes have the same key, whatever the name', () => {
        expect(boundaryKey({ name: 'a', shapes: [box] })).toBe(boundaryKey({ name: 'b', shapes: [{ ...box }] }));
        expect(boundaryKey({ shapes: [box] })).not.toBe(boundaryKey({ shapes: [box, circle] }));
        expect(boundaryKey(null)).toBeNull();
    });

    it('inside any of its shapes', () => {
        const b = { shapes: [box, circle] };
        expect(boundaryContains(b, 35.2, -80.8)).toBe(true);
        expect(boundaryContains(b, 35.3, -80.801)).toBe(true);
        expect(boundaryContains(b, 35.25, -80.8)).toBe(false);
    });

    it('bounds around every shape', () => {
        const b = boundaryBounds({ shapes: [box, circle] });
        expect(b.south).toBe(35.19);
        expect(b.north).toBeCloseTo(35.3 + 500 / 111320, 6);
        expect(boundaryBounds({ shapes: [] })).toBeNull();
    });

    it('a drawn outline is simplified to a few points that still follow it', () => {
        // A wobbly circle of 400 points.
        const drawn = Array.from({ length: 400 }, (_, i) => {
            const t = (2 * Math.PI * i) / 400;
            const r = 0.01 * (1 + 0.002 * Math.sin(37 * t));
            return [35.2 + r * Math.sin(t), -80.8 + r * Math.cos(t)];
        });
        const simple = simplifyOutline(drawn);
        expect(simple.length).toBeGreaterThanOrEqual(3);
        expect(simple.length).toBeLessThanOrEqual(40);
        expect(boundaryContains({ shapes: [{ shape: 'freeform', coordinates: simple }] }, 35.2, -80.8)).toBe(true);
        expect(simplifyOutline(drawn.slice(0, 10))).toHaveLength(10);
        // Handles to drag: no two points close together, also where the drawing closed its loop.
        const gaps = simple.map((p, i) => {
            const q = simple[(i + 1) % simple.length];
            return metersBetween(p[0], p[1], q[0], q[1]);
        });
        // Its size: from where the drawing began (the east side) to the far side.
        const across = metersBetween(35.2, -80.81, 35.2, -80.79);
        expect(Math.min(...gaps)).toBeGreaterThan(across / 10 - 5);
    });

    it('labels', () => {
        expect(shapeLabel(circle)).toBe('Circle, 0.6 mi across');
        expect(shapeLabel(box, 'km')).toMatch(/^Box, 3\.6 × 2\.2 km$/);
        expect(shapeLabel({ shape: 'freeform', coordinates: [[0, 0], [0, 1], [1, 1]] })).toBe('Freeform, 3 points');
    });
});

describe('the automatic search area on the map', () => {
    const marker = { lat: 35.2, lng: -80.8 };
    const plan = { marker, miles: 20, boundary: null, editing: false, favoritesTab: false };
    const gen = { start: marker, miles: 30, boundary: null, show: true };

    it('the plan draws max / 2 around the pin', () => {
        expect(automaticArea('input', plan, gen)).toEqual({ lat: 35.2, lng: -80.8, miles: 20 });
    });

    it('a custom boundary, the editor, the Favorites tab and no pin draw nothing', () => {
        expect(automaticArea('input', { ...plan, boundary: { shapes: [box] } }, gen)).toBeNull();
        expect(automaticArea('input', { ...plan, editing: true }, gen)).toBeNull();
        expect(automaticArea('input', { ...plan, favoritesTab: true }, gen)).toBeNull();
        expect(automaticArea('input', { ...plan, marker: null }, gen)).toBeNull();
        expect(automaticArea('input', { ...plan, miles: 0 }, gen)).toBeNull();
    });

    it('an open generation follows the More routes length, with the option on', () => {
        expect(automaticArea('display', plan, gen)).toEqual({ lat: 35.2, lng: -80.8, miles: 30 });
        expect(automaticArea('display', plan, { ...gen, miles: 45 })).toEqual({ lat: 35.2, lng: -80.8, miles: 45 });
        expect(automaticArea('display', plan, { ...gen, show: false })).toBeNull();
        expect(automaticArea('display', plan, { ...gen, boundary: { shapes: [box] } })).toBeNull();
        expect(automaticArea('display', plan, { ...gen, start: null })).toBeNull();
    });
});
