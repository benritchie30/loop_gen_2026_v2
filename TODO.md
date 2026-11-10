# To do later

## Later features

- [ ] Phones: touch gestures and a narrow layout (the demo is desktop-only for now).
- [ ] Better elevation data: USGS 3DEP bare-earth elevation (~10 m, lidar, US) from the free AWS Terrain Tiles instead of SRTM, which is a surface model (roofs and tree canopy add bumps).
- [ ] Experiment with new path finding algorithms attempting to improve speed and path quality.
- [ ] Improving tile/map data download speed.
- [ ] Better filtering and sorting for favorited paths.
- [ ] Improving aesthetics of paths and tools on map. Make paths clear to see no matter which background is selected.
- [ ] Path editor tool. (allows you to edit path or draw one from scratch)
- [ ] Backup, import and sharing: export / import every saved loop and favorite as one JSON file (they live only in the browser), and a share link for a single route (the route in the URL hash, no accounts).
- [ ] Find roads you haven't ridden: import past GPX / FIT rides; a "Prefer roads I haven't ridden" roads option, and a filter / sort by % new road.
- [ ] Steepness limits: a max-grade filter (total climb and climb rate miss a single steep wall); steep sections marked red on the elevation chart and the map.
- [ ] Include `highway=track` in the download filter (forest and farm tracks: a lot of the real gravel riding). Bumps `FILTER_VERSION`, so every tile is downloaded again.
- [ ] Send a route straight to Ride with GPS (their API needs a registered app and each visitor logging in to RWGPS; Strava's API cannot create routes, so GPX import stays the way there).

## Done

- [x] Search area on the map: the automatic area is drawn like a custom boundary (a grey dotted circle of max / 2 around the start). A custom boundary replaces it instead of being drawn over it, an open generation's follows the More routes length slider, and the plan's follows the plan's.
- [x] Remove turns from the route cards and the filter / sort list (the search still counts them internally).
- [x] GPX export of a route: the download icon by "Route n of m", the selected card's GPX button, or the selected favorite's icon. One track with elevation, in the direction shown (Reverse included), no times, so apps import it as a route.
- [x] Display road surfaces: unpaved stretches (gravel and dirt, one class; unknown shown as paved) dashed on the bold route on the map, and vertical bars of the theme colour and white under the elevation chart's line, with an "Unpaved x mi" legend and the surface at the hovered point. Reverse flips them with the profile.
- [x] Elevation profile sample distances: samples are spaced in metres along each edge (they were spaced in degrees, up to ~100 m from their distance on long curvy roads).
- [x] Grade colours on the elevation chart ("Grade colors", its own toggle): < −10% dark navy, −10 to −5 and −5 to 0 lighter dark blues, 0–3 green, 3–6 yellow, 3-point steps through orange to > 15% dark red, with a key. In blocks sized to the chart: smoothed over 150 m, simplified to straight segments within 4% of the relief shown (1.5–2.5 m), no block narrower than 100 m or 1/80 of the distance shown, each coloured by its own grade. Unpaved stretches stay visible as white bars over the colours. The grade line is grey.
- [x] Elevation accuracy: SRTM read bilinearly between its four grid points (it was the single point north-west of each sample), a sample every 25 m (was 50 m; the grid is 30 m), the profile lightly smoothed (Gaussian, sigma 30 m) and Total climb counted on it. Climb was 7–29% high in a synthetic test, now within ~7%.
- [x] "% unpaved" on the route cards (and the selected card's details), as a sort and as a filter.
- [x] Elevation chart: wide and low like a route planner's, drawn at its real size; a summary of what it shows ("10.8 mi +1,465 ft / −1,000 ft": the whole route, the zoomed part, or the part being dragged over); units on the tick labels instead of axis titles; the unpaved legend and the surface reading removed.
- [x] Grade line: smoothed over distances (grade over ~100 m, averaged over 250 m) instead of sample counts, which had halved its smoothing when samples went to every 25 m.
- [x] Surface preference (plan card and More routes): Paved only (a strong charge on unpaved roads, and a loop with more than 400 m of them is left out, with a note), Allow gravel (the default), Prefer gravel (a small charge on paved roads, and loops ranked by their unpaved share, so the most unpaved come first).
