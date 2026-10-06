import { useCallback } from 'react';

function snap(value, bounds, decimals) {
    const clamped = Math.min(Math.max(Number(value), bounds.min), bounds.max);
    return Number(clamped.toFixed(decimals));
}

/**
 * Dual-handle range slider for one route metric.
 * The ends span the active route set. A handle on an end stores null, so it
 * keeps following the set as routes stream in.
 */
function RangeFilter({ metric, bounds, range, onChange }) {
    const decimals = metric.decimals;
    const hasBounds = !!bounds;
    const minVal = hasBounds ? snap(range[0] ?? bounds.min, bounds, decimals) : 0;
    const maxVal = hasBounds ? snap(range[1] ?? bounds.max, bounds, decimals) : 0;

    const emit = useCallback((lo, hi) => {
        onChange([
            lo <= bounds.min ? null : lo,
            hi >= bounds.max ? null : hi,
        ]);
    }, [bounds, onChange]);

    const handleMinChange = useCallback((e) => {
        emit(Math.min(snap(e.target.value, bounds, decimals), maxVal), maxVal);
    }, [bounds, decimals, emit, maxVal]);

    const handleMaxChange = useCallback((e) => {
        emit(minVal, Math.max(snap(e.target.value, bounds, decimals), minVal));
    }, [bounds, decimals, emit, minVal]);

    if (!hasBounds) {
        return <p className="distance-filter__note">No routes in this set have this value.</p>;
    }
    if (bounds.min === bounds.max) {
        return (
            <p className="distance-filter__note">
                Every route is {metric.format(bounds.min)}.
            </p>
        );
    }

    const span = bounds.max - bounds.min;
    const minPercent = ((minVal - bounds.min) / span) * 100;
    const maxPercent = ((maxVal - bounds.min) / span) * 100;
    const mid = Number((bounds.min + span / 2).toFixed(decimals));

    return (
        <div className="distance-filter">
            <div className="distance-filter__header">
                <span className="distance-filter__range">
                    {metric.format(minVal)} – {metric.format(maxVal)}
                </span>
            </div>

            <div className="distance-filter__slider-container">
                <div
                    className="distance-filter__fill"
                    style={{
                        left: `${minPercent}%`,
                        width: `${maxPercent - minPercent}%`,
                    }}
                />
                <input
                    type="range"
                    min={bounds.min}
                    max={bounds.max}
                    step={bounds.step}
                    value={minVal}
                    onChange={handleMinChange}
                    className="distance-filter__slider distance-filter__slider--min"
                    aria-label={`Minimum ${metric.label}`}
                />
                <input
                    type="range"
                    min={bounds.min}
                    max={bounds.max}
                    step={bounds.step}
                    value={maxVal}
                    onChange={handleMaxChange}
                    className="distance-filter__slider distance-filter__slider--max"
                    aria-label={`Maximum ${metric.label}`}
                />
            </div>

            <div className="distance-filter__marks">
                <span>{metric.format(bounds.min)}</span>
                <span>{metric.format(mid)}</span>
                <span>{metric.format(bounds.max)}</span>
            </div>
        </div>
    );
}

export default RangeFilter;
