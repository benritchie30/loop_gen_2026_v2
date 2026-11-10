import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import { attachProximityHover } from '../../utils/mapHover';
import { nearestOnProfile, routeHoverReachM } from '../../utils/routeHover';
import { hoverPoint } from '../../hooks/useHoverPoint';

/**
 * The marker on the shown route that follows the pointer (pan mode) and the
 * elevation chart's cursor. The pointer only has to be near the route
 * (routeHoverReachM: 48 px to appear, 64 px to keep it). The marker is one
 * Leaflet layer moved in place.
 */
function RouteHover({ profile, enabled, color, pane }) {
    const map = useMap();

    // The marker follows the shared hover point, whoever set it (map or chart).
    useEffect(() => {
        const marker = L.circleMarker([0, 0], {
            radius: 7,
            color: '#ffffff',
            weight: 2.5,
            fillColor: color,
            fillOpacity: 1,
            interactive: false,
            pane,
            className: 'route-hover-marker',
        });
        const show = () => {
            const point = hoverPoint.get();
            if (point?.coordinate) {
                marker.setLatLng(point.coordinate);
                if (!map.hasLayer(marker)) marker.addTo(map);
            } else if (map.hasLayer(marker)) {
                marker.remove();
            }
        };
        show();
        const unsubscribe = hoverPoint.subscribe(show);
        return () => {
            unsubscribe();
            marker.remove();
        };
    }, [map, color, pane]);

    // Pointer near the route: the nearest point of it becomes the hover point.
    useEffect(() => {
        if (!enabled || !Array.isArray(profile) || profile.length < 2) return undefined;
        let previous = null;
        const hover = attachProximityHover(map, {
            pick: ({ latlng }) => nearestOnProfile(
                profile,
                latlng.lat,
                latlng.lng,
                routeHoverReachM(map.getZoom(), latlng.lat, previous != null),
                previous?.distance ?? null,
            ),
            keyOf: (hit) => `${hit.coordinate[0].toFixed(7)},${hit.coordinate[1].toFixed(7)}`,
            onChange: (hit) => {
                previous = hit;
                hoverPoint.set(hit ? { ...hit, source: 'map' } : null);
            },
        });
        return () => hover.detach();
    }, [map, enabled, profile]);

    // Another route (or none): the old point means nothing.
    useEffect(() => () => hoverPoint.set(null), [profile]);

    return null;
}

export default RouteHover;
