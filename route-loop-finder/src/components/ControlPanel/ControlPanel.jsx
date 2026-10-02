import { useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ChevronDown, MapPin, MousePointer2, Pencil, Undo2, Ban, ArrowUpDown, Minimize2, Maximize2 } from 'lucide-react';
import './ControlPanel.css';

import PathInfo from './PathInfo';
import DistanceFilter from './DistanceFilter';
import DifficultyFilter from './DifficultyFilter';
import GraphSelector from './GraphSelector';
import ThemeSettings from './ThemeSettings';
import {
    DEFAULT_ROAD_WEIGHTS,
    ROAD_WEIGHT_FIELDS,
    ROAD_WEIGHT_PRESETS,
} from '../../utils/roadWeights';

/**
 * Floating control panel for path navigation, filtering, and mode switching.
 */
function ControlPanel({
    mode,
    setMode,
    currentPath,
    currentPathIndex,
    filteredPathsCount,
    totalPathsCount,
    distanceRange,
    setDistanceRange,
    difficultyRange,
    setDifficultyRange,
    sortBy,
    setSortBy,
    sortAscending,
    setSortAscending,
    onNextPath,
    onPrevPath,
    onJumpPath,
    onGoToFirst,
    onGoToLast,
    hasActivePathSet,
    activeTool,
    setActiveTool,
    isExcludeMode,
    setIsExcludeMode,
    onUndo,
    genSettings,
    setGenSettings,
    algorithms,
    graphs,
    activeGraph,
    onSwitchGraph,
    onStartGraphCreate,
    isCreatingGraph,
    graphCreateMode,
    setGraphCreateMode,
    graphBounds,
    showArrows,
    setShowArrows,
    showPathPreview,
    setShowPathPreview,
    pathPreviewOpacity,
    setPathPreviewOpacity,
    showCentroids,
    setShowCentroids,
    showGraphBoundary,
    setShowGraphBoundary,
    isDrawingExclusion,
    setIsDrawingExclusion,
    primaryColor,
    setPrimaryColor,
    showGraphNodes,
    setShowGraphNodes,
    hasPoiPins,
    poiPinCount,
    keptPinCount,
    hasProbePin,
    poiMatch,
    setPoiMatch,
    poiRadiusOn,
    setPoiRadiusOn,
    poiRadiusMiles,
    setPoiRadiusMiles,
    poiNote,
    onClearProbe,
    onClearKept,
    onKeepProbe,
}) {
    const canGoPrev = currentPathIndex > 0;
    const canGoNext = currentPathIndex < filteredPathsCount - 1;
    const [isMinimized, setIsMinimized] = useState(false);
    const [collapsed, setCollapsed] = useState(() => {
        const defaults = {
            generation: false,
            debug: true,
            view: true,
            distance: true,
            difficulty: true,
            appearance: true,
        };
        try {
            const saved = JSON.parse(localStorage.getItem('panelSections') || '{}');
            return { ...defaults, ...saved };
        } catch {
            return defaults;
        }
    });

    const toggleSection = (key) => {
        setCollapsed((prev) => {
            const next = { ...prev, [key]: !prev[key] };
            localStorage.setItem('panelSections', JSON.stringify(next));
            return next;
        });
    };

    const handleSettingChange = (e) => {
        const { name, value, type, checked } = e.target;
        setGenSettings(prev => ({
            ...prev,
            [name]: type === 'checkbox' ? checked
                : type === 'number' ? parseFloat(value)
                    : value
        }));
    };

    const algorithmOptions = (algorithms && algorithms.length > 0)
        ? algorithms
        : [
            { id: 'turns', label: 'Turns-first (baseline)' },
            { id: 'turns_pruned', label: 'Turns-first + self-cross prune + A*' },
            { id: 'turns_capped', label: 'Turns-first + capped state space' },
            { id: 'pleasant_capped', label: 'Pleasant roads (capped)' },
            { id: 'discomfort_capped', label: 'Pleasant, ignore turns (capped)' },
            { id: 'distance_capped', label: 'Distance only (capped)' },
        ];

    return (
        <div className="control-panel">
            {/* Header with navigation - only show in display mode */}
            {mode === 'display' && (
                <div className="control-panel__header">
                    <div className="control-panel__header-top">
                        <div className="control-panel__counter">
                            {filteredPathsCount > 0 ? (
                                <>
                                    <strong>{currentPathIndex + 1}</strong> / {filteredPathsCount}
                                    {filteredPathsCount !== totalPathsCount && (
                                        <span> ({totalPathsCount})</span>
                                    )}
                                </>
                            ) : (
                                <span>No paths</span>
                            )}
                        </div>
                        <button
                            className="control-panel__nav-btn"
                            onClick={() => setIsMinimized(!isMinimized)}
                            title={isMinimized ? "Maximize" : "Minimize"}
                            style={{ marginLeft: 'auto' }}
                        >
                            {isMinimized ? <Maximize2 size={18} /> : <Minimize2 size={18} />}
                        </button>
                    </div>

                    <div className="control-panel__nav-row">
                        <button
                            className="control-panel__nav-btn"
                            onClick={onGoToFirst}
                            disabled={!canGoPrev}
                            aria-label="First path"
                            title="First Path"
                        >
                            <ChevronsLeft size={18} />
                        </button>
                        <button
                            className="control-panel__nav-btn"
                            onClick={() => onJumpPath && onJumpPath(-5)}
                            disabled={!canGoPrev}
                            aria-label="Back 5 paths"
                            title="Back 5"
                            style={{ fontSize: '10px', fontWeight: 'bold', width: '24px' }}
                        >
                            -5
                        </button>
                        <button
                            className="control-panel__nav-btn"
                            onClick={onPrevPath}
                            disabled={!canGoPrev}
                            aria-label="Previous path"
                            title="Previous Path"
                        >
                            <ChevronLeft size={20} />
                        </button>
                        <button
                            className="control-panel__nav-btn"
                            onClick={onNextPath}
                            disabled={!canGoNext}
                            aria-label="Next path"
                            title="Next Path"
                        >
                            <ChevronRight size={20} />
                        </button>
                        <button
                            className="control-panel__nav-btn"
                            onClick={() => onJumpPath && onJumpPath(5)}
                            disabled={!canGoNext}
                            aria-label="Forward 5 paths"
                            title="Forward 5"
                            style={{ fontSize: '10px', fontWeight: 'bold', width: '24px' }}
                        >
                            +5
                        </button>
                        <button
                            className="control-panel__nav-btn"
                            onClick={onGoToLast}
                            disabled={!canGoNext}
                            aria-label="Last path"
                            title="Last Path"
                        >
                            <ChevronsRight size={18} />
                        </button>
                    </div>
                </div>
            )}

            {!isMinimized && (
                <div className="control-panel__body">
                    {/* Graph selector - only in input mode */}
                    {(mode === 'input' || mode === 'graphCreate') && (
                        <div className="control-panel__section">
                            <GraphSelector
                                graphs={graphs}
                                activeGraph={activeGraph}
                                onSwitchGraph={onSwitchGraph}
                                onStartGraphCreate={onStartGraphCreate}
                                isCreatingGraph={isCreatingGraph}
                                isGraphCreateMode={mode === 'graphCreate'}
                                graphCreateMode={graphCreateMode}
                                setGraphCreateMode={setGraphCreateMode}
                                graphBounds={graphBounds}
                                // Exclusion props
                                isDrawingExclusion={isDrawingExclusion}
                                setIsDrawingExclusion={setIsDrawingExclusion}
                                showGraphBoundary={showGraphBoundary}
                                setShowGraphBoundary={setShowGraphBoundary}
                                showGraphNodes={showGraphNodes}
                                setShowGraphNodes={setShowGraphNodes}
                            />
                        </div>
                    )}

                    {/* Generator Settings - Show in INPUT mode */}
                    {mode === 'input' && genSettings && (
                        <div className="control-panel__section">
                            <SectionToggle
                                title="Generation Settings"
                                collapsed={collapsed.generation}
                                onToggle={() => toggleSection('generation')}
                            />
                            {!collapsed.generation && (
                            <div className="settings-grid">
                                <label className="setting-item">
                                    <span>Min Path Distance</span>
                                    <input
                                        type="number"
                                        name="min_path_len"
                                        value={genSettings.min_path_len}
                                        onChange={handleSettingChange}
                                        min="1" max="100"
                                    />
                                </label>
                                <label className="setting-item">
                                    <span>Max Path Distance</span>
                                    <input
                                        type="number"
                                        name="max_path_len"
                                        value={genSettings.max_path_len}
                                        onChange={handleSettingChange}
                                        min="1" max="200"
                                    />
                                </label>
                                <label className="setting-item">
                                    <span>Loop Path Percentage</span>
                                    <input
                                        type="number"
                                        name="loop_ratio"
                                        value={genSettings.loop_ratio}
                                        onChange={handleSettingChange}
                                        step="0.1" min="0" max="1"
                                    />
                                </label>
                                <label className="setting-item">
                                    <span>Number of Paths</span>
                                    <input
                                        type="number"
                                        name="num_paths"
                                        value={genSettings.num_paths}
                                        onChange={handleSettingChange}
                                        min="1" max="100"
                                    />
                                </label>

                                <label className="setting-item full-width">
                                    <span>Algorithm</span>
                                    <select
                                        name="algorithm"
                                        value={genSettings.algorithm || 'turns'}
                                        onChange={handleSettingChange}
                                    >
                                        {algorithmOptions.map(opt => (
                                            <option key={opt.id} value={opt.id}>{opt.label}</option>
                                        ))}
                                    </select>
                                </label>

                                {String(genSettings.algorithm || '').endsWith('_capped') && (
                                    <label className="setting-item full-width">
                                        <span>Cap per node/bucket</span>
                                        <input
                                            type="number"
                                            name="cap_k"
                                            value={genSettings.cap_k ?? 3}
                                            onChange={handleSettingChange}
                                            min="1" max="50" step="1"
                                        />
                                    </label>
                                )}

                                <details className="road-weights">
                                    <summary>Road weights</summary>
                                    <p className="road-weights__hint">
                                        A number is extra turns per mile. 0 is free. A bike lane still cuts a costly road.
                                    </p>
                                    <div className="road-weights__presets">
                                        {ROAD_WEIGHT_PRESETS.map(preset => (
                                            <button
                                                type="button"
                                                key={preset.id}
                                                className={genSettings.road_weight_preset === preset.id ? 'is-active' : ''}
                                                onClick={() => setGenSettings(prev => ({
                                                    ...prev,
                                                    road_weights: { ...preset.weights },
                                                    road_weight_preset: preset.id,
                                                    rural_scale: preset.rural_scale,
                                                }))}
                                            >
                                                {preset.label}
                                            </button>
                                        ))}
                                    </div>
                                    <div className="settings-grid">
                                        {ROAD_WEIGHT_FIELDS.map(([key, label]) => (
                                            <label key={key} className="setting-item">
                                                <span>{label}</span>
                                                <input
                                                    type="number"
                                                    min="0"
                                                    step="0.1"
                                                    value={genSettings.road_weights?.[key] ?? 0}
                                                    onChange={(e) => {
                                                        const num = parseFloat(e.target.value);
                                                        setGenSettings(prev => ({
                                                            ...prev,
                                                            road_weight_preset: 'custom',
                                                            road_weights: {
                                                                ...DEFAULT_ROAD_WEIGHTS,
                                                                ...prev.road_weights,
                                                                [key]: Number.isFinite(num) && num >= 0 ? num : 0,
                                                            },
                                                        }));
                                                    }}
                                                />
                                            </label>
                                        ))}
                                        <label className="setting-item full-width road-weights__rural">
                                            <input
                                                type="checkbox"
                                                checked={genSettings.rural_scale !== false}
                                                onChange={(e) => setGenSettings(prev => ({
                                                    ...prev,
                                                    road_weight_preset: 'custom',
                                                    rural_scale: e.target.checked,
                                                }))}
                                            />
                                            <span>Soften busy roads on rural graphs</span>
                                        </label>
                                    </div>
                                </details>

                                <label className="setting-item full-width">
                                    <span>Dedup</span>
                                    <select
                                        name="deduplication"
                                        value={genSettings.deduplication}
                                        onChange={handleSettingChange}
                                    >
                                        <option value="centroid">Centroid (Spatial)</option>
                                        <option value="jaccard">Jaccard (Overlap)</option>
                                    </select>
                                </label>

                                {/* Conditional Input based on Dedup selection */}
                                {genSettings.deduplication === 'jaccard' ? (
                                    <label className="setting-item full-width">
                                        <span>Path Similarity</span>
                                        <input
                                            type="number"
                                            name="sim_ceiling"
                                            value={genSettings.sim_ceiling}
                                            onChange={handleSettingChange}
                                            step="0.1" min="0" max="1"
                                        />
                                    </label>
                                ) : (
                                    <label className="setting-item full-width">
                                        <span>Centroid Sensitivity</span>
                                        <input
                                            type="number"
                                            name="min_dist_m"
                                            value={genSettings.min_dist_m || 50}
                                            onChange={handleSettingChange}
                                            min="10" max="1000" step="10"
                                        />
                                    </label>
                                )}

                                <SectionToggle
                                    title="Debug"
                                    collapsed={collapsed.debug}
                                    onToggle={() => toggleSection('debug')}
                                />
                                {!collapsed.debug && (
                                <>
                                <label className="checkbox-item" style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' }}>
                                    <input
                                        type="checkbox"
                                        name="debug_snapshots"
                                        checked={!!genSettings.debug_snapshots}
                                        onChange={handleSettingChange}
                                    />
                                    Save search snapshots
                                </label>
                                {genSettings.debug_snapshots && (
                                    <label className="setting-item full-width">
                                        <span>Snapshot every N pops</span>
                                        <input
                                            type="number"
                                            name="snapshot_every"
                                            value={genSettings.snapshot_every || 25000}
                                            onChange={handleSettingChange}
                                            min="1000" max="1000000" step="1000"
                                        />
                                    </label>
                                )}
                                </>
                                )}
                            </div>
                            )}
                        </div>
                    )}

                    {/* Drawing Tools - Only show in display mode */}
                    {mode === 'display' && (
                        <div className="control-panel__section">
                            <div className="control-panel__section-title">Tools</div>
                            <div className="control-panel__tools">
                                <button
                                    className={`control-panel__tool-btn ${activeTool === 'path' ? 'active' : ''}`}
                                    onClick={() => setActiveTool(activeTool === 'path' ? null : 'path')}
                                    title="Path Tool (Select Along Road)"
                                >
                                    <Pencil size={18} />
                                </button>
                                <button
                                    className={`control-panel__tool-btn ${activeTool === 'lasso' ? 'active' : ''}`}
                                    onClick={() => setActiveTool(activeTool === 'lasso' ? null : 'lasso')}
                                    title="Lasso Tool (Select Area)"
                                >
                                    <MousePointer2 size={18} />
                                </button>
                                <button
                                    className={`control-panel__tool-btn ${activeTool === 'poi' ? 'active' : ''}`}
                                    onClick={() => setActiveTool(activeTool === 'poi' ? null : 'poi')}
                                    title="Near a point (o). Click to probe, Ctrl+click to keep."
                                >
                                    <MapPin size={18} />
                                </button>
                                <button
                                    className={`control-panel__tool-btn ${isExcludeMode ? 'active exclude' : ''}`}
                                    onClick={() => setIsExcludeMode(!isExcludeMode)}
                                    title="Toggle Exclude Mode (d)"
                                >
                                    <Ban size={18} />
                                </button>
                                <button
                                    className="control-panel__tool-btn"
                                    onClick={onUndo}
                                    title="Undo Last Selection (z)"
                                >
                                    <Undo2 size={18} />
                                </button>
                            </div>
                            {(activeTool === 'poi' || hasPoiPins) && (
                                <div className="poi-controls">
                                    <p className="poi-controls__hint">
                                        Click the map to probe. Ctrl+click keeps that pin. Double-click or × removes a kept pin. Esc clears the probe.
                                    </p>
                                    {poiPinCount > 1 && (
                                        <div className="poi-controls__match">
                                            <button
                                                type="button"
                                                className={poiMatch === 'all' ? 'active' : ''}
                                                onClick={() => setPoiMatch('all')}
                                            >
                                                All pins
                                            </button>
                                            <button
                                                type="button"
                                                className={poiMatch === 'any' ? 'active' : ''}
                                                onClick={() => setPoiMatch('any')}
                                            >
                                                Any pin
                                            </button>
                                        </div>
                                    )}
                                    <label className="poi-controls__radius">
                                        <input
                                            type="checkbox"
                                            checked={poiRadiusOn}
                                            onChange={(e) => setPoiRadiusOn(e.target.checked)}
                                        />
                                        <span>Within {poiRadiusMiles.toFixed(1)} mi</span>
                                    </label>
                                    {poiRadiusOn && (
                                        <input
                                            type="range"
                                            min="0.1"
                                            max="3"
                                            step="0.1"
                                            value={poiRadiusMiles}
                                            onChange={(e) => setPoiRadiusMiles(parseFloat(e.target.value))}
                                            aria-label="Maximum distance from pins"
                                        />
                                    )}
                                    <div className="poi-controls__actions">
                                        {hasProbePin && (
                                            <button type="button" onClick={onKeepProbe}>Keep probe</button>
                                        )}
                                        {hasProbePin && (
                                            <button type="button" onClick={onClearProbe}>Clear probe</button>
                                        )}
                                        {keptPinCount > 0 && (
                                            <button type="button" onClick={onClearKept}>Clear pins</button>
                                        )}
                                    </div>
                                    {poiNote && (
                                        <p className="poi-controls__note">
                                            {poiNote.fallback
                                                ? `None within ${poiNote.radius.toFixed(1)} mi. Showing the ${poiNote.shown} closest. Nearest is ${formatNoteMiles(poiNote.closest)}.`
                                                : poiNote.radius
                                                    ? `${poiNote.withinCount} ${poiNote.withinCount === 1 ? 'route comes' : 'routes come'} within ${poiNote.radius.toFixed(1)} mi.`
                                                    : `Nearest approach is ${formatNoteMiles(poiNote.closest)}.`}
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Path info - only show when we have a path */}
                    {hasActivePathSet && (
                        <>
                            <div className="control-panel__section">
                            <SectionToggle
                                title="View Options"
                                collapsed={collapsed.view}
                                onToggle={() => toggleSection('view')}
                            />
                            {!collapsed.view && (
                            <div className="settings-grid">
                                    {showPathPreview && (
                                        <label className="setting-item full-width" style={{ marginTop: '8px' }}>
                                            <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Preview Opacity: {Math.round(pathPreviewOpacity * 100)}%</span>
                                            <input
                                                type="range"
                                                min="0.1"
                                                max="1.0"
                                                step="0.1"
                                                value={pathPreviewOpacity}
                                                onChange={e => setPathPreviewOpacity(parseFloat(e.target.value))}
                                                style={{ width: '100%' }}
                                            />
                                        </label>
                                    )}
                                    <label className="checkbox-item" style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' }}>
                                        <input
                                            type="checkbox"
                                            checked={showArrows}
                                            onChange={e => setShowArrows(e.target.checked)}
                                        />
                                        Show Direction Arrows
                                    </label>
                                    <div className="control-panel__setting-row">
                                        <label className="control-panel__setting-label">
                                            Show Graph Boundary
                                        </label>
                                        <label className="switch">
                                            <input
                                                type="checkbox"
                                                checked={showGraphBoundary}
                                                onChange={(e) => setShowGraphBoundary(e.target.checked)}
                                            />
                                            <span className="slider round"></span>
                                        </label>
                                    </div>

                                    <div className="control-panel__setting-row">
                                        <label className="control-panel__setting-label">
                                            Show Path Preview
                                        </label>
                                        <label className="switch">
                                            <input
                                                type="checkbox"
                                                checked={showPathPreview}
                                                onChange={(e) => setShowPathPreview(e.target.checked)}
                                            />
                                            <span className="slider round"></span>
                                        </label>
                                    </div>

                                    <div className="control-panel__setting-row">
                                        <label className="control-panel__setting-label">
                                            Show Graph Nodes
                                        </label>
                                        <label className="switch">
                                            <input
                                                type="checkbox"
                                                checked={showGraphNodes}
                                                onChange={(e) => setShowGraphNodes(e.target.checked)}
                                            />
                                            <span className="slider round"></span>
                                        </label>
                                    </div>
                                    <label className="checkbox-item" style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', marginTop: '4px' }}>
                                        <input
                                            type="checkbox"
                                            checked={showCentroids}
                                            onChange={e => setShowCentroids(e.target.checked)}
                                        />
                                        Show Centroids
                                    </label>

                                </div>
                            )}
                            </div>

                            <div className="control-panel__section">
                                <div className="control-panel__section-title">Sort By</div>
                                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                    <select
                                        value={sortBy}
                                        onChange={(e) => setSortBy(e.target.value)}
                                        className="control-panel__select"
                                        style={{ flex: 1 }}
                                    >
                                        <option value="total_miles">Distance</option>
                                        <option value="difficulty">Difficulty</option>
                                        <option value="total_climb_ft">Total Climbing Distance</option>
                                        <option value="loop_ratio">Loop Path Percentage</option>
                                        <option value="turns">Number of Turns</option>
                                        <option value="discomfort">Discomfort</option>
                                        <option value="spatial">Spatial Flow</option>
                                        {hasPoiPins && (
                                            <option value="poi">Closest to pins</option>
                                        )}
                                    </select>
                                    <button
                                        className="control-panel__tool-btn"
                                        onClick={() => setSortAscending(!sortAscending)}
                                        title={sortAscending ? 'Ascending' : 'Descending'}
                                        style={{ minWidth: '32px' }}
                                    >
                                        <ArrowUpDown size={16} />
                                    </button>
                                </div>
                            </div>

                            <div className="control-panel__section">
                            <SectionToggle
                                title="Filter by Distance"
                                collapsed={collapsed.distance}
                                onToggle={() => toggleSection('distance')}
                            />
                            {!collapsed.distance && (
                                <DistanceFilter
                                    distanceRange={distanceRange}
                                    setDistanceRange={setDistanceRange}
                                />
                            )}
                            </div>

                            <div className="control-panel__section">
                            <SectionToggle
                                title="Filter by Difficulty"
                                collapsed={collapsed.difficulty}
                                onToggle={() => toggleSection('difficulty')}
                            />
                            {!collapsed.difficulty && (
                                <DifficultyFilter
                                    difficultyRange={difficultyRange}
                                    setDifficultyRange={setDifficultyRange}
                                />
                            )}
                            </div>
                        </>
                    )}

                    {/* Path info - only show when we have a path */}
                    {currentPath ? (
                        <div className="control-panel__section">
                            <div className="control-panel__section-title">Path Details</div>
                            <PathInfo path={currentPath} />
                        </div>
                    ) : hasActivePathSet ? (
                        <div className="control-panel__empty">
                            <div className="control-panel__empty-text">
                                No paths match your filters
                            </div>
                        </div>
                    ) : null}

                    {/* Theme Settings */}
                    <ThemeSettings
                        primaryColor={primaryColor}
                        setPrimaryColor={setPrimaryColor}
                        collapsed={collapsed.appearance}
                        onToggle={() => toggleSection('appearance')}
                    />
                </div>
            )}
        </div>
    );
}

function SectionToggle({ title, collapsed, onToggle }) {
    return (
        <button
            type="button"
            className="control-panel__section-toggle"
            onClick={onToggle}
            aria-expanded={!collapsed}
        >
            <span>{title}</span>
            <ChevronDown size={14} className={collapsed ? '' : 'is-open'} />
        </button>
    );
}

export default ControlPanel;

function formatNoteMiles(miles) {
    if (typeof miles !== 'number' || !Number.isFinite(miles)) return '—';
    if (miles < 0.1) return `${Math.round(miles * 5280)} ft`;
    return `${miles.toFixed(2)} mi`;
}
