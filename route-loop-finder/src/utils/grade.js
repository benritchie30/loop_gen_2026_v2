/**
 * Grade colours for the elevation chart: cool for descents (dark blues,
 * darkest for the steepest), green for flat, then yellow through orange to
 * dark red as climbs steepen.
 *
 * Elevation comes from SRTM (a 30 m grid of whole metres, which also sees
 * some roofs and trees). The server reads it between grid points every 25 m
 * and smooths it lightly, but grade from sample to sample is still too
 * noisy to colour: short pieces would flip colours every few pixels.
 * Instead, in blocks sized to the chart:
 * 1. smooth the elevation (mean within SMOOTH_M of each sample);
 * 2. simplify it into the fewest straight segments that stay within a
 *    tolerance of it (Douglas-Peucker, vertical error): a steady climb is
 *    one segment, a real change of slope starts a new one. The tolerance is
 *    TOL_FRACTION of the elevation range shown, within TOL_MIN..TOL_MAX: a
 *    city route with 20 m of relief keeps its small hills, a mountain route
 *    does not split on every wiggle;
 * 3. colour each segment by its grade and join neighbours of one colour;
 * 4. fold any block narrower than the minimum (MIN_BLOCK_M, 1/MIN_BLOCKS_SHOWN
 *    of the distance shown, or long enough that the tolerance can move its
 *    grade by at most MAX_GRADE_ERROR) into the neighbour of the closest grade. The
 *    joined block is coloured by its own grade, end to end, so a climb is
 *    never painted as a descent because a descent swallowed it.
 * Zooming the chart in shows finer blocks (the distance and range shown shrink).
 */

const FT_PER_MI = 5280;
const M_PER_MI = 1609.344;
const FT_PER_M = 3.28084;
export const SMOOTH_M = 150; // elevation smoothing window
export const TOL_FRACTION = 0.04; // straightened profile may stray this share of the range shown...
export const TOL_MIN = 1.5; // ...but at least this many metres (SRTM noise)...
export const TOL_MAX = 2.5; // ...and at most this many
export const MIN_BLOCK_M = 100; // narrowest colour block (two samples)...
export const MIN_BLOCKS_SHOWN = 80; // ...or this fraction of the distance shown...
export const MAX_GRADE_ERROR = 0.012; // ...or long enough that the tolerance moves its grade at most 1.2 points

/** Grade bands, lowest first: [from %, to %) and their colour. */
export const GRADE_BANDS = [
    { from: -Infinity, to: -10, color: '#0a1f4d', label: '< −10%' },
    { from: -10, to: -5, color: '#14398a', label: '−10 to −5%' },
    { from: -5, to: 0, color: '#2456a8', label: '−5 to 0%' },
    { from: 0, to: 3, color: '#3a9d4a', label: '0 to 3%' },
    { from: 3, to: 6, color: '#e8c619', label: '3 to 6%' },
    { from: 6, to: 9, color: '#f2a516', label: '6 to 9%' },
    { from: 9, to: 12, color: '#ec7a1c', label: '9 to 12%' },
    { from: 12, to: 15, color: '#d9461f', label: '12 to 15%' },
    { from: 15, to: Infinity, color: '#8e1014', label: '> 15%' },
];

/** Index into GRADE_BANDS for a grade in %. */
export function gradeBand(grade) {
    if (!Number.isFinite(grade)) return GRADE_BANDS.findIndex((b) => b.from === 0);
    const i = GRADE_BANDS.findIndex((b) => grade >= b.from && grade < b.to);
    return i < 0 ? GRADE_BANDS.length - 1 : i;
}

export function gradeColor(grade) {
    return GRADE_BANDS[gradeBand(grade)].color;
}

/**
 * Each sample's elevation averaged with its neighbours within half the
 * window (by distance). Near the ends the window shrinks to stay centred
 * (the first and last samples keep their own), so a climb running to the
 * end of the route is not flattened there.
 */
function smoothed(profile, windowMi) {
    const start = profile[0][0];
    const end = profile[profile.length - 1][0];
    const out = new Array(profile.length);
    let lo = 0;
    let hi = 0;
    let sum = 0;
    for (let i = 0; i < profile.length; i++) {
        const d = profile[i][0];
        const half = Math.min(windowMi / 2, d - start, end - d);
        // Both window ends only move forward as i grows.
        while (hi < profile.length && profile[hi][0] <= d + half + 1e-12) sum += profile[hi++][1];
        while (profile[lo][0] < d - half - 1e-12) sum -= profile[lo++][1];
        out[i] = sum / (hi - lo);
    }
    return out;
}

/**
 * Indices of the samples kept when simplifying (x[i], y[i]) into straight
 * segments with at most `tol` vertical error (Douglas-Peucker).
 */
function simplify(x, y, tol) {
    const n = x.length;
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        if (b - a < 2) continue;
        const slope = x[b] > x[a] ? (y[b] - y[a]) / (x[b] - x[a]) : 0;
        let worst = -1;
        let at = -1;
        for (let i = a + 1; i < b; i++) {
            const off = Math.abs(y[i] - (y[a] + slope * (x[i] - x[a])));
            if (off > worst) {
                worst = off;
                at = i;
            }
        }
        if (worst > tol) {
            keep[at] = 1;
            stack.push([a, at], [at, b]);
        }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
    return out;
}

/**
 * Coloured blocks along a profile ([dist_mi, elev_ft, ...], as the server
 * sends it): [{ from, to, band, grade }] in miles, band an index into
 * GRADE_BANDS, grade the block's grade in % (its rise over its length).
 * shown: [from mi, to mi] of the chart (zoomed), the whole route by
 * default; it sizes the blocks. Empty for fewer than two samples.
 */
export function gradeRuns(profile, { shown = null } = {}) {
    if (!Array.isArray(profile) || profile.length < 2) return [];
    const start = profile[0][0];
    const end = profile[profile.length - 1][0];
    if (!(end > start)) return [];
    const x = profile.map((p) => p[0] * M_PER_MI); // metres along
    const y = smoothed(profile, SMOOTH_M / M_PER_MI).map((e) => e / FT_PER_M); // metres up

    const [s0, s1] = shown && shown[1] > shown[0] ? shown : [start, end];
    let lo = Infinity;
    let hi = -Infinity;
    profile.forEach((p, i) => {
        if (p[0] >= s0 && p[0] <= s1) {
            lo = Math.min(lo, y[i]);
            hi = Math.max(hi, y[i]);
        }
    });
    const range = hi >= lo ? hi - lo : 0;
    const tol = Math.min(TOL_MAX, Math.max(TOL_MIN, range * TOL_FRACTION));

    // Blocks are sample spans [a, b]; each coloured by its own grade, end to end.
    const grade = (a, b) => (x[b] > x[a] ? ((y[b] - y[a]) / (x[b] - x[a])) * 100 : 0);
    const block = (a, b) => {
        const g = grade(a, b);
        return { a, b, grade: g, band: gradeBand(g) };
    };
    const joinSameBand = (blocks) => {
        const out = [];
        for (const bl of blocks) {
            const last = out[out.length - 1];
            // Two blocks of one band make one of that band (its grade is between theirs).
            if (last && last.band === bl.band) out[out.length - 1] = { ...block(last.a, bl.b), band: bl.band };
            else out.push(bl);
        }
        return out;
    };

    const kept = simplify(x, y, tol);
    let blocks = [];
    for (let k = 1; k < kept.length; k++) blocks.push(block(kept[k - 1], kept[k]));
    blocks = joinSameBand(blocks);

    // Fold blocks narrower than the minimum into the neighbour of the closest grade, narrowest first.
    // A block's grade is off by up to (tolerance / its length): short blocks need a longer run.
    const minM = Math.max(MIN_BLOCK_M, ((s1 - s0) * M_PER_MI) / MIN_BLOCKS_SHOWN, tol / MAX_GRADE_ERROR);
    const width = (bl) => x[bl.b] - x[bl.a];
    for (;;) {
        let i = -1;
        for (let k = 0; k < blocks.length; k++) {
            if (blocks.length > 1 && width(blocks[k]) < minM && (i < 0 || width(blocks[k]) < width(blocks[i]))) i = k;
        }
        if (i < 0) break;
        const bl = blocks[i];
        const left = blocks[i - 1];
        const right = blocks[i + 1];
        const gap = (n) => (n ? Math.abs(n.grade - bl.grade) : Infinity);
        if (gap(left) <= gap(right)) blocks.splice(i - 1, 2, block(left.a, bl.b));
        else blocks.splice(i, 2, block(bl.a, right.b));
        blocks = joinSameBand(blocks);
    }
    return blocks.map((bl) => ({ from: profile[bl.a][0], to: profile[bl.b][0], band: bl.band, grade: bl.grade }));
}

/**
 * The grade line (and the hovered grade): grade at each sample in %, over
 * about MEASURE_M of road around it, then averaged over AVERAGE_M. Both are
 * distances, not sample counts, so the line is as smooth at any sample
 * spacing. profile: [dist, elev, ...] in display units, `unit` metres per
 * distance unit and `rise` elevation units per distance unit (mi/ft: 1609.344,
 * 5280; km/m: 1000, 1000).
 */
export const GRADE_MEASURE_M = 100;
export const GRADE_AVERAGE_M = 250;
export function gradeLine(profile, { unit = M_PER_MI, rise = FT_PER_MI } = {}) {
    if (!Array.isArray(profile) || profile.length < 2) return [];
    const n = profile.length;
    const half = GRADE_MEASURE_M / 2 / unit;
    const raw = new Array(n);
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < n; i++) {
        const d = profile[i][0];
        // lo: the nearest sample at least `half` behind (else the first); hi: ahead (else the last).
        while (lo < i && d - profile[lo + 1][0] >= half) lo++;
        if (hi < i) hi = i;
        while (hi < n - 1 && profile[hi][0] - d < half) hi++;
        let a = lo;
        let b = hi;
        if (a === b) {
            if (a > 0) a--;
            else if (b < n - 1) b++;
        }
        const run = profile[b][0] - profile[a][0];
        raw[i] = run > 0 ? ((profile[b][1] - profile[a][1]) / (run * rise)) * 100 : 0;
    }
    const avgHalf = GRADE_AVERAGE_M / 2 / unit;
    const out = new Array(n);
    let s = 0;
    let l = 0;
    let r = 0;
    for (let i = 0; i < n; i++) {
        const d = profile[i][0];
        while (r < n && profile[r][0] <= d + avgHalf) s += raw[r++];
        while (profile[l][0] < d - avgHalf) s -= raw[l++];
        out[i] = s / (r - l);
    }
    return out;
}
