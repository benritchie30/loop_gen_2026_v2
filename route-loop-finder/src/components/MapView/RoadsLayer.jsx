import { useMemo } from 'react';
import L from 'leaflet';
import { Polyline } from 'react-leaflet';
import { ROAD_COLORS } from '../../utils/roadColors';

/**
 * The graph's roads, drawn on a canvas (tens of thousands of segments are
 * too many for SVG). Offline the roads are the basemap; over tiles they are
 * faint, so it is clear which roads the search can use. The Road tool's
 * hover highlight is a plain Leaflet layer owned by DrawingHandler.
 */
function RoadsLayer({ index, offline, show }) {
    const renderer = useMemo(() => L.canvas({ padding: 0.5 }), []);
    const positions = useMemo(() => (index ? index.edges.map((e) => e.pts) : []), [index]);

    return (
        <>
            {(show || offline) && positions.length > 0 && (
                <Polyline
                    positions={positions}
                    pathOptions={{
                        renderer,
                        color: offline ? ROAD_COLORS.base : ROAD_COLORS.baseOverTiles,
                        weight: offline ? 1.5 : 1.2,
                        opacity: offline ? 0.9 : 0.22,
                    }}
                    interactive={false}
                />
            )}
        </>
    );
}

export default RoadsLayer;
