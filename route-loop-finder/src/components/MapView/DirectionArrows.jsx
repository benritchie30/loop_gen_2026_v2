import { useMemo } from 'react';
import { Marker } from 'react-leaflet';
import L from 'leaflet';

/**
 * Create a rotated arrow DivIcon using an SVG arrow.
 * bearingDeg is geographic (0=north, 90=east).
 * The SVG arrow points east (right) by default, so we subtract 90° for CSS rotation.
 */
function createArrowIcon(bearingDeg, color) {
    const cssRotation = bearingDeg - 90;
    return L.divIcon({
        className: 'direction-arrow',
        html: `<div class="direction-arrow__inner" style="transform: rotate(${cssRotation}deg)">
            <svg viewBox="0 0 24 24" width="32" height="32">
                <path d="M8 4 L16 12 L8 20" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
            </svg>
        </div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    });
}

/**
 * Renders directional arrow markers along the active path.
 * Uses the elevation_profile array: [dist_mi, elev_ft, lat, lng, bearing_deg].
 * Bearing is pre-computed in the backend from the actual edge geometry.
 * Places an arrow every `intervalMiles` miles along the path.
 */
function DirectionArrows({ elevationProfile, intervalMiles = 1, color = '#e63946' }) {
    const arrows = useMemo(() => {
        if (!elevationProfile || elevationProfile.length < 2) return [];

        const result = [];
        let nextMileMark = intervalMiles;

        for (let i = 0; i < elevationProfile.length; i++) {
            const pt = elevationProfile[i];
            if (pt.length < 5) continue; // need [dist, elev, lat, lng, bearing]

            const dist = pt[0];
            if (dist < nextMileMark) continue;

            result.push({
                lat: pt[2],
                lng: pt[3],
                bearing: pt[4],
                key: `arrow-${i}`
            });
            nextMileMark = dist + intervalMiles;
        }
        return result;
    }, [elevationProfile, intervalMiles]);

    return (
        <>
            {arrows.map(({ lat, lng, bearing, key }) => (
                <Marker
                    key={key}
                    position={[lat, lng]}
                    icon={createArrowIcon(bearing, color)}
                    interactive={false}
                />
            ))}
        </>
    );
}

export default DirectionArrows;
