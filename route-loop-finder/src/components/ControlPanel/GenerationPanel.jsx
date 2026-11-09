import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronLeft, ChevronRight, ChevronUp, MoreHorizontal, Plus, Star, Trash2 } from 'lucide-react';
import DualRange from './DualRange';
import RangeFilter from './RangeFilter';
import RouteCard from './RouteCard';
import ToolsBar from './ToolsBar';
import { FILTER_METRICS, getFilterMetric } from '../../utils/pathFiltering';
import { PINNED_FILTERS, SORT_OPTIONS } from '../../hooks/usePathSets';
import { ROAD_PREFERENCES } from '../../utils/roadWeights';
import { describeSelections } from '../../utils/routeSelections';
import {
    displayToMiles,
    distanceUnit,
    formatDistance,
    lengthSliderRange,
    roundLength,
    useUnits,
} from '../../utils/units';
import './GenerationPanel.css';

function roadsLabel(settings) {
    if (settings.road_preference === 'custom') return 'custom road weights';
    const p = ROAD_PREFERENCES.find((x) => x.id === (settings.road_preference || 'balanced'));
    return `${(p?.label || 'Balanced').toLowerCase()} roads`;
}

function roadsShort(preference) {
    if (preference === 'custom') return 'Custom';
    return ROAD_PREFERENCES.find((x) => x.id === (preference || 'balanced'))?.label || 'Balanced';
}

function settingsRows(generation, units) {
    const s = generation.settings || {};
    const opt = (v, d) => (v == null || v === '' ? `default (${d})` : String(v));
    const rows = [
        ['Route length', `${formatDistance(s.min_path_len, units, 0)} – ${formatDistance(s.max_path_len, units, 0)}`],
        ['Search area', s.boundary?.shapes?.length ? `boundary “${s.boundary.name || 'custom'}”` : 'automatic (within reach)'],
        ['Roads', roadsLabel(s)],
        ['Loop share', s.loop_ratio == null ? '—' : `at least ${Math.round(Number(s.loop_ratio) * 100)}%`],
        ['Soften busy roads (rural)', s.rural_scale === false ? 'off' : 'on'],
        ['Explore / detour / reuse', `${opt(s.explore_weight, 2)} / ${opt(s.detour_weight, 0.3)} / ${opt(s.reuse_weight, 1)}`],
        ['Same route within', `${s.min_dist_m ?? 50} m`],
    ];
    if (s.algorithm && s.algorithm !== 'tree_guided') rows.push(['Search', s.algorithm]);
    if (generation.markerPosition) {
        rows.push(['Start', `${generation.markerPosition.lat.toFixed(4)}, ${generation.markerPosition.lng.toFixed(4)}`]);
    }
    const painted = describeSelections(generation.selections || []);
    if (painted) rows.push(['Roads and areas', painted]);
    return rows;
}

const LIST_EDGE_PX = 14; // the list fades its cards out this close to its edges
const LIST_TOP_PX = 10; // a card scrolled to the top of the list sits this far down (below the fade)
const WHEEL_NOTCH_PX = 50; // a wheel event this big is one notch of a mouse wheel
const WHEEL_CARD_PX = 66; // trackpad: about one card of movement steps one card
const WHEEL_SETTLE_MS = 700; // no scrollend event (older browsers): settled after this

/**
 * Where the list scrolls to put the next (dir 1) or previous (dir -1) card at
 * its top, going from scrollTop `from`; null at the end.
 */
function nextCardTop(list, from, dir) {
    const max = list.scrollHeight - list.clientHeight;
    const tops = [...list.querySelectorAll('.route-card')]
        .map((card) => Math.min(max, Math.max(0, card.offsetTop - LIST_TOP_PX)));
    if (dir > 0) {
        const next = tops.find((top) => top > from + 1);
        return next ?? null;
    }
    const before = tops.filter((top) => top < from - 1);
    return before.length ? before[before.length - 1] : null;
}

/**
 * Scroll the list just enough that a clicked card shows whole, but keep the
 * card under the pointer at pointerY (page px), so no other card slides there.
 */
function revealUnderPointer(list, card, pointerY) {
    const l = list.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    let delta = 0; // > 0 scrolls the list down (the card moves up)
    if (c.bottom > l.bottom - LIST_EDGE_PX) delta = c.bottom - (l.bottom - LIST_EDGE_PX);
    if (c.top - delta < l.top + LIST_EDGE_PX) delta = c.top - (l.top + LIST_EDGE_PX);
    if (pointerY != null) {
        const keep = 8; // px of the card kept between the pointer and the card's edge
        if (delta > 0) delta = Math.min(delta, Math.max(0, c.bottom - pointerY - keep));
        if (delta < 0) delta = Math.max(delta, -Math.max(0, pointerY - c.top - keep));
    }
    if (Math.abs(delta) < 1) return;
    if (typeof list.scrollTo === 'function') list.scrollTo({ top: list.scrollTop + delta, behavior: 'smooth' });
    else list.scrollTop += delta;
}

/** Which way the list runs, in words, for the direction button. */
function directionLabel(sortBy, ascending) {
    if (sortBy === 'found') return ascending ? 'Best first' : 'Best last';
    if (sortBy === 'similar') return ascending ? 'From the shortest' : 'From the longest';
    return ascending ? 'Low to high' : 'High to low';
}

/**
 * An open generation. Top to bottom: header; route through / avoid tools;
 * sort and filters; the route cards (their own scroll area, the selected card
 * kept in the middle, arrows above); More routes at the bottom.
 */
function GenerationPanel({
    generation,
    paths,
    totalCount,
    currentPath,
    onSelectPath,
    onHoverPath,
    onPrev,
    onNext,
    sortBy,
    sortAscending,
    onSort,
    onFlipSort,
    routeFilters,
    filterBounds,
    setFilterRange,
    addRouteFilter,
    removeRouteFilter,
    onClearFilters,
    isGenerating,
    statusText,
    onStop,
    onBack,
    onRename,
    onDelete,
    onNewSearchHere,
    more,
    onMoreChange,
    onMoreRoutes,
    toolsProps,
    headerActions = null,
    isFavorite = null, // (route) => boolean
    onToggleFavorite, // (route)
    favoritesOnly = false,
    onFavoritesOnly, // (on)
    favoriteCount = 0, // favorite routes in this generation
}) {
    const units = useUnits();
    const settings = generation.settings || {};
    const unit = distanceUnit(units);
    const [sliderMin, sliderMax] = lengthSliderRange(units);

    // More routes: length and roads for the next batches (App keeps them, so M uses them too).
    const setMore = (update) => onMoreChange(update(more));
    const low = roundLength(more.min_path_len, units);
    const high = roundLength(more.max_path_len, units);
    const [moreOpen, setMoreOpen] = useState(false);

    const [menuOpen, setMenuOpen] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [editing, setEditing] = useState(false);
    const [draftName, setDraftName] = useState(generation.name);

    // The selected card sits in the middle of the list (as near as the ends allow),
    // so the routes before and after it are one short move away. A clicked card
    // is the exception: it stays under the pointer (centring it would slide
    // another card under the pointer, which would preview that one). The list
    // only scrolls to show all of it (its details open below), never so far
    // that it leaves the pointer.
    const listRef = useRef(null);
    const selectedRef = useRef(null);
    const currentId = currentPath?.id;
    const pointerAt = useRef(null); // last pointer position over the list
    const clickedId = useRef(null); // a card was clicked: the selection it makes stays put
    const selectCard = useCallback((id) => {
        clickedId.current = id === currentId ? null : id;
        onSelectPath(id);
    }, [currentId, onSelectPath]);
    useLayoutEffect(() => {
        const list = listRef.current;
        const card = selectedRef.current;
        const clicked = clickedId.current != null && clickedId.current === currentId;
        clickedId.current = null;
        if (!list || !card) return;
        if (clicked) {
            revealUnderPointer(list, card, pointerAt.current?.y);
            return;
        }
        const top = card.offsetTop - (list.clientHeight - card.offsetHeight) / 2;
        const target = Math.max(0, Math.min(top, list.scrollHeight - list.clientHeight));
        if (Math.abs(list.scrollTop - target) < 1) return;
        // Glide to a nearby card; jump when it is far (a long glide is slow and disorienting).
        const far = Math.abs(list.scrollTop - target) > list.clientHeight * 1.5;
        if (typeof list.scrollTo === 'function') list.scrollTo({ top: target, behavior: far ? 'auto' : 'smooth' });
        else list.scrollTop = target;
        // Only when the selection or the order changes: new routes streaming in
        // must not pull the list away from where the user scrolled.
    }, [currentId, sortBy, sortAscending]);

    // Map preview of the card under the pointer. Crossing the gap between two
    // cards keeps the last one (no flicker); leaving the list ends it. Only a
    // real pointer move previews: when the list scrolls a card under a still
    // pointer (the arrows centre the selected card), the browser
    // reports mouse events at the same position, and those are ignored. A new
    // selection ends the preview until the pointer moves again.
    const previewId = useRef(null);
    const setPreview = useCallback((id) => {
        if (previewId.current === id) return;
        previewId.current = id;
        onHoverPath?.(id);
    }, [onHoverPath]);
    const hoverCard = useCallback((id, e) => {
        const last = pointerAt.current;
        if (last && last.x === e.clientX && last.y === e.clientY) return;
        pointerAt.current = { x: e.clientX, y: e.clientY };
        setPreview(id);
    }, [setPreview]);
    const leaveList = useCallback(() => {
        pointerAt.current = null;
        setPreview(null);
    }, [setPreview]);
    useEffect(() => {
        setPreview(null);
    }, [currentId, setPreview]);

    // The mouse wheel scrolls one card per notch (a trackpad: one card per
    // card's height of movement), so no card is skipped. Quick notches queue
    // up. When the scroll settles, the card now under the pointer is
    // previewed (the wheel moved it there on purpose).
    const pathsRef = useRef(paths);
    pathsRef.current = paths;
    useEffect(() => {
        const list = listRef.current;
        if (!list) return undefined;
        let collected = 0;
        let target = null; // where the queued steps end
        let stepping = false;
        let settleTimer = null;
        const settle = () => {
            if (!stepping) return;
            stepping = false;
            clearTimeout(settleTimer);
            target = null;
            const at = pointerAt.current;
            if (!at) return;
            const card = document.elementFromPoint(at.x, at.y)?.closest?.('.route-card');
            if (!card || !list.contains(card)) return;
            const path = pathsRef.current.find((p) => String(p.id) === card.dataset.routeId);
            if (path) setPreview(path.id);
        };
        const onWheel = (e) => {
            if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // pinch zoom, sideways
            e.preventDefault();
            let px = e.deltaY;
            if (e.deltaMode === 1) px *= 40; // lines
            else if (e.deltaMode === 2) px *= list.clientHeight; // pages
            collected += px;
            if (Math.abs(px) < WHEEL_NOTCH_PX && Math.abs(collected) < WHEEL_CARD_PX) return;
            const dir = Math.sign(collected);
            collected = 0;
            const next = nextCardTop(list, target ?? list.scrollTop, dir);
            if (next == null) return;
            target = next;
            stepping = true;
            if (typeof list.scrollTo === 'function') list.scrollTo({ top: next, behavior: 'smooth' });
            else list.scrollTop = next;
            clearTimeout(settleTimer);
            settleTimer = setTimeout(settle, WHEEL_SETTLE_MS);
        };
        list.addEventListener('wheel', onWheel, { passive: false });
        list.addEventListener('scrollend', settle);
        return () => {
            clearTimeout(settleTimer);
            list.removeEventListener('wheel', onWheel);
            list.removeEventListener('scrollend', settle);
        };
    }, [setPreview]);
    useEffect(() => () => onHoverPath?.(null), [onHoverPath]);

    const activeKeys = new Set(routeFilters.map((f) => f.key));
    const addable = FILTER_METRICS.filter((m) => !activeKeys.has(m.key));
    const filtersOn = routeFilters.some((f) => f.range[0] != null || f.range[1] != null);
    const selectionCount = toolsProps.drawnSelections.length;
    const index = currentPath ? paths.findIndex((p) => p.id === currentPath.id) : -1;
    const currentFav = !!currentPath && !!isFavorite && isFavorite(currentPath);

    const commitName = () => {
        setEditing(false);
        if (draftName.trim() && draftName.trim() !== generation.name) onRename(draftName);
        else setDraftName(generation.name);
    };

    let empty = null;
    if (paths.length === 0) {
        if (favoritesOnly) {
            empty = (
                <div className="gen-empty">
                    <span>
                        {favoriteCount > 0
                            ? 'None of the favorites match your filters.'
                            : 'No favorites here yet. Press S or a card\'s star to add the route you are on.'}
                    </span>
                    <button type="button" className="link-btn" onClick={() => onFavoritesOnly?.(false)}>Show every route</button>
                </div>
            );
        } else if (totalCount > 0) {
            empty = (
                <div className="gen-empty">
                    <span>
                        No routes match your filters
                        {selectionCount > 0 ? ' and painted roads and areas' : ''}.
                    </span>
                    {filtersOn && (
                        <button type="button" className="link-btn" onClick={onClearFilters}>Clear filters</button>
                    )}
                    {selectionCount > 0 && !isGenerating && (
                        <button type="button" className="link-btn" onClick={() => onMoreRoutes(more)}>Find more routes that fit (M)</button>
                    )}
                </div>
            );
        } else if (isGenerating) {
            empty = <div className="gen-empty">{statusText || 'Finding routes…'}</div>;
        } else {
            empty = <div className="gen-empty">{generation.lastNote || 'No routes in this generation.'}</div>;
        }
    }

    return (
        <div className="gen-panel">
            <div className="gen-panel__header">
                <button type="button" className="icon-btn" onClick={onBack} title="Back to your loops (Backspace)" aria-label="Back">
                    <ChevronLeft size={18} />
                </button>
                <div className="gen-panel__title">
                    {editing ? (
                        <input
                            className="gen-panel__name-input"
                            value={draftName}
                            autoFocus
                            onChange={(e) => setDraftName(e.target.value)}
                            onBlur={commitName}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') commitName();
                                if (e.key === 'Escape') {
                                    setDraftName(generation.name);
                                    setEditing(false);
                                }
                            }}
                            aria-label="Generation name"
                        />
                    ) : (
                        <button type="button" className="gen-panel__name" onClick={() => setEditing(true)} title={`${generation.name} (click to rename)`}>
                            {generation.name}
                        </button>
                    )}
                    <div className="gen-panel__sub">
                        {totalCount} {totalCount === 1 ? 'route' : 'routes'}
                        {paths.length !== totalCount && ` · ${paths.length} shown`}
                        {' · '}{roadsLabel(settings)}
                    </div>
                </div>
                {headerActions}
                <div className="gen-menu">
                    <button
                        type="button"
                        className="icon-btn"
                        onClick={() => setMenuOpen((o) => !o)}
                        aria-label="More"
                        aria-expanded={menuOpen}
                    >
                        <MoreHorizontal size={18} />
                    </button>
                    {menuOpen && (
                        <div className="menu" onMouseLeave={() => setMenuOpen(false)}>
                            <button type="button" onClick={() => { setMenuOpen(false); setEditing(true); }}>Rename</button>
                            <button type="button" onClick={() => { setMenuOpen(false); onNewSearchHere(); }} title="Back to the plan with this start and settings: add to this set, or start a new one">Plan again from here</button>
                            <button type="button" onClick={() => { setMenuOpen(false); setShowSettings((v) => !v); }}>
                                {showSettings ? 'Hide settings used' : 'Settings used'}
                            </button>
                            <button type="button" className="is-danger" onClick={() => { setMenuOpen(false); onDelete(); }}>
                                <Trash2 size={14} /> Delete
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {showSettings && (
                <div className="gen-settings">
                    {settingsRows(generation, units).map(([k, v]) => (
                        <div key={k} className="gen-settings__row"><span>{k}</span><span>{v}</span></div>
                    ))}
                </div>
            )}

            <div className="panel-section">
                <ToolsBar {...toolsProps} mode="display" />
            </div>

            <div className="panel-section gen-controls">
                <div className="sort-row">
                    <label className="section-label" htmlFor="sort-by">Sort</label>
                    <select
                        id="sort-by"
                        className="select"
                        value={sortBy}
                        onChange={(e) => onSort(e.target.value)}
                    >
                        {SORT_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                    <button
                        type="button"
                        className="icon-btn icon-btn--boxed"
                        onClick={onFlipSort}
                        title={`${directionLabel(sortBy, sortAscending)}. Click to reverse (shows the new first route).`}
                        aria-label={`Reverse the order (now ${directionLabel(sortBy, sortAscending).toLowerCase()})`}
                    >
                        {sortAscending ? <ArrowUpNarrowWide size={16} /> : <ArrowDownWideNarrow size={16} />}
                    </button>
                </div>

                {routeFilters.map((filter) => {
                    const metric = getFilterMetric(filter.key);
                    if (!metric) return null;
                    return (
                        <RangeFilter
                            key={filter.key}
                            metric={metric}
                            bounds={filterBounds?.[filter.key]}
                            range={filter.range}
                            onChange={(range) => setFilterRange(filter.key, range)}
                            onRemove={PINNED_FILTERS.includes(filter.key) ? null : () => removeRouteFilter(filter.key)}
                        />
                    );
                })}

                <div className="filters-foot">
                    {addable.length > 0 && (
                        <label className="add-filter" title="Add a filter">
                            <Plus size={12} />
                            <span>Filter</span>
                            <select
                                value=""
                                onChange={(e) => { if (e.target.value) addRouteFilter(e.target.value); }}
                                aria-label="Add a filter"
                            >
                                <option value="">Add a filter…</option>
                                {addable.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                            </select>
                        </label>
                    )}
                    {filtersOn && (
                        <button type="button" className="link-btn" onClick={onClearFilters}>Clear filters</button>
                    )}
                    {onFavoritesOnly && (
                        <button
                            type="button"
                            className={`fav-toggle ${favoritesOnly ? 'is-on' : ''}`}
                            onClick={() => onFavoritesOnly(!favoritesOnly)}
                            aria-pressed={favoritesOnly}
                            title={favoritesOnly ? 'Show every route' : 'Show only the favorite routes'}
                        >
                            <Star size={12} fill={favoritesOnly ? 'currentColor' : 'none'} />
                            <span>Favorites</span>
                            <span className="fav-toggle__count">{favoriteCount}</span>
                        </button>
                    )}
                </div>
            </div>

            <div className="gen-routes">
                <div className="route-nav">
                    <button
                        type="button"
                        className="icon-btn icon-btn--boxed"
                        onClick={onPrev}
                        disabled={index <= 0}
                        title="Previous route (← or ↑)"
                        aria-label="Previous route"
                    >
                        <ChevronLeft size={16} />
                    </button>
                    <span className="route-nav__label" aria-live="polite">
                        {paths.length ? `${favoritesOnly ? 'Favorite' : 'Route'} ${index + 1} of ${paths.length}` : 'No routes'}
                        {onToggleFavorite && currentPath && (
                            <button
                                type="button"
                                className={`route-nav__star ${currentFav ? 'is-on' : ''}`}
                                onClick={() => onToggleFavorite(currentPath)}
                                title={currentFav ? 'Unfavorite this route (S)' : 'Favorite this route (S)'}
                                aria-label={currentFav ? 'Unfavorite this route' : 'Favorite this route'}
                                aria-pressed={currentFav}
                            >
                                <Star size={15} fill={currentFav ? 'currentColor' : 'none'} />
                            </button>
                        )}
                    </span>
                    <button
                        type="button"
                        className="icon-btn icon-btn--boxed"
                        onClick={onNext}
                        disabled={index < 0 || index >= paths.length - 1}
                        title="Next route (→ or ↓)"
                        aria-label="Next route"
                    >
                        <ChevronRight size={16} />
                    </button>
                </div>
                <div className="route-list" role="listbox" aria-label="Routes" ref={listRef} onMouseLeave={leaveList}>
                    {paths.map((path, i) => (
                        <RouteCard
                            key={path.id}
                            ref={path.id === currentId ? selectedRef : undefined}
                            path={path}
                            number={i + 1}
                            selected={path.id === currentId}
                            onSelect={selectCard}
                            onHover={hoverCard}
                            favorite={!!isFavorite && isFavorite(path)}
                            onToggleFavorite={onToggleFavorite}
                        />
                    ))}
                    {empty}
                </div>
            </div>

            <div className="gen-more">
                {moreOpen && (
                    <div className="gen-more__options">
                        <div className="field-row">
                            <span className="section-label">Length</span>
                            <span className="field-value">{low === high ? `${low} ${unit}` : `${low}–${high} ${unit}`}</span>
                        </div>
                        <DualRange
                            min={sliderMin}
                            max={sliderMax}
                            low={low}
                            high={high}
                            onChange={(lo, hi) => setMore((m) => ({
                                ...m,
                                min_path_len: Number(displayToMiles(lo, units).toFixed(3)),
                                max_path_len: Number(displayToMiles(hi, units).toFixed(3)),
                            }))}
                            label="route length"
                            format={(v) => `${v} ${unit}`}
                        />
                        <div className="segmented segmented--small" role="group" aria-label="Roads for more routes">
                            {ROAD_PREFERENCES.map((p) => (
                                <button
                                    key={p.id}
                                    type="button"
                                    className={more.road_preference === p.id ? 'is-active' : ''}
                                    onClick={() => setMore((m) => ({ ...m, road_preference: p.id }))}
                                    title={p.hint}
                                >
                                    {p.label}
                                </button>
                            ))}
                            {more.road_preference === 'custom' && (
                                <button type="button" className="is-active" title="Custom road weights">Custom</button>
                            )}
                        </div>
                    </div>
                )}
                <div className="gen-more__row">
                    {isGenerating ? (
                        <div className="busy">
                            <span className="busy__dot" />
                            <span className="busy__text">{statusText || `Finding routes… ${totalCount}`}</span>
                            <button type="button" className="link-btn" onClick={onStop} title="Stop (Esc)">Stop</button>
                        </div>
                    ) : (
                        <button
                            type="button"
                            className="btn-primary gen-more__go"
                            onClick={() => onMoreRoutes(more)}
                            title="Find more routes with these settings, through your green roads and areas (M)"
                        >
                            More routes
                        </button>
                    )}
                    <button
                        type="button"
                        className={`gen-more__settings ${moreOpen ? 'is-open' : ''}`}
                        onClick={() => setMoreOpen((o) => !o)}
                        aria-expanded={moreOpen}
                        title="Length and roads for more routes"
                    >
                        <span>{low === high ? `${low}` : `${low}–${high}`} {unit} · {roadsShort(more.road_preference)}</span>
                        <ChevronUp size={14} />
                    </button>
                </div>
            </div>
        </div>
    );
}

export default GenerationPanel;
