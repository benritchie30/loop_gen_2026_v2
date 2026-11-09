import { useSyncExternalStore } from 'react';

/**
 * The point of the shown route under the pointer, shared by the map marker and
 * the elevation chart: { distance (mi), elevation (ft), coordinate: [lat, lng],
 * bearing, source: 'map' | 'chart' } or null. It changes on every pointer
 * move, so it lives outside React state: only the marker and the chart
 * re-render, not the whole app.
 */
let current = null;
const listeners = new Set();

export const hoverPoint = {
    get: () => current,
    set(next) {
        if (next === current) return;
        current = next;
        listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
};

export function useHoverPoint() {
    return useSyncExternalStore(hoverPoint.subscribe, hoverPoint.get);
}
