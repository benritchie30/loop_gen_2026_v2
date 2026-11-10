/**
 * Custom search boundaries: the area a generation's roads must lie in, drawn
 * instead of the automatic one (every road within reach of the start). A
 * boundary is { id, name, shapes }, its shapes together one area (their
 * union), each in the painted areas' form: circle { lat, lng, radiusM },
 * box { north, south, east, west }, freeform { coordinates: [[lat, lng], ...] }.
 * The server (backend/boundary.py) keeps only the roads inside it.
 */
import { metersBetween, selectionContains } from './routeSelections';

const M_PER_DEG = 111320;
export const FREEFORM_MAX_POINTS = 40; // a drawn freeform outline keeps at most this many points

/** The shapes worth keeping (each a copy with only its own fields), [] when none. */
export function cleanShapes(shapes) {
    const ok = (...values) => values.every((v) => Number.isFinite(v));
    return (shapes || []).flatMap((s) => {
        if (s?.shape === 'circle' && ok(s.lat, s.lng, s.radiusM) && s.radiusM > 0) {
            return [{ shape: 'circle', lat: s.lat, lng: s.lng, radiusM: s.radiusM }];
        }
        if (s?.shape === 'box' && ok(s.north, s.south, s.east, s.west) && s.north > s.south && s.east > s.west) {
            return [{ shape: 'box', north: s.north, south: s.south, east: s.east, west: s.west }];
        }
        if (s?.shape === 'freeform' && (s.coordinates || []).filter((p) => ok(p?.[0], p?.[1])).length >= 3) {
            return [{ shape: 'freeform', coordinates: s.coordinates.filter((p) => ok(p?.[0], p?.[1])).map(([a, b]) => [a, b]) }];
        }
        return [];
    });
}

/** What the server needs: the shapes (null: the automatic area). */
export function boundaryPayload(boundary) {
    const shapes = cleanShapes(boundary?.shapes);
    return shapes.length ? { shapes } : null;
}

/** The same shapes, as a short string (to tell boundaries apart); null without shapes. */
export function boundaryKey(boundary) {
    const shapes = cleanShapes(boundary?.shapes);
    if (!shapes.length) return null;
    const r = (v) => Math.round(v * 1e7) / 1e7;
    return JSON.stringify(shapes.map((s) => (s.shape === 'freeform'
        ? [s.shape, s.coordinates.map(([a, b]) => [r(a), r(b)])]
        : [s.shape, ...Object.keys(s).filter((k) => k !== 'shape').sort().map((k) => r(s[k]))])));
}

/** Is (lat, lng) inside any of the boundary's shapes? */
export function boundaryContains(boundary, lat, lng) {
    return cleanShapes(boundary?.shapes).some((s) => selectionContains(s, lat, lng));
}

/** { south, west, north, east } around every shape; null without shapes. */
export function boundaryBounds(boundary) {
    let [south, west, north, east] = [90, 180, -90, -180];
    const add = (lat, lng) => {
        south = Math.min(south, lat); north = Math.max(north, lat);
        west = Math.min(west, lng); east = Math.max(east, lng);
    };
    const shapes = cleanShapes(boundary?.shapes);
    shapes.forEach((s) => {
        if (s.shape === 'circle') {
            const dLat = s.radiusM / M_PER_DEG;
            const dLng = s.radiusM / (M_PER_DEG * Math.max(Math.cos((s.lat * Math.PI) / 180), 1e-6));
            add(s.lat - dLat, s.lng - dLng);
            add(s.lat + dLat, s.lng + dLng);
        } else if (s.shape === 'box') {
            add(s.south, s.west);
            add(s.north, s.east);
        } else {
            s.coordinates.forEach(([lat, lng]) => add(lat, lng));
        }
    });
    return shapes.length ? { south, west, north, east } : null;
}

/**
 * A drawn outline ([[lat, lng], ...]) made easy to edit: Douglas-Peucker,
 * loosened until at most maxPoints are left (at least 3), with no two points
 * closer than a tenth of the shape's size.
 */
export function simplifyOutline(coords, maxPoints = FREEFORM_MAX_POINTS) {
    const pts = (coords || []).filter((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]));
    if (pts.length <= maxPoints) return pts.map(([a, b]) => [a, b]);
    const cos = Math.cos((pts[0][0] * Math.PI) / 180);
    const xy = pts.map(([lat, lng]) => [lng * M_PER_DEG * cos, lat * M_PER_DEG]);
    const keepWith = (tol) => {
        const keep = new Set([0, xy.length - 1]);
        const stack = [[0, xy.length - 1]];
        while (stack.length) {
            const [a, b] = stack.pop();
            const [ax, ay] = xy[a];
            const [bx, by] = xy[b];
            const dx = bx - ax;
            const dy = by - ay;
            const den = dx * dx + dy * dy;
            let best = -1;
            let bestI = -1;
            for (let i = a + 1; i < b; i++) {
                const [px, py] = xy[i];
                const t = den ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / den)) : 0;
                const d = Math.hypot(px - ax - dx * t, py - ay - dy * t);
                if (d > best) {
                    best = d;
                    bestI = i;
                }
            }
            if (best > tol && bestI > 0) {
                keep.add(bestI);
                stack.push([a, bestI], [bestI, b]);
            }
        }
        return [...keep].sort((p, q) => p - q);
    };
    let size = 0;
    xy.forEach(([x, y]) => { size = Math.max(size, Math.hypot(x - xy[0][0], y - xy[0][1])); });
    let tol = Math.max(1, size / 500);
    let kept = keepWith(tol);
    while (kept.length > maxPoints) {
        tol *= 1.5;
        kept = keepWith(tol);
    }
    // Points are handles to drag: none closer to the one before than a tenth of
    // the shape (a small shape gets fewer points; zoom in to edit it finely),
    // and where the drawing closed its loop, by where it began, one is enough.
    const gap = (a, b) => metersBetween(a[0], a[1], b[0], b[1]);
    const minGap = Math.max(1, size / 10);
    const out = [];
    kept.map((i) => pts[i]).forEach((p) => {
        if (!out.length || gap(out[out.length - 1], p) >= minGap) out.push(p);
    });
    while (out.length > 3 && gap(out[0], out[out.length - 1]) < minGap) out.pop();
    return out.length >= 3 ? out : pts.slice(0, 3);
}

/** "Circle, 1.2 mi across" / "Box, 2.1 × 1.4 mi" / "Freeform, 12 points" (miles or km). */
export function shapeLabel(shape, units = 'mi') {
    const toUnit = (m) => (units === 'km' ? m / 1000 : m / 1609.34);
    const unit = units === 'km' ? 'km' : 'mi';
    const fmt = (m) => toUnit(m).toFixed(1);
    if (shape.shape === 'circle') return `Circle, ${fmt(2 * shape.radiusM)} ${unit} across`;
    if (shape.shape === 'box') {
        const h = metersBetween(shape.south, shape.west, shape.north, shape.west);
        const w = metersBetween(shape.south, shape.west, shape.south, shape.east);
        return `Box, ${fmt(w)} × ${fmt(h)} ${unit}`;
    }
    return `Freeform, ${shape.coordinates.length} points`;
}

/**
 * The automatic search area to draw (grey dotted, like a custom boundary), or
 * null. No route of the max length gets farther from the start than max / 2,
 * so that circle is the boundary when no custom one replaces it.
 *
 * plan: { marker, miles, boundary, editing, favoritesTab } — the start pin,
 * the length slider's max, the chosen custom boundary, the boundary editor.
 * generation: { start, miles, boundary, show } — its pin, the More routes
 * length (what the next search covers), its boundary, the Search boundary
 * option.
 */
export function automaticArea(mode, plan, generation) {
    const area = (at, miles) => (at && Number(miles) > 0
        ? { lat: at.lat, lng: at.lng, miles: Number(miles) } : null);
    if (mode === 'input') {
        if (plan?.favoritesTab || plan?.editing || plan?.boundary) return null;
        return area(plan?.marker, plan?.miles);
    }
    if (!generation?.show || generation?.boundary) return null;
    return area(generation?.start, generation?.miles);
}
