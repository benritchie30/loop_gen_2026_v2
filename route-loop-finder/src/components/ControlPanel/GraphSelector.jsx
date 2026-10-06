import React from 'react';
import { Plus, Square, Circle, Hexagon, X } from 'lucide-react';
import './GraphSelector.css';

export default function GraphSelector({
    graphs,
    activeGraph,
    onSwitchGraph,
    onStartGraphCreate,
    isCreatingGraph,
    isGraphCreateMode,
    graphCreateMode,
    setGraphCreateMode,
    graphBounds,
    exclusionZones,
    setExclusionZones,
    isDrawingExclusion,
    setIsDrawingExclusion,
}) {
    // If in creation mode (selecting bounds)
    if (isGraphCreateMode) {
        return (
            <div className="graph-selector creating">
                <div className="graph-selector__header">
                    <span className="graph-selector__title">New Graph Region</span>
                    {/* Helper to cancel if needed, though Escape also works */}
                </div>

                <div className="graph-create-modes">
                    <button
                        className={`mode-btn ${graphCreateMode === 'box' ? 'active' : ''}`}
                        onClick={() => setGraphCreateMode('box')}
                        title="Box Selection"
                    >
                        <Square size={16} />
                        <span>Box</span>
                    </button>
                    <button
                        className={`mode-btn ${graphCreateMode === 'circle' ? 'active' : ''}`}
                        onClick={() => setGraphCreateMode('circle')}
                        title="Circle Selection"
                    >
                        <Circle size={16} />
                        <span>Circle</span>
                    </button>
                    <button
                        className={`mode-btn ${graphCreateMode === 'polygon' ? 'active' : ''}`}
                        onClick={() => setGraphCreateMode('polygon')}
                        title="Polygon Selection"
                    >
                        <Hexagon size={16} />
                        <span>Poly</span>
                    </button>

                    <div className="separator-vertical" />

                    <button
                        className={`mode-btn exclusion ${isDrawingExclusion ? 'active' : ''}`}
                        onClick={() => setIsDrawingExclusion(!isDrawingExclusion)}
                        title="Draw Exclusion Zone (Lasso)"
                    >
                        <X size={16} />
                        <span>Exclude</span>
                    </button>

                    {exclusionZones && exclusionZones.length > 0 && (
                        <button
                            className="mode-btn danger"
                            onClick={() => setExclusionZones([])}
                            title="Clear Exclusions"
                        >
                            <X size={14} />
                            <span>Clear ({exclusionZones.length})</span>
                        </button>
                    )}
                </div>

                <div className="graph-create-status">
                    {/* Status removed as requested */}
                </div>
            </div>
        );
    }

    // Normal selection mode
    return (
        <div className="graph-selector">
            <div className="graph-selector__label">Active Graph</div>
            <div className="graph-selector__row">
                <select
                    value={activeGraph || ''}
                    onChange={(e) => onSwitchGraph(e.target.value)}
                    className="graph-dropdown"
                    disabled={graphs.length === 0}
                >
                    {graphs.length === 0 && <option value="">No graphs found</option>}
                    {graphs.map(g => {
                        const name = typeof g === 'object' ? g.name : g;
                        return <option key={name} value={name}>{name}</option>;
                    })}
                </select>
                <button
                    className="new-graph-btn"
                    onClick={onStartGraphCreate}
                    title="Create New Graph"
                >
                    <Plus size={18} />
                </button>
            </div>
        </div>
    );
}
