import { ChevronLeft } from 'lucide-react';
import { ROAD_WEIGHT_FIELDS, weightsForPreference } from '../../utils/roadWeights';

function NumberField({ label, title, value, placeholder, onChange, min, max, step = 1 }) {
    return (
        <label className="setting-item" title={title}>
            <span>{label}</span>
            <input
                type="number"
                value={value ?? ''}
                placeholder={placeholder}
                min={min}
                max={max}
                step={step}
                onChange={(e) => {
                    const num = parseFloat(e.target.value);
                    onChange(Number.isFinite(num) ? num : null);
                }}
            />
        </label>
    );
}

/**
 * Advanced search settings: a page of its own over the whole panel, opened
 * from the bottom of the plan and closed with Back (or Esc).
 */
function AdvancedSettings({ genSettings, setGenSettings, algorithmOptions = [], onClose }) {
    const set = (patch) => setGenSettings((prev) => ({ ...prev, ...patch }));
    const preference = genSettings.road_preference || 'balanced';
    const weights = weightsForPreference(preference, genSettings.road_weights);
    const optional = (key) => (value) => set({ [key]: value != null && value >= 0 ? value : null });

    return (
        <div className="advanced">
            <div className="advanced__header">
                <button type="button" className="icon-btn" onClick={onClose} aria-label="Back to the plan" title="Back (Esc)">
                    <ChevronLeft size={18} />
                </button>
                <span className="panel-title">Advanced settings</span>
            </div>

            <div className="advanced__body">
                <section className="advanced__section">
                    <div className="field-row">
                        <span className="section-label">Loop share</span>
                        <span className="field-value">at least {Math.round((genSettings.loop_ratio ?? 0.5) * 100)}%</span>
                    </div>
                    <input
                        className="single-slider"
                        type="range"
                        min="0.2"
                        max="0.9"
                        step="0.05"
                        value={genSettings.loop_ratio ?? 0.5}
                        onChange={(e) => set({ loop_ratio: Number(e.target.value) })}
                        aria-label="Loop share"
                    />
                    <p className="hint">Each route is mostly loop; the rest is the same road out and back.</p>
                </section>

                <section className="advanced__section">
                    <span className="section-label">Search</span>
                    <div className="settings-grid">
                        <NumberField
                            label="First batch"
                            title="Routes found when you press Find loops"
                            value={genSettings.num_paths}
                            onChange={(v) => set({ num_paths: v == null ? 20 : Math.max(1, Math.round(v)) })}
                            min={1}
                            max={200}
                        />
                        <NumberField
                            label="More routes batch"
                            title="Routes found each time you ask for more (M, a green road or area)"
                            value={genSettings.routes_per_pin}
                            onChange={(v) => set({ routes_per_pin: v == null ? 10 : Math.max(1, Math.round(v)) })}
                            min={1}
                            max={100}
                        />
                        <NumberField
                            label="Explore weight"
                            title="How strongly routes are pushed toward areas not shown yet. 0 turns it off."
                            value={genSettings.explore_weight}
                            placeholder="2"
                            onChange={optional('explore_weight')}
                            min={0}
                            max={10}
                            step={0.5}
                        />
                        <NumberField
                            label="Detour cost"
                            title="Turns per mile charged for distance. Higher keeps each side more direct; lower lets it detour onto quieter roads."
                            value={genSettings.detour_weight}
                            placeholder="0.3"
                            onChange={optional('detour_weight')}
                            min={0}
                            max={5}
                            step={0.1}
                        />
                        <NumberField
                            label="Reuse penalty"
                            title="Turns per mile added to roads already used by a route, so later rounds find alternatives."
                            value={genSettings.reuse_weight}
                            placeholder="1"
                            onChange={optional('reuse_weight')}
                            min={0}
                            max={10}
                            step={0.5}
                        />
                        <NumberField
                            label="Same route within (m)"
                            title="Two routes whose centers are closer than this count as the same route"
                            value={genSettings.min_dist_m}
                            placeholder="50"
                            onChange={(v) => set({ min_dist_m: v == null ? 50 : Math.max(10, v) })}
                            min={10}
                            max={1000}
                            step={10}
                        />
                        {algorithmOptions.length > 1 && (
                            <label className="setting-item full-width">
                                <span>Search (LOOP_DEV)</span>
                                <select
                                    value={genSettings.algorithm}
                                    onChange={(e) => set({ algorithm: e.target.value, more_algorithm: e.target.value })}
                                >
                                    {algorithmOptions.map((opt) => (
                                        <option key={opt.id} value={opt.id}>{opt.label}</option>
                                    ))}
                                </select>
                            </label>
                        )}
                    </div>
                </section>

                <section className="advanced__section">
                    <div className="field-row">
                        <span className="section-label">Road weights</span>
                        {preference === 'custom' && (
                            <button type="button" className="link-btn" onClick={() => set({ road_preference: 'balanced' })}>
                                Reset
                            </button>
                        )}
                    </div>
                    <p className="hint">
                        Extra turns charged per mile on each kind of road (0 is free). Editing a number
                        switches Roads to Custom. A bike lane still cuts a costly road.
                    </p>
                    <div className="settings-grid">
                        {ROAD_WEIGHT_FIELDS.map(([key, label]) => (
                            <NumberField
                                key={key}
                                label={label}
                                value={weights[key]}
                                min={0}
                                step={0.1}
                                onChange={(v) => set({
                                    road_preference: 'custom',
                                    road_weights: { ...weights, [key]: v != null && v >= 0 ? v : 0 },
                                })}
                            />
                        ))}
                    </div>
                    <label className="check">
                        <input
                            type="checkbox"
                            checked={genSettings.rural_scale !== false}
                            onChange={(e) => set({ rural_scale: e.target.checked })}
                        />
                        <span>Soften busy roads in rural areas (where quiet roads are scarce)</span>
                    </label>
                </section>
            </div>
        </div>
    );
}

export default AdvancedSettings;
