/**
 * What painted thing is under the pointer: a painted road (green / red), an
 * area's dotted outline, or an old pin. Used by double-click-to-remove in
 * pan mode. Excluded areas are hit on their outline; the roads inside them
 * are only shown (and toggled) with the Road tool.
 */
import { distanceToPolyline } from './graphRoads';
import { metersBetween } from './routeSelections';

/** The outline an area selection is drawn with: the shape itself, or an excluded area's saved outline. */
export function outlineOf(selection) {
    if (!selection) return null;
    if (selection.shape === 'edges') return selection.kind === 'area' ? selection.outline || null : null;
    if (selection.shape === 'circle' || selection.shape === 'box' || selection.shape === 'freeform') return selection;
    return null;
}

function ringOf(outline) {
    if (outline.shape === 'box') {
        return [
            [outline.south, outline.west],
            [outline.north, outline.west],
            [outline.north, outline.east],
            [outline.south, outline.east],
            [outline.south, outline.west],
        ];
    }
    if (outline.shape === 'freeform' && outline.coordinates?.length >= 3) {
        const ring = outline.coordinates.slice();
        ring.push(ring[0]);
        return ring;
    }
    return null;
}

/** Metres from (lat, lng) to an area's boundary line. */
export function distanceToOutline(outline, lat, lng) {
    if (!outline) return Infinity;
    if (outline.shape === 'circle') {
        return Math.abs(metersBetween(lat, lng, outline.lat, outline.lng) - outline.radiusM);
    }
    const ring = ringOf(outline);
    if (!ring) return Infinity;
    return distanceToPolyline(ring, lat, lng, Math.cos((lat * Math.PI) / 180)).dist;
}

/** Metres from (lat, lng) to the nearest painted line of an edges selection. */
function distanceToLines(lines, lat, lng) {
    const cos = Math.cos((lat * Math.PI) / 180);
    let best = Infinity;
    (lines || []).forEach((pts) => {
        if (pts?.length >= 2) best = Math.min(best, distanceToPolyline(pts, lat, lng, cos).dist);
    });
    return best;
}

/** Metres from the pointer to what is drawn for a selection (Infinity if nothing is hit-testable). */
export function selectionDistance(selection, lat, lng) {
    if (selection.shape === 'edges') {
        // An excluded area is its outline; old saved ones without one are their red roads.
        if (selection.kind === 'area' && selection.outline) return distanceToOutline(selection.outline, lat, lng);
        return distanceToLines(selection.lines, lat, lng);
    }
    if (selection.shape === 'point') return metersBetween(lat, lng, selection.lat, selection.lng);
    return distanceToOutline(outlineOf(selection), lat, lng);
}

/** The selection drawn nearest the pointer within maxM, or null. */
export function selectionAt(selections, lat, lng, maxM) {
    let best = null;
    let bestD = maxM;
    (selections || []).forEach((selection) => {
        const d = selectionDistance(selection, lat, lng);
        if (d <= bestD) {
            best = selection;
            bestD = d;
        }
    });
    return best;
}
