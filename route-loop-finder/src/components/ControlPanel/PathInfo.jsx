/**
 * Displays statistics about the currently selected path.
 */
function PathInfo({ path }) {
    if (!path?.properties) {
        return null;
    }

    const props = path.properties;

    // Handle different property naming conventions from backend
    const totalDist = props.total_miles ?? 0;
    const loopDist = props.loop_miles ?? 0;
    const loopRatio = props.loop_ratio ?? 0;
    const totalClimb = props.total_climb_ft ?? 0;
    const difficulty = props.difficulty ?? 1;

    // Calculate climb rate (feet per mile)
    const climbRate = totalDist > 0 ? totalClimb / totalDist : 0;

    return (
        <div className="path-info">
            <div className="path-info__item">
                <span className="path-info__label">Total Distance</span>
                <span className="path-info__value">{formatDistance(totalDist)}</span>
            </div>

            <div className="path-info__item">
                <span className="path-info__label">Loop Distance</span>
                <span className="path-info__value">{formatDistance(loopDist)}</span>
            </div>

            <div className="path-info__item">
                <span className="path-info__label">Loop Path Percentage</span>
                <span className="path-info__value">{(loopRatio * 100).toFixed(0)}%</span>
            </div>

            <div className="path-info__item">
                <span className="path-info__label">Turns</span>
                <span className="path-info__value">{props.turns}</span>
            </div>

            <div className="path-info__item">
                <span className="path-info__label">Discomfort</span>
                <span className="path-info__value">
                    {typeof props.discomfort === 'number' ? props.discomfort.toFixed(1) : '—'}
                </span>
            </div>

            <div className="path-info__item">
                <span className="path-info__label">Climb Distance</span>
                <span className="path-info__value">{formatClimbing(totalClimb)}</span>
            </div>

            <div className="path-info__item">
                <span className="path-info__label">Climb Rate</span>
                <span className="path-info__value">{Math.round(climbRate)} ft/mi</span>
            </div>

            <div className="path-info__item">
                <span className="path-info__label">Difficulty</span>
                <span className="path-info__value">{difficulty}/10</span>
            </div>
        </div>
    );
}

function formatDistance(miles) {
    if (typeof miles !== 'number') {
        return '—';
    }
    return `${miles.toFixed(1)} mi`;
}

function formatClimbing(feet) {
    if (typeof feet !== 'number') {
        return '—';
    }
    return `${Math.round(feet)} ft`;
}

export default PathInfo;

