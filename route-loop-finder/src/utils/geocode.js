/**
 * Place search and names from Photon (komoot's OpenStreetMap geocoder): free,
 * no key, made for search-as-you-type. VITE_GEOCODER_URL points elsewhere
 * (for example a self-hosted Photon) without code changes.
 */
const PHOTON = (import.meta.env.VITE_GEOCODER_URL || 'https://photon.komoot.io').replace(/\/$/, '');

function unique(parts) {
    const out = [];
    parts.forEach((p) => {
        const text = (p || '').trim();
        if (text && !out.includes(text)) out.push(text);
    });
    return out;
}

/** { title, detail } for a Photon feature's properties. */
export function describePlace(props = {}) {
    const address = props.housenumber && props.street ? `${props.housenumber} ${props.street}` : props.street;
    const title = props.name || address || props.city || props.county || props.state || 'Unnamed place';
    const detail = unique([
        props.name && address ? address : null,
        props.district || props.locality,
        props.city,
        props.state,
        props.countrycode === 'US' ? null : props.country,
    ]).filter((p) => p !== title).join(', ');
    return { title, detail };
}

/** Short name for a start point, e.g. "East Blvd, Dilworth" or "Freedom Park, Charlotte". */
export function shortPlaceName(props = {}) {
    const house = props.osm_key === 'building' || props.type === 'house';
    return unique([
        house ? null : props.name,
        props.street,
        props.district || props.locality,
        props.city || props.county,
    ]).slice(0, 2).join(', ') || null;
}

function toResult(feature) {
    const [lng, lat] = feature.geometry?.coordinates || [];
    if (lat == null || lng == null) return null;
    const props = feature.properties || {};
    const { title, detail } = describePlace(props);
    // Photon extent: [minLon, maxLat, maxLon, minLat]
    const e = props.extent;
    const bounds = Array.isArray(e) && e.length === 4 ? [[e[3], e[0]], [e[1], e[2]]] : null;
    return {
        id: `${props.osm_type || ''}${props.osm_id || ''}-${lat}-${lng}`,
        lat, lng, title, detail, bounds,
        name: shortPlaceName(props) || title,
    };
}

/** Up to `limit` places for `query`, ranked near `near` ({ lat, lng }). */
export async function searchPlaces(query, near, signal, limit = 6) {
    const params = new URLSearchParams({ q: query, limit: String(limit), lang: 'en' });
    if (near) {
        params.set('lat', near.lat.toFixed(4));
        params.set('lon', near.lng.toFixed(4));
    }
    const res = await fetch(`${PHOTON}/api/?${params}`, { signal });
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    const data = await res.json();
    return (data.features || []).map(toResult).filter(Boolean);
}

/** Short place name for a point (null when unknown or unreachable). */
export async function placeNameAt(lat, lng, signal) {
    const params = new URLSearchParams({ lat: lat.toFixed(5), lon: lng.toFixed(5), lang: 'en' });
    const res = await fetch(`${PHOTON}/reverse?${params}`, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    const props = data.features?.[0]?.properties;
    return props ? shortPlaceName(props) : null;
}
