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

const withDefaults = (overrides) => ({ ...DEFAULT_ROAD_WEIGHTS, ...overrides });

export const ROAD_WEIGHT_PRESETS = [
    {
        id: 'current',
        label: 'Current',
        rural_scale: true,
        weights: withDefaults({}),
    },
    {
        id: 'charlotte_cycle',
        label: 'Charlotte cycle',
        rural_scale: false,
        weights: withDefaults({
            unclassified: 0.25,
            tertiary: 1.5,
            secondary: 2.5,
            primary: 6,
            trunk: 12,
        }),
    },
    {
        id: 'charlotte_strict',
        label: 'Charlotte strict',
        rural_scale: false,
        weights: withDefaults({
            unclassified: 1,
            tertiary: 3,
            secondary: 5,
            primary: 8,
            trunk: 16,
        }),
    },
    {
        id: 'rural',
        label: 'Rural',
        rural_scale: false,
        weights: withDefaults({
            residential: 0.5,
            unclassified: 0,
            tertiary: 0,
            secondary: 0.5,
            primary: 2,
            trunk: 6,
        }),
    },
];

export function normalizeRoadWeights(saved) {
    const weights = { ...DEFAULT_ROAD_WEIGHTS };
    if (!saved || typeof saved !== 'object') return weights;
    for (const key of Object.keys(DEFAULT_ROAD_WEIGHTS)) {
        const num = Number(saved[key]);
        if (Number.isFinite(num) && num >= 0) weights[key] = num;
    }
    return weights;
}
