import { describe, expect, it } from 'vitest';
import { GRADE_BANDS, MIN_BLOCK_M, MIN_BLOCKS_SHOWN, gradeBand, gradeColor, gradeLine, gradeRuns } from '../grade';
import plaza from './plazaProfile.json';

const M_PER_MI = 1609.344;
/** A profile sampled every 50 m ([dist_mi, elev_ft]) of `meters` length; elev(m) in feet. */
function profile(meters, elev) {
    const out = [];
    for (let m = 0; m <= meters; m += 50) out.push([m / M_PER_MI, elev(m), 0, 0, 0]);
    return out;
}
const FT_PER_M = 3.28084;
const label = (run) => GRADE_BANDS[run.band].label;

describe('grade bands', () => {
    it('cool to warm, lower end included', () => {
        expect(GRADE_BANDS.map((b) => b.label)).toEqual([
            '< −10%', '−10 to −5%', '−5 to 0%', '0 to 3%', '3 to 6%', '6 to 9%', '9 to 12%', '12 to 15%', '> 15%',
        ]);
        expect(GRADE_BANDS[gradeBand(-12)].label).toBe('< −10%');
        expect(GRADE_BANDS[gradeBand(-10)].label).toBe('−10 to −5%');
        expect(GRADE_BANDS[gradeBand(-0.1)].label).toBe('−5 to 0%');
        expect(GRADE_BANDS[gradeBand(0)].label).toBe('0 to 3%');
        expect(GRADE_BANDS[gradeBand(3)].label).toBe('3 to 6%');
        expect(GRADE_BANDS[gradeBand(14.9)].label).toBe('12 to 15%');
        expect(GRADE_BANDS[gradeBand(15)].label).toBe('> 15%');
        expect(GRADE_BANDS[gradeBand(40)].label).toBe('> 15%');
        expect(gradeColor(NaN)).toBe(gradeColor(1)); // no grade: flat
    });
});

describe('grade runs', () => {
    it('a steady 5% climb is one yellow run over the whole route', () => {
        const runs = gradeRuns(profile(2000, (m) => 1000 + 0.05 * m * FT_PER_M));
        expect(runs).toHaveLength(1);
        expect(label(runs[0])).toBe('3 to 6%');
        expect(runs[0].grade).toBeCloseTo(5, 1);
        expect(runs[0].from).toBe(0);
        expect(runs[0].to).toBeCloseTo(2000 / M_PER_MI, 6);
    });

    it('climb, flat, descent: three runs in order', () => {
        const elev = (m) => (m <= 1000 ? 0.08 * m : m <= 2000 ? 80 : 80 - 0.12 * (m - 2000)) * FT_PER_M;
        const runs = gradeRuns(profile(3000, elev));
        const bands = runs.map(label);
        expect(bands[0]).toBe('6 to 9%');
        expect(bands).toContain('0 to 3%');
        expect(bands[bands.length - 1]).toBe('< −10%');
        // Smoothing only blurs the corners: the middle of each part keeps its colour.
        const at = (m) => label(runs.find((r) => r.from <= m / M_PER_MI && r.to >= m / M_PER_MI));
        expect([at(500), at(1500), at(2500)]).toEqual(['6 to 9%', '0 to 3%', '< −10%']);
    });

    it('one bad sample does not paint a steep spike', () => {
        const runs = gradeRuns(profile(2000, (m) => (m === 1000 ? 1000 + 25 : 1000)));
        // 25 ft up and down between two 50 m samples is ±15%; smoothed it stays under 6%.
        expect(runs.every((r) => Math.abs(r.grade) < 6)).toBe(true);
    });

    it('runs cover the route without gaps and join neighbours of the same colour', () => {
        const runs = gradeRuns(profile(5000, (m) => 300 * Math.sin(m / 700)));
        for (let i = 1; i < runs.length; i++) {
            expect(runs[i].from).toBeCloseTo(runs[i - 1].to, 9);
            expect(runs[i].band).not.toBe(runs[i - 1].band);
        }
        expect(runs[0].from).toBe(0);
    });

    it('a steady climb with SRTM-like noise is still one block', () => {
        // About 1 m of noise (up to ~2.5 m), correlated. Much more than that and a
        // noise bump is the size of a real small hill: it may get its own block.
        let seed = 3;
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
        let noise = 0;
        const runs = gradeRuns(profile(4000, (m) => {
            noise = 0.6 * noise + rnd() * 9;
            return 1000 + 0.045 * m * FT_PER_M + noise;
        }));
        expect(runs.map(label)).toEqual(['3 to 6%']);
    });

    it('no block is narrower than the minimum: 100 m, or 1/80 of the distance shown', () => {
        let seed = 5;
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
        const hilly = profile(70000, (m) => 3000 + 900 * Math.sin(m / 8000) + 250 * Math.sin(m / 1500) + 80 * Math.sin(m / 300) + rnd() * 15);
        const total = 70000 / M_PER_MI;
        const runs = gradeRuns(hilly);
        const narrowest = Math.min(...runs.map((r) => r.to - r.from));
        expect(narrowest).toBeGreaterThanOrEqual(total / MIN_BLOCKS_SHOWN - 1e-9);
        expect(runs.length).toBeLessThanOrEqual(MIN_BLOCKS_SHOWN);
        // Zoomed in on 3 km: finer blocks are allowed, but never under 100 m.
        const zoomed = gradeRuns(hilly, { shown: [20, 20 + 3000 / M_PER_MI] });
        expect(zoomed.length).toBeGreaterThan(runs.length);
        expect(Math.min(...zoomed.map((r) => r.to - r.from))).toBeGreaterThanOrEqual(MIN_BLOCK_M / M_PER_MI - 1e-9);
    });

    it('a short rise on a flat route shows as a climb (the tolerance follows the relief shown)', () => {
        // 2 km flat, 12 m up over 100 m, 2 km flat: on a route this flat, that is its hill.
        const elev = (m) => (m < 2000 ? 0 : m < 2100 ? 0.12 * (m - 2000) : 12) * FT_PER_M;
        const runs = gradeRuns(profile(4100, elev));
        expect(runs.map(label)).toEqual(['0 to 3%', '3 to 6%', '0 to 3%']);
    });

    it('every block is coloured by its own grade: a climb is never painted as a descent', () => {
        // A real city route (digitized from a chart): small hills, 70 ft of relief in 2 miles.
        const runs = gradeRuns(plaza);
        const elevAt = (d) => plaza[Math.max(0, plaza.findIndex((p) => p[0] >= d - 1e-9))][1];
        const flat = GRADE_BANDS.findIndex((b) => b.from === 0);
        for (const r of runs) {
            const rise = elevAt(r.to) - elevAt(r.from);
            const where = `${r.from.toFixed(2)}-${r.to.toFixed(2)} mi, ${rise.toFixed(0)} ft`;
            if (rise > 8) expect(r.band < flat, where).toBe(false);
            if (rise < -8) expect(r.band < flat, where).toBe(true);
        }
        // Its climbs and descents each get blocks (not one colour for a hill and the valley after it).
        expect(runs.length).toBeGreaterThanOrEqual(8);
    });

    it('too short a profile has none', () => {
        expect(gradeRuns([])).toEqual([]);
        expect(gradeRuns([[0, 10]])).toEqual([]);
        expect(gradeRuns(null)).toEqual([]);
    });
});

describe('grade line', () => {
    it('reads the grade of a steady climb, at any sample spacing', () => {
        for (const step of [25, 50]) {
            const p = [];
            for (let m = 0; m <= 2000; m += step) p.push([m / M_PER_MI, 0.06 * m * FT_PER_M]);
            const g = gradeLine(p);
            expect(g.length).toBe(p.length);
            expect(g[Math.floor(p.length / 2)]).toBeCloseTo(6, 6);
        }
    });

    it('is as smooth at 25 m as at 50 m (the windows are distances, not sample counts)', () => {
        let seed = 9;
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
        const roughness = (step) => {
            const p = [];
            for (let m = 0; m <= 5000; m += step) p.push([m / M_PER_MI, (0.04 * m + rnd() * 3) * FT_PER_M]);
            const g = gradeLine(p);
            // typical change of the line per 100 m
            const per = Math.round(100 / step);
            let sum = 0;
            for (let i = per; i < g.length; i += per) sum += Math.abs(g[i] - g[i - per]);
            return sum / Math.floor((g.length - 1) / per);
        };
        expect(roughness(25)).toBeLessThan(roughness(50) * 1.5);
    });

    it('works in km and m', () => {
        const p = [];
        for (let m = 0; m <= 2000; m += 25) p.push([m / 1000, 0.05 * m]);
        expect(gradeLine(p, { unit: 1000, rise: 1000 })[40]).toBeCloseTo(5, 6);
    });
});
