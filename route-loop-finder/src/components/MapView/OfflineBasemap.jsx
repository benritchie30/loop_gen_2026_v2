import { useEffect, useMemo, useState } from 'react';
import L from 'leaflet';
import { Polygon, Polyline, useMap, useMapEvents } from 'react-leaflet';
import { coverageOutline, tileBounds, tileKey, tilesInBounds } from '../../utils/mapTiles';

// Below this zoom only the downloaded area is drawn (too many roads to be useful).
const ROADS_MIN_ZOOM = 10;
const ALL_ROADS_ZOOM = 12; // below it: major and minor roads only

// Drawing classes from the server (tile_roads.py): 0 major, 1 minor, 2 local, 3 paths.
const CLASS_STYLE = [
    { color: '#a3abb6', weight: 2.6 },
    { color: '#b4bbc4', weight: 1.8 },
    { color: '#c6cbd2', weight: 1.2 },
    { color: '#b9cbb6', weight: 1.1 },
];

const positionsCache = new WeakMap(); // a tile's lines -> per class [[lat, lng], ...] lists

function tilePositions(lines) {
    let cached = positionsCache.get(lines);
    if (cached) return cached;
    cached = [[], [], [], []];
    lines.forEach((line) => {
        const pts = [];
        for (let i = 1; i + 1 < line.length; i += 2) pts.push([line[i], line[i + 1]]);
        if (pts.length >= 2) (cached[line[0]] || cached[2]).push(pts);
    });
    positionsCache.set(lines, cached);
    return cached;
}

function viewOf(map) {
    const b = map.getBounds();
    return {
        zoom: map.getZoom(),
        bounds: { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() },
    };
}

/**
 * The basemap without internet: the roads of every downloaded map tile in
 * view (asked from the server per tile, GET_TILE_ROADS), on a light ground
 * that marks where map data exists, with a dashed outline around it. Outside
 * it the map is grey: a start there needs tiles that are not downloaded.
 * Draws in the "basemap" pane (MapView), under every route layer.
 */
function OfflineBasemap({ coverage, tileRoads, onNeedTiles, onCoverageInView }) {
    const map = useMap();
    // A canvas renderer draws in its own pane (not the layer's): put it under the route layers.
    const renderer = useMemo(() => L.canvas({ padding: 0.4, pane: 'basemap' }), []);
    const [view, setView] = useState(() => viewOf(map));
    useMapEvents({
        moveend: () => setView(viewOf(map)),
        zoomend: () => setView(viewOf(map)),
    });

    const deg = coverage?.deg;
    const have = useMemo(() => new Set((coverage?.tiles || []).map(([r, c]) => tileKey(r, c))), [coverage]);
    const visible = useMemo(
        () => (deg ? tilesInBounds(view.bounds, deg).filter(([r, c]) => have.has(tileKey(r, c))) : []),
        [view, deg, have],
    );

    useEffect(() => {
        onCoverageInView?.(visible.length > 0);
    }, [visible.length, onCoverageInView]);

    // Ask for the roads of the downloaded tiles in view.
    useEffect(() => {
        if (view.zoom < ROADS_MIN_ZOOM || !visible.length) return;
        const wanted = visible.filter(([r, c]) => !tileRoads[tileKey(r, c)]);
        if (wanted.length) onNeedTiles?.(wanted);
    }, [view.zoom, visible, tileRoads, onNeedTiles]);

    const ground = useMemo(
        () => (deg ? (coverage.tiles || []).map((t) => {
            const [[s, w], [n, e]] = tileBounds(t, deg);
            return [[s, w], [n, w], [n, e], [s, e]];
        }) : []),
        [coverage, deg],
    );
    const outline = useMemo(() => (deg ? coverageOutline(coverage.tiles || [], deg) : []), [coverage, deg]);

    const byClass = useMemo(() => {
        const out = [[], [], [], []];
        if (view.zoom < ROADS_MIN_ZOOM) return out;
        const classes = view.zoom >= ALL_ROADS_ZOOM ? [0, 1, 2, 3] : [0, 1];
        visible.forEach(([r, c]) => {
            const lines = tileRoads[tileKey(r, c)];
            if (!lines) return;
            const per = tilePositions(lines);
            classes.forEach((k) => { out[k] = out[k].concat(per[k]); });
        });
        return out;
    }, [view.zoom, visible, tileRoads]);

    if (!deg) return null;
    return (
        <>
            {ground.length > 0 && (
                <Polygon
                    positions={ground}
                    pathOptions={{ renderer, stroke: false, fillColor: '#fcfbf7', fillOpacity: 1 }}
                    pane="basemap"
                    interactive={false}
                />
            )}
            {[3, 2, 1, 0].map((k) => (byClass[k].length > 0 && (
                <Polyline
                    key={k}
                    positions={byClass[k]}
                    pathOptions={{ renderer, ...CLASS_STYLE[k], opacity: 1, lineCap: 'round', lineJoin: 'round' }}
                    pane="basemap"
                    interactive={false}
                />
            )))}
            {outline.length > 0 && (
                <Polyline
                    positions={outline}
                    pathOptions={{ color: '#8b95a3', weight: 1.5, opacity: 0.9, dashArray: '6 5' }}
                    pane="basemap"
                    interactive={false}
                />
            )}
        </>
    );
}

export default OfflineBasemap;
