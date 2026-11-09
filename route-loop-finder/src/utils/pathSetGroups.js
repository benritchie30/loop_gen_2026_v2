/**
 * Generations (path sets) that share a start. Starts snap onto the road, so
 * two searches from the same place share the same point; older generations
 * kept the clicked point, so "the same start" allows a few metres.
 */
import { metersBetween } from './routeSelections';

export const SAME_START_M = 20;

function positionOf(item) {
    const p = item?.position || item?.markerPosition;
    return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) ? p : null;
}

/** Is `a` the same start as `b` (both { lat, lng })? */
export function sameStart(a, b, withinM = SAME_START_M) {
    return !!a && !!b && metersBetween(a.lat, a.lng, b.lat, b.lng) <= withinM;
}

/**
 * One map pin per start: [{ key, position, items }], `items` in the order
 * given. A pin sits at its first item's start; later items within
 * SAME_START_M of it join it.
 */
export function groupByStart(items, withinM = SAME_START_M) {
    const groups = [];
    (items || []).forEach((item) => {
        const position = positionOf(item);
        if (!position) return;
        const group = groups.find((g) => sameStart(g.position, position, withinM));
        if (group) group.items.push(item);
        else groups.push({ key: item.id, position, items: [item] });
    });
    return groups;
}

/** The generations that start where `position` is, newest first. */
export function setsAtStart(generations, position, withinM = SAME_START_M) {
    if (!position) return [];
    return (generations || [])
        .filter((g) => sameStart(positionOf(g), position, withinM))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** [shortest, longest] route length (miles) of a generation's routes, or null. */
export function lengthRange(paths) {
    let lo = Infinity;
    let hi = -Infinity;
    (paths || []).forEach((p) => {
        const miles = p?.properties?.total_miles;
        if (!Number.isFinite(miles)) return;
        lo = Math.min(lo, miles);
        hi = Math.max(hi, miles);
    });
    return lo <= hi ? [lo, hi] : null;
}

/**
 * Favorites grouped by where they start, newest first:
 * [{ key, position, records, setId, title }]. setId is the generation to
 * open for the group (the newest favorite's own, if it still exists, else
 * the newest one that starts there; null when none is left), title its name
 * (else the name the favorite was saved with). Favorites saved without a
 * start are one group at the end (position null).
 */
export function groupFavorites(records, generations) {
    const sorted = [...(records || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const withStart = sorted.filter((r) => positionOf({ position: r.start }));
    const noStart = sorted.filter((r) => !positionOf({ position: r.start }));
    const byId = new Map((generations || []).map((g) => [g.id, g]));
    const groups = groupByStart(withStart.map((r) => ({ id: r.key, position: r.start, record: r })))
        .map((g) => ({ key: g.key, position: g.position, records: g.items.map((i) => i.record) }));
    if (noStart.length) groups.push({ key: 'no-start', position: null, records: noStart });
    return groups.map((group) => {
        const own = group.records.map((r) => byId.get(r.pathSetId)).find(Boolean);
        const there = own || setsAtStart(generations, group.position)[0] || null;
        const saved = group.records.find((r) => r.setName)?.setName;
        return { ...group, setId: there?.id ?? null, title: there?.name || saved || 'Favorites' };
    });
}
