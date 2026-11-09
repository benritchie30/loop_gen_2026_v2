/**
 * Pointer-near-something hover for a Leaflet map, shared by the Road tool
 * (nearest road) and the route hover marker (nearest point of the shown
 * route). What makes it smooth:
 *
 * - It listens on the whole map, not on the thin line itself, so the pointer
 *   only has to be near the thing (the caller's pick decides how near).
 * - Work runs at most once per animation frame, on the latest pointer spot.
 * - onChange only fires when keyOf(result) changes, so callers can redraw
 *   freely; results are meant to update a Leaflet layer in place, never to
 *   re-render the map.
 *
 * pick({ latlng, point, ctrl, shift }) returns a result or null.
 * Returns { refresh, detach }: refresh() re-runs pick for the last pointer
 * spot (after a click changed what is under it); detach() removes the
 * listeners and reports null if something was shown.
 */
export function attachProximityHover(map, { pick, keyOf = () => 'x', onChange, trackModifiers = false }) {
    const el = map.getContainer();
    let last = null;
    let frame = null;
    let lastKey = '';

    const evaluate = () => {
        frame = null;
        const result = last ? pick(last) : null;
        const key = result == null ? '' : String(keyOf(result));
        if (key === lastKey) return;
        lastKey = key;
        onChange(result == null ? null : result);
    };
    const schedule = () => {
        if (frame == null) frame = requestAnimationFrame(evaluate);
    };

    const onMove = (e) => {
        const ev = e.originalEvent || {};
        last = {
            latlng: e.latlng,
            point: e.containerPoint,
            ctrl: !!(ev.ctrlKey || ev.metaKey),
            shift: !!ev.shiftKey,
        };
        schedule();
    };
    const clear = () => {
        last = null;
        if (frame != null) {
            cancelAnimationFrame(frame);
            frame = null;
        }
        if (lastKey !== '') {
            lastKey = '';
            onChange(null);
        }
    };
    const onKey = (e) => {
        if (!last) return;
        const ctrl = !!(e.ctrlKey || e.metaKey);
        const shift = !!e.shiftKey;
        if (ctrl === last.ctrl && shift === last.shift) return;
        last = { ...last, ctrl, shift };
        schedule();
    };

    map.on('mousemove', onMove);
    el.addEventListener('mouseleave', clear);
    if (trackModifiers) {
        window.addEventListener('keydown', onKey);
        window.addEventListener('keyup', onKey);
    }

    return {
        refresh() {
            lastKey = '\u0000'; // force onChange even if the result's key is the same
            schedule();
        },
        detach() {
            map.off('mousemove', onMove);
            el.removeEventListener('mouseleave', clear);
            if (trackModifiers) {
                window.removeEventListener('keydown', onKey);
                window.removeEventListener('keyup', onKey);
            }
            clear();
        },
    };
}
