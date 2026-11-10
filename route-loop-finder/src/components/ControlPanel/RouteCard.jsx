import { forwardRef } from 'react';
import { Download, Star } from 'lucide-react';
import Sparkline from './Sparkline';
import { formatClimbRate, formatClimb, formatDistance, useUnits } from '../../utils/units';
import { formatUnpaved } from '../../utils/pathFiltering';
import { unpavedShare } from '../../utils/surface';

/** The selected card's details: what the card row does not already say, and its GPX download. */
function Details({ p, units, onDownloadGpx }) {
    const miles = p.total_miles;
    const rate = miles > 0 && typeof p.total_climb_ft === 'number' ? p.total_climb_ft / miles : null;
    const items = [
        ['Loop', formatDistance(p.loop_miles, units)],
        ['Loop share', p.loop_ratio != null ? `${Math.round(p.loop_ratio * 100)}%` : '—'],
        ['Climb rate', formatClimbRate(rate, units)],
        ['Discomfort', typeof p.discomfort === 'number' ? p.discomfort.toFixed(1) : '—'],
        ['Difficulty', p.difficulty != null ? `${p.difficulty}/10` : '—'],
        ['Unpaved', formatUnpaved(unpavedShare(p))],
    ];
    return (
        <>
            <dl className="route-card__details">
                {items.map(([label, value]) => (
                    <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                    </div>
                ))}
            </dl>
            {onDownloadGpx && (
                <div className="route-card__actions">
                    <button
                        type="button"
                        className="link-btn route-card__gpx"
                        onClick={(e) => {
                            e.stopPropagation(); // not a click on the card
                            onDownloadGpx();
                        }}
                        title="Save as a GPX file to import into Ride with GPS, Strava, Garmin…"
                    >
                        <Download size={13} /> GPX
                    </button>
                </div>
            )}
        </>
    );
}

/**
 * One route in the list: length, climb, elevation shape, a star (favorite).
 * The selected card opens up with a few more numbers. Pointer moves over it
 * are reported with onHover(id, event); the list decides what is previewed
 * on the map. A favorite is marked in the favorite colour.
 */
const RouteCard = forwardRef(function RouteCard({
    path, number, selected, onSelect, onHover, favorite = false, onToggleFavorite, onDownloadGpx,
}, ref) {
    const units = useUnits();
    const p = path.properties || {};
    return (
        <div
            ref={ref}
            role="option"
            aria-selected={selected}
            tabIndex={-1}
            className={`route-card ${selected ? 'is-selected' : ''} ${favorite ? 'is-favorite' : ''}`}
            data-route-id={path.id}
            onClick={() => onSelect(path.id)}
            onMouseMove={(e) => onHover?.(path.id, e)}
        >
            <div className="route-card__row">
                <span className="route-card__num">{number}</span>
                <span className="route-card__main">
                    <strong>{formatDistance(p.total_miles, units)}</strong>
                    <span className="route-card__climb">↗ {formatClimb(p.total_climb_ft, units)}</span>
                </span>
                <Sparkline profile={p.elevation_profile} />
                {onToggleFavorite && (
                    <button
                        type="button"
                        className={`route-card__star ${favorite ? 'is-on' : ''}`}
                        onClick={(e) => {
                            e.stopPropagation(); // a star is not a click on the card
                            onToggleFavorite(path);
                        }}
                        title={favorite ? 'Unfavorite' : 'Favorite'}
                        aria-label={favorite ? `Unfavorite route ${number}` : `Favorite route ${number}`}
                        aria-pressed={favorite}
                    >
                        <Star size={14} fill={favorite ? 'currentColor' : 'none'} />
                    </button>
                )}
            </div>
            {!selected && (
                <div className="route-card__meta">
                    {p.loop_ratio != null && <span>loop {Math.round(p.loop_ratio * 100)}%</span>}
                    {unpavedShare(p) != null && <span>{formatUnpaved(unpavedShare(p))} unpaved</span>}
                </div>
            )}
            {selected && <Details p={p} units={units} onDownloadGpx={onDownloadGpx && (() => onDownloadGpx(path))} />}
        </div>
    );
});

export default RouteCard;
