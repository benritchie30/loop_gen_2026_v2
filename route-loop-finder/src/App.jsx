import { useEffect, useCallback, useState, useRef, useMemo } from 'react';
import { Activity } from 'lucide-react';
import './App.css';

import { MapView } from './components/MapView';
import { ControlPanel } from './components/ControlPanel';
import ElevationProfileWindow from './components/ElevationProfileWindow';
import { useWebSocket } from './hooks/useWebSocket';
import { useAppMode } from './hooks/useAppMode';
import { usePathSets, suggestGenerationName } from './hooks/usePathSets';
import { useFavorites } from './hooks/useFavorites';
import { useFavoritesView } from './hooks/useFavoritesView';
import { applyPaint } from './utils/paintRoads';
import { normalizeRoadWeights } from './utils/roadWeights';
import { buildRoadIndex, edgeKey } from './utils/graphRoads';
import { tilesInBounds } from './utils/mapTiles';
import { mapProgressText, nextProgress } from './utils/mapProgress';
import { MAX_ROUTE_MILES, UnitsContext, readUnits } from './utils/units';
import { placeNameAt } from './utils/geocode';
import { setsAtStart } from './utils/pathSetGroups';
import { routeKey } from './utils/routeIdentity';
import { boundaryBounds, boundaryContains, boundaryKey, boundaryPayload, cleanShapes, simplifyOutline } from './utils/boundary';
import { useBoundaries } from './hooks/useBoundaries';

/** What the server needs from a selection (geometry for roads is re-derived from node pairs). */
function selectionPayload(selection) {
  return {
    id: selection.id,
    type: selection.type,
    shape: selection.shape,
    lat: selection.lat,
    lng: selection.lng,
    radiusM: selection.radiusM,
    north: selection.north,
    south: selection.south,
    east: selection.east,
    west: selection.west,
    coordinates: selection.coordinates,
    edges: selection.edges,
  };
}

/** Selections to send: an excluded area whose roads were all turned back on constrains nothing. */
function selectionsPayload(selections) {
  return (selections || [])
    .filter((s) => s.shape !== 'edges' || (s.edges || []).length > 0)
    .map(selectionPayload);
}

const DEFAULT_ALGORITHM_OPTION = { id: 'tree_guided', label: 'Area sweep', resumable: true };
// Every strategy the server has (dev ones only listed with LOOP_DEV=1).
const AREA_SWEEP_IDS = ['tree_guided', 'tree_loops', 'tree_cover', 'tree_triangles', 'loop_atlas'];
// Saved settings of search options that were removed.
const REMOVED_SETTINGS = ['sim_ceiling', 'deduplication', 'cap_k', 'debug_snapshots', 'snapshot_every'];
// Route length the slider allows, in miles (up to the server's limit).
const LENGTH_LIMITS_MI = [0.6, MAX_ROUTE_MILES];
const UNDO_MS = 7000;
const EDGE_SETS_KEPT = 4; // road layers of recent areas kept in the browser
const TILE_ROADS_KEPT = 80; // offline basemap: roads of this many map tiles kept in the browser
const SEGMENT_TILES_KEPT = 40; // Favorites tab: road pieces of this many map tiles kept for painting

const SETTING_DEFAULTS = {
  min_path_len: 15,
  max_path_len: 30,
  loop_ratio: 0.5,
  num_paths: 20,
  routes_per_pin: 10,
  more_algorithm: DEFAULT_ALGORITHM_OPTION.id,
  algorithm: DEFAULT_ALGORITHM_OPTION.id,
  min_dist_m: 50,
  explore_weight: null,
  detour_weight: null,
  reuse_weight: null,
  road_preference: 'balanced', // quiet | balanced | any | custom (road_weights)
  road_weights: null,
  rural_scale: true,
  boundary: null, // custom search boundary { id, name, shapes } (utils/boundary.js); null: automatic
};

function readSettings() {
  try {
    const saved = localStorage.getItem('generatorSettings');
    if (!saved) return { ...SETTING_DEFAULTS };
    const parsed = JSON.parse(saved);
    REMOVED_SETTINGS.forEach((key) => { delete parsed[key]; });
    if (!AREA_SWEEP_IDS.includes(parsed.algorithm)) parsed.algorithm = DEFAULT_ALGORITHM_OPTION.id;
    if (!AREA_SWEEP_IDS.includes(parsed.more_algorithm)) parsed.more_algorithm = parsed.algorithm;
    // Old road presets: the built-in table is Balanced; anything tuned stays as custom weights.
    if (!parsed.road_preference) {
      const preset = parsed.road_weight_preset;
      parsed.road_preference = !preset || preset === 'current' ? 'balanced' : 'custom';
    }
    delete parsed.road_weight_preset;
    parsed.road_weights = parsed.road_preference === 'custom' ? normalizeRoadWeights(parsed.road_weights) : null;
    if (typeof parsed.rural_scale !== 'boolean') parsed.rural_scale = true;
    parsed.boundary = parsed.boundary && cleanShapes(parsed.boundary.shapes).length
      ? { ...parsed.boundary, shapes: cleanShapes(parsed.boundary.shapes) }
      : null;
    const clamp = (v, d) => Math.min(LENGTH_LIMITS_MI[1], Math.max(LENGTH_LIMITS_MI[0], Number(v) || d));
    const lo = clamp(parsed.min_path_len, SETTING_DEFAULTS.min_path_len);
    const hi = clamp(parsed.max_path_len, SETTING_DEFAULTS.max_path_len);
    parsed.min_path_len = Math.min(lo, hi);
    parsed.max_path_len = Math.max(lo, hi);
    return { ...SETTING_DEFAULTS, ...parsed };
  } catch {
    return { ...SETTING_DEFAULTS };
  }
}

const VIEW_OPTION_DEFAULTS = {
  showArrows: true,
  showCentroids: false,
  primaryColor: '215',
  showPathPreview: true,
  pathPreviewOpacity: 0.5,
  showGraphRoads: true,
  showSelections: true, // painted roads and areas on the map (always while a tool is active)
  showBoundary: true, // an open generation's custom search boundary (grey, dotted)
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
  const flag = (key) => (typeof saved[key] === 'boolean' ? saved[key] : VIEW_OPTION_DEFAULTS[key]);
  return {
    showArrows: flag('showArrows'),
    showCentroids: flag('showCentroids'),
    showPathPreview: flag('showPathPreview'),
    showGraphRoads: flag('showGraphRoads'),
    showSelections: flag('showSelections'),
    showBoundary: flag('showBoundary'),
    pathPreviewOpacity: Number.isFinite(opacity)
      ? Math.min(1, Math.max(0.1, opacity))
      : VIEW_OPTION_DEFAULTS.pathPreviewOpacity,
    primaryColor: Number.isFinite(hue)
      ? String(Math.min(360, Math.max(0, Math.round(hue))))
      : VIEW_OPTION_DEFAULTS.primaryColor,
  };
}

/** Same pin? Prefetch messages carry the pin they were asked for. */
function samePin(a, b) {
  return !!a && !!b && Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9;
}

/** A prefetch message for the pin's current request (its max and boundary: `token`)? */
function forPinArea(area, message) {
  return samePin(area, message) && (message.token == null || message.token === area.token);
}

/** The search settings a request carries (custom road weights only when Roads is Custom). */
function requestSettings(settings) {
  return {
    ...settings,
    road_weights: settings.road_preference === 'custom' ? settings.road_weights : null,
  };
}

/** The favorite colour's hue: the theme colour's complement. */
function favoriteHueOf(primaryHue) {
  return (Math.round(Number(primaryHue) || 0) + 180) % 360;
}

function App() {
  const { status: wsStatus, sendMessage, subscribe } = useWebSocket();
  const { favorites, isFavorite, toggleFavorite } = useFavorites();

  const {
    pathSets,
    activePathSetId,
    activePathSet,
    currentPath,
    filteredPaths,
    totalPathsCount,
    generations,
    routeFilters,
    filterBounds,
    sortBy,
    sortAscending,
    drawnSelections,
    pathSetMarkers,
    hoveredPathId,
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
    favoritesOnly,
    showFavoritesOnly,
    keepListed,
  } = usePathSets({ favorites });

  const { mode, setMode, pendingMarker, setMarkerPosition, placeMarker, clearPendingMarker } = useAppMode();
  const pendingMarkerRef = useRef(pendingMarker); // the pin now (server messages compare against it)
  pendingMarkerRef.current = pendingMarker;

  // Tools: null is pan.
  const [activeTool, setActiveTool] = useState(null);
  const [isExcludeMode, setIsExcludeMode] = useState(false);
  const [isElevationMinimized, setIsElevationMinimized] = useState(false);
  const draftingRef = useRef(null);
  const boundaryDraftingRef = useRef(null); // a shape being dragged in the boundary editor (Esc cancels it)
  const pendingGenerations = useRef([]);

  // ---- map display options ----
  const [viewOptions, setViewOptions] = useState(readViewOptions);
  const setViewOption = useCallback((key, value) => {
    setViewOptions((prev) => ({ ...prev, [key]: value }));
  }, []);
  const { showArrows, showCentroids, primaryColor, showPathPreview, pathPreviewOpacity, showGraphRoads, showSelections,
    showBoundary } = viewOptions;
  useEffect(() => {
    localStorage.setItem('viewOptions', JSON.stringify(viewOptions));
    localStorage.setItem('primaryColor', viewOptions.primaryColor);
  }, [viewOptions]);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--color-primary', `hsl(${primaryColor}, 65%, 50%)`);
    root.style.setProperty('--color-primary-light', `hsl(${primaryColor}, 65%, 90%)`);
    root.style.setProperty('--color-primary-dark', `hsl(${primaryColor}, 65%, 40%)`);
    root.style.setProperty('--color-accent', `hsl(${primaryColor}, 70%, 60%)`);
    root.style.setProperty('--path-active', `hsl(${primaryColor}, 65%, 30%)`);
    root.style.setProperty('--marker-pending', `hsl(${primaryColor}, 65%, 50%)`);
    const fav = favoriteHueOf(primaryColor);
    root.style.setProperty('--color-favorite', `hsl(${fav}, 75%, 45%)`);
    root.style.setProperty('--color-favorite-light', `hsl(${fav}, 80%, 93%)`);
  }, [primaryColor]);

  // ---- settings, units ----
  const [genSettings, setGenSettings] = useState(readSettings);
  useEffect(() => {
    localStorage.setItem('generatorSettings', JSON.stringify(genSettings));
  }, [genSettings]);
  const [units, setUnitsState] = useState(readUnits);
  const setUnits = useCallback((value) => {
    setUnitsState(value);
    localStorage.setItem('units', value);
  }, []);

  // The server sends the real list (only Area sweep unless it runs with LOOP_DEV=1).
  const [algorithms, setAlgorithms] = useState([DEFAULT_ALGORITHM_OPTION]);
  const pickAlgorithm = useCallback(
    (id) => (algorithms.some((item) => item.id === id) ? id : algorithms[0].id),
    [algorithms],
  );

  // Short map notice (pin snapped / rejected, batch notes). A new id re-shows the same text.
  const [notice, setNotice] = useState(null);
  const showNotice = useCallback((text) => {
    if (text) setNotice({ text, id: Date.now() });
  }, []);

  // ---- map areas ----
  // The server downloads map data and builds a search graph per start pin and
  // generation ("area"). pinArea follows the pin being placed (PREFETCH_AREA);
  // each generation's area comes with AREA_READY {pathSetId}.
  const [pinArea, setPinArea] = useState(null); // { lat, lng, status, done, total, mb, areaId, error }
  const [areaOfPathSet, setAreaOfPathSet] = useState({}); // pathSetId -> areaId
  const [genMapStatus, setGenMapStatus] = useState({}); // pathSetId -> { phase, done, total, mb }
  const [edgeSets, setEdgeSets] = useState({}); // areaId -> road lines
  const edgesRequested = useRef(new Set());
  const openRequested = useRef(new Set());

  // Offline basemap: which map tiles are downloaded (MAP_INFO) and their roads (TILE_ROADS).
  const [mapCoverage, setMapCoverage] = useState(null); // { deg, tiles }
  const [tileRoads, setTileRoads] = useState({}); // "row_col" -> lines
  const tilesRequested = useRef(new Set());

  // Area ids belong to one server run: forget them whenever the connection drops.
  const [connection, setConnection] = useState(0);
  useEffect(() => {
    if (wsStatus !== 'connected') return;
    setConnection((n) => n + 1);
    setAreaOfPathSet({});
    edgesRequested.current = new Set();
    openRequested.current = new Set();
    tilesRequested.current = new Set();
    segmentsRequested.current = new Set();
  }, [wsStatus]);

  // Road pieces straight from map tiles (GET_ROAD_SEGMENTS): the Favorites
  // tab paints roads with them, with no start pin or area needed.
  const [roadSegments, setRoadSegments] = useState({}); // "row_col" -> [{u, v, name, pts}]
  const segmentsRequested = useRef(new Set());
  const requestRoadSegments = useCallback((tiles) => {
    const wanted = tiles.filter(([r, c]) => !segmentsRequested.current.has(`${r}_${c}`));
    if (!wanted.length) return;
    if (sendMessage('GET_ROAD_SEGMENTS', { tiles: wanted })) {
      wanted.forEach(([r, c]) => segmentsRequested.current.add(`${r}_${c}`));
    }
  }, [sendMessage]);

  const requestTileRoads = useCallback((tiles) => {
    const wanted = tiles.filter(([r, c]) => !tilesRequested.current.has(`${r}_${c}`));
    if (!wanted.length) return;
    if (sendMessage('GET_TILE_ROADS', { tiles: wanted })) {
      wanted.forEach(([r, c]) => tilesRequested.current.add(`${r}_${c}`));
    }
  }, [sendMessage]);

  const wantedAreaId = mode === 'display'
    ? (activePathSetId ? areaOfPathSet[activePathSetId] || null : null)
    : (pendingMarker && samePin(pinArea, pendingMarker) && pinArea?.status === 'ready' ? pinArea.areaId : null);
  const requestGraphEdges = useCallback(() => {
    if (!wantedAreaId || edgeSets[wantedAreaId] || edgesRequested.current.has(wantedAreaId)) return;
    if (sendMessage('GET_GRAPH_EDGES', { areaId: wantedAreaId })) edgesRequested.current.add(wantedAreaId);
  }, [wantedAreaId, edgeSets, sendMessage]);
  useEffect(() => {
    if (wsStatus === 'connected') requestGraphEdges();
  }, [wsStatus, requestGraphEdges]);
  const wantedLines = wantedAreaId ? edgeSets[wantedAreaId] : null;
  const roadIndex = useMemo(() => (wantedLines?.length ? buildRoadIndex(wantedLines) : null), [wantedLines]);

  // ---- generations ----
  const activeGeneration = generations.find((g) => g.id === activePathSetId) || null;
  const generatingPathSetId = Object.keys(pathSets).find((id) => !pathSets[id].isComplete) || null;
  const isGenerating = generatingPathSetId !== null;
  const generatingPathCount = isGenerating ? pathSets[generatingPathSetId].paths.length : 0;
  const activeIsGenerating = !!activePathSet && !activePathSet.isComplete;
  const canContinue = mode === 'display' && !!activeGeneration && activeGeneration.resumable;

  /** What the server needs to recreate a generation it no longer holds. */
  const rebuildFor = useCallback((id) => {
    const set = pathSets[id];
    if (!set?.markerPosition) return null;
    return {
      lat: set.markerPosition.lat,
      lng: set.markerPosition.lng,
      settings: requestSettings(set.settings || {}),
      centroids: set.paths.map((p) => p.properties?.centroid).filter(Boolean),
      batches: set.batches || 0,
    };
  }, [pathSets]);

  // An open generation whose area this server run has not sent yet (reload,
  // restart): ask for it, so roads can be painted and More routes is quick.
  useEffect(() => {
    if (wsStatus !== 'connected' || mode !== 'display' || !activePathSetId) return;
    if (areaOfPathSet[activePathSetId] || openRequested.current.has(activePathSetId)) return;
    if (activeIsGenerating) return; // its own messages bring the area
    const rebuild = rebuildFor(activePathSetId);
    if (sendMessage('OPEN_GENERATION', { pathSetId: activePathSetId, rebuild })) {
      openRequested.current.add(activePathSetId);
    }
  }, [wsStatus, mode, activePathSetId, areaOfPathSet, activeIsGenerating, rebuildFor, sendMessage, connection]);

  const handleStopGeneration = useCallback(() => {
    sendMessage('STOP_GENERATION', {});
  }, [sendMessage]);

  // The server can't send GENERATION_COMPLETE after the socket drops.
  useEffect(() => {
    if (wsStatus === 'connected') return;
    Object.keys(pathSets).forEach((id) => {
      if (!pathSets[id].isComplete) completePathSet(id);
    });
  }, [wsStatus, pathSets, completePathSet]);

  const clearGenStatus = useCallback((id) => {
    setGenMapStatus((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  // ---- server messages ----
  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      switch (message.type) {
        case 'PATHSET_CREATED':
          createPathSet(message.pathSetId, message.markerPosition, pendingGenerations.current.shift() || null);
          // The generation's pin takes the start pin's place.
          clearPendingMarker();
          setMode('display');
          break;

        case 'PATH_RECEIVED':
          addPathToSet(message.pathSetId, message.path);
          break;

        case 'GENERATION_COMPLETE':
          completePathSet(message.pathSetId, { resumable: message.resumable, note: message.note });
          clearGenStatus(message.pathSetId);
          if (message.note) showNotice(message.note);
          else if (message.added === 0 && !message.stopped) showNotice('No new routes found');
          break;

        case 'GENERATION_RESUMED':
          resumePathSet(message.pathSetId);
          break;

        // Pins snapped onto roads by the server; selections that hit no road are dropped.
        case 'CONSTRAINTS_RESOLVED':
          (message.results || []).forEach((result) => {
            if (result.ok) {
              const patch = { pending: false };
              if (result.lat != null && result.lng != null) {
                patch.lat = result.lat;
                patch.lng = result.lng;
              }
              updateSelection(result.id, patch);
            } else {
              removeSelection(result.id);
              showNotice(result.error || 'No road here');
            }
          });
          break;

        case 'GENERATION_ERROR':
          if (message.code === 'SESSION_EXPIRED' && message.pathSetId) expirePathSetSession(message.pathSetId);
          showNotice(message.error || 'Generation failed');
          break;

        case 'MAP_PROGRESS':
          if (message.pathSetId) {
            setGenMapStatus((prev) => ({
              ...prev,
              [message.pathSetId]: nextProgress(prev[message.pathSetId], message),
            }));
          } else if (message.scope === 'prefetch') {
            setPinArea((prev) => (forPinArea(prev, message) ? nextProgress(prev, message, { status: message.phase }) : prev));
          }
          break;

        case 'AREA_READY':
          if (message.pathSetId) {
            setAreaOfPathSet((prev) => ({ ...prev, [message.pathSetId]: message.areaId }));
            clearGenStatus(message.pathSetId);
          } else {
            // The start pin moves onto the start the server found (the nearest
            // road that loops can start from), so it shows where routes begin.
            // Asked again from there, the server answers from the same area.
            const { start } = message;
            const current = message.token == null || message.token === prefetchTokenRef.current;
            const snap = current && samePin(pendingMarkerRef.current, message) && start
              && Number.isFinite(start.lat) && Number.isFinite(start.lng) && !samePin(start, message);
            setPinArea((prev) => (forPinArea(prev, message)
              ? {
                ...prev,
                status: 'ready',
                areaId: message.areaId,
                error: null,
                ...(snap ? { lat: start.lat, lng: start.lng } : {}),
              }
              : prev));
            if (snap) placeMarker({ lat: start.lat, lng: start.lng });
          }
          break;

        case 'MAP_ERROR':
          setPinArea((prev) => (forPinArea(prev, message) ? { ...prev, status: 'error', error: message.error } : prev));
          break;

        case 'GRAPH_EDGES':
          if (!message.areaId || !(message.lines || []).length) break;
          setEdgeSets((prev) => {
            const kept = Object.keys(prev).filter((id) => id !== message.areaId).slice(-(EDGE_SETS_KEPT - 1));
            const next = {};
            kept.forEach((id) => { next[id] = prev[id]; });
            next[message.areaId] = message.lines;
            return next;
          });
          break;

        case 'ALGORITHMS_LIST':
          if (Array.isArray(message.algorithms) && message.algorithms.length > 0) setAlgorithms(message.algorithms);
          break;

        case 'MAP_INFO':
          if (Array.isArray(message.coverage)) {
            setMapCoverage({ deg: message.tileDeg || 0.1, tiles: message.coverage });
          }
          break;

        case 'ROAD_SEGMENTS': {
          if (!Array.isArray(message.tile)) break;
          const key = `${message.tile[0]}_${message.tile[1]}`;
          setRoadSegments((prev) => {
            const keys = Object.keys(prev).filter((k) => k !== key);
            const keep = keys.slice(-(SEGMENT_TILES_KEPT - 1));
            keys.slice(0, keys.length - keep.length).forEach((k) => segmentsRequested.current.delete(k));
            const next = {};
            keep.forEach((k) => { next[k] = prev[k]; });
            next[key] = message.lines || [];
            return next;
          });
          break;
        }

        case 'TILE_ROADS': {
          if (!Array.isArray(message.tile)) break;
          const key = `${message.tile[0]}_${message.tile[1]}`;
          setTileRoads((prev) => {
            const keys = Object.keys(prev).filter((k) => k !== key);
            const keep = keys.slice(-(TILE_ROADS_KEPT - 1));
            // Tiles dropped from the cache may be asked for again.
            keys.slice(0, keys.length - keep.length).forEach((k) => tilesRequested.current.delete(k));
            const next = {};
            keep.forEach((k) => { next[k] = prev[k]; });
            next[key] = message.lines || [];
            return next;
          });
          break;
        }

        default:
          console.log('[App] Unknown message type:', message.type);
      }
    });
    return unsubscribe;
  }, [subscribe, createPathSet, addPathToSet, completePathSet, resumePathSet, expirePathSetSession,
    updateSelection, removeSelection, showNotice, setMode, clearPendingMarker, placeMarker, clearGenStatus]);

  // ---- start pin ----
  const handleMapClick = useCallback((position) => setMarkerPosition(position), [setMarkerPosition]);

  // A short place name for the start pin: from the search result, else looked
  // up (Photon reverse geocoding) a moment after the pin stops moving.
  const [pinPlace, setPinPlace] = useState(null); // { lat, lng, name }
  const pinName = pendingMarker && samePin(pinPlace, pendingMarker) ? pinPlace.name : null;
  useEffect(() => {
    if (!pendingMarker || samePin(pinPlace, pendingMarker)) return undefined;
    const { lat, lng } = pendingMarker;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const name = await placeNameAt(lat, lng, controller.signal);
        setPinPlace({ lat, lng, name });
      } catch {
        // Offline or blocked: generations fall back to coordinates.
      }
    }, 700);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [pendingMarker, pinPlace]);

  // Placing or moving the start pin (or changing the max distance) downloads
  // that area's map in the background and builds its roads, so generating
  // can start at once. The server cancels queued downloads for an old pin.
  // With a custom boundary the area is the roads inside it; the request's
  // token (max and boundary) tells its answers from an earlier request's.
  const prefetchMax = Number(genSettings.max_path_len) || 0;
  const planBoundary = boundaryPayload(genSettings.boundary);
  const prefetchToken = `${prefetchMax}|${boundaryKey(genSettings.boundary) || 'auto'}`;
  const prefetchTokenRef = useRef(prefetchToken);
  prefetchTokenRef.current = prefetchToken;
  useEffect(() => {
    if (mode !== 'input' || !pendingMarker || wsStatus !== 'connected' || prefetchMax <= 0) return undefined;
    const { lat, lng } = pendingMarker;
    const timer = setTimeout(() => {
      setPinArea((prev) => (samePin(prev, pendingMarker) && prev.token === prefetchToken && prev.status !== 'error'
        ? prev
        : { lat, lng, max: prefetchMax, token: prefetchToken, status: 'checking' }));
      sendMessage('PREFETCH_AREA', { lat, lng, max_path_len: prefetchMax, boundary: planBoundary, token: prefetchToken });
    }, 400);
    return () => clearTimeout(timer);
    // planBoundary goes with its token
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pendingMarker, prefetchMax, prefetchToken, wsStatus, sendMessage, connection]);

  // Search result or "use my location": start from there.
  const handlePlaceSelected = useCallback((place) => {
    const position = { lat: place.lat, lng: place.lng };
    setActiveTool(null);
    selectPathSet(null);
    setMode('input');
    placeMarker(position);
    if (place.name) setPinPlace({ ...position, name: place.name });
  }, [setMode, placeMarker, selectPathSet]);

  // Length and roads for the open generation's next batches (the More routes slider).
  const [moreSettings, setMoreSettings] = useState(null);

  // The plan's lists: 'loops' (Your loops) or 'favorites' (every favorite, on the map too).
  const [planTab, setPlanTab] = useState('loops');
  const favoritesTab = mode === 'input' && planTab === 'favorites';

  // Each tab keeps its own painted roads and areas: the plan's go with Find
  // loops; the Favorites tab's only filter favorites (and may come from road
  // pieces the server does not know as graph edges). Switching tabs swaps
  // them; coming back from a generation to Favorites brings its ones back
  // (to Your loops, the plan starts clear, as before).
  const selectionTab = mode === 'input' ? planTab : null;
  const tabSelections = useRef({ loops: [], favorites: [] });
  const lastSelectionTab = useRef(selectionTab);
  useEffect(() => {
    const prev = lastSelectionTab.current;
    if (prev === selectionTab) {
      if (selectionTab) tabSelections.current[selectionTab] = drawnSelections;
      return;
    }
    lastSelectionTab.current = selectionTab;
    if (selectionTab === 'favorites') replaceSelections(tabSelections.current.favorites);
    else if (selectionTab === 'loops' && prev === 'favorites') replaceSelections(tabSelections.current.loops);
  }, [selectionTab, drawnSelections, replaceSelections]);
  const planSelections = favoritesTab ? tabSelections.current.loops : drawnSelections;

  // Generations that start where the pin is: Find loops can add to one of
  // them (the newest, unless another or "new" is chosen) instead of making
  // another one. startChoice: { pin, id } (id null: a new generation).
  const setsHere = useMemo(
    () => (mode === 'input' && pendingMarker ? setsAtStart(generations, pendingMarker) : []),
    [mode, pendingMarker, generations],
  );
  const [startChoice, setStartChoice] = useState(null);
  const choiceForPin = startChoice && samePin(startChoice.pin, pendingMarker) ? startChoice : null;
  const addToId = choiceForPin
    ? (setsHere.some((g) => g.id === choiceForPin.id) ? choiceForPin.id : null)
    : (setsHere[0]?.id ?? null);
  const chooseStart = useCallback((id) => {
    if (pendingMarker) setStartChoice({ pin: pendingMarker, id });
  }, [pendingMarker]);

  // Find loops from the plan into an existing generation: it opens, takes the
  // plan's settings (length, roads, Advanced) and painted roads and areas,
  // and the server adds a first-sized batch to it (never repeating a route).
  const addToGeneration = useCallback((id) => {
    const set = pathSets[id];
    if (!set || !set.resumable) return false;
    const settings = { ...structuredClone(genSettings), algorithm: pickAlgorithm(genSettings.algorithm) };
    const selections = [...(set.selections || []),
      ...planSelections.filter((sel) => !(set.selections || []).some((x) => x.id === sel.id))];
    const sent = sendMessage('CONTINUE_GENERATION', {
      pathSetId: id,
      selections: selectionsPayload(selections),
      num_paths: Math.max(1, Math.round(Number(settings.num_paths) || 20)),
      algorithm: settings.algorithm,
      settings: requestSettings(settings),
      rebuild: rebuildFor(id), // its old settings: the server applies the new ones after
    });
    if (!sent) return false;
    setActiveTool(null);
    selectPathSet(id, planSelections);
    setPlanTab('loops');
    updatePathSetSettings(id, settings);
    setMoreSettings(null);
    clearPendingMarker();
    setMode('display');
    return true;
  }, [pathSets, genSettings, pickAlgorithm, planSelections, sendMessage, rebuildFor, selectPathSet,
    updatePathSetSettings, clearPendingMarker, setMode]);

  const startGeneration = useCallback(() => {
    if (mode !== 'input' || !pendingMarker) return;
    if (addToId && addToGeneration(addToId)) return;
    const algorithmId = pickAlgorithm(genSettings.algorithm);
    // Named after the place ("Dilworth, Charlotte"); a second one from there gets " 2".
    const place = pinName || `${pendingMarker.lat.toFixed(3)}, ${pendingMarker.lng.toFixed(3)}`;
    const name = suggestGenerationName(place, pathSets);
    const settings = { ...structuredClone(genSettings), algorithm: algorithmId };
    // Roads and areas painted before generating constrain the first search too.
    const sent = sendMessage('START_GENERATION', {
      lat: pendingMarker.lat,
      lng: pendingMarker.lng,
      ...requestSettings(settings),
      selections: selectionsPayload(planSelections),
    });
    if (!sent) return;
    pendingGenerations.current.push({ name, settings, selections: planSelections });
    setPlanTab('loops');
    localStorage.setItem('lastMapPosition', JSON.stringify({ center: [pendingMarker.lat, pendingMarker.lng], zoom: 13 }));
  }, [mode, pendingMarker, addToId, addToGeneration, genSettings, pathSets, sendMessage, planSelections,
    pickAlgorithm, pinName]);

  // A generation under the pointer in "Your loops": its pin is highlighted.
  // Map moves asked for by the panel: centreOn { lat, lng, n } (a generation
  // opened from a list, a start placed from Favorites), showBounds
  // { bounds, n } (a favorite selected in the list). n makes a repeat act.
  const [hoveredSetId, setHoveredSetId] = useState(null);
  const [centreOn, setCentreOn] = useState(null);
  const [showBounds, setShowBounds] = useState(null);
  const centreMapOn = useCallback((position) => {
    if (position) setCentreOn((prev) => ({ lat: position.lat, lng: position.lng, n: (prev?.n || 0) + 1 }));
  }, []);

  const favView = useFavoritesView({ favorites, generations, selections: drawnSelections });
  const { paths: favPaths, current: favCurrent } = favView;

  // The Favorites tab paints roads from the road pieces of the downloaded
  // map tiles under every favorite (no start pin or area needed).
  const favoriteTiles = useMemo(() => {
    if (!mapCoverage?.tiles) return [];
    const have = new Set(mapCoverage.tiles.map(([r, c]) => `${r}_${c}`));
    const out = new Map();
    favorites.forEach((record) => {
      const coords = record.path?.geometry?.coordinates || [];
      if (!coords.length) return;
      let [south, west, north, east] = [90, 180, -90, -180];
      coords.forEach(([lng, lat]) => {
        south = Math.min(south, lat); north = Math.max(north, lat);
        west = Math.min(west, lng); east = Math.max(east, lng);
      });
      tilesInBounds({ south, west, north, east }, mapCoverage.deg).forEach(([r, c]) => {
        if (have.has(`${r}_${c}`)) out.set(`${r}_${c}`, [r, c]);
      });
    });
    return [...out.values()];
  }, [favorites, mapCoverage]);
  useEffect(() => {
    if (favoritesTab && wsStatus === 'connected' && favoriteTiles.length) requestRoadSegments(favoriteTiles);
  }, [favoritesTab, wsStatus, favoriteTiles, requestRoadSegments]);
  const favRoadIndex = useMemo(() => {
    if (!favoritesTab) return null;
    const seen = new Set();
    const lines = [];
    favoriteTiles.forEach(([r, c]) => (roadSegments[`${r}_${c}`] || []).forEach((line) => {
      const key = edgeKey(line.u, line.v);
      if (seen.has(key)) return; // a road crossing two tiles comes with both
      seen.add(key);
      lines.push(line);
    }));
    return lines.length ? buildRoadIndex(lines) : null;
  }, [favoritesTab, favoriteTiles, roadSegments]);
  // The roads the Road tool paints: the Favorites tab's, else the start pin's or the open generation's area.
  const toolRoadIndex = favoritesTab ? favRoadIndex : roadIndex;

  // ---- search boundaries ----
  // The plan uses the automatic area (every road within reach of the start)
  // or a saved custom boundary (genSettings.boundary, a copy; generations keep
  // the one they were made with in their settings). boundaryDraft: the one
  // being drawn or edited ({ id (null: new), name, shapes, tool }), shown as
  // its own page over the panel; the map draws it with handles.
  const { boundaries, saveBoundary, deleteBoundary } = useBoundaries();
  const [boundaryDraft, setBoundaryDraft] = useState(null);
  const editingBoundary = mode === 'input' && !!boundaryDraft;
  const showBoundaryOnMap = useCallback((boundary) => {
    const b = boundaryBounds(boundary);
    if (b) setShowBounds((prev) => ({ bounds: [[b.south, b.west], [b.north, b.east]], n: (prev?.n || 0) + 1 }));
  }, []);
  const chooseBoundary = useCallback((id) => {
    const chosen = id ? boundaries.find((b) => b.id === id) || null : null;
    setGenSettings((prev) => ({ ...prev, boundary: chosen }));
    if (chosen) showBoundaryOnMap(chosen);
  }, [boundaries, showBoundaryOnMap]);
  const newBoundary = useCallback(() => {
    setActiveTool(null);
    setPlanTab('loops');
    setBoundaryDraft({ id: null, name: '', shapes: [], tool: 'box' });
  }, []);
  const editBoundary = useCallback(() => {
    const b = genSettings.boundary;
    if (!b) return;
    setActiveTool(null);
    setPlanTab('loops');
    setBoundaryDraft({ id: b.id, name: b.name, shapes: cleanShapes(b.shapes), tool: null });
    showBoundaryOnMap(b);
  }, [genSettings.boundary, showBoundaryOnMap]);
  const boundaryEdit = useMemo(() => ({
    // A drawn shape joins the boundary (a freehand outline is simplified to a
    // few points to drag); the tool goes back to none, so its handles show.
    add: (selection) => {
      const [shape] = cleanShapes([selection.shape === 'freeform'
        ? { ...selection, coordinates: simplifyOutline(selection.coordinates) }
        : selection]);
      if (shape) setBoundaryDraft((d) => (d ? { ...d, shapes: [...d.shapes, shape], tool: null } : d));
    },
    change: (index, shape) => setBoundaryDraft((d) => (d
      ? { ...d, shapes: d.shapes.map((s, i) => (i === index ? shape : s)) }
      : d)),
    remove: (index) => setBoundaryDraft((d) => (d ? { ...d, shapes: d.shapes.filter((_, i) => i !== index) } : d)),
    setTool: (tool) => setBoundaryDraft((d) => (d ? { ...d, tool: d.tool === tool ? null : tool } : d)),
    setName: (name) => setBoundaryDraft((d) => (d ? { ...d, name } : d)),
  }), []);
  const saveBoundaryDraft = useCallback(() => {
    if (!boundaryDraft) return;
    const saved = saveBoundary(boundaryDraft);
    if (!saved) return;
    setGenSettings((prev) => ({ ...prev, boundary: saved }));
    setBoundaryDraft(null);
  }, [boundaryDraft, saveBoundary]);
  const cancelBoundaryDraft = useCallback(() => setBoundaryDraft(null), []);
  const deleteBoundaryDraft = useCallback(() => {
    if (!boundaryDraft?.id) return;
    deleteBoundary(boundaryDraft.id);
    setGenSettings((prev) => (prev.boundary?.id === boundaryDraft.id ? { ...prev, boundary: null } : prev));
    setBoundaryDraft(null);
  }, [boundaryDraft, deleteBoundary]);

  // ---- open generation ----
  // Open a generation. { favorites: true } opens it in favorites only;
  // { routeKey } shows the route with that key (utils/routeIdentity) when it has it.
  const openGeneration = useCallback((id, options = {}) => {
    setActiveTool(null);
    setBoundaryDraft(null);
    setHoveredSetId(null);
    selectPathSet(id);
    if (options.favorites) showFavoritesOnly(true);
    if (options.routeKey) {
      const route = (pathSets[id]?.paths || []).find((p) => routeKey(p) === options.routeKey);
      if (route) selectPath(route.id);
    }
    setMode('display');
  }, [selectPathSet, showFavoritesOnly, pathSets, selectPath, setMode]);

  // Favorite (or unfavorite) a route of the open generation. In favorites
  // only, an unfavorited route stays listed until another one is selected.
  const toggleRouteFavorite = useCallback((path) => {
    if (!path) return;
    const source = activeGeneration
      ? { id: activeGeneration.id, name: activeGeneration.name, markerPosition: activeGeneration.markerPosition }
      : null;
    const now = toggleFavorite(path, source);
    if (now === false && favoritesOnly) keepListed(path.id);
  }, [activeGeneration, toggleFavorite, favoritesOnly, keepListed]);
  const favoriteCount = useMemo(
    () => (activePathSet?.paths || []).filter((p) => isFavorite(p)).length,
    [activePathSet, isFavorite],
  );

  const openGenerationFromList = useCallback((id, options) => {
    openGeneration(id, options);
    centreMapOn(pathSets[id]?.markerPosition);
  }, [openGeneration, centreMapOn, pathSets]);

  // ---- the plan's Favorites tab ----
  // A pin opens its generation in favorites only (the selected favorite shown, if it is there).
  const openFromPin = useCallback((id) => {
    if (!favoritesTab) {
      openGeneration(id);
      return;
    }
    openGeneration(id, { favorites: true, routeKey: favCurrent ? routeKey(favCurrent) : null });
  }, [favoritesTab, openGeneration, favCurrent]);
  const selectFavorite = useCallback((id) => {
    favView.select(id);
    const path = favView.paths.find((p) => p.id === id);
    const coords = path?.geometry?.coordinates || [];
    if (!coords.length) return;
    let [s, w, n, e] = [90, 180, -90, -180];
    coords.forEach(([lng, lat]) => {
      s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lng); e = Math.max(e, lng);
    });
    setShowBounds((prev) => ({ bounds: [[s, w], [n, e]], n: (prev?.n || 0) + 1 }));
  }, [favView]);
  // Unfavorite (it stays listed until another is selected), or favorite again.
  const toggleListedFavorite = useCallback((path) => {
    const record = favView.recordOf(path);
    const source = record ? { id: record.pathSetId, name: record.setName, markerPosition: record.start } : null;
    if (toggleFavorite(path, source) === false) favView.keepListed(record);
  }, [favView, toggleFavorite]);
  const favoritesProps = {
    groups: favView.groups,
    total: favorites.size,
    selectedId: favView.selectedId,
    onSelect: selectFavorite,
    onHover: favView.setHoveredId,
    isFavorite,
    onToggleFavorite: toggleListedFavorite,
    onOpenGroup: (group) => {
      const selected = group.records.find((r) => r.path.id === favView.selectedId) || group.records[0];
      openGenerationFromList(group.setId, { favorites: true, routeKey: selected?.key });
    },
    onPlanHere: (group) => {
      placeMarker({ lat: group.position.lat, lng: group.position.lng });
      setPlanTab('loops');
      centreMapOn(group.position);
    },
    onHoverGroup: setHoveredSetId,
  };

  const closeGeneration = useCallback(() => {
    setActiveTool(null);
    selectPathSet(null);
    setMode('input');
  }, [selectPathSet, setMode]);

  // "Plan again from here": the plan takes the generation's start and
  // settings; Find loops then adds to it (or, chosen, starts a new one).
  const newSearchFromGeneration = useCallback(() => {
    if (!activeGeneration) return;
    const s = activeGeneration.settings || {};
    setGenSettings((prev) => ({
      ...prev,
      ...Object.fromEntries(Object.entries(s).filter(([k]) => k in SETTING_DEFAULTS)),
    }));
    const start = activeGeneration.markerPosition;
    closeGeneration();
    if (start) {
      const pin = { lat: start.lat, lng: start.lng };
      placeMarker(pin);
      setStartChoice({ pin, id: activeGeneration.id });
    }
  }, [activeGeneration, closeGeneration, placeMarker]);

  // Delete with undo.
  const [undo, setUndo] = useState(null); // { removed, name }
  const undoTimer = useRef(null);
  const handleDeleteGeneration = useCallback((id) => {
    const name = pathSets[id]?.name;
    const removed = deletePathSet(id);
    if (!removed) return;
    if (id === activePathSetId) {
      setActiveTool(null);
      setMode('input');
    }
    clearTimeout(undoTimer.current);
    setUndo({ removed, name });
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
  }, [pathSets, deletePathSet, activePathSetId, setMode]);
  const handleUndoDelete = useCallback(() => {
    if (!undo) return;
    restorePathSet(undo.removed);
    clearTimeout(undoTimer.current);
    setUndo(null);
  }, [undo, restorePathSet]);
  useEffect(() => () => clearTimeout(undoTimer.current), []);

  // ---- more routes ----
  const moreFor = useCallback((id) => {
    const s = pathSets[id]?.settings || {};
    return {
      min_path_len: s.min_path_len ?? SETTING_DEFAULTS.min_path_len,
      max_path_len: s.max_path_len ?? SETTING_DEFAULTS.max_path_len,
      road_preference: s.road_preference || 'balanced',
    };
  }, [pathSets]);
  const currentMore = moreSettings?.id === activePathSetId ? moreSettings.value : (activePathSetId ? moreFor(activePathSetId) : null);
  const setCurrentMore = useCallback((value) => {
    setMoreSettings({ id: activePathSetId, value });
  }, [activePathSetId]);

  // More routes for the open generation: through every include selection
  // (pins, green roads, areas), avoiding every red road, with the More
  // routes length / roads. Routes already in the generation never repeat.
  const requestMoreRoutes = useCallback((selections, more = currentMore) => {
    if (!canContinue || !activePathSetId) return false;
    const set = pathSets[activePathSetId];
    const settings = { ...(set?.settings || {}), ...(more || {}) };
    const sent = sendMessage('CONTINUE_GENERATION', {
      pathSetId: activePathSetId,
      selections: selectionsPayload(selections),
      num_paths: Math.max(1, Math.round(Number(settings.routes_per_pin ?? genSettings.routes_per_pin) || 10)),
      algorithm: pickAlgorithm(settings.more_algorithm || settings.algorithm),
      settings: requestSettings(settings),
      rebuild: rebuildFor(activePathSetId),
    });
    if (sent && more) updatePathSetSettings(activePathSetId, more);
    return sent;
  }, [canContinue, activePathSetId, pathSets, sendMessage, genSettings.routes_per_pin, pickAlgorithm,
    rebuildFor, updatePathSetSettings, currentMore]);

  const handleMoreRoutes = useCallback((more) => {
    if (!canContinue || activeIsGenerating) return;
    if (more) setCurrentMore(more);
    requestMoreRoutes(drawnSelections, more || currentMore);
  }, [canContinue, activeIsGenerating, requestMoreRoutes, drawnSelections, currentMore, setCurrentMore]);

  const handleSelection = useCallback((selection) => {
    addDrawnSelection(selection);
    setActiveTool(null);
    // An include area on an open generation also asks for routes through it
    // (and through every earlier include, avoiding every exclude).
    if (canContinue && selection.type === 'include') requestMoreRoutes([...drawnSelections, selection]);
  }, [addDrawnSelection, canContinue, requestMoreRoutes, drawnSelections]);

  // Road tool: paint edges (or a whole road) green / red. Green on an open
  // generation asks for routes through it; red only filters.
  const handleToggleEdges = useCallback((edges, options) => {
    toggleEdges(edges, options);
    if (!canContinue) return;
    const next = applyPaint(drawnSelections, edges, options);
    const greenCount = (list) => list.filter((s) => s.shape === 'edges' && s.type === 'include').length;
    if (options.type === 'include' && greenCount(next) > greenCount(drawnSelections)) {
      requestMoreRoutes(next);
    } else if (activeIsGenerating && next.length < drawnSelections.length) {
      handleStopGeneration(); // a constraint came off; the batch was built for it
    }
  }, [toggleEdges, canContinue, drawnSelections, requestMoreRoutes, activeIsGenerating, handleStopGeneration]);

  // A drawn excluded area: its roads turn red (only filters, like red roads).
  // Like an include area, drawing one is a single gesture: back to pan after.
  const handleExcludeArea = useCallback((edges, outline) => {
    handleToggleEdges(edges, { type: 'exclude', kind: 'area', label: 'area', outline });
    setActiveTool(null);
  }, [handleToggleEdges]);

  // Removing a constraint stops a batch that was built to cross it.
  const handleRemoveSelection = useCallback((id) => {
    removeSelection(id);
    if (canContinue && activeIsGenerating) handleStopGeneration();
  }, [removeSelection, canContinue, activeIsGenerating, handleStopGeneration]);

  const handleUndoSelection = useCallback(() => {
    undoLastSelection();
    if (canContinue && activeIsGenerating && drawnSelections.length > 0) handleStopGeneration();
  }, [undoLastSelection, canContinue, activeIsGenerating, drawnSelections.length, handleStopGeneration]);

  // ---- keyboard ----
  useEffect(() => {
    const handleKeyDown = (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) {
        if (!(e.key === 'Enter' && tag === 'INPUT')) return;
      }
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;

      // The boundary editor: Enter uses it, Esc cancels a shape being dragged,
      // else the editor; C / B / F add a shape, K stops adding, Z removes the last.
      if (editingBoundary) {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveBoundaryDraft();
        } else if (e.key === 'Escape') {
          if (!boundaryDraftingRef.current?.()) cancelBoundaryDraft();
        } else if (plain && tag !== 'INPUT') {
          const tool = { c: 'circle', b: 'box', f: 'freeform' }[e.key.toLowerCase()];
          if (tool) boundaryEdit.setTool(tool);
          if (e.key === 'k' || e.key === 'K') setBoundaryDraft((d) => (d ? { ...d, tool: null } : d));
          if ((e.key === 'z' || e.key === 'Z') && boundaryDraft?.shapes.length) {
            boundaryEdit.remove(boundaryDraft.shapes.length - 1);
          }
        }
        return;
      }

      if (e.key === 'Enter' && mode === 'input') startGeneration();

      if (mode === 'display') {
        if (e.key === 'Escape') {
          if (draftingRef.current?.()) return;
          if (activeTool) {
            setActiveTool(null);
            return;
          }
          if (isGenerating) handleStopGeneration();
        }
        if (e.key === 'Backspace') {
          e.preventDefault();
          closeGeneration();
        }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          nextPath();
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          prevPath();
        }
        if (plain && (e.key === 'e' || e.key === 'E')) setIsElevationMinimized((prev) => !prev);
        if (plain && (e.key === 'm' || e.key === 'M')) handleMoreRoutes();
        if (plain && (e.key === 's' || e.key === 'S')) toggleRouteFavorite(currentPath);
      }

      // The plan's Favorites tab: arrows step through the favorites, S
      // unfavorites (or favorites again) the selected one, Esc deselects it.
      if (mode === 'input' && planTab === 'favorites' && !activeTool) {
        if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) {
          e.preventDefault();
          const id = favView.stepId(e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1);
          if (id) selectFavorite(id);
          return;
        }
        if (plain && (e.key === 's' || e.key === 'S') && favCurrent) {
          toggleListedFavorite(favCurrent);
          return;
        }
        if (e.key === 'Escape' && favCurrent && !draftingRef.current?.()) {
          favView.select(null);
          return;
        }
      }

      // Tools: in the route view, and before generating (Plan card, Advanced).
      if (plain) {
        if (mode === 'input' && e.key === 'Escape') {
          if (draftingRef.current?.()) return;
          if (activeTool) setActiveTool(null);
        }
        const toolKeys = { c: 'circle', b: 'box', f: 'freeform', r: 'road' };
        const tool = toolKeys[e.key.toLowerCase()];
        if (tool) setActiveTool(activeTool === tool ? null : tool);
        if (e.key === 'k' || e.key === 'K') setActiveTool(null);
        if (e.key === 'z' || e.key === 'Z') handleUndoSelection();
        if (e.key === 'd' || e.key === 'D') setIsExcludeMode((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mode, startGeneration, closeGeneration, handleUndoSelection, handleMoreRoutes, nextPath, prevPath,
    activeTool, isGenerating, handleStopGeneration, toggleRouteFavorite, currentPath, planTab, favView, favCurrent,
    selectFavorite, toggleListedFavorite, editingBoundary, boundaryDraft, boundaryEdit, saveBoundaryDraft,
    cancelBoundaryDraft]);

  const toolsProps = {
    activeTool,
    setActiveTool,
    isExcludeMode,
    setIsExcludeMode,
    onUndo: handleUndoSelection,
    roadIndexReady: !!toolRoadIndex,
    drawnSelections,
    onClearSelections: clearDrawnSelections,
    selectionsHidden: !showSelections && !activeTool,
  };

  const activeStatus = activePathSetId ? mapProgressText(genMapStatus[activePathSetId]) : null;

  // Dev server only: state the browser checks (backend/tools/check_frontend.py) read.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__routeKey = routeKey;
    window.__loopState = {
      mode,
      pendingMarker,
      activeTool,
      isExcludeMode,
      selections: drawnSelections,
      currentPath,
      paths: filteredPaths,
      totalCount: totalPathsCount,
      isGenerating,
      sortBy,
      sortAscending,
      hoveredPathId,
      activePathSetId,
      favoritesOnly,
      favoriteCount: favorites.size,
      favoriteKeys: [...favorites.keys()],
      planTab,
      favoritesShown: favoritesTab ? favPaths.length : 0,
      favoritePaths: favoritesTab ? favPaths : [],
      roadToolReady: !!toolRoadIndex,
      boundary: genSettings.boundary,
      boundaryDraft,
      boundaries,
      setBoundary: activePathSet?.settings?.boundary || null,
      favoriteSelected: favoritesTab ? favCurrent?.id ?? null : null,
      currentFavorite: !!currentPath && isFavorite(currentPath),
      generations: generations.map(({ id, name, pathCount, markerPosition }) => ({ id, name, pathCount, markerPosition })),
    };
  }, [mode, pendingMarker, activeTool, isExcludeMode, drawnSelections, currentPath, filteredPaths, totalPathsCount,
    isGenerating, sortBy, sortAscending, hoveredPathId, activePathSetId, generations, favoritesOnly, favorites,
    isFavorite, planTab, favoritesTab, favPaths, favCurrent, toolRoadIndex, genSettings.boundary, boundaryDraft,
    boundaries, activePathSet]);

  // The elevation chart: the open generation's route, or the favorite selected in the Favorites tab.
  const shownProfile = mode === 'display'
    ? currentPath?.properties?.elevation_profile
    : (favoritesTab ? favView.current?.properties?.elevation_profile : null);

  return (
    <UnitsContext.Provider value={units}>
      <div className="app">
        <MapView
          mode={mode}
          activeTool={activeTool}
          wsStatus={wsStatus}
          pendingMarker={pendingMarker}
          pathSetMarkers={pathSetMarkers}
          activePathSetId={activePathSetId}
          currentPath={currentPath}
          filteredPaths={filteredPaths}
          drawnSelections={drawnSelections}
          onMapClick={handleMapClick}
          onPinMove={handleMapClick}
          onPlaceSelected={handlePlaceSelected}
          mapCoverage={mapCoverage}
          tileRoads={tileRoads}
          onNeedTileRoads={requestTileRoads}
          onMarkerClick={openFromPin}
          onSelection={handleSelection}
          onExcludeArea={handleExcludeArea}
          onRemoveSelection={handleRemoveSelection}
          draftingRef={draftingRef}
          notice={notice}
          roadIndex={toolRoadIndex}
          onNeedGraphEdges={requestGraphEdges}
          showGraphRoads={showGraphRoads}
          showSelections={showSelections}
          onToggleEdges={handleToggleEdges}
          showArrows={showArrows}
          showCentroids={showCentroids}
          primaryColor={primaryColor}
          showPathPreview={showPathPreview}
          pathPreviewOpacity={pathPreviewOpacity}
          isGenerating={isGenerating}
          generatingPathCount={generatingPathCount}
          generatingStatus={generatingPathSetId ? mapProgressText(genMapStatus[generatingPathSetId]) : null}
          onStopGeneration={handleStopGeneration}
          reachMiles={Number(genSettings.max_path_len) || null}
          isExcludeMode={isExcludeMode}
          hoveredPathId={hoveredPathId}
          onSelectPath={selectPath}
          hoveredSetId={mode === 'input' ? hoveredSetId : null}
          centreOn={centreOn}
          showBounds={showBounds}
          boundaryShapes={mode === 'input'
            ? (favoritesTab ? null : genSettings.boundary?.shapes || null)
            : (showBoundary ? activePathSet?.settings?.boundary?.shapes || null : null)}
          boundaryEdit={editingBoundary ? {
            shapes: boundaryDraft.shapes,
            tool: boundaryDraft.tool,
            add: boundaryEdit.add,
            change: boundaryEdit.change,
            draftingRef: boundaryDraftingRef,
          } : null}
          favoritesView={favoritesTab ? {
            paths: favView.paths,
            current: favView.current,
            hoveredId: favView.hoveredId,
            onSelect: favView.select,
          } : null}
          isFavorite={isFavorite}
          favoriteHue={favoriteHueOf(primaryColor)}
          addingToName={addToId ? setsHere.find((g) => g.id === addToId)?.name || null : null}
        />

        <ControlPanel
          mode={mode}
          genSettings={genSettings}
          setGenSettings={setGenSettings}
          units={units}
          setUnits={setUnits}
          pinArea={pendingMarker && samePin(pinArea, pendingMarker) ? pinArea : null}
          pinName={pinName}
          hasStart={!!pendingMarker}
          onGenerate={startGeneration}
          algorithms={algorithms}
          toolsProps={toolsProps}
          generations={generations}
          onOpenGeneration={openGenerationFromList}
          onDeleteGeneration={handleDeleteGeneration}
          activeGeneration={activeGeneration}
          generationProps={{
            paths: filteredPaths,
            totalCount: totalPathsCount,
            currentPath,
            onSelectPath: selectPath,
            onHoverPath: setHoveredPathId,
            onPrev: prevPath,
            onNext: nextPath,
            sortBy,
            sortAscending,
            onSort: chooseSort,
            onFlipSort: flipSort,
            routeFilters,
            filterBounds,
            setFilterRange,
            addRouteFilter,
            removeRouteFilter,
            onClearFilters: resetFilterRanges,
            isGenerating: activeIsGenerating,
            statusText: activeStatus,
            onStop: handleStopGeneration,
            onBack: closeGeneration,
            onRename: (name) => renamePathSet(activePathSetId, name),
            onDelete: () => handleDeleteGeneration(activePathSetId),
            onNewSearchHere: newSearchFromGeneration,
            more: currentMore,
            onMoreChange: setCurrentMore,
            onMoreRoutes: handleMoreRoutes,
            isFavorite,
            onToggleFavorite: toggleRouteFavorite,
            favoritesOnly,
            onFavoritesOnly: showFavoritesOnly,
            favoriteCount,
          }}
          viewOptions={viewOptions}
          setViewOption={setViewOption}
          setsHere={setsHere}
          addToId={addToId}
          onChooseStart={chooseStart}
          onRenameGeneration={renamePathSet}
          onHoverGeneration={setHoveredSetId}
          planTab={planTab}
          onPlanTab={setPlanTab}
          boundaryProps={{
            boundaries,
            selected: genSettings.boundary,
            onChoose: chooseBoundary,
            onNew: newBoundary,
            onEdit: editBoundary,
            // The pin outside the boundary: the start moves to its nearest road inside.
            pinOutside: !!pendingMarker && !!genSettings.boundary
              && !boundaryContains(genSettings.boundary, pendingMarker.lat, pendingMarker.lng),
          }}
          boundaryEditor={editingBoundary ? {
            draft: boundaryDraft,
            ...boundaryEdit,
            onSave: saveBoundaryDraft,
            onCancel: cancelBoundaryDraft,
            onDelete: boundaryDraft.id ? deleteBoundaryDraft : null,
          } : null}
          favoritesProps={favoritesProps}
        />

        {undo && (
          <div className="undo-toast" role="status">
            <span>Deleted “{undo.name}”.</span>
            <button type="button" onClick={handleUndoDelete}>Undo</button>
          </div>
        )}

        {shownProfile?.length > 1 && (
          <>
            {isElevationMinimized && (
              <button className="elevation-toggle-btn" onClick={() => setIsElevationMinimized(false)}>
                <Activity size={16} />
                Elevation
              </button>
            )}
            {!isElevationMinimized && (
              <ElevationProfileWindow
                elevationProfile={shownProfile}
                onClose={() => setIsElevationMinimized(true)}
                onFlipPath={mode === 'display' ? reverseCurrentPathProfile : undefined}
              />
            )}
          </>
        )}
      </div>
    </UnitsContext.Provider>
  );
}

export default App;
