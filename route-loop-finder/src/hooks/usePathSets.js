import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { filterByDistance, filterByDifficulty, filterBySelection, sortPaths } from '../utils/pathFiltering';
import { annotatePathsWithPoi } from '../utils/poiDistance';

const EMPTY_PINS = [];
const POI_FALLBACK_COUNT = 8;

/**
 * Manages all path set state - the core data store for the application.
 * A PathSet represents a starting point and all generated routes from it.
 */
export function usePathSets({
    poiPins = EMPTY_PINS,
    poiMatch = 'all',
    poiRadiusMiles = null,
} = {}) {
    // Map of pathSetId -> { markerPosition, paths: [] }
    const [pathSets, setPathSets] = useState({});
    const [activePathSetId, setActivePathSetId] = useState(null);
    const [selectedPathId, setSelectedPathId] = useState(null);
    const [distanceRange, setDistanceRange] = useState(() => {
        const saved = localStorage.getItem('distanceRange');
        return saved ? JSON.parse(saved) : [0, 200];
    });
    const [difficultyRange, setDifficultyRange] = useState(() => {
        const saved = localStorage.getItem('difficultyRange');
        return saved ? JSON.parse(saved) : [1, 10];
    });
    const [sortBy, setSortBy] = useState(() => {
        const saved = localStorage.getItem('sortBy');
        return saved && saved !== 'poi' ? saved : 'total_miles';
    });
    const [sortAscending, setSortAscending] = useState(true);

    // Save distanceRange to localStorage
    useEffect(() => {
        localStorage.setItem('distanceRange', JSON.stringify(distanceRange));
    }, [distanceRange]);

    // Save difficultyRange to localStorage
    useEffect(() => {
        localStorage.setItem('difficultyRange', JSON.stringify(difficultyRange));
    }, [difficultyRange]);

    // Save sortBy to localStorage
    useEffect(() => {
        if (sortBy && sortBy !== 'poi') {
            localStorage.setItem('sortBy', sortBy);
        }
    }, [sortBy]);


    // drawnSelections: Array of { id, mask, type: 'include'|'exclude', geometry }
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
    }, []);

    // Get the active path set
    const activePathSet = useMemo(() => {
        return activePathSetId ? pathSets[activePathSetId] : null;
    }, [pathSets, activePathSetId]);

    // Get filtered paths based on distance, drawn selections, and dropped pins
    const filterResult = useMemo(() => {
        if (!activePathSet?.paths?.length) return { paths: [], poiNote: null, closestPoiId: null };

        let paths = activePathSet.paths;

        // Filter by distance
        paths = filterByDistance(paths, distanceRange[0], distanceRange[1]);

        // Filter by difficulty
        paths = filterByDifficulty(paths, difficultyRange[0], difficultyRange[1]);

        // Filter by drawn selection masks if any
        if (drawnSelections.length > 0) {
            // Aggregate masks
            let strictIncludeMasks = []; // For 'path' tool (ALL nodes)
            let looseIncludeMasks = [];  // For 'lasso' tool (ANY node)
            let excludeMask = BigInt(0); // Single BigInt for OR logic

            drawnSelections.forEach(selection => {
                // Handle both old structure (backward compatibility) and new GeoJSON structure
                const props = selection.properties || selection;
                const mask = BigInt(props.mask || '0');
                const tool = props.tool || 'lasso'; // Default to lasso if undefined (backward compat)

                if (props.type === 'exclude') {
                    excludeMask = excludeMask | mask;
                } else {
                    // Add to appropriate inclusion list
                    if (mask > BigInt(0)) {
                        if (tool === 'path') {
                            strictIncludeMasks.push(mask);
                        } else {
                            looseIncludeMasks.push(mask);
                        }
                    }
                }
            });

            paths = filterBySelection(paths, strictIncludeMasks, looseIncludeMasks, excludeMask);
        }

        let poiNote = null;
        if (poiPins.length > 0) {
            paths = annotatePathsWithPoi(paths, poiPins, poiMatch);
            const ranked = [...paths].sort(
                (a, b) => (a.properties.poi_miles ?? Infinity) - (b.properties.poi_miles ?? Infinity)
            );
            const closest = ranked[0]?.properties?.poi_miles;
            if (poiRadiusMiles != null && poiRadiusMiles > 0) {
                const within = ranked.filter((p) => (p.properties.poi_miles ?? Infinity) <= poiRadiusMiles);
                if (within.length === 0) {
                    const shown = ranked.slice(0, Math.min(POI_FALLBACK_COUNT, ranked.length));
                    poiNote = {
                        fallback: true,
                        closest,
                        radius: poiRadiusMiles,
                        shown: shown.length,
                        withinCount: 0,
                    };
                    paths = shown;
                } else {
                    poiNote = {
                        fallback: false,
                        closest,
                        radius: poiRadiusMiles,
                        shown: within.length,
                        withinCount: within.length,
                    };
                    paths = within;
                }
            } else {
                poiNote = {
                    fallback: false,
                    closest,
                    radius: null,
                    shown: ranked.length,
                    withinCount: ranked.length,
                };
            }
        }

        let closestPoiId = null;
        if (poiPins.length > 0 && paths.length > 0) {
            let best = paths[0];
            for (const path of paths) {
                const miles = path.properties?.poi_miles ?? Infinity;
                if (miles < (best.properties?.poi_miles ?? Infinity)) best = path;
            }
            closestPoiId = best.id;
        }

        const effectiveSort = sortBy === 'poi' && poiPins.length === 0 ? 'total_miles' : sortBy;
        return { paths: sortPaths(paths, effectiveSort, sortAscending), poiNote, closestPoiId };
    }, [activePathSet, distanceRange, difficultyRange, drawnSelections, sortBy, sortAscending, poiPins, poiMatch, poiRadiusMiles]);

    const filteredPaths = filterResult.paths;
    const poiNote = filterResult.poiNote;
    const closestPoiId = filterResult.closestPoiId;

    const poiQueryKey = poiPins.length === 0
        ? ''
        : `${poiMatch}|${poiRadiusMiles ?? ''}|${poiPins.map((pin) => `${pin.id}:${pin.lat}:${pin.lng}`).join(';')}`;
    const [appliedPoiKey, setAppliedPoiKey] = useState('');
    if (poiQueryKey !== appliedPoiKey) {
        setAppliedPoiKey(poiQueryKey);
        if (poiQueryKey) {
            if (sortBy !== 'poi') setSortBy('poi');
            if (!sortAscending) setSortAscending(true);
            if (closestPoiId && closestPoiId !== selectedPathId) setSelectedPathId(closestPoiId);
        }
    }



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

            const {
                poi_miles: _poiMiles,
                poi_approaches: _poiApproaches,
                ...storedProperties
            } = currentPath.properties;

            // Create new path object with updated profile
            const newPath = {
                ...currentPath,
                properties: {
                    ...storedProperties,
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
        poiNote,
        distanceRange,
        difficultyRange,
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
        setDistanceRange,
        setDifficultyRange,
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
