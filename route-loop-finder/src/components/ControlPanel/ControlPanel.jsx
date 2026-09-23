import { useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, MapPin, MousePointer2, Pencil, Undo2, Ban, ArrowUpDown, Minimize2, Maximize2 } from 'lucide-react';
import './ControlPanel.css';

import PathInfo from './PathInfo';
import DistanceFilter from './DistanceFilter';
import DifficultyFilter from './DifficultyFilter';
import GraphSelector from './GraphSelector';
import ThemeSettings from './ThemeSettings';

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
    setShowGraphNodes
}) {
    const canGoPrev = currentPathIndex > 0;
    const canGoNext = currentPathIndex < filteredPathsCount - 1;
    const [isMinimized, setIsMinimized] = useState(false);

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
                            <div className="control-panel__section-title">Generation Settings</div>
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

                                {(genSettings.algorithm === 'turns_capped' || genSettings.algorithm === 'pleasant_capped') && (
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

                                <div className="control-panel__section-title" style={{ marginTop: '8px' }}>Debug</div>
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
                            </div>
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
                        </div>
                    )}

                    {/* Path info - only show when we have a path */}
                    {hasActivePathSet && (
                        <>
                            <div className="control-panel__section">
                                <div className="control-panel__section-title">View Options</div>
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
                                <div className="control-panel__section-title">Filter by Distance</div>
                                <DistanceFilter
                                    distanceRange={distanceRange}
                                    setDistanceRange={setDistanceRange}
                                />
                            </div>

                            <div className="control-panel__section">
                                <div className="control-panel__section-title">Filter by Difficulty</div>
                                <DifficultyFilter
                                    difficultyRange={difficultyRange}
                                    setDifficultyRange={setDifficultyRange}
                                />
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
                    />
                </div>
            )}
        </div>
    );
}

export default ControlPanel;
