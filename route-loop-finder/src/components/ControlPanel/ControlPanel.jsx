import { useEffect, useState } from 'react';
import { ChevronRight, Maximize2, Minimize2, SlidersHorizontal } from 'lucide-react';
import './ControlPanel.css';

import PlanCard from './PlanCard';
import AdvancedSettings from './AdvancedSettings';
import GenerationsList from './GenerationsList';
import FavoritesList from './FavoritesList';
import BoundaryEditor from './BoundaryEditor';
import GenerationPanel from './GenerationPanel';
import ViewOptions from './ViewOptions';

/**
 * The panel on the right, sized to fit the window without scrolling (only
 * lists scroll, inside their own boxes).
 * - No generation open: the plan (start, length, roads, through / avoid,
 *   Find loops), "Your loops", and Advanced settings at the bottom, which
 *   opens as a page over the whole panel.
 * - A generation open: its routes (GenerationPanel).
 */
function ControlPanel({
    mode,
    // plan
    genSettings,
    setGenSettings,
    units,
    setUnits,
    pinArea,
    pinName,
    hasStart,
    onGenerate,
    algorithms,
    toolsProps,
    // saved generations
    generations = [],
    onOpenGeneration,
    onDeleteGeneration,
    // open generation
    activeGeneration,
    generationProps,
    // map display
    viewOptions,
    setViewOption,
    setsHere = [],
    addToId = null,
    onChooseStart,
    onRenameGeneration,
    onHoverGeneration,
    planTab = 'loops', // 'loops' | 'favorites'
    onPlanTab,
    favoritesProps = null, // FavoritesList's props (every favorite, grouped by start)
    boundaryProps = null, // the plan's search area: PlanCard's boundary props
    boundaryEditor = null, // a boundary being drawn or edited: BoundaryEditor's props (its own page)
}) {
    const [minimized, setMinimized] = useState(false);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const showGeneration = mode === 'display' && activeGeneration;
    const title = showGeneration ? activeGeneration.name : 'Plan a loop';

    // A generation opening (even one started from the Advanced page, with
    // Enter) closes Advanced: going back from it shows the plan.
    useEffect(() => {
        if (showGeneration) setAdvancedOpen(false);
    }, [showGeneration]);

    // Esc closes the Advanced page.
    useEffect(() => {
        if (!advancedOpen || showGeneration) return undefined;
        const onKey = (e) => {
            if (e.key === 'Escape') setAdvancedOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [advancedOpen, showGeneration]);

    const actions = (
        <div className="panel-actions">
            <ViewOptions options={viewOptions} setOption={setViewOption} />
            <button
                type="button"
                className="icon-btn"
                onClick={() => setMinimized((m) => !m)}
                title={minimized ? 'Show the panel' : 'Hide the panel'}
                aria-label={minimized ? 'Show the panel' : 'Hide the panel'}
            >
                {minimized ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
            </button>
        </div>
    );

    if (minimized) {
        return (
            <div className="control-panel control-panel--minimized">
                <div className="panel-top">
                    <span className="panel-title">{title}</span>
                    {actions}
                </div>
            </div>
        );
    }

    if (showGeneration) {
        return (
            <div className="control-panel control-panel--full">
                <GenerationPanel
                    key={activeGeneration.id}
                    generation={activeGeneration}
                    headerActions={actions}
                    toolsProps={toolsProps}
                    {...generationProps}
                />
            </div>
        );
    }

    if (boundaryEditor && !showGeneration) {
        return (
            <div className="control-panel control-panel--full">
                <BoundaryEditor {...boundaryEditor} />
            </div>
        );
    }

    if (advancedOpen) {
        return (
            <div className="control-panel control-panel--full">
                <AdvancedSettings
                    genSettings={genSettings}
                    setGenSettings={setGenSettings}
                    algorithmOptions={algorithms}
                    onClose={() => setAdvancedOpen(false)}
                />
            </div>
        );
    }

    return (
        <div className="control-panel">
            <div className="panel-top">
                <span className="panel-title">{title}</span>
                {actions}
            </div>
            <div className="panel-section">
                <PlanCard
                    genSettings={genSettings}
                    setGenSettings={setGenSettings}
                    units={units}
                    setUnits={setUnits}
                    pinArea={pinArea}
                    pinName={pinName}
                    hasStart={hasStart}
                    onGenerate={onGenerate}
                    toolsProps={toolsProps}
                    setsHere={setsHere}
                    addToId={addToId}
                    onChooseStart={onChooseStart}
                    boundary={boundaryProps}
                />
            </div>
            {(generations.length > 0 || favoritesProps?.total > 0) && (
                <div className="panel-section panel-section--grow">
                    <div className="plan-tabs" role="tablist" aria-label="Your loops or every favorite">
                        {[['loops', 'Your loops', generations.length], ['favorites', 'Favorites', favoritesProps?.total || 0]].map(([id, label, count]) => (
                            <button
                                key={id}
                                type="button"
                                role="tab"
                                aria-selected={planTab === id}
                                className={planTab === id ? 'is-active' : ''}
                                onClick={() => onPlanTab?.(id)}
                            >
                                {label}
                                <span className="plan-tabs__count">{count}</span>
                            </button>
                        ))}
                    </div>
                    {planTab === 'favorites' ? (
                        <FavoritesList {...favoritesProps} />
                    ) : (
                        <GenerationsList
                            generations={generations}
                            onOpen={onOpenGeneration}
                            onDelete={onDeleteGeneration}
                            onRename={onRenameGeneration}
                            onHover={onHoverGeneration}
                            showHeader={false}
                        />
                    )}
                </div>
            )}
            <button type="button" className="panel-footer-btn" onClick={() => setAdvancedOpen(true)}>
                <SlidersHorizontal size={15} />
                <span>Advanced settings</span>
                {genSettings.road_preference === 'custom' && <span className="pill">custom roads</span>}
                <ChevronRight size={16} />
            </button>
            <p className="panel-privacy">
                Your routes are saved only in this browser. The server sees the start points you search
                from but doesn&apos;t store them.
            </p>
        </div>
    );
}

export default ControlPanel;
