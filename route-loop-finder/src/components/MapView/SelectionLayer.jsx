import { Fragment, useEffect } from 'react';
import { Circle, CircleMarker, Polygon, Rectangle, useMap } from 'react-leaflet';

function outlineStyle(selection, isLatest) {
    const exclude = selection.type === 'exclude';
    return {
        color: exclude ? '#b56b6b' : '#6e8cae',
        weight: isLatest ? 2 : 1,
        opacity: isLatest ? 0.9 : 0.38,
        dashArray: '4 6',
        fillColor: exclude ? '#b56b6b' : '#6e8cae',
        fillOpacity: isLatest ? 0.06 : 0.025,
    };
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
 * Committed pins and area outlines. The newest one is drawn a little stronger.
 */
function SelectionLayer({ selections, onRemove, lockDoubleClick }) {
    const lastIndex = selections.length - 1;

    return (
        <>
            <DoubleClickZoomLock locked={lockDoubleClick || selections.some((sel) => sel.shape === 'point')} />
            {selections.map((selection, index) => {
                const isLatest = index === lastIndex;
                const style = outlineStyle(selection, isLatest);
                const key = selection.id || index;

                if (selection.shape === 'point' || selection.shape === 'circle') {
                    return (
                        <Fragment key={key}>
                            <Circle
                                center={[selection.lat, selection.lng]}
                                radius={selection.radiusM}
                                pathOptions={style}
                                pane="tools"
                                interactive={false}
                            />
                            {selection.shape === 'point' && (
                                <CircleMarker
                                    center={[selection.lat, selection.lng]}
                                    radius={isLatest ? 6 : 5}
                                    pane="tools"
                                    bubblingMouseEvents={false}
                                    pathOptions={{
                                        color: '#ffffff',
                                        weight: 2,
                                        fillColor: selection.type === 'exclude' ? '#b56b6b' : '#d08a3a',
                                        fillOpacity: 0.95,
                                    }}
                                    eventHandlers={{
                                        dblclick: (e) => {
                                            if (e.originalEvent) e.originalEvent.stopPropagation();
                                            onRemove(selection.id);
                                        },
                                    }}
                                />
                            )}
                        </Fragment>
                    );
                }

                if (selection.shape === 'box') {
                    return (
                        <Rectangle
                            key={key}
                            bounds={[
                                [selection.south, selection.west],
                                [selection.north, selection.east],
                            ]}
                            pathOptions={style}
                            pane="tools"
                            interactive={false}
                        />
                    );
                }

                if (selection.shape === 'freeform' && selection.coordinates?.length >= 3) {
                    return (
                        <Polygon
                            key={key}
                            positions={selection.coordinates}
                            pathOptions={style}
                            pane="tools"
                            interactive={false}
                        />
                    );
                }

                return null;
            })}
        </>
    );
}

export default SelectionLayer;
