import { useMemo, useState, useRef, useEffect } from 'react';
import { Minimize2, ArrowLeftRight } from 'lucide-react';
import './ElevationProfileWindow.css';
import { KM_PER_MI, M_PER_FT, useUnits } from '../utils/units';
import { hoverPoint, useHoverPoint } from '../hooks/useHoverPoint';

const CHART_WIDTH = 800;
const CHART_HEIGHT = 200;
const PADDING = { top: 16, right: 24, bottom: 32, left: 48 };

/**
 * Standalone window displaying elevation profile chart.
 * Centered at the bottom of the screen with larger dimensions.
 */
function ElevationProfileWindow({ elevationProfile: rawProfile, onClose, onFlipPath }) {
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
    const [zoomDomain, setZoomDomain] = useState(null); // [minDist, maxDist] in display units
    useEffect(() => { setZoomDomain(null); }, [km]);
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState(null);
    const [dragCurrent, setDragCurrent] = useState(null);
    const [showGrade, setShowGrade] = useState(false); // Default to hidden if noisy
    const svgRef = useRef(null);

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

        // Y-axis ticks (5 ticks)
        const yTicks = [];
        for (let i = 0; i <= 4; i++) {
            const v = yMin + (yMax - yMin) * (i / 4);
            yTicks.push({
                y: scaleY(v),
                label: `${Math.round(v)}`
            });
        }

        // X-axis ticks
        const xTicks = [];
        const step = distRange > 10 ? Math.ceil(distRange / 8) : distRange > 5 ? 1 : 0.5;
        for (let d = Math.ceil(minDist / step) * step; d <= maxDist; d += step) {
            xTicks.push({
                x: scaleX(d),
                label: `${d.toFixed(step < 1 ? 1 : 0)}`
            });
        }

        // Calculate grades (slope %)
        // Use a smoothing window to avoid noise from point-to-point fluctuations
        const GRADE_SAMPLE_DIST = km ? 0.08 : 0.05; // about 260 ft
        let rawGrades = [];

        for (let i = 0; i < elevationProfile.length; i++) {
            const currentDist = elevationProfile[i][0];

            // Find start of window
            let startIdx = i;
            while (startIdx > 0 && (currentDist - elevationProfile[startIdx][0]) < GRADE_SAMPLE_DIST / 2) {
                startIdx--;
            }

            // Find end of window
            let endIdx = i;
            while (endIdx < elevationProfile.length - 1 && (elevationProfile[endIdx][0] - currentDist) < GRADE_SAMPLE_DIST / 2) {
                endIdx++;
            }

            // If window is too small (e.g. at very start/end with few points), extend it
            if (startIdx === endIdx && elevationProfile.length > 1) {
                if (startIdx > 0) startIdx--;
                else if (endIdx < elevationProfile.length - 1) endIdx++;
            }

            const p1 = elevationProfile[startIdx];
            const p2 = elevationProfile[endIdx];
            const distMi = p2[0] - p1[0];
            const elevFt = p2[1] - p1[1];

            let grade = 0;
            if (distMi > 0.0001) {
                grade = (elevFt / (distMi * (km ? 1000 : 5280))) * 100;
            }
            rawGrades.push(grade);
        }

        // Apply a secondary Moving Average smoothing pass
        // This helps remove "step" artifacts from the windowed calculation
        const SMA_WINDOW = 5; // number of points to average
        const grades = rawGrades.map((_, i, arr) => {
            const start = Math.max(0, i - Math.floor(SMA_WINDOW / 2));
            const end = Math.min(arr.length, i + Math.ceil(SMA_WINDOW / 2));
            const subset = arr.slice(start, end);
            const sum = subset.reduce((a, b) => a + b, 0);
            return sum / subset.length;
        });

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
    }, [elevationProfile, zoomDomain, km]);

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
                <div className="elevation-window__chart-container">
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
                            {/* Filled area (Elevation) */}
                            <path d={chartData.areaPath} fill="url(#elevGradient)" />

                            {/* Elevation Line */}
                            <path
                                d={chartData.linePath}
                                fill="none"
                                stroke="var(--color-primary)"
                                strokeWidth="2.5"
                                strokeLinejoin="round"
                            />

                            {/* Grade Line */}
                            {showGrade && (
                                <path
                                    d={chartData.gradePath}
                                    fill="none"
                                    stroke="#f59e0b"
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

                        {/* Axis labels */}
                        <text
                            x={PADDING.left + chartData.plotW / 2}
                            y={CHART_HEIGHT - 6}
                            textAnchor="middle"
                            fontSize="12"
                            fill="var(--color-text-muted)"
                        >
                            Distance ({km ? 'km' : 'miles'})
                        </text>

                        <text
                            x={16}
                            y={PADDING.top + chartData.plotH / 2}
                            textAnchor="middle"
                            fontSize="12"
                            fill="var(--color-text-muted)"
                            transform={`rotate(-90 16 ${PADDING.top + chartData.plotH / 2})`}
                        >
                            Elev ({km ? 'm' : 'ft'})
                        </text>
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
            </div>
        </div>
    );
}

export default ElevationProfileWindow;
