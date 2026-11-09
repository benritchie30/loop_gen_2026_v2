import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import { pointerReachM, routeForClick } from '../../utils/routeHover';
import { selectionAt } from '../../utils/selectionHit';

// A click near something a double-click would remove waits this long for the
// second click, so a double-click does not also act as a click.
const DOUBLE_CLICK_MS = 250;

/**
 * Clicks with no tool active (pan mode).
 * - Route view: a click near routes shows the one there; clicking again where
 *   several run together steps through them (quick clicks too). Nothing is
 *   filtered or sent.
 * - Plan view: a click moves the start pin; with the Favorites tab open, a
 *   click near favorites shows one there instead (and steps like routes).
 * - Double-click a painted road, an area's outline, or an old pin: remove it
 *   (a Ctrl-click road goes as a whole). Double-click never zooms.
 * Only clicks pressed in pan mode count: releasing a drawn area switches back
 * to pan, and the click of that release must not move the start.
 */
function PanInteractions({
    enabled,
    mode,
    paths,
    currentPathId,
    selections,
    onSelectPath,
    onMoveStart,
    onRemoveSelection,
}) {
    const map = useMap();
    const state = useRef({});
    state.current = { mode, paths, currentPathId, selections, onSelectPath, onMoveStart, onRemoveSelection };

    // No double-click zoom: quick clicks on routes would zoom the map.
    useEffect(() => {
        map.doubleClickZoom.disable();
        return () => map.doubleClickZoom.enable();
    }, [map]);

    useEffect(() => {
        if (!enabled) return undefined;
        let timer = null;
        // Set by a press in pan mode. A click whose press began while a tool
        // was drawing (it switches back to pan on release) is not a pan click.
        let pressed = false;
        const tolerance = (lat) => pointerReachM(map.getZoom(), lat);

        const act = (latlng) => {
            const s = state.current;
            if (s.mode === 'display') {
                const maxM = tolerance(latlng.lat);
                const route = routeForClick(s.paths, s.currentPathId, latlng.lat, latlng.lng, maxM);
                if (route && route.id !== s.currentPathId) s.onSelectPath?.(route.id);
            } else if (s.mode === 'input') {
                // The plan's Favorites tab: a click near favorites shows one; elsewhere it moves the start.
                if (s.paths?.length) {
                    const route = routeForClick(s.paths, s.currentPathId, latlng.lat, latlng.lng, tolerance(latlng.lat));
                    if (route) {
                        if (route.id !== s.currentPathId) s.onSelectPath?.(route.id);
                        return;
                    }
                }
                s.onMoveStart?.({ lat: latlng.lat, lng: latlng.lng });
            }
        };

        const onDown = () => {
            pressed = true;
        };

        const onClick = (e) => {
            if (!pressed) return;
            const { latlng } = e;
            const removable = selectionAt(state.current.selections, latlng.lat, latlng.lng, tolerance(latlng.lat));
            if (!removable) {
                clearTimeout(timer);
                timer = null;
                act(latlng);
                return;
            }
            // Near something a double-click removes: wait to see if this is one.
            if (e.originalEvent?.detail > 1) return; // its second click
            clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                act(latlng);
            }, DOUBLE_CLICK_MS);
        };

        const onDoubleClick = (e) => {
            clearTimeout(timer);
            timer = null;
            const { latlng } = e;
            const hit = selectionAt(state.current.selections, latlng.lat, latlng.lng, tolerance(latlng.lat));
            if (hit) state.current.onRemoveSelection?.(hit.id);
        };

        map.on('mousedown', onDown);
        map.on('click', onClick);
        map.on('dblclick', onDoubleClick);
        return () => {
            clearTimeout(timer);
            map.off('mousedown', onDown);
            map.off('click', onClick);
            map.off('dblclick', onDoubleClick);
        };
    }, [map, enabled]);

    return null;
}

export default PanInteractions;
