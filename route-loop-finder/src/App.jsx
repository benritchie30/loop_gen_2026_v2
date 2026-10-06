import { useEffect, useCallback, useState, useRef } from 'react';
import { Activity } from 'lucide-react';
import './App.css';

import { MapView } from './components/MapView';
import { ControlPanel } from './components/ControlPanel';
import ElevationProfileWindow from './components/ElevationProfileWindow';
import { useWebSocket } from './hooks/useWebSocket';
import { usePathSets } from './hooks/usePathSets';
import { normalizeRoadWeights, DEFAULT_ROAD_WEIGHTS } from './utils/roadWeights';
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

const VIEW_OPTION_DEFAULTS = {
  showArrows: true,
  showCentroids: false,
  primaryColor: '215',
  showPathPreview: true,
  pathPreviewOpacity: 0.5,
  showGraphBoundary: false,
  showGraphNodes: false,
};

function readViewOptions() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem('viewOptions') || '{}') || {};
  } catch {
    saved = {};
  }
  const opacity = Number(saved.pathPreviewOpacity);
  const hue = Number(saved.primaryColor ?? localStorage.getItem('primaryColor') ?? VIEW_OPTION_DEFAULTS.primaryColor);
  const flag = (key) => (
    typeof saved[key] === 'boolean' ? saved[key] : VIEW_OPTION_DEFAULTS[key]
  );
  return {
    showArrows: flag('showArrows'),
    showCentroids: flag('showCentroids'),
    showPathPreview: flag('showPathPreview'),
    showGraphBoundary: flag('showGraphBoundary'),
    showGraphNodes: flag('showGraphNodes'),
    pathPreviewOpacity: Number.isFinite(opacity)
      ? Math.min(1, Math.max(0.1, opacity))
      : VIEW_OPTION_DEFAULTS.pathPreviewOpacity,
    primaryColor: Number.isFinite(hue)
      ? String(Math.min(360, Math.max(0, Math.round(hue))))
      : VIEW_OPTION_DEFAULTS.primaryColor,
  };
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
    pathSets,
    pathSetMarkers,
    activePathSetId,
    activePathSet,
    currentPath,
    currentPathIndex,
    filteredPaths,
    routeFilters,
    filterBounds,
    sortBy,
    sortAscending,
    drawnSelections,
    createPathSet,
    addPathToSet,
    completePathSet,
    selectPathSet,
    addDrawnSelection,
    setFilterRange,
    addRouteFilter,
    removeRouteFilter,
    setSortBy,
    setSortAscending,
    nextPath,
    prevPath,
    goToPath,
    jumpPath,
    goToFirst,
    goToLast,
    reverseCurrentPathProfile,
    undoLastSelection,
    removeSelection
  } = usePathSets();

  const {
    mode,
    setMode,
    pendingMarker,
    setMarkerPosition
  } = useAppMode();

  // Local state for tools. null means pan.
  const [activeTool, setActiveTool] = useState(null);
  const [isExcludeMode, setIsExcludeMode] = useState(false);
  const [isElevationMinimized, setIsElevationMinimized] = useState(false);
  const [hoveredPoint, setHoveredPoint] = useState(null);
  const draftingRef = useRef(null);

  const [viewOptions, setViewOptions] = useState(readViewOptions);
  const {
    showArrows,
    showCentroids,
    primaryColor,
    showPathPreview,
    pathPreviewOpacity,
    showGraphBoundary,
    showGraphNodes,
  } = viewOptions;
  const setViewOption = (key, value) => {
    setViewOptions((prev) => ({ ...prev, [key]: value }));
  };
  const setShowArrows = (value) => setViewOption('showArrows', value);
  const setShowCentroids = (value) => setViewOption('showCentroids', value);
  const setPrimaryColor = (value) => setViewOption('primaryColor', String(value));
  const setShowPathPreview = (value) => setViewOption('showPathPreview', value);
  const setPathPreviewOpacity = (value) => setViewOption('pathPreviewOpacity', value);
  const setShowGraphBoundary = (value) => setViewOption('showGraphBoundary', value);
  const setShowGraphNodes = (value) => setViewOption('showGraphNodes', value);
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
  const [algorithms, setAlgorithms] = useState([
    { id: 'turns', label: 'Turns-first (baseline)' },
    { id: 'turns_pruned', label: 'Turns-first + self-cross prune + A*' },
    { id: 'turns_capped', label: 'Turns-first + capped state space' },
    { id: 'pleasant_capped', label: 'Pleasant roads (capped)' },
    { id: 'discomfort_capped', label: 'Pleasant, ignore turns (capped)' },
    { id: 'distance_capped', label: 'Distance only (capped)' },
    { id: 'pleasant_explore', label: 'Pleasant + explore new areas (capped)' },
    { id: 'tree_loops', label: 'Area sweep (best-route trees)' },
  ]);

  const generatingPathSetId = Object.keys(pathSets).find(id => !pathSets[id].isComplete) || null;
  const isGenerating = generatingPathSetId !== null;
  const generatingPathCount = isGenerating ? pathSets[generatingPathSetId].paths.length : 0;

  const handleStopGeneration = useCallback(() => {
    sendMessage('STOP_GENERATION', {});
  }, [sendMessage]);

  // The server can't send GENERATION_COMPLETE after the socket drops
  useEffect(() => {
    if (wsStatus === 'connected') return;
    Object.keys(pathSets).forEach(id => {
      if (!pathSets[id].isComplete) completePathSet(id);
    });
  }, [wsStatus, pathSets, completePathSet]);

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

        case 'ALGORITHMS_LIST':
          if (Array.isArray(message.algorithms) && message.algorithms.length > 0) {
            setAlgorithms(message.algorithms);
          }
          break;

        default:
          console.log('[App] Unknown message type:', message.type);
      }
    });

    return unsubscribe;
  }, [subscribe, createPathSet, addPathToSet, completePathSet, setMode]);

  // Handle map click (in input mode)
  const handleMapClick = useCallback((position) => {
    setMarkerPosition(position);
  }, [setMarkerPosition]);

  // Handle marker click to select a path set
  const handleMarkerClick = useCallback((pathSetId) => {
    selectPathSet(pathSetId);
    setMode('display');
  }, [selectPathSet, setMode]);

  const handleSelection = useCallback((selection) => {
    addDrawnSelection(selection);
    setActiveTool(null);
  }, [addDrawnSelection]);

  // Graph-creation exclusion zones stay local. Route filters never ask the backend.
  const handleDrawingComplete = useCallback((coordinates, _tool, _exclude) => {
    if (!isDrawingExclusion || coordinates.length <= 2) return;
    setExclusionZones(prev => [...prev, coordinates]);
  }, [isDrawingExclusion]);

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
    const defaults = {
      min_path_len: 15,
      max_path_len: 40,
      loop_ratio: 0.5,
      sim_ceiling: 0.7,
      num_paths: 30,
      algorithm: 'pleasant_capped',
      deduplication: 'centroid',
      min_dist_m: 50,
      cap_k: 3,
      explore_weight: null,
      detour_weight: null,
      reuse_weight: null,
      debug_snapshots: false,
      snapshot_every: 25000,
      road_weights: { ...DEFAULT_ROAD_WEIGHTS },
      road_weight_preset: 'current',
      rural_scale: true,
    };
    try {
      const saved = localStorage.getItem('generatorSettings');
      if (!saved) return defaults;
      const parsed = JSON.parse(saved);
      const legacy = { scenic: 'turns', direct: 'turns', turn: 'turns' };
      if (legacy[parsed.algorithm]) {
        parsed.algorithm = legacy[parsed.algorithm];
      }
      parsed.road_weights = normalizeRoadWeights(parsed.road_weights);
      if (typeof parsed.rural_scale !== 'boolean') parsed.rural_scale = true;
      return { ...defaults, ...parsed, road_weights: parsed.road_weights };
    } catch {
      return defaults;
    }
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
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) {
        if (!(e.key === 'Enter' && tag === 'INPUT')) return;
      }

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
        if (e.key === 'Escape') {
          if (draftingRef.current?.()) return;
          if (activeTool) {
            setActiveTool(null);
            return;
          }
          if (isGenerating) handleStopGeneration();
        }

        // Backspace: Return to Input Mode
        if (e.key === 'Backspace') {
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

        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          const toolKeys = { c: 'circle', b: 'box', f: 'freeform' };
          const tool = toolKeys[e.key.toLowerCase()];
          if (tool) {
            setActiveTool(activeTool === tool ? null : tool);
          }
          if (e.key === 'k' || e.key === 'K') {
            setActiveTool(null);
          }
          if (e.key === 'z' || e.key === 'Z') {
            undoLastSelection();
          }
          if (e.key === 'd' || e.key === 'D') {
            setIsExcludeMode(prev => !prev);
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [mode, pendingMarker, sendMessage, selectPathSet, setMode, undoLastSelection, genSettings, graphBounds, isCreatingGraph, nextPath, prevPath, activeTool, setIsElevationMinimized, graphCreateMode, handleCreateGraph, exclusionZones, setIsDrawingExclusion, isGenerating, handleStopGeneration]);

  // Auto-show elevation window when path with elevation data is selected
  // Auto-show elevation window when path with elevation data is selected
  useEffect(() => {
    // If we have a path with elevation data, ensure we are not in minimized state unless user explicitly minimized
    // But since we want persistent minimization, we actually don't want to force it open every time the path changes
    // if the user minimized it.
    // So we just don't do anything here. The window shows if !isElevationMinimized and data exists.
  }, [currentPath]);

  useEffect(() => {
    localStorage.setItem('viewOptions', JSON.stringify(viewOptions));
    localStorage.setItem('primaryColor', viewOptions.primaryColor);
  }, [viewOptions]);

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
        activeTool={mode === 'graphCreate' && isDrawingExclusion ? 'freeform' : activeTool}
        exclusionDraw={mode === 'graphCreate' && isDrawingExclusion}
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
        onSelection={handleSelection}
        onRemoveSelection={removeSelection}
        draftingRef={draftingRef}
        graphBounds={graphBounds}
        onGraphBoundsChange={handleGraphBoundsChange}
        graphCreateMode={graphCreateMode}
        graphBoundaries={graphBoundaries}
        activeGraph={activeGraph}
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
        isGenerating={isGenerating}
        generatingPathCount={generatingPathCount}
        onStopGeneration={handleStopGeneration}

        // Exclusion / Drawing props
        exclusionZones={exclusionZones}
        // Merge exclude mode logic: True if user toggled exclude mode OR if drawing an exclusion zone
        isExcludeMode={isExcludeMode || (mode === 'graphCreate' && isDrawingExclusion)}
      />

      <ControlPanel
        mode={mode}
        setMode={setMode}
        currentPath={currentPath}
        currentPathIndex={currentPathIndex}
        filteredPathsCount={filteredPaths.length}
        totalPathsCount={activePathSet?.paths?.length || 0}
        routeFilters={routeFilters}
        filterBounds={filterBounds}
        setFilterRange={setFilterRange}
        addRouteFilter={addRouteFilter}
        removeRouteFilter={removeRouteFilter}
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
        activeTool={activeTool}
        setActiveTool={setActiveTool}
        isExcludeMode={isExcludeMode}
        setIsExcludeMode={setIsExcludeMode}
        onUndo={undoLastSelection}
        genSettings={genSettings}
        setGenSettings={setGenSettings}
        algorithms={algorithms}
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
