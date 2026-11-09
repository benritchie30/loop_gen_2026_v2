import { describe, expect, it } from 'vitest';
import { coverageGroups, coverageOutline, nearestGroup, tilesForStart, tilesInBounds } from '../mapTiles';

const sorted = (tiles) => tiles.map((t) => t.join(',')).sort();

describe('map tiles (same as the server)', () => {
    // Expected values printed by backend areas.tiles_needed.
    it('a start needs the same tiles the server downloads', () => {
        expect(sorted(tilesForStart(36.25, -81.85, 12))).toEqual(sorted([
            [361, -820], [361, -819], [361, -818], [362, -820], [362, -819], [362, -818], [363, -820], [363, -819], [363, -818],
        ]));
        expect(sorted(tilesForStart(35.2, -80.8, 10))).toEqual(sorted([[351, -809], [351, -808], [352, -809], [352, -808]]));
        expect(sorted(tilesForStart(36.05, -81.95, 6))).toEqual(sorted([
            [359, -820], [360, -821], [360, -820], [360, -819], [361, -820],
        ]));
        expect(tilesForStart(35.15, -80.85, 30)).toHaveLength(31);
    });

    it('lists the tiles in view', () => {
        expect(sorted(tilesInBounds({ south: 35.15, west: -80.85, north: 35.25, east: -80.75 }))).toEqual(sorted([
            [351, -809], [351, -808], [352, -809], [352, -808],
        ]));
    });

    it('outlines a block of tiles by its outer sides only', () => {
        const block = [[351, -809], [351, -808], [352, -809], [352, -808]];
        expect(coverageOutline(block)).toHaveLength(8); // 2 x 2 block: 2 sides per edge
    });

    it('finds separate downloaded places and the nearest one', () => {
        const tiles = [[351, -809], [352, -808], [362, -819], [363, -819], [363, -818]];
        const groups = coverageGroups(tiles);
        expect(groups).toHaveLength(2); // the corner-touching pair counts as one
        expect(nearestGroup(groups, 35.0, -80.0).tiles).toHaveLength(2);
        expect(nearestGroup(groups, 37.0, -82.0).tiles).toHaveLength(3);
    });
});
