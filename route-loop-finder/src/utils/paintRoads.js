/**
 * Painted roads: what a Road tool click, a drawn excluded area, or a toggle
 * inside an excluded area does to the selection list. Pure functions: they
 * take the list and return a new one.
 *
 * Edges selections: { id, type: 'include'|'exclude', shape: 'edges',
 * kind: 'edge'|'road'|'area', keys, edges, lines, outline? }. keys[i],
 * edges[i] ([u, v]) and lines[i] (points) describe the same road edge.
 */
import { areaEdges, edgesSelection, nearestEdge, roadOf } from './graphRoads';
import { selectionContains } from './routeSelections';

function newSelectionId() {
    return `sel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** key -> the edges selection that paints it. */
export function paintedKeys(selections) {
    const painted = new Map();
    (selections || []).forEach((selection) => {
        if (selection.shape !== 'edges') return;
        (selection.keys || []).forEach((key) => painted.set(key, selection));
    });
    return painted;
}

/** An excluded area drawn as an outline (its roads are only shown by the Road tool). */
export function isOutlinedArea(selection) {
    return selection?.shape === 'edges' && selection.kind === 'area' && !!selection.outline;
}

/**
 * Take `keys` out of every edges selection. A selection left with no roads
 * goes, except an outlined excluded area: it stays (its outline still shows,
 * and its roads can be turned back on).
 */
function without(selections, keys) {
    const out = [];
    selections.forEach((selection) => {
        if (selection.shape !== 'edges' || !(selection.keys || []).some((key) => keys.has(key))) {
            out.push(selection);
            return;
        }
        const keep = selection.keys.map((key, i) => (keys.has(key) ? null : i)).filter((i) => i != null);
        if (keep.length === 0 && !isOutlinedArea(selection)) return;
        out.push({
            ...selection,
            keys: keep.map((i) => selection.keys[i]),
            edges: keep.map((i) => selection.edges[i]),
            lines: keep.map((i) => selection.lines[i]),
        });
    });
    return out;
}

/**
 * Road tool click on `edgeList` (one edge, or a whole road with Ctrl):
 * - every one of them already painted (any colour) -> unpaint them;
 * - otherwise -> paint them all in `type` as one new selection.
 * So a click on a painted road always clears it, in include or exclude mode.
 */
export function toggleEdgesIn(selections, edgeList, { type, kind, label }) {
    const keys = new Set(edgeList.map((e) => e.key));
    if (keys.size === 0) return selections;
    const painted = paintedKeys(selections);
    const stripped = without(selections, keys);
    if ([...keys].every((key) => painted.has(key))) return stripped;
    return [...stripped, edgesSelection(edgeList, { type, kind, label, id: newSelectionId() })];
}

/**
 * A drawn excluded area: its roads turn red, kept as one selection with the
 * outline. Roads already painted (e.g. a green one inside) stay as they are.
 */
export function addExcludedArea(selections, edgeList, outline) {
    const painted = paintedKeys(selections);
    const fresh = edgeList.filter((edge) => !painted.has(edge.key));
    if (!fresh.length) return selections;
    return [
        ...selections,
        edgesSelection(fresh, { type: 'exclude', kind: 'area', label: 'area', id: newSelectionId(), outline }),
    ];
}

/**
 * Road tool inside an excluded area: turn its roads back on, or off again.
 * If every one of `edgeList` is excluded by the area -> they are turned back
 * on (leave the area). Otherwise the ones not excluded join the area again
 * (taken from any other selection first).
 */
export function toggleInArea(selections, areaId, edgeList) {
    const area = selections.find((selection) => selection.id === areaId);
    if (!area || !edgeList.length) return selections;
    const inArea = new Set(area.keys || []);
    const keys = new Set(edgeList.map((e) => e.key));
    if ([...keys].every((key) => inArea.has(key))) return without(selections, keys);

    const adding = edgeList.filter((edge) => !inArea.has(edge.key));
    const addKeys = new Set(adding.map((e) => e.key));
    return without(selections, addKeys).map((selection) => (selection.id !== areaId ? selection : {
        ...selection,
        keys: [...selection.keys, ...adding.map((e) => e.key)],
        edges: [...selection.edges, ...adding.map((e) => [e.u, e.v])],
        lines: [...selection.lines, ...adding.map((e) => e.pts)],
    }));
}

/** Number of include constraints (green roads and areas) in a list. */
export function includeCount(selections) {
    return (selections || []).filter((s) => s.type === 'include').length;
}

/**
 * One entry point for every paint gesture:
 * - options.areaId: Road tool inside that excluded area (toggleInArea);
 * - options.outline: a drawn excluded area (addExcludedArea);
 * - otherwise a Road tool click (toggleEdgesIn).
 */
export function applyPaint(selections, edgeList, options) {
    if (options.areaId) return toggleInArea(selections, options.areaId, edgeList);
    if (options.outline) return addExcludedArea(selections, edgeList, options.outline);
    return toggleEdgesIn(selections, edgeList, options);
}

/**
 * What a click at the pointer would do. Returns null when there is nothing
 * to show, else { edges, action: 'include'|'exclude'|'clear', areaId, revealId }.
 * - revealId: the excluded area whose roads are shown (the pointer is inside
 *   it, or on one of its roads).
 * - areaId set: the click toggles those roads in that area (back on / off).
 * - otherwise a painted road is cleared (any colour, any mode) and an
 *   unpainted one is painted in the current mode.
 */
export function planRoadClick({ roadIndex, selections, latlng, maxM, ctrl, exclude }) {
    const hit = nearestEdge(roadIndex, latlng.lat, latlng.lng, maxM);
    const painted = paintedKeys(selections);
    let area = (selections || []).find((s) => (
        isOutlinedArea(s) && selectionContains(s.outline, latlng.lat, latlng.lng)
    )) || null;
    if (!area && hit && isOutlinedArea(painted.get(hit.edge.key))) area = painted.get(hit.edge.key);
    const revealId = area ? area.id : null;
    if (!hit) return revealId ? { edges: [], action: null, areaId: null, revealId } : null;

    let edges = ctrl ? roadOf(roadIndex, hit.edge) : [hit.edge];
    if (area) {
        const inOutline = new Set(areaEdges(roadIndex, area.outline).map((e) => e.key));
        (area.keys || []).forEach((key) => inOutline.add(key));
        const owner = painted.get(hit.edge.key);
        const paintedElsewhere = owner && owner.id !== area.id;
        if (inOutline.has(hit.edge.key) && !paintedElsewhere) {
            edges = edges.filter((e) => inOutline.has(e.key) && (!painted.has(e.key) || painted.get(e.key).id === area.id));
            const inArea = new Set(area.keys || []);
            const allExcluded = edges.every((e) => inArea.has(e.key));
            return { edges, action: allExcluded ? 'clear' : 'exclude', areaId: area.id, revealId };
        }
    }
    const allPainted = edges.every((e) => painted.has(e.key));
    return {
        edges,
        action: allPainted ? 'clear' : (exclude ? 'exclude' : 'include'),
        areaId: null,
        revealId,
    };
}
