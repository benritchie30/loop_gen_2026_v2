import { Hand, Circle, Square, Lasso, Undo2, Route } from 'lucide-react';
import { describeSelections } from '../../utils/routeSelections';

/**
 * Route through (green) or avoid (red): roads and areas. Always visible, in
 * the plan and the route view. One row: the tools, the Through / Avoid
 * switch, undo; a summary line with Clear when anything is painted.
 * Keyboard: K pan, R road, C circle, B box, F freeform, D through/avoid
 * (Shift flips it while held), Z undo. What the active tool does is shown
 * on the map (MapView's hint). The summary says when the painted roads and
 * areas are hidden on the map (display options; they still filter).
 */
function ToolsBar({
    mode,
    activeTool,
    setActiveTool,
    isExcludeMode,
    setIsExcludeMode,
    onUndo,
    roadIndexReady = false,
    drawnSelections = [],
    onClearSelections,
    selectionsHidden = false,
}) {
    const summary = describeSelections(drawnSelections);
    const toggle = (tool) => setActiveTool(activeTool === tool ? null : tool);
    const needsRoads = roadIndexReady ? '' : ' Available once the map of the start is loaded.';
    const tools = [
        {
            id: null,
            icon: Hand,
            label: 'Pan',
            title: mode === 'input'
                ? 'Pan (K). Click the map to move the start.'
                : 'Pan (K). Click near a route to show it; click again to step through routes there. Double-click a painted road or an area outline to remove it.',
        },
        {
            id: 'road',
            icon: Route,
            label: 'Road',
            title: `Road (R). Click a road to paint it; Ctrl-click for the whole road; click a painted road to clear it.${needsRoads}`,
            disabled: !roadIndexReady,
        },
        { id: 'circle', icon: Circle, label: 'Circle', title: 'Circle area (C). Drag from the centre.' },
        { id: 'box', icon: Square, label: 'Box', title: 'Box area (B). Drag a rectangle.' },
        { id: 'freeform', icon: Lasso, label: 'Freeform', title: 'Freeform area (F). Drag a shape.' },
    ];

    return (
        <div className="tools">
            <div className="tools__row">
                <div className="tools__group" role="toolbar" aria-label="Map tools">
                    {tools.map(({ id, icon, label, title, disabled }) => {
                        const Icon = icon;
                        const active = activeTool === id;
                        return (
                            <button
                                key={label}
                                type="button"
                                className={`tools__btn ${active ? 'is-active' : ''}`}
                                onClick={() => (id ? toggle(id) : setActiveTool(null))}
                                title={title}
                                aria-label={label}
                                aria-pressed={active}
                                disabled={disabled}
                            >
                                <Icon size={16} />
                            </button>
                        );
                    })}
                </div>
                <div
                    className={`tools__mode ${isExcludeMode ? 'is-avoid' : 'is-through'}`}
                    role="group"
                    aria-label="Paint as"
                    title="What the tools paint (D switches; hold Shift to flip it for one click)"
                >
                    <button type="button" className={!isExcludeMode ? 'is-active' : ''} onClick={() => setIsExcludeMode(false)} aria-pressed={!isExcludeMode}>
                        Through
                    </button>
                    <button type="button" className={isExcludeMode ? 'is-active' : ''} onClick={() => setIsExcludeMode(true)} aria-pressed={isExcludeMode}>
                        Avoid
                    </button>
                </div>
                <button
                    type="button"
                    className="tools__btn tools__undo"
                    onClick={onUndo}
                    title="Undo the last road or area (Z)"
                    aria-label="Undo"
                    disabled={drawnSelections.length === 0}
                >
                    <Undo2 size={16} />
                </button>
            </div>
            {summary && (
                <div className="tools__summary">
                    <span>
                        {summary}
                        {selectionsHidden && (
                            <span className="tools__hidden" title="Hidden on the map (display options); they still filter the routes">
                                {' · hidden'}
                            </span>
                        )}
                    </span>
                    <button type="button" className="link-btn" onClick={onClearSelections} title="Remove every painted road and area">
                        Clear
                    </button>
                </div>
            )}
        </div>
    );
}

export default ToolsBar;
