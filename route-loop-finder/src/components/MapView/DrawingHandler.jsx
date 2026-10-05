import { useCallback, useEffect, useRef, useState } from 'react';
import { Circle, Polygon, Rectangle, useMap } from 'react-leaflet';
import {
    metersBetween,
    MIN_DRAG_M,
    POINT_RADIUS_M,
    snapToRoutes,
    snapToleranceMeters,
} from '../../utils/routeSelections';

function newId() {
    return `sel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function boxFromCorners(a, b) {
    return {
        north: Math.max(a.lat, b.lat),
        south: Math.min(a.lat, b.lat),
        east: Math.max(a.lng, b.lng),
        west: Math.min(a.lng, b.lng),
    };
}

function thinCoordinates(latlngs) {
    if (!latlngs.length) return [];
    const out = [[latlngs[0].lat, latlngs[0].lng]];
    for (let i = 1; i < latlngs.length; i++) {
        const prev = out[out.length - 1];
        if (metersBetween(prev[0], prev[1], latlngs[i].lat, latlngs[i].lng) >= 12) {
            out.push([latlngs[i].lat, latlngs[i].lng]);
        }
    }
    const last = latlngs[latlngs.length - 1];
    const end = out[out.length - 1];
    if (end[0] !== last.lat || end[1] !== last.lng) {
        out.push([last.lat, last.lng]);
    }
    return out;
}

const DRAFT_STYLE = {
    color: '#6e8cae',
    weight: 2,
    opacity: 0.9,
    dashArray: '4 6',
    fillColor: '#6e8cae',
    fillOpacity: 0.06,
};

const EXCLUDE_DRAFT = {
    ...DRAFT_STYLE,
    color: '#b56b6b',
    fillColor: '#b56b6b',
};

function dragThresholdMeters(zoom, lat) {
    const metersPerPixel = 156543.03392 * Math.cos(lat * Math.PI / 180) / (2 ** zoom);
    return Math.max(MIN_DRAG_M, 8 * metersPerPixel);
}

function isClick(current, thresholdM) {
    if (current.kind === 'circle') return current.radiusM < thresholdM;
    if (current.kind === 'box') {
        const box = boxFromCorners(current.a, current.b);
        const height = metersBetween(box.south, box.west, box.north, box.west);
        const width = metersBetween(box.south, box.west, box.south, box.east);
        return height < thresholdM && width < thresholdM;
    }
    if (current.kind === 'freeform') {
        const start = current.points[0];
        if (!start) return true;
        return current.points.every((point) => (
            metersBetween(start.lat, start.lng, point.lat, point.lng) < thresholdM
        ));
    }
    return false;
}

function clickLatLng(current) {
    if (current.kind === 'box') return { lat: current.a.lat, lng: current.a.lng };
    if (current.kind === 'freeform') return { lat: current.points[0].lat, lng: current.points[0].lng };
    return { lat: current.lat, lng: current.lng };
}

/**
 * Circle, box, and freeform gestures. A click without a drag drops a pin.
 * Graph-creation exclusion reuses the freeform drag and reports raw coordinates.
 */
function DrawingHandler({
    activeTool,
    isExcludeMode,
    exclusionDraw = false,
    snapPaths = [],
    onSelection,
    onDrawingComplete,
    onSnapMiss,
    draftingRef,
    pinOnClick = false,
}) {
    const map = useMap();
    const draftRef = useRef(null);
    const [draft, setDraft] = useState(null);

    const writeDraft = useCallback((next) => {
        draftRef.current = next;
        setDraft(next);
    }, []);

    useEffect(() => {
        if (!draftingRef) return undefined;
        draftingRef.current = () => {
            if (!draftRef.current) return false;
            draftRef.current = null;
            setDraft(null);
            return true;
        };
        return () => {
            draftingRef.current = null;
        };
    }, [draftingRef]);

    useEffect(() => {
        const el = map.getContainer();
        const drawing = activeTool === 'circle' || activeTool === 'box' || activeTool === 'freeform';
        if (drawing) {
            el.classList.add('route-tool-active');
            el.style.cursor = 'crosshair';
            map.boxZoom.disable();
            map.dragging.disable();
        } else {
            el.classList.remove('route-tool-active');
            el.style.cursor = '';
            map.dragging.enable();
            map.boxZoom.enable();
            writeDraft(null);
        }
        return () => {
            el.classList.remove('route-tool-active');
            el.style.cursor = '';
            map.dragging.enable();
            map.boxZoom.enable();
        };
    }, [activeTool, map, writeDraft]);

    const dropPoint = useCallback((lat, lng, exclude) => {
        const maxM = snapToleranceMeters(map.getZoom(), lat);
        const snapped = snapToRoutes(snapPaths, lat, lng, maxM);
        if (!snapped) {
            onSnapMiss?.();
            return;
        }
        onSelection?.({
            id: newId(),
            type: exclude ? 'exclude' : 'include',
            shape: 'point',
            lat: snapped.lat,
            lng: snapped.lng,
            radiusM: POINT_RADIUS_M,
        });
    }, [map, snapPaths, onSelection, onSnapMiss]);

    const commit = useCallback((current) => {
        if (!current) return;
        const exclude = current.exclude;

        const point = clickLatLng(current);
        const threshold = dragThresholdMeters(map.getZoom(), point.lat);
        if (isClick(current, threshold)) {
            if (!exclusionDraw) dropPoint(point.lat, point.lng, exclude);
            return;
        }

        if (current.kind === 'freeform') {
            const coordinates = thinCoordinates(current.points);
            if (coordinates.length < 3) return;
            if (exclusionDraw) {
                onDrawingComplete?.(coordinates, 'freeform', true);
                return;
            }
            onSelection?.({
                id: newId(),
                type: exclude ? 'exclude' : 'include',
                shape: 'freeform',
                coordinates,
            });
            return;
        }

        if (exclusionDraw) return;

        if (current.kind === 'circle') {
            onSelection?.({
                id: newId(),
                type: exclude ? 'exclude' : 'include',
                shape: 'circle',
                lat: current.lat,
                lng: current.lng,
                radiusM: current.radiusM,
            });
            return;
        }

        if (current.kind === 'box') {
            const box = boxFromCorners(current.a, current.b);
            onSelection?.({
                id: newId(),
                type: exclude ? 'exclude' : 'include',
                shape: 'box',
                ...box,
            });
        }
    }, [map, exclusionDraw, onDrawingComplete, onSelection, dropPoint]);

    useEffect(() => {
        if (!activeTool) return undefined;

        const onDown = (e) => {
            if (activeTool !== 'circle' && activeTool !== 'box' && activeTool !== 'freeform') return;
            if (e.originalEvent && e.originalEvent.button !== 0) return;
            const exclude = isExcludeMode || e.originalEvent?.shiftKey;
            const latlng = e.latlng;
            if (activeTool === 'circle') {
                writeDraft({ kind: 'circle', lat: latlng.lat, lng: latlng.lng, radiusM: 0, exclude });
            } else if (activeTool === 'box') {
                writeDraft({ kind: 'box', a: latlng, b: latlng, exclude });
            } else {
                writeDraft({ kind: 'freeform', points: [latlng], exclude });
            }
        };

        const onMove = (e) => {
            const current = draftRef.current;
            if (!current) return;
            if (current.kind === 'circle') {
                writeDraft({
                    ...current,
                    radiusM: metersBetween(current.lat, current.lng, e.latlng.lat, e.latlng.lng),
                });
            } else if (current.kind === 'box') {
                writeDraft({ ...current, b: e.latlng });
            } else if (current.kind === 'freeform') {
                writeDraft({ ...current, points: [...current.points, e.latlng] });
            }
        };

        const onUp = () => {
            const current = draftRef.current;
            if (!current) return;
            draftRef.current = null;
            setDraft(null);
            commit(current);
        };

        map.on('mousedown', onDown);
        map.on('mousemove', onMove);
        window.addEventListener('mouseup', onUp);

        return () => {
            map.off('mousedown', onDown);
            map.off('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [map, activeTool, isExcludeMode, exclusionDraw, snapPaths, onSelection, onSnapMiss, commit, writeDraft]);

    useEffect(() => {
        if (!pinOnClick) return undefined;
        let timer = null;

        const onClick = (e) => {
            if (e.originalEvent?.detail > 1) {
                clearTimeout(timer);
                timer = null;
                return;
            }
            const exclude = isExcludeMode || e.originalEvent?.shiftKey;
            const { lat, lng } = e.latlng;
            clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                dropPoint(lat, lng, exclude);
            }, 220);
        };

        const onDoubleClick = () => {
            clearTimeout(timer);
            timer = null;
        };

        map.on('click', onClick);
        map.on('dblclick', onDoubleClick);
        return () => {
            clearTimeout(timer);
            map.off('click', onClick);
            map.off('dblclick', onDoubleClick);
        };
    }, [map, pinOnClick, isExcludeMode, dropPoint]);

    if (!draft) return null;
    const style = draft.exclude ? EXCLUDE_DRAFT : DRAFT_STYLE;

    if (draft.kind === 'circle') {
        return (
            <Circle
                center={[draft.lat, draft.lng]}
                radius={Math.max(draft.radiusM, 1)}
                pathOptions={style}
                pane="tools"
                interactive={false}
            />
        );
    }

    if (draft.kind === 'box') {
        const box = boxFromCorners(draft.a, draft.b);
        return (
            <Rectangle
                bounds={[[box.south, box.west], [box.north, box.east]]}
                pathOptions={style}
                pane="tools"
                interactive={false}
            />
        );
    }

    if (draft.kind === 'freeform' && draft.points.length >= 2) {
        return <Polygon positions={draft.points} pathOptions={style} pane="tools" interactive={false} />;
    }

    return null;
}

export default DrawingHandler;
