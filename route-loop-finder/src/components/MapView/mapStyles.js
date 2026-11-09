/**
 * Basemaps for the layers button. `offline` draws the area's roads instead of tiles.
 * Only free, keyless tile servers that a public site may use (with attribution, light
 * use): Google's tile URLs are not allowed outside its Maps API, and Carto now wants a key.
 */
export const DEFAULT_MAP_STYLE = 'osm';
export const MAP_STYLES = {
    offline: {
        name: 'Blank road network',
        url: null, // no internet tiles; the area's roads are drawn instead
        attribution: 'Roads of the current area (OpenStreetMap data)'
    },
    osm: {
        name: 'OpenStreetMap',
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    },
    osmCycle: {
        name: 'OSM Cycle',
        url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    },
    esriTopo: {
        name: 'ESRI Topo',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
    },
    usgs: {
        name: 'USGS Topo',
        url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
        attribution: 'Tiles courtesy of the <a href="https://usgs.gov/">U.S. Geological Survey</a>'
    },
    satellite: {
        name: 'Satellite',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
    }
};
