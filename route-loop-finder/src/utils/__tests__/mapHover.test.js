import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachProximityHover } from '../mapHover';

/** A stand-in for a Leaflet map: handlers by event name, and a container. */
function fakeMap() {
    const handlers = {};
    const domHandlers = {};
    return {
        on: (name, fn) => { handlers[name] = fn; },
        off: (name) => { delete handlers[name]; },
        getContainer: () => ({
            addEventListener: (name, fn) => { domHandlers[name] = fn; },
            removeEventListener: (name) => { delete domHandlers[name]; },
        }),
        move: (lat, lng) => handlers.mousemove?.({ latlng: { lat, lng }, containerPoint: { x: 0, y: 0 }, originalEvent: {} }),
        leave: () => domHandlers.mouseleave?.(),
        handlers,
    };
}

let frames = [];
beforeEach(() => {
    frames = [];
    globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    globalThis.cancelAnimationFrame = () => { frames = []; };
    globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };
});
const flush = () => { const run = frames; frames = []; run.forEach((fn) => fn()); };

describe('attachProximityHover (shared by the Road tool and the route marker)', () => {
    it('runs pick once per frame on the latest pointer spot', () => {
        const map = fakeMap();
        const pick = vi.fn(({ latlng }) => ({ v: Math.round(latlng.lat) }));
        const onChange = vi.fn();
        attachProximityHover(map, { pick, keyOf: (r) => r.v, onChange });
        map.move(1, 0);
        map.move(2, 0);
        map.move(3, 0);
        flush();
        expect(pick).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenLastCalledWith({ v: 3 });
    });

    it('only reports changes, and null when the pointer leaves', () => {
        const map = fakeMap();
        const onChange = vi.fn();
        attachProximityHover(map, { pick: () => ({ v: 1 }), keyOf: (r) => r.v, onChange });
        map.move(1, 0); flush();
        map.move(1.1, 0); flush();
        expect(onChange).toHaveBeenCalledTimes(1);
        map.leave();
        expect(onChange).toHaveBeenLastCalledWith(null);
    });

    it('detach removes the listeners and clears what was shown', () => {
        const map = fakeMap();
        const onChange = vi.fn();
        const hover = attachProximityHover(map, { pick: () => ({ v: 1 }), keyOf: (r) => r.v, onChange });
        map.move(1, 0); flush();
        hover.detach();
        expect(map.handlers.mousemove).toBeUndefined();
        expect(onChange).toHaveBeenLastCalledWith(null);
    });
});
