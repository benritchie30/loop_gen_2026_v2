import { sortBySimilarity } from './routeSelections';

/**
 * Sort-by fields that can also be range filters. Similar routes is excluded.
 * Slider ends come from the active route set; `decimals` sets the step.
 */
export const FILTER_METRICS = [
    {
        key: 'total_miles',
        label: 'Distance',
        decimals: 1,
        format: (value) => `${value.toFixed(1)} mi`,
    },
    {
        key: 'difficulty',
        label: 'Difficulty',
        decimals: 1,
        format: (value) => value.toFixed(1),
    },
    {
        key: 'total_climb_ft',
        label: 'Total Climbing Distance',
        decimals: 0,
        format: (value) => `${Math.round(value)} ft`,
    },
    {
        key: 'climb_rate',
        label: 'Climb Rate',
        decimals: 0,
        format: (value) => `${Math.round(value)} ft/mi`,
        derive: (path) => {
            const climb = propertyValue(path, 'total_climb_ft');
            const miles = propertyValue(path, 'total_miles');
            return climb != null && miles > 0 ? climb / miles : null;
        },
    },
    {
        key: 'loop_ratio',
        label: 'Loop Path Percentage',
        decimals: 2,
        format: (value) => `${Math.round(value * 100)}%`,
    },
    {
        key: 'turns',
        label: 'Number of Turns',
        decimals: 0,
        format: (value) => String(Math.round(value)),
    },
    {
        key: 'discomfort',
        label: 'Discomfort',
        decimals: 1,
        format: (value) => value.toFixed(1),
    },
];

export const OPEN_RANGE = [null, null];

export function getFilterMetric(key) {
    return FILTER_METRICS.find((metric) => metric.key === key) || null;
}

function propertyValue(path, key) {
    const raw = path?.properties?.[key];
    if (raw == null || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

/** Metrics with `derive` are computed from other properties instead of read directly. */
function metricValue(path, key) {
    const derive = getFilterMetric(key)?.derive;
    return derive ? derive(path) : propertyValue(path, key);
}

/**
 * Slider ends for one metric across a route set, rounded outward to the step.
 * Returns null when no route has the value.
 */
export function metricBounds(paths, metric) {
    let lo = Infinity;
    let hi = -Infinity;
    (paths || []).forEach((path) => {
        const value = metricValue(path, metric.key);
        if (value == null) return;
        if (value < lo) lo = value;
        if (value > hi) hi = value;
    });
    if (lo === Infinity) return null;
    const scale = 10 ** metric.decimals;
    return {
        min: Math.floor(lo * scale + 1e-9) / scale,
        max: Math.ceil(hi * scale - 1e-9) / scale,
        step: 1 / scale,
    };
}

function cleanLimit(value) {
    if (value == null || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

/**
 * Drop unknown or repeated keys. A null limit is an open end that follows the set.
 */
export function sanitizeRouteFilters(filters) {
    if (!Array.isArray(filters)) return [];
    const seen = new Set();
    const clean = [];
    filters.forEach((filter) => {
        const metric = getFilterMetric(filter?.key);
        if (!metric || seen.has(metric.key)) return;
        seen.add(metric.key);
        let min = cleanLimit(filter.range?.[0]);
        let max = cleanLimit(filter.range?.[1]);
        if (min != null && max != null && min > max) [min, max] = [max, min];
        clean.push({ key: metric.key, range: [min, max] });
    });
    return clean;
}

/** Keep paths inside every slider. Routes without the value are kept. */
export function filterByMetrics(paths, filters) {
    const active = sanitizeRouteFilters(filters)
        .filter((filter) => filter.range[0] != null || filter.range[1] != null);
    if (active.length === 0) return paths;

    return paths.filter((path) => active.every((filter) => {
        const value = metricValue(path, filter.key);
        if (value == null) return true;
        const [min, max] = filter.range;
        if (min != null && value < min) return false;
        if (max != null && value > max) return false;
        return true;
    }));
}

/**
 * Sort paths by a property.
 * 'found' keeps the order the search yielded them (best first).
 * 'similar' walks routes that share ground, starting at the shortest or longest.
 */
export function sortPaths(paths, sortBy = 'loop_miles', ascending = true) {
    if (sortBy === 'found') {
        const ordered = [...paths];
        return ascending ? ordered : ordered.reverse();
    }
    if (sortBy === 'similar' || sortBy === 'spatial') {
        return sortBySimilarity(paths, ascending);
    }

    return [...paths].sort((a, b) => {
        const aVal = metricValue(a, sortBy) ?? 0;
        const bVal = metricValue(b, sortBy) ?? 0;
        return ascending ? aVal - bVal : bVal - aVal;
    });
}
