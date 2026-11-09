import { useCallback, useEffect, useRef, useState } from 'react';
import { Circle, Polygon, Rectangle, useMap } from 'react-leaflet';
import { metersBetween, MIN_DRAG_M } from '../../utils/routeSelections';
import { edgesInShape } from '../../utils/graphRoads';
import { metersPerPixel } from '../../utils/routeHover';
import { AREA_STYLE } from '../../utils/roadColors';

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

/** Too small to be a shape (a click, or a wobble): nothing is drawn. */
function tooSmall(current, thresholdM) {
    if (current.kind === 'circle') return current.radiusM < thresholdM;
    if (current.kind === 'box') {
        const box = boxFromCorners(current.a, current.b);
        const height = metersBetween(box.south, box.west, box.north, box.west);
        const width = metersBetween(box.south, box.west, box.south, box.east);
        return height < thresholdM || width < thresholdM;
    }
    if (current.kind === 'freeform') {
        const start = current.points[0];
        if (!start) return true;
        return current.points.every((point) => (
            metersBetween(start.lat, start.lng, point.lat, point.lng) < thresholdM
        ));
    }
    return true;
}

/** The shape a finished drag describes (null if it is not one). */
function shapeOf(current) {
    if (current.kind === 'circle') {
        return { shape: 'circle', lat: current.lat, lng: current.lng, radiusM: current.radiusM };
    }
    if (current.kind === 'box') return { shape: 'box', ...boxFromCorners(current.a, current.b) };
    if (current.kind === 'freeform') {
        const coordinates = thinCoordinates(current.points);
        return coordinates.length >= 3 ? { shape: 'freeform', coordinates } : null;
    }
    return null;
}

/**
 * Circle, box, and freeform areas: drag to draw. An include area stays a
 * shape (routes must enter it). An excluded area becomes the red roads inside
 * it, kept with its outline: the map draws the outline, and the Road tool
 * shows the roads (to turn single ones back on) when the pointer is inside.
 */
function DrawingHandler({
    activeTool,
    isExcludeMode,
    onSelection, // include area: (selection)
    onExcludeArea, // excluded area: (edges, outline)
    onSnapMiss, // an excluded area with no road in it
    draftingRef,
    roadIndex = null,
    drawStyle = null, // the shape being dragged (default: the through / avoid area colours)
}) {
    const map = useMap();
    const draftRef = useRef(null);
    const [draft, setDraft] = useState(null);
    const drawing = activeTool === 'circle' || activeTool === 'box' || activeTool === 'freeform';

    const writeDraft = useCallback((next) => {
        draftRef.current = next;
        setDraft(next);
    }, []);

    // Esc cancels a shape being drawn.
    useEffect(() => {
        if (!draftingRef) return undefined;
        draftingRef.current = () => {
            if (!draftRef.current) return false;
            writeDraft(null);
            return true;
        };
        return () => {
            draftingRef.current = null;
        };
    }, [draftingRef, writeDraft]);

    useEffect(() => {
        if (!drawing) {
            writeDraft(null);
            return undefined;
        }
        const el = map.getContainer();
        el.classList.add('route-tool-active');
        map.boxZoom.disable();
        map.dragging.disable();
        return () => {
            el.classList.remove('route-tool-active');
            map.dragging.enable();
            map.boxZoom.enable();
        };
    }, [drawing, map, writeDraft]);

    const cb = useRef({});
    cb.current = { onSelection, onExcludeArea, onSnapMiss, roadIndex };

    const commit = useCallback((current) => {
        const start = current.kind === 'box' ? current.a : current.kind === 'freeform' ? current.points[0] : current;
        const thresholdM = Math.max(MIN_DRAG_M, 8 * metersPerPixel(map.getZoom(), start.lat));
        if (tooSmall(current, thresholdM)) return;
        const shape = shapeOf(current);
        if (!shape) return;
        const { onSelection: include, onExcludeArea: exclude, onSnapMiss: miss, roadIndex: index } = cb.current;
        if (!current.exclude) {
            include?.({ id: newId(), type: 'include', ...shape });
            return;
        }
        const edges = index ? edgesInShape(index, shape) : [];
        if (!edges.length) {
            miss?.();
            return;
        }
        exclude?.(edges, shape);
    }, [map]);

    useEffect(() => {
        if (!drawing) return undefined;

        const onDown = (e) => {
            if (e.originalEvent && e.originalEvent.button !== 0) return;
            const exclude = isExcludeMode || !!e.originalEvent?.shiftKey;
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
            writeDraft(null);
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
    }, [map, drawing, activeTool, isExcludeMode, commit, writeDraft]);

    if (!draft) return null;
    const style = drawStyle || { ...(draft.exclude ? AREA_STYLE.exclude : AREA_STYLE.include), weight: 2, opacity: 0.95 };

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
