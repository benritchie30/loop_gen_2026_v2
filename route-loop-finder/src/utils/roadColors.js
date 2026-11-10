/** Colours of painted roads and areas, shared by the map layers and the panel. */
export const ROAD_COLORS = {
    base: '#9aa3ad',
    baseOverTiles: '#4b5563',
    exclude: '#dc2626',
    includeEdge: '#22c55e',
    includeRoad: '#15803d',
    hover: '#3b82f6',
    clear: '#334155', // Road tool hover over a painted road: a click unpaints it
    allowed: '#64748b', // a road inside an excluded area that was turned back on
};

export function paintColor(selection) {
    if (selection.type === 'exclude') return ROAD_COLORS.exclude;
    return selection.kind === 'road' ? ROAD_COLORS.includeRoad : ROAD_COLORS.includeEdge;
}

/** Dotted area outlines: green = routes must enter it, red = routes avoid its roads. */
export const AREA_STYLE = {
    include: {
        color: '#16a34a',
        weight: 2,
        opacity: 0.9,
        dashArray: '6 6',
        fillColor: '#16a34a',
        fillOpacity: 0.05,
    },
    exclude: {
        color: '#dc2626',
        weight: 2,
        opacity: 0.9,
        dashArray: '6 6',
        fillColor: '#dc2626',
        fillOpacity: 0.06,
    },
};
