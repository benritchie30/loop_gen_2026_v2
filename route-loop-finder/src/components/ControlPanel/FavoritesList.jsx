import { ChevronRight, MapPin, Star } from 'lucide-react';
import Sparkline from './Sparkline';
import { formatClimb, formatDistance, useUnits } from '../../utils/units';

/**
 * Every favorite (the plan's Favorites tab), grouped by start. A row selects
 * its route (bold on the map, elevation shown); hovering previews it. A
 * group opens its generation in favorites only, or, when none is left,
 * puts the start pin there. Hovering a group highlights its pin. Like the
 * route cards, a preview only ends when the pointer leaves the list.
 */
function FavoritesList({
    groups,
    total, // every favorite, before the painted roads and areas filter them
    selectedId,
    onSelect,
    onHover,
    isFavorite,
    onToggleFavorite, // (path)
    onOpenGroup, // (group)
    onPlanHere, // (group)
    onHoverGroup, // (generation id | null)
}) {
    const units = useUnits();
    if (!total) {
        return (
            <div className="gen-empty fav-list__empty">
                No favorites yet. Open a set and press S (or a card&rsquo;s star) on a route you like.
            </div>
        );
    }
    if (!groups.length) {
        return <div className="gen-empty fav-list__empty">No favorite goes through your painted roads and areas.</div>;
    }
    return (
        <div
            className="fav-list"
            onMouseLeave={() => {
                onHover?.(null);
                onHoverGroup?.(null);
            }}
        >
            {groups.map((group) => (
                <section key={group.key} className="fav-group">
                    <div className="fav-group__head" onMouseEnter={() => onHoverGroup?.(group.setId)}>
                        <span className="fav-group__title" title={group.title}>{group.title}</span>
                        <span className="fav-group__count">{group.records.length}</span>
                        {group.setId ? (
                            <button
                                type="button"
                                className="link-btn fav-group__action"
                                onClick={() => onOpenGroup?.(group)}
                                title="Open this set, showing its favorites"
                            >
                                Open <ChevronRight size={12} />
                            </button>
                        ) : group.position && (
                            <button
                                type="button"
                                className="link-btn fav-group__action"
                                onClick={() => onPlanHere?.(group)}
                                title="Its set was deleted: put the start pin here"
                            >
                                <MapPin size={12} /> Plan here
                            </button>
                        )}
                    </div>
                    <ul className="fav-group__rows">
                        {group.records.map((record) => {
                            const { path } = record;
                            const p = path.properties || {};
                            const selected = path.id === selectedId;
                            const favorite = isFavorite ? isFavorite(path) : true;
                            return (
                                <li
                                    key={record.key}
                                    className={`fav-row ${selected ? 'is-selected' : ''}`}
                                    onClick={() => onSelect?.(path.id)}
                                    onMouseEnter={() => {
                                        onHover?.(path.id);
                                        onHoverGroup?.(group.setId);
                                    }}
                                    data-route-id={path.id}
                                >
                                    <span className="fav-row__main">
                                        <strong>{formatDistance(p.total_miles, units)}</strong>
                                        <span className="fav-row__climb">↗ {formatClimb(p.total_climb_ft, units)}</span>
                                    </span>
                                    <Sparkline profile={p.elevation_profile} />
                                    <button
                                        type="button"
                                        className={`route-card__star ${favorite ? 'is-on' : ''}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onToggleFavorite?.(path);
                                        }}
                                        title={favorite ? 'Unfavorite' : 'Favorite again'}
                                        aria-label={favorite ? 'Unfavorite' : 'Favorite again'}
                                        aria-pressed={favorite}
                                    >
                                        <Star size={14} fill={favorite ? 'currentColor' : 'none'} />
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                </section>
            ))}
        </div>
    );
}

export default FavoritesList;
