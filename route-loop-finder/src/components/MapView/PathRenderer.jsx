import { GeoJSON, CircleMarker, Polyline } from 'react-leaflet';
import { useMemo } from 'react';
import DirectionArrows from './DirectionArrows';
import { surfacePieces } from '../../utils/surface';

/**
 * The bold route with its unpaved stretches dashed: paved pieces as the
 * usual solid line; unpaved ones as short dashes of the same colour over a
 * pale line (so the dashes read on any background and the route stays whole).
 */
function SurfaceLine({ pieces, style, pane }) {
    const weight = style.weight || 4;
    const under = useMemo(() => ({
        color: '#ffffff', weight: weight + 2, opacity: 0.75, lineCap: 'round', lineJoin: 'round',
    }), [weight]);
    const dashes = useMemo(() => ({
        color: style.color, opacity: 1, weight, lineCap: 'butt', lineJoin: 'round',
        dashArray: `${weight * 2} ${Math.round(weight * 1.5)}`, // 8 on, 6 off at the bold weight
    }), [style.color, weight]);
    return (
        <>
            {pieces.paved.length > 0 && (
                <Polyline positions={pieces.paved} pathOptions={style} pane={pane} interactive={false} />
            )}
            <Polyline positions={pieces.unpaved} pathOptions={under} pane={pane} interactive={false} />
            <Polyline positions={pieces.unpaved} pathOptions={dashes} pane={pane} interactive={false} />
        </>
    );
}

/**
 * Renders paths on the map. Nothing here takes pointer events: hovering and
 * clicking routes is done map-wide with a reach (RouteHover, PanInteractions).
 * - Active path: bold dark line (always on top)
 * - Filtered paths: subtle translucent preview
 * - Direction arrows: small rotated arrows along the active path
 * - Centroid: small dot (for spatial sort testing)
 * - Route card under the pointer (hoveredPathId): shown in place of the
 *   active path, with its arrows and centroid; the active path drops to a
 *   faint line like the others until the pointer leaves the card.
 * - Favorite routes (isFavorite) are drawn in the favorite colour (the
 *   theme's complement, favoriteHue) when bold or previewed; faint, they
 *   look like every other route.
 * - The bold route's unpaved stretches are dashed (SurfaceLine); faint
 *   routes stay plain.
 *
 * Render order ensures the shown path is always visible above others.
 */
function PathRenderer({
    currentPath,
    filteredPaths,
    backgroundPane = 'overlayPane',
    activePane = 'overlayPane',
    showArrows = true,
    showCentroids = false,
    primaryColor = 215,
    showPathPreview = true,
    pathPreviewOpacity = 0.4,
    hoveredPathId = null, // a route card under the pointer: shown instead of the active path
    isFavorite = null, // (route) => boolean
    favoriteHue = 35,
}) {
    const hoveredPath = hoveredPathId && hoveredPathId !== currentPath?.id
        ? filteredPaths?.find((p) => p.id === hoveredPathId) || null
        : null;
    // The one route drawn bold: the hovered card's, else the selected one.
    const shownPath = hoveredPath || currentPath;
    const hoverStyle = useMemo(() => ({
        weight: 5,
        color: `hsl(${primaryColor}, 75%, 55%)`,
        opacity: 0.9,
    }), [primaryColor]);
    const inactiveStyle = useMemo(() => ({
        weight: 2,
        color: `hsl(${primaryColor}, 40%, 65%)`, // Muted version of theme color
        opacity: pathPreviewOpacity
    }), [primaryColor, pathPreviewOpacity]);

    // Style for the currently selected path — bold, using theme color
    const activeStyle = useMemo(() => ({
        weight: 4,
        color: `hsl(${primaryColor}, 65%, 30%)`, // Darker version for high contrast
        opacity: 0.85
    }), [primaryColor]);

    // Favorites: the bold and preview styles in the favorite colour.
    const favorite = (path) => !!isFavorite && !!path && isFavorite(path);
    const favHoverStyle = useMemo(() => ({ ...hoverStyle, color: `hsl(${favoriteHue}, 85%, 50%)` }), [hoverStyle, favoriteHue]);
    const favActiveStyle = useMemo(() => ({ ...activeStyle, color: `hsl(${favoriteHue}, 80%, 42%)`, opacity: 0.95 }), [activeStyle, favoriteHue]);

    // Derived colors for elements
    // Secondary color: Brighter/Lighter/More saturated for better visibility against dark path
    const secondaryColor = `hsl(${primaryColor}, 85%, 60%)`;

    // Use secondary color for arrows and centroids
    const arrowColor = secondaryColor;
    const centroidColor = secondaryColor;

    // Every route gets a unique id when it arrives (usePathSets.addPathToSet).
    const getPathKey = (path, index, prefix) => `${prefix}-${path?.id ?? 'route'}-${index}`;

    const shownPieces = useMemo(() => surfacePieces(shownPath), [shownPath]);
    const shownStyle = hoveredPath
        ? (favorite(shownPath) ? favHoverStyle : hoverStyle)
        : (favorite(shownPath) ? favActiveStyle : activeStyle);

    return (
        <>
            {/* All filtered paths — translucent preview, bottom layer (the active
                path too while a card preview replaces it) */}
            {showPathPreview && filteredPaths?.map((path, index) => {
                if (path === shownPath || (path.id && path.id === shownPath?.id)) return null;

                return (
                    <GeoJSON
                        key={getPathKey(path, index, 'inactive')}
                        data={path}
                        style={inactiveStyle}
                        pane={backgroundPane}
                        interactive={false}
                    />
                );
            })}

            {/* The shown path: a route card's preview, else the active path (unpaved stretches dashed) */}
            {shownPath && shownPieces && (
                <SurfaceLine
                    key={getPathKey(shownPath, 0, `surface-${hoveredPath ? 'hover' : 'active'}${favorite(shownPath) ? '-fav' : ''}`)}
                    pieces={shownPieces}
                    style={shownStyle}
                    pane={activePane}
                />
            )}
            {shownPath && !shownPieces && (
                <GeoJSON
                    key={getPathKey(shownPath, 0, `${hoveredPath ? 'hover' : 'active'}${favorite(shownPath) ? '-fav' : ''}`)}
                    data={shownPath}
                    style={shownStyle}
                    pane={activePane}
                    interactive={false}
                />
            )}

            {/* Direction arrows along the shown path */}
            {showArrows && shownPath?.properties?.elevation_profile?.length > 1 && (
                <DirectionArrows
                    key={shownPath.id}
                    elevationProfile={shownPath.properties.elevation_profile}
                    color={arrowColor}
                />
            )}

            {/* Centroid marker (for spatial sort verification) */}
            {showCentroids && shownPath?.properties?.centroid && (
                <CircleMarker
                    center={shownPath.properties.centroid}
                    radius={4}
                    pathOptions={{
                        color: centroidColor,
                        fillColor: centroidColor,
                        fillOpacity: 0.8,
                        weight: 1
                    }}
                    interactive={false}
                />
            )}

        </>
    );
}

export default PathRenderer;
