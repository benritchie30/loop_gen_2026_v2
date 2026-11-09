import { Fragment, useMemo, useRef } from 'react';
import { Circle, Marker, Polygon, Rectangle } from 'react-leaflet';
import L from 'leaflet';
import { metersBetween } from '../../utils/routeSelections';

const M_PER_DEG = 111320;
// A saved / a generation's boundary: a grey dotted outline.
const BOUNDARY_STYLE = { color: '#64748b', weight: 2, opacity: 0.9, dashArray: '2 6', lineCap: 'round', fill: false };
// The boundary being edited.
const EDIT_STYLE = { color: '#334155', weight: 2, opacity: 0.95, dashArray: '6 5', fillColor: '#64748b', fillOpacity: 0.08 };

function ShapeOutline({ shape, style }) {
    if (shape.shape === 'circle') {
        return <Circle center={[shape.lat, shape.lng]} radius={shape.radiusM} pathOptions={style} pane="tools" interactive={false} />;
    }
    if (shape.shape === 'box') {
        return (
            <Rectangle
                bounds={[[shape.south, shape.west], [shape.north, shape.east]]}
                pathOptions={style}
                pane="tools"
                interactive={false}
            />
        );
    }
    return <Polygon positions={shape.coordinates} pathOptions={style} pane="tools" interactive={false} />;
}

/** A boundary's shapes as grey dotted outlines (the plan's, or an open generation's). */
export function BoundaryOutline({ shapes }) {
    return (shapes || []).map((shape, i) => <ShapeOutline key={i} shape={shape} style={BOUNDARY_STYLE} />);
}

const icons = {
    corner: L.divIcon({ className: 'boundary-handle', iconSize: [14, 14] }),
    mid: L.divIcon({ className: 'boundary-handle boundary-handle--mid', iconSize: [10, 10] }),
    move: L.divIcon({ className: 'boundary-handle boundary-handle--move', iconSize: [18, 18] }),
};

/** A draggable handle. Callbacks may change every render; the marker's listeners stay. */
function Handle({ position, kind = 'corner', title, onDrag, onDragEnd, onClick, onDoubleClick }) {
    const cb = useRef({});
    cb.current = { onDrag, onDragEnd, onClick, onDoubleClick };
    const handlers = useMemo(() => ({
        drag: (e) => cb.current.onDrag?.(e.target.getLatLng()),
        dragend: (e) => cb.current.onDragEnd?.(e.target.getLatLng()),
        click: (e) => {
            L.DomEvent.stopPropagation(e);
            cb.current.onClick?.();
        },
        dblclick: (e) => {
            L.DomEvent.stopPropagation(e);
            cb.current.onDoubleClick?.();
        },
    }), []);
    return (
        <Marker
            position={position}
            icon={icons[kind]}
            draggable
            title={title}
            zIndexOffset={kind === 'mid' ? 1500 : 2000}
            eventHandlers={handlers}
            keyboard={false}
        />
    );
}

const shifted = (lat, lng, dLat, dLng) => [lat + dLat, lng + dLng];

function CircleHandles({ shape, onChange }) {
    const east = shape.lng + shape.radiusM / (M_PER_DEG * Math.cos((shape.lat * Math.PI) / 180));
    return (
        <>
            <Handle
                kind="move"
                position={[shape.lat, shape.lng]}
                title="Drag to move the circle"
                onDrag={(p) => onChange({ ...shape, lat: p.lat, lng: p.lng })}
            />
            <Handle
                position={[shape.lat, east]}
                title="Drag to change the size"
                onDrag={(p) => onChange({ ...shape, radiusM: Math.max(20, metersBetween(shape.lat, shape.lng, p.lat, p.lng)) })}
            />
        </>
    );
}

function BoxHandles({ shape, onChange }) {
    const corners = [
        ['north', 'west'], ['north', 'east'], ['south', 'east'], ['south', 'west'],
    ];
    const opposite = { north: 'south', south: 'north', east: 'west', west: 'east' };
    return (
        <>
            {corners.map(([ns, ew]) => (
                <Handle
                    key={`${ns}-${ew}`}
                    position={[shape[ns], shape[ew]]}
                    title="Drag the corner"
                    onDrag={(p) => {
                        const fixedLat = shape[opposite[ns]];
                        const fixedLng = shape[opposite[ew]];
                        onChange({
                            shape: 'box',
                            north: Math.max(p.lat, fixedLat),
                            south: Math.min(p.lat, fixedLat),
                            east: Math.max(p.lng, fixedLng),
                            west: Math.min(p.lng, fixedLng),
                        });
                    }}
                />
            ))}
            <Handle
                kind="move"
                position={[(shape.north + shape.south) / 2, (shape.east + shape.west) / 2]}
                title="Drag to move the box"
                onDrag={(p) => {
                    const dLat = p.lat - (shape.north + shape.south) / 2;
                    const dLng = p.lng - (shape.east + shape.west) / 2;
                    onChange({
                        shape: 'box',
                        north: shape.north + dLat,
                        south: shape.south + dLat,
                        east: shape.east + dLng,
                        west: shape.west + dLng,
                    });
                }}
            />
        </>
    );
}

function FreeformHandles({ shape, onChange }) {
    const pts = shape.coordinates;
    const centre = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    const withPoint = (i, p) => ({ ...shape, coordinates: pts.map((q, k) => (k === i ? [p.lat, p.lng] : q)) });
    const inserted = (i, lat, lng) => ({
        ...shape, coordinates: [...pts.slice(0, i + 1), [lat, lng], ...pts.slice(i + 1)],
    });
    return (
        <>
            {pts.map((p, i) => (
                <Handle
                    key={`v${i}`}
                    position={p}
                    title="Drag the point · double-click removes it"
                    onDrag={(q) => onChange(withPoint(i, q))}
                    onDoubleClick={() => {
                        if (pts.length > 3) onChange({ ...shape, coordinates: pts.filter((_, k) => k !== i) });
                    }}
                />
            ))}
            {pts.map((p, i) => {
                const q = pts[(i + 1) % pts.length];
                const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
                return (
                    <Handle
                        key={`m${i}-${pts.length}`}
                        kind="mid"
                        position={mid}
                        title="Click or drag to add a point"
                        onClick={() => onChange(inserted(i, mid[0], mid[1]))}
                        onDragEnd={(r) => onChange(inserted(i, r.lat, r.lng))}
                    />
                );
            })}
            <Handle
                kind="move"
                position={centre}
                title="Drag to move the shape"
                onDrag={(r) => {
                    const dLat = r.lat - centre[0];
                    const dLng = r.lng - centre[1];
                    onChange({ ...shape, coordinates: pts.map(([a, b]) => shifted(a, b, dLat, dLng)) });
                }}
            />
        </>
    );
}

/**
 * The boundary being edited: its shapes, each with white handles (a circle's
 * centre and edge, a box's corners and middle, a freeform shape's points,
 * with small ones between them to add a point; double-click a point to
 * remove it).
 */
export function BoundaryEditLayer({ shapes, onChange }) {
    return (shapes || []).map((shape, i) => {
        const change = (next) => onChange(i, next);
        return (
            <Fragment key={i}>
                <ShapeOutline shape={shape} style={EDIT_STYLE} />
                {shape.shape === 'circle' && <CircleHandles shape={shape} onChange={change} />}
                {shape.shape === 'box' && <BoxHandles shape={shape} onChange={change} />}
                {shape.shape === 'freeform' && <FreeformHandles shape={shape} onChange={change} />}
            </Fragment>
        );
    });
}
