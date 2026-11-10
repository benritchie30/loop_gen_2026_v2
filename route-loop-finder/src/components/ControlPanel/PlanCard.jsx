import { Pencil } from 'lucide-react';
import DualRange from './DualRange';
import { boundaryContains } from '../../utils/boundary';
import ToolsBar from './ToolsBar';
import { mapProgressText } from '../../utils/mapProgress';
import { ROAD_PREFERENCES } from '../../utils/roadWeights';
import { SURFACE_PREFERENCES, surfacePreference } from '../../utils/surface';
import {
    displayToMiles,
    distanceUnit,
    lengthSliderRange,
    milesToDisplay,
    roundLength,
} from '../../utils/units';
import './PlanCard.css';

/** One line about the start pin's map data (PREFETCH_AREA / MAP_PROGRESS / AREA_READY). */
function areaStatusText(area) {
    if (!area) return 'Click the map or search a place to set the start.';
    if (area.status === 'download' || area.status === 'build' || area.status === 'queue') return mapProgressText(area);
    if (area.status === 'ready') return 'Map ready';
    if (area.status === 'error') return area.error || 'Map data could not be loaded.';
    return 'Checking map data…';
}

/** "12 routes · 5.2–14.8 mi" for a generation in the start choice. */
function setSummary(g, units) {
    const routes = `${g.pathCount} ${g.pathCount === 1 ? 'route' : 'routes'}`;
    if (!g.lengthRange) return routes;
    const [lo, hi] = g.lengthRange.map((miles) => milesToDisplay(miles, units).toFixed(1));
    return `${routes} · ${lo === hi ? lo : `${lo}–${hi}`} ${distanceUnit(units)}`;
}

/**
 * Plan a loop: where (the start), how long, which roads, roads and areas to
 * go through or avoid, Find loops. The rest is on the Advanced page. When
 * generations already start where the pin is, Find loops adds to one of them
 * (the newest, unless another one or "New set" is chosen).
 */
function PlanCard({
    genSettings,
    setGenSettings,
    units,
    setUnits,
    pinArea,
    pinName,
    hasStart,
    onGenerate,
    toolsProps,
    setsHere = [], // generations that start where the pin is, newest first
    addToId = null, // the one Find loops adds to (null: a new generation)
    onChooseStart, // (id | null)
    boundary = null, // { boundaries, selected, onChoose, onNew, onEdit, pinOutside }: the search area
}) {
    const set = (patch) => setGenSettings((prev) => ({ ...prev, ...patch }));

    const [sliderMin, sliderMax] = lengthSliderRange(units);
    const unit = distanceUnit(units);
    const low = roundLength(genSettings.min_path_len, units);
    const high = roundLength(genSettings.max_path_len, units);
    const setLength = (lo, hi) => set({
        min_path_len: Number(displayToMiles(lo, units).toFixed(3)),
        max_path_len: Number(displayToMiles(hi, units).toFixed(3)),
    });

    const preference = genSettings.road_preference || 'balanced';
    const prefInfo = ROAD_PREFERENCES.find((p) => p.id === preference);
    const surface = surfacePreference(genSettings.surface_preference);
    const surfaceInfo = SURFACE_PREFERENCES.find((p) => p.id === surface);
    const status = hasStart ? pinArea?.status || 'checking' : 'none';
    const pin = hasStart && pinArea ? pinArea : null;

    return (
        <div className="plan-card">
            <div className={`area-status area-status--${status}`}>
                <span className="area-status__dot" />
                <span className="area-status__text">
                    {pinName && hasStart && <strong>{pinName}</strong>}
                    <span>{hasStart ? areaStatusText(pinArea) : areaStatusText(null)}</span>
                </span>
            </div>

            <div className="field">
                <div className="field-row">
                    <span
                        className="section-label"
                        title={`The whole ride, there and back. Routes stay inside the dashed circle (${Math.round(high / 2)} ${unit} from the start).`}
                    >
                        Route length
                    </span>
                    <span className="field-value field-value--big">
                        {low === high ? `${low} ${unit}` : `${low}–${high} ${unit}`}
                    </span>
                    <div className="segmented segmented--tiny" role="group" aria-label="Units">
                        {['mi', 'km'].map((u) => (
                            <button
                                key={u}
                                type="button"
                                className={units === u ? 'is-active' : ''}
                                onClick={() => setUnits(u)}
                                aria-pressed={units === u}
                            >
                                {u}
                            </button>
                        ))}
                    </div>
                </div>
                <DualRange
                    min={sliderMin}
                    max={sliderMax}
                    low={low}
                    high={high}
                    onChange={setLength}
                    label="route length"
                    format={(v) => `${v} ${unit}`}
                />
            </div>

            <div className="field">
                <div className="field-row">
                    <span className="section-label">Roads</span>
                    <span className="field-hint" title={prefInfo?.hint}>{prefInfo ? prefInfo.short : 'Custom weights (Advanced)'}</span>
                </div>
                <div className="segmented" role="group" aria-label="Roads">
                    {ROAD_PREFERENCES.map((p) => (
                        <button
                            key={p.id}
                            type="button"
                            className={preference === p.id ? 'is-active' : ''}
                            onClick={() => set({ road_preference: p.id })}
                            aria-pressed={preference === p.id}
                            title={p.hint}
                        >
                            {p.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="field">
                <div className="field-row">
                    <span className="section-label">Surface</span>
                    <span className="field-hint" title={surfaceInfo.hint}>{surfaceInfo.short}</span>
                </div>
                <div className="segmented" role="group" aria-label="Surface">
                    {SURFACE_PREFERENCES.map((p) => (
                        <button
                            key={p.id}
                            type="button"
                            className={surface === p.id ? 'is-active' : ''}
                            onClick={() => set({ surface_preference: p.id })}
                            aria-pressed={surface === p.id}
                            title={p.hint}
                        >
                            {p.label}
                        </button>
                    ))}
                </div>
            </div>

            {boundary && (
                <div className="field search-area">
                    <div className="field-row">
                        <span
                            className="section-label"
                            title="Automatic: every road within reach of the start. A boundary: only the roads inside the shapes you drew."
                        >
                            Search area
                        </span>
                        {boundary.pinOutside && (
                            <span className="field-hint search-area__warn" title="The start moves to the nearest road inside the boundary">
                                start outside it
                            </span>
                        )}
                    </div>
                    <div className="search-area__row">
                        <select
                            value={boundary.selected?.id || ''}
                            onChange={(e) => {
                                if (e.target.value === '__new') boundary.onNew();
                                else boundary.onChoose(e.target.value || null);
                            }}
                            aria-label="Search area"
                        >
                            <option value="">Automatic (within reach)</option>
                            {[...boundary.boundaries]
                                // Boundaries around the start first.
                                .sort((a, b) => Number(!!pin && boundaryContains(b, pin.lat, pin.lng))
                                    - Number(!!pin && boundaryContains(a, pin.lat, pin.lng)))
                                .map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                            <option value="__new">New boundary…</option>
                        </select>
                        {boundary.selected && (
                            <button type="button" className="icon-btn" onClick={boundary.onEdit} title="Edit this boundary" aria-label="Edit the boundary">
                                <Pencil size={15} />
                            </button>
                        )}
                    </div>
                </div>
            )}

            <div className="field">
                <span className="section-label" title="Green roads and areas must be on every route; red ones are avoided.">
                    Route through / avoid
                </span>
                <ToolsBar {...toolsProps} mode="input" />
            </div>

            {hasStart && setsHere.length > 0 && (
                <div className="field start-choice">
                    <span className="section-label" title="Add the new loops to a set that starts here, or make a new set">
                        Loops from here
                    </span>
                    <div className="start-choice__list" role="radiogroup" aria-label="Add the loops to">
                        {setsHere.map((g) => (
                            <label key={g.id} className={`start-choice__row ${addToId === g.id ? 'is-active' : ''}`}>
                                <input
                                    type="radio"
                                    name="start-choice"
                                    checked={addToId === g.id}
                                    onChange={() => onChooseStart?.(g.id)}
                                />
                                <span className="start-choice__name">{g.name}</span>
                                <span className="start-choice__meta">{setSummary(g, units)}</span>
                            </label>
                        ))}
                        <label className={`start-choice__row ${addToId === null ? 'is-active' : ''}`}>
                            <input
                                type="radio"
                                name="start-choice"
                                checked={addToId === null}
                                onChange={() => onChooseStart?.(null)}
                            />
                            <span className="start-choice__name">New set</span>
                        </label>
                    </div>
                </div>
            )}

            <button
                type="button"
                className="btn-primary btn-primary--big"
                onClick={onGenerate}
                disabled={!hasStart}
                title={addToId
                    ? `Add loops to “${setsHere.find((g) => g.id === addToId)?.name}” (Enter)`
                    : 'Find loops from the start (Enter)'}
            >
                {addToId ? 'Add loops' : 'Find loops'}
            </button>
        </div>
    );
}

export default PlanCard;
