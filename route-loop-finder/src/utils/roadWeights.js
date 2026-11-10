/** Turns charged per mile for each highway class. 0 is free. */

export const DEFAULT_ROAD_WEIGHTS = {
    cycleway: 0,
    path: 0,
    pedestrian: 0,
    living_street: 0,
    residential: 0,
    unclassified: 0,
    tertiary: 0,
    secondary: 1,
    primary: 4,
    trunk: 12,
};

export const ROAD_WEIGHT_FIELDS = [
    ['cycleway', 'Cycleway'],
    ['path', 'Path'],
    ['pedestrian', 'Pedestrian'],
    ['living_street', 'Living street'],
    ['residential', 'Residential'],
    ['unclassified', 'Unclassified'],
    ['tertiary', 'Tertiary'],
    ['secondary', 'Secondary'],
    ['primary', 'Primary'],
    ['trunk', 'Trunk'],
];

/**
 * Roads choice -> multiplier on every busy-road class (same as the server's
 * road_stress.PREFERENCE_SCALE). 'custom' uses the Advanced table as is.
 */
export const ROAD_PREFERENCES = [
    { id: 'quiet', label: 'Quiet', scale: 2, short: 'Stays off busy roads', hint: 'Stays off busy roads, even if the loop has more turns.' },
    { id: 'balanced', label: 'Balanced', scale: 1, short: 'Busy roads only when much shorter', hint: 'Avoids busy roads when a quiet way is not much longer.' },
    { id: 'any', label: 'Any', scale: 0.4, short: 'Busy roads are fine', hint: 'Takes busy roads when they make a simpler loop.' },
];

/** Weights a Roads choice uses (for showing in the Advanced table). */
export function weightsForPreference(preference, custom) {
    if (preference === 'custom') return normalizeRoadWeights(custom);
    const scale = ROAD_PREFERENCES.find((p) => p.id === preference)?.scale ?? 1;
    const out = {};
    Object.entries(DEFAULT_ROAD_WEIGHTS).forEach(([key, w]) => { out[key] = Math.round(w * scale * 100) / 100; });
    return out;
}

export function normalizeRoadWeights(saved) {
    const weights = { ...DEFAULT_ROAD_WEIGHTS };
    if (!saved || typeof saved !== 'object') return weights;
    for (const key of Object.keys(DEFAULT_ROAD_WEIGHTS)) {
        const num = Number(saved[key]);
        if (Number.isFinite(num) && num >= 0) weights[key] = num;
    }
    return weights;
}
