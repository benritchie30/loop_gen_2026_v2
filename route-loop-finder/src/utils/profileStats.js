/**
 * Totals of a stretch of an elevation profile ([dist, elev, ...] rows, in
 * whatever units the profile is in): its length and the climb and descent
 * along it, with the ends interpolated. Over the whole route the climb is
 * the route's Total climb (the server counts it on the same profile).
 */
export function rangeTotals(profile, from = -Infinity, to = Infinity) {
    if (!Array.isArray(profile) || profile.length < 2) return null;
    const start = Math.max(from, profile[0][0]);
    const end = Math.min(to, profile[profile.length - 1][0]);
    if (!(end > start)) return { distance: 0, climb: 0, descent: 0 };
    const elevAt = (d) => {
        let i = 1;
        while (i < profile.length - 1 && profile[i][0] < d) i++;
        const [x0, y0] = profile[i - 1];
        const [x1, y1] = profile[i];
        const t = x1 > x0 ? Math.min(1, Math.max(0, (d - x0) / (x1 - x0))) : 0;
        return y0 + (y1 - y0) * t;
    };
    const elevs = [elevAt(start)];
    for (const p of profile) if (p[0] > start && p[0] < end) elevs.push(p[1]);
    elevs.push(elevAt(end));
    let climb = 0;
    let descent = 0;
    for (let i = 1; i < elevs.length; i++) {
        const delta = elevs[i] - elevs[i - 1];
        if (delta > 0) climb += delta;
        else descent -= delta;
    }
    return { distance: end - start, climb, descent };
}
