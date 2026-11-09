import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import { attachProximityHover } from '../../utils/mapHover';
import { planRoadClick } from '../../utils/paintRoads';
import { pointerReachM } from '../../utils/routeHover';
import { ROAD_COLORS } from '../../utils/roadColors';

const ACTION_COLOR = {
    include: ROAD_COLORS.hover,
    exclude: ROAD_COLORS.exclude,
    clear: ROAD_COLORS.clear,
};

/**
 * Road tool: hover shows the road a click would change (the edge, or with
 * Ctrl the whole named road) in the colour it would get (grey = cleared);
 * click applies it. Inside an excluded area its roads show, and a click turns
 * one back on or off. The highlight is one Leaflet layer updated in place by
 * the shared proximity hover (utils/mapHover).
 */
function RoadTool({ roadIndex, selections, isExcludeMode, onToggleEdges, onSnapMiss, onRevealArea }) {
    const map = useMap();
    // Callbacks and state live in a ref so the effect only depends on the roads:
    // re-subscribing on every parent render would clear the highlight.
    const cb = useRef({});
    cb.current = { selections, isExcludeMode, onToggleEdges, onSnapMiss, onRevealArea };
    const hoverRef = useRef(null);

    useEffect(() => {
        if (!roadIndex) return undefined;
        const el = map.getContainer();
        el.classList.add('road-tool-active');
        const highlight = L.polyline([], {
            color: ROAD_COLORS.hover, weight: 8, opacity: 0.55, lineCap: 'round',
            pane: 'tools', interactive: false,
        }).addTo(map);
        let revealed = null;
        const reveal = (id) => {
            if (id === revealed) return;
            revealed = id;
            cb.current.onRevealArea?.(id);
        };

        const plan = (latlng, ctrl, shift) => planRoadClick({
            roadIndex,
            selections: cb.current.selections,
            latlng,
            maxM: pointerReachM(map.getZoom(), latlng.lat),
            ctrl,
            exclude: cb.current.isExcludeMode || shift,
        });

        const hover = attachProximityHover(map, {
            trackModifiers: true,
            pick: ({ latlng, ctrl, shift }) => plan(latlng, ctrl, shift),
            keyOf: (p) => `${p.edges.map((e) => e.key).join('|')}:${p.action}:${p.revealId}`,
            onChange: (p) => {
                reveal(p?.revealId ?? null);
                if (!p || !p.edges.length) {
                    highlight.setLatLngs([]);
                    return;
                }
                highlight.setStyle({ color: ACTION_COLOR[p.action] || ROAD_COLORS.hover });
                highlight.setLatLngs(p.edges.map((e) => e.pts));
            },
        });
        hoverRef.current = hover;

        const onClick = (e) => {
            const ev = e.originalEvent || {};
            const ctrl = !!(ev.ctrlKey || ev.metaKey);
            const p = plan(e.latlng, ctrl, !!ev.shiftKey);
            if (!p || !p.edges.length) {
                cb.current.onSnapMiss?.();
                return;
            }
            if (p.areaId) {
                cb.current.onToggleEdges?.(p.edges, { type: 'exclude', kind: 'area', areaId: p.areaId });
            } else {
                cb.current.onToggleEdges?.(p.edges, {
                    type: p.action === 'exclude' ? 'exclude' : 'include', // ignored when clearing
                    kind: ctrl ? 'road' : 'edge',
                    label: p.edges[0].name,
                });
            }
        };
        map.on('click', onClick);

        return () => {
            map.off('click', onClick);
            hoverRef.current = null;
            hover.detach();
            highlight.remove();
            reveal(null);
            el.classList.remove('road-tool-active');
        };
    }, [map, roadIndex]);

    // Painting changed what is under the pointer: show the new state at once.
    useEffect(() => {
        hoverRef.current?.refresh();
    }, [selections, isExcludeMode]);

    return null;
}

export default RoadTool;
