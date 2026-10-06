import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { FILTER_METRICS, OPEN_RANGE, filterByMetrics, metricBounds, sanitizeRouteFilters, sortPaths } from '../utils/pathFiltering';
import { filterByRouteSelections } from '../utils/routeSelections';

/**
 * Manages all path set state - the core data store for the application.
 * A PathSet represents a starting point and all generated routes from it.
 */
export function usePathSets() {
    // Map of pathSetId -> { markerPosition, paths: [] }
    const [pathSets, setPathSets] = useState({});
    const [activePathSetId, setActivePathSetId] = useState(null);
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

    // Create a new path set when generation starts
    const createPathSet = useCallback((pathSetId, markerPosition) => {
        setPathSets(prev => ({
            ...prev,
            [pathSetId]: {
                markerPosition,
                paths: [],
                isComplete: false
            }
        }));
        setActivePathSetId(pathSetId);
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

    // Select a path set to display
    const selectPathSet = useCallback((pathSetId) => {
        setDrawnSelections([]);
        if (!pathSetId) {
            setActivePathSetId(null);
            return;
        }
        if (pathSets[pathSetId]) {
            setActivePathSetId(pathSetId);
            setSelectedPathId(null);
        }
    }, [pathSets]);

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

    // Get the active path set
    const activePathSet = useMemo(() => {
        return activePathSetId ? pathSets[activePathSetId] : null;
    }, [pathSets, activePathSetId]);

    const filterBounds = useMemo(() => {
        const bounds = {};
        FILTER_METRICS.forEach((metric) => {
            bounds[metric.key] = metricBounds(activePathSet?.paths, metric);
        });
        return bounds;
    }, [activePathSet]);

    // Get filtered paths based on distance, drawn selections, and dropped pins
    const filteredPaths = useMemo(() => {
        if (!activePathSet?.paths?.length) return [];

        let paths = activePathSet.paths;
        paths = filterByMetrics(paths, routeFilters);
        paths = filterByRouteSelections(paths, drawnSelections);
        return sortPaths(paths, sortBy, sortAscending);
    }, [activePathSet, routeFilters, drawnSelections, sortBy, sortAscending]);



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
            position: pathSet.markerPosition,
            isActive: id === activePathSetId,
            pathCount: pathSet.paths.length
        }));
    }, [pathSets, activePathSetId]);

    const reverseCurrentPathProfile = useCallback(() => {
        if (!activePathSetId || !currentPath) return;

        setPathSets(prev => {
            const pathSet = prev[activePathSetId];
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
                [activePathSetId]: {
                    ...pathSet,
                    paths: paths
                }
            };
        });
    }, [activePathSetId, currentPath]);

    return {
        // State
        pathSets,
        activePathSetId,
        activePathSet,
        currentPathIndex,
        currentPath,
        filteredPaths,
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
