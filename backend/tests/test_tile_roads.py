"""Road pieces straight from a map tile (tile_roads.tile_segments), for
painting roads where there is no start (the plan's Favorites tab).

    cd backend
    python -m unittest discover -s tests -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tile_roads import tile_segments  # noqa: E402


def way(way_id, nodes, tags):
    """A tile way: nodes 1..n at made-up positions (lng = node id / 1000)."""
    flat = []
    for n in nodes:
        flat += [n / 1000.0, 35.0 + n / 100000.0]
    return [way_id, nodes, flat, tags]


class TileSegmentsTests(unittest.TestCase):
    def test_roads_split_where_they_cross(self):
        main = way(1, [1, 2, 3, 4, 5], {'highway': 'residential', 'name': 'Main Street'})
        cross = way(2, [10, 3, 11], {'highway': 'residential', 'name': 'Cross Street'})
        pieces = {(p['u'], p['v']): p['name'] for p in tile_segments([main, cross])}
        self.assertEqual(pieces, {
            (1, 3): 'Main Street', (3, 5): 'Main Street',
            (10, 3): 'Cross Street', (3, 11): 'Cross Street',
        })

    def test_points_are_lat_lng_from_end_to_end(self):
        [piece] = tile_segments([way(1, [1, 2, 3], {'highway': 'path'})])
        self.assertEqual(len(piece['pts']), 3)
        self.assertEqual(piece['pts'][0], [round(35.0 + 1 / 100000.0, 5), 0.001])

    def test_only_rideable_roads_and_a_ref_without_a_name(self):
        motorway = way(1, [1, 2], {'highway': 'motorway', 'name': 'I-77'})
        private = way(2, [3, 4], {'highway': 'residential', 'access': 'private'})
        numbered = way(3, [5, 6], {'highway': 'secondary', 'ref': 'NC 16;NC 27'})
        pieces = tile_segments([motorway, private, numbered])
        self.assertEqual([(p['u'], p['v'], p['name']) for p in pieces], [(5, 6, 'NC 16')])


if __name__ == '__main__':
    unittest.main()
