import { sortBySimilarity } from './routeSelections';

/**
 * Filter paths by distance range.
 * Uses loop_miles property from path GeoJSON.
 */
export function filterByDistance(paths, minMiles, maxMiles) {
    return paths.filter(path => {
        // Use total_miles as provided by the backend
        const dist = path.properties?.total_miles ?? 0;
        return dist >= minMiles && dist <= maxMiles;
    });
}

/**
 * Filter paths by difficulty range (1-10 scale).
 */
export function filterByDifficulty(paths, minDifficulty, maxDifficulty) {
    return paths.filter(path => {
        const diff = path.properties?.difficulty ?? 1;
        return diff >= minDifficulty && diff <= maxDifficulty;
    });
}

/**
 * Sort paths by a property.
 * 'similar' walks routes that share ground, starting at the shortest or longest.
 */
export function sortPaths(paths, sortBy = 'loop_miles', ascending = true) {
    if (sortBy === 'similar' || sortBy === 'spatial') {
        return sortBySimilarity(paths, ascending);
    }

    return [...paths].sort((a, b) => {
        const aVal = a.properties?.[sortBy] ?? 0;
        const bVal = b.properties?.[sortBy] ?? 0;
        return ascending ? aVal - bVal : bVal - aVal;
    });
}
