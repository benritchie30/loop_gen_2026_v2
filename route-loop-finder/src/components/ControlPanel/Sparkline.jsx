import { useMemo } from 'react';

const W = 84;
const H = 22;
const MAX_POINTS = 60;

/**
 * Tiny elevation shape of a route (its own min to max, so a flat route and a
 * hilly one both fill the box; the climb number next to it gives the scale).
 * profile items: [dist_mi, elev_ft, lat, lng, bearing].
 */
function Sparkline({ profile }) {
    const { line, area } = useMemo(() => {
        if (!Array.isArray(profile) || profile.length < 2) return { line: '', area: '' };
        const stepN = Math.max(1, Math.ceil(profile.length / MAX_POINTS));
        const pts = profile.filter((_, i) => i % stepN === 0 || i === profile.length - 1);
        const d0 = pts[0][0];
        const d1 = pts[pts.length - 1][0] || 1;
        let lo = Infinity;
        let hi = -Infinity;
        pts.forEach((p) => { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); });
        const span = hi - lo || 1;
        const xy = pts.map((p) => [
            ((p[0] - d0) / (d1 - d0 || 1)) * W,
            H - 2 - ((p[1] - lo) / span) * (H - 4),
        ]);
        const l = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
        return { line: l, area: `${l}L${W},${H}L0,${H}Z` };
    }, [profile]);

    if (!line) return <svg className="sparkline" width={W} height={H} aria-hidden="true" />;
    return (
        <svg className="sparkline" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
            <path d={area} className="sparkline__area" />
            <path d={line} className="sparkline__line" />
        </svg>
    );
}

export default Sparkline;
