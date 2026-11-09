import { Fragment, useMemo } from 'react';
import { Circle, CircleMarker, Polygon, Polyline, Rectangle } from 'react-leaflet';
import { AREA_STYLE, ROAD_COLORS, paintColor } from '../../utils/roadColors';
import { areaEdges } from '../../utils/graphRoads';
import { isOutlinedArea, paintedKeys } from '../../utils/paintRoads';

/** A dotted area outline (circle, box, or freeform). */
function Outline({ outline, style }) {
    if (outline.shape === 'circle') {
        return (
            <Circle
                center={[outline.lat, outline.lng]}
                radius={outline.radiusM}
                pathOptions={style}
                pane="tools"
                interactive={false}
            />
        );
    }
    if (outline.shape === 'box') {
        return (
            <Rectangle
                bounds={[[outline.south, outline.west], [outline.north, outline.east]]}
                pathOptions={style}
                pane="tools"
                interactive={false}
            />
        );
    }
    if (outline.shape === 'freeform' && outline.coordinates?.length >= 3) {
        return <Polygon positions={outline.coordinates} pathOptions={style} pane="tools" interactive={false} />;
    }
    return null;
}

/** The roads inside an excluded area, shown while the Road tool points into it. */
function RevealedArea({ area, roadIndex, selections }) {
    // Roads in the outline that are neither excluded by it nor painted by anything else: turned back on.
    const allowed = useMemo(() => {
        const painted = paintedKeys(selections);
        return areaEdges(roadIndex, area.outline)
            .filter((edge) => !painted.has(edge.key))
            .map((edge) => edge.pts);
    }, [roadIndex, area, selections]);
    return (
        <>
            {allowed.length > 0 && (
                <Polyline
                    positions={allowed}
                    pathOptions={{ color: ROAD_COLORS.allowed, weight: 4, opacity: 0.9, dashArray: '2 7', lineCap: 'round' }}
                    pane="tools"
                    interactive={false}
                />
            )}
            {area.lines?.length > 0 && (
                <Polyline
                    positions={area.lines}
                    pathOptions={{ color: ROAD_COLORS.exclude, weight: 5, opacity: 0.9, lineCap: 'round' }}
                    pane="tools"
                    interactive={false}
                />
            )}
        </>
    );
}

/**
 * Painted roads and area outlines. Green dotted = routes must enter the area;
 * red dotted = an excluded area (its red roads are shown only while the Road
 * tool points inside it, `revealedAreaId`). Nothing here takes pointer
 * events: double-click to remove is handled map-wide (PanInteractions).
 */
function SelectionLayer({ selections, roadIndex = null, revealedAreaId = null }) {
    return (
        <>
            {selections.map((selection, index) => {
                const key = selection.id || index;

                if (isOutlinedArea(selection)) {
                    return (
                        <Fragment key={key}>
                            <Outline outline={selection.outline} style={AREA_STYLE.exclude} />
                            {selection.id === revealedAreaId && roadIndex && (
                                <RevealedArea area={selection} roadIndex={roadIndex} selections={selections} />
                            )}
                        </Fragment>
                    );
                }

                // Painted roads: red = excluded, green = one required edge,
                // dark green = a road group (any one of its edges will do).
                if (selection.shape === 'edges') {
                    if (!selection.lines?.length) return null;
                    return (
                        <Polyline
                            key={key}
                            positions={selection.lines}
                            pathOptions={{ color: paintColor(selection), weight: 5, opacity: 0.9, lineCap: 'round' }}
                            pane="tools"
                            interactive={false}
                        />
                    );
                }

                // Pins are no longer made; generations saved with them still show them.
                if (selection.shape === 'point') {
                    const exclude = selection.type === 'exclude';
                    return (
                        <CircleMarker
                            key={key}
                            center={[selection.lat, selection.lng]}
                            radius={6}
                            pane="tools"
                            interactive={false}
                            pathOptions={{
                                color: '#ffffff',
                                weight: 2,
                                fillColor: exclude ? ROAD_COLORS.exclude : '#d08a3a',
                                fillOpacity: selection.pending ? 0.4 : 0.95,
                            }}
                        />
                    );
                }

                return (
                    <Outline
                        key={key}
                        outline={selection}
                        style={selection.type === 'exclude' ? AREA_STYLE.exclude : AREA_STYLE.include}
                    />
                );
            })}
        </>
    );
}

export default SelectionLayer;
