/** Miles between two lat/lng points (equirectangular, fine inside one city). */
export function milesBetween(lat1, lng1, lat2, lng2) {
    const midLat = ((lat1 + lat2) * 0.5 * Math.PI) / 180;
    const dNorth = (lat2 - lat1) * 111320;
    const dEast = (lng2 - lng1) * 111320 * Math.cos(midLat);
    return Math.hypot(dNorth, dEast) / 1609.344;
}

/**
 * Closest sample on an elevation profile to a pin.
 * Profile rows are [dist_mi, elev_ft, lat, lng, bearing].
 */
export function closestApproach(profile, lat, lng) {
    let miles = Infinity;
    let point = null;
    if (!profile) return { miles, point };

    for (let i = 0; i < profile.length; i++) {
        const sample = profile[i];
        if (!sample || sample.length < 4) continue;
        const dist = milesBetween(lat, lng, sample[2], sample[3]);
        if (dist < miles) {
            miles = dist;
            point = [sample[2], sample[3]];
        }
    }
    return { miles, point };
}

/**
 * Attach poi_miles (worst pin, or best pin when match is 'any') and
 * per-pin closest approaches. Returns new path objects.
 */
export function annotatePathsWithPoi(paths, pins, match = 'all') {
    if (!pins?.length) return paths;

    return paths.map((path) => {
        const approaches = pins.map((pin) => {
            const hit = closestApproach(path.properties?.elevation_profile, pin.lat, pin.lng);
            return {
                id: pin.id,
                kind: pin.kind,
                label: pin.label,
                miles: hit.miles,
                lat: hit.point ? hit.point[0] : null,
                lng: hit.point ? hit.point[1] : null,
            };
        });
        const dists = approaches.map((a) => a.miles);
        const score = match === 'any' ? Math.min(...dists) : Math.max(...dists);
        return {
            ...path,
            properties: {
                ...path.properties,
                poi_miles: score,
                poi_approaches: approaches,
            },
        };
    });
}

export function formatApproachMiles(miles) {
    if (typeof miles !== 'number' || !Number.isFinite(miles)) return '—';
    if (miles < 0.1) return `${Math.round(miles * 5280)} ft`;
    return `${miles.toFixed(2)} mi`;
}
