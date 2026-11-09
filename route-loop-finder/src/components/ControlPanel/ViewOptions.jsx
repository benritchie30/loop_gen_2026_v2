import { useState } from 'react';
import { Settings2 } from 'lucide-react';

function ToggleRow({ label, checked, onChange }) {
    return (
        <label className="view-option">
            <span>{label}</span>
            <span className="view-option__switch">
                <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
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

/** Map display options behind a small gear button (top right of the panel). */
function ViewOptions({ options, setOption }) {
    const [open, setOpen] = useState(false);
    return (
        <div className="view-menu">
            <button
                type="button"
                className="icon-btn"
                onClick={() => setOpen((o) => !o)}
                title="Map display options"
                aria-label="Map display options"
                aria-expanded={open}
            >
                <Settings2 size={16} />
            </button>
            {open && (
                <div className="view-menu__panel view-options" onMouseLeave={() => setOpen(false)}>
                    <ToggleRow label="Direction arrows" checked={options.showArrows} onChange={(v) => setOption('showArrows', v)} />
                    <ToggleRow label="Other routes, faint" checked={options.showPathPreview} onChange={(v) => setOption('showPathPreview', v)} />
                    <SliderRow label="Faint routes opacity" valueLabel={`${Math.round(options.pathPreviewOpacity * 100)}%`}>
                        <input
                            type="range" min="0.1" max="1" step="0.1"
                            value={options.pathPreviewOpacity}
                            onChange={(e) => setOption('pathPreviewOpacity', parseFloat(e.target.value))}
                            aria-label="Faint routes opacity"
                        />
                    </SliderRow>
                    <ToggleRow label="Painted roads & areas" checked={options.showSelections} onChange={(v) => setOption('showSelections', v)} />
                    <ToggleRow label="Search boundary" checked={options.showBoundary} onChange={(v) => setOption('showBoundary', v)} />
                    <ToggleRow label="Road network" checked={options.showGraphRoads} onChange={(v) => setOption('showGraphRoads', v)} />
                    <ToggleRow label="Route centres" checked={options.showCentroids} onChange={(v) => setOption('showCentroids', v)} />
                    <SliderRow label="Theme colour" valueLabel={`${options.primaryColor}°`}>
                        <input
                            type="range" min="0" max="360"
                            value={options.primaryColor}
                            onChange={(e) => setOption('primaryColor', String(e.target.value))}
                            aria-label="Theme colour"
                        />
                    </SliderRow>
                </div>
            )}
        </div>
    );
}

export default ViewOptions;
