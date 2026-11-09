import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { filterByRouteSelections } from '../utils/routeSelections';
import { groupFavorites } from '../utils/pathSetGroups';

/**
 * Every favorite, from every generation (the plan's Favorites tab): grouped
 * by start, filtered by the plan's painted roads and areas (a favorite must
 * go through every green one and avoid every red one). One can be selected
 * (drawn bold, its elevation shown) and one previewed (a row under the
 * pointer). One unfavorited here stays listed until another is selected.
 */
export function useFavoritesView({ favorites, generations, selections }) {
    const [selectedId, setSelectedId] = useState(null);
    const [hoveredId, setHoveredId] = useState(null);
    const [keptKeys, setKeptKeys] = useState(() => new Map()); // key -> record, unfavorited but still listed

    const records = useMemo(() => {
        const all = new Map(favorites);
        keptKeys.forEach((record, key) => { if (!all.has(key)) all.set(key, record); });
        return [...all.values()];
    }, [favorites, keptKeys]);

    // Groups of the favorites that pass the painted roads and areas.
    const groups = useMemo(() => {
        const passing = new Set(filterByRouteSelections(records.map((r) => r.path), selections || []));
        return groupFavorites(records.filter((r) => passing.has(r.path)), generations);
    }, [records, selections, generations]);

    // The listed routes, in the list's order (arrows step through it).
    const paths = useMemo(() => groups.flatMap((g) => g.records.map((r) => r.path)), [groups]);
    const current = useMemo(() => paths.find((p) => p.id === selectedId) || null, [paths, selectedId]);
    const recordOf = useCallback((path) => records.find((r) => r.path === path) || null, [records]);

    // Another route selected: the unfavorited ones kept so far go.
    const keptFor = useRef(selectedId);
    useEffect(() => {
        if (keptFor.current === selectedId) return;
        keptFor.current = selectedId;
        setKeptKeys((prev) => (prev.size ? new Map() : prev));
    }, [selectedId]);

    const keepListed = useCallback((record) => {
        if (record?.key) setKeptKeys((prev) => new Map(prev).set(record.key, record));
    }, []);

    /** The id of the route `delta` steps from the selected one (the first / last when none is). */
    const stepId = useCallback((delta) => {
        if (!paths.length) return null;
        const i = paths.findIndex((p) => p.id === selectedId);
        const next = i < 0 ? (delta > 0 ? 0 : paths.length - 1) : Math.min(Math.max(i + delta, 0), paths.length - 1);
        return paths[next].id;
    }, [paths, selectedId]);

    return {
        groups,
        paths,
        current,
        selectedId: current ? selectedId : null,
        hoveredId,
        select: setSelectedId,
        setHoveredId,
        stepId,
        recordOf,
        keepListed,
    };
}
