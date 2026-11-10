import { useMemo, useState, useRef, useEffect, useLayoutEffect } from 'react';
import { Minimize2, ArrowLeftRight } from 'lucide-react';
import './ElevationProfileWindow.css';
import { KM_PER_MI, M_PER_FT, useUnits } from '../utils/units';
import { hoverPoint, useHoverPoint } from '../hooks/useHoverPoint';
import { profileSlice, unpavedRuns } from '../utils/surface';
import { GRADE_BANDS, gradeLine, gradeRuns } from '../utils/grade';
import { rangeTotals } from '../utils/profileStats';

// Unpaved stretches: vertical bars of the theme colour and white under the line, a dotted band along the route.
const UNPAVED_COLOR = 'var(--color-primary)';
const UNPAVED_BAR = 3; // chart units per bar

// The chart is drawn in screen pixels at its box's size (wide and low, like a
// route planner's), so text keeps its size and the pointer maps 1:1.
const DEFAULT_SIZE = { width: 800, height: 150 };
const PADDING = { top: 12, right: 24, bottom: 24, left: 62 };

/**
 * Standalone window displaying elevation profile chart.
 * Centered at the bottom of the screen with larger dimensions.
 */
function ElevationProfileWindow({ elevationProfile: rawProfile, unpaved: rawUnpaved, onClose, onFlipPath }) {
    // Shared with the map marker (hooks/useHoverPoint): either side can set it.
    const hoveredPoint = useHoverPoint();
    const onHover = (point) => hoverPoint.set(point ? { ...point, source: 'chart' } : null);
    // The chart works in display units (km and m, or mi and ft). The profile
    // and hoveredPoint shared with the map stay in miles and feet.
    const units = useUnits();
    const km = units === 'km';
    const dScale = km ? KM_PER_MI : 1;
    const eScale = km ? M_PER_FT : 1;
    const elevationProfile = useMemo(
        () => (km && rawProfile ? rawProfile.map((p) => [p[0] * KM_PER_MI, p[1] * M_PER_FT, ...p.slice(2)]) : rawProfile),
        [rawProfile, km],
    );
    // Unpaved stretches in display distance units; null when the route has no surface data (older routes).
    const unpaved = useMemo(() => (Array.isArray(rawUnpaved)
        ? unpavedRuns({ unpaved: rawUnpaved }).map((r) => [r[2] * dScale, r[3] * dScale])
        : null), [rawUnpaved, dScale]);
    const [zoomDomain, setZoomDomain] = useState(null); // [minDist, maxDist] in display units
    useEffect(() => { setZoomDomain(null); }, [km]);
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState(null);
    const [dragCurrent, setDragCurrent] = useState(null);
    const [showGrade, setShowGrade] = useState(false); // Default to hidden if noisy
    const [showGradeColors, setShowGradeColors] = useState(false); // area under the line coloured by grade
    // Grade blocks from the profile as sent (miles, feet), in display distance units. They are
    // sized to what the chart shows, so zooming in shows finer blocks.
    const gradeColorRuns = useMemo(() => (showGradeColors
        ? gradeRuns(rawProfile, { shown: zoomDomain ? [zoomDomain[0] / dScale, zoomDomain[1] / dScale] : null })
            .map((r) => ({ ...r, from: r.from * dScale, to: r.to * dScale }))
        : []), [showGradeColors, rawProfile, dScale, zoomDomain]);
    const svgRef = useRef(null);
    const hasProfile = elevationProfile?.length > 1;
    const boxRef = useRef(null);
    const [size, setSize] = useState(DEFAULT_SIZE);
    useLayoutEffect(() => {
        const box = boxRef.current;
        if (!box) return undefined;
        const measure = () => {
            const width = Math.round(box.clientWidth);
            const height = Math.round(box.clientHeight);
            if (width > 0 && height > 0) {
                setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
            }
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(box);
        return () => observer.disconnect();
    }, [hasProfile]);
    const { width: CHART_WIDTH, height: CHART_HEIGHT } = size;

    const chartData = useMemo(() => {
        if (!elevationProfile || elevationProfile.length < 2) return null;

        let dataPoints = elevationProfile;

        // Filter data if zoomed
        if (zoomDomain) {
            dataPoints = elevationProfile.filter(p => p[0] >= zoomDomain[0] && p[0] <= zoomDomain[1]);
        }

        const distances = dataPoints.map(p => p[0]);
        const elevations = dataPoints.map(p => p[1]);

        let minDist = zoomDomain ? zoomDomain[0] : distances[0];
        let maxDist = zoomDomain ? zoomDomain[1] : distances[distances.length - 1];

        if (zoomDomain && dataPoints.length === 0) {
            minDist = zoomDomain[0];
            maxDist = zoomDomain[1];
        } else if (!zoomDomain && distances.length > 0) {
            minDist = distances[0];
            maxDist = distances[distances.length - 1];
        }

        const minElev = Math.min(...elevations);
        const maxElev = Math.max(...elevations);

        // Add padding to elevation range
        const elevRange = maxElev - minElev || 1;
        const elevPad = elevRange * 0.1;
        const yMin = minElev - elevPad;
        const yMax = maxElev + elevPad;

        const plotW = CHART_WIDTH - PADDING.left - PADDING.right;
        const plotH = CHART_HEIGHT - PADDING.top - PADDING.bottom;
        const distRange = maxDist - minDist || 1;

        const scaleX = (d) => PADDING.left + ((d - minDist) / distRange) * plotW;
        const scaleY = (e) => PADDING.top + plotH - ((e - yMin) / (yMax - yMin)) * plotH;
        const invertX = (x) => minDist + ((x - PADDING.left) / plotW) * distRange;

        // Build SVG path for the line
        const linePoints = elevationProfile.map(
            ([d, e]) => `${scaleX(d).toFixed(1)},${scaleY(e).toFixed(1)}`
        );
        const linePath = `M${linePoints.join('L')}`;

        // Build filled area path (line + close along bottom)
        const bottomY = PADDING.top + plotH;
        const areaPath = `${linePath}L${scaleX(maxDist).toFixed(1)},${bottomY}L${scaleX(minDist).toFixed(1)},${bottomY}Z`;

        // The area under the line between two distances (null when outside the profile).
        const areaUnder = (d0, d1) => {
            const pts = profileSlice(elevationProfile, d0, d1);
            if (pts.length < 2) return null;
            const top = pts.map(([d, e]) => `${scaleX(d).toFixed(1)},${scaleY(e).toFixed(1)}`).join('L');
            return `M${scaleX(pts[0][0]).toFixed(1)},${bottomY}L${top}L${scaleX(pts[pts.length - 1][0]).toFixed(1)},${bottomY}Z`;
        };
        // Unpaved stretches: the area under the line over each one.
        const unpavedPaths = (unpaved || []).map(([d0, d1]) => areaUnder(d0, d1)).filter(Boolean);
        // Grade colours: the area under the line over each run, in its band's colour.
        const gradePaths = gradeColorRuns
            .map((r) => ({ d: areaUnder(r.from, r.to), color: GRADE_BANDS[r.band].color }))
            .filter((p) => p.d);

        // Y-axis ticks (5 ticks)
        const yTicks = [];
        for (let i = 0; i <= 4; i++) {
            const v = yMin + (yMax - yMin) * (i / 4);
            yTicks.push({
                y: scaleY(v),
                label: `${Math.round(v).toLocaleString()} ${km ? 'm' : 'ft'}`
            });
        }

        // X-axis ticks
        const xTicks = [];
        const step = distRange > 10 ? Math.ceil(distRange / 8) : distRange > 5 ? 1 : 0.5;
        for (let d = Math.ceil(minDist / step) * step; d <= maxDist; d += step) {
            xTicks.push({
                x: scaleX(d),
                label: `${d.toFixed(step < 1 ? 1 : 0)} ${km ? 'km' : 'mi'}`
            });
        }

        // Grades (slope %) for the grade line and the hovered grade, smoothed over
        // distances (utils/grade.gradeLine), so the line is as smooth at any sample spacing.
        const grades = gradeLine(elevationProfile, km ? { unit: 1000, rise: 1000 } : {});

        // Calculate visible grades min/max for scaling
        // Use the smoothed grades we calculated for the full profile
        let visibleGrades = [];
        if (dataPoints.length > 0) {
            const startIdx = elevationProfile.indexOf(dataPoints[0]);
            if (startIdx !== -1) {
                visibleGrades = grades.slice(startIdx, startIdx + dataPoints.length);
            }
        }

        // If for some reason lookup failed (shouldn't happen with filter), fallback
        if (visibleGrades.length === 0 && dataPoints.length > 0) {
            visibleGrades = new Array(dataPoints.length).fill(0);
        }

        const minGrade = Math.min(...visibleGrades, -1);
        const maxGrade = Math.max(...visibleGrades, 1);
        // Symmetrical grade scale usually looks best or just fit
        const maxAbsGrade = Math.max(Math.abs(minGrade), Math.abs(maxGrade));
        const gradeYMin = -maxAbsGrade * 1.2;
        const gradeYMax = maxAbsGrade * 1.2;

        const scaleGradeY = (g) => PADDING.top + plotH - ((g - gradeYMin) / (gradeYMax - gradeYMin)) * plotH;

        // Build SVG path for Grade Line
        // We match dataPoints
        const gradeLinePoints = dataPoints.map((p, i) => {
            const g = visibleGrades[i] || 0;
            return `${scaleX(p[0]).toFixed(1)},${scaleGradeY(g).toFixed(1)}`;
        });
        const gradePath = `M${gradeLinePoints.join('L')}`;


        return {
            dataPoints,
            linePath,
            areaPath,
            gradePath,
            unpavedPaths,
            gradePaths,
            yTicks,
            xTicks,
            plotW,
            plotH,
            bottomY,
            minElev: Math.round(minElev),
            maxElev: Math.round(maxElev),
            scaleX,
            scaleY,
            scaleGradeY,
            invertX,
            minDist,
            maxDist,
            grades, // full grades
            visibleGrades // for stats if needed
        };
    }, [elevationProfile, zoomDomain, km, unpaved, gradeColorRuns, CHART_WIDTH, CHART_HEIGHT]);

    const getMouseX = (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        return e.clientX - rect.left;
    };

    const handleMouseDown = (e) => {
        if (!chartData) return;
        const x = getMouseX(e);
        // Only start if within plot area
        if (x >= PADDING.left && x <= PADDING.left + chartData.plotW) {
            setIsDragging(true);
            setDragStart(x);
            setDragCurrent(x);
        }
    };

    const handleMouseUp = () => {
        if (isDragging) {
            setIsDragging(false);
            if (Math.abs(dragCurrent - dragStart) > 5) {
                // Determine range
                const x1 = Math.min(dragStart, dragCurrent);
                const x2 = Math.max(dragStart, dragCurrent);

                // Convert to distance
                const d1 = chartData.invertX(x1);
                const d2 = chartData.invertX(x2);

                // Set zoom
                setZoomDomain([Math.max(chartData.minDist, d1), Math.min(chartData.maxDist, d2)]);
            }
            setDragStart(null);
            setDragCurrent(null);
        }
    };

    // Global mouse up to catch release outside
    useEffect(() => {
        const up = () => {
            if (isDragging) setIsDragging(false);
        };
        window.addEventListener('mouseup', up);
        return () => window.removeEventListener('mouseup', up);
    }, [isDragging]);

    const handleMouseMove = (e) => {
        if (!chartData) return;
        const x = getMouseX(e);

        if (isDragging) {
            setDragCurrent(x);
        }

        // Convert x to distance
        let dist = chartData.invertX(x);

        // Clamp to range
        dist = Math.max(chartData.minDist, Math.min(dist, chartData.maxDist));

        // Find closest point in visible data (dataPoints)
        const points = chartData.dataPoints || elevationProfile;
        let closest = points[0];
        let minDiff = Math.abs(closest[0] - dist);

        for (let i = 1; i < points.length; i++) {
            const diff = Math.abs(points[i][0] - dist);
            if (diff < minDiff) {
                minDiff = diff;
                closest = points[i];
            }
        }

        onHover({
            distance: closest[0] / dScale,
            elevation: closest[1] / eScale,
            coordinate: [closest[2], closest[3]],
            bearing: closest[4],
        });
    };

    // Grade at the hovered distance (from the map or the chart).
    const hoverGrade = useMemo(() => {
        if (!hoveredPoint || !chartData?.grades?.length) return null;
        const d = hoveredPoint.distance * dScale;
        let lo = 0;
        let hi = elevationProfile.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (elevationProfile[mid][0] < d) lo = mid + 1;
            else hi = mid;
        }
        if (lo > 0 && Math.abs(elevationProfile[lo - 1][0] - d) < Math.abs(elevationProfile[lo][0] - d)) lo -= 1;
        return chartData.grades[lo] ?? null;
    }, [hoveredPoint, chartData, elevationProfile, dScale]);

    // Surface at the hovered distance (null without surface data).
    // Length, climb and descent of what is shown: the part being dragged
    // over, else the zoomed part, else the whole route.
    const summaryRange = useMemo(() => {
        if (isDragging && chartData && dragStart != null && dragCurrent != null && Math.abs(dragCurrent - dragStart) > 5) {
            const a = chartData.invertX(Math.min(dragStart, dragCurrent));
            const b = chartData.invertX(Math.max(dragStart, dragCurrent));
            return [Math.max(chartData.minDist, a), Math.min(chartData.maxDist, b)];
        }
        return zoomDomain;
    }, [isDragging, chartData, dragStart, dragCurrent, zoomDomain]);
    const summary = useMemo(
        () => rangeTotals(elevationProfile, summaryRange?.[0], summaryRange?.[1]),
        [elevationProfile, summaryRange],
    );

    const handleMouseLeave = () => {
        onHover(null);
    };

    if (!chartData) {
        return null;
    }

    return (
        <div className="elevation-window">
            <div className="elevation-window__content">
                <div className="elevation-window__header">
                    <h3>Elevation</h3>
                    {summary && (
                        <span
                            className={`elevation-window__summary ${summaryRange ? 'is-part' : ''}`}
                            title={summaryRange ? 'The selected part of the route' : 'The whole route'}
                        >
                            <strong>{summary.distance.toFixed(1)} {km ? 'km' : 'mi'}</strong>
                            {' '}+{Math.round(summary.climb).toLocaleString()} {km ? 'm' : 'ft'}
                            {' / '}−{Math.round(summary.descent).toLocaleString()} {km ? 'm' : 'ft'}
                        </span>
                    )}
                    <div className="elevation-window__stats">
                        <div className="elevation-window__stat">
                            <span>Distance</span>
                            <span className="elevation-window__stat-value">
                                {hoveredPoint ? (hoveredPoint.distance * dScale).toFixed(2) : '–'} {km ? 'km' : 'mi'}
                            </span>
                        </div>
                        <div className="elevation-window__stat">
                            <span>Elevation</span>
                            <span className="elevation-window__stat-value">
                                {hoveredPoint ? Math.round(hoveredPoint.elevation * eScale).toLocaleString() : '–'} {km ? 'm' : 'ft'}
                            </span>
                        </div>
                        <div className="elevation-window__stat">
                            <span>Grade</span>
                            <span className={`elevation-window__stat-value ${hoverGrade != null
                                ? (hoverGrade >= 0 ? 'elevation-window__stat-value--grade-pos' : 'elevation-window__stat-value--grade-neg')
                                : ''
                                }`}>
                                {hoverGrade != null ? `${hoverGrade >= 0 ? '+' : '−'}${Math.abs(hoverGrade).toFixed(1)}%` : '–'}
                            </span>
                        </div>
                    </div>
                    <div className="elevation-window__controls">
                        <button
                            className={`elevation-window__flip-btn ${showGradeColors ? 'active' : ''}`}
                            onClick={() => setShowGradeColors(!showGradeColors)}
                            title="Colour the chart by grade: blues downhill, green flat, yellow to dark red as it steepens"
                        >
                            <span className="elevation-window__grade-swatch" aria-hidden="true" />
                            Grade colors
                        </button>
                        <button
                            className={`elevation-window__flip-btn ${showGrade ? 'active' : ''}`}
                            onClick={() => setShowGrade(!showGrade)}
                            title="Show the grade line on the chart"
                        >
                            <span className="elevation-window__pct">%</span>
                            Grade line
                        </button>
                        {onFlipPath && (
                            <button
                                className="elevation-window__flip-btn"
                                onClick={onFlipPath}
                                title="Ride it the other way (flips the profile)"
                            >
                                <ArrowLeftRight size={14} />
                                Reverse
                            </button>
                        )}
                        {zoomDomain && (
                            <button
                                className="elevation-window__flip-btn"
                                onClick={() => setZoomDomain(null)}
                                title="Reset Zoom"
                            >
                                <Minimize2 size={14} style={{ transform: 'rotate(45deg)' }} />
                                Reset Zoom
                            </button>
                        )}
                        <button
                            className="elevation-window__close"
                            onClick={onClose}
                            title="Hide (E)"
                        >
                            <Minimize2 size={16} />
                        </button>
                    </div>
                </div>
                <div className="elevation-window__chart-container" ref={boxRef}>
                    <svg
                        ref={svgRef}
                        width={CHART_WIDTH}
                        height={CHART_HEIGHT}
                        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                        style={{
                            display: 'block',
                            width: '100%',
                            height: '100%',
                            cursor: isDragging ? 'ew-resize' : 'crosshair',
                            userSelect: 'none'
                        }}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        onMouseLeave={handleMouseLeave}
                    >
                        <defs>
                            <linearGradient id="elevGradient" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.5" />
                                <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0.08" />
                            </linearGradient>
                            <pattern id="unpavedBars" patternUnits="userSpaceOnUse" width={UNPAVED_BAR * 2} height="10">
                                <rect width={UNPAVED_BAR} height="10" fill={UNPAVED_COLOR} />
                                <rect x={UNPAVED_BAR} width={UNPAVED_BAR} height="10" fill="#ffffff" />
                            </pattern>
                            {/* With grade colours: white bars only, so the grade colour shows between them */}
                            <pattern id="unpavedBarsOver" patternUnits="userSpaceOnUse" width={UNPAVED_BAR * 2} height="10">
                                <rect x={UNPAVED_BAR} width={UNPAVED_BAR} height="10" fill="#ffffff" fillOpacity="0.85" />
                            </pattern>
                            <clipPath id="chart-clip">
                                <rect
                                    x={PADDING.left}
                                    y={PADDING.top}
                                    width={chartData.plotW}
                                    height={chartData.plotH}
                                />
                            </clipPath>
                        </defs>

                        {/* Grid lines */}
                        {chartData.yTicks.map((tick, i) => (
                            <line
                                key={`y-grid-${i}`}
                                x1={PADDING.left}
                                y1={tick.y}
                                x2={PADDING.left + chartData.plotW}
                                y2={tick.y}
                                stroke="var(--color-border)"
                                strokeWidth="0.5"
                                strokeDasharray="3,3"
                                opacity="0.3"
                            />
                        ))}

                        <g clipPath="url(#chart-clip)">
                            {/* Filled area (Elevation): the theme gradient, or grade colours */}
                            {showGradeColors
                                ? chartData.gradePaths.map((p, i) => (
                                    <path key={`grade-${i}`} d={p.d} fill={p.color} stroke={p.color} strokeWidth="0.5" />
                                ))
                                : <path d={chartData.areaPath} fill="url(#elevGradient)" />}

                            {/* Unpaved stretches: theme-colour and white bars under the line
                                (over grade colours: white bars, the grade colour between them) */}
                            {chartData.unpavedPaths.map((d, i) => (
                                <path
                                    key={`unpaved-${i}`}
                                    d={d}
                                    fill={showGradeColors ? 'url(#unpavedBarsOver)' : 'url(#unpavedBars)'}
                                    fillOpacity={showGradeColors ? 1 : 0.9}
                                />
                            ))}

                            {/* Elevation Line (dark over grade colours, which include the theme's blues) */}
                            <path
                                d={chartData.linePath}
                                fill="none"
                                stroke={showGradeColors ? '#1e293b' : 'var(--color-primary)'}
                                strokeWidth="2.5"
                                strokeLinejoin="round"
                            />

                            {/* Grade Line */}
                            {showGrade && (
                                <path
                                    d={chartData.gradePath}
                                    fill="none"
                                    stroke="#6b7280"
                                    strokeWidth="1.5"
                                    strokeOpacity="0.8"
                                    strokeLinejoin="round"
                                />
                            )}
                        </g>

                        {/* Selection Rectangle */}
                        {isDragging && dragStart !== null && dragCurrent !== null && (
                            <g clipPath="url(#chart-clip)">
                                <rect
                                    x={Math.min(dragStart, dragCurrent)}
                                    y={PADDING.top}
                                    width={Math.abs(dragCurrent - dragStart)}
                                    height={chartData.plotH}
                                    fill="rgba(33, 150, 243, 0.2)"
                                    stroke="rgba(33, 150, 243, 0.5)"
                                />
                            </g>
                        )}

                        {/* Y-axis (Elevation) */}
                        <line
                            x1={PADDING.left}
                            y1={PADDING.top}
                            x2={PADDING.left}
                            y2={PADDING.top + chartData.plotH}
                            stroke="var(--color-border)"
                            strokeWidth="1"
                        />

                        {/* Y-axis ticks (Elevation) */}
                        {chartData.yTicks.map((tick, i) => (
                            <g key={`y-${i}`}>
                                <line
                                    x1={PADDING.left - 4}
                                    y1={tick.y}
                                    x2={PADDING.left}
                                    y2={tick.y}
                                    stroke="var(--color-border)"
                                    strokeWidth="1"
                                />
                                <text
                                    x={PADDING.left - 8}
                                    y={tick.y + 4}
                                    textAnchor="end"
                                    fontSize="11"
                                    fill="var(--color-text-muted)"
                                >
                                    {tick.label}
                                </text>
                            </g>
                        ))}

                        {/* X-axis */}
                        <line
                            x1={PADDING.left}
                            y1={chartData.bottomY}
                            x2={PADDING.left + chartData.plotW}
                            y2={chartData.bottomY}
                            stroke="var(--color-border)"
                            strokeWidth="1"
                        />

                        {/* X-axis ticks */}
                        {chartData.xTicks.map((tick, i) => (
                            <g key={`x-${i}`}>
                                <line
                                    x1={tick.x}
                                    y1={chartData.bottomY}
                                    x2={tick.x}
                                    y2={chartData.bottomY + 4}
                                    stroke="var(--color-border)"
                                    strokeWidth="1"
                                />
                                <text
                                    x={tick.x}
                                    y={chartData.bottomY + 18}
                                    textAnchor="middle"
                                    fontSize="11"
                                    fill="var(--color-text-muted)"
                                >
                                    {tick.label}
                                </text>
                            </g>
                        ))}

                        {/* Hover Cursor Line */}
                        {hoveredPoint && (
                            <line
                                x1={chartData.scaleX(hoveredPoint.distance * dScale)}
                                y1={PADDING.top}
                                x2={chartData.scaleX(hoveredPoint.distance * dScale)}
                                y2={chartData.bottomY}
                                stroke="var(--color-text)"
                                strokeWidth="1"
                                strokeDasharray="4,2"
                                opacity="0.5"
                                clipPath="url(#chart-clip)"
                            />
                        )}

                        {/* Units are on the tick labels (no axis titles: less clutter) */}
                        {/* Right Y-axis (Grade) */}
                        {showGrade && (
                            <>
                                <line
                                    x1={PADDING.left + chartData.plotW}
                                    y1={PADDING.top}
                                    x2={PADDING.left + chartData.plotW}
                                    y2={PADDING.top + chartData.plotH}
                                    stroke="var(--color-border)"
                                    strokeWidth="1"
                                />


                                <text
                                    x={PADDING.left + chartData.plotW + 16}
                                    y={PADDING.top + chartData.plotH / 2}
                                    textAnchor="middle"
                                    fontSize="12"
                                    fill="var(--color-text-muted)"
                                    transform={`rotate(90 ${PADDING.left + chartData.plotW + 16} ${PADDING.top + chartData.plotH / 2})`}
                                >
                                    Grade (%)
                                </text>
                            </>
                        )}
                    </svg>
                </div>
                {showGradeColors && (
                    <div className="elevation-window__grade-key" aria-label="Grade colours">
                        <span className="elevation-window__grade-key-title">Grade</span>
                        {GRADE_BANDS.map((b) => (
                            <span key={b.label} className="elevation-window__grade-key-item">
                                <span className="elevation-window__grade-key-swatch" style={{ background: b.color }} />
                                {b.label}
                            </span>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

export default ElevationProfileWindow;
