import React from 'react';
import { Plus, Square, Circle, Hexagon, X, Crop } from 'lucide-react';
import './GraphSelector.css';

function shapeReady(bounds) {
    if (!bounds?.type) return false;
    if (bounds.type === 'polygon') {
        return Array.isArray(bounds.coordinates) && bounds.coordinates.length >= 3;
    }
    if (bounds.type === 'circle') {
        return bounds.center?.lat != null && bounds.radiusMiles > 0;
    }
    return bounds.nw?.lat != null && bounds.se?.lat != null;
}

export default function GraphSelector({
    graphs,
    activeGraph,
    onSwitchGraph,
    onStartGraphCreate,
    onStartGraphCrop,
    onCancelGraphCreate,
    onCreateGraph,
    isCreatingGraph,
    isGraphCreateMode,
    graphCreateMode,
    graphCreateAction,
    setGraphCreateMode,
    graphBounds,
    exclusionZones,
    setExclusionZones,
    isDrawingExclusion,
    setIsDrawingExclusion,
}) {
    const cropping = graphCreateAction === 'crop';

    // If in creation mode (selecting bounds)
    if (isGraphCreateMode) {
        const ready = shapeReady(graphBounds) && !isCreatingGraph;
        return (
            <div className="graph-selector creating">
                <div className="graph-selector__header">
                    <span className="graph-selector__title">
                        {cropping ? `Crop ${activeGraph}` : 'New Graph Region'}
                    </span>
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

                <p className="graph-create-hint">
                    {cropping
                        ? `Keeps roads already in ${activeGraph}. Box, circle, polygon, and exclude work the same way.`
                        : 'Downloads this area from OpenStreetMap.'}
                </p>

                <div className="graph-create-actions">
                    <button
                        className="graph-create-submit"
                        onClick={onCreateGraph}
                        disabled={!ready}
                    >
                        {isCreatingGraph
                            ? (cropping ? 'Cropping…' : 'Downloading…')
                            : (cropping ? 'Crop graph' : 'Download graph')}
                    </button>
                    <button
                        className="graph-create-cancel"
                        onClick={onCancelGraphCreate}
                        disabled={isCreatingGraph}
                    >
                        Cancel
                    </button>
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
                    title="Download a new graph"
                >
                    <Plus size={18} />
                </button>
                <button
                    className="new-graph-btn crop"
                    onClick={onStartGraphCrop}
                    title={activeGraph ? `Crop ${activeGraph}` : 'Load a graph to crop'}
                    disabled={!activeGraph}
                >
                    <Crop size={18} />
                </button>
            </div>
        </div>
    );
}
