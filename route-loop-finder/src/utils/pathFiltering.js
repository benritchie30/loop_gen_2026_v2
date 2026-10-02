/* global BigInt */

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
 * Filter paths based on inclusion and exclusion masks.
 * strictIncludeMasks: Array of BigInts. Path must visit ALL nodes in EACH mask. (For 'path' tool)
 * looseIncludeMasks: Array of BigInts. Path must visit AT LEAST ONE node in EACH mask. (For 'lasso' tool)
 * excludeMask: BigInt. Path must NOT visit ANY node in this mask.
 */
export function filterBySelection(paths, strictIncludeMasks, looseIncludeMasks, excludeMask) {
    return paths.filter(path => {
        const visited = BigInt(path.properties?.visited || '0');

        // Check exclusion (must not touch any excluded nodes)
        if (excludeMask && excludeMask > BigInt(0)) {
            if ((visited & excludeMask) !== BigInt(0)) {
                return false;
            }
        }

        // Check STRICT inclusion (must touch ALL nodes in EACH strict mask)
        // Used for "Draw Path" - we want the path to follow the drawn line exactly.
        if (strictIncludeMasks && strictIncludeMasks.length > 0) {
            for (const mask of strictIncludeMasks) {
                if (mask > BigInt(0)) {
                    // (visited & mask) must equal mask
                    // This means every bit set in 'mask' is also set in 'visited'
                    if ((visited & mask) !== mask) {
                        return false;
                    }
                }
            }
        }

        // Check LOOSE inclusion (must touch at least one node in EACH loose mask)
        // Used for "Lasso" - we want the path to touch the region somewhere.
        if (looseIncludeMasks && looseIncludeMasks.length > 0) {
            for (const mask of looseIncludeMasks) {
                if (mask > BigInt(0)) {
                    // IF the mask has nodes, the path MUST touch at least one of them.
                    if ((visited & mask) === BigInt(0)) {
                        return false;
                    }
                }
            }
        }

        return true;
    });
}

/**
 * Combine multiple selection masks using OR.
 * (Kept for other usages if any, but main filtering now uses array for AND logic)
 */
export function combineMasks(selections) {
    return selections.reduce((combined, selection) => {
        const mask = BigInt(selection.mask || selection.properties?.visited || '0');
        return combined | mask;
    }, BigInt(0));
}

/**
 * Calculate squared Euclidean distance between two path centroids.
 */
function getCentroidDistSq(p1, p2) {
    const c1 = p1.properties?.centroid;
    const c2 = p2.properties?.centroid;
    if (!c1 || !c2) return Infinity;
    const dLat = c1[0] - c2[0];
    const dLng = c1[1] - c2[1];
    return dLat * dLat + dLng * dLng;
}

/**
 * Sort paths by a property.
 * 'spatial' uses nearest-neighbor sort based on centroid distance.
 */
export function sortPaths(paths, sortBy = 'loop_miles', ascending = true) {
    if (sortBy === 'poi') {
        return [...paths].sort((a, b) => {
            const aVal = a.properties?.poi_miles ?? Infinity;
            const bVal = b.properties?.poi_miles ?? Infinity;
            return ascending ? aVal - bVal : bVal - aVal;
        });
    }

    // Standard property sort
    if (sortBy !== 'spatial') {
        return [...paths].sort((a, b) => {
            const aVal = a.properties?.[sortBy] ?? 0;
            const bVal = b.properties?.[sortBy] ?? 0;
            return ascending ? aVal - bVal : bVal - aVal;
        });
    }

    // Spatial nearest-neighbor sort
    if (paths.length <= 1) return [...paths];

    // Seed with the first path (or could pick most northern/western)
    // For stability, let's sort by latitude first to pick a deterministic start
    const sorted = [...paths].sort((a, b) => {
        const latA = a.properties?.centroid?.[0] ?? 0;
        const latB = b.properties?.centroid?.[0] ?? 0;
        return latB - latA; // North to South
    });

    const result = [sorted[0]];
    const unvisited = new Set(sorted.slice(1));
    let current = sorted[0];

    while (unvisited.size > 0) {
        let nearest = null;
        let minDistSq = Infinity;

        for (const p of unvisited) {
            const distSq = getCentroidDistSq(current, p);
            if (distSq < minDistSq) {
                minDistSq = distSq;
                nearest = p;
            }
        }

        if (nearest) {
            result.push(nearest);
            unvisited.delete(nearest);
            current = nearest;
        } else {
            // Should not happen unless centroids are missing
            const remaining = Array.from(unvisited);
            result.push(...remaining);
            break;
        }
    }

    return result;
}
