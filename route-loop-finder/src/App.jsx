import { useEffect, useCallback, useState, useRef } from 'react';
import { Activity } from 'lucide-react';
import './App.css';

import { MapView } from './components/MapView';
import { ControlPanel } from './components/ControlPanel';
import ElevationProfileWindow from './components/ElevationProfileWindow';
import { useWebSocket } from './hooks/useWebSocket';
import { usePathSets } from './hooks/usePathSets';
import { useAppMode } from './hooks/useAppMode';

const LAST_GRAPH_SHAPE_KEY = 'lastGraphShape';

function isValidGraphBounds(bounds) {
  if (!bounds?.type) return false;
  if (bounds.type === 'box') {
    return bounds.nw?.lat != null && bounds.nw?.lng != null &&
      bounds.se?.lat != null && bounds.se?.lng != null;
  }
  if (bounds.type === 'polygon') {
    return Array.isArray(bounds.coordinates) && bounds.coordinates.length >= 3;
  }
  if (bounds.type === 'circle') {
    return bounds.center?.lat != null && bounds.center?.lng != null && bounds.radiusMiles != null;
  }
  return false;
}

function loadLastGraphShape() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_GRAPH_SHAPE_KEY));
    return isValidGraphBounds(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveLastGraphShape(bounds) {
  if (!bounds?.type) return;
  localStorage.setItem(LAST_GRAPH_SHAPE_KEY, JSON.stringify(bounds));
}

/** Convert a saved .boundary.json payload into BoundsSelector graphBounds. */
function boundaryToGraphBounds(boundary) {
  if (!boundary?.type) return null;
  if (boundary.type === 'box' &&
      [boundary.north, boundary.south, boundary.east, boundary.west].every((v) => v != null)) {
    return {
      type: 'box',
      nw: { lat: boundary.north, lng: boundary.west },
      se: { lat: boundary.south, lng: boundary.east }
    };
  }
  if (boundary.type === 'polygon' && Array.isArray(boundary.coordinates) && boundary.coordinates.length >= 3) {
    return { type: 'polygon', coordinates: boundary.coordinates };
  }
  if (boundary.type === 'circle' && boundary.center != null && boundary.radius_miles != null) {
    const center = Array.isArray(boundary.center)
      ? { lat: boundary.center[0], lng: boundary.center[1] }
      : boundary.center;
    if (center?.lat == null || center?.lng == null) return null;
    return { type: 'circle', center, radiusMiles: boundary.radius_miles };
  }
  return null;
}

function App() {
  // Initialize hooks
  const { status: wsStatus, sendMessage, subscribe } = useWebSocket();
  const {
    pathSetMarkers,
    activePathSetId,
    activePathSet,
    currentPath,
    currentPathIndex,
    filteredPaths,
    distanceRange,
    difficultyRange,
    sortBy,
    sortAscending,
    drawnSelections,
    createPathSet,
    addPathToSet,
    completePathSet,
    selectPathSet,
    addDrawnSelection,
    setDistanceRange,
    setDifficultyRange,
    setSortBy,
    setSortAscending,
    nextPath,
    prevPath,
    goToPath,
    jumpPath,
    goToFirst,
    goToLast,
    reverseCurrentPathProfile,
    undoLastSelection
  } = usePathSets();

  const {
    mode,
    setMode,
    pendingMarker,
    setMarkerPosition,
    clearPendingMarker
  } = useAppMode();

  // Local state for tools
  const [activeTool, setActiveTool] = useState(null); // 'path', 'lasso', or null
  const [isExcludeMode, setIsExcludeMode] = useState(false);
  const [isElevationMinimized, setIsElevationMinimized] = useState(false);
  const [hoveredPoint, setHoveredPoint] = useState(null);

  // Display Options
  const [showArrows, setShowArrows] = useState(true);
  const [showCentroids, setShowCentroids] = useState(false);
  const [primaryColor, setPrimaryColor] = useState(() => localStorage.getItem('primaryColor') || '215'); // Default hue (Blue)
  const [showPathPreview, setShowPathPreview] = useState(true);
  const [pathPreviewOpacity, setPathPreviewOpacity] = useState(0.5);
  const [showGraphBoundary, setShowGraphBoundary] = useState(false);
  const [showGraphNodes, setShowGraphNodes] = useState(false);
  const [graphNodes, setGraphNodes] = useState([]);
  const [exclusionZones, setExclusionZones] = useState([]);
  const [isDrawingExclusion, setIsDrawingExclusion] = useState(false);

  // Update CSS variables when primary color changes
  useEffect(() => {
    const root = document.documentElement;
    // Assuming primaryColor is a hue value (0-360) or a string that can be parsed as such.
    // If it's a hex string, this HSL conversion will not work as expected.
    // For now, we'll assume it's a hue number or a string representation of a hue number.
    root.style.setProperty('--color-primary', `hsl(${primaryColor}, 65%, 50%)`);
    root.style.setProperty('--color-primary-light', `hsl(${primaryColor}, 65%, 90%)`);
    root.style.setProperty('--color-primary-dark', `hsl(${primaryColor}, 65%, 40%)`);
    root.style.setProperty('--color-accent', `hsl(${primaryColor}, 70%, 60%)`);
    root.style.setProperty('--path-active', `hsl(${primaryColor}, 65%, 30%)`); // Darker for path
    root.style.setProperty('--marker-pending', `hsl(${primaryColor}, 65%, 50%)`);
  }, [primaryColor]);

  // Graph management state
  const [graphs, setGraphs] = useState([]);
  const [activeGraph, setActiveGraph] = useState(null);
  const [graphBounds, setGraphBounds] = useState(null);
  const [isCreatingGraph, setIsCreatingGraph] = useState(false);
  const [graphCreateMode, setGraphCreateMode] = useState('box'); // 'box' or 'polygon'
  const [graphBoundaries, setGraphBoundaries] = useState({});

  // Ref for path tool undo handler
  const pathUndoRef = useRef(null);

  // Queue to track pending requests context (to know if response is include/exclude)
  const pendingRequests = useRef([]);

  // Handle WebSocket messages
  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      console.log('[App] Received message:', message);

      switch (message.type) {
        case 'PATHSET_CREATED':
          createPathSet(message.pathSetId, message.markerPosition);
          setMode('display');
          break;

        case 'PATH_RECEIVED':
          addPathToSet(message.pathSetId, message.path);
          break;

        case 'GENERATION_COMPLETE':
          completePathSet(message.pathSetId);
          break;

        case 'NODES_IN_REGION':
        case 'NODES_ALONG_PATH': {
          // Pop context to see if it was include or exclude
          const context = pendingRequests.current.shift();
          const type = context?.type || 'include'; // default to include if lost

          // For path tool: use server-returned edge geometry if available
          // For lasso tool: construct geometry from user-drawn coordinates
          let selectionFeature;
          if (message.edges && context?.tool === 'path') {
            // Use the actual matched edge geometry from the server
            selectionFeature = {
              ...message.edges,
              properties: {
                ...message.edges.properties,
                mask: message.mask,
                type: type,
                tool: 'path'
              }
            };
          } else {
            // Construct GeoJSON geometry from user-drawn coordinates
            let geometry = null;
            if (context?.coordinates) {
              const coords = context.coordinates.map(([lat, lng]) => [lng, lat]);

              if (context.tool === 'lasso') {
                if (coords.length > 0) {
                  const first = coords[0];
                  const last = coords[coords.length - 1];
                  if (first[0] !== last[0] || first[1] !== last[1]) {
                    coords.push(first);
                  }
                }
                geometry = { type: 'Polygon', coordinates: [coords] };
              } else {
                geometry = { type: 'LineString', coordinates: coords };
              }
            }
            selectionFeature = {
              type: "Feature",
              geometry: geometry,
              properties: {
                mask: message.mask,
                type: type,
                tool: context?.tool
              }
            };
          }

          console.log('[App] Received nodes in region:', message.mask, type);
          addDrawnSelection(selectionFeature);
          break;
        }

        // Graph management messages
        case 'GRAPHS_LIST':
          setGraphs(message.graphs || []);
          if (message.active) {
            setActiveGraph(message.active);
          }
          if (message.boundaries) {
            setGraphBoundaries(message.boundaries);
          }
          break;

        case 'GRAPH_SWITCHED':
          setActiveGraph(message.name);
          break;

        case 'GRAPH_CREATING':
          setIsCreatingGraph(true);
          break;

        case 'GRAPH_CREATED':
          setIsCreatingGraph(false);
          setActiveGraph(message.name);
          setGraphBounds(null);
          setMode('input');
          break;

        case 'GRAPH_CREATE_ERROR':
          setIsCreatingGraph(false);
          console.error('[App] Graph creation error:', message.error);
          alert(`Graph creation failed: ${message.error}`);
          break;

        case 'GRAPH_NODES':
          setGraphNodes(message.nodes || []);
          break;

        default:
          console.log('[App] Unknown message type:', message.type);
      }
    });

    return unsubscribe;
  }, [subscribe, createPathSet, addPathToSet, completePathSet, addDrawnSelection, setMode]);

  // Handle map click (in input mode)
  const handleMapClick = useCallback((position) => {
    setMarkerPosition(position);
  }, [setMarkerPosition]);

  // Handle marker click to select a path set
  const handleMarkerClick = useCallback((pathSetId) => {
    selectPathSet(pathSetId);
    setMode('display');
  }, [selectPathSet, setMode]);

  // Handle drawing complete
  const handleDrawingComplete = useCallback((coordinates, tool, exclude) => {
    // If drawing an exclusion zone (Graph Create Mode)
    // Only if explicitly in drawing exclusion mode (set by GraphSelector)
    if (isDrawingExclusion) {
      if (tool === 'lasso' && coordinates.length > 2) {
        setExclusionZones(prev => [...prev, coordinates]);
        // Keep tool active for multiple zones
      }
      return;
    }

    const context = { type: exclude ? 'exclude' : 'include', coordinates, tool };
    pendingRequests.current.push(context);

    if (tool === 'path') {
      sendMessage('GET_NODES_NEAR_POLYLINE', { coordinates });
    } else if (tool === 'lasso') {
      sendMessage('GET_NODES_IN_REGION', { coordinates });
      setActiveTool(null);
    }
  }, [sendMessage, setActiveTool, isDrawingExclusion]);

  // Graph management handlers
  const handleSwitchGraph = useCallback((name) => {
    sendMessage('SWITCH_GRAPH', { name });
    setGraphNodes([]); // Clear nodes when switching graphs
  }, [sendMessage]);

  const handleStartGraphCreate = useCallback(() => {
    const lastShape = loadLastGraphShape();
    const fromActive = activeGraph ? boundaryToGraphBounds(graphBoundaries[activeGraph]) : null;
    const startShape = lastShape?.type ? lastShape : fromActive;

    if (startShape?.type) {
      setGraphCreateMode(startShape.type);
      setGraphBounds(startShape);
    } else {
      setGraphCreateMode('box');
      setGraphBounds(null); // BoundsSelector fills from the current viewport
    }
    setMode('graphCreate');
  }, [setMode, activeGraph, graphBoundaries]);

  const handleGraphBoundsChange = useCallback((bounds) => {
    setGraphBounds(bounds);
  }, []);

  // Generator Settings State
  const [genSettings, setGenSettings] = useState(() => {
    const saved = localStorage.getItem('generatorSettings');
    return saved ? JSON.parse(saved) : {
      min_path_len: 15,
      max_path_len: 40,
      loop_ratio: 0.5,
      sim_ceiling: 0.7,
      num_paths: 30,
      algorithm: 'scenic', // 'scenic' or 'direct'
      deduplication: 'centroid', // 'centroid' or 'jaccard'
      min_dist_m: 50 // Centroid distance threshold in meters
    };
  });

  // Save settings to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('generatorSettings', JSON.stringify(genSettings));
  }, [genSettings]);



  // Define handleCreateGraph
  const handleCreateGraph = useCallback(() => {
    if (!graphBounds) return;

    // Validate polygon has enough points
    if (graphBounds.type === 'polygon' && (!graphBounds.coordinates || graphBounds.coordinates.length < 3)) {
      return;
    }

    const name = window.prompt('Enter a name for the new graph:');
    if (name && name.trim()) {
      const payload = {
        name: name.trim(),
        boundary_type: graphBounds.type,
        exclusion_zones: exclusionZones // Add exclusion zones
      };

      if (graphBounds.type === 'polygon') {
        payload.coordinates = graphBounds.coordinates;
      } else if (graphBounds.type === 'circle') {
        payload.center_lat = graphBounds.center.lat;
        payload.center_lng = graphBounds.center.lng;
        payload.radius_miles = graphBounds.radiusMiles;
      } else {
        // Box — min/max so swapped handles still make a valid OSM bbox
        const { nw, se } = graphBounds;
        payload.south = Math.min(nw.lat, se.lat);
        payload.north = Math.max(nw.lat, se.lat);
        payload.west = Math.min(nw.lng, se.lng);
        payload.east = Math.max(nw.lng, se.lng);
      }

      saveLastGraphShape(graphBounds);
      sendMessage('CREATE_GRAPH', payload);
    }
  }, [graphBounds, exclusionZones, sendMessage]);

  // Keyboard Shortcuts Effect - Updated to use handleCreateGraph
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Input Mode: Enter to start generation
      if (e.key === 'Enter' && mode === 'input' && pendingMarker) {
        // ... existing input mode logic ...
        sendMessage('START_GENERATION', {
          lat: pendingMarker.lat,
          lng: pendingMarker.lng,
          ...genSettings
        });
        localStorage.setItem('lastMapPosition', JSON.stringify({
          center: [pendingMarker.lat, pendingMarker.lng],
          zoom: 13
        }));
      }

      // Graph Create Mode: Enter to create graph
      if (e.key === 'Enter' && mode === 'graphCreate' && graphBounds && !isCreatingGraph) {
        handleCreateGraph();
      }

      // ... rest of key handlers ...


      // Graph Create Mode: Escape or Backspace to cancel
      if ((e.key === 'Escape' || e.key === 'Backspace') && mode === 'graphCreate') {
        setGraphBounds(null);
        setMode('input');
      }

      // Graph Create Mode: Z to undo / remove last exclusion zone
      if ((e.key === 'z' || e.key === 'Z') && mode === 'graphCreate') {
        if (exclusionZones && exclusionZones.length > 0) {
          setExclusionZones(prev => prev.slice(0, -1));
        } else if (graphBounds?.type === 'polygon') {
          const coords = graphBounds.coordinates;
          if (coords && coords.length > 0) {
            const newCoords = coords.slice(0, -1);
            setGraphBounds({ ...graphBounds, coordinates: newCoords });
          }
        }
      }

      // Graph Create Mode: L to toggle exclusion tool
      if ((e.key === 'l' || e.key === 'L') && mode === 'graphCreate') {
        setIsDrawingExclusion(prev => !prev);
      }

      // Display Mode Shortcuts
      if (mode === 'display') {
        // Backspace: Return to Input Mode
        if (e.key === 'Backspace') {
          console.log('Backspace pressed, returning to input mode');
          selectPathSet(null);
          setMode('input');
          setActiveTool(null);
        }

        // Arrow keys: page through paths
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          nextPath();
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          prevPath();
        }

        // 'e' key: Toggle elevation window
        if (e.key === 'e' || e.key === 'E') {
          setIsElevationMinimized(prev => !prev);
        }

        // p: path tool
        if (e.key === 'p' || e.key === 'P') {
          setActiveTool(activeTool === 'path' ? null : 'path');
        }

        // l: lasso tool
        if (e.key === 'l' || e.key === 'L') {
          setActiveTool(activeTool === 'lasso' ? null : 'lasso');
        }

        // k: pan / no tool
        if (e.key === 'k' || e.key === 'K') {
          setActiveTool(null);
        }

        // z: Undo last selection (or path point if in path tool)
        if (e.key === 'z' || e.key === 'Z') {
          // First try path tool undo (moves point back)
          const pathHandledUndo = pathUndoRef.current?.();
          if (!pathHandledUndo) {
            // If path tool didn't handle it, do selection undo
            undoLastSelection();
          } else {
            // Path tool moved the point back, also remove the last selection
            undoLastSelection();
          }
        }

        // d: Toggle Exclude mode
        if (e.key === 'd' || e.key === 'D') {
          setIsExcludeMode(prev => !prev);
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [mode, pendingMarker, sendMessage, clearPendingMarker, selectPathSet, setMode, undoLastSelection, genSettings, graphBounds, isCreatingGraph, nextPath, prevPath, activeTool, setActiveTool, setIsExcludeMode, setIsElevationMinimized, pathUndoRef, graphCreateMode, handleCreateGraph, exclusionZones, setIsDrawingExclusion]);

  // Auto-show elevation window when path with elevation data is selected
  // Auto-show elevation window when path with elevation data is selected
  useEffect(() => {
    // If we have a path with elevation data, ensure we are not in minimized state unless user explicitly minimized
    // But since we want persistent minimization, we actually don't want to force it open every time the path changes
    // if the user minimized it.
    // So we just don't do anything here. The window shows if !isElevationMinimized and data exists.
  }, [currentPath]);

  // Persist primary color setting
  useEffect(() => {
    localStorage.setItem('primaryColor', primaryColor);
  }, [primaryColor]);

  // Fetch graph nodes when the toggle is turned on
  useEffect(() => {
    if (showGraphNodes && activeGraph && graphNodes.length === 0) {
      sendMessage('GET_GRAPH_NODES', {});
    }
  }, [showGraphNodes, activeGraph, graphNodes.length, sendMessage]);

  // Reset bounds only when the user switches shape type while already creating.
  // Keep a restored last-submitted shape when entering graphCreate.
  useEffect(() => {
    if (mode !== 'graphCreate') return;
    setGraphBounds((prev) => {
      if (!prev) return prev;
      if (prev.type === graphCreateMode) return prev;
      return null;
    });
  }, [graphCreateMode, mode]);

  return (
    <div className="app">
      <MapView
        mode={mode}
        activeTool={activeTool || (isDrawingExclusion ? 'lasso' : null)}
        // isExcludeMode passed below merged with isDrawingExclusion
        wsStatus={wsStatus}
        pendingMarker={pendingMarker}
        pathSetMarkers={pathSetMarkers}
        activePathSetId={activePathSetId}
        currentPath={currentPath}
        filteredPaths={filteredPaths}
        drawnSelections={drawnSelections}
        onMapClick={handleMapClick}
        onMarkerClick={handleMarkerClick}
        onDrawingComplete={handleDrawingComplete}
        graphBounds={graphBounds}
        onGraphBoundsChange={handleGraphBoundsChange}
        graphCreateMode={graphCreateMode}
        graphBoundaries={graphBoundaries}
        activeGraph={activeGraph}
        pathUndoRef={pathUndoRef}
        showArrows={showArrows}
        showCentroids={showCentroids}
        primaryColor={primaryColor}
        hoveredPoint={hoveredPoint}
        onHover={setHoveredPoint}
        showPathPreview={showPathPreview}
        pathPreviewOpacity={pathPreviewOpacity}
        showGraphBoundary={showGraphBoundary}
        showGraphNodes={showGraphNodes}
        graphNodes={graphNodes}

        // Exclusion / Drawing props
        exclusionZones={exclusionZones}
        // Merge exclude mode logic: True if user toggled exclude mode OR if drawing an exclusion zone
        isExcludeMode={isExcludeMode || isDrawingExclusion}
      />

      <ControlPanel
        mode={mode}
        setMode={setMode}
        currentPath={currentPath}
        currentPathIndex={currentPathIndex}
        filteredPathsCount={filteredPaths.length}
        totalPathsCount={activePathSet?.paths?.length || 0}
        distanceRange={distanceRange}
        setDistanceRange={setDistanceRange}
        difficultyRange={difficultyRange}
        setDifficultyRange={setDifficultyRange}
        sortBy={sortBy}
        setSortBy={setSortBy}
        sortAscending={sortAscending}
        setSortAscending={setSortAscending}
        onNextPath={nextPath}
        onPrevPath={prevPath}
        onJumpPath={jumpPath}
        onGoToFirst={goToFirst}
        onGoToLast={goToLast}
        hasActivePathSet={!!activePathSetId}
        setActiveTool={setActiveTool}
        isExcludeMode={isExcludeMode}
        setIsExcludeMode={setIsExcludeMode}
        onUndo={undoLastSelection}
        genSettings={genSettings}
        setGenSettings={setGenSettings}
        graphs={graphs}
        activeGraph={activeGraph}
        onSwitchGraph={handleSwitchGraph}
        onStartGraphCreate={handleStartGraphCreate}
        // Graph Create Props
        isGraphCreateMode={mode === 'graphCreate'}
        graphCreateMode={graphCreateMode}
        setGraphCreateMode={setGraphCreateMode}
        graphBounds={graphBounds}
        onCreateGraph={handleCreateGraph}
        isCreatingGraph={isCreatingGraph}
        // Exclusion props
        exclusionZones={exclusionZones}
        setExclusionZones={setExclusionZones}
        isDrawingExclusion={isDrawingExclusion}
        setIsDrawingExclusion={setIsDrawingExclusion}
        showArrows={showArrows}
        setShowArrows={setShowArrows}
        showPathPreview={showPathPreview}
        setShowPathPreview={setShowPathPreview}
        pathPreviewOpacity={pathPreviewOpacity}
        setPathPreviewOpacity={setPathPreviewOpacity}
        showCentroids={showCentroids}
        setShowCentroids={setShowCentroids}
        showGraphBoundary={showGraphBoundary}
        setShowGraphBoundary={setShowGraphBoundary}
        showGraphNodes={showGraphNodes}
        setShowGraphNodes={setShowGraphNodes}

        primaryColor={primaryColor}
        setPrimaryColor={setPrimaryColor}
      />

      {/* Elevation Window & Toggle */}
      {currentPath?.properties?.elevation_profile?.length > 1 && (
        <>
          {/* Minimized toggle button */}
          {isElevationMinimized && (
            <button
              className="elevation-toggle-btn"
              onClick={() => setIsElevationMinimized(false)}
            >
              Show Elevation Profile
              <Activity size={16} />
            </button>
          )}

          {/* Key listener for Toggle is already in handleKeyDown ('e') */}

          {/* Main Window */}
          {!isElevationMinimized && <ElevationProfileWindow
            elevationProfile={currentPath.properties.elevation_profile}
            onClose={() => setIsElevationMinimized(true)}
            hoveredPoint={hoveredPoint}
            onHover={setHoveredPoint}
            onFlipPath={reverseCurrentPathProfile}
          />}
        </>
      )}
    </div>
  );
}

export default App;
