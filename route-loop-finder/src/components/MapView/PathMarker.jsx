import { Marker } from 'react-leaflet';
import L from 'leaflet';
import { useMemo } from 'react';

// Create custom marker icons using SVG for cleaner rendering
const createMarkerIcon = (color) => {
    const colors = {
        pending: '#3068c8',   // Medium blue
        active: '#1e3a5f',    // Dark navy
        inactive: '#94a3b8'   // Cool slate
    };

    const fillColor = colors[color] || colors.inactive;

    const svgIcon = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="24" height="36">
      <path fill="${fillColor}" stroke="#fff" stroke-width="1" d="M12 0C5.4 0 0 5.4 0 12c0 7.2 12 24 12 24s12-16.8 12-24c0-6.6-5.4-12-12-12z"/>
      <circle fill="#fff" cx="12" cy="12" r="4"/>
    </svg>
  `;

    return L.divIcon({
        html: svgIcon,
        className: 'custom-marker-icon',
        iconSize: [24, 36],
        iconAnchor: [12, 36],
        popupAnchor: [0, -36]
    });
};

/**
 * Reusable marker component with configurable colors.
 */
function PathMarker({ position, color = 'inactive', onClick, title, zIndexOffset = 0 }) {
    const icon = useMemo(() => createMarkerIcon(color), [color]);

    // Handle both { lat, lng } and [lat, lng] formats
    const markerPosition = Array.isArray(position)
        ? position
        : [position.lat, position.lng];

    const eventHandlers = useMemo(() => ({
        click: (e) => {
            if (onClick) {
                // Stop propagation to prevent map click
                L.DomEvent.stopPropagation(e);
                onClick(e);
            }
        }
    }), [onClick]);

    return (
        <Marker
            position={markerPosition}
            icon={icon}
            title={title || undefined}
            zIndexOffset={zIndexOffset}
            eventHandlers={eventHandlers}
        />
    );
}

export default PathMarker;
