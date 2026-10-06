import { useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ChevronDown, Hand, Circle, Square, Lasso, Undo2, Ban, ArrowUpDown, Minimize2, Maximize2, Plus, Trash2, GripVertical } from 'lucide-react';
import './ControlPanel.css';

import PathInfo from './PathInfo';
import RangeFilter from './RangeFilter';
import GraphSelector from './GraphSelector';
import { FILTER_METRICS, getFilterMetric } from '../../utils/pathFiltering';
import {
    DEFAULT_ROAD_WEIGHTS,
    ROAD_WEIGHT_FIELDS,
    ROAD_WEIGHT_PRESETS,
} from '../../utils/roadWeights';

const SECTION_KEYS = ['tools', 'view', 'sort', 'filters', 'details'];
const SECTION_LABELS = {
    tools: 'Tools',
    view: 'View Options',
    sort: 'Sort By',
    filters: 'Filters',
    details: 'Path Details',
};

function readSectionOrder() {
    let saved = [];
    try {
        saved = JSON.parse(localStorage.getItem('panelSectionOrder') || '[]');
    } catch {
        saved = [];
    }
    const known = Array.isArray(saved) ? saved.filter((key, i) => SECTION_KEYS.includes(key) && saved.indexOf(key) === i) : [];
    return [...known, ...SECTION_KEYS.filter((key) => !known.includes(key))];
}

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
    routeFilters,
    filterBounds,
    setFilterRange,
    addRouteFilter,
    removeRouteFilter,
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
}) {
    const [filterPickerOpen, setFilterPickerOpen] = useState(false);
    const activeFilterKeys = new Set((routeFilters || []).map((filter) => filter.key));
    const availableFilters = FILTER_METRICS.filter((metric) => !activeFilterKeys.has(metric.key));
    const canGoPrev = currentPathIndex > 0;
    const canGoNext = currentPathIndex < filteredPathsCount - 1;
    const [isMinimized, setIsMinimized] = useState(false);
    const [collapsed, setCollapsed] = useState(() => {
        const defaults = {
            generation: false,
            debug: true,
            view: true,
            filters: false,
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

    const [sectionOrder, setSectionOrder] = useState(readSectionOrder);
    const [armedSection, setArmedSection] = useState(null);
    const [draggingSection, setDraggingSection] = useState(null);
    const [dropTarget, setDropTarget] = useState(null);

    const sectionVisible = {
        tools: mode === 'display',
        view: true,
        sort: hasActivePathSet,
        filters: hasActivePathSet,
        details: !!currentPath || hasActivePathSet,
    };

    const saveSectionOrder = (next) => {
        setSectionOrder(next);
        localStorage.setItem('panelSectionOrder', JSON.stringify(next));
    };

    const moveSection = (key, targetKey, after) => {
        if (key === targetKey) return;
        const next = sectionOrder.filter((k) => k !== key);
        const targetIndex = next.indexOf(targetKey);
        if (targetIndex < 0) return;
        next.splice(after ? targetIndex + 1 : targetIndex, 0, key);
        saveSectionOrder(next);
    };

    const nudgeSection = (key, direction) => {
        const visible = sectionOrder.filter((k) => sectionVisible[k]);
        const index = visible.indexOf(key);
        const target = visible[index + direction];
        if (!target) return;
        moveSection(key, target, direction > 0);
    };

    const endSectionDrag = () => {
        setArmedSection(null);
        setDraggingSection(null);
        setDropTarget(null);
    };

    const sectionProps = (key) => ({
        id: key,
        label: SECTION_LABELS[key],
        order: sectionOrder.indexOf(key),
        armed: armedSection === key,
        dragging: draggingSection === key,
        dropSide: dropTarget?.key === key ? (dropTarget.after ? 'after' : 'before') : null,
        onArm: () => setArmedSection(key),
        onDisarm: () => { if (!draggingSection) setArmedSection(null); },
        onNudge: (direction) => nudgeSection(key, direction),
        onDragStart: (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', key);
            setDraggingSection(key);
        },
        onDragOver: (e) => {
            if (!draggingSection) return;
            e.preventDefault();
            if (draggingSection === key) {
                setDropTarget(null);
                return;
            }
            const rect = e.currentTarget.getBoundingClientRect();
            const after = e.clientY > rect.top + rect.height / 2;
            if (dropTarget?.key !== key || dropTarget.after !== after) {
                setDropTarget({ key, after });
            }
        },
        onDragEnd: endSectionDrag,
    });

    const handleBodyDragOver = (e) => {
        if (draggingSection) e.preventDefault();
    };

    const handleBodyDrop = (e) => {
        if (!draggingSection) return;
        e.preventDefault();
        if (dropTarget) moveSection(draggingSection, dropTarget.key, dropTarget.after);
        endSectionDrag();
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
                <div
                    className="control-panel__body"
                    onDragOver={handleBodyDragOver}
                    onDrop={handleBodyDrop}
                >
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
                    {sectionVisible.tools && (
                        <ReorderableSection {...sectionProps('tools')}>
                            <div className="control-panel__section-title">Tools</div>
                            <div className="control-panel__tools">
                                <button
                                    className={`control-panel__tool-btn ${!activeTool ? 'active' : ''}`}
                                    onClick={() => setActiveTool(null)}
                                    title="Pan (K). Click a road to drop a pin."
                                >
                                    <Hand size={18} />
                                </button>
                                <button
                                    className={`control-panel__tool-btn ${activeTool === 'circle' ? 'active' : ''}`}
                                    onClick={() => setActiveTool(activeTool === 'circle' ? null : 'circle')}
                                    title="Circle (C). Click a road, or drag a radius."
                                >
                                    <Circle size={18} />
                                </button>
                                <button
                                    className={`control-panel__tool-btn ${activeTool === 'box' ? 'active' : ''}`}
                                    onClick={() => setActiveTool(activeTool === 'box' ? null : 'box')}
                                    title="Box (B). Click a road, or drag a rectangle."
                                >
                                    <Square size={18} />
                                </button>
                                <button
                                    className={`control-panel__tool-btn ${activeTool === 'freeform' ? 'active' : ''}`}
                                    onClick={() => setActiveTool(activeTool === 'freeform' ? null : 'freeform')}
                                    title="Freeform (F). Click a road, or drag a shape."
                                >
                                    <Lasso size={18} />
                                </button>
                                <button
                                    className={`control-panel__tool-btn ${isExcludeMode ? 'active exclude' : ''}`}
                                    onClick={() => setIsExcludeMode(!isExcludeMode)}
                                    title="Exclude (D). Hold Shift to exclude one selection."
                                >
                                    <Ban size={18} />
                                </button>
                                <button
                                    className="control-panel__tool-btn"
                                    onClick={onUndo}
                                    title="Undo last pin or area (Z)"
                                >
                                    <Undo2 size={18} />
                                </button>
                            </div>
                            <p className="tool-hint">
                                {!activeTool && 'Drag to move the map. '}
                                Click a road to drop a pin.
                                {activeTool === 'circle' && ' Drag to set a radius.'}
                                {activeTool === 'box' && ' Drag to draw a rectangle.'}
                                {activeTool === 'freeform' && ' Drag to draw a shape.'}
                                {' Double-click a pin to remove it.'}
                                {isExcludeMode ? ' Exclude is on.' : ' Hold Shift to exclude.'}
                            </p>
                        </ReorderableSection>
                    )}

                    <ReorderableSection {...sectionProps('view')}>
                        <SectionToggle
                            title="View Options"
                            collapsed={collapsed.view}
                            onToggle={() => toggleSection('view')}
                        />
                        {!collapsed.view && (
                            <div className="view-options">
                                <ToggleRow
                                    label="Show Direction Arrows"
                                    checked={showArrows}
                                    onChange={setShowArrows}
                                />
                                <ToggleRow
                                    label="Show Graph Boundary"
                                    checked={showGraphBoundary}
                                    onChange={setShowGraphBoundary}
                                />
                                <ToggleRow
                                    label="Show Path Preview"
                                    checked={showPathPreview}
                                    onChange={setShowPathPreview}
                                />
                                <SliderRow
                                    label="Preview Opacity"
                                    valueLabel={`${Math.round(pathPreviewOpacity * 100)}%`}
                                >
                                    <input
                                        type="range"
                                        min="0.1"
                                        max="1"
                                        step="0.1"
                                        value={pathPreviewOpacity}
                                        onChange={(e) => setPathPreviewOpacity(parseFloat(e.target.value))}
                                        aria-label="Preview opacity"
                                    />
                                </SliderRow>
                                <ToggleRow
                                    label="Show Graph Nodes"
                                    checked={showGraphNodes}
                                    onChange={setShowGraphNodes}
                                />
                                <ToggleRow
                                    label="Show Centroids"
                                    checked={showCentroids}
                                    onChange={setShowCentroids}
                                />
                                <SliderRow
                                    label="Theme Color"
                                    valueLabel={`${primaryColor}°`}
                                >
                                    <input
                                        type="range"
                                        min="0"
                                        max="360"
                                        value={primaryColor}
                                        onChange={(e) => setPrimaryColor(e.target.value)}
                                        aria-label="Theme color"
                                    />
                                </SliderRow>
                            </div>
                        )}
                    </ReorderableSection>

                    {hasActivePathSet && (
                        <>
                            <ReorderableSection {...sectionProps('sort')}>
                                <div className="control-panel__section-title">Sort By</div>
                                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                    <select
                                        value={sortBy}
                                        onChange={(e) => setSortBy(e.target.value)}
                                        className="control-panel__select"
                                        style={{ flex: 1 }}
                                    >
                                        <option value="similar">Similar routes</option>
                                        <option value="total_miles">Distance</option>
                                        <option value="difficulty">Difficulty</option>
                                        <option value="total_climb_ft">Total Climbing Distance</option>
                                        <option value="climb_rate">Climb Rate</option>
                                        <option value="loop_ratio">Loop Path Percentage</option>
                                        <option value="turns">Number of Turns</option>
                                        <option value="discomfort">Discomfort</option>
                                    </select>
                                    <button
                                        className="control-panel__tool-btn"
                                        onClick={() => setSortAscending(!sortAscending)}
                                        title={sortBy === 'similar'
                                            ? (sortAscending ? 'Start with shortest' : 'Start with longest')
                                            : (sortAscending ? 'Ascending' : 'Descending')}
                                        style={{ minWidth: '32px' }}
                                    >
                                        <ArrowUpDown size={16} />
                                    </button>
                                </div>
                            </ReorderableSection>

                            <ReorderableSection {...sectionProps('filters')}>
                                <div className="filters-head">
                                    <SectionToggle
                                        title="Filters"
                                        collapsed={collapsed.filters}
                                        onToggle={() => toggleSection('filters')}
                                    />
                                    <button
                                        type="button"
                                        className="filters-add"
                                        onClick={() => {
                                            if (collapsed.filters) {
                                                toggleSection('filters');
                                                setFilterPickerOpen(true);
                                                return;
                                            }
                                            setFilterPickerOpen((open) => !open);
                                        }}
                                        disabled={availableFilters.length === 0}
                                        title={availableFilters.length === 0 ? 'Every filter is already added' : 'Add a filter'}
                                        aria-label="Add a filter"
                                        aria-expanded={filterPickerOpen}
                                    >
                                        <Plus size={16} />
                                    </button>
                                </div>
                                {!collapsed.filters && filterPickerOpen && availableFilters.length > 0 && (
                                    <select
                                        className="control-panel__select filters-picker"
                                        autoFocus
                                        value=""
                                        onChange={(e) => {
                                            if (!e.target.value) return;
                                            addRouteFilter(e.target.value);
                                            setFilterPickerOpen(false);
                                        }}
                                        aria-label="Choose a filter"
                                    >
                                        <option value="">Choose a filter</option>
                                        {availableFilters.map((metric) => (
                                            <option key={metric.key} value={metric.key}>{metric.label}</option>
                                        ))}
                                    </select>
                                )}
                                {!collapsed.filters && (routeFilters || []).map((filter) => {
                                    const metric = getFilterMetric(filter.key);
                                    if (!metric) return null;
                                    return (
                                        <div key={filter.key} className="filter-block">
                                            <div className="filter-block__head">
                                                <span>{metric.label}</span>
                                                <button
                                                    type="button"
                                                    className="filter-block__delete"
                                                    onClick={() => removeRouteFilter(filter.key)}
                                                    title={`Remove ${metric.label} filter`}
                                                    aria-label={`Remove ${metric.label} filter`}
                                                >
                                                    <Trash2 size={14} />
                                                </button>
                                            </div>
                                            <RangeFilter
                                                metric={metric}
                                                bounds={filterBounds?.[filter.key]}
                                                range={filter.range}
                                                onChange={(range) => setFilterRange(filter.key, range)}
                                            />
                                        </div>
                                    );
                                })}
                            </ReorderableSection>
                        </>
                    )}

                    {sectionVisible.details && (
                        <ReorderableSection {...sectionProps('details')}>
                            <div className="control-panel__section-title">Path Details</div>
                            {currentPath ? (
                                <PathInfo path={currentPath} />
                            ) : (
                                <div className="control-panel__empty">
                                    <div className="control-panel__empty-text">
                                        No paths match your filters
                                    </div>
                                </div>
                            )}
                        </ReorderableSection>
                    )}

                </div>
            )}
        </div>
    );
}

function ReorderableSection({
    label,
    order,
    armed,
    dragging,
    dropSide,
    onArm,
    onDisarm,
    onNudge,
    onDragStart,
    onDragOver,
    onDragEnd,
    children,
}) {
    const className = [
        'control-panel__section',
        'control-panel__section--movable',
        dragging ? 'is-dragging' : '',
        dropSide ? `is-drop-${dropSide}` : '',
    ].filter(Boolean).join(' ');

    return (
        <div
            className={className}
            style={{ order }}
            draggable={armed}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
        >
            <button
                type="button"
                className="section-grip"
                onPointerDown={onArm}
                onPointerUp={onDisarm}
                onKeyDown={(e) => {
                    if (e.key === 'ArrowUp') { e.preventDefault(); onNudge(-1); }
                    if (e.key === 'ArrowDown') { e.preventDefault(); onNudge(1); }
                }}
                title={`Drag to move ${label}. Arrow keys also move it.`}
                aria-label={`Move ${label}`}
            >
                <GripVertical size={12} />
            </button>
            {children}
        </div>
    );
}

function ToggleRow({ label, checked, onChange }) {
    return (
        <label className="view-option">
            <span>{label}</span>
            <span className="view-option__switch">
                <input
                    type="checkbox"
                    checked={!!checked}
                    onChange={(e) => onChange(e.target.checked)}
                />
                <span />
            </span>
        </label>
    );
}

function SliderRow({ label, valueLabel, children }) {
    return (
        <div className="view-option view-option--stack">
            <div className="view-option__meta">
                <span>{label}</span>
                <span>{valueLabel}</span>
            </div>
            {children}
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
