import { Fragment, useEffect, useMemo, useRef } from 'react';
import { Circle, Marker, Polyline, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { formatApproachMiles } from '../../utils/poiDistance';

const METERS_PER_MILE = 1609.344;

function pinIcon(label, kind) {
    const remove = kind === 'kept'
        ? '<button type="button" class="poi-marker__remove" data-poi-remove="1" title="Remove pin">×</button>'
        : '';
    return L.divIcon({
        className: 'poi-marker',
        html: `<div class="poi-marker__dot poi-marker__dot--${kind}"><span>${label}</span>${remove}</div>`,
        iconSize: [36, 36],
        iconAnchor: [18, 18],
    });
}

function PoiMarker({ pin, onRemoveKept, swallowClick }) {
    const icon = useMemo(
        () => pinIcon(pin.label, pin.kind),
        [pin.label, pin.kind]
    );

    return (
        <Marker
            position={[pin.lat, pin.lng]}
            icon={icon}
            zIndexOffset={800}
            eventHandlers={{
                click: (e) => {
                    swallowClick.current = true;
                    if (e.originalEvent) L.DomEvent.stop(e.originalEvent);
                    const target = e.originalEvent?.target;
                    if (target?.closest?.('[data-poi-remove]')) {
                        onRemoveKept(pin.id);
                    }
                },
                dblclick: (e) => {
                    swallowClick.current = true;
                    if (e.originalEvent) L.DomEvent.stop(e.originalEvent);
                    if (pin.kind === 'kept') onRemoveKept(pin.id);
                },
            }}
        />
    );
}

function DoubleClickZoomLock({ locked }) {
    const map = useMap();
    useEffect(() => {
        if (locked) map.doubleClickZoom.disable();
        else map.doubleClickZoom.enable();
        return () => map.doubleClickZoom.enable();
    }, [map, locked]);
    return null;
}

/**
 * Probe pin, kept pins, radius rings, and connectors to the current route.
 */
function PoiLayer({
    active,
    pins,
    radiusMiles,
    approaches,
    onProbe,
    onKeep,
    onRemoveKept,
}) {
    const map = useMap();
    const swallowClick = useRef(false);

    useEffect(() => {
        const el = map.getContainer();
        if (active) el.classList.add('poi-tool-active');
        else el.classList.remove('poi-tool-active');
        return () => el.classList.remove('poi-tool-active');
    }, [map, active]);

    useMapEvents({
        click(e) {
            if (!active) return;
            if (swallowClick.current) {
                swallowClick.current = false;
                return;
            }
            const point = { lat: e.latlng.lat, lng: e.latlng.lng };
            const keep = e.originalEvent.ctrlKey || e.originalEvent.metaKey;
            if (keep) onKeep(point);
            else onProbe(point);
        },
    });

    const showRadius = radiusMiles != null && radiusMiles > 0;

    return (
        <>
            <DoubleClickZoomLock locked={active || pins.some((pin) => pin.kind === 'kept')} />
            {pins.map((pin) => (
                <Fragment key={pin.id}>
                    {showRadius && (
                        <Circle
                            center={[pin.lat, pin.lng]}
                            radius={radiusMiles * METERS_PER_MILE}
                            pathOptions={{
                                color: pin.kind === 'probe' ? '#e9a825' : '#d97706',
                                weight: 1,
                                dashArray: '4 4',
                                fillColor: '#e9a825',
                                fillOpacity: 0.06,
                            }}
                            interactive={false}
                        />
                    )}
                    <PoiMarker
                        pin={pin}
                        onRemoveKept={onRemoveKept}
                        swallowClick={swallowClick}
                    />
                </Fragment>
            ))}
            {approaches?.map((approach) => {
                if (approach.lat == null || approach.lng == null) return null;
                const pin = pins.find((p) => p.id === approach.id);
                if (!pin) return null;
                return (
                    <Polyline
                        key={`link-${approach.id}`}
                        positions={[[pin.lat, pin.lng], [approach.lat, approach.lng]]}
                        pathOptions={{
                            color: '#e9a825',
                            weight: 2,
                            dashArray: '3 5',
                            opacity: 0.9,
                        }}
                        interactive={false}
                    >
                        <Tooltip permanent direction="center" className="poi-dist-tip">
                            {formatApproachMiles(approach.miles)}
                        </Tooltip>
                    </Polyline>
                );
            })}
        </>
    );
}

export default PoiLayer;
