import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';

function boundaryToLatLngBounds(boundary) {
    if (!boundary?.type) return null;

    if (boundary.type === 'box' &&
        [boundary.north, boundary.south, boundary.east, boundary.west].every((v) => v != null)) {
        return L.latLngBounds(
            [boundary.south, boundary.west],
            [boundary.north, boundary.east]
        );
    }

    if (boundary.type === 'polygon' && Array.isArray(boundary.coordinates) && boundary.coordinates.length >= 3) {
        return L.latLngBounds(boundary.coordinates.map(([lat, lng]) => [lat, lng]));
    }

    if (boundary.type === 'circle' && boundary.center != null && boundary.radius_miles != null) {
        const lat = Array.isArray(boundary.center) ? boundary.center[0] : boundary.center.lat;
        const lng = Array.isArray(boundary.center) ? boundary.center[1] : boundary.center.lng;
        if (lat == null || lng == null) return null;
        const latDelta = boundary.radius_miles / 69.0;
        const lngDelta = boundary.radius_miles / (69.0 * Math.cos(lat * Math.PI / 180));
        return L.latLngBounds(
            [lat - latDelta, lng - lngDelta],
            [lat + latDelta, lng + lngDelta]
        );
    }

    return null;
}

/**
 * Pans/zooms the map to the active graph's saved boundary when the user switches graphs.
 */
export default function FitMapToGraphBoundary({ activeGraph, graphBoundaries, mode }) {
    const map = useMap();
    const prevActiveGraphRef = useRef(undefined);
    const lastFittedGraphRef = useRef(null);

    useEffect(() => {
        const prevActive = prevActiveGraphRef.current;
        prevActiveGraphRef.current = activeGraph;

        if (mode === 'graphCreate' || !activeGraph) return;

        const boundary = graphBoundaries?.[activeGraph];
        if (!boundary) return;

        const graphChanged = prevActive != null && prevActive !== activeGraph;
        const needsFitForNewBoundary =
            lastFittedGraphRef.current !== activeGraph;

        if (prevActive === undefined) {
            lastFittedGraphRef.current = activeGraph;
            return;
        }

        if (!graphChanged && !needsFitForNewBoundary) return;

        const bounds = boundaryToLatLngBounds(boundary);
        if (!bounds || !bounds.isValid()) return;

        map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });
        lastFittedGraphRef.current = activeGraph;

        try {
            const center = map.getCenter();
            localStorage.setItem('lastMapPosition', JSON.stringify({
                center: [center.lat, center.lng],
                zoom: map.getZoom(),
            }));
        } catch {
            // ignore storage errors
        }
    }, [activeGraph, graphBoundaries, mode, map]);

    return null;
}
