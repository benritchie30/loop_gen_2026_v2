import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { FILTER_METRICS, OPEN_RANGE, filterByMetrics, metricBounds, sanitizeRouteFilters, sortPaths } from '../utils/pathFiltering';
import { filterByRouteSelections } from '../utils/routeSelections';
import { applyPaint } from '../utils/paintRoads';
import { deleteGeneration, loadGenerations, saveGeneration } from '../utils/generationsDb';
import { lengthRange } from '../utils/pathSetGroups';
import { routeKey } from '../utils/routeIdentity';
import { reverseUnpaved } from '../utils/surface';

function newRouteId(pathSetId) {
    return typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${pathSetId}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/** Filters shown on every generation (others are added with "+ Filter"). */
export const PINNED_FILTERS = ['total_miles'];
/**
 * Sort choices: Best (the order the search found them), every route metric,
 * and Similar (routes that share ground next to each other).
 */
const SORT_METRIC_ORDER = ['total_miles', 'climb_rate', 'total_climb_ft', 'difficulty', 'loop_ratio', 'unpaved_share', 'discomfort'];
export const SORT_OPTIONS = [
    { id: 'found', label: 'Best' },
    ...SORT_METRIC_ORDER.map((key) => ({ id: key, label: FILTER_METRICS.find((m) => m.key === key).label })),
    { id: 'similar', label: 'Similar' },
];
const FILTERS_VERSION = '2'; // 2: Climb is no longer a default filter
const SAVE_DELAY_MS = 1200;

/** Next unused name, so two searches from the same place stay apart. */
export function suggestGenerationName(base, pathSets) {
    const used = new Set();
    Object.values(pathSets || {}).forEach((set) => {
        if (set?.name) used.add(set.name);
    });
    const label = base || 'Generation';
    if (!used.has(label)) return label;
    let n = 2;
    while (used.has(`${label} ${n}`)) n += 1;
    return `${label} ${n}`;
}

/** What is kept in the browser for a generation. */
function toRecord(id, set) {
    return {
        id,
        name: set.name,
        createdAt: set.createdAt,
        markerPosition: set.markerPosition,
        settings: set.settings,
        selections: set.selections || [],
        paths: set.paths,
        batches: set.batches || 0,
        lastNote: set.lastNote || null,
    };
}

function fromRecord(record) {
    return {
        markerPosition: record.markerPosition,
        paths: Array.isArray(record.paths) ? record.paths : [],
        isComplete: true,
        resumable: true, // the server can always rebuild it from this copy
        name: record.name || 'Generation',
        settings: record.settings || {},
        selections: record.selections || [],
        createdAt: record.createdAt || 0,
        batches: record.batches || 0,
        lastNote: record.lastNote || null,
    };
}

function readRouteFilters() {
    let saved = [];
    try {
        saved = sanitizeRouteFilters(JSON.parse(localStorage.getItem('routeFilterLimits') || '[]'));
        // Climb used to be shown on every generation (and so was always saved): start without it once.
        if (localStorage.getItem('routeFiltersVersion') !== FILTERS_VERSION) {
            saved = saved.filter((f) => f.key !== 'total_climb_ft');
            localStorage.setItem('routeFiltersVersion', FILTERS_VERSION);
        }
    } catch {
        saved = [];
    }
    // Pinned filters first and always present; limits start open for a new generation.
    const pinned = PINNED_FILTERS.map((key) => ({ key, range: OPEN_RANGE }));
    const extra = saved.filter((f) => !PINNED_FILTERS.includes(f.key)).map((f) => ({ key: f.key, range: OPEN_RANGE }));
    return [...pinned, ...extra];
}

/**
 * Generations (path sets) and the routes of the open one.
 * A generation: { markerPosition, paths, isComplete, resumable, name,
 * settings, selections, createdAt, batches, lastNote }. Generations are
 * saved in the browser (IndexedDB) as they change and loaded at start.
 * `favorites` (hooks/useFavorites: key -> record) drives "favorites only",
 * which lists the open generation's favorite routes; one unfavorited there
 * stays listed until another route is selected.
 */
export function usePathSets({ favorites = null } = {}) {
    const [pathSets, setPathSets] = useState({});
    const [hydrated, setHydrated] = useState(false);
    const [activeId, setActiveId] = useState(null);
    const [selectedPathId, setSelectedPathId] = useState(null);
    const [hoveredPathId, setHoveredPathId] = useState(null);
    const [favoritesOnly, setFavoritesOnly] = useState(false);
    const [keptIds, setKeptIds] = useState(() => new Set()); // unfavorited in favorites only, still listed
    const [routeFilters, setRouteFilters] = useState(readRouteFilters);
    const [sortBy, setSortBy] = useState(() => {
        const saved = localStorage.getItem('sortBy');
        return SORT_OPTIONS.some((o) => o.id === saved) ? saved : 'found';
    });
    const [sortAscending, setSortAscending] = useState(true);
    const sortByRef = useRef(sortBy);
    sortByRef.current = sortBy;

    // ---- saved generations ----

    // id -> the generation object last written to storage. A generation is
    // saved whenever its object changes (immutable updates), so loaded ones
    // are recorded as saved as they are loaded.
    const savedRef = useRef(new Map());
    const saveTimer = useRef(null);

    useEffect(() => {
        let cancelled = false;
        loadGenerations().then((records) => {
            if (cancelled) return;
            const loaded = {};
            records.forEach((r) => {
                if (r?.id) {
                    loaded[r.id] = fromRecord(r);
                    savedRef.current.set(r.id, loaded[r.id]);
                }
            });
            setPathSets((prev) => ({ ...loaded, ...prev }));
            setHydrated(true);
        });
        return () => { cancelled = true; };
    }, []);

    // Save changed generations a moment after the last change (routes stream
    // in one by one), and at once when the page is hidden or closed.
    const pathSetsRef = useRef(pathSets);
    pathSetsRef.current = pathSets;
    const flushSaves = useCallback(() => {
        clearTimeout(saveTimer.current);
        Object.entries(pathSetsRef.current).forEach(([id, set]) => {
            if (savedRef.current.get(id) === set) return;
            savedRef.current.set(id, set);
            saveGeneration(toRecord(id, set));
        });
    }, []);
    useEffect(() => {
        if (!hydrated) return undefined;
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(flushSaves, SAVE_DELAY_MS);
        return () => clearTimeout(saveTimer.current);
    }, [pathSets, hydrated, flushSaves]);
    useEffect(() => {
        const onHide = () => {
            if (document.visibilityState === 'hidden') flushSaves();
        };
        document.addEventListener('visibilitychange', onHide);
        window.addEventListener('pagehide', flushSaves);
        return () => {
            document.removeEventListener('visibilitychange', onHide);
            window.removeEventListener('pagehide', flushSaves);
        };
    }, [flushSaves]);

    useEffect(() => {
        localStorage.setItem('routeFilterLimits', JSON.stringify(routeFilters.map((f) => ({ key: f.key, range: OPEN_RANGE }))));
    }, [routeFilters]);

    useEffect(() => {
        if (sortBy) localStorage.setItem('sortBy', sortBy);
    }, [sortBy]);

    // ---- filters ----

    const setFilterRange = useCallback((key, range) => {
        setRouteFilters((prev) => prev.map((filter) => (
            filter.key === key ? { ...filter, range } : filter
        )));
    }, []);

    const addRouteFilter = useCallback((key) => {
        setRouteFilters((prev) => {
            if (prev.some((filter) => filter.key === key)) return prev;
            const next = sanitizeRouteFilters([...prev, { key, range: OPEN_RANGE }]);
            return next.length === prev.length ? prev : next;
        });
    }, []);

    const removeRouteFilter = useCallback((key) => {
        if (PINNED_FILTERS.includes(key)) return;
        setRouteFilters((prev) => prev.filter((filter) => filter.key !== key));
    }, []);

    const resetFilterRanges = useCallback(() => {
        setRouteFilters((prev) => prev.map((f) => ({ ...f, range: OPEN_RANGE })));
    }, []);

    // ---- pins, areas, painted roads ----

    // drawnSelections: { id, type: 'include'|'exclude', shape, ... }
    const [drawnSelections, setDrawnSelections] = useState([]);

    // Selections belong to the open generation (saved with it and shown when it
    // is opened again). In input mode they are the plan's, for the first search.
    const selectionsRef = useRef(drawnSelections);
    selectionsRef.current = drawnSelections;
    const activeIdRef = useRef(activeId);
    activeIdRef.current = activeId;
    useEffect(() => {
        const id = activeIdRef.current;
        if (!id) return;
        setPathSets((prev) => {
            const pathSet = prev[id];
            if (!pathSet || pathSet.selections === drawnSelections) return prev;
            return { ...prev, [id]: { ...pathSet, selections: drawnSelections } };
        });
    }, [drawnSelections]);

    const addDrawnSelection = useCallback((selectionData) => {
        setDrawnSelections((prev) => [...prev, selectionData]);
        setSelectedPathId(null);
    }, []);

    const toggleEdges = useCallback((edgeList, options) => {
        setDrawnSelections((prev) => applyPaint(prev, edgeList, options));
        setSelectedPathId(null);
    }, []);

    const clearDrawnSelections = useCallback(() => setDrawnSelections([]), []);
    // Another list of painted roads and areas (the plan's tabs keep one each).
    const replaceSelections = useCallback((list) => setDrawnSelections(list || []), []);

    const undoLastSelection = useCallback(() => {
        setDrawnSelections((prev) => (prev.length === 0 ? prev : prev.slice(0, -1)));
        setSelectedPathId(null);
    }, []);

    const removeSelection = useCallback((id) => {
        setDrawnSelections((prev) => prev.filter((selection) => selection.id !== id));
        setSelectedPathId(null);
    }, []);

    // Move a pin onto the road the server snapped it to, or clear its pending flag.
    const updateSelection = useCallback((id, patch) => {
        setDrawnSelections((prev) => prev.map((selection) => (
            selection.id === id ? { ...selection, ...patch } : selection
        )));
    }, []);

    // ---- generations ----

    // A generation starts: meta is its name, settings and selections (else
    // the ones painted now go with it). It becomes the open one.
    const createPathSet = useCallback((pathSetId, markerPosition, meta) => {
        const info = meta || {};
        setPathSets((prev) => ({
            ...prev,
            [pathSetId]: {
                markerPosition,
                paths: [],
                isComplete: false,
                resumable: true,
                name: info.name || 'Generation',
                settings: info.settings || {},
                selections: info.selections || selectionsRef.current,
                createdAt: Date.now(),
                batches: 0,
            },
        }));
        setActiveId(pathSetId);
        setSelectedPathId(null);
        resetFilterRanges();
    }, [resetFilterRanges]);

    const addPathToSet = useCallback((pathSetId, pathData) => {
        setPathSets((prev) => {
            const pathSet = prev[pathSetId];
            if (!pathSet) return prev;
            const pathWithId = { ...pathData, id: newRouteId(pathSetId) };
            return { ...prev, [pathSetId]: { ...pathSet, paths: [...pathSet.paths, pathWithId] } };
        });
    }, []);

    // A batch ended. `info.note` explains a thin batch.
    const completePathSet = useCallback((pathSetId, info = {}) => {
        setPathSets((prev) => {
            const pathSet = prev[pathSetId];
            if (!pathSet) return prev;
            const next = { ...pathSet, isComplete: true };
            if (typeof info.resumable === 'boolean') next.resumable = info.resumable;
            if (info.note !== undefined) next.lastNote = info.note;
            return { ...prev, [pathSetId]: next };
        });
    }, []);

    // More routes started for a generation.
    const resumePathSet = useCallback((pathSetId) => {
        setPathSets((prev) => {
            const pathSet = prev[pathSetId];
            if (!pathSet) return prev;
            return {
                ...prev,
                [pathSetId]: { ...pathSet, isComplete: false, lastNote: null, batches: (pathSet.batches || 0) + 1 },
            };
        });
    }, []);

    // The server cannot continue it (and had nothing to rebuild from).
    const expirePathSetSession = useCallback((pathSetId) => {
        setPathSets((prev) => {
            const pathSet = prev[pathSetId];
            if (!pathSet) return prev;
            return { ...prev, [pathSetId]: { ...pathSet, isComplete: true, resumable: false } };
        });
    }, []);

    /**
     * Open a generation (null closes it); its painted roads and areas come
     * back. `addSelections` (the plan's, when adding to it) join them.
     */
    const selectPathSet = useCallback((pathSetId, addSelections = null) => {
        setActiveId(pathSetId || null);
        let selections = pathSetId ? (pathSets[pathSetId]?.selections || []) : [];
        if (pathSetId && addSelections?.length) {
            const have = new Set(selections.map((sel) => sel.id));
            selections = [...selections, ...addSelections.filter((sel) => !have.has(sel.id))];
        }
        setDrawnSelections(selections);
        setSelectedPathId(null);
        setHoveredPathId(null);
        setFavoritesOnly(false);
        setKeptIds(new Set());
        if (pathSetId) resetFilterRanges();
    }, [pathSets, resetFilterRanges]);

    const renamePathSet = useCallback((pathSetId, name) => {
        const clean = (name || '').trim();
        if (!clean) return;
        setPathSets((prev) => (prev[pathSetId]
            ? { ...prev, [pathSetId]: { ...prev[pathSetId], name: clean } }
            : prev));
    }, []);

    /** Settings used for the generation's later batches (length, roads). */
    const updatePathSetSettings = useCallback((pathSetId, patch) => {
        setPathSets((prev) => (prev[pathSetId]
            ? { ...prev, [pathSetId]: { ...prev[pathSetId], settings: { ...prev[pathSetId].settings, ...patch } } }
            : prev));
    }, []);

    /** Delete a generation; returns it so it can be restored (undo). */
    const deletePathSet = useCallback((pathSetId) => {
        const removed = pathSets[pathSetId];
        if (!removed) return null;
        setPathSets((prev) => {
            const next = { ...prev };
            delete next[pathSetId];
            return next;
        });
        savedRef.current.delete(pathSetId);
        deleteGeneration(pathSetId);
        if (activeIdRef.current === pathSetId) {
            setActiveId(null);
            setDrawnSelections([]);
        }
        return { id: pathSetId, set: removed };
    }, [pathSets]);

    const restorePathSet = useCallback((removed) => {
        if (!removed?.id) return;
        setPathSets((prev) => ({ ...prev, [removed.id]: { ...removed.set, isComplete: true } }));
    }, []);

    // ---- the open generation's routes ----

    const activeSet = activeId ? pathSets[activeId] || null : null;
    const allPaths = useMemo(() => activeSet?.paths || [], [activeSet]);

    const generations = useMemo(() => Object.entries(pathSets)
        .map(([id, set]) => ({
            id,
            name: set.name || 'Generation',
            settings: set.settings || {},
            markerPosition: set.markerPosition,
            pathCount: set.paths.length,
            lengthRange: lengthRange(set.paths),
            isComplete: !!set.isComplete,
            resumable: !!set.resumable,
            lastNote: set.lastNote || null,
            selections: set.selections || [],
            createdAt: set.createdAt || 0,
            batches: set.batches || 0,
        }))
        .sort((a, b) => b.createdAt - a.createdAt), [pathSets]);

    const filterBounds = useMemo(() => {
        const bounds = {};
        FILTER_METRICS.forEach((metric) => {
            bounds[metric.key] = metricBounds(allPaths, metric);
        });
        return bounds;
    }, [allPaths]);

    const filteredPaths = useMemo(() => {
        if (!allPaths.length) return [];
        let paths = filterByMetrics(allPaths, routeFilters);
        paths = filterByRouteSelections(paths, drawnSelections);
        if (favoritesOnly) {
            paths = paths.filter((p) => keptIds.has(p.id) || (favorites && favorites.has(routeKey(p))));
        }
        return sortPaths(paths, sortBy, sortAscending);
    }, [allPaths, routeFilters, drawnSelections, favoritesOnly, favorites, keptIds, sortBy, sortAscending]);

    const currentPath = useMemo(() => {
        if (!selectedPathId) return filteredPaths[0] || null;
        return filteredPaths.find((p) => p.id === selectedPathId) || filteredPaths[0] || null;
    }, [filteredPaths, selectedPathId]);

    const currentPathIndex = useMemo(
        () => (currentPath ? filteredPaths.indexOf(currentPath) : 0),
        [filteredPaths, currentPath],
    );

    // Keep the selection on a route that is still listed.
    useEffect(() => {
        if (filteredPaths.length === 0) {
            if (selectedPathId) setSelectedPathId(null);
            return;
        }
        if (!selectedPathId || !filteredPaths.some((p) => p.id === selectedPathId)) {
            setSelectedPathId(filteredPaths[0].id);
        }
    }, [filteredPaths, selectedPathId]);

    // Favorites only: a route unfavorited there stays until another is selected.
    const keepListed = useCallback((pathId) => {
        setKeptIds((prev) => (prev.has(pathId) ? prev : new Set(prev).add(pathId)));
    }, []);
    const currentId = currentPath?.id ?? null;
    const keptFor = useRef(currentId);
    useEffect(() => {
        if (keptFor.current === currentId) return;
        keptFor.current = currentId;
        setKeptIds((prev) => (prev.size ? new Set() : prev));
    }, [currentId]);
    // The shown route stays if it is listed (a favorite); else the first one is shown.
    const showFavoritesOnly = useCallback((on) => {
        setFavoritesOnly(!!on);
        setKeptIds(new Set());
    }, []);

    // A new sort keeps the shown route (the list scrolls to it).
    const chooseSort = useCallback((id) => {
        if (!SORT_OPTIONS.some((o) => o.id === id) || id === sortByRef.current) return;
        setSortBy(id);
        setSortAscending(true);
    }, []);

    // Flipping the order jumps to the first route of the new order.
    const flipSort = useCallback(() => {
        setSortAscending((asc) => !asc);
        setSelectedPathId(null);
    }, []);

    const selectPath = useCallback((pathId) => setSelectedPathId(pathId), []);

    const step = useCallback((delta) => {
        if (!filteredPaths.length) return;
        const i = filteredPaths.findIndex((p) => p.id === currentPath?.id);
        const next = Math.min(Math.max((i < 0 ? 0 : i) + delta, 0), filteredPaths.length - 1);
        setSelectedPathId(filteredPaths[next].id);
    }, [filteredPaths, currentPath]);
    const nextPath = useCallback(() => step(1), [step]);
    const prevPath = useCallback(() => step(-1), [step]);

    // Oldest first: a pin shared by several generations sits at the first one's start.
    const pathSetMarkers = useMemo(() => Object.entries(pathSets)
        .map(([id, set]) => ({
            id,
            name: set.name || 'Generation',
            position: set.markerPosition,
            isActive: id === activeId,
            pathCount: set.paths.length,
            lengthRange: lengthRange(set.paths),
            createdAt: set.createdAt || 0,
        }))
        .sort((a, b) => a.createdAt - b.createdAt), [pathSets, activeId]);

    // Flip the elevation profile of the shown route (ride it the other way).
    const reverseCurrentPathProfile = useCallback(() => {
        if (!activeId || !currentPath) return;
        setPathSets((prev) => {
            const pathSet = prev[activeId];
            if (!pathSet) return prev;
            const paths = [...pathSet.paths];
            const pathIndex = paths.findIndex((p) => p.id === currentPath.id);
            if (pathIndex === -1) return prev;
            const profile = currentPath.properties.elevation_profile;
            if (!profile || profile.length < 2) return prev;
            const totalDist = profile[profile.length - 1][0];
            // Profile item: [dist_mi, elev_ft, lat, lng, bearing]
            const reversed = profile.map((p) => [
                Number((totalDist - p[0]).toFixed(3)), p[1], p[2], p[3], (p[4] + 180) % 360,
            ]).reverse();
            const properties = { ...currentPath.properties, elevation_profile: reversed };
            // Unpaved stretches: same points on the map, miles from the other end.
            if (Array.isArray(properties.unpaved)) properties.unpaved = reverseUnpaved(properties.unpaved, totalDist);
            paths[pathIndex] = { ...currentPath, properties };
            return { ...prev, [activeId]: { ...pathSet, paths } };
        });
    }, [activeId, currentPath]);

    return {
        // State
        pathSets,
        hydrated,
        activePathSetId: activeId,
        activePathSet: activeSet,
        currentPathIndex,
        currentPath,
        filteredPaths,
        totalPathsCount: allPaths.length,
        generations,
        routeFilters,
        filterBounds,
        sortBy,
        sortAscending,
        drawnSelections,
        pathSetMarkers,
        hoveredPathId,
        favoritesOnly,

        // Actions
        createPathSet,
        addPathToSet,
        completePathSet,
        resumePathSet,
        expirePathSetSession,
        selectPathSet,
        renamePathSet,
        updatePathSetSettings,
        deletePathSet,
        restorePathSet,
        addDrawnSelection,
        toggleEdges,
        clearDrawnSelections,
        replaceSelections,
        undoLastSelection,
        removeSelection,
        updateSelection,
        setFilterRange,
        addRouteFilter,
        removeRouteFilter,
        resetFilterRanges,
        chooseSort,
        flipSort,
        selectPath,
        setHoveredPathId,
        nextPath,
        prevPath,
        reverseCurrentPathProfile,
        showFavoritesOnly,
        keepListed,
    };
}
