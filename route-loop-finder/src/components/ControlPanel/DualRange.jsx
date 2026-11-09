/**
 * Two-handle slider over [min, max]. The handles cannot cross (they may
 * meet). Shared look for the plan's route length, More routes, and the route
 * filters (`dual-slider` in ControlPanel.css).
 */
function DualRange({ min, max, step = 1, low, high, onChange, label = 'value', format = String }) {
    const lo = Math.min(Math.max(low, min), max);
    const hi = Math.min(Math.max(high, lo), max);
    const span = max - min || 1;
    const loPct = ((lo - min) / span) * 100;
    const hiPct = ((hi - min) / span) * 100;
    const fix = (v) => Number(Number(v).toFixed(10));

    return (
        <div className="dual-slider">
            <div className="dual-slider__track" />
            <div className="dual-slider__fill" style={{ left: `${loPct}%`, width: `${hiPct - loPct}%` }} />
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={lo}
                onChange={(e) => onChange(Math.min(fix(e.target.value), hi), hi)}
                // Both handles at the top end: the low one must stay grabbable.
                style={lo === hi && lo > (min + max) / 2 ? { zIndex: 4 } : undefined}
                aria-label={`Lowest ${label}`}
                aria-valuetext={format(lo)}
            />
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={hi}
                onChange={(e) => onChange(lo, Math.max(fix(e.target.value), lo))}
                aria-label={`Highest ${label}`}
                aria-valuetext={format(hi)}
            />
        </div>
    );
}

export default DualRange;
