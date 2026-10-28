import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { FILTER_METRICS, OPEN_RANGE, filterByMetrics, metricBounds, sanitizeRouteFilters, sortPaths } from '../utils/pathFiltering';
import { filterByRouteSelections, routesSharingGround } from '../utils/routeSelections';

/** Next unused label, so a blank name still tells two runs of the same algorithm apart. */
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

/**
 * Manages all path set state - the core data store for the application.
 * A PathSet represents a starting point and all generated routes from it.
 */
export function usePathSets() {
    // Map of pathSetId -> { markerPosition, paths: [] }
    const [pathSets, setPathSets] = useState({});
    // A and B are generation ids. mode is how two selected runs combine.
    const [compare, setCompare] = useState({ a: null, b: null, mode: 'intersection' });
    const [selectedPathId, setSelectedPathId] = useState(null);
    const [routeFilters, setRouteFilters] = useState(() => {
        try {
            const saved = localStorage.getItem('routeFilterLimits');
            if (saved) {
                const parsed = sanitizeRouteFilters(JSON.parse(saved));
                if (parsed.length > 0) return parsed;
            }
            // Older saves used fixed slider ends, so keep only which filters were open.
            const legacy = sanitizeRouteFilters(JSON.parse(localStorage.getItem('routeFilters') || '[]'));
            if (legacy.length > 0) {
                return legacy.map((filter) => ({ key: filter.key, range: OPEN_RANGE }));
            }
        } catch {
            // Fall through to the distance default.
        }
        return [{ key: 'total_miles', range: OPEN_RANGE }];
    });
    const [sortBy, setSortBy] = useState(() => {
        const saved = localStorage.getItem('sortBy');
        if (!saved || saved === 'poi') return 'total_miles';
        if (saved === 'spatial') return 'similar';
        return saved;
    });
    const [sortAscending, setSortAscending] = useState(true);
    const sortByRef = useRef(sortBy);
    sortByRef.current = sortBy;

    useEffect(() => {
        localStorage.setItem('routeFilterLimits', JSON.stringify(routeFilters));
    }, [routeFilters]);

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
        setRouteFilters((prev) => {
            const next = prev.filter((filter) => filter.key !== key);
            if (next.length > 0) return next;
            return [{ key: 'total_miles', range: OPEN_RANGE }];
        });
    }, []);

    // Save sortBy to localStorage
    useEffect(() => {
        if (sortBy) {
            localStorage.setItem('sortBy', sortBy);
        }
    }, [sortBy]);


    // drawnSelections: { id, type: 'include'|'exclude', shape, geometry }
    const [drawnSelections, setDrawnSelections] = useState([]);

    // Create a new path set when generation starts. meta is the name and settings snapshot.
    const createPathSet = useCallback((pathSetId, markerPosition, meta) => {
        const info = meta || {};
        const settings = info.settings || {};
        setPathSets(prev => ({
            ...prev,
            [pathSetId]: {
                markerPosition,
                paths: [],
                isComplete: false,
                name: info.name || 'Generation',
                graph: info.graph || '',
                algorithmLabel: info.algorithmLabel || settings.algorithm || 'Generation',
                settings,
                createdAt: Date.now()
            }
        }));
        setCompare(prev => ({
            ...prev,
            a: pathSetId,
            b: prev.b === pathSetId ? null : prev.b
        }));
        setSelectedPathId(null);
        setDrawnSelections([]);
    }, []);

    // Add a path to an existing path set
    const addPathToSet = useCallback((pathSetId, pathData) => {
        setPathSets(prev => {
            const pathSet = prev[pathSetId];
            if (!pathSet) return prev;

            // Generate a unique ID for the path if it doesn't have one
            // Use crypto.randomUUID where available, or fallback to timestamp+random
            const uniqueId = typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : `${pathSetId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            const pathWithId = {
                ...pathData,
                id: uniqueId
            };

            return {
                ...prev,
                [pathSetId]: {
                    ...pathSet,
                    paths: [...pathSet.paths, pathWithId]
                }
            };
        });
    }, []);

    // Mark a path set as complete
    const completePathSet = useCallback((pathSetId) => {
        setPathSets(prev => {
            const pathSet = prev[pathSetId];
            if (!pathSet) return prev;

            return {
                ...prev,
                [pathSetId]: { ...pathSet, isComplete: true }
            };
        });
    }, []);

    // Open a generation as set A. Clicking the generation already in B swaps them.
    const selectPathSet = useCallback((pathSetId) => {
        setDrawnSelections([]);
        setSelectedPathId(null);
        if (!pathSetId) {
            setCompare(prev => ({ ...prev, a: null }));
            return;
        }
        setCompare(prev => {
            if (!pathSets[pathSetId]) return prev;
            if (prev.b === pathSetId) {
                return { ...prev, a: pathSetId, b: prev.a === pathSetId ? null : prev.a };
            }
            return { ...prev, a: pathSetId };
        });
    }, [pathSets]);

    const setCompareA = useCallback((id) => {
        const next = id || null;
        setCompare(prev => ({
            ...prev,
            a: next,
            b: next && next === prev.b ? null : prev.b
        }));
        setDrawnSelections([]);
        setSelectedPathId(null);
    }, []);

    const setCompareB = useCallback((id) => {
        const next = id || null;
        setCompare(prev => ({
            ...prev,
            b: next,
            a: next && next === prev.a ? null : prev.a
        }));
        setDrawnSelections([]);
        setSelectedPathId(null);
    }, []);

    const setCompareMode = useCallback((mode) => {
        if (mode !== 'intersection' && mode !== 'difference') return;
        setCompare(prev => (prev.mode === mode ? prev : { ...prev, mode }));
    }, []);

    const swapCompare = useCallback(() => {
        setCompare(prev => ({ ...prev, a: prev.b, b: prev.a }));
    }, []);

    // Add a drawn selection for filtering
    const addDrawnSelection = useCallback((selectionData) => {
        setDrawnSelections(prev => [...prev, selectionData]);
        setSelectedPathId(null);
        const currentSort = sortByRef.current;
        if (currentSort === 'total_miles' || currentSort === 'spatial' || currentSort === 'poi') {
            setSortBy('similar');
            setSortAscending(true);
        }
    }, []);

    // Clear drawn selections
    const clearDrawnSelections = useCallback(() => {
        setDrawnSelections([]);
    }, []);

    const undoLastSelection = useCallback(() => {
        setDrawnSelections(prev => {
            if (prev.length === 0) return prev;
            return prev.slice(0, -1);
        });
        setSelectedPathId(null);
    }, []);

    const removeSelection = useCallback((id) => {
        setDrawnSelections(prev => prev.filter((selection) => selection.id !== id));
        setSelectedPathId(null);
    }, []);

    const compareA = compare.a && pathSets[compare.a] ? compare.a : null;
    const compareB = compare.b && pathSets[compare.b] ? compare.b : null;
    const compareMode = compare.mode === 'difference' ? 'difference' : 'intersection';
    // One selected run is shown whole. Two runs combine from A's point of view.
    const sourceId = compareA && compareB ? compareA : (compareA || compareB);

    const comparedPaths = useMemo(() => {
        const setA = compareA ? pathSets[compareA] : null;
        const setB = compareB ? pathSets[compareB] : null;
        if (setA && setB) {
            const { shared, only } = routesSharingGround(setA.paths, setB.paths);
            return compareMode === 'difference' ? only : shared;
        }
        if (setA) return setA.paths;
        if (setB) return setB.paths;
        return [];
    }, [pathSets, compareA, compareB, compareMode]);

    const generations = useMemo(() => {
        return Object.entries(pathSets)
            .map(([id, set]) => ({
                id,
                name: set.name || 'Generation',
                algorithmLabel: set.algorithmLabel || '',
                graph: set.graph || '',
                settings: set.settings || {},
                markerPosition: set.markerPosition,
                pathCount: set.paths.length,
                isComplete: !!set.isComplete,
                createdAt: set.createdAt || 0
            }))
            .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
    }, [pathSets]);

    // Get the active path set
    const activePathSet = sourceId ? pathSets[sourceId] : null;

    const filterBounds = useMemo(() => {
        const bounds = {};
        FILTER_METRICS.forEach((metric) => {
            bounds[metric.key] = metricBounds(comparedPaths, metric);
        });
        return bounds;
    }, [comparedPaths]);

    // Get filtered paths based on distance, drawn selections, and dropped pins
    const filteredPaths = useMemo(() => {
        if (!comparedPaths.length) return [];

        let paths = comparedPaths;
        paths = filterByMetrics(paths, routeFilters);
        paths = filterByRouteSelections(paths, drawnSelections);
        return sortPaths(paths, sortBy, sortAscending);
    }, [comparedPaths, routeFilters, drawnSelections, sortBy, sortAscending]);



    // Get the currently displayed path based on ID
    const currentPath = useMemo(() => {
        if (!selectedPathId) return filteredPaths[0] || null;
        return filteredPaths.find(p => p.id === selectedPathId) || filteredPaths[0] || null;
    }, [filteredPaths, selectedPathId]);

    // Derive the index for display components
    const currentPathIndex = useMemo(() => {
        if (!currentPath) return 0;
        return filteredPaths.indexOf(currentPath);
    }, [filteredPaths, currentPath]);

    // Ensure selectedPathId is valid when filteredPaths changes
    useEffect(() => {
        if (filteredPaths.length > 0) {
            // If we have a selected path, check if it's still in the list
            if (selectedPathId) {
                const stillExists = filteredPaths.some(p => p.id === selectedPathId);
                if (!stillExists) {
                    // It's gone, default to the first one
                    setSelectedPathId(filteredPaths[0].id);
                }
            } else {
                // No selection, select the first one
                setSelectedPathId(filteredPaths[0].id);
            }
        } else {
            setSelectedPathId(null);
        }
    }, [filteredPaths, selectedPathId]);

    // Wrappers for sort setters to capture current path - NO LONGER NEEDED with ID-based selection!
    // The ID based selection automatically preserves the selection because the ID doesn't change on sort.
    const handleSetSortBy = useCallback((newSortBy) => {
        setSortBy(newSortBy);
    }, []);

    const handleSetSortAscending = useCallback((newAsc) => {
        setSortAscending(newAsc);
        setSelectedPathId(null); // Reset selection to default to the first one in the new order
    }, []);

    // Navigation helpers
    const nextPath = useCallback(() => {
        const currentIndex = filteredPaths.findIndex(p => p.id === currentPath?.id);
        if (currentIndex < filteredPaths.length - 1) {
            setSelectedPathId(filteredPaths[currentIndex + 1].id);
        }
    }, [filteredPaths, currentPath]);

    const prevPath = useCallback(() => {
        const currentIndex = filteredPaths.findIndex(p => p.id === currentPath?.id);
        if (currentIndex > 0) {
            setSelectedPathId(filteredPaths[currentIndex - 1].id);
        }
    }, [filteredPaths, currentPath]);

    const jumpPath = useCallback((delta) => {
        const currentIndex = filteredPaths.findIndex(p => p.id === currentPath?.id);
        if (currentIndex === -1 && filteredPaths.length > 0) {
            setSelectedPathId(filteredPaths[0].id);
            return;
        }

        const newIndex = Math.min(Math.max(currentIndex + delta, 0), filteredPaths.length - 1);
        if (newIndex !== currentIndex) {
            setSelectedPathId(filteredPaths[newIndex].id);
        }
    }, [filteredPaths, currentPath]);

    const goToFirst = useCallback(() => {
        if (filteredPaths.length > 0) {
            setSelectedPathId(filteredPaths[0].id);
        }
    }, [filteredPaths]);

    const goToLast = useCallback(() => {
        if (filteredPaths.length > 0) {
            setSelectedPathId(filteredPaths[filteredPaths.length - 1].id);
        }
    }, [filteredPaths]);

    const goToPath = useCallback((index) => {
        if (index >= 0 && index < filteredPaths.length) {
            setSelectedPathId(filteredPaths[index].id);
        }
    }, [filteredPaths]);

    // Get all path set markers for display
    const pathSetMarkers = useMemo(() => {
        return Object.entries(pathSets).map(([id, pathSet]) => ({
            id,
            name: pathSet.name || 'Generation',
            position: pathSet.markerPosition,
            isActive: id === sourceId,
            pathCount: pathSet.paths.length
        }));
    }, [pathSets, sourceId]);

    const reverseCurrentPathProfile = useCallback(() => {
        if (!sourceId || !currentPath) return;

        setPathSets(prev => {
            const pathSet = prev[sourceId];
            if (!pathSet) return prev;

            const paths = [...pathSet.paths];
            // Find the index of the path in the source array
            // Note: currentPath is from filteredPaths, so we need to find it in the main list
            // However, paths objects are references, so we can find index by reference
            const pathIndex = paths.findIndex((p) => p.id === currentPath.id);

            if (pathIndex === -1) return prev;

            const originalProfile = currentPath.properties.elevation_profile;
            if (!originalProfile || originalProfile.length < 2) return prev;

            const totalDist = originalProfile[originalProfile.length - 1][0];

            // Create new reversed profile
            // Profile item: [dist_mi, elev_ft, lat, lng, bearing]
            const reversedProfile = originalProfile.map(p => [
                Number((totalDist - p[0]).toFixed(3)), // New distance
                p[1],                                  // Elevation
                p[2],                                  // Lat
                p[3],                                  // Lng
                (p[4] + 180) % 360                     // New Bearing
            ]).reverse();

            const newPath = {
                ...currentPath,
                properties: {
                    ...currentPath.properties,
                    elevation_profile: reversedProfile
                }
            };

            paths[pathIndex] = newPath;

            return {
                ...prev,
                [sourceId]: {
                    ...pathSet,
                    paths: paths
                }
            };
        });
    }, [sourceId, currentPath]);

    return {
        // State
        pathSets,
        activePathSetId: sourceId,
        activePathSet,
        currentPathIndex,
        currentPath,
        filteredPaths,
        comparedCount: comparedPaths.length,
        generations,
        compareA,
        compareB,
        compareMode,
        routeFilters,
        filterBounds,
        sortBy,
        sortAscending,
        drawnSelections,
        pathSetMarkers,

        // Actions
        createPathSet,
        addPathToSet,
        completePathSet,
        selectPathSet,
        setCompareA,
        setCompareB,
        setCompareMode,
        swapCompare,
        addDrawnSelection,
        clearDrawnSelections,
        undoLastSelection,
        removeSelection,
        setFilterRange,
        addRouteFilter,
        removeRouteFilter,
        setSortBy: handleSetSortBy,
        setSortAscending: handleSetSortAscending,
        nextPath,
        prevPath,
        goToPath,
        jumpPath,
        goToFirst,
        goToLast,
        reverseCurrentPathProfile
    };
}
