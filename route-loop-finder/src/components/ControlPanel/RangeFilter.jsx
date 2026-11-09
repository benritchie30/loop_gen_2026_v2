import { X } from 'lucide-react';
import DualRange from './DualRange';
import { useUnits } from '../../utils/units';

function snap(value, bounds, decimals) {
    const clamped = Math.min(Math.max(Number(value), bounds.min), bounds.max);
    return Number(clamped.toFixed(decimals));
}

/**
 * One route filter: name and chosen range on one line, a two-handle slider
 * under it. The ends span the open generation's routes; a handle at an end
 * stores null, so it keeps following the set as routes stream in.
 */
function RangeFilter({ metric, bounds, range, onChange, onRemove = null }) {
    const units = useUnits();
    const fmt = (value) => metric.format(value, units);
    const decimals = metric.decimals;

    let value = null;
    let body = null;
    if (!bounds) {
        value = <span className="filter__note">no data</span>;
    } else if (bounds.min === bounds.max) {
        value = <span className="filter__note">all {fmt(bounds.min)}</span>;
    } else {
        const lo = snap(range[0] ?? bounds.min, bounds, decimals);
        const hi = snap(range[1] ?? bounds.max, bounds, decimals);
        const narrowed = lo > bounds.min || hi < bounds.max;
        value = <span className={`filter__value ${narrowed ? 'is-narrowed' : ''}`}>{fmt(lo)} – {fmt(hi)}</span>;
        body = (
            <DualRange
                min={bounds.min}
                max={bounds.max}
                step={bounds.step}
                low={lo}
                high={hi}
                onChange={(a, b) => onChange([
                    a <= bounds.min ? null : snap(a, bounds, decimals),
                    b >= bounds.max ? null : snap(b, bounds, decimals),
                ])}
                label={metric.label.toLowerCase()}
                format={fmt}
            />
        );
    }

    return (
        <div className="filter">
            <div className="filter__head">
                <span className="filter__label">{metric.label}</span>
                {value}
                {onRemove && (
                    <button type="button" className="icon-btn icon-btn--xs" onClick={onRemove} aria-label={`Remove the ${metric.label} filter`} title="Remove filter">
                        <X size={12} />
                    </button>
                )}
            </div>
            {body}
        </div>
    );
}

export default RangeFilter;
